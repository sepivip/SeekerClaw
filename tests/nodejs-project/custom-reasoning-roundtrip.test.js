#!/usr/bin/env node
// custom-reasoning-roundtrip.test.js — pin BAT-549 v4.1 acceptance criteria:
//
//  - Custom DeepSeek V4 fixture: response w/ `reasoning_content + content +
//    tool_calls`; next request reconstructs assistant message with required
//    `reasoning_content` at correct JSON path.
//  - R1 strip-don't-echo fixture: deepseek-reasoner response; confirm
//    `formatRequest`/toApiMessages does NOT include `reasoning_content`
//    from prior turn (would cause 400).
//  - Cross-provider stamping: capture under provider:'custom', delegateAdapter:'openrouter'.
//
// Run:  node tests/nodejs-project/custom-reasoning-roundtrip.test.js
// Exit: 0 = all pass, 1 = at least one failure.
//
// Why fixture-based: the production crash path requires a real API call to
// DeepSeek which we can't run here. Instead we feed each adapter the exact
// raw response shape DeepSeek returns and assert the round-trip exactly
// matches what DeepSeek expects on the next request.

'use strict';

const path = require('path');

// Shim runtime config for adapter loading. The Custom adapter pulls
// CUSTOM_FORMAT/CUSTOM_KEY/etc from config.js at require-time; we point
// require.cache to a stub so the adapter loads without a real config.json.
const stubConfigPath = path.resolve(__dirname, '../../app/src/main/assets/nodejs-project/config.js');
require.cache[stubConfigPath] = {
    id: stubConfigPath,
    filename: stubConfigPath,
    loaded: true,
    exports: {
        CUSTOM_KEY: 'sk-stub',
        CUSTOM_HEADERS: {},
        CUSTOM_FORMAT: 'chat_completions',
        CUSTOM_ENDPOINT: { hostname: 'api.deepseek.com', path: '/chat/completions' },
        CUSTOM_BASE_URL: 'https://api.deepseek.com/chat/completions',
        OPENROUTER_FALLBACK_MODEL: '',
        // resolveActiveModel switched per-test below
        resolveActiveModel: () => _activeModel,
        log: () => {},
    },
};

let _activeModel = 'deepseek-v4-pro';

// Now require the adapter — it'll pick up the stub
const customAdapter = require('../../app/src/main/assets/nodejs-project/providers/custom');

let failures = 0;

function assertEq(label, actual, expected) {
    const a = JSON.stringify(actual);
    const e = JSON.stringify(expected);
    if (a === e) {
        console.log(`PASS: ${label}`);
    } else {
        console.log(`FAIL: ${label}\n  actual:   ${a}\n  expected: ${e}`);
        failures++;
    }
}

function assertOk(label, cond, hint = '') {
    if (cond) {
        console.log(`PASS: ${label}`);
    } else {
        console.log(`FAIL: ${label}${hint ? ' — ' + hint : ''}`);
        failures++;
    }
}

// ─── Fixture: DeepSeek V4-pro response with reasoning_content + tool_calls ──

console.log('── DeepSeek V4 fixture: capture into reasoningBlocks[] ──');

_activeModel = 'deepseek-v4-pro';

const dsV4Response = {
    id: 'chatcmpl-deepseek-v4-001',
    model: 'deepseek-v4-pro',
    choices: [{
        index: 0,
        finish_reason: 'tool_calls',
        message: {
            role: 'assistant',
            content: 'Let me look up the weather.',
            reasoning_content: 'The user is asking about weather. I should call the weather tool with city=Tbilisi to get current conditions.',
            tool_calls: [{
                id: 'tc_001',
                type: 'function',
                function: { name: 'weather', arguments: JSON.stringify({ city: 'Tbilisi' }) },
            }],
        },
    }],
    usage: { prompt_tokens: 100, completion_tokens: 50, total_tokens: 150 },
};

const v4Parsed = customAdapter.fromApiResponse(dsV4Response);

assertOk('parsed.text captured',
    v4Parsed.text === 'Let me look up the weather.');
assertOk('parsed.toolCalls captured',
    Array.isArray(v4Parsed.toolCalls) && v4Parsed.toolCalls.length === 1);
assertOk('parsed.toolCalls[0].name = weather',
    v4Parsed.toolCalls[0].name === 'weather');
assertOk('parsed.toolCalls[0].input.city = Tbilisi',
    v4Parsed.toolCalls[0].input.city === 'Tbilisi');
assertOk('parsed.reasoningBlocks is an array',
    Array.isArray(v4Parsed.reasoningBlocks));
assertOk('parsed.reasoningBlocks has exactly 1 entry',
    v4Parsed.reasoningBlocks.length === 1);

const block = v4Parsed.reasoningBlocks[0];
assertEq('block.schemaVersion = 1', block.schemaVersion, 1);
assertEq('block.provider = custom (re-stamped from openrouter)', block.provider, 'custom');
assertEq('block.sourceAdapter = custom (re-stamped)', block.sourceAdapter, 'custom');
assertEq('block.delegateAdapter = openrouter (forensic record)', block.delegateAdapter, 'openrouter');
assertEq('block.sourceModel = deepseek-v4-pro', block.sourceModel, 'deepseek-v4-pro');
assertEq('block.wire.reasoning_content preserved verbatim',
    block.wire.reasoning_content,
    'The user is asking about weather. I should call the weather tool with city=Tbilisi to get current conditions.');

console.log();
console.log('── DeepSeek V4 round-trip: V4 echo path emits reasoning_content ──');

// Simulate the next turn's request: build an internal-format messages array
// that includes the assistant turn just captured, plus a tool result and
// follow-up user message — what /resume would re-send to DeepSeek.
const messagesV4 = [
    { role: 'user', content: 'What is the weather in Tbilisi?' },
    {
        role: 'assistant',
        content: v4Parsed.text,
        toolCalls: v4Parsed.toolCalls,
        reasoningBlocks: v4Parsed.reasoningBlocks,
    },
    { role: 'tool', toolCallId: 'tc_001', content: '{"temp":18,"sky":"clear"}' },
];

const wireMessagesV4 = customAdapter.toApiMessages(messagesV4);

// Find assistant entry in wire output
const wireAssistantV4 = wireMessagesV4.find((m) => m.role === 'assistant');
assertOk('V4: wire output has assistant entry', !!wireAssistantV4);
assertOk('V4: wire assistant has reasoning_content (DeepSeek requires it)',
    typeof wireAssistantV4.reasoning_content === 'string'
        && wireAssistantV4.reasoning_content.length > 0,
    'reasoning_content missing or empty — DeepSeek V4 returns 400 on /resume after tool call without it');
assertEq('V4: reasoning_content matches captured value',
    wireAssistantV4.reasoning_content,
    'The user is asking about weather. I should call the weather tool with city=Tbilisi to get current conditions.');
assertOk('V4: wire assistant has tool_calls', Array.isArray(wireAssistantV4.tool_calls)
    && wireAssistantV4.tool_calls.length === 1);
assertOk('V4: wire assistant has content', wireAssistantV4.content === 'Let me look up the weather.');

console.log();
console.log('── DeepSeek R1 fixture: capture but STRIP on round-trip ──');

_activeModel = 'deepseek-reasoner';

// Same shape response (R1 also returns reasoning_content) but a different
// model id → gating MUST strip on round-trip
const dsR1Response = {
    id: 'chatcmpl-deepseek-r1-001',
    model: 'deepseek-reasoner',
    choices: [{
        index: 0,
        finish_reason: 'tool_calls',
        message: {
            role: 'assistant',
            content: 'Calling weather tool.',
            reasoning_content: 'R1 reasoning — this MUST NOT be sent back on next turn (R1 returns 400 if echoed).',
            tool_calls: [{
                id: 'tc_r1',
                type: 'function',
                function: { name: 'weather', arguments: JSON.stringify({ city: 'Batumi' }) },
            }],
        },
    }],
    usage: {},
};

const r1Parsed = customAdapter.fromApiResponse(dsR1Response);
assertOk('R1: parsed.reasoningBlocks captured (capture is unconditional)',
    Array.isArray(r1Parsed.reasoningBlocks) && r1Parsed.reasoningBlocks.length === 1);

const messagesR1 = [
    { role: 'user', content: 'What is the weather in Batumi?' },
    {
        role: 'assistant',
        content: r1Parsed.text,
        toolCalls: r1Parsed.toolCalls,
        reasoningBlocks: r1Parsed.reasoningBlocks,
    },
    { role: 'tool', toolCallId: 'tc_r1', content: '{"temp":22,"sky":"sunny"}' },
];

const wireMessagesR1 = customAdapter.toApiMessages(messagesR1);
const wireAssistantR1 = wireMessagesR1.find((m) => m.role === 'assistant');

assertOk('R1: wire assistant exists', !!wireAssistantR1);
assertOk('R1: wire assistant has NO reasoning_content (would cause 400)',
    wireAssistantR1.reasoning_content === undefined,
    'R1 returns 400 if reasoning_content is echoed back');
assertOk('R1: wire assistant has NO reasoning_details either',
    wireAssistantR1.reasoning_details === undefined);
assertOk('R1: wire assistant still has tool_calls',
    Array.isArray(wireAssistantR1.tool_calls) && wireAssistantR1.tool_calls.length === 1);
assertOk('R1: wire assistant still has content',
    wireAssistantR1.content === 'Calling weather tool.');

console.log();
console.log('── Unknown model fixture: capture but DO NOT echo ──');

_activeModel = 'qwen3-thinking-72b';

const qwenResponse = {
    id: 'chatcmpl-qwen-001',
    model: 'qwen3-thinking-72b',
    choices: [{
        index: 0,
        finish_reason: 'tool_calls',
        message: {
            role: 'assistant',
            content: 'Tool time.',
            reasoning_content: 'Qwen reasoning — gateway contract unknown; do not echo.',
            tool_calls: [{
                id: 'tc_qwen',
                type: 'function',
                function: { name: 'echo', arguments: '{}' },
            }],
        },
    }],
    usage: {},
};

const qwenParsed = customAdapter.fromApiResponse(qwenResponse);
assertOk('Unknown: capture happens unconditionally',
    qwenParsed.reasoningBlocks.length === 1);

const messagesQwen = [
    { role: 'user', content: 'echo' },
    {
        role: 'assistant',
        content: qwenParsed.text,
        toolCalls: qwenParsed.toolCalls,
        reasoningBlocks: qwenParsed.reasoningBlocks,
    },
    { role: 'tool', toolCallId: 'tc_qwen', content: 'ok' },
];

const wireMessagesQwen = customAdapter.toApiMessages(messagesQwen);
const wireAssistantQwen = wireMessagesQwen.find((m) => m.role === 'assistant');
assertOk('Unknown: wire assistant has NO reasoning_content (capture-only)',
    wireAssistantQwen.reasoning_content === undefined);

console.log();
console.log('── Empty-reasoning response: graceful no-op ──');

const emptyResponse = {
    id: 'chatcmpl-empty',
    model: 'deepseek-v4-pro',
    choices: [{
        index: 0,
        finish_reason: 'stop',
        message: { role: 'assistant', content: 'Just a text reply, no thinking.' },
    }],
    usage: {},
};

_activeModel = 'deepseek-v4-pro';
const emptyParsed = customAdapter.fromApiResponse(emptyResponse);
assertOk('Empty: parsed.reasoningBlocks = []',
    Array.isArray(emptyParsed.reasoningBlocks) && emptyParsed.reasoningBlocks.length === 0);

console.log();
console.log('── Schema discriminator (Codex v3 finding 1) ──');
const dsV4Block = v4Parsed.reasoningBlocks[0];
assertOk('Block has schemaVersion (forward-compat)', typeof dsV4Block.schemaVersion === 'number');
assertOk('Block has provider', typeof dsV4Block.provider === 'string');
assertOk('Block has sourceAdapter', typeof dsV4Block.sourceAdapter === 'string');
assertOk('Block has sourceModel', typeof dsV4Block.sourceModel === 'string');
assertOk('Block has turnId', dsV4Block.turnId !== undefined);

console.log();
console.log('── R2 thread 4: sourceModel uses raw.model, not resolveActiveModel ──');
// This pins the v4.1 finding 4 invariant: persisted provenance must
// reflect the model the response ACTUALLY came from, not whatever
// resolveActiveModel returns when fromApiResponse runs (which can drift
// after an agent_settings.json overlay flip mid-conversation).
_activeModel = 'deepseek-v4-pro-NEW-OVERLAY'; // pretend overlay flipped after the request

const stableV4Resp = {
    id: 'chatcmpl-stable',
    model: 'deepseek-v4-pro', // <-- response says THIS model produced it
    choices: [{
        finish_reason: 'tool_calls',
        message: {
            role: 'assistant',
            content: 'response',
            reasoning_content: 'reasoning under deepseek-v4-pro',
            tool_calls: [{ id: 'tcA', type: 'function', function: { name: 'echo', arguments: '{}' } }],
        },
    }],
};
const stableParsed = customAdapter.fromApiResponse(stableV4Resp);
assertEq('sourceModel = raw.model (not the overlay-shifted resolveActiveModel)',
    stableParsed.reasoningBlocks[0].sourceModel,
    'deepseek-v4-pro');

// Fall-through: response without raw.model → resolveActiveModel takes over
_activeModel = 'fallback-model-v9';
const noModelResp = {
    id: 'chatcmpl-no-model',
    // no `model` field
    choices: [{
        finish_reason: 'tool_calls',
        message: {
            role: 'assistant',
            content: 'response',
            reasoning_content: 'reasoning when raw.model absent',
            tool_calls: [{ id: 'tcB', type: 'function', function: { name: 'echo', arguments: '{}' } }],
        },
    }],
};
const noModelParsed = customAdapter.fromApiResponse(noModelResp);
// Delegate's openrouter.js sets sourceModel from raw.model || null. So
// when raw.model is absent, blk.sourceModel from delegate = null, and
// we fall back to resolveActiveModel.
assertEq('sourceModel falls back to resolveActiveModel when raw.model absent',
    noModelParsed.reasoningBlocks[0].sourceModel,
    'fallback-model-v9');

console.log();
console.log('── R2 thread 3: toApiMessages takes activeModel parameter ──');
// Pin the v4.1 finding 3 invariant: gating uses the EXPLICITLY-PASSED
// model, not whatever resolveActiveModel returns at toApiMessages-time.
// Set a contradiction: resolveActiveModel returns R1 (would strip),
// but we PASS V4 explicitly → gating MUST echo.

_activeModel = 'deepseek-reasoner'; // would normally → strip
const contradictionMessages = [
    { role: 'user', content: 'q' },
    {
        role: 'assistant',
        content: 'a',
        toolCalls: [{ id: 'tc-c', name: 'echo', input: {} }],
        reasoningBlocks: [{
            schemaVersion: 1, provider: 'custom', sourceAdapter: 'custom',
            delegateAdapter: 'openrouter', sourceModel: 'deepseek-v4-pro',
            wire: { reasoning_content: 'V4 reasoning that must echo' },
        }],
    },
    { role: 'tool', toolCallId: 'tc-c', content: 'ok' },
];

// Pass V4 explicitly → gating uses it, NOT the R1 from resolveActiveModel
const wireWithExplicitModel = customAdapter.toApiMessages(contradictionMessages, 'deepseek-v4-pro');
const wireAssistantExplicit = wireWithExplicitModel.find((m) => m.role === 'assistant');
assertOk('Explicit V4 model → reasoning_content echoed (gating used param, not stale resolveActiveModel)',
    typeof wireAssistantExplicit.reasoning_content === 'string'
        && wireAssistantExplicit.reasoning_content.includes('V4 reasoning'));

// Don't pass model → falls back to resolveActiveModel = R1 → strip
const wireWithoutModel = customAdapter.toApiMessages(contradictionMessages);
const wireAssistantFallback = wireWithoutModel.find((m) => m.role === 'assistant');
assertOk('No explicit model → falls back to resolveActiveModel (R1) → strip',
    wireAssistantFallback.reasoning_content === undefined);

// Empty/null param → falls back too
const wireWithEmpty = customAdapter.toApiMessages(contradictionMessages, '');
const wireAssistantEmpty = wireWithEmpty.find((m) => m.role === 'assistant');
assertOk('Empty model param → falls back to resolveActiveModel',
    wireAssistantEmpty.reasoning_content === undefined);

console.log();
if (failures === 0) {
    console.log('ALL TESTS PASS');
    process.exit(0);
} else {
    console.log(`${failures} TEST(S) FAILED`);
    process.exit(1);
}
