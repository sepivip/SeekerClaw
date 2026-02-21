// SeekerClaw — config.js
// Root module: configuration, constants, logging. Zero external dependencies.

const fs = require('fs');
const path = require('path');

// ============================================================================
// WORKSPACE & LOG PATHS
// ============================================================================

const workDir = process.argv[2] || __dirname;
const debugLog = path.join(workDir, 'node_debug.log');

// ============================================================================
// LOG ROTATION — prevent debug log from growing unbounded on mobile
// ============================================================================

const LOG_MAX_BYTES = 5 * 1024 * 1024; // 5 MB
try {
    if (fs.existsSync(debugLog)) {
        const stat = fs.statSync(debugLog);
        if (stat.size > LOG_MAX_BYTES) {
            // Read as Buffer to work with byte offsets (not character length)
            const buffer = fs.readFileSync(debugLog);
            const KEEP_BYTES = 1024 * 1024; // 1 MB
            const startOffset = Math.max(0, buffer.length - KEEP_BYTES);
            const trimmed = buffer.subarray(startOffset).toString('utf8');
            // Find first complete line
            const firstNewline = trimmed.indexOf('\n');
            const clean = firstNewline >= 0 ? trimmed.slice(firstNewline + 1) : trimmed;
            // Archive old log, write trimmed version
            try { fs.renameSync(debugLog, debugLog + '.old'); } catch (_) {}
            fs.writeFileSync(debugLog, `INFO|--- Log rotated (was ${(stat.size / 1024 / 1024).toFixed(1)} MB, kept last ~1 MB) ---\n` + clean);
        }
    }
} catch (_) {} // Non-fatal — don't prevent startup

// ============================================================================
// TIME UTILITIES
// ============================================================================

// Local timestamp with timezone offset (BAT-23)
function localTimestamp(date) {
    const d = date || new Date();
    const off = -d.getTimezoneOffset();
    const sign = off >= 0 ? '+' : '-';
    const pad = (n) => String(Math.abs(n)).padStart(2, '0');
    return d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate())
        + 'T' + pad(d.getHours()) + ':' + pad(d.getMinutes()) + ':' + pad(d.getSeconds())
        + sign + pad(Math.floor(Math.abs(off) / 60)) + ':' + pad(Math.abs(off) % 60);
}

function localDateStr(date) {
    const d = date || new Date();
    const pad = (n) => String(n).padStart(2, '0');
    return d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate());
}

// ============================================================================
// LOGGING
// ============================================================================

// redactSecrets is defined in main.js (SECURITY HELPERS) — injected after load via setRedactFn()
let _redactFn = null;

function setRedactFn(fn) {
    _redactFn = fn;
}

function log(msg, level = 'INFO') {
    const safe = _redactFn ? _redactFn(msg) : msg;
    const line = `${level}|${safe}\n`;
    try { fs.appendFileSync(debugLog, line); } catch (_) {}
}

log('Starting SeekerClaw AI Agent...', 'DEBUG');
log(`Node.js ${process.version} on ${process.platform} ${process.arch}`, 'DEBUG');
log(`Workspace: ${workDir}`, 'DEBUG');

// ============================================================================
// LOAD CONFIG
// ============================================================================

const configPath = path.join(workDir, 'config.json');
if (!fs.existsSync(configPath)) {
    log('ERROR: config.json not found', 'ERROR');
    process.exit(1);
}

const config = JSON.parse(fs.readFileSync(configPath, 'utf8'));

// Strip hidden line breaks from secrets (clipboard paste can include \r\n, Unicode separators)
function normalizeSecret(val) {
    return typeof val === 'string' ? val.replace(/[\r\n\u2028\u2029]+/g, '').trim() : '';
}

// ============================================================================
// CONFIG CONSTANTS
// ============================================================================

const BOT_TOKEN = normalizeSecret(config.botToken);
let OWNER_ID = config.ownerId ? String(config.ownerId).trim() : '';
const ANTHROPIC_KEY = normalizeSecret(config.anthropicApiKey);
const AUTH_TYPE = config.authType || 'api_key';
const MODEL = config.model || 'claude-opus-4-6';
const AGENT_NAME = config.agentName || 'SeekerClaw';
let BRIDGE_TOKEN = normalizeSecret(config.bridgeToken || '');
const USER_AGENT = 'SeekerClaw/1.0 (Android; +https://seekerclaw.com)';

// BAT-244: API timeout config — config.json values > env vars > defaults
// Use ?? (nullish coalescing) so config.json values take priority even if falsy (e.g. 0)
const API_TIMEOUT_MS = Math.max(5000, parseInt(config.apiTimeoutMs ?? process.env.API_TIMEOUT_MS) || 60000);
const API_TIMEOUT_RETRIES = Math.max(0, Math.min(5, parseInt(config.apiTimeoutRetries ?? process.env.API_TIMEOUT_RETRIES) || 2));
const API_TIMEOUT_BACKOFF_MS = Math.max(100, parseInt(config.apiTimeoutBackoffMs ?? process.env.API_TIMEOUT_BACKOFF_MS) || 500);
const API_TIMEOUT_MAX_BACKOFF_MS = Math.max(1000, parseInt(config.apiTimeoutMaxBackoffMs ?? process.env.API_TIMEOUT_MAX_BACKOFF_MS) || 5000);

// Reaction config with validation
// FIX-2 (BAT-219): Security note — 'own' (default) restricts reaction events to the owner only.
// Setting this to 'all' surfaces emoji reactions from ANY Telegram user to the agent as
// informational events. This does not bypass the owner gate (no tool calls are triggered),
// but non-owner activity becomes visible to the agent. Keep 'own' unless you specifically
// need to observe public reactions on the bot's messages.
const VALID_REACTION_NOTIFICATIONS = new Set(['off', 'own', 'all']);
const VALID_REACTION_GUIDANCE = new Set(['off', 'minimal', 'full']);
const REACTION_NOTIFICATIONS = VALID_REACTION_NOTIFICATIONS.has(config.reactionNotifications)
    ? config.reactionNotifications : 'own';
const REACTION_GUIDANCE = VALID_REACTION_GUIDANCE.has(config.reactionGuidance)
    ? config.reactionGuidance : 'minimal';
if (config.reactionNotifications && !VALID_REACTION_NOTIFICATIONS.has(config.reactionNotifications))
    log(`WARNING: Invalid reactionNotifications "${config.reactionNotifications}" — using "own"`, 'WARN');
if (config.reactionGuidance && !VALID_REACTION_GUIDANCE.has(config.reactionGuidance))
    log(`WARNING: Invalid reactionGuidance "${config.reactionGuidance}" — using "minimal"`, 'WARN');

// Normalize optional API keys in-place (clipboard paste can include hidden line breaks)
if (config.braveApiKey) config.braveApiKey = normalizeSecret(config.braveApiKey);
if (config.perplexityApiKey) config.perplexityApiKey = normalizeSecret(config.perplexityApiKey);
if (config.jupiterApiKey) config.jupiterApiKey = normalizeSecret(config.jupiterApiKey);

// MCP server configs (remote tool servers) — normalize first, then filter invalid
const MCP_SERVERS = (config.mcpServers || [])
    .map((server) => {
        if (server && typeof server === 'object') {
            const n = { ...server };
            if (typeof n.url === 'string') n.url = n.url.trim();
            if (typeof n.id === 'string') n.id = n.id.trim();
            if (typeof n.name === 'string') n.name = n.name.trim();
            if (typeof n.authToken === 'string') n.authToken = normalizeSecret(n.authToken);
            return n;
        }
        return null;
    })
    .filter((server) => server && typeof server === 'object' && server.url);

if (!BOT_TOKEN || !ANTHROPIC_KEY) {
    log('ERROR: Missing required config (botToken, anthropicApiKey)', 'ERROR');
    process.exit(1);
}

if (!OWNER_ID) {
    // FIX-3 (BAT-219): Upgraded DEBUG → WARN. An unconfigured owner ID means the first
    // inbound Telegram message will silently claim ownership. OpenClawService should have
    // blocked startup before reaching this point, but log clearly if it is ever bypassed.
    log('WARNING: Owner ID not set — first inbound message will claim ownership. Complete setup via the Android app.', 'WARN');
} else {
    const authLabel = AUTH_TYPE === 'setup_token' ? 'setup-token' : 'api-key';
    log(`Agent: ${AGENT_NAME} | Model: ${MODEL} | Auth: ${authLabel} | Owner: ${OWNER_ID}`, 'DEBUG');
}

// ============================================================================
// FILE PATHS
// ============================================================================

const SOUL_PATH = path.join(workDir, 'SOUL.md');
const MEMORY_PATH = path.join(workDir, 'MEMORY.md');
const HEARTBEAT_PATH = path.join(workDir, 'HEARTBEAT.md');
const MEMORY_DIR = path.join(workDir, 'memory');
const SKILLS_DIR = path.join(workDir, 'skills');
const DB_PATH = path.join(workDir, 'seekerclaw.db');

// Ensure directories exist
if (!fs.existsSync(MEMORY_DIR)) {
    fs.mkdirSync(MEMORY_DIR, { recursive: true });
}
if (!fs.existsSync(SKILLS_DIR)) {
    fs.mkdirSync(SKILLS_DIR, { recursive: true });
}

// ============================================================================
// TOOL RESULT TRUNCATION (ported from OpenClaw)
// ============================================================================

const HARD_MAX_TOOL_RESULT_CHARS = 400000;  // ~100K tokens, absolute safety net
const MAX_TOOL_RESULT_CONTEXT_SHARE = 0.3;  // Max 30% of context per tool result
const MIN_KEEP_CHARS = 2000;                // Always keep at least this much
const MODEL_CONTEXT_CHARS = 400000;         // ~100K tokens for typical model context

function truncateToolResult(text) {
    if (typeof text !== 'string') return text;

    const maxChars = Math.min(
        HARD_MAX_TOOL_RESULT_CHARS,
        Math.max(MIN_KEEP_CHARS, Math.floor(MODEL_CONTEXT_CHARS * MAX_TOOL_RESULT_CONTEXT_SHARE))
    );

    if (text.length <= maxChars) return text;

    // Truncate at a line boundary
    let cutoff = text.lastIndexOf('\n', maxChars);
    if (cutoff < MIN_KEEP_CHARS) cutoff = maxChars;

    const truncated = text.slice(0, cutoff);
    const droppedChars = text.length - cutoff;
    return truncated + `\n\n⚠️ [Content truncated — ${droppedChars} characters removed. Use offset/limit parameters for more.]`;
}

// ============================================================================
// SENSITIVE FILE BLOCKLIST (shared by read tool, js_eval, delete tool)
// ============================================================================

const SECRETS_BLOCKED = new Set(['config.json', 'config.yaml', 'seekerclaw.db']);

// ============================================================================
// SHELL EXEC ALLOWLIST (shared by tools.js and skills.js requirements gating)
// ============================================================================

// Note: node/npm/npx are NOT available — nodejs-mobile runs as libnode.so via JNI,
// not as a standalone binary. The allowlist prevents use of destructive system
// commands (rm, kill, etc.).
const SHELL_ALLOWLIST = new Set([
    'cat', 'ls', 'mkdir', 'cp', 'mv', 'echo', 'pwd', 'which',
    'head', 'tail', 'wc', 'sort', 'uniq', 'grep', 'find',
    'curl', 'ping', 'date', 'df', 'du', 'uname', 'printenv'
]);

// ============================================================================
// TOOL CONFIRMATION GATES
// ============================================================================

// Tools that require explicit user confirmation before execution.
// These are high-impact actions that a prompt-injected agent could abuse.
const CONFIRM_REQUIRED = new Set([
    'android_sms',
    'android_call',
    'jupiter_trigger_create',
    'jupiter_dca_create',
]);

// Rate limits (ms) — even with confirmation, prevent rapid-fire abuse
const TOOL_RATE_LIMITS = {
    'android_sms': 60000,       // 1 per 60s
    'android_call': 60000,      // 1 per 60s
    'jupiter_trigger_create': 30000,  // 1 per 30s
    'jupiter_dca_create': 30000,      // 1 per 30s
};

// Ephemeral status messages shown in Telegram while slow tools execute (BAT-150)
const TOOL_STATUS_MAP = {
    web_search:             '🔍 Searching...',
    web_fetch:              '🌐 Fetching...',
    shell_exec:             '⚙️ Running...',
    js_eval:                '⚙️ Running...',
    solana_balance:         '💰 Checking wallet...',
    solana_send:            '💸 Sending...',
    solana_swap:            '🔄 Executing swap...',
    solana_quote:           '💱 Getting quote...',
    solana_history:         '📜 Checking history...',
    solana_price:           '📈 Checking prices...',
    jupiter_dca_create:     '🔄 Setting up DCA...',
    jupiter_dca_cancel:     '🔄 Cancelling DCA...',
    jupiter_trigger_create: '⏰ Setting up order...',
    jupiter_trigger_cancel: '⏰ Cancelling order...',
    memory_search:          '🧠 Remembering...',
    android_camera_capture: '📷 Capturing...',
    android_location:       '📍 Getting location...',
};

// ============================================================================
// CONVERSATIONAL API KEYS (BAT-236)
// Merges apiKeys from agent_settings.json into the config object so all
// existing tools (Brave, Perplexity, Jupiter) pick them up automatically.
// Android Settings keys (from config.json) take priority over conversational
// keys. Conversational keys fill gaps and can be re-saved by the agent.
// ============================================================================

const _agentKeyMap = { perplexity: 'perplexityApiKey', brave: 'braveApiKey', jupiter: 'jupiterApiKey' };

// Snapshot which keys came from Android Settings at startup (immutable)
const _androidKeys = {};
for (const [, configField] of Object.entries(_agentKeyMap)) {
    if (config[configField]) _androidKeys[configField] = true;
}

function syncAgentApiKeys() {
    try {
        const settingsPath = path.join(workDir, 'agent_settings.json');
        if (!fs.existsSync(settingsPath)) return;
        const s = JSON.parse(fs.readFileSync(settingsPath, 'utf8'));
        if (!s.apiKeys || typeof s.apiKeys !== 'object') return;
        for (const [service, configField] of Object.entries(_agentKeyMap)) {
            // Android Settings keys always win — don't overwrite
            if (_androidKeys[configField]) continue;
            const agentKey = s.apiKeys[service];
            if (agentKey && typeof agentKey === 'string' && agentKey.trim()) {
                const normalized = normalizeSecret(agentKey);
                if (normalized && config[configField] !== normalized) {
                    config[configField] = normalized;
                    log(`[Config] Loaded ${service} API key from agent_settings.json`, 'INFO');
                }
            }
        }
    } catch (_) {}
}

// Run once at startup
syncAgentApiKeys();

// ============================================================================
// OWNER_ID — mutable (auto-detect from first message)
// ============================================================================

function getOwnerId() { return OWNER_ID; }
function setOwnerId(id) { OWNER_ID = id; }

// ============================================================================
// EXPORTS
// ============================================================================

module.exports = {
    // Core paths
    workDir,
    debugLog,

    // Config object (for accessing optional API keys etc.)
    config,

    // Primary constants
    BOT_TOKEN,
    ANTHROPIC_KEY,
    AUTH_TYPE,
    MODEL,
    AGENT_NAME,
    BRIDGE_TOKEN,
    USER_AGENT,
    MCP_SERVERS,

    // Reaction config
    REACTION_NOTIFICATIONS,
    REACTION_GUIDANCE,

    // File paths
    SOUL_PATH,
    MEMORY_PATH,
    HEARTBEAT_PATH,
    MEMORY_DIR,
    SKILLS_DIR,
    DB_PATH,

    // Truncation
    HARD_MAX_TOOL_RESULT_CHARS,
    MAX_TOOL_RESULT_CONTEXT_SHARE,
    MIN_KEEP_CHARS,
    MODEL_CONTEXT_CHARS,
    truncateToolResult,

    // Security/tool constants
    SHELL_ALLOWLIST,
    SECRETS_BLOCKED,
    CONFIRM_REQUIRED,
    TOOL_RATE_LIMITS,
    TOOL_STATUS_MAP,

    // Functions
    localTimestamp,
    localDateStr,
    log,
    normalizeSecret,
    setRedactFn,

    // Mutable owner ID
    getOwnerId,
    setOwnerId,

    // API timeout config (BAT-244)
    API_TIMEOUT_MS,
    API_TIMEOUT_RETRIES,
    API_TIMEOUT_BACKOFF_MS,
    API_TIMEOUT_MAX_BACKOFF_MS,

    // Conversational API keys (BAT-236)
    syncAgentApiKeys,
};
