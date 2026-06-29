#!/usr/bin/env node
// telegram-systemplain.test.js — BAT-1050 P1A Slice 1.
// Pins the systemPlain contract: synthetic/system notices (heartbeat,
// back-online, confirmation nudges, auto-resume status) send RAW — no
// parse_mode, no HTML/rich transform — while normal user replies keep the
// classic parse_mode:HTML pipeline. Guards the BAT-558 heartbeat invariant
// (heartbeat ALERT must stay plain) at both the behavioral and source level.
//
// Run:  node tests/nodejs-project/telegram-systemplain.test.js

'use strict';

const path = require('path');
const fs = require('fs');

// ── Stub config + http + security BEFORE requiring telegram ─────────
const configPath = path.resolve(__dirname, '../../app/src/main/assets/nodejs-project/config.js');
const httpPath = path.resolve(__dirname, '../../app/src/main/assets/nodejs-project/http.js');
const securityPath = path.resolve(__dirname, '../../app/src/main/assets/nodejs-project/security.js');

const sentMessages = []; // [{ method, payload, message_id }]
let nextMessageId = 100;

require.cache[configPath] = {
    id: configPath, filename: configPath, loaded: true,
    exports: {
        BOT_TOKEN: 'fake-token',
        log: () => {},
        workDir: '/tmp/seekerclaw-test',
        getOwnerId: () => '1',
    },
};

require.cache[httpPath] = {
    id: httpPath, filename: httpPath, loaded: true,
    exports: {
        httpRequest: async (opts, body) => {
            const method = opts.path.split('/').pop();
            const parsed = body ? (typeof body === 'string' ? JSON.parse(body) : body) : {};
            if (method === 'sendMessage') {
                const message_id = ++nextMessageId;
                sentMessages.push({ method, payload: parsed, message_id });
                return { data: { ok: true, result: { message_id } } };
            }
            return { data: { ok: true, result: {} } };
        },
    },
};

// Redact a sentinel so we can prove redactSecrets still runs on the plain path.
require.cache[securityPath] = {
    id: securityPath, filename: securityPath, loaded: true,
    exports: { redactSecrets: (s) => String(s).replace(/SEKRET-[A-Z0-9]+/g, '[redacted]') },
};

const telegram = require('../../app/src/main/assets/nodejs-project/telegram');

let failures = 0;
function ok(label, cond, hint = '') {
    if (cond) console.log(`PASS: ${label}`);
    else { console.log(`FAIL: ${label}${hint ? ' — ' + hint : ''}`); failures++; }
}
function eq(label, actual, expected) {
    const a = JSON.stringify(actual), e = JSON.stringify(expected);
    if (a === e) console.log(`PASS: ${label}`);
    else { console.log(`FAIL: ${label}\n  actual:   ${a}\n  expected: ${e}`); failures++; }
}
const sleep = (ms) => new Promise(r => setTimeout(r, ms));
async function waitFor(predicate, timeoutMs = 3000, intervalMs = 50) {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
        if (predicate()) return;
        await sleep(intervalMs);
    }
    throw new Error(`waitFor timed out after ${timeoutMs}ms`);
}

(async () => {
    // ── systemPlain: raw send, NO parse_mode, NO transform ───────────
    console.log('── systemPlain sends raw (no parse_mode, no HTML transform) ──');
    sentMessages.length = 0;
    await telegram.sendMessageSystem(123, 'Alert: **bold** and <b>raw</b> and a < b');
    eq('systemPlain: exactly 1 send', sentMessages.length, 1);
    ok('systemPlain: payload has NO parse_mode key',
        !('parse_mode' in sentMessages[0].payload));
    ok('systemPlain: markdown left raw (** not converted to <b>)',
        sentMessages[0].payload.text.includes('**bold**'));
    ok('systemPlain: raw angle brackets passed through literally (no parse, no escape)',
        sentMessages[0].payload.text.includes('<b>raw</b>') && sentMessages[0].payload.text.includes('a < b'));
    eq('systemPlain: chat_id forwarded', sentMessages[0].payload.chat_id, 123);
    ok('systemPlain: no reply threading (reply_to_message_id null)',
        sentMessages[0].payload.reply_to_message_id == null);

    // ── systemPlain still redacts secrets ────────────────────────────
    console.log();
    console.log('── systemPlain still applies redactSecrets ──');
    sentMessages.length = 0;
    await telegram.sendMessageSystem(789, 'leaked token SEKRET-ABC123 in a system notice');
    ok('systemPlain: secret redacted before send',
        sentMessages[0].payload.text.includes('[redacted]')
        && !sentMessages[0].payload.text.includes('SEKRET-ABC123'));

    // ── classic user reply keeps parse_mode:HTML + transform ─────────
    console.log();
    console.log('── classic sendMessage keeps parse_mode:HTML (the rich-eligible path) ──');
    sentMessages.length = 0;
    await telegram.sendMessage(456, 'hi **bold**');
    ok('classic: at least 1 send', sentMessages.length >= 1);
    ok('classic: first attempt uses parse_mode:HTML',
        sentMessages[0].payload.parse_mode === 'HTML');
    ok('classic: markdown transformed to HTML (<b>bold</b>)',
        sentMessages[0].payload.text.includes('<b>bold</b>'));

    // ── thinking/status bubble stays plain (regression guard) ────────
    console.log();
    console.log('── status/thinking bubble bypasses rich (stays plain) ──');
    sentMessages.length = 0;
    const bubble = telegram.deferThinkingStatus(222);
    await waitFor(() => sentMessages.length >= 1, 3000);
    ok('bubble: payload has NO parse_mode key',
        !('parse_mode' in sentMessages[0].payload));
    ok('bubble: sent with disable_notification:true',
        sentMessages[0].payload.disable_notification === true);
    await bubble.cleanup();

    // ── BAT-558 source drift-guard: heartbeat uses sendMessageSystem ─
    // runHeartbeat() lives in main.js and isn't unit-testable in isolation
    // (it drives a full chat() turn). Pin the routing at the source level so
    // a refactor can't silently send the heartbeat ALERT through the
    // rich-eligible path.
    console.log();
    console.log('── BAT-558: heartbeat final-notify routes through sendMessageSystem ──');
    const mainSrc = fs.readFileSync(
        path.resolve(__dirname, '../../app/src/main/assets/nodejs-project/main.js'), 'utf8');
    ok('heartbeat alert calls sendMessageSystem(ownerChatId, cleaned)',
        /addToConversation\(ownerChatId, 'assistant', cleaned\);\s*await sendMessageSystem\(ownerChatId, cleaned\);/.test(mainSrc));
    ok('heartbeat alert does NOT use the rich-eligible sendMessage alias',
        !/await sendMessage\(ownerChatId, cleaned\)/.test(mainSrc));

    console.log();
    if (failures === 0) {
        console.log('ALL TESTS PASS');
        process.exit(0);
    } else {
        console.log(`${failures} TEST(S) FAILED`);
        process.exit(1);
    }
})();
