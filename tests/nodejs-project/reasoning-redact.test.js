#!/usr/bin/env node
// reasoning-redact.test.js — pin Codex v4.1 finding 1 (NO raw reasoning
// snippets at any log level) and finding 3 (redaction matrix shape).
//
// What this test guards against:
//  - Mobile log capture risk: logs end up in screenshots and bug reports.
//    Raw signatures, encrypted_content, full reasoning text, redacted_thinking
//    data MUST never appear in any log line at any level. Only fingerprints
//    + lengths + types are allowed.
//  - "first 16 chars sanitized" temptation (was in v4, removed in v4.1).
//
// Run:  node tests/nodejs-project/reasoning-redact.test.js
// Exit: 0 = all pass, 1 = at least one failure.

'use strict';

const {
    redactReasoningBlock,
    redactReasoningBlocks,
    redactReasoningField,
    fingerprint,
    byteLen,
} = require('../../app/src/main/assets/nodejs-project/reasoning-redact');

let failures = 0;

function ok(label, cond, hint = '') {
    if (cond) {
        console.log(`PASS: ${label}`);
    } else {
        console.log(`FAIL: ${label}${hint ? '\n  ' + hint : ''}`);
        failures++;
    }
}

function notIncludes(label, haystack, needle) {
    ok(label, !haystack.includes(needle), `output included forbidden substring "${needle}":\n  ${haystack}`);
}

function includes(label, haystack, needle) {
    ok(label, haystack.includes(needle), `output missing required substring "${needle}":\n  ${haystack}`);
}

console.log('── fingerprint() basics ──');
ok('fingerprint("") → "-"',          fingerprint('') === '-');
ok('fingerprint(null) → "-"',        fingerprint(null) === '-');
ok('fingerprint(undefined) → "-"',   fingerprint(undefined) === '-');
ok('fingerprint stable for same input',
   fingerprint('hello world') === fingerprint('hello world'));
ok('fingerprint differs for different input',
   fingerprint('hello world') !== fingerprint('hello WORLD'));
ok('fingerprint 8 hex chars',
   /^[0-9a-f]{8}$/.test(fingerprint('hello world')));

console.log();
console.log('── byteLen() basics ──');
ok('byteLen("") → 0',             byteLen('') === 0);
ok('byteLen("hello") → 5',         byteLen('hello') === 5);
ok('byteLen multibyte → bytes',    byteLen('café') === 5);
ok('byteLen non-string → 0',       byteLen(42) === 0);

console.log();
console.log('── redactReasoningBlock — Anthropic thinking ──');
const RAW_THINKING = 'Detailed step-by-step reasoning the user must never see in logs: secret_key=sk-ant-FAKE-DO-NOT-LEAK';
const RAW_SIG = 'sig-base64-AbCdEfGhIjKlMnOpQrStUvWxYz0123456789';
const anthropicBlock = {
    schemaVersion: 1,
    provider: 'anthropic',
    sourceAdapter: 'claude',
    sourceModel: 'claude-sonnet-4-6',
    turnId: 'msg_abc',
    wire: { type: 'thinking', thinking: RAW_THINKING, signature: RAW_SIG },
};
const anthropicSummary = redactReasoningBlock(anthropicBlock);
console.log(`  redacted: ${anthropicSummary}`);
notIncludes('Anthropic redaction omits raw thinking text', anthropicSummary, 'step-by-step');
notIncludes('Anthropic redaction omits raw thinking secret', anthropicSummary, 'sk-ant-FAKE');
notIncludes('Anthropic redaction omits raw signature', anthropicSummary, 'AbCdEfGhIjKl');
notIncludes('Anthropic redaction omits sig-base64 prefix', anthropicSummary, 'sig-base64');
includes('Anthropic redaction includes provider', anthropicSummary, 'provider=anthropic');
includes('Anthropic redaction includes model',     anthropicSummary, 'model=claude-sonnet-4-6');
includes('Anthropic redaction includes textLen',   anthropicSummary, `textLen=${byteLen(RAW_THINKING)}`);
includes('Anthropic redaction includes textFp',    anthropicSummary, `textFp=${fingerprint(RAW_THINKING)}`);
includes('Anthropic redaction includes sigFp',     anthropicSummary, `sigFp=${fingerprint(RAW_SIG)}`);

console.log();
console.log('── redactReasoningBlock — Anthropic redacted_thinking ──');
const RAW_REDACTED = 'opaque-server-encrypted-bytes-DO-NOT-LEAK-IN-LOGS';
const anthropicRedacted = {
    schemaVersion: 1, provider: 'anthropic', sourceAdapter: 'claude',
    sourceModel: 'claude-sonnet-4-6', turnId: 'msg_def',
    wire: { type: 'redacted_thinking', data: RAW_REDACTED },
};
const redactedSummary = redactReasoningBlock(anthropicRedacted);
console.log(`  redacted: ${redactedSummary}`);
notIncludes('redacted_thinking omits raw data', redactedSummary, 'opaque-server');
notIncludes('redacted_thinking omits raw bytes', redactedSummary, 'DO-NOT-LEAK');
includes('redacted_thinking kind tag', redactedSummary, 'kind=redacted_thinking');
includes('redacted_thinking dataFp present', redactedSummary, `dataFp=${fingerprint(RAW_REDACTED)}`);

console.log();
console.log('── redactReasoningBlock — OpenAI ──');
const RAW_ENC = 'GcmEncryptedReasoningPayload-Base64-Bytes-MustNotLeak';
const RAW_SUMMARY1 = 'I considered using approach Y because of the database constraint X';
const RAW_SUMMARY2 = 'Then I switched to Z due to the timing requirement';
const openaiBlock = {
    schemaVersion: 1, provider: 'openai', sourceAdapter: 'openai',
    sourceModel: 'gpt-5.5', turnId: 'resp_xyz',
    wire: {
        id: 'rs_abc123',
        summary: [
            { type: 'summary_text', text: RAW_SUMMARY1 },
            { type: 'summary_text', text: RAW_SUMMARY2 },
        ],
        encrypted_content: RAW_ENC,
    },
};
const openaiSummary = redactReasoningBlock(openaiBlock);
console.log(`  redacted: ${openaiSummary}`);
notIncludes('OpenAI omits raw summary text 1', openaiSummary, 'considered using approach');
notIncludes('OpenAI omits raw summary text 2', openaiSummary, 'switched to Z');
notIncludes('OpenAI omits raw encrypted_content', openaiSummary, 'GcmEncrypted');
notIncludes('OpenAI omits Base64-Bytes literal', openaiSummary, 'Base64-Bytes');
includes('OpenAI includes itemId (server-assigned, OK)', openaiSummary, 'itemId=rs_abc123');
includes('OpenAI includes summaryParts count', openaiSummary, 'summaryParts=2');
includes('OpenAI includes encLen byte length',  openaiSummary, `encLen=${byteLen(RAW_ENC)}`);
includes('OpenAI includes encFp', openaiSummary, `encFp=${fingerprint(RAW_ENC)}`);

console.log();
console.log('── redactReasoningBlock — OpenRouter reasoning_details ──');
const RAW_OR_TEXT = 'My internal reasoning that leaked into logs would be terrible.';
const orBlock = {
    schemaVersion: 1, provider: 'openrouter', sourceAdapter: 'openrouter',
    sourceModel: 'anthropic/claude-sonnet-4-6', turnId: 'gen_abc',
    wire: { type: 'reasoning.text', format: 'anthropic-claude-v1', text: RAW_OR_TEXT },
};
const orSummary = redactReasoningBlock(orBlock);
console.log(`  redacted: ${orSummary}`);
notIncludes('OpenRouter omits raw text', orSummary, 'leaked into logs');
notIncludes('OpenRouter omits My internal', orSummary, 'My internal');
includes('OpenRouter includes format', orSummary, 'format=anthropic-claude-v1');
includes('OpenRouter includes type',   orSummary, 'type=reasoning.text');
includes('OpenRouter includes textLen', orSummary, `textLen=${byteLen(RAW_OR_TEXT)}`);

console.log();
console.log('── redactReasoningBlock — Custom (DeepSeek-shape via Custom) ──');
const RAW_DS = 'DeepSeek thought: the user wants foo so I will call tool bar with quux';
const customBlock = {
    schemaVersion: 1, provider: 'custom', sourceAdapter: 'custom',
    delegateAdapter: 'openrouter', sourceModel: 'deepseek-v4-pro',
    turnId: 'cmpl_def',
    wire: { reasoning_content: RAW_DS },
};
const customSummary = redactReasoningBlock(customBlock);
console.log(`  redacted: ${customSummary}`);
notIncludes('Custom omits raw reasoning_content', customSummary, 'DeepSeek thought');
notIncludes('Custom omits "user wants foo"', customSummary, 'user wants foo');
includes('Custom kind=plain', customSummary, 'kind=plain');
includes('Custom includes delegateAdapter', customSummary, 'delegateAdapter=openrouter');
includes('Custom includes sourceModel',     customSummary, 'model=deepseek-v4-pro');
includes('Custom includes len',             customSummary, `len=${byteLen(RAW_DS)}`);
includes('Custom includes fp',              customSummary, `fp=${fingerprint(RAW_DS)}`);

console.log();
console.log('── redactReasoningBlocks — array path ──');
const blocks = [anthropicBlock, openaiBlock, customBlock];
const arraySummary = redactReasoningBlocks(blocks);
console.log(`  redacted: ${arraySummary}`);
includes('Array summary leads with count', arraySummary, 'blocks=3');
notIncludes('Array summary omits ALL raw text (Anthropic)', arraySummary, 'step-by-step');
notIncludes('Array summary omits ALL raw text (OpenAI)',     arraySummary, 'considered using');
notIncludes('Array summary omits ALL raw text (Custom)',     arraySummary, 'DeepSeek thought');
notIncludes('Array summary omits ALL raw signatures',        arraySummary, 'AbCdEfGhIjKl');
notIncludes('Array summary omits ALL raw encrypted_content', arraySummary, 'GcmEncrypted');

ok('Empty array → "blocks=0"', redactReasoningBlocks([]) === 'blocks=0');
ok('null → "blocks=0"',         redactReasoningBlocks(null) === 'blocks=0');

console.log();
console.log('── redactReasoningField — single-string redaction path ──');
const fieldOut = redactReasoningField('A secret thought process the user wrote');
console.log(`  redacted: ${fieldOut}`);
notIncludes('Field redaction omits raw text', fieldOut, 'thought process');
notIncludes('Field redaction omits "A secret"', fieldOut, 'A secret');
includes('Field redaction has len',  fieldOut, 'len=');
includes('Field redaction has fp',   fieldOut, 'fp=');

ok('Field absent → "absent"', redactReasoningField(null) === 'absent');
ok('Field undefined → "absent"', redactReasoningField(undefined) === 'absent');

console.log();
console.log('── Regression: NO "first N chars sanitized" leakage anywhere ──');
// Per Codex v4.1 finding 1: the entire "first 16 chars" bucket was removed.
// Build a block with text starting with a recognizable phrase; assert the
// redacted output never contains the first 4, 8, 16, or 32 chars of it.
const RECOG = 'RECOGNIZABLE_LEAK_PHRASE_DO_NOT_INCLUDE_IN_OUTPUT abcdefghijklmnopqrstuvwxyz';
const leakBlock = {
    schemaVersion: 1, provider: 'custom', sourceAdapter: 'custom',
    delegateAdapter: 'openrouter', sourceModel: 'deepseek-v4-pro',
    wire: { reasoning_content: RECOG },
};
const out = redactReasoningBlock(leakBlock);
notIncludes('No 4-char leak',   out, 'RECO');
notIncludes('No 8-char leak',   out, 'RECOGNIZ');
notIncludes('No 16-char leak',  out, 'RECOGNIZABLE_LEA');
notIncludes('No 32-char leak',  out, 'RECOGNIZABLE_LEAK_PHRASE_DO_NOT_');

console.log();
console.log('── 2b Copilot: redactReasoningField Buffer fast-path ──');
// Test guards against the doc/impl drift: comment claimed
// _safeStringify "handles Buffer" but it actually didn't (R3 moved
// Buffer hashing into fingerprint() directly). redactReasoningField
// must take a Buffer fast-path to avoid expanding to a giant
// `{type:"Buffer",data:[...]}` JSON string. (redactReasoningField
// already imported above.)
const bufLarge = Buffer.alloc(2048, 0x42);
const bufSmall = Buffer.from('hello', 'utf8');
const bufResult = redactReasoningField(bufLarge);
ok('Buffer redaction: returns "bufferLen=N fp=XXXXXXXX" shape',
    /^bufferLen=\d+ fp=[0-9a-f]{8}$/.test(bufResult));
ok('Buffer redaction: bufferLen matches actual byte length',
    bufResult.includes('bufferLen=2048'));
const smallResult = redactReasoningField(bufSmall);
ok('Buffer redaction: small buffer also handled', smallResult.includes('bufferLen=5'));
// Different-byte same-length Buffers produce different fingerprints
const fieldBufA = Buffer.from('AAAAA', 'utf8');
const fieldBufB = Buffer.from('BBBBB', 'utf8');
ok('Buffer redaction: same-length different bytes → different fp',
    redactReasoningField(fieldBufA) !== redactReasoningField(fieldBufB));

console.log();
console.log('── Safe stringify regression (Codex R2 thread 1) ──');
// fingerprint() and the unknown/opaque paths must not throw on BigInt,
// circular refs, or Buffer. Each of these would crash logging call sites
// if not guarded.

// BigInt — JSON.stringify throws "TypeError: Do not know how to serialize a BigInt"
let bigintHash;
try { bigintHash = fingerprint(BigInt(12345)); ok('fingerprint(BigInt) does not throw', true); }
catch (e) { ok('fingerprint(BigInt) does not throw', false, e.message); }
ok('fingerprint(BigInt) returns 8-char hex', /^[0-9a-f]{8}$/.test(bigintHash || ''));

// Circular reference
const circ = { foo: 'bar' }; circ.self = circ;
let circHash;
try { circHash = fingerprint(circ); ok('fingerprint(circular) does not throw', true); }
catch (e) { ok('fingerprint(circular) does not throw', false, e.message); }
ok('fingerprint(circular) returns valid output (not "-")', circHash && circHash !== '-');

// Buffer — fingerprinted via bytes directly (R3 thread 3 fix). Two
// same-length Buffers with different bytes MUST produce different
// fingerprints; previous implementation collided them via a
// `<Buffer:<len>b>` placeholder.
const buf = Buffer.from('reasoning bytes that should not be JSON-expanded for hashing', 'utf8');
let bufHash;
try { bufHash = fingerprint(buf); ok('fingerprint(Buffer) does not throw', true); }
catch (e) { ok('fingerprint(Buffer) does not throw', false, e.message); }
ok('fingerprint(Buffer) returns 8-char hex', /^[0-9a-f]{8}$/.test(bufHash || ''));

// R3 thread 3 — collision regression: same-length Buffers must hash differently
const bufA = Buffer.from('AAAAAAAA', 'utf8');
const bufB = Buffer.from('BBBBBBBB', 'utf8');
ok('Same-length Buffers with different bytes produce different fingerprints',
    fingerprint(bufA) !== fingerprint(bufB),
    `bufA fp=${fingerprint(bufA)} bufB fp=${fingerprint(bufB)}`);
ok('Buffer fingerprint matches its string-content fingerprint when bytes equal',
    // Sanity: buffer of "hello" must hash same as string "hello"
    fingerprint(Buffer.from('hello', 'utf8')) === fingerprint('hello'));

// Opaque-wire path with BigInt inside
const opaqueBlock = {
    schemaVersion: 1, provider: 'custom', sourceAdapter: 'custom',
    sourceModel: 'unknown-gateway', wire: { weird: BigInt(42) },
};
let opaqueOut;
try { opaqueOut = redactReasoningBlock(opaqueBlock); ok('redactReasoningBlock(BigInt-wire) does not throw', true); }
catch (e) { ok('redactReasoningBlock(BigInt-wire) does not throw', false, e.message); }
ok('opaque block summary still has kind tag',
    typeof opaqueOut === 'string' && (opaqueOut.includes('kind=opaque') || opaqueOut.includes('kind=unknown')));

// Unknown-provider path with circular wire
const unknownBlock = {
    schemaVersion: 1, provider: 'future-provider-v9', sourceAdapter: 'future',
    sourceModel: 'whatever', wire: circ,
};
let unknownOut;
try { unknownOut = redactReasoningBlock(unknownBlock); ok('redactReasoningBlock(circular-wire) does not throw', true); }
catch (e) { ok('redactReasoningBlock(circular-wire) does not throw', false, e.message); }
ok('unknown block summary contains kind=unknown',
    typeof unknownOut === 'string' && unknownOut.includes('kind=unknown'));

console.log();
if (failures === 0) {
    console.log('ALL TESTS PASS');
    process.exit(0);
} else {
    console.log(`${failures} TEST(S) FAILED`);
    process.exit(1);
}
