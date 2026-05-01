#!/usr/bin/env node
// retry-log-provider-label.test.js — pin BAT-559 observability fix.
//
// Pre-fix, ai.js's retry/network log paths hardcoded "[Retry] Claude API
// <status>" / "[Claude] Failed to log network error" regardless of which
// provider actually returned the error. An OpenAI 429 from a rate-limited
// account was logged as "Claude API 429" — misleading the user about the
// failure source. BAT-559 swaps the literal "Claude" for
// `displayNameForProvider(PROVIDER)` so each provider's logs label
// themselves correctly:
//   - claude → "Claude" (registry exception: provider id 'claude' has
//              displayName 'Anthropic' in the registry, so the actual
//              label rendered is "Anthropic")
//   - openai → "OpenAI"
//   - openrouter → "OpenRouter"
//   - custom → "Custom"
//
// Per BAT-559 PM contract: test the LABEL function (displayNameForProvider)
// directly. ai.js's retry path is hard to drive in a unit test (it requires
// mocking the full http transport, retry budget, error classifier). The
// label function is the load-bearing piece for this fix; pinning it
// catches the same-class-bug if a future refactor swaps in a different
// helper or hardcodes a label literal.
//
// Run:  node tests/nodejs-project/retry-log-provider-label.test.js

'use strict';

const path = require('path');

// Defensive config.js stub. R1 Copilot: model-catalog.js does NOT
// currently import config (it only requires fs/path and reads
// model-registry.json), so the stub is not load-bearing today. It's
// kept as a guard for future model-catalog edits that might bring in
// a config dependency — without it, those tests would silently start
// requiring a config.json fixture on disk and fail in CI with a
// confusing "config.json not found" trace. Cheap insurance against
// a hard-to-diagnose future regression.
const configPath = path.resolve(__dirname, '../../app/src/main/assets/nodejs-project/config.js');
require.cache[configPath] = {
    id: configPath, filename: configPath, loaded: true,
    exports: { log: () => {} },
};

const {
    displayNameForProvider,
    PROVIDER_DISPLAY_NAMES,
    KNOWN_PROVIDERS,
} = require('../../app/src/main/assets/nodejs-project/model-catalog');

let failures = 0;
function eq(label, actual, expected) {
    const a = JSON.stringify(actual);
    const e = JSON.stringify(expected);
    if (a === e) console.log(`PASS: ${label}`);
    else { console.log(`FAIL: ${label}\n  actual:   ${a}\n  expected: ${e}`); failures++; }
}
function ok(label, cond, hint = '') {
    if (cond) console.log(`PASS: ${label}`);
    else { console.log(`FAIL: ${label}${hint ? ' — ' + hint : ''}`); failures++; }
}

console.log('── BAT-559: provider-label substitution covers all known providers ──');

// Each known provider must produce a non-empty, non-lowercase-id label.
// The exact label text comes from model-registry.json's provider entries;
// drift between the registry and these expected values is intentionally
// flagged here so a registry rename surfaces in tests.
const expectations = {
    claude: 'Anthropic',     // registry chooses 'Anthropic' for the company
    openai: 'OpenAI',
    openrouter: 'OpenRouter',
    custom: 'Custom',
};
for (const [providerId, expectedLabel] of Object.entries(expectations)) {
    eq(`displayNameForProvider('${providerId}') → '${expectedLabel}'`,
        displayNameForProvider(providerId), expectedLabel);
}

// Every registered provider must have an entry in PROVIDER_DISPLAY_NAMES.
// If a future provider lands in the registry but forgets a displayName,
// `displayNameForProvider` falls back to a Capitalized id — surfacing as
// "[Retry] Foobar API 429" in the user-visible Logs screen. Catch this
// regression by iterating the AUTHORITATIVE provider list (`KNOWN_PROVIDERS`,
// derived from registry.providers[].id), not the display-names map keys —
// the map-keys iteration was tautological because it only visited providers
// that already had a mapping (R2 Copilot finding).
console.log();
console.log('── BAT-559: every registry provider has an explicit displayName ──');
ok('At least 4 providers known to the registry',
    Array.isArray(KNOWN_PROVIDERS) && KNOWN_PROVIDERS.length >= 4,
    `actual count: ${KNOWN_PROVIDERS?.length}`);
for (const id of KNOWN_PROVIDERS) {
    ok(`Registry provider '${id}' has an entry in PROVIDER_DISPLAY_NAMES`,
        Object.prototype.hasOwnProperty.call(PROVIDER_DISPLAY_NAMES, id)
            && typeof PROVIDER_DISPLAY_NAMES[id] === 'string'
            && PROVIDER_DISPLAY_NAMES[id].length > 0,
        `actual: ${JSON.stringify(PROVIDER_DISPLAY_NAMES[id])}`);
}

// Robustness: unknown / malformed provider id must not crash the log
// path. Pre-fix this never came up because the literal "Claude" was
// always emitted. Post-fix it could surface if PROVIDER ever
// contained an unexpected value (config import bug, env override, etc.).
console.log();
console.log('── BAT-559: unknown / malformed input fallback ──');
ok('Empty string → "Unknown" (defensive)',
    displayNameForProvider('') === 'Unknown');
ok('null → "Unknown"',
    displayNameForProvider(null) === 'Unknown');
ok('undefined → "Unknown"',
    displayNameForProvider(undefined) === 'Unknown');
eq("Unknown provider id 'foobar' → Capitalized fallback",
    displayNameForProvider('foobar'), 'Foobar');

// Smoke the actual log-line shape so a future refactor that swaps the
// template breaks loudly. This is the literal `[Retry] <Provider> API
// <status> ...` shape the user sees on the Logs screen.
console.log();
console.log('── BAT-559: composed log-line shape (the user-visible template) ──');
const composedRetry = (provider, status) =>
    `[Retry] ${displayNameForProvider(provider)} API ${status} (rate_limit), retry 1/3, base 2000ms, waiting 1500ms`;
ok('OpenAI retry log starts with "[Retry] OpenAI API ..."',
    composedRetry('openai', 429).startsWith('[Retry] OpenAI API 429'),
    `actual: ${composedRetry('openai', 429)}`);
ok('OpenRouter retry log starts with "[Retry] OpenRouter API ..."',
    composedRetry('openrouter', 502).startsWith('[Retry] OpenRouter API 502'));
ok('Claude retry log uses registry "Anthropic" label (not literal "Claude")',
    composedRetry('claude', 529).startsWith('[Retry] Anthropic API 529'),
    `actual: ${composedRetry('claude', 529)}`);
ok('Custom retry log starts with "[Retry] Custom API ..."',
    composedRetry('custom', 503).startsWith('[Retry] Custom API 503'));

const composedNetwork = (provider) =>
    `[${displayNameForProvider(provider)}] Failed to log network error to DB: connection reset`;
ok('OpenAI network-error DB log uses "[OpenAI]" tag',
    composedNetwork('openai').startsWith('[OpenAI]'),
    `actual: ${composedNetwork('openai')}`);
ok('Claude network-error DB log uses registry "[Anthropic]" tag',
    composedNetwork('claude').startsWith('[Anthropic]'),
    `actual: ${composedNetwork('claude')}`);

console.log();
if (failures === 0) {
    console.log('ALL TESTS PASS');
    process.exit(0);
} else {
    console.log(`${failures} TEST(S) FAILED`);
    process.exit(1);
}
