#!/usr/bin/env node
// usepod-adapter.test.js — pin BAT-971 v2.2 Usepod adapter contract:
//
//  - Endpoint construction: valid UUID → /proxy/<TOKEN>/v1/chat/completions
//  - Endpoint refusal: invalid token (blank, non-UUID, URL-with-slashes,
//    .., whitespace) → throws typed error, NEVER constructs a malformed URL
//  - buildHeaders: minimal (Content-Type + dummy Authorization) — NO
//    HTTP-Referer, NO X-Title, NO OpenRouter API key
//  - formatRequest: clean OpenAI chat-completions body — NO `provider`,
//    NO `cache_control`, NO OpenRouter-only fields. `input` treated as
//    already-translated chat-completions messages (Codex v2.1 fix #2)
//  - classifyError: 402 unfunded vs `no_provider_at_price` (Codex v2 fix #6);
//    401 invalid-format vs not-found-or-not-activated (per BAT-971
//    live-probe characterization)
//  - parseRateLimitHeaders: parses X-Balance-Remaining if present
//
// Run: node tests/nodejs-project/usepod-adapter.test.js
// Exit: 0 = all pass, 1 = at least one failure

'use strict';

const path = require('path');

// Stub config.js so the adapter loads without a real config.json or running
// validation gates. The token here is a valid UUID so the dynamic endpoint
// getter doesn't throw under the adapter's own UUID pre-flight.
const VALID_TOKEN = '11111111-2222-3333-4444-555555555555';
const stubConfigPath = path.resolve(__dirname, '../../app/src/main/assets/nodejs-project/config.js');
const USEPOD_UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
let _currentToken = VALID_TOKEN;
require.cache[stubConfigPath] = {
    id: stubConfigPath,
    filename: stubConfigPath,
    loaded: true,
    exports: {
        // The adapter destructures these three at require-time:
        get USEPOD_TOKEN() { return _currentToken; },
        isValidUsepodToken: (t) => typeof t === 'string' && USEPOD_UUID_RE.test(t.trim()),
        log: () => {},
    },
};

const usepod = require('../../app/src/main/assets/nodejs-project/providers/usepod');
// Also load openrouter to verify the delegated functions are bound, not
// re-implemented (the v2.2 design splits OWN vs DELEGATED explicitly).
const openrouter = require('../../app/src/main/assets/nodejs-project/providers/openrouter');

let failures = 0;
function assertEq(label, actual, expected) {
    const a = JSON.stringify(actual);
    const e = JSON.stringify(expected);
    if (a === e) console.log(`PASS: ${label}`);
    else { console.log(`FAIL: ${label}\n  actual:   ${a}\n  expected: ${e}`); failures++; }
}
function assertOk(label, cond, hint = '') {
    if (cond) console.log(`PASS: ${label}`);
    else { console.log(`FAIL: ${label}${hint ? ' — ' + hint : ''}`); failures++; }
}
function assertThrows(label, fn, expectedCode = null) {
    try {
        fn();
        console.log(`FAIL: ${label} — expected throw, got none`);
        failures++;
    } catch (e) {
        if (expectedCode && e.code !== expectedCode) {
            console.log(`FAIL: ${label} — wrong code (expected=${expectedCode} actual=${e.code})`);
            failures++;
        } else {
            console.log(`PASS: ${label} — threw as expected`);
        }
    }
}

// ─── Endpoint construction ──────────────────────────────────────────────────

console.log('── Endpoint construction ──');

_currentToken = VALID_TOKEN;
assertEq(
    'endpoint with valid token produces /proxy/<TOKEN>/v1/chat/completions',
    { hostname: usepod.endpoint.hostname, path: usepod.endpoint.path },
    { hostname: 'api.usepod.ai', path: `/proxy/${VALID_TOKEN}/v1/chat/completions` },
);

assertEq(
    'testEndpoint with valid token produces /proxy/<TOKEN>/balance (GET)',
    { hostname: usepod.testEndpoint.hostname, path: usepod.testEndpoint.path, method: usepod.testEndpoint.method },
    { hostname: 'api.usepod.ai', path: `/proxy/${VALID_TOKEN}/balance`, method: 'GET' },
);

// ─── Endpoint refusal on invalid tokens ─────────────────────────────────────

console.log('── Endpoint refusal on invalid tokens ──');

for (const bad of ['', '   ', 'not-a-uuid', '../etc/passwd', 'a/b/c', 'a?b=c', 'a#b', 'https://evil.com/']) {
    _currentToken = bad;
    assertThrows(
        `endpoint refuses invalid token: ${JSON.stringify(bad)}`,
        () => usepod.endpoint.path,
        'USEPOD_INVALID_TOKEN',
    );
    assertThrows(
        `testEndpoint refuses invalid token: ${JSON.stringify(bad)}`,
        () => usepod.testEndpoint.path,
        'USEPOD_INVALID_TOKEN',
    );
}

// ─── buildHeaders: minimal, no OpenRouter decorations ───────────────────────

console.log('── buildHeaders minimal ──');

const headers = usepod.buildHeaders('ignored-key-arg');
assertEq('buildHeaders has exactly Content-Type + Authorization', Object.keys(headers).sort(), ['Authorization', 'Content-Type']);
assertEq('Authorization is the dummy literal "Bearer UsePod"', headers.Authorization, 'Bearer UsePod');
assertOk('buildHeaders does NOT include HTTP-Referer', !('HTTP-Referer' in headers));
assertOk('buildHeaders does NOT include X-Title', !('X-Title' in headers));

// ─── formatRequest: clean OpenAI body, no OpenRouter-only fields ────────────

console.log('── formatRequest clean body ──');

const sampleInput = [
    { role: 'user', content: 'hello' },
];
const bodyStr = usepod.formatRequest('some-model', 1024, 'sys', sampleInput, []);
const body = JSON.parse(bodyStr);
assertEq('body has exactly model + stream + max_tokens + messages', Object.keys(body).sort(), ['max_tokens', 'messages', 'model', 'stream']);
assertEq('model is what was passed in', body.model, 'some-model');
assertEq('stream is true', body.stream, true);
assertEq('max_tokens is what was passed in', body.max_tokens, 1024);
assertEq('messages prepends system then spreads input', body.messages, [
    { role: 'system', content: 'sys' },
    { role: 'user', content: 'hello' },
]);
assertOk('body has NO provider routing field', !('provider' in body));
assertOk('body has NO cache_control field', !('cache_control' in body));
assertOk('body has NO transforms field', !('transforms' in body));
assertOk('body has NO route field', !('route' in body));

// With tools
const bodyToolsStr = usepod.formatRequest('m', 100, 'sys', [], [{ type: 'function', function: { name: 'foo' } }]);
const bodyTools = JSON.parse(bodyToolsStr);
assertEq('body with tools includes tools array', bodyTools.tools, [{ type: 'function', function: { name: 'foo' } }]);

// Without tools → no tools key (omitted, not null)
const bodyNoToolsStr = usepod.formatRequest('m', 100, 'sys', [], []);
const bodyNoTools = JSON.parse(bodyNoToolsStr);
assertOk('body without tools omits tools key', !('tools' in bodyNoTools));

// ─── classifyError ──────────────────────────────────────────────────────────

console.log('── classifyError 402 unfunded vs no_provider_at_price ──');

const e402Unfunded = usepod.classifyError(402, { error: { type: 'insufficient_balance', message: 'fund it' } });
assertEq('402 generic → type=unfunded', e402Unfunded.type, 'unfunded');
assertOk('402 unfunded message mentions usepod.ai/dashboard', /usepod\.ai\/dashboard/.test(e402Unfunded.userMessage));

const e402Ceiling = usepod.classifyError(402, {
    error: {
        type: 'no_provider_at_price',
        message: 'too cheap',
        details: { suggested_min_input_per_1m: 500000, suggested_min_output_per_1m: 800000 },
    },
});
assertEq('402 no_provider_at_price → type=price_ceiling', e402Ceiling.type, 'price_ceiling');
assertOk('price_ceiling message mentions ceiling', /price ceiling/i.test(e402Ceiling.userMessage));
assertOk('price_ceiling interpolates suggested minimums', /500000.*800000/.test(e402Ceiling.userMessage));

console.log('── classifyError 401 invalid-format vs not-found-or-not-activated ──');

const e401Format = usepod.classifyError(401, { error: { type: 'unauthorized', message: 'unauthorized: invalid token format' } });
assertEq('401 invalid token format → type=auth', e401Format.type, 'auth');
assertOk('401 invalid-format message says "Invalid Usepod token format"', /invalid usepod token format/i.test(e401Format.userMessage));

const e401NotFound = usepod.classifyError(401, { error: { type: 'unauthorized', message: 'unauthorized: token not found or not activated' } });
assertEq('401 not found or not activated → type=auth_or_unfunded', e401NotFound.type, 'auth_or_unfunded');
assertOk('401 not-found message mentions "unfunded or unknown"', /unfunded or unknown/i.test(e401NotFound.userMessage));

const e401Other = usepod.classifyError(401, { error: { type: 'unauthorized', message: 'something else' } });
assertEq('401 other → type=auth', e401Other.type, 'auth');
assertOk('401 other message says "Invalid Usepod token"', /invalid usepod token/i.test(e401Other.userMessage));

console.log('── classifyError messages never leak "OpenRouter" branding ──');

for (const [label, status, data] of [
    ['402 unfunded', 402, {}],
    ['402 ceiling', 402, { error: { type: 'no_provider_at_price' } }],
    ['401 format', 401, { error: { message: 'unauthorized: invalid token format' } }],
    ['401 not-found', 401, { error: { message: 'unauthorized: token not found or not activated' } }],
    ['429', 429, {}],
    ['500', 500, {}],
    ['418', 418, { error: { message: 'teapot' } }],
]) {
    const r = usepod.classifyError(status, data);
    assertOk(
        `classifyError(${label}) does not leak "OpenRouter"`,
        !/OpenRouter|openrouter/.test(r.userMessage || ''),
        r.userMessage,
    );
}

// ─── parseRateLimitHeaders: X-Balance-Remaining parsed if present ───────────

console.log('── parseRateLimitHeaders ──');

const rNo = usepod.parseRateLimitHeaders(null);
assertEq('parseRateLimitHeaders(null) → infinity remaining', rNo.tokensRemaining, Infinity);

const rWithBalance = usepod.parseRateLimitHeaders({ 'x-balance-remaining': '5000000' });
assertOk('parseRateLimitHeaders with X-Balance-Remaining returns infinity (no rate-limit semantics)', rWithBalance.tokensRemaining === Infinity);

// ─── Module surface ─────────────────────────────────────────────────────────

console.log('── Module surface: delegate is openrouter, not own re-implementation ──');

assertOk('toApiMessages is delegated to openrouter (same function ref)', usepod.toApiMessages === openrouter.toApiMessages);
assertOk('fromApiResponse is delegated to openrouter', usepod.fromApiResponse === openrouter.fromApiResponse);
assertOk('formatSystemPrompt is delegated to openrouter', usepod.formatSystemPrompt === openrouter.formatSystemPrompt);
assertOk('formatTools is delegated to openrouter', usepod.formatTools === openrouter.formatTools);
assertOk('formatVision is delegated to openrouter', usepod.formatVision === openrouter.formatVision);
assertOk('normalizeUsage is delegated to openrouter', usepod.normalizeUsage === openrouter.normalizeUsage);
assertOk('classifyNetworkError is delegated to openrouter', usepod.classifyNetworkError === openrouter.classifyNetworkError);

assertOk('buildHeaders is OWN (not openrouter.buildHeaders)', usepod.buildHeaders !== openrouter.buildHeaders);
assertOk('formatRequest is OWN', usepod.formatRequest !== openrouter.formatRequest);
assertOk('classifyError is OWN', usepod.classifyError !== openrouter.classifyError);
assertOk('parseRateLimitHeaders is OWN', usepod.parseRateLimitHeaders !== openrouter.parseRateLimitHeaders);

assertEq('streamProtocol is chat-completions', usepod.streamProtocol, 'chat-completions');
assertEq('supportsCache is false', usepod.supportsCache, false);
assertEq('authTypes is [api_key]', usepod.authTypes, ['api_key']);
assertEq('id is usepod', usepod.id, 'usepod');

console.log('');
if (failures > 0) {
    console.log(`FAIL: ${failures} test(s) failed.`);
    process.exit(1);
} else {
    console.log('PASS: all usepod adapter contract tests passed.');
    process.exit(0);
}
