#!/usr/bin/env node
// flipper-invocation.test.js — invocation-context classification for
// `flipper_press` (BAT-1202).
//
// WHY THIS FILE EXISTS
// --------------------
// `invocationFor(chatId)` decides whether a Flipper IR press is treated as
// user-driven or as automation, and the Kotlin bridge REFUSES automation. Get it
// wrong in the permissive direction and a cron job can actuate an appliance with
// nobody present; get it wrong in the restrictive direction and the feature is
// simply dead.
//
// It shipped wrong in the restrictive direction. The guard was
// `typeof chatId !== 'string'` → automated, but the two channels disagree:
//
//   main.js  normalizeTelegramMessage → chatId: msg.chat.id      (JSON NUMBER)
//   discord.js                        → chatId: msg.channel_id   (snowflake STRING)
//
// So every genuine Telegram press — the primary channel — was classified as
// automation and refused with `automation_not_allowed`, while Discord worked.
// The asymmetry is what makes it worth pinning: a device test on one channel
// would have "passed".
//
// Run:  node tests/nodejs-project/flipper-invocation.test.js
// Exit: 0 = all pass, 1 = at least one failure.

'use strict';

const path = require('path');

const GREEN = '\x1b[32m';
const RED = '\x1b[31m';
const DIM = '\x1b[2m';
const BOLD = '\x1b[1m';
const RESET = '\x1b[0m';

const MODULE = path.join(
    __dirname, '..', '..',
    'app', 'src', 'main', 'assets', 'nodejs-project', 'tools', 'flipper-invocation.js',
);

const { invocationFor } = require(MODULE);

if (typeof invocationFor !== 'function') {
    console.log(`${RED}✗${RESET} tools/flipper-invocation.js does not export invocationFor`);
    process.exit(1);
}

const cases = [
    // ── The regression this file exists for ──────────────────────────────────
    ['telegram chat id (number)', 6543210987, 'user_message'],
    ['telegram chat id, negative group', -1001234567890, 'user_message'],
    ['telegram chat id as a string', '6543210987', 'user_message'],
    ['discord channel id (snowflake string)', '1234567890123456789', 'user_message'],
    ['bigint id', 9007199254740993n, 'user_message'],

    // ── Automation sentinels — must stay refused ─────────────────────────────
    ['cron session', 'cron:abc123', 'automated'],
    ['cron session, bare prefix', 'cron:', 'automated'],
    ['heartbeat probe', '__heartbeat__', 'automated'],

    // ── Fail-closed on anything that is not an id ────────────────────────────
    ['null', null, 'automated'],
    ['undefined', undefined, 'automated'],
    ['empty string', '', 'automated'],
    ['object', { id: 1 }, 'automated'],
    ['array', [1], 'automated'],
    ['function', () => 1, 'automated'],
    ['boolean', true, 'automated'],
    ['NaN', NaN, 'automated'],
    ['Infinity', Infinity, 'automated'],

    // ── Near-misses that must NOT be mistaken for sentinels ──────────────────
    ['id merely containing cron:', 'not-cron:123', 'user_message'],
    ['heartbeat-like but not exact', '__heartbeat__x', 'user_message'],
];

let pass = 0;
const failures = [];

for (const [label, input, expected] of cases) {
    let actual;
    try {
        actual = invocationFor(input);
    } catch (e) {
        actual = `threw: ${e.message}`;
    }
    if (actual === expected) pass++;
    else failures.push({ label, expected, actual });
}

console.log(`\n${BOLD}tools/flipper-invocation.js${RESET} — ${cases.length} cases`);
console.log(`${DIM}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${RESET}`);
if (failures.length === 0) {
    console.log(`${GREEN}✓${RESET} ${pass}/${cases.length} passed`);
    process.exit(0);
} else {
    console.log(`${RED}✗${RESET} ${failures.length}/${cases.length} failed, ${pass} passed\n`);
    for (const f of failures) {
        console.log(`  ${RED}FAIL${RESET} ${f.label}`);
        console.log(`    expected: ${f.expected}`);
        console.log(`    actual:   ${f.actual}`);
    }
    process.exit(1);
}
