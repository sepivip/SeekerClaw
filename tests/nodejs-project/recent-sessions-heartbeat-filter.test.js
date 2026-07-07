#!/usr/bin/env node
// recent-sessions-heartbeat-filter.test.js — BAT-1130 F2.
//
// getRecentSessions() must DROP legacy heartbeat-ack session summaries (any row
// whose summary_excerpt contains the literal protocol token "HEARTBEAT_OK") so
// they can't re-enter the system prompt and re-trigger Anthropic's setup_token
// content filter (mislabeled as a "You're out of extra usage" 400 — see
// testing/FINDINGS.md). New builds no longer create these rows (F1), but rows
// written by older builds persist across upgrade; this read-time filter fixes
// existing installs with no schema change and no DB migration.
//
// Uses the REAL database.js + a fresh in-memory SQL.js database.
'use strict';

const assert = require('assert');
const path = require('path');
const os = require('os');
const fs = require('fs');

const BUNDLE = path.resolve(__dirname, '..', '..', 'app', 'src', 'main', 'assets', 'nodejs-project');
function _stub(modPath, exports) {
    const resolved = require.resolve(modPath);
    require.cache[resolved] = { id: resolved, filename: resolved, loaded: true, exports };
}

const TMP_DB = path.join(os.tmpdir(), `bat1130-sessions-${process.pid}.db`);
try { fs.unlinkSync(TMP_DB); } catch (_) {}

_stub(path.join(BUNDLE, 'config.js'), {
    workDir: os.tmpdir(),
    log: () => {},
    localTimestamp: () => '2026-07-07T00:00:00Z',
    localDateStr: () => '2026-07-07',
    DB_PATH: TMP_DB,
    MEMORY_PATH: path.join(os.tmpdir(), 'bat1130-MEMORY.md'),
    MEMORY_DIR: path.join(os.tmpdir(), 'bat1130-memory-nonexistent'),
});
_stub(path.join(BUNDLE, 'memory.js'), { setDb: () => {} });

const db = require(path.join(BUNDLE, 'database.js'));

let failures = 0;
function check(label, fn) {
    try { fn(); console.log(`  ✓ ${label}`); }
    catch (e) { failures++; console.error(`  ✗ ${label}\n    ${e.stack || e.message}`); }
}

(async () => {
    await db.initDatabase();

    const base = { durationMin: 2, messageCount: 2, summaryFile: 'x.md', trigger: 'idle', model: 'claude-opus-4-8' };
    // Two real conversations + one heartbeat-ack (the poison shape).
    db.saveSession({ ...base, startedAt: '2026-07-07T01:00:00Z', endedAt: '2026-07-07T01:05:00Z',
        summaryExcerpt: 'Discussed the quarterly budget and agreed on next steps' });
    db.saveSession({ ...base, durationMin: 1, messageCount: 1, startedAt: '2026-07-07T02:00:00Z', endedAt: '2026-07-07T02:05:00Z',
        summaryExcerpt: 'Checked HEARTBEAT.md. Responded with standard heartbeat acknowledgment (HEARTBEAT_OK) per instructions' });
    db.saveSession({ ...base, startedAt: '2026-07-07T03:00:00Z', endedAt: '2026-07-07T03:05:00Z',
        summaryExcerpt: 'Planned the trip itinerary for next week' });

    const recent = db.getRecentSessions(5);

    check('drops the HEARTBEAT_OK row', () => {
        assert.ok(recent.every(s => !/HEARTBEAT_OK/i.test(String(s.summaryText || ''))),
            'no summary containing HEARTBEAT_OK may survive getRecentSessions');
    });
    check('keeps the two real conversation rows', () => {
        assert.strictEqual(recent.length, 2, 'exactly the 2 non-heartbeat rows should remain');
        assert.ok(recent.some(s => /quarterly budget/.test(s.summaryText)), 'budget session must be kept');
        assert.ok(recent.some(s => /trip itinerary/.test(s.summaryText)), 'trip session must be kept');
    });
    check('respects the limit after filtering', () => {
        // Insert 6 more real rows; ask for 3 → get 3, none of them heartbeat.
        for (let i = 0; i < 6; i++) {
            db.saveSession({ ...base, startedAt: `2026-07-07T0${i}:30:00Z`, endedAt: `2026-07-07T0${i}:35:00Z`,
                summaryExcerpt: `Real conversation number ${i}` });
        }
        const three = db.getRecentSessions(3);
        assert.strictEqual(three.length, 3, 'limit honored after filtering');
        assert.ok(three.every(s => !/HEARTBEAT_OK/i.test(String(s.summaryText || ''))), 'still no heartbeat rows');
    });
    check('does NOT false-empty when the newest 20+ rows are all heartbeat (Copilot R5)', () => {
        // A real conversation, then 25 NEWER heartbeat-ack rows (> the old over-fetch of 20).
        // The old JS-post-filter would have fetched 20 all-heartbeat rows → returned [].
        // SQL filtering applies the LIMIT AFTER filtering, so the real session survives.
        db.saveSession({ ...base, startedAt: '2026-07-09T00:00:00Z', endedAt: '2026-07-09T00:05:00Z',
            summaryExcerpt: 'A real conversation buried under many heartbeats' });
        for (let i = 0; i < 25; i++) {
            const hh = String(i).padStart(2, '0');
            db.saveSession({ ...base, durationMin: 1, messageCount: 1,
                startedAt: `2026-07-10T${hh}:00:00Z`, endedAt: `2026-07-10T${hh}:05:00Z`,
                summaryExcerpt: `Responded with heartbeat acknowledgment (HEARTBEAT_OK) #${i}` });
        }
        const recent = db.getRecentSessions(5);
        assert.ok(recent.length > 0, 'must NOT return empty when real sessions exist behind 25 heartbeat rows');
        assert.ok(recent.every(s => !/HEARTBEAT_OK/i.test(String(s.summaryText || ''))), 'no heartbeat rows survive');
        assert.ok(recent.some(s => /buried under many heartbeats/.test(String(s.summaryText || ''))), 'the buried real session surfaces');
    });

    try { fs.unlinkSync(TMP_DB); } catch (_) {}

    if (failures > 0) { console.error(`\n${failures} failure(s).`); process.exit(1); }
    console.log('\nPASS: recent-sessions-heartbeat-filter.test.js (F2 — heartbeat rows filtered at read).');
})();
