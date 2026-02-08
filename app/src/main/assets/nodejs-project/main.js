// SeekerClaw AI Agent
// Phase 2: Full Claude AI agent with tools, memory, and personality

const fs = require('fs');
const path = require('path');
const https = require('https');

// ============================================================================
// CONFIGURATION
// ============================================================================

const workDir = process.argv[2] || __dirname;
const debugLog = path.join(workDir, 'node_debug.log');

function log(msg) {
    const line = `[${new Date().toISOString()}] ${msg}\n`;
    try { fs.appendFileSync(debugLog, line); } catch (_) {}
    console.log('[SeekerClaw] ' + msg);
}

process.on('uncaughtException', (err) => log('UNCAUGHT: ' + (err.stack || err)));
process.on('unhandledRejection', (reason) => log('UNHANDLED: ' + reason));

log('Starting SeekerClaw AI Agent...');
log(`Node.js ${process.version} on ${process.platform} ${process.arch}`);
log(`Workspace: ${workDir}`);

// Load config
const configPath = path.join(workDir, 'config.json');
if (!fs.existsSync(configPath)) {
    log('ERROR: config.json not found');
    process.exit(1);
}

const config = JSON.parse(fs.readFileSync(configPath, 'utf8'));
const BOT_TOKEN = config.botToken;
let OWNER_ID = config.ownerId ? String(config.ownerId) : '';
const ANTHROPIC_KEY = config.anthropicApiKey;
const AUTH_TYPE = config.authType || 'api_key';
const MODEL = config.model || 'claude-opus-4-6';
const AGENT_NAME = config.agentName || 'SeekerClaw';

if (!BOT_TOKEN || !ANTHROPIC_KEY) {
    log('ERROR: Missing required config (botToken, anthropicApiKey)');
    process.exit(1);
}

if (!OWNER_ID) {
    log('Owner ID not set — will auto-detect from first message');
} else {
    const authLabel = AUTH_TYPE === 'setup_token' ? 'setup-token' : 'api-key';
    log(`Agent: ${AGENT_NAME} | Model: ${MODEL} | Auth: ${authLabel} | Owner: ${OWNER_ID}`);
}

// ============================================================================
// FILE PATHS
// ============================================================================

const SOUL_PATH = path.join(workDir, 'SOUL.md');
const MEMORY_PATH = path.join(workDir, 'MEMORY.md');
const HEARTBEAT_PATH = path.join(workDir, 'HEARTBEAT.md');
const MEMORY_DIR = path.join(workDir, 'memory');
const SKILLS_DIR = path.join(workDir, 'skills');

// Ensure directories exist
if (!fs.existsSync(MEMORY_DIR)) {
    fs.mkdirSync(MEMORY_DIR, { recursive: true });
}
if (!fs.existsSync(SKILLS_DIR)) {
    fs.mkdirSync(SKILLS_DIR, { recursive: true });
}

// ============================================================================
// SOUL & MEMORY
// ============================================================================

// Bootstrap, Identity, User paths (OpenClaw-style onboarding)
const BOOTSTRAP_PATH = path.join(workDir, 'BOOTSTRAP.md');
const IDENTITY_PATH = path.join(workDir, 'IDENTITY.md');
const USER_PATH = path.join(workDir, 'USER.md');

function loadSoul() {
    if (fs.existsSync(SOUL_PATH)) {
        return fs.readFileSync(SOUL_PATH, 'utf8');
    }
    // Default personality
    return `# ${AGENT_NAME}

You are ${AGENT_NAME}, a helpful AI assistant running on an Android phone via SeekerClaw.
You communicate through Telegram with your owner.

## Personality
- Friendly, helpful, and concise
- You remember previous conversations through your memory files
- You can search the web and fetch URLs when needed

## Guidelines
- Keep responses concise for mobile reading
- Use markdown formatting sparingly
- Be proactive about saving important information to memory
`;
}

function loadBootstrap() {
    if (fs.existsSync(BOOTSTRAP_PATH)) {
        return fs.readFileSync(BOOTSTRAP_PATH, 'utf8');
    }
    return null;
}

function loadIdentity() {
    if (fs.existsSync(IDENTITY_PATH)) {
        return fs.readFileSync(IDENTITY_PATH, 'utf8');
    }
    return null;
}

function loadUser() {
    if (fs.existsSync(USER_PATH)) {
        return fs.readFileSync(USER_PATH, 'utf8');
    }
    return null;
}

function loadMemory() {
    if (fs.existsSync(MEMORY_PATH)) {
        return fs.readFileSync(MEMORY_PATH, 'utf8');
    }
    return '';
}

function saveMemory(content) {
    fs.writeFileSync(MEMORY_PATH, content, 'utf8');
    log('Memory updated');
}

function getDailyMemoryPath() {
    const date = new Date().toISOString().split('T')[0];
    return path.join(MEMORY_DIR, `${date}.md`);
}

function loadDailyMemory() {
    const dailyPath = getDailyMemoryPath();
    if (fs.existsSync(dailyPath)) {
        return fs.readFileSync(dailyPath, 'utf8');
    }
    return '';
}

function appendDailyMemory(content) {
    const dailyPath = getDailyMemoryPath();
    const timestamp = new Date().toLocaleTimeString();
    const entry = `\n## ${timestamp}\n${content}\n`;
    fs.appendFileSync(dailyPath, entry, 'utf8');
    log('Daily memory updated');
}

function updateHeartbeat() {
    const now = new Date();
    const uptime = Math.floor(process.uptime());
    const content = `# Heartbeat

Last updated: ${now.toISOString()}
Uptime: ${Math.floor(uptime / 3600)}h ${Math.floor((uptime % 3600) / 60)}m ${uptime % 60}s
Memory: ${Math.round(process.memoryUsage().rss / 1024 / 1024)} MB
Status: Running
`;
    fs.writeFileSync(HEARTBEAT_PATH, content, 'utf8');
}

// Update heartbeat every 5 minutes
setInterval(updateHeartbeat, 5 * 60 * 1000);
updateHeartbeat();

// ============================================================================
// CRON/SCHEDULING SYSTEM (ported from OpenClaw)
// ============================================================================
// Supports three schedule types:
//   - "at"    : one-shot job at specific timestamp
//   - "every" : repeating interval (e.g., every 30s)
//   - "cron"  : cron expressions (e.g., "0 9 * * MON") — future, needs croner lib
//
// Persists to JSON file with atomic writes and .bak backup.
// ============================================================================

const CRON_STORE_PATH = path.join(workDir, 'cron', 'jobs.json');
const CRON_RUN_LOG_DIR = path.join(workDir, 'cron', 'runs');
const MAX_TIMEOUT_MS = 2147483647; // 2^31 - 1 (setTimeout max)

// --- Cron Store (JSON file persistence with atomic writes) ---

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

// --- Cron Run Log (JSONL execution history) ---

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

// --- Job ID Generation ---

function generateJobId() {
    return 'cron_' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
}

// --- Schedule Computation ---

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
            const periods = Math.ceil(elapsed / interval);
            return anchor + periods * interval;
        }

        default:
            return undefined;
    }
}

// --- Parse Natural Language Time ---

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

// --- Cron Service ---

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
            }
        };

        // Compute initial next run
        job.state.nextRunAtMs = computeNextRunAtMs(job.schedule, now);

        this.store.jobs.push(job);
        saveCronStore(this.store);
        this._armTimer();

        log(`[Cron] Created job ${job.id}: "${job.name}" → next: ${job.state.nextRunAtMs ? new Date(job.state.nextRunAtMs).toISOString() : 'never'}`);
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
        const ZOMBIE_THRESHOLD = 2 * 3600000; // 2 hours

        for (const job of this.store.jobs) {
            // Clear stuck "running" markers
            if (job.state.runningAtMs && (now - job.state.runningAtMs) > ZOMBIE_THRESHOLD) {
                log(`[Cron] Clearing zombie job: ${job.id}`);
                job.state.runningAtMs = undefined;
                job.state.lastStatus = 'error';
                job.state.lastError = 'Job timed out (zombie cleared)';
            }

            if (!job.enabled) {
                job.state.nextRunAtMs = undefined;
                continue;
            }

            // One-shot "at" jobs that already ran → disable
            if (job.schedule.kind === 'at' && job.state.lastStatus === 'ok') {
                job.enabled = false;
                job.state.nextRunAtMs = undefined;
                continue;
            }

            job.state.nextRunAtMs = computeNextRunAtMs(job.schedule, now);
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

        const startTime = Date.now();
        let status = 'ok';
        let error = null;

        try {
            // Execute based on payload type
            if (job.payload.kind === 'reminder') {
                const message = `⏰ **Reminder**\n\n${job.payload.message}\n\n_Set ${formatDuration(Date.now() - job.createdAtMs)} ago_`;
                await sendMessage(OWNER_ID, message);
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

        // Handle post-execution
        if (job.schedule.kind === 'at') {
            // One-shot: disable after successful run
            if (status === 'ok') {
                job.enabled = false;
                job.state.nextRunAtMs = undefined;
                if (job.deleteAfterRun) {
                    const idx = this.store.jobs.indexOf(job);
                    if (idx !== -1) this.store.jobs.splice(idx, 1);
                }
            }
        } else {
            // Recurring: compute next run
            job.state.nextRunAtMs = computeNextRunAtMs(job.schedule, Date.now());
        }
    },
};


// ============================================================================
// SKILLS SYSTEM
// ============================================================================

/**
 * Skill definition loaded from SKILL.md
 *
 * SKILL.md format:
 * ```
 * # Skill Name
 *
 * Trigger: keyword1, keyword2, keyword3
 *
 * ## Description
 * What this skill does
 *
 * ## Instructions
 * How to handle requests matching this skill
 *
 * ## Tools
 * - tool_name: description
 * ```
 */

// Simple YAML frontmatter parser (no external dependencies)
function parseYamlFrontmatter(content) {
    const frontmatter = {};
    const lines = content.split('\n');

    for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed || trimmed.startsWith('#')) continue;

        // Handle simple key: value pairs
        const colonIndex = line.indexOf(':');
        if (colonIndex > 0) {
            const key = line.slice(0, colonIndex).trim();
            let value = line.slice(colonIndex + 1).trim();

            // Remove quotes if present
            if ((value.startsWith('"') && value.endsWith('"')) ||
                (value.startsWith("'") && value.endsWith("'"))) {
                value = value.slice(1, -1);
            }

            // Handle nested keys (simple one-level)
            if (key.includes('.')) {
                const parts = key.split('.');
                let obj = frontmatter;
                for (let i = 0; i < parts.length - 1; i++) {
                    if (!obj[parts[i]]) obj[parts[i]] = {};
                    obj = obj[parts[i]];
                }
                obj[parts[parts.length - 1]] = value;
            } else {
                frontmatter[key] = value;
            }
        }
    }

    return frontmatter;
}

function parseSkillFile(content, skillDir) {
    const skill = {
        name: '',
        triggers: [],
        description: '',
        instructions: '',
        tools: [],
        emoji: '',
        requires: { bins: [], env: [], config: [] },
        dir: skillDir
    };

    let body = content;

    // Check for YAML frontmatter (OpenClaw format)
    if (content.startsWith('---')) {
        const endIndex = content.indexOf('---', 3);
        if (endIndex > 0) {
            const yamlContent = content.slice(3, endIndex).trim();
            const frontmatter = parseYamlFrontmatter(yamlContent);

            // Extract OpenClaw-style fields
            if (frontmatter.name) skill.name = frontmatter.name;
            if (frontmatter.description) skill.description = frontmatter.description;
            if (frontmatter.emoji) skill.emoji = frontmatter.emoji;

            // Handle metadata.openclaw.emoji
            if (frontmatter.metadata?.openclaw?.emoji) {
                skill.emoji = frontmatter.metadata.openclaw.emoji;
            }

            // Handle requires (bins, env, config)
            if (frontmatter.requires?.bins) {
                skill.requires.bins = frontmatter.requires.bins.split(',').map(s => s.trim());
            }
            if (frontmatter.requires?.env) {
                skill.requires.env = frontmatter.requires.env.split(',').map(s => s.trim());
            }

            // Body is everything after frontmatter
            body = content.slice(endIndex + 3).trim();
        }
    }

    const lines = body.split('\n');
    let currentSection = '';
    let sectionContent = [];

    for (const line of lines) {
        // Parse skill name from # heading (if not set by frontmatter)
        if (line.startsWith('# ') && !skill.name) {
            skill.name = line.slice(2).trim();
            continue;
        }

        // Parse trigger keywords (legacy format, still supported)
        if (line.toLowerCase().startsWith('trigger:')) {
            skill.triggers = line.slice(8).split(',').map(t => t.trim().toLowerCase()).filter(Boolean);
            continue;
        }

        // Detect section headers
        if (line.startsWith('## ')) {
            // Save previous section
            if (currentSection && sectionContent.length > 0) {
                const text = sectionContent.join('\n').trim();
                if (currentSection === 'description' && !skill.description) skill.description = text;
                else if (currentSection === 'instructions') skill.instructions = text;
                else if (currentSection === 'tools') {
                    skill.tools = text.split('\n')
                        .filter(l => l.trim().startsWith('-'))
                        .map(l => l.slice(l.indexOf('-') + 1).trim());
                }
            }
            currentSection = line.slice(3).trim().toLowerCase();
            sectionContent = [];
            continue;
        }

        // Accumulate section content
        if (currentSection) {
            sectionContent.push(line);
        }
    }

    // Save last section
    if (currentSection && sectionContent.length > 0) {
        const text = sectionContent.join('\n').trim();
        if (currentSection === 'description' && !skill.description) skill.description = text;
        else if (currentSection === 'instructions') skill.instructions = text;
        else if (currentSection === 'tools') {
            skill.tools = text.split('\n')
                .filter(l => l.trim().startsWith('-'))
                .map(l => l.slice(l.indexOf('-') + 1).trim());
        }
    }

    // If no triggers but has description, use semantic matching (skill will be listed for AI to pick)
    // This enables OpenClaw-style semantic triggering

    return skill;
}

function loadSkills() {
    const skills = [];

    if (!fs.existsSync(SKILLS_DIR)) {
        return skills;
    }

    try {
        const entries = fs.readdirSync(SKILLS_DIR, { withFileTypes: true });

        for (const entry of entries) {
            if (entry.isDirectory()) {
                const skillPath = path.join(SKILLS_DIR, entry.name, 'SKILL.md');
                if (fs.existsSync(skillPath)) {
                    try {
                        const content = fs.readFileSync(skillPath, 'utf8');
                        const skill = parseSkillFile(content, path.join(SKILLS_DIR, entry.name));
                        if (skill.name) {
                            skills.push(skill);
                            log(`Loaded skill: ${skill.name} (triggers: ${skill.triggers.join(', ')})`);
                        }
                    } catch (e) {
                        log(`Error loading skill ${entry.name}: ${e.message}`);
                    }
                }
            }
        }
    } catch (e) {
        log(`Error reading skills directory: ${e.message}`);
    }

    return skills;
}

function findMatchingSkills(message) {
    const skills = loadSkills();
    const lowerMsg = message.toLowerCase();

    return skills.filter(skill =>
        skill.triggers.some(trigger => lowerMsg.includes(trigger))
    );
}

function buildSkillsSection(skills) {
    if (skills.length === 0) return '';

    const lines = ['## Active Skills', ''];
    lines.push('The following skills are available and may be relevant to this request:');
    lines.push('');

    for (const skill of skills) {
        lines.push(`### ${skill.name}`);
        if (skill.description) {
            lines.push(skill.description);
        }
        lines.push('');
        if (skill.instructions) {
            lines.push('**Instructions:**');
            lines.push(skill.instructions);
            lines.push('');
        }
        if (skill.tools.length > 0) {
            lines.push('**Recommended tools:** ' + skill.tools.join(', '));
            lines.push('');
        }
    }

    return lines.join('\n');
}

// Global skills cache (refreshed on each message)
let cachedSkills = [];

// ============================================================================
// HTTP HELPERS
// ============================================================================

function httpRequest(options, body = null) {
    return new Promise((resolve, reject) => {
        const req = https.request(options, (res) => {
            let data = '';
            res.on('data', chunk => data += chunk);
            res.on('end', () => {
                try {
                    resolve({ status: res.statusCode, data: JSON.parse(data) });
                } catch (e) {
                    resolve({ status: res.statusCode, data: data });
                }
            });
        });
        req.on('error', reject);
        req.setTimeout(60000, () => { req.destroy(); reject(new Error('Timeout')); });
        if (body) req.write(typeof body === 'string' ? body : JSON.stringify(body));
        req.end();
    });
}

// ============================================================================
// TELEGRAM API
// ============================================================================

async function telegram(method, body = null) {
    const res = await httpRequest({
        hostname: 'api.telegram.org',
        path: `/bot${BOT_TOKEN}/${method}`,
        method: body ? 'POST' : 'GET',
        headers: body ? { 'Content-Type': 'application/json' } : {},
    }, body);
    return res.data;
}

async function sendMessage(chatId, text, replyTo = null) {
    // Telegram max message length is 4096
    const chunks = [];
    let remaining = text;
    while (remaining.length > 0) {
        chunks.push(remaining.slice(0, 4000));
        remaining = remaining.slice(4000);
    }

    for (const chunk of chunks) {
        let sent = false;

        // Try with Markdown first
        try {
            const result = await telegram('sendMessage', {
                chat_id: chatId,
                text: chunk,
                reply_to_message_id: replyTo,
                parse_mode: 'Markdown',
            });
            // Check if Telegram actually accepted the message
            if (result && result.ok) {
                sent = true;
            }
        } catch (e) {
            // Network error - will retry without markdown
        }

        // Only retry without markdown if the first attempt failed
        if (!sent) {
            try {
                await telegram('sendMessage', {
                    chat_id: chatId,
                    text: chunk,
                    reply_to_message_id: replyTo,
                });
            } catch (e) {
                log(`Failed to send message: ${e.message}`);
            }
        }
    }
}

async function sendTyping(chatId) {
    await telegram('sendChatAction', { chat_id: chatId, action: 'typing' }).catch(() => {});
}

// ============================================================================
// TOOLS
// ============================================================================

const TOOLS = [
    {
        name: 'web_search',
        description: 'Search the web using Brave Search. Use this to find current information, news, or answers to questions.',
        input_schema: {
            type: 'object',
            properties: {
                query: { type: 'string', description: 'The search query' }
            },
            required: ['query']
        }
    },
    {
        name: 'web_fetch',
        description: 'Fetch and read the content of a webpage. Use this to get detailed information from a specific URL.',
        input_schema: {
            type: 'object',
            properties: {
                url: { type: 'string', description: 'The URL to fetch' }
            },
            required: ['url']
        }
    },
    {
        name: 'memory_save',
        description: 'Save important information to long-term memory (MEMORY.md). Use this to remember facts, preferences, or important details about the user.',
        input_schema: {
            type: 'object',
            properties: {
                content: { type: 'string', description: 'The content to save to memory' }
            },
            required: ['content']
        }
    },
    {
        name: 'memory_read',
        description: 'Read the current contents of long-term memory.',
        input_schema: {
            type: 'object',
            properties: {}
        }
    },
    {
        name: 'daily_note',
        description: 'Add a note to today\'s daily memory file. Use this for logging events, conversations, or daily observations.',
        input_schema: {
            type: 'object',
            properties: {
                note: { type: 'string', description: 'The note to add' }
            },
            required: ['note']
        }
    },
    {
        name: 'memory_search',
        description: 'Search across all memory files (MEMORY.md and daily files) for keywords or patterns. Returns matching lines with file paths and line numbers.',
        input_schema: {
            type: 'object',
            properties: {
                query: { type: 'string', description: 'Search term or pattern to find' },
                max_results: { type: 'number', description: 'Maximum results to return (default 20)' }
            },
            required: ['query']
        }
    },
    {
        name: 'memory_get',
        description: 'Get specific lines from a memory file by line number. Use after memory_search to retrieve full context.',
        input_schema: {
            type: 'object',
            properties: {
                file: { type: 'string', description: 'File path relative to workspace (e.g., "MEMORY.md" or "memory/2024-01-15.md")' },
                start_line: { type: 'number', description: 'Starting line number (1-indexed)' },
                end_line: { type: 'number', description: 'Ending line number (optional, defaults to start_line + 10)' }
            },
            required: ['file', 'start_line']
        }
    },
    {
        name: 'read',
        description: 'Read a file from the workspace directory. Only files within workspace/ can be read.',
        input_schema: {
            type: 'object',
            properties: {
                path: { type: 'string', description: 'File path relative to workspace (e.g., "notes.txt", "data/config.json")' }
            },
            required: ['path']
        }
    },
    {
        name: 'write',
        description: 'Write or create a file in the workspace directory. Overwrites if file exists.',
        input_schema: {
            type: 'object',
            properties: {
                path: { type: 'string', description: 'File path relative to workspace' },
                content: { type: 'string', description: 'Content to write to the file' }
            },
            required: ['path', 'content']
        }
    },
    {
        name: 'edit',
        description: 'Edit an existing file in the workspace. Supports append, prepend, or replace operations.',
        input_schema: {
            type: 'object',
            properties: {
                path: { type: 'string', description: 'File path relative to workspace' },
                operation: { type: 'string', enum: ['append', 'prepend', 'replace'], description: 'Type of edit operation' },
                content: { type: 'string', description: 'Content for the operation' },
                search: { type: 'string', description: 'Text to find (required for replace operation)' }
            },
            required: ['path', 'operation', 'content']
        }
    },
    {
        name: 'ls',
        description: 'List files and directories in the workspace. Returns file names, sizes, and types.',
        input_schema: {
            type: 'object',
            properties: {
                path: { type: 'string', description: 'Directory path relative to workspace (default: root)' },
                recursive: { type: 'boolean', description: 'List recursively (default: false)' }
            }
        }
    },
    {
        name: 'skill_read',
        description: 'Read a skill\'s full instructions. Use this when a skill from <available_skills> applies to the user\'s request.',
        input_schema: {
            type: 'object',
            properties: {
                name: { type: 'string', description: 'Name of the skill to read (from available_skills list)' }
            },
            required: ['name']
        }
    },
    {
        name: 'cron_create',
        description: 'Create a scheduled job. Supports one-shot reminders ("in 30 minutes", "tomorrow at 9am") and recurring intervals ("every 2 hours", "every 30 minutes").',
        input_schema: {
            type: 'object',
            properties: {
                name: { type: 'string', description: 'Short name for the job (e.g., "Water plants reminder")' },
                message: { type: 'string', description: 'The message to deliver when the job fires' },
                time: { type: 'string', description: 'When to fire: "in 30 minutes", "tomorrow at 9am", "every 2 hours", "at 3pm"' },
                deleteAfterRun: { type: 'boolean', description: 'If true, delete the job after it runs (default: false for one-shot, N/A for recurring)' }
            },
            required: ['message', 'time']
        }
    },
    {
        name: 'cron_list',
        description: 'List all scheduled jobs with their status and next run time.',
        input_schema: {
            type: 'object',
            properties: {
                includeDisabled: { type: 'boolean', description: 'Include disabled/completed jobs (default: false)' }
            }
        }
    },
    {
        name: 'cron_cancel',
        description: 'Cancel a scheduled job by its ID.',
        input_schema: {
            type: 'object',
            properties: {
                id: { type: 'string', description: 'The job ID to cancel' }
            },
            required: ['id']
        }
    },
    {
        name: 'cron_status',
        description: 'Get scheduling service status: total jobs, next wake time, etc.',
        input_schema: {
            type: 'object',
            properties: {}
        }
    },
    {
        name: 'datetime',
        description: 'Get current date and time in various formats. Supports timezone conversion.',
        input_schema: {
            type: 'object',
            properties: {
                format: { type: 'string', description: 'Output format: "iso", "unix", "human", "date", "time", "full" (default: "full")' },
                timezone: { type: 'string', description: 'Timezone like "America/New_York", "Europe/London", "Asia/Tokyo" (default: local)' }
            }
        }
    },
    {
        name: 'session_status',
        description: 'Get current session information including uptime, memory usage, model, and conversation stats.',
        input_schema: {
            type: 'object',
            properties: {}
        }
    },
    {
        name: 'memory_stats',
        description: 'Get memory system statistics: file sizes, daily file count, total storage used.',
        input_schema: {
            type: 'object',
            properties: {}
        }
    },
    // ==================== Android Bridge Tools ====================
    {
        name: 'android_battery',
        description: 'Get device battery level, charging status, and charge type.',
        input_schema: {
            type: 'object',
            properties: {}
        }
    },
    {
        name: 'android_storage',
        description: 'Get device storage information (total, available, used).',
        input_schema: {
            type: 'object',
            properties: {}
        }
    },
    {
        name: 'android_clipboard_get',
        description: 'Get current clipboard content.',
        input_schema: {
            type: 'object',
            properties: {}
        }
    },
    {
        name: 'android_clipboard_set',
        description: 'Set clipboard content.',
        input_schema: {
            type: 'object',
            properties: {
                content: { type: 'string', description: 'Text to copy to clipboard' }
            },
            required: ['content']
        }
    },
    {
        name: 'android_contacts_search',
        description: 'Search contacts by name. Requires READ_CONTACTS permission.',
        input_schema: {
            type: 'object',
            properties: {
                query: { type: 'string', description: 'Name to search for' },
                limit: { type: 'number', description: 'Max results (default 10)' }
            },
            required: ['query']
        }
    },
    {
        name: 'android_sms',
        description: 'Send an SMS message. Requires SEND_SMS permission. ALWAYS confirm with user before sending.',
        input_schema: {
            type: 'object',
            properties: {
                phone: { type: 'string', description: 'Phone number to send to' },
                message: { type: 'string', description: 'Message text' }
            },
            required: ['phone', 'message']
        }
    },
    {
        name: 'android_call',
        description: 'Make a phone call. Requires CALL_PHONE permission. ALWAYS confirm with user before calling.',
        input_schema: {
            type: 'object',
            properties: {
                phone: { type: 'string', description: 'Phone number to call' }
            },
            required: ['phone']
        }
    },
    {
        name: 'android_location',
        description: 'Get current GPS location. Requires ACCESS_FINE_LOCATION permission.',
        input_schema: {
            type: 'object',
            properties: {}
        }
    },
    {
        name: 'android_tts',
        description: 'Speak text out loud using device text-to-speech.',
        input_schema: {
            type: 'object',
            properties: {
                text: { type: 'string', description: 'Text to speak' },
                speed: { type: 'number', description: 'Speech rate 0.5-2.0 (default 1.0)' },
                pitch: { type: 'number', description: 'Pitch 0.5-2.0 (default 1.0)' }
            },
            required: ['text']
        }
    },
    {
        name: 'android_apps_list',
        description: 'List installed apps that can be launched.',
        input_schema: {
            type: 'object',
            properties: {}
        }
    },
    {
        name: 'android_apps_launch',
        description: 'Launch an app by package name.',
        input_schema: {
            type: 'object',
            properties: {
                package: { type: 'string', description: 'Package name (e.g., com.android.chrome)' }
            },
            required: ['package']
        }
    },
    // Solana Wallet Tools
    {
        name: 'solana_balance',
        description: 'Get SOL balance and SPL token balances for a Solana wallet address.',
        input_schema: {
            type: 'object',
            properties: {
                address: { type: 'string', description: 'Solana wallet public key (base58). If omitted, uses the connected wallet address.' }
            }
        }
    },
    {
        name: 'solana_history',
        description: 'Get recent transaction history for a Solana wallet address.',
        input_schema: {
            type: 'object',
            properties: {
                address: { type: 'string', description: 'Solana wallet public key (base58). If omitted, uses the connected wallet address.' },
                limit: { type: 'number', description: 'Number of transactions (default 10, max 50)' }
            }
        }
    },
    {
        name: 'solana_address',
        description: 'Get the connected Solana wallet address from the SeekerClaw app.',
        input_schema: {
            type: 'object',
            properties: {}
        }
    },
    {
        name: 'solana_send',
        description: 'Send SOL to a Solana address. IMPORTANT: This prompts the user to approve the transaction in their wallet app on the phone. ALWAYS confirm with the user in chat before calling this tool.',
        input_schema: {
            type: 'object',
            properties: {
                to: { type: 'string', description: 'Recipient Solana address (base58)' },
                amount: { type: 'number', description: 'Amount of SOL to send' }
            },
            required: ['to', 'amount']
        }
    }
];

async function executeTool(name, input) {
    log(`Executing tool: ${name}`);

    switch (name) {
        case 'web_search': {
            if (!config.braveApiKey) {
                return { error: 'Brave Search API key not configured. Ask owner to add braveApiKey to config.' };
            }
            try {
                const res = await httpRequest({
                    hostname: 'api.search.brave.com',
                    path: `/res/v1/web/search?q=${encodeURIComponent(input.query)}&count=5`,
                    method: 'GET',
                    headers: { 'X-Subscription-Token': config.braveApiKey }
                });
                if (res.data.web && res.data.web.results) {
                    return res.data.web.results.slice(0, 5).map(r => ({
                        title: r.title,
                        url: r.url,
                        snippet: r.description
                    }));
                }
                return { error: 'No results found' };
            } catch (e) {
                return { error: e.message };
            }
        }

        case 'web_fetch': {
            try {
                const url = new URL(input.url);
                const res = await httpRequest({
                    hostname: url.hostname,
                    path: url.pathname + url.search,
                    method: 'GET',
                    headers: { 'User-Agent': 'SeekerClaw/1.0' }
                });
                // Basic HTML to text conversion
                let text = typeof res.data === 'string' ? res.data : JSON.stringify(res.data);
                text = text.replace(/<script[^>]*>[\s\S]*?<\/script>/gi, '');
                text = text.replace(/<style[^>]*>[\s\S]*?<\/style>/gi, '');
                text = text.replace(/<[^>]+>/g, ' ');
                text = text.replace(/\s+/g, ' ').trim();
                // Limit length
                return { content: text.slice(0, 8000) };
            } catch (e) {
                return { error: e.message };
            }
        }

        case 'memory_save': {
            const currentMemory = loadMemory();
            const newMemory = currentMemory + '\n\n---\n\n' + input.content;
            saveMemory(newMemory.trim());
            return { success: true, message: 'Memory saved' };
        }

        case 'memory_read': {
            const memory = loadMemory();
            return { content: memory || '(Memory is empty)' };
        }

        case 'daily_note': {
            appendDailyMemory(input.note);
            return { success: true, message: 'Note added to daily memory' };
        }

        case 'memory_search': {
            const maxResults = input.max_results || 20;
            const query = input.query.toLowerCase();
            const results = [];

            // Search MEMORY.md
            const memoryPath = path.join(workDir, 'MEMORY.md');
            if (fs.existsSync(memoryPath)) {
                const content = fs.readFileSync(memoryPath, 'utf8');
                const lines = content.split('\n');
                lines.forEach((line, idx) => {
                    if (line.toLowerCase().includes(query)) {
                        results.push({
                            file: 'MEMORY.md',
                            line: idx + 1,
                            content: line.trim().slice(0, 200)
                        });
                    }
                });
            }

            // Search daily memory files
            const memoryDir = path.join(workDir, 'memory');
            if (fs.existsSync(memoryDir)) {
                const files = fs.readdirSync(memoryDir).filter(f => f.endsWith('.md'));
                for (const file of files) {
                    if (results.length >= maxResults) break;
                    const filePath = path.join(memoryDir, file);
                    const content = fs.readFileSync(filePath, 'utf8');
                    const lines = content.split('\n');
                    lines.forEach((line, idx) => {
                        if (results.length < maxResults && line.toLowerCase().includes(query)) {
                            results.push({
                                file: `memory/${file}`,
                                line: idx + 1,
                                content: line.trim().slice(0, 200)
                            });
                        }
                    });
                }
            }

            return {
                query: input.query,
                count: results.length,
                results: results.slice(0, maxResults)
            };
        }

        case 'memory_get': {
            const filePath = path.join(workDir, input.file);
            // Security: ensure path is within workspace
            if (!filePath.startsWith(workDir)) {
                return { error: 'Access denied: path outside workspace' };
            }
            if (!fs.existsSync(filePath)) {
                return { error: `File not found: ${input.file}` };
            }
            const content = fs.readFileSync(filePath, 'utf8');
            const lines = content.split('\n');
            const startLine = Math.max(1, input.start_line) - 1;
            const endLine = Math.min(lines.length, input.end_line || startLine + 11) - 1;
            const selectedLines = lines.slice(startLine, endLine + 1);
            return {
                file: input.file,
                start_line: startLine + 1,
                end_line: endLine + 1,
                content: selectedLines.map((line, i) => `${startLine + i + 1}: ${line}`).join('\n')
            };
        }

        case 'read': {
            const filePath = path.join(workDir, input.path);
            // Security: ensure path is within workspace
            if (!filePath.startsWith(workDir)) {
                return { error: 'Access denied: path outside workspace' };
            }
            if (!fs.existsSync(filePath)) {
                return { error: `File not found: ${input.path}` };
            }
            const stat = fs.statSync(filePath);
            if (stat.isDirectory()) {
                return { error: 'Path is a directory, use ls tool instead' };
            }
            const content = fs.readFileSync(filePath, 'utf8');
            return {
                path: input.path,
                size: stat.size,
                content: content.slice(0, 50000) // Limit to 50KB
            };
        }

        case 'write': {
            const filePath = path.join(workDir, input.path);
            // Security: ensure path is within workspace
            if (!filePath.startsWith(workDir)) {
                return { error: 'Access denied: path outside workspace' };
            }
            // Create parent directories if needed
            const dir = path.dirname(filePath);
            if (!fs.existsSync(dir)) {
                fs.mkdirSync(dir, { recursive: true });
            }
            fs.writeFileSync(filePath, input.content, 'utf8');
            return {
                success: true,
                path: input.path,
                size: input.content.length
            };
        }

        case 'edit': {
            const filePath = path.join(workDir, input.path);
            // Security: ensure path is within workspace
            if (!filePath.startsWith(workDir)) {
                return { error: 'Access denied: path outside workspace' };
            }
            if (!fs.existsSync(filePath)) {
                return { error: `File not found: ${input.path}` };
            }
            let content = fs.readFileSync(filePath, 'utf8');

            switch (input.operation) {
                case 'append':
                    content = content + '\n' + input.content;
                    break;
                case 'prepend':
                    content = input.content + '\n' + content;
                    break;
                case 'replace':
                    if (!input.search) {
                        return { error: 'Replace operation requires search parameter' };
                    }
                    if (!content.includes(input.search)) {
                        return { error: `Search text not found in file: ${input.search.slice(0, 50)}` };
                    }
                    content = content.replace(input.search, input.content);
                    break;
                default:
                    return { error: `Unknown operation: ${input.operation}` };
            }

            fs.writeFileSync(filePath, content, 'utf8');
            return {
                success: true,
                path: input.path,
                operation: input.operation
            };
        }

        case 'ls': {
            const targetPath = path.join(workDir, input.path || '');
            // Security: ensure path is within workspace
            if (!targetPath.startsWith(workDir)) {
                return { error: 'Access denied: path outside workspace' };
            }
            if (!fs.existsSync(targetPath)) {
                return { error: `Directory not found: ${input.path || '/'}` };
            }
            const stat = fs.statSync(targetPath);
            if (!stat.isDirectory()) {
                return { error: 'Path is not a directory' };
            }

            const listDir = (dir, prefix = '') => {
                const entries = [];
                const items = fs.readdirSync(dir);
                for (const item of items) {
                    const itemPath = path.join(dir, item);
                    const itemStat = fs.statSync(itemPath);
                    const entry = {
                        name: prefix + item,
                        type: itemStat.isDirectory() ? 'directory' : 'file',
                        size: itemStat.isDirectory() ? null : itemStat.size
                    };
                    entries.push(entry);
                    if (input.recursive && itemStat.isDirectory()) {
                        entries.push(...listDir(itemPath, prefix + item + '/'));
                    }
                }
                return entries;
            };

            return {
                path: input.path || '/',
                entries: listDir(targetPath)
            };
        }

        case 'skill_read': {
            const skills = loadSkills();
            const skillName = input.name.toLowerCase();
            const skill = skills.find(s => s.name.toLowerCase() === skillName);

            if (!skill) {
                return { error: `Skill not found: ${input.name}. Use skill name from <available_skills> list.` };
            }

            // Read the full SKILL.md content
            const skillPath = path.join(skill.dir, 'SKILL.md');
            if (!fs.existsSync(skillPath)) {
                return { error: `Skill file not found: ${skillPath}` };
            }

            const content = fs.readFileSync(skillPath, 'utf8');

            return {
                name: skill.name,
                description: skill.description,
                instructions: skill.instructions || content,
                tools: skill.tools,
                emoji: skill.emoji
            };
        }

        case 'cron_create': {
            const triggerTime = parseTimeExpression(input.time);
            if (!triggerTime) {
                return { error: `Could not parse time: "${input.time}". Try formats like "in 30 minutes", "tomorrow at 9am", "every 2 hours", "at 3pm", or "2024-01-15 14:30".` };
            }

            const isRecurring = triggerTime._recurring === true;

            if (!isRecurring) {
                const diffMs = triggerTime.getTime() - Date.now();
                if (diffMs < -60000) {
                    return { error: 'Scheduled time is in the past.' };
                }
                if (diffMs > 10 * 365.25 * 24 * 3600000) {
                    return { error: 'Scheduled time is too far in the future (max 10 years).' };
                }
            }

            let schedule;
            if (isRecurring) {
                schedule = {
                    kind: 'every',
                    everyMs: triggerTime._everyMs,
                    anchorMs: Date.now(),
                };
            } else {
                schedule = {
                    kind: 'at',
                    atMs: triggerTime.getTime(),
                };
            }

            const job = cronService.create({
                name: input.name || input.message.slice(0, 50),
                description: input.message,
                schedule,
                payload: { kind: 'reminder', message: input.message },
                deleteAfterRun: input.deleteAfterRun || false,
            });

            return {
                success: true,
                id: job.id,
                name: job.name,
                message: input.message,
                type: isRecurring ? 'recurring' : 'one-shot',
                nextRunAt: job.state.nextRunAtMs ? new Date(job.state.nextRunAtMs).toISOString() : null,
                nextRunIn: job.state.nextRunAtMs ? formatDuration(job.state.nextRunAtMs - Date.now()) : null,
                interval: isRecurring ? formatDuration(triggerTime._everyMs) : null,
            };
        }

        case 'cron_list': {
            const jobs = cronService.list({ includeDisabled: input.includeDisabled || false });

            return {
                count: jobs.length,
                jobs: jobs.map(j => ({
                    id: j.id,
                    name: j.name,
                    type: j.schedule.kind,
                    enabled: j.enabled,
                    message: j.payload?.message || j.description,
                    nextRunAt: j.state.nextRunAtMs ? new Date(j.state.nextRunAtMs).toISOString() : null,
                    nextRunIn: j.state.nextRunAtMs ? formatDuration(j.state.nextRunAtMs - Date.now()) : null,
                    lastRun: j.state.lastRunAtMs ? new Date(j.state.lastRunAtMs).toISOString() : null,
                    lastStatus: j.state.lastStatus || 'never',
                }))
            };
        }

        case 'cron_cancel': {
            const jobs = cronService.list({ includeDisabled: true });
            const job = jobs.find(j => j.id === input.id);

            if (!job) {
                return { error: `Job not found: ${input.id}` };
            }

            const removed = cronService.remove(input.id);
            return {
                success: removed,
                id: input.id,
                message: `Job "${job.name}" cancelled and removed.`
            };
        }

        case 'cron_status': {
            return cronService.status();
        }

        case 'datetime': {
            const now = new Date();
            const format = input.format || 'full';

            // Timezone handling
            let dateStr;
            const tz = input.timezone;

            const formatDate = (date, tzOpt) => {
                const options = tzOpt ? { timeZone: tzOpt } : {};

                switch (format) {
                    case 'iso':
                        return date.toISOString();
                    case 'unix':
                        return Math.floor(date.getTime() / 1000).toString();
                    case 'date':
                        return date.toLocaleDateString('en-US', { ...options, weekday: 'long', year: 'numeric', month: 'long', day: 'numeric' });
                    case 'time':
                        return date.toLocaleTimeString('en-US', { ...options, hour: '2-digit', minute: '2-digit', second: '2-digit' });
                    case 'human':
                        return date.toLocaleString('en-US', { ...options, dateStyle: 'medium', timeStyle: 'short' });
                    case 'full':
                    default:
                        return date.toLocaleString('en-US', {
                            ...options,
                            weekday: 'long',
                            year: 'numeric',
                            month: 'long',
                            day: 'numeric',
                            hour: '2-digit',
                            minute: '2-digit',
                            second: '2-digit',
                            timeZoneName: 'short'
                        });
                }
            };

            try {
                dateStr = formatDate(now, tz);
            } catch (e) {
                // Invalid timezone, fall back to local
                dateStr = formatDate(now, null);
            }

            return {
                formatted: dateStr,
                iso: now.toISOString(),
                unix: Math.floor(now.getTime() / 1000),
                timezone: tz || 'local',
                dayOfWeek: now.toLocaleDateString('en-US', { weekday: 'long' }),
                weekNumber: Math.ceil((now - new Date(now.getFullYear(), 0, 1)) / (7 * 24 * 60 * 60 * 1000))
            };
        }

        case 'session_status': {
            const uptime = Math.floor(process.uptime());
            const memUsage = process.memoryUsage();
            const totalConversations = conversations.size;
            let totalMessages = 0;
            conversations.forEach(conv => totalMessages += conv.length);

            return {
                agent: AGENT_NAME,
                model: MODEL,
                uptime: {
                    seconds: uptime,
                    formatted: `${Math.floor(uptime / 3600)}h ${Math.floor((uptime % 3600) / 60)}m ${uptime % 60}s`
                },
                memory: {
                    rss: Math.round(memUsage.rss / 1024 / 1024),
                    heapUsed: Math.round(memUsage.heapUsed / 1024 / 1024),
                    heapTotal: Math.round(memUsage.heapTotal / 1024 / 1024),
                    external: Math.round(memUsage.external / 1024 / 1024)
                },
                conversations: {
                    active: totalConversations,
                    totalMessages: totalMessages
                },
                runtime: {
                    nodeVersion: process.version,
                    platform: process.platform,
                    arch: process.arch
                },
                features: {
                    webSearch: !!config.braveApiKey,
                    reminders: true,
                    skills: loadSkills().length
                }
            };
        }

        case 'memory_stats': {
            const stats = {
                memoryMd: { exists: false, size: 0 },
                dailyFiles: { count: 0, totalSize: 0, oldestDate: null, newestDate: null },
                total: { size: 0, warning: null }
            };

            // Check MEMORY.md
            const memoryPath = path.join(workDir, 'MEMORY.md');
            if (fs.existsSync(memoryPath)) {
                const stat = fs.statSync(memoryPath);
                stats.memoryMd.exists = true;
                stats.memoryMd.size = stat.size;
                stats.total.size += stat.size;

                // Warn if MEMORY.md exceeds 50KB
                if (stat.size > 50 * 1024) {
                    stats.total.warning = `MEMORY.md is ${Math.round(stat.size / 1024)}KB - consider archiving old entries`;
                }
            }

            // Check daily memory files
            const memoryDir = path.join(workDir, 'memory');
            if (fs.existsSync(memoryDir)) {
                const files = fs.readdirSync(memoryDir).filter(f => f.endsWith('.md')).sort();
                stats.dailyFiles.count = files.length;

                if (files.length > 0) {
                    stats.dailyFiles.oldestDate = files[0].replace('.md', '');
                    stats.dailyFiles.newestDate = files[files.length - 1].replace('.md', '');
                }

                for (const file of files) {
                    const filePath = path.join(memoryDir, file);
                    const stat = fs.statSync(filePath);
                    stats.dailyFiles.totalSize += stat.size;
                    stats.total.size += stat.size;
                }
            }

            // Format sizes for readability
            stats.memoryMd.sizeFormatted = formatBytes(stats.memoryMd.size);
            stats.dailyFiles.totalSizeFormatted = formatBytes(stats.dailyFiles.totalSize);
            stats.total.sizeFormatted = formatBytes(stats.total.size);

            // Check if we have too many daily files (>30 days)
            if (stats.dailyFiles.count > 30) {
                stats.total.warning = (stats.total.warning || '') +
                    ` ${stats.dailyFiles.count} daily files - consider pruning old files.`;
            }

            return stats;
        }

        // ==================== Android Bridge Tools ====================

        case 'android_battery': {
            return await androidBridgeCall('/battery');
        }

        case 'android_storage': {
            return await androidBridgeCall('/storage');
        }

        case 'android_clipboard_get': {
            return await androidBridgeCall('/clipboard/get');
        }

        case 'android_clipboard_set': {
            return await androidBridgeCall('/clipboard/set', { content: input.content });
        }

        case 'android_contacts_search': {
            return await androidBridgeCall('/contacts/search', {
                query: input.query,
                limit: input.limit || 10
            });
        }

        case 'android_sms': {
            return await androidBridgeCall('/sms', {
                phone: input.phone,
                message: input.message
            });
        }

        case 'android_call': {
            return await androidBridgeCall('/call', { phone: input.phone });
        }

        case 'android_location': {
            return await androidBridgeCall('/location');
        }

        case 'android_tts': {
            return await androidBridgeCall('/tts', {
                text: input.text,
                speed: input.speed || 1.0,
                pitch: input.pitch || 1.0
            });
        }

        case 'android_apps_list': {
            return await androidBridgeCall('/apps/list');
        }

        case 'android_apps_launch': {
            return await androidBridgeCall('/apps/launch', { package: input.package });
        }

        // ==================== Solana Tools ====================

        case 'solana_address': {
            const walletConfigPath = path.join(workDir, 'solana_wallet.json');
            if (fs.existsSync(walletConfigPath)) {
                try {
                    const walletConfig = JSON.parse(fs.readFileSync(walletConfigPath, 'utf8'));
                    return { address: walletConfig.publicKey, label: walletConfig.label || '' };
                } catch (e) {
                    return { error: 'Failed to read wallet config' };
                }
            }
            return { error: 'No wallet connected. Connect a wallet in the SeekerClaw app Settings.' };
        }

        case 'solana_balance': {
            let address = input.address;
            if (!address) {
                const walletConfigPath = path.join(workDir, 'solana_wallet.json');
                if (fs.existsSync(walletConfigPath)) {
                    try {
                        address = JSON.parse(fs.readFileSync(walletConfigPath, 'utf8')).publicKey;
                    } catch (_) {}
                }
            }
            if (!address) return { error: 'No wallet address provided and no wallet connected.' };

            const balanceResult = await solanaRpc('getBalance', [address]);
            if (balanceResult.error) return { error: balanceResult.error };

            const solBalance = (balanceResult.value || 0) / 1e9;

            const tokenResult = await solanaRpc('getTokenAccountsByOwner', [
                address,
                { programId: 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA' },
                { encoding: 'jsonParsed' }
            ]);

            const tokens = [];
            if (tokenResult.value) {
                for (const account of tokenResult.value) {
                    try {
                        const info = account.account.data.parsed.info;
                        if (parseFloat(info.tokenAmount.uiAmountString) > 0) {
                            tokens.push({
                                mint: info.mint,
                                amount: info.tokenAmount.uiAmountString,
                                decimals: info.tokenAmount.decimals,
                            });
                        }
                    } catch (_) {}
                }
            }

            return { address, sol: solBalance, tokens, tokenCount: tokens.length };
        }

        case 'solana_history': {
            let address = input.address;
            if (!address) {
                const walletConfigPath = path.join(workDir, 'solana_wallet.json');
                if (fs.existsSync(walletConfigPath)) {
                    try {
                        address = JSON.parse(fs.readFileSync(walletConfigPath, 'utf8')).publicKey;
                    } catch (_) {}
                }
            }
            if (!address) return { error: 'No wallet address provided and no wallet connected.' };

            const limit = Math.min(input.limit || 10, 50);
            const signatures = await solanaRpc('getSignaturesForAddress', [address, { limit }]);
            if (signatures.error) return { error: signatures.error };

            return {
                address,
                transactions: (signatures || []).map(sig => ({
                    signature: sig.signature,
                    slot: sig.slot,
                    blockTime: sig.blockTime ? new Date(sig.blockTime * 1000).toISOString() : null,
                    status: sig.err ? 'Failed' : 'Success',
                    memo: sig.memo || null,
                })),
                count: (signatures || []).length,
            };
        }

        case 'solana_send': {
            // Build tx in JS, wallet signs AND broadcasts via signAndSendTransactions
            const walletConfigPath = path.join(workDir, 'solana_wallet.json');
            if (!fs.existsSync(walletConfigPath)) {
                return { error: 'No wallet connected. Connect a wallet in the SeekerClaw app Settings.' };
            }
            const walletConfig = JSON.parse(fs.readFileSync(walletConfigPath, 'utf8'));
            const from = walletConfig.publicKey;
            const to = input.to;
            const amount = input.amount;

            if (!to || !amount || amount <= 0) {
                return { error: 'Both "to" address and a positive "amount" are required.' };
            }

            // Step 1: Get latest blockhash
            const blockhashResult = await solanaRpc('getLatestBlockhash', [{ commitment: 'finalized' }]);
            if (blockhashResult.error) return { error: 'Failed to get blockhash: ' + blockhashResult.error };
            const recentBlockhash = blockhashResult.blockhash || (blockhashResult.value && blockhashResult.value.blockhash);
            if (!recentBlockhash) return { error: 'No blockhash returned from RPC' };

            // Step 2: Build unsigned transaction
            const lamports = Math.round(amount * 1e9);
            let unsignedTx;
            try {
                unsignedTx = buildSolTransferTx(from, to, lamports, recentBlockhash);
            } catch (e) {
                return { error: 'Failed to build transaction: ' + e.message };
            }
            const txBase64 = unsignedTx.toString('base64');

            // Step 3: Send to wallet — wallet signs AND broadcasts (signAndSendTransactions)
            const result = await androidBridgeCall('/solana/sign', { transaction: txBase64 });
            if (result.error) return { error: result.error };
            if (!result.signature) return { error: 'No signature returned from wallet' };

            // Convert base64 signature to base58 for display
            const sigBytes = Buffer.from(result.signature, 'base64');
            const sigBase58 = base58Encode(sigBytes);

            return { signature: sigBase58, success: true };
        }

        default:
            return { error: `Unknown tool: ${name}` };
    }
}

// Helper for Android Bridge HTTP calls
async function androidBridgeCall(endpoint, data = {}) {
    const http = require('http');

    return new Promise((resolve) => {
        const postData = JSON.stringify(data);

        const req = http.request({
            hostname: 'localhost',
            port: 8765,
            path: endpoint,
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'Content-Length': Buffer.byteLength(postData)
            },
            timeout: 10000
        }, (res) => {
            let body = '';
            res.on('data', chunk => body += chunk);
            res.on('end', () => {
                try {
                    resolve(JSON.parse(body));
                } catch (e) {
                    resolve({ error: 'Invalid response from Android Bridge' });
                }
            });
        });

        req.on('error', (e) => {
            log(`Android Bridge error: ${e.message}`);
            resolve({ error: `Android Bridge unavailable: ${e.message}` });
        });

        req.on('timeout', () => {
            req.destroy();
            resolve({ error: 'Android Bridge timeout' });
        });

        req.write(postData);
        req.end();
    });
}

// ============================================================================
// SOLANA RPC
// ============================================================================

const SOLANA_RPC_URL = 'https://api.mainnet-beta.solana.com';

async function solanaRpc(method, params = []) {
    return new Promise((resolve) => {
        const postData = JSON.stringify({
            jsonrpc: '2.0',
            id: 1,
            method: method,
            params: params,
        });

        const url = new URL(SOLANA_RPC_URL);
        const options = {
            hostname: url.hostname,
            port: 443,
            path: url.pathname,
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'Content-Length': Buffer.byteLength(postData),
            },
            timeout: 15000,
        };

        const req = https.request(options, (res) => {
            let body = '';
            res.on('data', chunk => body += chunk);
            res.on('end', () => {
                try {
                    const json = JSON.parse(body);
                    if (json.error) {
                        resolve({ error: json.error.message });
                    } else {
                        resolve(json.result);
                    }
                } catch (e) {
                    resolve({ error: 'Invalid RPC response' });
                }
            });
        });

        req.on('error', (e) => resolve({ error: e.message }));
        req.on('timeout', () => { req.destroy(); resolve({ error: 'Solana RPC timeout' }); });
        req.write(postData);
        req.end();
    });
}

// Base58 decode for Solana public keys and blockhashes
function base58Decode(str) {
    const ALPHABET = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';
    let zeros = 0;
    for (let i = 0; i < str.length && str[i] === '1'; i++) zeros++;
    let value = 0n;
    for (let i = 0; i < str.length; i++) {
        const idx = ALPHABET.indexOf(str[i]);
        if (idx < 0) throw new Error('Invalid base58 character: ' + str[i]);
        value = value * 58n + BigInt(idx);
    }
    const hex = value.toString(16);
    const hexPadded = hex.length % 2 ? '0' + hex : hex;
    const decoded = Buffer.from(hexPadded, 'hex');
    const result = Buffer.alloc(zeros + decoded.length);
    decoded.copy(result, zeros);
    return result;
}

// Base58 encode for Solana transaction signatures
function base58Encode(buf) {
    const ALPHABET = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';
    let zeros = 0;
    for (let i = 0; i < buf.length && buf[i] === 0; i++) zeros++;
    let value = 0n;
    for (let i = 0; i < buf.length; i++) {
        value = value * 256n + BigInt(buf[i]);
    }
    let result = '';
    while (value > 0n) {
        result = ALPHABET[Number(value % 58n)] + result;
        value = value / 58n;
    }
    return '1'.repeat(zeros) + result;
}

// Build an unsigned SOL transfer transaction (legacy format)
function buildSolTransferTx(fromBase58, toBase58, lamports, recentBlockhashBase58) {
    const from = base58Decode(fromBase58);
    const to = base58Decode(toBase58);
    const blockhash = base58Decode(recentBlockhashBase58);
    const systemProgram = Buffer.alloc(32); // 11111111111111111111111111111111

    // SystemProgram.Transfer instruction data: u32 LE index(2) + u64 LE lamports
    const instructionData = Buffer.alloc(12);
    instructionData.writeUInt32LE(2, 0);
    instructionData.writeBigUInt64LE(BigInt(lamports), 4);

    // Message: header + account keys + blockhash + instructions
    const message = Buffer.concat([
        Buffer.from([1, 0, 1]),          // num_required_sigs=1, readonly_signed=0, readonly_unsigned=1
        Buffer.from([3]),                // compact-u16: 3 account keys
        from,                            // index 0: from (signer, writable)
        to,                              // index 1: to (writable)
        systemProgram,                   // index 2: System Program (readonly)
        blockhash,                       // recent blockhash
        Buffer.from([1]),                // compact-u16: 1 instruction
        Buffer.from([2]),                // program_id_index = 2 (System Program)
        Buffer.from([2, 0, 1]),          // compact-u16 num_accounts=2, indices [0, 1]
        Buffer.from([12]),               // compact-u16 data_length=12
        instructionData,
    ]);

    // Full transaction: signature count + empty signature + message
    return Buffer.concat([
        Buffer.from([1]),                // compact-u16: 1 signature
        Buffer.alloc(64),               // empty signature placeholder
        message,
    ]);
}

// Helper to format bytes
function formatBytes(bytes) {
    if (bytes === 0) return '0 B';
    const k = 1024;
    const sizes = ['B', 'KB', 'MB', 'GB'];
    const i = Math.floor(Math.log(bytes) / Math.log(k));
    return parseFloat((bytes / Math.pow(k, i)).toFixed(2)) + ' ' + sizes[i];
}

// Helper to format duration
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
// CLAUDE API
// ============================================================================

// Conversation history per chat
const conversations = new Map();
const MAX_HISTORY = 20;

function getConversation(chatId) {
    if (!conversations.has(chatId)) {
        conversations.set(chatId, []);
    }
    return conversations.get(chatId);
}

function addToConversation(chatId, role, content) {
    const conv = getConversation(chatId);
    conv.push({ role, content });
    // Keep last N messages
    while (conv.length > MAX_HISTORY) {
        conv.shift();
    }
}

function clearConversation(chatId) {
    conversations.set(chatId, []);
}

function buildSystemPrompt(matchedSkills = []) {
    const soul = loadSoul();
    const memory = loadMemory();
    const dailyMemory = loadDailyMemory();
    const allSkills = loadSkills();
    const bootstrap = loadBootstrap();
    const identity = loadIdentity();
    const user = loadUser();

    const lines = [];

    // BOOTSTRAP MODE - First run ritual takes priority
    if (bootstrap) {
        lines.push('# FIRST RUN - BOOTSTRAP MODE');
        lines.push('');
        lines.push('**IMPORTANT:** This is your first conversation. BOOTSTRAP.md exists in your workspace.');
        lines.push('You must follow the bootstrap ritual to establish your identity and learn about your human.');
        lines.push('Read BOOTSTRAP.md carefully and guide this conversation through the ritual steps.');
        lines.push('After completing all steps, use the write tool to delete BOOTSTRAP.md (write empty content to it).');
        lines.push('');
        lines.push('---');
        lines.push('');
        lines.push(bootstrap);
        lines.push('');
        lines.push('---');
        lines.push('');
    }

    // Identity - matches OpenClaw style
    lines.push('You are a personal assistant running inside SeekerClaw on Android.');
    lines.push('');

    // Tooling section - OpenClaw style
    lines.push('## Tooling');
    lines.push('Tool availability (filtered by policy):');
    lines.push('Tool names are case-sensitive. Call tools exactly as listed.');
    lines.push('');
    lines.push('**Web:**');
    lines.push('- web_search: Search the web (Brave API)');
    lines.push('- web_fetch: Fetch and extract readable content from a URL');
    lines.push('');
    lines.push('**Memory:**');
    lines.push('- memory_save: Save important info to long-term memory (MEMORY.md)');
    lines.push('- memory_read: Read current long-term memory');
    lines.push('- memory_search: Search all memory files for keywords (returns file:line citations)');
    lines.push('- memory_get: Get specific lines from a memory file by line number');
    lines.push('- daily_note: Add note to today\'s daily memory file');
    lines.push('');
    lines.push('**Workspace:**');
    lines.push('- read: Read a file from workspace');
    lines.push('- write: Write/create a file in workspace');
    lines.push('- edit: Edit a file (append, prepend, replace)');
    lines.push('- ls: List files and directories');
    lines.push('');
    lines.push('**Skills:**');
    lines.push('- skill_read: Load a skill\'s instructions (use when a skill applies)');
    lines.push('');
    lines.push('**Scheduling:**');
    lines.push('- cron_create: Create a scheduled job — one-shot ("in 30 min", "tomorrow at 9am") or recurring ("every 2 hours")');
    lines.push('- cron_list: List all scheduled jobs with status and next run time');
    lines.push('- cron_cancel: Cancel and remove a scheduled job by ID');
    lines.push('- cron_status: Get scheduling service status (total jobs, next wake time)');
    lines.push('');
    lines.push('**Utility:**');
    lines.push('- datetime: Get current date/time in various formats and timezones');
    lines.push('- session_status: Get session info (uptime, memory, model, stats)');
    lines.push('- memory_stats: Get memory system statistics (file sizes, daily file count)');
    lines.push('');
    lines.push('**Android (requires permissions):**');
    lines.push('- android_battery: Get battery level and charging status');
    lines.push('- android_storage: Get storage info (total, available, used)');
    lines.push('- android_clipboard_get/set: Read/write system clipboard');
    lines.push('- android_contacts_search: Search contacts by name');
    lines.push('- android_sms: Send SMS (ALWAYS confirm with user first!)');
    lines.push('- android_call: Make phone call (ALWAYS confirm with user first!)');
    lines.push('- android_location: Get GPS location');
    lines.push('- android_tts: Speak text out loud');
    lines.push('- android_apps_list: List installed apps');
    lines.push('- android_apps_launch: Launch an app by package name');
    lines.push('');
    lines.push('### Solana Wallet');
    lines.push('- solana_balance: Get SOL and token balances');
    lines.push('- solana_history: Get recent transactions');
    lines.push('- solana_address: Get connected wallet address');
    lines.push('- solana_send: Send SOL (requires user confirmation + wallet approval on device)');
    lines.push('');

    // Tool Call Style - OpenClaw style
    lines.push('## Tool Call Style');
    lines.push('Default: do not narrate routine, low-risk tool calls (just call the tool).');
    lines.push('Narrate only when it helps: multi-step work, complex/challenging problems, sensitive actions (e.g., deletions), or when the user explicitly asks.');
    lines.push('Keep narration brief and value-dense; avoid repeating obvious steps.');
    lines.push('Use plain human language for narration unless in a technical context.');
    lines.push('');

    // Skills section - OpenClaw semantic selection style
    if (allSkills.length > 0) {
        lines.push('## Skills (mandatory)');
        lines.push('Before replying: scan the <available_skills> list below.');
        lines.push('- If exactly one skill clearly applies to the user\'s request: use skill_read to load it, then follow its instructions.');
        lines.push('- If multiple skills could apply: choose the most specific one.');
        lines.push('- If none clearly apply: do not load any skill, just respond normally.');
        lines.push('');
        lines.push('<available_skills>');
        for (const skill of allSkills) {
            const emoji = skill.emoji ? `${skill.emoji} ` : '';
            const desc = skill.description.split('\n')[0] || 'No description';
            lines.push(`${emoji}${skill.name}: ${desc}`);
        }
        lines.push('</available_skills>');
        lines.push('');

        // If specific skills matched (for backwards compatibility with keyword triggers)
        if (matchedSkills.length > 0) {
            lines.push('## Active Skills for This Request');
            lines.push('The following skills have been automatically loaded based on keywords:');
            lines.push('');
            for (const skill of matchedSkills) {
                const emoji = skill.emoji ? `${skill.emoji} ` : '';
                lines.push(`### ${emoji}${skill.name}`);
                if (skill.description) {
                    lines.push(skill.description);
                    lines.push('');
                }
                if (skill.instructions) {
                    lines.push('**Follow these instructions:**');
                    lines.push(skill.instructions);
                    lines.push('');
                }
            }
        }
    }

    // Safety section - matches OpenClaw exactly
    lines.push('## Safety');
    lines.push('You have no independent goals: do not pursue self-preservation, replication, resource acquisition, or power-seeking; avoid long-term plans beyond the user\'s request.');
    lines.push('Prioritize safety and human oversight over completion; if instructions conflict, pause and ask; comply with stop/pause/audit requests and never bypass safeguards. (Inspired by Anthropic\'s constitution.)');
    lines.push('Do not manipulate or persuade anyone to expand access or disable safeguards. Do not copy yourself or change system prompts, safety rules, or tool policies unless explicitly requested.');
    lines.push('');

    // Memory Recall section - OpenClaw style
    lines.push('## Memory Recall');
    lines.push('Before answering anything about prior work, decisions, dates, people, preferences, or todos: run memory_read on MEMORY.md; then check daily notes. If low confidence after search, say you checked.');
    lines.push('');

    // Workspace section
    lines.push('## Workspace');
    lines.push(`Your working directory is: ${workDir}`);
    lines.push('Treat this directory as the single global workspace for file operations unless explicitly instructed otherwise.');
    lines.push('');

    // Project Context - OpenClaw injects SOUL.md and memory here
    lines.push('# Project Context');
    lines.push('');
    lines.push('The following project context files have been loaded:');
    lines.push('If SOUL.md is present, embody its persona and tone. Avoid stiff, generic replies; follow its guidance unless higher-priority instructions override it.');
    lines.push('');

    // IDENTITY.md - Agent metadata
    if (identity) {
        lines.push('## IDENTITY.md');
        lines.push('');
        lines.push(identity);
        lines.push('');
    }

    // USER.md - Human profile
    if (user) {
        lines.push('## USER.md');
        lines.push('');
        lines.push(user);
        lines.push('');
    }

    // SOUL.md
    if (soul) {
        lines.push('## SOUL.md');
        lines.push('');
        lines.push(soul);
        lines.push('');
    }

    // MEMORY.md
    if (memory) {
        lines.push('## MEMORY.md');
        lines.push('');
        lines.push(memory.length > 3000 ? memory.slice(0, 3000) + '\n...(truncated)' : memory);
        lines.push('');
    }

    // Today's daily memory
    if (dailyMemory) {
        const date = new Date().toISOString().split('T')[0];
        lines.push(`## memory/${date}.md`);
        lines.push('');
        lines.push(dailyMemory.length > 1500 ? dailyMemory.slice(0, 1500) + '\n...(truncated)' : dailyMemory);
        lines.push('');
    }

    // Heartbeat section - OpenClaw style
    lines.push('## Heartbeats');
    lines.push('Heartbeat prompt: (configured)');
    lines.push('If you receive a heartbeat poll (a user message matching the heartbeat prompt above), and there is nothing that needs attention, reply exactly:');
    lines.push('HEARTBEAT_OK');
    lines.push('SeekerClaw treats a leading/trailing "HEARTBEAT_OK" as a heartbeat ack (and may discard it).');
    lines.push('If something needs attention, do NOT include "HEARTBEAT_OK"; reply with the alert text instead.');
    lines.push('');

    // User Identity section - OpenClaw style
    lines.push('## User Identity');
    lines.push(`Telegram Owner ID: ${OWNER_ID || '(pending auto-detect)'}`);
    lines.push('You are talking to your owner. Treat messages from this ID as trusted.');
    lines.push('');

    // Silent Replies section - OpenClaw style
    lines.push('## Silent Replies');
    lines.push('If nothing useful to say (no action taken, no information to convey), reply with exactly:');
    lines.push('SILENT_REPLY');
    lines.push('SeekerClaw will discard the message instead of sending it to Telegram.');
    lines.push('Use sparingly — most messages should have content.');
    lines.push('');

    // Reply Tags section - OpenClaw style (Telegram-specific)
    lines.push('## Reply Tags');
    lines.push('To reply to the current message (quoting it in Telegram), start your reply with:');
    lines.push('[[reply_to_current]]');
    lines.push('This creates a quoted reply in Telegram. Use when directly responding to a specific question or statement.');
    lines.push('');

    // Runtime section - OpenClaw style
    lines.push('## Runtime');
    lines.push(`Platform: Android ${process.arch} | Node: ${process.version} | Model: ${MODEL}`);
    lines.push(`Channel: telegram | Agent: ${AGENT_NAME}`);
    lines.push(`Current time: ${new Date().toLocaleString()}`);

    return lines.join('\n');
}

async function chat(chatId, userMessage) {
    // Find skills that match this message
    const matchedSkills = findMatchingSkills(userMessage);
    if (matchedSkills.length > 0) {
        log(`Matched skills: ${matchedSkills.map(s => s.name).join(', ')}`);
    }

    const systemPrompt = buildSystemPrompt(matchedSkills);

    // Add user message to history
    addToConversation(chatId, 'user', userMessage);

    const messages = getConversation(chatId);

    // Call Claude API with tool use loop
    let response;
    let toolUseCount = 0;
    const MAX_TOOL_USES = 5;

    while (toolUseCount < MAX_TOOL_USES) {
        const body = JSON.stringify({
            model: MODEL,
            max_tokens: 4096,
            system: systemPrompt,
            tools: TOOLS,
            messages: messages
        });

        const authHeaders = AUTH_TYPE === 'setup_token'
            ? { 'Authorization': `Bearer ${ANTHROPIC_KEY}` }
            : { 'x-api-key': ANTHROPIC_KEY };

        const res = await httpRequest({
            hostname: 'api.anthropic.com',
            path: '/v1/messages',
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'anthropic-version': '2023-06-01',
                ...authHeaders,
            }
        }, body);

        if (res.status !== 200) {
            log(`Claude API error: ${res.status} - ${JSON.stringify(res.data)}`);
            throw new Error(`API error: ${res.data.error?.message || res.status}`);
        }

        response = res.data;

        // Check if we need to handle tool use
        const toolUses = response.content.filter(c => c.type === 'tool_use');

        if (toolUses.length === 0) {
            // No tool use, we're done
            break;
        }

        // Execute tools and add results
        toolUseCount++;

        // Add assistant's response with tool use to history
        messages.push({ role: 'assistant', content: response.content });

        // Execute each tool and collect results
        const toolResults = [];
        for (const toolUse of toolUses) {
            log(`Tool use: ${toolUse.name}`);
            const result = await executeTool(toolUse.name, toolUse.input);
            toolResults.push({
                type: 'tool_result',
                tool_use_id: toolUse.id,
                content: JSON.stringify(result)
            });
        }

        // Add tool results to history
        messages.push({ role: 'user', content: toolResults });
    }

    // Extract text response
    const textContent = response.content.find(c => c.type === 'text');
    const assistantMessage = textContent ? textContent.text : '(No response)';

    // Update conversation history with final response
    addToConversation(chatId, 'assistant', assistantMessage);

    return assistantMessage;
}

// ============================================================================
// COMMAND HANDLERS
// ============================================================================

async function handleCommand(chatId, command, args) {
    switch (command) {
        case '/start':
            return `Hello! I'm ${AGENT_NAME}, your AI assistant running on Android via SeekerClaw.

I can:
- Have conversations and remember context
- Search the web for current information
- Save and recall memories
- Take daily notes
- Use specialized skills for specific tasks

Commands:
/status - Show system status
/reset - Clear conversation history
/soul - Show my personality
/memory - Show long-term memory
/skills - List installed skills
/help - Show this message

Just send me a message to chat!`;

        case '/help':
            return handleCommand(chatId, '/start', '');

        case '/status': {
            const uptime = Math.floor(process.uptime());
            const memUsage = process.memoryUsage();
            return `*Status*
Agent: ${AGENT_NAME}
Model: ${MODEL}
Uptime: ${Math.floor(uptime / 3600)}h ${Math.floor((uptime % 3600) / 60)}m ${uptime % 60}s
Memory: ${Math.round(memUsage.rss / 1024 / 1024)} MB
Node: ${process.version}
Platform: ${process.platform} ${process.arch}
Conversation: ${getConversation(chatId).length} messages
Web Search: ${config.braveApiKey ? 'Enabled' : 'Disabled'}`;
        }

        case '/reset':
            clearConversation(chatId);
            return 'Conversation history cleared. Starting fresh!';

        case '/soul': {
            const soul = loadSoul();
            return `*SOUL.md*\n\n${soul.slice(0, 3000)}${soul.length > 3000 ? '\n\n...(truncated)' : ''}`;
        }

        case '/memory': {
            const memory = loadMemory();
            if (!memory) {
                return 'Long-term memory is empty.';
            }
            return `*MEMORY.md*\n\n${memory.slice(0, 3000)}${memory.length > 3000 ? '\n\n...(truncated)' : ''}`;
        }

        case '/skills': {
            const skills = loadSkills();
            if (skills.length === 0) {
                return `*No skills installed*

Skills are specialized capabilities you can add to your agent.

To add a skill, create a folder in:
\`workspace/skills/your-skill-name/SKILL.md\`

SKILL.md format:
\`\`\`
# Skill Name

Trigger: keyword1, keyword2

## Description
What this skill does

## Instructions
How to handle matching requests
\`\`\``;
            }

            let response = `*Installed Skills (${skills.length})*\n\n`;
            for (const skill of skills) {
                response += `**${skill.name}**\n`;
                response += `Triggers: ${skill.triggers.join(', ')}\n`;
                if (skill.description) {
                    response += `${skill.description.split('\n')[0]}\n`;
                }
                response += '\n';
            }
            return response;
        }

        default:
            return null; // Not a command
    }
}

// ============================================================================
// MESSAGE HANDLER
// ============================================================================

async function handleMessage(msg) {
    const chatId = msg.chat.id;
    const senderId = String(msg.from?.id);
    const text = (msg.text || '').trim();

    if (!text) return;

    // Owner auto-detect: first person to message claims ownership
    if (!OWNER_ID) {
        OWNER_ID = senderId;
        log(`Owner claimed by ${senderId} (auto-detect)`);

        // Persist to config.json
        try {
            const cfg = JSON.parse(fs.readFileSync(configPath, 'utf8'));
            cfg.ownerId = senderId;
            fs.writeFileSync(configPath, JSON.stringify(cfg, null, 2), 'utf8');
        } catch (e) {
            log(`Warning: Could not save owner to config.json: ${e.message}`);
        }

        // Persist to Android encrypted storage
        androidBridgeCall('/config/set-owner', { ownerId: senderId }).catch(() => {});

        await sendMessage(chatId, `Owner set to your account (${senderId}). Only you can use this bot.`);
    }

    // Only respond to owner
    if (senderId !== OWNER_ID) {
        log(`Ignoring message from ${senderId} (not owner)`);
        return;
    }

    log(`Message: ${text.slice(0, 100)}${text.length > 100 ? '...' : ''}`);

    try {
        // Check for commands
        if (text.startsWith('/')) {
            const [command, ...argParts] = text.split(' ');
            const args = argParts.join(' ');
            const response = await handleCommand(chatId, command.toLowerCase(), args);
            if (response) {
                await sendMessage(chatId, response, msg.message_id);
                return;
            }
        }

        // Regular message - send to Claude
        await sendTyping(chatId);

        let response = await chat(chatId, text);

        // Handle special tokens (OpenClaw-style)
        // SILENT_REPLY - discard the message
        if (response.trim() === 'SILENT_REPLY') {
            log('Agent returned SILENT_REPLY, not sending to Telegram');
            return;
        }

        // HEARTBEAT_OK - discard heartbeat acks (handled by watchdog)
        if (response.trim() === 'HEARTBEAT_OK' || response.trim().startsWith('HEARTBEAT_OK')) {
            log('Agent returned HEARTBEAT_OK');
            return;
        }

        // [[reply_to_current]] - quote reply to the current message
        let replyToId = null;
        if (response.startsWith('[[reply_to_current]]')) {
            response = response.replace('[[reply_to_current]]', '').trim();
            replyToId = msg.message_id;
        }

        await sendMessage(chatId, response, replyToId || msg.message_id);

        // Report message to Android for stats tracking
        androidBridgeCall('/stats/message').catch(() => {});

    } catch (error) {
        log(`Error: ${error.message}`);
        await sendMessage(chatId, `Error: ${error.message}`, msg.message_id);
    }
}

// ============================================================================
// POLLING LOOP
// ============================================================================

let offset = 0;
let pollErrors = 0;

async function poll() {
    while (true) {
        try {
            const result = await telegram('getUpdates', {
                offset: offset,
                timeout: 30,
                allowed_updates: ['message']
            });

            if (result.ok && result.result.length > 0) {
                for (const update of result.result) {
                    offset = update.update_id + 1;
                    if (update.message) {
                        handleMessage(update.message).catch(e =>
                            log(`Message handler error: ${e.message}`)
                        );
                    }
                }
            }
            pollErrors = 0;
        } catch (error) {
            pollErrors++;
            log(`Poll error (${pollErrors}): ${error.message}`);
            const delay = Math.min(1000 * Math.pow(2, pollErrors - 1), 30000);
            await new Promise(r => setTimeout(r, delay));
        }
    }
}

// ============================================================================
// CRON SERVICE STARTUP
// ============================================================================

// Start the cron service (loads persisted jobs, arms timers)
cronService.start();

// ============================================================================
// STARTUP
// ============================================================================

log('Connecting to Telegram...');
telegram('getMe')
    .then(async result => {
        if (result.ok) {
            log(`Bot connected: @${result.result.username}`);
            // Flush old updates to avoid re-processing messages after restart
            try {
                const flush = await telegram('getUpdates', { offset: -1, timeout: 0 });
                if (flush.ok && flush.result.length > 0) {
                    offset = flush.result[flush.result.length - 1].update_id + 1;
                    log(`Flushed ${flush.result.length} old update(s), offset now ${offset}`);
                }
            } catch (e) {
                log(`Warning: Could not flush old updates: ${e.message}`);
            }
            poll();
        } else {
            log(`ERROR: ${JSON.stringify(result)}`);
            process.exit(1);
        }
    })
    .catch(err => {
        log(`ERROR: ${err.message}`);
        process.exit(1);
    });

// Heartbeat log
setInterval(() => {
    log(`Heartbeat - uptime: ${Math.floor(process.uptime())}s, memory: ${Math.round(process.memoryUsage().rss / 1024 / 1024)}MB`);
}, 5 * 60 * 1000);
