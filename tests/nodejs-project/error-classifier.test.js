#!/usr/bin/env node
// error-classifier.test.js — verify classifyError maps common error patterns
// to stable low-cardinality buckets, and that the fallback path is redacted
// + truncated to 40 chars.

const path = require('path');
const { classifyError } = require(path.join(
    __dirname,
    '../../app/src/main/assets/nodejs-project/error-classifier.js',
));

let fails = 0;
let passes = 0;

function assertEq(actual, expected, msg) {
    if (actual !== expected) {
        console.error(`  FAIL ${msg}: expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
        fails++;
    } else {
        console.log(`  ok   ${msg}`);
        passes++;
    }
}

// ── Common classifications ───────────────────────────────────────────────────
assertEq(classifyError('ENOENT: no such file, open /tmp/foo'), 'file_not_found', 'ENOENT');
assertEq(classifyError('Error: permission denied'), 'permission_denied', 'permission denied');
assertEq(classifyError('EACCES: access denied'), 'permission_denied', 'EACCES');
assertEq(classifyError('EISDIR: is a directory'), 'is_directory', 'EISDIR');
assertEq(classifyError('ENOSPC: no space left on device'), 'disk_full', 'ENOSPC');

assertEq(classifyError('ECONNREFUSED 127.0.0.1:8080'), 'connection_refused', 'ECONNREFUSED');
assertEq(classifyError('getaddrinfo ENOTFOUND api.example.com'), 'dns_error', 'ENOTFOUND dns');
assertEq(classifyError('Request timeout after 30s'), 'timeout', 'timeout');
assertEq(classifyError('ETIMEDOUT'), 'timeout', 'ETIMEDOUT');
assertEq(classifyError('socket hang up'), 'connection_reset', 'ECONNRESET/socket hang up');

assertEq(classifyError('HTTP 404 Not Found'), 'http_404', 'http 404');
assertEq(classifyError('HTTP 500 Internal Server Error'), 'http_500', 'http 500');

assertEq(classifyError('Too many requests'), 'rate_limited', 'rate_limited');

// Auth checked before validation — "401 Unauthorized" must bucket as unauthorized
assertEq(classifyError('401 Unauthorized'), 'unauthorized', 'unauthorized (401)');
assertEq(classifyError('Forbidden'), 'unauthorized', 'forbidden/403');

assertEq(classifyError('invalid argument'), 'validation_error', 'validation');
assertEq(classifyError('field is required'), 'validation_error', 'required');

assertEq(classifyError('user did not confirm'), 'user_canceled', 'user_canceled');
assertEq(classifyError('operation cancelled'), 'user_canceled', 'cancelled');

// ── Fallback — redacted + truncated ─────────────────────────────────────────
const fallback1 = classifyError('something totally unique and weird xyz abc def');
if (fallback1.length > 40) {
    console.error(`  FAIL fallback too long: ${fallback1.length} chars: ${fallback1}`);
    fails++;
} else {
    console.log(`  ok   fallback truncated to ${fallback1.length} chars`);
    passes++;
}

// Fallback with an API key — must be redacted before truncation
const redacted = classifyError('boom sk-ant-abc123def456ghi789jklmn something else that is long');
if (redacted.includes('sk-ant-abc123')) {
    console.error(`  FAIL fallback leaked raw API key: ${redacted}`);
    fails++;
} else {
    console.log(`  ok   fallback redacts sk-ant-*** before truncation (${redacted})`);
    passes++;
}

// ── Falsy inputs ────────────────────────────────────────────────────────────
assertEq(classifyError(''), 'unknown', 'empty string');
assertEq(classifyError(null), 'unknown', 'null');
assertEq(classifyError(undefined), 'unknown', 'undefined');

// ── Summary ─────────────────────────────────────────────────────────────────
console.log(`\n${passes} passed, ${fails} failed`);
if (fails > 0) process.exit(1);
console.log('all tests passed');
process.exit(0);
