#!/usr/bin/env node
// openrouter-reasoning-roundtrip.test.js — pin BAT-549 Commit 2c
// OpenRouter native preservation invariants:
//
//  - fromApiResponse captures reasoning_details[] entries verbatim into
//    reasoningBlocks (preserves format discriminator: anthropic-claude-v1,
//    google-gemini-v1, openai-responses-v1, etc.)
//  - fromApiResponse also captures DeepSeek-style reasoning_content
//    when surfaced through native OR (e.g. user picks a deepseek/* model)
//  - toApiMessages emits reasoning_details[] verbatim INSIDE the assistant
//    message in messages[] (NOT request top-level — v4.1 finding 6)
//  - reasoning_details[] echoed regardless of model (it's OR's normalized
//    format and round-trips cleanly per OR docs)
//  - reasoning_content echo gated by R1/V4 model detection (R1 → strip,
//    V4 → echo, unknown → don't echo to avoid spurious 400s)
//  - Provider isolation: only sourceAdapter==='openrouter' OR
//    delegateAdapter==='openrouter' blocks emit on this adapter
//  - Malformed-block defense: non-object wire silently skipped
//  - Schema discriminator (Codex v3 finding 1) on every captured block
//
// Run:  node tests/nodejs-project/openrouter-reasoning-roundtrip.test.js

'use strict';

// Stub config before requiring openrouter adapter (it imports `log` and
// `OPENROUTER_FALLBACK_MODEL` from config.js).
const path = require('path');
const configPath = path.resolve(__dirname, '../../app/src/main/assets/nodejs-project/config.js');
require.cache[configPath] = {
    id: configPath, filename: configPath, loaded: true,
    exports: {
        log: () => {},
        OPENROUTER_FALLBACK_MODEL: '',
    },
};

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

// ── Fixture: native OR response from anthropic/claude-sonnet-4-6 with reasoning_details ─

const claudeViaORResponse = {
    id: 'gen-or-01',
    model: 'anthropic/claude-sonnet-4-6',
    choices: [{
        finish_reason: 'tool_calls',
        message: {
            role: 'assistant',
            content: 'Let me check.',
            tool_calls: [{
                id: 'call_or_001',
                type: 'function',
                function: { name: 'weather', arguments: '{"city":"Tbilisi"}' },
            }],
            reasoning_details: [
                { type: 'reasoning.text', text: 'I should call weather tool', format: 'anthropic-claude-v1' },
                { type: 'reasoning.encrypted', encrypted: 'opaque_blob_aBcDeF', format: 'anthropic-claude-v1' },
            ],
        },
    }],
    usage: { prompt_tokens: 100, completion_tokens: 50 },
};

console.log('── fromApiResponse: capture reasoning_details verbatim ──');
const parsed = openrouter.fromApiResponse(claudeViaORResponse);
eq('Captured 2 reasoning blocks (one per reasoning_details entry)',
    parsed.reasoningBlocks.length, 2);

const block0 = parsed.reasoningBlocks[0];
eq('Block 0 schemaVersion = 1', block0.schemaVersion, 1);
eq('Block 0 provider = openrouter', block0.provider, 'openrouter');
eq('Block 0 sourceAdapter = openrouter', block0.sourceAdapter, 'openrouter');
eq('Block 0 sourceModel = anthropic/claude-sonnet-4-6', block0.sourceModel, 'anthropic/claude-sonnet-4-6');
eq('Block 0 turnId = gen-or-01', block0.turnId, 'gen-or-01');
ok('Block 0 wire is reference-equal to original reasoning_details entry',
    block0.wire === claudeViaORResponse.choices[0].message.reasoning_details[0]);
eq('Block 0 wire.type preserved', block0.wire.type, 'reasoning.text');
eq('Block 0 wire.format preserved', block0.wire.format, 'anthropic-claude-v1');
eq('Block 0 wire.text preserved', block0.wire.text, 'I should call weather tool');

const block1 = parsed.reasoningBlocks[1];
eq('Block 1 wire.type = reasoning.encrypted', block1.wire.type, 'reasoning.encrypted');
eq('Block 1 wire.encrypted preserved byte-exact',
    block1.wire.encrypted, 'opaque_blob_aBcDeF');

// Multi-format response (e.g. routed through OR with mixed providers)
const mixedFormatResp = {
    id: 'gen-or-02',
    model: 'google/gemini-2.5-pro',
    choices: [{
        finish_reason: 'tool_calls',
        message: {
            role: 'assistant', content: 'response',
            tool_calls: [{ id: 'tc1', type: 'function', function: { name: 'echo', arguments: '{}' } }],
            reasoning_details: [
                { type: 'reasoning.text', text: 'gemini thought', format: 'google-gemini-v1' },
                { type: 'reasoning.summary', text: 'summary', format: 'google-gemini-v1' },
            ],
        },
    }],
    usage: {},
};
const mixedParsed = openrouter.fromApiResponse(mixedFormatResp);
eq('Mixed-format: 2 blocks captured', mixedParsed.reasoningBlocks.length, 2);
eq('Mixed-format: format discriminators preserved',
    mixedParsed.reasoningBlocks.map((b) => b.wire.format),
    ['google-gemini-v1', 'google-gemini-v1']);
eq('Mixed-format: types preserved (reasoning.text, reasoning.summary)',
    mixedParsed.reasoningBlocks.map((b) => b.wire.type),
    ['reasoning.text', 'reasoning.summary']);

// DeepSeek-style reasoning_content via native OR
const deepseekViaORResp = {
    id: 'gen-or-03',
    model: 'deepseek/deepseek-v4-pro',
    choices: [{
        finish_reason: 'tool_calls',
        message: {
            role: 'assistant', content: 'thinking and acting',
            tool_calls: [{ id: 'tc1', type: 'function', function: { name: 'echo', arguments: '{}' } }],
            reasoning_content: 'V4 thinking content here',
        },
    }],
    usage: {},
};
const dsParsed = openrouter.fromApiResponse(deepseekViaORResp);
eq('DeepSeek-via-OR: 1 block captured (reasoning_content path)',
    dsParsed.reasoningBlocks.length, 1);
eq('DeepSeek-via-OR: wire has reasoning_content',
    dsParsed.reasoningBlocks[0].wire.reasoning_content, 'V4 thinking content here');

// Plain response with no reasoning
const plainResp = {
    id: 'gen-or-04', model: 'mistralai/mistral-large-2407',
    choices: [{ finish_reason: 'stop', message: { role: 'assistant', content: 'plain' } }],
    usage: {},
};
eq('No-reasoning response: empty reasoningBlocks',
    openrouter.fromApiResponse(plainResp).reasoningBlocks, []);

// Empty/missing choices
eq('No choices: empty reasoningBlocks',
    openrouter.fromApiResponse({ id: 'r' }).reasoningBlocks, []);

console.log();
console.log('── toApiMessages: reasoning_details attached to assistant message INSIDE messages[] ──');

// V4.1 finding 6 contract: reasoning_details lives on the assistant message
// in messages[], NOT at request top-level. The fixture mimics the assistant
// turn we just parsed; the wire output should re-serialize the assistant
// entry with reasoning_details intact.
const storedAssistant = {
    role: 'assistant',
    content: parsed.text || 'Let me check.',
    toolCalls: [{ id: 'call_or_001', name: 'weather', input: { city: 'Tbilisi' } }],
    reasoningBlocks: parsed.reasoningBlocks,
};
const messages = [
    { role: 'user', content: 'weather?' },
    storedAssistant,
    { role: 'tool', toolCallId: 'call_or_001', content: '{"temp":18}' },
];

// Pass model ANTHROPIC/CLAUDE so OR's gating does NOT classify as deepseek
// → reasoning_details emitted unconditionally; reasoning_content not present
// in this fixture so won't matter.
const apiMsgs = openrouter.toApiMessages(messages, 'anthropic/claude-sonnet-4-6');
const wireAssistant = apiMsgs.find((m) => m.role === 'assistant');
ok('Assistant entry exists in wire output', !!wireAssistant);
ok('Assistant has reasoning_details field (attached on message, NOT top-level)',
    Array.isArray(wireAssistant.reasoning_details));
eq('reasoning_details length matches captured', wireAssistant.reasoning_details.length, 2);
ok('reasoning_details[0] is the anthropic-claude-v1 text entry (verbatim)',
    wireAssistant.reasoning_details[0] === claudeViaORResponse.choices[0].message.reasoning_details[0]);
ok('reasoning_details[1] is the encrypted entry (verbatim)',
    wireAssistant.reasoning_details[1] === claudeViaORResponse.choices[0].message.reasoning_details[1]);

// Top-level shape: reasoning_details should NOT be at request top-level
ok('Wire output is an array of messages (no top-level reasoning_details key)',
    Array.isArray(apiMsgs));
const topLevelKeys = apiMsgs.map((m) => Object.keys(m)).flat();
ok('No message at top-level position has reasoning_details OUTSIDE the assistant',
    apiMsgs.filter((m) => m.role !== 'assistant')
        .every((m) => m.reasoning_details === undefined));

console.log();
console.log('── toApiMessages: V4 model echoes reasoning_content; R1 strips ──');

// DeepSeek-via-OR with reasoning_content captured. Replay path uses model
// gating from reasoning-gating.js to decide.
const dsStored = {
    role: 'assistant',
    content: 'thinking',
    toolCalls: [{ id: 'tc1', name: 'echo', input: {} }],
    reasoningBlocks: dsParsed.reasoningBlocks,
};
const dsMessages = [
    { role: 'user', content: 'q' },
    dsStored,
    { role: 'tool', toolCallId: 'tc1', content: 'ok' },
];

// V4 model → reasoning_content emitted
const v4Wire = openrouter.toApiMessages(dsMessages, 'deepseek/deepseek-v4-pro');
const v4Assistant = v4Wire.find((m) => m.role === 'assistant');
eq('V4 native-OR: reasoning_content emitted',
    v4Assistant.reasoning_content, 'V4 thinking content here');

// R1 model → reasoning_content stripped (would 400 if echoed)
const r1Wire = openrouter.toApiMessages(dsMessages, 'deepseek/deepseek-r1-0528');
const r1Assistant = r1Wire.find((m) => m.role === 'assistant');
ok('R1 native-OR: reasoning_content NOT emitted (R1 returns 400 if echoed)',
    r1Assistant.reasoning_content === undefined);

// Unknown model → reasoning_content stripped (capture-only contract)
const unknownWire = openrouter.toApiMessages(dsMessages, 'mistralai/mistral-large-2407');
const unknownAssistant = unknownWire.find((m) => m.role === 'assistant');
ok('Unknown model native-OR: reasoning_content NOT emitted (capture-only)',
    unknownAssistant.reasoning_content === undefined);

// reasoning_details ALWAYS echoes regardless of model (OR's normalized contract)
const v4WithDetails = {
    role: 'assistant',
    content: 'r',
    toolCalls: [{ id: 'tc1', name: 'echo', input: {} }],
    reasoningBlocks: [
        ...dsParsed.reasoningBlocks,
        ...parsed.reasoningBlocks, // 2 reasoning_details + 1 reasoning_content
    ],
};
const r1WithDetails = openrouter.toApiMessages([
    { role: 'user', content: 'q' }, v4WithDetails,
    { role: 'tool', toolCallId: 'tc1', content: 'ok' },
], 'deepseek/deepseek-r1-0528');
const r1WithDetailsAssistant = r1WithDetails.find((m) => m.role === 'assistant');
ok('R1 + reasoning_details: details still emit even when content is gated',
    Array.isArray(r1WithDetailsAssistant.reasoning_details)
        && r1WithDetailsAssistant.reasoning_details.length === 2);
ok('R1 + reasoning_details: content still gated/stripped',
    r1WithDetailsAssistant.reasoning_content === undefined);

console.log();
console.log('── Provider isolation: skips non-OR blocks ──');

const claudeBlock = {
    schemaVersion: 1, provider: 'anthropic', sourceAdapter: 'claude',
    wire: { type: 'thinking', thinking: 'claude thought', signature: 'sig' },
};
const openaiBlock = {
    schemaVersion: 1, provider: 'openai', sourceAdapter: 'openai',
    wire: { type: 'reasoning', id: 'rs', summary: [] },
};
const customBlock = {
    schemaVersion: 1, provider: 'custom', sourceAdapter: 'custom',
    delegateAdapter: 'openai', // delegates to OpenAI (not OR)
    wire: { type: 'reasoning', id: 'rs2', summary: [] },
};
const customViaORBlock = {
    schemaVersion: 1, provider: 'custom', sourceAdapter: 'custom',
    delegateAdapter: 'openrouter', // CUSTOM but delegates through OR
    wire: { type: 'reasoning.text', text: 't', format: 'anthropic-claude-v1' },
};
const orNativeBlock = {
    schemaVersion: 1, provider: 'openrouter', sourceAdapter: 'openrouter',
    wire: { type: 'reasoning.text', text: 'or thought', format: 'google-gemini-v1' },
};

const mixedStored = {
    role: 'assistant',
    content: 'r',
    toolCalls: [{ id: 'tc1', name: 'echo', input: {} }],
    reasoningBlocks: [claudeBlock, openaiBlock, customBlock, customViaORBlock, orNativeBlock],
};
const mixedWire = openrouter.toApiMessages([mixedStored], 'anthropic/claude-sonnet-4-6');
const mixedAssistant = mixedWire.find((m) => m.role === 'assistant');
const mixedDetails = mixedAssistant.reasoning_details || [];
eq('Mixed-provider: 2 blocks emitted (orNative + customViaOR)', mixedDetails.length, 2);
ok('Mixed-provider: customViaOR block emitted (delegateAdapter==="openrouter")',
    mixedDetails.includes(customViaORBlock.wire));
ok('Mixed-provider: orNative block emitted (sourceAdapter==="openrouter")',
    mixedDetails.includes(orNativeBlock.wire));
ok('Mixed-provider: claude block NOT emitted',
    !mixedDetails.includes(claudeBlock.wire));
ok('Mixed-provider: openai block NOT emitted',
    !mixedDetails.includes(openaiBlock.wire));
ok('Mixed-provider: custom-via-openai block NOT emitted',
    !mixedDetails.includes(customBlock.wire));

console.log();
console.log('── Malformed-block defense ──');

const malformedStored = {
    role: 'assistant',
    content: 'r',
    toolCalls: [{ id: 'tc1', name: 'echo', input: {} }],
    reasoningBlocks: [
        { schemaVersion: 1, provider: 'openrouter', sourceAdapter: 'openrouter', wire: null },
        { schemaVersion: 1, provider: 'openrouter', sourceAdapter: 'openrouter', wire: 'string-not-object' },
        { schemaVersion: 1, provider: 'openrouter', sourceAdapter: 'openrouter', wire: ['array', 'not', 'object'] },
        { schemaVersion: 1, provider: 'openrouter', sourceAdapter: 'openrouter', wire: 12345 },
        { schemaVersion: 1, provider: 'openrouter', sourceAdapter: 'openrouter' /* no wire */ },
    ],
};
const malformedWire = openrouter.toApiMessages([malformedStored], 'anthropic/claude-sonnet-4-6');
const malformedAssistant = malformedWire.find((m) => m.role === 'assistant');
ok('Malformed blocks: NO reasoning_details emitted (all skipped)',
    malformedAssistant.reasoning_details === undefined);
ok('Malformed blocks: NO reasoning_content emitted',
    malformedAssistant.reasoning_content === undefined);

console.log();
console.log('── Round-trip: parse → emit produces verbatim reasoning_details ──');

const rtParsed = openrouter.fromApiResponse(claudeViaORResponse);
const rtStored = {
    role: 'assistant',
    content: rtParsed.text,
    toolCalls: rtParsed.toolCalls,
    reasoningBlocks: rtParsed.reasoningBlocks,
};
const rtWire = openrouter.toApiMessages([rtStored], 'anthropic/claude-sonnet-4-6');
const rtAssistant = rtWire.find((m) => m.role === 'assistant');
eq('Round-trip: reasoning_details matches original byte-exactly',
    rtAssistant.reasoning_details,
    claudeViaORResponse.choices[0].message.reasoning_details);

console.log();
console.log('── 3e R1-of-R15: customEchoOverride threading (Custom-delegated only) ──');

// Custom-delegated block on an UNKNOWN model:
//   - override=false → behavior='unknown' → reasoning_content stripped
//   - override=true  → behavior='echo-on-tool-loop' → reasoning_content emitted
// Native OR block (delegateAdapter !== 'openrouter') ignores the override
// even when set true, because the override is per-Custom-config-tuple.
const customDelegatedUnknownMsg = {
    role: 'assistant',
    content: 'r',
    toolCalls: [{ id: 'fc1', name: 'echo', input: {} }],
    reasoningBlocks: [{
        schemaVersion: 1,
        provider: 'custom',
        sourceAdapter: 'custom',
        delegateAdapter: 'openrouter',
        sourceModel: 'unknown-future-deepseek-fork',
        wire: { reasoning_content: 'opaque-thoughts' },
    }],
};

// Override=false → reasoning_content NOT emitted (unknown stays capture-only)
const noOverrideOut = openrouter.toApiMessages(
    [customDelegatedUnknownMsg],
    'unknown-future-deepseek-fork',
    { customEchoOverride: false },
);
const noOverrideAssistant = noOverrideOut.find((m) => m.role === 'assistant');
ok('Custom-delegated unknown + override=false: reasoning_content NOT emitted',
    noOverrideAssistant && noOverrideAssistant.reasoning_content === undefined);

// Override=true → reasoning_content IS emitted (R15 fix — was broken pre-R15)
const overrideOut = openrouter.toApiMessages(
    [customDelegatedUnknownMsg],
    'unknown-future-deepseek-fork',
    { customEchoOverride: true },
);
const overrideAssistant = overrideOut.find((m) => m.role === 'assistant');
eq('Custom-delegated unknown + override=true: reasoning_content emitted (R15 fix)',
    overrideAssistant && overrideAssistant.reasoning_content,
    'opaque-thoughts');

// Native OR block (NOT Custom-delegated) IGNORES customEchoOverride.
// Even with override=true, the native unknown-model gating stays.
const nativeUnknownMsg = {
    role: 'assistant',
    content: 'r',
    toolCalls: [{ id: 'fc2', name: 'echo', input: {} }],
    reasoningBlocks: [{
        schemaVersion: 1,
        provider: 'openrouter',
        sourceAdapter: 'openrouter',
        // NO delegateAdapter — native block
        sourceModel: 'some-unknown-or-model',
        wire: { reasoning_content: 'native thoughts' },
    }],
};
const nativeOverrideOut = openrouter.toApiMessages(
    [nativeUnknownMsg],
    'some-unknown-or-model',
    { customEchoOverride: true },
);
const nativeAssistant = nativeOverrideOut.find((m) => m.role === 'assistant');
ok('Native OR unknown + override=true: reasoning_content NOT emitted (override is per-Custom-tuple)',
    nativeAssistant && nativeAssistant.reasoning_content === undefined);

// Backward compat: no requestOptions arg → behaves as if override=false
// (legacy callsites and direct openrouter usage still work).
const legacyOut = openrouter.toApiMessages([customDelegatedUnknownMsg], 'unknown-future-deepseek-fork');
const legacyAssistant = legacyOut.find((m) => m.role === 'assistant');
ok('Legacy 2-arg call: reasoning_content NOT emitted (no override default)',
    legacyAssistant && legacyAssistant.reasoning_content === undefined);

console.log();
if (failures === 0) {
    console.log('ALL TESTS PASS');
    process.exit(0);
} else {
    console.log(`${failures} TEST(S) FAILED`);
    process.exit(1);
}
