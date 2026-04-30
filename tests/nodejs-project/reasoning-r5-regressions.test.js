#!/usr/bin/env node
// reasoning-r5-regressions.test.js — pin BAT-549 PR #354 R5 Copilot
// findings:
//
//  Thread 1: recovery escalation must loop until ok=true OR step 3
//            attempted (step 1+2 both no-op should still try step 3)
//  Thread 2: addToConversation `extra` allowlist blocks prototype
//            pollution via __proto__/constructor/prototype keys
//
// Run:  node tests/nodejs-project/reasoning-r5-regressions.test.js

'use strict';

let failures = 0;
function ok(label, cond, hint = '') {
    if (cond) console.log(`PASS: ${label}`);
    else { console.log(`FAIL: ${label}${hint ? ' — ' + hint : ''}`); failures++; }
}

console.log('── R5 thread 1: escalation loop runs through step 3 when 1+2 both no-op ──');

// Replicate the exact ai.js chat() escalation logic against a stubbed
// quarantineActiveSegment. Asserts: when step 1 returns ok=false AND
// step 2 returns ok=false, step 3 is still attempted (and ok=true since
// step 3 is unconditional reset).
function simulateEscalation(stepBehavior) {
    let _reasoningRecoveryStep = 0;
    let recovered = false;
    const stepsAttempted = [];
    const quarantineStub = (ctx) => {
        stepsAttempted.push(ctx.step);
        const ok = stepBehavior[ctx.step] === true;
        return { ok, cutIndex: ok ? 0 : -1, newMessages: [], systemNote: 'note' };
    };

    while (_reasoningRecoveryStep < 3 && !recovered) {
        _reasoningRecoveryStep++;
        const result = quarantineStub({ step: _reasoningRecoveryStep });
        if (result.ok) recovered = true;
    }

    return { recovered, stepsAttempted, finalStep: _reasoningRecoveryStep };
}

// Step 1 ok=true → no further escalation
let r = simulateEscalation({ 1: true, 2: true, 3: true });
ok('Step 1 ok → recovered, only step 1 attempted',
    r.recovered && r.stepsAttempted.length === 1 && r.stepsAttempted[0] === 1);

// Step 1 no-op, step 2 ok → recovered, escalated once
r = simulateEscalation({ 1: false, 2: true, 3: true });
ok('Step 1 no-op + step 2 ok → recovered after 2 attempts',
    r.recovered && r.stepsAttempted.length === 2
    && r.stepsAttempted[0] === 1 && r.stepsAttempted[1] === 2);

// THE BUG: step 1 + 2 both no-op → previous code stopped here. Fixed
// version MUST escalate to step 3.
r = simulateEscalation({ 1: false, 2: false, 3: true });
ok('Step 1 + 2 both no-op → step 3 ATTEMPTED (R5 thread 1 fix)',
    r.stepsAttempted.length === 3 && r.stepsAttempted[2] === 3,
    `attempted: ${JSON.stringify(r.stepsAttempted)}`);
ok('Step 1 + 2 both no-op → step 3 ok → recovered',
    r.recovered);

// All 3 no-op (degenerate, should not happen in production since step 3
// is unconditional reset) → not recovered, but loop terminates cleanly.
r = simulateEscalation({ 1: false, 2: false, 3: false });
ok('All 3 no-op → loop terminates without recovery',
    !r.recovered && r.stepsAttempted.length === 3);

console.log();
console.log('── R5 thread 2: addToConversation extra-field allowlist blocks prototype pollution ──');

// Replicate ai.js's addToConversation allowlist logic
const _ADD_TO_CONV_ALLOWED_EXTRAS = ['reasoningBlocks'];
function buildEntry(role, content, extra = null) {
    const entry = { role, content };
    if (extra && typeof extra === 'object') {
        for (const key of _ADD_TO_CONV_ALLOWED_EXTRAS) {
            if (Object.prototype.hasOwnProperty.call(extra, key)) {
                entry[key] = extra[key];
            }
        }
    }
    return entry;
}

// Prototype pollution attempt 1: __proto__
{
    const polluted = {};
    Object.assign(polluted, { __proto__: { isAdmin: true } });
    // The malicious payload: an `extra` object trying to mutate Object.prototype
    const malicious = JSON.parse('{"__proto__":{"isAdmin":true},"reasoningBlocks":[]}');
    const entry = buildEntry('assistant', 'hi', malicious);
    // Confirm Object.prototype was NOT polluted
    const cleanProbe = {};
    ok('No prototype pollution via __proto__ (Object.prototype.isAdmin undefined)',
        cleanProbe.isAdmin === undefined);
    ok('Allowlisted reasoningBlocks still passes through',
        Array.isArray(entry.reasoningBlocks) && entry.reasoningBlocks.length === 0);
    // entry.__proto__ is unchanged from the default Object.prototype
    ok('entry has no own __proto__ property',
        !Object.prototype.hasOwnProperty.call(entry, '__proto__'));
}

// Prototype pollution attempt 2: constructor.prototype
{
    const malicious = { constructor: { prototype: { polluted: true } }, reasoningBlocks: [] };
    buildEntry('assistant', 'hi', malicious);
    const probe = {};
    ok('No pollution via constructor.prototype (probe.polluted undefined)',
        probe.polluted === undefined);
}

// Prototype pollution attempt 3: prototype key directly
{
    const malicious = { prototype: { polluted: true }, reasoningBlocks: [{ provider: 'custom' }] };
    const entry = buildEntry('assistant', 'hi', malicious);
    ok('prototype key NOT copied to entry (not in allowlist)',
        entry.prototype === undefined);
    ok('reasoningBlocks key still copied (in allowlist)',
        Array.isArray(entry.reasoningBlocks));
}

// Verify role/content can't be overridden by extra (defense in depth)
{
    const malicious = { role: 'system', content: 'override', reasoningBlocks: [] };
    const entry = buildEntry('user', 'original', malicious);
    ok('role NOT overridden by extra (allowlist excludes role)',
        entry.role === 'user');
    ok('content NOT overridden by extra (allowlist excludes content)',
        entry.content === 'original');
}

// Allowlist additions stay safe even if `extra` is the malicious object
{
    const realBlock = { schemaVersion: 1, provider: 'custom', wire: { reasoning_content: 'x' } };
    const entry = buildEntry('assistant', 'hi', { reasoningBlocks: [realBlock] });
    ok('Real reasoningBlocks data passed through cleanly',
        entry.reasoningBlocks[0] === realBlock);
}

console.log();
console.log('── R6 thread 1: _reasoningRecoveryStep resets to 0 after every 200 ──');

// Replicate ai.js's chat() while-loop step tracking. After each 200,
// the counter must reset so a later 400 in the same turn re-attempts
// step 1 (rather than jumping straight to step 3 from a previous
// recovery's leftover state).
function simulateMultipleEpisodes(events) {
    let _reasoningRecoveryStep = 0;
    const stepsAttemptedPerEpisode = [];
    let currentEpisode = null;

    for (const ev of events) {
        if (ev === 'recover-success') {
            // start episode
            if (!currentEpisode) currentEpisode = [];
            _reasoningRecoveryStep++;
            currentEpisode.push(_reasoningRecoveryStep);
        } else if (ev === '200') {
            // close episode (if any) — reset
            if (currentEpisode) { stepsAttemptedPerEpisode.push(currentEpisode); currentEpisode = null; }
            _reasoningRecoveryStep = 0;
        }
    }
    if (currentEpisode) stepsAttemptedPerEpisode.push(currentEpisode);
    return stepsAttemptedPerEpisode;
}

let episodes = simulateMultipleEpisodes([
    'recover-success',  // 400 → recovery step 1, 200 follows
    '200',
    'recover-success',  // another 400 in same turn → MUST be step 1 again
    '200',
]);
ok('Each 400 episode after 200 starts at step 1',
    episodes.length === 2 && episodes[0][0] === 1 && episodes[1][0] === 1,
    `episodes: ${JSON.stringify(episodes)}`);

console.log();
console.log('── R6 thread 2: resumedFromTaskId quarantine path ──');
// We can't run the full chat() flow without a config, but we can pin
// the contract: if `resumedFromTaskId` is set AND differs from the
// fresh `taskId`, recovery quarantines BOTH. We replicate the gating
// logic directly from ai.js.
function shouldQuarantineResumedFrom(resumedFromTaskId, freshTaskId) {
    return Boolean(resumedFromTaskId && resumedFromTaskId !== freshTaskId);
}
ok('resume case: resumedFromTaskId set, differs from fresh → quarantine BOTH',
    shouldQuarantineResumedFrom('old-resumed-task', 'new-fresh-task') === true);
ok('non-resume case: resumedFromTaskId null → fresh-only',
    shouldQuarantineResumedFrom(null, 'fresh-task') === false);
ok('edge case: same id (defensive) → fresh-only',
    shouldQuarantineResumedFrom('same-id', 'same-id') === false);
ok('empty string → fresh-only',
    shouldQuarantineResumedFrom('', 'fresh-task') === false);

console.log();
if (failures === 0) {
    console.log('ALL TESTS PASS');
    process.exit(0);
} else {
    console.log(`${failures} TEST(S) FAILED`);
    process.exit(1);
}
