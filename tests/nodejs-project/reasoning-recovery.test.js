#!/usr/bin/env node
// reasoning-recovery.test.js — pin BAT-549 v4.1 acceptance criteria for the
// adaptive 3-step quarantine recovery (Codex v4.1 finding 2 + 3):
//
//  - 400 detection by message regex
//  - Step 1 cuts at last user-message boundary
//  - Step 2 cuts at earliest provider-relevant assistant tool-call turn
//  - Step 3 fallback resets full conversation
//  - Forensic file written to recovery/<chatId>-<ts>-stepN.json
//  - Active task-store checkpoint quarantined + rewritten
//  - Memory/skills/cron/credentials/other-chat-checkpoints UNTOUCHED
//
// Run:  node tests/nodejs-project/reasoning-recovery.test.js

'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');

const recovery = require('../../app/src/main/assets/nodejs-project/reasoning-recovery');

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

console.log('── isReasoningContent400 — provider error message detection ──');
ok('DeepSeek V4 string in error.message',
    recovery.isReasoningContent400(400, { error: { message: "The 'reasoning_content' in the thinking mode must be passed back to the API." } }));
ok('Hyphen variant',
    recovery.isReasoningContent400(400, { error: { message: 'reasoning-content must be passed back' } }));
ok('Direct top-level message',
    recovery.isReasoningContent400(400, { message: 'reasoning_content must be passed back' }));
ok('Top-level string body',
    recovery.isReasoningContent400(400, 'reasoning_content must be passed back'));
ok('Embedded inside larger error JSON',
    recovery.isReasoningContent400(400, { error: { type: 'invalid_request_error', message: 'something something reasoning_content must be passed back something' } }));
ok('Other 400s are NOT recovery-triggers',
    !recovery.isReasoningContent400(400, { error: { message: 'invalid api key' } }));
ok('Non-400 status is never a trigger',
    !recovery.isReasoningContent400(500, { error: { message: 'reasoning_content must be passed back' } }));
ok('null data is safe',
    !recovery.isReasoningContent400(400, null));
ok('undefined data is safe',
    !recovery.isReasoningContent400(400, undefined));

console.log();
console.log('── findLastUserBoundary ──');
const sampleConv = [
    { role: 'user', content: 'first question' },
    { role: 'assistant', content: 'thinking', toolCalls: [{ id: 't1', name: 'echo', input: {} }] },
    { role: 'tool', toolCallId: 't1', content: 'ok' },
    { role: 'assistant', content: 'first answer' },
    { role: 'user', content: 'second question' },
    { role: 'assistant', content: 'reasoning...', toolCalls: [{ id: 't2', name: 'echo', input: {} }] },
    { role: 'tool', toolCallId: 't2', content: 'ok2' },
];
eq('lastUserBoundary points AFTER second user message',
    recovery.findLastUserBoundary(sampleConv), 5);
eq('No-user-messages → -1',
    recovery.findLastUserBoundary([{ role: 'assistant', content: 'a' }]), -1);
eq('Empty array → -1',
    recovery.findLastUserBoundary([]), -1);

console.log();
console.log('── findEarliestAssistantToolCallIndex ──');
eq('Finds FIRST tool-call assistant (widen on ambiguity)',
    recovery.findEarliestAssistantToolCallIndex(sampleConv), 1);
eq('No tool-call assistant → -1',
    recovery.findEarliestAssistantToolCallIndex([
        { role: 'user', content: 'q' },
        { role: 'assistant', content: 'plain answer' },
    ]), -1);
eq('Detects Claude-native tool_use blocks too',
    recovery.findEarliestAssistantToolCallIndex([
        { role: 'user', content: 'q' },
        { role: 'assistant', content: [{ type: 'tool_use', id: 't1', name: 'foo', input: {} }] },
    ]), 1);

console.log();
console.log('── quarantineActiveSegment — step 1 with sandbox dir ──');
const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'bat549-recovery-'));
fs.mkdirSync(path.join(tmpRoot, 'memory'), { recursive: true });
fs.writeFileSync(path.join(tmpRoot, 'memory', 'MEMORY.md'), '# memory must not be touched\n');
fs.writeFileSync(path.join(tmpRoot, 'SOUL.md'), '# soul must not be touched\n');
fs.mkdirSync(path.join(tmpRoot, 'skills'), { recursive: true });
fs.writeFileSync(path.join(tmpRoot, 'skills', 'foo.md'), '# skill must not be touched\n');
fs.mkdirSync(path.join(tmpRoot, 'task-store'), { recursive: true });
const otherChatCp = { taskId: 'other', chatId: 'other-chat', conversationSlice: [{ role: 'user', content: 'unrelated' }] };
fs.writeFileSync(path.join(tmpRoot, 'task-store', 'other.json'), JSON.stringify(otherChatCp));

const taskId = 'task-abc';
const activeCp = {
    taskId,
    chatId: '12345',
    conversationSlice: sampleConv.slice(),
    originalGoal: 'do the thing',
};
fs.writeFileSync(path.join(tmpRoot, 'task-store', `${taskId}.json`), JSON.stringify(activeCp));

const step1 = recovery.quarantineActiveSegment({
    chatId: '12345',
    messages: sampleConv,
    workDir: tmpRoot,
    step: 1,
    taskId,
    now: () => 1700000000000,
});
ok('step 1 ok=true', step1.ok === true);
eq('step 1 cutIndex points after last user message', step1.cutIndex, 5);
eq('step 1 newMessages length = 5', step1.newMessages.length, 5);
ok('step 1 systemNote present', typeof step1.systemNote === 'string' && step1.systemNote.length > 0);
ok('step 1 quarantinePath present', !!step1.quarantinePath);
ok('step 1 quarantine file exists',
    fs.existsSync(path.join(tmpRoot, 'recovery', '12345-1700000000000-step1.json')));
ok('step 1 forensic checkpoint exists',
    fs.existsSync(path.join(tmpRoot, 'recovery', '12345-1700000000000-step1-checkpoint.json')));

const writtenForensic = JSON.parse(fs.readFileSync(step1.quarantinePath, 'utf8'));
eq('forensic file: schemaVersion=1', writtenForensic.schemaVersion, 1);
eq('forensic file: recoveryStep=1', writtenForensic.recoveryStep, 1);
eq('forensic file: chatId preserved', writtenForensic.chatId, '12345');
eq('forensic file: cutIndex=5', writtenForensic.cutIndex, 5);
eq('forensic file: quarantinedLength=2', writtenForensic.quarantinedLength, 2);
ok('forensic file: quarantinedSlice is array', Array.isArray(writtenForensic.quarantinedSlice));

// Active checkpoint mutated to truncated state
const activeCpAfter = JSON.parse(fs.readFileSync(path.join(tmpRoot, 'task-store', `${taskId}.json`), 'utf8'));
eq('active checkpoint conversationSlice truncated to 5',
    activeCpAfter.conversationSlice.length, 5);
eq('active checkpoint recoveryQuarantineStep set', activeCpAfter.recoveryQuarantineStep, 1);
eq('active checkpoint originalGoal preserved', activeCpAfter.originalGoal, 'do the thing');

// Other chat's checkpoint UNTOUCHED
const otherCpAfter = JSON.parse(fs.readFileSync(path.join(tmpRoot, 'task-store', 'other.json'), 'utf8'));
eq('other-chat checkpoint untouched',
    otherCpAfter.conversationSlice[0].content, 'unrelated');
ok('other-chat checkpoint has NO recovery marker',
    otherCpAfter.recoveryQuarantineStep === undefined);

// Memory + skills + soul UNTOUCHED
ok('MEMORY.md untouched',
    fs.readFileSync(path.join(tmpRoot, 'memory', 'MEMORY.md'), 'utf8').includes('memory must not be touched'));
ok('SOUL.md untouched',
    fs.readFileSync(path.join(tmpRoot, 'SOUL.md'), 'utf8').includes('soul must not be touched'));
ok('skills/foo.md untouched',
    fs.readFileSync(path.join(tmpRoot, 'skills', 'foo.md'), 'utf8').includes('skill must not be touched'));

console.log();
console.log('── quarantineActiveSegment — step 2 widens past tool-call turn ──');
const step2 = recovery.quarantineActiveSegment({
    chatId: '12345',
    messages: sampleConv, // original sample (not the step1 truncated one)
    workDir: tmpRoot,
    step: 2,
    taskId,
    now: () => 1700000000001,
});
ok('step 2 ok=true', step2.ok === true);
eq('step 2 cutIndex points to first tool-call assistant', step2.cutIndex, 1);
eq('step 2 newMessages length = 1 (just the first user)', step2.newMessages.length, 1);

console.log();
console.log('── quarantineActiveSegment — step 3 full reset ──');
const step3 = recovery.quarantineActiveSegment({
    chatId: '12345',
    messages: sampleConv,
    workDir: tmpRoot,
    step: 3,
    taskId,
    now: () => 1700000000002,
});
ok('step 3 ok=true', step3.ok === true);
eq('step 3 cutIndex=0 (full reset)', step3.cutIndex, 0);
eq('step 3 newMessages empty', step3.newMessages.length, 0);

console.log();
console.log('── quarantineActiveSegment — no-op detection (should escalate) ──');
const noUserConv = [
    { role: 'assistant', content: 'orphan' },
];
const step1NoOp = recovery.quarantineActiveSegment({
    chatId: 'no-user',
    messages: noUserConv,
    workDir: tmpRoot,
    step: 1,
    taskId: null,
    now: () => 1700000000003,
});
ok('step 1 no user messages → ok=false (caller escalates to step 2)',
    step1NoOp.ok === false);

console.log();
console.log('── quarantineActiveSegment — pure (does not mutate input) ──');
const beforeLen = sampleConv.length;
recovery.quarantineActiveSegment({
    chatId: 'pure-test',
    messages: sampleConv,
    workDir: tmpRoot,
    step: 1,
    taskId: null,
    now: () => 1700000000004,
});
eq('input messages array NOT mutated by quarantine', sampleConv.length, beforeLen);

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
