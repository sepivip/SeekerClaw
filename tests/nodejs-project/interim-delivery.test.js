#!/usr/bin/env node
// interim-delivery.test.js — BAT-1109: interim/pre-tool assistant text delivery.
//
// The bug: when the model returns an assistant message with BOTH text and a
// tool_use block, the ai.js tool loop executed the tool and dropped the text —
// only the final text-only response reached the user. The fix threads a
// sendInterim callback into chat() and routes both interim and final text
// through a shared deliverAgentText sanitizer/sender.
//
// This pins the message-handler half (deliverAgentText + the sendInterim
// wiring). The ai.js insertion point (interim only on tool-executing rounds,
// after the _loopFinalIteration guard, never double-sent) is covered by the
// contract's exhaustive per-exit-path analysis + on-device testing — the full
// chat() loop is too coupled to mock deterministically here.
//
// Pins:
//   deliverAgentText (shared sanitizer/sender):
//     - plain text sent; returns true
//     - final replyToDefault = messageId; interim replyToDefault = null
//     - [[reply_to_current]] honored (interim quote-replies the message)
//     - SILENT_REPLY (canonical + legacy bare) suppressed → returns false, no send
//     - HEARTBEAT_OK stripped; HEARTBEAT_OK-only suppressed
//     - empty / whitespace-only suppressed
//     - dedup: exact repeat suppressed, distinct sent, resets with a fresh Set
//   handleMessage wiring:
//     - interim text delivered BEFORE the final reply, in order
//     - interim uses no quote-reply; final quote-replies the message
//     - dedup within a turn (recovery replay of the same text → sent once)
//     - dedup resets on the next user turn (fresh Set per handleMessage call)
//     - interim send failure is logged + swallowed → final reply still delivered
//     - the interactive path wires a real sendInterim function into chat()
//
// Run:  node tests/nodejs-project/interim-delivery.test.js

'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');

// ── Stub config.js + main.js dependencies BEFORE requiring message-handler ──
const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'bat1109-interim-'));
const workDir = path.join(tmpRoot, 'workspace');
fs.mkdirSync(workDir, { recursive: true });

const configPath = path.resolve(__dirname, '../../app/src/main/assets/nodejs-project/config.js');
require.cache[configPath] = {
    id: configPath, filename: configPath, loaded: true,
    exports: {
        log: () => {},
        CHANNEL: 'telegram',
        workDir,
        PROVIDER: 'claude',
        AUTH_TYPE: 'api_key',
        OPENAI_AUTH_TYPE: 'api_key',
        resolveActiveModel: () => 'claude-opus-4-7',
        runtimeState: { read: () => ({}), write: () => {} },
        config: {},
    },
};

const stubModule = (relPath, exports) => {
    const fullPath = path.resolve(__dirname, '../../app/src/main/assets/nodejs-project', relPath);
    require.cache[fullPath] = { id: fullPath, filename: fullPath, loaded: true, exports };
};
stubModule('telegram.js', { sendTyping: async () => {}, sentMessageCache: new Map(), SENT_CACHE_TTL: 60000 });
stubModule('discord.js', {});
stubModule('channel.js', { sendMessage: async () => {} });
stubModule('skills.js', { findRelevantSkill: () => null });
stubModule('mcp-client.js', { MCPManager: class {} });
stubModule('database.js', { getDb: () => null });
stubModule('memory.js', {});
stubModule('cron.js', {});
stubModule('quick-actions.js', {});
stubModule('repetition-detector.js', {});
stubModule('task-store.js', { listOpenCheckpoints: () => [] });
stubModule('security.js', { redactSecrets: (s) => s });
stubModule('bridge.js', { androidBridgeCall: async () => ({}) });
stubModule('http.js', {});

const mh = require('../../app/src/main/assets/nodejs-project/message-handler');

// ── Recording sinks (reset per test) ──
let sent = [];                 // { chatId, text, replyTo }
let logs = [];                 // { msg, level }
let chatImpl = async () => ''; // per-test chat() behavior
let throwOnText = null;        // when set, deps.sendMessage throws for this exact text

const OWNER = '42';
mh.init({
    log: (msg, level) => logs.push({ msg, level }),
    androidBridgeCall: async () => ({}),
    sendMessage: async (chatId, text, replyTo) => {
        if (throwOnText !== null && text === throwOnText) throw new Error('simulated telegram failure');
        sent.push({ chatId, text, replyTo });
    },
    sendTyping: async () => {},
    getOwnerId: () => OWNER,
    setOwnerId: () => {},
    createStatusReactionController: () => ({
        setQueued: () => {}, setThinking: () => {}, setTool: () => {},
        setDone: async () => {}, clear: async () => {}, setError: async () => {},
    }),
    lastIncomingMessages: new Map(),
    chat: (...a) => chatImpl(...a),
    redactSecrets: (s) => s,
    MAX_FILE_SIZE: 20 * 1024 * 1024,
    MAX_IMAGE_SIZE: 5 * 1024 * 1024,
});

let failures = 0;
function ok(label, cond, hint = '') {
    if (cond) console.log(`PASS: ${label}`);
    else { console.log(`FAIL: ${label}${hint ? ' — ' + hint : ''}`); failures++; }
}
function reset() { sent = []; logs = []; throwOnText = null; }

// Drive one plain-text interactive turn through the real handleMessage.
async function turn(text, chat) {
    reset();
    chatImpl = chat;
    await mh.handleMessage({ chatId: '123', senderId: OWNER, text, messageId: 7, media: null });
}

(async () => {
    // ─────────────────────────────────────────────────────────────
    // Part A — deliverAgentText (shared sanitizer + dedup), direct
    // ─────────────────────────────────────────────────────────────

    reset();
    let r = await mh.deliverAgentText('c', 'hello world', 9, 9);
    ok('A1 plain text sent + returns true',
        r === true && sent.length === 1 && sent[0].text === 'hello world' && sent[0].replyTo === 9);

    reset();
    r = await mh.deliverAgentText('c', 'BANANA', 9, null);
    ok('A2 interim: replyToDefault=null → no quote-reply',
        r === true && sent.length === 1 && sent[0].text === 'BANANA' && sent[0].replyTo === null);

    reset();
    r = await mh.deliverAgentText('c', '[[reply_to_current]]hi there', 9, null);
    ok('A3 [[reply_to_current]] honored for interim (quote-replies message, tag stripped)',
        r === true && sent.length === 1 && sent[0].text === 'hi there' && sent[0].replyTo === 9);

    reset();
    r = await mh.deliverAgentText('c', '[[SILENT_REPLY]]', 9, 9);
    ok('A4 canonical [[SILENT_REPLY]] suppressed', r === false && sent.length === 0);

    reset();
    r = await mh.deliverAgentText('c', 'SILENT_REPLY', 9, 9);
    ok('A5 legacy bare SILENT_REPLY (whole message) suppressed', r === false && sent.length === 0);

    reset();
    r = await mh.deliverAgentText('c', 'Hello [[SILENT_REPLY]] world', 9, null);
    ok('A6 mixed-content SILENT_REPLY stripped, remainder sent',
        r === true && sent.length === 1 && sent[0].text === 'Hello world');

    reset();
    r = await mh.deliverAgentText('c', 'done HEARTBEAT_OK', 9, 9);
    ok('A7 HEARTBEAT_OK stripped from mixed content',
        r === true && sent.length === 1 && sent[0].text === 'done');

    reset();
    r = await mh.deliverAgentText('c', 'HEARTBEAT_OK', 9, 9);
    ok('A8 HEARTBEAT_OK-only suppressed', r === false && sent.length === 0);

    reset();
    r = await mh.deliverAgentText('c', '   ', 9, 9);
    ok('A9 whitespace-only suppressed', r === false && sent.length === 0);

    reset();
    r = await mh.deliverAgentText('c', 12345, 9, 9);
    ok('A10 non-string suppressed (no throw)', r === false && sent.length === 0);

    // dedup semantics
    reset();
    const set = new Set();
    const d1 = await mh.deliverAgentText('c', 'X', 9, null, set);
    const d2 = await mh.deliverAgentText('c', 'X', 9, null, set);
    const d3 = await mh.deliverAgentText('c', 'Y', 9, null, set);
    ok('A11 dedup: exact repeat suppressed, distinct sent',
        d1 === true && d2 === false && d3 === true
        && sent.length === 2 && sent[0].text === 'X' && sent[1].text === 'Y');

    reset();
    const freshSet = new Set();
    const e1 = await mh.deliverAgentText('c', 'X', 9, null, freshSet);
    ok('A12 dedup resets with a fresh Set', e1 === true && sent.length === 1 && sent[0].text === 'X');

    // dedup keys on SANITIZED text: "X" vs "X HEARTBEAT_OK" both sanitize to "X"
    reset();
    const set2 = new Set();
    const f1 = await mh.deliverAgentText('c', 'X', 9, null, set2);
    const f2 = await mh.deliverAgentText('c', 'X HEARTBEAT_OK', 9, null, set2);
    ok('A13 dedup keys on sanitized text (X vs "X HEARTBEAT_OK")',
        f1 === true && f2 === false && sent.length === 1);

    // ─────────────────────────────────────────────────────────────
    // Part B — handleMessage wiring (end-to-end interactive turn)
    // ─────────────────────────────────────────────────────────────

    // B1: interim delivered before final, in order; interim no quote-reply, final quotes.
    let sawSendInterimFn = false;
    await turn('say BANANA, then use a tool', async (chatId, content, opts) => {
        sawSendInterimFn = typeof opts.sendInterim === 'function';
        await opts.sendInterim('BANANA');
        return 'Your heartbeat interval is 30 minutes';
    });
    ok('B1a interactive path wires a real sendInterim function', sawSendInterimFn);
    ok('B1b interim before final, in order',
        sent.length === 2
        && sent[0].text === 'BANANA' && sent[0].replyTo === null
        && sent[1].text === 'Your heartbeat interval is 30 minutes' && sent[1].replyTo === 7,
        JSON.stringify(sent));

    // B2: multiple DISTINCT interim strings across tool rounds are all delivered, in order.
    await turn('multi', async (chatId, content, opts) => {
        await opts.sendInterim('Let me check X');
        await opts.sendInterim('Now checking Y');
        return 'done';
    });
    ok('B2 distinct interims all delivered in order + final',
        sent.length === 3
        && sent[0].text === 'Let me check X'
        && sent[1].text === 'Now checking Y'
        && sent[2].text === 'done',
        JSON.stringify(sent));

    // B3: recovery replay — the SAME interim text emitted twice in one turn is sent once.
    await turn('recovery', async (chatId, content, opts) => {
        await opts.sendInterim('BANANA');   // round 1
        await opts.sendInterim('BANANA');   // reasoning-400 recovery re-emit
        return 'final';
    });
    ok('B3 duplicate interim (recovery replay) sent once',
        sent.length === 2 && sent[0].text === 'BANANA' && sent[1].text === 'final',
        JSON.stringify(sent));

    // B4: dedup resets on the next user turn (fresh Set per handleMessage call).
    await turn('turn-one', async (chatId, content, opts) => { await opts.sendInterim('SAME'); return 'a'; });
    const turnOneSent = sent.map(s => s.text);
    await turn('turn-two', async (chatId, content, opts) => { await opts.sendInterim('SAME'); return 'b'; });
    const turnTwoSent = sent.map(s => s.text);
    ok('B4 dedup resets across turns (SAME delivered in both turns)',
        turnOneSent[0] === 'SAME' && turnTwoSent[0] === 'SAME',
        JSON.stringify({ turnOneSent, turnTwoSent }));

    // B5: interim send FAILURE is logged + swallowed; the final reply still delivers.
    await turn('failing interim', async (chatId, content, opts) => {
        throwOnText = 'boom';               // deps.sendMessage throws for this exact text
        await opts.sendInterim('boom');     // must NOT abort the turn
        throwOnText = null;
        return 'final after failed interim';
    });
    ok('B5a interim failure did not abort → final reply delivered',
        sent.length === 1 && sent[0].text === 'final after failed interim' && sent[0].replyTo === 7,
        JSON.stringify(sent));
    ok('B5b interim failure logged (WARN)',
        logs.some(l => l.level === 'WARN' && /\[Interim\] send failed/.test(l.msg)));

    // B6: SILENT_REPLY-only final → nothing delivered (final path suppression via shared sanitizer).
    await turn('silent final', async () => '[[SILENT_REPLY]]');
    ok('B6 SILENT_REPLY-only final delivers nothing', sent.length === 0);

    // Cleanup
    try { fs.rmSync(tmpRoot, { recursive: true, force: true }); } catch (_) {}

    console.log('');
    if (failures === 0) {
        console.log('ALL TESTS PASS');
        process.exit(0);
    } else {
        console.log(`${failures} TEST(S) FAILED`);
        process.exit(1);
    }
})().catch((e) => {
    console.error('UNEXPECTED ERROR:', e && e.stack ? e.stack : e);
    process.exit(1);
});
