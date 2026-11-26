#!/usr/bin/env node
// refusal-chat.test.js — BAT-1705 D2–D5 + v2.1 A1/A3/A5 (Codex sign-off 563398e8).
//
// Drives the REAL chat() (ai.js + providers + refusal-notice) with only I/O edges
// stubbed (transport, tools, confirmation, task-store observed). Pins:
//   - a refused response is never pushed, executed, interim-sent or summarised;
//     the turn returns the notice and history holds it (not "[No response generated]");
//   - the notice discloses prior actions only when tools were actually DISPATCHED
//     (denied calls don't count; a tool that threw does), with the filter wording
//     for a content filter;
//   - a refused closing summary is handled like a refused round;
//   - a heartbeat stays silent and writes no notice;
//   - one WARN [Trace] with reason / allowlisted category / counts and no text;
//   - onTurnOutcome fires exactly once per non-throwing turn;
//   - task + checkpoints are cleared (a refused task is not resumable);
//   - regression: a plain empty end_turn is still the silent reply.
//
// Run:  node tests/nodejs-project/refusal-chat.test.js

'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');

const BUNDLE = path.resolve(__dirname, '..', '..', 'app', 'src', 'main', 'assets', 'nodejs-project');
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'bat1705-chat-'));
const TASKS_DIR = path.join(TMP, 'tasks');
fs.mkdirSync(TASKS_DIR, { recursive: true });

const LOGS = [];
function log(msg, level) { LOGS.push({ msg: String(msg), level: level || 'INFO' }); }
function _stub(rel, exports) {
    const resolved = require.resolve(path.join(BUNDLE, rel));
    require.cache[resolved] = { id: resolved, filename: resolved, loaded: true, exports };
}

let currentModel = 'claude-opus-5';
_stub('config.js', {
    workDir: TMP, TASKS_DIR,
    MODEL: 'claude-opus-5', resolveActiveModel: () => currentModel,
    PROVIDER: 'claude', CHANNEL: 'telegram',
    ANTHROPIC_KEY: 'sk-ant-test-key', OPENAI_KEY: '', XAI_KEY: '', OPENROUTER_KEY: 'sk-or-test', CUSTOM_KEY: '',
    CUSTOM_BASE_URL: '', CUSTOM_FORMAT: '', OPENROUTER_FALLBACK_MODEL: '',
    OPENROUTER_MODEL_CONTEXT: 0, OPENROUTER_FALLBACK_CONTEXT: 0,
    AUTH_TYPE: 'api_key', OPENAI_AUTH_TYPE: 'api_key',
    REACTION_GUIDANCE: 'on', REACTION_NOTIFICATIONS: 'on', MEMORY_DIR: path.join(TMP, 'memory'),
    TOOL_RATE_LIMITS: {}, TOOL_STATUS_MAP: {}, RICH_MESSAGES_ENABLED: false,
    API_TIMEOUT_RETRIES: 0, API_TIMEOUT_BACKOFF_MS: 10, API_TIMEOUT_MAX_BACKOFF_MS: 10,
    truncateToolResult: (s) => s,
    localTimestamp: () => '2026-11-23T00:00:00Z',
    localDateStr: () => '2026-11-23',
    log,
    getOwnerId: () => 'OWNER',
    USER_ENV_KEYS: [],
    config: { agentName: 'TestAgent', jupiterApiKey: '' },
    runtimeState: { read: () => ({ reasoningEnabled: false, reasoningDisplayInChat: false }) },
});
// A registered secret, as security.js redacts a configured *ApiKey (literal match).
const SECRET = 'SECRETTOKEN_abcdefghij';
_stub('security.js', { redactSecrets: (s) => (typeof s === 'string' ? s.split(SECRET).join('[REDACTED:testApiKey]') : s) });
_stub('channel.js', { sendMessage: async () => {}, sendTyping: () => {}, getOwnerChatId: () => 'OWNER' });
_stub('telegram.js', {
    sentMessageCache: new Map(), SENT_CACHE_TTL: 60000,
    deferStatus: () => ({ cleanup: async () => {} }),
    deferThinkingStatus: () => ({ cleanup: async () => {} }),
});
_stub('bridge.js', { androidBridgeCall: async () => ({ error: 'mocked' }), fetchMcpToken: async () => '' });
_stub('memory.js', {
    loadSoul: () => '', loadBootstrap: () => '', loadIdentity: () => '', loadUser: () => '',
    loadMemory: () => '', loadDailyMemory: () => '',
});
_stub('skills.js', { findMatchingSkills: () => [], loadSkills: () => [] });
_stub('database.js', {
    getDb: () => null, markDbDirty: () => {}, markDbSummaryDirty: () => {}, indexMemoryFiles: () => {},
    saveSession: () => {}, getRecentSessions: () => [],
});
let policyNow = 'none';
_stub('confirmation/index.js', {
    getConfirmationPolicy: () => policyNow,
    normalizePolicy: (r) => (typeof r === 'string' ? { policy: r } : r),
});
_stub('wallet/index.js', { getWalletState: async () => ({ burnerConfigured: false }) });

const claude = require(path.join(BUNDLE, 'providers', 'claude.js'));
const openrouter = require(path.join(BUNDLE, 'providers', 'openrouter.js'));
let currentAdapter = claude;
_stub('providers/index.js', { getAdapter: () => currentAdapter });

const realHttp = require(path.join(BUNDLE, 'http.js'));
const SENT = [];
let SCRIPT = [];
async function transport(opts, body) {
    SENT.push(typeof body === 'string' ? JSON.parse(body) : body);
    const next = SCRIPT.shift();
    if (!next) return { status: 200, data: textResp('(default)') };
    return { status: 200, data: typeof next === 'function' ? next() : next };
}
_stub('http.js', Object.assign({}, realHttp, {
    httpStreamingRequest: transport,
    httpChatCompletionsStreamingRequest: transport,
}));

const ai = require(path.join(BUNDLE, 'ai.js'));
const { TOKEN: SILENT } = require(path.join(BUNDLE, 'silent-reply.js'));
const N = require(path.join(BUNDLE, 'refusal-notice.js'));

let EXEC = 0;
let execThrows = false;
let confirmAnswer = true;
ai.setChatDeps({
    executeTool: async (name) => { EXEC++; if (execThrows) throw new Error('tool blew up'); return { ok: true, name }; },
    getTools: () => [{ name: 'read', description: 'read', input_schema: { type: 'object', properties: {} } }],
    requestConfirmation: async () => confirmAnswer,
    lastToolUseTime: new Map(),
    lastIncomingMessages: new Map(),
    getMcpStatus: () => [],
});

let failures = 0;
function ok(label, cond, hint) {
    if (cond) console.log(`PASS: ${label}`);
    else { failures++; console.log(`FAIL: ${label}${hint ? ' — ' + hint : ''}`); }
}
function eq(label, a, e) { ok(label, JSON.stringify(a) === JSON.stringify(e), `\n  actual:   ${JSON.stringify(a)}\n  expected: ${JSON.stringify(e)}`); }

let _rid = 0;
function textResp(t) { return { id: `msg_${++_rid}`, model: currentModel, content: [{ type: 'text', text: t }], stop_reason: 'end_turn', usage: { input_tokens: 1, output_tokens: 1 } }; }
function emptyResp() { return { id: `msg_${++_rid}`, model: currentModel, content: [], stop_reason: 'end_turn', usage: { input_tokens: 1, output_tokens: 1 } }; }
function toolResp(id, text) {
    const content = [];
    if (text) content.push({ type: 'text', text });
    content.push({ type: 'tool_use', id, name: 'read', input: { q: id } });
    return { id: `msg_${++_rid}`, model: currentModel, content, stop_reason: 'tool_use', usage: { input_tokens: 1, output_tokens: 1 } };
}
function refusalResp(extra = {}) {
    return { id: `msg_${++_rid}`, model: currentModel, content: extra.content || [], stop_reason: 'refusal',
        stop_details: extra.stop_details === undefined ? null : extra.stop_details, usage: { input_tokens: 1, output_tokens: 0 } };
}
function orToolResp(id) {
    return { id: `or_${++_rid}`, model: 'x', choices: [{ index: 0, finish_reason: 'tool_calls',
        message: { role: 'assistant', content: null, tool_calls: [{ id, type: 'function', function: { name: 'read', arguments: '{}' } }] } }], usage: {} };
}
function orFilterResp() { return { id: `or_${++_rid}`, model: 'x', choices: [{ index: 0, finish_reason: 'content_filter', message: { role: 'assistant', content: 'part' } }], usage: {} }; }
function orRefusalResp(msg) { return { id: `or_${++_rid}`, model: 'x', choices: [{ index: 0, finish_reason: 'stop', message: { role: 'assistant', content: null, refusal: msg } }], usage: {} }; }

let _c = 0;
const newChat = () => `rf-${++_c}`;
const mark = () => LOGS.length;
const traces = (m) => LOGS.slice(m).filter(l => l.level === 'WARN' && l.msg.startsWith('[Trace]') && /model_refusal|provider_content_filter/.test(l.msg))
    .map(l => JSON.parse(l.msg.slice('[Trace] '.length)));
const lastAssistant = (chatId) => { const c = ai.getConversation(chatId); for (let i = c.length - 1; i >= 0; i--) if (c[i].role === 'assistant') return c[i]; return null; };
function chatFiles(chatId) {
    return fs.readdirSync(TASKS_DIR).filter(f => { try { return JSON.parse(fs.readFileSync(path.join(TASKS_DIR, f), 'utf8')).chatId === chatId; } catch (_) { return false; } });
}
async function turn(chatId, msg, opts = {}) {
    const outcomes = [];
    const interim = [];
    const r = await ai.chat(chatId, msg, { ...opts, sendInterim: async (t) => interim.push(t), onTurnOutcome: (o) => outcomes.push(o) });
    return { r, outcomes, interim };
}
function reset(adapter = claude, model = 'claude-opus-5') {
    currentAdapter = adapter; currentModel = model; SENT.length = 0; SCRIPT = []; EXEC = 0;
    execThrows = false; confirmAnswer = true; policyNow = 'none';
}

async function main() {
    // ── 1. empty refusal on the first request (the ticket's case)
    console.log('── empty refusal, no tools ──');
    {
        reset(); const chatId = newChat(); const m = mark();
        SCRIPT = [refusalResp({ stop_details: { type: 'refusal', category: 'Cyber Security!!', explanation: 'SECRET-EXPLANATION' } })];
        const { r, outcomes } = await turn(chatId, 'please do the forbidden thing USERTEXT');
        eq('the user gets the decline notice', r, N.NOTICE_DECLINED);
        eq('history holds the notice, not [No response generated]', lastAssistant(chatId).content, N.NOTICE_DECLINED);
        const t = traces(m);
        eq('one WARN trace', t.length, 1);
        ok('trace fields', t[0] && t[0].reason === 'model_refusal' && t[0].phase === 'loop' && t[0].dispatchedTools === 0
            && t[0].fallbackReturned === true && t[0].provider === 'claude' && t[0].model === 'claude-opus-5', JSON.stringify(t[0]));
        eq('a non-allowlisted category is logged as other', t[0] && t[0].category, 'other');
        ok('no user or model text in the logs', !LOGS.slice(m).some(l => /USERTEXT|SECRET-EXPLANATION/.test(l.msg) && l.level !== 'DEBUG'));
        eq('onTurnOutcome fires once with the refusal', outcomes.map(o => o.refusal && o.refusal.kind), ['model_refusal']);
        eq('exactly one API request (no retry, no summary)', SENT.length, 1);
    }

    // ── 2. mid-stream refusal with partial text + a cut-off tool call
    {
        reset(); const chatId = newChat();
        SCRIPT = [refusalResp({ content: [{ type: 'text', text: 'Sure, running' }, { type: 'tool_use', id: 'tu_x', name: 'read', input: {} }] })];
        const { r, interim } = await turn(chatId, 'go');
        eq('a refused tool call is never executed', EXEC, 0);
        eq('partial text is never interim-sent', interim, []);
        ok('partial text is never shown', !r.includes('Sure, running'));
        ok('the refused response never enters history', !ai.getConversation(chatId).some(mm => mm.role === 'assistant' && Array.isArray(mm.toolCalls) && mm.toolCalls.some(tc => tc.id === 'tu_x')));
    }

    // ── 3. refusal after a dispatched tool round → disclosure, no summary call
    console.log('── after tool rounds ──');
    {
        reset(); const chatId = newChat(); const m = mark();
        let cpBeforeRefusal = null;
        SCRIPT = [toolResp('t1', 'looking'), () => { cpBeforeRefusal = chatFiles(chatId).length; return refusalResp(); }];
        const { r } = await turn(chatId, 'multi step');
        ok('precondition: a checkpoint existed when the refusal arrived', cpBeforeRefusal > 0, String(cpBeforeRefusal));
        eq('one tool dispatched', EXEC, 1);
        ok('the reply opens with the prior-action disclosure', r.startsWith(N.DISCLOSURE_DECLINED) && r.includes(N.RECOVERY_LINE), r);
        eq('no closing summary call', SENT.length, 2);
        eq('trace counts the dispatched tool', traces(m)[0] && traces(m)[0].dispatchedTools, 1);
        eq('task + checkpoints cleared (not resumable)', chatFiles(chatId), []);
    }
    {
        reset(); const chatId = newChat(); execThrows = true;
        SCRIPT = [toolResp('t2'), refusalResp()];
        const { r } = await turn(chatId, 'x');
        ok('a tool that threw still counts as dispatched → disclosure', r.startsWith(N.DISCLOSURE_DECLINED));
    }
    {
        reset(); const chatId = newChat(); policyNow = 'confirm'; confirmAnswer = false;
        SCRIPT = [toolResp('t3'), refusalResp()];
        const { r } = await turn(chatId, 'x');
        eq('a denied call is not dispatched', EXEC, 0);
        eq('denied only → the ordinary notice (no disclosure)', r, N.NOTICE_DECLINED);
    }

    // ── 4. refused closing summary
    {
        reset(); const chatId = newChat(); const m = mark();
        SCRIPT = [toolResp('t4'), emptyResp(), refusalResp()];
        const { r } = await turn(chatId, 'x');
        eq('the summary call was made', SENT.length, 3);
        ok('a refused summary gets the disclosure notice', r.startsWith(N.DISCLOSURE_DECLINED), r);
        ok('not the "Done — took N steps" fallback', !/^Done — took/.test(r));
        eq('trace phase summary', traces(m)[0] && traces(m)[0].phase, 'summary');
    }

    // ── 5. Chat Completions: content filter after a dispatched tool; model message
    console.log('── OpenAI family ──');
    {
        reset(openrouter, 'some/model'); const chatId = newChat();
        SCRIPT = [orToolResp('c1'), orFilterResp()];
        const { r } = await turn(chatId, 'x');
        ok('content filter after tools uses the filter disclosure', r.startsWith(N.DISCLOSURE_FILTERED) && !r.includes('declined'), r);
        ok('the filtered partial text is not shown', !r.includes('part'));
    }
    {
        reset(openrouter, 'some/model'); const chatId = newChat();
        SCRIPT = [orFilterResp()];
        const { r } = await turn(chatId, 'x');
        eq('content filter, no tools → filter notice', r, N.NOTICE_FILTERED);
    }
    {
        reset(openrouter, 'some/model'); const chatId = newChat();
        SCRIPT = [orRefusalResp(`${'x'.repeat(2500)}`)];
        const { r } = await turn(chatId, 'x');
        ok('the model message is shown, capped at 2000', r.length === 2000 && r.endsWith('…'), String(r.length));
    }
    {
        // Codex connector on #472: a secret straddling the 2,000-char cap must be redacted
        // BEFORE the cap, or its prefix survives and no literal redactor matches it later.
        reset(openrouter, 'some/model'); const chatId = newChat();
        SCRIPT = [orRefusalResp('x'.repeat(1990) + SECRET + ' trailing')];
        const { r } = await turn(chatId, 'x');
        ok('no part of a secret straddling the cap reaches the reply', !r.includes('SECRETTOKEN') && !r.includes('SECRETT'), r.slice(1980));
        // The marker may itself be cut by the cap — harmless: it holds no secret.
        ok('the secret was redacted before the cap (marker, possibly cut, remains)', r.includes('[REDACTED'), r.slice(1980));
    }
    {
        reset(openrouter, 'some/model'); const chatId = newChat();
        SCRIPT = [orRefusalResp(SILENT)];
        const { r } = await turn(chatId, 'x');
        eq('a model message that strips to nothing → generic notice', r, N.NOTICE_DECLINED);
    }
    {
        reset(openrouter, 'some/model'); const chatId = newChat();
        SCRIPT = [orToolResp('c2'), orRefusalResp('I will not continue.')];
        const { r } = await turn(chatId, 'x');
        ok('the model message never replaces the disclosure; it follows it',
            r.startsWith(N.DISCLOSURE_DECLINED) && r.endsWith('I will not continue.'), r);
    }

    // ── 6. heartbeat stays silent
    console.log('── heartbeat ──');
    {
        reset(); const chatId = '__heartbeat__'; const m = mark();
        const before = ai.getConversation(chatId).length;
        SCRIPT = [refusalResp()];
        const { r, outcomes } = await turn(chatId, 'heartbeat poll', { synthetic: 'heartbeat' });
        eq('heartbeat refusal returns the silent token', r, SILENT);
        const conv = ai.getConversation(chatId);
        ok('no notice written to heartbeat history', !conv.slice(before).some(mm => mm.role === 'assistant'));
        eq('trace fallbackReturned false', traces(m)[0] && traces(m)[0].fallbackReturned, false);
        eq('onTurnOutcome still reports it', outcomes.length, 1);
    }

    // ── 7. regressions
    console.log('── regressions ──');
    {
        reset(); const chatId = newChat();
        SCRIPT = [emptyResp()];
        const { r, outcomes } = await turn(chatId, 'x');
        eq('plain empty end_turn is still the silent reply', r, SILENT);
        eq('…stored as [No response generated]', lastAssistant(chatId).content, '[No response generated]');
        eq('onTurnOutcome fires once with refusal null', outcomes, [{ refusal: null }]);
    }
    {
        reset(); const chatId = newChat();
        SCRIPT = [toolResp('t9'), textResp('done!')];
        const { r, outcomes } = await turn(chatId, 'x');
        eq('a normal tool turn is unchanged', r, 'done!');
        eq('…and reports no refusal', outcomes, [{ refusal: null }]);
    }
    {
        // A throwing turn never calls onTurnOutcome.
        reset(); const chatId = newChat();
        let calls = 0;
        const realTransport = SCRIPT;
        SCRIPT = [];
        const throwingAdapter = Object.assign({}, claude, { fromApiResponse: () => { throw new Error('boom'); } });
        currentAdapter = throwingAdapter;
        try { await ai.chat(chatId, 'x', { onTurnOutcome: () => { calls++; } }); } catch (_) {}
        eq('onTurnOutcome is not called for a throwing turn', calls, 0);
        void realTransport;
    }

    try { fs.rmSync(TMP, { recursive: true, force: true }); } catch (_) {}
    console.log(`\n${failures === 0 ? 'All' : failures + ' FAILED of'} refusal chat() checks${failures === 0 ? ' passed' : ''}.`);
    process.exit(failures === 0 ? 0 : 1);
}

main().catch((e) => { console.error(e); process.exit(1); });
