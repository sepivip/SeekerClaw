#!/usr/bin/env node
// checkpoint-provenance.test.js — BAT-1283 store boundary + auto-resume wiring.
//
// LAYER 2 of the signed coverage gate. What this file can and cannot see:
//   CAN  — the REAL saveCheckpoint -> listCheckpoints -> loadCheckpoint path, and
//          the REAL redactSecrets (security.js is loaded, not stubbed).
//   CANNOT — that main.js actually calls goalIsTrusted(full). main.js has zero
//          module.exports and requiring it boots the agent (smoke.js:131), so that
//          claim is covered by the SOURCE-WIRING guard at the bottom of this file
//          plus the device test — NOT by behavioural assertion. Stated, not implied.
//
// One stub only: config.js (TASKS_DIR -> a temp dir, plus the handful of exports
// security.js destructures). The contract budgeted two stubs; stubbing security.js
// would have defeated the OQ2 tests, which need the real redaction patterns.
//
// Run:  node tests/nodejs-project/checkpoint-provenance.test.js
'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const BUNDLE = path.join(__dirname, '..', '..', 'app', 'src', 'main', 'assets', 'nodejs-project');

// ── stub config.js BEFORE requiring anything that needs it ──────────────────
const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'bat1283-'));
const workDir = path.join(tmpRoot, 'workspace');
const TASKS_DIR = path.join(workDir, 'tasks');
fs.mkdirSync(TASKS_DIR, { recursive: true });

const configPath = require.resolve(path.join(BUNDLE, 'config.js'));
require.cache[configPath] = {
    id: configPath,
    filename: configPath,
    loaded: true,
    exports: {
        TASKS_DIR,
        workDir,
        config: {},
        log: () => {},
        getBridgeToken: () => null,
    },
};

const { saveCheckpoint, listCheckpoints, loadCheckpoint } = require(path.join(BUNDLE, 'task-store'));
const { goalIsTrusted, resolveTurnGoal, GOAL_SCAN_UNSAFE_KEY } = require(path.join(BUNDLE, 'turn-goal'));

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

let seq = 0;
function writeCheckpoint(fields) {
    const taskId = `t${++seq}${Date.now().toString(36)}`;
    saveCheckpoint(taskId, {
        taskId,
        chatId: '7561373860',
        turnId: 'turn1',
        startedAt: Date.now(),
        stepCount: 1,
        maxSteps: 35,
        complete: false,
        reason: null,
        conversationSlice: [],
        ...fields,
    });
    return taskId;
}
const summaryOf = (taskId) => listCheckpoints().find(c => c.taskId === taskId);

console.log('\ncheckpoint provenance — a stored goal is authoritative only if we can vouch for it\n');

// ── the object boundary that made v3 inert (Codex B4) ───────────────────────

test('the list summary omits goalSrc; only the loaded checkpoint carries it', () => {
    const id = writeCheckpoint({ originalGoal: 'summarise the quarterly numbers', goalSrc: 'turn' });
    const summary = summaryOf(id);
    const full = loadCheckpoint(id);
    assert.ok(summary, 'checkpoint should be listed');
    assert.strictEqual(summary.goalSrc, undefined, 'listCheckpoints() is a six-field whitelist');
    assert.strictEqual(full.goalSrc, 'turn', 'the loaded record must preserve provenance');
});

test('NEGATIVE CONTROL: trusting the summary marks every checkpoint legacy', () => {
    // This IS contract v3's specification, and the reason it was rejected. Reading
    // provenance off `cp` would suppress the goal and hint for EVERY checkpoint,
    // silently disabling the fix while every pure resolver test stayed green.
    const id = writeCheckpoint({ originalGoal: 'a real request', goalSrc: 'turn' });
    assert.strictEqual(goalIsTrusted(loadCheckpoint(id)), true, 'full record is trusted');
    assert.strictEqual(goalIsTrusted(summaryOf(id)), false, 'summary can never be trusted');
});

test('a pre-fix checkpoint (no goalSrc) round-trips as untrusted', () => {
    const id = writeCheckpoint({ originalGoal: 'Hey girl' });   // the device symptom
    const full = loadCheckpoint(id);
    assert.strictEqual(full.originalGoal, 'Hey girl', 'legacy value is preserved on disk');
    assert.strictEqual(full.goalSrc, undefined);
    assert.strictEqual(goalIsTrusted(full), false, 'legacy goal must never be promoted');
});

test('an unknown provenance value fails closed', () => {
    const id = writeCheckpoint({ originalGoal: 'a real request', goalSrc: 'bogus' });
    assert.strictEqual(goalIsTrusted(loadCheckpoint(id)), false);
});

// ── OQ2: redaction-altered goals fail closed ────────────────────────────────

test('a goal mangled by redaction is marked and fails closed', () => {
    // Real redactSecrets, real pattern. /sk-[a-zA-Z0-9_-]{20,}/ fires on any
    // kebab-case phrase whose word ends in "sk" — ask-, task-, risk-.
    const goal = 'ask-claude-to-summarise-this-long-document-please';
    const id = writeCheckpoint({ originalGoal: goal, goalSrc: 'turn' });
    const full = loadCheckpoint(id);
    assert.notStrictEqual(full.originalGoal, goal, 'redaction should have altered it');
    assert.strictEqual(full.goalSrc, 'redacted', 'alteration must be recorded');
    // Downgrade safety: an old build knows nothing about goalSrc, so the mangled
    // text must not be sitting in the field it WOULD read. null is the only value
    // both builds agree means "no goal".
    assert.strictEqual(full.originalGoal, null, 'the mangled text must not be persisted');
    assert.strictEqual(goalIsTrusted(full), false, 'a mangled goal is not authoritative');
});

test('NEGATIVE CONTROL: an unmangled goal keeps its provenance and stays trusted', () => {
    // Without this, the OQ2 test would pass just as well if EVERYTHING were marked
    // redacted — which would silently disable the whole feature.
    const goal = 'check my wallet balance and summarise it';
    const id = writeCheckpoint({ originalGoal: goal, goalSrc: 'turn' });
    const full = loadCheckpoint(id);
    assert.strictEqual(full.originalGoal, goal, 'clean goal must survive verbatim');
    assert.strictEqual(full.goalSrc, 'turn');
    assert.strictEqual(goalIsTrusted(full), true);
});

test('the redacted mark survives a re-save and the goal does not degrade further', () => {
    // saveCheckpoint runs on every re-save (main.js:405-406 attempt bump,
    // markComplete round-trip). redactSecrets is idempotent, so the second pass
    // detects no change — the mark must persist rather than being cleared.
    const goal = 'ask-claude-to-summarise-this-long-document-please';
    const id = writeCheckpoint({ originalGoal: goal, goalSrc: 'turn' });
    const once = loadCheckpoint(id);
    saveCheckpoint(id, { ...once, resumeAttempts: 1 });
    const twice = loadCheckpoint(id);
    assert.strictEqual(twice.goalSrc, 'redacted', 'mark must survive the re-save');
    assert.strictEqual(twice.originalGoal, once.originalGoal, 'goal must not degrade further');
    assert.strictEqual(twice.originalGoal, null, 'and stays dropped, not resurrected');
    assert.strictEqual(goalIsTrusted(twice), false);
});

// ── auto-resume wiring: SOURCE GUARD, not behavioural coverage ──────────────

test('SOURCE GUARD: auto-resume reads provenance from `full`, never from `cp`', () => {
    // main.js has zero module.exports and requiring it boots the agent
    // (smoke.js:131), so this cannot be asserted behaviourally without a refactor
    // the contract explicitly rules out. A source guard is weaker than a
    // behavioural test and is labelled as such. Its own negative control is run by
    // hand: rewrite the line to cp.goalSrc and confirm this goes red — that is
    // precisely the B4 bug.
    const src = fs.readFileSync(path.join(BUNDLE, 'main.js'), 'utf8');
    assert.ok(/const goalTrusted = goalIsTrusted\(full\)/.test(src),
        'auto-resume must derive provenance from the loaded checkpoint');
    assert.ok(!/goalIsTrusted\(\s*cp\b/.test(src),
        'must not read provenance from the listCheckpoints() summary');
    assert.ok(!/\bcp\.goalSrc\b/.test(src),
        'cp.goalSrc can never exist — the summary is a six-field whitelist');
    assert.ok(/originalGoal: goalIsUsableString \? full\.originalGoal : null/.test(src),
        'an untrusted goal must never reach the resume directive');
    assert.ok(/goalIsUsableString \? full\.originalGoal\.slice\(0, 80\) : null/.test(src),
        'an untrusted goal must never reach the Telegram hint');
});

test('SOURCE GUARD: /resume gates the same way, via the same shared helper', () => {
    const src = fs.readFileSync(path.join(BUNDLE, 'message-handler.js'), 'utf8');
    assert.ok(/goalIsTrusted\(full\)/.test(src), '/resume must gate on the loaded checkpoint');
    assert.ok(!/goalIsTrusted\(\s*cp\b/.test(src) && !/\bcp\.goalSrc\b/.test(src));
    assert.ok(/originalGoal: goalTrusted \? full\.originalGoal : null/.test(src));
    // one implementation, not two — the rules cannot drift between read sites
    for (const f of ['main.js', 'message-handler.js']) {
        const s = fs.readFileSync(path.join(BUNDLE, f), 'utf8');
        assert.ok(/require\('\.\/turn-goal'\)/.test(s), `${f} must import the shared helper`);
    }
});

// ── Codex diff-review blocker 1: two-generation laundering ──────────────────
//
// The single-generation tests above all pass with the bug present. The store
// redacts the conversationSlice as well as originalGoal, so a goal mangled into
// "ask-***" ALSO survives inside the slice. On resume the backward scan reads it
// back and stamps the SUCCESSOR checkpoint 'scan' — a trusted value — and the
// second crash replays the mangled text authoritatively. Only a save -> resolve
// -> save sequence can see it, which is why this test spans two generations.

function generationTwo(sliceText, { stripMark = false } = {}) {
    // gen 1: the crash that mangles the goal
    const id = writeCheckpoint({
        originalGoal: sliceText,
        goalSrc: 'turn',
        conversationSlice: [
            { role: 'user', content: sliceText },
            { role: 'assistant', content: 'I was interrupted mid-task.' },
        ],
    });
    const gen1 = loadCheckpoint(id);

    // resume: main.js restores the slice verbatim, then chat(chatId, 'continue')
    const restored = gen1.conversationSlice.map(m => {
        const c = { ...m };
        if (stripMark) delete c[GOAL_SCAN_UNSAFE_KEY];
        return c;
    });
    const resolved = resolveTurnGoal({
        optionsGoal: goalIsTrusted(gen1) ? gen1.originalGoal : null,
        userMessage: 'continue',
        messages: restored,
    });

    // gen 2: the resumed turn checkpoints itself
    const id2 = writeCheckpoint({
        originalGoal: resolved.goal,
        goalSrc: resolved.src,
        conversationSlice: restored,
    });
    return { gen1, resolved, gen2: loadCheckpoint(id2) };
}

const LAUNDER_GOAL = 'ask-claude-to-summarise-this-long-document-please';

test('a redacted goal cannot be laundered back into trusted provenance', () => {
    const { gen1, resolved, gen2 } = generationTwo(LAUNDER_GOAL);

    assert.strictEqual(gen1.goalSrc, 'redacted', 'precondition: gen 1 is marked');
    assert.strictEqual(goalIsTrusted(gen1), false, 'precondition: gen 1 fails closed');

    // The scan must not have adopted the mangled slice text...
    assert.notStrictEqual(resolved.goal, 'ask-***', 'the mangled text must not be re-adopted');
    // ...and with nothing else in the window, there is simply no goal to promote.
    assert.strictEqual(resolved.goal, null, 'nothing substantive survives the mangling');
    assert.strictEqual(resolved.src, 'none');

    assert.strictEqual(goalIsTrusted(gen2), false,
        'generation 2 must not be authoritative either');
});

test('UPGRADE PATH: a pre-fix checkpoint cannot launder either', () => {
    // Codex diff-review point 1. Stripping the marker models exactly what an
    // upgrading user has on disk: a checkpoint written by the PRE-fix build, whose
    // slice text is already redacted and carries no marker. Redaction is
    // idempotent, so re-saving it under the new build never adds one — the marker
    // alone cannot close this. The content sentinel is what covers it.
    const { resolved, gen2 } = generationTwo(LAUNDER_GOAL, { stripMark: true });

    assert.notStrictEqual(resolved.goal, 'ask-***', 'the mangled text must not be adopted');
    assert.strictEqual(resolved.src, 'none');
    assert.strictEqual(goalIsTrusted(gen2), false, 'and generation 2 is not authoritative');
});

test('UPGRADE PATH: older clean chatter behind the mangled message is NOT promoted', () => {
    // Codex asked for this shape specifically. The dangerous outcome is not just
    // adopting "ask-***" — it is reaching PAST it to an older message and stamping
    // that with trusted 'scan' provenance, which is the original BAT-1283 bug.
    const id = writeCheckpoint({
        conversationSlice: [
            { role: 'user', content: 'Hey girl' },          // older, clean, and WRONG
            { role: 'assistant', content: 'hi' },
            { role: 'user', content: LAUNDER_GOAL },        // redacted on write, unmarked below
        ],
    });
    const full = loadCheckpoint(id);
    const legacy = full.conversationSlice.map(m => {
        const c = { ...m };
        delete c[GOAL_SCAN_UNSAFE_KEY];                     // pre-fix build wrote no marker
        return c;
    });

    const r = resolveTurnGoal({ userMessage: 'continue', messages: legacy });
    assert.strictEqual(r.goal, null, 'no goal at all');
    assert.strictEqual(r.src, 'none');
    assert.notStrictEqual(r.goal, 'Hey girl', 'the original bug, reached by a new route');
});

test('NEGATIVE CONTROL: a clean goal still survives two generations', () => {
    // The marker must not fire on ordinary text — otherwise the fix would work by
    // disabling the scan fallback entirely, which the device test relies on.
    const clean = 'summarise my unread notes and tell me what needs action today';
    const { gen1, resolved, gen2 } = generationTwo(clean);

    assert.strictEqual(gen1.originalGoal, clean, 'untouched by redaction');
    assert.strictEqual(goalIsTrusted(gen1), true);
    assert.strictEqual(resolved.goal, clean, 'carried forward, not lost');
    assert.strictEqual(resolved.src, 'carried');
    assert.strictEqual(goalIsTrusted(gen2), true);
});

test('the unsafe mark is written onto the slice message, and only when altered', () => {
    const id = writeCheckpoint({
        conversationSlice: [
            { role: 'user', content: LAUNDER_GOAL },
            { role: 'user', content: 'a perfectly ordinary request' },
        ],
    });
    const [mangled, clean] = loadCheckpoint(id).conversationSlice;
    assert.strictEqual(mangled[GOAL_SCAN_UNSAFE_KEY], true, 'altered message must be marked');
    assert.strictEqual(clean[GOAL_SCAN_UNSAFE_KEY], undefined, 'clean message must NOT be marked');
    assert.strictEqual(clean.content, 'a perfectly ordinary request', 'and survives verbatim');
});

test('only the SCAN-VISIBLE text block can mark a message unsafe', () => {
    // CodeRabbit R2: textOfContent reads the FIRST type:'text' block. Marking on any
    // other redacted block would skip a message whose goal text is clean, quietly
    // disabling the scan fallback for it — the over-marking failure mode.
    const id = writeCheckpoint({
        conversationSlice: [{
            role: 'user',
            content: [
                { type: 'text', text: 'summarise my unread notes' },   // scan reads THIS
                { type: 'text', text: LAUNDER_GOAL },                  // mangled, but invisible
                { type: 'image', text: LAUNDER_GOAL },                 // ditto, and not a text block
            ],
        }],
    });
    const [msg] = loadCheckpoint(id).conversationSlice;

    assert.strictEqual(msg[GOAL_SCAN_UNSAFE_KEY], undefined,
        'a clean first text block must not be marked by later redactions');
    assert.strictEqual(msg.content[0].text, 'summarise my unread notes', 'and stays verbatim');
    assert.notStrictEqual(msg.content[1].text, LAUNDER_GOAL,
        'the other blocks are still redacted — this is about MARKING, not redaction');
    // A tool_result block is deliberately NOT used here: a user message carrying one is
    // dropped by the leading-orphan trim (task-store.js:41), so it never reaches the scan.
    assert.notStrictEqual(msg.content[2].text, LAUNDER_GOAL);

    // and the scan can still use it
    const r = resolveTurnGoal({ userMessage: 'continue', messages: [msg] });
    assert.strictEqual(r.goal, 'summarise my unread notes');
    assert.strictEqual(r.src, 'scan');
});

test('NEGATIVE CONTROL: mangling the FIRST text block does mark it', () => {
    const id = writeCheckpoint({
        conversationSlice: [{
            role: 'user',
            content: [
                { type: 'text', text: LAUNDER_GOAL },
                { type: 'text', text: 'summarise my unread notes' },
            ],
        }],
    });
    const [msg] = loadCheckpoint(id).conversationSlice;
    assert.strictEqual(msg[GOAL_SCAN_UNSAFE_KEY], true, 'the scan-visible block WAS mangled');

    const r = resolveTurnGoal({ userMessage: 'continue', messages: [msg] });
    assert.strictEqual(r.goal, null, 'so the message is skipped entirely');
    assert.strictEqual(r.src, 'none');
});

try { fs.rmSync(tmpRoot, { recursive: true, force: true }); } catch { /* best effort */ }

if (failed > 0) {
    console.error(`\nFAIL: checkpoint-provenance.test.js — ${failed} failed, ${passed} passed\n`);
} else {
    console.log(`\nPASS: checkpoint-provenance.test.js (${passed} assertions)\n`);
}
