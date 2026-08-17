#!/usr/bin/env node
/**
 * log-safe.test.js — BAT-1247 regression guard.
 *
 * THE INVARIANT: text that reaches `log()` from an untrusted source must be a
 * single physical line.
 *
 * Why it is security-relevant, in one paragraph: config.js `log()` splits on
 * '\n' and emits one wire record per physical line; SeekerClawService forwards
 * each record as its own LogEntry; LogsScreen renders each with a full
 * "[LEVEL] [time] [Node] " header. LogShareSanitizer (the Share-sheet scrub) is
 * line-based — it blanks the segment after a `Message: ` marker, then keeps
 * blanking following lines only until it sees a real entry header. So a
 * multiline chat body split across N records has lines 2..N arrive wearing
 * genuine headers, the sanitizer stops, and the remainder of the user's message
 * ships off-device verbatim. That was a live leak: a pasted "[database]" block
 * plus the credential line under it went out in one tap.
 *
 * These tests pin the flattening that closes it. If flattenForLog ever lets a
 * '\n' or '\r' through, the leak is back.
 *
 * Run: node tests/nodejs-project/log-safe.test.js
 */

'use strict';

const assert = require('assert');
const path = require('path');

const BUNDLE = path.join(__dirname, '..', '..', 'app', 'src', 'main', 'assets', 'nodejs-project');
const { flattenForLog, NEWLINE_GLYPH } = require(path.join(BUNDLE, 'log-safe'));

let passed = 0;
function test(name, fn) {
    try {
        fn();
        passed++;
        console.log(`  ✓ ${name}`);
    } catch (e) {
        console.error(`  ✗ ${name}`);
        console.error(`    ${e.message}`);
        process.exitCode = 1;
    }
}

console.log('\nlog-safe.js — untrusted text must never break a log line\n');

// ── The core invariant ──────────────────────────────────────────────────────

test('NEVER emits a newline, for any line-break flavour', () => {
    const inputs = [
        'a\nb',
        'a\r\nb',
        'a\rb',
        'a\n\n\nb',
        '\nleading',
        'trailing\n',
        '\r\n\r\n',
        'mixed\r\na\nb\rc',
    ];
    for (const s of inputs) {
        const out = flattenForLog(s, 100);
        assert.ok(!out.includes('\n'), `newline survived for ${JSON.stringify(s)}: ${JSON.stringify(out)}`);
        assert.ok(!out.includes('\r'), `carriage return survived for ${JSON.stringify(s)}: ${JSON.stringify(out)}`);
    }
});

test('the exact production leak case is neutralised', () => {
    // The body that shipped a credential off-device before this fix.
    const body = 'here is my config\n[database]\nhost=admin:hunter2@internal.db';
    const out = flattenForLog(body, 100);
    assert.ok(!out.includes('\n'), 'must be one physical line');
    // Content is preserved — it is the SANITIZER's job to blank it, and it can
    // only do that while the whole body sits behind the `Message: ` marker.
    assert.ok(out.includes('hunter2'), 'flattening must not silently drop content');
    assert.strictEqual(
        out,
        `here is my config${NEWLINE_GLYPH}[database]${NEWLINE_GLYPH}host=admin:hunter2@internal.db`,
    );
});

test('a run of line breaks collapses to ONE glyph', () => {
    assert.strictEqual(flattenForLog('a\n\n\n\nb', 100), `a${NEWLINE_GLYPH}b`);
    assert.strictEqual(flattenForLog('a\r\n\r\nb', 100), `a${NEWLINE_GLYPH}b`);
});

test('the glyph is not the wire delimiter', () => {
    // `LEVEL|epochMs|message` — a '|' here would still parse (the Kotlin parser
    // keeps later pipes in the message), but choosing it would be asking for
    // trouble the first time someone tightens that parser.
    assert.ok(!NEWLINE_GLYPH.includes('|'));
});

// ── Truncation ──────────────────────────────────────────────────────────────

test('truncates on the ORIGINAL text, not the flattened form', () => {
    // 10 chars of user input, then a newline and more. With maxChars=10 the cap
    // must bite at the user's 10th character — the glyph must not consume budget.
    const out = flattenForLog('0123456789\nsecret', 10);
    assert.strictEqual(out, '0123456789...');
    assert.ok(!out.includes('secret'), 'text beyond the cap must not appear');
});

test('appends an ellipsis only when the cap actually bites', () => {
    assert.strictEqual(flattenForLog('short', 100), 'short');
    assert.strictEqual(flattenForLog('exactly10!', 10), 'exactly10!');
    assert.strictEqual(flattenForLog('exactly10!x', 10), 'exactly10!...');
});

test('omitting maxChars flattens without truncating', () => {
    const long = 'x'.repeat(500) + '\ny';
    const out = flattenForLog(long);
    assert.ok(!out.includes('\n'));
    assert.ok(out.endsWith('y'), 'no truncation was requested');
    assert.ok(!out.includes('...'));
});

// ── Degenerate input (the caller supplies its own placeholder wording) ───────

test('empty and non-string inputs return empty string', () => {
    for (const v of ['', null, undefined, 0, 42, {}, [], true, NaN]) {
        assert.strictEqual(flattenForLog(v, 100), '', `unexpected output for ${JSON.stringify(v)}`);
    }
});

test('a body that is ONLY line breaks does not become a header-shaped line', () => {
    const out = flattenForLog('\n\n\n', 100);
    assert.ok(!out.includes('\n'));
    assert.strictEqual(out, NEWLINE_GLYPH);
});

// ── Call-site drift guard ───────────────────────────────────────────────────
// Behavioural tests above pin the helper; this pins that the leaky call site
// actually USES it. Both matter: a correct helper nobody calls fixes nothing.

test('message-handler builds the chat-body preview through flattenForLog', () => {
    // NB: an earlier version of this guard inspected the `deps.log(...)` line and
    // asserted it mentioned `bodyPreview`. That passed even with the leak fully
    // reintroduced, because the raw slice lives in the ASSIGNMENT above the log
    // call, not in the call. Verified by reverting the call site and watching the
    // guard stay green. Assert on where the value is BUILT.
    const fs = require('fs');
    const src = fs.readFileSync(path.join(BUNDLE, 'message-handler.js'), 'utf8');

    const logLine = src.split('\n').find((l) => l.includes('deps.log(`Message: '));
    assert.ok(logLine, 'the `Message: ` log site disappeared — re-point this guard');

    const assign = src.split('\n').find((l) => /const bodyPreview\s*=/.test(l));
    assert.ok(assign, 'the bodyPreview assignment disappeared — re-point this guard');
    assert.ok(
        /flattenForLog\s*\(/.test(assign),
        'the chat-body preview must be built with flattenForLog:\n    ' + assign.trim(),
    );

    // The pattern that WAS the leak. It existed only to build this preview, so a
    // file-wide check is both safe and the strongest form of the invariant.
    assert.ok(
        !/combinedText\s*\.slice\s*\(/.test(src),
        'raw combinedText.slice() is back — the multiline body leak is reopened',
    );
});

test('no log site interpolates a raw goal snippet any more', () => {
    const fs = require('fs');
    for (const f of ['message-handler.js', 'main.js', 'ai.js']) {
        const src = fs.readFileSync(path.join(BUNDLE, f), 'utf8');
        assert.ok(
            !/goal=\$\{|goal="\$\{|goal=\$\{.*slice/.test(src) && !/goalSnippet \? '"'/.test(src),
            `${f} still interpolates raw goal text into a log line`,
        );
    }
});

console.log(`\nPASS: log-safe.test.js (${passed} assertions)\n`);
