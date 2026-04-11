#!/usr/bin/env node
// silent-reply.test.js — unit tests for the centralized silent-reply token
// handling in app/src/main/assets/nodejs-project/silent-reply.js.
//
// Run:  node tests/nodejs-project/silent-reply.test.js
// Exit: 0 = all pass, 1 = at least one failure.
//
// WHY THIS FILE EXISTS
// --------------------
// silent-reply.js is critical — it gates whether the agent sends a message
// to the user at all. A regression here is user-visible (either stray tokens
// leak into chat, or legitimate replies get swallowed).
//
// History:
//   - 2026-04-11 (BAT-489): file shipped with a Unicode-property-escape
//     regex (`\p{L}\p{N}`) that crashed nodejs-mobile's V8 at module load.
//     Rewrote to ASCII `\w` boundaries. These cases lock in the ASCII
//     boundary semantics so future rewrites can't silently regress.
//   - 2026-04-11 (BAT-491): renamed the canonical sentinel from
//     `SILENT_REPLY` to `[[SILENT_REPLY]]` because the bare form collided
//     with natural prose when the agent discussed the protocol. Bare
//     whole-message is still honored as a legacy backward-compat sentinel;
//     bare inline is now discussion that passes through untouched.
//
// Coverage sections:
//   1. Canonical [[SILENT_REPLY]] form — stripped aggressively
//   2. Legacy bare SILENT_REPLY — whole-message only (compat safety net)
//   3. Protocol discussion — bare inline passes through (THE BAT-491 FIX)
//   4. Identifier preservation — MY_SILENT_REPLY_HANDLE stays intact
//   5. Plain text passthrough

const path = require('path');
const sr = require(path.resolve(__dirname, '..', '..', 'app', 'src', 'main', 'assets', 'nodejs-project', 'silent-reply.js'));

const GREEN = '\x1b[32m';
const RED = '\x1b[31m';
const DIM = '\x1b[2m';
const BOLD = '\x1b[1m';
const RESET = '\x1b[0m';

// [label, input, expected stripSilentReply output, expected containsSilentReply]
const cases = [
    // ── Section 1: canonical [[SILENT_REPLY]] form ──────────────────────
    ['canonical exact',                        '[[SILENT_REPLY]]',                              '',                           true],
    ['canonical exact with whitespace',        '  [[SILENT_REPLY]]  ',                          '',                           true],
    ['canonical lowercase (case insensitive)', '[[silent_reply]]',                              '',                           true],
    ['canonical leading-spaced',               '[[SILENT_REPLY]] hello',                        'hello',                      true],
    ['canonical leading-spaced newline',       '[[SILENT_REPLY]]\nhello',                       'hello',                      true],
    ['canonical leading-glued',                '[[SILENT_REPLY]]hello',                         'hello',                      true],
    ['canonical mid-token space bounded',      'Hello [[SILENT_REPLY]] world',                  'Hello  world',               true],
    ['canonical repeated leading',             '[[SILENT_REPLY]] [[SILENT_REPLY]]',             '',                           true],
    ['canonical repeat then glued',            '[[SILENT_REPLY]] [[SILENT_REPLY]]hello',        'hello',                      true],
    ['canonical bold wrapped',                 '**[[SILENT_REPLY]]**',                          '',                           true],
    ['canonical code wrapped',                 '`[[SILENT_REPLY]]`',                            '',                           true],
    ['canonical json envelope',                '{"action":"[[SILENT_REPLY]]"}',                 '',                           true],

    // ── Section 2: legacy bare-form whole-message (backward compat) ─────
    ['legacy bare exact',                      'SILENT_REPLY',                                  '',                           true],
    ['legacy bare with whitespace',            '  SILENT_REPLY  ',                              '',                           true],
    ['legacy bare lowercase',                  'silent_reply',                                  '',                           true],
    ['legacy json envelope bare',              '{"action":"SILENT_REPLY"}',                     '',                           true],

    // ── Section 3: protocol discussion (THE BAT-491 FIX) ────────────────
    // These all contain the literal bare `SILENT_REPLY` string INLINE in
    // normal prose. Expectation: pass through UNCHANGED, containsSilentReply
    // returns false. This is what the old regex would break (over-strip).
    // If any case in this section fails, we've regressed.
    ['discussion: leading bare',               'SILENT_REPLY is a special internal token I use when I should do work silently.', 'SILENT_REPLY is a special internal token I use when I should do work silently.', false],
    ['discussion: mid bare',                   'If I send SILENT_REPLY by itself, SeekerClaw discards the message.', 'If I send SILENT_REPLY by itself, SeekerClaw discards the message.', false],
    ['discussion: trailing bare',              'The token is called SILENT_REPLY',              'The token is called SILENT_REPLY', false],
    ['discussion: multiple inline bares',      'Use SILENT_REPLY when you have nothing to say. SILENT_REPLY is NOT a shortcut.', 'Use SILENT_REPLY when you have nothing to say. SILENT_REPLY is NOT a shortcut.', false],

    // ── Section 4: identifier preservation (must NOT strip or flag) ─────
    ['identifier: underscore-bounded',         'MY_SILENT_REPLY_HANDLE',                        'MY_SILENT_REPLY_HANDLE',     false],
    ['identifier: word glue both sides',       'testSILENT_REPLYbar',                           'testSILENT_REPLYbar',        false],

    // ── Section 5: plain text passthrough ───────────────────────────────
    ['regular sentence',                       'Just a regular message with no sentinel.',      'Just a regular message with no sentinel.', false],
    ['empty string',                           '',                                              '',                           false],
];

let pass = 0;
let fail = 0;
const failures = [];

for (const [label, input, expectStrip, expectContains] of cases) {
    const stripped = sr.stripSilentReply(input);
    const contains = sr.containsSilentReply(input);
    const stripOk = stripped === expectStrip;
    const containsOk = contains === expectContains;

    if (stripOk && containsOk) {
        pass++;
    } else {
        fail++;
        failures.push({ label, input, expectStrip, stripped, expectContains, contains, stripOk, containsOk });
    }
}

console.log(`\n${BOLD}silent-reply.js${RESET} — ${cases.length} cases`);
console.log(`${DIM}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${RESET}`);
if (fail === 0) {
    console.log(`${GREEN}✓${RESET} ${pass}/${cases.length} passed`);
    process.exit(0);
} else {
    console.log(`${RED}✗${RESET} ${fail}/${cases.length} failed, ${pass} passed\n`);
    for (const f of failures) {
        console.log(`  ${RED}FAIL${RESET} ${f.label}`);
        console.log(`    input: ${JSON.stringify(f.input)}`);
        if (!f.stripOk) {
            console.log(`    strip:    expected ${JSON.stringify(f.expectStrip)}`);
            console.log(`              got      ${JSON.stringify(f.stripped)}`);
        }
        if (!f.containsOk) {
            console.log(`    contains: expected ${f.expectContains}, got ${f.contains}`);
        }
    }
    process.exit(1);
}
