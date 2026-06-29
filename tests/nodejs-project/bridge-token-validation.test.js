'use strict';
// BAT-1071 — bridge-token validation must accept ONLY the canonical UUID shape
// (8-4-4-4-12 hex) and reject malformed content. The old check
// (`length === 36 && /^[0-9a-f-]+$/`) accepted ANY 36 hex-or-dash chars — even
// 36 dashes or misplaced dashes — so a corrupt bridge_token file was used
// instead of failing to the cold value. We test the pure exported validator
// `isCanonicalBridgeToken` (config.js loaded with DEFAULT argv, like smoke.js —
// overriding workDir triggers config's init path and is not needed here).

const assert = require('assert');
const path = require('path');

const BUNDLE = path.resolve(__dirname, '..', '..', 'app', 'src', 'main', 'assets', 'nodejs-project');
// Import the PURE validator module (config.js can't be required in a unit test —
// it reads config.json + process.exit(1)s on missing fields). config.js uses
// this same module, so this exercises the real production validator.
const { isCanonicalBridgeToken } = require(path.join(BUNDLE, 'bridge-token.js'));

let pass = 0, fail = 0;
function check(name, fn) {
    try { fn(); console.log('  ✓ ' + name); pass++; }
    catch (e) { console.log('  ✗ ' + name + '\n    ' + (e && e.message)); fail++; }
}

assert.strictEqual(typeof isCanonicalBridgeToken, 'function', 'isCanonicalBridgeToken must be exported');

const VALID = '3b241101-e2bb-4255-8caf-4136c566a962'; // canonical UUID shape

// ── Accept: real UUIDs (what UUID.randomUUID().toString() produces) ──
check('accepts a canonical lowercase UUID', () => assert.strictEqual(isCanonicalBridgeToken(VALID), true));
check('accepts UPPERCASE hex (case-insensitive)', () => assert.strictEqual(isCanonicalBridgeToken(VALID.toUpperCase()), true));
check('accepts with surrounding whitespace (trimmed)', () => assert.strictEqual(isCanonicalBridgeToken(`  ${VALID}\n`), true));

// ── Reject: the bug class — all of these PASSED the old loose check ──
check('rejects 36 dashes', () => assert.strictEqual(isCanonicalBridgeToken('-'.repeat(36)), false));
check('rejects 36 chars with MISPLACED dashes (32 hex + 4 trailing dashes)', () => assert.strictEqual(isCanonicalBridgeToken('3b241101e2bb42558caf4136c566a962----'), false));
check('rejects 36 hex chars with NO dashes', () => assert.strictEqual(isCanonicalBridgeToken('a'.repeat(36)), false));
check('rejects truncated (35 chars)', () => assert.strictEqual(isCanonicalBridgeToken(VALID.slice(0, 35)), false));
check('rejects too long (37 chars)', () => assert.strictEqual(isCanonicalBridgeToken(VALID + 'a'), false));
check('rejects non-hex in a hex position', () => assert.strictEqual(isCanonicalBridgeToken('zzzzzzzz-e2bb-4255-8caf-4136c566a962'), false));
check('rejects dashes in the wrong positions (right count, wrong places)', () => assert.strictEqual(isCanonicalBridgeToken('3b2411-01e2bb-4255-8caf-4136c566a962'), false));
check('rejects empty string', () => assert.strictEqual(isCanonicalBridgeToken(''), false));
check('rejects non-string (null / undefined / number)', () => {
    assert.strictEqual(isCanonicalBridgeToken(null), false);
    assert.strictEqual(isCanonicalBridgeToken(undefined), false);
    assert.strictEqual(isCanonicalBridgeToken(36), false);
});

console.log('');
if (fail > 0) { console.log(`FAIL: bridge-token-validation.test.js (${fail} failed, ${pass} passed)`); process.exit(1); }
console.log(`PASS: bridge-token-validation.test.js (${pass} checks).`);
