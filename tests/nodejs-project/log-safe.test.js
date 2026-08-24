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

test('strips every character the JVM treats as a line terminator', () => {
    // The consumer is a Kotlin/JVM regex, so the property that matters is JAVA's
    // line model, not Node's. Verified on JBR 21 against the exact
    // LogShareSanitizer patterns, with the body "…config<SEP>host=admin:hunter2@…":
    //
    //   plain space    matches=true  find=true  splits=false -> scrubbed
    //   U+2028 LS      matches=false find=false splits=false -> BODY LEAKED
    //   U+2029 PS      matches=false find=false splits=false -> BODY LEAKED
    //   U+0085 NEL     matches=false find=false splits=false -> BODY LEAKED
    //
    // `.` does not match a Java line terminator and `$` anchors before one, so
    // `(.*)$` cannot reach end-of-input and `messageMarker.matches()` fails. Kotlin's
    // `lines()` splits only on \r\n / \n / \r, so the line is ALSO never split and
    // never reaches the `[redacted continuation]` fallback — it lands in the `else`
    // branch and ships verbatim. Stripping \r and \n alone is NOT sufficient.
    const JVM_TERMINATORS = ['\u2028', '\u2029', '\u0085'];
    for (const sep of JVM_TERMINATORS) {
        const out = flattenForLog(`here is my config${sep}host=admin:hunter2@internal.db`, 200);
        assert.ok(
            !out.includes(sep),
            `U+${sep.codePointAt(0).toString(16).toUpperCase().padStart(4, '0')} survived: ${JSON.stringify(out)}`,
        );
    }
});

test('does NOT strip characters the JVM regex handles correctly', () => {
    // Calibration, so the class above does not creep wider than the threat. VT and
    // FF are `\s` but are NOT java.util.regex line terminators — the JBR 21 probe
    // shows matches=true/find=true for both, i.e. already scrubbed. Mangling them
    // would cost output fidelity for no security gain.
    for (const ch of ['\u000B', '\u000C']) {
        const out = flattenForLog(`a${ch}b`, 100);
        assert.ok(out.includes(ch), `U+000${ch.codePointAt(0).toString(16).toUpperCase()} should be preserved: ${JSON.stringify(out)}`);
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

test('no LOG call interpolates raw goal text', () => {
    // The invariant is about LOG lines specifically. main.js legitimately echoes a
    // goal snippet back into the USER'S OWN chat via sendMessageSystem — the user's
    // own text returning to the user, not an export path — so a blanket file-wide ban
    // on the substring would be wrong, and would have to be weakened the moment
    // anyone re-added that (correct) user-facing hint.
    //
    // NB: the previous version of this guard keyed on the literal spellings `goal=`
    // and `goalSnippet ? '"'`. Renaming the log field to `goalPreview=` sailed
    // straight through it, and it also went green against the restored (legitimate)
    // goalSnippet purely by spelling luck. Assert on the CALL, not on one spelling.
    const fs = require('fs');
    for (const f of ['message-handler.js', 'main.js', 'ai.js']) {
        const fsrc = fs.readFileSync(path.join(BUNDLE, f), 'utf8');
        const logLines = fsrc.split('\n').filter((l) => /\blog\s*\(/.test(l));
        for (const l of logLines) {
            // Check each interpolation separately. A whole-line escape hatch would
            // pass a line carrying BOTH a safe `_byteLen(full.originalGoal)` and a
            // raw `${full.originalGoal}`; per-expression checking will not.
            for (const e of l.match(/\$\{[^}]*\}/g) || []) {
                if (/\boriginalGoal\b/.test(e)) {
                    // Key on the underlying redaction helpers, not on one file's
                    // local alias: main.js imports them as `_fp`/`_byteLen` and
                    // ai.js as `_reasoningFingerprint`/`_byteLen`, but both resolve
                    // to reasoning-redact's sha256(...).slice(0, 8) and UTF-8 length.
                    // An alias-keyed allowlist false-flags the safe ai.js call site.
                    assert.ok(
                        /(?:byteLen|_fp|[Ff]ingerprint)\s*\(/.test(e),
                        `${f}: a log call interpolates raw originalGoal:\n    ${l.trim()}`,
                    );
                }
                assert.ok(
                    !/\bgoalSnippet\b/.test(e),
                    `${f}: a log call interpolates the goal snippet:\n    ${l.trim()}`,
                );
            }
        }
    }
});

test('main.js declares every goal-related local it reads', () => {
    // Regression guard. A prior revision of this fix deleted `const goalSnippet = ...`
    // while treating it as a log leak, but left the read at the notify site. Nothing
    // caught it: `node --check` passes, because an undeclared free variable is a legal
    // runtime global lookup resolved lazily; and smoke.js SKIPS main.js, because
    // requiring it boots the whole agent. So on every boot with a live checkpoint,
    // auto-resume threw ReferenceError, the outer catch swallowed it as a generic
    // "[AutoResume] Startup scan failed", and both AUTO_RESUME_MAX_ATTEMPTS were
    // burned BEFORE the throw — permanently abandoning the very checkpoint that
    // crash-recovery exists to rescue.
    //
    // Deliberately narrow: a real unbound-identifier check needs a parser, and adding
    // a dependency for it is out of scope here. That main.js has no load coverage at
    // all is the underlying gap, and is tracked separately.
    const fs = require('fs');
    const msrc = fs.readFileSync(path.join(BUNDLE, 'main.js'), 'utf8');
    for (const name of ['goalSnippet', 'goalHint']) {
        if (!msrc.includes(name)) continue;
        const declared =
            msrc.includes('const ' + name + ' =') ||
            msrc.includes('let ' + name + ' =') ||
            msrc.includes('var ' + name + ' =');
        assert.ok(
            declared,
            'main.js reads `' + name + '` but never declares it — ReferenceError at runtime',
        );
    }
});

console.log(`\nPASS: log-safe.test.js (${passed} assertions)\n`);
