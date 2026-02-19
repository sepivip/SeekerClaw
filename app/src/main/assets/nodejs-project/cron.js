// SeekerClaw — cron.js
// Cron/scheduling system: one-shot reminders, recurring intervals, persistence.
// Depends on: config.js. Needs sendMessage injected from telegram.js.

const fs = require('fs');
const path = require('path');

const { workDir, log, localTimestamp, getOwnerId } = require('./config');

// ============================================================================
// DEPENDENCY INJECTION
// ============================================================================

// sendMessage is defined in telegram.js — injected after load via setSendMessage()
let _sendMessage = null;

function setSendMessage(fn) {
    _sendMessage = fn;
}

// ============================================================================
// CONSTANTS
// ============================================================================

const CRON_STORE_PATH = path.join(workDir, 'cron', 'jobs.json');
const CRON_RUN_LOG_DIR = path.join(workDir, 'cron', 'runs');
const MAX_TIMEOUT_MS = 2147483647; // 2^31 - 1 (setTimeout max)

// ============================================================================
// DURATION FORMATTING
// ============================================================================

function formatDuration(ms) {
    if (ms < 0) return 'overdue';
    const minutes = Math.floor(ms / 60000);
    const hours = Math.floor(minutes / 60);
    const days = Math.floor(hours / 24);

    if (days > 0) return `${days}d ${hours % 24}h`;
    if (hours > 0) return `${hours}h ${minutes % 60}m`;
    return `${minutes}m`;
}

// ============================================================================
// CRON STORE (JSON file persistence with atomic writes)
// ============================================================================

function loadCronStore() {
    try {
        if (fs.existsSync(CRON_STORE_PATH)) {
            const store = JSON.parse(fs.readFileSync(CRON_STORE_PATH, 'utf8'));
            // Migrate old jobs: add delivery object if missing
            let mutated = false;
            for (const job of store.jobs) {
                if (!job.delivery) {
                    job.delivery = { mode: 'announce' };
                    mutated = true;
                }
                // Migrate old "deliver" mode name to "announce"
                if (job.delivery.mode === 'deliver') {
                    job.delivery.mode = 'announce';
                    mutated = true;
                }
            }
            if (mutated) saveCronStore(store);
            return store;
        }
    } catch (e) {
        log(`Error loading cron store: ${e.message}`);
    }
    return { version: 1, jobs: [] };
}

function saveCronStore(store) {
    try {
        const dir = path.dirname(CRON_STORE_PATH);
        if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });

        // Atomic write: write to temp, rename over original
        const tmpPath = CRON_STORE_PATH + '.tmp';
        fs.writeFileSync(tmpPath, JSON.stringify(store, null, 2), 'utf8');

        // Backup existing file
        try {
            if (fs.existsSync(CRON_STORE_PATH)) {
                fs.copyFileSync(CRON_STORE_PATH, CRON_STORE_PATH + '.bak');
            }
        } catch (_) {}

        fs.renameSync(tmpPath, CRON_STORE_PATH);
    } catch (e) {
        log(`Error saving cron store: ${e.message}`);
    }
}

// ============================================================================
// CRON RUN LOG (JSONL execution history)
// ============================================================================

function appendCronRunLog(jobId, entry) {
    try {
        if (!fs.existsSync(CRON_RUN_LOG_DIR)) {
            fs.mkdirSync(CRON_RUN_LOG_DIR, { recursive: true });
        }
        const logPath = path.join(CRON_RUN_LOG_DIR, `${jobId}.jsonl`);
        const line = JSON.stringify({ ts: Date.now(), jobId, ...entry }) + '\n';
        fs.appendFileSync(logPath, line, 'utf8');

        // Prune if too large (>500KB)
        try {
            const stat = fs.statSync(logPath);
            if (stat.size > 500 * 1024) {
                const lines = fs.readFileSync(logPath, 'utf8').trim().split('\n');
                const kept = lines.slice(-200); // Keep last 200 entries
                fs.writeFileSync(logPath, kept.join('\n') + '\n', 'utf8');
            }
        } catch (_) {}
    } catch (e) {
        log(`Error writing run log: ${e.message}`);
    }
}

// ============================================================================
// JOB ID GENERATION
// ============================================================================

function generateJobId() {
    return 'cron_' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
}

// ============================================================================
// SCHEDULE COMPUTATION
// ============================================================================

function computeNextRunAtMs(schedule, nowMs) {
    switch (schedule.kind) {
        case 'at':
            // One-shot: fire once at atMs, undefined if past
            return schedule.atMs > nowMs ? schedule.atMs : undefined;

        case 'every': {
            // Repeating interval with optional anchor
            const anchor = schedule.anchorMs || 0;
            const interval = schedule.everyMs;
            if (interval <= 0) return undefined;
            const elapsed = nowMs - anchor;
            // Fix 2 (BAT-21): Use floor+1 to always advance past current time.
            // Math.ceil can return the current second when nowMs lands exactly
            // on an interval boundary, causing immediate duplicate fires.
            const periods = Math.floor(elapsed / interval) + 1;
            return anchor + periods * interval;
        }

        default:
            return undefined;
    }
}

// ============================================================================
// PARSE NATURAL LANGUAGE TIME
// ============================================================================

function parseTimeExpression(timeStr) {
    const now = new Date();
    const lower = timeStr.toLowerCase().trim();

    // "in X minutes/hours/days/seconds"
    const inMatch = lower.match(/^in\s+(\d+)\s*(second|sec|minute|min|hour|hr|day|week)s?$/i);
    if (inMatch) {
        const amount = parseInt(inMatch[1], 10);
        const unit = inMatch[2].toLowerCase();
        const ms = {
            'second': 1000, 'sec': 1000,
            'minute': 60000, 'min': 60000,
            'hour': 3600000, 'hr': 3600000,
            'day': 86400000,
            'week': 604800000
        };
        return new Date(now.getTime() + amount * (ms[unit] || 60000));
    }

    // "every X minutes/hours" → returns { recurring: true, everyMs: ... }
    const everyMatch = lower.match(/^every\s+(\d+)\s*(second|sec|minute|min|hour|hr|day|week)s?$/i);
    if (everyMatch) {
        const amount = parseInt(everyMatch[1], 10);
        const unit = everyMatch[2].toLowerCase();
        const ms = {
            'second': 1000, 'sec': 1000,
            'minute': 60000, 'min': 60000,
            'hour': 3600000, 'hr': 3600000,
            'day': 86400000,
            'week': 604800000
        };
        const result = new Date(now.getTime() + amount * (ms[unit] || 60000));
        result._recurring = true;
        result._everyMs = amount * (ms[unit] || 60000);
        return result;
    }

    // "tomorrow at Xam/pm" or "tomorrow at HH:MM"
    const tomorrowMatch = lower.match(/^tomorrow\s+at\s+(\d{1,2})(?::(\d{2}))?\s*(am|pm)?$/i);
    if (tomorrowMatch) {
        let hours = parseInt(tomorrowMatch[1], 10);
        const minutes = parseInt(tomorrowMatch[2] || '0', 10);
        const ampm = tomorrowMatch[3]?.toLowerCase();
        if (ampm === 'pm' && hours < 12) hours += 12;
        if (ampm === 'am' && hours === 12) hours = 0;
        const tomorrow = new Date(now);
        tomorrow.setDate(tomorrow.getDate() + 1);
        tomorrow.setHours(hours, minutes, 0, 0);
        return tomorrow;
    }

    // "today at Xam/pm"
    const todayMatch = lower.match(/^today\s+at\s+(\d{1,2})(?::(\d{2}))?\s*(am|pm)?$/i);
    if (todayMatch) {
        let hours = parseInt(todayMatch[1], 10);
        const minutes = parseInt(todayMatch[2] || '0', 10);
        const ampm = todayMatch[3]?.toLowerCase();
        if (ampm === 'pm' && hours < 12) hours += 12;
        if (ampm === 'am' && hours === 12) hours = 0;
        const today = new Date(now);
        today.setHours(hours, minutes, 0, 0);
        return today;
    }

    // "at Xam/pm" (same day or next day if past)
    const atMatch = lower.match(/^at\s+(\d{1,2})(?::(\d{2}))?\s*(am|pm)?$/i);
    if (atMatch) {
        let hours = parseInt(atMatch[1], 10);
        const minutes = parseInt(atMatch[2] || '0', 10);
        const ampm = atMatch[3]?.toLowerCase();
        if (ampm === 'pm' && hours < 12) hours += 12;
        if (ampm === 'am' && hours === 12) hours = 0;
        const target = new Date(now);
        target.setHours(hours, minutes, 0, 0);
        if (target <= now) target.setDate(target.getDate() + 1);
        return target;
    }

    // ISO format or standard date-time "YYYY-MM-DD HH:MM"
    const isoMatch = lower.match(/^(\d{4}-\d{2}-\d{2})[\sT](\d{2}:\d{2})$/);
    if (isoMatch) {
        return new Date(`${isoMatch[1]}T${isoMatch[2]}:00`);
    }

    // Fallback: try native Date parsing
    const parsed = new Date(timeStr);
    if (!isNaN(parsed.getTime())) return parsed;

    return null;
}

// ============================================================================
// CRON SERVICE
// ============================================================================

const cronService = {
    store: null,
    timer: null,
    running: false,

    // Initialize and start the cron service
    start() {
        this.store = loadCronStore();
        // Recompute next runs and clear zombies
        this._recomputeNextRuns();
        this._armTimer();
        log(`[Cron] Service started with ${this.store.jobs.length} jobs`);
    },

    // Stop the cron service
    stop() {
        if (this.timer) {
            clearTimeout(this.timer);
            this.timer = null;
        }
        this.running = false;
    },

    // Error backoff schedule (exponential): 30s, 1min, 5min, 15min, 60min
    ERROR_BACKOFF_MS: [30000, 60000, 300000, 900000, 3600000],

    // Create a new job
    create(input) {
        if (!this.store) this.store = loadCronStore();

        const now = Date.now();
        const job = {
            id: generateJobId(),
            name: input.name || 'Unnamed job',
            description: input.description || '',
            enabled: true,
            deleteAfterRun: input.deleteAfterRun || false,
            createdAtMs: now,
            updatedAtMs: now,
            schedule: input.schedule, // { kind: 'at'|'every', atMs?, everyMs?, anchorMs? }
            payload: input.payload,   // { kind: 'reminder', message: '...' }
            delivery: { mode: 'announce' },
            state: {
                nextRunAtMs: undefined,
                lastRunAtMs: undefined,
                lastStatus: undefined,
                lastError: undefined,
                consecutiveErrors: 0,
            }
        };

        // Compute initial next run
        job.state.nextRunAtMs = computeNextRunAtMs(job.schedule, now);

        this.store.jobs.push(job);
        saveCronStore(this.store);
        this._armTimer();

        log(`[Cron] Created job ${job.id}: "${job.name}" → next: ${job.state.nextRunAtMs ? localTimestamp(new Date(job.state.nextRunAtMs)) : 'never'}`);
        return job;
    },

    // Update an existing job
    update(id, patch) {
        if (!this.store) this.store = loadCronStore();
        const job = this.store.jobs.find(j => j.id === id);
        if (!job) return null;

        if (patch.name !== undefined) job.name = patch.name;
        if (patch.description !== undefined) job.description = patch.description;
        if (patch.enabled !== undefined) job.enabled = patch.enabled;
        if (patch.schedule !== undefined) job.schedule = patch.schedule;
        if (patch.payload !== undefined) job.payload = patch.payload;
        job.updatedAtMs = Date.now();

        // Recompute next run
        job.state.nextRunAtMs = job.enabled
            ? computeNextRunAtMs(job.schedule, Date.now())
            : undefined;

        saveCronStore(this.store);
        this._armTimer();
        return job;
    },

    // Remove a job
    remove(id) {
        if (!this.store) this.store = loadCronStore();
        const idx = this.store.jobs.findIndex(j => j.id === id);
        if (idx === -1) return false;

        const removed = this.store.jobs.splice(idx, 1)[0];
        saveCronStore(this.store);
        this._armTimer();
        log(`[Cron] Removed job ${id}: "${removed.name}"`);
        return true;
    },

    // List jobs
    list(opts = {}) {
        if (!this.store) this.store = loadCronStore();
        let jobs = this.store.jobs;
        if (!opts.includeDisabled) {
            jobs = jobs.filter(j => j.enabled);
        }
        return jobs.sort((a, b) => (a.state.nextRunAtMs || Infinity) - (b.state.nextRunAtMs || Infinity));
    },

    // Get service status
    status() {
        if (!this.store) this.store = loadCronStore();
        const enabledJobs = this.store.jobs.filter(j => j.enabled);
        const nextJob = enabledJobs
            .filter(j => j.state.nextRunAtMs)
            .sort((a, b) => a.state.nextRunAtMs - b.state.nextRunAtMs)[0];

        return {
            running: true,
            totalJobs: this.store.jobs.length,
            enabledJobs: enabledJobs.length,
            nextWakeAtMs: nextJob?.state.nextRunAtMs || null,
            nextWakeIn: nextJob?.state.nextRunAtMs
                ? formatDuration(nextJob.state.nextRunAtMs - Date.now())
                : null,
        };
    },

    // --- Internal Methods ---

    _recomputeNextRuns() {
        const now = Date.now();

        for (const job of this.store.jobs) {
            // Fix 4 (BAT-21): On restart, clear ALL runningAtMs markers.
            // Nothing can actually be running after a process restart.
            if (job.state.runningAtMs) {
                log(`[Cron] Clearing interrupted job marker: ${job.id}`);
                job.state.runningAtMs = undefined;
            }

            if (!job.enabled) {
                job.state.nextRunAtMs = undefined;
                continue;
            }

            // Fix 1 (BAT-21): Any truthy lastStatus means the job already
            // reached a terminal state (ok, error, skipped). Don't re-fire
            // one-shot jobs on restart — they ran or were handled already.
            if (job.schedule.kind === 'at' && job.state.lastStatus) {
                job.enabled = false;
                job.state.nextRunAtMs = undefined;
                continue;
            }

            const nextRun = computeNextRunAtMs(job.schedule, now);

            // Fix 1 (BAT-21): One-shot 'at' jobs whose time has passed but
            // never ran — mark as skipped so they don't re-fire on next restart.
            if (job.schedule.kind === 'at' && !nextRun && !job.state.lastStatus) {
                log(`[Cron] Skipping missed one-shot job: ${job.id} "${job.name}"`);
                job.enabled = false;
                job.state.lastStatus = 'skipped';
                job.state.nextRunAtMs = undefined;
                continue;
            }

            job.state.nextRunAtMs = nextRun;
        }

        saveCronStore(this.store);
    },

    _armTimer() {
        if (this.timer) {
            clearTimeout(this.timer);
            this.timer = null;
        }

        if (!this.store) return;

        // Find earliest next run
        let earliest = Infinity;
        for (const job of this.store.jobs) {
            if (job.enabled && job.state.nextRunAtMs && job.state.nextRunAtMs < earliest) {
                earliest = job.state.nextRunAtMs;
            }
        }

        if (earliest === Infinity) return;

        const delay = Math.max(0, Math.min(earliest - Date.now(), MAX_TIMEOUT_MS));
        this.timer = setTimeout(() => this._onTimer(), delay);
        if (this.timer.unref) this.timer.unref(); // Don't keep process alive
    },

    async _onTimer() {
        if (this.running) return; // Prevent concurrent execution
        this.running = true;

        try {
            if (!this.store) this.store = loadCronStore();
            await this._runDueJobs();
            saveCronStore(this.store);
        } catch (e) {
            log(`[Cron] Timer error: ${e.message}`);
        } finally {
            this.running = false;
            this._armTimer();
        }
    },

    async _runDueJobs() {
        const now = Date.now();
        const dueJobs = this.store.jobs.filter(j =>
            j.enabled &&
            !j.state.runningAtMs &&
            j.state.nextRunAtMs &&
            j.state.nextRunAtMs <= now
        );

        for (const job of dueJobs) {
            await this._executeJob(job, now);
        }
    },

    async _executeJob(job, nowMs) {
        log(`[Cron] Executing job ${job.id}: "${job.name}"`);
        job.state.runningAtMs = nowMs;
        // Fix 2 (BAT-21): Clear nextRunAtMs before execution to prevent
        // the job from being picked up as due again during async execution.
        job.state.nextRunAtMs = undefined;

        const startTime = Date.now();
        let status = 'ok';
        let error = null;

        try {
            // Execute based on payload type
            if (job.payload.kind === 'reminder') {
                const ownerId = getOwnerId();
                const message = `⏰ **Reminder**\n\n${job.payload.message}\n\n_Set ${formatDuration(Date.now() - job.createdAtMs)} ago_`;
                if (_sendMessage) {
                    await _sendMessage(ownerId, message);
                } else {
                    log(`[Cron] WARNING: sendMessage not injected, cannot deliver reminder for job ${job.id}`);
                    throw new Error('sendMessage not available');
                }
                log(`[Cron] Delivered reminder: ${job.id}`);
            }
        } catch (e) {
            status = 'error';
            error = e.message;
            log(`[Cron] Job error ${job.id}: ${e.message}`);
        }

        const durationMs = Date.now() - startTime;

        // Update job state
        job.state.runningAtMs = undefined;
        job.state.lastRunAtMs = nowMs;
        job.state.lastStatus = status;
        job.state.lastError = error;
        job.state.lastDurationMs = durationMs;

        // Log execution
        appendCronRunLog(job.id, {
            action: 'finished',
            status,
            error,
            durationMs,
            nextRunAtMs: undefined,
        });

        // Track consecutive errors for backoff
        if (status === 'error') {
            job.state.consecutiveErrors = (job.state.consecutiveErrors || 0) + 1;
        } else {
            job.state.consecutiveErrors = 0;
        }

        // Handle post-execution
        if (job.schedule.kind === 'at') {
            // One-shot: disable after any terminal status (ok or error)
            job.enabled = false;
            job.state.nextRunAtMs = undefined;
            // Fix 3 (BAT-21): Only delete on success. Keep errored/skipped
            // jobs visible in state for debugging and user awareness.
            if (job.deleteAfterRun && status === 'ok') {
                const idx = this.store.jobs.indexOf(job);
                if (idx !== -1) this.store.jobs.splice(idx, 1);
            }
        } else {
            // Recurring: compute next run with error backoff
            const normalNext = computeNextRunAtMs(job.schedule, Date.now());

            if (status === 'error' && job.state.consecutiveErrors > 0) {
                const backoffIdx = Math.min(job.state.consecutiveErrors - 1, this.ERROR_BACKOFF_MS.length - 1);
                const backoffNext = nowMs + this.ERROR_BACKOFF_MS[backoffIdx];
                job.state.nextRunAtMs = Math.max(normalNext, backoffNext);
                log(`[Cron] Job ${job.id} error #${job.state.consecutiveErrors}, backing off until ${localTimestamp(new Date(job.state.nextRunAtMs))}`);
            } else {
                job.state.nextRunAtMs = normalNext;
            }
        }
    },
};

// ============================================================================
// EXPORTS
// ============================================================================

module.exports = {
    setSendMessage,
    cronService,
    parseTimeExpression,
    formatDuration,
};
