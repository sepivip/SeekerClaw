#!/usr/bin/env node
// claude-thinking-binding.test.js — BAT-1664 slice A: preserved-thinking replay.
//
// Anthropic binds every thinking block's signature to the exact prefix that
// produced it (system + tools + every earlier message) and to the model. On
// enforcing models (claude-fable-5-1 for new accounts, the 5.5 family) a
// replayed block whose prefix changed is a 400 `Invalid \`signature\` in
// \`thinking\` block`. This file pins the slice-A defences:
//
//   §2 C1        — thinking replays only from THIS turn (anchor identity),
//                  never from before it, never without requestOptions.
//   §3 Verbatim  — in-turn replay is the content array exactly as received
//                  (through the REAL http.js reducer), never rebuilt; the
//                  snapshot never reaches disk; every toolCalls/content edit
//                  goes through invalidateWireSnapshot.
//   §4 C2        — block_binding drop_block + beta header on flagged models,
//                  header ⇔ field at both claudeApiCall header sites, the
//                  rejection fallback and the credential-scoped capability.
//   §5 Registry  — thinkingBindingFor.
//   §6 C3        — signature-400 matcher + one turn-sticky heal per turn.
//   §7 C4        — input_transformations capture + [ThinkingBinding] logging.
//
// chat() is driven end-to-end with the REAL ai.js, providers/claude.js,
// reasoning-recovery.js, reasoning-gating.js, model-catalog.js, history-trim.js
// and task-store.js; only I/O edges (config, channel, bridge, memory, DB, the
// HTTP transport) are stubbed. The transport stub records every request's
// headers + body so invariants can be checked across ALL sends.
//
// Run:  node tests/nodejs-project/claude-thinking-binding.test.js

'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');

const BUNDLE = path.resolve(__dirname, '..', '..', 'app', 'src', 'main', 'assets', 'nodejs-project');
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'bat1664-'));
const TASKS_DIR = path.join(TMP, 'tasks');
fs.mkdirSync(TASKS_DIR, { recursive: true });

// ── log capture ─────────────────────────────────────────────────────────────
const LOGS = [];
function log(msg, level) { LOGS.push({ msg: String(msg), level: level || 'INFO' }); }

// ── stubs ───────────────────────────────────────────────────────────────────
function _stub(rel, exports) {
    const resolved = require.resolve(path.join(BUNDLE, rel));
    require.cache[resolved] = { id: resolved, filename: resolved, loaded: true, exports };
}

const KEY_A = 'sk-ant-test-CREDENTIAL-A-0123456789';
let currentModel = 'claude-fable-5-1';
let rtReasoning = false;

_stub('config.js', {
    workDir: TMP, TASKS_DIR,
    MODEL: 'claude-fable-5-1', resolveActiveModel: () => currentModel,
    PROVIDER: 'claude', CHANNEL: 'telegram',
    ANTHROPIC_KEY: KEY_A, OPENAI_KEY: '', XAI_KEY: '', OPENROUTER_KEY: '', CUSTOM_KEY: '',
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
    runtimeState: { read: () => ({ reasoningEnabled: rtReasoning, reasoningDisplayInChat: false }) },
});
_stub('security.js', { redactSecrets: (s) => s });
_stub('channel.js', {
    sendMessage: async () => {}, sendTyping: () => {}, getOwnerChatId: () => 'OWNER',
});
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

// Real claude adapter behind a stubbed provider registry (avoids loading every provider).
const claude = require(path.join(BUNDLE, 'providers', 'claude.js'));
_stub('providers/index.js', { getAdapter: () => claude });

// Real http.js reducer, stubbed transport.
const realHttp = require(path.join(BUNDLE, 'http.js'));
const SENT = []; // { headers, body(obj), raw(string) }
let SCRIPT = [];  // queue of (sentReq) => {status,data,headers?}
_stub('http.js', Object.assign({}, realHttp, {
    httpStreamingRequest: async (opts, body) => {
        const raw = typeof body === 'string' ? body : JSON.stringify(body);
        const req = { headers: Object.assign({}, opts.headers), body: JSON.parse(raw), raw };
        SENT.push(req);
        const next = SCRIPT.shift();
        if (!next) return { status: 200, data: textResp('(default)') };
        return next(req);
    },
}));

// Real task-store, wrapped so every checkpoint WRITE is captured from disk.
const realTaskStore = require(path.join(BUNDLE, 'task-store.js'));
const CHECKPOINT_FILES = [];
_stub('task-store.js', Object.assign({}, realTaskStore, {
    saveCheckpoint: (taskId, state) => {
        const r = realTaskStore.saveCheckpoint(taskId, state);
        try { CHECKPOINT_FILES.push(fs.readFileSync(path.join(TASKS_DIR, `${taskId}.json`), 'utf8')); } catch (_) {}
        return r;
    },
}));

const recovery = require(path.join(BUNDLE, 'reasoning-recovery.js'));
const gating = require(path.join(BUNDLE, 'reasoning-gating.js'));
const catalog = require(path.join(BUNDLE, 'model-catalog.js'));
const ai = require(path.join(BUNDLE, 'ai.js'));

const TOOLS = [{ name: 'read', description: 'read a thing', input_schema: { type: 'object', properties: {} } }];
ai.setChatDeps({
    executeTool: async () => ({ ok: true, v: 1 }),
    getTools: () => TOOLS,
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
    ok(label, a === e, `\n  actual:   ${a}\n  expected: ${e}`);
}

// ── fixtures ────────────────────────────────────────────────────────────────
const BIND_BETA = 'thinking-binding-controls-2026-08-01';
const BOUND_THINKING = { type: 'adaptive', block_binding: { prefix_mismatch_behavior: 'drop_block' } };
let _rid = 0;
function th(tag) { return { type: 'thinking', thinking: `reasoning ${tag}`, signature: `SIG-${tag}-` + 'x'.repeat(24) }; }
function tu(id) { return { type: 'tool_use', id, name: 'read', input: { q: id } }; }
function toolResp(blocks) {
    return { id: `msg_${++_rid}`, model: currentModel, type: 'message', role: 'assistant',
        content: blocks, stop_reason: 'tool_use', usage: { input_tokens: 1, output_tokens: 1 } };
}
function textResp(t, extra) {
    return Object.assign({ id: `msg_${++_rid}`, model: currentModel, type: 'message', role: 'assistant',
        content: [{ type: 'text', text: t }], stop_reason: 'end_turn', usage: { input_tokens: 1, output_tokens: 1 } }, extra || {});
}
const ok200 = (data) => () => ({ status: 200, data });
const err400 = (message) => () => ({ status: 400, data: { type: 'error', error: { type: 'invalid_request_error', message } } });

const SIG_400_TEXT = 'messages.3.content.0: Invalid `signature` in `thinking` block. The block is bound to a different conversation. Remove the block, or set `thinking.block_binding.prefix_mismatch_behavior` to "drop_block".';
const SIG_400_WITH_HINT = SIG_400_TEXT + ' That setting requires the `thinking-binding-controls-2026-08-01` value in the `anthropic-beta` header.';
const REJ_HEADER = 'Unexpected value(s) `thinking-binding-controls-2026-08-01` for the `anthropic-beta` header. Please consult our documentation at docs.claude.com or try again without the header.';
const REJ_FIELD = 'thinking.adaptive.block_binding: Extra inputs are not permitted';
const ENUM_ERR = "thinking.adaptive.block_binding.prefix_mismatch_behavior: Input should be 'error' or 'drop_block'";

function thinkingIn(apiMsg) {
    return Array.isArray(apiMsg.content) ? apiMsg.content.filter((b) => b.type === 'thinking' || b.type === 'redacted_thinking') : [];
}
function anyThinking(body) { return (body.messages || []).some((m) => m.role === 'assistant' && thinkingIn(m).length > 0); }
function hasHeader(req) { return String(req.headers['anthropic-beta'] || '').split(',').includes(BIND_BETA); }
function hasField(req) { return !!(req.body.thinking && req.body.thinking.block_binding); }
function streamEvents(content, extra) {
    // Build the exact Anthropic SSE event sequence for `content`.
    const ev = [{ eventType: 'message_start', data: { type: 'message_start', message: Object.assign({
        id: `msg_${++_rid}`, type: 'message', role: 'assistant', model: currentModel, content: [], usage: { input_tokens: 5 } },
        (extra && extra.startMessage) || {}) } }];
    content.forEach((b, i) => {
        if (b.type === 'thinking') {
            ev.push({ eventType: 'content_block_start', data: { index: i, content_block: { type: 'thinking', thinking: '', signature: '' } } });
            ev.push({ eventType: 'content_block_delta', data: { index: i, delta: { type: 'thinking_delta', thinking: b.thinking } } });
            ev.push({ eventType: 'content_block_delta', data: { index: i, delta: { type: 'signature_delta', signature: b.signature } } });
        } else if (b.type === 'redacted_thinking') {
            ev.push({ eventType: 'content_block_start', data: { index: i, content_block: { type: 'redacted_thinking', data: b.data } } });
        } else if (b.type === 'text') {
            ev.push({ eventType: 'content_block_start', data: { index: i, content_block: { type: 'text', text: '' } } });
            ev.push({ eventType: 'content_block_delta', data: { index: i, delta: { type: 'text_delta', text: b.text } } });
        } else if (b.type === 'tool_use') {
            ev.push({ eventType: 'content_block_start', data: { index: i, content_block: { type: 'tool_use', id: b.id, name: b.name, input: {} } } });
            ev.push({ eventType: 'content_block_delta', data: { index: i, delta: { type: 'input_json_delta', partial_json: JSON.stringify(b.input) } } });
        }
        ev.push({ eventType: 'content_block_stop', data: { index: i } });
    });
    ev.push({ eventType: 'message_delta', data: Object.assign({ delta: { stop_reason: 'tool_use' }, usage: { output_tokens: 9 } }, (extra && extra.delta) || {}) });
    ev.push({ eventType: 'message_stop', data: {} });
    return ev;
}
let _chatSeq = 0;
function newChatId() { return `chat-${++_chatSeq}`; }

// ════════════════════════════════════════════════════════════════════════════
async function main() {
    // ── §2 C1 — current-turn-only replay (adapter level) ────────────────────
    console.log('── §2 C1: the anchor is the only boundary ──');
    {
        const prevAnchor = { role: 'user', content: 'earlier question' };
        const prevAsst = { role: 'assistant', content: 'checking', toolCalls: [{ id: 'p1', name: 'read', input: {} }],
            reasoningBlocks: [{ sourceAdapter: 'claude', wire: th('prev') }] };
        // Same-process previous turn: its snapshot is still in memory.
        claude.setWireSnapshot(prevAsst, [th('prev'), { type: 'text', text: 'checking' }, tu('p1')]);
        const prevTool = { role: 'tool', toolCallId: 'p1', content: '{}' };
        const prevFinal = { role: 'assistant', content: 'done before', reasoningBlocks: [{ sourceAdapter: 'claude', wire: th('pf') }] };
        const legacy = { role: 'assistant', content: [th('legacy'), { type: 'text', text: 'legacy text' }] };
        const anchor = { role: 'user', content: 'new question' };
        const a1 = { role: 'assistant', content: 'step 1', toolCalls: [{ id: 'c1', name: 'read', input: {} }], reasoningBlocks: [] };
        claude.setWireSnapshot(a1, [th('a1'), { type: 'text', text: 'step 1' }, tu('c1')]);
        const t1 = { role: 'tool', toolCallId: 'c1', content: '{}' };
        const loopWarn = { role: 'user', content: '[System] You appear to be repeating the same tool call with identical arguments.' };
        const a2 = { role: 'assistant', content: 'step 2', toolCalls: [{ id: 'c2', name: 'read', input: {} }], reasoningBlocks: [] };
        claude.setWireSnapshot(a2, [th('a2'), { type: 'text', text: 'step 2' }, tu('c2')]);
        const t2 = { role: 'tool', toolCallId: 'c2', content: '{}' };
        const conv = [prevAnchor, prevAsst, prevTool, prevFinal, legacy, anchor, a1, t1, loopWarn, a2, t2];
        const before = JSON.stringify(conv);

        const out = claude.toApiMessages(conv, 'claude-fable-5-1', { turnAnchor: anchor });
        const asst = out.filter((m) => m.role === 'assistant');
        eq('C1: pre-anchor assistant (with an in-memory snapshot) replays NO thinking', thinkingIn(asst[0]).length, 0);
        eq('C1: pre-anchor final answer replays NO thinking', thinkingIn(asst[1]).length, 0);
        eq('C1: legacy native array before the anchor — thinking stripped, text kept', asst[2].content, [{ type: 'text', text: 'legacy text' }]);
        eq('C1: in-turn message BEFORE the loop-warn replays its thinking', thinkingIn(asst[3]).map((b) => b.signature), [th('a1').signature]);
        eq('C1: mid-turn [System] loop-warn (role user) does NOT move the boundary', thinkingIn(asst[4]).map((b) => b.signature), [th('a2').signature]);
        eq('C1: stored history is never mutated by emission', JSON.stringify(conv), before);
        ok('C1: emission does not drop the in-memory snapshots', !!claude.getWireSnapshot(a1) && !!claude.getWireSnapshot(prevAsst));

        const noOpts = claude.toApiMessages(conv);
        ok('C1: no requestOptions (vision / summaries) → no thinking anywhere', !anyThinking({ messages: noOpts }));
        const noAnchor = claude.toApiMessages(conv, 'm', { turnAnchor: null });
        ok('C1: absent anchor → no thinking anywhere (never a role scan)', !anyThinking({ messages: noAnchor }));
        const foreignAnchor = claude.toApiMessages(conv, 'm', { turnAnchor: { role: 'user', content: 'new question' } });
        ok('C1: an EQUAL but non-identical anchor object → no thinking (identity, not value)', !anyThinking({ messages: foreignAnchor }));

        // Resume: restored checkpoint messages precede the resume turn's anchor.
        const restored = JSON.parse(JSON.stringify([prevAnchor, prevAsst, prevTool]));
        const resumeAnchor = { role: 'user', content: 'continue' };
        const resumeOut = claude.toApiMessages([...restored, resumeAnchor], 'm', { turnAnchor: resumeAnchor });
        ok('C1: resume replays nothing from before the anchor', !anyThinking({ messages: resumeOut }));

        // Text-only turn: nothing after the anchor.
        const textOnly = claude.toApiMessages([prevAnchor, prevAsst, prevTool, anchor], 'm', { turnAnchor: anchor });
        ok('C1: text-only turn (round 1) carries no thinking', !anyThinking({ messages: textOnly }));
    }

    // ── §3 Verbatim — the real http.js reducer → fromApiResponse → storage → toApiMessages ──
    console.log('\n── §3 Verbatim in-turn replay ──');
    const FIXTURES = {
        'interleaved [thinking,text,tool_use,thinking,tool_use]':
            [th('v1'), { type: 'text', text: 'first I look' }, tu('v_t1'), th('v2'), tu('v_t2')],
        'multi-text + redacted':
            [{ type: 'redacted_thinking', data: 'OPAQUE==' }, { type: 'text', text: 'part one' }, { type: 'text', text: 'part two' }, tu('v_t3'), th('v3'), tu('v_t4')],
    };
    for (const [name, content] of Object.entries(FIXTURES)) {
        const assembled = realHttp.assembleClaudeStreamMessage(streamEvents(content));
        const parsed = claude.fromApiResponse(assembled);
        const stored = { role: 'assistant', content: parsed.text || '', toolCalls: parsed.toolCalls, reasoningBlocks: parsed.reasoningBlocks };
        claude.setWireSnapshot(stored, parsed.wireContent);
        const anchor = { role: 'user', content: 'go' };
        const tools = parsed.toolCalls.map((tc) => ({ role: 'tool', toolCallId: tc.id, content: '{}' }));
        const out = claude.toApiMessages([anchor, stored, ...tools], currentModel, { turnAnchor: anchor });
        eq(`Verbatim (${name}): replayed content === streamed content (order, multi-text, signatures)`, out[1].content, assembled.content);
        // Negative control (today's path): neutral rebuild = thinking first + joined text.
        const legacyRebuild = [...parsed.reasoningBlocks.map((b) => b.wire),
            ...(parsed.text ? [{ type: 'text', text: parsed.text }] : []),
            ...parsed.toolCalls.map((tc) => ({ type: 'tool_use', id: tc.id, name: tc.name, input: tc.input }))];
        ok(`Verbatim (${name}): negative control — the old join/reorder rebuild DIFFERS from the wire`,
            JSON.stringify(legacyRebuild) !== JSON.stringify(assembled.content));
        ok(`Verbatim (${name}): snapshot is a deep copy (mutating the response does not change it)`,
            (() => { const before = JSON.stringify(claude.getWireSnapshot(stored)); assembled.content[0].x = 1; return JSON.stringify(claude.getWireSnapshot(stored)) === before; })());
        ok(`Verbatim (${name}): snapshot is non-enumerable (JSON / spread never carry it)`,
            !JSON.stringify(stored).includes('claudeWireContent') && !('claudeWireContent' in { ...stored })
            && !Object.keys(stored).includes('claudeWireContent'));
    }

    // Capture validity: a malformed thinking block never enters the snapshot.
    {
        const parsed = claude.fromApiResponse(toolResp([{ type: 'thinking', thinking: '', signature: '  ' }, th('good'), tu('m1')]));
        eq('Verbatim: wireContent drops a blank-signature block (same rule as reasoningBlocks)',
            parsed.wireContent.map((b) => b.type), ['thinking', 'tool_use']);
    }

    // Missing snapshot → strip that message AND every later one in the turn.
    {
        const anchor = { role: 'user', content: 'go' };
        const a1 = { role: 'assistant', content: 'one', toolCalls: [{ id: 'm1', name: 'read', input: {} }] };
        const a2 = { role: 'assistant', content: 'two', toolCalls: [{ id: 'm2', name: 'read', input: {} }] };
        claude.setWireSnapshot(a2, [th('later'), { type: 'text', text: 'two' }, tu('m2')]);
        const out = claude.toApiMessages([anchor, a1, { role: 'tool', toolCallId: 'm1', content: '{}' }, a2,
            { role: 'tool', toolCallId: 'm2', content: '{}' }], 'm', { turnAnchor: anchor });
        ok('Verbatim: missing snapshot strips the LATER in-turn message too', !anyThinking({ messages: out }));
        const sticky = claude.toApiMessages([anchor, a2, { role: 'tool', toolCallId: 'm2', content: '{}' }], 'm', { turnAnchor: anchor, stripAllThinking: true });
        ok('Verbatim: stripAllThinking strips even a valid snapshot', !anyThinking({ messages: sticky }));
    }

    // Mixed valid + orphan sanitize pin (with negative control).
    {
        const conv = [];
        const anchor = { role: 'user', content: 'go' };
        const a1 = { role: 'assistant', content: 'two calls', toolCalls: [{ id: 'k1', name: 'read', input: {} }, { id: 'k2', name: 'read', input: {} }] };
        claude.setWireSnapshot(a1, [th('k'), { type: 'text', text: 'two calls' }, tu('k1'), tu('k2')]);
        const a2 = { role: 'assistant', content: 'next', toolCalls: [{ id: 'k3', name: 'read', input: {} }] };
        claude.setWireSnapshot(a2, [th('k3'), { type: 'text', text: 'next' }, tu('k3')]);
        conv.push(anchor, a1, { role: 'tool', toolCallId: 'k1', content: '{}' }, /* k2 orphan */ a2, { role: 'tool', toolCallId: 'k3', content: '{}' });
        // Negative control: BEFORE sanitize, verbatim replay would carry the orphan tool_use k2 (→ 400 tool_use without tool_result).
        const pre = claude.toApiMessages(conv, 'm', { turnAnchor: anchor });
        ok('Sanitize pin: negative control — un-invalidated snapshot WOULD replay orphan tool_use k2',
            pre[1].content.some((b) => b.type === 'tool_use' && b.id === 'k2'));
        const epoch0 = claude.wireEditEpoch(conv);
        const stripped = ai._sanitizeConversationForTest(conv, 'turn-sanitize');
        ok('Sanitize pin: the orphan call was stripped', stripped === 1 && a1.toolCalls.length === 1);
        ok('Sanitize pin: the edited message lost its snapshot', claude.getWireSnapshot(a1) === null);
        ok('Sanitize pin: the conversation epoch moved (→ stripAllThinking for the turn)', claude.wireEditEpoch(conv) === epoch0 + 1);
        const post = claude.toApiMessages(conv, 'm', { turnAnchor: anchor });
        ok('Sanitize pin: the edited message emits no orphan tool_use', !post[1].content.some((b) => b.type === 'tool_use' && b.id === 'k2'));
        ok('Sanitize pin: the edited message AND the later valid one carry no thinking', !anyThinking({ messages: post }));
    }

    // Source guard: no direct `.toolCalls =` outside invalidateWireSnapshot.
    {
        const offenders = [];
        const walk = (dir) => {
            for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
                if (e.name === 'node_modules') continue;
                const p = path.join(dir, e.name);
                if (e.isDirectory()) walk(p);
                else if (e.name.endsWith('.js') && !e.name.endsWith('.min.js')) {
                    const lines = fs.readFileSync(p, 'utf8').split(/\r?\n/);
                    lines.forEach((l, i) => {
                        if (!/\.toolCalls\s*=(?!=)/.test(l)) return;
                        if (/^\s*(\/\/|\*)/.test(l)) return; // comments
                        const rel = path.relative(BUNDLE, p).replace(/\\/g, '/');
                        // Allowed: the helper itself; task-store's on-disk redaction CLONE.
                        if (rel === 'providers/claude.js' && /^\s*if \(Array\.isArray\(toolCalls\)\) msg\.toolCalls = toolCalls;/.test(l)) return;
                        if (rel === 'task-store.js' && /clone\.toolCalls\s*=/.test(l)) return;
                        offenders.push(`${rel}:${i + 1}: ${l.trim()}`);
                    });
                }
            }
        };
        walk(BUNDLE);
        eq('Source guard: no direct `.toolCalls =` assignment outside invalidateWireSnapshot', offenders, []);
        const aiSrc = fs.readFileSync(path.join(BUNDLE, 'ai.js'), 'utf8');
        ok('Source guard: the loop-final clear goes through the helper',
            /invalidateWireSnapshot\(lastMsg, messages, \[\]\)/.test(aiSrc));
    }

    // ── chat()-level: 3-round byte identity + serialization ─────────────────
    console.log('\n── §3 Verbatim through chat(): 3 rounds ──');
    {
        currentModel = 'claude-opus-5'; // unflagged → no binding noise in this block
        const chatId = newChatId();
        const r1 = [th('r1'), { type: 'text', text: 'look 1' }, tu('r1_t'), th('r1b'), tu('r1_u')];
        const r2 = [th('r2'), { type: 'text', text: 'a' }, { type: 'text', text: 'b' }, tu('r2_t')];
        const r3 = [{ type: 'redacted_thinking', data: 'RRR' }, tu('r3_t')];
        SENT.length = 0;
        SCRIPT = [
            () => ({ status: 200, data: realHttp.assembleClaudeStreamMessage(streamEvents(r1)) }),
            () => ({ status: 200, data: realHttp.assembleClaudeStreamMessage(streamEvents(r2)) }),
            () => ({ status: 200, data: realHttp.assembleClaudeStreamMessage(streamEvents(r3)) }),
            ok200(textResp('all done')),
        ];
        CHECKPOINT_FILES.length = 0;
        const reply = await ai.chat(chatId, 'do the three-step thing');
        eq('3-round: final reply', reply, 'all done');
        eq('3-round: 4 requests sent', SENT.length, 4);
        ok('3-round: round 1 carries no thinking (nothing in-turn yet)', !anyThinking(SENT[0].body));
        for (let k = 1; k < SENT.length; k++) {
            const prev = SENT[k - 1].body, cur = SENT[k].body;
            eq(`3-round: request ${k + 1} system byte-identical to request ${k}`, JSON.stringify(cur.system), JSON.stringify(prev.system));
            eq(`3-round: request ${k + 1} tools byte-identical to request ${k}`, JSON.stringify(cur.tools), JSON.stringify(prev.tools));
            const prevAssist = prev.messages.map((m, i) => [m, i]).filter(([m]) => m.role === 'assistant');
            ok(`3-round: every assistant array of request ${k} is byte-identical in request ${k + 1}`,
                prevAssist.every(([m, i]) => JSON.stringify(cur.messages[i]) === JSON.stringify(m)));
        }
        const lastAssist = SENT[3].body.messages.filter((m) => m.role === 'assistant');
        eq('3-round: replayed arrays equal the streamed content, in order',
            lastAssist.slice(-3).map((m) => m.content), [r1, r2, r3].map((c) => realHttp.assembleClaudeStreamMessage(streamEvents(c)).content));
        ok('3-round: at least one checkpoint was written', CHECKPOINT_FILES.length >= 2);
        ok('3-round: claudeWireContent never reaches a checkpoint file',
            CHECKPOINT_FILES.every((f) => !f.includes('claudeWireContent')));
        const conv = ai.getConversation(chatId);
        ok('3-round: conversation JSON never carries claudeWireContent', !JSON.stringify(conv).includes('claudeWireContent'));
        ok('3-round: header ⇔ field (unflagged → neither)', SENT.every((r) => !hasHeader(r) && !hasField(r)));
    }

    // In-turn edit through chat(): a whitespace-padded tool name is normalized
    // (an edit of the stored toolCalls) → the snapshot is invalidated and the
    // rest of the turn replays no thinking.
    {
        currentModel = 'claude-opus-5';
        const chatId = newChatId();
        SENT.length = 0;
        SCRIPT = [
            ok200(toolResp([th('pad'), { type: 'tool_use', id: 'pad_t', name: ' read ', input: {} }])),
            ok200(toolResp([th('pad2'), tu('pad_u')])),
            ok200(textResp('done')),
        ];
        await ai.chat(chatId, 'q');
        ok('In-turn edit (tool-name trim): the next request replays NO thinking', !anyThinking(SENT[1].body));
        ok('In-turn edit: the edited message goes out normalized with the trimmed name',
            SENT[1].body.messages.some((m) => m.role === 'assistant' && m.content.some((b) => b.type === 'tool_use' && b.name === 'read' && b.id === 'pad_t')));
        ok('In-turn edit: stripAllThinking is turn-sticky (a later valid snapshot is stripped too)', !anyThinking(SENT[2].body));
    }
    // Epoch-only cases: an edit that leaves EVERY remaining in-turn message with a
    // valid snapshot. toApiMessages' own stripRest cannot see it (nothing is
    // missing a snapshot); only chat()'s wire-edit-epoch check turns on
    // stripAllThinking. Two shapes, both performed between rounds (during tool
    // execution of round 2): (a) a PRE-anchor assistant is edited, (b) the
    // round-1 in-turn assistant + its tool result are spliced out entirely.
    for (const variant of ['pre-anchor edit', 'in-turn splice']) {
        currentModel = 'claude-opus-5';
        const chatId = newChatId();
        ai.addToConversation(chatId, 'user', 'earlier question');
        ai.addToConversation(chatId, 'assistant', 'earlier answer');
        const conv = ai.getConversation(chatId);
        let calls = 0;
        ai.setChatDeps({
            executeTool: async () => {
                calls++;
                if (calls === 2) {
                    if (variant === 'pre-anchor edit') {
                        const old = conv.find((m) => m.role === 'assistant' && m.content === 'earlier answer');
                        claude.invalidateWireSnapshot(old, conv);
                        old.content = 'earlier answer (edited)';
                    } else {
                        const a1 = conv.find((m) => m.role === 'assistant' && Array.isArray(m.toolCalls) && m.toolCalls.some((tc) => tc.id === 'ep_t1'));
                        const i = conv.indexOf(a1);
                        claude.invalidateWireSnapshot(a1, conv);
                        conv.splice(i, 2); // a1 + its tool result
                    }
                }
                return { ok: true };
            },
        });
        SENT.length = 0;
        SCRIPT = [
            ok200(toolResp([th('ep1'), tu('ep_t1')])),
            ok200(toolResp([th('ep2'), tu('ep_t2')])),
            ok200(textResp('done')),
        ];
        await ai.chat(chatId, 'q');
        ai.setChatDeps({ executeTool: async () => ({ ok: true, v: 1 }) });
        eq(`Epoch (${variant}): 3 requests`, SENT.length, 3);
        ok(`Epoch (${variant}): request 2 (before the edit) replays in-turn thinking`, anyThinking(SENT[1].body));
        const inTurnAfter = conv.filter((m) => m.role === 'assistant' && Array.isArray(m.toolCalls) && m.toolCalls.length > 0);
        ok(`Epoch (${variant}): precondition — every remaining in-turn assistant still has a valid snapshot`,
            inTurnAfter.length >= 1 && inTurnAfter.every((m) => !!claude.getWireSnapshot(m)));
        ok(`Epoch (${variant}): request 3 (after the edit) carries NO thinking blocks at all`, !anyThinking(SENT[2].body));
    }

    // Loop-final: tool calls are cleared through the helper (source guard above).

    // ── §4 C2 — binding on flagged models ───────────────────────────────────
    console.log('\n── §4 C2: block binding ──');
    async function twoRoundTurn(chatId, opts) {
        SENT.length = 0;
        SCRIPT = [ok200(toolResp([th('b1'), { type: 'text', text: 'x' }, tu(`b_${chatId}`)])), ok200(textResp('fin'))];
        return ai.chat(chatId, 'question', opts || {});
    }
    {
        currentModel = 'claude-fable-5-1';
        await twoRoundTurn(newChatId());
        ok('C2 flagged, round 1 (no thinking emitted) → no binding', !hasField(SENT[0]) && !hasHeader(SENT[0]));
        ok('C2 flagged, round 2 (in-turn thinking) → body block_binding drop_block', hasField(SENT[1])
            && JSON.stringify(SENT[1].body.thinking) === JSON.stringify(BOUND_THINKING));
        ok('C2 flagged, round 2 → anthropic-beta carries thinking-binding-controls-2026-08-01', hasHeader(SENT[1]));
        ok('C2 flagged, round 2 → base beta tags kept', /prompt-caching-2024-07-31/.test(SENT[1].headers['anthropic-beta'])
            && /interleaved-thinking-2025-05-14/.test(SENT[1].headers['anthropic-beta']));

        currentModel = 'claude-opus-5';
        await twoRoundTurn(newChatId());
        ok('C2 unflagged, round 2 replays thinking but sends NO binding', anyThinking(SENT[1].body) && !hasField(SENT[1]) && !hasHeader(SENT[1]));
        currentModel = 'claude-fable-5-1';

        // Off / heartbeat: binding still sent (flagged models think adaptively anyway) + log gate.
        rtReasoning = true;
        gating._resetSuppressionLogForTest();
        const logMark = LOGS.length;
        await twoRoundTurn('__heartbeat__', { reasoningMode: 'off', synthetic: 'heartbeat' });
        ok('C2 heartbeat/off, round 1 → no thinking field at all', !('thinking' in SENT[0].body));
        ok('C2 heartbeat/off, round 2 → binding sent anyway', hasField(SENT[1]) && hasHeader(SENT[1]));
        const hbLogs = LOGS.slice(logMark).filter((l) => l.msg.includes('suppressed: synthetic-heartbeat'));
        eq('C2 heartbeat log gate: "suppressed" logged ONLY for the unbound request (1 of 2)', hbLogs.length, 1);
        rtReasoning = false;
        ai.clearConversation('__heartbeat__');
    }

    // Header ⇔ field at BOTH claudeApiCall header sites.
    {
        const body = claude.formatRequest('claude-fable-5-1', 4096, [], [], [], { bindThinking: true });
        SENT.length = 0;
        SCRIPT = [ok200(textResp('a'))];
        await ai._claudeApiCallForTest(body, null, { anthropicBetaExtra: [BIND_BETA] });
        ok('Header site 1 (initial build): beta present with the field', hasHeader(SENT[0]) && hasField(SENT[0]));
        const plain = claude.formatRequest('claude-fable-5-1', 4096, [], [], [], {});
        SCRIPT = [ok200(textResp('a'))];
        await ai._claudeApiCallForTest(plain, null, {});
        ok('Header site 1: no extra → no beta, no field', !hasHeader(SENT[1]) && !hasField(SENT[1]));

        // Site 2: the 401 → handleUnauthorized → rebuild path.
        const origClassify = claude.classifyError;
        claude.handleUnauthorized = async () => {};
        claude.classifyError = (status, data) => (status === 401
            ? { type: 'auth', retryable: true, userMessage: 'auth' } : origClassify(status, data));
        try {
            SENT.length = 0;
            SCRIPT = [() => ({ status: 401, data: { error: { type: 'authentication_error', message: 'x' } } }), ok200(textResp('b'))];
            await ai._claudeApiCallForTest(body, null, { anthropicBetaExtra: [BIND_BETA] });
            eq('Header site 2 (401 rebuild): two sends', SENT.length, 2);
            ok('Header site 2 (401 rebuild): the rebuilt headers still carry the beta', hasHeader(SENT[1]) && hasField(SENT[1]));
            SENT.length = 0;
            SCRIPT = [() => ({ status: 401, data: { error: { type: 'authentication_error', message: 'x' } } }), ok200(textResp('c'))];
            await ai._claudeApiCallForTest(plain, null, {});
            ok('Header site 2 (401 rebuild): no extra → rebuilt headers carry no beta', !hasHeader(SENT[1]));
        } finally {
            delete claude.handleUnauthorized;
            claude.classifyError = origClassify;
        }
        const aiSrc = fs.readFileSync(path.join(BUNDLE, 'ai.js'), 'utf8');
        const callStart = aiSrc.indexOf('async function claudeApiCall(');
        const callEnd = aiSrc.indexOf('\n}\n', callStart) > 0 ? aiSrc.indexOf('\n}\n', callStart) : aiSrc.indexOf('\r\n}\r\n', callStart);
        const callSrc = aiSrc.slice(callStart, callEnd);
        eq('Header sites: claudeApiCall has NO raw adapter.buildHeaders(apiKey, AUTH_TYPE) build left',
            (callSrc.match(/headers = adapter\.buildHeaders\(/g) || []).length, 0);
        eq('Header sites: both builds go through the beta-aware builder', (callSrc.match(/headers = _buildRequestHeaders\(/g) || []).length, 2);
    }

    // Matcher pins.
    console.log('\n── §4 C2 / §6 C3: matcher pins ──');
    {
        const d = (m) => ({ type: 'error', error: { type: 'invalid_request_error', message: m } });
        ok('Matcher: signature text → signature path', recovery.isThinkingSignature400(400, d(SIG_400_TEXT)));
        ok('Matcher: signature text WITH the beta hint → signature path', recovery.isThinkingSignature400(400, d(SIG_400_WITH_HINT)));
        ok('Matcher: signature WITH hint + binding sent → NOT a rejection (signature wins)', !recovery.isBindingRejected400(400, d(SIG_400_WITH_HINT), true));
        ok('Matcher: header rejection + binding sent → rejection', recovery.isBindingRejected400(400, d(REJ_HEADER), true));
        ok('Matcher: field rejection + binding sent → rejection', recovery.isBindingRejected400(400, d(REJ_FIELD), true));
        ok('Matcher: header rejection WITHOUT binding sent → neither', !recovery.isBindingRejected400(400, d(REJ_HEADER), false) && !recovery.isThinkingSignature400(400, d(REJ_HEADER)));
        ok('Matcher: field rejection WITHOUT binding sent → neither', !recovery.isBindingRejected400(400, d(REJ_FIELD), false) && !recovery.isThinkingSignature400(400, d(REJ_FIELD)));
        ok('Matcher: enum error (bad value) → neither', !recovery.isBindingRejected400(400, d(ENUM_ERR), true) && !recovery.isThinkingSignature400(400, d(ENUM_ERR)));
        ok('Matcher: unrelated 400 → neither', !recovery.isBindingRejected400(400, d('max_tokens: field required'), true) && !recovery.isThinkingSignature400(400, d('max_tokens: field required')));
        ok('Matcher: rejection text not anchored at start → not a rejection', !recovery.isBindingRejected400(400, d('note: ' + REJ_FIELD), true));
        ok('Matcher: rejection needs invalid_request_error', !recovery.isBindingRejected400(400, { error: { type: 'api_error', message: REJ_FIELD } }, true));
        ok('Matcher: rejection needs status 400', !recovery.isBindingRejected400(500, d(REJ_FIELD), true));
        // C3 scan rules (copied from isReasoningContent400).
        ok('C3 scan: string body', recovery.isThinkingSignature400(400, SIG_400_TEXT));
        ok('C3 scan: Buffer body', recovery.isThinkingSignature400(400, Buffer.from(SIG_400_TEXT)));
        ok('C3 scan: top-level message', recovery.isThinkingSignature400(400, { message: SIG_400_TEXT }));
        ok('C3 scan: NO stringify fallback (text in an unknown field)', !recovery.isThinkingSignature400(400, { detail: SIG_400_TEXT }));
        ok('C3 scan: beyond the 4 KB scan limit → no match', !recovery.isThinkingSignature400(400, 'x'.repeat(5000) + SIG_400_TEXT));
        ok('C3: status ≠ 400 → no match', !recovery.isThinkingSignature400(500, d(SIG_400_TEXT)));
        // Non-overlap with the existing recoveries.
        ok('Non-overlap: signature text is not a reasoning_content 400', !recovery.isReasoningContent400(400, d(SIG_400_WITH_HINT)));
        ok('Non-overlap: signature text is not the usage-filter 400', !ai._isUsageFilter400(400, d(SIG_400_WITH_HINT)));
        const rc = "The 'reasoning_content' in the thinking mode must be passed back to the API.";
        ok('Non-overlap: reasoning_content 400 matches neither new matcher', !recovery.isThinkingSignature400(400, d(rc)) && !recovery.isBindingRejected400(400, d(rc), true));
        ok('Non-overlap: usage-filter 400 matches neither new matcher', !recovery.isThinkingSignature400(400, d("You're out of extra usage")) && !recovery.isBindingRejected400(400, d("You're out of extra usage"), true));
        // Placement: after the sanitized ERROR log, before the reasoning-400 quarantine.
        const aiSrc = fs.readFileSync(path.join(BUNDLE, 'ai.js'), 'utf8');
        const iErr = aiSrc.indexOf('log(`API error: status=${res.status}');
        const iSig = aiSrc.indexOf('_reasoningRecovery.isThinkingSignature400(res.status, res.data)', iErr);
        const iRej = aiSrc.indexOf('_reasoningRecovery.isBindingRejected400(res.status, res.data, _bind)', iErr);
        const iQuar = aiSrc.indexOf('_reasoningRecovery.isReasoningContent400(res.status, res.data)', iErr);
        ok('Placement: ERROR log < signature check < binding-rejection check < reasoning-400 quarantine',
            iErr > 0 && iSig > iErr && iRej > iSig && iQuar > iRej, `err=${iErr} sig=${iSig} rej=${iRej} quar=${iQuar}`);
    }

    // C2 fallback + credential-scoped capability.
    console.log('\n── §4 C2: rejection fallback + credential-scoped capability ──');
    {
        ai._bindingCapabilityForTest.reset();
        currentModel = 'claude-fable-5-1';
        const chatId = newChatId();
        SENT.length = 0;
        SCRIPT = [ok200(toolResp([th('f1'), tu('f_t1')])), err400(REJ_FIELD), ok200(textResp('recovered'))];
        const logMark = LOGS.length;
        const reply = await ai.chat(chatId, 'q');
        eq('C2 fallback: turn recovers', reply, 'recovered');
        eq('C2 fallback: exactly one retry (3 sends)', SENT.length, 3);
        ok('C2 fallback: the rejected request sent header + field', hasHeader(SENT[1]) && hasField(SENT[1]));
        ok('C2 fallback: the retry sends NEITHER header NOR field', !hasHeader(SENT[2]) && !hasField(SENT[2]));
        ok('C2 fallback: the retry carries no thinking (stripAllThinking)', !anyThinking(SENT[2].body));
        const host = claude.endpoint.hostname;
        ok('Capability: credential A is recorded as denied', ai._bindingCapabilityForTest.isDenied(host, 'api_key', KEY_A));
        ok('Capability: credential B on the same route is NOT denied', !ai._bindingCapabilityForTest.isDenied(host, 'api_key', 'sk-ant-test-CREDENTIAL-B'));
        ok('Capability: same credential, other auth type is NOT denied', !ai._bindingCapabilityForTest.isDenied(host, 'setup_token', KEY_A));

        // Next turn on credential A: in-turn thinking is replayed but binding is not sent.
        await twoRoundTurn(chatId);
        ok('Capability: next turn on credential A → thinking replayed, NO binding', anyThinking(SENT[1].body) && !hasField(SENT[1]) && !hasHeader(SENT[1]));

        // Credential B still sends: record B only after a send with B — simulate via the store.
        ai._bindingCapabilityForTest.reset();
        ai._bindingCapabilityForTest.record(host, 'api_key', 'sk-ant-test-CREDENTIAL-B');
        await twoRoundTurn(newChatId());
        ok('Capability: A rejected-for-B does not block A (B recorded, A still binds)', hasField(SENT[1]) && hasHeader(SENT[1]));

        // A signature 400 with binding sent never records a capability.
        ai._bindingCapabilityForTest.reset();
        const body = claude.formatRequest('claude-fable-5-1', 4096, [], [], [], { bindThinking: true });
        SCRIPT = [err400(SIG_400_WITH_HINT)];
        await ai._claudeApiCallForTest(body, null, { anthropicBetaExtra: [BIND_BETA] });
        eq('Capability: a signature 400 (even with the beta hint) records nothing', ai._bindingCapabilityForTest.size(), 0);
        SCRIPT = [err400(REJ_HEADER)];
        await ai._claudeApiCallForTest(plainBody(), null, {});
        eq('Capability: a rejection text on a request WITHOUT the binding records nothing', ai._bindingCapabilityForTest.size(), 0);

        const hashA = crypto.createHash('sha256').update(KEY_A, 'utf8').digest('hex');
        const leaked = LOGS.slice(logMark).filter((l) => l.msg.includes(KEY_A) || l.msg.includes(hashA) || l.msg.includes(hashA.slice(0, 16)));
        eq('Capability: no credential or credential hash in any log line', leaked.map((l) => l.msg), []);
        ok('Capability: the rejection is logged (tagged, no secrets)', LOGS.slice(logMark).some((l) => l.msg.startsWith('[ThinkingBinding]') && l.msg.includes('binding control rejected')));
        ai._bindingCapabilityForTest.reset();
    }

    // ── §5 Registry ─────────────────────────────────────────────────────────
    console.log('\n── §5 Registry: thinkingBindingFor ──');
    {
        ok('Registry: claude-fable-5-1 (api_key) → true', catalog.thinkingBindingFor('claude', 'claude-fable-5-1', 'api_key') === true);
        ok('Registry: claude-fable-5-1 (setup_token) → true', catalog.thinkingBindingFor('claude', 'claude-fable-5-1', 'setup_token') === true);
        for (const m of ['claude-fable-5', 'claude-opus-5', 'claude-sonnet-4-6', 'claude-haiku-4-5', 'claude-fable-5-1-custom', 'my-proxy-model', '', null]) {
            ok(`Registry: ${JSON.stringify(m)} → false`, catalog.thinkingBindingFor('claude', m, 'api_key') === false);
        }
        ok('Registry: custom provider, same id → false', catalog.thinkingBindingFor('custom', 'claude-fable-5-1', 'api_key') === false);
        ok('Registry: openrouter → false', catalog.thinkingBindingFor('openrouter', 'anthropic/claude-fable-5-1', 'api_key') === false);
        const reg = JSON.parse(fs.readFileSync(path.join(BUNDLE, 'model-registry.json'), 'utf8'));
        const flagged = [];
        for (const p of reg.providers) for (const m of (p.models || [])) if ('thinkingBinding' in m) flagged.push(`${p.id}/${m.id}=${m.thinkingBinding}`);
        eq('Registry: the field is set exactly once (claude/claude-fable-5-1=true)', flagged, ['claude/claude-fable-5-1=true']);
    }

    // ── §6 C3 — signature heal through chat() ───────────────────────────────
    console.log('\n── §6 C3: signature 400 heal ──');
    {
        currentModel = 'claude-opus-5'; // any first-party Claude model (unflagged here)
        const chatId = newChatId();
        SENT.length = 0;
        let historyAtFailure = null;
        SCRIPT = [
            ok200(toolResp([th('s1'), tu('s_t1')])),
            () => { historyAtFailure = JSON.stringify(ai.getConversation(chatId)); return err400(SIG_400_TEXT)(); },
            ok200(toolResp([th('s2'), tu('s_t2')])),
            ok200(textResp('healed')),
        ];
        const logMark = LOGS.length;
        let reply;
        try { reply = await ai.chat(chatId, 'q'); } catch (e) { reply = `THREW: ${e.message}`; }
        eq('C3: turn recovers after one signature 400', reply, 'healed');
        eq('C3: 4 sends (1 retry)', SENT.length, 4);
        ok('C3: the failing request carried thinking', anyThinking(SENT[1].body));
        ok('C3: the retry carries NO thinking', !anyThinking(SENT[2].body));
        ok('C3: turn-sticky — a LATER round (new in-turn thinking) still carries none', !anyThinking(SENT[3].body));
        {
            const atFail = historyAtFailure ? JSON.parse(historyAtFailure) : null;
            const now = ai.getConversation(chatId);
            ok('C3: stored history unchanged by the heal (every message present at the failure is byte-identical after the turn)',
                !!atFail && JSON.stringify(now.slice(0, atFail.length)) === historyAtFailure);
            const inTurnAsst = now.filter((m) => m.role === 'assistant' && Array.isArray(m.toolCalls) && m.toolCalls.length > 0);
            ok('C3: the heal did not drop the in-memory wire snapshots (strip is emission-only)',
                inTurnAsst.length >= 1 && inTurnAsst.every((m) => !!claude.getWireSnapshot(m)));
        }
        ok('C3: heal logged with the [ThinkingBinding] tag', LOGS.slice(logMark).some((l) => l.msg.startsWith('[ThinkingBinding]') && l.msg.includes('thinking-signature mismatch') && l.level === 'WARN'));

        // A second signature 400 in the same turn surfaces (classifyApiError).
        const chat2 = newChatId();
        SENT.length = 0;
        SCRIPT = [ok200(toolResp([th('s3'), tu('s_t3')])), err400(SIG_400_TEXT), err400(SIG_400_TEXT)];
        let threw = null;
        try { await ai.chat(chat2, 'q'); } catch (e) { threw = e; }
        ok('C3: a second signature 400 in the same turn surfaces as an error', threw && /API error \(400\)/.test(threw.message), threw && threw.message);
        eq('C3: no third retry', SENT.length, 3);

        // Non-Claude adapter never takes the C3 path: pinned by the `adapter.id === 'claude'` gate.
        const aiSrc = fs.readFileSync(path.join(BUNDLE, 'ai.js'), 'utf8');
        ok('C3: gated to first-party Claude', /adapter\.id === 'claude'\s*&& _reasoningRecovery\.isThinkingSignature400/.test(aiSrc));
    }

    // ── §7 C4 — input_transformations ───────────────────────────────────────
    console.log('\n── §7 C4: input_transformations ──');
    {
        const IT = [{ type: 'thinking_dropped', path: 'messages.1.content.0', reason: 'prefix_binding_mismatch' }];
        const fromStart = realHttp.assembleClaudeStreamMessage(streamEvents([{ type: 'text', text: 'hi' }], { startMessage: { input_transformations: IT } }));
        eq('C4: captured from message_start', fromStart.input_transformations, IT);
        const IT2 = [{ type: 'thinking_dropped', path: 'messages.3.content.0', reason: 'model_binding_mismatch' }];
        const fromDelta = realHttp.assembleClaudeStreamMessage(streamEvents([{ type: 'text', text: 'hi' }], { startMessage: { input_transformations: [] }, delta: { input_transformations: IT2 } }));
        eq('C4: final message_delta (top-level) overrides message_start', fromDelta.input_transformations, IT2);
        const fromNested = realHttp.assembleClaudeStreamMessage(streamEvents([{ type: 'text', text: 'hi' }], { delta: { delta: { stop_reason: 'end_turn', input_transformations: IT2 } } }));
        eq('C4: message_delta delta.input_transformations also captured', fromNested.input_transformations, IT2);
        const none = realHttp.assembleClaudeStreamMessage(streamEvents([{ type: 'text', text: 'hi' }]));
        ok('C4: absent when the API sends none', !('input_transformations' in none));
        eq('C4: fromApiResponse exposes parsed.inputTransformations', claude.fromApiResponse(fromStart).inputTransformations, IT);
        eq('C4: fromApiResponse → null when absent', claude.fromApiResponse(none).inputTransformations, null);

        gating._resetSuppressionLogForTest();
        let mark = LOGS.length;
        ai._logInputTransformations([], 'm');
        ai._logInputTransformations(null, 'm');
        eq('C4: nothing logged for an empty / absent array', LOGS.length - mark, 0);
        ai._logInputTransformations([...IT, { ...IT[0], path: 'messages.5.content.0' }], 'claude-fable-5-1');
        ai._logInputTransformations(IT, 'claude-fable-5-1');
        const tb = LOGS.slice(mark).filter((l) => l.msg.startsWith('[ThinkingBinding]'));
        eq('C4: prefix drops → first at INFO, then DEBUG (dedup)', tb.map((l) => l.level), ['INFO', 'DEBUG']);
        ok('C4: counts only (count=2), never the path', tb[0].msg.includes('count=2') && !tb.some((l) => l.msg.includes('messages.')));
        mark = LOGS.length;
        ai._logInputTransformations([...IT2, { type: 'thinking_mismatch_allowed', path: 'x', reason: 'prefix_binding_mismatch' }, { type: 'future_kind' }], 'm');
        const mb = LOGS.slice(mark);
        eq('C4: model_binding_mismatch → DEBUG only; unknown entries ignored', mb.map((l) => `${l.level}:${l.msg}`), ['DEBUG:[ThinkingBinding] thinking dropped: model_binding_mismatch count=1']);

        // Through chat(): a bound round whose response reports a drop is logged.
        currentModel = 'claude-fable-5-1';
        gating._resetSuppressionLogForTest();
        SENT.length = 0;
        SCRIPT = [ok200(toolResp([th('d1'), tu('d_t1')])), ok200(textResp('ok', { input_transformations: IT }))];
        mark = LOGS.length;
        await ai.chat(newChatId(), 'q');
        ok('C4 via chat(): the drop is logged at INFO with the tag', LOGS.slice(mark).some((l) => l.level === 'INFO' && l.msg.startsWith('[ThinkingBinding] thinking-dropped-prefix-binding-mismatch')));
    }

    // ── Global invariant over EVERY request this file sent ──────────────────
    console.log('\n── Global: header ⇔ field on every send ──');
    ok('Global: anthropic-beta binding tag present iff body.thinking.block_binding present',
        ALL_SENT.every((r) => hasHeader(r) === hasField(r)), `${ALL_SENT.filter((r) => hasHeader(r) !== hasField(r)).length} mismatches`);
}

function plainBody() { return claude.formatRequest('claude-fable-5-1', 4096, [], [], [], {}); }

// Keep every send for the global invariant (SENT is reset per block).
const ALL_SENT = [];
const _origPush = SENT.push.bind(SENT);
SENT.push = (...items) => { ALL_SENT.push(...items); return _origPush(...items); };

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
