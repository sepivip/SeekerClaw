#!/usr/bin/env node
// resume-goal-provenance.test.js — BAT-1283 /resume read-site behaviour.
//
// LAYER 3 of the signed coverage gate. What this file can and cannot see:
//   CAN  — the REAL handleCommand('/resume') disk path in message-handler.js, and
//          the actual `originalGoal` it hands onward. This is behavioural coverage
//          of one production read site.
//   CANNOT — the auto-resume path in main.js (zero module.exports; requiring it
//          boots the agent, smoke.js:131). That is covered by the source guard in
//          checkpoint-provenance.test.js plus the device test, and is labelled
//          there as source-wiring, NOT behavioural.
//
// Cost: ONE stub (config.js). message-handler's init(d) is pure dependency
// injection, and its other top-level requires (silent-reply, model-catalog,
// telegram-commands, reasoning-redact, turn-goal, log-safe) all load standalone —
// they are in smoke.js LOAD_TARGETS. The contract budgeted a ~270-line harness
// modelled on think-command.test.js; injection makes it far cheaper.
//
// Run:  node tests/nodejs-project/resume-goal-provenance.test.js
'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const BUNDLE = path.join(__dirname, '..', '..', 'app', 'src', 'main', 'assets', 'nodejs-project');

// ── stub config.js BEFORE requiring message-handler ─────────────────────────
const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'bat1283-resume-'));
const workDir = path.join(tmpRoot, 'workspace');
fs.mkdirSync(workDir, { recursive: true });

const configPath = require.resolve(path.join(BUNDLE, 'config.js'));
require.cache[configPath] = {
    id: configPath,
    filename: configPath,
    loaded: true,
    exports: {
        CHANNEL: 'telegram',
        workDir,
        PROVIDER: 'openai',
        AUTH_TYPE: 'oauth',
        OPENAI_AUTH_TYPE: 'oauth',
        resolveActiveModel: () => 'gpt-5.6-sol',
        runtimeState: {},
        config: {},
        TASKS_DIR: path.join(workDir, 'tasks'),
        log: () => {},
        getBridgeToken: () => null,
    },
};

const messageHandler = require(path.join(BUNDLE, 'message-handler'));

let passed = 0;
let failed = 0;
function test(name, fn) {
    const run = fn();
    const settle = (ok, err) => {
        if (ok) { passed++; console.log(`  ✓ ${name}`); }
        else {
            failed++;
            console.error(`  ✗ ${name}`);
            console.error(`    ${err && err.message}`);
            process.exitCode = 1;
        }
    };
    return Promise.resolve(run).then(() => settle(true), (e) => settle(false, e));
}

const CHAT = '7561373860';
const TASK = 'check my wallet balance and summarise it';
const LEGACY_GOAL = 'Hey girl';   // the device symptom

/**
 * Drive the real /resume disk path with a given stored checkpoint, and return the
 * `originalGoal` message-handler actually hands onward.
 */
async function resumeWith(checkpointFields) {
    const full = {
        taskId: 'tk1',
        chatId: CHAT,
        complete: false,
        reason: 'budget_exhausted',
        startedAt: Date.now() - 60000,
        updatedAt: Date.now() - 60000,
        conversationSlice: [{ role: 'user', content: TASK }],
        ...checkpointFields,
    };
    // listCheckpoints() returns SUMMARIES — deliberately without goalSrc, exactly
    // as task-store.js:163-170 builds them. If the production code read provenance
    // off this object it would see undefined and mark everything legacy (B4).
    const summary = {
        taskId: full.taskId,
        chatId: full.chatId,
        startedAt: full.startedAt,
        updatedAt: full.updatedAt,
        complete: full.complete,
        reason: full.reason,
    };
    messageHandler.init({
        log: () => {},
        getActiveTask: () => null,          // force PATH=disk
        clearActiveTask: () => {},
        getConversation: () => [],
        listCheckpoints: () => [summary],
        loadCheckpoint: () => full,
    });
    return messageHandler.handleCommand(CHAT, '/resume', '', null);
}

console.log('\n/resume — an untrusted stored goal must never reach the resume directive\n');

(async () => {

await test('trusted checkpoint: the stored goal is passed onward', async () => {
    const res = await resumeWith({ originalGoal: TASK, goalSrc: 'turn' });
    assert.ok(res && res.__resumeFallthrough, 'expected a resume fall-through');
    assert.strictEqual(res.originalGoal, TASK);
});

await test('legacy checkpoint (no goalSrc): goal suppressed', async () => {
    // A pre-fix checkpoint still holds the wrong value ("Hey girl"). It must not
    // become ORIGINAL USER REQUEST; the model gets the history fallback instead.
    const res = await resumeWith({ originalGoal: LEGACY_GOAL });
    assert.ok(res && res.__resumeFallthrough);
    assert.strictEqual(res.originalGoal, null, 'legacy goal must be suppressed');
});

await test('bogus provenance: goal suppressed', async () => {
    const res = await resumeWith({ originalGoal: TASK, goalSrc: 'bogus' });
    assert.strictEqual(res.originalGoal, null);
});

await test('redaction-marked goal (OQ2): suppressed', async () => {
    // task-store sets goalSrc='redacted' when redactSecrets altered the goal, so
    // the stored text no longer represents the request.
    const res = await resumeWith({ originalGoal: 'ask-***', goalSrc: 'redacted' });
    assert.strictEqual(res.originalGoal, null);
});

await test('non-string stored goal: suppressed, and does not throw', async () => {
    for (const bad of [12345, {}, true]) {
        const res = await resumeWith({ originalGoal: bad, goalSrc: 'turn' });
        assert.strictEqual(res.originalGoal, null, `expected suppression for ${JSON.stringify(bad)}`);
    }
});

await test('NEGATIVE CONTROL: the suppressed cases still carry the same stored value', async () => {
    // Proves suppression is the gate's doing, not an empty fixture. Each case above
    // has a truthy originalGoal on the checkpoint; only provenance differs.
    const legacy = { originalGoal: LEGACY_GOAL };
    const trusted = { originalGoal: LEGACY_GOAL, goalSrc: 'turn' };
    assert.strictEqual((await resumeWith(legacy)).originalGoal, null);
    assert.strictEqual((await resumeWith(trusted)).originalGoal, LEGACY_GOAL,
        'same string, trusted provenance -> passed onward');
});

await test('the resumed-from taskId is still forwarded in every case', async () => {
    // Suppressing the goal must not break the rest of the resume contract.
    for (const fields of [{ originalGoal: TASK, goalSrc: 'turn' }, { originalGoal: LEGACY_GOAL }]) {
        const res = await resumeWith(fields);
        assert.strictEqual(res.resumedFromTaskId, 'tk1');
    }
});

try { fs.rmSync(tmpRoot, { recursive: true, force: true }); } catch { /* best effort */ }

if (failed > 0) {
    console.error(`\nFAIL: resume-goal-provenance.test.js — ${failed} failed, ${passed} passed\n`);
} else {
    console.log(`\nPASS: resume-goal-provenance.test.js (${passed} assertions)\n`);
}

})();
