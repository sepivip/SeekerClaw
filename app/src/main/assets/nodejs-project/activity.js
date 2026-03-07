// activity.js — Memory Activity Tracker (BAT-325)
// Tracks file access patterns for the Memory Activity Grid on the System screen.
// In-memory Map, debounced 2s flush to workspace/memory_activity_state JSON.
// Android polls this file in the existing 1s ServiceState polling loop.

const fs = require('fs');
const path = require('path');
const { workDir, log } = require('./config');

const ACTIVITY_FILE = path.join(workDir, 'memory_activity_state');
const FLUSH_INTERVAL_MS = 2000;

// In-memory tracking: group → { lastRead, lastWrite, readCount, writeCount }
const memoryActivity = new Map();

let flushTimer = null;
let dirty = false;

function classifyPath(relPath) {
    if (!relPath || typeof relPath !== 'string') return null;
    const normalized = relPath.replace(/\\/g, '/');
    const base = path.basename(normalized);

    if (base === 'SOUL.md') return 'soul';
    if (base === 'IDENTITY.md') return 'identity';
    if (base === 'USER.md') return 'user';
    if (base === 'MEMORY.md') return 'memory';
    if (base === 'HEARTBEAT.md') return 'heartbeat';
    if (base === 'agent_settings.json') return 'settings';
    if (normalized.startsWith('memory/') && base.endsWith('.md')) return 'daily';
    if (normalized.startsWith('skills/') && base.endsWith('.md')) return 'skills';
    return null;
}

function trackMemoryAccess(relPath, action) {
    const group = classifyPath(relPath);
    if (!group) return;

    const entry = memoryActivity.get(group) || { lastRead: 0, lastWrite: 0, readCount: 0, writeCount: 0 };
    const now = Date.now();
    if (action === 'read') {
        entry.lastRead = now;
        entry.readCount++;
    } else {
        entry.lastWrite = now;
        entry.writeCount++;
    }
    memoryActivity.set(group, entry);
    dirty = true;
    scheduleFlush();
}

function scheduleFlush() {
    if (flushTimer) return;
    flushTimer = setTimeout(() => {
        flushTimer = null;
        if (dirty) writeActivityFile();
    }, FLUSH_INTERVAL_MS);
}

function writeActivityFile() {
    try {
        const state = Object.fromEntries(memoryActivity);
        state.updatedAt = new Date().toISOString();
        const tmpPath = ACTIVITY_FILE + '.tmp';
        fs.writeFileSync(tmpPath, JSON.stringify(state));
        fs.renameSync(tmpPath, ACTIVITY_FILE);
        dirty = false;
    } catch (err) {
        log(`[Activity] Failed to write activity file: ${err.message}`, 'WARN');
    }
}

function cleanupActivityTimer() {
    if (flushTimer) {
        clearTimeout(flushTimer);
        flushTimer = null;
    }
    // Final flush on shutdown
    if (dirty) writeActivityFile();
}

module.exports = { trackMemoryAccess, writeActivityFile, cleanupActivityTimer, classifyPath };
