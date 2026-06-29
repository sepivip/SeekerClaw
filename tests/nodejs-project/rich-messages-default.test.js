#!/usr/bin/env node
// rich-messages-default.test.js — BAT-1050.
// Pins the RICH_MESSAGES_ENABLED resolution in config.js:
//   _boolFlag(config.richMessages ?? process.env.SEEKERCLAW_RICH ?? true)
// i.e. DEFAULT ON, with precedence: Settings toggle (config.richMessages) >
// SEEKERCLAW_RICH env var > default true. The whole feature flips on this one
// line, and a stray edit to the default or the precedence would silently change
// behavior for EVERY user — so we guard it two ways:
//   1. structural drift guard: the literal expression must be present in config.js
//   2. truth table: a faithful re-implementation of _boolFlag + the ?? chain
//      exercises every (config, env) combination.
//
// Run:  node tests/nodejs-project/rich-messages-default.test.js

'use strict';

const fs = require('fs');
const path = require('path');

let failures = 0;
function eq(label, actual, expected) {
    if (actual === expected) console.log(`PASS: ${label}`);
    else { console.log(`FAIL: ${label}\n  actual:   ${actual}\n  expected: ${expected}`); failures++; }
}
function ok(label, cond, hint = '') {
    if (cond) console.log(`PASS: ${label}`);
    else { console.log(`FAIL: ${label}${hint ? ' — ' + hint : ''}`); failures++; }
}

const CONFIG_JS = path.join(__dirname, '..', '..', 'app', 'src', 'main', 'assets', 'nodejs-project', 'config.js');
const src = fs.readFileSync(CONFIG_JS, 'utf8');

console.log('── drift guard: config.js pins default ON + precedence ──');
ok('_boolFlag accepts true / "true" / "1" only',
    src.includes("const _boolFlag = (v) => v === true || v === 'true' || v === '1';"),
    '_boolFlag definition changed — update this test if intentional');
ok('RICH_MESSAGES_ENABLED defaults ON (?? true) with toggle>env precedence',
    src.includes("const RICH_MESSAGES_ENABLED = _boolFlag(config.richMessages ?? process.env.SEEKERCLAW_RICH ?? true);"),
    'the resolution expression changed — default ON or precedence may have drifted');
ok('config.js still documents DEFAULT ON',
    /DEFAULT ON/.test(src), 'comment no longer says DEFAULT ON');
ok('no stale "default-OFF" comment anywhere in config.js',
    !/default-off/i.test(src), 'a default-OFF comment drifted back — the flag is DEFAULT ON now');

console.log();
console.log('── truth table: _boolFlag(config.richMessages ?? SEEKERCLAW_RICH ?? true) ──');
// Faithful re-implementation. `??` only falls through on null/undefined (NOT on
// boolean false), so an explicit false from the toggle/env disables Rich.
const _boolFlag = (v) => v === true || v === 'true' || v === '1';
const resolve = (cfg, env) => _boolFlag(cfg ?? env ?? true);

eq('nothing set -> ON (default)',            resolve(undefined, undefined), true);
eq('toggle ON -> ON',                        resolve(true, undefined), true);
eq('toggle OFF -> OFF (wins over default)',  resolve(false, undefined), false);
eq('env "true", no toggle -> ON',            resolve(undefined, 'true'), true);
eq('env "1", no toggle -> ON',               resolve(undefined, '1'), true);
eq('env "false", no toggle -> OFF',          resolve(undefined, 'false'), false);
eq('toggle OFF beats env "true"',            resolve(false, 'true'), false);
eq('toggle ON beats env "false"',            resolve(true, 'false'), true);
eq('garbage env, no toggle -> OFF (strict)', resolve(undefined, 'yes'), false);

console.log();
if (failures === 0) { console.log('ALL TESTS PASS'); process.exit(0); }
else { console.log(`${failures} TEST(S) FAILED`); process.exit(1); }
