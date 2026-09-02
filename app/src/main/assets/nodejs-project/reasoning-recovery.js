// SeekerClaw — reasoning-recovery.js (BAT-549)
//
// Adaptive 3-step quarantine recovery for active conversations stuck in a
// reasoning-content 400 loop. Codex v4.1 finding 2+3:
//
//  Step 1 — narrow cut: last user-message boundary
//  Step 2 — widen: earliest provider-relevant assistant tool-call turn
//           in the active segment; widen on ambiguity
//  Step 3 — fallback: full conversation reset
//
// PLUS active task-store checkpoint quarantine: each step ALSO mutates the
// persisted `task-store/<taskId>.json` so a future `/resume` can't reload
// the original bad slice. (task-store files are keyed by `taskId`, not
// `chatId` — Copilot R1 thread 2 doc fix.) The pre-quarantine checkpoint
// is copied to `recovery/<chatId>-<timestamp>-stepN-checkpoint.json` for
// forensics; the recovery file uses the chatId because forensic files are
// per-conversation rather than per-task.
//
// User data ALWAYS preserved: workspace, memory files (MEMORY.md, daily/,
// SOUL.md, IDENTITY.md, USER.md), skills, config, credentials, checkpoints
// for OTHER chats, task-store entries for OTHER chats, cron jobs.

'use strict';

const fs = require('fs');
const path = require('path');

const REASONING_400_PATTERN = /reasoning[_-]?content.*passed\s*back/i;

/**
 * Inspect an HTTP error data payload and decide whether it's the
 * "reasoning_content must be passed back" 400. Cheap regex over the
 * provider's error message string.
 */
// Cap the regex-match window for fallback stringify / Buffer decoding.
// Provider error bodies that mention reasoning_content are ~50-200 chars
// (e.g. DeepSeek's "The 'reasoning_content' in the thinking mode must be
// passed back to the API.") — 4 KB is generous and bounds memory if a
// caller passes a giant blob.
const _REASONING_400_SCAN_LIMIT = 4096;

function isReasoningContent400(status, data) {
    if (status !== 400) return false;
    if (!data) return false;
    const candidates = [];
    if (typeof data === 'string') {
        candidates.push(data.length > _REASONING_400_SCAN_LIMIT
            ? data.slice(0, _REASONING_400_SCAN_LIMIT)
            : data);
    } else if (Buffer.isBuffer(data)) {
        // 2c Copilot R1: skip JSON.stringify(Buffer) — that would expand
        // to `{type:"Buffer",data:[...]}` and blow up on large bodies.
        // Decode at most _REASONING_400_SCAN_LIMIT bytes as utf-8 (lossy
        // for non-text bodies, which is fine — they wouldn't match the
        // English-language regex anyway).
        candidates.push(data.toString('utf8', 0, Math.min(data.length, _REASONING_400_SCAN_LIMIT)));
    } else if (typeof data === 'object') {
        // 2c Copilot R2: rely on STRUCTURED fields only. Previous version
        // had a `JSON.stringify(data)` fallback as a last-ditch regex
        // surface, but JSON.stringify itself is unbounded on input — a
        // 10MB error blob would be fully serialized before the slice. All
        // production providers we care about (Anthropic, OpenAI,
        // OpenRouter, DeepSeek/Custom) put the human-readable error
        // message on `error.message` or `message`. If a future provider
        // surfaces it elsewhere, we'll add an explicit field here rather
        // than re-introducing the unbounded fallback.
        if (data.error && typeof data.error.message === 'string') {
            candidates.push(data.error.message.length > _REASONING_400_SCAN_LIMIT
                ? data.error.message.slice(0, _REASONING_400_SCAN_LIMIT)
                : data.error.message);
        }
        if (typeof data.message === 'string') {
            candidates.push(data.message.length > _REASONING_400_SCAN_LIMIT
                ? data.message.slice(0, _REASONING_400_SCAN_LIMIT)
                : data.message);
        }
    }
    return candidates.some((s) => REASONING_400_PATTERN.test(s));
}

/**
 * Step 1 cut point: index AFTER the last user-role message in the active
 * segment. Slice from this index to get the volatile tail. Returns -1 if
 * no user message found — caller escalates step 1 to step 2 first
 * (escalate-by-one), and only falls through to step 3 if step 2 also
 * returns ok=false. R3 doc fix to match actual recovery driver semantics
 * in `quarantineActiveSegment` + the no-op handling in ai.js's chat()
 * loop (which calls step 2 immediately when step 1 returns ok=false).
 */
function findLastUserBoundary(messages) {
    if (!Array.isArray(messages)) return -1;
    for (let i = messages.length - 1; i >= 0; i--) {
        const m = messages[i];
        if (m && m.role === 'user') return i + 1;
    }
    return -1;
}

/**
 * Step 2 cut point: index of the EARLIEST assistant turn that has tool_calls
 * (Codex v4.1 finding 2: "earliest provider-relevant assistant tool-call
 * turn in the active segment", widen on ambiguity → the FIRST one wins).
 * Returns -1 if no candidate (caller falls through to step 3).
 */
function findEarliestAssistantToolCallIndex(messages) {
    if (!Array.isArray(messages)) return -1;
    for (let i = 0; i < messages.length; i++) {
        const m = messages[i];
        if (!m || m.role !== 'assistant') continue;
        const hasNeutralToolCalls = Array.isArray(m.toolCalls) && m.toolCalls.length > 0;
        const hasClaudeToolUse = Array.isArray(m.content)
            && m.content.some((b) => b && b.type === 'tool_use');
        if (hasNeutralToolCalls || hasClaudeToolUse) return i;
    }
    return -1;
}

/**
 * BAT-1290 D5: staging and publication are SEPARATE steps.
 *
 * The checkpoint repair must remove a poisoned `.bak` BETWEEN writing the
 * repaired JSON and publishing it over the primary. Publishing first opens a
 * window where a repaired primary sits beside a poisoned backup, and
 * `loadCheckpoint` falls back to that backup when the primary is unreadable
 * (task-store.js:192) — the bad slice could be resurrected.
 *
 * Two-file atomicity is not available; the achievable guarantee is
 * crash-consistent ORDERING:
 *     forensic copy -> stage -> remove/quarantine .bak -> publish primary
 *
 * A crash between stage and publish leaves an unpublished `.tmp` that
 * loadCheckpoint neither reads nor enumerates (it reads primary, then `.bak`),
 * so no half-written checkpoint is ever loadable.
 */
function stageJson(filePath, obj) {
    const dir = path.dirname(filePath);
    fs.mkdirSync(dir, { recursive: true });
    const tmp = filePath + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(obj, null, 2), 'utf8');
    return tmp;
}

function publishStaged(tmpPath, filePath) {
    fs.renameSync(tmpPath, filePath);
}

/**
 * Combined stage+publish. Retained for the forensic quarantine write, whose
 * behaviour is unchanged; the checkpoint repair path uses the split form.
 */
function writeJsonAtomic(filePath, obj) {
    publishStaged(stageJson(filePath, obj), filePath);
}

/** BAT-1290 D2: the structured checkpoint outcome. Every return path sets one. */
function _cp(status, reason, cpPath) {
    return { status, reason: reason || null, path: cpPath || null };
}

/**
 * BAT-1290 D4: move an unrepairable checkpoint OUT of the resumable directory
 * so a future /resume cannot reload it. Timestamped + step + which file, with
 * an exclusive-create suffix so repeated quarantines of the same task cannot
 * collide.
 */
function _quarantineFile(src, recoveryDir, safeTask, step, kind, now) {
    fs.mkdirSync(recoveryDir, { recursive: true });
    const base = `${now}-${safeTask}-step${step}-${kind}`;
    for (let i = 0; i < 50; i++) {
        const dest = path.join(recoveryDir, i === 0 ? `${base}.json` : `${base}-${i}.json`);
        if (!_isUnderDir(dest, recoveryDir)) return null;
        try {
            // 'wx' fails if the path exists — collision-resistant by construction.
            const fd = fs.openSync(dest, 'wx');
            try { fs.writeFileSync(fd, fs.readFileSync(src)); } finally { fs.closeSync(fd); }
            fs.unlinkSync(src);
            return dest;
        } catch (e) {
            if (e && e.code === 'EEXIST') continue;
            throw e;
        }
    }
    return null;
}

// Copilot 2b finding: chatId comes from a Telegram-platform-provided value
// and resumedFromTaskId is loaded from on-disk JSON — either could in
// principle contain `/`, `..`, NUL, or other path-shaping characters. Strict
// allowlist prevents path traversal: only [A-Za-z0-9_-], capped length, with
// a non-empty fallback for inputs that sanitize to empty.
function _sanitizePathComponent(input, maxLen = 64) {
    const str = (typeof input === 'number' || typeof input === 'string') ? String(input) : '';
    const cleaned = str.replace(/[^A-Za-z0-9_-]/g, '_').slice(0, maxLen);
    return cleaned.length > 0 ? cleaned : 'x';
}

// Verify a candidate path resolves under the expected base directory.
// Defense-in-depth on top of _sanitizePathComponent — if the sanitization
// somehow lets a traversal through (or fileBase logic regresses), this
// catches it before we write/copy. Both inputs are normalized via
// path.resolve so symlink/.. funkiness is collapsed before comparison.
function _isUnderDir(candidate, baseDir) {
    const resolvedCandidate = path.resolve(candidate);
    const resolvedBase = path.resolve(baseDir);
    if (resolvedCandidate === resolvedBase) return true;
    return resolvedCandidate.startsWith(resolvedBase + path.sep);
}

/**
 * Compute the cut index for a given step against a given messages array.
 * Returns -1 if the step has no valid cut point against this input
 * (caller should escalate to the next step).
 */
function computeCutIndex(messages, step) {
    if (step === 1) return findLastUserBoundary(messages);
    if (step === 2) return findEarliestAssistantToolCallIndex(messages);
    return 0; // step 3 = full reset
}

/**
 * Run ONE step of adaptive quarantine recovery.
 *
 * @param {object} ctx
 * @param {string|number} ctx.chatId — for naming recovery files
 * @param {Array}  ctx.messages — current in-memory messages array (NOT mutated)
 * @param {string} ctx.workDir — filesystem root (for recovery/ + task-store/)
 * @param {number} ctx.step — 1, 2, or 3
 * @param {function} [ctx.log] — optional logger
 * @param {string} [ctx.taskId] — task id for active checkpoint quarantine
 * @param {function} [ctx.now] — clock injection for tests; defaults to Date.now
 *
 * @returns {object}
 *   - newMessages : truncated messages array (NEW array; caller reassigns)
 *   - systemNote : user-visible system note string (or null on no-op)
 *   - quarantinePath : path to written recovery file (or null on write failure)
 *   - checkpointPath : path to forensic checkpoint copy (or null)
 *   - ok : true if step actually truncated; false → caller escalates
 *   - cutIndex : the index used; -1 means no-op
 */
/**
 * BAT-1290: repair (or quarantine) the persisted checkpoint for `taskId`.
 *
 * Previously this probed `path.join(workDir, 'task-store')` while checkpoints
 * live at `config.TASKS_DIR = <workDir>/tasks`, so `fs.existsSync` was ALWAYS
 * false and the on-disk half of recovery never ran on a device — silently,
 * because the block had no else. The canonical directory is now INJECTED
 * (D1); this module never re-derives it from workDir.
 *
 * @returns {{status: string, reason: string|null, path: string|null}}
 */
function _repairCheckpoint(o) {
    const { tasksDir, taskId, checkpointKind, recoveryDir, fileBase, step, now, log, safeTask } = o;

    // D1: never fall back to a derived path — that drift is the whole bug.
    if (!tasksDir) {
        log(`[ReasoningRecovery] Step ${step} checkpoint rejected — no tasksDir supplied (caller bug)`, 'WARN');
        return _cp('rejected', 'no-tasks-dir');
    }
    // D4: the kind decides policy; defaulting it would silently disable the
    // resumed-path quarantine, which is the point of this work.
    if (checkpointKind !== 'current' && checkpointKind !== 'resumed') {
        log(`[ReasoningRecovery] Step ${step} checkpoint failed — invalid checkpointKind=${String(checkpointKind)}`, 'WARN');
        return _cp('failed', 'invalid-checkpoint-kind');
    }

    const primary = path.join(tasksDir, `${taskId}.json`);
    const backup = primary + '.bak';
    if (!_isUnderDir(primary, tasksDir)) {
        log(`[ReasoningRecovery] Step ${step} checkpoint rejected — taskId escapes tasksDir (sanitized=${safeTask})`, 'WARN');
        return _cp('rejected', 'path-escape');
    }

    const hasPrimary = fs.existsSync(primary);
    const hasBackup = fs.existsSync(backup);

    // D2: `absent` means BOTH are gone. A backup-only checkpoint is still
    // loadable (task-store.js:192), so calling that "absent" would be a lie in
    // the dangerous direction.
    if (!hasPrimary && !hasBackup) {
        // D4: a resumed checkpoint is EXPECTED to exist; its absence is notable.
        log(`[ReasoningRecovery] Step ${step} checkpoint absent for ${checkpointKind} task`,
            checkpointKind === 'resumed' ? 'WARN' : 'DEBUG');
        return _cp('absent', 'no-file');
    }

    const source = hasPrimary ? primary : backup;

    // (a) forensic copy FIRST — it is the only record if repair fails.
    let forensic = null;
    try {
        const dest = path.join(recoveryDir, `${fileBase}-checkpoint.json`);
        if (_isUnderDir(dest, recoveryDir)) {
            fs.mkdirSync(recoveryDir, { recursive: true });
            fs.copyFileSync(source, dest);
            forensic = dest;
        }
    } catch (e) {
        log(`[ReasoningRecovery] Step ${step} forensic copy failed: ${e.message}`, 'WARN');
    }

    const unrepairable = (reason) => {
        if (checkpointKind !== 'resumed') return _cp('unchanged', reason, forensic);
        // D4: a resumed checkpoint that cannot be repaired must not stay
        // resumable — it is SUSPECTED poisoned, and reloading it re-triggers
        // the same 400. Forensic copy is already taken.
        try {
            if (hasPrimary) _quarantineFile(primary, recoveryDir, safeTask, step, 'primary', now);
            if (fs.existsSync(backup)) _quarantineFile(backup, recoveryDir, safeTask, step, 'bak', now);
            log(`[ReasoningRecovery] Step ${step} quarantined resumed checkpoint (${reason})`, 'WARN');
            return _cp('quarantined', reason, forensic);
        } catch (e) {
            log(`[ReasoningRecovery] Step ${step} quarantine FAILED: ${e.message}`, 'ERROR');
            return _cp('failed', 'quarantine-failed', forensic);
        }
    };

    let cp;
    try {
        cp = JSON.parse(fs.readFileSync(source, 'utf8'));
    } catch (e) {
        log(`[ReasoningRecovery] Step ${step} checkpoint parse failed: ${e.message}`, 'WARN');
        return unrepairable('parse-failed');
    }

    // JSON.parse succeeds on `null`, on bare primitives and on arrays, none of
    // which survive the field reads below. `null` is the dangerous one: the
    // TypeError escapes _repairCheckpoint AND quarantineActiveSegment, so the
    // structured outcome is lost and the quarantine never runs -- the exact
    // failure this ticket exists to remove. Primitives and arrays did not throw
    // but reported 'no-cut-point', which misstates the cause in the forensic
    // record. A checkpoint that is not a JSON object is a parse failure.
    if (!cp || typeof cp !== 'object' || Array.isArray(cp)) {
        log(`[ReasoningRecovery] Step ${step} checkpoint is not a JSON object`, 'WARN');
        return unrepairable('parse-failed');
    }

    // D3: the marker is stamped ONLY when the slice actually shrank. The old
    // code stamped it unconditionally, recording a repair that never happened.
    let shrank = false;
    if (Array.isArray(cp.conversationSlice)) {
        const cpCut = computeCutIndex(cp.conversationSlice, step);
        if (cpCut >= 0 && cpCut < cp.conversationSlice.length) {
            cp.conversationSlice = cp.conversationSlice.slice(0, cpCut);
            shrank = true;
        }
    }
    if (!shrank) return unrepairable('no-cut-point');

    cp.updatedAt = now;
    cp.recoveryQuarantineStep = step;
    cp.recoveryQuarantinedAt = new Date(now).toISOString();

    // (b) stage -> (c) drop the poisoned backup -> (d) publish primary.
    // NOT task-store.saveCheckpoint(): it copies the existing primary into
    // .bak before publishing (task-store.js:156-165), which would re-poison
    // the backup with the very slice being removed.
    try {
        const tmp = stageJson(primary, cp);
        if (fs.existsSync(backup)) fs.unlinkSync(backup);
        publishStaged(tmp, primary);
    } catch (e) {
        log(`[ReasoningRecovery] Step ${step} checkpoint write failed: ${e.message}`, 'WARN');
        return unrepairable('write-failed');
    }

    log(`[ReasoningRecovery] Step ${step} repaired ${checkpointKind} checkpoint ${primary}`, 'INFO');
    return _cp('repaired', 'slice-truncated', forensic);
}

function quarantineActiveSegment(ctx) {
    // BAT-1290 D1/D4: tasksDir is INJECTED (never derived from workDir here) and
    // checkpointKind is REQUIRED — see _repairCheckpoint.
    const { chatId, messages, workDir, step, taskId, tasksDir, checkpointKind } = ctx;
    const log = ctx.log || (() => {});
    const now = (ctx.now || Date.now)();

    if (!Array.isArray(messages)) {
        return { newMessages: messages, systemNote: null, quarantinePath: null, checkpointPath: null, ok: false, cutIndex: -1,
                 checkpoint: _cp('skipped', 'invalid-messages') };
    }

    const cutIndex = computeCutIndex(messages, step);

    // No-op detection: step 1/2 may not find a valid cut point. Step 3
    // (cutIndex=0) is always valid — it resets the whole conversation.
    if (cutIndex < 0) {
        return { newMessages: messages, systemNote: null, quarantinePath: null, checkpointPath: null, ok: false, cutIndex: -1,
                 checkpoint: _cp('skipped', 'no-cut-point') };
    }
    if (step !== 3 && cutIndex >= messages.length) {
        // Cut point is at or past the tail — nothing to truncate
        return { newMessages: messages, systemNote: null, quarantinePath: null, checkpointPath: null, ok: false, cutIndex,
                 checkpoint: _cp('skipped', 'tail-noop') };
    }

    // R2 thread 2: step 1 was "lost in an upgrade" — but the recovery
    // trigger is a provider 400, which can fire for reasons other than
    // an app upgrade (provider-side contract changes, misconfig, model
    // switch mid-conversation, etc.). Neutral wording stays accurate
    // for all trigger cases.
    const systemNote = step === 1
        ? 'Conversation state could not be recovered after a provider error. Continuing from your last message; long-term memory and skills are preserved.'
        : step === 2
            ? 'Earlier conversation could not be recovered after a provider error. Continuing with a wider truncation; long-term memory and skills are preserved.'
            : 'Earlier reasoning state could not be recovered. Conversation reset; long-term memory and skills are preserved.';

    const keptPrefix = messages.slice(0, cutIndex);
    const quarantinedSlice = messages.slice(cutIndex);
    const recoveryDir = path.join(workDir, 'recovery');
    // R7 thread 1: include taskId in the filename so two calls within
    // the same millisecond (ai.js's recovery loop hits both fresh and
    // resumed-from taskIds when /resume triggers a 400) don't overwrite
    // each other's forensic files.
    // 2b Copilot: chatId (platform-provided) and taskId (loaded from
    // on-disk JSON via /resume's resumedFromTaskId) are NOT trusted
    // path components. Sanitize before interpolation, then verify the
    // resolved write path stays under recoveryDir. Both inputs sanitize
    // to a-zA-Z0-9_- only, capped at 64 chars.
    const safeChat = _sanitizePathComponent(chatId);
    const safeTask = taskId ? _sanitizePathComponent(taskId) : 'no-task';
    const taskTag = `-${safeTask}`;
    const fileBase = `${safeChat}-${now}-step${step}${taskTag}`;
    const quarantinePath = path.join(recoveryDir, `${fileBase}.json`);
    if (!_isUnderDir(quarantinePath, recoveryDir)) {
        log(`[ReasoningRecovery] Step ${step} aborted — sanitized path escapes recoveryDir (chatId=${safeChat} taskId=${safeTask})`, 'ERROR');
        return { newMessages: keptPrefix, systemNote, quarantinePath: null, checkpointPath: null, ok: true, cutIndex };
    }

    let quarantineWritten = null;
    try {
        writeJsonAtomic(quarantinePath, {
            schemaVersion: 1,
            recoveryStep: step,
            chatId: String(chatId),
            quarantinedAt: new Date(now).toISOString(),
            cutIndex,
            originalLength: messages.length,
            quarantinedLength: quarantinedSlice.length,
            quarantinedSlice,
        });
        quarantineWritten = quarantinePath;
        log(`[ReasoningRecovery] Step ${step} quarantined ${quarantinedSlice.length} messages → ${quarantinePath}`, 'INFO');
    } catch (e) {
        log(`[ReasoningRecovery] Step ${step} forensic write failed: ${e.message}`, 'WARN');
    }

    // BAT-1290: the on-disk half of recovery. Previously probed
    // `path.join(workDir, 'task-store')` — a directory nothing creates — so it
    // never ran on a device, silently. The canonical dir is now injected.
    let checkpointPath = null;
    let checkpointOutcome = _cp('skipped', 'no-task-id');
    if (taskId) {
        checkpointOutcome = _repairCheckpoint({
            tasksDir, taskId, checkpointKind, recoveryDir, fileBase, step, now, log, safeTask,
        });
        checkpointPath = checkpointOutcome.path;
    }

    return {
        checkpoint: checkpointOutcome,
        newMessages: keptPrefix,
        systemNote,
        quarantinePath: quarantineWritten,
        checkpointPath,
        ok: true,
        cutIndex,
    };
}

module.exports = {
    _repairCheckpoint,
    stageJson,
    publishStaged,
    isReasoningContent400,
    findLastUserBoundary,
    findEarliestAssistantToolCallIndex,
    computeCutIndex,
    quarantineActiveSegment,
    REASONING_400_PATTERN,
};
