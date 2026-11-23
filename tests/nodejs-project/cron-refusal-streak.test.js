#!/usr/bin/env node
// cron-refusal-streak.test.js — BAT-1705 A2′ (contract v2.2, Codex sign-off 563398e8).
//
// A cron job whose agent turn the model keeps refusing notifies the owner once per
// streak. Pinned here against the REAL cron.js + REAL telegram.js plain path (only
// the HTTP transport, config and redaction are stubbed):
//   - the notice goes out as exactly ONE outbound request, measured on the actual
//     request payload, with a redaction that EXPANDS (an 8-char secret becomes
//     `[REDACTED:jupiterApiKey]`) and a long job label (Codex pin 1);
//   - a job is marked notified only on positive delivery evidence (a message id);
//     an unacknowledged, rejected or thrown send leaves it eligible on a later run,
//     with no second send in the same run;
//   - the streak resets only after a non-refused run's delivery succeeded (pin 2);
//   - an expired run (soft timeout) or a deleted job can never change the state,
//     whether its result or its send acknowledgement arrives late.
//
// Run:  node tests/nodejs-project/cron-refusal-streak.test.js

'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');

const BUNDLE = path.resolve(__dirname, '..', '..', 'app', 'src', 'main', 'assets', 'nodejs-project');
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'bat1705-cron-'));

const LOGS = [];
function _stub(rel, exports) {
    const resolved = require.resolve(path.join(BUNDLE, rel));
    require.cache[resolved] = { id: resolved, filename: resolved, loaded: true, exports };
}
_stub('config.js', {
    BOT_TOKEN: 'fake-token',
    workDir: TMP,
    log: (msg, level) => LOGS.push({ msg: String(msg), level: level || 'INFO' }),
    localTimestamp: () => '2026-11-23T00:00:00Z',
    getOwnerId: () => 'OWNER',
});
// An EXPANDING redaction, like a configured 8-character *ApiKey (security.js
// rebuildRedactPatterns): 8 chars in, 24 chars out.
const SECRET = 'AB12cd34';
const REDACTED = '[REDACTED:jupiterApiKey]';
_stub('security.js', { redactSecrets: (s) => (typeof s === 'string' ? s.split(SECRET).join(REDACTED) : s) });

// Telegram transport: records every Bot API request; behaviour per mode.
const REQUESTS = [];
let nextId = 1000;
let tgMode = 'ok'; // ok | noack | reject | throw
_stub('http.js', {
    httpRequest: async (opts, body) => {
        const method = opts.path.split('/').pop();
        const payload = body ? (typeof body === 'string' ? JSON.parse(body) : body) : {};
        if (method !== 'sendMessage') return { data: { ok: true, result: {} } };
        REQUESTS.push({ method, payload });
        if (tgMode === 'throw') throw new Error('ECONNRESET');
        if (tgMode === 'reject') return { data: { ok: false, error_code: 400, description: 'Bad Request: chat not found' } };
        if (tgMode === 'noack') return { data: { ok: true, result: {} } };
        return { data: { ok: true, result: { message_id: ++nextId } } };
    },
});

const telegram = require(path.join(BUNDLE, 'telegram.js'));
const cron = require(path.join(BUNDLE, 'cron.js'));
const { cronService } = cron;
const notice = require(path.join(BUNDLE, 'refusal-notice.js'));

let failures = 0;
function ok(label, cond, hint) {
    if (cond) console.log(`PASS: ${label}`);
    else { failures++; console.log(`FAIL: ${label}${hint ? ' — ' + hint : ''}`); }
}
function eq(label, a, e) { ok(label, JSON.stringify(a) === JSON.stringify(e), `\n  actual:   ${JSON.stringify(a)}\n  expected: ${JSON.stringify(e)}`); }
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

// ── wiring ──────────────────────────────────────────────────────────────────
const NORMAL_SENDS = [];
cron.setGetOwnerChatId(() => 'OWNER');
cron.setSendMessage(async (chatId, text) => { NORMAL_SENDS.push(text); return { messageId: ++nextId }; });
const realSystemSend = (chatId, text) => telegram.sendMessageSystem(chatId, text);
cron.setSendSystemMessage(realSystemSend);

let SCRIPT = [];
cron.setRunAgentTurn(async () => {
    const next = SCRIPT.shift();
    if (!next) throw new Error('script exhausted');
    return next();
});

const REFUSAL = (extra = {}) => ({ kind: 'model_refusal', category: null, modelMessage: null, dispatchedTools: 0, ...extra });
const refused = (r) => async () => ({ text: 'ignored notice text', refusal: r || REFUSAL() });
const textResult = (t) => async () => ({ text: t, refusal: null });
const silent = () => async () => ({ text: null, refusal: null });

function job(id, extra = {}) {
    return { id, name: `Job ${id}`, enabled: true, payload: { kind: 'agentTurn', message: 'do it' },
        schedule: { kind: 'every', everyMs: 3600000 }, state: {}, ...extra };
}
async function run(j) { await cronService._executeJob(j, Date.now()); }
const state = () => cron._refusalStateForTest();
const notified = (id) => state().notified.includes(id);

async function main() {
    cronService.store = { version: 1, jobs: [] };

    // ── 1. one outbound request, expanding redaction + long label (Codex pin 1)
    console.log('── one request at the channel boundary ──');
    {
        const j = job('one', { name: `Nightly ${SECRET} report ` + 'L'.repeat(400) });
        const huge = (`model says ${SECRET} `).repeat(400); // ~8k chars raw, longer redacted
        REQUESTS.length = 0; tgMode = 'ok';
        SCRIPT = [refused(REFUSAL({ modelMessage: huge }))];
        await run(j);
        eq('exactly one outbound request for the refusal notice', REQUESTS.length, 1);
        const sent = REQUESTS[0] ? REQUESTS[0].payload.text : '';
        ok('the actual request payload fits one plain request (≤ 1800 chars, redacted)', sent.length <= notice.CRON_NOTICE_MAX_CHARS, `len=${sent.length}`);
        ok('no secret survives into the request', !sent.includes(SECRET));
        ok('plain send (no parse_mode)', REQUESTS[0] && REQUESTS[0].payload.parse_mode === undefined);
        ok('the label is bounded and kept, plain (no Markdown asterisks)', /^\[Nightly \[REDACTED:jupiterApiKey\] report L+…\]\n\n/.test(sent), sent.slice(0, 120));
        ok('the model message is kept, truncated', sent.includes('model says') && sent.endsWith('…'));
        ok('acknowledged → notified', notified('one'));
        eq('no run left active', state().active, []);
    }

    // The prior-tool disclosure is never dropped to fit.
    {
        const txt = notice.buildCronRefusalNotice(
            { jobName: 'J'.repeat(500), refusal: REFUSAL({ modelMessage: (`x ${SECRET} `).repeat(2000) }), dispatchedTools: 2 },
            { redact: (s) => s.split(SECRET).join(REDACTED) },
        );
        ok('disclosure kept under the budget', txt.includes(notice.DISCLOSURE_DECLINED) && txt.includes(notice.RECOVERY_LINE) && txt.length <= 1800, `len=${txt.length}`);
        const f = notice.buildCronRefusalNotice({ jobName: 'J', refusal: { kind: 'provider_content_filter', modelMessage: 'leak' }, dispatchedTools: 0 });
        ok('a content filter surfaces no model message', f.includes(notice.NOTICE_FILTERED) && !f.includes('leak'));
        const c = notice.buildCronRefusalNotice({ jobName: 'a\nb\u0007c', refusal: REFUSAL() });
        ok('control characters never reach the label', c.startsWith('[a b c]\n\n'), c.slice(0, 20));
    }

    // ── 2. streak: suppress, reset after a successful non-refused run, notify again
    console.log('── streak lifecycle ──');
    {
        const j = job('streak');
        REQUESTS.length = 0; tgMode = 'ok';
        SCRIPT = [refused()]; await run(j);
        eq('first refusal sends', REQUESTS.length, 1);
        SCRIPT = [refused()]; await run(j);
        eq('second refusal is suppressed (no request)', REQUESTS.length, 1);
        ok('suppression logged', LOGS.some(l => /refusal notice suppressed \(streak\) job=streak/.test(l.msg)));
        SCRIPT = [silent()]; await run(j);
        ok('a silent non-refused completion resets the streak', !notified('streak'));
        SCRIPT = [refused()]; await run(j);
        eq('the next refusal notifies again', REQUESTS.length, 2);
        SCRIPT = [textResult('all good')]; await run(j);
        ok('a delivered non-refused result resets the streak', !notified('streak'));
    }
    {
        // Codex connector on #472: a normal send that resolves WITHOUT a message id
        // (the real Telegram/Discord senders do this after a rejected send) is not a
        // confirmed delivery, so it must not reset the streak.
        const j = job('noack-normal');
        REQUESTS.length = 0; tgMode = 'ok';
        SCRIPT = [refused()]; await run(j);
        ok('precondition: notified', notified('noack-normal'));
        cron.setSendMessage(async () => undefined);
        SCRIPT = [textResult('answer')]; await run(j);
        ok('an unconfirmed normal delivery does not reset the streak', notified('noack-normal'));
        cron.setSendMessage(async () => ({}));
        SCRIPT = [textResult('answer')]; await run(j);
        ok('…nor does a resolved {} without an id', notified('noack-normal'));
        cron.setSendMessage(async (chatId, text) => { NORMAL_SENDS.push(text); return { messageId: ++nextId }; });
        SCRIPT = [textResult('answer')]; await run(j);
        ok('a confirmed normal delivery resets it', !notified('noack-normal'));
    }

    // ── 3. acknowledgement evidence
    console.log('── positive delivery evidence ──');
    for (const [label, mode, sender] of [
        ['Telegram resolves with no message id', 'noack', null],
        ['Telegram rejects (ok:false)', 'reject', null],
        ['the send throws', 'throw', null],
        ['sender resolves {}', 'ok', async () => ({})],
        ['sender resolves { delivered: true } without an id', 'ok', async () => ({ delivered: true })],
        ['sender resolves undefined', 'ok', async () => undefined],
    ]) {
        const j = job(`ack-${mode}-${sender ? 'custom' : 'tg'}-${label.length}`);
        REQUESTS.length = 0; tgMode = mode;
        let customCalls = 0;
        cron.setSendSystemMessage(sender ? async (...a) => { customCalls++; return sender(...a); } : realSystemSend);
        SCRIPT = [refused()]; await run(j);
        const sends = sender ? customCalls : REQUESTS.length;
        eq(`${label}: one attempt, no retry in the same run`, sends, 1);
        ok(`${label}: not marked notified`, !notified(j.id));
        // Next refused run is still eligible.
        tgMode = 'ok'; cron.setSendSystemMessage(realSystemSend); REQUESTS.length = 0;
        SCRIPT = [refused()]; await run(j);
        eq(`${label}: a later refusal sends again`, REQUESTS.length, 1);
        ok(`${label}: and that confirmed send marks it`, notified(j.id));
    }
    cron.setSendSystemMessage(realSystemSend); tgMode = 'ok';

    // ── 4. two jobs keep separate streaks
    {
        const a = job('jobA'), b = job('jobB');
        REQUESTS.length = 0;
        SCRIPT = [refused()]; await run(a);
        SCRIPT = [refused()]; await run(b);
        eq('each job notifies once', REQUESTS.length, 2);
        SCRIPT = [silent()]; await run(a);
        ok('resetting A leaves B notified', !notified('jobA') && notified('jobB'));
    }

    // ── 5. soft timeout: late results / late acks with NO successor run
    console.log('── expired runs ──');
    const realTimeout = cronService.AGENT_TURN_TIMEOUT_MS;
    cronService.AGENT_TURN_TIMEOUT_MS = 60;
    {
        // Late refused RESULT: the send is never started.
        const j = job('late-result');
        REQUESTS.length = 0;
        SCRIPT = [async () => { await sleep(300); return { text: 'n', refusal: REFUSAL() }; }];
        await run(j); // returns at the timeout
        await sleep(450);
        eq('a refused result after the timeout starts no send', REQUESTS.length, 0);
        ok('and changes no state', !notified('late-result') && !state().active.includes('late-result'));
        ok('logged as expired', LOGS.some(l => /refusal after run expired, not sent job=late-result/.test(l.msg)));
    }
    {
        // Late non-refused RESULT does not reset an existing streak.
        const j = job('late-text');
        cronService.AGENT_TURN_TIMEOUT_MS = realTimeout;
        SCRIPT = [refused()]; await run(j);
        ok('precondition: notified', notified('late-text'));
        cronService.AGENT_TURN_TIMEOUT_MS = 60;
        SCRIPT = [async () => { await sleep(300); return { text: 'late answer', refusal: null }; }];
        const before = NORMAL_SENDS.length;
        await run(j); await sleep(450);
        ok('the late non-refused result is still delivered (unchanged behaviour)', NORMAL_SENDS.slice(before).some(t => t.includes('late answer')));
        ok('but does not reset the streak', notified('late-text'));
    }
    {
        // Late ACK with no successor: the send started in time, its ack lands after expiry.
        const j = job('late-ack');
        cron.setSendSystemMessage(async () => { await sleep(300); return { messageId: 1 }; });
        SCRIPT = [refused()];
        await run(j); await sleep(450);
        ok('a late acknowledgement after the timeout marks nothing', !notified('late-ack'));
        eq('no run left active', state().active.includes('late-ack'), false);
        cron.setSendSystemMessage(realSystemSend);
    }
    {
        // Non-refused result whose delivery HANGS past the timeout: no reset (Codex pin 2).
        const j = job('hang-send');
        cronService.AGENT_TURN_TIMEOUT_MS = realTimeout;
        SCRIPT = [refused()]; await run(j);
        ok('precondition: notified', notified('hang-send'));
        cronService.AGENT_TURN_TIMEOUT_MS = 60;
        cron.setSendMessage(async () => { await sleep(300); return { messageId: 2 }; });
        SCRIPT = [textResult('slow delivery')];
        await run(j); await sleep(450);
        ok('a non-refused run whose send outlives the timeout does not reset', notified('hang-send'));
        cron.setSendMessage(async (chatId, text) => { NORMAL_SENDS.push(text); return { messageId: ++nextId }; });
    }
    {
        // Late ACK while a SUCCESSOR run is still being awaited (reviewer on the first
        // draft: B must be live when A's ack lands, or a plain "is a run active" flag
        // would pass too). Only token identity keeps A's ack off B's streak.
        const j = job('successor');
        cron.setSendSystemMessage(async () => { await sleep(300); return { messageId: 3 }; });
        SCRIPT = [refused()];
        await run(j); // run A expires at 60 ms; its send is still in flight
        cron.setSendSystemMessage(realSystemSend);
        cronService.AGENT_TURN_TIMEOUT_MS = realTimeout;
        let releaseB;
        SCRIPT = [() => new Promise(r => { releaseB = () => r({ text: 'n', refusal: REFUSAL() }); })];
        const b = run(j); // run B: awaited (its turn is blocked) when A's ack lands
        await sleep(450);
        ok('precondition: B is the live run', state().active.includes('successor'));
        ok("an old run's late ack never marks the live successor's streak", !notified('successor'));
        REQUESTS.length = 0;
        releaseB(); await b;
        eq('the successor then sends its own notice', REQUESTS.length, 1);
        ok('and marks its own streak', notified('successor'));
        cronService.AGENT_TURN_TIMEOUT_MS = 60;
    }
    cronService.AGENT_TURN_TIMEOUT_MS = realTimeout;

    // ── 6. deletion
    console.log('── deletion ──');
    {
        const j = job('deleted');
        cronService.store.jobs.push(j);
        let release;
        cron.setSendSystemMessage(() => new Promise(r => { release = () => r({ messageId: 4 }); }));
        SCRIPT = [refused()];
        const p = run(j);
        await sleep(30);
        ok('the run is active while its send is in flight', state().active.includes('deleted'));
        cronService.remove('deleted');
        release(); await p;
        eq('a deleted job is never re-created by its in-flight ack', { n: notified('deleted'), a: state().active.includes('deleted') }, { n: false, a: false });
        cron.setSendSystemMessage(realSystemSend);
    }
    {
        const j = job('once', { schedule: { kind: 'at', atMs: Date.now() }, deleteAfterRun: true });
        cronService.store.jobs.push(j);
        SCRIPT = [refused()];
        await run(j);
        ok('deleteAfterRun removes the job', !cronService.store.jobs.includes(j));
        ok('and clears its refusal state', !notified('once') && !state().active.includes('once'));
    }

    // ── 7. drift guards
    {
        const tg = fs.readFileSync(path.join(BUNDLE, 'telegram.js'), 'utf8');
        const m = tg.match(/const CHUNK_MAX = (\d+)/);
        ok('the cron budget fits one Telegram chunk and one Discord message',
            m && notice.CRON_NOTICE_MAX_CHARS <= Math.min(Number(m[1]), 2000), m && m[1]);
        const cronSrc = fs.readFileSync(path.join(BUNDLE, 'cron.js'), 'utf8');
        ok('notified is set only after a message id, and only while live',
            /res\.messageId != null\)\s*\{\s*if \(isLive\(\)\) refusalStreaks\.set/.test(cronSrc));
        const mainSrc = fs.readFileSync(path.join(BUNDLE, 'main.js'), 'utf8');
        ok('main.js wires the plain system send into cron', /setSendSystemMessage\(\(chatId, text\) => channel\.sendMessageSystem\(chatId, text\)\)/.test(mainSrc));
    }

    try { fs.rmSync(TMP, { recursive: true, force: true }); } catch (_) {}
    console.log(`\n${failures === 0 ? 'All' : failures + ' FAILED of'} cron refusal-streak checks${failures === 0 ? ' passed' : ''}.`);
    process.exit(failures === 0 ? 0 : 1);
}

main().catch((e) => { console.error(e); process.exit(1); });
