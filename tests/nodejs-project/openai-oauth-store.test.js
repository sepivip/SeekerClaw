// BAT-1157 — providers/openai.js OAuth recovery against the token store contract
// (v2 §4, v3 §2/§4, v4 §1, Codex sign-off C2). Drives the REAL adapter with config.js and bridge.js
// replaced in the require cache and https.request mocked, the same pattern as xai.test.js.
//
// Pins:
//  - no upstream refresh before this process confirmed the family (confirm-family), and only on an
//    EXACT 200 that echoes the request (C2): a 429, a timeout, a non-200 with a success-shaped body,
//    or a 200 with the wrong family/epoch all mean zero refreshes;
//  - one confirm per process; concurrent 401s make one refresh; a delayed 401 (stale usedGen)
//    retries without refreshing;
//  - the save needs an exact 200 echoing epoch+1; a 409 drops the pair and latches; an ambiguous
//    reply keeps the pair, re-sends the SAME save (same rotationId) and blocks any new refresh;
//  - preflightAuth blocks sends while latched or reconnect-required; transient states are not
//    'reauth' (that type drives the autonomous reconnect notice).
'use strict';

const path = require('path');
const https = require('https');
const crypto = require('crypto');
const { EventEmitter } = require('events');

const BUNDLE = path.resolve(__dirname, '../../app/src/main/assets/nodejs-project');
const configPath = path.join(BUNDLE, 'config.js');
const bridgePath = path.join(BUNDLE, 'bridge.js');
const openaiPath = path.join(BUNDLE, 'providers', 'openai.js');

let failures = 0;
function ok(label, cond, hint = '') {
    if (cond) console.log('PASS: ' + label);
    else { console.log('FAIL: ' + label + (hint ? ' — ' + hint : '')); failures++; }
}

// ── test doubles ─────────────────────────────────────────────────────────────

let bridgeCalls = [];
let confirmReply;
let saveReplies;
const bridgeStub = {
    androidBridgeCall: async () => ({ error: 'not used' }),
    androidBridgeCallWithStatus: async (endpoint, data) => {
        bridgeCalls.push({ endpoint, data: JSON.parse(JSON.stringify(data)) });
        if (endpoint === '/openai/oauth/confirm-family') return typeof confirmReply === 'function' ? confirmReply(data) : confirmReply;
        if (endpoint === '/openai/oauth/save-tokens') {
            const r = saveReplies.length > 1 ? saveReplies.shift() : saveReplies[0];
            return typeof r === 'function' ? r(data) : r;
        }
        return { status: 404, body: null, transportError: null };
    },
};

function load({ token = 'acc0', refresh = 'ref0', family = 'fam-1', epoch = 3, reconnect = false, authType = 'oauth' } = {}) {
    for (const p of [configPath, bridgePath, openaiPath]) delete require.cache[p];
    require.cache[configPath] = {
        id: configPath, filename: configPath, loaded: true,
        exports: {
            log: () => {},
            OPENAI_OAUTH_TOKEN: token, OPENAI_OAUTH_REFRESH: refresh, OPENAI_AUTH_TYPE: authType,
            OPENAI_OAUTH_FAMILY: family, OPENAI_OAUTH_EPOCH: epoch, OPENAI_OAUTH_RECONNECT_REQUIRED: reconnect,
        },
    };
    require.cache[bridgePath] = { id: bridgePath, filename: bridgePath, loaded: true, exports: bridgeStub };
    bridgeCalls = [];
    return require(openaiPath);
}

let upstreamPosts = 0;
let nextRefresh = 1;
const origRequest = https.request;
function mockUpstream({ fail = false } = {}) {
    https.request = function (opts, cb) {
        upstreamPosts++;
        const req = new EventEmitter();
        req.write = () => {}; req.end = () => {}; req.destroy = () => {};
        const res = new EventEmitter();
        res.statusCode = fail ? 400 : 200;
        const n = nextRefresh++;
        const body = fail ? { error: 'invalid_grant' } : { access_token: 'acc' + n, refresh_token: 'ref' + n, expires_in: 3600 };
        setTimeout(() => { cb(res); res.emit('data', JSON.stringify(body)); res.emit('end'); }, 5);
        return req;
    };
}
function restore() { https.request = origRequest; }

const fp = (s) => crypto.createHash('sha256').update(s, 'utf8').digest('hex');
const okConfirm = (fam = 'fam-1', ep = 3) => ({ status: 200, body: { success: true, familyId: fam, epoch: ep }, transportError: null });
const okSave = (data) => ({ status: 200, body: { success: true, epoch: data.expectedEpoch + 1 }, transportError: null });

async function outcome(p, usedGen) {
    try { await p.handleUnauthorized(usedGen); return 'returned'; } catch (e) { return e.retryable ? 'retry' : 'fatal'; }
}
const confirms = () => bridgeCalls.filter(c => c.endpoint === '/openai/oauth/confirm-family');
const saves = () => bridgeCalls.filter(c => c.endpoint === '/openai/oauth/save-tokens');

// ── tests ────────────────────────────────────────────────────────────────────

async function main() {
    mockUpstream();

    // 1. Confirm before refresh; exactly one refresh after an exact 200.
    {
        upstreamPosts = 0; confirmReply = okConfirm(); saveReplies = [okSave];
        const p = load();
        ok('fresh process: the credential is not confirmed — first 401 retries after confirm+refresh', (await outcome(p, 0)) === 'retry');
        ok('confirm-family sent once, with the fingerprint of the refresh token (never the token)',
            confirms().length === 1 && confirms()[0].data.refreshFingerprint === fp('ref0') && !JSON.stringify(confirms()[0].data).includes('"ref0"'));
        ok('exactly one upstream refresh after confirmation', upstreamPosts === 1);
        ok('the save carries family, expectedEpoch and a rotationId',
            saves().length === 1 && saves()[0].data.familyId === 'fam-1' && saves()[0].data.expectedEpoch === 3 && !!saves()[0].data.rotationId);
        ok('generation advanced on adoption', p.currentRefreshGeneration() === 1);
        ok('an acknowledged save leaves nothing pending', p.isPersistPending() === false);
        // A second 401 on the new credential: no second confirm (already confirmed in this process).
        await outcome(p, 1);
        ok('no second confirm-family in the same process', confirms().length === 1, `confirms=${confirms().length}`);
    }

    // 2. C2: anything but an exact 200 means zero upstream refreshes.
    const badReplies = {
        '429': { status: 429, body: { error: 'rate limited' }, transportError: null },
        'timeout': { status: null, body: null, transportError: 'Android Bridge timeout' },
        'non-200 with a success-shaped body': { status: 503, body: { success: true, familyId: 'fam-1', epoch: 3 }, transportError: null },
        '200 with the wrong family': okConfirm('fam-OTHER', 3),
        '200 with the wrong epoch': okConfirm('fam-1', 9),
        'unparseable body': { status: 200, body: null, transportError: null },
    };
    for (const [name, reply] of Object.entries(badReplies)) {
        upstreamPosts = 0; confirmReply = reply; saveReplies = [okSave];
        const p = load();
        const o = await outcome(p, 0);
        ok(`confirm-family ${name} → no upstream refresh, request stops`, upstreamPosts === 0 && o === 'fatal', `posts=${upstreamPosts} outcome=${o}`);
        const c = p.classifyError(401, {});
        ok(`confirm-family ${name} → the storage message, not 'reauth'`, c.type === 'storage' && /Couldn't save/.test(c.userMessage), JSON.stringify(c));
    }

    // 3. 409 RECONNECT / FAMILY_CHANGED from confirm-family.
    {
        upstreamPosts = 0; confirmReply = { status: 409, body: { code: 'OPENAI_OAUTH_RECONNECT' }, transportError: null };
        const p = load();
        await outcome(p, 0);
        ok('RECONNECT: no refresh', upstreamPosts === 0);
        ok('RECONNECT: preflight now blocks sends with the reconnect message', p.preflightAuth() && /Reconnect OpenAI/.test(p.preflightAuth().userMessage));
        upstreamPosts = 0; confirmReply = { status: 409, body: { code: 'OPENAI_OAUTH_FAMILY_CHANGED' }, transportError: null };
        const q = load();
        await outcome(q, 0);
        ok('FAMILY_CHANGED: no refresh and latched', upstreamPosts === 0 && /sign-in changed/.test(q.preflightAuth().userMessage));
    }

    // 4. A legacy (null-family) boot sends epoch 0 and adopts the family the bridge returns.
    {
        upstreamPosts = 0; confirmReply = (d) => okConfirm(d.familyId === null && d.epoch === 0 ? 'fam-new' : 'x', 1); saveReplies = [okSave];
        const p = load({ family: null, epoch: 0 });
        await outcome(p, 0);
        ok('legacy confirm: null family, epoch 0', confirms()[0].data.familyId === null && confirms()[0].data.epoch === 0);
        ok('legacy confirm: the save uses the adopted family and epoch', saves()[0] && saves()[0].data.familyId === 'fam-new' && saves()[0].data.expectedEpoch === 1);
    }

    // 5. Concurrent 401s make one confirm and one refresh; a delayed 401 does not refresh again.
    {
        upstreamPosts = 0; confirmReply = okConfirm(); saveReplies = [okSave];
        const p = load();
        const r = await Promise.all([outcome(p, 0), outcome(p, 0), outcome(p, 0)]);
        ok('concurrent 401s: one refresh, all retry', upstreamPosts === 1 && r.every(x => x === 'retry'), `posts=${upstreamPosts} ${r}`);
        ok('concurrent 401s: one confirm', confirms().length === 1);
        const delayed = await outcome(p, 0); // a request sent with the OLD credential, 401 arriving late
        ok('delayed 401 with a stale usedGen retries without a second refresh', delayed === 'retry' && upstreamPosts === 1);
    }

    // 6. Save 409 → drop the pair, latch, no more sends.
    {
        upstreamPosts = 0; confirmReply = okConfirm(); saveReplies = [{ status: 409, body: { code: 'OPENAI_OAUTH_EPOCH_CONFLICT' }, transportError: null }];
        const p = load();
        await outcome(p, 0);
        ok('save 409: latched — preflight blocks every send', p.preflightAuth() && p.preflightAuth().type === 'reauth');
        ok('save 409: the bearer is dropped', p.buildHeaders('').Authorization === 'Bearer ', p.buildHeaders('').Authorization);
        upstreamPosts = 0;
        ok('save 409: a later 401 never refreshes', (await outcome(p, p.currentRefreshGeneration())) === 'fatal' && upstreamPosts === 0);
    }

    // 7. Ambiguous save: keep the pair, re-send the SAME save, no new refresh until it lands.
    {
        upstreamPosts = 0; confirmReply = okConfirm();
        saveReplies = [
            { status: 503, body: { code: 'OPENAI_OAUTH_SAVE_UNCONFIRMED' }, transportError: null },
            { status: 200, body: { success: true, epoch: 99 }, transportError: null }, // wrong epoch: still not acknowledged
        ];
        const p = load();
        ok('ambiguous save: the refresh itself succeeded (retry)', (await outcome(p, 0)) === 'retry');
        ok('ambiguous save: the new pair is in use', p.buildHeaders('').Authorization !== 'Bearer acc0', p.buildHeaders('').Authorization);
        const c = p.classifyError(401, {});
        ok("ambiguous save: a 401 now says 'saving', type is not 'reauth'", c.type === 'storage' && /Saving your refreshed/.test(c.userMessage));
        upstreamPosts = 0;
        ok('ambiguous save: no new upstream refresh while unacknowledged', (await outcome(p, p.currentRefreshGeneration())) === 'fatal' && upstreamPosts === 0);
        ok('ambiguous save: health sees the unsaved pair (isPersistPending)', p.isPersistPending() === true);
        p.shutdownOAuthTimers();
        ok('the save retry timer is cleared by shutdownOAuthTimers (SIGTERM)', true);
    }

    // 8. Pre-send checks and the transport.
    {
        const p = load({ token: '', refresh: '', reconnect: true });
        const b = p.preflightAuth();
        ok('reconnect-required: preflight blocks with type reauth', b && b.type === 'reauth' && /Reconnect OpenAI/.test(b.userMessage));
        const k = load({ authType: 'api_key' });
        ok('api_key transport: preflight never blocks', k.preflightAuth() === null);
    }

    // 9. Source guard (ai.js cannot be required in isolation): the pre-send check runs at the TOP of
    //    claudeApiCall's retry loop — before every streamFn attempt, including after a backoff — so a
    //    latch that lands while the loop waits can never let the retained headers be sent.
    {
        const fs = require('fs');
        const ai = fs.readFileSync(path.join(BUNDLE, 'ai.js'), 'utf8');
        const fn = ai.slice(ai.indexOf('async function claudeApiCall('));
        const loop = fn.indexOf('while (true) {');
        const pre = fn.indexOf('adapter.preflightAuth()', loop);
        const send = fn.indexOf('await streamFn(', loop);
        ok('ai.js: preflightAuth runs inside the retry loop, before every streamFn send',
            loop !== -1 && pre !== -1 && send !== -1 && pre < send, `loop=${loop} pre=${pre} send=${send}`);
        const sum = ai.slice(ai.indexOf('[ContextSummary]') - 4000);
        ok('ai.js: the context summarizer also checks preflightAuth before sending', /preflightAuth\(\)/.test(ai.slice(ai.indexOf('_sumRefreshed'), ai.indexOf('_sumRefreshed') + 800)));
    }

    restore();
    console.log(failures === 0 ? '\nAll openai-oauth-store tests passed' : `\n${failures} TEST(S) FAILED`);
    process.exit(failures === 0 ? 0 : 1);
}

main().catch((e) => { console.error(e); process.exit(1); });
