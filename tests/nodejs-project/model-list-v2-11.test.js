#!/usr/bin/env node
// model-list-v2-11.test.js — BAT-1661 amendment v2.11: model lists and defaults.
//
// Run:  node tests/nodejs-project/model-list-v2-11.test.js
// Exit: 0 = all pass, 1 = at least one failure.
//
// WHAT THIS PINS
// --------------
// v2.11 moved both defaults (claude-opus-5-5, gpt-6.2-sol) and dropped three ids from the
// picker (claude-opus-4-8, claude-sonnet-4-6, gpt-6-sol). The registry pins live in
// model-catalog.test.js and ModelRegistryDefaultsTest; this file pins what those cannot see:
//
//   §3a  The Node copies of the defaults, through the REAL code: runtime-state.js DEFAULTS and
//        config.js booted in a child process with no stored model, for every provider. The
//        source-level copy scan (Kotlin + Node) is ModelDefaultCopiesDriftTest.
//   §2a  A stored dropped id: `/model <id>` is rejected (validateModelForProvider), reasoning
//        support is "unknown", and — on BOTH OpenAI transports — the request body:
//          - api_key: no reasoning field (the OPTIONAL user-toggle branch needs "yes");
//          - oauth:   reasoning STILL sent (transport-required, providers/openai.js ~375–382).
//        Binding clarification 2 (543ad2c7): "Extended Thinking off" for a dropped id means only
//        the optional branch; do not assert that all reasoning stops.
//   §3   Context-limit coverage: every listed id, and every id this release dropped, has a
//        MODEL_CONTEXT_LIMITS entry at the 200000 cap. Without it a stored dropped model falls to
//        the 128000 fallback and trims ~37% earlier (BAT-1315).

'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const BUNDLE = path.resolve(__dirname, '..', '..', 'app', 'src', 'main', 'assets', 'nodejs-project');
const { seedFixture } = require('../live/_shared/fixture');
const catalog = require(path.join(BUNDLE, 'model-catalog.js'));
const runtimeState = require(path.join(BUNDLE, 'runtime-state.js'));

const REGISTRY = JSON.parse(fs.readFileSync(path.join(BUNDLE, 'model-registry.json'), 'utf8'));
const byId = Object.fromEntries(REGISTRY.providers.map((p) => [p.id, p]));

const DROPPED = [
    { provider: 'claude', id: 'claude-opus-4-8', auths: ['api_key', 'setup_token'] },
    { provider: 'claude', id: 'claude-sonnet-4-6', auths: ['api_key', 'setup_token'] },
    { provider: 'openai', id: 'gpt-6-sol', auths: ['api_key', 'oauth'] },
];

const tests = [];
function t(name, fn) { tests.push([name, fn]); }

// ── §3a: the Node copies of the defaults ────────────────────────────────────

t('the registry defaults are the v2.11 ones (owner, 2026-11-18)', () => {
    assert.strictEqual(byId.claude.defaultModel, 'claude-opus-5-5');
    assert.strictEqual(byId.openai.defaultModel, 'gpt-6.2-sol');
});

t('runtime-state.js DEFAULTS.model, and a fresh read, are the registry claude default', () => {
    assert.strictEqual(runtimeState.DEFAULTS.model, byId.claude.defaultModel);
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'v211-rs-'));
    try {
        const work = path.join(dir, 'workspace');
        fs.mkdirSync(work);
        const read = runtimeState.open(work).read();
        assert.strictEqual(read.provider, 'claude');
        assert.strictEqual(read.model, byId.claude.defaultModel, 'no runtime_state.json → DEFAULTS');
    } finally {
        fs.rmSync(dir, { recursive: true, force: true });
    }
});

// config.js freezes PROVIDER/AUTH_TYPE/MODEL at load from argv[2], so each case boots it in a
// child process against a fixture whose config.json carries a BLANK model and no runtime_state:
// MODEL then comes from the `_defaultModel` chain.
const CHILD = `
const c = require(${JSON.stringify(path.join(BUNDLE, 'config.js'))});
process.stdout.write(JSON.stringify({ MODEL: c.MODEL }));
process.exit(0);
`;
function bootModel(provider, authConfig) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'v211-cfg-'));
    try {
        seedFixture(dir, { provider, authConfig, model: '' });
        const childFile = path.join(dir, 'child.cjs');
        fs.writeFileSync(childFile, CHILD, 'utf8');
        const r = spawnSync(process.execPath, [childFile, dir], { encoding: 'utf8', timeout: 30000 });
        if (r.status !== 0) throw new Error(`config.js boot failed (status ${r.status}): ${(r.stderr || '').slice(0, 400)}`);
        return JSON.parse(r.stdout.slice(r.stdout.lastIndexOf('{"MODEL"'))).MODEL;
    } finally {
        try { fs.rmSync(dir, { recursive: true, force: true }); } catch (_) { /* best-effort */ }
    }
}
const BOOTS = [
    ['claude', { authType: 'api_key', anthropicApiKey: 'sk-ant-api03-PLACEHOLDER' }],
    ['claude', { authType: 'setup_token', setupToken: 'sk-ant-oat01-PLACEHOLDER' }],
    ['openai', { authType: 'api_key', openaiApiKey: 'sk-proj-PLACEHOLDER' }],
    ['openai', { authType: 'oauth', openaiOAuthToken: 'oauth-PLACEHOLDER-TOKEN' }],
    ['openrouter', { authType: 'api_key', openrouterApiKey: 'sk-or-v1-PLACEHOLDER' }],
    ['xai', { authType: 'api_key', xaiApiKey: 'xai-PLACEHOLDER' }],
];
for (const [provider, authConfig] of BOOTS) {
    t(`config.js with no stored model (${provider}/${authConfig.authType}) boots on the registry default`, () => {
        assert.strictEqual(bootModel(provider, authConfig), byId[provider].defaultModel);
    });
}

// ── §2a: a stored model that left the picker ────────────────────────────────

for (const { provider, id, auths } of DROPPED) {
    for (const auth of auths) {
        t(`${provider}/${auth}: ${id} is unlisted, not retired`, () => {
            assert.ok(!catalog.modelsForProvider(provider, auth).some((m) => m.id === id));
            assert.ok(!catalog.retiredModelsFor(provider, auth).includes(id), 'dropped, not retired');
            // The read rule leaves it alone: a stored dropped id keeps working.
            assert.strictEqual(catalog.applyRetiredModelRule(provider, auth, id), id);
        });
        t(`${provider}/${auth}: /model ${id} is rejected by validateModelForProvider`, () => {
            const v = catalog.validateModelForProvider(provider, auth, id);
            assert.strictEqual(v.ok, false);
            assert.ok(typeof v.reason === 'string' && v.reason.length > 0);
            assert.ok(v.options.includes(byId[provider].defaultModel), 'the options offer the default');
        });
        t(`${provider}/${auth}: reasoningSupportFor(${id}) is "unknown", thinkingBindingFor is false`, () => {
            assert.strictEqual(catalog.reasoningSupportFor(provider, id, auth), 'unknown');
            assert.strictEqual(catalog.thinkingBindingFor(provider, id, auth), false);
        });
    }
}

// The request body is built from the SAME requestOptions shape ai.js passes (ai.js ~3233):
//   { reasoningEnabled: <the user's toggle>, reasoningSupport: reasoningSupportFor(provider, model, auth), reasoningMode }
// This guard keeps that composition honest: if ai.js stops deriving reasoningSupport from the
// registry per request, the bodies below no longer describe production.
t('ai.js derives requestOptions.reasoningSupport from reasoningSupportFor for the active model', () => {
    const src = fs.readFileSync(path.join(BUNDLE, 'ai.js'), 'utf8');
    assert.ok(/reasoningSupport: reasoningSupportFor\(_registryProviderId, activeModel, _authForRegistry\),/.test(src));
});

// providers/openai.js and providers/claude.js read config at load; stub it (and the bridge),
// and reload openai.js per transport, exactly as reasoning-request-enablement.test.js does.
const configPath = path.join(BUNDLE, 'config.js');
const bridgePath = path.join(BUNDLE, 'bridge.js');
const openaiPath = path.join(BUNDLE, 'providers', 'openai.js');
const claudePath = path.join(BUNDLE, 'providers', 'claude.js');
function loadAdapters(openaiAuth) {
    require.cache[configPath] = {
        id: configPath, filename: configPath, loaded: true,
        exports: {
            log: () => {},
            OPENAI_OAUTH_TOKEN: 'fake-oauth', OPENAI_OAUTH_REFRESH: 'fake-refresh',
            OPENAI_AUTH_TYPE: openaiAuth,
            resolveActiveModel: () => 'unused',
        },
    };
    require.cache[bridgePath] = {
        id: bridgePath, filename: bridgePath, loaded: true,
        exports: { androidBridgeCall: async () => ({}), androidBridgeCallWithStatus: async () => ({}) },
    };
    delete require.cache[openaiPath];
    delete require.cache[claudePath];
    return { openai: require(openaiPath), claude: require(claudePath) };
}
function openaiBody(adapter, auth, model, reasoningEnabled, reasoningMode) {
    const requestOptions = {
        reasoningEnabled,
        reasoningSupport: catalog.reasoningSupportFor('openai', model, auth),
        reasoningMode: reasoningMode || 'normal',
    };
    return JSON.parse(adapter.formatRequest(model, 4096, 'sys', [], [], requestOptions));
}

t('OpenAI api_key, dropped gpt-6-sol, Extended Thinking ON → NO reasoning field (optional branch off)', () => {
    const { openai } = loadAdapters('api_key');
    const body = openaiBody(openai, 'api_key', 'gpt-6-sol', true);
    assert.strictEqual(body.reasoning, undefined, 'reasoning must not be sent for an unlisted id on api_key');
    assert.ok(!(Array.isArray(body.include) && body.include.includes('reasoning.encrypted_content')), 'no encrypted-reasoning include');
    // Control: the listed successor with the same toggle DOES send it, so the absence above is the
    // dropped id, not the toggle or the stub.
    const ctl = openaiBody(openai, 'api_key', 'gpt-6.2-sol', true);
    assert.deepStrictEqual(ctl.reasoning, { effort: 'medium', summary: 'auto' });
});

t('OpenAI oauth, dropped gpt-6-sol → reasoning STILL sent (transport-required), toggle on, off, or synthetic', () => {
    const { openai } = loadAdapters('oauth');
    for (const [enabled, mode] of [[true, 'normal'], [false, 'normal'], [true, 'off']]) {
        const body = openaiBody(openai, 'oauth', 'gpt-6-sol', enabled, mode);
        assert.deepStrictEqual(body.reasoning, { effort: 'medium', summary: 'auto' },
            `toggle=${enabled} mode=${mode}: the Codex transport needs reasoning or returns output: []`);
        assert.strictEqual(body.store, false, 'oauth transport shape');
    }
});

t('Claude, dropped claude-opus-4-8, Extended Thinking ON → no thinking; claude-opus-5-5 control → adaptive', () => {
    const { claude } = loadAdapters('api_key');
    const opts = (model) => ({ reasoningEnabled: true, reasoningSupport: catalog.reasoningSupportFor('claude', model, 'api_key') });
    const dropped = JSON.parse(claude.formatRequest('claude-opus-4-8', 4096, [], [], [], opts('claude-opus-4-8')));
    assert.strictEqual(dropped.thinking, undefined);
    const ctl = JSON.parse(claude.formatRequest('claude-opus-5-5', 4096, [], [], [], opts('claude-opus-5-5')));
    assert.deepStrictEqual(ctl.thinking, { type: 'adaptive' });
});

// ── §3: context-limit coverage ─────────────────────────────────────────────

t('every listed first-party id, and every id dropped in v2.11, has a 200000 MODEL_CONTEXT_LIMITS entry', () => {
    const src = fs.readFileSync(path.join(BUNDLE, 'ai.js'), 'utf8');
    const block = src.slice(src.indexOf('const MODEL_CONTEXT_LIMITS = {'));
    const body = block.slice(0, block.indexOf('\n};'));
    const limits = {};
    for (const m of body.matchAll(/^\s*'([^']+)':\s*(\d+),/gm)) limits[m[1]] = Number(m[2]);
    assert.strictEqual(limits['gpt-5.2'], 200000, 'parser sanity: an old kept entry is seen');
    const ids = [];
    for (const p of ['claude', 'openai', 'xai']) for (const m of byId[p].models) ids.push(m.id);
    for (const d of DROPPED) ids.push(d.id);
    const missing = ids.filter((id) => limits[id] !== 200000);
    assert.deepStrictEqual(missing, [], `ids without a 200000 entry: ${missing.join(', ')}`);
});

// ── run ─────────────────────────────────────────────────────────────────────

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
console.log(`ALL TESTS PASS (${tests.length})`);
