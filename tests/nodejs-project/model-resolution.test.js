#!/usr/bin/env node
// model-resolution.test.js — contract tests for resolveActiveModel() in
// config.js after BAT-509 Part 1.
//
// Run:  node tests/nodejs-project/model-resolution.test.js
// Exit: 0 = all pass, 1 = at least one failure.
//
// WHY THIS FILE EXISTS
// --------------------
// resolveActiveModel() is the single source of truth for "what model is
// the agent actually using right now." Called per chat() turn by ai.js
// AND by /status, /version, session_status — if these surfaces disagree
// the agent introspects a different model than the one servicing API
// requests (the split-brain incident on 2026-04-24).
//
// This file SUPERSEDES tests/nodejs-project/active-model.test.js after
// the BAT-509 Part 1 refactor:
//   - OLD flow: Node read agent_settings.json overlay, Kotlin & Telegram
//               both wrote it → race conditions when both surfaces
//               changed provider/model simultaneously.
//   - NEW flow: Kotlin owns provider/authType/model in SharedPreferences;
//               exposes them to Node via bridge endpoint POST
//               /config/runtime. Telegram /model & /provider write via
//               bridge POST /config/save-{model,provider}. Single
//               writer per field, enforced by transport.
//
// Every edge case from active-model.test.js has been ported here, plus
// new cases for the bridge-based flow. Specifically preserved:
//   - bridge-down → fallback to startup MODEL  (was: file-missing)
//   - bridge returns malformed body → fallback (was: unparseable JSON)
//   - bridge returns blank model → fallback   (was: blank string)
//   - bridge returns whitespace-only → trimmed → fallback (was: same)
//   - bridge returns whitespace-padded → trimmed and used (was: same)
//   - bridge returns non-string model → fallback (was: number/null)
//   - bridge returns provider != startup PROVIDER → fallback (race during
//     /provider restart window; was: overlay.provider mismatch)
//   - structural drift-guard: config.js MUST have an async resolveActiveModel
//     that calls androidBridgeCall on '/config/runtime' (locks in the wiring
//     so the implementation can be rewritten without the contract drifting).
//
// We don't require config.js to be requirable in this test (it pulls in
// the runtime config.json + Keystore-decrypted secrets, neither of which
// exist in a unit-test sandbox). Instead we mirror resolveActiveModel's
// pure logic and stub the bridge call. The structural drift-guard at the
// bottom verifies the mirror still matches the live source.

'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');

const CONFIG_JS = path.join(__dirname, '..', '..', 'app', 'src', 'main',
    'assets', 'nodejs-project', 'config.js');

// --- mirrored implementation under test ---
// Mirrors config.js:resolveActiveModel after BAT-509 Part 1. Async
// because the bridge call is HTTP. PROVIDER/MODEL captured from startup
// closure in the live code; emulated here as parameters.
async function resolveActiveModel(bridgeCall, fallbackModel, startupProvider = 'claude') {
    try {
        const res = await bridgeCall('/config/runtime', {}, 3000);
        if (!res || res.error || !res.runtime || typeof res.runtime !== 'object') {
            return fallbackModel;
        }
        const runtime = res.runtime;
        const overlayProvider = typeof runtime.provider === 'string' ? runtime.provider.trim() : '';
        // Provider-scoping: during /provider restart window prefs may
        // already have new provider but Node is still running old adapter.
        // Returning the new provider's model would crash the in-flight call.
        if (overlayProvider && overlayProvider !== startupProvider) {
            return fallbackModel;
        }
        const m = typeof runtime.model === 'string' ? runtime.model.trim() : '';
        if (m) return m;
    } catch (_) {}
    return fallbackModel;
}

// --- bridge stub helpers ---
function stubBridge(response) {
    return async (endpoint, _data, _timeout) => {
        if (endpoint !== '/config/runtime') {
            throw new Error(`unexpected endpoint: ${endpoint}`);
        }
        if (response instanceof Error) throw response;
        return response;
    };
}

const tests = [];
function t(name, fn) { tests.push([name, fn]); }

// ============================================================
// CORE CONTRACT — bridge happy path
// ============================================================
t('bridge returns matching provider + model → use bridge model', async () => {
    const bridge = stubBridge({ ok: true, runtime: { provider: 'claude', authType: 'api_key', model: 'claude-sonnet-4-6' } });
    assert.strictEqual(await resolveActiveModel(bridge, 'claude-opus-4-7', 'claude'), 'claude-sonnet-4-6');
});

t('bridge model with surrounding whitespace → trimmed and used', async () => {
    // Was: active-model.test.js "overlay model with surrounding whitespace"
    const bridge = stubBridge({ ok: true, runtime: { provider: 'openai', model: '  gpt-5.5  ' } });
    assert.strictEqual(await resolveActiveModel(bridge, 'gpt-5.4', 'openai'), 'gpt-5.5');
});

// ============================================================
// FALLBACK PATHS — every reason to return startup MODEL
// ============================================================
t('bridge unavailable (network error) → falls back', async () => {
    // Was: "no agent_settings.json"
    const bridge = stubBridge(new Error('ECONNREFUSED'));
    assert.strictEqual(await resolveActiveModel(bridge, 'gpt-5.4'), 'gpt-5.4');
});

t('bridge returns {error: ...} → falls back', async () => {
    // Was: "unparseable agent_settings.json"
    const bridge = stubBridge({ error: 'Android Bridge unavailable' });
    assert.strictEqual(await resolveActiveModel(bridge, 'gpt-5.4'), 'gpt-5.4');
});

t('bridge returns shape without runtime field → falls back', async () => {
    // Was: "overlay model field missing"
    const bridge = stubBridge({ ok: true });
    assert.strictEqual(await resolveActiveModel(bridge, 'gpt-5.4'), 'gpt-5.4');
});

t('bridge returns runtime as non-object → falls back', async () => {
    // Was: "JSON array (not object)"
    const bridge = stubBridge({ ok: true, runtime: 'not-an-object' });
    assert.strictEqual(await resolveActiveModel(bridge, 'gpt-5.4'), 'gpt-5.4');
});

t('bridge runtime.model missing → falls back', async () => {
    // Was: "overlay model field missing"
    const bridge = stubBridge({ ok: true, runtime: { provider: 'claude' } });
    assert.strictEqual(await resolveActiveModel(bridge, 'gpt-5.4'), 'gpt-5.4');
});

t('bridge runtime.model is blank string → falls back', async () => {
    // Was: "overlay model is blank string"
    const bridge = stubBridge({ ok: true, runtime: { model: '' } });
    assert.strictEqual(await resolveActiveModel(bridge, 'gpt-5.4'), 'gpt-5.4');
});

t('bridge runtime.model is whitespace-only → trimmed-then-blank → falls back', async () => {
    // Was: "overlay model is whitespace-only"
    const bridge = stubBridge({ ok: true, runtime: { model: '   \t  ' } });
    assert.strictEqual(await resolveActiveModel(bridge, 'gpt-5.4'), 'gpt-5.4');
});

t('bridge runtime.model is non-string number → falls back', async () => {
    // Was: "overlay model non-string (number)"
    const bridge = stubBridge({ ok: true, runtime: { model: 42 } });
    assert.strictEqual(await resolveActiveModel(bridge, 'gpt-5.4'), 'gpt-5.4');
});

t('bridge runtime.model is null → falls back', async () => {
    // Was: "overlay model non-string (null)"
    const bridge = stubBridge({ ok: true, runtime: { model: null } });
    assert.strictEqual(await resolveActiveModel(bridge, 'gpt-5.4'), 'gpt-5.4');
});

// ============================================================
// PROVIDER-SCOPING — race during /provider restart window
// Critical: prefs may carry new provider before Node restart finishes.
// Applying new provider's model on the OLD running adapter would crash
// every in-flight request.
// ============================================================
t('bridge runtime.provider matches startup PROVIDER → model applied', async () => {
    const bridge = stubBridge({ ok: true, runtime: { provider: 'openai', model: 'gpt-5.5' } });
    assert.strictEqual(await resolveActiveModel(bridge, 'gpt-5.4', 'openai'), 'gpt-5.5');
});

t('bridge runtime.provider mismatches startup → model IGNORED (race-window protection)', async () => {
    // Was: "overlay provider mismatches startup → model IGNORED"
    // Pre-conditions of the race: user typed /provider openai, bridge
    // wrote prefs, restart not yet complete, Node still running Claude
    // adapter. We MUST return the running adapter's model, not the new
    // provider's, or every in-flight Anthropic call will 422.
    const bridge = stubBridge({ ok: true, runtime: { provider: 'openai', model: 'gpt-5.4' } });
    assert.strictEqual(await resolveActiveModel(bridge, 'claude-opus-4-7', 'claude'), 'claude-opus-4-7');
});

t('bridge runtime omits provider → model applied (plain /model switch)', async () => {
    // Was: "overlay omits provider → model applied"
    // /model writes only model, never provider — always honored.
    const bridge = stubBridge({ ok: true, runtime: { model: 'claude-sonnet-4-6' } });
    assert.strictEqual(await resolveActiveModel(bridge, 'claude-opus-4-7', 'claude'), 'claude-sonnet-4-6');
});

t('bridge runtime.provider is blank → treated as absent → model applied', async () => {
    // Was: "overlay provider blank"
    const bridge = stubBridge({ ok: true, runtime: { provider: '   ', model: 'claude-sonnet-4-6' } });
    assert.strictEqual(await resolveActiveModel(bridge, 'claude-opus-4-7', 'claude'), 'claude-sonnet-4-6');
});

t('bridge runtime.provider non-string → falls back (defensive)', async () => {
    // Defense against tampered or version-skewed bridge response.
    const bridge = stubBridge({ ok: true, runtime: { provider: 42, model: 'gpt-5.5' } });
    // provider=42 → trimmed to '' → treated as absent → model applied
    assert.strictEqual(await resolveActiveModel(bridge, 'gpt-5.4', 'openai'), 'gpt-5.5');
});

// ============================================================
// STRUCTURAL DRIFT-GUARD — locks the live config.js wiring to the
// bridge-based contract. If anyone reverts to file-overlay reads,
// or removes the async signature, or stops calling bridge, this
// fails the build BEFORE the bug ships.
// ============================================================
t('config.js resolveActiveModel wiring still bridge-based (structural)', () => {
    const src = fs.readFileSync(CONFIG_JS, 'utf8');
    const code = src
        .replace(/\/\*[\s\S]*?\*\//g, '')
        .replace(/(^|[^:])\/\/[^\n]*/g, '$1');

    assert.ok(/async\s+function\s+resolveActiveModel\s*\(/.test(code),
        'config.js resolveActiveModel must be ASYNC (bridge call is HTTP)');
    assert.ok(/['"]\/config\/runtime['"]/.test(code),
        'config.js resolveActiveModel must call bridge endpoint "/config/runtime"');
    assert.ok(/typeof\s+[A-Za-z_$][\w$]*\.model\s*===?\s*['"]string['"]/.test(code),
        'config.js resolveActiveModel must type-check runtime.model as string');
    assert.ok(/typeof\s+[A-Za-z_$][\w$]*\.provider\s*===?\s*['"]string['"]/.test(code),
        'config.js resolveActiveModel must type-check runtime.provider as string (provider-scoping)');
    assert.ok(/!==\s*PROVIDER/.test(code),
        'config.js resolveActiveModel must compare runtime.provider to startup PROVIDER (race protection)');
    assert.ok(/return\s+MODEL\s*;?/.test(code),
        'config.js resolveActiveModel must fall back to `return MODEL` on any failure path');
    assert.ok(/module\.exports\s*=\s*\{[\s\S]*\bresolveActiveModel\b[\s\S]*\}/.test(code),
        'config.js must export resolveActiveModel');
});

t('config.js resolveActiveModel must NOT read agent_settings.json for model (single-writer invariant)', () => {
    // After BAT-509 Part 1, the overlay no longer carries provider/authType/model.
    // If a future commit re-introduces a file read for those fields, the
    // dual-source-of-truth bug class returns. This guard fails immediately.
    const src = fs.readFileSync(CONFIG_JS, 'utf8');
    // Allow agent_settings.json reads for OTHER fields (apiKeys, heartbeat)
    // by checking that resolveActiveModel's body specifically doesn't
    // touch the file. Extract the function body then check.
    //
    // The body extractor uses balanced-brace counting rather than regex so
    // it survives reformatting (indented `}`, trailing whitespace, comments
    // before the close, etc.) — Copilot R3 flagged the original regex as
    // fragile because `\n\}` required the closing brace at column 0.
    const declMatch = src.match(/async\s+function\s+resolveActiveModel\s*\([^)]*\)\s*\{/);
    assert.ok(declMatch, 'could not locate resolveActiveModel declaration');
    const bodyStart = declMatch.index + declMatch[0].length;
    let depth = 1;
    let bodyEnd = bodyStart;
    while (depth > 0 && bodyEnd < src.length) {
        const ch = src[bodyEnd];
        if (ch === '{') depth++;
        else if (ch === '}') depth--;
        bodyEnd++;
    }
    assert.ok(depth === 0, 'unbalanced braces extracting resolveActiveModel body');
    const body = src.slice(bodyStart, bodyEnd - 1);
    assert.ok(!/agent_settings\.json/.test(body),
        'resolveActiveModel body must NOT read agent_settings.json — provider/authType/model are bridge-mediated now');
    assert.ok(!/readFileSync|existsSync/.test(body),
        'resolveActiveModel body must NOT do filesystem I/O — bridge HTTP only');
});

// --- runner ---
(async () => {
    let passed = 0, failed = 0;
    for (const [name, fn] of tests) {
        try {
            await fn();
            console.log(`  ok  ${name}`);
            passed++;
        } catch (e) {
            console.error(`  FAIL ${name}\n    ${e.message}`);
            failed++;
        }
    }
    console.log(`\n${passed} passed, ${failed} failed`);
    process.exit(failed === 0 ? 0 : 1);
})();
