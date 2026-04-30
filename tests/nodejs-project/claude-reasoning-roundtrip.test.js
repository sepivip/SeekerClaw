#!/usr/bin/env node
// claude-reasoning-roundtrip.test.js — pin BAT-549 Commit 2 Anthropic
// preservation invariants:
//
//  - fromApiResponse captures `thinking` + `redacted_thinking` verbatim
//    into reasoningBlocks (signature byte-exact, raw wire payload)
//  - toApiMessages emits thinking blocks FIRST in content[] on tool-use
//    turns (Anthropic server-validates signature; order matters)
//  - text-only assistant turns do NOT replay thinking (contract: tool-
//    use loops only)
//  - Other-provider blocks (custom/openrouter) are skipped — only
//    sourceAdapter==='claude' blocks emit on this adapter
//  - Malformed blocks (missing signature, wrong types) are skipped
//  - Legacy Claude-native content arrays pass through unchanged (no
//    double-emit of thinking blocks)
//  - Schema discriminator (Codex v3 finding 1) on every captured block
//
// Run:  node tests/nodejs-project/claude-reasoning-roundtrip.test.js

'use strict';

// claude.js requires '../config' for `log`. Stub it before requiring.
const path = require('path');
const configPath = path.resolve(__dirname, '../../app/src/main/assets/nodejs-project/config.js');
require.cache[configPath] = {
    id: configPath,
    filename: configPath,
    loaded: true,
    exports: { log: () => {} },
};

const claude = require('../../app/src/main/assets/nodejs-project/providers/claude');

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

// ── Fixture: a typical thinking-enabled tool-use response from Claude ──

const SIG = 'EpgDCkYIBxgCKkA4nQ-fake-signature-bytes-for-testing-do-not-validate-this'
    + 'YwYjg5N2Y3M2QzZTgwYWJjMTIzNDU2Nzg5MGFiY2RlZmFiY2RlZmFiY2RlZmFiY2RlZmFiY2RlZg==';

const claudeToolUseResponse = {
    id: 'msg_01ABCDEFG',
    model: 'claude-sonnet-4-6',
    type: 'message',
    role: 'assistant',
    content: [
        {
            type: 'thinking',
            thinking: 'The user is asking about weather. I should call the weather tool.',
            signature: SIG,
        },
        {
            type: 'text',
            text: 'Let me check the weather for you.',
        },
        {
            type: 'tool_use',
            id: 'toolu_01XYZ',
            name: 'weather',
            input: { city: 'Tbilisi' },
        },
    ],
    stop_reason: 'tool_use',
    usage: { input_tokens: 100, output_tokens: 50 },
};

console.log('── fromApiResponse: capture thinking + redacted_thinking ──');
const parsed = claude.fromApiResponse(claudeToolUseResponse);
eq('Captured 1 reasoning block', parsed.reasoningBlocks.length, 1);
const block = parsed.reasoningBlocks[0];
eq('Block schemaVersion = 1', block.schemaVersion, 1);
eq('Block provider = anthropic', block.provider, 'anthropic');
eq('Block sourceAdapter = claude', block.sourceAdapter, 'claude');
eq('Block sourceModel = claude-sonnet-4-6', block.sourceModel, 'claude-sonnet-4-6');
eq('Block turnId = msg_01ABCDEFG', block.turnId, 'msg_01ABCDEFG');
ok('Block wire is the verbatim thinking block (reference equality)',
    block.wire === claudeToolUseResponse.content[0]);
eq('Block wire.thinking text preserved', block.wire.thinking,
    'The user is asking about weather. I should call the weather tool.');
eq('Block wire.signature preserved byte-exact', block.wire.signature, SIG);

// Multi-block: thinking + redacted_thinking
const multiBlockResp = {
    id: 'msg_02', model: 'claude-opus-4-7',
    content: [
        { type: 'thinking', thinking: 'first thought', signature: SIG + '-1' },
        { type: 'redacted_thinking', data: 'OPAQUE_SERVER_DATA_HERE' },
        { type: 'thinking', thinking: 'second thought', signature: SIG + '-2' },
        { type: 'text', text: 'response' },
        { type: 'tool_use', id: 'tc1', name: 'echo', input: {} },
    ],
    stop_reason: 'tool_use',
    usage: {},
};
const multiParsed = claude.fromApiResponse(multiBlockResp);
eq('Multi-block: 3 reasoning blocks captured', multiParsed.reasoningBlocks.length, 3);
eq('Multi-block: order preserved (thinking, redacted_thinking, thinking)',
    multiParsed.reasoningBlocks.map((b) => b.wire.type),
    ['thinking', 'redacted_thinking', 'thinking']);
eq('Multi-block: redacted_thinking.data preserved',
    multiParsed.reasoningBlocks[1].wire.data, 'OPAQUE_SERVER_DATA_HERE');

// No thinking blocks
const plainResp = {
    id: 'msg_03', model: 'claude-haiku-4-5',
    content: [{ type: 'text', text: 'plain answer' }],
    stop_reason: 'end_turn', usage: {},
};
eq('No-thinking response: empty reasoningBlocks', claude.fromApiResponse(plainResp).reasoningBlocks, []);

// Empty content
eq('Empty content: empty reasoningBlocks',
    claude.fromApiResponse({ id: 'm', content: [], usage: {} }).reasoningBlocks, []);

// Missing model field — sourceModel is null (per safe-extraction in fromApiResponse)
const noModelResp = {
    id: 'm-noModel',
    content: [{ type: 'thinking', thinking: 't', signature: 's' }],
    usage: {},
};
eq('Missing model: sourceModel = null',
    claude.fromApiResponse(noModelResp).reasoningBlocks[0].sourceModel, null);

console.log();
console.log('── toApiMessages: thinking blocks FIRST in content[] on tool-use turns ──');

// Build a stored neutral assistant message with reasoningBlocks (matching what
// fromApiResponse would have stored)
const storedAssistant = {
    role: 'assistant',
    content: 'Let me check the weather for you.',
    toolCalls: [{ id: 'toolu_01XYZ', name: 'weather', input: { city: 'Tbilisi' } }],
    reasoningBlocks: [parsed.reasoningBlocks[0]],
};

const messages = [
    { role: 'user', content: 'weather in tbilisi?' },
    storedAssistant,
    { role: 'tool', toolCallId: 'toolu_01XYZ', content: '{"temp":18}' },
];

const apiMsgs = claude.toApiMessages(messages);
eq('toApiMessages produces 3 API messages', apiMsgs.length, 3);
const apiAssistant = apiMsgs[1];
eq('Assistant message role correct', apiAssistant.role, 'assistant');
ok('Assistant content is an array', Array.isArray(apiAssistant.content));
eq('Content has 3 blocks (thinking, text, tool_use)', apiAssistant.content.length, 3);
eq('Block 0 type is thinking (FIRST)', apiAssistant.content[0].type, 'thinking');
eq('Block 0 signature byte-exact', apiAssistant.content[0].signature, SIG);
eq('Block 1 type is text', apiAssistant.content[1].type, 'text');
eq('Block 2 type is tool_use', apiAssistant.content[2].type, 'tool_use');

// Multiple thinking blocks preserve order
const multiStored = {
    role: 'assistant',
    content: 'response',
    toolCalls: [{ id: 'tc1', name: 'echo', input: {} }],
    reasoningBlocks: multiParsed.reasoningBlocks,
};
const multiApi = claude.toApiMessages([multiStored])[0];
eq('Multi-block emit: 5 blocks (3 thinking + text + tool_use)',
    multiApi.content.length, 5);
eq('Multi-block emit: first 3 are thinking-family blocks',
    multiApi.content.slice(0, 3).map((b) => b.type),
    ['thinking', 'redacted_thinking', 'thinking']);
eq('Multi-block emit: text comes after thinking',
    multiApi.content[3].type, 'text');
eq('Multi-block emit: tool_use last',
    multiApi.content[4].type, 'tool_use');

console.log();
console.log('── toApiMessages: text-only assistant turn does NOT replay thinking ──');

const textOnlyStored = {
    role: 'assistant',
    content: 'just a text answer',
    toolCalls: [],
    reasoningBlocks: [parsed.reasoningBlocks[0]], // has thinking from a prior turn
};
const textOnlyApi = claude.toApiMessages([textOnlyStored])[0];
ok('Text-only assistant: NO thinking blocks emitted',
    !textOnlyApi.content.some((b) => b.type === 'thinking' || b.type === 'redacted_thinking'));
eq('Text-only assistant: only text block', textOnlyApi.content.length, 1);
eq('Text-only assistant: text block type', textOnlyApi.content[0].type, 'text');

// Same shape but undefined toolCalls — still no echo
const noToolsStored = {
    role: 'assistant',
    content: 'plain',
    reasoningBlocks: [parsed.reasoningBlocks[0]],
};
const noToolsApi = claude.toApiMessages([noToolsStored])[0];
ok('Undefined toolCalls: no thinking echoed',
    !noToolsApi.content.some((b) => b.type === 'thinking'));

console.log();
console.log('── toApiMessages: skips non-claude reasoningBlocks ──');

const customBlock = {
    schemaVersion: 1, provider: 'custom', sourceAdapter: 'custom',
    delegateAdapter: 'openrouter', sourceModel: 'deepseek-v4-pro',
    wire: { reasoning_content: 'deepseek thinking' },
};
const orBlock = {
    schemaVersion: 1, provider: 'openrouter', sourceAdapter: 'openrouter',
    sourceModel: 'anthropic/claude-opus-4-7',
    wire: { type: 'reasoning.text', text: '...', format: 'anthropic-claude-v1' },
};
const mixedStored = {
    role: 'assistant',
    content: 'response',
    toolCalls: [{ id: 'tc1', name: 'echo', input: {} }],
    reasoningBlocks: [
        customBlock,
        orBlock,
        parsed.reasoningBlocks[0], // the only claude-stamped one
    ],
};
const mixedApi = claude.toApiMessages([mixedStored])[0];
const thinkingCount = mixedApi.content.filter((b) => b.type === 'thinking' || b.type === 'redacted_thinking').length;
eq('Mixed-provider blocks: only the 1 claude-stamped block emits',
    thinkingCount, 1);
eq('Mixed-provider: emitted block matches the claude one',
    mixedApi.content.find((b) => b.type === 'thinking').signature, SIG);

console.log();
console.log('── toApiMessages: skips malformed blocks ──');

const malformedBlocks = [
    // Missing signature on thinking
    { schemaVersion: 1, provider: 'anthropic', sourceAdapter: 'claude',
      wire: { type: 'thinking', thinking: 'no sig' } },
    // Wrong type on thinking field
    { schemaVersion: 1, provider: 'anthropic', sourceAdapter: 'claude',
      wire: { type: 'thinking', thinking: 12345, signature: 'sig' } },
    // Missing data on redacted_thinking
    { schemaVersion: 1, provider: 'anthropic', sourceAdapter: 'claude',
      wire: { type: 'redacted_thinking' } },
    // Wire is null
    { schemaVersion: 1, provider: 'anthropic', sourceAdapter: 'claude', wire: null },
    // Wire is array (not object)
    { schemaVersion: 1, provider: 'anthropic', sourceAdapter: 'claude', wire: ['x'] },
    // Wire type not thinking-family
    { schemaVersion: 1, provider: 'anthropic', sourceAdapter: 'claude',
      wire: { type: 'text', text: 'wrong type' } },
];

for (const blk of malformedBlocks) {
    const stored = {
        role: 'assistant', content: 'r',
        toolCalls: [{ id: 'tc', name: 'e', input: {} }],
        reasoningBlocks: [blk],
    };
    const api = claude.toApiMessages([stored])[0];
    const hasThinking = api.content.some((b) => b.type === 'thinking' || b.type === 'redacted_thinking');
    ok(`Malformed block (${JSON.stringify(blk.wire).slice(0, 40)}): NOT emitted`, !hasThinking);
}

console.log();
console.log('── toApiMessages: legacy Claude-native content array passes through unchanged ──');

// A checkpoint pre-BAT-549 might have stored the assistant message in
// Claude-native form (content as array of blocks). The pass-through path
// must NOT double-emit thinking blocks from reasoningBlocks.
const legacyClaudeNative = {
    role: 'assistant',
    content: [
        { type: 'thinking', thinking: 'inline thought', signature: 'inline-sig' },
        { type: 'text', text: 'inline answer' },
    ],
    // Some checkpoint also stored reasoningBlocks (defensive: shouldn't double-emit)
    reasoningBlocks: [parsed.reasoningBlocks[0]],
    toolCalls: [{ id: 'tc1', name: 'echo', input: {} }],
};
const legacyApi = claude.toApiMessages([legacyClaudeNative])[0];
eq('Legacy native: content passes through unchanged (no double-emit)',
    legacyApi.content, legacyClaudeNative.content);
ok('Legacy native: thinking in content is the inline one (not the separate block)',
    legacyApi.content[0].thinking === 'inline thought');

console.log();
console.log('── Round-trip: fromApiResponse → toApiMessages produces equivalent assistant block ──');

const rtParsed = claude.fromApiResponse(claudeToolUseResponse);
const rtStored = {
    role: 'assistant',
    content: rtParsed.text,
    toolCalls: rtParsed.toolCalls,
    reasoningBlocks: rtParsed.reasoningBlocks,
};
const rtApi = claude.toApiMessages([rtStored])[0];
// Reconstructed content[] should match the original response content[]:
//   thinking, text, tool_use — same shapes, same fields, same order
eq('Round-trip content[] matches original (signature, order, fields)',
    rtApi.content, claudeToolUseResponse.content);

console.log();
if (failures === 0) {
    console.log('ALL TESTS PASS');
    process.exit(0);
} else {
    console.log(`${failures} TEST(S) FAILED`);
    process.exit(1);
}
