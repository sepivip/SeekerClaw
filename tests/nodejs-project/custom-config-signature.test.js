#!/usr/bin/env node
// custom-config-signature.test.js — pin BAT-549 Commit 3d signature
// algorithm invariants on the Node side. The Kotlin-side equivalence
// test (CustomConfigSignatureTest.kt) MUST produce identical hashes
// for the same inputs — that's how dual-side stability is enforced.
//
// What this pins:
//   - null sentinel for all-blank input
//   - inputs IN the signature: model, baseUrl, format, sorted header keys
//   - inputs NOT in the signature: apiKey (rotation), header VALUES (secrets)
//   - canonical-input separator behavior (pipe + comma, both invalid in HTTP tokens)
//   - SHA-256 hex (64 lowercase chars)
//   - JSON-parse failure → no-headers (no throw)
//   - Header key normalization: trim, lowercase, dedupe
//   - Prototype-key rejection (`__proto__` / `constructor` / `prototype`)
//   - Header VALUE changes do NOT change the signature (privacy/secret-safety)
//
// Run:  node tests/nodejs-project/custom-config-signature.test.js

'use strict';

const { computeCustomConfigSignature, _sortedHeaderKeys } =
    require('../../app/src/main/assets/nodejs-project/custom-config-signature');

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

console.log('── null sentinel: all-blank input ──');

eq('null when all fields blank',
    computeCustomConfigSignature({
        customModel: '', customBaseUrl: '', customFormat: '', customHeaders: '',
    }),
    null);
eq('null when fields are whitespace-only (trimmed)',
    computeCustomConfigSignature({
        customModel: '   ', customBaseUrl: '\t\n', customFormat: ' ', customHeaders: '  ',
    }),
    null);
eq('null when input object is empty',
    computeCustomConfigSignature({}), null);
eq('null when no input at all',
    computeCustomConfigSignature(undefined), null);

console.log();
console.log('── valid signature: 64-char hex ──');

const sig1 = computeCustomConfigSignature({
    customModel: 'deepseek-v4-pro',
    customBaseUrl: 'https://api.deepseek.com/v1',
    customFormat: 'chat_completions',
    customHeaders: '{"X-API-Key":"sk-secret"}',
});
ok('Signature is 64-char lowercase hex',
    typeof sig1 === 'string' && /^[0-9a-f]{64}$/.test(sig1),
    `actual: ${sig1}`);
console.log(`  sig: ${sig1}`);

console.log();
console.log('── stability: same inputs → same hash ──');

const sig2 = computeCustomConfigSignature({
    customModel: 'deepseek-v4-pro',
    customBaseUrl: 'https://api.deepseek.com/v1',
    customFormat: 'chat_completions',
    customHeaders: '{"X-API-Key":"sk-secret"}',
});
eq('Identical inputs produce identical signatures', sig2, sig1);

console.log();
console.log('── changes IN the signature: each field is sensitive ──');

const sigModelChanged = computeCustomConfigSignature({
    customModel: 'deepseek-r1', // changed
    customBaseUrl: 'https://api.deepseek.com/v1',
    customFormat: 'chat_completions',
    customHeaders: '{"X-API-Key":"sk-secret"}',
});
ok('model change → signature changes', sigModelChanged !== sig1);

const sigBaseUrlChanged = computeCustomConfigSignature({
    customModel: 'deepseek-v4-pro',
    customBaseUrl: 'https://api.deepseek.com/v2', // changed
    customFormat: 'chat_completions',
    customHeaders: '{"X-API-Key":"sk-secret"}',
});
ok('baseUrl change → signature changes', sigBaseUrlChanged !== sig1);

const sigFormatChanged = computeCustomConfigSignature({
    customModel: 'deepseek-v4-pro',
    customBaseUrl: 'https://api.deepseek.com/v1',
    customFormat: 'responses', // changed
    customHeaders: '{"X-API-Key":"sk-secret"}',
});
ok('format change → signature changes', sigFormatChanged !== sig1);

const sigHeaderKeyAdded = computeCustomConfigSignature({
    customModel: 'deepseek-v4-pro',
    customBaseUrl: 'https://api.deepseek.com/v1',
    customFormat: 'chat_completions',
    customHeaders: '{"X-API-Key":"sk-secret","X-Org-Id":"org-1"}', // added key
});
ok('new header key → signature changes', sigHeaderKeyAdded !== sig1);

console.log();
console.log('── changes NOT in the signature ──');

// Header VALUE change MUST NOT change signature (privacy/secret-safety)
const sigHeaderValueChanged = computeCustomConfigSignature({
    customModel: 'deepseek-v4-pro',
    customBaseUrl: 'https://api.deepseek.com/v1',
    customFormat: 'chat_completions',
    customHeaders: '{"X-API-Key":"sk-DIFFERENT-secret"}', // value changed
});
eq('header VALUE change → SAME signature (secret-safe)', sigHeaderValueChanged, sig1);

// Header KEY ORDER doesn't matter (deterministic sort)
const sigHeaderOrderA = computeCustomConfigSignature({
    customModel: 'm', customBaseUrl: 'u', customFormat: 'f',
    customHeaders: '{"A":"v","B":"v","C":"v"}',
});
const sigHeaderOrderB = computeCustomConfigSignature({
    customModel: 'm', customBaseUrl: 'u', customFormat: 'f',
    customHeaders: '{"C":"v","A":"v","B":"v"}',
});
eq('header key order doesn\'t affect signature', sigHeaderOrderB, sigHeaderOrderA);

// Header KEY case doesn't matter (HTTP headers are case-insensitive)
const sigHeaderCaseA = computeCustomConfigSignature({
    customModel: 'm', customBaseUrl: 'u', customFormat: 'f',
    customHeaders: '{"X-API-Key":"v","Authorization":"v"}',
});
const sigHeaderCaseB = computeCustomConfigSignature({
    customModel: 'm', customBaseUrl: 'u', customFormat: 'f',
    customHeaders: '{"x-api-key":"v","authorization":"v"}',
});
eq('header key CASE doesn\'t affect signature (HTTP headers case-insensitive)',
    sigHeaderCaseB, sigHeaderCaseA);

console.log();
console.log('── header parsing edge cases ──');

eq('malformed JSON → empty header keys',
    _sortedHeaderKeys('{not valid json}'), []);
eq('JSON array (not object) → empty',
    _sortedHeaderKeys('["a","b"]'), []);
eq('JSON null → empty',
    _sortedHeaderKeys('null'), []);
eq('Empty string → empty',
    _sortedHeaderKeys(''), []);
eq('Whitespace string → empty',
    _sortedHeaderKeys('   '), []);
eq('Non-string input → empty',
    _sortedHeaderKeys(42), []);
eq('JSON object → keys lowercased + sorted + deduped',
    _sortedHeaderKeys('{"Z":"v","A":"v","M":"v","a":"v"}'),
    ['a', 'm', 'z']);
eq('Whitespace keys filtered',
    _sortedHeaderKeys('{"":"v","   ":"v","X":"v"}'),
    ['x']);
eq('Prototype-poisoning keys rejected',
    _sortedHeaderKeys('{"__proto__":"v","constructor":"v","prototype":"v","X":"v"}'),
    ['x']);

// Hash-level: malformed customHeaders treated as no headers (no throw)
const sigMalformedHeaders = computeCustomConfigSignature({
    customModel: 'm', customBaseUrl: 'u', customFormat: 'f',
    customHeaders: '{not valid',
});
const sigNoHeaders = computeCustomConfigSignature({
    customModel: 'm', customBaseUrl: 'u', customFormat: 'f',
    customHeaders: '',
});
eq('malformed customHeaders JSON → same hash as no headers', sigMalformedHeaders, sigNoHeaders);

console.log();
console.log('── dual-side anchor: golden hash for fixed input ──');

// THIS HASH MUST MATCH the Kotlin CustomConfigSignatureTest golden.
// If you change the algorithm (separator chars, normalization, etc.),
// update BOTH sides AND this golden simultaneously. The golden is the
// dual-side stability anchor — drift is caught at the test boundary.
const golden = computeCustomConfigSignature({
    customModel: 'deepseek-v4-pro',
    customBaseUrl: 'https://api.deepseek.com/v1',
    customFormat: 'chat_completions',
    customHeaders: '{"X-API-Key":"sk-secret","X-Org-Id":"org-1"}',
});
console.log(`  Kotlin must match: ${golden}`);

// Compute manually to verify the algorithm in this test
const crypto = require('crypto');
const expectedCanonical = 'deepseek-v4-pro|https://api.deepseek.com/v1|chat_completions|x-api-key,x-org-id';
const expectedHash = crypto.createHash('sha256').update(expectedCanonical, 'utf8').digest('hex');
eq('Golden matches independent canonical computation', golden, expectedHash);

console.log();
if (failures === 0) {
    console.log('ALL TESTS PASS');
    process.exit(0);
} else {
    console.log(`${failures} TEST(S) FAILED`);
    process.exit(1);
}
