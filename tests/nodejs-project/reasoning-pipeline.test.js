#!/usr/bin/env node
// reasoning-pipeline.test.js — pin BAT-549 v4.1 acceptance criteria:
//
//  - reasoningBlocks survives task-store.saveCheckpoint → loadCheckpoint
//  - Old checkpoints (no reasoningBlocks field) load without crash
//    (upgrade safety / forward compat)
//  - Old runtime_state.json shapes (BAT-513-only fields) merge cleanly
//    with new defaults (RuntimeState dual-side compat)
//  - Existing redactSecrets pass on save does not corrupt reasoningBlocks
//
// task-store.js is harder to require directly (depends on config.js's
// CONFIG_FILE path resolution). To smoke the persistence path, we shim
// the config require and exercise saveCheckpoint/loadCheckpoint with a
// real tmp dir and a synthetic conversation slice.
//
// Run:  node tests/nodejs-project/reasoning-pipeline.test.js

'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');

const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'bat549-pipeline-'));

// Shim config.js BEFORE requiring task-store. task-store loads security.js
// transitively, which reads `config` (the raw object) for redaction patterns,
// `BRIDGE_TOKEN`, and `workDir`. We provide minimum stubs.
const configPath = path.resolve(__dirname, '../../app/src/main/assets/nodejs-project/config.js');
const TASKS_DIR = path.join(tmpRoot, 'task-store');
fs.mkdirSync(TASKS_DIR, { recursive: true });
require.cache[configPath] = {
    id: configPath,
    filename: configPath,
    loaded: true,
    exports: {
        workDir: tmpRoot,
        log: () => {},
        config: {},
        BRIDGE_TOKEN: '',
        TASKS_DIR,
    },
};

const taskStore = require('../../app/src/main/assets/nodejs-project/task-store');

let failures = 0;
function ok(label, cond, hint = '') {
    if (cond) console.log(`PASS: ${label}`);
    else { console.log(`FAIL: ${label}${hint ? ' — ' + hint : ''}`); failures++; }
}
function eq(label, actual, expected) {
    const a = JSON.stringify(actual), e = JSON.stringify(expected);
    if (a === e) console.log(`PASS: ${label}`);
    else { console.log(`FAIL: ${label}\n  actual:   ${a}\n  expected: ${e}`); failures++; }
}

console.log('── Checkpoint round-trip preserves reasoningBlocks ──');

const reasoningBlock = {
    schemaVersion: 1,
    provider: 'custom',
    sourceAdapter: 'custom',
    delegateAdapter: 'openrouter',
    sourceModel: 'deepseek-v4-pro',
    turnId: 'cmpl_xyz',
    wire: { reasoning_content: 'I considered approach A, then chose B because of constraint X.' },
};

const conversationSlice = [
    { role: 'user', content: 'What is the weather in Tbilisi?' },
    {
        role: 'assistant',
        content: 'Let me check.',
        toolCalls: [{ id: 'tc1', name: 'weather', input: { city: 'Tbilisi' } }],
        reasoningBlocks: [reasoningBlock],
    },
    { role: 'tool', toolCallId: 'tc1', content: '{"temp":18}' },
];

const taskId = 'task-pipeline-001';
const saveResult = taskStore.saveCheckpoint(taskId, {
    taskId,
    chatId: '12345',
    conversationSlice,
    originalGoal: 'check weather',
});
ok('saveCheckpoint succeeded (durationMs ≥ 0)', typeof saveResult === 'number' && saveResult >= 0);

const loaded = taskStore.loadCheckpoint(taskId);
ok('loadCheckpoint returns object', loaded !== null && typeof loaded === 'object');
eq('loaded.taskId roundtrips', loaded.taskId, taskId);
eq('loaded.conversationSlice length preserved', loaded.conversationSlice.length, 3);

const loadedAssistant = loaded.conversationSlice.find((m) => m.role === 'assistant');
ok('loaded assistant message has reasoningBlocks',
    Array.isArray(loadedAssistant.reasoningBlocks) && loadedAssistant.reasoningBlocks.length === 1);
const loadedBlock = loadedAssistant.reasoningBlocks[0];
eq('loaded block.schemaVersion preserved', loadedBlock.schemaVersion, 1);
eq('loaded block.provider preserved', loadedBlock.provider, 'custom');
eq('loaded block.sourceAdapter preserved', loadedBlock.sourceAdapter, 'custom');
eq('loaded block.delegateAdapter preserved', loadedBlock.delegateAdapter, 'openrouter');
eq('loaded block.sourceModel preserved', loadedBlock.sourceModel, 'deepseek-v4-pro');
eq('loaded block.turnId preserved', loadedBlock.turnId, 'cmpl_xyz');
eq('loaded block.wire.reasoning_content verbatim',
    loadedBlock.wire.reasoning_content,
    'I considered approach A, then chose B because of constraint X.');

console.log();
console.log('── Old checkpoint (no reasoningBlocks) loads without crash ──');

const oldShapeTaskId = 'task-pre-bat549';
const oldShape = {
    taskId: oldShapeTaskId,
    chatId: '99999',
    // Pre-BAT-549 conversation slice: no `reasoningBlocks` field
    conversationSlice: [
        { role: 'user', content: 'hello' },
        { role: 'assistant', content: 'hi', toolCalls: [] },
    ],
    originalGoal: 'pre-existing checkpoint',
};
fs.writeFileSync(path.join(tmpRoot, 'task-store', `${oldShapeTaskId}.json`),
    JSON.stringify(oldShape, null, 2));

const loadedOld = taskStore.loadCheckpoint(oldShapeTaskId);
ok('Old-shape checkpoint loads without crash', loadedOld !== null);
eq('Old-shape conversationSlice intact', loadedOld.conversationSlice.length, 2);
ok('Old-shape assistant has no reasoningBlocks (graceful)',
    loadedOld.conversationSlice[1].reasoningBlocks === undefined);

console.log();
console.log('── Empty reasoningBlocks does not break save ──');
const emptyTaskId = 'task-empty-blocks';
const emptyResult = taskStore.saveCheckpoint(emptyTaskId, {
    taskId: emptyTaskId,
    chatId: '111',
    conversationSlice: [
        { role: 'user', content: 'q' },
        { role: 'assistant', content: 'a', toolCalls: [], reasoningBlocks: [] },
    ],
});
ok('save with empty reasoningBlocks succeeds', emptyResult >= 0);
const loadedEmpty = taskStore.loadCheckpoint(emptyTaskId);
ok('loaded empty reasoningBlocks is array',
    Array.isArray(loadedEmpty.conversationSlice[1].reasoningBlocks)
        && loadedEmpty.conversationSlice[1].reasoningBlocks.length === 0);

console.log();
console.log('── Persisted reasoningBlocks does not contain text from redactSecrets pattern ──');
// Existing task-store redactSecrets runs on `clone.content` strings only.
// Our reasoningBlocks live on a DIFFERENT field, so they pass through
// untouched. Verify by writing a block whose wire.reasoning_content
// happens to LOOK like a secret string and confirm it's preserved.
const lookalikeTaskId = 'task-redact-lookalike';
const lookalikeBlock = {
    ...reasoningBlock,
    wire: { reasoning_content: 'sk-test-FAKE-LOOKS-LIKE-A-KEY-AbCdEf-but-is-just-reasoning-text' },
};
taskStore.saveCheckpoint(lookalikeTaskId, {
    taskId: lookalikeTaskId,
    chatId: '222',
    conversationSlice: [
        { role: 'user', content: 'q' },
        { role: 'assistant', content: 'a', reasoningBlocks: [lookalikeBlock] },
    ],
});
const loadedLookalike = taskStore.loadCheckpoint(lookalikeTaskId);
const loadedLookalikeBlock = loadedLookalike.conversationSlice[1].reasoningBlocks[0];
eq('reasoning_content preserved verbatim through save/load (no spurious redaction)',
    loadedLookalikeBlock.wire.reasoning_content,
    'sk-test-FAKE-LOOKS-LIKE-A-KEY-AbCdEf-but-is-just-reasoning-text');

console.log();
console.log('── Backup file (.bak) is created on second save ──');
const cpDir = path.join(tmpRoot, 'task-store');
ok('Primary task-store/<taskId>.json exists',
    fs.existsSync(path.join(cpDir, `${taskId}.json`)));
// Second save creates .bak
taskStore.saveCheckpoint(taskId, {
    taskId,
    chatId: '12345',
    conversationSlice: conversationSlice.concat([{ role: 'user', content: 'follow-up' }]),
});
ok('Backup file <taskId>.json.bak exists after 2nd save',
    fs.existsSync(path.join(cpDir, `${taskId}.json.bak`)));

console.log();
console.log('── Stress: large reasoningBlocks survive trim to MAX_CONVERSATION_SLICE ──');
// Generate a long conversation (>8 entries — task-store trims to 8)
// with reasoningBlocks on every assistant turn.
const longConv = [];
for (let i = 0; i < 12; i++) {
    longConv.push({ role: 'user', content: `turn ${i}` });
    longConv.push({
        role: 'assistant',
        content: `response ${i}`,
        reasoningBlocks: [{ ...reasoningBlock, turnId: `gen-${i}` }],
    });
}
const longTaskId = 'task-long';
taskStore.saveCheckpoint(longTaskId, { taskId: longTaskId, chatId: '333', conversationSlice: longConv });
const loadedLong = taskStore.loadCheckpoint(longTaskId);
ok('Long conversation trimmed to <= MAX_CONVERSATION_SLICE',
    loadedLong.conversationSlice.length <= 8);
const trimmedAssistants = loadedLong.conversationSlice.filter((m) => m.role === 'assistant');
ok('All trimmed assistants still have reasoningBlocks',
    trimmedAssistants.every((m) => Array.isArray(m.reasoningBlocks) && m.reasoningBlocks.length === 1));

// Cleanup
try { fs.rmSync(tmpRoot, { recursive: true, force: true }); } catch (_) {}

console.log();
if (failures === 0) {
    console.log('ALL TESTS PASS');
    process.exit(0);
} else {
    console.log(`${failures} TEST(S) FAILED`);
    process.exit(1);
}
