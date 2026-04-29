// ============================================================================
// Model & provider catalog — derived from the shared model-registry.json (BAT-517).
//
// Used by the `/model` and `/provider` Telegram slash commands to validate
// user input. After BAT-517, the catalog data lives in ONE place:
//   app/src/main/assets/nodejs-project/model-registry.json
// Both this module AND Kotlin's ModelRegistry load the same file. Adding
// a model means editing the JSON; both runtimes pick it up at next start.
//
// Export shape preserved from pre-BAT-517 (CLAUDE_MODELS, OPENAI_*_MODELS,
// *_DEFAULT_MODEL, KNOWN_PROVIDERS, PROVIDER_DISPLAY_NAMES, the
// validate/resolve helpers) so existing callers in message-handler.js and
// the test suite keep working without churn.
// ============================================================================

'use strict';

const fs = require('fs');
const path = require('path');

const REGISTRY_PATH = path.join(__dirname, 'model-registry.json');
const EXPECTED_VERSION = 1;

// Load + validate at require-time. Failure throws — matches Kotlin's
// "fail loud at boot" behaviour and makes a malformed bundled asset
// (a build-time bug) impossible to ship undetected.
// IDs whose presence the constant derivations below depend on. Kept
// in sync with the dereferences `_byId.claude / _byId.openai /
// _byId.openrouter` further down — `custom` is intentionally NOT
// required at this layer (no top-level constant references it).
const REQUIRED_PROVIDER_IDS = ['openai', 'claude', 'openrouter'];

/**
 * Validate a parsed registry object. Pure function (no I/O) so tests
 * can exercise the failure paths without touching the bundled asset.
 * Throws Error with a clear message on any contract violation.
 *
 * BAT-517 R4 Copilot: duplicate-id and required-id checks added —
 * Object.fromEntries silently overwrites duplicates, and the
 * constant derivations below directly deref _byId.{claude,openai,
 * openrouter}, so without this guard those failures would surface as
 * unhelpful "Cannot read properties of undefined" TypeErrors at
 * require-time. Symmetric with Kotlin's `loadAndValidate` +
 * `requireProviderById`.
 */
function _validateRegistry(parsed) {
    if (!parsed || typeof parsed !== 'object') {
        throw new Error('model-registry.json is not a JSON object');
    }
    if (parsed.version !== EXPECTED_VERSION) {
        throw new Error(`model-registry.json version=${parsed.version}, expected=${EXPECTED_VERSION}`);
    }
    if (!Array.isArray(parsed.providers) || parsed.providers.length === 0) {
        throw new Error('model-registry.json has no providers');
    }
    const ids = parsed.providers.map((p) => p && p.id);
    const dupes = ids.filter((id, i) => ids.indexOf(id) !== i);
    if (dupes.length > 0) {
        throw new Error(`model-registry.json has duplicate provider ids: ${[...new Set(dupes)].join(', ')}`);
    }
    const missing = REQUIRED_PROVIDER_IDS.filter((id) => !ids.includes(id));
    if (missing.length > 0) {
        throw new Error(`model-registry.json is missing required provider(s): ${missing.join(', ')}`);
    }
    return parsed;
}

function _loadRegistry() {
    const raw = fs.readFileSync(REGISTRY_PATH, 'utf8');
    return _validateRegistry(JSON.parse(raw));
}

const _REGISTRY = _loadRegistry();
const _byId = Object.fromEntries(_REGISTRY.providers.map((p) => [p.id, p]));

// ─── Backward-compat exports derived from the registry ──────────────────────
//
// Pre-BAT-517 callers import these names directly. Computed once at module
// load — the registry is read-only at runtime, so freezing the references
// here matches the previous semantics (top-level `const`s).

const CLAUDE_MODELS         = _byId.claude.models;
const OPENAI_API_KEY_MODELS = _byId.openai.models;
// BAT-517 R1 Copilot: `modelsByAuth` is optional in the schema (Kotlin
// defaults it to emptyMap()), so we must not assume the override exists.
// If a future registry omits it, fall back to the base `models` list —
// same behaviour as `modelsForProvider('openai','oauth')` and Kotlin's
// `modelsByAuth["oauth"] ?: models`.
const OPENAI_OAUTH_MODELS   = (_byId.openai.modelsByAuth && _byId.openai.modelsByAuth.oauth)
    || _byId.openai.models;

const CLAUDE_DEFAULT_MODEL     = _byId.claude.defaultModel;
const OPENAI_DEFAULT_MODEL     = _byId.openai.defaultModel;
const OPENROUTER_DEFAULT_MODEL = _byId.openrouter.defaultModel;

const KNOWN_PROVIDERS = _REGISTRY.providers.map((p) => p.id);

// Canonical display names for user-facing messaging (Telegram replies,
// TG command descriptions, etc). Mirrors Kotlin's Settings UI convention
// — `claude` maps to "Anthropic" (the company making Claude). NOT used
// for identity/routing — that's always `providerId`.
const PROVIDER_DISPLAY_NAMES = Object.fromEntries(
    _REGISTRY.providers.map((p) => [p.id, p.displayName]),
);

// ─── Resolution helpers ─────────────────────────────────────────────────────

/**
 * Resolve the model list for a given provider + auth.
 * Returns [] for freeform providers (openrouter, custom) and unknown providers.
 *
 * For OpenAI, `authType` MUST be explicitly 'api_key' or 'oauth'.
 * Passing null/undefined/anything else returns [] so callers
 * (validateModelForProvider, /model display) surface a clear error
 * rather than silently validating against the API-key allowlist.
 * Mirrors Kotlin's modelsForProvider which throws on the same
 * ambiguity — we return empty instead of throwing because a thrown
 * error from inside a Node tool would crash the chat turn (BAT-517
 * preserves this asymmetry).
 */
function modelsForProvider(providerId, authType) {
    const provider = _byId[providerId];
    if (!provider) return [];
    if (provider.freeform) return [];
    if (provider.id === 'openai') {
        // BAT-517 R2 Copilot: guard `modelsByAuth` — schema marks it
        // optional (Kotlin defaults to emptyMap()), so the
        // `modelsByAuth.oauth` direct access could TypeError if a future
        // registry omits the field. Symmetric with the
        // OPENAI_OAUTH_MODELS constant derivation above.
        if (authType === 'oauth') return (provider.modelsByAuth && provider.modelsByAuth.oauth) || provider.models;
        if (authType === 'api_key') return provider.models;
        return [];
    }
    if (authType && provider.modelsByAuth && provider.modelsByAuth[authType]) {
        return provider.modelsByAuth[authType];
    }
    return provider.models;
}

/**
 * Recommended default model for provider+authType.
 * Deliberately decoupled from list order — don't put tier-gated models here.
 * Mirrors Kotlin defaultModelForProvider(...).
 */
// eslint-disable-next-line no-unused-vars
function defaultModelForProvider(providerId, authType) {
    const provider = _byId[providerId];
    if (!provider) return '';
    return provider.defaultModel;
}

/**
 * Render a provider ID as a canonical brand name ("OpenAI", not
 * "Openai"). Falls back to the raw ID (capitalized) for anything
 * not in the registry so future providers don't crash the display
 * path if the JSON forgets to register one.
 */
function displayNameForProvider(providerId) {
    if (PROVIDER_DISPLAY_NAMES[providerId]) return PROVIDER_DISPLAY_NAMES[providerId];
    if (typeof providerId !== 'string' || !providerId) return 'Unknown';
    return providerId.charAt(0).toUpperCase() + providerId.slice(1);
}

/**
 * Valid auth types per provider. Falls back to ['api_key'] for unknown
 * providers (defensive — matches the pre-BAT-517 default branch).
 */
function authTypesForProvider(providerId) {
    const provider = _byId[providerId];
    if (provider) return provider.authTypes;
    return ['api_key'];
}

/**
 * Check whether a given (providerId, authType) has credentials configured.
 * Reads from the startup `config` object loaded by config.js. Returns:
 *   { ok: true }                          — credentials present
 *   { ok: false, reason: <human string> } — missing / not configured
 *
 * NOT registry data — the runtime-config-key mapping (which `config.X`
 * field corresponds to each provider/auth) is loader-side behaviour
 * that stays per-language. Could move into the schema later if both
 * runtimes need it; out of scope for BAT-517.
 */
function hasCredentialsFor(config, providerId, authType) {
    const nonBlank = (v) => typeof v === 'string' && v.trim().length > 0;
    switch (providerId) {
        case 'claude':
            if (authType === 'setup_token') {
                return nonBlank(config.setupToken)
                    ? { ok: true }
                    : { ok: false, reason: 'No Anthropic setup token. Add one in Settings → Provider → Anthropic → Setup Token.' };
            }
            return nonBlank(config.anthropicApiKey)
                ? { ok: true }
                : { ok: false, reason: 'No Anthropic API key. Add one in Settings → Provider → Anthropic.' };
        case 'openai':
            if (authType === 'oauth') {
                return nonBlank(config.openaiOAuthToken)
                    ? { ok: true }
                    : { ok: false, reason: 'Not signed in to OpenAI. Sign in via Settings → Provider → OpenAI → ChatGPT login.' };
            }
            return nonBlank(config.openaiApiKey)
                ? { ok: true }
                : { ok: false, reason: 'No OpenAI API key. Add one in Settings → Provider → OpenAI.' };
        case 'openrouter':
            return nonBlank(config.openrouterApiKey)
                ? { ok: true }
                : { ok: false, reason: 'No OpenRouter API key. Add one in Settings → Provider → OpenRouter.' };
        case 'custom':
            if (!nonBlank(config.customApiKey)) {
                return { ok: false, reason: 'No Custom provider API key. Set it in Settings → Provider → Custom.' };
            }
            if (!nonBlank(config.customBaseUrl)) {
                return { ok: false, reason: 'No Custom provider base URL. Set it in Settings → Provider → Custom.' };
            }
            return { ok: true };
        default:
            return { ok: false, reason: `Unknown provider: ${providerId}` };
    }
}

/**
 * Validate a model ID for a given provider+auth.
 * OpenRouter / Custom accept anything non-empty (freeform).
 * Claude / OpenAI must match the allowlist.
 */
function validateModelForProvider(providerId, authType, modelId) {
    const trimmed = typeof modelId === 'string' ? modelId.trim() : '';
    if (!trimmed) return { ok: false, reason: 'Model ID must not be empty.' };
    const provider = _byId[providerId];
    if (provider && provider.freeform) {
        return { ok: true, model: trimmed };
    }
    if (providerId === 'openrouter' || providerId === 'custom') {
        // Defensive: keep freeform behaviour at this call site even if
        // someone removes the freeform flag from the registry entries.
        return { ok: true, model: trimmed };
    }
    const list = modelsForProvider(providerId, authType);
    const found = list.find((m) => m.id === trimmed);
    if (!found) {
        return {
            ok: false,
            reason: `Unknown model for ${providerId}${authType ? ` (${authType})` : ''}.`,
            options: list.map((m) => m.id),
        };
    }
    return { ok: true, model: trimmed };
}

module.exports = {
    CLAUDE_MODELS,
    OPENAI_API_KEY_MODELS,
    OPENAI_OAUTH_MODELS,
    CLAUDE_DEFAULT_MODEL,
    OPENAI_DEFAULT_MODEL,
    OPENROUTER_DEFAULT_MODEL,
    KNOWN_PROVIDERS,
    PROVIDER_DISPLAY_NAMES,
    modelsForProvider,
    defaultModelForProvider,
    authTypesForProvider,
    hasCredentialsFor,
    validateModelForProvider,
    displayNameForProvider,
    // Test seam — exposes the loader's pure validation so unit tests
    // can exercise failure paths (duplicate ids, missing required ids,
    // bad version) without writing temp asset files. Not used by
    // production code paths.
    _validateRegistry,
};
