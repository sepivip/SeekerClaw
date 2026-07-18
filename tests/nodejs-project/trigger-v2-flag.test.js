#!/usr/bin/env node
// trigger-v2-flag.test.js — BAT-1148 (delivers BAT-1091).
//
// Pins the Jupiter Trigger V2 kill-switch resolution: V2 is default-ON, and V1
// is reachable via config `useTriggerV2:false` OR env
// `SEEKERCLAW_USE_TRIGGER_V2=false`, with ENV taking precedence over config so
// support can force every install back to V1 without a rebuild.
//
// This is the automated half of Codex guardrail #6 ("forced-off kill-switch
// routes to V1 / default-on with no env"). It exercises the REAL resolver
// (jupiter/trigger-flag.js) — tool-schemas.test.js mocks config.js, so it can't.
//
// Run: node tests/nodejs-project/trigger-v2-flag.test.js

'use strict';

const assert = require('assert');
const path = require('path');

const BUNDLE = path.resolve(__dirname, '..', '..', 'app', 'src', 'main', 'assets', 'nodejs-project');
const { triBool, resolveUseTriggerV2 } = require(path.join(BUNDLE, 'jupiter', 'trigger-flag.js'));

let passed = 0;
function check(desc, actual, expected) {
    assert.strictEqual(actual, expected, `${desc}: expected ${expected}, got ${actual}`);
    passed++;
}

// ── triBool: explicit true/false vs unspecified ─────────────────────────────
check('triBool(true)', triBool(true), true);
check('triBool(false)', triBool(false), false);
check('triBool("true")', triBool('true'), true);
check('triBool("false")', triBool('false'), false);
check('triBool("TRUE") case-insensitive', triBool('TRUE'), true);
check('triBool("False") case-insensitive', triBool('False'), false);
check('triBool(" false ") trims', triBool(' false '), false);
check('triBool("1")', triBool('1'), true);
check('triBool("0")', triBool('0'), false);
check('triBool(undefined) → unspecified', triBool(undefined), undefined);
check('triBool("") → unspecified (not a footgun off)', triBool(''), undefined);
check('triBool("yes") unknown → unspecified', triBool('yes'), undefined);
check('triBool(null) → unspecified', triBool(null), undefined);
check('triBool(0 number) → unspecified (only strings/bools normalize)', triBool(0), undefined);

// ── resolveUseTriggerV2: default-ON ─────────────────────────────────────────
check('default (nothing set) → ON', resolveUseTriggerV2({}), true);
check('no args at all → ON', resolveUseTriggerV2(), true);
check('config undefined, env undefined → ON',
    resolveUseTriggerV2({ configValue: undefined, envValue: undefined }), true);

// ── kill-switch: config forces OFF ──────────────────────────────────────────
check('config false (bool) → OFF', resolveUseTriggerV2({ configValue: false }), false);
check('config "false" (string) → OFF', resolveUseTriggerV2({ configValue: 'false' }), false);
check('config true → ON', resolveUseTriggerV2({ configValue: true }), true);

// ── kill-switch: env forces OFF ─────────────────────────────────────────────
check('env "false" → OFF', resolveUseTriggerV2({ envValue: 'false' }), false);
check('env "FALSE" → OFF', resolveUseTriggerV2({ envValue: 'FALSE' }), false);
check('env "0" → OFF', resolveUseTriggerV2({ envValue: '0' }), false);
check('env "true" → ON', resolveUseTriggerV2({ envValue: 'true' }), true);
check('env "" (empty) → falls through to default ON',
    resolveUseTriggerV2({ envValue: '' }), true);

// ── precedence: env overrides config (the load-bearing guardrail) ───────────
check('env "false" overrides config true → OFF',
    resolveUseTriggerV2({ configValue: true, envValue: 'false' }), false);
check('env "true" overrides config false → ON',
    resolveUseTriggerV2({ configValue: false, envValue: 'true' }), true);
check('env unspecified, config false → OFF (config applies)',
    resolveUseTriggerV2({ configValue: false, envValue: undefined }), false);
check('env "" empty, config false → OFF (empty env is not an override)',
    resolveUseTriggerV2({ configValue: false, envValue: '' }), false);

console.log(`\n✓ trigger-v2-flag: all ${passed} assertions passed (V2 default-ON; env>config>default kill-switch)`);
