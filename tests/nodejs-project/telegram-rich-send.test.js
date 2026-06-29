#!/usr/bin/env node
// telegram-rich-send.test.js — BAT-1050 P1A Slice 4.
// Pins richTrySend: when the flag is on, sendMessage tries sendRichMessage first
// (sanitized markdown, skip_entity_detection:true, reply_parameters), and falls
// back to the classic HTML pipeline ONLY when Rich did not land — except a
// transport throw (possibly delivered) which must NOT duplicate. Also pins the
// method-availability cache (after a 'method not found', stop probing Rich).
//
// Run:  node tests/nodejs-project/telegram-rich-send.test.js

'use strict';

const path = require('path');

const configPath = path.resolve(__dirname, '../../app/src/main/assets/nodejs-project/config.js');
const httpPath = path.resolve(__dirname, '../../app/src/main/assets/nodejs-project/http.js');
const securityPath = path.resolve(__dirname, '../../app/src/main/assets/nodejs-project/security.js');

let richMode = 'ok';
const richCalls = [];   // captured sendRichMessage payloads
let classicCalls = 0;   // sendMessage (classic) call count
let nextId = 700;

require.cache[configPath] = {
    id: configPath, filename: configPath, loaded: true,
    exports: {
        BOT_TOKEN: 'fake-token', log: () => {}, workDir: '/tmp/seekerclaw-test',
        getOwnerId: () => '1', RICH_MESSAGES_ENABLED: true,
    },
};

require.cache[httpPath] = {
    id: httpPath, filename: httpPath, loaded: true,
    exports: {
        httpRequest: async (opts, body) => {
            const method = opts.path.split('/').pop();
            const parsed = body ? (typeof body === 'string' ? JSON.parse(body) : body) : {};
            if (method === 'sendRichMessage') {
                richCalls.push(parsed);
                if (richMode === 'throw') { const e = new Error('Timeout'); e.timeoutSource = 'transport'; throw e; }
                if (richMode === 'reject') return { data: { ok: false, description: 'Bad Request: rich message invalid' } };
                if (richMode === '429') return { data: { ok: false, error_code: 429, description: 'Too Many Requests' } };
                if (richMode === '404') return { data: { ok: false, error_code: 404, description: 'Not Found: method not found' } };
                return { data: { ok: true, result: { message_id: ++nextId } } };
            }
            if (method === 'sendMessage') {
                classicCalls++;
                return { data: { ok: true, result: { message_id: ++nextId } } };
            }
            return { data: { ok: true, result: {} } };
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
function reset() { richCalls.length = 0; classicCalls = 0; }

(async () => {
    // ── 1. Rich success: rich used, no classic ─────────────────────
    console.log('── rich send success ──');
    richMode = 'ok'; reset();
    await telegram.sendMessage(555, 'hi **there** <b>raw</b>', 42);
    eq('1 sendRichMessage call', richCalls.length, 1);
    eq('0 classic fallback', classicCalls, 0);
    ok('skip_entity_detection:true on rich call', richCalls[0].rich_message.skip_entity_detection === true);
    ok('markdown sanitized (<b> escaped)', richCalls[0].rich_message.markdown.includes('&lt;b&gt;'));
    ok('markdown keeps bold (**there**)', richCalls[0].rich_message.markdown.includes('**there**'));
    ok('reply_parameters w/ allow_sending_without_reply',
        richCalls[0].reply_parameters
        && richCalls[0].reply_parameters.message_id === 42
        && richCalls[0].reply_parameters.allow_sending_without_reply === true);
    ok('no deprecated reply_to_message_id on rich', !('reply_to_message_id' in richCalls[0]));

    // ── 2. Sanitization: tg:// + image neutered on the rich path ────
    console.log();
    console.log('── rich markdown sanitization ──');
    richMode = 'ok'; reset();
    await telegram.sendMessage(555, '[click](tg://user?id=9) and ![](https://img/x.png)');
    ok('tg:// link neutered', richCalls[0].rich_message.markdown.includes('click') && !richCalls[0].rich_message.markdown.includes('tg://'));
    ok('image neutered (no remote URL)', !richCalls[0].rich_message.markdown.includes('https://img'));

    // ── 3. Transport throw: possibly delivered -> NO classic fallback
    console.log();
    console.log('── rich transport throw (no double-delivery) ──');
    richMode = 'throw'; reset();
    await telegram.sendMessage(555, 'boom');
    eq('1 rich attempt', richCalls.length, 1);
    eq('0 classic fallback (no duplicate)', classicCalls, 0);

    // ── 4. Deterministic rich rejection -> classic fallback ────────
    console.log();
    console.log('── rich deterministic rejection -> classic ──');
    richMode = 'reject'; reset();
    await telegram.sendMessage(555, 'hello');
    eq('1 rich attempt', richCalls.length, 1);
    ok('classic fallback used (>=1)', classicCalls >= 1);

    // ── 5. 429 transient -> classic fallback (not a duplicate) ─────
    console.log();
    console.log('── rich 429 transient -> classic ──');
    richMode = '429'; reset();
    await telegram.sendMessage(555, 'hello');
    eq('1 rich attempt', richCalls.length, 1);
    ok('classic fallback used (>=1)', classicCalls >= 1);

    // ── 6. method-not-found -> classic + disables rich for the run ─
    console.log();
    console.log('── rich method-not-found -> classic + cache off ──');
    richMode = '404'; reset();
    await telegram.sendMessage(555, 'hello');
    eq('1 rich attempt', richCalls.length, 1);
    ok('classic fallback used (>=1)', classicCalls >= 1);

    // ── 7. cache: after 404, rich is NOT re-probed ─────────────────
    console.log();
    console.log('── after method-not-found, Rich is skipped ──');
    richMode = 'ok'; reset(); // stub would accept, but rich must be skipped now
    await telegram.sendMessage(555, 'hello again');
    eq('0 rich attempts (cached unavailable)', richCalls.length, 0);
    ok('classic used (>=1)', classicCalls >= 1);

    console.log();
    if (failures === 0) { console.log('ALL TESTS PASS'); process.exit(0); }
    else { console.log(`${failures} TEST(S) FAILED`); process.exit(1); }
})();
