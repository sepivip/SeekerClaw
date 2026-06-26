#!/usr/bin/env node
// telegram-no-double-delivery.test.js — BAT-1050 P1A Slice 2.
// Pins the NO-DOUBLE-DELIVERY invariant: a SECOND (plain) visible send happens
// ONLY on a deterministic HTML rejection. A transport throw (timeout/socket
// after the POST = possibly delivered) and a 429/5xx (transient) must NOT
// trigger a duplicate send. Also unit-tests classifyTelegramOutcome and pins
// that tools/telegram.js telegram_send no longer blindly resends.
//
// Run:  node tests/nodejs-project/telegram-no-double-delivery.test.js

'use strict';

const path = require('path');
const fs = require('fs');

const configPath = path.resolve(__dirname, '../../app/src/main/assets/nodejs-project/config.js');
const httpPath = path.resolve(__dirname, '../../app/src/main/assets/nodejs-project/http.js');
const securityPath = path.resolve(__dirname, '../../app/src/main/assets/nodejs-project/security.js');

let stubMode = 'ok';       // controls how the HTML attempt behaves
let htmlAttempts = 0;      // sends carrying parse_mode:HTML
let plainAttempts = 0;     // sends WITHOUT parse_mode (the fallback)
let nextId = 500;

require.cache[configPath] = {
    id: configPath, filename: configPath, loaded: true,
    exports: { BOT_TOKEN: 'fake-token', log: () => {}, workDir: '/tmp/seekerclaw-test', getOwnerId: () => '1' },
};

require.cache[httpPath] = {
    id: httpPath, filename: httpPath, loaded: true,
    exports: {
        httpRequest: async (opts, body) => {
            const method = opts.path.split('/').pop();
            const parsed = body ? (typeof body === 'string' ? JSON.parse(body) : body) : {};
            if (method !== 'sendMessage') return { status: 200, data: { ok: true, result: {} } };
            if (parsed.parse_mode === 'HTML') {
                htmlAttempts++;
                if (stubMode === 'throw-transport') {
                    const e = new Error('Timeout'); e.timeoutSource = 'transport'; throw e;
                }
                if (stubMode === 'reject-parse') {
                    return { status: 400, data: { ok: false, description: "Bad Request: can't parse entities in message text" } };
                }
                if (stubMode === 'reject-429') {
                    return { status: 429, data: { ok: false, error_code: 429, description: 'Too Many Requests: retry after 5' } };
                }
                return { status: 200, data: { ok: true, result: { message_id: ++nextId } } }; // 'ok'
            }
            // plain (fallback) attempt — always accepted so we can count it
            plainAttempts++;
            return { status: 200, data: { ok: true, result: { message_id: ++nextId } } };
        },
    },
};

require.cache[securityPath] = {
    id: securityPath, filename: securityPath, loaded: true,
    exports: { redactSecrets: (s) => s },
};

const telegram = require('../../app/src/main/assets/nodejs-project/telegram');

let failures = 0;
function eq(label, actual, expected) {
    const a = JSON.stringify(actual), e = JSON.stringify(expected);
    if (a === e) console.log(`PASS: ${label}`);
    else { console.log(`FAIL: ${label}\n  actual:   ${a}\n  expected: ${e}`); failures++; }
}
function ok(label, cond, hint = '') {
    if (cond) console.log(`PASS: ${label}`);
    else { console.log(`FAIL: ${label}${hint ? ' — ' + hint : ''}`); failures++; }
}

async function send(mode) {
    stubMode = mode; htmlAttempts = 0; plainAttempts = 0;
    await telegram.sendMessage(999, 'hello **world**');
}

(async () => {
    // ── classifyTelegramOutcome unit cases ──────────────────────────
    console.log('── classifyTelegramOutcome ──');
    const C = telegram.classifyTelegramOutcome;
    eq('thrown error -> uncertain', C(null, new Error('boom')).verdict, 'uncertain');
    eq('ok:true -> ok', C({ ok: true }, null).verdict, 'ok');
    eq('too long -> too_long', C({ ok: false, description: 'Bad Request: message is too long' }, null).verdict, 'too_long');
    eq('429 -> transient', C({ ok: false, error_code: 429 }, null).verdict, 'transient');
    eq('503 -> transient', C({ ok: false, error_code: 503 }, null).verdict, 'transient');
    eq("parse error -> fallback", C({ ok: false, description: "can't parse entities" }, null).verdict, 'fallback');

    // ── sendMessage: second send only on deterministic rejection ─────
    console.log();
    console.log('── sendMessage fallback gating ──');

    await send('throw-transport');
    eq('transport throw: 1 HTML attempt', htmlAttempts, 1);
    eq('transport throw: 0 plain fallback (NO double-delivery)', plainAttempts, 0);

    await send('reject-429');
    eq('429: 1 HTML attempt', htmlAttempts, 1);
    eq('429: 0 plain fallback (transient, no hammer)', plainAttempts, 0);

    await send('reject-parse');
    eq('parse rejection: 1 HTML attempt', htmlAttempts, 1);
    eq('parse rejection: 1 plain fallback (deterministic, safe)', plainAttempts, 1);

    await send('ok');
    eq('ok: 1 HTML attempt', htmlAttempts, 1);
    eq('ok: 0 plain fallback', plainAttempts, 0);

    // ── source drift-guard: telegram_send retrofit ──────────────────
    console.log();
    console.log('── telegram_send no-double-delivery (source drift-guard) ──');
    const toolSrc = fs.readFileSync(
        path.resolve(__dirname, '../../app/src/main/assets/nodejs-project/tools/telegram.js'), 'utf8');
    ok('telegram_send classifies the outcome', /classifyTelegramOutcome/.test(toolSrc));
    ok("telegram_send no longer blind-resends on (htmlFailed || !result.ok)",
        !/htmlFailed \|\| !result \|\| !result\.ok/.test(toolSrc));
    ok('telegram_send returns a possibly-delivered warning on transport throw',
        /possibly.+delivered/i.test(toolSrc));

    console.log();
    if (failures === 0) { console.log('ALL TESTS PASS'); process.exit(0); }
    else { console.log(`${failures} TEST(S) FAILED`); process.exit(1); }
})();
