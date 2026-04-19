// tools/index.js — Tool registry + executeTool() dispatcher (BAT-470)
// Merges all domain modules, builds handler dispatch map, routes tool calls.

const { log, CHANNEL, workDir } = require('../config');
const channel = require('../channel');
const { ToolCallLogger } = require('../tool-call-logger');
const { getShape } = require('../call-shape');
const { getDb } = require('../database');
const { redactSecrets } = require('../security');
const { classifyError } = require('../error-classifier');

// ── Domain modules ───────────────────────────────────────────────────────────

const webMod      = require('./web');
const memoryMod   = require('./memory');
const fileMod     = require('./file');
const skillMod    = require('./skill');
const cronMod     = require('./cron');
const sessionMod  = require('./session');
const androidMod  = require('./android');
const solanaMod   = require('./solana');
const telegramMod = CHANNEL === 'telegram' ? require('./telegram') : null;
const systemMod   = require('./system');
const schoolMod   = require('./school');

// ── School tools ────────────────────────────────────────────────────────────

const schoolTools = [
    {
        name: 'school_begin',
        description: 'Start or resume a Go-to-School self-improvement session. Creates workspace/SCHOOL.md as a trigger file; if one already exists, returns its parsed state for resumption. Returns session_id + last 10 prior sessions from workspace/school/log.jsonl for dedup.',
        input_schema: { type: 'object', properties: { reason: { type: 'string', enum: ['on_demand', 'cron', 'resumed'] } }, required: ['reason'] },
    },
    {
        name: 'school_scan',
        description: 'Pattern-mine the tool_call_log and skill_trigger_log SQL.js tables. Returns structured candidates: repeated_patterns (same call_shape ≥3×), failed_sequences (error_kind repeats), expensive_turns (≥8 tool calls), triggered_skills (for computing unused_skills retire candidates).',
        input_schema: { type: 'object', properties: { window_days: { type: 'integer', minimum: 1, maximum: 30 }, min_repetition: { type: 'integer' } } },
    },
    {
        name: 'school_write_skill',
        description: 'Write a new SKILL.md (create mode) or patch an existing one. Tool auto-injects `source: school`, `created`, `evidence` frontmatter on create; preserves existing `source` field + appends `last_patched_by: school` on patch. Enforces path sandbox (workspace/skills/ only), 64KB size cap, valid YAML frontmatter, and non-empty markdown body.',
        input_schema: { type: 'object', properties: {
            mode: { type: 'string', enum: ['create', 'patch'] },
            path: { type: 'string' },
            body: { type: 'string' },
            evidence: { type: 'string' },
        }, required: ['mode', 'path', 'body', 'evidence'] },
    },
    {
        name: 'school_retire_skill',
        description: 'Move a workspace skill to workspace/school/retired/ (reversible archive, not delete). Bundled skills rejected. User can restore by moving the file back.',
        input_schema: { type: 'object', properties: { path: { type: 'string' }, reason: { type: 'string' } }, required: ['path'] },
    },
    {
        name: 'school_end',
        description: 'Finalize a school session: append one JSON line to workspace/school/log.jsonl (rolling 90-day retention), then delete SCHOOL.md. Atomic ordering guarantees crash recovery never re-finalizes a session already logged.',
        input_schema: { type: 'object', properties: {
            session_id: { type: 'string' },
            summary: { type: 'object' },
        }, required: ['session_id', 'summary'] },
    },
    {
        name: 'school_handle_input',
        description: 'Advance the school session state machine. Agent calls this for school-relevant inputs (yes/no/review/skip/stop) after classifying user input via the classification rubric in the go-to-school skill. Returns the new state + next_action to execute. NOT called for unrelated messages — those route through normal message handling.',
        input_schema: { type: 'object', properties: {
            session_id: { type: 'string' },
            state: { type: 'object' },
            input: { type: 'object' },
        }, required: ['session_id', 'state', 'input'] },
    },
];

// ── Merged TOOLS array ───────────────────────────────────────────────────────

const TOOLS = [
    ...webMod.tools,
    ...memoryMod.tools,
    ...fileMod.tools,
    ...skillMod.tools,
    ...cronMod.tools,
    ...sessionMod.tools,
    ...androidMod.tools,
    ...solanaMod.tools,
    ...(telegramMod ? telegramMod.tools : []),
    ...systemMod.tools,
    ...schoolTools,
];

// ── School context builder ──────────────────────────────────────────────────

function _schoolCtx(chatId) {
    return { chatId, workDir, db: getDb() };
}

// ── Handler dispatch map ─────────────────────────────────────────────────────

const handlerMap = Object.assign({},
    webMod.handlers,
    memoryMod.handlers,
    fileMod.handlers,
    skillMod.handlers,
    cronMod.handlers,
    sessionMod.handlers,
    androidMod.handlers,
    solanaMod.handlers,
    ...(telegramMod ? [telegramMod.handlers] : []),
    systemMod.handlers,
    {
        school_begin: (input, chatId) => schoolMod.schoolBeginHandler(input, _schoolCtx(chatId)),
        school_scan: (input, chatId) => schoolMod.schoolScanHandler(input, _schoolCtx(chatId)),
        school_write_skill: (input, chatId) => schoolMod.schoolWriteSkillHandler(input, _schoolCtx(chatId)),
        school_retire_skill: (input, chatId) => schoolMod.schoolRetireSkillHandler(input, _schoolCtx(chatId)),
        school_end: (input, chatId) => schoolMod.schoolEndHandler(input, _schoolCtx(chatId)),
        school_handle_input: (input, chatId) => schoolMod.schoolHandleInputHandler(input, _schoolCtx(chatId)),
    },
);

// ── Shared state ─────────────────────────────────────────────────────────────

let _mcpExecuteTool = null;

function setMcpExecuteTool(fn) {
    _mcpExecuteTool = fn;
}

const pendingConfirmations = new Map(); // chatId -> { resolve, timer }
const lastToolUseTime = new Map();      // toolName -> timestamp

// BAT-255: Safe number-to-decimal-string conversion.
// String(0.0000001) -> "1e-7" but we need "0.0000001" for parseInputAmountToLamports.
function numberToDecimalString(n) {
    const s = String(n);
    if (!s.includes('e') && !s.includes('E')) return s;
    return n.toFixed(20).replace(/\.?0+$/, '');
}

// ── Wire cross-module dependencies ───────────────────────────────────────────

solanaMod._setNumberToDecimalString(numberToDecimalString);
memoryMod._setFormatBytes(fileMod.formatBytes);
// DeerFlow P2: tool_search needs access to ALL tools (static + MCP).
// Default to static TOOLS; main.js upgrades this after MCP is initialized.
let _fullToolGetter = () => TOOLS;
systemMod._setToolRegistry(() => _fullToolGetter());

function setFullToolRegistry(getter) { _fullToolGetter = getter; }

// ── Confirmation UI ──────────────────────────────────────────────────────────

// Format a human-readable confirmation message for the user.
// Uses Markdown — Telegram's toTelegramHtml() converts **bold** to <b>bold</b>,
// Discord renders **bold** natively. One format, both channels work.
function formatConfirmationMessage(toolName, input) {
    const esc = (s) => {
        let v = String(s ?? '');
        if (v.length > 200) v = v.slice(0, 197) + '...';
        return v;
    };
    let details;
    switch (toolName) {
        case 'android_sms':
            details = `📱 **Send SMS**\n  To: \`${esc(input.phone)}\`\n  Message: "${esc(input.message)}"`;
            break;
        case 'android_call':
            details = `📞 **Make Phone Call**\n  To: \`${esc(input.phone)}\``;
            break;
        case 'solana_send':
            details = `💸 **Send SOL**\n  To: \`${esc(input.to)}\`\n  Amount: ${esc(input.amount)} SOL`;
            break;
        case 'solana_swap':
            details = `🔄 **Swap Tokens**\n  Sell: ${esc(input.amount)} ${esc(input.inputToken)}\n  Buy: ${esc(input.outputToken)}`;
            break;
        case 'jupiter_trigger_create':
            details = `📊 **Create Trigger Order**\n  Sell: ${esc(input.inputAmount)} ${esc(input.inputToken)}\n  For: ${esc(input.outputToken)}\n  Trigger price: ${esc(input.triggerPrice)}`;
            break;
        case 'jupiter_dca_create':
            details = `🔄 **Create DCA Order**\n  ${esc(input.amountPerCycle)} ${esc(input.inputToken)} → ${esc(input.outputToken)}\n  Every: ${esc(input.cycleInterval)}\n  Cycles: ${input.totalCycles != null ? esc(String(input.totalCycles)) : '30 (default)'}\n  Total deposit: ${esc(input.amountPerCycle * (input.totalCycles || 30))} ${esc(input.inputToken)}`;
            break;
        default:
            details = `**${esc(toolName)}**`;
    }
    return `⚠️ **Action requires confirmation:**\n\n${details}\n\nReply **YES** to proceed or anything else to cancel.\n_(Auto-cancels in 60s)_`;
}

// Send confirmation message and wait for user reply (Promise-based)
function requestConfirmation(chatId, toolName, input) {
    // BAT-326: Cron sessions use synthetic chatIds (e.g. "cron:abc123") that are not
    // valid Telegram chat IDs. Auto-deny confirmation-gated tools in cron turns with
    // a clear error rather than sending a Telegram message that will always fail.
    // #298: Heartbeat probes use "__heartbeat__" chatId — same restriction applies.
    if (typeof chatId === 'string' && (chatId.startsWith('cron:') || chatId === '__heartbeat__')) {
        const ctx = chatId.startsWith('cron:') ? 'scheduled tasks' : 'heartbeat probes';
        log(`[Confirm] Rejected ${toolName} in ${ctx} (${chatId}) — confirmation-gated tools not available`, 'WARN');
        return Promise.reject(new Error(`${toolName} requires user confirmation which is not available in ${ctx}. Confirmation-gated tools (swaps, transfers, etc.) cannot be used here.`));
    }

    const msg = formatConfirmationMessage(toolName, input);
    return new Promise((resolve) => {
        const timer = setTimeout(() => {
            pendingConfirmations.delete(chatId);
            log(`[Confirm] Timeout for ${toolName} in chat ${chatId}`, 'INFO');
            resolve(false);
        }, 60000);
        // Register BEFORE sending to prevent race where fast reply arrives
        // before pendingConfirmations is set (would be enqueued as normal message)
        pendingConfirmations.set(chatId, {
            resolve: (confirmed) => {
                clearTimeout(timer);
                resolve(confirmed);
            },
            timer,
            toolName,
        });
        log(`[Confirm] Awaiting confirmation for ${toolName} in chat ${chatId}`, 'DEBUG');
        channel.sendMessage(chatId, msg).then((result) => {
            if (result && result.error) {
                log(`[Confirm] Channel rejected confirmation message: ${result.error}`, 'WARN');
                pendingConfirmations.delete(chatId);
                clearTimeout(timer);
                resolve(false);
            }
            // Note: confirmation messages are NOT recorded in sentMessageCache — they are
            // transient system UI, not user content that should appear in "Recent Sent Messages"
        }).catch((err) => {
            log(`[Confirm] Failed to send confirmation message: ${err.message}`, 'ERROR');
            pendingConfirmations.delete(chatId);
            clearTimeout(timer);
            resolve(false);
        });
    });
}

// ── tool-call-log plumbing (see spec §6.3) ───────────────────────────────────
let _logger = null;
function getLogger() {
    if (_logger) return _logger;
    const db = getDb();
    if (!db) return null;  // db not yet initialized at very early startup
    _logger = new ToolCallLogger({ db, log });
    return _logger;
}
async function flushLoggerNow() { const l = getLogger(); if (l) await l.flushNow(); }
async function stopLogger() { if (_logger) { await _logger.stop(); _logger = null; } }

// ── executeTool() dispatcher ─────────────────────────────────────────────────

async function executeToolInner(name, input, chatId) {
    log(`Executing tool: ${name}`, 'DEBUG');
    // OpenClaw parity: normalize whitespace-padded tool names
    name = typeof name === 'string' ? name.trim() : '';
    if (!name) return { error: 'Tool name is required and must be a non-empty string after trimming whitespace.' };

    // Look up handler in dispatch map
    const handler = handlerMap[name];
    if (handler) {
        return await handler(input, chatId);
    }

    // Route MCP tools (mcp__<server>__<tool>) to MCPManager
    if (name.startsWith('mcp__')) {
        if (_mcpExecuteTool) return await _mcpExecuteTool(name, input);
        return { error: `MCP tools not available — mcpManager not wired` };
    }

    return { error: `Unknown tool: ${name}` };
}

async function executeTool(name, input, chatId, messageId = null) {
    const startedAt = Date.now();
    // Normalize once — executeToolInner also trims defensively, but we need the
    // normalized name for consistent tool_name + call_shape in tool_call_log.
    const normalizedName = typeof name === 'string' ? name.trim() : '';
    let status = 'ok';
    let errorKind = null;
    let result;
    try {
        result = await executeToolInner(normalizedName, input, chatId);
        // Some tool handlers return { error: '...' } on non-exception failures.
        // classifyError maps into low-cardinality buckets (file_not_found, http_404, etc.)
        // so tool_call_log aggregations are pattern-mineable; fallback is redacted + truncated.
        if (result && typeof result === 'object' && result.error) {
            status = 'error';
            errorKind = classifyError(String(result.error));
        }
    } catch (e) {
        status = 'error';
        // Prefer e.code → e.message → e.name for richer error kinds.
        // Without e.message, every `new Error('bridge unreachable')` collapses to 'Error'.
        const raw = (e && (e.code || e.message || e.name) || 'exception').toString();
        errorKind = classifyError(raw);
        // Convert to the `{ error }` contract per ARCHITECTURE.md — callers expect no exceptions
        // to escape executeTool(). Returning a synthetic error result keeps the interface consistent.
        // Also redact the user-facing synthetic message — e.message can plausibly contain URLs
        // with query strings, tokens, or file paths that would otherwise leak through to Telegram.
        const safeMsg = e && e.message ? redactSecrets(String(e.message)) : 'exception';
        result = { error: `Tool execution failed: ${safeMsg}` };
    } finally {
        try {
            const logger = getLogger();
            if (logger) {
                logger.record({
                    turn_id: chatId != null ? String(chatId) : 'unknown',
                    message_id: messageId != null ? String(messageId) : null,
                    tool_name: normalizedName,
                    triggered_by_skill: null,    // Task A6 will populate
                    call_shape: getShape(normalizedName, input),
                    // result_status is 'ok' | 'error' only in PR-A. Spec §6.1 lists
                    // 'timeout' | 'blocked_by_policy' | 'blocked_by_confirmation' which
                    // happen upstream (ai.js confirmation gate, rate limiter) and need
                    // separate instrumentation. Deferred to PR-B where blocked-tool
                    // analytics feed school_scan; see spec §6.1 "known limitation".
                    result_status: status,
                    error_kind: errorKind,
                    latency_ms: Date.now() - startedAt,
                    created_at: startedAt,
                });
            }
        } catch (_) { /* never let logging break a tool call */ }
    }
    return result;
}

// ── Re-exported helpers ──────────────────────────────────────────────────────

const { listFilesRecursive, formatBytes } = fileMod;

// ============================================================================
// EXPORTS
// ============================================================================

module.exports = {
    TOOLS, executeTool,
    formatConfirmationMessage, requestConfirmation,
    pendingConfirmations, lastToolUseTime,
    listFilesRecursive, formatBytes,
    setMcpExecuteTool, setFullToolRegistry,
    flushLoggerNow, stopLogger,   // NEW for tool-call-log
};
