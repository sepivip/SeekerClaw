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
    isEligibleTurnText,
    isEligibleHistoryText,
    isScanTainted,
    goalIsTrusted,
    GOAL_SCAN_UNSAFE_KEY,
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

test('goalIsTrusted accepts only provenance that can carry a real goal', () => {
    // 'none' is a legitimate WRITE value but not a forwardable one — see below.
    for (const src of ['carried', 'turn', 'scan']) {
        assert.strictEqual(goalIsTrusted({ goalSrc: src, originalGoal: TASK }), true,
            `expected trusted: ${src}`);
    }
});

test("'none' provenance is never forwardable, even carrying a goal", () => {
    // CodeRabbit #450: 'none' records that the resolver found NOTHING, so a
    // checkpoint holding both 'none' and a goal is internally inconsistent — the
    // goal did not come from the resolver that stamped it. Fail closed.
    assert.strictEqual(goalIsTrusted({ goalSrc: 'none', originalGoal: 'Hey girl' }), false);
    assert.strictEqual(goalIsTrusted({ goalSrc: 'none', originalGoal: null }), false);
});

test('the stored goal itself is guarded, not just its provenance', () => {
    // Persisted JSON living on disk for up to 7 days. The resolver only ever
    // stores normalizeGoal() output, so anything untrimmed, empty, or over the
    // bound did not come from it — treat as tampering and fail closed.
    assert.strictEqual(goalIsTrusted({ goalSrc: 'turn', originalGoal: 'x'.repeat(MAX_GOAL_CHARS + 1) }), false,
        'oversized stored goal must not be trusted');
    assert.strictEqual(goalIsTrusted({ goalSrc: 'turn', originalGoal: '  padded  ' }), false,
        'untrimmed stored goal must not be trusted');
    assert.strictEqual(goalIsTrusted({ goalSrc: 'turn', originalGoal: '' }), false);
    assert.strictEqual(goalIsTrusted({ goalSrc: 'turn', originalGoal: 12345 }), false);
});

test('NEGATIVE CONTROL: an ordinary goal is still trusted', () => {
    // Without this, every assertion above would pass if goalIsTrusted simply
    // returned false always — which would silently disable the whole feature.
    assert.strictEqual(goalIsTrusted({ goalSrc: 'turn', originalGoal: TASK }), true);
    assert.strictEqual(goalIsTrusted({ goalSrc: 'turn', originalGoal: 'x'.repeat(MAX_GOAL_CHARS) }), true,
        'exactly at the bound is still valid');
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

// ── Codex diff-review blocker 2: machine prefixes are a HISTORY rule ─────────
//
// SKIP_PREFIXES had been applied to this turn's own message as well. A user who
// pastes a log line and asks for help ("[System] production node is stuck") had
// their real request rejected, and the scan then handed back older chatter —
// the exact failure this module exists to fix, re-created one layer up.

test('a current task quoting a machine prefix is still THIS turn\'s goal', () => {
    const history = [{ role: 'user', content: 'Hey girl' }];
    for (const prefix of ['[System]', '[system event]', '[TASK RESUME]']) {
        const task = `${prefix} production node is stuck; diagnose it`;
        const r = resolveTurnGoal({ userMessage: task, messages: history });
        assert.strictEqual(r.src, 'turn', `${prefix}: must resolve from the turn`);
        assert.strictEqual(r.goal, task, `${prefix}: the user's own words, verbatim`);
        assert.notStrictEqual(r.goal, 'Hey girl', `${prefix}: must not fall back to chatter`);
    }
});

test('NEGATIVE CONTROL: the same strings in HISTORY are still skipped', () => {
    // The turn/history split must not weaken the scan. Machine-authored entries
    // wearing role:'user' are always NEWER than the real request, so a backward
    // scan reaches them first — that is why the prefix rule exists at all.
    for (const prefix of ['[System]', '[system event]', '[TASK RESUME]']) {
        const r = resolveTurnGoal({
            userMessage: 'continue',
            messages: [
                { role: 'user', content: 'summarise my unread notes' },
                { role: 'assistant', content: 'working on it' },
                { role: 'user', content: `${prefix} loop detected, stop repeating` },
            ],
        });
        assert.strictEqual(r.src, 'scan', `${prefix}: control reply must fall through`);
        assert.strictEqual(r.goal, 'summarise my unread notes',
            `${prefix}: must skip the machine entry and keep scanning back`);
    }
});

test('the two predicates differ ONLY on machine prefixes', () => {
    assert.strictEqual(isEligibleTurnText('[System] diagnose this'), true);
    assert.strictEqual(isEligibleHistoryText('[System] diagnose this'), false);
    // everything else agrees, in both directions
    for (const t of ['check my wallet balance', 'x', 'a real request here']) {
        assert.strictEqual(isEligibleTurnText(t), true, t);
        assert.strictEqual(isEligibleHistoryText(t), true, t);
    }
    for (const t of ['continue', 'ok', 'yes, proceed', '', '   ']) {
        assert.strictEqual(isEligibleTurnText(t), false, JSON.stringify(t));
        assert.strictEqual(isEligibleHistoryText(t), false, JSON.stringify(t));
    }
});

// ── Codex diff-review blocker 1: redaction taint must not launder ────────────

test('a tainted candidate TERMINATES the scan, it does not skip past it', () => {
    // Codex diff-review point 2. Skipping onward would promote older chatter to
    // src:'scan' — a TRUSTED provenance — which is the original bug by another
    // route. Losing the hint is correct; asserting a wrong goal is not.
    const r = resolveTurnGoal({
        userMessage: 'continue',
        messages: [
            { role: 'user', content: 'Hey girl' },                 // older, clean, WRONG
            { role: 'assistant', content: 'ok' },
            { role: 'user', content: 'ask-***', [GOAL_SCAN_UNSAFE_KEY]: true },
        ],
    });
    assert.strictEqual(r.goal, null, 'no goal is better than the wrong goal');
    assert.strictEqual(r.src, 'none');
    assert.notStrictEqual(r.goal, 'Hey girl', 'must never reach past the tainted message');
});

test('GUARD 1 — the marker alone taints, with no sentinel in the text', () => {
    // Isolates the save-time marker: this text is perfectly clean, so only the
    // flag can be doing the work.
    const clean = { role: 'user', content: 'summarise my unread notes', [GOAL_SCAN_UNSAFE_KEY]: true };
    assert.strictEqual(isScanTainted(clean, clean.content), true);
    const r = resolveTurnGoal({ userMessage: 'continue', messages: [clean] });
    assert.strictEqual(r.src, 'none');
});

test('GUARD 2 — a redaction sentinel alone taints, with no marker (the legacy path)', () => {
    // Isolates the content signal. A checkpoint written by the PRE-fix build has
    // redacted text and NO marker, and redaction is idempotent so a re-save never
    // adds one. Without this guard every upgrading user keeps the laundering path
    // for the 7 days their old checkpoints live.
    for (const mangled of ['ask-***', 'sk-***', 'my token is eyJ***', 'see [REDACTED_ENV]', 'key [REDACTED:BRAVE_API_KEY]']) {
        const msg = { role: 'user', content: mangled };
        assert.strictEqual(isScanTainted(msg, mangled), true, mangled);
        const r = resolveTurnGoal({
            userMessage: 'continue',
            messages: [{ role: 'user', content: 'Hey girl' }, msg],
        });
        assert.strictEqual(r.src, 'none', `${mangled}: must not fall back to older chatter`);
    }
});

test('NEGATIVE CONTROL: neither guard fires on ordinary text', () => {
    // Without this, both guards would pass just as well if EVERYTHING were tainted
    // — which would disable the scan fallback the device test relies on.
    const msg = { role: 'user', content: 'summarise my unread notes' };
    assert.strictEqual(isScanTainted(msg, msg.content), false);
    const r = resolveTurnGoal({ userMessage: 'continue', messages: [msg] });
    assert.strictEqual(r.goal, 'summarise my unread notes');
    assert.strictEqual(r.src, 'scan');
});

test('the sentinel guard applies to the SCAN only, never to live user text', () => {
    // This turn's message has not been through redaction, so a user who types ***
    // means it. Tainting it would silently drop a real request.
    const r = resolveTurnGoal({ userMessage: 'grep the logs for *** and report', messages: [] });
    assert.strictEqual(r.src, 'turn');
    assert.strictEqual(r.goal, 'grep the logs for *** and report');
});

test('only an exact `true` marks a message unsafe', () => {
    // Guards against a truthy-string or JSON round-trip surprise silently
    // disabling the scan for ordinary messages.
    for (const v of [false, 0, '', null, undefined]) {
        const r = resolveTurnGoal({
            userMessage: 'continue',
            messages: [{ role: 'user', content: 'a real request', [GOAL_SCAN_UNSAFE_KEY]: v }],
        });
        assert.strictEqual(r.goal, 'a real request', `marker=${JSON.stringify(v)} must not skip`);
    }
});

// ── Codex diff-review nits: quote / punctuation normalisation ────────────────

test('controls are recognised through nested quotes and punctuation', () => {
    // Phone keyboards produce smart quotes, and users nest the punctuation both
    // ways. Each of these is a bare control reply, not a new request.
    const forms = [
        '"continue."', '"continue".', '\u201ccontinue.\u201d', '\u2018go ahead\u2019!',
        'continue;', 'ok:', "'proceed'.", '  YES,  ', '\u201cyes, proceed\u201d',
    ];
    for (const f of forms) {
        assert.strictEqual(isContinuationControl(f), true, `expected control: ${JSON.stringify(f)}`);
    }
});

test('NEGATIVE CONTROL: quoted real requests survive normalisation', () => {
    const forms = [
        '"turn on the TV."', '\u201ccheck my wallet balance\u201d',
        'yes, turn on the TV', 'continue the migration script',
    ];
    for (const f of forms) {
        assert.strictEqual(isContinuationControl(f), false, `must stay a goal: ${JSON.stringify(f)}`);
    }
});

test('ACCEPTED AMBIGUITY: a bare "Resume." is read as a control', () => {
    // Codex flagged this as unavoidable: "resume" is in the control vocabulary,
    // so a one-word message asking about a CV is indistinguishable from asking the
    // agent to carry on. Pinned deliberately so the behaviour is a decision on
    // record rather than an accident — the cost is one scan fallback, and any
    // longer phrasing ("send me your resume") is unaffected.
    assert.strictEqual(isContinuationControl('Resume.'), true);
    assert.strictEqual(isContinuationControl('send me your resume'), false);
    assert.strictEqual(isContinuationControl('resume the deployment please'), false);
});

if (failed > 0) {
    console.error(`\nFAIL: turn-goal.test.js — ${failed} failed, ${passed} passed\n`);
} else {
    console.log(`\nPASS: turn-goal.test.js (${passed} assertions)\n`);
}
