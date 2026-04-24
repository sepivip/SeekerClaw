#!/usr/bin/env node
// active-model.test.js — tests for resolveActiveModel() in config.js.
//
// Run:  node tests/nodejs-project/active-model.test.js
// Exit: 0 = all pass, 1 = at least one failure.
//
// WHY THIS FILE EXISTS
// --------------------
// resolveActiveModel() is the single source of truth for "what model is
// the agent actually using right now." It's called per chat() turn by
// ai.js AND by /status, /version, and the session_status tool — if these
// surfaces disagree, the agent introspects a different model than the
// one servicing its API requests (the split-brain device-test caught
// 2026-04-24: API went to gpt-5.4, the agent replied "gpt-5.5").
//
// The function is 15 lines of pure logic + two fs reads. We can't
// require('config.js') directly (it reads a real config.json and exits
// on missing, same constraint env-merge.test.js works around), so we
// mirror the logic verbatim and add a structural grep at the end to
// catch drift between the mirror and the live source.
//
// Invariants:
//   - overlay model wins when non-blank
//   - missing file, unparseable JSON, missing field, blank string, non-
//     string, untrimmed-only-whitespace → fallback to startup MODEL
//   - whitespace around overlay model is trimmed, not rejected

'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const CONFIG_JS = path.join(__dirname, '..', '..', 'app', 'src', 'main',
    'assets', 'nodejs-project', 'config.js');

// --- extracted pure function (must mirror config.js resolveActiveModel) ---
// `activeProvider` param mirrors the startup PROVIDER const. Overlay model
// is only honored when overlay.provider is absent OR matches activeProvider.
function resolveActiveModel(workDir, fallbackModel, activeProvider = 'claude') {
    try {
        const settingsPath = path.join(workDir, 'agent_settings.json');
        if (fs.existsSync(settingsPath)) {
            const s = JSON.parse(fs.readFileSync(settingsPath, 'utf8'));
            const overlayProvider = typeof s.provider === 'string' ? s.provider.trim() : '';
            if (overlayProvider && overlayProvider !== activeProvider) {
                return fallbackModel;
            }
            const m = typeof s.model === 'string' ? s.model.trim() : '';
            if (m) return m;
        }
    } catch (_) {}
    return fallbackModel;
}

// Each test gets a fresh tempdir so writes don't leak between cases.
function makeTempDir() {
    return fs.mkdtempSync(path.join(os.tmpdir(), 'active-model-test-'));
}
function writeSettings(dir, obj) {
    fs.writeFileSync(path.join(dir, 'agent_settings.json'),
        typeof obj === 'string' ? obj : JSON.stringify(obj), 'utf8');
}
function cleanup(dir) {
    try { fs.rmSync(dir, { recursive: true, force: true }); } catch (_) {}
}

// --- tests ---
const tests = [];
function t(name, fn) { tests.push([name, fn]); }

t('no agent_settings.json → falls back to startup MODEL', () => {
    const dir = makeTempDir();
    try {
        assert.strictEqual(resolveActiveModel(dir, 'gpt-5.4'), 'gpt-5.4');
    } finally { cleanup(dir); }
});

t('overlay model wins when present and non-blank', () => {
    const dir = makeTempDir();
    try {
        writeSettings(dir, { model: 'claude-opus-4-7' });
        assert.strictEqual(resolveActiveModel(dir, 'gpt-5.4'), 'claude-opus-4-7');
    } finally { cleanup(dir); }
});

t('overlay model field missing → falls back', () => {
    const dir = makeTempDir();
    try {
        writeSettings(dir, { maxStepsPerTurn: 25 });
        assert.strictEqual(resolveActiveModel(dir, 'gpt-5.4'), 'gpt-5.4');
    } finally { cleanup(dir); }
});

t('overlay model is blank string → falls back', () => {
    // Defensive edge case: even if agent_settings.json somehow ends up
    // with `{ model: '' }` (tampering, partial write, older writer from
    // a pre-fix build), resolveActiveModel() treats the empty string as
    // "no overlay" and returns the startup MODEL. Current /provider
    // custom behavior OMITS the model field entirely when the default
    // is blank (not `model: ''`), so this test covers the safety net,
    // not a path /provider currently exercises.
    const dir = makeTempDir();
    try {
        writeSettings(dir, { model: '' });
        assert.strictEqual(resolveActiveModel(dir, 'gpt-5.4'), 'gpt-5.4');
    } finally { cleanup(dir); }
});

t('overlay model is whitespace-only → falls back (trimmed-then-blank)', () => {
    const dir = makeTempDir();
    try {
        writeSettings(dir, { model: '   \t  ' });
        assert.strictEqual(resolveActiveModel(dir, 'gpt-5.4'), 'gpt-5.4');
    } finally { cleanup(dir); }
});

t('overlay model with surrounding whitespace → trimmed', () => {
    const dir = makeTempDir();
    try {
        writeSettings(dir, { model: '  gpt-5.5  ' });
        assert.strictEqual(resolveActiveModel(dir, 'gpt-5.4'), 'gpt-5.5');
    } finally { cleanup(dir); }
});

t('overlay model non-string (number) → falls back', () => {
    const dir = makeTempDir();
    try {
        writeSettings(dir, { model: 42 });
        assert.strictEqual(resolveActiveModel(dir, 'gpt-5.4'), 'gpt-5.4');
    } finally { cleanup(dir); }
});

t('overlay model non-string (null) → falls back', () => {
    const dir = makeTempDir();
    try {
        writeSettings(dir, { model: null });
        assert.strictEqual(resolveActiveModel(dir, 'gpt-5.4'), 'gpt-5.4');
    } finally { cleanup(dir); }
});

t('unparseable agent_settings.json → falls back (error swallowed)', () => {
    const dir = makeTempDir();
    try {
        writeSettings(dir, 'not json {{{ broken');
        assert.strictEqual(resolveActiveModel(dir, 'gpt-5.4'), 'gpt-5.4');
    } finally { cleanup(dir); }
});

t('JSON array (not object) → falls back', () => {
    // Defensive: accessing .model on an array returns undefined →
    // typeof !== 'string' branch → blank → fallback. No crash.
    const dir = makeTempDir();
    try {
        writeSettings(dir, [1, 2, 3]);
        assert.strictEqual(resolveActiveModel(dir, 'gpt-5.4'), 'gpt-5.4');
    } finally { cleanup(dir); }
});

// Provider-scoping: during the /provider restart window, overlay
// can carry the NEW provider + NEW model but the running adapter
// is still the OLD provider. Applying the new model would crash
// the in-flight API call.

t('overlay provider matches startup → model applied', () => {
    const dir = makeTempDir();
    try {
        writeSettings(dir, { provider: 'openai', model: 'gpt-5.5' });
        assert.strictEqual(resolveActiveModel(dir, 'gpt-5.4', 'openai'), 'gpt-5.5');
    } finally { cleanup(dir); }
});

t('overlay provider mismatches startup → model IGNORED', () => {
    // The key race-condition test: /provider openai write has happened,
    // restart not yet complete, activeProvider still claude. We must NOT
    // return gpt-5.4 — the Claude adapter can't call Anthropic with it.
    const dir = makeTempDir();
    try {
        writeSettings(dir, { provider: 'openai', model: 'gpt-5.4' });
        assert.strictEqual(
            resolveActiveModel(dir, 'claude-opus-4-7', 'claude'),
            'claude-opus-4-7'
        );
    } finally { cleanup(dir); }
});

t('overlay omits provider → model applied (plain /model switch)', () => {
    // /model <id> writes just { model }, no provider — always honored.
    const dir = makeTempDir();
    try {
        writeSettings(dir, { model: 'claude-sonnet-4-6' });
        assert.strictEqual(
            resolveActiveModel(dir, 'claude-opus-4-7', 'claude'),
            'claude-sonnet-4-6'
        );
    } finally { cleanup(dir); }
});

t('overlay provider blank → model applied (treated as absent)', () => {
    const dir = makeTempDir();
    try {
        writeSettings(dir, { provider: '   ', model: 'claude-sonnet-4-6' });
        assert.strictEqual(
            resolveActiveModel(dir, 'claude-opus-4-7', 'claude'),
            'claude-sonnet-4-6'
        );
    } finally { cleanup(dir); }
});

t('config.js resolveActiveModel wiring still present (structural)', () => {
    const src = fs.readFileSync(CONFIG_JS, 'utf8');
    const code = src
        .replace(/\/\*[\s\S]*?\*\//g, '')
        .replace(/(^|[^:])\/\/[^\n]*/g, '$1');

    assert.ok(/function\s+resolveActiveModel\s*\(/.test(code),
        'config.js is missing `function resolveActiveModel(` declaration');
    assert.ok(/path\.join\s*\(\s*workDir\s*,\s*['"]agent_settings\.json['"]\s*\)/.test(code),
        'config.js resolveActiveModel must read from path.join(workDir, "agent_settings.json")');
    assert.ok(/typeof\s+[A-Za-z_$][\w$]*\.model\s*===?\s*['"]string['"]/.test(code),
        'config.js resolveActiveModel must type-check .model as string');
    // Provider-scoping guard must be present — the race-condition fix
    // that prevents applying a new provider's model before the adapter
    // restart completes.
    assert.ok(/typeof\s+[A-Za-z_$][\w$]*\.provider\s*===?\s*['"]string['"]/.test(code),
        'config.js resolveActiveModel must type-check .provider as string (provider-scoping)');
    assert.ok(/!==\s*PROVIDER/.test(code),
        'config.js resolveActiveModel must compare overlay provider to startup PROVIDER');
    assert.ok(/return\s+MODEL\s*;?/.test(code),
        'config.js resolveActiveModel must fall back to `return MODEL`');
    assert.ok(/module\.exports\s*=\s*\{[\s\S]*\bresolveActiveModel\b[\s\S]*\}/.test(code),
        'config.js is missing resolveActiveModel in module.exports');
});

// --- runner ---
let passed = 0, failed = 0;
for (const [name, fn] of tests) {
    try { fn(); console.log(`  ok  ${name}`); passed++; }
    catch (e) { console.error(`  FAIL ${name}\n    ${e.message}`); failed++; }
}
console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed === 0 ? 0 : 1);
