#!/usr/bin/env node
// claude-stable-history.test.js — BAT-1664 slice B: C0 stable history within a
// turn + the formatted-payload budget gate (spec "C0", "The budget gate",
// pins P1/P3, Tests item 1).
//
// Every thinking block's signature is bound to the exact prefix that produced
// it. On registry-flagged first-party Claude models (`thinkingBinding: true`)
// nothing before the newest message may change between the rounds of a turn:
//   - tool-result aging runs ONCE, before the first request, pre-anchor only;
//   - no per-round MAX_HISTORY trim — a 'turnEnd' trim instead;
//   - the wire `tools` array is frozen at turn start; the loop-final round
//     keeps it and sends `tool_choice: {type:'none'}`.
// Every other provider keeps the per-round behavior.
//
// Budget gate (all first-party Claude): the FORMATTED body is measured; over
// the threshold → ONE reduction (strip thinking, age, adaptiveTrim) → still
// over → the request is NOT sent and the turn ends recoverably
// (context_budget_exceeded). The C3 / C2 retries go through the same gate (P1).
//
// Drives the REAL chat() (ai.js + providers/claude.js + providers/openrouter.js
// + http.js reducer + history-trim + loop-detector + task-store); only I/O
// edges are stubbed. The transport stub is the claudeApiCall spy: it REJECTS
// (and records) any body at/over the budget, so an oversized send fails here.
//
// Run:  node tests/nodejs-project/claude-stable-history.test.js

'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');

const BUNDLE = path.resolve(__dirname, '..', '..', 'app', 'src', 'main', 'assets', 'nodejs-project');
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'bat1664b-'));
const TASKS_DIR = path.join(TMP, 'tasks');
fs.mkdirSync(TASKS_DIR, { recursive: true });

const LOGS = [];
function log(msg, level) { LOGS.push({ msg: String(msg), level: level || 'INFO' }); }

function _stub(rel, exports) {
    const resolved = require.resolve(path.join(BUNDLE, rel));
    require.cache[resolved] = { id: resolved, filename: resolved, loaded: true, exports };
}

let currentModel = 'claude-fable-5-1';
_stub('config.js', {
    workDir: TMP, TASKS_DIR,
    MODEL: 'claude-fable-5-1', resolveActiveModel: () => currentModel,
    PROVIDER: 'claude', CHANNEL: 'telegram',
    ANTHROPIC_KEY: 'sk-ant-test-key', OPENAI_KEY: '', XAI_KEY: '', OPENROUTER_KEY: 'sk-or-test', CUSTOM_KEY: '',
    CUSTOM_BASE_URL: '', CUSTOM_FORMAT: '', OPENROUTER_FALLBACK_MODEL: '',
    OPENROUTER_MODEL_CONTEXT: 0, OPENROUTER_FALLBACK_CONTEXT: 0,
    AUTH_TYPE: 'api_key', OPENAI_AUTH_TYPE: 'api_key',
    REACTION_GUIDANCE: 'on', REACTION_NOTIFICATIONS: 'on', MEMORY_DIR: path.join(TMP, 'memory'),
    TOOL_RATE_LIMITS: {}, TOOL_STATUS_MAP: {}, RICH_MESSAGES_ENABLED: false,
    API_TIMEOUT_RETRIES: 0, API_TIMEOUT_BACKOFF_MS: 10, API_TIMEOUT_MAX_BACKOFF_MS: 10,
    truncateToolResult: (s) => s,
    localTimestamp: () => '2026-11-16T00:00:00Z',
    localDateStr: () => '2026-11-16',
    log,
    getOwnerId: () => 'OWNER',
    USER_ENV_KEYS: [],
    config: { agentName: 'TestAgent', jupiterApiKey: '' },
    runtimeState: { read: () => ({ reasoningEnabled: false, reasoningDisplayInChat: false }) },
});
_stub('security.js', { redactSecrets: (s) => s });
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
_stub('confirmation/index.js', {
    getConfirmationPolicy: () => 'none',
    normalizePolicy: (r) => (typeof r === 'string' ? { policy: r } : r),
});
_stub('wallet/index.js', { getWalletState: async () => ({ burnerConfigured: false }) });

const claude = require(path.join(BUNDLE, 'providers', 'claude.js'));
const openrouter = require(path.join(BUNDLE, 'providers', 'openrouter.js'));
let currentAdapter = claude;
_stub('providers/index.js', { getAdapter: () => currentAdapter });

// ── transport stub = claudeApiCall spy ──────────────────────────────────────
const realHttp = require(path.join(BUNDLE, 'http.js'));
const LIMIT_TOKENS = 200000;           // MODEL_CONTEXT_LIMITS for the Claude models used here
const BUDGET_CHARS = 0.90 * LIMIT_TOKENS * 4;
const SENT = [];
const VIOLATIONS = [];
let SCRIPT = [];
// The spy's OWN size model (independent of ai.js): text at chars/4, and every
// image block at a fixed 1,600 tokens with its base64 payload excluded — what
// the API actually bills for an image, not its encoded size.
function spyTokens(raw) {
    let images = 0;
    const text = raw.replace(/"data":"[A-Za-z0-9+/=]{64,}"/g, () => { images++; return '"data":""'; });
    return Math.ceil(text.length / 4) + images * 1600;
}
async function transport(opts, body) {
    const raw = typeof body === 'string' ? body : JSON.stringify(body);
    const req = { headers: Object.assign({}, opts.headers), body: JSON.parse(raw), raw };
    SENT.push(req);
    if (currentAdapter === claude && spyTokens(raw) >= BUDGET_CHARS / 4) {
        VIOLATIONS.push(raw.length);
        return { status: 400, data: { type: 'error', error: { type: 'invalid_request_error', message: 'prompt is too long (spy: over budget)' } } };
    }
    const next = SCRIPT.shift();
    if (!next) return { status: 200, data: textResp('(default)') };
    return next(req);
}
_stub('http.js', Object.assign({}, realHttp, {
    httpStreamingRequest: transport,
    httpChatCompletionsStreamingRequest: transport,
}));

const realTaskStore = require(path.join(BUNDLE, 'task-store.js'));
const CHECKPOINTS = [];
_stub('task-store.js', Object.assign({}, realTaskStore, {
    saveCheckpoint: (taskId, state) => {
        const r = realTaskStore.saveCheckpoint(taskId, state);
        try { CHECKPOINTS.push(JSON.parse(fs.readFileSync(path.join(TASKS_DIR, `${taskId}.json`), 'utf8'))); } catch (_) {}
        return r;
    },
}));

const ai = require(path.join(BUNDLE, 'ai.js'));

const TOOLS_A = [{ name: 'read', description: 'read a thing', input_schema: { type: 'object', properties: {} } }];
const TOOLS_B = [...TOOLS_A, { name: 'late_mcp_tool', description: 'appeared mid-turn', input_schema: { type: 'object', properties: {} } }];
let toolsNow = TOOLS_A;
let toolResultSize = 1500;            // > AGING_SIZE_THRESHOLD (800) → aging candidate
let EXEC_CALLS = 0;
let execHook = null;
ai.setChatDeps({
    executeTool: async (name, input) => {
        EXEC_CALLS++;
        if (execHook) execHook(EXEC_CALLS);
        return { ok: true, name, data: 'r'.repeat(toolResultSize) };
    },
    getTools: () => toolsNow,
    requestConfirmation: async () => true,
    lastToolUseTime: new Map(),
    lastIncomingMessages: new Map(),
    getMcpStatus: () => [],
});

// ── assertions ──────────────────────────────────────────────────────────────
let failures = 0;
let passes = 0;
function ok(label, cond, hint) {
    if (cond) { passes++; console.log(`PASS: ${label}`); }
    else { failures++; console.log(`FAIL: ${label}${hint ? ' — ' + hint : ''}`); }
}
function eq(label, actual, expected) {
    const a = JSON.stringify(actual), e = JSON.stringify(expected);
    // Bodies here can be ~1 MB — keep failure output bounded.
    const cut = (x) => (typeof x === 'string' && x.length > 300 ? `${x.slice(0, 300)}…(${x.length} chars)` : x);
    ok(label, a === e, `\n  actual:   ${cut(a)}\n  expected: ${cut(e)}`);
}

// ── fixtures ────────────────────────────────────────────────────────────────
let _rid = 0;
function th(tag, size) { return { type: 'thinking', thinking: size ? 'T'.repeat(size) : `reasoning ${tag}`, signature: `SIG-${tag}-` + 'x'.repeat(24) }; }
function tu(id, input) { return { type: 'tool_use', id, name: 'read', input: input || { q: id } }; }
function toolResp(blocks) {
    return { id: `msg_${++_rid}`, model: currentModel, type: 'message', role: 'assistant',
        content: blocks, stop_reason: 'tool_use', usage: { input_tokens: 1, output_tokens: 1 } };
}
function textResp(t) {
    return { id: `msg_${++_rid}`, model: currentModel, type: 'message', role: 'assistant',
        content: [{ type: 'text', text: t }], stop_reason: 'end_turn', usage: { input_tokens: 1, output_tokens: 1 } };
}
function orToolResp(id, input) {
    return { id: `or_${++_rid}`, model: 'x', choices: [{ index: 0, finish_reason: 'tool_calls',
        message: { role: 'assistant', content: null, tool_calls: [{ id, type: 'function', function: { name: 'read', arguments: JSON.stringify(input || { q: id }) } }] } }],
        usage: { prompt_tokens: 1, completion_tokens: 1 } };
}
function orTextResp(t) {
    return { id: `or_${++_rid}`, model: 'x', choices: [{ index: 0, finish_reason: 'stop', message: { role: 'assistant', content: t } }],
        usage: { prompt_tokens: 1, completion_tokens: 1 } };
}
const ok200 = (data) => () => ({ status: 200, data });
const err400 = (message) => () => ({ status: 400, data: { type: 'error', error: { type: 'invalid_request_error', message } } });
const SIG_400 = 'messages.3.content.0: Invalid `signature` in `thinking` block. The block is bound to a different conversation.';
const REJ_FIELD = 'thinking.adaptive.block_binding: Extra inputs are not permitted';

function anyThinking(body) {
    return (body.messages || []).some((m) => m.role === 'assistant' && Array.isArray(m.content)
        && m.content.some((b) => b.type === 'thinking' || b.type === 'redacted_thinking'));
}
let _chatSeq = 0;
function newChatId() { return `sh-${++_chatSeq}`; }
// Seed a prior-turn history: `pairs` user/assistant text pairs and one prior
// tool group with a LARGE result (an aging candidate before the anchor).
function seed(chatId, pairs) {
    const conv = ai.getConversation(chatId);
    conv.push({ role: 'user', content: 'old question with a tool' });
    conv.push({ role: 'assistant', content: 'old look', toolCalls: [{ id: 'old_t', name: 'read', input: {} }], reasoningBlocks: [] });
    conv.push({ role: 'tool', toolCallId: 'old_t', content: JSON.stringify({ ok: true, data: 'o'.repeat(2000) }) });
    conv.push({ role: 'assistant', content: 'old answer', reasoningBlocks: [] });
    for (let i = 0; i < pairs; i++) {
        conv.push({ role: 'user', content: `filler q${i}` });
        conv.push({ role: 'assistant', content: `filler a${i}`, reasoningBlocks: [] });
    }
    return conv;
}
function toolResultContents(body) {
    const out = [];
    for (const m of body.messages || []) {
        if (m.role !== 'user' || !Array.isArray(m.content)) continue;
        for (const b of m.content) if (b.type === 'tool_result') out.push({ id: b.tool_use_id, content: b.content });
    }
    return out;
}
function orToolResultContents(body) {
    return (body.messages || []).filter((m) => m.role === 'tool').map((m) => ({ id: m.tool_call_id, content: m.content }));
}
function turnLogs(mark, re) { return LOGS.slice(mark).filter((l) => re.test(l.msg)); }

// ════════════════════════════════════════════════════════════════════════════
async function main() {
    // ── C0-1 flagged: byte-stable prefix, aging once pre-anchor, frozen tools, no per-round trim
    console.log('── C0 (flagged claude-fable-5-1): stable history within a turn ──');
    {
        currentAdapter = claude; currentModel = 'claude-fable-5-1'; toolsNow = TOOLS_A; toolResultSize = 1500;
        const chatId = newChatId();
        seed(chatId, 14); // 4 + 28 = 32 messages before the anchor → > MAX_HISTORY (35) mid-turn
        const ROUNDS = 6;
        SENT.length = 0;
        SCRIPT = [];
        for (let r = 1; r <= ROUNDS; r++) SCRIPT.push(ok200(toolResp([th(`r${r}`), { type: 'text', text: `step ${r}` }, tu(`c${r}`)])));
        SCRIPT.push(ok200(textResp('all done')));
        execHook = (n) => { if (n === 2) toolsNow = TOOLS_B; }; // an MCP tool appears mid-turn
        const execBefore = EXEC_CALLS;
        const mark = LOGS.length;
        const reply = await ai.chat(chatId, 'the long question');
        execHook = null; toolsNow = TOOLS_A;
        eq('C0: final reply', reply, 'all done');
        eq('C0: one request per round + final', SENT.length, ROUNDS + 1);
        eq('C0: every tool still executed (availability checks unaffected)', EXEC_CALLS - execBefore, ROUNDS);
        let prefixOk = true; let detail = '';
        for (let k = 1; k < SENT.length; k++) {
            const prev = SENT[k - 1].body, cur = SENT[k].body;
            if (JSON.stringify(cur.system) !== JSON.stringify(prev.system)) { prefixOk = false; detail = `system differs at ${k}`; break; }
            if (JSON.stringify(cur.tools) !== JSON.stringify(prev.tools)) { prefixOk = false; detail = `tools differ at ${k}`; break; }
            const head = cur.messages.slice(0, prev.messages.length);
            if (JSON.stringify(head) !== JSON.stringify(prev.messages)) {
                const at = prev.messages.findIndex((m, i) => JSON.stringify(m) !== JSON.stringify(head[i]));
                prefixOk = false; detail = `messages differ at request ${k + 1}, index ${at}`; break;
            }
        }
        ok('C0: system + tools + every message of request N are byte-identical in request N+1', prefixOk, detail);
        ok('C0: frozen tools — the mid-turn MCP tool never reaches the wire', SENT.every((r) => r.body.tools.length === TOOLS_A.length));
        const tr0 = toolResultContents(SENT[0].body);
        ok('C0: aging ran before the first request on the pre-anchor tool result', tr0.some((t) => t.id === 'old_t' && /^\[Trimmed: read result/.test(t.content)));
        const last = SENT[SENT.length - 1].body;
        const inTurn = toolResultContents(last).filter((t) => /^c\d$/.test(t.id));
        eq('C0: all in-turn tool results reach the last request', inTurn.length, ROUNDS);
        ok('C0: no in-turn tool result is ever aged', inTurn.every((t) => t.content.length > 1000));
        eq('C0: [Aging] ran exactly once this turn', turnLogs(mark, /^\[Aging\]/).length, 1);
        ok('C0: no per-round trim — the last request carries > MAX_HISTORY (35) messages', last.messages.length > 35, `len=${last.messages.length}`);
        eq('C0: no "toolRound" [History] trim this turn', turnLogs(mark, /"site":"toolRound"/).length, 0);
        const conv = ai.getConversation(chatId);
        ok('C0: after the turn the history is bounded again (<= 36 with the anchor exemption)', conv.length <= 36, `len=${conv.length}`);
        ok('C0: …and the trim kept the anchor', conv.some((m) => m.role === 'user' && m.content === 'the long question'));
        ok('C0: in-turn thinking was replayed (nothing forced stripping)', anyThinking(last));
        eq('C0: no request over budget', VIOLATIONS.length, 0);
    }

    // ── C0-2 turn-end trim on a THROWN exit keeps the anchor
    {
        currentAdapter = claude; currentModel = 'claude-fable-5-1'; toolResultSize = 1500;
        const chatId = newChatId();
        seed(chatId, 14);
        SENT.length = 0;
        SCRIPT = [1, 2, 3, 4].map((r) => ok200(toolResp([th(`e${r}`), tu(`e${r}`)])));
        SCRIPT.push(err400('max_tokens: field required'));
        const mark = LOGS.length;
        let threw = null;
        try { await ai.chat(chatId, 'question that errors'); } catch (e) { threw = e; }
        ok('turnEnd: the turn ended with the API error', !!threw);
        const conv = ai.getConversation(chatId);
        ok('turnEnd: history bounded after a thrown exit (<= 36)', conv.length <= 36, `len=${conv.length}`);
        ok('turnEnd: the anchor survived the trim', conv.some((m) => m.role === 'user' && m.content === 'question that errors'));
        ok('turnEnd: logged with site "turnEnd"', turnLogs(mark, /"site":"turnEnd"/).length === 1);
        let pairsOk = true;
        for (let i = 0; i < conv.length; i++) {
            const m = conv[i];
            if (m.role === 'tool') {
                let k = i - 1; while (k >= 0 && conv[k].role === 'tool') k--;
                if (k < 0 || conv[k].role !== 'assistant' || !(conv[k].toolCalls || []).some((tc) => tc.id === m.toolCallId)) pairsOk = false;
            }
        }
        ok('turnEnd: no orphan tool result after the trim', pairsOk);
    }

    // ── C0-3 loop-final: frozen tools + tool_choice none (flagged) vs no tools (unflagged)
    console.log('\n── C0: loop-final round ──');
    for (const model of ['claude-fable-5-1', 'claude-opus-5']) {
        currentAdapter = claude; currentModel = model; toolResultSize = 10;
        const chatId = newChatId();
        SENT.length = 0;
        SCRIPT = [1, 2, 3, 4, 5].map((r) => ok200(toolResp([th(`l${r}`), tu(`l${r}`, { same: true })])));
        SCRIPT.push(ok200(toolResp([th('l6'), { type: 'text', text: 'here is what I have' }, tu('l6', { same: true })])));
        const reply = await ai.chat(chatId, 'loop please');
        const finalReq = SENT[5] && SENT[5].body;
        ok(`loop-final (${model}): the 6th request is the forced-final round`, !!finalReq && JSON.stringify(finalReq.messages).includes('Tool loop detected'));
        if (model === 'claude-fable-5-1') {
            eq('loop-final (flagged): frozen tools sent unchanged', JSON.stringify(finalReq.tools), JSON.stringify(SENT[0].body.tools));
            eq('loop-final (flagged): tool_choice none', finalReq.tool_choice, { type: 'none' });
            ok('loop-final (flagged): earlier rounds carry no tool_choice', SENT.slice(0, 5).every((r) => !('tool_choice' in r.body)));
        } else {
            ok('loop-final (unflagged): tools removed (pre-BAT-1664 behavior)', !('tools' in finalReq));
            ok('loop-final (unflagged): no tool_choice', !('tool_choice' in finalReq));
        }
        eq(`loop-final (${model}): tool calls on the final round are still ignored`, reply, 'here is what I have');
        eq(`loop-final (${model}): no 7th request`, SENT.length, 6);
    }

    // ── C0-4 non-Claude provider keeps per-round behavior
    console.log('\n── C0: non-Claude provider (OpenRouter) unchanged ──');
    {
        currentAdapter = openrouter; currentModel = 'anthropic/claude-fable-5-1'; toolsNow = TOOLS_A; toolResultSize = 1500;
        const chatId = newChatId();
        seed(chatId, 14);
        SENT.length = 0;
        SCRIPT = [1, 2, 3, 4, 5, 6].map((r) => ok200(orToolResp(`o${r}`)));
        SCRIPT.push(ok200(orTextResp('or done')));
        let execAt = 0;
        execHook = () => { execAt++; if (execAt === 2) toolsNow = TOOLS_B; };
        const gateBefore = ai.budgetGateStats.checks;
        const mark = LOGS.length;
        const reply = await ai.chat(chatId, 'openrouter question');
        execHook = null; toolsNow = TOOLS_A;
        eq('non-Claude: final reply', reply, 'or done');
        ok('non-Claude: tools are re-read per round (the mid-turn tool appears)', SENT[SENT.length - 1].body.tools.length === TOOLS_B.length && SENT[0].body.tools.length === TOOLS_A.length);
        const lastTR = orToolResultContents(SENT[SENT.length - 1].body);
        ok('non-Claude: per-round aging still ages an in-turn result', lastTR.some((t) => /^o\d$/.test(t.id) && /^\[Trimmed:/.test(t.content)));
        ok('non-Claude: per-round [Aging] ran more than once', turnLogs(mark, /^\[Aging\]/).length > 1);
        ok('non-Claude: per-round MAX_HISTORY trim still runs', turnLogs(mark, /"site":"toolRound"/).length > 0);
        ok('non-Claude: no tool_choice anywhere', SENT.every((r) => !('tool_choice' in r.body)));
        eq('non-Claude: the budget gate does not run', ai.budgetGateStats.checks - gateBefore, 0);
        currentAdapter = claude;
    }

    // ── Emergency edits → stripAllThinking for the rest of the turn
    console.log('\n── C0: emergency edits strip thinking ──');
    {
        // sanitize repair that touches NO assistant message (an orphan tool
        // result spliced out) must still move the edit epoch.
        const conv = [
            { role: 'user', content: 'q' },
            { role: 'assistant', content: 'a', toolCalls: [{ id: 'k1', name: 'read', input: {} }] },
            { role: 'tool', toolCallId: 'k1', content: '{}' },
            { role: 'tool', toolCallId: 'ghost', content: '{}' }, // orphan
        ];
        const e0 = claude.wireEditEpoch(conv);
        const n = ai._sanitizeConversationForTest(conv, 't-orphan');
        ok('emergency/sanitize: an orphan tool result is repaired', n === 1 && conv.length === 3);
        ok('emergency/sanitize: the repair moves the edit epoch (→ stripAllThinking in chat())', claude.wireEditEpoch(conv) > e0);
        const clean = [{ role: 'user', content: 'q' }];
        const e1 = claude.wireEditEpoch(clean);
        ai._sanitizeConversationForTest(clean, 't-clean');
        eq('emergency/sanitize: a no-op sanitize does not move the epoch', claude.wireEditEpoch(clean), e1);
        // Quarantine, lean self-heal and anchor-guard repair: structural pins (the
        // epoch → strip wiring itself is exercised end-to-end in
        // claude-thinking-binding.test.js).
        const src = fs.readFileSync(path.join(BUNDLE, 'ai.js'), 'utf8');
        const near = (anchorRe, needle, span) => {
            const m = anchorRe.exec(src);
            return !!m && src.slice(m.index, m.index + span).includes(needle);
        };
        ok('emergency/quarantine: _applyRecovery sets stripAllThinking', near(/const _applyRecovery = \(result\) => \{/, '_stripAllThinking = true;', 400));
        ok('emergency/lean self-heal: sets stripAllThinking', near(/_contentFilterSelfHealed = true;/, '_stripAllThinking = true;', 200));
        ok('emergency/anchorGuardRepair: sets stripAllThinking', near(/if \(anchorGuardRepair\(messages, _turnAnchor\)\) \{/, '_stripAllThinking = true;', 120));
        ok('emergency/budget reduction: sets stripAllThinking', near(/reductions\+\+;/, '_stripAllThinking = true;', 600));
    }

    // ── Budget gate
    console.log('\n── Budget gate ──');
    // B1: an irreducible recent batch → no send, recoverable exit (flagged + unflagged).
    for (const model of ['claude-fable-5-1', 'claude-opus-5']) {
        currentAdapter = claude; currentModel = model; toolResultSize = 900000; // ~225k tokens in the newest batch
        const chatId = newChatId();
        SENT.length = 0; VIOLATIONS.length = 0;
        SCRIPT = [ok200(toolResp([th('b1'), tu('b1')])), ok200(textResp('should never be reached'))];
        const blockedBefore = ai.budgetGateStats.blocked;
        const cpBefore = CHECKPOINTS.length;
        const mark = LOGS.length;
        let reply; try { reply = await ai.chat(chatId, 'read the huge file'); } catch (e) { reply = `THREW: ${e.message}`; }
        eq(`budget/irreducible (${model}): only round 1 was sent`, SENT.length, 1);
        eq(`budget/irreducible (${model}): the spy saw no oversized body`, VIOLATIONS.length, 0);
        ok(`budget/irreducible (${model}): one blocked request counted`, ai.budgetGateStats.blocked === blockedBefore + 1);
        ok(`budget/irreducible (${model}): the user is told it is the context limit`, /context limit/.test(reply), reply);
        ok(`budget/irreducible (${model}): opening unchanged (the system-prompt playbook line 3b quotes it)`,
            reply.startsWith("I stopped before sending: this conversation has reached the model's context limit"));
        ok(`budget/irreducible (${model}): P3 — no promise that /resume progresses (may hit the limit again OR lose the results); offers a smaller step or a fresh context`,
            /may hit the same limit again or lose these latest results/.test(reply) && /smaller step/.test(reply) && /\/new/.test(reply)
            && !/kept in full/.test(reply));
        const cp = CHECKPOINTS.slice(cpBefore).pop();
        ok(`budget/irreducible (${model}): checkpoint kept with reason context_budget_exceeded`, !!cp && cp.reason === 'context_budget_exceeded' && cp.complete === false);
        ok(`budget/irreducible (${model}): the checkpoint keeps the anchor`, !!cp && cp.conversationSlice.some((m) => m.role === 'user' && m.content === 'read the huge file'));
        ok(`budget/irreducible (${model}): WARN "not sending" logged`, turnLogs(mark, /^\[ContextBudget\] still ~\d+ tokens .* not sending; ending the turn \(context_budget_exceeded\)/).length === 1);
        const conv = ai.getConversation(chatId);
        eq(`budget/irreducible (${model}): the fallback is the last history entry`, conv[conv.length - 1].content, reply);
        let pairsOk = true;
        for (let i = 0; i < conv.length; i++) if (conv[i].role === 'tool' && !(conv[i - 1] && conv[i - 1].toolCalls)) pairsOk = false;
        ok(`budget/irreducible (${model}): no tool call/result pair broken`, pairsOk);
    }

    // B1a (CodeRabbit #467 round 2): a 40-result irreducible batch. The exit's
    // fallback append goes through the MAX_HISTORY cap, which removes the whole
    // 41-entry group — so the text must not promise the results are kept. The
    // conversation must stay well-formed.
    {
        currentAdapter = claude; currentModel = 'claude-fable-5-1'; toolResultSize = 23000; // 40 × 23k ≈ 230k tokens
        const chatId = newChatId();
        SENT.length = 0; VIOLATIONS.length = 0;
        const ids = Array.from({ length: 40 }, (_, i) => `big${i + 1}`);
        SCRIPT = [ok200(toolResp([th('b40'), ...ids.map((id) => tu(id))])), ok200(textResp('never'))];
        const mark = LOGS.length;
        let reply; try { reply = await ai.chat(chatId, 'read forty big files'); } catch (e) { reply = `THREW: ${e.message}`; }
        eq('40-batch: only round 1 was sent', SENT.length, 1);
        eq('40-batch: the spy saw no oversized body', VIOLATIONS.length, 0);
        ok('40-batch: the new fallback text', /^I stopped before sending: this conversation has reached the model's context limit/.test(reply)
            && /may hit the same limit again or lose these latest results/.test(reply) && !/kept in full/.test(reply), reply);
        const conv = ai.getConversation(chatId);
        const trimLines = turnLogs(mark, /"site":"addToConversation"/);
        ok('40-batch: the fallback append trimmed history through the cap', trimLines.length >= 1);
        const removed = trimLines.reduce((n, l) => n + (Number((l.msg.match(/"removed":(\d+)/) || [])[1]) || 0), 0);
        eq('40-batch: the cap removed the whole 41-entry group (call + 40 results), not part of it', removed, 41);
        ok('40-batch: the anchor is kept', conv.some((m) => m.role === 'user' && m.content === 'read forty big files'));
        eq('40-batch: the fallback is the last entry', conv[conv.length - 1].content, reply);
        const callIds = new Set(); const resultIds = new Set();
        for (const m of conv) {
            if (m.role === 'assistant' && Array.isArray(m.toolCalls)) for (const tc of m.toolCalls) callIds.add(tc.id);
            if (m.role === 'tool') resultIds.add(m.toolCallId);
        }
        ok('40-batch: no orphan tool_use (every call has its result)', [...callIds].every((id) => resultIds.has(id)));
        ok('40-batch: no orphan tool_result (every result has its call)', [...resultIds].every((id) => callIds.has(id)));
        const cp = CHECKPOINTS.filter((c) => c.reason === 'context_budget_exceeded').pop();
        ok('40-batch: checkpoint slice keeps the anchor and has no orphan result at its head',
            !!cp && cp.conversationSlice.some((m) => m.role === 'user' && m.content === 'read forty big files')
            && cp.conversationSlice[0] && cp.conversationSlice[0].role !== 'tool');
    }

    // B1b: an inline photo (the turn anchor) is NOT text bulk — a 700 KB JPEG
    // (~955k base64 chars) must send, and so must the follow-up text turn.
    console.log('\n── Budget gate: inline images ──');
    const PHOTO_B64 = Buffer.alloc(700 * 1024, 7).toString('base64');
    const photoMsg = (caption) => [
        { type: 'text', text: `${caption}\n\n[Image saved to media/inbound/p.jpg (716800 bytes)]` },
        { type: 'image', source: { type: 'base64', media_type: 'image/jpeg', data: PHOTO_B64 } },
    ];
    for (const model of ['claude-fable-5-1', 'claude-opus-5']) {
        currentAdapter = claude; currentModel = model; toolResultSize = 10;
        const chatId = newChatId();
        SENT.length = 0; VIOLATIONS.length = 0;
        SCRIPT = [ok200(textResp('nice photo'))];
        const blockedBefore = ai.budgetGateStats.blocked;
        let reply; try { reply = await ai.chat(chatId, photoMsg('what is this?')); } catch (e) { reply = `THREW: ${e.message}`; }
        eq(`image (${model}): the 700 KB photo turn is sent`, SENT.length, 1);
        eq(`image (${model}): the model's answer is returned`, reply, 'nice photo');
        {
            let sentImage = null;
            for (const m of (SENT[0] ? SENT[0].body.messages : [])) {
                if (m.role === 'user' && Array.isArray(m.content)) sentImage = m.content.find((b) => b.type === 'image') || sentImage;
            }
            ok(`image (${model}): the photo reached the wire intact (full base64 equal)`,
                !!sentImage && sentImage.source && sentImage.source.type === 'base64' && sentImage.source.data === PHOTO_B64);
        }
        SCRIPT = [ok200(toolResp([th('i1'), tu('i1')])), ok200(textResp('follow-up answered'))];
        let reply2; try { reply2 = await ai.chat(chatId, 'and what colour is it?'); } catch (e) { reply2 = `THREW: ${e.message}`; }
        eq(`image (${model}): the follow-up text turn is sent (2 rounds)`, SENT.length, 3);
        eq(`image (${model}): follow-up answered`, reply2, 'follow-up answered');
        ok(`image (${model}): nothing was blocked`, ai.budgetGateStats.blocked === blockedBefore);
        eq(`image (${model}): the spy saw no oversized body`, VIOLATIONS.length, 0);
    }
    // B1b2 (Codex 49822321, major): the photo must not drive the PRE-FILTER either.
    // A mature Fable 5.1 chat + a 700 KB photo + one small tool result used to read
    // ~254k estimated tokens in checkContextUsage (base64 counted as text), so it sent
    // an extra summary request, pressure-trimmed history, and — because those are
    // history edits — sent the tool continuation WITHOUT its valid thinking.
    // Negative control: drop `mediaAware` from the _ctxCache in chat() → the DANGER, adaptive-trim
    // and thinking-replay assertions fail (in this harness the summarizer does not send).
    {
        currentAdapter = claude; currentModel = 'claude-fable-5-1'; toolResultSize = 10;
        const chatId = newChatId();
        seed(chatId, 6); // 4 + 12 = 16 prior messages: enough for summarizeOldMessages to act
        SENT.length = 0; VIOLATIONS.length = 0;
        const mark = LOGS.length;
        SCRIPT = [ok200(toolResp([th('ph'), tu('ph')])), ok200(textResp('photo checked'))];
        let reply; try { reply = await ai.chat(chatId, photoMsg('check this photo with the tool')); } catch (e) { reply = `THREW: ${e.message}`; }
        eq('mature photo + tool: the turn completes', reply, 'photo checked');
        eq('mature photo + tool: exactly two sends (no pressure summary request)', SENT.length, 2);
        eq('mature photo + tool: no [Context] DANGER from the base64', turnLogs(mark, /\[Context\] DANGER/).length, 0);
        ok('mature photo + tool: no pressure summary was spliced in', !ai.getConversation(chatId).some((m) => typeof m.content === 'string' && m.content.startsWith('[Summary of earlier conversation]')));
        eq('mature photo + tool: no pressure trim', turnLogs(mark, /\[Context\] Adaptive trim/).length, 0);
        ok('mature photo + tool: round 2 still replays the turn\'s thinking (no sticky strip)', !!SENT[1] && anyThinking(SENT[1].body));
        eq('mature photo + tool: the spy saw no oversized body', VIOLATIONS.length, 0);
    }
    // B1c: real text bulk is still blocked with a photo present.
    {
        currentAdapter = claude; currentModel = 'claude-fable-5-1'; toolResultSize = 900000;
        const chatId = newChatId();
        SENT.length = 0; VIOLATIONS.length = 0;
        SCRIPT = [ok200(toolResp([th('ib'), tu('ib')])), ok200(textResp('never'))];
        let reply; try { reply = await ai.chat(chatId, photoMsg('read the huge file for this photo')); } catch (e) { reply = `THREW: ${e.message}`; }
        eq('image + text bulk: only round 1 (photo, no bulk yet) was sent', SENT.length, 1);
        eq('image + text bulk: the spy saw no oversized body', VIOLATIONS.length, 0);
        ok('image + text bulk: the gate still stops the over-budget text batch', /context limit/.test(reply), reply);
    }

    // B1d (CodeRabbit #467, major): the budget reduction never ages the NEWEST
    // batch, even when it is wider than the 6-message recency window. Round 1
    // returns a huge thinking block + 7 parallel tool calls; round 2 is over
    // budget only because of the replayed thinking → reduce → must keep all 7.
    {
        currentAdapter = claude; currentModel = 'claude-fable-5-1'; toolResultSize = 1500;
        const chatId = newChatId();
        SENT.length = 0; VIOLATIONS.length = 0;
        const ids = [1, 2, 3, 4, 5, 6, 7].map((i) => `nb${i}`);
        SCRIPT = [ok200(toolResp([th('nb', 760000), ...ids.map((id) => tu(id))])), ok200(textResp('used all seven'))];
        const redBefore = ai.budgetGateStats.reductions;
        let reply; try { reply = await ai.chat(chatId, 'check seven things'); } catch (e) { reply = `THREW: ${e.message}`; }
        eq('newest batch: turn completes', reply, 'used all seven');
        ok('newest batch: the reduction ran', ai.budgetGateStats.reductions === redBefore + 1);
        const sentTR = SENT[1] ? toolResultContents(SENT[1].body).filter((t) => ids.includes(t.id)) : [];
        eq('newest batch: all 7 results were sent', sentTR.length, 7);
        ok('newest batch: none of the 7 is placeholdered in the SENT body', sentTR.every((t) => !/^\[Trimmed:/.test(t.content) && t.content.length > 1000));
        const stored = ai.getConversation(chatId).filter((m) => m.role === 'tool' && ids.includes(m.toolCallId));
        ok('newest batch: none of the 7 is placeholdered in stored history', stored.length === 7 && stored.every((m) => !/^\[Trimmed:/.test(m.content)));
    }

    // B1e — DECISION RECORD (BAT-1664, PR #467 CodeRabbit follow-up). On an
    // UNFLAGGED Claude model, per-round aging and the per-round MAX_HISTORY trim
    // edit history mid-turn but deliberately do NOT strip replayed thinking:
    // the live --compat probe (2026-11-16) showed fable-5, opus-5, opus-4-8,
    // sonnet-5 and sonnet-4-6 never run the prefix check, and stripping from
    // round 2 on every long turn of the DEFAULT model would cost reasoning for
    // nothing. An unknown id that does check is covered by the C3 heal; models
    // that check must be FLAGGED (thinkingBinding) instead. Change this only
    // with a new --compat run.
    console.log('\n── Unflagged per-round edits: decision record ──');
    const DR = "unflagged Claude: per-round aging/trim does NOT strip replayed thinking — unflagged registry models don't run the prefix check (live --compat 2026-11-16); unknown checking ids rely on the C3 heal";
    {
        // In-turn aging: 6 parallel results in round 1, one more in round 2 → at
        // round 3 the two oldest in-turn results leave the window and are aged.
        currentAdapter = claude; currentModel = 'claude-opus-5'; toolResultSize = 1500;
        const chatId = newChatId();
        SENT.length = 0; VIOLATIONS.length = 0;
        SCRIPT = [
            ok200(toolResp([th('ag1'), ...[1, 2, 3, 4, 5, 6].map((i) => tu(`ag${i}`))])),
            ok200(toolResp([th('ag2'), tu('ag7')])),
            ok200(textResp('aged done')),
        ];
        const mark = LOGS.length;
        await ai.chat(chatId, 'aging turn');
        eq('unflagged aging: 3 requests', SENT.length, 3);
        ok('unflagged aging: precondition — in-turn results were aged before round 3', turnLogs(mark, /^\[Aging\]/).length >= 1
            && toolResultContents(SENT[2].body).some((t) => /^ag\d$/.test(t.id) && /^\[Trimmed:/.test(t.content)));
        ok(`${DR} [in-turn aging: round 2 still carries thinking]`, anyThinking(SENT[1].body));
        ok(`${DR} [in-turn aging: round 3 still carries thinking]`, anyThinking(SENT[2].body));
    }
    {
        // In-turn trim: history at the MAX_HISTORY cap — the round-1 tool group
        // pushes it over and the per-round trim removes the oldest messages.
        currentAdapter = claude; currentModel = 'claude-opus-5'; toolResultSize = 10;
        const chatId = newChatId();
        seed(chatId, 15);
        SENT.length = 0; VIOLATIONS.length = 0;
        SCRIPT = [ok200(toolResp([th('tr1'), tu('tr1')])), ok200(textResp('trimmed done'))];
        const mark = LOGS.length;
        await ai.chat(chatId, 'trim turn');
        ok('unflagged trim: precondition — the per-round trim removed messages', turnLogs(mark, /"site":"toolRound"/).length >= 1);
        ok(`${DR} [in-turn trim: round 2 still carries thinking]`, SENT.length === 2 && anyThinking(SENT[1].body));
    }
    {
        // Control: a short history below the cap whose PRE-anchor tool result is
        // aged in round 1 (before this turn produced any thinking) → no trim, no
        // in-turn edit → round 2 still replays thinking (no needless strip).
        currentAdapter = claude; currentModel = 'claude-opus-5'; toolResultSize = 10;
        const chatId = newChatId();
        seed(chatId, 2);
        SENT.length = 0;
        SCRIPT = [ok200(toolResp([th('nt1'), tu('nt1')])), ok200(textResp('no trim'))];
        const mark = LOGS.length;
        await ai.chat(chatId, 'small turn');
        ok('unflagged no-change: round 1 aged the pre-anchor result', turnLogs(mark, /^\[Aging\]/).length >= 1
            && toolResultContents(SENT[0].body).some((t) => t.id === 'old_t' && /^\[Trimmed:/.test(t.content)));
        ok('unflagged no-change: no per-round trim', turnLogs(mark, /"site":"toolRound"/).length === 0);
        ok('unflagged no-change: round 2 still replays in-turn thinking', SENT.length === 2 && anyThinking(SENT[1].body));
    }

    // B2: replay over budget → strip, re-measure, send.
    {
        currentAdapter = claude; currentModel = 'claude-fable-5-1'; toolResultSize = 10;
        const chatId = newChatId();
        SENT.length = 0; VIOLATIONS.length = 0;
        // A 760k-char thinking block: the cheap estimate never sees it, the formatted body does.
        SCRIPT = [ok200(toolResp([th('big', 760000), tu('g1')])), ok200(textResp('fits now'))];
        const redBefore = ai.budgetGateStats.reductions;
        const mark = LOGS.length;
        let reply; try { reply = await ai.chat(chatId, 'think hard'); } catch (e) { reply = `THREW: ${e.message}`; }
        eq('budget/replay: turn completes', reply, 'fits now');
        eq('budget/replay: 2 requests sent', SENT.length, 2);
        eq('budget/replay: the spy saw no oversized body', VIOLATIONS.length, 0);
        ok('budget/replay: the re-measured request carries no thinking', !anyThinking(SENT[1].body));
        ok('budget/replay: one reduction', ai.budgetGateStats.reductions === redBefore + 1);
        ok('budget/replay: WARN over-budget then INFO "reduced … sending"',
            turnLogs(mark, /^\[ContextBudget\] request ~\d+ tokens .* reducing once/).length === 1
            && turnLogs(mark, /^\[ContextBudget\] reduced to ~\d+ tokens .* sending/).length === 1);
        ok('budget/replay: the anchor is still in the sent request', SENT[1].body.messages.some((m) => m.role === 'user' && m.content === 'think hard'));
    }

    // B3 (P1): the C3 heal retry and the C2 fallback retry are measured by the gate.
    console.log('\n── Budget gate: P1 retries ──');
    for (const [label, errText] of [['C3 signature heal', SIG_400], ['C2 binding fallback', REJ_FIELD]]) {
        currentAdapter = claude; currentModel = 'claude-fable-5-1'; toolResultSize = 10;
        const chatId = newChatId();
        SENT.length = 0; VIOLATIONS.length = 0;
        SCRIPT = [ok200(toolResp([th('p1'), tu('p1')])), err400(errText), ok200(textResp('retried'))];
        const checksBefore = ai.budgetGateStats.checks;
        let reply; try { reply = await ai.chat(chatId, 'q'); } catch (e) { reply = `THREW: ${e.message}`; }
        eq(`P1 (${label}): turn recovers`, reply, 'retried');
        eq(`P1 (${label}): 3 sends (1 retry)`, SENT.length, 3);
        eq(`P1 (${label}): every send — the retry included — was measured by the gate`, ai.budgetGateStats.checks - checksBefore, SENT.length);
    }
    // B3b: a retry that would be over budget is NOT sent.
    {
        currentAdapter = claude; currentModel = 'claude-fable-5-1'; toolResultSize = 10;
        const chatId = newChatId();
        SENT.length = 0; VIOLATIONS.length = 0;
        // Make the heal retry over budget: when the signature 400 arrives, inflate
        // the in-turn tool result in place (the newest batch — the reduction cannot
        // age it), so only the gate on the retry path can stop the send.
        const conv = ai.getConversation(chatId);
        SCRIPT = [ok200(toolResp([th('p2'), tu('p2')])), () => {
            const tr = conv.filter((m) => m.role === 'tool').pop();
            if (tr) tr.content = JSON.stringify({ ok: true, data: 'z'.repeat(900000) });
            return err400(SIG_400)();
        }];
        let reply; try { reply = await ai.chat(chatId, 'q2'); } catch (e) { reply = `THREW: ${e.message}`; }
        eq('P1 (over-budget heal retry): not sent — only the 2 earlier requests', SENT.length, 2);
        eq('P1 (over-budget heal retry): the spy saw no oversized body', VIOLATIONS.length, 0);
        ok('P1 (over-budget heal retry): recoverable context-limit exit', /context limit/.test(reply), reply);
    }

    // B4: the closing-summary request is gated too.
    {
        currentAdapter = claude; currentModel = 'claude-opus-5'; toolResultSize = 10;
        const chatId = newChatId();
        SENT.length = 0; VIOLATIONS.length = 0;
        const conv = ai.getConversation(chatId);
        SCRIPT = [ok200(toolResp([th('s1'), tu('s1')])), () => {
            const tr = conv.filter((m) => m.role === 'tool').pop();
            if (tr) tr.content = JSON.stringify({ ok: true, data: 'z'.repeat(900000) });
            return ok200(toolResp([th('s2')]))(); // no text, no tools → closing summary path
        }];
        let reply; try { reply = await ai.chat(chatId, 'q3'); } catch (e) { reply = `THREW: ${e.message}`; }
        eq('closing summary: the over-budget summary request is not sent', SENT.length, 2);
        eq('closing summary: the spy saw no oversized body', VIOLATIONS.length, 0);
        ok('closing summary: the built-in summary is used instead', /^Done — took 1 step/.test(reply), reply);
    }
}

main().then(() => {
    try { ai.cancelAllIdleSummaries(); } catch (_) {}
    try { fs.rmSync(TMP, { recursive: true, force: true }); } catch (_) {}
    console.log();
    if (failures === 0) { console.log(`ALL TESTS PASS (${passes})`); process.exit(0); }
    console.log(`${failures} TEST(S) FAILED (${passes} passed)`);
    process.exit(1);
}).catch((e) => {
    console.log(`FAIL: harness crashed — ${e && e.stack ? e.stack : e}`);
    try { ai.cancelAllIdleSummaries(); } catch (_) {}
    process.exit(1);
});
