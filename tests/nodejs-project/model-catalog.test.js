#!/usr/bin/env node
// model-catalog.test.js — unit tests for the pure-logic helpers in
// app/src/main/assets/nodejs-project/model-catalog.js.
//
// Run:  node tests/nodejs-project/model-catalog.test.js
// Exit: 0 = all pass, 1 = at least one failure.
//
// WHY THIS FILE EXISTS
// --------------------
// model-catalog.js drives validation for the /model and /provider Telegram
// slash commands. A regression here is user-visible: either a bad model
// gets accepted and the next request fails silently, or a legitimate
// switch gets rejected with a confusing message.
//
// The module is also the Node mirror of Kotlin's Providers.kt / Models.kt.
// Drift between the two would let Settings UI and Telegram commands
// disagree about which models are valid. These tests lock in the contract.
//
// Invariants these tests protect:
//   - openai api_key allowlist includes gpt-5.5 (added 2026-04-23) but NOT
//     gpt-5.4-mini (OAuth-only).
//   - defaultModelForProvider never returns a tier-gated model (gpt-5.5
//     is in the list but gpt-5.4 is the default).
//   - Defaults are EXPLICIT constants, not list-order-derived — a new
//     model added at the top of a display list must not change defaults.
//   - Freeform providers (openrouter, custom) accept any non-blank model
//     but still reject blanks.
//   - Credential check reads the exact field names Kotlin writes to
//     config.json (anthropicApiKey, setupToken, openaiApiKey,
//     openaiOAuthToken, openrouterApiKey, customApiKey, customBaseUrl).

'use strict';

const mc = require('../../app/src/main/assets/nodejs-project/model-catalog');

let failures = 0;
function check(label, actual, expected) {
    const actualStr = JSON.stringify(actual);
    const expectedStr = JSON.stringify(expected);
    if (actualStr === expectedStr) {
        console.log('PASS: ' + label);
    } else {
        failures++;
        console.log('FAIL: ' + label);
        console.log('  got:  ' + actualStr);
        console.log('  want: ' + expectedStr);
    }
}

console.log('── modelsForProvider ────────────────────────────');
check('openai api_key list starts with gpt-5.5', mc.modelsForProvider('openai', 'api_key')[0].id, 'gpt-5.5');
check('openai oauth list includes gpt-5.4-mini', mc.modelsForProvider('openai', 'oauth').some((m) => m.id === 'gpt-5.4-mini'), true);
check('openai api_key list EXCLUDES gpt-5.4-mini', mc.modelsForProvider('openai', 'api_key').some((m) => m.id === 'gpt-5.4-mini'), false);
check('claude list non-empty', mc.modelsForProvider('claude', 'api_key').length > 0, true);
check('openrouter is freeform (empty list)', mc.modelsForProvider('openrouter', 'api_key'), []);
check('custom is freeform (empty list)', mc.modelsForProvider('custom', null), []);
check('unknown provider returns empty list', mc.modelsForProvider('bogus', null), []);
check('openai with null authType returns empty (strict)', mc.modelsForProvider('openai', null), []);
check('openai with undefined authType returns empty (strict)', mc.modelsForProvider('openai', undefined), []);
check('openai with bogus authType returns empty (strict)', mc.modelsForProvider('openai', 'bogus'), []);

console.log();
console.log('── displayNameForProvider (canonical brand casing) ─────');
check('claude → Anthropic (match Kotlin Settings displayName)', mc.displayNameForProvider('claude'), 'Anthropic');
check('openai → OpenAI (not Openai)', mc.displayNameForProvider('openai'), 'OpenAI');
check('openrouter → OpenRouter (not Openrouter)', mc.displayNameForProvider('openrouter'), 'OpenRouter');
check('custom → Custom', mc.displayNameForProvider('custom'), 'Custom');
check('unknown provider → capitalized fallback', mc.displayNameForProvider('futurething'), 'Futurething');
check('empty string → Unknown', mc.displayNameForProvider(''), 'Unknown');
check('null → Unknown', mc.displayNameForProvider(null), 'Unknown');

console.log();
console.log('── defaultModelForProvider (decoupled from list order) ──');
check('claude default explicit (NOT list[0])', mc.defaultModelForProvider('claude', 'api_key'), mc.CLAUDE_DEFAULT_MODEL);
check('openai api_key default is gpt-5.4', mc.defaultModelForProvider('openai', 'api_key'), 'gpt-5.4');
check('openai oauth default is gpt-5.4 (NOT 5.5 — tier-gated)', mc.defaultModelForProvider('openai', 'oauth'), 'gpt-5.4');
check('openrouter default is anthropic/claude-sonnet-4-6', mc.defaultModelForProvider('openrouter', 'api_key'), 'anthropic/claude-sonnet-4-6');
check('custom default is blank (user must type model)', mc.defaultModelForProvider('custom', 'api_key'), '');
check('unknown provider default is blank', mc.defaultModelForProvider('bogus', null), '');
check('exports CLAUDE_DEFAULT_MODEL const', typeof mc.CLAUDE_DEFAULT_MODEL === 'string' && mc.CLAUDE_DEFAULT_MODEL.length > 0, true);
check('exports OPENAI_DEFAULT_MODEL const', mc.OPENAI_DEFAULT_MODEL, 'gpt-5.4');

console.log();
console.log('── authTypesForProvider ─────────────────────────');
check('openai has api_key + oauth', mc.authTypesForProvider('openai'), ['api_key', 'oauth']);
check('claude has api_key + setup_token', mc.authTypesForProvider('claude'), ['api_key', 'setup_token']);
check('openrouter has api_key only', mc.authTypesForProvider('openrouter'), ['api_key']);
check('custom has api_key only', mc.authTypesForProvider('custom'), ['api_key']);

console.log();
console.log('── validateModelForProvider (allowlist) ─────────');
check('gpt-5.5 valid on openai api_key', mc.validateModelForProvider('openai', 'api_key', 'gpt-5.5').ok, true);
check('gpt-5.4-mini valid on openai oauth', mc.validateModelForProvider('openai', 'oauth', 'gpt-5.4-mini').ok, true);
check('gpt-5.4-mini INVALID on openai api_key', mc.validateModelForProvider('openai', 'api_key', 'gpt-5.4-mini').ok, false);

const bogus = mc.validateModelForProvider('openai', 'api_key', 'gpt-99');
check('unknown model rejected with reason', bogus.ok === false && typeof bogus.reason === 'string', true);
check('unknown model returns options list', Array.isArray(bogus.options) && bogus.options.length > 0, true);

check('claude-opus-4-7 valid on claude', mc.validateModelForProvider('claude', 'api_key', 'claude-opus-4-7').ok, true);

console.log();
console.log('── validateModelForProvider (freeform) ──────────');
check('openrouter accepts arbitrary ID', mc.validateModelForProvider('openrouter', null, 'openai/gpt-5.5').ok, true);
check('custom accepts arbitrary ID', mc.validateModelForProvider('custom', null, 'my-custom-model').ok, true);
check('openrouter rejects blank', mc.validateModelForProvider('openrouter', null, '').ok, false);
check('openai rejects whitespace-only', mc.validateModelForProvider('openai', 'api_key', '   ').ok, false);

console.log();
console.log('── hasCredentialsFor (field names mirror Kotlin config.json) ──');
check('claude api_key set', mc.hasCredentialsFor({ anthropicApiKey: 'sk-ant-xxx' }, 'claude', 'api_key').ok, true);
check('claude api_key blank → rejected', mc.hasCredentialsFor({}, 'claude', 'api_key').ok, false);
check('claude setup_token set', mc.hasCredentialsFor({ setupToken: 'abc' }, 'claude', 'setup_token').ok, true);
check('claude setup_token blank → rejected', mc.hasCredentialsFor({}, 'claude', 'setup_token').ok, false);

check('openai api_key set', mc.hasCredentialsFor({ openaiApiKey: 'sk-xxx' }, 'openai', 'api_key').ok, true);
check('openai api_key missing → rejected', mc.hasCredentialsFor({}, 'openai', 'api_key').ok, false);
check('openai oauth token set', mc.hasCredentialsFor({ openaiOAuthToken: 'tok' }, 'openai', 'oauth').ok, true);
check('openai oauth token missing → rejected', mc.hasCredentialsFor({}, 'openai', 'oauth').ok, false);

check('openrouter key set', mc.hasCredentialsFor({ openrouterApiKey: 'sk-or-xxx' }, 'openrouter', 'api_key').ok, true);
check('openrouter key missing → rejected', mc.hasCredentialsFor({}, 'openrouter', 'api_key').ok, false);

check('custom both (key + URL) set', mc.hasCredentialsFor({ customApiKey: 'k', customBaseUrl: 'https://x.com' }, 'custom', 'api_key').ok, true);
check('custom missing URL → rejected', mc.hasCredentialsFor({ customApiKey: 'k' }, 'custom', 'api_key').ok, false);
check('custom missing KEY → rejected', mc.hasCredentialsFor({ customBaseUrl: 'https://x.com' }, 'custom', 'api_key').ok, false);

check('unknown provider → rejected', mc.hasCredentialsFor({}, 'bogus', 'api_key').ok, false);

// Reason messages should exist and be non-empty on rejection — these become
// user-facing Telegram messages, so keep them informative.
check('rejection reason is a non-empty string', typeof mc.hasCredentialsFor({}, 'claude', 'api_key').reason === 'string' && mc.hasCredentialsFor({}, 'claude', 'api_key').reason.length > 0, true);

console.log();
console.log('── KNOWN_PROVIDERS ──────────────────────────────');
check('KNOWN_PROVIDERS has 4 entries', mc.KNOWN_PROVIDERS.length, 4);
check('includes claude', mc.KNOWN_PROVIDERS.includes('claude'), true);
check('includes openai', mc.KNOWN_PROVIDERS.includes('openai'), true);
check('includes openrouter', mc.KNOWN_PROVIDERS.includes('openrouter'), true);
check('includes custom', mc.KNOWN_PROVIDERS.includes('custom'), true);
// Provider order pin (BAT-517 Codex finding 1): preserve fallback target.
check('KNOWN_PROVIDERS[0] is openai (preserves pre-BAT-517 unknown-id fallback)', mc.KNOWN_PROVIDERS[0], 'openai');

console.log();
console.log('── BAT-517 schema invariants (model-registry.json contract) ──');
// Re-read the registry directly so we can pin schema-level invariants
// independent of the derived export shape — if a future edit breaks
// the registry's own rules, this catches it BEFORE we ever shipped a
// catalog with garbage values. Mirrors ModelRegistryTest.kt.
const fs = require('fs');
const path = require('path');
const REGISTRY_PATH = path.join(
    __dirname, '..', '..',
    'app', 'src', 'main', 'assets', 'nodejs-project', 'model-registry.json',
);
const REGISTRY = JSON.parse(fs.readFileSync(REGISTRY_PATH, 'utf8'));

check('registry version is 1', REGISTRY.version, 1);
check('registry has providers array', Array.isArray(REGISTRY.providers), true);
check('registry has 4 providers', REGISTRY.providers.length, 4);

// Per-auth default-model invariant (Codex v2 Fix 4): for every
// non-freeform provider AND every authType in `authTypes`,
// `defaultModel` must appear in `modelsByAuth[authType] ?? models`.
let perAuthInvariantOk = true;
let perAuthFailures = [];
for (const p of REGISTRY.providers) {
    if (p.freeform) continue;
    for (const auth of p.authTypes) {
        const effective = (p.modelsByAuth && p.modelsByAuth[auth]) || p.models;
        const ids = effective.map((m) => m.id);
        if (!ids.includes(p.defaultModel)) {
            perAuthInvariantOk = false;
            perAuthFailures.push(`${p.id}/${auth}: defaultModel '${p.defaultModel}' not in [${ids.join(', ')}]`);
        }
    }
}
check('per-auth defaultModel invariant holds (Codex Fix 4)', perAuthInvariantOk, true);
if (!perAuthInvariantOk) {
    console.log('  failures:');
    for (const f of perAuthFailures) console.log('    - ' + f);
}

// modelsByAuth keys must be a subset of authTypes.
let authKeysOk = true;
for (const p of REGISTRY.providers) {
    if (!p.modelsByAuth) continue;
    for (const k of Object.keys(p.modelsByAuth)) {
        if (!p.authTypes.includes(k)) {
            authKeysOk = false;
            console.log(`  ${p.id}: modelsByAuth key '${k}' not in authTypes [${p.authTypes.join(', ')}]`);
        }
    }
}
check('modelsByAuth keys ⊆ authTypes', authKeysOk, true);

// Freeform providers MUST have empty `models`.
let freeformShapeOk = true;
for (const p of REGISTRY.providers) {
    if (p.freeform && p.models.length !== 0) {
        freeformShapeOk = false;
        console.log(`  ${p.id}: freeform but models has ${p.models.length} entries`);
    }
}
check('freeform providers have empty models list', freeformShapeOk, true);

// No duplicate provider ids; no duplicate model ids within a provider.
const providerIds = REGISTRY.providers.map((p) => p.id);
check('no duplicate provider ids', providerIds.length, new Set(providerIds).size);
let dupeModelOk = true;
for (const p of REGISTRY.providers) {
    const allLists = [p.models, ...Object.values(p.modelsByAuth || {})];
    for (const list of allLists) {
        const ids = list.map((m) => m.id);
        if (new Set(ids).size !== ids.length) {
            dupeModelOk = false;
            console.log(`  ${p.id}: duplicate ids in [${ids.join(', ')}]`);
        }
    }
}
check('no duplicate model ids within any per-provider list', dupeModelOk, true);

console.log();
console.log('── exported constants match registry-derived values (drift guard) ──');
// If someone touches the catalog code without re-running the loader (or
// hardcodes a value), this guard catches the drift between exports and
// the JSON source of truth.
const byId = Object.fromEntries(REGISTRY.providers.map((p) => [p.id, p]));
// BAT-517 R3 Copilot: mirror the production code's optional handling
// of `modelsByAuth` here too. Direct `.modelsByAuth.oauth` access would
// TypeError and ABORT the test run if a future registry omits the
// override; the guarded access lets `check()` report a clean FAIL
// instead.
const expectedOpenaiOauthModels =
    (byId.openai.modelsByAuth && byId.openai.modelsByAuth.oauth) || byId.openai.models;
check('CLAUDE_MODELS == registry.claude.models', mc.CLAUDE_MODELS, byId.claude.models);
check('OPENAI_API_KEY_MODELS == registry.openai.models', mc.OPENAI_API_KEY_MODELS, byId.openai.models);
check('OPENAI_OAUTH_MODELS == registry.openai.modelsByAuth.oauth (or fallback to models)', mc.OPENAI_OAUTH_MODELS, expectedOpenaiOauthModels);
check('CLAUDE_DEFAULT_MODEL matches registry', mc.CLAUDE_DEFAULT_MODEL, byId.claude.defaultModel);
check('OPENAI_DEFAULT_MODEL matches registry', mc.OPENAI_DEFAULT_MODEL, byId.openai.defaultModel);
check('OPENROUTER_DEFAULT_MODEL matches registry', mc.OPENROUTER_DEFAULT_MODEL, byId.openrouter.defaultModel);
check('PROVIDER_DISPLAY_NAMES matches registry',
    mc.PROVIDER_DISPLAY_NAMES,
    Object.fromEntries(REGISTRY.providers.map((p) => [p.id, p.displayName])));

console.log();
console.log('── _validateRegistry: explicit failure paths (BAT-517 R4 Copilot) ──');
// Pin the loader-side validation Copilot asked for: duplicate provider
// ids and missing required providers must throw clear errors at
// require-time, not surface as obscure "Cannot read properties of
// undefined" TypeErrors when the constant derivations dereference
// _byId.{claude,openai,openrouter}.
function expectThrow(label, fn, messageSubstring) {
    try {
        fn();
    } catch (e) {
        if (typeof e.message === 'string' && e.message.includes(messageSubstring)) {
            console.log(`PASS: ${label}`);
            return;
        }
        console.log(`FAIL: ${label} — wrong error message: ${e.message}`);
        failures++;
        return;
    }
    console.log(`FAIL: ${label} — did not throw`);
    failures++;
}

const baseRegistry = JSON.parse(JSON.stringify(REGISTRY));
const _validate = mc._validateRegistry;

expectThrow(
    'rejects null',
    () => _validate(null),
    'is not a JSON object',
);
expectThrow(
    'rejects bad version',
    () => _validate({ ...baseRegistry, version: 999 }),
    'version=999',
);
expectThrow(
    'rejects empty providers',
    () => _validate({ version: 1, providers: [] }),
    'has no providers',
);
expectThrow(
    'rejects duplicate provider ids',
    () => _validate({
        version: 1,
        providers: [...baseRegistry.providers, baseRegistry.providers[0]],
    }),
    'duplicate provider ids',
);
expectThrow(
    'rejects missing required claude',
    () => _validate({
        version: 1,
        providers: baseRegistry.providers.filter((p) => p.id !== 'claude'),
    }),
    'missing required provider(s): claude',
);
expectThrow(
    'rejects missing required openai',
    () => _validate({
        version: 1,
        providers: baseRegistry.providers.filter((p) => p.id !== 'openai'),
    }),
    'missing required provider(s): openai',
);
expectThrow(
    'rejects missing required openrouter',
    () => _validate({
        version: 1,
        providers: baseRegistry.providers.filter((p) => p.id !== 'openrouter'),
    }),
    'missing required provider(s): openrouter',
);
// And the happy path: live registry passes validation.
try {
    _validate(baseRegistry);
    console.log('PASS: live registry passes _validateRegistry');
} catch (e) {
    console.log(`FAIL: live registry rejected by _validateRegistry — ${e.message}`);
    failures++;
}

console.log();
if (failures === 0) {
    console.log('ALL TESTS PASS');
    process.exit(0);
} else {
    console.log(`${failures} TEST(S) FAILED`);
    process.exit(1);
}
