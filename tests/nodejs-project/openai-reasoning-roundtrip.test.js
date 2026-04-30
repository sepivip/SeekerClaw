#!/usr/bin/env node
// openai-reasoning-roundtrip.test.js — pin BAT-549 Commit 2b OpenAI
// Responses-API preservation invariants:
//
//  - fromApiResponse captures FULL `output[]` reasoning items verbatim
//    into reasoningBlocks (id, summary, encrypted_content all preserved
//    byte-exact)
//  - toApiMessages emits reasoning items FIRST in input[] on tool-use
//    turns (Responses-API ordering: reasoning items → message → function_call)
//  - text-only turns are capture-only (no replay)
//  - Provider isolation: only sourceAdapter==='openai' blocks emit on
//    this adapter; claude/openrouter/custom blocks skipped
//  - Malformed blocks (missing id, wrong type, non-object wire) skipped
//  - formatRequest adds `include:["reasoning.encrypted_content"]` on
//    OAuth/Codex path so encrypted_content flows back across turns
//  - Schema discriminator (Codex v3 finding 1) on every captured block
//
// Run:  node tests/nodejs-project/openai-reasoning-roundtrip.test.js

'use strict';

// Stub config + bridge before requiring openai adapter.
const path = require('path');
const configPath = path.resolve(__dirname, '../../app/src/main/assets/nodejs-project/config.js');
const bridgePath = path.resolve(__dirname, '../../app/src/main/assets/nodejs-project/bridge.js');

// Mutable auth-type so the formatRequest tests can flip OAuth on/off
let _authType = 'oauth';
require.cache[configPath] = {
    id: configPath, filename: configPath, loaded: true,
    exports: {
        log: () => {},
        OPENAI_OAUTH_TOKEN: 'fake-oauth-token',
        OPENAI_OAUTH_REFRESH: 'fake-refresh',
        get OPENAI_AUTH_TYPE() { return _authType; },
    },
};
require.cache[bridgePath] = {
    id: bridgePath, filename: bridgePath, loaded: true,
    exports: { androidBridgeCall: async () => ({}) },
};

const openai = require('../../app/src/main/assets/nodejs-project/providers/openai');

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

// ── Fixture: Codex/gpt-5.x tool-use response with encrypted reasoning ─

const ENCRYPTED = 'gAAAAABh-FAKE-encrypted-base64-bytes-server-issued-do-not-decrypt-this'
    + 'YWJjZGVmZ2hpamtsbW5vcHFyc3R1dnd4eXowMTIzNDU2Nzg5K0FCQ0RFRkdISUpLTE1OT1BRUlNUVVZXWFla';

const codexToolUseResponse = {
    id: 'resp_01ABCDEFG',
    object: 'response',
    model: 'gpt-5.3-codex',
    status: 'completed',
    output: [
        {
            id: 'rs_01XYZ',
            type: 'reasoning',
            summary: [{ type: 'summary_text', text: 'Looking up weather for Tbilisi.' }],
            encrypted_content: ENCRYPTED,
        },
        {
            id: 'msg_01ABC',
            type: 'message',
            content: [{ type: 'output_text', text: 'Let me check the weather.' }],
        },
        {
            type: 'function_call',
            call_id: 'fc_01',
            name: 'weather',
            arguments: '{"city":"Tbilisi"}',
        },
    ],
    usage: { input_tokens: 100, output_tokens: 50 },
};

console.log('── fromApiResponse: capture reasoning items verbatim ──');
const parsed = openai.fromApiResponse(codexToolUseResponse);
eq('Captured 1 reasoning block', parsed.reasoningBlocks.length, 1);
const block = parsed.reasoningBlocks[0];
eq('Block schemaVersion = 1', block.schemaVersion, 1);
eq('Block provider = openai', block.provider, 'openai');
eq('Block sourceAdapter = openai', block.sourceAdapter, 'openai');
eq('Block sourceModel = gpt-5.3-codex', block.sourceModel, 'gpt-5.3-codex');
eq('Block turnId = resp_01ABCDEFG', block.turnId, 'resp_01ABCDEFG');
ok('Block wire is reference-equal to original output item',
    block.wire === codexToolUseResponse.output[0]);
eq('Block wire.id preserved', block.wire.id, 'rs_01XYZ');
eq('Block wire.encrypted_content preserved byte-exact',
    block.wire.encrypted_content, ENCRYPTED);
eq('Block wire.summary preserved', block.wire.summary,
    [{ type: 'summary_text', text: 'Looking up weather for Tbilisi.' }]);

// Multi-reasoning-item response
const multiResp = {
    id: 'resp_02', model: 'gpt-5.4',
    output: [
        { id: 'rs_a', type: 'reasoning', summary: [{ type: 'summary_text', text: 'first' }],
          encrypted_content: 'enc_a' },
        { id: 'rs_b', type: 'reasoning', summary: [{ type: 'summary_text', text: 'second' }],
          encrypted_content: 'enc_b' },
        { id: 'msg_c', type: 'message', content: [{ type: 'output_text', text: 'response' }] },
        { type: 'function_call', call_id: 'fc_c', name: 'echo', arguments: '{}' },
    ],
    usage: {},
};
const multiParsed = openai.fromApiResponse(multiResp);
eq('Multi-reasoning: 2 blocks captured', multiParsed.reasoningBlocks.length, 2);
eq('Multi-reasoning: order preserved (rs_a, rs_b)',
    multiParsed.reasoningBlocks.map((b) => b.wire.id), ['rs_a', 'rs_b']);

// No reasoning items
const plainResp = {
    id: 'resp_03', model: 'gpt-5.4-mini',
    output: [{ id: 'msg', type: 'message', content: [{ type: 'output_text', text: 'plain' }] }],
    usage: {},
};
eq('No-reasoning response: empty reasoningBlocks',
    openai.fromApiResponse(plainResp).reasoningBlocks, []);

// Empty output
eq('Empty output: empty reasoningBlocks',
    openai.fromApiResponse({ id: 'r', output: [], usage: {} }).reasoningBlocks, []);

// Reasoning item missing required `id` — must skip (Responses API rejects replay without id)
const missingIdResp = {
    id: 'resp_noid', model: 'gpt-5.4',
    output: [
        { type: 'reasoning', summary: [{ type: 'summary_text', text: 's' }], encrypted_content: 'e' },
    ],
    usage: {},
};
eq('Reasoning item without id: NOT captured (would fail replay)',
    openai.fromApiResponse(missingIdResp).reasoningBlocks, []);

// Nested response.completed event shape
const nestedResp = {
    type: 'response.completed',
    response: codexToolUseResponse,
};
const nestedParsed = openai.fromApiResponse(nestedResp);
eq('Nested response.completed shape: still captures', nestedParsed.reasoningBlocks.length, 1);
eq('Nested: turnId from inner response', nestedParsed.reasoningBlocks[0].turnId, 'resp_01ABCDEFG');

console.log();
console.log('── toApiMessages: reasoning items FIRST in input[] on tool-use turns ──');

// Build a stored neutral assistant message with reasoningBlocks.
// In the OpenAI Responses API context, the next request must replay the
// reasoning items BEFORE the assistant's message + function_call items
// so the API can validate the tool-loop continuation.
const storedAssistant = {
    role: 'assistant',
    content: 'Let me check the weather.',
    toolCalls: [{ id: 'fc_01', name: 'weather', input: { city: 'Tbilisi' } }],
    reasoningBlocks: [parsed.reasoningBlocks[0]],
};

const messages = [
    { role: 'user', content: 'weather?' },
    storedAssistant,
    { role: 'tool', toolCallId: 'fc_01', content: '{"temp":18}' },
];

const apiInput = openai.toApiMessages(messages);
// Expected order: user → reasoning (rs_01XYZ) → assistant message → function_call → function_call_output
ok('input[0] is user', apiInput[0].role === 'user');
ok('input[1] is the reasoning item (FIRST in the assistant turn group)',
    apiInput[1] && apiInput[1].type === 'reasoning' && apiInput[1].id === 'rs_01XYZ');
ok('input[1] preserves encrypted_content byte-exact',
    apiInput[1].encrypted_content === ENCRYPTED);
ok('input[2] is the assistant message',
    apiInput[2] && apiInput[2].role === 'assistant');
ok('input[3] is the function_call',
    apiInput[3] && apiInput[3].type === 'function_call' && apiInput[3].call_id === 'fc_01');
ok('input[4] is the function_call_output',
    apiInput[4] && apiInput[4].type === 'function_call_output' && apiInput[4].call_id === 'fc_01');

// Multi-reasoning emit
const multiStored = {
    role: 'assistant',
    content: 'response',
    toolCalls: [{ id: 'fc_c', name: 'echo', input: {} }],
    reasoningBlocks: multiParsed.reasoningBlocks,
};
const multiInput = openai.toApiMessages([multiStored]);
const reasoningItems = multiInput.filter((i) => i.type === 'reasoning');
eq('Multi-reasoning emit: 2 reasoning items in input[]', reasoningItems.length, 2);
eq('Multi-reasoning emit: order preserved (rs_a, rs_b)',
    reasoningItems.map((i) => i.id), ['rs_a', 'rs_b']);

console.log();
console.log('── toApiMessages: text-only assistant turn does NOT replay reasoning ──');

const textOnlyStored = {
    role: 'assistant',
    content: 'just text',
    toolCalls: [], // no tool use → no replay
    reasoningBlocks: [parsed.reasoningBlocks[0]],
};
const textOnlyInput = openai.toApiMessages([textOnlyStored]);
ok('Text-only assistant: NO reasoning items emitted',
    !textOnlyInput.some((i) => i.type === 'reasoning'));

// Same shape with undefined toolCalls
const noToolsStored = {
    role: 'assistant',
    content: 'plain',
    reasoningBlocks: [parsed.reasoningBlocks[0]],
};
const noToolsInput = openai.toApiMessages([noToolsStored]);
ok('Undefined toolCalls: no reasoning replay',
    !noToolsInput.some((i) => i.type === 'reasoning'));

console.log();
console.log('── toApiMessages: skips non-openai reasoningBlocks ──');

const claudeBlock = {
    schemaVersion: 1, provider: 'anthropic', sourceAdapter: 'claude',
    sourceModel: 'claude-opus-4-7',
    wire: { type: 'thinking', thinking: 'claude thought', signature: 'sig' },
};
const customBlock = {
    schemaVersion: 1, provider: 'custom', sourceAdapter: 'custom',
    delegateAdapter: 'openai', sourceModel: 'deepseek-v4-pro',
    wire: { reasoning_content: 'custom reasoning' },
};
const orBlock = {
    schemaVersion: 1, provider: 'openrouter', sourceAdapter: 'openrouter',
    sourceModel: 'openai/gpt-5.4',
    wire: { type: 'reasoning.text', text: 'or reasoning', format: 'openai-responses-v1' },
};
const mixedStored = {
    role: 'assistant',
    content: 'response',
    toolCalls: [{ id: 'fc1', name: 'echo', input: {} }],
    reasoningBlocks: [
        claudeBlock, customBlock, orBlock,
        parsed.reasoningBlocks[0], // the only openai-stamped one
    ],
};
const mixedInput = openai.toApiMessages([mixedStored]);
const reasoningOnly = mixedInput.filter((i) => i.type === 'reasoning');
eq('Mixed-provider blocks: only the 1 openai-stamped block emits',
    reasoningOnly.length, 1);
eq('Mixed-provider: emitted block matches the openai one',
    reasoningOnly[0].id, 'rs_01XYZ');

console.log();
console.log('── 3b R3 Fix 2: Custom-Responses replay (delegateAdapter==="openai") ──');

// A Custom-stamped block with a byte-exact OpenAI Responses reasoning
// wire item must be replayed. The Custom adapter wraps openai when
// CUSTOM_FORMAT==='responses', captures `output[]` reasoning items,
// then re-stamps provider/sourceAdapter to 'custom' while recording
// delegateAdapter='openai'. Without the delegateAdapter branch in
// `_collectOpenAIReasoningItems`, this round-trip silently drops the
// reasoning item on the next tool-use turn — breaking encrypted_content
// preservation for Custom+Responses gateways.
const customResponsesBlock = {
    schemaVersion: 1,
    provider: 'custom',
    sourceAdapter: 'custom',
    delegateAdapter: 'openai',
    sourceModel: 'gpt-5.4',
    turnId: 'resp_custom_01',
    // Wire shape MUST match what OpenAI Responses returned (id, type,
    // summary, encrypted_content) — Custom adapter doesn't re-shape it,
    // only re-stamps the envelope.
    wire: {
        id: 'rs_custom_01ABC',
        type: 'reasoning',
        summary: [{ type: 'summary_text', text: 'Custom-via-Responses thought.' }],
        encrypted_content: 'gAAAAABh-CUSTOM-encrypted-bytes-from-gateway',
    },
};
const customStored = {
    role: 'assistant',
    content: 'response from custom gateway',
    toolCalls: [{ id: 'fc_custom', name: 'echo', input: {} }],
    reasoningBlocks: [customResponsesBlock],
};
const customInput = openai.toApiMessages([customStored]);
const customReasoning = customInput.filter((i) => i.type === 'reasoning');
eq('Custom+Responses block: emitted on tool-use turn', customReasoning.length, 1);
eq('Custom+Responses block: id preserved verbatim',
    customReasoning[0].id, 'rs_custom_01ABC');
eq('Custom+Responses block: encrypted_content preserved verbatim',
    customReasoning[0].encrypted_content,
    'gAAAAABh-CUSTOM-encrypted-bytes-from-gateway');

// Native OpenRouter blocks STAY skipped — sourceAdapter !== 'openai'
// AND delegateAdapter !== 'openai'. (Defense in depth: the older check
// against orBlock above asserts this from the negative side; here we
// re-state it next to the positive case so the branch contract is
// pinned together.)
const nativeOrStored = {
    role: 'assistant',
    content: 'r',
    toolCalls: [{ id: 'fc', name: 'e', input: {} }],
    reasoningBlocks: [{
        schemaVersion: 1, provider: 'openrouter', sourceAdapter: 'openrouter',
        delegateAdapter: 'openrouter',
        sourceModel: 'openai/gpt-5.4',
        wire: { id: 'rs_or_01', type: 'reasoning', summary: [],
            encrypted_content: 'e' },
    }],
};
const nativeOrInput = openai.toApiMessages([nativeOrStored]);
const nativeOrReasoning = nativeOrInput.filter((i) => i.type === 'reasoning');
eq('Native OpenRouter block: still skipped (delegateAdapter==="openrouter")',
    nativeOrReasoning.length, 0);

console.log();
console.log('── toApiMessages: skips malformed blocks ──');

const malformedBlocks = [
    // Missing id
    { schemaVersion: 1, provider: 'openai', sourceAdapter: 'openai',
      wire: { type: 'reasoning', summary: [], encrypted_content: 'e' } },
    // id is empty string
    { schemaVersion: 1, provider: 'openai', sourceAdapter: 'openai',
      wire: { type: 'reasoning', id: '', encrypted_content: 'e' } },
    // wrong wire type
    { schemaVersion: 1, provider: 'openai', sourceAdapter: 'openai',
      wire: { type: 'message', id: 'msg', content: [] } },
    // Wire is null
    { schemaVersion: 1, provider: 'openai', sourceAdapter: 'openai', wire: null },
    // Wire is array (not object)
    { schemaVersion: 1, provider: 'openai', sourceAdapter: 'openai', wire: ['x'] },
];

for (const blk of malformedBlocks) {
    const stored = {
        role: 'assistant', content: 'r',
        toolCalls: [{ id: 'fc', name: 'e', input: {} }],
        reasoningBlocks: [blk],
    };
    const apiInput2 = openai.toApiMessages([stored]);
    const hasReasoning = apiInput2.some((i) => i.type === 'reasoning');
    ok(`Malformed block (${(blk.wire && blk.wire.type) || (blk.wire === null ? 'null' : Array.isArray(blk.wire) ? 'array' : 'unknown')}): NOT emitted`,
        !hasReasoning);
}

console.log();
console.log('── formatRequest: include reasoning.encrypted_content on OAuth/Codex path ──');

// OAuth path
_authType = 'oauth';
const reload = require.resolve('../../app/src/main/assets/nodejs-project/providers/openai');
delete require.cache[reload];
const openaiOauth = require('../../app/src/main/assets/nodejs-project/providers/openai');
const oauthBody = JSON.parse(openaiOauth.formatRequest('gpt-5.4', 4096, 'sys', [], []));
ok('OAuth path: body.include === ["reasoning.encrypted_content"]',
    Array.isArray(oauthBody.include)
        && oauthBody.include.length === 1
        && oauthBody.include[0] === 'reasoning.encrypted_content');
ok('OAuth path: body.reasoning still present (don\'t regress existing hardcode)',
    oauthBody.reasoning && oauthBody.reasoning.effort === 'medium'
        && oauthBody.reasoning.summary === 'auto');
ok('OAuth path: body.store === false', oauthBody.store === false);

// API-key path with codex model name (still triggers reasoning hardcode)
_authType = 'api_key';
delete require.cache[reload];
const openaiApi = require('../../app/src/main/assets/nodejs-project/providers/openai');
const codexBody = JSON.parse(openaiApi.formatRequest('gpt-5.3-codex', 4096, 'sys', [], []));
ok('Codex model (api_key): body.include === ["reasoning.encrypted_content"]',
    Array.isArray(codexBody.include) && codexBody.include[0] === 'reasoning.encrypted_content');
ok('Codex model (api_key): body.reasoning present', !!codexBody.reasoning);

// API-key path with non-reasoning model — no include, no reasoning param
const plainBody = JSON.parse(openaiApi.formatRequest('gpt-5.4', 4096, 'sys', [], []));
ok('Non-codex api_key: body.include absent (no encrypted echo needed)',
    plainBody.include === undefined);
ok('Non-codex api_key: body.reasoning absent (no enablement)',
    plainBody.reasoning === undefined);

console.log();
console.log('── Round-trip: fromApiResponse → toApiMessages produces equivalent input items ──');

// reset adapter to a stable one
_authType = 'oauth';
delete require.cache[reload];
const openaiRt = require('../../app/src/main/assets/nodejs-project/providers/openai');

const rtParsed = openaiRt.fromApiResponse(codexToolUseResponse);
const rtStored = {
    role: 'assistant',
    content: rtParsed.text,
    toolCalls: rtParsed.toolCalls,
    reasoningBlocks: rtParsed.reasoningBlocks,
};
const rtInput = openaiRt.toApiMessages([rtStored]);
// Should reproduce the assistant turn shape: reasoning → message → function_call
const rtReasoning = rtInput.find((i) => i.type === 'reasoning');
const rtMessage = rtInput.find((i) => i.role === 'assistant');
const rtFunctionCall = rtInput.find((i) => i.type === 'function_call');
ok('Round-trip: reasoning item present', !!rtReasoning);
ok('Round-trip: assistant message present', !!rtMessage);
ok('Round-trip: function_call present', !!rtFunctionCall);
eq('Round-trip: reasoning item is reference-equal to captured wire (byte-exact preservation)',
    rtReasoning === rtParsed.reasoningBlocks[0].wire, true);

console.log();
if (failures === 0) {
    console.log('ALL TESTS PASS');
    process.exit(0);
} else {
    console.log(`${failures} TEST(S) FAILED`);
    process.exit(1);
}
