#!/usr/bin/env node
// claude-adaptive-thinking.test.js — BAT-1033 request-shape guard.
//
// Anthropic REMOVED extended thinking (`thinking.type:'enabled'` +
// `budget_tokens`) from the current models — fable-5/opus-4-8/opus-4-7/sonnet-5
// reject it with 400 "thinking.type.enabled is not supported for this model.
// Use thinking.type.adaptive". Verified live (tests/live/anthropic/test-thinking-matrix.js):
// adaptive is accepted by every reasoning model. So formatRequest now emits
// `thinking: { type: 'adaptive' }` uniformly (no budget_tokens).
//
// This pins that shape and guards against `budget_tokens` ever coming back
// (which would re-break every current model on the raw api-key path). It also
// re-verifies the BAT-549/BAT-558 gates survive the migration.
//
// Run:  node tests/nodejs-project/claude-adaptive-thinking.test.js
'use strict';

const path = require('path');
const configPath = path.resolve(__dirname, '../../app/src/main/assets/nodejs-project/config.js');
require.cache[configPath] = {
    id: configPath, filename: configPath, loaded: true,
    exports: { log: () => {}, API_TIMEOUT_MS: 60000 },
};
const claude = require('../../app/src/main/assets/nodejs-project/providers/claude');

let failures = 0;
function ok(label, cond, hint = '') {
    if (cond) console.log(`PASS: ${label}`);
    else { console.log(`FAIL: ${label}${hint ? ' — ' + hint : ''}`); failures++; }
}

const SYS = [{ type: 'text', text: 'sys' }];
const MSGS = [{ role: 'user', content: 'hi' }];
const ON = { reasoningEnabled: true, reasoningSupport: 'yes' };
const bodyOf = (maxTokens, opts, model = 'claude-sonnet-5') =>
    JSON.parse(claude.formatRequest(model, maxTokens, SYS, MSGS, [], opts));

console.log('── BAT-1033: request emits adaptive thinking, never budget_tokens ──');

// 1) reasoning ON + supported + big turn → adaptive, NO budget_tokens.
const t = bodyOf(4096, ON).thinking;
ok('(1) reasoning on → thinking.type === "adaptive"', !!t && t.type === 'adaptive', `got ${JSON.stringify(t)}`);
ok('(2) adaptive carries NO budget_tokens', !!t && t.budget_tokens === undefined, `got ${JSON.stringify(t)}`);

// 3–7) the BAT-549/BAT-558 gates must still suppress thinking.
ok('(3) reasoning off → no thinking',
    bodyOf(4096, { reasoningEnabled: false, reasoningSupport: 'yes' }).thinking === undefined);
ok('(4) reasoningSupport!=="yes" → no thinking',
    bodyOf(4096, { reasoningEnabled: true, reasoningSupport: 'no' }).thinking === undefined);
ok('(5) reasoningMode:"off" (heartbeat) → no thinking',
    bodyOf(4096, { ...ON, reasoningMode: 'off' }).thinking === undefined);
ok('(6) small turn (maxTokens<2048) → no thinking',
    bodyOf(1024, ON).thinking === undefined);
ok('(7) no requestOptions → no thinking',
    bodyOf(4096, undefined).thinking === undefined);

// 8) HARD regression guard: no reasoning model may ever emit budget_tokens.
const MODELS = ['claude-fable-5', 'claude-opus-4-8', 'claude-opus-4-7', 'claude-opus-4-6', 'claude-sonnet-5', 'claude-sonnet-4-6'];
const offenders = MODELS.filter((m) => /"budget_tokens"/.test(claude.formatRequest(m, 4096, SYS, MSGS, [], ON)));
ok('(8) no reasoning model emits budget_tokens (would 400 on api-key path)',
    offenders.length === 0, `offenders: ${offenders.join(', ')}`);
// …and every one of them emits adaptive.
const allAdaptive = MODELS.every((m) => bodyOf(4096, ON, m).thinking?.type === 'adaptive');
ok('(9) every reasoning model emits adaptive', allAdaptive);

console.log();
if (failures === 0) { console.log('ALL TESTS PASS'); process.exit(0); }
else { console.log(`${failures} TEST(S) FAILED`); process.exit(1); }
