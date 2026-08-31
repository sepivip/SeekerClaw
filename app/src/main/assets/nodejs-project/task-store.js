// task-store.js — Persistent task checkpoints (P2.2)
// Atomic write pattern (tmp → backup → rename) matching cron.js
// Durable: all writes are synchronous — checkpoint is on disk before returning.

const fs = require('fs');
const path = require('path');

const { TASKS_DIR, log } = require('./config');
const { redactSecrets } = require('./security');
const { GOAL_SCAN_UNSAFE_KEY } = require('./turn-goal');

const MAX_CHECKPOINT_AGE_MS = 7 * 24 * 60 * 60 * 1000; // 7 days
const MAX_CONVERSATION_SLICE = 8; // Keep last 8 messages in checkpoint

// ============================================================================
// CORE API
// ============================================================================

/**
 * Save a task checkpoint to disk (durable, atomic).
 * Returns write duration in ms for monitoring.
 */
function saveCheckpoint(taskId, state) {
    const start = Date.now();
    const filePath = path.join(TASKS_DIR, `${taskId}.json`);
    const tmpPath = filePath + '.tmp';

    try {
        // Trim conversation slice to prevent bloat, then clean orphans.
        // A tool_use (assistant) must always be followed by its tool_result (user).
        // If the slice boundary splits a pair, sanitizeConversation will strip
        // the orphan on restore and destroy context.
        const trimmed = { ...state };
        if (Array.isArray(trimmed.conversationSlice)) {
            // Step 1: trim to max size
            if (trimmed.conversationSlice.length > MAX_CONVERSATION_SLICE) {
                trimmed.conversationSlice = trimmed.conversationSlice.slice(-MAX_CONVERSATION_SLICE);
            }
            // Step 2: ALWAYS drop leading orphaned tool results (no matching tool call before them)
            // Handles both Claude-native (role:'user' + tool_result blocks) and neutral (role:'tool') formats
            while (trimmed.conversationSlice.length > 0) {
                const first = trimmed.conversationSlice[0];
                const isClaudeToolResult = first.role === 'user' && Array.isArray(first.content)
                    && first.content.some(b => b.type === 'tool_result');
                const isNeutralToolResult = first.role === 'tool';
                if (isClaudeToolResult || isNeutralToolResult) {
                    trimmed.conversationSlice = trimmed.conversationSlice.slice(1);
                } else {
                    break;
                }
            }
            // Step 3: drop trailing orphaned tool calls (no following tool result)
            // Handles both Claude-native (tool_use blocks) and neutral (toolCalls array) formats
            while (trimmed.conversationSlice.length > 0) {
                const last = trimmed.conversationSlice[trimmed.conversationSlice.length - 1];
                const isClaudeToolUse = last.role === 'assistant' && Array.isArray(last.content)
                    && last.content.some(b => b.type === 'tool_use');
                const isNeutralToolUse = last.role === 'assistant'
                    && Array.isArray(last.toolCalls) && last.toolCalls.length > 0;
                if (isClaudeToolUse || isNeutralToolUse) {
                    trimmed.conversationSlice.pop();
                } else {
                    break;
                }
            }
        }

        // Redact secrets from conversation slice before writing to disk (BAT-305)
        // Handles both Claude-native and neutral message formats
        if (Array.isArray(trimmed.conversationSlice)) {
            trimmed.conversationSlice = trimmed.conversationSlice.map(msg => {
                const clone = { ...msg };
                // BAT-1283: track whether redaction altered the text the goal scan
                // would READ (turn-goal's textOfContent: a string body, or the
                // first type:'text' block). Tool inputs and tool_result bodies are
                // redacted too but never feed the scan, so they must not taint the
                // message -- over-marking would disable a fallback that works.
                let textAltered = false;
                if (typeof clone.content === 'string') {
                    const redacted = redactSecrets(clone.content);
                    if (redacted !== clone.content) textAltered = true;
                    clone.content = redacted;
                } else if (Array.isArray(clone.content)) {
                    // textOfContent reads ONLY the FIRST type:'text' block, so only that
                    // block's alteration can mangle a scannable goal. Marking on any other
                    // redacted block (a later text block, or a non-text block carrying a
                    // .text field) would skip a message whose goal text is perfectly clean.
                    const scanIdx = clone.content.findIndex(b => b && b.type === 'text');
                    clone.content = clone.content.map((block, idx) => {
                        const b = { ...block };
                        if (typeof b.text === 'string') {
                            const redactedText = redactSecrets(b.text);
                            if (idx === scanIdx && redactedText !== b.text) textAltered = true;
                            b.text = redactedText;
                        }
                        if (typeof b.content === 'string') b.content = redactSecrets(b.content);
                        // Deep-redact tool_use input — Claude-native format
                        if (b.type === 'tool_use' && b.input && typeof b.input === 'object') {
                            b.input = _redactObject(b.input);
                        }
                        return b;
                    });
                }
                // Deep-redact toolCalls[].input — neutral format (OpenAI adapter)
                if (Array.isArray(clone.toolCalls)) {
                    clone.toolCalls = clone.toolCalls.map(tc => {
                        const t = { ...tc };
                        if (t.input && typeof t.input === 'object') {
                            t.input = _redactObject(t.input);
                        }
                        return t;
                    });
                }
                // Sticky: only ever set. A re-save spreads the existing marker
                // through `{...msg}` above, and redaction is idempotent, so a
                // second pass finds no further change to re-trigger it.
                if (textAltered) clone[GOAL_SCAN_UNSAFE_KEY] = true;
                return clone;
            });
        }
        if (typeof trimmed.originalGoal === 'string') {
            const redactedGoal = redactSecrets(trimmed.originalGoal);
            if (redactedGoal !== trimmed.originalGoal) {
                // BAT-1283 (OQ2): redaction ALTERED the goal, so the stored text no
                // longer faithfully represents the user's request. Measured: the
                // /sk-[a-zA-Z0-9_-]{20,}/ pattern (security.js:121) fires on any
                // kebab-case phrase whose word ends in "sk" — ask-, task-, risk- —
                // turning "ask-claude-to-summarise-this-long-document-please" into
                // "ask-***". Promoting that to ORIGINAL USER REQUEST would hand the
                // model authoritative nonsense, which is worse than omitting it.
                //
                // Mark it so the read sites fail closed. 'redacted' is deliberately
                // NOT a member of GOAL_SRC_VALUES (turn-goal.js), so goalIsTrusted()
                // rejects it with no change to that function. Distinguishable from a
                // legacy checkpoint, where the key is absent entirely.
                //
                // Only ever SET, never cleared: redactSecrets is idempotent, so a
                // re-save (main.js:405-406 attempt bump, markComplete round-trip)
                // sees no further change and the mark survives.
                trimmed.goalSrc = 'redacted';
                // Drop the mangled text rather than persisting it. On a post-fix
                // build 'redacted' already fails the gate, so nothing is lost; on
                // a DOWNGRADED build, which knows nothing about goalSrc, a stored
                // "ask-***" would be replayed verbatim as the original request.
                // null is the only value both builds read as "no goal".
                trimmed.originalGoal = null;
            } else {
                trimmed.originalGoal = redactedGoal;
            }
        }

        trimmed.updatedAt = Date.now();

        const json = JSON.stringify(trimmed, null, 2);

        // Atomic write: tmp → backup existing → rename
        fs.writeFileSync(tmpPath, json, 'utf8');

        try {
            if (fs.existsSync(filePath)) {
                fs.copyFileSync(filePath, filePath + '.bak');
            }
        } catch (e) { log(`[TaskStore] Backup before save failed: ${e.message}`, 'WARN'); }

        fs.renameSync(tmpPath, filePath);

        const durationMs = Date.now() - start;
        if (durationMs > 50) {
            log(`[TaskStore] Slow checkpoint write: ${durationMs}ms (task ${taskId})`, 'WARN');
        }
        return durationMs;
    } catch (e) {
        // Clean up tmp file on failure
        try { if (fs.existsSync(tmpPath)) fs.unlinkSync(tmpPath); } catch (_) {}
        log(`[TaskStore] saveCheckpoint failed for ${taskId}: ${e.message}`, 'ERROR');
        return -1;
    }
}

/**
 * Load a checkpoint from disk. Falls back to .bak if primary is corrupt.
 * Returns null if no checkpoint exists or both files are corrupt.
 */
function loadCheckpoint(taskId) {
    const filePath = path.join(TASKS_DIR, `${taskId}.json`);

    // Try primary file
    const primary = _readJson(filePath);
    if (primary) return primary;

    // Try backup
    const backup = _readJson(filePath + '.bak');
    if (backup) {
        log(`[TaskStore] Loaded ${taskId} from .bak (primary was corrupt)`, 'WARN');
        return backup;
    }

    return null;
}

/**
 * List all checkpoints, sorted by updatedAt descending (most recent first).
 * Returns array of { taskId, chatId, startedAt, updatedAt, complete, reason }.
 */
function listCheckpoints() {
    try {
        const files = fs.readdirSync(TASKS_DIR).filter(f => f.endsWith('.json') && !f.endsWith('.tmp') && !f.endsWith('.bak'));
        const results = [];
        for (const file of files) {
            const data = _readJson(path.join(TASKS_DIR, file));
            if (data) {
                results.push({
                    taskId: data.taskId || file.replace('.json', ''),
                    chatId: data.chatId,
                    startedAt: data.startedAt,
                    updatedAt: data.updatedAt,
                    complete: !!data.complete,
                    reason: data.reason || null,
                });
            }
        }
        results.sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0));
        return results;
    } catch (e) {
        log(`[TaskStore] listCheckpoints failed: ${e.message}`, 'ERROR');
        return [];
    }
}

/**
 * Delete a checkpoint and its backup.
 */
function deleteCheckpoint(taskId) {
    const filePath = path.join(TASKS_DIR, `${taskId}.json`);
    const existed = fs.existsSync(filePath);
    if (existed) {
        const caller = new Error().stack.split('\n')[2]?.trim() || 'unknown';
        log(`[TaskStore] DELETE taskId=${taskId} caller=${caller}`, 'INFO');
    }
    try { if (existed) fs.unlinkSync(filePath); } catch (_) {}
    try { if (fs.existsSync(filePath + '.bak')) fs.unlinkSync(filePath + '.bak'); } catch (_) {}
    try { if (fs.existsSync(filePath + '.tmp')) fs.unlinkSync(filePath + '.tmp'); } catch (_) {}
}

/**
 * Mark a checkpoint as complete (task finished successfully).
 */
function markComplete(taskId) {
    const data = loadCheckpoint(taskId);
    if (!data) return;
    data.complete = true;
    data.completedAt = Date.now();
    saveCheckpoint(taskId, data);
}

/**
 * Delete all incomplete checkpoints for a given chatId.
 * Called on task completion to clean up both current and stale checkpoints.
 */
function cleanupChatCheckpoints(chatId) {
    const chatStr = String(chatId);
    let deleted = 0;
    try {
        const files = fs.readdirSync(TASKS_DIR).filter(f => f.endsWith('.json') && !f.endsWith('.tmp') && !f.endsWith('.bak'));
        for (const file of files) {
            const data = _readJson(path.join(TASKS_DIR, file));
            if (data && String(data.chatId) === chatStr && !data.complete) {
                deleteCheckpoint(file.replace('.json', ''));
                deleted++;
            }
        }
        if (deleted > 0) {
            log(`[TaskStore] Cleaned up ${deleted} stale checkpoint(s) for chat ${chatStr}`, 'DEBUG');
        }
    } catch (e) {
        log(`[TaskStore] cleanupChatCheckpoints failed: ${e.message}`, 'ERROR');
    }
    return deleted;
}

/**
 * Clean up expired checkpoints (older than MAX_CHECKPOINT_AGE_MS).
 * Returns number of deleted checkpoints.
 */
function cleanupExpired() {
    const cutoff = Date.now() - MAX_CHECKPOINT_AGE_MS;
    let deleted = 0;
    try {
        const files = fs.readdirSync(TASKS_DIR).filter(f => f.endsWith('.json') && !f.endsWith('.tmp') && !f.endsWith('.bak'));
        for (const file of files) {
            const data = _readJson(path.join(TASKS_DIR, file));
            if (data && (data.updatedAt || data.startedAt || 0) < cutoff) {
                deleteCheckpoint(file.replace('.json', ''));
                deleted++;
            }
        }
        if (deleted > 0) {
            log(`[TaskStore] Cleaned up ${deleted} expired checkpoint(s)`, 'INFO');
        }
    } catch (e) {
        log(`[TaskStore] cleanupExpired failed: ${e.message}`, 'ERROR');
    }
    return deleted;
}

// ============================================================================
// INTERNAL
// ============================================================================

// Deep-redact all string values in an object (for tool call input payloads)
function _redactObject(obj) {
    if (typeof obj === 'string') return redactSecrets(obj);
    if (Array.isArray(obj)) return obj.map(item => _redactObject(item));
    if (obj && typeof obj === 'object') {
        const out = Object.create(null);
        for (const key of Object.keys(obj)) {
            if (key === '__proto__' || key === 'constructor' || key === 'prototype') continue;
            out[key] = _redactObject(obj[key]);
        }
        return out;
    }
    return obj;
}

function _readJson(filePath) {
    try {
        if (!fs.existsSync(filePath)) return null;
        const raw = fs.readFileSync(filePath, 'utf8');
        return JSON.parse(raw);
    } catch (e) {
        log(`[TaskStore] Failed to read ${filePath}: ${e.message}`, 'WARN');
        return null;
    }
}

// ============================================================================
// STARTUP
// ============================================================================

// Clean up expired checkpoints on load (non-blocking, non-fatal)
try { cleanupExpired(); } catch (_) {}

// ============================================================================
// EXPORTS
// ============================================================================

module.exports = {
    saveCheckpoint,
    loadCheckpoint,
    listCheckpoints,
    deleteCheckpoint,
    cleanupChatCheckpoints,
    markComplete,
    cleanupExpired,
    MAX_CHECKPOINT_AGE_MS,
};
