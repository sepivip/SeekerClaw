// BAT-1157 (Codex diff review #3, ed09115a) — an OpenAI OAuth 401 that arrives while a refreshed
// pair's save is still unacknowledged, driven through ai.js's REAL request/retry loop
// (claudeApiCall) with the REAL providers/openai.js adapter. Only the leaves are stubbed: config.js,
// bridge.js (the token-store endpoints), http.js (the upstream send) and https (the token refresh).
//
// Pins:
//  - a DELAYED 401 from a request sent with the previous pair (stale generation) retries once on the
//    current pair, with no new refresh, even though the save is still pending and the "saving"
//    window (opened by another request's refused 401 on the current pair) is open;
//  - a 401 on the CURRENT pair while the save is pending stops: no refresh, one send, and the
//    reply classifies as the "saving" message (type 'storage', never 'reauth').
// Negative controls: (a) make classifyError return the non-retryable 'storage' class whenever a save is
// pending (the pre-fix code) and the first pin fails — the delayed 401 never reaches
// handleUnauthorized, so the turn ends on a 401 although a working pair is in memory; (b) drop the
// `{ usedGen }` argument from ai.js's in-loop classifyApiError call and the same pin fails, because
// the open window now swallows the stale 401.
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const https = require('https');
const { EventEmitter } = require('events');

const BUNDLE = path.resolve(__dirname, '../../app/src/main/assets/nodejs-project');
const workDir = fs.mkdtempSync(path.join(os.tmpdir(), 'bat1157-dispatch-'));

let failures = 0;
function ok(label, cond, hint = '') {
    if (cond) console.log('PASS: ' + label);
    else { console.log('FAIL: ' + label + (hint ? ' — ' + hint : '')); failures++; }
}

function stub(rel, exports) {
    const p = path.join(BUNDLE, rel);
    require.cache[p] = { id: p, filename: p, loaded: true, exports };
}

// ── leaves ───────────────────────────────────────────────────────────────────

const cfg = {
    log: () => {},
    workDir, MEMORY_DIR: path.join(workDir, 'memory'), TASKS_DIR: path.join(workDir, 'tasks'),
    PROVIDER: 'openai', CHANNEL: 'telegram', AUTH_TYPE: 'api_key', OPENAI_AUTH_TYPE: 'oauth',
    MODEL: 'gpt-5.5', resolveActiveModel: () => 'gpt-5.5', OPENAI_KEY: '',
    OPENAI_OAUTH_TOKEN: 'acc0', OPENAI_OAUTH_REFRESH: 'ref0', OPENAI_OAUTH_FAMILY: 'fam-1', OPENAI_OAUTH_EPOCH: 3,
    OPENAI_OAUTH_RECONNECT_REQUIRED: false,
    TOOL_RATE_LIMITS: {}, TOOL_STATUS_MAP: {}, USER_ENV_KEYS: [],
    API_TIMEOUT_RETRIES: 0, API_TIMEOUT_BACKOFF_MS: 1, API_TIMEOUT_MAX_BACKOFF_MS: 1,
    truncateToolResult: (s) => s, localTimestamp: () => new Date().toISOString(), localDateStr: () => '2026-11-16',
    getOwnerId: () => '1', config: {}, runtimeState: { read: () => ({}), write: () => {} },
};
stub('config.js', new Proxy(cfg, { get: (t, k) => (k in t ? t[k] : undefined) }));

// The token store: confirm-family succeeds; every save is ambiguous (503), so the pair stays pending.
stub('bridge.js', {
    androidBridgeCall: async () => ({}),
    androidBridgeCallWithStatus: async (endpoint) => {
        if (endpoint === '/openai/oauth/confirm-family') {
            return { status: 200, body: { success: true, familyId: 'fam-1', epoch: 3 }, transportError: null };
        }
        if (endpoint === '/openai/oauth/save-tokens') {
            return { status: 503, body: { code: 'OPENAI_OAUTH_SAVE_UNCONFIRMED' }, transportError: null };
        }
        return { status: 404, body: null, transportError: null };
    },
});

// Upstream sends: each test sets `onSend` (receives the request options, returns the response).
const sends = [];
let onSend = async () => ({ status: 200, data: {}, headers: {} });
const send = async (opts) => {
    sends.push(opts.headers && opts.headers.Authorization);
    return onSend(opts);
};
stub('http.js', { httpStreamingRequest: send, httpOpenAIStreamingRequest: send, httpChatCompletionsStreamingRequest: send });
stub('telegram.js', {
    sentMessageCache: new Map(), SENT_CACHE_TTL: 1,
    deferStatus: () => ({ cleanup: async () => {} }), deferThinkingStatus: () => ({ cleanup: async () => {} }),
});
stub('channel.js', {});
stub('database.js', { getDb: () => null });

// The token refresh (auth.openai.com) goes through https.request.
let refreshes = 0;
https.request = function (opts, cb) {
    refreshes++;
    const req = new EventEmitter();
    req.write = () => {}; req.end = () => {}; req.destroy = () => {};
    const res = new EventEmitter();
    res.statusCode = 200;
    const n = refreshes;
    setTimeout(() => {
        cb(res);
        res.emit('data', JSON.stringify({ access_token: 'acc' + n, refresh_token: 'ref' + n, expires_in: 3600 }));
        res.emit('end');
    }, 5);
    return req;
};

const ai = require(path.join(BUNDLE, 'ai.js'));
const openai = require(path.join(BUNDLE, 'providers', 'openai.js'));
const RETRY_AFTER = { 'retry-after': '1' }; // keeps the loop's backoff at 1 s

async function main() {
    // 1. A delayed 401: the request went out with acc0; while it was in flight another request's
    //    recovery refreshed to acc1 (save still unacknowledged), and a third request's 401 on acc1
    //    was already refused — so the "saving" window is open when this stale 401 lands.
    {
        sends.length = 0;
        let first = true;
        let windowOpen = null;
        onSend = async () => {
            if (first) {
                first = false;
                try { await openai.handleUnauthorized(0); } catch (_) { /* the concurrent request's retry signal */ }
                try { await openai.handleUnauthorized(1); } catch (_) { /* refused: save pending */ }
                windowOpen = openai.classifyError(401, {}).type === 'storage';
                return { status: 401, data: { error: { message: 'expired' } }, headers: RETRY_AFTER };
            }
            return { status: 200, data: {}, headers: {} };
        };
        const res = await ai._claudeApiCallForTests({ model: 'gpt-5.5', input: [] }, 'chat-1', { background: true });
        ok('setup: the concurrent recovery left the save pending', openai.isPersistPending() === true);
        ok('setup: the "saving" window was open when the stale 401 arrived', windowOpen === true);
        ok('the delayed 401 is retried and the turn succeeds', res && res.status === 200, `status=${res && res.status}`);
        ok('the retry carries the CURRENT pair', sends.length === 2 && sends[0] === 'Bearer acc0' && sends[1] === 'Bearer acc1', JSON.stringify(sends));
        ok('no new refresh: only the concurrent recovery refreshed', refreshes === 1, `refreshes=${refreshes}`);
    }

    // 2. A 401 on the CURRENT pair while the save is still pending: stop, never refresh again.
    {
        sends.length = 0;
        const before = refreshes;
        onSend = async () => ({ status: 401, data: { error: { message: 'expired' } }, headers: RETRY_AFTER });
        const res = await ai._claudeApiCallForTests({ model: 'gpt-5.5', input: [] }, 'chat-1', { background: true });
        ok('a current-pair 401 while saving ends the attempt', res && res.status === 401 && sends.length === 1, `status=${res && res.status} sends=${sends.length}`);
        ok('no refresh while the save is pending', refreshes === before, `refreshes=${refreshes - before}`);
        const c = openai.classifyError(401, {});
        ok("the user sees 'saving', type 'storage' (never 'reauth')", c.type === 'storage' && /Saving your refreshed/.test(c.userMessage), JSON.stringify(c));
    }

    openai.shutdownOAuthTimers();
    fs.rmSync(workDir, { recursive: true, force: true });
    console.log(failures === 0 ? '\nAll openai-oauth-dispatch tests passed' : `\n${failures} TEST(S) FAILED`);
    process.exitCode = failures === 0 ? 0 : 1;
}

main().catch((e) => { console.error(e); process.exitCode = 1; });
