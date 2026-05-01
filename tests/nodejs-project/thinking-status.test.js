#!/usr/bin/env node
// thinking-status.test.js — pin BAT-549 Commit 6 extended-thinking
// status indicator invariants per v4 contract sign-off.
//
// What this guards:
//   - 500ms debounce: no status message sent if cleanup arrives < 500ms
//     (so fast non-thinking turns never flash a Thinking... bubble)
//   - Status text is hardcoded "Thinking..." (no emoji, per Codex v3
//     sign-off — quiet/durable if Telegram delete fails)
//   - cleanup() has NO min-visible hold (unlike deferStatus's 1.5s
//     hold) — Codex v4 adjustment 1: final answer must NEVER be
//     delayed by the bubble lifecycle
//   - Gating expression: bubble appears ONLY when ALL three of
//     reasoningEnabled / reasoningSupport=='yes' / reasoningDisplayInChat
//
// Run:  node tests/nodejs-project/thinking-status.test.js

'use strict';

const path = require('path');

// ── Stub config + http BEFORE requiring telegram ────────────────────

const configPath = path.resolve(__dirname, '../../app/src/main/assets/nodejs-project/config.js');
const httpPath = path.resolve(__dirname, '../../app/src/main/assets/nodejs-project/http.js');
const securityPath = path.resolve(__dirname, '../../app/src/main/assets/nodejs-project/security.js');

const sentMessages = []; // [{ chatId, text, msg_id }]
const deletedMessages = []; // [{ chatId, message_id }]

require.cache[configPath] = {
    id: configPath, filename: configPath, loaded: true,
    exports: {
        BOT_TOKEN: 'fake-token',
        log: () => {},
        workDir: '/tmp/seekerclaw-test',
        getOwnerId: () => '1',
    },
};

let nextMessageId = 100;
require.cache[httpPath] = {
    id: httpPath, filename: httpPath, loaded: true,
    exports: {
        httpRequest: async (opts, body) => {
            // Minimal stub of the Telegram API: parse method + chat_id
            // out of the path/body and synthesize the right response.
            const method = opts.path.split('/').pop();
            const parsed = body ? (typeof body === 'string' ? JSON.parse(body) : body) : {};
            if (method === 'sendMessage') {
                const message_id = ++nextMessageId;
                sentMessages.push({ chatId: parsed.chat_id, text: parsed.text, message_id });
                return { data: { ok: true, result: { message_id } } };
            }
            if (method === 'deleteMessage') {
                deletedMessages.push({ chatId: parsed.chat_id, message_id: parsed.message_id });
                return { data: { ok: true } };
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

(async () => {
    // ── 500ms debounce: cleanup before 500ms cancels the send ────────

    console.log('── debounce: cleanup < 500ms cancels send ──');
    sentMessages.length = 0;
    deletedMessages.length = 0;
    let s = telegram.deferThinkingStatus(123);
    await sleep(50); // well under 500ms
    await s.cleanup();
    eq('cleanup at 50ms: 0 sendMessage calls (timer cancelled)',
        sentMessages.length, 0);
    eq('cleanup at 50ms: 0 deleteMessage calls (nothing to delete)',
        deletedMessages.length, 0);

    // ── 500ms debounce: cleanup after 500ms sends + deletes ──────────

    console.log();
    console.log('── send + delete after debounce ──');
    sentMessages.length = 0;
    deletedMessages.length = 0;
    s = telegram.deferThinkingStatus(456);
    await sleep(550); // over 500ms — message should send
    eq('after 550ms: 1 sendMessage call', sentMessages.length, 1);
    eq('text is "Thinking..." (no emoji)', sentMessages[0].text, 'Thinking...');
    eq('chat_id forwarded', sentMessages[0].chatId, 456);
    await s.cleanup();
    eq('after cleanup: 1 deleteMessage call', deletedMessages.length, 1);
    eq('deleted the message we sent',
        deletedMessages[0].message_id, sentMessages[0].message_id);

    // ── No min-visible hold (CRITICAL Codex sign-off contract) ───────

    console.log();
    console.log('── no min-visible hold: cleanup is fast even right after send ──');
    sentMessages.length = 0;
    deletedMessages.length = 0;
    s = telegram.deferThinkingStatus(789);
    await sleep(550); // status message has been sent at this point
    const beforeCleanup = Date.now();
    await s.cleanup();
    const cleanupElapsed = Date.now() - beforeCleanup;
    // deferStatus would hold for ~1.5s here. deferThinkingStatus
    // must NOT — answer delivery depends on this.
    ok(`cleanup completes in <500ms (no min-visible hold; got ${cleanupElapsed}ms)`,
        cleanupElapsed < 500);

    // ── Fire-and-forget pattern: caller does not await ───────────────

    console.log();
    console.log('── fire-and-forget pattern (caller does NOT await cleanup) ──');
    sentMessages.length = 0;
    deletedMessages.length = 0;
    s = telegram.deferThinkingStatus(101);
    await sleep(550);
    // Mimic ai.js's call: cleanup().catch(() => {}) — fire and continue
    const cleanupPromise = s.cleanup().catch(() => {});
    // The caller code path returns IMMEDIATELY without waiting
    // for cleanupPromise to resolve. Verify by checking we can
    // synchronously continue.
    ok('cleanup is a Promise (caller can fire-and-forget)',
        cleanupPromise && typeof cleanupPromise.then === 'function');
    await cleanupPromise; // for test cleanup, wait for the actual delete

    // ── Gating expression (mirrors ai.js's showThinkingStatus) ───────
    //
    // The gating expression in ai.js is:
    //   showThinkingStatus = !!(
    //       requestOptions.reasoningEnabled === true
    //       && requestOptions.reasoningSupport === 'yes'
    //       && _liveRtState.reasoningDisplayInChat === true
    //   )
    // Pin the contract by replicating it in the test — wrong gates
    // would let "Thinking..." flash on no-op turns OR fail to show
    // when it should.

    console.log();
    console.log('── gating expression: all three required ──');
    function shouldShow(opts, rtState) {
        return !!(
            opts && opts.reasoningEnabled === true
            && opts.reasoningSupport === 'yes'
            && rtState && rtState.reasoningDisplayInChat === true
        );
    }
    ok('all three on → show', shouldShow(
        { reasoningEnabled: true, reasoningSupport: 'yes' },
        { reasoningDisplayInChat: true }) === true);
    ok('reasoningEnabled false → hide', shouldShow(
        { reasoningEnabled: false, reasoningSupport: 'yes' },
        { reasoningDisplayInChat: true }) === false);
    ok('reasoningSupport=no → hide (Haiku case)', shouldShow(
        { reasoningEnabled: true, reasoningSupport: 'no' },
        { reasoningDisplayInChat: true }) === false);
    ok('reasoningSupport=unknown → hide (freeform Custom case)', shouldShow(
        { reasoningEnabled: true, reasoningSupport: 'unknown' },
        { reasoningDisplayInChat: true }) === false);
    ok('reasoningDisplayInChat false → hide', shouldShow(
        { reasoningEnabled: true, reasoningSupport: 'yes' },
        { reasoningDisplayInChat: false }) === false);
    ok('null requestOptions → hide', shouldShow(
        null,
        { reasoningDisplayInChat: true }) === false);
    ok('null rtState → hide', shouldShow(
        { reasoningEnabled: true, reasoningSupport: 'yes' },
        null) === false);

    // ── Cleanup with no message_id (timer never fired) is safe ───────

    console.log();
    console.log('── cleanup before any send is safe (no throw, no leaks) ──');
    sentMessages.length = 0;
    deletedMessages.length = 0;
    s = telegram.deferThinkingStatus(202);
    await s.cleanup(); // immediate cleanup, before 500ms
    eq('immediate cleanup: 0 sends', sentMessages.length, 0);
    eq('immediate cleanup: 0 deletes', deletedMessages.length, 0);

    console.log();
    if (failures === 0) {
        console.log('ALL TESTS PASS');
        process.exit(0);
    } else {
        console.log(`${failures} TEST(S) FAILED`);
        process.exit(1);
    }
})();
