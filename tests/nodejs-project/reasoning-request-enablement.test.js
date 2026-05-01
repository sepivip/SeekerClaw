#!/usr/bin/env node
// reasoning-request-enablement.test.js — pin BAT-549 Commit 3c per-adapter
// request-side reasoning enablement gating, EXTENDED for BAT-558 v4:
// per-request budget clamp on Claude, synthetic-turn marker
// (`reasoningMode: 'off'`) suppression matrix, OpenRouter explicit
// `effort: 'none'` disablement signal.
//
//  Adapter contract: each adapter's formatRequest accepts an optional 6th
//  `requestOptions` argument. When BOTH `reasoningEnabled === true` AND
//  `reasoningSupport === "yes"`, the adapter MUST emit its provider-
//  specific reasoning param. Any other combination MUST NOT emit (the
//  registry's "yes" gate is authoritative; "no"/"unknown" never sends).
//
//  Per-adapter body shapes (BAT-549 baseline + BAT-558 v4 R1/R3):
//   - claude.js → body.thinking = {type:"enabled", budget_tokens: <clamped>}
//                  where <clamped> = min(16000, floor(maxTokens*0.5))
//                  AND maxTokens >= 2048 (smaller turns SKIP thinking entirely)
//   - openai.js (api_key) → body.reasoning = {effort:"medium", summary:"auto"}
//                          + body.include = ["reasoning.encrypted_content"]
//   - openrouter.js → body.reasoning = {effort:"medium"} OR
//                     {effort:"none"} on `reasoningMode:'off'` (BAT-558 R3)
//   - custom.js → forwards to delegate (or no-op for chat-completions)
//
//  Preservation of existing hardcodes (don't regress):
//   - openai OAuth/Codex path: body.reasoning ALWAYS set, even on
//     `reasoningMode:'off'` — transport-required exception per BAT-485.
//     v4 R3 explicitly preserves this; we pin it as a regression guard.
//   - claude headers: anthropic-beta now includes interleaved-thinking-2025-05-14
//
//  Backward compat: callers that don't pass requestOptions get the same
//  no-reasoning-enabled body as before BAT-549 Commit 3c.
//
// Run:  node tests/nodejs-project/reasoning-request-enablement.test.js

'use strict';

const path = require('path');
const configPath = path.resolve(__dirname, '../../app/src/main/assets/nodejs-project/config.js');
const bridgePath = path.resolve(__dirname, '../../app/src/main/assets/nodejs-project/bridge.js');

let _openaiAuthType = 'api_key';
require.cache[configPath] = {
    id: configPath, filename: configPath, loaded: true,
    exports: {
        log: () => {},
        OPENAI_OAUTH_TOKEN: 'fake-oauth',
        OPENAI_OAUTH_REFRESH: 'fake-refresh',
        get OPENAI_AUTH_TYPE() { return _openaiAuthType; },
        OPENROUTER_FALLBACK_MODEL: '',
        OPENROUTER_KEY: 'fake-or-key',
        CUSTOM_KEY: 'fake-custom-key',
        CUSTOM_HEADERS: {},
        CUSTOM_FORMAT: 'chat_completions',
        CUSTOM_ENDPOINT: { protocol: 'https:', hostname: 'gateway.example', port: 443, path: '/v1/chat/completions' },
        resolveActiveModel: () => 'gpt-4',
    },
};
require.cache[bridgePath] = {
    id: bridgePath, filename: bridgePath, loaded: true,
    exports: { androidBridgeCall: async () => ({}) },
};

const claude = require('../../app/src/main/assets/nodejs-project/providers/claude');
const openai = require('../../app/src/main/assets/nodejs-project/providers/openai');
const openrouter = require('../../app/src/main/assets/nodejs-project/providers/openrouter');

let failures = 0;
function ok(label, cond, hint = '') {
    if (cond) console.log(`PASS: ${label}`);
    else { console.log(`FAIL: ${label}${hint ? ' — ' + hint : ''}`); failures++; }
}
function eq(label, actual, expected) {
    const a = JSON.stringify(actual), e = JSON.stringify(expected);
    if (a === e) console.log(`PASS: ${label}`);
    else { console.log(`FAIL: ${label}\n  actual:   ${a}\n  expected: ${e}`); failures++; }
}

// ── Claude (Anthropic Messages API) ────────────────────────────────

console.log('── claude.js: thinking gate ──');

// reasoningEnabled + support===yes + maxTokens=4096 → emit, BAT-558 R1 clamp
// kicks in: budget = floor(4096*0.5) = 2048 (NOT the pre-558 unconditional 16000)
let body = JSON.parse(claude.formatRequest('claude-opus-4-7', 4096, [], [], [], {
    reasoningEnabled: true, reasoningSupport: 'yes',
}));
eq('Claude yes/yes maxTokens=4096: body.thinking emitted with clamped budget (BAT-558 R1)',
    body.thinking, { type: 'enabled', budget_tokens: 2048 });

// reasoningEnabled but support===no (Haiku) → DO NOT emit
body = JSON.parse(claude.formatRequest('claude-haiku-4-5', 4096, [], [], [], {
    reasoningEnabled: true, reasoningSupport: 'no',
}));
ok('Claude yes/no: body.thinking NOT emitted (Haiku regression guard)',
    body.thinking === undefined);

// reasoningEnabled but support===unknown → DO NOT emit
body = JSON.parse(claude.formatRequest('claude-future-x', 4096, [], [], [], {
    reasoningEnabled: true, reasoningSupport: 'unknown',
}));
ok('Claude yes/unknown: body.thinking NOT emitted (safe default)',
    body.thinking === undefined);

// reasoningEnabled=false (toggle off) → DO NOT emit even when support===yes
body = JSON.parse(claude.formatRequest('claude-opus-4-7', 4096, [], [], [], {
    reasoningEnabled: false, reasoningSupport: 'yes',
}));
ok('Claude off/yes: body.thinking NOT emitted (toggle off)',
    body.thinking === undefined);

// No requestOptions arg → backward compat (pre-3c behavior)
body = JSON.parse(claude.formatRequest('claude-opus-4-7', 4096, [], [], []));
ok('Claude legacy (no opts): body.thinking NOT emitted',
    body.thinking === undefined);

// Existing body shape preserved
body = JSON.parse(claude.formatRequest('claude-opus-4-7', 4096, ['sys'], [{role:'user', content:'hi'}], [{name:'tool', description:'d', input_schema:{}}], {
    reasoningEnabled: true, reasoningSupport: 'yes',
}));
eq('Claude: body.model preserved', body.model, 'claude-opus-4-7');
eq('Claude: body.max_tokens preserved', body.max_tokens, 4096);
eq('Claude: body.system preserved', body.system, ['sys']);
eq('Claude: body.messages preserved', body.messages, [{role:'user', content:'hi'}]);
ok('Claude: body.tools preserved', Array.isArray(body.tools) && body.tools.length === 1);

// Header beta tag includes interleaved-thinking
const apiKeyHeaders = claude.buildHeaders('sk-ant-fake', 'api_key');
ok('Claude headers (api_key): anthropic-beta includes interleaved-thinking-2025-05-14',
    apiKeyHeaders['anthropic-beta'].includes('interleaved-thinking-2025-05-14'),
    `actual: ${apiKeyHeaders['anthropic-beta']}`);
ok('Claude headers (api_key): anthropic-beta still includes prompt-caching',
    apiKeyHeaders['anthropic-beta'].includes('prompt-caching-2024-07-31'));

const setupHeaders = claude.buildHeaders('sk-ant-setup-fake', 'setup_token');
ok('Claude headers (setup_token): anthropic-beta includes interleaved-thinking-2025-05-14',
    setupHeaders['anthropic-beta'].includes('interleaved-thinking-2025-05-14'));
ok('Claude headers (setup_token): anthropic-beta still includes oauth-2025-04-20',
    setupHeaders['anthropic-beta'].includes('oauth-2025-04-20'));

// ── OpenAI (Responses API) ────────────────────────────────────────

console.log();
console.log('── openai.js: reasoning gate (api_key path) ──');

// api_key + reasoningEnabled + support===yes → emit
body = JSON.parse(openai.formatRequest('gpt-5.4', 4096, 'sys', [], [], {
    reasoningEnabled: true, reasoningSupport: 'yes',
}));
eq('OpenAI api_key yes/yes: body.reasoning emitted',
    body.reasoning, { effort: 'medium', summary: 'auto' });
eq('OpenAI api_key yes/yes: body.include emitted (encrypted_content)',
    body.include, ['reasoning.encrypted_content']);

// api_key + support===no → DO NOT emit
body = JSON.parse(openai.formatRequest('gpt-3.5-turbo', 4096, 'sys', [], [], {
    reasoningEnabled: true, reasoningSupport: 'no',
}));
ok('OpenAI api_key yes/no: body.reasoning NOT emitted',
    body.reasoning === undefined);
ok('OpenAI api_key yes/no: body.include NOT emitted',
    body.include === undefined);

// api_key + support===unknown → DO NOT emit
body = JSON.parse(openai.formatRequest('gpt-future-x', 4096, 'sys', [], [], {
    reasoningEnabled: true, reasoningSupport: 'unknown',
}));
ok('OpenAI api_key yes/unknown: body.reasoning NOT emitted',
    body.reasoning === undefined);

// api_key + reasoningEnabled=false → DO NOT emit
body = JSON.parse(openai.formatRequest('gpt-5.4', 4096, 'sys', [], [], {
    reasoningEnabled: false, reasoningSupport: 'yes',
}));
ok('OpenAI api_key off/yes: body.reasoning NOT emitted (toggle off)',
    body.reasoning === undefined);

// No requestOptions on api_key non-codex → DO NOT emit (legacy compat)
body = JSON.parse(openai.formatRequest('gpt-3.5-turbo', 4096, 'sys', [], []));
ok('OpenAI api_key legacy: body.reasoning NOT emitted',
    body.reasoning === undefined);

// Codex model on api_key (transport hardcode preserved) — emit even without toggle
body = JSON.parse(openai.formatRequest('gpt-5.3-codex', 4096, 'sys', [], []));
ok('OpenAI api_key + codex model (transport hardcode): body.reasoning emitted regardless of toggle',
    body.reasoning && body.reasoning.effort === 'medium');
ok('OpenAI api_key + codex model: body.include emitted',
    Array.isArray(body.include) && body.include.includes('reasoning.encrypted_content'));

console.log();
console.log('── openai.js: reasoning gate (OAuth path — transport hardcode) ──');

// Reload openai with OAuth
_openaiAuthType = 'oauth';
delete require.cache[require.resolve('../../app/src/main/assets/nodejs-project/providers/openai')];
const openaiOauth = require('../../app/src/main/assets/nodejs-project/providers/openai');

// OAuth + no requestOptions → still emit (transport hardcode preserved)
body = JSON.parse(openaiOauth.formatRequest('gpt-5.4', 4096, 'sys', [], []));
ok('OpenAI OAuth legacy (no opts): body.reasoning emitted (transport req)',
    body.reasoning && body.reasoning.effort === 'medium');
ok('OpenAI OAuth: body.store === false', body.store === false);

// OAuth + reasoningEnabled=false → STILL emit (transport overrides toggle off)
body = JSON.parse(openaiOauth.formatRequest('gpt-5.4', 4096, 'sys', [], [], {
    reasoningEnabled: false, reasoningSupport: 'no',
}));
ok('OpenAI OAuth off/no: body.reasoning STILL emitted (transport hardcode wins)',
    body.reasoning && body.reasoning.effort === 'medium');

// Reset to api_key for downstream tests
_openaiAuthType = 'api_key';

// ── OpenRouter (Chat Completions) ──────────────────────────────────

console.log();
console.log('── openrouter.js: reasoning gate ──');

// reasoningEnabled + support===yes → emit
body = JSON.parse(openrouter.formatRequest('anthropic/claude-opus-4-7', 4096, 'sys', [], [], {
    reasoningEnabled: true, reasoningSupport: 'yes',
}));
eq('OpenRouter yes/yes: body.reasoning emitted',
    body.reasoning, { effort: 'medium' });

// support===unknown (the OR default for freeform) → DO NOT emit
body = JSON.parse(openrouter.formatRequest('anthropic/claude-opus-4-7', 4096, 'sys', [], [], {
    reasoningEnabled: true, reasoningSupport: 'unknown',
}));
ok('OpenRouter yes/unknown: body.reasoning NOT emitted (freeform default)',
    body.reasoning === undefined);

// reasoningEnabled=false → DO NOT emit
body = JSON.parse(openrouter.formatRequest('anthropic/claude-opus-4-7', 4096, 'sys', [], [], {
    reasoningEnabled: false, reasoningSupport: 'yes',
}));
ok('OpenRouter off/yes: body.reasoning NOT emitted (toggle off)',
    body.reasoning === undefined);

// No requestOptions → DO NOT emit (legacy compat)
body = JSON.parse(openrouter.formatRequest('anthropic/claude-opus-4-7', 4096, 'sys', [], []));
ok('OpenRouter legacy (no opts): body.reasoning NOT emitted',
    body.reasoning === undefined);

// Existing body shape preserved
body = JSON.parse(openrouter.formatRequest('foo/model', 4096, 'sys-prompt', [{role:'user',content:'hi'}], [], {
    reasoningEnabled: true, reasoningSupport: 'yes',
}));
eq('OpenRouter: body.cache_control preserved', body.cache_control, { type: 'ephemeral' });
eq('OpenRouter: system message preserved as first message',
    body.messages[0], { role: 'system', content: 'sys-prompt' });

// ── Custom (delegates) ─────────────────────────────────────────────

console.log();
console.log('── custom.js: chat-completions formatRequest does NOT emit reasoning ──');

// Re-cache config with chat-completions Custom format
delete require.cache[configPath];
require.cache[configPath] = {
    id: configPath, filename: configPath, loaded: true,
    exports: {
        log: () => {},
        OPENAI_OAUTH_TOKEN: 'fake', OPENAI_OAUTH_REFRESH: 'fake',
        get OPENAI_AUTH_TYPE() { return _openaiAuthType; },
        OPENROUTER_FALLBACK_MODEL: '',
        OPENROUTER_KEY: 'fake',
        CUSTOM_KEY: 'fake',
        CUSTOM_HEADERS: {},
        CUSTOM_FORMAT: 'chat_completions',
        CUSTOM_ENDPOINT: { protocol: 'https:', hostname: 'gw', port: 443, path: '/v1/chat/completions' },
        resolveActiveModel: () => 'deepseek-v4-pro',
    },
};
delete require.cache[require.resolve('../../app/src/main/assets/nodejs-project/providers/custom')];
delete require.cache[require.resolve('../../app/src/main/assets/nodejs-project/providers/openai')];
delete require.cache[require.resolve('../../app/src/main/assets/nodejs-project/providers/openrouter')];
delete require.cache[require.resolve('../../app/src/main/assets/nodejs-project/reasoning-gating')];
const customCC = require('../../app/src/main/assets/nodejs-project/providers/custom');

body = JSON.parse(customCC.formatRequest('deepseek-v4-pro', 4096, 'sys', [{role:'user',content:'hi'}], [], {
    reasoningEnabled: true, reasoningSupport: 'unknown',
}));
ok('Custom chat-completions: body.reasoning NOT emitted (Custom defines own clean shape)',
    body.reasoning === undefined);
eq('Custom chat-completions: body.model preserved', body.model, 'deepseek-v4-pro');
ok('Custom chat-completions: body.messages preserved as system+user',
    body.messages[0].role === 'system' && body.messages[1].role === 'user');

console.log();
console.log('── custom.js: responses-format formatRequest forwards to OpenAI delegate ──');

// Switch to responses format
delete require.cache[configPath];
require.cache[configPath] = {
    id: configPath, filename: configPath, loaded: true,
    exports: {
        log: () => {},
        OPENAI_OAUTH_TOKEN: 'fake', OPENAI_OAUTH_REFRESH: 'fake',
        get OPENAI_AUTH_TYPE() { return _openaiAuthType; },
        OPENROUTER_FALLBACK_MODEL: '',
        OPENROUTER_KEY: 'fake',
        CUSTOM_KEY: 'fake',
        CUSTOM_HEADERS: {},
        CUSTOM_FORMAT: 'responses',
        CUSTOM_ENDPOINT: { protocol: 'https:', hostname: 'gw', port: 443, path: '/v1/responses' },
        resolveActiveModel: () => 'gpt-5.4',
    },
};
delete require.cache[require.resolve('../../app/src/main/assets/nodejs-project/providers/custom')];
delete require.cache[require.resolve('../../app/src/main/assets/nodejs-project/providers/openai')];
const customResponses = require('../../app/src/main/assets/nodejs-project/providers/custom');

body = JSON.parse(customResponses.formatRequest('gpt-5.4', 4096, 'sys', [], [], {
    reasoningEnabled: true, reasoningSupport: 'yes',
}));
eq('Custom responses-format yes/yes: body.reasoning emitted via OpenAI delegate',
    body.reasoning, { effort: 'medium', summary: 'auto' });

body = JSON.parse(customResponses.formatRequest('gpt-5.4', 4096, 'sys', [], [], {
    reasoningEnabled: false, reasoningSupport: 'yes',
}));
ok('Custom responses-format off/yes: body.reasoning NOT emitted (toggle off)',
    body.reasoning === undefined);

console.log();
console.log('── custom.js: toApiMessages reads customEchoOverride from requestOptions ──');

// Construct an assistant message with reasoningBlocks. With override=true,
// gating must promote unknown→echo (block stays); with override=false the
// block is stripped (gating decides 'unknown'→capture-only).
const unknownEchoMsg = {
    role: 'assistant', content: 'r',
    toolCalls: [{ id: 'fc1', name: 'echo', input: {} }],
    reasoningBlocks: [{
        schemaVersion: 1, provider: 'custom', sourceAdapter: 'custom',
        delegateAdapter: 'openrouter', sourceModel: 'unknown-future-model',
        wire: { reasoning_content: 'opaque-reasoning' },
    }],
};

// Reload Custom in chat-completions to test gating without OpenAI delegate noise
delete require.cache[configPath];
require.cache[configPath] = {
    id: configPath, filename: configPath, loaded: true,
    exports: {
        log: () => {},
        OPENAI_OAUTH_TOKEN: 'fake', OPENAI_OAUTH_REFRESH: 'fake',
        get OPENAI_AUTH_TYPE() { return _openaiAuthType; },
        OPENROUTER_FALLBACK_MODEL: '',
        OPENROUTER_KEY: 'fake',
        CUSTOM_KEY: 'fake',
        CUSTOM_HEADERS: {},
        CUSTOM_FORMAT: 'chat_completions',
        CUSTOM_ENDPOINT: { protocol: 'https:', hostname: 'gw', port: 443, path: '/v1/chat/completions' },
        resolveActiveModel: () => 'unknown-future-model',
    },
};
delete require.cache[require.resolve('../../app/src/main/assets/nodejs-project/providers/custom')];
delete require.cache[require.resolve('../../app/src/main/assets/nodejs-project/providers/openrouter')];
delete require.cache[require.resolve('../../app/src/main/assets/nodejs-project/reasoning-gating')];
const custom2 = require('../../app/src/main/assets/nodejs-project/providers/custom');

// Test gating decision via the public test seam — pin behavior at the
// gating-function boundary (stable contract; toApiMessages emit-shape is
// delegate-specific and harder to assert generically).
const behaviorWithoutOverride = custom2._detectEchoBehaviorForTest('unknown-future-model', false);
const behaviorWithOverride = custom2._detectEchoBehaviorForTest('unknown-future-model', true);
ok('Custom unknown-model + override=false → unknown (capture-only)',
    behaviorWithoutOverride === 'unknown',
    `actual: ${behaviorWithoutOverride}`);
ok('Custom unknown-model + override=true → echo-on-tool-loop (3c override path)',
    behaviorWithOverride === 'echo-on-tool-loop',
    `actual: ${behaviorWithOverride}`);

// Now exercise the toApiMessages path: with override=true the unknown
// model should NOT have its reasoningBlocks stripped pre-delegation
// (gating became echo-on-tool-loop). With override=false the gating
// decided 'unknown' → strip → reasoningBlocks cleared on the delegate
// input. We assert by checking the gated message's reasoningBlocks
// directly using a wrapped message clone.
function deepCopy(o) { return JSON.parse(JSON.stringify(o)); }

const noOverrideOpts = { reasoningEnabled: false, reasoningSupport: 'unknown', customEchoOverride: false };
const withOverrideOpts = { reasoningEnabled: false, reasoningSupport: 'unknown', customEchoOverride: true };

// Use an Anthropic-format conversation snippet so the openrouter delegate's
// transformation doesn't drop our reasoningBlocks unrelated to gating.
const convoSnippet = [
    { role: 'user', content: 'hello' },
    deepCopy(unknownEchoMsg),
    { role: 'tool', toolCallId: 'fc1', content: 'tool result' },
];

// override=false: openrouter delegate's emit path should see assistant
// message with reasoningBlocks=[] (stripped pre-delegation).
const inputNoOverride = custom2.toApiMessages(deepCopy(convoSnippet), 'unknown-future-model', noOverrideOpts);
// In Chat Completions output the reasoning_content field would only be set
// on the last assistant message if the delegate echoes it. We can't observe
// the inner reasoningBlocks directly post-delegation without coupling to
// openrouter internals — so we verify behavior via the assistant turn's
// emitted content shape. The simplest pin: with override=false on an
// "unknown" model, the openrouter delegate's gating ALSO sees "unknown"
// and emits NO `reasoning_content` field on the assistant. With
// override=true, openrouter still sees "unknown" (it gates on its own
// model regex independently), so override-path body shape is the SAME
// for openrouter — which is correct (Custom's override only affects
// Custom's pre-delegation strip, not the delegate's own gating).
// The contract pinned by the unit-test seam above is the contract; the
// toApiMessages path is exercised here only to confirm no crash:
ok('Custom toApiMessages override=false: returns array',
    Array.isArray(inputNoOverride));
const inputWithOverride = custom2.toApiMessages(deepCopy(convoSnippet), 'unknown-future-model', withOverrideOpts);
ok('Custom toApiMessages override=true: returns array',
    Array.isArray(inputWithOverride));

// No requestOptions arg → defaults to override=false (legacy behavior)
const inputLegacy = custom2.toApiMessages(deepCopy(convoSnippet), 'unknown-future-model');
ok('Custom toApiMessages legacy (no opts): returns array (default override=false)',
    Array.isArray(inputLegacy));

console.log();
console.log('── 3c R6 Fix 1: Custom-Responses delegate-id resolution ──');

// The ai.js chat() loop resolves reasoningSupport via the DELEGATE provider
// id ('openai') when Custom is configured for the Responses transport.
// Without this routing, the user toggle would be permanently dead on
// Custom-Responses gateways pointing at known reasoning models (e.g.,
// gpt-5.4 on a self-hosted Responses-compatible proxy).
//
// This test pins the underlying registry contract that ai.js relies on:
//   - reasoningSupportFor('custom', 'gpt-5.4', 'api_key') → 'unknown'
//     (custom is freeform; resolving here would hide a known-yes model)
//   - reasoningSupportFor('openai', 'gpt-5.4', 'api_key') → 'yes'
//     (openai api_key list contains gpt-5.4; the delegate resolution
//      lights up the toggle path)
const { reasoningSupportFor: rsf } = require('../../app/src/main/assets/nodejs-project/model-catalog');
ok("Custom registry resolution: 'gpt-5.4' under 'custom' is 'unknown' (freeform)",
    rsf('custom', 'gpt-5.4', 'api_key') === 'unknown',
    `actual: ${rsf('custom', 'gpt-5.4', 'api_key')}`);
ok("Delegate routing target: 'gpt-5.4' under 'openai' api_key is 'yes'",
    rsf('openai', 'gpt-5.4', 'api_key') === 'yes',
    `actual: ${rsf('openai', 'gpt-5.4', 'api_key')}`);
ok("Delegate-id robustness: unknown model id under 'openai' stays 'unknown'",
    rsf('openai', 'some-unknown-deepseek-id', 'api_key') === 'unknown');

// ── BAT-558 v4 R1 — Claude budget clamp + small-turn skip ─────────────
// Pinned per the v4 §R6 acceptance matrix. ai.js calls
// formatRequest(..., 4096, ...) for normal chat — this 4096 is the
// real-world value that surfaced the unclamped 16000 budget bug. Each
// case here is taken from the v4 worked-examples table.

console.log();
console.log('── BAT-558 v4 R1: Claude budget clamp ──');

// maxTokens=2048 → budget = floor(1024) = 1024 (Anthropic floor), answer room 1024.
body = JSON.parse(claude.formatRequest('claude-opus-4-7', 2048, [], [], [], {
    reasoningEnabled: true, reasoningSupport: 'yes',
}));
eq('Claude maxTokens=2048: budget clamped to floor (1024)',
    body.thinking, { type: 'enabled', budget_tokens: 1024 });

// maxTokens=1536 → SKIP thinking entirely (v3 amendment 1 gap-case Codex called out).
body = JSON.parse(claude.formatRequest('claude-opus-4-7', 1536, [], [], [], {
    reasoningEnabled: true, reasoningSupport: 'yes',
}));
ok('Claude maxTokens=1536: thinking SKIPPED (BAT-558 R1 small-turn floor)',
    body.thinking === undefined,
    `actual: ${JSON.stringify(body.thinking)}`);

// maxTokens=1024 → SKIP thinking entirely (below MIN_THINKING_TURN=2048).
body = JSON.parse(claude.formatRequest('claude-opus-4-7', 1024, [], [], [], {
    reasoningEnabled: true, reasoningSupport: 'yes',
}));
ok('Claude maxTokens=1024: thinking SKIPPED',
    body.thinking === undefined);

// maxTokens=32000 → DEFAULT_THINKING_BUDGET cap (16000); not floor(32000*0.5)=16000.
body = JSON.parse(claude.formatRequest('claude-opus-4-7', 32000, [], [], [], {
    reasoningEnabled: true, reasoningSupport: 'yes',
}));
eq('Claude maxTokens=32000: budget at DEFAULT cap (16000)',
    body.thinking, { type: 'enabled', budget_tokens: 16000 });

// maxTokens=64000 → DEFAULT_THINKING_BUDGET cap (16000); leaves 48000 for answer.
body = JSON.parse(claude.formatRequest('claude-opus-4-7', 64000, [], [], [], {
    reasoningEnabled: true, reasoningSupport: 'yes',
}));
eq('Claude maxTokens=64000: budget still at DEFAULT cap (16000)',
    body.thinking, { type: 'enabled', budget_tokens: 16000 });

// Final invariant guard: across the entire matrix above, when emitted,
// budget_tokens is ALWAYS strictly less than max_tokens (Anthropic's
// hard requirement). This is the bug class the original 400 surfaced.
const claudeBudgetCases = [
    { maxTokens: 2048,  expectEmit: true },
    { maxTokens: 4096,  expectEmit: true },
    { maxTokens: 32000, expectEmit: true },
    { maxTokens: 64000, expectEmit: true },
];
for (const c of claudeBudgetCases) {
    const cb = JSON.parse(claude.formatRequest('claude-opus-4-7', c.maxTokens, [], [], [], {
        reasoningEnabled: true, reasoningSupport: 'yes',
    }));
    if (c.expectEmit) {
        ok(`Claude maxTokens=${c.maxTokens}: budget < max_tokens (Anthropic invariant)`,
            cb.thinking && cb.thinking.budget_tokens < c.maxTokens,
            `budget=${cb.thinking?.budget_tokens}, max=${c.maxTokens}`);
        ok(`Claude maxTokens=${c.maxTokens}: budget >= ANTHROPIC_MIN_BUDGET (1024)`,
            cb.thinking && cb.thinking.budget_tokens >= 1024,
            `budget=${cb.thinking?.budget_tokens}`);
    }
}

// ── BAT-558 v4 R3 — synthetic-turn marker `reasoningMode: 'off'` ──────
// Per-provider behavior matrix from v4 R3. Heartbeat call site sends this;
// ai.js also defensively forces it for chatId === '__heartbeat__'.

console.log();
console.log('── BAT-558 v4 R3: reasoningMode=off matrix ──');

// Claude — OFF skips thinking even when toggle+support would emit.
body = JSON.parse(claude.formatRequest('claude-opus-4-7', 4096, [], [], [], {
    reasoningEnabled: true, reasoningSupport: 'yes',
    reasoningMode: 'off',
}));
ok('Claude reasoningMode=off: thinking NOT emitted (synthetic suppression)',
    body.thinking === undefined);

// OpenAI api_key non-Codex — OFF suppresses body.reasoning + body.include.
// Reload openai with api_key for this branch.
delete require.cache[require.resolve('../../app/src/main/assets/nodejs-project/providers/openai')];
_openaiAuthType = 'api_key';
const openaiApiKey = require('../../app/src/main/assets/nodejs-project/providers/openai');
body = JSON.parse(openaiApiKey.formatRequest('gpt-5.4', 4096, 'sys', [], [], {
    reasoningEnabled: true, reasoningSupport: 'yes',
    reasoningMode: 'off',
}));
ok('OpenAI api_key reasoningMode=off: body.reasoning NOT emitted',
    body.reasoning === undefined);
ok('OpenAI api_key reasoningMode=off: body.include NOT emitted',
    body.include === undefined);

// OpenAI OAuth/Codex — OFF MUST PRESERVE body.reasoning (transport-required).
// This is the BAT-485 invariant pinned exception: Codex endpoint returns
// `output: []` without reasoning, so suppressing it would break Codex
// users entirely. v4 R3 explicitly excludes OAuth from synthetic suppression.
delete require.cache[require.resolve('../../app/src/main/assets/nodejs-project/providers/openai')];
_openaiAuthType = 'oauth';
const openaiOauthOff = require('../../app/src/main/assets/nodejs-project/providers/openai');
body = JSON.parse(openaiOauthOff.formatRequest('gpt-5.4', 4096, 'sys', [], [], {
    reasoningEnabled: true, reasoningSupport: 'yes',
    reasoningMode: 'off',
}));
ok('OpenAI OAuth reasoningMode=off: body.reasoning STILL emitted (BAT-485 transport invariant)',
    body.reasoning && body.reasoning.effort === 'medium',
    `actual: ${JSON.stringify(body.reasoning)}`);

// OpenAI api_key + codex model — OFF MUST PRESERVE (model-id-driven hardcode).
delete require.cache[require.resolve('../../app/src/main/assets/nodejs-project/providers/openai')];
_openaiAuthType = 'api_key';
const openaiCodexOff = require('../../app/src/main/assets/nodejs-project/providers/openai');
body = JSON.parse(openaiCodexOff.formatRequest('gpt-5.3-codex', 4096, 'sys', [], [], {
    reasoningEnabled: false, reasoningSupport: 'yes',
    reasoningMode: 'off',
}));
ok('OpenAI api_key + codex model + reasoningMode=off: body.reasoning STILL emitted (codex hardcode)',
    body.reasoning && body.reasoning.effort === 'medium');

// OpenRouter — OFF emits explicit disablement signal `effort: 'none'`.
// This is STRONGER than just omitting (some OR reasoning models reason by
// default per OR docs). The `reasoning` key IS present, with the disable
// signal — that's the v4 R3 contract.
delete require.cache[require.resolve('../../app/src/main/assets/nodejs-project/providers/openrouter')];
const openrouterOff = require('../../app/src/main/assets/nodejs-project/providers/openrouter');
body = JSON.parse(openrouterOff.formatRequest('openai/gpt-5.4', 4096, 'sys', [], [], {
    reasoningEnabled: true, reasoningSupport: 'yes',
    reasoningMode: 'off',
}));
eq("OpenRouter reasoningMode=off: body.reasoning = { effort: 'none' } (explicit disable signal)",
    body.reasoning, { effort: 'none' });

// OpenRouter — OFF takes precedence over user-toggle (defensive, contract-belt).
// If somehow both reasoningMode='off' AND reasoningEnabled=true coexist,
// the off signal wins because the caller marked the turn synthetic.
body = JSON.parse(openrouterOff.formatRequest('openai/gpt-5.4', 4096, 'sys', [], [], {
    reasoningEnabled: true, reasoningSupport: 'yes',
    reasoningMode: 'off',
}));
eq("OpenRouter reasoningMode=off + toggle on: off STILL wins",
    body.reasoning, { effort: 'none' });

// Custom chat-completions — already doesn't emit body.reasoning; OFF unchanged.
const customPath = require.resolve('../../app/src/main/assets/nodejs-project/providers/custom');
delete require.cache[customPath];
delete require.cache[require.resolve('../../app/src/main/assets/nodejs-project/providers/openai')];
_openaiAuthType = 'api_key';
// Force chat_completions format
const config2 = require.cache[configPath].exports;
config2.CUSTOM_FORMAT = 'chat_completions';
const customChat = require('../../app/src/main/assets/nodejs-project/providers/custom');
body = JSON.parse(customChat.formatRequest('deepseek-v4', 4096, 'sys', [], [], {
    reasoningEnabled: true, reasoningSupport: 'yes',
    reasoningMode: 'off',
}));
ok('Custom chat-completions reasoningMode=off: body.reasoning NOT emitted (no regression)',
    body.reasoning === undefined);

// Custom Responses — delegates to openai.formatRequest, follows OpenAI
// optional-off behavior (suppress body.reasoning + body.include for
// non-OAuth/non-codex). Pin the round-trip.
delete require.cache[customPath];
delete require.cache[require.resolve('../../app/src/main/assets/nodejs-project/providers/openai')];
_openaiAuthType = 'api_key';
config2.CUSTOM_FORMAT = 'responses';
const customResp = require('../../app/src/main/assets/nodejs-project/providers/custom');
body = JSON.parse(customResp.formatRequest('gpt-5.4', 4096, 'sys', [], [], {
    reasoningEnabled: true, reasoningSupport: 'yes',
    reasoningMode: 'off',
}));
ok('Custom Responses reasoningMode=off: body.reasoning NOT emitted (delegates to OpenAI optional-off)',
    body.reasoning === undefined);

// R3 Copilot: Custom Responses + codex model + reasoningMode='off'
// MUST PRESERVE body.reasoning — the codex model-id-driven hardcode
// in the openai delegate is transport-required (Codex endpoint
// returns `output: []` without `body.reasoning`). The same exception
// applies to Custom Responses because the delegation IS the OpenAI
// Responses transport. Pinning this prevents a future refactor from
// silently breaking Codex through a Custom-Responses gateway.
body = JSON.parse(customResp.formatRequest('gpt-5.3-codex', 4096, 'sys', [], [], {
    reasoningEnabled: false, reasoningSupport: 'yes',
    reasoningMode: 'off',
}));
ok('Custom Responses + codex model + reasoningMode=off: body.reasoning STILL emitted (codex transport hardcode)',
    body.reasoning && body.reasoning.effort === 'medium',
    `actual: ${JSON.stringify(body.reasoning)}`);

// ── BAT-558 v4 R4 — log dedup ────────────────────────────────────────
// First occurrence per (process, reason) at INFO; subsequent at DEBUG.
// Pin the level-selection logic so a future refactor doesn't regress
// the rate limit (heartbeat probes every 30 min would otherwise flood
// the Logs screen).

console.log();
console.log('── BAT-558 v4 R4: suppression-log dedup ──');

// Capture log calls instead of printing them. Replace the test stub's
// log() with a recorder. The reasoning-gating module already imported
// log from config, but since we control config's exports via require.cache,
// swap it now.
const _logRecord = [];
require.cache[configPath].exports.log = (msg, level) => {
    _logRecord.push({ msg, level });
};
delete require.cache[require.resolve('../../app/src/main/assets/nodejs-project/reasoning-gating')];
const rg = require('../../app/src/main/assets/nodejs-project/reasoning-gating');

rg._resetSuppressionLogForTest();
_logRecord.length = 0;

rg.logSuppression(rg.SUPPRESSION_REASONS.SYNTHETIC_HEARTBEAT, 'first');
rg.logSuppression(rg.SUPPRESSION_REASONS.SYNTHETIC_HEARTBEAT, 'second');
rg.logSuppression(rg.SUPPRESSION_REASONS.SYNTHETIC_HEARTBEAT, 'third');
ok('Dedup: first call to same reason → INFO',
    _logRecord[0] && _logRecord[0].level === 'INFO',
    `actual: ${JSON.stringify(_logRecord[0])}`);
ok('Dedup: second call to same reason → DEBUG',
    _logRecord[1] && _logRecord[1].level === 'DEBUG',
    `actual: ${JSON.stringify(_logRecord[1])}`);
ok('Dedup: third call to same reason → DEBUG',
    _logRecord[2] && _logRecord[2].level === 'DEBUG');

// Different reason → fresh INFO regardless of prior reasons.
rg.logSuppression(rg.SUPPRESSION_REASONS.MAX_TOKENS_BELOW_FLOOR, 'first');
ok('Dedup: different reason → INFO again',
    _logRecord[3] && _logRecord[3].level === 'INFO');

// Reset clears the dedup state.
rg._resetSuppressionLogForTest();
_logRecord.length = 0;
rg.logSuppression(rg.SUPPRESSION_REASONS.SYNTHETIC_HEARTBEAT, 'after-reset');
ok('Dedup: after _resetSuppressionLogForTest, same reason → INFO again',
    _logRecord[0] && _logRecord[0].level === 'INFO');

// Detail string is concatenated into the log line.
rg._resetSuppressionLogForTest();
_logRecord.length = 0;
rg.logSuppression(rg.SUPPRESSION_REASONS.MAX_TOKENS_BELOW_FLOOR, 'claude maxTokens=1024');
ok('Dedup: detail string appears in log message',
    _logRecord[0] && _logRecord[0].msg.includes('maxTokens=1024'),
    `actual: ${_logRecord[0]?.msg}`);

console.log();
if (failures === 0) {
    console.log('ALL TESTS PASS');
    process.exit(0);
} else {
    console.log(`${failures} TEST(S) FAILED`);
    process.exit(1);
}
