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
const _bridgeCalls = [];
const _bridgeStub = {
    androidBridgeCall: (endpoint, data) => {
        _bridgeCalls.push({ endpoint, data });
        return Promise.resolve(_bridgeResult);
    },
};

// Load providers/xai.js fresh with a mocked config for the given auth scenario.
function loadXai({ authType = 'api_key', oauthToken = '', refresh = '', apiKey = '' } = {}) {
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
function installHttpsMock({ statusCode = 200, body = {}, delayMs = 0 } = {}) {
    https.request = function (opts, cb) {
        _httpsCallCount++;
        const res = new EventEmitter();
        res.statusCode = statusCode;
        // Fire on a later tick so the caller has attached res.on(...) (inside cb)
        // and req.on(...)/write/end before any data flows.
        setTimeout(() => {
            cb(res);
            res.emit('data', JSON.stringify(body));
            res.emit('end');
        }, delayMs);
        const req = new EventEmitter();
        req.write = () => {};
        req.end = () => {};
        req.destroy = () => {};
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
    ok('single-flight: bridge persist called exactly once', _bridgeCalls.length === 1, `calls=${_bridgeCalls.length}`);

    // H2: the persist was AWAITED and got the rotated access token.
    ok('await-persist: bridge received the ROTATED access token', _bridgeCalls[0] && _bridgeCalls[0].data.accessToken === 'eyJnew.acc.tok');
    ok('await-persist: hit the /xai/oauth/save-tokens endpoint', _bridgeCalls[0] && _bridgeCalls[0].endpoint === '/xai/oauth/save-tokens', _bridgeCalls[0] && _bridgeCalls[0].endpoint);

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

async function testPersistFailurePropagates() {
    console.log('\n── refreshOAuthToken: persist-failure propagates a HARD error (H2) ──');

    _httpsCallCount = 0;
    _bridgeCalls.length = 0;
    _registeredSecrets.length = 0;
    _bridgeResult = { error: 'disk full', code: 'XAI_OAUTH_SAVE_FAILED' };
    installHttpsMock({
        statusCode: 200,
        body: { access_token: 'eyJx.y.z', refresh_token: 'r2', expires_in: 21600 },
    });

    const xai = loadXai({ authType: 'oauth', oauthToken: 'eyJa.b.c', refresh: 'r1' });
    let threw = false;
    let err = null;
    try {
        await xai.refreshOAuthToken();
    } catch (e) {
        threw = true;
        err = e;
    }
    ok('H2: an UNPERSISTED rotation rejects — never resolves true', threw === true);
    ok('H2: the propagated error is flagged persistFailed', !!err && err.persistFailed === true, err && err.message);
    // Bounded retry: the bridge was tried more than once before failing.
    ok('H2: bridge persist was retried (bounded) before surfacing', _bridgeCalls.length >= 2, `calls=${_bridgeCalls.length}`);
    // The rotated tokens were still registered (redaction covers the leaked-but-unpersisted case).
    ok('H2: rotated tokens still registered for redaction even on persist failure', _registeredSecrets.includes('eyJx.y.z'));

    restoreHttps();
}

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

// ── Runner ───────────────────────────────────────────────────────────────────

(async function run() {
    try {
        await testRefreshSingleFlightAndPersist();
        await testPersistFailurePropagates();
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
