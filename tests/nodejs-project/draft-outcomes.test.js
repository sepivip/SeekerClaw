#!/usr/bin/env node
// draft-outcomes.test.js — BAT-1409 P1-H: the agent's SMS and calls are notification drafts.
//
// Pins:
//   tools/android.js
//     - android_sms / android_call send the user's input to /sms and /call, and map the bridge's
//       answer (AndroidBridge.draftResponse; a 429 carries code "rate_limited") to exactly one
//       outcome with fixed wording;
//     - `posted` uses the contract wording verbatim, and no message ever says "sent", "opened",
//       "calling" or "called";
//     - every refusal says no draft was created; the notification refusals point to
//       SeekerClaw → Settings → Notifications;
//     - a transport failure is not a draft outcome: no `outcome`, the bridge error is kept;
//     - scheduled tasks (`cron:*`) and heartbeat probes get outcome `unattended` and never reach the
//       bridge (before P1-H their confirmation step always refused SMS and calls);
//     - the tool descriptions describe drafts, not sending or dialling, and claim no confirmation.
//   Drift guard against the PRODUCER: every code in the Kotlin DraftNotifier.Outcome enum (plus
//     rate_limited) has its own branch in draftResult and its own row in DIAGNOSTICS.md.
//   tool-rate-limit.js
//     - drafts run without confirmation but keep their 1-per-60s limit, and only a posted draft
//       counts, so a refused draft can be retried at once;
//     - another tool on the no-confirm path (a burner action under cap) is never rate-limited;
//     - the confirm path's refusal keeps its text and gains code "rate_limited";
//     - ai.js uses these helpers on both paths.
//
// Run:  node tests/nodejs-project/draft-outcomes.test.js

'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const ROOT = path.resolve(__dirname, '..', '..');
const BUNDLE = path.join(ROOT, 'app', 'src', 'main', 'assets', 'nodejs-project');

// ── Stub config.js (never booted without a scratch workDir), the bridge and ai.js ──
const workDir = fs.mkdtempSync(path.join(os.tmpdir(), 'bat1409-drafts-'));
function stub(rel, exports) {
    const full = path.join(BUNDLE, rel);
    require.cache[full] = { id: full, filename: full, loaded: true, exports };
}
stub('config.js', { workDir, log: () => {} });
const bridgeCalls = [];
let bridgeReply = null;
stub('bridge.js', {
    androidBridgeCall: async (endpoint, data) => {
        bridgeCalls.push({ endpoint, data });
        return bridgeReply;
    },
});
stub('ai.js', { visionAnalyzeImage: async () => ({}) });

const { tools, handlers, draftResult } = require(path.join(BUNDLE, 'tools', 'android.js'));
const { RATE_LIMITED_WITHOUT_CONFIRM, rateLimitRefusal, runWithoutConfirm } = require(path.join(BUNDLE, 'tool-rate-limit.js'));

const FORBIDDEN = /\b(sent|opened|calling|called)\b/i;
const SETTINGS = 'SeekerClaw → Settings → Notifications';
const SMS_POSTED = "I've put the message in the notifications on the phone running SeekerClaw — tap it to open your SMS app and send.";
const CALL_POSTED = "I've put the call in the notifications on the phone running SeekerClaw — tap it to dial.";

let passed = 0;
async function test(name, fn) {
    try {
        await fn();
        passed++;
    } catch (e) {
        console.error(`FAIL: ${name}\n  ${e.message}`);
        process.exitCode = 1;
    }
}

// The outcome codes the Kotlin producer can emit (DraftNotifier.Outcome), read from its source.
const notifierSrc = fs.readFileSync(path.join(ROOT, 'app/src/main/java/com/seekerclaw/app/bridge/DraftNotifier.kt'), 'utf8');
const KOTLIN_OUTCOMES = [...notifierSrc.matchAll(/^\s+[A-Z_]+\("([a-z_]+)"\),?$/gm)].map((m) => m[1]);
// Node-only outcomes: rate_limited (bridge 429 or the Node limit) and unattended (tools/android.js).
const ALL_OUTCOMES = [...KOTLIN_OUTCOMES, 'rate_limited', 'unattended'];

(async () => {
    await test('the Kotlin enum yields the six draft outcomes (the drift guard reads a real list)', () => {
        assert.deepStrictEqual(KOTLIN_OUTCOMES.slice().sort(), [
            'channel_blocked', 'invalid_recipient', 'no_handler', 'notifications_disabled', 'notifications_paused', 'posted',
        ]);
    });

    await test('android_sms sends phone + message to /sms and relays the posted wording verbatim', async () => {
        bridgeCalls.length = 0;
        bridgeReply = { success: true, outcome: 'posted' };
        const r = await handlers.android_sms({ phone: '+1 555 123 4567', message: 'running late' }, 1);
        assert.deepStrictEqual(bridgeCalls, [{ endpoint: '/sms', data: { phone: '+1 555 123 4567', message: 'running late' } }]);
        assert.deepStrictEqual(r, { success: true, outcome: 'posted', message: SMS_POSTED });
    });

    await test('android_call sends the phone to /call and relays the posted wording verbatim', async () => {
        bridgeCalls.length = 0;
        bridgeReply = { success: true, outcome: 'posted' };
        const r = await handlers.android_call({ phone: '+15551234567' }, 1);
        assert.deepStrictEqual(bridgeCalls, [{ endpoint: '/call', data: { phone: '+15551234567' } }]);
        assert.deepStrictEqual(r, { success: true, outcome: 'posted', message: CALL_POSTED });
    });

    await test('every refusal from the bridge maps to its own outcome and says no draft was created', async () => {
        for (const kind of ['sms', 'call']) {
            for (const outcome of KOTLIN_OUTCOMES.filter((o) => o !== 'posted')) {
                bridgeReply = { error: outcome, outcome }; // DraftNotifier.reply, 400/409 (pinned by SmsCallDraftsTest)
                const r = await handlers[kind === 'sms' ? 'android_sms' : 'android_call']({ phone: '5551234', message: 'x' }, 1);
                assert.strictEqual(r.outcome, outcome, `${kind}/${outcome}`);
                assert.strictEqual(r.error, outcome, `${kind}/${outcome}`);
                assert.ok(!r.success, `${kind}/${outcome} must not report success`);
                assert.ok(r.message.startsWith(`No ${kind === 'sms' ? 'message' : 'call'} draft was created: `), r.message);
            }
        }
    });

    await test('the notification refusals point to SeekerClaw → Settings → Notifications', () => {
        for (const outcome of ['notifications_disabled', 'notifications_paused', 'channel_blocked']) {
            assert.ok(draftResult('sms', { error: outcome, outcome }).message.includes(SETTINGS), outcome);
        }
    });

    await test('the bridge 429 (code rate_limited) maps to outcome rate_limited', () => {
        const r = draftResult('sms', { error: 'Rate limit exceeded for /sms', code: 'rate_limited' });
        assert.strictEqual(r.outcome, 'rate_limited');
        assert.strictEqual(r.error, 'rate_limited');
        assert.match(r.message, /^No message draft was created: too many drafts/);
    });

    await test('a transport failure is not a draft outcome: no outcome, bridge error kept', () => {
        for (const reply of [{ error: 'Android Bridge unavailable: connect ECONNREFUSED' }, { error: 'phone and message are required' }, null]) {
            const r = draftResult('call', reply);
            assert.strictEqual(r.outcome, undefined, JSON.stringify(reply));
            assert.strictEqual(r.error, (reply && reply.error) || 'draft_failed');
            assert.ok(r.message.startsWith('No call draft was created: '), r.message);
        }
    });

    await test('scheduled tasks and heartbeat probes never reach the bridge (outcome unattended)', async () => {
        bridgeReply = { success: true, outcome: 'posted' };
        for (const chatId of ['cron:job-123', 'cron:', '__heartbeat__']) {
            for (const name of ['android_sms', 'android_call']) {
                bridgeCalls.length = 0;
                const r = await handlers[name]({ phone: '+15551234567', message: 'x' }, chatId);
                assert.deepStrictEqual(bridgeCalls, [], `${name} in ${chatId} reached the bridge`);
                assert.strictEqual(r.outcome, 'unattended', `${name} in ${chatId}`);
                assert.strictEqual(r.error, 'unattended');
                assert.ok(!r.success);
                assert.match(r.message, /only drafted when the user asks in chat/);
            }
        }
    });

    await test('live chats draft normally: Telegram numeric ids and Discord string ids', async () => {
        bridgeReply = { success: true, outcome: 'posted' };
        for (const chatId of [123456789, -1001234567890, '987654321098765432', 'telegram-chat']) {
            bridgeCalls.length = 0;
            const r = await handlers.android_call({ phone: '+15551234567' }, chatId);
            assert.strictEqual(bridgeCalls.length, 1, `chat ${chatId}`);
            assert.strictEqual(r.outcome, 'posted', `chat ${chatId}`);
        }
    });

    await test('no draft message ever says "sent", "opened", "calling" or "called"', () => {
        for (const kind of ['sms', 'call']) {
            for (const outcome of ALL_OUTCOMES) {
                const { message } = draftResult(kind, { error: outcome, outcome });
                assert.ok(!FORBIDDEN.test(message), `${kind}/${outcome}: ${message}`);
            }
        }
    });

    await test('DIAGNOSTICS.md has a row for every outcome, and draftResult a branch for each', () => {
        const diag = fs.readFileSync(path.join(BUNDLE, 'DIAGNOSTICS.md'), 'utf8');
        for (const outcome of ALL_OUTCOMES) {
            assert.ok(diag.includes('| `' + outcome + '` |'), `DIAGNOSTICS.md has no row for ${outcome}`);
            assert.strictEqual(draftResult('sms', { error: outcome, outcome }).outcome, outcome, `draftResult has no branch for ${outcome}`);
        }
        assert.ok(diag.includes('### `needs_foreground`'), 'DIAGNOSTICS.md documents needs_foreground');
    });

    await test('tool descriptions describe drafts, not sending or dialling, and claim no confirmation', () => {
        for (const name of ['android_sms', 'android_call']) {
            const t = tools.find((x) => x.name === name);
            assert.ok(t, name);
            assert.match(t.description, /^Draft /, name);
            assert.ok(t.description.includes('notifications on the phone running SeekerClaw'), name);
            assert.ok(!/Confirmation-gated|SEND_SMS|CALL_PHONE|Send an SMS|Place a phone call/.test(t.description), name);
        }
    });

    // ── tool-rate-limit.js ──────────────────────────────────────────────────
    const limits = { android_sms: 60000, android_call: 60000, solana_send: 15000 };
    const logs = [];
    const log = (msg, level) => logs.push({ level, msg });

    await test('only android_sms and android_call are rate-limited off the confirm path', () => {
        assert.deepStrictEqual([...RATE_LIMITED_WITHOUT_CONFIRM].sort(), ['android_call', 'android_sms']);
        const configSrc = fs.readFileSync(path.join(BUNDLE, 'config.js'), 'utf8');
        assert.match(configSrc, /'android_sms': 60000,/);
        assert.match(configSrc, /'android_call': 60000,/);
    });

    await test('a posted draft counts; the next one inside 60s is refused without running', async () => {
        const last = new Map();
        let runs = 0;
        const exec = async () => { runs++; return { success: true, outcome: 'posted' }; };
        assert.strictEqual((await runWithoutConfirm('android_sms', exec, { limits, lastToolUseTime: last, log })).outcome, 'posted');
        assert.ok(last.has('android_sms'));
        const r = await runWithoutConfirm('android_sms', exec, { limits, lastToolUseTime: last, log });
        assert.strictEqual(runs, 1, 'the refused draft never reached the bridge');
        assert.strictEqual(r.outcome, 'rate_limited');
        assert.strictEqual(r.code, 'rate_limited');
        assert.match(r.error, /^Rate limited: android_sms can only be used once per 60s\. Try again in \d+s\.$/);
        // Like every other draft outcome, the refusal carries a message to relay.
        assert.ok(r.message.startsWith('No message draft was created: too many drafts in a short time. Rate limited:'), r.message);
        assert.ok(!FORBIDDEN.test(r.message), r.message);
        assert.ok(logs.some((l) => l.level === 'WARN' && l.msg.startsWith('[RateLimit] android_sms blocked')));
        // The call window is separate.
        assert.strictEqual((await runWithoutConfirm('android_call', exec, { limits, lastToolUseTime: last, log })).outcome, 'posted');
        assert.strictEqual(runs, 2);
    });

    await test('a refused draft does not count, so it can be retried at once', async () => {
        const last = new Map();
        let runs = 0;
        const exec = async () => { runs++; return { error: 'notifications_disabled', outcome: 'notifications_disabled' }; };
        await runWithoutConfirm('android_call', exec, { limits, lastToolUseTime: last, log });
        await runWithoutConfirm('android_call', exec, { limits, lastToolUseTime: last, log });
        assert.strictEqual(runs, 2);
        assert.ok(!last.has('android_call'));
    });

    await test('the window expires after 60s', async () => {
        const last = new Map([['android_sms', Date.now() - 60001]]);
        let runs = 0;
        await runWithoutConfirm('android_sms', async () => { runs++; return { outcome: 'posted' }; }, { limits, lastToolUseTime: last, log });
        assert.strictEqual(runs, 1);
    });

    await test('a burner action under cap (no-confirm path) is never rate-limited', async () => {
        const recent = Date.now();
        const last = new Map([['solana_send', recent]]);
        let runs = 0;
        await runWithoutConfirm('solana_send', async () => { runs++; return { success: true }; }, { limits, lastToolUseTime: last, log });
        assert.strictEqual(runs, 1);
        assert.strictEqual(last.get('solana_send'), recent, 'the no-confirm path does not record other tools');
    });

    await test('the confirm-path refusal keeps its text and gains code rate_limited', () => {
        const now = 1_000_000;
        const r = rateLimitRefusal('solana_send', limits, new Map([['solana_send', now - 5000]]), log, now);
        assert.deepStrictEqual(r, { error: 'Rate limited: solana_send can only be used once per 15s. Try again in 10s.', code: 'rate_limited' });
        assert.strictEqual(rateLimitRefusal('solana_send', limits, new Map([['solana_send', now - 15000]]), log, now), null);
        assert.strictEqual(rateLimitRefusal('memory_save', limits, new Map([['memory_save', now]]), log, now), null);
        assert.strictEqual(rateLimitRefusal('solana_send', limits, null, log, now), null);
    });

    await test('ai.js uses the helpers on both paths', () => {
        const ai = fs.readFileSync(path.join(BUNDLE, 'ai.js'), 'utf8');
        assert.match(ai, /rateLimitRefusal\(toolUse\.name, TOOL_RATE_LIMITS, _deps\.lastToolUseTime, log\)/);
        assert.match(ai, /result = await runWithoutConfirm\(toolUse\.name, async \(\) => \{/);
    });

    fs.rmSync(workDir, { recursive: true, force: true });
    if (process.exitCode) {
        console.error('\ndraft-outcomes.test.js FAILED');
    } else {
        console.log(`PASS: draft-outcomes.test.js (${passed} checks)`);
    }
})();
