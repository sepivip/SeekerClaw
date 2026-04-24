// ============================================================================
// Model & provider catalog — mirrors Kotlin Providers.kt / Models.kt.
//
// Used by the `/model` and `/provider` Telegram slash commands to validate
// user input. Kept deliberately simple (pure data + pure functions) so it's
// easy to unit-test and easy to spot drift vs the Kotlin source.
//
// KEEP IN SYNC with:
//   app/src/main/java/com/seekerclaw/app/config/Providers.kt
//   app/src/main/java/com/seekerclaw/app/config/Models.kt
// ============================================================================

'use strict';

// Ordered for display: freshest first. Default selection is explicit (see
// defaultModelForProvider) and NOT tied to list position — so newly-added
// tier-gated models can appear at the top of pickers without silently
// becoming the default.
const CLAUDE_MODELS = [
    { id: 'claude-opus-4-7',   displayName: 'Opus 4.7' },
    { id: 'claude-opus-4-6',   displayName: 'Opus 4.6' },
    { id: 'claude-sonnet-4-6', displayName: 'Sonnet 4.6' },
    { id: 'claude-haiku-4-5',  displayName: 'Haiku 4.5' },
];

const OPENAI_API_KEY_MODELS = [
    { id: 'gpt-5.5',       displayName: 'GPT-5.5' },
    { id: 'gpt-5.4',       displayName: 'GPT-5.4' },
    { id: 'gpt-5.3-codex', displayName: 'GPT-5.3 Codex' },
];

const OPENAI_OAUTH_MODELS = [
    { id: 'gpt-5.5',       displayName: 'GPT-5.5' },
    { id: 'gpt-5.4',       displayName: 'GPT-5.4' },
    { id: 'gpt-5.4-mini',  displayName: 'GPT-5.4 Mini' },
    { id: 'gpt-5.3-codex', displayName: 'GPT-5.3 Codex' },
];

const OPENROUTER_DEFAULT_MODEL = 'anthropic/claude-sonnet-4-6';

// Explicit safe defaults per provider. Do NOT derive these from list order —
// a new model inserted at the top of a display list shouldn't silently change
// the default. Tier-gated models (eg. gpt-5.5 on some ChatGPT plans) must
// never be listed here, or fresh installs / provider-switch fallbacks would
// land users on a model their plan can't reach.
const CLAUDE_DEFAULT_MODEL = 'claude-opus-4-7';
const OPENAI_DEFAULT_MODEL = 'gpt-5.4'; // available on every ChatGPT tier + api key

/**
 * Resolve the model list for a given provider + auth.
 * Returns [] for freeform providers (openrouter, custom).
 *
 * For OpenAI, `authType` MUST be explicitly 'api_key' or 'oauth'.
 * Passing null/undefined/anything else returns [] so callers
 * (validateModelForProvider, /model display) surface a clear error
 * rather than silently validating against the API-key allowlist.
 * Mirrors Kotlin's modelsForProvider which throws on the same
 * ambiguity — we return empty instead of throwing because a thrown
 * error from inside a Node tool would crash the chat turn.
 */
function modelsForProvider(providerId, authType) {
    switch (providerId) {
        case 'claude':
            return CLAUDE_MODELS;
        case 'openai':
            if (authType === 'oauth') return OPENAI_OAUTH_MODELS;
            if (authType === 'api_key') return OPENAI_API_KEY_MODELS;
            return [];
        case 'openrouter':
        case 'custom':
            return [];
        default:
            return [];
    }
}

/**
 * Recommended default model for provider+authType.
 * Deliberately decoupled from list order — don't put tier-gated models here.
 * Mirrors Kotlin defaultModelForProvider(...).
 */
function defaultModelForProvider(providerId, authType) {
    switch (providerId) {
        case 'claude':     return CLAUDE_DEFAULT_MODEL;
        case 'openai':     return OPENAI_DEFAULT_MODEL;
        case 'openrouter': return OPENROUTER_DEFAULT_MODEL;
        case 'custom':     return '';
        default:           return '';
    }
}

const KNOWN_PROVIDERS = ['claude', 'openai', 'openrouter', 'custom'];

// Canonical display names for user-facing messaging (Telegram replies,
// TG command descriptions, etc). Mirrors Kotlin's Providers.kt
// `availableProviders[].displayName` so Settings UI and Telegram
// replies never disagree on branding. NOT used for identity/routing
// — that's always `providerId`.
//
// Note: `claude` maps to "Anthropic" (the company making Claude) to
// match Kotlin's Settings UI convention. Settings shows "Anthropic"
// with the sk-ant-api03-… key hint, so the Telegram reply saying
// "Switching to Anthropic" is consistent with where the user
// configured credentials.
const PROVIDER_DISPLAY_NAMES = {
    claude: 'Anthropic',
    openai: 'OpenAI',
    openrouter: 'OpenRouter',
    custom: 'Custom',
};

/**
 * Render a provider ID as a canonical brand name ("OpenAI", not
 * "Openai"). Falls back to the raw ID (capitalized) for anything
 * not in the registry so future providers don't crash the display
 * path if someone forgets to update PROVIDER_DISPLAY_NAMES.
 */
function displayNameForProvider(providerId) {
    if (PROVIDER_DISPLAY_NAMES[providerId]) return PROVIDER_DISPLAY_NAMES[providerId];
    if (typeof providerId !== 'string' || !providerId) return 'Unknown';
    return providerId.charAt(0).toUpperCase() + providerId.slice(1);
}

/**
 * Valid auth types per provider. OpenAI is the only one with multiple.
 */
function authTypesForProvider(providerId) {
    switch (providerId) {
        case 'openai': return ['api_key', 'oauth'];
        case 'claude': return ['api_key', 'setup_token'];
        default: return ['api_key'];
    }
}

/**
 * Check whether a given (providerId, authType) has credentials configured.
 * Reads from the startup `config` object loaded by config.js. Returns:
 *   { ok: true }                          — credentials present
 *   { ok: false, reason: <human string> } — missing / not configured
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
    if (providerId === 'openrouter' || providerId === 'custom') {
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
};
