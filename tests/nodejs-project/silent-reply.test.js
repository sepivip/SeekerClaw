#!/usr/bin/env node
// silent-reply.test.js — unit tests for the centralized SILENT_REPLY token
// handling in app/src/main/assets/nodejs-project/silent-reply.js.
//
// Run:  node tests/nodejs-project/silent-reply.test.js
// Exit: 0 = all pass, 1 = at least one failure.
//
// WHY THIS FILE EXISTS
// --------------------
// silent-reply.js is critical — it gates whether the agent sends a message
// to the user at all. A regression here is user-visible (either stray tokens
// leak into chat, or legitimate replies get swallowed). On 2026-04-11 the
// file shipped with a Unicode-property-escape regex (`\p{L}\p{N}`) that
// crashed nodejs-mobile's V8 at module load; we rewrote it to ASCII `\w`
// boundaries. These cases lock in the ASCII boundary semantics so future
// rewrites can't silently regress.

const path = require('path');
const sr = require(path.resolve(__dirname, '..', '..', 'app', 'src', 'main', 'assets', 'nodejs-project', 'silent-reply.js'));

const GREEN = '\x1b[32m';
const RED = '\x1b[31m';
const DIM = '\x1b[2m';
const RESET = '\x1b[0m';

// [label, input, expected stripSilentReply, expected containsSilentReply]
const cases = [
    // --- Exact / standalone
    ['exact token',                     'SILENT_REPLY',                               '',                             true],
    ['exact with surrounding whitespace', '  SILENT_REPLY  ',                          '',                             true],
    ['lowercase exact (case insensitive)', 'silent_reply',                             '',                             true],

    // --- Leading-spaced form ("SILENT_REPLY <content>")
    ['leading spaced',                  'SILENT_REPLY hello',                         'hello',                        true],
    ['leading spaced newline',          'SILENT_REPLY\nhello',                        'hello',                        true],

    // --- Leading-glued form ("SILENT_REPLYhello")
    ['leading glued',                   'SILENT_REPLYhello',                          'hello',                        true],
    ['leading underscore-glued',        'SILENT_REPLY_hello',                         'hello',                        true],

    // --- Mid-glued and multi-token
    ['mid token, space bounded',        'Hello SILENT_REPLY world',                   'Hello  world',                 true],
    ['repeated leading tokens',         'SILENT_REPLY SILENT_REPLY',                  '',                             true],
    ['repeat then glued',               'SILENT_REPLY SILENT_REPLYhello',             'hello',                        true],

    // --- Markdown-wrapped
    ['bold wrapped',                    '**SILENT_REPLY**',                           '',                             true],
    ['code wrapped',                    '`SILENT_REPLY`',                             '',                             true],

    // --- JSON envelope
    ['json envelope exact',             '{"action":"SILENT_REPLY"}',                  '',                             true],

    // --- Identifier preservation (must NOT strip or report as match)
    ['identifier with both-side glue',  'MY_SILENT_REPLY_HANDLE',                     'MY_SILENT_REPLY_HANDLE',       false],
    ['identifier word glue',            'testSILENT_REPLYbar',                        'testSILENT_REPLYbar',          false],

    // --- Plain text should be unchanged
    ['regular sentence',                'Just a regular message',                     'Just a regular message',       false],
    ['empty string',                    '',                                           '',                             false],
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

console.log(`\nsilent-reply.js — ${cases.length} cases`);
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
