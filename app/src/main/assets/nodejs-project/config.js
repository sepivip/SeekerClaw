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
// USER ENV VARS — merge user-set env vars into process.env
// ============================================================================
// Filters out POSIX-invalid names and reserved names (defense in depth — the
// Android-side UI already blocks these, but a malicious config import could
// bypass that). USER_ENV_KEYS is exported so buildSystemBlocks() and the
// env_list tool can list the user-set keys without filtering process.env
// (which also contains system vars like PATH).

const _ENV_RESERVED_EXACT = new Set([
    'PATH', 'HOME', 'TMPDIR', 'USER', 'SHELL', 'LANG', 'TERM',
    'AGENT_VERSION',
    'API_TIMEOUT_MS', 'API_TIMEOUT_RETRIES',
    'API_TIMEOUT_BACKOFF_MS', 'API_TIMEOUT_MAX_BACKOFF_MS',
    'WS_NO_UTF_8_VALIDATE', 'WS_NO_BUFFER_UTIL',
]);
// All prefixes UPPERCASE — the POSIX name regex above rejects any input with
// lowercase, so a mixed-case reservation would be unreachable dead code.
const _ENV_RESERVED_PREFIXES = ['NODE_', 'NPM_', 'ANDROID_', 'LC_', 'JAVA_'];
// Defense-in-depth caps mirror Kotlin EnvVar.MAX_KEYS / MAX_VALUE_BYTES — a
// tampered config.json that bypasses the UI cannot push oversized blobs into
// process.env or exceed the 256-key ceiling.
const _ENV_MAX_KEYS = 256;
const _ENV_MAX_VALUE_BYTES = 8192;
const USER_ENV_KEYS = [];

if (config.envVars && typeof config.envVars === 'object') {
    let droppedOversize = 0;
    for (const [key, value] of Object.entries(config.envVars)) {
        if (USER_ENV_KEYS.length >= _ENV_MAX_KEYS) break;
        if (typeof key !== 'string') continue;
        if (!/^[A-Z_][A-Z0-9_]*$/.test(key)) continue;
        if (_ENV_RESERVED_EXACT.has(key)) continue;
        if (_ENV_RESERVED_PREFIXES.some((p) => key.startsWith(p))) continue;
        const str = String(value);
        // Newline-free rule mirrors Kotlin EnvVar.validateValue. A value with
        // embedded \r or \n interpolated into a shell command (e.g.
        // `curl -H "Authorization: Bearer $TOK"`) can split the command; on a
        // .env round-trip the serialization would be ambiguous. Skip defensively
        // in case a tampered config.json tries to inject newline values.
        if (str.indexOf('\n') >= 0 || str.indexOf('\r') >= 0) continue;
        if (Buffer.byteLength(str, 'utf8') > _ENV_MAX_VALUE_BYTES) {
            droppedOversize++;
            continue;
        }
        process.env[key] = str;
        USER_ENV_KEYS.push(key);
    }
    USER_ENV_KEYS.sort();
    const note = droppedOversize > 0 ? ` (${droppedOversize} dropped for exceeding ${_ENV_MAX_VALUE_BYTES}-byte cap)` : '';
    log(`[Config] Merged ${USER_ENV_KEYS.length} user env var(s) into process.env${note}`, 'DEBUG');
}

// ============================================================================
// CONFIG CONSTANTS
// ============================================================================

const BOT_TOKEN = normalizeSecret(config.botToken);
const CHANNEL = (typeof config.channel === 'string' ? config.channel : 'telegram').trim().toLowerCase();
const VALID_CHANNELS = new Set(['telegram', 'discord']);
if (!VALID_CHANNELS.has(CHANNEL)) {
    log(`ERROR: Unknown channel "${CHANNEL}" — must be "telegram" or "discord"`, 'ERROR');
    process.exit(1);
}
const DISCORD_TOKEN = normalizeSecret(config.discordBotToken || '');
const DISCORD_OWNER_ID = config.discordOwnerId ? String(config.discordOwnerId).trim() : '';
// Owner ID is channel-specific: Telegram uses ownerId, Discord uses discordOwnerId.
// This prevents the Telegram owner ID from blocking Discord auto-detect (and vice versa).
let OWNER_ID = CHANNEL === 'discord'
    ? (config.discordOwnerId ? String(config.discordOwnerId).trim() : '')
    : (config.ownerId ? String(config.ownerId).trim() : '');
// BAT-513: load the cross-process runtime state file (provider /
// authType / model). This is the new source of truth — Telegram
// `/provider` and `/model` write to it, the main UI process's
// RuntimeStateStore mirrors it back to SharedPreferences. config.json
// is the cold-start fallback (Kotlin regenerates it on every service
// start from prefs + Keystore), so a fresh install with no
// runtime_state.json yet still boots correctly.
//
// IMPORTANT: read here via raw `JSON.parse(fs.readFileSync(...))` instead
// of `_runtimeState.read()`. The cross-process-store helper deliberately
// SWALLOWS decode errors and returns defaults — that's correct for the
// per-store hot read path (reader gets a usable value, never crashes),
// but WRONG for our fallback chain. If `runtime_state.json` is corrupt,
// `_runtimeState.read()` would return `runtime-state.DEFAULTS`
// (`{claude, api_key, claude-opus-4-7}`) which would silently OVERRIDE
// whatever `config.json` has — masking the corruption AND leaking
// defaults into a user's actual config. Inline JSON.parse so we can
// distinguish "decoded cleanly" from "fell back to defaults" and treat
// the failure case as "file effectively missing → fall back to
// config.json". The store handle is still kept for write paths
// (createStore preserved its own atomicity contract).
const _runtimeStateModule = require('./runtime-state');
const _runtimeState = _runtimeStateModule.open(workDir);
// BAT-515: open the agent-preferences handle alongside runtime-state.
// `getAgentName` / `getSearchProvider` below read this per-call so live
// edits from the Settings UI (cross-process write to
// agent_preferences.json) flow into the running agent on the next
// inbound message — no service restart needed.
const _agentPreferencesModule = require('./agent-preferences');
const _agentPreferences = _agentPreferencesModule.open(workDir);
let _runtimeStateValues = null;
if (fs.existsSync(_runtimeState.filePath)) {
    try {
        const _raw = fs.readFileSync(_runtimeState.filePath, 'utf8');
        const _parsed = JSON.parse(_raw);
        // Guard: JSON.parse can legitimately return non-objects (a file
        // containing the literal `null`, or `42`, or `"string"` parses
        // cleanly). Without this check, `_parsed.provider` on `null`
        // crashes Node startup with TypeError. Treat any non-object
        // (including null) the same as decode failure: log + fall
        // through to config.json.
        const _isObj = !!_parsed && typeof _parsed === 'object' && !Array.isArray(_parsed);
        // Defense-in-depth: validate the FULL RuntimeState shape — the
        // (provider, authType) matrix AND that `model` is a string.
        // Without the model check, a manually-edited file with provider/
        // authType present but `model` missing or non-string would
        // accept the file as "valid" and downstream reads of
        // `_runtimeStateValues.model` would yield `undefined` (logs
        // would print "model=undefined" and the per-provider default
        // would silently take over). The "runtime_state.json is valid"
        // branch must correspond to a complete persisted RuntimeState,
        // matching the Kotlin RuntimeState data class which has all
        // three fields as non-null Strings.
        if (_isObj && typeof _parsed.provider === 'string' && typeof _parsed.authType === 'string'
            && typeof _parsed.model === 'string'
            && _runtimeStateModule.validateMatrix(_parsed.provider, _parsed.authType)) {
            _runtimeStateValues = _parsed;
            log(`[Config] Loaded runtime_state.json: provider=${_runtimeStateValues.provider} authType=${_runtimeStateValues.authType} model=${_runtimeStateValues.model}`, 'DEBUG');
        } else {
            const _provider = _isObj ? _parsed.provider : '<not-an-object>';
            const _authType = _isObj ? _parsed.authType : '<not-an-object>';
            const _model = _isObj ? _parsed.model : '<not-an-object>';
            log(`[Config] runtime_state.json has invalid content (provider=${_provider}, authType=${_authType}, model=${_model}) — falling back to config.json`, 'WARN');
            _runtimeStateValues = null;
        }
    } catch (e) {
        // Decode failure (corrupt JSON, partial write surviving rename
        // failure, manual edit gone wrong). Fall back to config.json
        // — DO NOT silently substitute the runtime-state DEFAULTS.
        log(`[Config] runtime_state.json decode failed (${e.message}) — falling back to config.json`, 'WARN');
        _runtimeStateValues = null;
    }
} else {
    log('[Config] runtime_state.json not present — falling back to config.json values', 'DEBUG');
}

const _SUPPORTED_PROVIDERS = new Set(['claude', 'openai', 'openrouter', 'custom']);
// Resolution order: runtime_state.json (live, BAT-513) → config.json (cold-start).
// Fall back to 'claude' if neither has a valid value.
const _runtimeProvider = (_runtimeStateValues && typeof _runtimeStateValues.provider === 'string')
    ? _runtimeStateValues.provider.trim().toLowerCase()
    : '';
const _configProvider = (typeof config.provider === 'string' && config.provider.trim())
    ? config.provider.trim().toLowerCase()
    : '';
const _rawProvider = _runtimeProvider || _configProvider || 'claude';
const PROVIDER = _SUPPORTED_PROVIDERS.has(_rawProvider) ? _rawProvider : 'claude';
// ANTHROPIC_KEY is derived after AUTH_TYPE is computed (below) so it can
// pick the right credential field. Kotlin now writes raw `anthropicApiKey`
// and `setupToken` as SEPARATE fields in config.json (the activeCredential
// collapse used to happen Kotlin-side), so Node picks by auth mode here.
const OPENAI_KEY = normalizeSecret(config.openaiApiKey || '');
const OPENAI_OAUTH_TOKEN = normalizeSecret(config.openaiOAuthToken || '');
const OPENAI_OAUTH_REFRESH = normalizeSecret(config.openaiOAuthRefresh || '');

// Normalize authType (trim/lowercase) so values like " OAuth\n" don't silently fall
// through to api_key. For OpenAI, alias known legacy values (e.g. "setup_token" left
// over from when the user was on Anthropic) to "api_key" so older installs don't
// hard-crash on startup. Truly unknown values still throw to prevent accidentally
// charging the user's platform API key.
const _SUPPORTED_OPENAI_AUTH_TYPES = new Set(['api_key', 'oauth']);
const _LEGACY_OPENAI_AUTH_TYPE_ALIASES = new Map([
    ['setup_token', 'api_key'],
]);
// BAT-513: authType resolves from runtime_state.json first, then
// config.json. Same fallback chain as PROVIDER above.
const _runtimeAuthType = (_runtimeStateValues && typeof _runtimeStateValues.authType === 'string')
    ? _runtimeStateValues.authType.trim().toLowerCase()
    : '';
const _configAuthType = typeof config.authType === 'string'
    ? config.authType.trim().toLowerCase()
    : '';
const _rawAuthType = _runtimeAuthType || _configAuthType;
let AUTH_TYPE = _rawAuthType || 'api_key';

if (PROVIDER === 'openai' && _LEGACY_OPENAI_AUTH_TYPE_ALIASES.has(AUTH_TYPE)) {
    const aliased = _LEGACY_OPENAI_AUTH_TYPE_ALIASES.get(AUTH_TYPE);
    log(`[Config] Normalizing legacy OpenAI authType ${JSON.stringify(config.authType)} → ${JSON.stringify(aliased)}`, 'WARN');
    AUTH_TYPE = aliased;
}

if (PROVIDER === 'openai' && !_SUPPORTED_OPENAI_AUTH_TYPES.has(AUTH_TYPE)) {
    throw new Error(`Invalid OpenAI authType: ${JSON.stringify(config.authType)}. Supported values are "api_key" and "oauth".`);
}

// OpenAI auth type strictly follows the (normalized, validated) authType — no silent
// fallback. The credential validation below will fail fast on missing OAuth token.
const OPENAI_AUTH_TYPE = AUTH_TYPE === 'oauth' ? 'oauth' : 'api_key';

// Now that AUTH_TYPE is known, pick the right Claude credential. Kotlin
// writes both fields raw. In setup_token mode, derive STRICTLY from
// setupToken with no API-key fallback — otherwise a missing setup token
// would silently boot the agent with an API key in the Bearer header
// while it thinks it's in setup_token mode, causing every request to
// fail confusingly at runtime. The startup validation below fails
// loudly instead, which is what we want.
const ANTHROPIC_KEY = normalizeSecret(
    (PROVIDER === 'claude' && AUTH_TYPE === 'setup_token')
        ? (config.setupToken || '')
        : (config.anthropicApiKey || '')
);

const OPENROUTER_KEY = normalizeSecret(config.openrouterApiKey || '');
const CUSTOM_KEY = normalizeSecret(config.customApiKey || '');
const CUSTOM_BASE_URL = (typeof config.customBaseUrl === 'string' ? config.customBaseUrl : '').trim();
const CUSTOM_HEADERS_RAW = (typeof config.customHeaders === 'string' ? config.customHeaders : '').trim();
const CUSTOM_FORMAT = (typeof config.customFormat === 'string' ? config.customFormat : 'chat_completions').trim().toLowerCase();
const OPENROUTER_FALLBACK_MODEL = (typeof config.openrouterFallbackModel === 'string' ? config.openrouterFallbackModel : '').trim();
const OPENROUTER_MODEL_CONTEXT = parseInt(config.openrouterModelContext, 10) || 0;
const OPENROUTER_FALLBACK_CONTEXT = parseInt(config.openrouterFallbackContext, 10) || 0;
const _defaultModel = PROVIDER === 'openai' ? 'gpt-5.4'
    : PROVIDER === 'openrouter' ? 'anthropic/claude-sonnet-4-6'
    : PROVIDER === 'custom' ? ''
    : 'claude-opus-4-7';
// BAT-513: model resolves from runtime_state.json first, then
// config.json, then the per-provider safe default. The agent_settings.json
// overlay path (resolveActiveModel) still applies AFTER this for live
// `/model` updates within a process lifetime; once the BAT-511 family
// fully migrates, the overlay path can be retired in favour of
// runtime-state.js per-turn reads.
const _runtimeModel = (_runtimeStateValues && typeof _runtimeStateValues.model === 'string'
    && _runtimeStateValues.model.trim())
    ? _runtimeStateValues.model.trim()
    : '';
const MODEL = _runtimeModel || config.model || _defaultModel;

// BAT-515: agentName + searchProvider are no longer startup-frozen
// constants — they're resolved per-call via the precedence chain below
// so a Settings UI edit (cross-process write to agent_preferences.json)
// takes effect on the next AI turn / next web_search call without a
// service restart. See agent-preferences.js for the file shape and
// AgentPreferencesStore.kt (Kotlin singleton) for the writer-side
// contract.
//
// Precedence per BAT-515 v3 §3:
//   1. agent_preferences.json (live, validated by readLiveOrNull) —
//      what Settings/Telegram-flow writes update.
//   2. config.json `agentName` / `searchProvider` (cold-start
//      fallback) — what saveConfig.writeConfigJson last wrote. Stays
//      readable across service restarts even if the live file is
//      genuinely absent or corrupt.
//   3. Hardcoded fallback ('MyAgent' / 'brave') — unreachable under
//      normal flow because saveConfig writes the cold-start keys for
//      any user past Setup. R9 Copilot: lock-step with
//      `AgentPreferences.DEFAULT_AGENT_NAME` (Kotlin) and
//      `agent-preferences.js DEFAULTS.agentName` so the agent
//      reports the same name across all three sources if the
//      precedence chain bottoms out.

// R1 Copilot: normalize + validate the cold-start fallback. Without
// this, a malformed `config.json` field could escape past the live
// readLiveOrNull check and reach callers — `tools/web.js` would hit
// the `default:` branch with "Unknown search provider X", and
// `/status` could surface a whitespace-only agent name. The live
// path goes through readLiveOrNull which already enforces these
// rules; the fallbacks need the same.
function _normalizeAgentName(value) {
    if (typeof value !== 'string') return null;
    const trimmed = value.trim();
    return trimmed ? trimmed : null;
}

function _normalizeSearchProvider(value) {
    if (typeof value !== 'string') return null;
    const normalized = value.trim().toLowerCase();
    // Reuse the same allowlist agent-preferences.js's readLiveOrNull
    // applies — keeps the live-vs-cold-start gates symmetric so a
    // value that the live file would reject can't slip through the
    // fallback either.
    return _agentPreferencesModule.KNOWN_SEARCH_PROVIDERS.has(normalized)
        ? normalized
        : null;
}

function getAgentName() {
    const live = _agentPreferences.readLiveOrNull();
    const liveName = live ? _normalizeAgentName(live.agentName) : null;
    if (liveName) return liveName;
    const coldName = _normalizeAgentName(config.agentName);
    if (coldName) return coldName;
    // R9 Copilot: lock-step with the shared default. Pre-BAT-515 this
    // returned 'SeekerClaw' (a Node-only value that diverged from
    // Kotlin's `AgentPreferences.DEFAULT_AGENT_NAME = "MyAgent"` and
    // `agent-preferences.js DEFAULTS.agentName = "MyAgent"`). The
    // unreachable-under-normal-flow caveat still holds (saveConfig
    // writes both the live file and config.json for any user past
    // Setup) but keeping all three sources in sync means a
    // hypothetical full-corruption scenario doesn't surface
    // inconsistent agent names across `:node` startup banner,
    // `/status`, and the Android UI.
    return _agentPreferencesModule.DEFAULTS.agentName;
}

function getSearchProvider() {
    const live = _agentPreferences.readLiveOrNull();
    const liveProvider = live ? _normalizeSearchProvider(live.searchProvider) : null;
    if (liveProvider) return liveProvider;
    const coldProvider = _normalizeSearchProvider(config.searchProvider);
    if (coldProvider) return coldProvider;
    // R9 Copilot: lock-step with the shared default (currently
    // 'brave' — same as the prior literal, but reading from the
    // module so a future default change happens in one place across
    // Kotlin + Node).
    return _agentPreferencesModule.DEFAULTS.searchProvider;
}

/**
 * Resolve the currently-active model — the agent_settings.json overlay
 * wins over the startup MODEL const. The `/model` Telegram command and
 * the Settings UI model picker both write to agent_settings.json; this
 * resolver is what lets those changes take effect live (no service
 * restart). Called per chat() turn and by any self-report surface
 * (/status, /version, session_status, system prompt) so the agent
 * never reports a different model than the one handling the request.
 *
 * Provider-scoping: if the overlay specifies a provider, only adopt the
 * overlay model when it matches the running provider. This closes a race
 * where `/provider` writes `{provider: openai, model: gpt-5.4}` to
 * agent_settings.json BEFORE the service restart completes (~2.5s
 * window); without scoping, the still-running Claude adapter would pick
 * up `gpt-5.4` and try to call Anthropic with an OpenAI model ID,
 * causing immediate API failures for any message in that window.
 *
 * Falls back to the module-level MODEL if:
 *   - agent_settings.json doesn't exist
 *   - it can't be parsed
 *   - `model` field is missing / non-string / blank
 *   - overlay.provider is set AND differs from the startup PROVIDER
 *     (provider switch is pending; old adapter can't use new model)
 */
function resolveActiveModel() {
    try {
        const settingsPath = path.join(workDir, 'agent_settings.json');
        if (fs.existsSync(settingsPath)) {
            const s = JSON.parse(fs.readFileSync(settingsPath, 'utf8'));
            // Overlay is stale while a /provider restart is pending.
            const overlayProvider = typeof s.provider === 'string' ? s.provider.trim() : '';
            if (overlayProvider && overlayProvider !== PROVIDER) {
                return MODEL;
            }
            const m = typeof s.model === 'string' ? s.model.trim() : '';
            if (m) return m;
        }
    } catch (_) {}
    return MODEL;
}

let BRIDGE_TOKEN = normalizeSecret(config.bridgeToken || '');
const USER_AGENT = 'SeekerClaw/1.0 (Android; +https://seekerclaw.com)';

// BAT-244: API timeout config — config.json values > env vars > defaults
// _safeInt: parse to int, return null on NaN so ?? default applies correctly (0 is preserved)
const _safeInt = (v) => { const n = parseInt(v); return Number.isFinite(n) ? n : null; };
const API_TIMEOUT_MS = Math.max(5000, _safeInt(config.apiTimeoutMs ?? process.env.API_TIMEOUT_MS) ?? 60000);
const API_TIMEOUT_RETRIES = Math.max(0, Math.min(5, _safeInt(config.apiTimeoutRetries ?? process.env.API_TIMEOUT_RETRIES) ?? 2));
const API_TIMEOUT_BACKOFF_MS = Math.max(100, _safeInt(config.apiTimeoutBackoffMs ?? process.env.API_TIMEOUT_BACKOFF_MS) ?? 500);
const API_TIMEOUT_MAX_BACKOFF_MS = Math.max(1000, _safeInt(config.apiTimeoutMaxBackoffMs ?? process.env.API_TIMEOUT_MAX_BACKOFF_MS) ?? 5000);

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
if (config.heliusApiKey) config.heliusApiKey = normalizeSecret(config.heliusApiKey);
if (config.searchProvider) config.searchProvider = String(config.searchProvider).trim().toLowerCase();
if (config.exaApiKey) config.exaApiKey = normalizeSecret(config.exaApiKey);
if (config.tavilyApiKey) config.tavilyApiKey = normalizeSecret(config.tavilyApiKey);
if (config.firecrawlApiKey) config.firecrawlApiKey = normalizeSecret(config.firecrawlApiKey);

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

// Validate: channel token required per channel; API key required for active provider only
// For OpenAI: validate based on effective auth type (api_key needs API key, oauth needs OAuth token)
const _activeKey = PROVIDER === 'openai' ? (OPENAI_AUTH_TYPE === 'oauth' ? OPENAI_OAUTH_TOKEN : OPENAI_KEY)
    : PROVIDER === 'openrouter' ? OPENROUTER_KEY
    : PROVIDER === 'custom' ? CUSTOM_KEY
    : ANTHROPIC_KEY;
if (CHANNEL === 'telegram' && !BOT_TOKEN) {
    log('ERROR: Missing required config (botToken) for Telegram channel', 'ERROR');
    process.exit(1);
}
if (CHANNEL === 'discord' && !DISCORD_TOKEN) {
    log('ERROR: Missing required config (discordBotToken) for Discord channel', 'ERROR');
    process.exit(1);
}
if (!_activeKey) {
    const keyName = PROVIDER === 'openai' ? 'openaiApiKey or openaiOAuthToken'
        : PROVIDER === 'openrouter' ? 'openrouterApiKey'
        : PROVIDER === 'custom' ? 'customApiKey'
        : AUTH_TYPE === 'setup_token' ? 'setupToken'
        : 'anthropicApiKey';
    log(`ERROR: Missing required config (${keyName}) for provider "${PROVIDER}"`, 'ERROR');
    process.exit(1);
}

if (PROVIDER === 'custom' && !CUSTOM_BASE_URL) {
    log('ERROR: Missing required config (customBaseUrl) for provider "custom"', 'ERROR');
    process.exit(1);
}

if (PROVIDER === 'custom' && !MODEL) {
    log('ERROR: Missing required config (model) for provider "custom"', 'ERROR');
    process.exit(1);
}

if (!OWNER_ID) {
    // An unconfigured owner ID means the first inbound Telegram message will claim ownership.
    // This is the intended auto-detect flow — the owner ID is persisted via the Android bridge.
    log('WARNING: Owner ID not set — first inbound message will claim ownership. ' +
        'This is expected on first run; use the Android setup flow to set or reset the owner.', 'WARN');
} else {
    const authLabel = PROVIDER === 'claude' ? (AUTH_TYPE === 'setup_token' ? 'setup-token' : 'api-key') : 'api-key';
    log(`Agent: ${getAgentName()} | Provider: ${PROVIDER} | Model: ${MODEL} | Auth: ${authLabel} | Owner: ${OWNER_ID}`, 'DEBUG');
}

function parseCustomHeaders(raw) {
    if (!raw) return {};
    try {
        const parsed = JSON.parse(raw);
        if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return {};
        const out = {};
        for (const [key, value] of Object.entries(parsed)) {
            const headerKey = String(key || '').trim();
            if (!headerKey || headerKey === '__proto__' || headerKey === 'constructor' || headerKey === 'prototype') continue;
            if (value == null) continue;
            out[headerKey] = String(value);
        }
        return out;
    } catch (e) {
        log(`[Config] Failed to parse customHeaders JSON: ${e.message}`, 'WARN');
        return {};
    }
}

function parseCustomEndpoint(raw) {
    const fallback = { protocol: 'https:', hostname: '', port: undefined, path: '/v1/chat/completions' };
    if (!raw) return fallback;
    try {
        const url = new URL(raw);
        if (url.protocol !== 'https:' && url.protocol !== 'http:') {
            log(`[Config] Unsupported protocol "${url.protocol}" in customBaseUrl — only http: and https: are allowed`, 'WARN');
            return fallback;
        }
        let urlPath = url.pathname || '/';
        if (urlPath.endsWith('/') && urlPath.length > 1) urlPath = urlPath.slice(0, -1);
        if (url.search) urlPath += url.search;
        return {
            protocol: url.protocol || 'https:',
            hostname: url.hostname || '',
            port: url.port ? Number(url.port) : undefined,
            path: urlPath,
        };
    } catch (e) {
        log(`[Config] Invalid customBaseUrl "${raw}": ${e.message}`, 'WARN');
        return fallback;
    }
}

const CUSTOM_HEADERS = parseCustomHeaders(CUSTOM_HEADERS_RAW);
const CUSTOM_ENDPOINT = parseCustomEndpoint(CUSTOM_BASE_URL);
if (PROVIDER === 'custom' && CUSTOM_BASE_URL && !CUSTOM_ENDPOINT.hostname) {
    log(`ERROR: customBaseUrl "${CUSTOM_BASE_URL}" is not a valid URL (no hostname)`, 'ERROR');
    process.exit(1);
}

// ============================================================================
// FILE PATHS
// ============================================================================

const SOUL_PATH = path.join(workDir, 'SOUL.md');
const MEMORY_PATH = path.join(workDir, 'MEMORY.md');
const HEARTBEAT_PATH = path.join(workDir, 'HEARTBEAT.md');
const MEMORY_DIR = path.join(workDir, 'memory');
const SKILLS_DIR = path.join(workDir, 'skills');
const TASKS_DIR = path.join(workDir, 'tasks');  // P2.2: disk-backed task checkpoints
const DB_PATH = path.join(workDir, 'seekerclaw.db');

// Ensure directories exist
if (!fs.existsSync(MEMORY_DIR)) {
    fs.mkdirSync(MEMORY_DIR, { recursive: true });
}
if (!fs.existsSync(SKILLS_DIR)) {
    fs.mkdirSync(SKILLS_DIR, { recursive: true });
}
if (!fs.existsSync(TASKS_DIR)) {
    fs.mkdirSync(TASKS_DIR, { recursive: true });
}

// ============================================================================
// TOOL RESULT TRUNCATION (ported from OpenClaw)
// ============================================================================

const HARD_MAX_TOOL_RESULT_CHARS = 50000;   // BAT-259: 50K chars — no single result should dominate payload (was 400K)
const MAX_TOOL_RESULT_CONTEXT_SHARE = 0.3;  // Max 30% of context per tool result
const MIN_KEEP_CHARS = 2000;                // Always keep at least this much
const MODEL_CONTEXT_CHARS = 200000;         // BAT-259: Realistic context budget (was 400K)

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

const SECRETS_BLOCKED = new Set(['config.js', 'config.json', 'config.yaml', 'seekerclaw.db']);

// ============================================================================
// SHELL EXEC ALLOWLIST (shared by tools.js and skills.js requirements gating)
// ============================================================================

// Note: node/npm/npx are NOT available — nodejs-mobile runs as libnode.so via JNI,
// not as a standalone binary. The allowlist prevents use of destructive system
// commands (rm, kill, etc.).
const SHELL_ALLOWLIST = new Set([
    'cat', 'ls', 'mkdir', 'cp', 'mv', 'echo', 'pwd', 'which',
    'head', 'tail', 'wc', 'sort', 'uniq', 'grep', 'find',
    'curl', 'ping', 'date', 'df', 'du', 'uname', 'printenv',
    'touch', 'diff', 'sed', 'cut', 'base64',
    'stat', 'file', 'sleep', 'getprop', 'md5sum', 'sha256sum',
    'screencap'
]);

// ============================================================================
// TOOL CONFIRMATION GATES
// ============================================================================

// Tools that require explicit user confirmation before execution.
// These are high-impact actions that a prompt-injected agent could abuse.
const CONFIRM_REQUIRED = new Set([
    'android_sms',
    'android_call',
    'android_camera_capture', // #207: silent photo risk from prompt injection
    'android_location',       // #207: silent location tracking risk
    'solana_send',           // BAT-255: P0 — wallet-draining risk from prompt injection
    'solana_swap',           // BAT-255: P0 — wallet-draining risk from prompt injection
    'jupiter_trigger_create',
    'jupiter_dca_create',
]);

// Rate limits (ms) — even with confirmation, prevent rapid-fire abuse
const TOOL_RATE_LIMITS = {
    'android_sms': 60000,       // 1 per 60s
    'android_call': 60000,      // 1 per 60s
    'android_camera_capture': 15000, // 1 per 15s (#207)
    'android_location': 15000,       // 1 per 15s (#207)
    'solana_send': 15000,       // 1 per 15s (BAT-255)
    'solana_swap': 15000,       // 1 per 15s (BAT-255)
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
    solana_nft_holdings:    '🖼️ Checking NFTs...',
};

// ============================================================================
// CONVERSATIONAL API KEYS (BAT-236)
// Merges apiKeys from agent_settings.json into the config object so all
// existing tools (Brave, Perplexity, Jupiter) pick them up automatically.
// Android Settings keys (from config.json) take priority over conversational
// keys. Conversational keys fill gaps and can be re-saved by the agent.
// ============================================================================

// Known mappings for keys that come from Android Settings (config.json).
// These get priority — agent_settings.json keys never overwrite them.
const _knownKeyMap = { perplexity: 'perplexityApiKey', brave: 'braveApiKey', exa: 'exaApiKey', tavily: 'tavilyApiKey', firecrawl: 'firecrawlApiKey', jupiter: 'jupiterApiKey', helius: 'heliusApiKey' };

// Snapshot which keys came from Android Settings at startup (immutable).
// Protect ALL existing *ApiKey fields, not just known ones.
const _androidKeys = {};
for (const key of Object.keys(config)) {
    if (key.endsWith('ApiKey') && config[key]) _androidKeys[key] = true;
}

// Normalize service name to lowerCamelCase to align with envToCamelCase in skills.js.
// "dune" → "dune", "DUNE" → "dune", "dune_analytics" → "duneAnalytics"
// Preserves internal capitals for already-camelCase inputs: "duneApiKey" → "duneApiKey"
function normalizeService(service) {
    if (!service) return '';
    const parts = String(service).trim()
        .replace(/[^A-Za-z0-9]+/g, ' ').split(' ').filter(Boolean);
    if (!parts.length) return '';
    // First token: preserve internal capitals if mixed case (camelCase/PascalCase)
    const first = parts[0];
    const hasLower = /[a-z]/.test(first);
    const hasUpper = /[A-Z]/.test(first);
    const normalizedFirst = (hasLower && hasUpper)
        ? first.charAt(0).toLowerCase() + first.slice(1)
        : first.toLowerCase();
    const rest = parts.slice(1).map(p => p.charAt(0).toUpperCase() + p.slice(1).toLowerCase());
    return normalizedFirst + rest.join('');
}

// Convert service name to config field: "dune" → "duneApiKey", "brave" → "braveApiKey"
function serviceToConfigField(service) {
    if (_knownKeyMap[service]) return _knownKeyMap[service];
    const normalized = normalizeService(service);
    if (!normalized) return '';
    // Avoid double suffix: "DUNE_API_KEY" → "duneApiKey" (not "duneApiKeyApiKey")
    // Normalize suffix casing to exactly "ApiKey" so endsWith('ApiKey') checks work
    if (/[Aa]pi[Kk]ey$/.test(normalized)) return normalized.replace(/[Aa]pi[Kk]ey$/, 'ApiKey');
    return `${normalized}ApiKey`;
}

function syncAgentApiKeys() {
    try {
        const settingsPath = path.join(workDir, 'agent_settings.json');
        if (!fs.existsSync(settingsPath)) return;
        const s = JSON.parse(fs.readFileSync(settingsPath, 'utf8'));
        if (!s.apiKeys || typeof s.apiKeys !== 'object') return;
        // Dynamic: load ALL keys from apiKeys.*, not just known ones
        for (const [service, agentKey] of Object.entries(s.apiKeys)) {
            const configField = serviceToConfigField(service);
            if (!configField) continue;
            // Android Settings keys always win — don't overwrite
            if (_androidKeys[configField]) continue;
            if (agentKey && typeof agentKey === 'string' && agentKey.trim() && agentKey.length <= 512) {
                const normalized = normalizeSecret(agentKey);
                if (normalized && config[configField] !== normalized) {
                    config[configField] = normalized;
                    // Log configField (sanitized) instead of raw service name to prevent log injection
                    log(`[Config] Loaded API key → config.${configField} from agent_settings.json`, 'INFO');
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

    // BAT-513: handle on the cross-process runtime state file so
    // command handlers (`/model`, `/provider` in message-handler.js)
    // can write live updates without re-deriving the file path.
    runtimeState: _runtimeState,

    // Primary constants
    BOT_TOKEN,
    CHANNEL,
    DISCORD_TOKEN,
    DISCORD_OWNER_ID,
    PROVIDER,
    ANTHROPIC_KEY,
    OPENAI_KEY,
    OPENAI_OAUTH_TOKEN, OPENAI_OAUTH_REFRESH, OPENAI_AUTH_TYPE,
    OPENROUTER_KEY,
    CUSTOM_KEY,
    CUSTOM_BASE_URL,
    CUSTOM_HEADERS,
    CUSTOM_FORMAT,
    CUSTOM_ENDPOINT,
    OPENROUTER_FALLBACK_MODEL,
    OPENROUTER_MODEL_CONTEXT,
    OPENROUTER_FALLBACK_CONTEXT,
    AUTH_TYPE,
    MODEL,
    resolveActiveModel,
    // BAT-515: per-call getters replace the startup-frozen `AGENT_NAME` /
    // `config.searchProvider` reads. Consumers (main.js startup banner,
    // message-handler /status, tools/session.js session_status,
    // tools/web.js web_search) call these per-turn so a Settings UI
    // edit takes effect on the next AI turn without a service restart.
    getAgentName,
    getSearchProvider,
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
    TASKS_DIR,
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

    // User env vars (BAT-495)
    USER_ENV_KEYS,
};
