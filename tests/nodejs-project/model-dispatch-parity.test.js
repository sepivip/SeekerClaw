#!/usr/bin/env node
// model-dispatch-parity.test.js — BAT-1661 Kotlin/Node parity for the model repair's two Node rules.
//
// Run:  node tests/nodejs-project/model-dispatch-parity.test.js
// Exit: 0 = all pass, 1 = at least one failure.
//
// WHY THIS FILE EXISTS
// --------------------
// The Kotlin repair (ModelRepair.kt) decides two things the way Node does, and the contract
// (v2.9 §1, §3; v2.10 §3) requires each to be ONE Kotlin function pinned to Node by a parity test:
//   1. the dispatch file — which store config.js's resolveActiveModel() takes the model from
//      (agent_settings.json overlay, runtime_state.json, or config.json). Kotlin: NodeDispatch.winner.
//   2. the OpenAI transport — OPENAI_AUTH_TYPE / OPENAI_OAUTH_RECONNECT_REQUIRED from the selected
//      auth, the sign-in token and the API key. Kotlin: ModelRepair.transportOf (OpenAIAuth).
//
// Both sides read ONE table, tests/nodejs-project/fixtures/model-dispatch-parity.json. This runner
// boots the REAL config.js in a child process per row against a seeded workDir (config.js freezes
// PROVIDER/AUTH_TYPE/MODEL at load from argv[2]); ModelDispatchParityTest.kt runs the Kotlin side
// over the same rows. A drift on either side fails its own runner.
//
// Negative control built in: the table has rows where only one rule distinguishes the outcome
// (a blank overlay model, a non-canonical runtime provider, a foreign overlay against
// runtime_state's provider), so a resolver that skipped any of those checks fails here.

'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');
const { seedFixture } = require('../live/_shared/fixture');

const BUNDLE = path.join(__dirname, '..', '..', 'app', 'src', 'main', 'assets', 'nodejs-project');
const CONFIG_JS = path.join(BUNDLE, 'config.js');
const TABLE = JSON.parse(fs.readFileSync(path.join(__dirname, 'fixtures', 'model-dispatch-parity.json'), 'utf8'));
const MARK = '@@PARITY@@';

const CHILD = `
const c = require(${JSON.stringify(CONFIG_JS)});
process.stdout.write(${JSON.stringify(MARK)} + JSON.stringify({
    active: c.resolveActiveModel(),
    provider: c.PROVIDER,
    openaiAuth: c.OPENAI_AUTH_TYPE,
    reconnect: c.OPENAI_OAUTH_RECONNECT_REQUIRED,
}));
process.exit(0);
`;

function writeStore(file, value) {
    if (value === null || value === undefined) return;
    fs.writeFileSync(file, typeof value === 'string' ? value : JSON.stringify(value), 'utf8');
}

// Kotlin starts Node with argv[2] = filesDir/workspace; runtime_state.json lives in filesDir.
function boot({ configProvider, authConfig, runtime, overlay }) {
    const base = fs.mkdtempSync(path.join(os.tmpdir(), 'dispatch-parity-'));
    const workDir = path.join(base, 'workspace');
    fs.mkdirSync(workDir, { recursive: true });
    try {
        seedFixture(workDir, { provider: configProvider, authConfig, model: 'm-config' });
        writeStore(path.join(base, 'runtime_state.json'), runtime);
        writeStore(path.join(workDir, 'agent_settings.json'), overlay);
        const childFile = path.join(base, 'child.cjs');
        fs.writeFileSync(childFile, CHILD, 'utf8');
        const r = spawnSync(process.execPath, [childFile, workDir], { encoding: 'utf8', timeout: 30000 });
        if (r.status !== 0) {
            throw new Error(`config.js boot failed (status ${r.status}): ${(r.stderr || r.stdout || '').slice(0, 400)}`);
        }
        return JSON.parse(r.stdout.slice(r.stdout.lastIndexOf(MARK) + MARK.length));
    } finally {
        try { fs.rmSync(base, { recursive: true, force: true }); } catch (_) { /* best-effort */ }
    }
}

// Every provider's credential, so config.js never exits on a missing key whatever PROVIDER a row lands on.
const ALL_KEYS = {
    authType: 'api_key',
    openaiApiKey: 'sk-proj-PLACEHOLDER',
    anthropicApiKey: 'sk-ant-PLACEHOLDER',
    xaiApiKey: 'xai-PLACEHOLDER',
    openrouterApiKey: 'sk-or-PLACEHOLDER',
    customApiKey: 'custom-PLACEHOLDER',
    customBaseUrl: 'https://gateway.invalid/v1',
};

const SOURCE_OF = { 'm-overlay': 'OVERLAY', 'm-runtime': 'RUNTIME', 'm-config': 'CONFIG' };

const tests = [];
function t(name, fn) { tests.push([name, fn]); }

for (const row of TABLE.dispatch) {
    t(`dispatch: ${row.name} → ${row.expect}`, () => {
        const r = boot({ configProvider: row.configProvider, authConfig: ALL_KEYS, runtime: row.runtime, overlay: row.overlay });
        assert.strictEqual(SOURCE_OF[r.active], row.expect, `resolveActiveModel() returned ${JSON.stringify(r.active)}`);
    });
}

for (const row of TABLE.transport) {
    t(`transport: ${row.name} → ${row.expect}`, () => {
        const authConfig = { authType: row.selected };
        if (row.token) authConfig.openaiOAuthToken = 'oauth-PLACEHOLDER-TOKEN';
        if (row.key) authConfig.openaiApiKey = 'sk-proj-PLACEHOLDER';
        const runtime = row.runtimeAuth ? { provider: 'openai', authType: row.runtimeAuth, model: 'm-runtime' } : null;
        const r = boot({ configProvider: 'openai', authConfig, runtime, overlay: null });
        assert.strictEqual(r.provider, 'openai');
        const got = r.reconnect ? 'RECONNECT' : r.openaiAuth === 'oauth' ? 'OAUTH' : 'API_KEY';
        assert.strictEqual(got, row.expect, `OPENAI_AUTH_TYPE=${r.openaiAuth} reconnect=${r.reconnect}`);
    });
}

// Codex 7ec40d8b #1: the model Node runs on, against the key it can USE (plaintext, normalised).
const REGISTRY = JSON.parse(fs.readFileSync(path.join(BUNDLE, 'model-registry.json'), 'utf8'));
const OPENAI_DEFAULT = REGISTRY.providers.find((p) => p.id === 'openai').defaultModel;
for (const row of TABLE.display) {
    t(`display: ${row.name} → ${row.expect}`, () => {
        const authConfig = { authType: row.selected };
        if (row.token) authConfig.openaiOAuthToken = 'oauth-PLACEHOLDER-TOKEN';
        if (row.key !== null) authConfig.openaiApiKey = row.key;
        const runtime = { provider: 'openai', authType: row.selected, model: row.stored };
        const r = boot({ configProvider: 'openai', authConfig, runtime, overlay: null });
        const want = row.expect === 'DEFAULT' ? OPENAI_DEFAULT : row.stored;
        assert.strictEqual(r.active, want, `active=${r.active} openaiAuth=${r.openaiAuth} reconnect=${r.reconnect}`);
    });
}

t('the table has both sections and enough rows to be a real pin', () => {
    assert.ok(TABLE.dispatch.length >= 20, 'dispatch rows');
    assert.ok(TABLE.transport.length >= 6, 'transport rows');
    for (const s of ['OVERLAY', 'RUNTIME', 'CONFIG']) {
        assert.ok(TABLE.dispatch.some((r) => r.expect === s), `a ${s} row`);
    }
    for (const s of ['OAUTH', 'API_KEY', 'RECONNECT']) {
        assert.ok(TABLE.transport.some((r) => r.expect === s), `a ${s} row`);
    }
    assert.ok(TABLE.display.length >= 6, 'display rows');
    for (const s of ['DEFAULT', 'STORED']) {
        assert.ok(TABLE.display.some((r) => r.expect === s), `a ${s} display row`);
    }
});

let failed = 0;
for (const [name, fn] of tests) {
    try {
        fn();
        console.log(`  ok  ${name}`);
    } catch (e) {
        failed++;
        console.log(`  FAIL ${name}\n       ${e.message}`);
    }
}
console.log(`\n${tests.length - failed}/${tests.length} passed`);
process.exit(failed ? 1 : 0);
