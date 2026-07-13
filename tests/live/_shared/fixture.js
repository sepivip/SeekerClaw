// tests/live/_shared/fixture.js
// ─────────────────────────────────────────────────────────────────────────────
// Seeds a per-mode fixture workDir that the REAL agent modules can boot against:
//   • config.json  — provider=openai, channel=telegram, the mode's auth fields,
//                     a canonical bridgeToken, and a model. (gitignored)
//   • SOUL/IDENTITY/USER/MEMORY.md + memory/<date>.md — obviously-synthetic but
//     realistically-shaped workspace so buildSystemBlocks() reads REAL content
//     into the system prompt (the whole point: real payload, not a fake one).
//
// config.js derives every workspace path from workDir=process.argv[2]
// (SOUL/MEMORY/HEARTBEAT + memory/ + the DB), and memory.js reads
// IDENTITY.md/USER.md/BOOTSTRAP.md from workDir too — so writing these files
// into `dir` is enough to populate the prompt.
//
// DB FIXTURE (follow-up): we deliberately do NOT seed the SQL.js Recent-Sessions
// DB. database.js loads SQL.js WASM and getRecentSessions() returns [] when the
// DB is absent — the system prompt simply omits the "Recent Sessions" rollup.
// Seeding real rows means driving the SQL.js WASM loader (async) + the
// api_request_log schema; punted to a follow-up so the harness stays synchronous
// and dependency-free. See README "DB fixture follow-up".
'use strict';

const fs = require('fs');
const path = require('path');

// A canonical 8-4-4-4-12 UUID that satisfies bridge-token's isCanonicalBridgeToken.
// config.js does NOT hard-require bridgeToken to load (BRIDGE_TOKEN is only
// shape-validated on live per-request reads via getBridgeToken()), but a valid
// one keeps the fixture realistic and future-proof if a loader check tightens.
const CANON_BRIDGE_TOKEN = '11111111-2222-4333-8444-555555555555';

function write(p, content) {
    fs.writeFileSync(p, content);
}

/**
 * @param {string} dir absolute fixture workDir
 * @param {object} opts
 * @param {'apikey'|'oauth'} opts.mode
 * @param {string} [opts.model='gpt-5.4']
 * @param {string} [opts.apiKey]        api_key mode — real key (live) or placeholder
 * @param {string} [opts.oauthToken]    oauth mode — real token (live) or placeholder
 * @param {string} [opts.oauthRefresh]  optional oauth refresh token
 * @returns {string} the fixture dir
 */
function seedFixture(dir, opts) {
    const {
        mode,
        model = 'gpt-5.4',
        apiKey,
        oauthToken,
        oauthRefresh,
        botToken = '100000000:TEST-BOT-TOKEN-PLACEHOLDER',
        ownerId = '100000001',
        agentName = 'TestBot',
    } = opts || {};

    // Clear any stale state from a PRIOR run before re-seeding (Copilot): config.js
    // prefers runtime_state.json over config.json, and buildSystemBlocks reads the
    // workspace files — so a leftover runtime_state / memory file could silently poison
    // the next seed (e.g. wrong provider/auth mode, or stale prompt content).
    for (const f of ['config.json', 'runtime_state.json', 'agent_settings.json', 'node_debug.log',
                     'SOUL.md', 'IDENTITY.md', 'USER.md', 'MEMORY.md', 'HEARTBEAT.md', 'BOOTSTRAP.md']) {
        try { fs.rmSync(path.join(dir, f), { force: true }); } catch (_) { /* best-effort */ }
    }
    try { fs.rmSync(path.join(dir, 'memory'), { recursive: true, force: true }); } catch (_) { /* best-effort */ }

    fs.mkdirSync(path.join(dir, 'memory'), { recursive: true });

    // ── config.json ──────────────────────────────────────────────────────────
    const cfg = {
        provider: 'openai',
        authType: mode === 'oauth' ? 'oauth' : 'api_key',
        channel: 'telegram',
        botToken,
        ownerId,
        model,
        agentName,
        bridgeToken: CANON_BRIDGE_TOKEN,
    };
    if (mode === 'oauth') {
        cfg.openaiOAuthToken = oauthToken || 'oauth-test-PLACEHOLDER';
        if (oauthRefresh) cfg.openaiOAuthRefresh = oauthRefresh;
    } else {
        cfg.openaiApiKey = apiKey || 'sk-test-PLACEHOLDER';
    }
    write(path.join(dir, 'config.json'), JSON.stringify(cfg, null, 2) + '\n');

    // ── Mock-but-realistic workspace (NO real user data) ─────────────────────
    write(path.join(dir, 'IDENTITY.md'), [
        '# IDENTITY.md',
        '',
        '- **Name:** TestBot',
        '- **Nature:** synthetic fixture agent (BAT-1144 exact-agent-copy harness)',
        '- **Born:** 2026-07-09 (fixture seed)',
        '- **Purpose:** exercise the REAL system prompt + tool payload offline',
        '',
        'You are TestBot, a deterministic fixture persona used only by the OpenAI',
        'live-model harness. This file is synthetic and contains no production data.',
        '',
    ].join('\n'));

    write(path.join(dir, 'USER.md'), [
        '# USER.md',
        '',
        '- **Name:** Test User',
        '- **Handle:** @test_user_synthetic',
        '- **Timezone:** UTC',
        '- **Interests:** verifying that the harness builds the real agent request',
        '- **Notes:** Synthetic owner profile. Contains no real personal data.',
        '',
    ].join('\n'));

    write(path.join(dir, 'SOUL.md'), [
        '# SOUL.md — Who You Are',
        '',
        "_You're not a chatbot. You're a fixture — but act the part: be genuinely",
        'helpful, have opinions, stay concise._',
        '',
        '## Core Truths',
        '- Be resourceful before asking.',
        '- Earn trust through competence.',
        '- This is synthetic test data — never treat it as production memory.',
        '',
    ].join('\n'));

    write(path.join(dir, 'MEMORY.md'), [
        '# MEMORY.md',
        '',
        '## Long-term (synthetic)',
        '- 2026-07-01: Fixture created for the BAT-1144 OpenAI live-model harness.',
        '- 2026-07-05: Confirmed the harness builds the real agent payload, not a mock.',
        '- Test User prefers concise, direct answers (synthetic preference).',
        '',
    ].join('\n'));

    // A couple of daily memory files (realistic shape/size).
    write(path.join(dir, 'memory', '2026-07-08.md'), [
        '# 2026-07-08',
        '',
        '- Ran the offline self-check; both api_key and oauth bodies validated.',
        '- Noted that the Codex/OAuth path forces reasoning + store:false.',
        '',
    ].join('\n'));
    write(path.join(dir, 'memory', '2026-07-09.md'), [
        '# 2026-07-09',
        '',
        '- Test User asked TestBot to summarize the day. Nothing else of note.',
        '- Reminder (synthetic): the DB fixture is a follow-up, so Recent Sessions is empty.',
        '',
    ].join('\n'));

    return dir;
}

module.exports = { seedFixture, CANON_BRIDGE_TOKEN };
