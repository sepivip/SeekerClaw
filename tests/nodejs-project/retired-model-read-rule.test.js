#!/usr/bin/env node
// retired-model-read-rule.test.js — BAT-1661 read rule through the REAL config.js.
//
// Run:  node tests/nodejs-project/retired-model-read-rule.test.js
// Exit: 0 = all pass, 1 = at least one failure.
//
// WHY THIS FILE EXISTS
// --------------------
// OpenAI retired gpt-5.5 / gpt-5.4 / gpt-5.4-mini for ChatGPT sign-in (live 400,
// 2026-11-05). A sign-in user whose stored model is one of them must still get a
// working model on EVERY dispatch — including when the durable repair (Kotlin,
// pre-Node) failed and a valid retired JSON overlay is still on disk.
//
// Codex required this to exercise the REAL per-turn resolver, not a mirror: each
// case boots the real config.js in a child process against a seeded fixture
// workDir (config.js freezes PROVIDER/AUTH_TYPE/MODEL at load from argv[2]).
//
// Negative control built in: case "retired overlay on disk" keeps a VALID startup
// MODEL and puts the retired id only in agent_settings.json — so an implementation
// that applied the rule to MODEL alone (and not inside resolveActiveModel) fails it.

'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');
const { seedFixture } = require('../live/_shared/fixture');

const BUNDLE = path.join(__dirname, '..', '..', 'app', 'src', 'main', 'assets', 'nodejs-project');
const CONFIG_JS = path.join(BUNDLE, 'config.js');
const AI_JS = path.join(BUNDLE, 'ai.js');

const CHILD = `
const c = require(${JSON.stringify(CONFIG_JS)});
process.stdout.write(JSON.stringify({ MODEL: c.MODEL, active: c.resolveActiveModel() }));
process.exit(0);
`;

function boot({ mode, model, overlay }) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'retired-rule-'));
    try {
        seedFixture(dir, {
            mode,
            model,
            apiKey: mode === 'apikey' ? 'sk-proj-PLACEHOLDER' : undefined,
            oauthToken: mode === 'oauth' ? 'oauth-PLACEHOLDER-TOKEN' : undefined,
        });
        if (overlay !== undefined) {
            fs.writeFileSync(path.join(dir, 'agent_settings.json'),
                typeof overlay === 'string' ? overlay : JSON.stringify(overlay), 'utf8');
        }
        const childFile = path.join(dir, 'child.cjs');
        fs.writeFileSync(childFile, CHILD, 'utf8');
        const r = spawnSync(process.execPath, [childFile, dir], { encoding: 'utf8', timeout: 30000 });
        if (r.status !== 0) {
            throw new Error(`config.js boot failed (status ${r.status}): ${(r.stderr || '').slice(0, 400)}`);
        }
        const out = r.stdout.slice(r.stdout.lastIndexOf('{"MODEL"'));
        return JSON.parse(out);
    } finally {
        try { fs.rmSync(dir, { recursive: true, force: true }); } catch (_) { /* best-effort */ }
    }
}

const tests = [];
function t(name, fn) { tests.push([name, fn]); }

for (const id of ['gpt-5.5', 'gpt-5.4', 'gpt-5.4-mini']) {
    t(`oauth + stored ${id} → MODEL and resolveActiveModel are gpt-6.1-sol`, () => {
        const r = boot({ mode: 'oauth', model: id });
        assert.strictEqual(r.MODEL, 'gpt-6.1-sol');
        assert.strictEqual(r.active, 'gpt-6.1-sol');
    });
}

t('oauth + valid startup model + RETIRED overlay still on disk (failed repair) → real resolver serves gpt-6.1-sol', () => {
    const r = boot({ mode: 'oauth', model: 'gpt-6-astra', overlay: { provider: 'openai', model: 'gpt-5.4' } });
    assert.strictEqual(r.MODEL, 'gpt-6-astra', 'startup MODEL is the valid stored value');
    assert.strictEqual(r.active, 'gpt-6.1-sol', 'per-turn resolver must mask the retired overlay');
});

t('oauth + retired overlay with no provider key (applicable) → gpt-6.1-sol', () => {
    const r = boot({ mode: 'oauth', model: 'gpt-6-sol', overlay: { model: 'gpt-5.4-mini' } });
    assert.strictEqual(r.active, 'gpt-6.1-sol');
});

t('oauth + valid newer overlay (Astra) → returned as-is (rule never overrides a valid choice)', () => {
    const r = boot({ mode: 'oauth', model: 'gpt-5.4', overlay: { provider: 'openai', model: 'gpt-6-astra' } });
    assert.strictEqual(r.active, 'gpt-6-astra');
    assert.strictEqual(r.MODEL, 'gpt-6.1-sol');
});

t('oauth + dropped-but-not-retired id (gpt-5.6-sol) → unchanged', () => {
    const r = boot({ mode: 'oauth', model: 'gpt-5.6-sol' });
    assert.strictEqual(r.MODEL, 'gpt-5.6-sol');
    assert.strictEqual(r.active, 'gpt-5.6-sol');
});

t('oauth + custom id sharing a retired prefix → unchanged (exact match only)', () => {
    const r = boot({ mode: 'oauth', model: 'gpt-5.4-mini-ft' });
    assert.strictEqual(r.active, 'gpt-5.4-mini-ft');
});

t('api_key + stored gpt-5.4 → unchanged (still served on API keys)', () => {
    const r = boot({ mode: 'apikey', model: 'gpt-5.4', overlay: { provider: 'openai', model: 'gpt-5.4' } });
    assert.strictEqual(r.MODEL, 'gpt-5.4');
    assert.strictEqual(r.active, 'gpt-5.4');
});

t('oauth + corrupt overlay → falls back to rule-applied MODEL', () => {
    const r = boot({ mode: 'oauth', model: 'gpt-5.5', overlay: '{not json' });
    assert.strictEqual(r.active, 'gpt-6.1-sol');
});

// Dispatch wiring guard: every model the chat/cron/heartbeat turn sends comes from
// resolveActiveModel() (rule applied per call) or MODEL (rule applied at load).
t('ai.js chat turn resolves its model through resolveActiveModel()', () => {
    const src = fs.readFileSync(AI_JS, 'utf8');
    assert.ok(/const activeModel = resolveActiveModel\(\);/.test(src),
        'chat() must take its model from resolveActiveModel() so the read rule covers dispatch');
});

// Source guard (contract v2.2 §1): no Node file other than config.js reads the
// overlay's `model` key — otherwise a retired overlay could bypass the read rule.
t('only config.js reads agent_settings.json `model`', () => {
    const offenders = [];
    for (const f of fs.readdirSync(BUNDLE)) {
        if (!f.endsWith('.js') || f === 'config.js') continue;
        const lines = fs.readFileSync(path.join(BUNDLE, f), 'utf8').split(/\r?\n/);
        if (!lines.some((l) => l.includes('agent_settings.json'))) continue;
        lines.forEach((line, i) => {
            if (/^\s*\/\//.test(line)) return; // comments describe, they don't read
            // A read of a parsed settings object's model field: settings.model / s.model / parsed.model …
            if (!/\b(settings|s|parsed|overlay|agentSettings)\.model\b/.test(line)) return;
            // Allowed: a model read of runtime_state.json (not the overlay) — e.g. the /provider
            // revert snapshot in message-handler.js. It must sit just after that file's read.
            const window = lines.slice(Math.max(0, i - 8), i).join('\n');
            if (/_runtimeState\.filePath|runtime_state\.json/.test(window)) return;
            offenders.push(`${f}:${i + 1}`);
        });
    }
    assert.deepStrictEqual(offenders, [], `files reading the overlay model outside config.js: ${offenders.join(', ')}`);
});

let failed = 0;
for (const [name, fn] of tests) {
    try {
        fn();
        console.log(`  ✓ ${name}`);
    } catch (e) {
        failed++;
        console.log(`  ✗ ${name}\n      ${e.message}`);
    }
}
console.log();
if (failed) {
    console.log(`${failed} TEST(S) FAILED`);
    process.exit(1);
}
console.log('ALL TESTS PASS');
