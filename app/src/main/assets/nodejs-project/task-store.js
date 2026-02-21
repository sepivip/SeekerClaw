// task-store.js — Persistent task checkpoints (P2.2)
// Atomic write pattern (tmp → backup → rename) matching cron.js
// Durable: all writes are synchronous — checkpoint is on disk before returning.

const fs = require('fs');
const path = require('path');

const { TASKS_DIR, log } = require('./config');

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
            // Step 2: ALWAYS drop leading orphaned tool_result (no matching tool_use before it)
            while (trimmed.conversationSlice.length > 0) {
                const first = trimmed.conversationSlice[0];
                if (first.role === 'user' && Array.isArray(first.content)
                    && first.content.some(b => b.type === 'tool_result')) {
                    trimmed.conversationSlice = trimmed.conversationSlice.slice(1);
                } else {
                    break;
                }
            }
            // Step 3: drop trailing orphaned tool_use (no following tool_result)
            while (trimmed.conversationSlice.length > 0) {
                const last = trimmed.conversationSlice[trimmed.conversationSlice.length - 1];
                if (last.role === 'assistant' && Array.isArray(last.content)
                    && last.content.some(b => b.type === 'tool_use')) {
                    trimmed.conversationSlice.pop();
                } else {
                    break;
                }
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
