#!/usr/bin/env node
// env-merge.test.js — unit tests for the envVars merge logic in config.js.
//
// Run:  node tests/nodejs-project/env-merge.test.js
// Exit: 0 = all pass, 1 = at least one failure.
//
// We can't require('config.js') directly (it reads a real config.json and
// exits on missing). Instead we copy the merge logic verbatim from the
// module into this file as a pure function, and also assert that the live
// source string still contains expected fingerprint tokens so we notice
// if the module's copy drifts.

const assert = require('assert');
const fs = require('fs');
const path = require('path');

const CONFIG_JS = path.join(__dirname, '..', '..', 'app', 'src', 'main',
    'assets', 'nodejs-project', 'config.js');

// --- extracted pure function (must mirror config.js) ---
const RESERVED_EXACT = new Set([
    'PATH', 'HOME', 'TMPDIR', 'USER', 'SHELL', 'LANG', 'TERM',
    'AGENT_VERSION',
    'API_TIMEOUT_MS', 'API_TIMEOUT_RETRIES',
    'API_TIMEOUT_BACKOFF_MS', 'API_TIMEOUT_MAX_BACKOFF_MS',
    'WS_NO_UTF_8_VALIDATE', 'WS_NO_BUFFER_UTIL',
]);
const RESERVED_PREFIXES = ['NODE_', 'NPM_', 'ANDROID_', 'LC_', 'JAVA_'];
const MAX_KEYS = 256;
const MAX_VALUE_BYTES = 8192;

function mergeEnvVars(envVarsObj, targetEnv) {
    const merged = [];
    let droppedOversize = 0;
    if (!envVarsObj || typeof envVarsObj !== 'object') return { merged, droppedOversize };
    for (const [key, value] of Object.entries(envVarsObj)) {
        if (merged.length >= MAX_KEYS) break;
        if (typeof key !== 'string') continue;
        if (!/^[A-Z_][A-Z0-9_]*$/.test(key)) continue;
        if (RESERVED_EXACT.has(key)) continue;
        if (RESERVED_PREFIXES.some((p) => key.startsWith(p))) continue;
        const str = String(value);
        if (Buffer.byteLength(str, 'utf8') > MAX_VALUE_BYTES) {
            droppedOversize++;
            continue;
        }
        targetEnv[key] = str;
        merged.push(key);
    }
    return { merged, droppedOversize };
}

// --- tests ---
const tests = [];
function t(name, fn) { tests.push([name, fn]); }

t('merges simple KEY=VALUE', () => {
    const env = {};
    const { merged } = mergeEnvVars({ FOO: 'bar' }, env);
    assert.strictEqual(env.FOO, 'bar');
    assert.deepStrictEqual(merged, ['FOO']);
});

t('coerces non-string values to string', () => {
    const env = {};
    mergeEnvVars({ PORT: 8080 }, env);
    assert.strictEqual(env.PORT, '8080');
});

t('skips reserved exact name PATH', () => {
    const env = {};
    const { merged } = mergeEnvVars({ PATH: '/tmp' }, env);
    assert.strictEqual(env.PATH, undefined);
    assert.deepStrictEqual(merged, []);
});

t('skips reserved prefix NODE_*', () => {
    const env = {};
    mergeEnvVars({ NODE_OPTIONS: '--foo' }, env);
    assert.strictEqual(env.NODE_OPTIONS, undefined);
});

t('skips reserved prefix NPM_*', () => {
    const env = {};
    mergeEnvVars({ NPM_CONFIG_X: 'y' }, env);
    assert.strictEqual(env.NPM_CONFIG_X, undefined);
});

t('skips invalid names (lowercase)', () => {
    const env = {};
    mergeEnvVars({ foo: 'bar' }, env);
    assert.strictEqual(env.foo, undefined);
});

t('skips invalid names (leading digit)', () => {
    const env = {};
    mergeEnvVars({ '1FOO': 'bar' }, env);
    assert.strictEqual(env['1FOO'], undefined);
});

t('empty/missing object is no-op', () => {
    const env = {};
    assert.deepStrictEqual(mergeEnvVars(null, env), { merged: [], droppedOversize: 0 });
    assert.deepStrictEqual(mergeEnvVars(undefined, env), { merged: [], droppedOversize: 0 });
    assert.deepStrictEqual(mergeEnvVars({}, env), { merged: [], droppedOversize: 0 });
});

t('drops values over 8 KB cap and reports count', () => {
    const env = {};
    const big = 'x'.repeat(8193);
    const small = 'ok';
    const { merged, droppedOversize } = mergeEnvVars({ TOO_BIG: big, FINE: small }, env);
    assert.strictEqual(env.TOO_BIG, undefined);
    assert.strictEqual(env.FINE, 'ok');
    assert.deepStrictEqual(merged, ['FINE']);
    assert.strictEqual(droppedOversize, 1);
});

t('stops at MAX_KEYS cap', () => {
    const env = {};
    const input = {};
    for (let i = 0; i < 260; i++) input[`KEY_${i}`] = String(i);
    const { merged } = mergeEnvVars(input, env);
    assert.strictEqual(merged.length, 256);
});

t('config.js merge wiring still present (structural, not substring)', () => {
    const src = fs.readFileSync(CONFIG_JS, 'utf8');
    // Strip comments so "USER_ENV_KEYS" in a comment can't satisfy these checks.
    const code = src
        .replace(/\/\*[\s\S]*?\*\//g, '')  // block comments
        .replace(/(^|[^:])\/\/[^\n]*/g, '$1');  // line comments (avoid URLs)

    // Declaration of the export array
    assert.ok(/const\s+USER_ENV_KEYS\s*=\s*\[\s*\]/.test(code),
        'config.js is missing `const USER_ENV_KEYS = []` declaration');
    // Merge loop iterates config.envVars entries
    assert.ok(/Object\.entries\s*\(\s*config\.envVars\s*\)/.test(code),
        'config.js is missing Object.entries(config.envVars) merge loop');
    // Actually writes into process.env — value source can be String(value) or a
    // named variable (e.g. `str`) after the value has been size-checked.
    assert.ok(/process\.env\[key\]\s*=\s*(String\(value\)|[A-Za-z_$][\w$]*)/.test(code),
        'config.js is missing process.env[key] = <value> assignment');
    // Size-checks the value against the 8 KB cap before writing (defense in depth).
    // The threshold can be either a literal (e.g. 8192) or a named constant
    // (e.g. _ENV_MAX_VALUE_BYTES) — accept either as evidence the check is wired.
    assert.ok(/Buffer\.byteLength\s*\([^)]+,\s*['"]utf8['"]\s*\)\s*>\s*[\w$]+/.test(code),
        'config.js is missing Buffer.byteLength value-size check');
    // Pushes into USER_ENV_KEYS after a successful write
    assert.ok(/USER_ENV_KEYS\.push\s*\(\s*key\s*\)/.test(code),
        'config.js is missing USER_ENV_KEYS.push(key) inside merge loop');
    // Exported from module.exports
    assert.ok(/module\.exports\s*=\s*\{[^}]*\bUSER_ENV_KEYS\b/s.test(code),
        'config.js is missing USER_ENV_KEYS in module.exports');
});

// --- runner ---
let passed = 0, failed = 0;
for (const [name, fn] of tests) {
    try { fn(); console.log(`  ok  ${name}`); passed++; }
    catch (e) { console.error(`  FAIL ${name}\n    ${e.message}`); failed++; }
}
console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed === 0 ? 0 : 1);
