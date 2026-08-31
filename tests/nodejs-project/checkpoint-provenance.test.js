#!/usr/bin/env node
// checkpoint-provenance.test.js — BAT-1283 store boundary + auto-resume wiring.
//
// LAYER 2 of the signed coverage gate. What this file can and cannot see:
//   CAN  — the REAL saveCheckpoint -> listCheckpoints -> loadCheckpoint path, and
//          the REAL redactSecrets (security.js is loaded, not stubbed).
//   CANNOT — that main.js actually calls goalIsTrusted(full). main.js has zero
//          module.exports and requiring it boots the agent (smoke.js:131), so that
//          claim is covered by the SOURCE-WIRING guard at the bottom of this file
//          plus the device test — NOT by behavioural assertion. Stated, not implied.
//
// One stub only: config.js (TASKS_DIR -> a temp dir, plus the handful of exports
// security.js destructures). The contract budgeted two stubs; stubbing security.js
// would have defeated the OQ2 tests, which need the real redaction patterns.
//
// Run:  node tests/nodejs-project/checkpoint-provenance.test.js
'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const BUNDLE = path.join(__dirname, '..', '..', 'app', 'src', 'main', 'assets', 'nodejs-project');

// ── stub config.js BEFORE requiring anything that needs it ──────────────────
const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'bat1283-'));
const workDir = path.join(tmpRoot, 'workspace');
const TASKS_DIR = path.join(workDir, 'tasks');
fs.mkdirSync(TASKS_DIR, { recursive: true });

const configPath = require.resolve(path.join(BUNDLE, 'config.js'));
require.cache[configPath] = {
    id: configPath,
    filename: configPath,
    loaded: true,
    exports: {
        TASKS_DIR,
        workDir,
        config: {},
        log: () => {},
        getBridgeToken: () => null,
    },
};

const { saveCheckpoint, listCheckpoints, loadCheckpoint } = require(path.join(BUNDLE, 'task-store'));
const { goalIsTrusted } = require(path.join(BUNDLE, 'turn-goal'));

let passed = 0;
let failed = 0;
function test(name, fn) {
    try {
        fn();
        passed++;
        console.log(`  ✓ ${name}`);
    } catch (e) {
        failed++;
        console.error(`  ✗ ${name}`);
        console.error(`    ${e.message}`);
        process.exitCode = 1;
    }
}

let seq = 0;
function writeCheckpoint(fields) {
    const taskId = `t${++seq}${Date.now().toString(36)}`;
    saveCheckpoint(taskId, {
        taskId,
        chatId: '7561373860',
        turnId: 'turn1',
        startedAt: Date.now(),
        stepCount: 1,
        maxSteps: 35,
        complete: false,
        reason: null,
        conversationSlice: [],
        ...fields,
    });
    return taskId;
}
const summaryOf = (taskId) => listCheckpoints().find(c => c.taskId === taskId);

console.log('\ncheckpoint provenance — a stored goal is authoritative only if we can vouch for it\n');

// ── the object boundary that made v3 inert (Codex B4) ───────────────────────

test('the list summary omits goalSrc; only the loaded checkpoint carries it', () => {
    const id = writeCheckpoint({ originalGoal: 'summarise the quarterly numbers', goalSrc: 'turn' });
    const summary = summaryOf(id);
    const full = loadCheckpoint(id);
    assert.ok(summary, 'checkpoint should be listed');
    assert.strictEqual(summary.goalSrc, undefined, 'listCheckpoints() is a six-field whitelist');
    assert.strictEqual(full.goalSrc, 'turn', 'the loaded record must preserve provenance');
});

test('NEGATIVE CONTROL: trusting the summary marks every checkpoint legacy', () => {
    // This IS contract v3's specification, and the reason it was rejected. Reading
    // provenance off `cp` would suppress the goal and hint for EVERY checkpoint,
    // silently disabling the fix while every pure resolver test stayed green.
    const id = writeCheckpoint({ originalGoal: 'a real request', goalSrc: 'turn' });
    assert.strictEqual(goalIsTrusted(loadCheckpoint(id)), true, 'full record is trusted');
    assert.strictEqual(goalIsTrusted(summaryOf(id)), false, 'summary can never be trusted');
});

test('a pre-fix checkpoint (no goalSrc) round-trips as untrusted', () => {
    const id = writeCheckpoint({ originalGoal: 'Hey girl' });   // the device symptom
    const full = loadCheckpoint(id);
    assert.strictEqual(full.originalGoal, 'Hey girl', 'legacy value is preserved on disk');
    assert.strictEqual(full.goalSrc, undefined);
    assert.strictEqual(goalIsTrusted(full), false, 'legacy goal must never be promoted');
});

test('an unknown provenance value fails closed', () => {
    const id = writeCheckpoint({ originalGoal: 'a real request', goalSrc: 'bogus' });
    assert.strictEqual(goalIsTrusted(loadCheckpoint(id)), false);
});

// ── OQ2: redaction-altered goals fail closed ────────────────────────────────

test('a goal mangled by redaction is marked and fails closed', () => {
    // Real redactSecrets, real pattern. /sk-[a-zA-Z0-9_-]{20,}/ fires on any
    // kebab-case phrase whose word ends in "sk" — ask-, task-, risk-.
    const goal = 'ask-claude-to-summarise-this-long-document-please';
    const id = writeCheckpoint({ originalGoal: goal, goalSrc: 'turn' });
    const full = loadCheckpoint(id);
    assert.notStrictEqual(full.originalGoal, goal, 'redaction should have altered it');
    assert.strictEqual(full.goalSrc, 'redacted', 'alteration must be recorded');
    assert.strictEqual(goalIsTrusted(full), false, 'a mangled goal is not authoritative');
});

test('NEGATIVE CONTROL: an unmangled goal keeps its provenance and stays trusted', () => {
    // Without this, the OQ2 test would pass just as well if EVERYTHING were marked
    // redacted — which would silently disable the whole feature.
    const goal = 'check my wallet balance and summarise it';
    const id = writeCheckpoint({ originalGoal: goal, goalSrc: 'turn' });
    const full = loadCheckpoint(id);
    assert.strictEqual(full.originalGoal, goal, 'clean goal must survive verbatim');
    assert.strictEqual(full.goalSrc, 'turn');
    assert.strictEqual(goalIsTrusted(full), true);
});

test('the redacted mark survives a re-save and the goal does not degrade further', () => {
    // saveCheckpoint runs on every re-save (main.js:405-406 attempt bump,
    // markComplete round-trip). redactSecrets is idempotent, so the second pass
    // detects no change — the mark must persist rather than being cleared.
    const goal = 'ask-claude-to-summarise-this-long-document-please';
    const id = writeCheckpoint({ originalGoal: goal, goalSrc: 'turn' });
    const once = loadCheckpoint(id);
    saveCheckpoint(id, { ...once, resumeAttempts: 1 });
    const twice = loadCheckpoint(id);
    assert.strictEqual(twice.goalSrc, 'redacted', 'mark must survive the re-save');
    assert.strictEqual(twice.originalGoal, once.originalGoal, 'goal must not degrade further');
    assert.strictEqual(goalIsTrusted(twice), false);
});

// ── auto-resume wiring: SOURCE GUARD, not behavioural coverage ──────────────

test('SOURCE GUARD: auto-resume reads provenance from `full`, never from `cp`', () => {
    // main.js has zero module.exports and requiring it boots the agent
    // (smoke.js:131), so this cannot be asserted behaviourally without a refactor
    // the contract explicitly rules out. A source guard is weaker than a
    // behavioural test and is labelled as such. Its own negative control is run by
    // hand: rewrite the line to cp.goalSrc and confirm this goes red — that is
    // precisely the B4 bug.
    const src = fs.readFileSync(path.join(BUNDLE, 'main.js'), 'utf8');
    assert.ok(/const goalTrusted = goalIsTrusted\(full\)/.test(src),
        'auto-resume must derive provenance from the loaded checkpoint');
    assert.ok(!/goalIsTrusted\(\s*cp\b/.test(src),
        'must not read provenance from the listCheckpoints() summary');
    assert.ok(!/\bcp\.goalSrc\b/.test(src),
        'cp.goalSrc can never exist — the summary is a six-field whitelist');
    assert.ok(/originalGoal: goalIsUsableString \? full\.originalGoal : null/.test(src),
        'an untrusted goal must never reach the resume directive');
    assert.ok(/goalIsUsableString \? full\.originalGoal\.slice\(0, 80\) : null/.test(src),
        'an untrusted goal must never reach the Telegram hint');
});

test('SOURCE GUARD: /resume gates the same way, via the same shared helper', () => {
    const src = fs.readFileSync(path.join(BUNDLE, 'message-handler.js'), 'utf8');
    assert.ok(/goalIsTrusted\(full\)/.test(src), '/resume must gate on the loaded checkpoint');
    assert.ok(!/goalIsTrusted\(\s*cp\b/.test(src) && !/\bcp\.goalSrc\b/.test(src));
    assert.ok(/originalGoal: goalTrusted \? full\.originalGoal : null/.test(src));
    // one implementation, not two — the rules cannot drift between read sites
    for (const f of ['main.js', 'message-handler.js']) {
        const s = fs.readFileSync(path.join(BUNDLE, f), 'utf8');
        assert.ok(/require\('\.\/turn-goal'\)/.test(s), `${f} must import the shared helper`);
    }
});

try { fs.rmSync(tmpRoot, { recursive: true, force: true }); } catch { /* best effort */ }

if (failed > 0) {
    console.error(`\nFAIL: checkpoint-provenance.test.js — ${failed} failed, ${passed} passed\n`);
} else {
    console.log(`\nPASS: checkpoint-provenance.test.js (${passed} assertions)\n`);
}
