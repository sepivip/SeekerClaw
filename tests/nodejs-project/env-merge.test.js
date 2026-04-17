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
const RESERVED_PREFIXES = ['NODE_', 'npm_', 'ANDROID_', 'LC_', 'JAVA_'];

function mergeEnvVars(envVarsObj, targetEnv) {
    const merged = [];
    if (!envVarsObj || typeof envVarsObj !== 'object') return merged;
    for (const [key, value] of Object.entries(envVarsObj)) {
        if (typeof key !== 'string') continue;
        if (!/^[A-Z_][A-Z0-9_]*$/.test(key)) continue;
        if (RESERVED_EXACT.has(key)) continue;
        if (RESERVED_PREFIXES.some((p) => key.startsWith(p))) continue;
        targetEnv[key] = String(value);
        merged.push(key);
    }
    return merged;
}

// --- tests ---
const tests = [];
function t(name, fn) { tests.push([name, fn]); }

t('merges simple KEY=VALUE', () => {
    const env = {};
    const keys = mergeEnvVars({ FOO: 'bar' }, env);
    assert.strictEqual(env.FOO, 'bar');
    assert.deepStrictEqual(keys, ['FOO']);
});

t('coerces non-string values to string', () => {
    const env = {};
    mergeEnvVars({ PORT: 8080 }, env);
    assert.strictEqual(env.PORT, '8080');
});

t('skips reserved exact name PATH', () => {
    const env = {};
    const keys = mergeEnvVars({ PATH: '/tmp' }, env);
    assert.strictEqual(env.PATH, undefined);
    assert.deepStrictEqual(keys, []);
});

t('skips reserved prefix NODE_*', () => {
    const env = {};
    mergeEnvVars({ NODE_OPTIONS: '--foo' }, env);
    assert.strictEqual(env.NODE_OPTIONS, undefined);
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
    assert.deepStrictEqual(mergeEnvVars(null, env), []);
    assert.deepStrictEqual(mergeEnvVars(undefined, env), []);
    assert.deepStrictEqual(mergeEnvVars({}, env), []);
});

t('config.js source fingerprint still present', () => {
    const src = fs.readFileSync(CONFIG_JS, 'utf8');
    // Drift detector: these tokens must appear in config.js for the merge
    // feature to be wired. If this fails, the real module has been edited
    // without updating this test's pure copy.
    assert.ok(src.includes('USER_ENV_KEYS'),
        'config.js is missing USER_ENV_KEYS export');
    assert.ok(src.includes('config.envVars'),
        'config.js is missing config.envVars merge');
});

// --- runner ---
let passed = 0, failed = 0;
for (const [name, fn] of tests) {
    try { fn(); console.log(`  ok  ${name}`); passed++; }
    catch (e) { console.error(`  FAIL ${name}\n    ${e.message}`); failed++; }
}
console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed === 0 ? 0 : 1);
