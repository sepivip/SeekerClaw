#!/usr/bin/env node
// claude-thinking-signature.test.js — regression guard for BAT-1033.
//
// THE BUG (shipped in v2.1.0): Anthropic streams a `thinking` block as
//   content_block_start {type:'thinking', thinking:'', signature:''}
//   content_block_delta {thinking_delta:  <reasoning text>}
//   content_block_delta {signature_delta: <the real signature>}
// but http.js's SSE reducer only handled text_delta + input_json_delta, so it
// DROPPED thinking_delta + signature_delta. The assembled block kept the empty
// signature from content_block_start. Echoing that block back on the next
// tool-loop round → API 400 "each thinking block must contain thinking".
//
// PROVEN via live setup_token probe (tests/live/anthropic/test-thinking-poison.js):
//   - a signed EMPTY-TEXT thinking block replays 200 (empty text is fine)
//   - the SAME block with signature:'' replays 400 (the exact prod error)
// → the invariant is the SIGNATURE, not the text.
//
// This test pins two layers, offline + deterministic:
//   1. http.js reducer assembles the FULL signature + text (would FAIL pre-fix).
//   2. claude.js replay guard skips an empty-signature block but keeps a signed
//      one (even with empty text) — recovers poisoned checkpoints on upgrade.
//
// Run:  node tests/nodejs-project/claude-thinking-signature.test.js
'use strict';

const path = require('path');

// Stub config.js (shared by http.js + claude.js) BEFORE requiring either.
const configPath = path.resolve(__dirname, '../../app/src/main/assets/nodejs-project/config.js');
require.cache[configPath] = {
    id: configPath, filename: configPath, loaded: true,
    exports: { log: () => {}, API_TIMEOUT_MS: 60000 },
};

const http = require('../../app/src/main/assets/nodejs-project/http');
const claude = require('../../app/src/main/assets/nodejs-project/providers/claude');

let failures = 0;
function ok(label, cond, hint = '') {
    if (cond) console.log(`PASS: ${label}`);
    else { console.log(`FAIL: ${label}${hint ? ' — ' + hint : ''}`); failures++; }
}

const SIG = 'EvoBCmMIDxgCKkBd1zSf-EXAMPLE-thinking-signature-bytes-abc123==';

console.log('── BAT-1033: streamed thinking block must retain its signature ──');

// ── Layer 1: http.js SSE reducer ────────────────────────────────────────────
// Feed the EXACT event sequence Anthropic streams (start-shell → thinking_delta
// → signature_delta), plus a tool_use block, through the real reducer.
const events = [
    { eventType: 'message_start', data: { message: { id: 'msg_1', model: 'claude-sonnet-5', usage: { input_tokens: 10 } } } },
    { eventType: 'content_block_start', data: { index: 0, content_block: { type: 'thinking', thinking: '', signature: '' } } },
    { eventType: 'content_block_delta', data: { index: 0, delta: { type: 'thinking_delta', thinking: 'Let me ' } } },
    { eventType: 'content_block_delta', data: { index: 0, delta: { type: 'thinking_delta', thinking: 'check the logs.' } } },
    { eventType: 'content_block_delta', data: { index: 0, delta: { type: 'signature_delta', signature: SIG } } },
    { eventType: 'content_block_stop', data: { index: 0 } },
    { eventType: 'content_block_start', data: { index: 1, content_block: { type: 'tool_use', id: 'tu_1', name: 'read', input: {} } } },
    { eventType: 'content_block_delta', data: { index: 1, delta: { type: 'input_json_delta', partial_json: '{"path":' } } },
    { eventType: 'content_block_delta', data: { index: 1, delta: { type: 'input_json_delta', partial_json: '"/logs"}' } } },
    { eventType: 'content_block_stop', data: { index: 1 } },
    { eventType: 'message_delta', data: { delta: { stop_reason: 'tool_use' }, usage: { output_tokens: 20 } } },
    { eventType: 'message_stop', data: {} },
];

const msg = http.assembleClaudeStreamMessage(events);
const think = Array.isArray(msg.content) ? msg.content.find((b) => b.type === 'thinking') : null;
const tool = Array.isArray(msg.content) ? msg.content.find((b) => b.type === 'tool_use') : null;

ok('(1) reducer preserves the streamed signature (the fix)',
    !!think && think.signature === SIG,
    `got signature=${JSON.stringify(think && think.signature)}`);
ok('(2) reducer preserves the streamed thinking text',
    !!think && think.thinking === 'Let me check the logs.',
    `got thinking=${JSON.stringify(think && think.thinking)}`);
ok('(3) tool_use block still assembles from input_json_delta (refactor regression guard)',
    !!tool && tool.id === 'tu_1' && tool.input && tool.input.path === '/logs',
    `got tool=${JSON.stringify(tool)}`);
ok('(4) message_stop propagates stop_reason', msg.stop_reason === 'tool_use');

// ── Layer 1b: capture side stores the good signature ─────────────────────────
const captured = claude.fromApiResponse(msg).reasoningBlocks;
ok('(5) fromApiResponse captures the thinking block WITH its signature',
    captured.length === 1 && captured[0].wire && captured[0].wire.signature === SIG,
    `captured=${JSON.stringify(captured)}`);

// ── Layer 1c: capture-side guard (BAT-1033) — poison never enters a checkpoint.
// Mirror the replay guard at the fromApiResponse boundary: a blank-signature
// thinking block must be dropped on capture; signed (even empty-text) thinking
// and redacted_thinking must be kept.
const mixedResp = {
    id: 'msg_mixed', model: 'claude-sonnet-5', stop_reason: 'end_turn', usage: {},
    content: [
        { type: 'thinking', thinking: '', signature: '' },          // poison → drop
        { type: 'thinking', thinking: '  ', signature: '   ' },     // whitespace sig → drop
        { type: 'thinking', thinking: '', signature: SIG },         // signed empty-text → keep
        { type: 'thinking', thinking: 'real reasoning', signature: SIG }, // normal → keep
        { type: 'redacted_thinking', data: 'AAAA' },                // keep
    ],
};
const capMixed = claude.fromApiResponse(mixedResp).reasoningBlocks;
ok('(5b) blank/whitespace-signature thinking blocks are NOT captured',
    !capMixed.some((b) => b.wire.type === 'thinking' && (b.wire.signature || '').trim() === ''),
    `captured=${JSON.stringify(capMixed.map((b) => b.wire))}`);
ok('(5c) signed thinking (incl. empty-text) + redacted_thinking ARE captured',
    capMixed.filter((b) => b.wire.type === 'thinking').length === 2
    && capMixed.some((b) => b.wire.type === 'redacted_thinking'),
    `captured=${JSON.stringify(capMixed.map((b) => b.wire))}`);

// ── Layer 2: claude.js replay guard (defense-in-depth) ───────────────────────
function replaysThinking(reasoningBlocks) {
    const asst = claude.toApiMessages([
        { role: 'user', content: 'check logs' },
        { role: 'assistant', content: 'ok', toolCalls: [{ id: 'tc1', name: 'read', input: {} }], reasoningBlocks },
        { role: 'tool', toolCallId: 'tc1', content: '{"ok":true}' },
    ]).find((m) => m.role === 'assistant');
    return (asst && Array.isArray(asst.content))
        ? asst.content.filter((b) => b.type === 'thinking')
        : [];
}
const mkBlock = (wire) => ({ schemaVersion: 1, provider: 'anthropic', sourceAdapter: 'claude', sourceModel: 'claude-sonnet-5', turnId: 't', wire });

// Poisoned block (empty signature) — the v2.1.0 shape — must be skipped, not replayed.
ok('(6) empty-signature thinking block is NOT replayed (would 400)',
    replaysThinking([mkBlock({ type: 'thinking', thinking: '', signature: '' })]).length === 0);
// Whitespace-only signature — equally invalid.
ok('(7) whitespace-signature thinking block is NOT replayed',
    replaysThinking([mkBlock({ type: 'thinking', thinking: 'x', signature: '   ' })]).length === 0);
// Signed but EMPTY-TEXT block — valid per live probe — MUST still replay.
const emptyTextSigned = replaysThinking([mkBlock({ type: 'thinking', thinking: '', signature: SIG })]);
ok('(8) signed empty-TEXT thinking block IS replayed (empty text is valid)',
    emptyTextSigned.length === 1 && emptyTextSigned[0].signature === SIG);
// Signed non-empty block — the normal case — replayed unchanged.
const signed = replaysThinking([mkBlock({ type: 'thinking', thinking: 'real reasoning', signature: SIG })]);
ok('(9) signed non-empty thinking block IS replayed unchanged',
    signed.length === 1 && signed[0].thinking === 'real reasoning' && signed[0].signature === SIG);

console.log();
if (failures === 0) { console.log('ALL TESTS PASS'); process.exit(0); }
else { console.log(`${failures} TEST(S) FAILED`); process.exit(1); }
