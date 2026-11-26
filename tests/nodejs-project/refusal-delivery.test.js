#!/usr/bin/env node
// refusal-delivery.test.js — BAT-1705, Codex code review 2b68f44a #3.
//
// A refusal notice must reach the user as composed. The model's own refusal text
// (and, for cron, the job label) could otherwise contain something the delivery
// path's cleanup strips: an unclosed `<think>` strips to the end of the message,
// a `[[reply_to_current]]` / HEARTBEAT_OK / SILENT_REPLY reply is dropped before
// send. The turn would then end silent, which is the bug BAT-1705 exists to fix.
//
// Pinned against the REAL delivery path: message-handler.js `deliverAgentText` →
// REAL telegram.js `sendMessage` (cleanResponse, redaction, HTML) → a recorded Bot
// API request. Only config / http / security / web are stubbed.
//
// Run:  node tests/nodejs-project/refusal-delivery.test.js

'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');

const BUNDLE = path.resolve(__dirname, '..', '..', 'app', 'src', 'main', 'assets', 'nodejs-project');
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'bat1705-delivery-'));

function _stub(rel, exports) {
    const resolved = require.resolve(path.join(BUNDLE, rel));
    require.cache[resolved] = { id: resolved, filename: resolved, loaded: true, exports };
}
_stub('config.js', {
    BOT_TOKEN: 'fake-token',
    RICH_MESSAGES_ENABLED: false,
    CHANNEL: 'telegram',
    workDir: TMP,
    PROVIDER: 'claude',
    AUTH_TYPE: 'api_key',
    OPENAI_AUTH_TYPE: 'api_key',
    APP_VERSION: 'test',
    resolveActiveModel: () => 'claude-opus-5-5',
    runtimeState: { read: () => ({}), write: () => {} },
    config: {},
    log: () => {},
    localTimestamp: () => '2026-11-26T00:00:00Z',
    getOwnerId: () => 'OWNER',
});
_stub('security.js', { redactSecrets: (s) => s });
_stub('web.js', { isBlockedAddress: () => false });

const REQUESTS = [];
let nextId = 5000;
_stub('http.js', {
    httpRequest: async (opts, body) => {
        const method = opts.path.split('/').pop();
        const payload = body ? (typeof body === 'string' ? JSON.parse(body) : body) : {};
        if (method === 'sendMessage') REQUESTS.push(payload);
        return { data: { ok: true, result: { message_id: ++nextId } } };
    },
});

const telegram = require(path.join(BUNDLE, 'telegram.js'));
const mh = require(path.join(BUNDLE, 'message-handler.js'));
const notice = require(path.join(BUNDLE, 'refusal-notice.js'));
const { TOKEN: SILENT_REPLY_TOKEN } = require(path.join(BUNDLE, 'silent-reply.js'));
if (typeof SILENT_REPLY_TOKEN !== 'string' || !SILENT_REPLY_TOKEN) throw new Error('silent-reply.js TOKEN export missing');

mh.init({ log: () => {}, sendMessage: (chatId, text, replyTo) => telegram.sendMessage(chatId, text, replyTo) });

let failures = 0;
function ok(label, cond, hint) {
    if (cond) console.log(`PASS: ${label}`);
    else { failures++; console.log(`FAIL: ${label}${hint ? ' — ' + hint : ''}`); }
}

// Telegram HTML escapes only &, < and >; compare on the unescaped request text.
const unescape = (s) => String(s).replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&');
const DECLINED_MARK = 'the model declined this request';
const DISCLOSURE_MARK = 'Some actions may already have taken effect';

/** Build the user-turn notice, deliver it through the real path, return the one request's text. */
async function deliver(refusal, dispatchedTools = 0) {
    REQUESTS.length = 0;
    const text = notice.buildRefusalNotice(refusal, dispatchedTools);
    const sent = await mh.deliverAgentText('OWNER', text, 1, 1);
    return { text, sent, count: REQUESTS.length, out: REQUESTS[0] ? unescape(REQUESTS[0].text) : '' };
}
const R = (modelMessage) => ({ kind: 'model_refusal', category: null, modelMessage });

async function main() {
    console.log('── user turn: model text the cleanup would erase ──');
    const erasing = [
        ['an unclosed <think>', '<think>'],
        ['a closed reasoning block only', '<thinking>internal plan</thinking>'],
        ['a [[reply_to_current]] tag only', '[[reply_to_current]]'],
        ['HEARTBEAT_OK only', 'HEARTBEAT_OK'],
        ['the SILENT_REPLY token', SILENT_REPLY_TOKEN],
        ['a [Historical context:] marker only', '[Historical context: earlier turn]'],
    ];
    for (const [label, msg] of erasing) {
        const d = await deliver(R(msg));
        ok(`${label}: exactly one request is sent`, d.sent === true && d.count === 1, `sent=${d.sent} count=${d.count}`);
        ok(`${label}: the fixed notice is what arrives`, d.out.includes(DECLINED_MARK), d.out.slice(0, 120));
    }
    {
        const d = await deliver(R("I can't help with that. <think>reasoning that never closes"));
        ok('visible text before an unclosed <think> is kept, the tag is not', d.count === 1 && d.out === "I can't help with that.", JSON.stringify(d.out));
    }
    {
        const d = await deliver(R('Sorry, I can only help with lawful requests.'));
        ok('an ordinary refusal message arrives exactly as composed', d.count === 1 && d.out === d.text, JSON.stringify(d.out));
    }

    console.log('── user turn: prior-tool disclosure is never lost ──');
    {
        const d = await deliver(R('<think>'), 2);
        ok('an erasing message after tools: the disclosure arrives', d.count === 1 && d.out.includes(DISCLOSURE_MARK) && d.out.includes(notice.RECOVERY_LINE), d.out.slice(0, 160));
        ok('…and nothing from the model is appended', d.out === `${notice.DISCLOSURE_DECLINED}\n\n${notice.RECOVERY_LINE}`, JSON.stringify(d.out));
    }
    {
        // Model text that interacts with the fixed lines (the repeated-line collapse
        // would rewrite the composed notice): dropped, so what arrives is what was composed.
        const echo = [notice.RECOVERY_LINE, notice.RECOVERY_LINE, 'a', 'b', 'c'].join('\n');
        const d = await deliver(R(echo), 1);
        ok('model text that would be rewritten by the cleanup is dropped', d.text === `${notice.DISCLOSURE_DECLINED}\n\n${notice.RECOVERY_LINE}`, JSON.stringify(d.text));
        ok('…and the delivered request equals the composed notice', d.count === 1 && d.out === d.text, JSON.stringify(d.out));
    }

    console.log('── fixed wording always survives the delivery cleanup ──');
    for (const [name, s] of [
        ['NOTICE_DECLINED', notice.NOTICE_DECLINED],
        ['NOTICE_FILTERED', notice.NOTICE_FILTERED],
        ['declined disclosure', `${notice.DISCLOSURE_DECLINED}\n\n${notice.RECOVERY_LINE}`],
        ['filtered disclosure', `${notice.DISCLOSURE_FILTERED}\n\n${notice.RECOVERY_LINE}`],
    ]) ok(`${name} survives unchanged`, notice.survivesDelivery(s));

    console.log(failures ? `\n${failures} FAILED of refusal delivery checks.` : '\nAll refusal delivery checks passed.');
    fs.rmSync(TMP, { recursive: true, force: true });
    process.exit(failures ? 1 : 0);
}

main().catch(e => { console.error(e); process.exit(1); });
