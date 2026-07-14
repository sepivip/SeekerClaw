#!/usr/bin/env node
// xai.test.js — BAT-1124 xAI Grok provider adapter unit tests.
//
// Run:  node tests/nodejs-project/xai.test.js
// Exit: 0 = all pass, 1 = at least one failure.
//
// WHY THIS FILE EXISTS
// --------------------
// providers/xai.js clones the OpenAI OAuth pattern but DIVERGES from it on the
// security-critical bits flagged in the BAT-1124 Stage-2 review (§11b). Cloning
// openai.js verbatim would have shipped account-locking / secret-leaking bugs.
// These tests pin every must-fix so a future "just make it like openai" refactor
// can't regress them:
//   C1 — 403 is NEVER type:'auth' (else ai.js fires a refresh and burns xAI's
//        single-use refresh rotation); 403 retry is bounded to ONE then terminal.
//   H1 — the rotated access+refresh tokens are registered with the redactor.
//   H2 — refreshOAuthToken is single-flight AND awaits persist; a persist
//        failure propagates a HARD error (never a silent resolve(true)).
//   H3 — ai.js getProviderApiKey resolves xai → XAI_KEY, never ANTHROPIC_KEY.
//   H4 — both auth flavors carry a SeekerClaw User-Agent.
//   L3 — the public client_id matches the expected literal.
//
// The provider module captures `isOAuth` / token constants at load time from
// config.js, so the harness mocks config.js (+ bridge.js + security.js) in the
// require cache and reloads xai.js fresh for each auth scenario — the same
// require-cache-injection pattern claude-adaptive-thinking.test.js uses.

'use strict';

const path = require('path');
const https = require('https');
const fs = require('fs');
const { EventEmitter } = require('events');

const BUNDLE = path.resolve(__dirname, '../../app/src/main/assets/nodejs-project');
const configPath = path.join(BUNDLE, 'config.js');
const bridgePath = path.join(BUNDLE, 'bridge.js');
const securityPath = path.join(BUNDLE, 'security.js');
const openrouterPath = path.join(BUNDLE, 'providers', 'openrouter.js');
const reasoningGatingPath = path.join(BUNDLE, 'reasoning-gating.js');
const xaiPath = path.join(BUNDLE, 'providers', 'xai.js');

let failures = 0;
function ok(label, cond, hint = '') {
    if (cond) { console.log('PASS: ' + label); }
    else { console.log('FAIL: ' + label + (hint ? ' — ' + hint : '')); failures++; }
}

// ── Shared test doubles ──────────────────────────────────────────────────────

// H1 spy: everything xai.js registers with the redactor lands here.
const _registeredSecrets = [];
const _securityStub = {
    registerRedactedSecret: (s) => { _registeredSecrets.push(s); },
};

// Configurable bridge stub (the real androidBridgeCall ALWAYS resolves — it
// resolves { error } on failure and { success: true } on a persisted write).
let _bridgeResult = { success: true };
// BAT-1155 stop-fence: the pre-POST rotation gate. Defaults to Ok so refresh tests that only care
// about the persist/mark path are unaffected; a gate test overrides it to Fenced/Dead/Unsafe/Conflict.
let _prepareRefreshResult = { success: true };
const _bridgeCalls = [];
const _bridgeStub = {
    androidBridgeCall: (endpoint, data) => {
        _bridgeCalls.push({ endpoint, data });
        if (endpoint === '/xai/oauth/prepare-refresh') return Promise.resolve(_prepareRefreshResult);
        if (endpoint === '/xai/oauth/clear-rotation-in-flight') return Promise.resolve({ success: true });
        return Promise.resolve(_bridgeResult);
    },
};

// Load providers/xai.js fresh with a mocked config for the given auth scenario.
function loadXai({ authType = 'api_key', oauthToken = '', refresh = '', apiKey = '', expiresAt = '' } = {}) {
    for (const p of [configPath, bridgePath, securityPath, openrouterPath, reasoningGatingPath, xaiPath]) {
        delete require.cache[p];
    }
    require.cache[configPath] = {
        id: configPath, filename: configPath, loaded: true,
        exports: {
            log: () => {},
            XAI_KEY: apiKey,
            XAI_OAUTH_TOKEN: oauthToken,
            XAI_OAUTH_REFRESH: refresh,
            // BAT-1143: seed the persisted expiry so _currentExpiresAtMs is non-zero
            // when a test wants a "known expiry" (blank → 0 = expiry-unknown, D5).
            XAI_OAUTH_EXPIRES_AT: expiresAt,
            AUTH_TYPE: authType,
            // openrouter.js (xai delegates message-shaping to it) reads this:
            OPENROUTER_FALLBACK_MODEL: '',
        },
    };
    require.cache[bridgePath] = {
        id: bridgePath, filename: bridgePath, loaded: true, exports: _bridgeStub,
    };
    require.cache[securityPath] = {
        id: securityPath, filename: securityPath, loaded: true, exports: _securityStub,
    };
    return require(xaiPath);
}

// Monkeypatch the real https module (xai.js does `require('https').request`).
let _httpsCallCount = 0;
const _origHttpsRequest = https.request;
// `reqError` (a coded Error-like, e.g. { code:'ECONNREFUSED' }) or `reqTimeout:true` emulate a
// TRANSPORT-layer failure with NO HTTP response — the path that reaches _performRefresh's catch and
// the marker-clear discipline (BAT-1155 M3). Otherwise a normal `statusCode`/`body` response fires.
function installHttpsMock({ statusCode = 200, body = {}, delayMs = 0, reqError = null, reqTimeout = false } = {}) {
    https.request = function (opts, cb) {
        _httpsCallCount++;
        const req = new EventEmitter();
        req.write = () => {};
        req.end = () => {};
        req.destroy = () => {};
        if (reqError || reqTimeout) {
            // Transport failure: emit on `req` (after _requestRotatedTokens attaches its
            // 'error'/'timeout' handlers) — cb(res) is NEVER called, mirroring a real socket error.
            setTimeout(() => {
                if (reqTimeout) req.emit('timeout');
                else req.emit('error', reqError);
            }, delayMs);
            return req;
        }
        const res = new EventEmitter();
        res.statusCode = statusCode;
        // Fire on a later tick so the caller has attached res.on(...) (inside cb)
        // and req.on(...)/write/end before any data flows.
        setTimeout(() => {
            cb(res);
            res.emit('data', JSON.stringify(body));
            res.emit('end');
        }, delayMs);
        return req;
    };
}
function restoreHttps() { https.request = _origHttpsRequest; }

// ── buildHeaders (H4 + api_key vs oauth token selection) ─────────────────────

(function testBuildHeaders() {
    console.log('── buildHeaders: api_key vs oauth ──');

    const xaiApi = loadXai({ authType: 'api_key', apiKey: 'xai-secret-key' });
    ok('api_key: isOAuth is false', xaiApi.isOAuth === false);
    const h1 = xaiApi.buildHeaders('xai-secret-key');
    ok('api_key: Authorization Bearer uses XAI_KEY (never ANTHROPIC_KEY)', h1.Authorization === 'Bearer xai-secret-key', h1.Authorization);
    ok('api_key: carries a SeekerClaw User-Agent (H4)',
        typeof h1['User-Agent'] === 'string' && h1['User-Agent'].startsWith('SeekerClaw'), h1['User-Agent']);

    const xaiOauth = loadXai({ authType: 'oauth', oauthToken: 'eyJoauth.tok.sig', refresh: 'rft' });
    ok('oauth: isOAuth is true', xaiOauth.isOAuth === true);
    const h2 = xaiOauth.buildHeaders('SHOULD-BE-IGNORED');
    ok('oauth: Authorization Bearer uses the OAuth token (ignores apiKey arg)', h2.Authorization === 'Bearer eyJoauth.tok.sig', h2.Authorization);
    ok('oauth: carries a SeekerClaw User-Agent (H4)',
        typeof h2['User-Agent'] === 'string' && h2['User-Agent'].startsWith('SeekerClaw'), h2['User-Agent']);
})();

// ── client_id constant (L3) ──────────────────────────────────────────────────

(function testClientId() {
    console.log('\n── client_id constant (L3) ──');
    const xai = loadXai({ authType: 'oauth', oauthToken: 'a.b.c', refresh: 'r' });
    ok('OAUTH_CLIENT_ID equals the expected Grok public client_id',
        xai.OAUTH_CLIENT_ID === 'b1a00492-073a-47ea-816f-4c329264a828', xai.OAUTH_CLIENT_ID);
})();

// ── XAI_BASE_URL: protocol + host + port override (self-hosted gateway) ──────

(function testBaseUrlOverride() {
    console.log('\n── XAI_BASE_URL: protocol + host + port override ──');
    // The endpoint is resolved at module load from process.env.XAI_BASE_URL, so
    // set it BEFORE loadXai() re-requires the module. Copilot (PR #434): parsing
    // only the hostname silently dropped protocol/port, breaking the "self-hosted
    // gateway" use case the code comment claims to support — ai.js/http.js plumb
    // all three (http.js picks http vs https from endpoint.protocol).
    const prev = process.env.XAI_BASE_URL;
    try {
        delete process.env.XAI_BASE_URL;
        const def = loadXai({ authType: 'api_key', apiKey: 'xai-k' });
        ok('default endpoint hostname → api.x.ai', def.endpoint.hostname === 'api.x.ai', def.endpoint.hostname);
        ok('default endpoint protocol → https:', def.endpoint.protocol === 'https:', def.endpoint.protocol);
        ok('default endpoint port → undefined (http.js uses 443)', def.endpoint.port === undefined, String(def.endpoint.port));

        process.env.XAI_BASE_URL = 'http://192.168.1.5:8080';
        const gw = loadXai({ authType: 'api_key', apiKey: 'xai-k' });
        ok('override protocol → http: (so http.js uses http, not https)', gw.endpoint.protocol === 'http:', gw.endpoint.protocol);
        ok('override hostname → 192.168.1.5', gw.endpoint.hostname === '192.168.1.5', gw.endpoint.hostname);
        ok('override port → 8080 (number, not dropped)', gw.endpoint.port === 8080, String(gw.endpoint.port));

        process.env.XAI_BASE_URL = 'gateway.internal'; // bare host, no scheme
        const bare = loadXai({ authType: 'api_key', apiKey: 'xai-k' });
        ok('bare host defaults protocol → https:', bare.endpoint.protocol === 'https:', bare.endpoint.protocol);
        ok('bare host parsed → gateway.internal', bare.endpoint.hostname === 'gateway.internal', bare.endpoint.hostname);
        ok('bare host port → undefined (→443)', bare.endpoint.port === undefined, String(bare.endpoint.port));

        process.env.XAI_BASE_URL = 'not a url ::::';
        const bad = loadXai({ authType: 'api_key', apiKey: 'xai-k' });
        ok('malformed override falls back to api.x.ai https (never throws at load)',
            bad.endpoint.hostname === 'api.x.ai' && bad.endpoint.protocol === 'https:', `${bad.endpoint.protocol}//${bad.endpoint.hostname}`);
    } finally {
        if (prev === undefined) delete process.env.XAI_BASE_URL; else process.env.XAI_BASE_URL = prev;
    }
})();

// ── formatRequest: reasoning_effort bounding (BAT-1124 grok-4.5 fix) ──────────
// THE bug this pins: xAI honors the OpenAI-style `reasoning_effort` STRING, NOT
// OpenRouter's `reasoning:{effort}` object. Sending neither leaves grok-4.5's
// reasoning UNBOUNDED → >60s silent reasoning on big agent requests → the app's
// socket-idle timeout fires (grok-4.3 tolerates it, grok-4.5 doesn't). Proven
// live in tests/live/xai `--diagnose`. This pins the request shape so a
// refactor can't silently drop the param and reintroduce the hang.
(function testFormatRequestReasoning() {
    console.log('\n── formatRequest: reasoning_effort bounding (grok-4.5 fix) ──');
    const xai = loadXai({ authType: 'oauth', oauthToken: 'a.b.c', refresh: 'r' });
    const parse = (opts) => JSON.parse(xai.formatRequest('grok-4.5', 4096, 'sys', [{ role: 'user', content: 'hi' }], [], opts));

    const def = parse({});
    ok('formatRequest sends reasoning_effort as a STRING (the param xAI honors)', typeof def.reasoning_effort === 'string', JSON.stringify(def.reasoning_effort));
    ok('does NOT send the ignored OpenRouter reasoning:{effort} object', def.reasoning === undefined);
    ok('default (no toggle) → reasoning_effort:"low" (responsive; bounds grok-4.5)', def.reasoning_effort === 'low', def.reasoning_effort);
    ok('still streams (stream:true)', def.stream === true);

    ok('heartbeat/synthetic (reasoningMode:"off") → "minimal"', parse({ reasoningMode: 'off' }).reasoning_effort === 'minimal');
    ok('user reasoning on a reasoning model (enabled+support:yes) → "high"', parse({ reasoningEnabled: true, reasoningSupport: 'yes' }).reasoning_effort === 'high');
    ok('reasoning toggle on but model support:no → stays bounded "low"', parse({ reasoningEnabled: true, reasoningSupport: 'no' }).reasoning_effort === 'low');
})();

// ── classifyError matrix (C1 is the star) ────────────────────────────────────

(function testClassifyError() {
    console.log('\n── classifyError: 403 (C1), 401, 429/5xx ──');
    const xai = loadXai({ authType: 'oauth', oauthToken: 'a.b.c', refresh: 'r' });
    xai._resetErrorStateForTests();

    // C1: 403 must never be type:'auth' (ai.js gates refresh on type==='auth').
    const e403a = xai.classifyError(403, {});
    ok('403 (1st): type is NOT "auth" — never triggers refresh (C1)', e403a.type !== 'auth', e403a.type);
    ok('403 (1st): retryable once (lazy provisioning grace)', e403a.retryable === true);

    const e403b = xai.classifyError(403, {});
    ok('403 (2nd): type is STILL NOT "auth" (C1)', e403b.type !== 'auth', e403b.type);
    ok('403 (2nd): retryable false — bounded to ONE retry then terminal', e403b.retryable === false);
    ok('403 (2nd): terminal tier-gate userMessage', /subscription tier doesn't include API access — add an xAI API key/.test(e403b.userMessage), e403b.userMessage);

    // A third 403 stays terminal (one-shot flag, not MAX_RETRIES).
    ok('403 (3rd): still terminal, still not auth', xai.classifyError(403, {}).retryable === false && xai.classifyError(403, {}).type !== 'auth');

    // 401 → type:'auth' ONLY when oauth + a refresh token is present.
    const e401 = xai.classifyError(401, {});
    ok('401 (oauth + refresh present): type "auth" + retryable → refresh', e401.type === 'auth' && e401.retryable === true);

    // 429 / 5xx retryable.
    ok('429: retryable (rate limit backoff)', xai.classifyError(429, {}).retryable === true);
    ok('500: retryable (server)', xai.classifyError(500, {}).retryable === true);
    ok('503: retryable (server)', xai.classifyError(503, {}).retryable === true);
    // Non-retryable credential/billing.
    ok('402: billing, not retryable', xai.classifyError(402, {}).retryable === false);

    // 401 WITHOUT a refresh token (oauth) → nothing to refresh → not auth.
    const xaiNoRefresh = loadXai({ authType: 'oauth', oauthToken: 'a.b.c', refresh: '' });
    const e401nr = xaiNoRefresh.classifyError(401, {});
    ok('401 (oauth, NO refresh): NOT auth + not retryable', e401nr.type !== 'auth' && e401nr.retryable === false);

    // 401 in api_key mode → not auth (there is no OAuth refresh to attempt).
    const xaiApi = loadXai({ authType: 'api_key', apiKey: 'xai-k' });
    const e401ak = xaiApi.classifyError(401, {});
    ok('401 (api_key): NOT auth + not retryable', e401ak.type !== 'auth' && e401ak.retryable === false);

    // 403 in api_key mode is a REAL tier/credit gate — terminal on the FIRST hit.
    // The provisioning retry-once grace is OAuth-only (Copilot review, PR #434); an
    // api_key user must not get a wasted retry or a misleading "provisioning" message.
    const eak403 = xaiApi.classifyError(403, {});
    ok('403 (api_key, 1st): NOT retryable — terminal immediately (no OAuth grace)', eak403.retryable === false, `retryable=${eak403.retryable}`);
    ok('403 (api_key, 1st): still NOT "auth" (C1 holds in api_key mode too)', eak403.type !== 'auth', eak403.type);
    ok('403 (api_key, 1st): api_key tier-gate copy, NOT "provisioning — retrying"',
        /API key doesn't have access to this model or endpoint/.test(eak403.userMessage)
        && !/provisioning — retrying/.test(eak403.userMessage), eak403.userMessage);
    ok('403 (api_key, 2nd): stays terminal', xaiApi.classifyError(403, {}).retryable === false);
})();

// ── refreshOAuthToken: single-flight + await-persist + H1 registration ───────

async function testRefreshSingleFlightAndPersist() {
    console.log('\n── refreshOAuthToken: single-flight + await-persist (H1/H2) ──');

    _httpsCallCount = 0;
    _bridgeCalls.length = 0;
    _registeredSecrets.length = 0;
    _bridgeResult = { success: true };
    installHttpsMock({
        statusCode: 200,
        body: { access_token: 'eyJnew.acc.tok', refresh_token: 'new-refresh-tok', expires_in: 21600 },
        delayMs: 15, // keep the first refresh in-flight while the 2nd call arrives
    });

    const xai = loadXai({ authType: 'oauth', oauthToken: 'eyJold.acc.tok', refresh: 'old-refresh' });
    const p1 = xai.refreshOAuthToken();
    const p2 = xai.refreshOAuthToken();
    ok('single-flight: concurrent calls share ONE in-flight promise (H2)', p1 === p2);

    await Promise.all([p1, p2]);
    ok('single-flight: auth.x.ai token POST fired exactly once', _httpsCallCount === 1, `count=${_httpsCallCount}`);
    // BAT-1155: a refresh now first hits /xai/oauth/prepare-refresh (the pre-POST rotation gate),
    // then /xai/oauth/save-tokens (the persist). Filter to the persist to pin single-flight.
    const persistCalls = _bridgeCalls.filter(c => c.endpoint.includes('save-tokens'));
    ok('single-flight: bridge persist called exactly once', persistCalls.length === 1, `persistCalls=${persistCalls.length}`);
    ok('single-flight: exactly one prepare-refresh gate call',
        _bridgeCalls.filter(c => c.endpoint === '/xai/oauth/prepare-refresh').length === 1);

    // H2: the persist was AWAITED and got the rotated access token.
    ok('await-persist: bridge received the ROTATED access token', persistCalls[0] && persistCalls[0].data.accessToken === 'eyJnew.acc.tok');
    ok('await-persist: hit the /xai/oauth/save-tokens endpoint', persistCalls[0] && persistCalls[0].endpoint === '/xai/oauth/save-tokens', persistCalls[0] && persistCalls[0].endpoint);

    // H1: both rotated tokens registered with the redactor.
    ok('H1: rotated ACCESS token registered for redaction', _registeredSecrets.includes('eyJnew.acc.tok'));
    ok('H1: rotated REFRESH token registered for redaction', _registeredSecrets.includes('new-refresh-tok'));

    // A subsequent refresh works again (the in-flight guard cleared on settle).
    _httpsCallCount = 0;
    _bridgeCalls.length = 0;
    await xai.refreshOAuthToken();
    ok('in-flight guard clears after settle (a later refresh runs again)', _httpsCallCount === 1);

    restoreHttps();
}

// BAT-1143 D3/D3a: a successful refresh advances expiry + monotonic anchor +
// generation SYNCHRONOUSLY (the anti-refresh-storm ordering).
async function testRefreshMintStateD3() {
    console.log('\n── D3/D3a: refresh advances expiry + mono anchor + generation ──');
    _httpsCallCount = 0; _bridgeCalls.length = 0; _bridgeResult = { success: true };
    installHttpsMock({ statusCode: 200, body: { access_token: 'a.b.c', refresh_token: 'r', expires_in: 21600 } });
    const xai = loadXai({ authType: 'oauth', oauthToken: 'old', refresh: 'r0', expiresAt: '' });
    xai._resetErrorStateForTests();
    const before = xai._getStateForTests();
    ok('D3: expiry starts unknown (0) with a blank persisted expiry', before.expiresAtMs === 0);
    ok('D3a: mono anchor invalid before any in-process mint', before.mintedMonoValid === false);
    await xai.refreshOAuthToken();
    const after = xai._getStateForTests();
    ok('D3: _currentExpiresAtMs advanced to a FUTURE absolute time', after.expiresAtMs > Date.now(), `expiresAtMs=${after.expiresAtMs}`);
    ok('D3a: mono anchor valid after an in-process mint', after.mintedMonoValid === true);
    ok('D3a: ttl recorded (21600s)', after.ttlMs === 21600 * 1000, `ttlMs=${after.ttlMs}`);
    ok('D8: refresh generation bumped', after.refreshGeneration === before.refreshGeneration + 1, `gen ${before.refreshGeneration}→${after.refreshGeneration}`);
    ok('D8: currentRefreshGeneration() getter exposes the bump (ai.js snapshots it)', xai.currentRefreshGeneration() === after.refreshGeneration, `getter=${xai.currentRefreshGeneration()}`);
    restoreHttps();
}

// BAT-1143 D9: persist-failure is AVAILABILITY-FIRST (the old H2 hard-error is
// replaced). Includes Codex's required "first persist fails → later same-pair
// persist succeeds → no second rotation" case.
async function testPersistFailureAvailabilityFirst() {
    console.log('\n── D9: persist-failure availability-first (in-memory pair + bounded re-persist) ──');

    _httpsCallCount = 0;
    _bridgeCalls.length = 0;
    _registeredSecrets.length = 0;
    _bridgeResult = { error: 'disk full', code: 'XAI_OAUTH_SAVE_FAILED' };
    installHttpsMock({ statusCode: 200, body: { access_token: 'eyJx.y.z', refresh_token: 'r2', expires_in: 21600 } });

    const xai = loadXai({ authType: 'oauth', oauthToken: 'eyJa.b.c', refresh: 'r1' });
    xai._resetErrorStateForTests();

    // The rotation succeeds server-side but the persist fails. D9: the refresh
    // RESOLVES true (the turn continues on the valid in-memory token) — no throw.
    let resolved = false, threw = false;
    try { resolved = (await xai.refreshOAuthToken()) === true; } catch (_) { threw = true; }
    ok('D9: an unpersisted rotation RESOLVES true (availability-first, no hard throw)', resolved === true && threw === false);
    ok('D9: state is _persistPending after the failed persist', xai.isPersistPending() === true);
    ok('D9: the rotated bearer is live in memory for THIS turn', xai.buildHeaders('x').Authorization === 'Bearer eyJx.y.z');
    ok('D9: rotated tokens still registered for redaction', _registeredSecrets.includes('eyJx.y.z'));

    // Codex-required: first persist fails → later SAME-pair persist succeeds → NO
    // second refresh POST → recovery only afterward.
    const httpsAfterRotation = _httpsCallCount;
    const bridgeAfterRotation = _bridgeCalls.length;
    _bridgeResult = { success: true }; // disk recovers
    await xai.ensureFreshToken();       // D9 step 1: re-persist the SAME pair FIRST (not a refresh)
    ok('D9: re-persist cleared the pending state', xai.isPersistPending() === false);
    ok('D9: NO second token rotation (auth.x.ai POST count unchanged)', _httpsCallCount === httpsAfterRotation, `https=${_httpsCallCount}`);
    ok('D9: the re-persist reused the SAME rotated pair', _bridgeCalls[_bridgeCalls.length - 1].data.accessToken === 'eyJx.y.z');
    ok('D9: bridge was called again for the re-persist', _bridgeCalls.length > bridgeAfterRotation, `calls=${_bridgeCalls.length}`);

    restoreHttps();
}

// BAT-1143 D2/D5/D8/D9: the proactive ensureFreshToken() gate.
async function testEnsureFreshTokenGating() {
    console.log('\n── ensureFreshToken: proactive gate (D2/D5) + suppression (D8/D9) ──');

    // api_key → always a no-op.
    _httpsCallCount = 0;
    const xaiApi = loadXai({ authType: 'api_key', apiKey: 'k' });
    await xaiApi.ensureFreshToken();
    ok('api_key: ensureFreshToken is a no-op (no refresh POST)', _httpsCallCount === 0, `https=${_httpsCallCount}`);

    // oauth FRESH token (>5min buffer away) → no refresh.
    _httpsCallCount = 0; _bridgeResult = { success: true };
    installHttpsMock({ statusCode: 200, body: { access_token: 'n.e.w', refresh_token: 'r', expires_in: 21600 } });
    const xaiFresh = loadXai({ authType: 'oauth', oauthToken: 'a.b.c', refresh: 'r0' });
    xaiFresh._resetErrorStateForTests();
    xaiFresh._setStateForTests({ expiresAtMs: Date.now() + 60 * 60 * 1000 });
    await xaiFresh.ensureFreshToken();
    ok('D2: fresh token (>5min buffer) → no proactive refresh', _httpsCallCount === 0, `https=${_httpsCallCount}`);

    // oauth NEAR expiry (inside the 5min buffer) → refresh fires.
    _httpsCallCount = 0;
    const xaiNear = loadXai({ authType: 'oauth', oauthToken: 'a.b.c', refresh: 'r0' });
    xaiNear._resetErrorStateForTests();
    xaiNear._setStateForTests({ expiresAtMs: Date.now() + 60 * 1000 }); // 60s out
    await xaiNear.ensureFreshToken();
    ok('D2: near-expiry (inside 5min buffer) → proactive refresh fires', _httpsCallCount === 1, `https=${_httpsCallCount}`);
    restoreHttps();

    // D5: expiry-unknown (0) → exactly ONE opportunistic refresh (prove at-most-once
    // by making the attempt fail transiently so expiry stays 0).
    _httpsCallCount = 0;
    installHttpsMock({ statusCode: 500, body: {} });
    const xaiUnk = loadXai({ authType: 'oauth', oauthToken: 'a.b.c', refresh: 'r0', expiresAt: '' });
    xaiUnk._resetErrorStateForTests();
    await xaiUnk.ensureFreshToken();
    const firstCount = _httpsCallCount;
    await xaiUnk.ensureFreshToken();
    ok('D5: expiry-unknown → one opportunistic refresh attempt', firstCount === 1, `first=${firstCount}`);
    ok('D5: opportunistic refresh does NOT repeat (at-most-once, no storm)', _httpsCallCount === firstCount, `https=${_httpsCallCount}`);
    restoreHttps();

    // Suppression: _refreshDead and _tierGated both prevent any refresh.
    _httpsCallCount = 0;
    installHttpsMock({ statusCode: 200, body: { access_token: 'x', refresh_token: 'r', expires_in: 21600 } });
    const xaiDead = loadXai({ authType: 'oauth', oauthToken: 'a.b.c', refresh: 'r0' });
    xaiDead._resetErrorStateForTests();
    xaiDead._setStateForTests({ expiresAtMs: Date.now() - 1000, refreshDead: true });
    await xaiDead.ensureFreshToken();
    ok('D9: _refreshDead suppresses proactive refresh (no dead-token hammering)', _httpsCallCount === 0, `https=${_httpsCallCount}`);

    const xaiGated = loadXai({ authType: 'oauth', oauthToken: 'a.b.c', refresh: 'r0' });
    xaiGated._resetErrorStateForTests();
    xaiGated._setStateForTests({ expiresAtMs: Date.now() - 1000, tierGated: true });
    await xaiGated.ensureFreshToken();
    ok('D8: _tierGated suppresses proactive refresh (no rotation churn on a gated account)', _httpsCallCount === 0, `https=${_httpsCallCount}`);
    restoreHttps();
}

// BAT-1143 D3a: monotonic age gate — uninitialized guard + backward-clock immunity.
// Observed through classifyError(403), which shares _isTokenExpiredish() with the
// proactive gate.
function testMonotonicAgeGateD3a() {
    console.log('\n── D3a: monotonic age gate (uninitialized guard + backward-clock immunity) ──');
    const xai = loadXai({ authType: 'oauth', oauthToken: 'a.b.c', refresh: 'r' });

    // (1) mono-invalid + FUTURE absolute expiry → NOT expiredish → 403 is a
    // tier-gate, NOT auth. Guards the _currentMintedAtMs=0 refresh-storm trap.
    xai._resetErrorStateForTests();
    xai._setStateForTests({ expiresAtMs: Date.now() + 60 * 60 * 1000, mintedMonoValid: false });
    ok('D3a: mono-invalid + fresh absolute expiry → 403 NOT auth (no first-request storm)',
        xai.classifyError(403, {}).type !== 'auth');

    // (2) Backward-clock skew: absolute expiry looks FRESH (device clock behind),
    // but the monotonic age says expired → 403 IS refreshable auth — even after the
    // provisioning grace has latched (D7 ordering).
    xai._resetErrorStateForTests();
    const ttlMs = 21600 * 1000;
    xai._setStateForTests({
        expiresAtMs: Date.now() + 60 * 60 * 1000,                       // absolute says fresh
        mintedMonoValid: true,
        ttlMs,
        mintedAtMono: process.hrtime.bigint() - BigInt(ttlMs) * 1000000n, // aged past TTL
        oauth403RetriedOnce: true,
    });
    const e = xai.classifyError(403, {});
    ok('D3a: absolute-fresh but monotonic-aged → 403 IS auth (backward-skew caught)', e.type === 'auth' && e.retryable === true, e.type);
}

// BAT-1143 D7/D8: classifyError(403) expired-backstop ordering + tier-gate honoring.
function testClassifyError403BackstopD7() {
    console.log('\n── D7/D8: classifyError(403) expired-backstop ordering + tier-gate ──');
    const xai = loadXai({ authType: 'oauth', oauthToken: 'a.b.c', refresh: 'r' });

    // Expired token → 'auth', EVEN after _oauth403RetriedOnce latched (the point of D7).
    xai._resetErrorStateForTests();
    xai._setStateForTests({ expiresAtMs: Date.now() - 1000, oauth403RetriedOnce: true });
    const eExp = xai.classifyError(403, {});
    ok('D7: expired 403 → "auth" retryable EVEN after _oauth403RetriedOnce', eExp.type === 'auth' && eExp.retryable === true, eExp.type);

    // Fresh token 403 → terminal tier-gate (C1 preserved), NOT auth.
    xai._resetErrorStateForTests();
    xai._setStateForTests({ expiresAtMs: Date.now() + 60 * 60 * 1000, oauth403RetriedOnce: true });
    const eFresh = xai.classifyError(403, {});
    ok('C1: fresh-token 403 stays terminal tier-gate (not auth)', eFresh.type !== 'auth' && eFresh.retryable === false, eFresh.type);

    // Tier-gated (breaker tripped) → terminal, skips the grace.
    xai._resetErrorStateForTests();
    xai._setStateForTests({ expiresAtMs: Date.now() + 60 * 60 * 1000, tierGated: true });
    const eGated = xai.classifyError(403, {});
    ok('D8: _tierGated 403 is terminal (skips the provisioning grace)', eGated.type !== 'auth' && eGated.retryable === false, eGated.type);
}

// BAT-1143 D8: breaker hooks.
function testD8BreakerHooks() {
    console.log('\n── D8: breaker hooks (markTierGated / noteInferenceSuccess / repairReset) ──');
    const xai = loadXai({ authType: 'oauth', oauthToken: 'a.b.c', refresh: 'r' });
    xai._resetErrorStateForTests();
    ok('breaker starts clear', xai._getStateForTests().tierGated === false);
    xai.markTierGated();
    ok('markTierGated() trips the breaker', xai._getStateForTests().tierGated === true);
    xai.noteInferenceSuccess();
    ok('noteInferenceSuccess() clears the breaker (a 200 = the account can reach the model)', xai._getStateForTests().tierGated === false);
    xai._setStateForTests({ tierGated: true, refreshDead: true, persistPending: true });
    xai.repairReset();
    const s = xai._getStateForTests();
    ok('repairReset() clears tierGated + refreshDead + persistPending', s.tierGated === false && s.refreshDead === false && s.persistPending === false);
}

// BAT-1143 D9: invalid_grant → _refreshDead → suppression + not-auth.
async function testD9DeadToken() {
    console.log('\n── D9: invalid_grant → _refreshDead → suppression + not-auth ──');
    _httpsCallCount = 0; _bridgeResult = { success: true };
    installHttpsMock({ statusCode: 400, body: { error: 'invalid_grant', error_description: 'refresh token revoked' } });
    const xai = loadXai({ authType: 'oauth', oauthToken: 'a.b.c', refresh: 'dead' });
    xai._resetErrorStateForTests();
    xai._setStateForTests({ expiresAtMs: Date.now() - 1000 }); // expired → ensureFreshToken will attempt

    await xai.ensureFreshToken();
    ok('D9: invalid_grant sets _refreshDead', xai._getStateForTests().refreshDead === true);
    const httpsAfter = _httpsCallCount;
    await xai.ensureFreshToken();
    ok('D9: dead-token suppresses further proactive refresh (no 5-min hammering)', _httpsCallCount === httpsAfter, `https=${_httpsCallCount}`);
    ok('D9: dead token → 401 is NOT auth (nothing to refresh)', xai.classifyError(401, {}).type !== 'auth');
    ok('D9/D10: isRefreshDead() getter reflects the dead state (ai.js counts it toward re-pair)', xai.isRefreshDead() === true);
    restoreHttps();
}

// ── BAT-1143 review fixes (Copilot + CodeRabbit + in-house adversarial) ──────

// 429-transient persist + durable convergence that clears pending (Copilot #1,
// CodeRabbit S2).
async function testPersistConvergenceEdges() {
    console.log('\n── review: 429-transient persist + durable convergence unblocks refresh ──');
    // (1) A bridge RATE-LIMIT must NOT count toward the durable-error budget.
    _bridgeResult = { error: 'Rate limit exceeded for /xai/oauth/save-tokens' };
    installHttpsMock({ statusCode: 200, body: { access_token: 'a.b.c', refresh_token: 'r', expires_in: 21600 } });
    let xai = loadXai({ authType: 'oauth', oauthToken: 'o', refresh: 'r0' });
    xai._resetErrorStateForTests();
    await xai.refreshOAuthToken(); // rotates; persist gets a 429
    ok('429: persist stays pending, NOT durable', xai.isPersistPending() === true && xai.hasPersistDurableError() === false);
    for (let i = 0; i < 8; i++) await xai.ensureFreshToken(); // hammer the throttle
    ok('429: repeated throttles never latch the durable error (not counted)', xai.hasPersistDurableError() === false && xai.isPersistPending() === true);
    _bridgeResult = { success: true }; // throttle clears
    await xai.ensureFreshToken();
    ok('429: converges once the throttle clears', xai.isPersistPending() === false);
    restoreHttps();

    // (2) A DURABLE (non-429) failure exhausts the budget → surfaces the durable error,
    // CLEARS pending (unblocks proactive refresh), no infinite bridge hammering.
    _bridgeResult = { error: 'keystore write failed' };
    installHttpsMock({ statusCode: 200, body: { access_token: 'a2.b.c', refresh_token: 'r2', expires_in: 21600 } });
    xai = loadXai({ authType: 'oauth', oauthToken: 'o', refresh: 'r0' });
    xai._resetErrorStateForTests();
    await xai.refreshOAuthToken(); // persist attempt 1 fails
    for (let i = 0; i < 8; i++) await xai.ensureFreshToken(); // drive to MAX
    ok('durable: convergence exhausted latches hasPersistDurableError()', xai.hasPersistDurableError() === true);
    ok('durable: _persistPending CLEARED so proactive refresh is unblocked (no forever-block)', xai.isPersistPending() === false);
    restoreHttps();
}

// B1: reactive handleUnauthorized latches _refreshDead on invalid_grant (Copilot #4 +
// adversarial B1 — the dead-token-hammering fix).
async function testHandleUnauthorizedDeadToken() {
    console.log('\n── B1: reactive handleUnauthorized latches _refreshDead on invalid_grant ──');
    _bridgeResult = { success: true };
    installHttpsMock({ statusCode: 400, body: { error: 'invalid_grant', error_description: 'revoked' } });
    const xai = loadXai({ authType: 'oauth', oauthToken: 'o', refresh: 'dead' });
    xai._resetErrorStateForTests();
    ok('pre: not dead', xai.isRefreshDead() === false);
    let fatal = false;
    try { await xai.handleUnauthorized(); } catch (e) { fatal = (e.retryable === false); }
    ok('B1: handleUnauthorized throws fatal (non-retryable) on invalid_grant', fatal === true);
    ok('B1: reactive path latched _refreshDead (dead token no longer re-POSTed)', xai.isRefreshDead() === true);
    ok('B1: subsequent 401 is NOT auth (dead — classifyError suppresses refresh)', xai.classifyError(401, {}).type !== 'auth');
    restoreHttps();
}

// S1: handleUnauthorized must not rotate AGAIN while a prior rotation is unpersisted
// (adversarial S1 — same-turn double-rotation / orphaned pending pair).
async function testHandleUnauthorizedPersistPending() {
    console.log('\n── S1: handleUnauthorized does not rotate again while persist pending ──');
    _bridgeResult = { error: 'disk full' };
    installHttpsMock({ statusCode: 200, body: { access_token: 't2.a.b', refresh_token: 'r2', expires_in: 21600 } });
    const xai = loadXai({ authType: 'oauth', oauthToken: 'o', refresh: 'r0' });
    xai._resetErrorStateForTests();
    await xai.refreshOAuthToken(); // rotate; persist fails → pending
    ok('setup: persist pending after a failed persist', xai.isPersistPending() === true);
    const httpsBefore = _httpsCallCount;
    _bridgeResult = { success: true }; // re-persist will succeed
    let retry = false;
    try { await xai.handleUnauthorized(); } catch (e) { retry = (e.retryable === true); }
    ok('S1: handleUnauthorized re-persists + signals retry on the current token', retry === true);
    ok('S1: NO second refresh POST (never rotated again while pending)', _httpsCallCount === httpsBefore, `https=${_httpsCallCount}`);
    ok('S1: the pending persist converged', xai.isPersistPending() === false);
    restoreHttps();
}

// D9/Q4: a transport-failure cooldown blocks a same-turn re-POST (CodeRabbit #6 —
// lost-refresh-response protection).
async function testTransportCooldown() {
    console.log('\n── D9/Q4: transport-failure cooldown blocks a same-turn re-POST ──');
    installHttpsMock({ statusCode: 500, body: {} }); // transport/server error (NOT invalid_grant)
    const xai = loadXai({ authType: 'oauth', oauthToken: 'o', refresh: 'r0' });
    xai._resetErrorStateForTests();
    xai._setStateForTests({ expiresAtMs: Date.now() - 1000 }); // expired → will try to refresh
    _httpsCallCount = 0;
    await xai.ensureFreshToken(); // 1 POST → transport fail → cooldown armed
    ok('first ensureFreshToken POSTed once (then failed)', _httpsCallCount === 1, `https=${_httpsCallCount}`);
    ok('cooldown did NOT latch _refreshDead (transport error, not invalid_grant)', xai.isRefreshDead() === false);
    await xai.ensureFreshToken(); // must be blocked by the cooldown
    ok('D9/Q4: second ensureFreshToken does NOT re-POST (cooldown active)', _httpsCallCount === 1, `https=${_httpsCallCount}`);
    let fatal = false;
    try { await xai.handleUnauthorized(); } catch (e) { fatal = (e.retryable === false); }
    ok('D9/Q4: handleUnauthorized is fatal + does NOT re-POST during cooldown', fatal === true && _httpsCallCount === 1, `https=${_httpsCallCount}`);
    restoreHttps();
}

// ── BAT-1143 stage 3/4: ai.js wiring (source-level guards, like H3 above) ─────
// ai.js can't be require()d in isolation (it boots the whole engine), so pin the
// D6/D8/D9/D10 wiring at the source level — the adapter-side behaviour is covered
// by the unit tests above; these prove ai.js actually calls the hooks in order.
(function testAiJsRefreshWiring() {
    console.log('\n── BAT-1143: ai.js wires ensureFreshToken + breaker + D10 accounting ──');
    const aiSrc = fs.readFileSync(path.join(BUNDLE, 'ai.js'), 'utf8');

    // D6: claudeApiCall awaits ensureFreshToken BEFORE buildHeaders.
    const capIdx = aiSrc.indexOf('async function claudeApiCall');
    ok('ai.js declares claudeApiCall (anchor)', capIdx !== -1);
    const capEnsureIdx = capIdx !== -1 ? aiSrc.indexOf('adapter.ensureFreshToken', capIdx) : -1;
    const capBuildIdx = capIdx !== -1 ? aiSrc.indexOf('adapter.buildHeaders(', capIdx) : -1;
    ok('D6: claudeApiCall awaits ensureFreshToken BEFORE its first buildHeaders',
        capEnsureIdx !== -1 && capBuildIdx !== -1 && capEnsureIdx < capBuildIdx, `ensure=${capEnsureIdx} build=${capBuildIdx}`);
    ok('D6: the ensureFreshToken call is awaited', /await adapter\.ensureFreshToken\(\)/.test(aiSrc));

    // D6: the standalone summarizer also refreshes before ITS buildHeaders.
    const sumIdx = aiSrc.indexOf('async function summarizeOldMessages');
    ok('ai.js declares summarizeOldMessages (anchor)', sumIdx !== -1);
    const sumEnsureIdx = sumIdx !== -1 ? aiSrc.indexOf('adapter.ensureFreshToken', sumIdx) : -1;
    const sumBuildIdx = sumIdx !== -1 ? aiSrc.indexOf('adapter.buildHeaders(', sumIdx) : -1;
    ok('D6: summarizeOldMessages awaits ensureFreshToken BEFORE its buildHeaders',
        sumEnsureIdx !== -1 && sumBuildIdx !== -1 && sumEnsureIdx < sumBuildIdx, `ensure=${sumEnsureIdx} build=${sumBuildIdx}`);

    // D8: breaker tripped on a post-refresh 403, cleared on 200.
    ok('D8: ai.js trips markTierGated() on a post-refresh 403 (refreshedThisCall marker)',
        /adapter\.markTierGated\(\)/.test(aiSrc) && /refreshedThisCall = true/.test(aiSrc));
    // The marker must cover the PRIMARY proactive path too: snapshot the refresh
    // generation around ensureFreshToken so a proactive-refresh-then-403 also trips
    // the breaker (else a gated account re-rotates every ~6h forever).
    ok('D8: ai.js snapshots currentRefreshGeneration around the proactive refresh',
        /currentRefreshGeneration\(\)/.test(aiSrc) && /_genBeforeRefresh/.test(aiSrc));
    ok('D8: ai.js clears the breaker via noteInferenceSuccess() on 200', /adapter\.noteInferenceSuccess\(\)/.test(aiSrc));

    // D9: degraded health while a rotated pair is persist-pending.
    ok('D9: ai.js reflects isPersistPending() as degraded health', /adapter\.isPersistPending\(\)/.test(aiSrc) && /'degraded'/.test(aiSrc));

    // D10: the session-expiry counter increment is gated on !isFreshTierGate, NOT the
    // old raw (res.status === 401 || res.status === 403). Pin the fix at the increment.
    const incIdx = aiSrc.indexOf('_consecutiveAuthFailures++');
    ok('ai.js still increments _consecutiveAuthFailures (anchor)', incIdx !== -1);
    const gateRegion = incIdx !== -1 ? aiSrc.slice(Math.max(0, incIdx - 240), incIdx) : '';
    ok('D10: the increment is gated on !isFreshTierGate (tier-gate no longer forces re-pair)',
        /!isFreshTierGate/.test(gateRegion), gateRegion.slice(-90));
    ok('D10: isFreshTierGate uses errClass.type provisioning + adapter.isRefreshDead',
        /isFreshTierGate = errClass\.type === 'provisioning' && !refreshDead/.test(aiSrc) && /adapter\.isRefreshDead/.test(aiSrc));
})();

// ── handleUnauthorized wiring (401 → refresh → retry signal) ─────────────────

async function testHandleUnauthorized() {
    console.log('\n── handleUnauthorized: 401 → refresh → retryable signal ──');

    // api_key mode / no refresh → no-op (nothing to refresh).
    const xaiApi = loadXai({ authType: 'api_key', apiKey: 'xai-k' });
    let noop = true;
    try { await xaiApi.handleUnauthorized(); } catch (_) { noop = false; }
    ok('handleUnauthorized is a no-op in api_key mode', noop === true);

    // oauth + refresh → refresh succeeds → throws a retryable signal.
    _httpsCallCount = 0;
    _bridgeCalls.length = 0;
    _bridgeResult = { success: true };
    installHttpsMock({ statusCode: 200, body: { access_token: 'eyJr.o.t', refresh_token: 'r3', expires_in: 21600 } });
    const xai = loadXai({ authType: 'oauth', oauthToken: 'eyJa.b.c', refresh: 'r1' });
    let retrySignalled = false;
    try {
        await xai.handleUnauthorized();
    } catch (e) {
        retrySignalled = e.retryable === true;
    }
    ok('oauth 401: handleUnauthorized throws { retryable:true } after refresh', retrySignalled === true);

    // Stale-bearer fix (ai.js): after the refresh, buildHeaders() must reflect the
    // ROTATED access token — this is exactly what ai.js re-reads to rebuild request
    // headers before the retry. If buildHeaders still returned the old token, the
    // retry would re-send the expired bearer and burn another single-use rotation.
    const hdrAfter = xai.buildHeaders('unused-in-oauth-mode');
    ok('post-refresh buildHeaders carries the ROTATED bearer (enables ai.js header rebuild)',
        hdrAfter.Authorization === 'Bearer eyJr.o.t', hdrAfter.Authorization);
    restoreHttps();
}

// ── H3: ai.js getProviderApiKey resolves xai → XAI_KEY, never ANTHROPIC_KEY ──

(function testGetProviderApiKeySource() {
    console.log('\n── H3: ai.js getProviderApiKey routes xai → XAI_KEY ──');
    // ai.js can't be require()d in isolation (it pulls in channel/telegram/http/
    // providers/bridge and boots the whole engine). getProviderApiKey is also not
    // exported. So this is a source-level regression pin on the exact H3 fix
    // location — if the xai branch or the XAI_KEY import is ever removed, the
    // Anthropic key would be Bearer'd to api.x.ai. buildHeaders(api_key) above
    // covers the downstream Bearer==XAI_KEY behavior.
    const aiSrc = fs.readFileSync(path.join(BUNDLE, 'ai.js'), 'utf8');
    const fnIdx = aiSrc.indexOf('function getProviderApiKey');
    // Guard indexOf === -1 (Copilot): a renamed function must FAIL the anchor assertion,
    // not silently slice(0,-1) the whole file and pass a stale check.
    ok('ai.js still declares getProviderApiKey (H3 anchor present)', fnIdx !== -1);
    const importRegion = fnIdx !== -1 ? aiSrc.slice(0, fnIdx) : '';
    ok('ai.js imports XAI_KEY from config (H3)', /\bXAI_KEY\b/.test(importRegion));
    ok("ai.js getProviderApiKey has the `PROVIDER === 'xai' ? XAI_KEY` branch (H3)",
        /PROVIDER === 'xai'\s*\?\s*XAI_KEY/.test(aiSrc));
})();

// ── ai.js rebuilds request headers after an OAuth 401 refresh (stale-bearer) ──

(function testHeaderRebuildAfterRefresh() {
    console.log('\n── ai.js: retry rebuilds headers after handleUnauthorized ──');
    // ai.js can't be require()d in isolation, so pin the fix at the source level.
    // The 'auth' retry branch MUST rebuild `headers` (via buildHeaders) AFTER
    // awaiting handleUnauthorized — otherwise the retry re-sends the expired bearer
    // and, for xAI (whose only refresh path is this loop), burns a single-use
    // refresh rotation on every attempt. buildHeaders-after-refresh above proves
    // the adapter side; this proves ai.js actually re-reads it.
    const aiSrc = fs.readFileSync(path.join(BUNDLE, 'ai.js'), 'utf8');
    ok('ai.js declares `let headers` (reassignable for the rebuild)', /\blet headers\b/.test(aiSrc));
    const authIdx = aiSrc.indexOf('handleUnauthorized()');
    ok('ai.js still calls handleUnauthorized() in the retry loop', authIdx !== -1);
    // handleUnauthorized SIGNALS a successful refresh by THROWING {retryable:true}
    // (not by returning), so the header rebuild must live AFTER the try/catch —
    // reachable when the throw is caught-and-not-broken. A rebuild INSIDE the try
    // (before the throw) is dead code on the success path (Copilot PR #434 caught
    // exactly this). Pin the structural ordering: the rebuild must come AFTER the
    // `catch`, not between `handleUnauthorized()` and `catch`.
    const catchIdx = authIdx !== -1 ? aiSrc.indexOf('catch', authIdx) : -1;
    const rebuildIdx = authIdx !== -1 ? aiSrc.indexOf('headers = adapter.buildHeaders(', authIdx) : -1;
    ok('ai.js rebuilds headers AFTER the handleUnauthorized try/catch (reachable on the retryable-throw success path)',
        catchIdx !== -1 && rebuildIdx !== -1 && rebuildIdx > catchIdx, `catchIdx=${catchIdx} rebuildIdx=${rebuildIdx}`);
})();

// Codex re-review blocker-2 + major-2: the AUTHORITATIVE diskUnsafe signal + the
// notify-once retry. flushPendingPersist must report diskUnsafe:true for EVERY on-disk-unsafe
// state (not just a pending pair), and a failed notify-once mark must be retained + retried.
async function testDurabilitySignalsAndNotifyRetry() {
    console.log('\n── Codex re-review: diskUnsafe signal + notify-once retry ──');

    // (1) Clean oauth family → diskUnsafe false.
    let xai = loadXai({ authType: 'oauth', oauthToken: 'o', refresh: 'r0' });
    xai._resetErrorStateForTests();
    let r = await xai.flushPendingPersist();
    ok('clean: flushPendingPersist reports diskUnsafe:false', r.diskUnsafe === false && r.pendingPersist === false);

    // (2) Convergence exhausted (T1 discarded, consumed T0 on disk) → diskUnsafe TRUE
    //     even though pendingPersist is false (the previously-hidden brick vector).
    xai._setStateForTests({ persistPending: false, pendingPersistPayload: null, persistDurableError: true });
    r = await xai.flushPendingPersist();
    ok('convergence-exhausted: pendingPersist false but diskUnsafe TRUE', r.pendingPersist === false && r.diskUnsafe === true);

    // (3) Failed dead-family mark (disk still says the revoked family is live) → diskUnsafe TRUE.
    xai._setStateForTests({ persistDurableError: false, markReauthPending: true });
    r = await xai.flushPendingPersist();
    ok('failed dead-mark: diskUnsafe TRUE', r.diskUnsafe === true);

    // (4) api_key family is never disk-unsafe (no rotation hazard).
    const xaiApi = loadXai({ authType: 'api_key', apiKey: 'k' });
    xaiApi._resetErrorStateForTests();
    xaiApi._setStateForTests({ persistDurableError: true, markReauthPending: true });
    r = await xaiApi.flushPendingPersist();
    ok('api_key: diskUnsafe always false (isOAuth-gated)', r.diskUnsafe === false);

    // (5) RESERVE-before-send (Codex re-review): noteReauthNotified() returns whether the dead
    //     epoch was DURABLY reserved. A failed reserve → false (ai.js must NOT send; it retries the
    //     reserve+send later — nothing was sent, so no duplicate) and does NOT set the suppressor.
    //     A successful reserve → true (ai.js sends the ONE notice) and sets the suppressor.
    xai = loadXai({ authType: 'oauth', oauthToken: 'o', refresh: 'r0' });
    xai._resetErrorStateForTests();
    xai._setStateForTests({ refreshDead: true, currentEpoch: 5, reauthNotifiedEpoch: -1 });
    _bridgeResult = { error: 'lock busy' };
    _bridgeCalls.length = 0;
    let reserved = await xai.noteReauthNotified();
    ok('reserve: a FAILED mark returns false (ai.js must NOT send)', reserved === false);
    ok('reserve: a failed mark does NOT set the suppressor (no silent swallow)', xai._getStateForTests().reauthNotifiedEpoch !== 5);
    ok('reserve: still SURFACEable so a later turn retries the reserve+send', xai.shouldSurfaceReauthNotice() === true);
    _bridgeResult = { success: true, epoch: 5 };
    reserved = await xai.noteReauthNotified();
    ok('reserve: a SUCCESSFUL mark returns true (ai.js sends the one notice)', reserved === true);
    ok('reserve: success sets the suppressor → no further autonomous notice for this epoch', xai._getStateForTests().reauthNotifiedEpoch === 5);
    ok('reserve: suppressed after a durable reserve', xai.shouldSurfaceReauthNotice() === false);

    // (6) reserve that CAS-CONFLICTS (a fresh sign-in advanced the epoch) → false (no notice is
    //     due for a superseded family); adopt the new epoch and drop the suppressor.
    xai._setStateForTests({ refreshDead: true, currentEpoch: 5, reauthNotifiedEpoch: -1 });
    _bridgeResult = { code: 'XAI_OAUTH_EPOCH_CONFLICT', currentEpoch: 9 };
    reserved = await xai.noteReauthNotified();
    const st = xai._getStateForTests();
    ok('reserve: a CAS conflict returns false (no notice for a superseded family)', reserved === false);
    ok('reserve: conflict adopts the new epoch + drops the suppressor', st.currentEpoch === 9 && st.reauthNotifiedEpoch === -1);

    // (7) BLOCKER (quiesce) — while quiesced for a controlled Stop, a token ROTATION is refused
    //     (no consumed-T0/mint-T1 pair can form between the durability ack and the kill); it
    //     resumes after unquiesce.
    const quiesce = require(path.join(BUNDLE, 'quiesce.js'));
    xai = loadXai({ authType: 'oauth', oauthToken: 'o', refresh: 'r0' });
    xai._resetErrorStateForTests();
    installHttpsMock({ statusCode: 200, body: { access_token: 'a.b.c', refresh_token: 'r1', expires_in: 21600 } });
    quiesce.quiesce();
    _httpsCallCount = 0;
    await xai.refreshOAuthToken();
    ok('quiesce: refreshOAuthToken does NOT rotate while quiesced (no https POST)', _httpsCallCount === 0);
    quiesce.unquiesce();
    await xai.refreshOAuthToken();
    ok('unquiesce: rotation resumes (one https POST)', _httpsCallCount === 1);
    restoreHttps();
    quiesce.unquiesce(); // leave clean for any later test
}

// ── Runner ───────────────────────────────────────────────────────────────────

// BAT-1155 stop-fence: the pre-POST rotation gate. Every non-Ok prepare-refresh outcome must
// prevent the external token POST (auth.x.ai). Drives the REAL refresh path with a stubbed bridge.
async function testPrepareRefreshGate() {
    console.log('\n── BAT-1155 stop-fence: pre-POST prepare-refresh gate ──');
    const near = () => ({ expiresAtMs: Date.now() + 60 * 1000 }); // inside the 5min buffer → refresh wants to fire
    // Returns the observable OUTCOME of one gated refresh, not just the POST count — so the tests can
    // tell 'skip' (keep the family LIVE: no POST, refreshDead stays false, epoch NOT adopted) apart
    // from 'dead' (surface reconnect: no POST, but refreshDead latched + reauth persisted). Keying on
    // POST-count alone can't distinguish them (M4), and can't catch a Conflict re-adopting the winning
    // epoch (M5) — both would ship a healthy-family-bricking regression green.
    const runRefresh = async (prep) => {
        _httpsCallCount = 0;
        _bridgeResult = { success: true };
        _prepareRefreshResult = prep;
        installHttpsMock({ statusCode: 200, body: { access_token: 'n.e.w', refresh_token: 'r', expires_in: 21600 } });
        const xai = loadXai({ authType: 'oauth', oauthToken: 'a.b.c', refresh: 'r0' });
        xai._resetErrorStateForTests();
        xai._setStateForTests(near());
        const epochBefore = xai._getStateForTests().currentEpoch;
        await xai.ensureFreshToken(); // proactive path swallows a refusal/throw
        restoreHttps();
        const st = xai._getStateForTests();
        return { posts: _httpsCallCount, refreshDead: st.refreshDead, epochBefore, epochAfter: st.currentEpoch };
    };

    // Ok → POST proceeds; success adopts the winning epoch (the positive half of M5's invariant).
    const okRes = await runRefresh({ success: true, epoch: 7 });
    ok('prepare-refresh Ok → the refresh POST proceeds', okRes.posts === 1);
    ok('prepare-refresh Ok → the success branch ADOPTS r.epoch', okRes.epochAfter === 7);

    // Fenced / Conflict → 'skip': NO POST, family stays LIVE (refreshDead false).
    const fenced = await runRefresh({ success: false, fenced: true });
    ok('prepare-refresh Fenced (a stop is in progress) → NO token POST', fenced.posts === 0);
    ok('prepare-refresh Fenced → family stays live (refreshDead NOT latched — skip, not dead)', fenced.refreshDead === false);

    const conflict = await runRefresh({ success: false, code: 'XAI_OAUTH_EPOCH_CONFLICT', currentEpoch: 9 });
    ok('prepare-refresh Conflict (superseded epoch) → NO token POST', conflict.posts === 0);
    ok('prepare-refresh Conflict → family stays live (refreshDead NOT latched)', conflict.refreshDead === false);
    // M5 (Codex break-fix): a Conflict must NOT adopt the winner's epoch (adopting would poison a
    // later mark-reauth/persist onto the freshly-signed-in family, bricking it).
    ok('prepare-refresh Conflict → does NOT adopt r.currentEpoch (epoch unchanged)',
        conflict.epochAfter === conflict.epochBefore, `before=${conflict.epochBefore} after=${conflict.epochAfter}`);

    // Unsafe / Dead → 'dead': NO POST, but the family is surfaced for reconnect (refreshDead latched).
    const unsafe = await runRefresh({ success: false, unsafe: true });
    ok('prepare-refresh Unsafe (rotation already in flight) → NO second token POST', unsafe.posts === 0);
    ok('prepare-refresh Unsafe → surfaces reconnect (refreshDead LATCHED — dead, not skip)', unsafe.refreshDead === true);

    const dead = await runRefresh({ success: false, dead: true });
    ok('prepare-refresh Dead (reauth/tombstone family) → NO token POST', dead.posts === 0);
    ok('prepare-refresh Dead → surfaces reconnect (refreshDead LATCHED)', dead.refreshDead === true);

    // Reset the gate default so later tests are unaffected.
    _prepareRefreshResult = { success: true };
}

// BAT-1155 M3: the rotation-marker CLEAR discipline (Codex decisions #1/#2). After a gate-'ok' POST
// fails, the durable marker is cleared ONLY when the transport PROVES no request bytes reached xAI
// (pre-connection DNS / connection-refused). A timeout, a socket reset, or ANY received HTTP response
// RETAINS the marker (the on-disk refresh token may be consumed) — else a consumed-token replay on the
// next boot revokes the whole family. Drives the REAL _performRefresh catch via an erroring socket.
async function testMarkerClearDiscipline() {
    console.log('\n── BAT-1155 M3: rotation-marker clear discipline (provably-not-sent) ──');
    // Run one refresh whose POST fails per `mockOpts`; report whether a clear-rotation-in-flight
    // bridge call fired (the marker was cleared).
    const clearedAfterFailedPost = async (mockOpts) => {
        _bridgeCalls.length = 0;
        _bridgeResult = { success: true };
        _prepareRefreshResult = { success: true }; // gate arms the marker → the POST proceeds
        installHttpsMock(mockOpts);
        const xai = loadXai({ authType: 'oauth', oauthToken: 'a.b.c', refresh: 'r0' });
        xai._resetErrorStateForTests();
        try { await xai.refreshOAuthToken(); } catch (_) { /* the POST failure rejects — expected */ }
        restoreHttps();
        return _bridgeCalls.some((c) => c.endpoint === '/xai/oauth/clear-rotation-in-flight');
    };

    // Provably-not-sent (pre-connection) → marker CLEARED (avoids a needless reconnect).
    ok('ECONNREFUSED → marker CLEARED (provably not sent)', (await clearedAfterFailedPost({ reqError: { code: 'ECONNREFUSED' } })) === true);
    ok('ENOTFOUND → marker CLEARED (DNS, provably not sent)', (await clearedAfterFailedPost({ reqError: { code: 'ENOTFOUND' } })) === true);
    ok('EAI_AGAIN → marker CLEARED (DNS temp, provably not sent)', (await clearedAfterFailedPost({ reqError: { code: 'EAI_AGAIN' } })) === true);

    // NOT provable (the token MAY be consumed) → marker RETAINED (no clear call).
    ok('timeout → marker RETAINED (token may be consumed)', (await clearedAfterFailedPost({ reqTimeout: true })) === false);
    ok('ECONNRESET (mid-flight reset) → marker RETAINED', (await clearedAfterFailedPost({ reqError: { code: 'ECONNRESET' } })) === false);
    ok('HTTP 500 (a response WAS received) → marker RETAINED', (await clearedAfterFailedPost({ statusCode: 500, body: {} })) === false);
    ok('HTTP 400 invalid_grant (a response WAS received) → marker RETAINED', (await clearedAfterFailedPost({ statusCode: 400, body: { error: 'invalid_grant' } })) === false);

    _prepareRefreshResult = { success: true };
    _bridgeResult = { success: true };
}

(async function run() {
    try {
        await testPrepareRefreshGate();
        await testMarkerClearDiscipline();
        await testDurabilitySignalsAndNotifyRetry();
        await testRefreshSingleFlightAndPersist();
        await testRefreshMintStateD3();
        await testPersistFailureAvailabilityFirst();
        await testEnsureFreshTokenGating();
        testMonotonicAgeGateD3a();
        testClassifyError403BackstopD7();
        testD8BreakerHooks();
        await testD9DeadToken();
        await testPersistConvergenceEdges();
        await testHandleUnauthorizedDeadToken();
        await testHandleUnauthorizedPersistPending();
        await testTransportCooldown();
        await testHandleUnauthorized();
    } catch (e) {
        console.log('FAIL: unexpected exception in async tests — ' + (e && e.stack || e));
        failures++;
    } finally {
        restoreHttps();
    }

    console.log();
    if (failures === 0) {
        console.log('ALL TESTS PASS');
        process.exit(0);
    } else {
        console.log(`${failures} TEST(S) FAILED`);
        process.exit(1);
    }
})();
