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

// 2c Copilot: Buffer body handling — must NOT JSON.stringify the buffer
ok('Buffer body containing the trigger phrase IS detected',
    recovery.isReasoningContent400(400,
        Buffer.from('Some HTML <p>reasoning_content must be passed back</p>', 'utf8')));
ok('Buffer body without trigger is NOT detected',
    !recovery.isReasoningContent400(400, Buffer.from('not relevant error', 'utf8')));

// Bounded scan: trigger phrase BEYOND the 4KB scan limit must NOT be
// detected. Functional / deterministic assertion of bounded behavior —
// replaces R1's wall-clock timing test which was flaky on slower CI
// machines (2c R2 Copilot thread 1).
const paddedBuf = Buffer.concat([
    Buffer.alloc(8192, 0x41), // 8 KB of 'A' filler — well past 4 KB limit
    Buffer.from('reasoning_content must be passed back', 'utf8'),
]);
ok('Trigger phrase beyond 4KB scan limit is NOT detected (proves bounded scan)',
    !recovery.isReasoningContent400(400, paddedBuf));

// Sanity: same phrase WITHIN the scan limit IS detected
const withinLimitBuf = Buffer.concat([
    Buffer.alloc(100, 0x41),
    Buffer.from('reasoning_content must be passed back', 'utf8'),
]);
ok('Trigger phrase within scan limit IS detected',
    recovery.isReasoningContent400(400, withinLimitBuf));

// Large buffer + no trigger → returns false without crashing/hanging
const bigBuf = Buffer.alloc(1024 * 1024, 0x41); // 1 MB of 'A'
ok('Large Buffer (1MB, no trigger) returns false without crash',
    recovery.isReasoningContent400(400, bigBuf) === false);
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
// R7 thread 1: filename includes taskId so concurrent quarantines (e.g.
// fresh + resumedFromTaskId in the same ms) don't overwrite each other.
ok('step 1 quarantine file exists with taskId in name',
    fs.existsSync(path.join(tmpRoot, 'recovery', '12345-1700000000000-step1-task-abc.json')));
ok('step 1 forensic checkpoint exists',
    fs.existsSync(path.join(tmpRoot, 'recovery', '12345-1700000000000-step1-task-abc-checkpoint.json')));

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

console.log();
console.log('── R4 thread 1: ai.js _applyRecovery semantics (current user preserved, no systemNote in prompt) ──');
// This pins the v4.1 R4 invariant for ai.js's _applyRecovery helper.
// We replicate its exact splice+re-append logic against a quarantine
// result and assert: (1) the current user message is the LAST user-role
// entry, (2) the systemNote is NOT present in the messages array.
const _applyRecoveryReplica = (messages, userMessage, result) => {
    messages.splice(0, messages.length, ...result.newMessages);
    const last = messages[messages.length - 1];
    const lastIsCurrentUser = last
        && last.role === 'user'
        && typeof last.content === 'string'
        && last.content === userMessage;
    if (!lastIsCurrentUser) {
        messages.push({ role: 'user', content: userMessage });
    }
    // Do NOT inject systemNote — recovery metadata only
};

// Step 2 quarantine removes the current user prompt — _applyRecovery must re-append.
const userMessageS2 = 'second question';  // matches sampleConv[4].content
const liveMessagesS2 = sampleConv.slice();
const step2result = recovery.quarantineActiveSegment({
    chatId: 'r4-step2',
    messages: liveMessagesS2,
    workDir: tmpRoot,
    step: 2,
    taskId: null,
    now: () => 1700000000005,
});
ok('Step 2 quarantine ok=true', step2result.ok === true);
ok('Step 2 newMessages does NOT include current user prompt (was removed)',
    step2result.newMessages.every((m) => !(m.role === 'user' && m.content === userMessageS2)));
_applyRecoveryReplica(liveMessagesS2, userMessageS2, step2result);
const lastS2 = liveMessagesS2[liveMessagesS2.length - 1];
ok('After _applyRecovery: last message is the current user prompt',
    lastS2 && lastS2.role === 'user' && lastS2.content === userMessageS2);
ok('After _applyRecovery: systemNote NOT injected as a user message',
    !liveMessagesS2.some((m) => typeof m.content === 'string'
        && m.content.includes(step2result.systemNote)));

// Step 1 quarantine PRESERVES the current user prompt — _applyRecovery must NOT duplicate.
const userMessageS1 = 'second question';
const liveMessagesS1 = sampleConv.slice();
const step1result = recovery.quarantineActiveSegment({
    chatId: 'r4-step1',
    messages: liveMessagesS1,
    workDir: tmpRoot,
    step: 1,
    taskId: null,
    now: () => 1700000000006,
});
ok('Step 1 newMessages still has current user prompt as last',
    step1result.newMessages[step1result.newMessages.length - 1].content === userMessageS1);
const beforeReplicaLenS1 = step1result.newMessages.length;
_applyRecoveryReplica(liveMessagesS1, userMessageS1, step1result);
ok('After _applyRecovery (step 1): no duplicate user prompt appended',
    liveMessagesS1.length === beforeReplicaLenS1,
    `expected ${beforeReplicaLenS1}, got ${liveMessagesS1.length}`);

// Step 3 full reset — _applyRecovery must re-append the user prompt.
const userMessageS3 = 'fresh start question';
const liveMessagesS3 = sampleConv.slice();
const step3result = recovery.quarantineActiveSegment({
    chatId: 'r4-step3',
    messages: liveMessagesS3,
    workDir: tmpRoot,
    step: 3,
    taskId: null,
    now: () => 1700000000007,
});
eq('Step 3 newMessages is empty', step3result.newMessages.length, 0);
_applyRecoveryReplica(liveMessagesS3, userMessageS3, step3result);
eq('After _applyRecovery (step 3): exactly one user-role message',
    liveMessagesS3.filter((m) => m.role === 'user').length, 1);
ok('After _applyRecovery (step 3): the lone user message is the current prompt',
    liveMessagesS3[0].role === 'user' && liveMessagesS3[0].content === userMessageS3);

console.log();
console.log('── R7 thread 2: _applyRecovery handles array-content userMessage (vision) ──');
// Replicate ai.js's _userMessageEq + _applyRecovery for arrays/objects.
// Vision flow: userMessage is an array of content blocks. After splice
// the spliced array contains a copy via spread, so reference equality
// fails AND the original userMessage object/array is needed for
// comparison.
// R8 thread 2: production uses cheap `===` (reference equality).
// addToConversation adopts `userMessage` by reference and splice
// preserves entries by reference, so reference equality is correct
// and OOM-safe even for multi-MB image-block payloads.
const _userMessageEqReplica = (a, b) => a === b;
const _applyRecoveryArrayReplica = (messages, userMessage, result) => {
    messages.splice(0, messages.length, ...result.newMessages);
    const last = messages[messages.length - 1];
    const lastIsCurrentUser = last
        && last.role === 'user'
        && _userMessageEqReplica(last.content, userMessage);
    if (!lastIsCurrentUser) {
        messages.push({ role: 'user', content: userMessage });
    }
};

// Vision-shape userMessage: array of content blocks
const visionUserMessage = [
    { type: 'text', text: 'What is in this image?' },
    { type: 'image_url', image_url: { url: 'data:image/png;base64,XXXX' } },
];
// Step 1 path: last user message in conv has the SAME array content
const visionConv = [
    { role: 'user', content: visionUserMessage },
];
// Run quarantine step 1 (cuts after last user → newMessages includes the user)
const visionStep1 = recovery.quarantineActiveSegment({
    chatId: 'vision-test', messages: visionConv, workDir: tmpRoot,
    step: 1, taskId: 'vt1', now: () => 1700000000222,
});
// Apply recovery — last message should NOT be duplicate-appended
const visionLive = visionConv.slice();
_applyRecoveryArrayReplica(visionLive, visionUserMessage, visionStep1);
const visionUsers = visionLive.filter((m) => m.role === 'user');
eq('Vision (array userMessage): step 1 preserves prompt without duplication',
    visionUsers.length, 1);

// Step 3 reset: array-userMessage gets re-appended exactly once
const visionStep3 = recovery.quarantineActiveSegment({
    chatId: 'vision-test', messages: visionConv, workDir: tmpRoot,
    step: 3, taskId: 'vt3', now: () => 1700000000223,
});
const visionLiveS3 = visionConv.slice();
_applyRecoveryArrayReplica(visionLiveS3, visionUserMessage, visionStep3);
const visionS3Users = visionLiveS3.filter((m) => m.role === 'user');
eq('Vision (array userMessage): step 3 re-appends exactly once',
    visionS3Users.length, 1);
ok('Vision (array userMessage): re-appended content matches original array shape',
    JSON.stringify(visionS3Users[0].content) === JSON.stringify(visionUserMessage));

// Mismatched arrays should NOT match: unrelated content array fails eq check
const otherArray = [{ type: 'text', text: 'totally different' }];
ok('Different arrays compare false (no false-positive match)',
    !_userMessageEqReplica(visionUserMessage, otherArray));

console.log();
console.log('── R7 thread 1: forensic file collision (same-ms double quarantine) ──');
// Replicate ai.js's recovery loop calling quarantineActiveSegment
// twice in the same ms — once for resumedFromTaskId, once for fresh
// taskId. Filenames MUST differ (taskId disambiguator).
const sameMs = 1700000000999;
const r1 = recovery.quarantineActiveSegment({
    chatId: 'race', messages: sampleConv, workDir: tmpRoot,
    step: 1, taskId: 'old-resumed', now: () => sameMs,
});
const r2 = recovery.quarantineActiveSegment({
    chatId: 'race', messages: sampleConv, workDir: tmpRoot,
    step: 1, taskId: 'new-fresh', now: () => sameMs,
});
ok('Both quarantines wrote distinct paths',
    r1.quarantinePath && r2.quarantinePath
    && r1.quarantinePath !== r2.quarantinePath,
    `r1=${r1.quarantinePath} r2=${r2.quarantinePath}`);
ok('Both forensic files coexist on disk',
    fs.existsSync(r1.quarantinePath) && fs.existsSync(r2.quarantinePath));

// Null-task case: no taskId → "no-task" tag (stable filename)
const r3 = recovery.quarantineActiveSegment({
    chatId: 'no-task-test', messages: sampleConv, workDir: tmpRoot,
    step: 1, taskId: null, now: () => 1700000000111,
});
ok('No-taskId quarantine still produces a valid file path',
    r3.quarantinePath && fs.existsSync(r3.quarantinePath));
ok('No-taskId path includes "no-task" disambiguator',
    r3.quarantinePath.includes('no-task'));

console.log();
console.log('── 2b Copilot: path-traversal defense on chatId/taskId ──');

// chatId with `..` and `/` characters MUST be sanitized; quarantine
// file MUST land under workDir/recovery, not somewhere outside.
const evilChat = '../../etc/passwd';
const evilTask = '../../../sneaky';
const evilStep1 = recovery.quarantineActiveSegment({
    chatId: evilChat,
    messages: sampleConv,
    workDir: tmpRoot,
    step: 1,
    taskId: evilTask,
    now: () => 1700000000888,
});
ok('Path traversal: quarantine still ok=true (sanitized, not blocked)',
    evilStep1.ok === true);
ok('Path traversal: file path stays under workDir/recovery',
    evilStep1.quarantinePath
        && evilStep1.quarantinePath.startsWith(path.join(tmpRoot, 'recovery') + path.sep));
ok('Path traversal: filename has no slashes or dots',
    evilStep1.quarantinePath
        && !path.basename(evilStep1.quarantinePath).includes('..')
        && !path.basename(evilStep1.quarantinePath).includes('/'));
ok('Path traversal: forensic file actually exists at sanitized path',
    fs.existsSync(evilStep1.quarantinePath));

// Verify nothing was written outside tmpRoot
const tmpRootParent = path.dirname(tmpRoot);
const evilEtcPasswd = path.join(tmpRootParent, '..', 'etc', 'passwd');
ok('Path traversal: nothing written outside tmpRoot (no /etc/passwd)',
    !fs.existsSync(evilEtcPasswd));

// chatId that sanitizes to empty (all special chars) gets fallback
const allSpecialChat = '////';
const fallbackStep1 = recovery.quarantineActiveSegment({
    chatId: allSpecialChat,
    messages: sampleConv,
    workDir: tmpRoot,
    step: 1,
    taskId: '////',
    now: () => 1700000000999,
});
ok('All-special-char chatId still produces a valid file (fallback "x")',
    fallbackStep1.quarantinePath
        && fallbackStep1.quarantinePath.startsWith(path.join(tmpRoot, 'recovery') + path.sep));

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
