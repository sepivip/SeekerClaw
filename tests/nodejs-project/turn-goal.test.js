#!/usr/bin/env node
// turn-goal.test.js — BAT-1283 goal resolution + checkpoint provenance.
//
// LAYER 1 of the signed coverage gate. What this file can and cannot see:
//   CAN  — everything in turn-goal.js: resolution order, the continuation
//          predicate, bounding, the forward-scan producer, goalIsTrusted().
//   CANNOT — that ai.js/main.js/message-handler.js actually CALL any of it.
//          Wiring is proven by checkpoint-provenance.test.js (store boundary +
//          source guard) and resume-goal-provenance.test.js (behavioural).
//
// Pure by construction: turn-goal.js has no requires, so this needs no stubs.
//
// Run:  node tests/nodejs-project/turn-goal.test.js
'use strict';

const assert = require('assert');
const path = require('path');

const BUNDLE = path.join(__dirname, '..', '..', 'app', 'src', 'main', 'assets', 'nodejs-project');
const {
    resolveTurnGoal,
    extractOriginalGoalForward,
    isContinuationControl,
    goalIsTrusted,
    MAX_GOAL_CHARS,
} = require(path.join(BUNDLE, 'turn-goal'));

let passed = 0;
let failed = 0;
function test(name, fn) {
    try {
        fn();
        passed++;
        console.log(`  ✓ ${name}`);
    } catch (e) {
        failed++;
        console.error(`  ✗ ${name}`);
        console.error(`    ${e.message}`);
        process.exitCode = 1;
    }
}

// The device incident, 2026-08-24. The greeting is reproduced exactly (its
// fingerprint b4e375d0 / 8 bytes is in the agent log); the task is a stand-in of
// the same shape — the real 92-byte string is NOT recoverable, because BAT-1247
// discipline logged only goalLen/goalFp and the checkpoint is gone. Hence
// structural assertions rather than a fingerprint pin.
const GREETING = 'Hey girl';
const TASK = 'check my wallet balance, then search the web for the current SOL price, then summarise both.';
const u = (content) => ({ role: 'user', content });
const a = (content) => ({ role: 'assistant', content });

console.log('\nturn-goal.js — the goal a checkpoint carries must be the task, not the oldest chatter\n');

// ── the reported defect ─────────────────────────────────────────────────────

test('device scenario: resolves the task, not the oldest greeting', () => {
    const messages = [u(GREETING), a('hi'), u(TASK)];
    const { goal, src } = resolveTurnGoal({ userMessage: TASK, messages });
    assert.strictEqual(goal, TASK);
    assert.notStrictEqual(goal, GREETING);
    assert.strictEqual(src, 'turn');
});

test('NEGATIVE CONTROL: the real pre-fix producer returns the greeting on that same fixture', () => {
    // Not a hand-authored copy — extractOriginalGoalForward is the pre-fix scan
    // preserved verbatim. If this ever stops returning the greeting, the fixture
    // has stopped reproducing the bug and every assertion above is worthless.
    const messages = [u(GREETING), a('hi'), u(TASK)];
    assert.strictEqual(extractOriginalGoalForward(messages), GREETING);
});

// ── continuation predicate (Codex B1) ───────────────────────────────────────

test('continuation turn scans back to the substantive task', () => {
    const messages = [u(GREETING), u(TASK), u('keep going')];
    const { goal, src } = resolveTurnGoal({ userMessage: 'keep going', messages });
    assert.strictEqual(goal, TASK);
    assert.strictEqual(src, 'scan');
});

test('NEGATIVE CONTROL: the naive tail answer on that fixture IS the control phrase', () => {
    // Proves the continuation predicate is doing the work — without it, "newest
    // user message" returns 'keep going' and that becomes the authoritative goal.
    const messages = [u(GREETING), u(TASK), u('keep going')];
    assert.strictEqual(messages[messages.length - 1].content, 'keep going');
});

test('"yes, turn on the TV" stays a real request', () => {
    assert.strictEqual(isContinuationControl('yes, turn on the TV'), false);
    const messages = [u(TASK), u('yes, turn on the TV')];
    const { goal } = resolveTurnGoal({ userMessage: 'yes, turn on the TV', messages });
    assert.strictEqual(goal, 'yes, turn on the TV');
});

test('POSITIVE CONTROL: "yes, proceed" IS a control and is skipped', () => {
    // Same leading word, opposite outcome — the predicate discriminates rather
    // than swallowing anything that starts with "yes".
    assert.strictEqual(isContinuationControl('yes, proceed'), true);
    const messages = [u(TASK), u('yes, proceed')];
    assert.strictEqual(resolveTurnGoal({ userMessage: 'yes, proceed', messages }).goal, TASK);
});

test('control forms survive casing, trailing punctuation and quotes', () => {
    for (const s of ['Continue.', '  keep going  ', 'OK!', '"go ahead"', 'Yes, please']) {
        assert.strictEqual(isContinuationControl(s), true, `expected control: ${JSON.stringify(s)}`);
    }
});

test('long prose beginning with a control word is NOT a control', () => {
    for (const s of ['yes and also summarise the attached document please',
                     'continue the migration you started on the staging cluster']) {
        assert.strictEqual(isContinuationControl(s), false, `expected substantive: ${JSON.stringify(s)}`);
    }
});

test('continuation with no prior substantive request returns none — never invents one', () => {
    const messages = [u('continue'), u('keep going')];
    assert.deepStrictEqual(resolveTurnGoal({ userMessage: 'continue', messages }), { goal: null, src: 'none' });
});

test('POSITIVE CONTROL: add one substantive message and it is found', () => {
    const messages = [u(TASK), u('continue'), u('keep going')];
    assert.strictEqual(resolveTurnGoal({ userMessage: 'continue', messages }).goal, TASK);
});

// ── the [System] skip (the load-bearing one) ────────────────────────────────

test('loop-detector [System] entries are skipped by the backward scan', () => {
    // ai.js pushes these as role:'user'. They are ALWAYS newer than the real goal,
    // so a backward scan without this skip returns one of them — strictly worse
    // than the bug being fixed, since it becomes an authoritative directive.
    const messages = [
        u(TASK),
        u('[System] You appear to be repeating the same tool call with identical arguments'),
        u('[System] Tool loop detected and stopped after 5 identical calls'),
    ];
    assert.strictEqual(resolveTurnGoal({ userMessage: 'continue', messages }).goal, TASK);
});

test('POSITIVE CONTROL: ordinary prose merely starting with the same word is returned', () => {
    // The predicate must reject the literal '[System] ' prefix without swallowing
    // real user text. '[system event]' is lowercase and a different literal.
    for (const s of ['system event happened during the deploy', '[Systemic risk review] please summarise']) {
        assert.strictEqual(resolveTurnGoal({ userMessage: s, messages: [u(s)] }).goal, s,
            `should be substantive: ${JSON.stringify(s)}`);
    }
});

test('legacy skip prefixes still skipped', () => {
    const messages = [u(TASK), u('[system event] channel reconnected'), u('[TASK RESUME] prior turn')];
    assert.strictEqual(resolveTurnGoal({ userMessage: 'continue', messages }).goal, TASK);
});

// ── precedence + bounding (Codex B3) ────────────────────────────────────────

test('a carried goal wins over history', () => {
    const messages = [u(GREETING), u(TASK)];
    assert.deepStrictEqual(resolveTurnGoal({ optionsGoal: 'STORED', userMessage: TASK, messages }),
        { goal: 'STORED', src: 'carried' });
});

test('NEGATIVE CONTROL: empty-ish carried goals fall through to derivation', () => {
    // Proves the precedence assertion is not passing because history is ignored.
    const messages = [u(GREETING), u(TASK)];
    for (const empty of [null, undefined, '', '   ']) {
        const { goal, src } = resolveTurnGoal({ optionsGoal: empty, userMessage: TASK, messages });
        assert.strictEqual(goal, TASK, `expected fall-through for ${JSON.stringify(empty)}`);
        assert.strictEqual(src, 'turn');
    }
});

test('every source is bounded by the same limit', () => {
    const long = 'x'.repeat(5000);
    assert.strictEqual(resolveTurnGoal({ optionsGoal: long }).goal.length, MAX_GOAL_CHARS);
    assert.strictEqual(resolveTurnGoal({ userMessage: long, messages: [] }).goal.length, MAX_GOAL_CHARS);
    assert.strictEqual(resolveTurnGoal({ userMessage: 'continue', messages: [u(long)] }).goal.length, MAX_GOAL_CHARS);
});

test('NEGATIVE CONTROL: a goal just under the limit is not truncated', () => {
    // Without this the bounding test would pass even if everything were truncated.
    const almost = 'y'.repeat(MAX_GOAL_CHARS - 1);
    assert.strictEqual(resolveTurnGoal({ optionsGoal: almost }).goal.length, MAX_GOAL_CHARS - 1);
});

test('non-string sources never throw and never yield a non-string goal', () => {
    for (const bad of [12345, {}, [], true, Symbol.iterator ? undefined : null]) {
        const { goal } = resolveTurnGoal({ optionsGoal: bad, userMessage: bad, messages: [] });
        assert.ok(goal === null || typeof goal === 'string', `bad goal type for ${String(bad)}`);
    }
    assert.strictEqual(resolveTurnGoal({ optionsGoal: 12345, userMessage: TASK, messages: [] }).goal, TASK);
});

test('vision content arrays resolve via their first text block', () => {
    const vision = [{ type: 'image', source: {} }, { type: 'text', text: TASK }];
    assert.strictEqual(resolveTurnGoal({ userMessage: vision, messages: [] }).goal, TASK);
    const noText = [{ type: 'image', source: {} }];
    assert.strictEqual(resolveTurnGoal({ userMessage: noText, messages: [u(TASK)] }).goal, TASK);
});

test('tool-role messages are never treated as goals', () => {
    const messages = [u(TASK), { role: 'tool', content: 'tool output that looks like a request' }];
    assert.strictEqual(resolveTurnGoal({ userMessage: 'continue', messages }).goal, TASK);
});

// ── heartbeat / cron must be unchanged ──────────────────────────────────────

test('heartbeat and cron prompts resolve exactly as before', () => {
    // Both clearConversation() before chat(), so the window holds one entry.
    for (const prompt of ['[Heartbeat] status check', 'Scheduled task: post the daily summary']) {
        const messages = [u(prompt)];
        assert.strictEqual(resolveTurnGoal({ userMessage: prompt, messages }).goal, prompt);
    }
});

test('SAME-VALUE DIFFERENTIAL: the pre-fix producer agrees on those single-entry windows', () => {
    // A same-value differential is the only way to distinguish "unchanged" from
    // "changed and coincidentally identical" for the heartbeat/cron paths.
    for (const prompt of ['[Heartbeat] status check', 'Scheduled task: post the daily summary']) {
        const messages = [u(prompt)];
        assert.strictEqual(resolveTurnGoal({ userMessage: prompt, messages }).goal,
            extractOriginalGoalForward(messages));
    }
});

// ── provenance gate (Codex B2 / B4) ─────────────────────────────────────────

test('goalIsTrusted accepts only the closed enum', () => {
    for (const src of ['carried', 'turn', 'scan', 'none']) {
        assert.strictEqual(goalIsTrusted({ goalSrc: src }), true, `expected trusted: ${src}`);
    }
});

test('goalIsTrusted fails closed on anything else', () => {
    // The listCheckpoints() summary shape is the important case: it is an explicit
    // six-field whitelist and can never carry goalSrc, so passing it here must be
    // false — that mistake would silently disable the fix for every checkpoint.
    const summary = { taskId: 't1', chatId: '1', startedAt: 0, updatedAt: 0, complete: false, reason: null };
    // 'redacted' (BAT-1283 OQ2) belongs in this list, not the trusted one: it marks a
    // goal that redactSecrets ALTERED at save time, so the stored text no longer
    // represents the request and must not become an authoritative directive.
    for (const bad of [summary, {}, { goalSrc: 'bogus' }, { goalSrc: '' }, { goalSrc: 42 },
                       { goalSrc: 'redacted' },
                       { goalSrc: null }, null, undefined, 'turn', 42]) {
        assert.strictEqual(goalIsTrusted(bad), false, `expected untrusted: ${JSON.stringify(bad)}`);
    }
});

if (failed > 0) {
    console.error(`\nFAIL: turn-goal.test.js — ${failed} failed, ${passed} passed\n`);
} else {
    console.log(`\nPASS: turn-goal.test.js (${passed} assertions)\n`);
}
