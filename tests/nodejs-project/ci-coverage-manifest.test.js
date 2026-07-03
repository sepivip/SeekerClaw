#!/usr/bin/env node
// ci-coverage-manifest.test.js — meta-test that ensures every *.test.js
// file under tests/nodejs-project/ is either:
//   (a) in the CI for-loop allowlist in .github/workflows/build.yml, OR
//   (b) explicitly listed in this file's SKIP_REASONS map with a reason.
//
// Run:  node tests/nodejs-project/ci-coverage-manifest.test.js
// Exit: 0 = all pass, 1 = at least one failure.
//
// WHY THIS FILE EXISTS
// --------------------
// Before BAT-1013, tests were added to tests/nodejs-project/ but the CI
// for-loop in build.yml was hand-maintained — easy to forget. The result:
// tests existed in the repo, passed locally, and never ran in CI. The
// burner-policy, tools-solana-routing, tx-parser, and public-rpc-shaper
// tests all sat untested in CI until this audit caught them.
//
// This meta-test enforces the rule forever: any new *.test.js file MUST
// be classified (allowlisted or explicitly skipped with a reason) or CI
// fails. No new test silently bypasses CI coverage.
//
// Mirrors the smoke.js SKIP_REASONS pattern: explicit, documented, and
// drift-detected.
//
// HOW IT WORKS
// ------------
//   1. Read .github/workflows/build.yml.
//   2. Parse the for-loop allowlist (between `for t in \` and `do`).
//   3. Read all *.test.js files in tests/nodejs-project/.
//   4. For each file, assert it is in the allowlist OR in SKIP_REASONS.
//   5. Fail with a clear message naming the unclassified files.

'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');

const REPO_ROOT = path.resolve(__dirname, '..', '..');
const BUILD_YML = path.join(REPO_ROOT, '.github', 'workflows', 'build.yml');
const TESTS_DIR = __dirname;

// Tests that are intentionally NOT in the financial-flow CI for-loop.
// Each entry must have a reason — "I forgot" is not a reason.
//
// Categories of acceptable skip:
//   - "invoked separately" — has its own CI step (tool-schemas.test.js
//     runs as the schema-validation step; smoke.js runs as its own step)
//   - "fixture-only" — requires real device state or a fixture we don't
//     have in CI yet
//   - "self-check" — meta-test that wraps the manifest itself
//
// New file added under tests/nodejs-project/? Choose one:
//   (a) add it to the for-loop allowlist in .github/workflows/build.yml
//   (b) add it here with a reason
// CI will fail until you do.
const SKIP_REASONS = {
    'tool-schemas.test.js': 'invoked separately as the Validate tool input_schemas CI step',
    // Note: ci-coverage-manifest.test.js itself is in the build.yml for-loop
    // allowlist (it runs against itself), so it does NOT appear here.
    // Tests that require a real device, fixture, or live network. These
    // run locally via scripts/pre-push-check.sh + on-device testing but
    // are excluded from CI to keep runs deterministic.
    'active-model.test.js': 'fixture-only — depends on runtime config state',
    'agent-preferences.test.js': 'fixture-only — needs workDir scaffold',
    'claude-reasoning-roundtrip.test.js': 'fixture-only — live Anthropic API roundtrip',
    'cross-process-store.test.js': 'fixture-only — needs tempdir workDir scaffold',
    'custom-config-signature.test.js': 'fixture-only — depends on signed-config harness',
    'custom-reasoning-roundtrip.test.js': 'fixture-only — live custom-provider API roundtrip',
    'db-dirty-debounce.test.js': 'fixture-only — needs SQL.js WASM + workDir',
    'dca-bigint-dos.test.js': 'fixture-only — long-running DoS regression sweep',
    'dca-bigint-precision.test.js': 'fixture-only — long-running precision sweep',
    'env-list.test.js': 'fixture-only — needs env scaffold',
    'env-merge.test.js': 'fixture-only — needs env scaffold',
    'idle-summary-timers.test.js': 'fixture-only — timer-based, flaky in CI',
    'interim-delivery.test.js': 'fixture-only — message-handler.js depends on main.js globals + config require-cache stubs (run via node locally / pre-push)',
    'jupiter-trigger-v2.test.js': 'fixture-only — live Jupiter Trigger V2 API roundtrip',
    'main-wallet-balance.test.js': 'fixture-only — live MWA + RPC roundtrip',
    'mcp-servers.test.js': 'fixture-only — needs workDir scaffold',
    'model-catalog.test.js': 'fixture-only — depends on runtime model state',
    'openai-reasoning-roundtrip.test.js': 'fixture-only — live OpenAI API roundtrip',
    'openrouter-reasoning-roundtrip.test.js': 'fixture-only — live OpenRouter API roundtrip',
    'reasoning-gating.test.js': 'fixture-only — depends on runtime provider state',
    'reasoning-pipeline.test.js': 'fixture-only — depends on runtime conversation state',
    'reasoning-r5-regressions.test.js': 'fixture-only — depends on captured fixture state',
    'reasoning-recovery.test.js': 'fixture-only — needs workDir scaffold',
    'reasoning-redact.test.js': 'fixture-only — depends on captured payload fixtures',
    'reasoning-request-enablement.test.js': 'fixture-only — depends on runtime provider state',
    'retry-log-provider-label.test.js': 'fixture-only — depends on runtime log state',
    'runtime-state-reasoning.test.js': 'fixture-only — needs workDir scaffold',
    'shutdown-flush.test.js': 'fixture-only — needs workDir + timer scaffold',
    'silent-reply.test.js': 'fixture-only — depends on telegram runtime state',
    'solana-rpc-url.test.js': 'fixture-only — depends on runtime config state',
    'telegram-commands.test.js': 'fixture-only — message-handler.js depends on main.js globals',
    'think-command.test.js': 'fixture-only — depends on conversation runtime state',
    'thinking-status.test.js': 'fixture-only — depends on telegram runtime state',
};

// ─────────────────────────────────────────────────────────────────
// Step 1: Parse the for-loop allowlist out of .github/workflows/build.yml.
// ─────────────────────────────────────────────────────────────────
function parseCiAllowlist() {
    assert.ok(fs.existsSync(BUILD_YML),
        `build.yml not found at ${BUILD_YML} — repo layout changed?`);
    const yml = fs.readFileSync(BUILD_YML, 'utf8');

    // Find the for-loop block:
    //   for t in \
    //     name1 \
    //     name2 \
    //     ...
    //   do
    const forIdx = yml.indexOf('for t in \\');
    assert.ok(forIdx !== -1,
        'build.yml has no `for t in \\` block — CI allowlist parser needs updating');
    // R11: anchor on the `do` keyword at line-start (with optional leading
    // whitespace), not a bare substring — a literal "do" inside a test-file
    // name like "do_something.test.js" would match first and truncate the
    // block. Search slice + add forIdx to convert relative back to absolute.
    const tail = yml.slice(forIdx);
    const doMatch = /(^|\n)\s*do(\s|$)/.exec(tail);
    assert.ok(doMatch,
        'build.yml `for t in \\` block has no matching `do` keyword on its own line — CI allowlist parser needs updating');
    const doIdx = forIdx + doMatch.index + doMatch[1].length;

    const block = yml.slice(forIdx, doIdx);
    const lines = block.split('\n').slice(1); // skip `for t in \` line
    const names = [];
    for (const raw of lines) {
        const line = raw.trim().replace(/\\\s*$/, '').trim();
        if (!line) continue;
        // Tolerate the `do` keyword if it appears inline somehow.
        if (line === 'do') break;
        names.push(line);
    }
    assert.ok(names.length > 0,
        'CI allowlist parser found 0 entries — build.yml format changed?');
    return names;
}

// ─────────────────────────────────────────────────────────────────
// Step 2: Discover all *.test.js files actually present in the directory.
// ─────────────────────────────────────────────────────────────────
function discoverTestFiles() {
    // BAT-1060: recurse subdirectories so a nested *.test.js can't silently
    // bypass the manifest + CI allowlist. Returns paths relative to TESTS_DIR
    // (flat names for the current top-level layout — forward-compatible).
    const files = [];
    function recurse(dir) {
        for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
            const full = path.join(dir, entry.name);
            if (entry.isDirectory()) recurse(full);
            else if (entry.name.endsWith('.test.js')) files.push(path.relative(TESTS_DIR, full).split(path.sep).join('/'));
        }
    }
    recurse(TESTS_DIR);
    return files.sort();
}

// ─────────────────────────────────────────────────────────────────
// Step 3: Run the tests.
// ─────────────────────────────────────────────────────────────────
const tests = [];
function t(name, fn) { tests.push([name, fn]); }

t('build.yml CI for-loop allowlist parses', () => {
    const allowlist = parseCiAllowlist();
    assert.ok(Array.isArray(allowlist) && allowlist.length > 0,
        'expected non-empty allowlist');
    // Note: allowlist→file existence is NOT asserted here. If build.yml
    // names a missing file, the CI for-loop itself fails immediately at
    // run time with `node: file not found`, which is a louder and earlier
    // signal than a manifest test could provide. Asserting here would
    // also race with peer agents adding new test files in the same PR.
});

t('every *.test.js file is in the CI allowlist OR explicitly skipped', () => {
    const allowlist = new Set(parseCiAllowlist().map((n) => n + '.test.js'));
    const present = discoverTestFiles();
    const unclassified = [];
    for (const f of present) {
        if (allowlist.has(f)) continue;
        if (Object.prototype.hasOwnProperty.call(SKIP_REASONS, f)) continue;
        unclassified.push(f);
    }
    if (unclassified.length > 0) {
        const msg = [
            '',
            'CI coverage manifest drift detected — the following test file(s)',
            'are neither in the build.yml for-loop allowlist nor in this file\'s',
            'SKIP_REASONS map:',
            '',
            ...unclassified.map((f) => '  - ' + f),
            '',
            'To fix, choose ONE per file:',
            '  (a) add it to the for-loop in .github/workflows/build.yml, OR',
            '  (b) add it to SKIP_REASONS in this file with a reason.',
            '',
        ].join('\n');
        assert.fail(msg);
    }
});

t('SKIP_REASONS only references files that exist', () => {
    const present = new Set(discoverTestFiles());
    const stale = [];
    for (const name of Object.keys(SKIP_REASONS)) {
        if (!present.has(name)) stale.push(name);
    }
    if (stale.length > 0) {
        const msg = [
            '',
            'SKIP_REASONS references stale file(s) that no longer exist:',
            '',
            ...stale.map((f) => '  - ' + f),
            '',
            'Remove the stale entries from SKIP_REASONS.',
            '',
        ].join('\n');
        assert.fail(msg);
    }
});

t('SKIP_REASONS entries have non-blank reasons', () => {
    for (const [name, reason] of Object.entries(SKIP_REASONS)) {
        assert.ok(typeof reason === 'string' && reason.trim().length > 0,
            `SKIP_REASONS["${name}"] must have a non-blank reason`);
    }
});

t('no file appears in BOTH the allowlist and SKIP_REASONS', () => {
    const allowlist = new Set(parseCiAllowlist().map((n) => n + '.test.js'));
    const overlap = [];
    for (const name of Object.keys(SKIP_REASONS)) {
        if (allowlist.has(name)) overlap.push(name);
    }
    if (overlap.length > 0) {
        const msg = [
            '',
            'The following file(s) appear in BOTH the CI allowlist and SKIP_REASONS:',
            '',
            ...overlap.map((f) => '  - ' + f),
            '',
            'Pick one — a file is either run in CI or explicitly skipped.',
            '',
        ].join('\n');
        assert.fail(msg);
    }
});

// ─────────────────────────────────────────────────────────────────
// Runner.
// ─────────────────────────────────────────────────────────────────
const GREEN = '\x1b[32m';
const RED = '\x1b[31m';
const RESET = '\x1b[0m';

let passed = 0;
let failed = 0;
for (const [name, fn] of tests) {
    try {
        fn();
        console.log(`${GREEN}✓${RESET} ${name}`);
        passed++;
    } catch (err) {
        console.log(`${RED}✗${RESET} ${name}`);
        console.log((err.stack || err.message || String(err))
            .split('\n')
            .map((l) => '    ' + l)
            .join('\n'));
        failed++;
    }
}

console.log('');
if (failed === 0) {
    console.log(`${GREEN}✓${RESET} ${passed}/${tests.length} ci-coverage-manifest checks passed`);
    process.exit(0);
} else {
    console.log(`${RED}✗${RESET} ${failed}/${tests.length} ci-coverage-manifest checks failed`);
    process.exit(1);
}
