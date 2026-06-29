#!/usr/bin/env node
// truncate-tool-result.test.js — characterization tests for truncateToolResult
// in config.js (the formatter applied to EVERY tool result before it enters the
// conversation — sole consumer: ai.js `truncateToolResult(JSON.stringify(result))`).
//
// Phase 0, item (e) of GitHub issue #345 (tool-result-formatting half). BAT-1077.
//
// Run:  node tests/nodejs-project/truncate-tool-result.test.js
// Exit: 0 = all pass, 1 = at least one failure.
//
// We can't require('config.js') directly (it reads a real config.json and
// process.exit(1)s on load). So we extract the LIVE truncateToolResult function
// (plus its four constants) from the config.js source and execute it in an
// isolated `vm` sandbox. This means the behavioral assertions below run against
// the REAL implementation — a semantic change in config.js (e.g. a different cap,
// cutoff rule, or marker) is caught here, not silently mirrored. The function is
// pure (only Math/String, no requires), so vm execution is safe and side-effect
// free. If config.js refactors the function away/renames it (e.g. the eventual
// #345 move into an agent/* module), extraction fails loudly and this test must be
// repointed — exactly the conscious review a characterization test should force.
//
// This is a CHARACTERIZATION test: it documents CURRENT behavior so the eventual
// #345 ai.js decomposition can move/refactor this code safely. It must NOT change
// truncateToolResult's behavior, and it touches no production code.

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

// Build-time constant path (not request-derived); mirrors env-merge.test.js.
const CONFIG_JS = path.join(__dirname, '..', '..', 'app', 'src', 'main',
    'assets', 'nodejs-project', 'config.js');

const CONST_NAMES = [
    'HARD_MAX_TOOL_RESULT_CHARS',
    'MAX_TOOL_RESULT_CONTEXT_SHARE',
    'MIN_KEEP_CHARS',
    'MODEL_CONTEXT_CHARS',
];

// Extract `const NAME = …;` declarations + the truncateToolResult function body
// from config.js source and run them in a fresh vm context, returning the LIVE
// function. Brace-matching from `function truncateToolResult` handles the one
// template literal in the body (`${droppedChars}` is brace-balanced).
function loadRealTruncate(src) {
    const constLines = CONST_NAMES.map((name) => {
        const m = src.match(new RegExp('const\\s+' + name + '\\s*=\\s*[^;]+;'));
        assert.ok(m, `config.js: const ${name} declaration not found`);
        return m[0];
    });

    const fnIdx = src.indexOf('function truncateToolResult');
    assert.ok(fnIdx !== -1, 'config.js: function truncateToolResult not found');
    let i = src.indexOf('{', fnIdx);
    assert.ok(i !== -1, 'config.js: truncateToolResult opening brace not found');
    let depth = 0, end = -1;
    for (; i < src.length; i++) {
        if (src[i] === '{') depth++;
        else if (src[i] === '}') { depth--; if (depth === 0) { end = i + 1; break; } }
    }
    assert.ok(end !== -1, 'config.js: could not brace-match truncateToolResult body');
    const fnSrc = src.slice(fnIdx, end);

    const snippet = constLines.join('\n') + '\n' + fnSrc +
        '\nmodule.exports = { truncateToolResult };';
    const sandbox = { module: { exports: {} } };
    vm.createContext(sandbox);
    vm.runInContext(snippet, sandbox, { filename: 'config.js#truncateToolResult' });
    const fn = sandbox.module.exports.truncateToolResult;
    assert.strictEqual(typeof fn, 'function', 'extracted truncateToolResult is not a function');
    return fn;
}

const CONFIG_SRC = fs.readFileSync(CONFIG_JS, 'utf8');
const truncateToolResult = loadRealTruncate(CONFIG_SRC); // the LIVE function under test

// Effective cap the live function should resolve to from its constants:
// min(50000, max(2000, floor(200000 * 0.3 = 60000))) = 50000. The behavioral
// boundary cases below fail if config.js changes any constant such that this moves.
const CAP = 50000;

// Independent golden copy of the marker (NOT shared with config.js) so a change to
// the live marker text is caught by the behavioral assertions below.
function goldenMarker(droppedChars) {
    return `\n\n⚠️ [Content truncated — ${droppedChars} characters removed. Use offset/limit parameters for more.]`;
}

// Assert a truncated result reconstructs exactly as slice(0, cutoff) + marker(dropped),
// and pin the load-bearing invariants. Returns the actual output for extra checks.
function expectTruncated(original, expectedCutoff) {
    const dropped = original.length - expectedCutoff;
    const expected = original.slice(0, expectedCutoff) + goldenMarker(dropped);
    const got = truncateToolResult(original);
    assert.strictEqual(got, expected, 'output must equal slice(0,cutoff) + exact marker');
    // pre-marker slice is exactly the first `cutoff` chars of the original
    assert.strictEqual(got.slice(0, expectedCutoff), original.slice(0, expectedCutoff),
        'kept text must be the original prefix up to cutoff');
    // accounting: cutoff + dropped === original length; dropped excludes the marker
    assert.strictEqual(expectedCutoff + dropped, original.length, 'cutoff + dropped must equal original length');
    // result length === cutoff + marker length (marker is NOT counted against the cap)
    assert.strictEqual(got.length, expectedCutoff + goldenMarker(dropped).length,
        'result length must be cutoff + marker length');
    assert.ok(got.endsWith('more.]'), 'truncated output must end with the marker');
    return got;
}

// --- tests ---
const tests = [];
function t(name, fn) { tests.push([name, fn]); }

// (1) Non-string passthrough — returned unchanged (identity for objects).
t('non-string inputs return unchanged (number/null/undefined/object/array/boolean)', () => {
    assert.strictEqual(truncateToolResult(42), 42);
    assert.strictEqual(truncateToolResult(null), null);
    assert.strictEqual(truncateToolResult(undefined), undefined);
    assert.strictEqual(truncateToolResult(true), true);
    const obj = { a: 1 };
    assert.strictEqual(truncateToolResult(obj), obj);   // same reference
    const arr = [1, 2, 3];
    assert.strictEqual(truncateToolResult(arr), arr);   // same reference
    assert.ok(Number.isNaN(truncateToolResult(NaN)));   // typeof NaN === 'number'
});

// (2) Empty string is unchanged.
t('empty string returns unchanged', () => {
    assert.strictEqual(truncateToolResult(''), '');
});

// (3) Exactly CAP chars returns unchanged (boundary, <=).
t('string of exactly 50000 chars returns unchanged', () => {
    const s = 'x'.repeat(CAP);
    const got = truncateToolResult(s);
    assert.strictEqual(got, s);
    assert.strictEqual(got.length, CAP);
});

// (4) Just under the cap returns unchanged.
t('string of 49999 chars returns unchanged', () => {
    const s = 'x'.repeat(CAP - 1);
    assert.strictEqual(truncateToolResult(s), s);
});

// (5) Over cap, no newline -> hard cut at 50000, dropped = 1.
t('50001 chars with no newline truncates at 50000, drops 1', () => {
    const s = 'x'.repeat(CAP + 1);
    const got = expectTruncated(s, CAP);
    assert.strictEqual(got, 'x'.repeat(CAP) + goldenMarker(1));
});

// (6) Newline at an index >= 2000 and <= 50000 -> cut at that line boundary.
t('newline at index 49000 selects that line boundary (cutoff = 49000)', () => {
    const s = 'a'.repeat(49000) + '\n' + 'b'.repeat(1000); // len 50001, '\n' at index 49000
    expectTruncated(s, 49000);
});

// (7) Only newline below MIN_KEEP_CHARS -> ignored, hard cut at 50000.
t('only newline at index 500 (< 2000) is ignored, hard cut at 50000', () => {
    const s = 'a'.repeat(500) + '\n' + 'b'.repeat(60000); // len 60501, '\n' at index 500
    expectTruncated(s, CAP);
});

// (8) Exact marker bytes (⚠️ emoji, em-dash, leading "\n\n", trailing "more.]").
t('marker format is byte-exact', () => {
    const s = 'x'.repeat(CAP + 1);
    const got = truncateToolResult(s);
    assert.strictEqual(
        got,
        'x'.repeat(CAP) + '\n\n⚠️ [Content truncated — 1 characters removed. Use offset/limit parameters for more.]'
    );
});

// (9) Accounting invariant covered by expectTruncated (cutoff + dropped === len;
// dropped excludes marker). Assert a representative non-hard-cut case explicitly.
t('accounting: dropped excludes the marker length', () => {
    const s = 'a'.repeat(49000) + '\n' + 'c'.repeat(5000); // len 54001, '\n' at 49000
    const dropped = s.length - 49000; // 5001 (the '\n' at 49000 + 5000 'c' = 5001 chars dropped)
    const got = truncateToolResult(s);
    assert.strictEqual(got, 'a'.repeat(49000) + goldenMarker(dropped));
    assert.strictEqual(got.slice(0, 49000).length, 49000);
});

// (10) Non-truncated output never ends with the marker.
t('non-truncated output does not contain the marker', () => {
    const s = 'hello\nworld';
    const got = truncateToolResult(s);
    assert.strictEqual(got, s);
    assert.ok(!got.includes('Content truncated'));
});

// (11) Newline exactly at index 50000 (== cap) is found (inclusive 2nd arg).
t('newline exactly at index 50000 is selected (cutoff = 50000)', () => {
    const s = 'a'.repeat(CAP) + '\n' + 'b'.repeat(1000); // '\n' at index 50000, len 51001
    expectTruncated(s, CAP);
});

// (12) Multiple newlines <= cap -> the LAST one wins.
t('multiple newlines below cap -> latest is selected (cutoff = 49000, not 3000)', () => {
    const s = 'a'.repeat(3000) + '\n' + 'b'.repeat(45999) + '\n' + 'c'.repeat(2000);
    // indices: '\n' at 3000 and at 49000; len = 3000+1+45999+1+2000 = 51001
    expectTruncated(s, 49000);
});

// (13) Newline only BEYOND the cap -> lastIndexOf returns -1 -> hard cut at 50000.
t('newline only beyond cap (index 51000) -> hard cut at 50000', () => {
    const s = 'a'.repeat(51000) + '\n' + 'b'.repeat(1000); // '\n' at 51000, len 52001
    expectTruncated(s, CAP);
});

// (14a) MIN_KEEP_CHARS boundary: newline at index exactly 2000 IS accepted (strict `<`).
t('newline at index exactly 2000 is accepted (cutoff = 2000)', () => {
    const s = 'a'.repeat(2000) + '\n' + 'b'.repeat(60000); // '\n' at index 2000, len 62001
    expectTruncated(s, 2000);
});

// (14b) MIN_KEEP_CHARS boundary: newline at index 1999 falls back to 50000.
t('newline at index 1999 falls back to hard cut at 50000', () => {
    const s = 'a'.repeat(1999) + '\n' + 'b'.repeat(60000); // '\n' at index 1999, len 62000
    expectTruncated(s, CAP);
});

// (15) CRLF: cut lands on the '\n'; the preceding '\r' is NOT stripped.
t('CRLF: stray \\r is retained before the marker', () => {
    const s = 'a'.repeat(48999) + '\r\n' + 'b'.repeat(2000);
    // indices: '\r' at 48999, '\n' at 49000; len = 48999+2+2000 = 51001
    const got = expectTruncated(s, 49000);
    assert.strictEqual(got.charCodeAt(48999), 0x0D, 'kept text must retain the \\r at index 48999');
    assert.ok(got.slice(0, 49000).endsWith('\r'), 'kept text ends with a stray \\r');
});

// (16) Returned length exceeds the cap when hard-cut (marker is not counted).
t('hard-cut output length exceeds 50000 (marker not counted against cap)', () => {
    const s = 'x'.repeat(CAP + 1);
    const got = truncateToolResult(s);
    assert.strictEqual(got.length, CAP + goldenMarker(1).length);
    assert.ok(got.length > CAP, 'returned string is longer than the cap');
});

// (17) UTF-16 code units: the cut can split a surrogate pair (current behavior).
t('UTF-16: hard cut can split a surrogate pair (lone high surrogate kept)', () => {
    // 'x' shifts the emoji pairs to odd start indices, so index 49999 (kept) is a
    // high surrogate whose low surrogate at 50000 is dropped -> a split pair.
    const s = 'x' + '\u{1F600}'.repeat(25001); // len = 1 + 25001*2 = 50003
    assert.strictEqual(s.length, 50003);
    const got = expectTruncated(s, CAP);
    const kept = got.slice(0, CAP);
    const lastUnit = kept.charCodeAt(CAP - 1);
    assert.ok(lastUnit >= 0xD800 && lastUnit <= 0xDBFF,
        'kept text ends with a lone high surrogate (pair was split)');
});

// (18) Export guard — the vm harness runs the function body regardless of whether
// config.js exports it, so separately confirm the live module still exports it
// (ai.js imports `truncateToolResult` from config.js; un-exporting would break it).
t('config.js exports truncateToolResult from module.exports', () => {
    const code = CONFIG_SRC
        .replace(/\/\*[\s\S]*?\*\//g, '')        // block comments
        .replace(/(^|[^:])\/\/[^\n]*/g, '$1');   // line comments (avoid URLs)
    assert.ok(/module\.exports\s*=\s*\{[\s\S]*\btruncateToolResult\b/.test(code),
        'truncateToolResult is no longer exported from config.js module.exports');
});

// --- runner ---
let passed = 0, failed = 0;
for (const [name, fn] of tests) {
    try { fn(); console.log(`  ok  ${name}`); passed++; }
    catch (e) { console.error(`  FAIL ${name}\n    ${e.message}`); failed++; }
}
console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed === 0 ? 0 : 1);
