// tools/cron.js — cron_create, cron_list, cron_cancel, cron_status, datetime handlers

const {
    log, localTimestamp,
} = require('../config');

const {
    cronService, parseTimeExpression, formatDuration, MIN_AGENT_TURN_INTERVAL_MS,
} = require('../cron');

const tools = [
    {
        name: 'cron_create',
        description: 'Create a scheduled job. Two kinds: "agentTurn" runs a full AI turn with tools (for tasks needing research, analysis, monitoring — costs API tokens per execution), "reminder" sends raw text to Telegram (for simple alerts — zero cost). Supports one-shot ("in 30 minutes", "tomorrow at 9am") and recurring ("every 2 hours"). Recurring agentTurn jobs require a minimum 15-minute interval.',
        input_schema: {
            type: 'object',
            properties: {
                name: { type: 'string', description: 'Short name for the job (e.g., "Daily SOL price check")' },
                message: { type: 'string', description: 'For agentTurn: the task instruction (you will execute this as an AI turn with full tool access). For reminder: the text to deliver.' },
                time: { type: 'string', description: 'When to fire: "in 30 minutes", "tomorrow at 9am", "every 2 hours", "at 3pm"' },
                kind: { type: 'string', enum: ['reminder', 'agentTurn'], description: 'Job type: "agentTurn" runs a full AI turn with tools (default for tasks needing intelligence), "reminder" sends text directly to Telegram (default for simple notifications). Default: "reminder".' },
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
];

const handlers = {
    async cron_create(input, chatId) {
        // Flat-params recovery: non-frontier models sometimes put job fields
        // at top level instead of using the schema correctly
        if (!input.time && !input.message) {
            // Check if params were wrapped in a 'job' object
            if (input.job && typeof input.job === 'object') {
                if (input.job.time) input.time = input.job.time;
                if (input.job.message) input.message = input.job.message;
                if (input.job.name) input.name = input.job.name;
                if (input.job.kind) input.kind = input.job.kind;
                if (input.job.deleteAfterRun !== undefined) input.deleteAfterRun = input.job.deleteAfterRun;
            }
        }

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

        // Normalize kind to valid values only (BAT-326 review fix)
        const kind = input.kind === 'agentTurn' ? 'agentTurn' : 'reminder';

        let schedule;
        if (isRecurring) {
            // Enforce minimum interval for agentTurn recurring jobs (BAT-326)
            if (kind === 'agentTurn' && triggerTime._everyMs < MIN_AGENT_TURN_INTERVAL_MS) {
                const minMinutes = Math.ceil(MIN_AGENT_TURN_INTERVAL_MS / 60000);
                return { error: `Recurring agentTurn jobs require a minimum interval of ${minMinutes} minutes. agentTurn jobs run a full AI turn (with tools and API calls) on each execution. Use kind="reminder" for shorter intervals.` };
            }
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

        const payload = kind === 'agentTurn'
            ? { kind: 'agentTurn', message: input.message }
            : { kind: 'reminder', message: input.message };

        const job = cronService.create({
            name: input.name || input.message.slice(0, 50),
            description: input.message,
            schedule,
            payload,
            deleteAfterRun: input.deleteAfterRun || false,
        });

        const result = {
            success: true,
            id: job.id,
            name: job.name,
            kind,
            message: input.message,
            type: isRecurring ? 'recurring' : 'one-shot',
            nextRunAt: job.state.nextRunAtMs ? localTimestamp(new Date(job.state.nextRunAtMs)) : null,
            nextRunIn: job.state.nextRunAtMs ? formatDuration(job.state.nextRunAtMs - Date.now()) : null,
            interval: isRecurring ? formatDuration(triggerTime._everyMs) : null,
        };

        // Inform about API token usage for agentTurn jobs
        if (kind === 'agentTurn') {
            result.note = 'This job runs a full AI turn on each execution and will consume API tokens.';
        }

        return result;
    },

    async cron_list(input, chatId) {
        const jobs = cronService.list({ includeDisabled: input.includeDisabled || false });

        return {
            count: jobs.length,
            jobs: jobs.map(j => ({
                id: j.id,
                name: j.name,
                kind: j.payload?.kind || 'reminder',
                type: j.schedule.kind,
                enabled: j.enabled,
                message: j.payload?.message || j.description,
                nextRunAt: j.state.nextRunAtMs ? localTimestamp(new Date(j.state.nextRunAtMs)) : null,
                nextRunIn: j.state.nextRunAtMs ? formatDuration(j.state.nextRunAtMs - Date.now()) : null,
                lastRun: j.state.lastRunAtMs ? localTimestamp(new Date(j.state.lastRunAtMs)) : null,
                lastStatus: j.state.lastStatus || 'never',
                lastDelivered: j.state.lastDelivered ?? null,
            }))
        };
    },

    async cron_cancel(input, chatId) {
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
    },

    async cron_status(input, chatId) {
        return cronService.status();
    },

    async datetime(input, chatId) {
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
            weekNumber: Math.floor((now - new Date(now.getFullYear(), 0, 1)) / (7 * 24 * 60 * 60 * 1000)) + 1
        };
    },
};

module.exports = { tools, handlers };
