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
// process.exit(1)s on load). Following the env-merge.test.js / active-model.test.js
// convention, we (1) copy the truncation logic verbatim from the module into this
// file as a pure function and assert its behavior, and (2) read the live source and
// assert — with tolerant structural regexes over comment-stripped text — that the
// module's copy hasn't drifted. The EXACT marker bytes (⚠️, em-dash, leading "\n\n")
// are pinned as a behavioral assertion on output (an independent golden literal),
// not as a source substring (so harmless marker reflow doesn't false-fail).
//
// This is a CHARACTERIZATION test: it documents CURRENT behavior so the eventual
// #345 ai.js decomposition can move/refactor this code safely. It must NOT change
// truncateToolResult's behavior, and it touches no production code.

const assert = require('assert');
const fs = require('fs');
const path = require('path');

const CONFIG_JS = path.join(__dirname, '..', '..', 'app', 'src', 'main',
    'assets', 'nodejs-project', 'config.js');

// --- extracted pure function (verbatim mirror of config.js) ---
const HARD_MAX_TOOL_RESULT_CHARS = 50000;
const MAX_TOOL_RESULT_CONTEXT_SHARE = 0.3;
const MIN_KEEP_CHARS = 2000;
const MODEL_CONTEXT_CHARS = 200000;

function truncateToolResult(text) {
    if (typeof text !== 'string') return text;

    const maxChars = Math.min(
        HARD_MAX_TOOL_RESULT_CHARS,
        Math.max(MIN_KEEP_CHARS, Math.floor(MODEL_CONTEXT_CHARS * MAX_TOOL_RESULT_CONTEXT_SHARE))
    );

    if (text.length <= maxChars) return text;

    // Truncate at a line boundary
    let cutoff = text.lastIndexOf('\n', maxChars);
    if (cutoff < MIN_KEEP_CHARS) cutoff = maxChars;

    const truncated = text.slice(0, cutoff);
    const droppedChars = text.length - cutoff;
    return truncated + `\n\n⚠️ [Content truncated — ${droppedChars} characters removed. Use offset/limit parameters for more.]`;
}

// Effective cap derived from the four constants: min(50000, max(2000, floor(60000))) = 50000.
const CAP = 50000;

// Independent golden copy of the marker (NOT shared with the mirror above) so a
// drift in the mirror's marker literal is caught by the behavioral assertions.
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

// (18) Source drift-guard — structural regexes over comment-stripped source.
t('config.js truncation logic still matches the mirror (structural, comment-stripped)', () => {
    const src = fs.readFileSync(CONFIG_JS, 'utf8');
    const code = src
        .replace(/\/\*[\s\S]*?\*\//g, '')        // block comments
        .replace(/(^|[^:])\/\/[^\n]*/g, '$1');   // line comments (avoid URLs)

    assert.ok(/const\s+HARD_MAX_TOOL_RESULT_CHARS\s*=\s*50000\b/.test(code),
        'HARD_MAX_TOOL_RESULT_CHARS = 50000 missing/changed');
    assert.ok(/const\s+MAX_TOOL_RESULT_CONTEXT_SHARE\s*=\s*0\.3\b/.test(code),
        'MAX_TOOL_RESULT_CONTEXT_SHARE = 0.3 missing/changed');
    assert.ok(/const\s+MIN_KEEP_CHARS\s*=\s*2000\b/.test(code),
        'MIN_KEEP_CHARS = 2000 missing/changed');
    assert.ok(/const\s+MODEL_CONTEXT_CHARS\s*=\s*200000\b/.test(code),
        'MODEL_CONTEXT_CHARS = 200000 missing/changed');
    assert.ok(/function\s+truncateToolResult\s*\(/.test(code),
        'function truncateToolResult declaration missing');
    assert.ok(/module\.exports\s*=\s*\{[\s\S]*\btruncateToolResult\b/.test(code),
        'truncateToolResult not exported from module.exports');
    // line-boundary selection + MIN_KEEP_CHARS fallback
    assert.ok(/lastIndexOf\s*\(\s*['"]\\n['"]\s*,/.test(code),
        "lastIndexOf('\\n', ...) line-boundary call missing");
    assert.ok(/cutoff\s*<\s*MIN_KEEP_CHARS/.test(code),
        'cutoff < MIN_KEEP_CHARS fallback branch missing');
    // tolerant marker anchors (semantic, reflow-safe) — exact bytes pinned on output above
    assert.ok(/Content truncated/.test(code), 'marker "Content truncated" wording missing');
    assert.ok(/characters removed/.test(code), 'marker "characters removed" wording missing');
    assert.ok(/offset\/limit/.test(code), 'marker "offset/limit" recovery hint missing');
});

// --- runner ---
let passed = 0, failed = 0;
for (const [name, fn] of tests) {
    try { fn(); console.log(`  ok  ${name}`); passed++; }
    catch (e) { console.error(`  FAIL ${name}\n    ${e.message}`); failed++; }
}
console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed === 0 ? 0 : 1);
