// tools/index.js — Tool registry + executeTool() dispatcher (BAT-470)
// Merges all domain modules, builds handler dispatch map, routes tool calls.

const { log, CHANNEL } = require('../config');
const channel = require('../channel');

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
];

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
// Returns plain text with **Markdown** bold — works on Discord natively.
// Telegram sendMessage uses parse_mode: 'HTML', so we also provide an HTML version.
function formatConfirmationMessage(toolName, input) {
    const esc = (s) => {
        let v = String(s ?? '');
        if (v.length > 200) v = v.slice(0, 197) + '...';
        return v;
    };
    let details;
    switch (toolName) {
        case 'android_sms':
            details = `📱 Send SMS\n  To: ${esc(input.phone)}\n  Message: "${esc(input.message)}"`;
            break;
        case 'android_call':
            details = `📞 Make Phone Call\n  To: ${esc(input.phone)}`;
            break;
        case 'solana_send':
            details = `💸 Send SOL\n  To: ${esc(input.to)}\n  Amount: ${esc(input.amount)} SOL`;
            break;
        case 'solana_swap':
            details = `🔄 Swap Tokens\n  Sell: ${esc(input.amount)} ${esc(input.inputToken)}\n  Buy: ${esc(input.outputToken)}`;
            break;
        case 'jupiter_trigger_create':
            details = `📊 Create Trigger Order\n  Sell: ${esc(input.inputAmount)} ${esc(input.inputToken)}\n  For: ${esc(input.outputToken)}\n  Trigger price: ${esc(input.triggerPrice)}`;
            break;
        case 'jupiter_dca_create':
            details = `🔄 Create DCA Order\n  ${esc(input.amountPerCycle)} ${esc(input.inputToken)} → ${esc(input.outputToken)}\n  Every: ${esc(input.cycleInterval)}\n  Cycles: ${input.totalCycles != null ? esc(String(input.totalCycles)) : '30 (default)'}\n  Total deposit: ${esc(input.amountPerCycle * (input.totalCycles || 30))} ${esc(input.inputToken)}`;
            break;
        default:
            details = esc(toolName);
    }
    return `⚠️ Action requires confirmation:\n\n${details}\n\nReply YES to proceed or anything else to cancel.\n(Auto-cancels in 60s)`;
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
            if (result && result.ok === false) {
                log(`[Confirm] Channel rejected confirmation message: ${JSON.stringify(result).slice(0, 200)}`, 'WARN');
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

// ── executeTool() dispatcher ─────────────────────────────────────────────────

async function executeTool(name, input, chatId) {
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
};
