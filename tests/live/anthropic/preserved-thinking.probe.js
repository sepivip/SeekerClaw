#!/usr/bin/env node
// preserved-thinking.probe.js — BAT-1664 live gate (spec Tests item 9).
//
// Anthropic binds every thinking block's signature to the exact request prefix
// that produced it (system + tools + every earlier message) and to the model.
// This probe drives SeekerClaw's PRODUCTION request path — the real
// providers/claude.js toApiMessages (turn anchor, verbatim wire snapshot),
// formatSystemPrompt, formatTools, formatRequest (bindThinking / toolChoiceNone),
// buildHeaders (with the binding beta extra) and http.js's streaming reducer —
// against the live API, and reads back `input_transformations`.
//
// Per model × auth (API key and setup token), one conversation:
//   (mature chat seeded: filler text pairs + an aged prior tool group with
//    prior-turn thinking, all BEFORE the anchor → stripped by C1)
//   T1R1  turn 1, round 1                         → tool_use with thinking
//   T1R2  round 2, after a mid-turn [System] loop-warn (role user), verbatim
//         replay, block_binding "error" override  → 200 (C1 + verbatim alone hold)
//   T1R3  loop-final round, production shape:
//           flagged   → frozen tools + tool_choice none + drop_block → 200, [] drops
//           unflagged → tools REMOVED (pre-C0 loop-final) + "error"  → recorded
//   T2R1  turn 2 (system prompt changed, as production rebuilds it) → tool_use
//   T2R2  turn 2 round 2, drop_block                               → 200, [] drops
//   EDIT-ERR   T2R2 with a pre-anchor message edited, "error"      → 400 signature
//   EDIT-DROP  same edit, drop_block                               → 200, ≥1 prefix drop
//
// For unflagged models production sends no binding at all; the probe adds the
// field ("error" or "drop_block") to OPT the request into enforcement, which is
// how an older account simulates an enforced one (Anthropic docs: any value of
// prefix_mismatch_behavior opts the request in). Each such row is labelled
// "probe-added".
//
// Test-only additions to the production body (constant across a conversation,
// so they never create a prefix mismatch): `output_config.effort: "high"` and a
// reasoning-heavy prompt, to make the model actually emit thinking blocks
// (a probe with no thinking block proves nothing).
//
// Credentials: ANTHROPIC_API_KEY / SETUP_TOKEN read from
//   $PRESERVED_THINKING_ENV, or .env next to this file (gitignored)
// They are NEVER printed, logged or written; only their presence is reported.
// A 401/403 stops the run immediately (no retries).
//
// Run:   node tests/live/anthropic/preserved-thinking.probe.js
//        node tests/live/anthropic/preserved-thinking.probe.js --self-check   (no network)
//        node tests/live/anthropic/preserved-thinking.probe.js --compat       (flag-scope check:
//             every reasoning-capable UNFLAGGED registry Claude model unless PT_MODELS is set)
// Env:   PT_MODELS=claude-fable-5-1,claude-opus-5-5   PT_AUTHS=api_key,setup_token

'use strict';

const fs = require('fs');
const path = require('path');

const BUNDLE = path.resolve(__dirname, '..', '..', '..', 'app', 'src', 'main', 'assets', 'nodejs-project');

// claude.js / http.js require ../config (log, API_TIMEOUT_MS). Stub it so the
// real bundle config (which reads device files) is never executed.
{
    const cfgPath = require.resolve(path.join(BUNDLE, 'config.js'));
    require.cache[cfgPath] = { id: cfgPath, filename: cfgPath, loaded: true, exports: { log: () => {}, API_TIMEOUT_MS: 180000 } };
}
const claude = require(path.join(BUNDLE, 'providers', 'claude.js'));
const http = require(path.join(BUNDLE, 'http.js'));
const catalog = require(path.join(BUNDLE, 'model-catalog.js'));
const recovery = require(path.join(BUNDLE, 'reasoning-recovery.js'));

const SELF_CHECK = process.argv.includes('--self-check');
const COMPAT = process.argv.includes('--compat');
const MODELS = process.env.PT_MODELS
    ? process.env.PT_MODELS.split(',').map((s) => s.trim()).filter(Boolean)
    : (process.argv.includes('--compat')
        ? catalog.CLAUDE_MODELS.map((m) => m.id).filter((id) => catalog.reasoningSupportFor('claude', id, 'api_key') === 'yes'
            && catalog.thinkingBindingFor('claude', id, 'api_key') !== true)
        : ['claude-fable-5-1', 'claude-opus-5-5', 'claude-sonnet-5-5']);
const AUTHS = (process.env.PT_AUTHS || 'api_key,setup_token').split(',').map((s) => s.trim()).filter(Boolean);
const MAX_TOKENS = 2048;

// ── credentials (never printed) ─────────────────────────────────────────────
function loadCreds() {
    const envPath = process.env.PRESERVED_THINKING_ENV || path.join(__dirname, '.env');
    const out = {};
    if (!fs.existsSync(envPath)) return { out, envPath, found: false };
    for (const line of fs.readFileSync(envPath, 'utf8').split(/\r?\n/)) {
        const t = line.trim();
        if (!t || t.startsWith('#')) continue;
        const eq = t.indexOf('=');
        if (eq === -1) continue;
        const k = t.slice(0, eq).trim();
        let v = t.slice(eq + 1).trim();
        if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) v = v.slice(1, -1);
        if (k === 'ANTHROPIC_API_KEY' || k === 'SETUP_TOKEN') out[k] = v;
    }
    return { out, envPath, found: true };
}
// Scrub anything credential-shaped from text we might print (API error text).
function scrub(s) {
    return String(s || '').replace(/sk-ant-[A-Za-z0-9_\-]+/g, '[redacted]').replace(/Bearer\s+\S+/g, 'Bearer [redacted]').slice(0, 220);
}

// ── fixtures ────────────────────────────────────────────────────────────────
const TOOLS_RAW = [{
    name: 'get_weather',
    description: 'Get the current weather for a city. Returns temperature in Celsius.',
    input_schema: { type: 'object', properties: { city: { type: 'string' } }, required: ['city'] },
}];
const STABLE = 'You are a careful planning assistant. When the user asks about several cities, call get_weather for ONE city per message, then reason about the results before the next call.';
const dynamicFor = (turn) => `Current time: Mon 2026-11-16 10:0${turn}:00 (turn ${turn})`; // production rebuilds this every turn
const T1_PROMPT = 'I am planning a 3-day trip: Tbilisi, Batumi, Kutaisi. Work out an itinerary that minimises total travel distance and puts the warmest city on day 2. Check the weather for each city with get_weather, one city per call, before deciding.';
const T2_PROMPT = 'Now compare: if I swapped day 1 and day 3, how much extra distance would that add? Re-check the weather in Kutaisi with get_weather first.';
const LOOP_WARN = '[System] You appear to be repeating the same tool call with identical arguments. Try a different approach or respond with what you have.';
const LOOP_BREAK = '[System] Tool loop detected and stopped after 5 identical calls. Respond to the user with what you have so far. Do not call any more tools.';
const toolResult = (city) => JSON.stringify({ ok: true, city, temp_c: { Tbilisi: 21, Batumi: 24, Kutaisi: 19 }[city] || 20, condition: 'clear' });

function seedMatureHistory() {
    // Pre-anchor history: filler pairs + a prior tool group whose result is
    // already aged and whose assistant carries prior-turn thinking (must be
    // stripped by C1 — replaying it would be a cross-turn bound block).
    return [
        { role: 'user', content: 'Hi, I am planning travel in Georgia soon.' },
        { role: 'assistant', content: 'Great — tell me the cities and dates and I will help.', reasoningBlocks: [] },
        { role: 'user', content: 'What was the weather in Mestia yesterday?' },
        { role: 'assistant', content: 'Let me check.', toolCalls: [{ id: 'toolu_prior_1', name: 'get_weather', input: { city: 'Mestia' } }],
            reasoningBlocks: [{ schemaVersion: 1, provider: 'anthropic', sourceAdapter: 'claude', wire: { type: 'thinking', thinking: '', signature: 'EqQBprior-turn-signature-that-must-never-be-replayed' } }] },
        { role: 'tool', toolCallId: 'toolu_prior_1', content: '[Trimmed: get_weather result — 1532 chars]' },
        { role: 'assistant', content: 'Mestia was 9°C and cloudy yesterday.', reasoningBlocks: [] },
    ];
}

// ── request building (production path) ─────────────────────────────────────
function buildRequest(ctx, { anchor, bindMode, toolChoiceNone, dropTools, turn }) {
    const systemBlocks = claude.formatSystemPrompt(STABLE, dynamicFor(turn), ctx.auth);
    const tools = dropTools ? [] : claude.formatTools(TOOLS_RAW);
    const apiMessages = claude.toApiMessages(ctx.messages, ctx.model, { turnAnchor: anchor, stripAllThinking: false });
    const hasThinking = claude.messagesHaveThinking(apiMessages);
    const bind = !!bindMode && hasThinking;
    const ro = { reasoningEnabled: true, reasoningSupport: 'yes', toolChoiceNone: !!toolChoiceNone };
    if (bind) ro.bindThinking = true;
    const body = JSON.parse(claude.formatRequest(ctx.model, MAX_TOKENS, systemBlocks, apiMessages, tools, ro));
    if (bind && bindMode === 'error') body.thinking.block_binding.prefix_mismatch_behavior = 'error';
    body.output_config = { effort: 'high' }; // test-only: force thinking
    const headers = bind
        ? claude.buildHeaders(ctx.key, ctx.auth, [claude.THINKING_BINDING_BETA])
        : claude.buildHeaders(ctx.key, ctx.auth);
    return { body, headers, bind, hasThinking, replayedThinking: countThinking(apiMessages) };
}
function countThinking(apiMessages) {
    let n = 0;
    for (const m of apiMessages) if (m.role === 'assistant' && Array.isArray(m.content)) n += m.content.filter((b) => b.type === 'thinking' || b.type === 'redacted_thinking').length;
    return n;
}

// ── transport ───────────────────────────────────────────────────────────────
let REQUESTS = 0;
const TOKENS = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };
class StopRun extends Error {}

async function liveSend(req) {
    REQUESTS++;
    const res = await http.httpStreamingRequest({
        hostname: claude.endpoint.hostname, path: claude.endpoint.path, method: 'POST', headers: req.headers, timeout: 180000,
    }, JSON.stringify(req.body));
    return res;
}

function record(res) {
    if (res && res.status === 200 && res.data && res.data.usage) {
        const u = claude.normalizeUsage(res.data.usage);
        TOKENS.input += u.inputTokens; TOKENS.output += u.outputTokens; TOKENS.cacheRead += u.cacheRead; TOKENS.cacheWrite += u.cacheWrite;
    }
}

// ── scenario runner ─────────────────────────────────────────────────────────
const ROWS = [];
function errText(res) {
    const d = res && res.data;
    if (!d) return '';
    if (typeof d === 'string') return d;
    return (d.error && d.error.message) || d.message || '';
}
function transformCounts(res) {
    const list = res && res.data && Array.isArray(res.data.input_transformations) ? res.data.input_transformations : null;
    if (!list) return { present: false, prefix: 0, model: 0, other: 0 };
    let prefix = 0, model = 0, other = 0;
    for (const t of list) {
        if (t && t.type === 'thinking_dropped' && t.reason === 'prefix_binding_mismatch') prefix++;
        else if (t && t.type === 'thinking_dropped' && t.reason === 'model_binding_mismatch') model++;
        else other++;
    }
    return { present: true, prefix, model, other };
}
function isSig400(res) { return !!res && res.status === 400 && /Invalid `signature` in `thinking` block/i.test(errText(res)); }

function addRow(ctx, scenario, mode, req, res, expect, note) {
    const tc = transformCounts(res);
    const verdict = expect(res, tc, req);
    ROWS.push({
        model: ctx.model, auth: ctx.auth, scenario, mode,
        status: res ? res.status : 'n/a',
        replayed: req ? req.replayedThinking : '-',
        bind: req ? (req.bind ? (req.body.thinking.block_binding.prefix_mismatch_behavior) : 'none') : '-',
        drops: tc.present ? `prefix=${tc.prefix} model=${tc.model} other=${tc.other}` : 'absent',
        thinkingOut: res && res.status === 200 && res.data ? (res.data.content || []).filter((b) => b.type === 'thinking' || b.type === 'redacted_thinking').length : '-',
        verdict: verdict === true ? 'OK' : (verdict === null ? 'INCONCLUSIVE' : 'UNEXPECTED'),
        note: note || (res && res.status !== 200 ? scrub(errText(res)) : ''),
    });
}

async function sendChecked(ctx, req) {
    const res = await ctx.send(req);
    record(res);
    if (res && (res.status === 401 || res.status === 403)) {
        throw new StopRun(`${res.status} on ${ctx.model}/${ctx.auth}: ${scrub(errText(res))}`);
    }
    return res;
}

function pushAssistant(ctx, res) {
    const parsed = claude.fromApiResponse(res.data);
    const msg = { role: 'assistant', content: parsed.text || '', toolCalls: parsed.toolCalls, reasoningBlocks: parsed.reasoningBlocks };
    claude.setWireSnapshot(msg, parsed.wireContent);
    ctx.messages.push(msg);
    return parsed;
}
function pushToolResults(ctx, parsed) {
    for (const tc of parsed.toolCalls) ctx.messages.push({ role: 'tool', toolCallId: tc.id, content: toolResult(tc.input && tc.input.city) });
}

const EXPECT = {
    // Unedited paths must come back with NO entries of any kind: a
    // model_binding_mismatch or an unrecognised entry is as unexpected as a
    // prefix drop (CodeRabbit #467).
    ok200Empty: (res, tc) => res.status === 200 && (!tc.present || (tc.prefix === 0 && tc.model === 0 && tc.other === 0)),
    toolUseWithThinking: (res) => {
        if (res.status !== 200) return false;
        const c = res.data.content || [];
        if (!c.some((b) => b.type === 'tool_use')) return null;
        if (!c.some((b) => b.type === 'thinking' || b.type === 'redacted_thinking')) return null;
        return true;
    },
    sig400: (res) => isSig400(res),
    droppedPrefix: (res, tc) => res.status === 200 && tc.present && tc.prefix >= 1,
    recordOnly: () => true,
};

async function runConversation(ctx) {
    const flagged = catalog.thinkingBindingFor('claude', ctx.model, ctx.auth) === true;
    ctx.messages = seedMatureHistory();

    // ── Turn 1
    const a1 = { role: 'user', content: T1_PROMPT };
    ctx.messages.push(a1);
    let req = buildRequest(ctx, { anchor: a1, bindMode: flagged ? 'drop_block' : null, turn: 1 });
    let res = await sendChecked(ctx, req);
    addRow(ctx, 'T1R1 mature chat, round 1', flagged ? 'production' : 'production', req, res, EXPECT.toolUseWithThinking,
        res.status === 200 ? `pre-anchor thinking replayed=${req.replayedThinking}` : undefined);
    if (res.status !== 200) return;
    let p = pushAssistant(ctx, res);
    if (!p.toolCalls.length) { ROWS[ROWS.length - 1].note += ' (no tool_use — rest of turn 1 skipped)'; return; }
    pushToolResults(ctx, p);
    ctx.messages.push({ role: 'user', content: LOOP_WARN });

    req = buildRequest(ctx, { anchor: a1, bindMode: 'error', turn: 1 });
    res = await sendChecked(ctx, req);
    addRow(ctx, 'T1R2 after mid-turn [System] loop-warn', `"error"${flagged ? '' : ' (probe-added)'}`, req, res,
        req.replayedThinking > 0 ? EXPECT.ok200Empty : () => null,
        req.replayedThinking > 0 ? undefined : 'no thinking replayed — inconclusive');
    if (res.status !== 200) return;
    p = pushAssistant(ctx, res);
    if (p.toolCalls.length) {
        pushToolResults(ctx, p);
        ctx.messages.push({ role: 'user', content: LOOP_BREAK });
        // Loop-final: flagged → C0 shape (frozen tools + none + drop_block);
        // unflagged → today's production shape (tools removed), probed with "error".
        req = flagged
            ? buildRequest(ctx, { anchor: a1, bindMode: 'drop_block', toolChoiceNone: true, turn: 1 })
            : buildRequest(ctx, { anchor: a1, bindMode: 'error', dropTools: true, turn: 1 });
        res = await sendChecked(ctx, req);
        addRow(ctx, flagged ? 'T1R3 loop-final (frozen tools + tool_choice none)' : 'T1R3 loop-final (tools removed, production)',
            flagged ? 'production drop_block' : '"error" (probe-added)', req, res,
            flagged ? EXPECT.ok200Empty : EXPECT.recordOnly,
            flagged ? undefined : (res.status === 200 ? 'accepted with tools removed' : `REJECTED: ${scrub(errText(res))}`));
        if (res.status === 200) {
            const calls = (res.data.content || []).filter((b) => b.type === 'tool_use').length;
            if (calls) ROWS[ROWS.length - 1].note += ` tool_use=${calls} (ignored by the loop-final guard)`;
            p = pushAssistant(ctx, res);
            // production: loop-final tool calls are cleared through the helper
            if (p.toolCalls.length) claude.invalidateWireSnapshot(ctx.messages[ctx.messages.length - 1], ctx.messages, []);
        } else {
            ctx.messages.push({ role: 'assistant', content: 'Here is what I have so far.', reasoningBlocks: [] });
        }
    } else {
        addRow(ctx, 'T1R3 loop-final', '-', null, null, () => null, 'model answered in round 2 — loop-final not reachable');
    }

    // ── Turn 2 (system prompt rebuilt with a new time line — production behaviour)
    const a2 = { role: 'user', content: T2_PROMPT };
    ctx.messages.push(a2);
    req = buildRequest(ctx, { anchor: a2, bindMode: flagged ? 'drop_block' : null, turn: 2 });
    res = await sendChecked(ctx, req);
    addRow(ctx, 'T2R1 turn 2, round 1 (system changed)', 'production', req, res, (r) => (r.status === 200 && req.replayedThinking === 0 ? EXPECT.toolUseWithThinking(r) : false),
        res.status === 200 ? `cross-turn thinking replayed=${req.replayedThinking}` : undefined);
    if (res.status !== 200) return;
    p = pushAssistant(ctx, res);
    if (!p.toolCalls.length) { ROWS[ROWS.length - 1].note += ' (no tool_use — T2R2/edit skipped)'; return; }
    pushToolResults(ctx, p);

    req = buildRequest(ctx, { anchor: a2, bindMode: 'drop_block', turn: 2 });
    res = await sendChecked(ctx, req);
    addRow(ctx, 'T2R2 turn 2, round 2', `drop_block${flagged ? ' (production)' : ' (probe-added)'}`, req, res,
        req.replayedThinking > 0 ? EXPECT.ok200Empty : () => null);
    if (req.replayedThinking === 0) return;

    // ── Edited-history control: change a PRE-anchor message's bytes.
    const edited = ctx.messages.map((m) => m);
    const idx = edited.findIndex((m) => m.role === 'assistant' && m.content === 'Mestia was 9°C and cloudy yesterday.');
    const original = edited[idx];
    edited[idx] = { role: 'assistant', content: 'Mestia was 10°C and cloudy yesterday.', reasoningBlocks: [] };
    const saved = ctx.messages;
    ctx.messages = edited;
    try {
        req = buildRequest(ctx, { anchor: a2, bindMode: 'error', turn: 2 });
        res = await sendChecked(ctx, req);
        addRow(ctx, 'EDIT-ERR pre-anchor edit, "error"', '"error"', req, res, EXPECT.sig400,
            isSig400(res) ? 'signature 400 (the error C3 heals)' : undefined);
        req = buildRequest(ctx, { anchor: a2, bindMode: 'drop_block', turn: 2 });
        res = await sendChecked(ctx, req);
        addRow(ctx, 'EDIT-DROP pre-anchor edit, drop_block', 'drop_block', req, res, EXPECT.droppedPrefix);
    } finally {
        ctx.messages = saved;
        void original;
    }
}

// ── --compat: flag-scope check for UNFLAGGED registry models ────────────────
// Per model × auth (≤4 requests):
//   T1R1          one real round → a signed in-turn thinking block + tool_use
//   T1R3-NOBIND   today's production loop-final for an unflagged model (tools
//                 removed, NO block_binding, NO beta) — does the account enforce
//                 the check by default?
//   EDIT-DROP     pre-anchor edit + drop_block + beta (tools kept) — is the
//                 control accepted, and does the model run the prefix check?
//   T1R3-ERR      loop-final, tools removed, "error" override — only when the
//                 model runs the check (EDIT-DROP dropped a block) and
//                 T1R3-NOBIND was accepted; otherwise its outcome is implied.
async function runCompat(ctx) {
    ctx.messages = seedMatureHistory();
    const a1 = { role: 'user', content: T1_PROMPT };
    ctx.messages.push(a1);
    let req = buildRequest(ctx, { anchor: a1, bindMode: null, turn: 1 });
    let res = await sendChecked(ctx, req);
    addRow(ctx, 'T1R1 round 1', 'production', req, res, EXPECT.toolUseWithThinking);
    if (res.status !== 200) return;
    const p = pushAssistant(ctx, res);
    const thinkingOut = (res.data.content || []).some((b) => b.type === 'thinking' || b.type === 'redacted_thinking');
    if (!p.toolCalls.length || !thinkingOut) { ROWS[ROWS.length - 1].note += ` (tool_use=${p.toolCalls.length} thinking=${thinkingOut} — rest skipped)`; return; }
    pushToolResults(ctx, p);
    const inTurn = ctx.messages.slice(); // state before the loop-break message

    // T1R3-NOBIND: exactly what production sends today.
    ctx.messages.push({ role: 'user', content: LOOP_BREAK });
    req = buildRequest(ctx, { anchor: a1, bindMode: null, dropTools: true, turn: 1 });
    res = await sendChecked(ctx, req);
    const nobindOk = res.status === 200;
    addRow(ctx, 'T1R3-NOBIND loop-final, tools removed, no binding/beta', 'production', req, res, EXPECT.recordOnly,
        nobindOk ? 'accepted (meaningful for default enforcement only if the model runs the check — see EDIT-DROP)' : (isSig400(res) ? 'SIGNATURE 400 without opting in → enforced by default' : scrub(errText(res))));

    // EDIT-DROP: pre-anchor edit, tools kept, drop_block + beta.
    ctx.messages = inTurn.map((m) => (m.role === 'assistant' && m.content === 'Mestia was 9°C and cloudy yesterday.')
        ? { role: 'assistant', content: 'Mestia was 10°C and cloudy yesterday.', reasoningBlocks: [] } : m);
    req = buildRequest(ctx, { anchor: a1, bindMode: 'drop_block', turn: 1 });
    res = await sendChecked(ctx, req);
    const tc = transformCounts(res);
    const rejected = recovery.isBindingRejected400(res.status, res.data, true);
    const runsCheck = res.status === 200 && tc.present && tc.prefix >= 1;
    addRow(ctx, 'EDIT-DROP pre-anchor edit, drop_block + beta', 'probe-added', req, res, EXPECT.recordOnly,
        res.status === 200
            ? (runsCheck ? 'control accepted; model RUNS the prefix check' : `control accepted; no prefix drop → model does NOT run the check (transformations ${tc.present ? 'present' : 'absent'})`)
            : (rejected ? `control REJECTED (isBindingRejected400=true): ${scrub(errText(res))}` : scrub(errText(res))));

    // T1R3-ERR only when informative.
    ctx.messages = inTurn.concat([{ role: 'user', content: LOOP_BREAK }]);
    if (runsCheck && nobindOk && process.env.PT_SKIP_ERR !== '1') {
        req = buildRequest(ctx, { anchor: a1, bindMode: 'error', dropTools: true, turn: 1 });
        res = await sendChecked(ctx, req);
        addRow(ctx, 'T1R3-ERR loop-final, tools removed, "error"', 'probe-added', req, res, EXPECT.recordOnly,
            res.status === 200 ? 'accepted' : (isSig400(res) ? 'SIGNATURE 400 (tools change breaks the binding)' : scrub(errText(res))));
    } else {
        addRow(ctx, 'T1R3-ERR loop-final, tools removed, "error"', 'not sent', null, null, EXPECT.recordOnly,
            !nobindOk ? 'implied 400 (already 400 without opting in)'
                : (runsCheck ? 'skipped (PT_SKIP_ERR=1; 400 already confirmed for checking models)' : 'implied 200 (model does not run the prefix check)'));
    }
}

function printTable() {
    const cols = ['model', 'auth', 'scenario', 'mode', 'status', 'replayed', 'bind', 'drops', 'thinkingOut', 'verdict', 'note'];
    console.log('\n| ' + cols.join(' | ') + ' |');
    console.log('|' + cols.map(() => '---').join('|') + '|');
    for (const r of ROWS) console.log('| ' + cols.map((c) => String(r[c] === undefined ? '' : r[c]).replace(/\|/g, '/')).join(' | ') + ' |');
}

// ── self-check (no network) ─────────────────────────────────────────────────
// Canned SSE event streams through the REAL reducer. The fake API enforces the
// prefix binding like the real one: it remembers each signature it issued with
// a hash of the prefix that produced it, and on replay compares.
function selfCheckTransport({ breakLoopFinalTools }) {
    const crypto = require('crypto');
    const issued = new Map(); // signature → prefix hash
    let n = 0;
    const prefixHash = (body, uptoMsg, uptoBlock) => {
        const msgs = body.messages.slice(0, uptoMsg);
        const cur = body.messages[uptoMsg];
        const head = cur ? { role: cur.role, content: cur.content.slice(0, uptoBlock) } : null;
        return crypto.createHash('sha256').update(JSON.stringify([body.system, body.tools || null, msgs, head])).digest('hex');
    };
    return async (req) => {
        REQUESTS++;
        const body = req.body;
        const enforced = !!(body.thinking && body.thinking.block_binding);
        const mode = enforced ? body.thinking.block_binding.prefix_mismatch_behavior : null;
        const drops = [];
        for (let i = 0; i < body.messages.length; i++) {
            const m = body.messages[i];
            if (m.role !== 'assistant' || !Array.isArray(m.content)) continue;
            m.content.forEach((b, j) => {
                if (b.type !== 'thinking') return;
                const want = issued.get(b.signature);
                // The fake binds to system + tools + messages-before (like the real API).
                const have = prefixHash(body, i, j);
                if (!want || want !== have) drops.push({ path: `messages.${i}.content.${j}` });
            });
        }
        if (enforced && drops.length && mode === 'error') {
            return { status: 400, data: { type: 'error', error: { type: 'invalid_request_error', message: `${drops[0].path}: Invalid \`signature\` in \`thinking\` block. The block is bound to a different conversation.` } } };
        }
        if (breakLoopFinalTools && !body.tools && drops.length && enforced) {
            return { status: 400, data: { type: 'error', error: { type: 'invalid_request_error', message: `${drops[0].path}: Invalid \`signature\` in \`thinking\` block.` } } };
        }
        // Produce a response: tool_use unless tool_choice none / no tools, with a thinking block.
        const sig = `SIG-${++n}-` + 'q'.repeat(20);
        const content = [{ type: 'thinking', thinking: '', signature: sig }];
        const canTool = body.tools && !(body.tool_choice && body.tool_choice.type === 'none');
        const lastUser = body.messages[body.messages.length - 1];
        const wantsTool = canTool && n % 7 !== 0;
        if (wantsTool) {
            const city = ['Tbilisi', 'Batumi', 'Kutaisi'][n % 3];
            content.push({ type: 'text', text: `Checking ${city}.` });
            content.push({ type: 'tool_use', id: `toolu_${n}`, name: 'get_weather', input: { city } });
        } else {
            content.push({ type: 'text', text: 'Here is the plan.' });
        }
        void lastUser;
        // Record the prefix each new thinking block is bound to = the request's
        // messages + the new assistant message's content before the block.
        issued.set(sig, prefixHash({ system: body.system, tools: body.tools, messages: [...body.messages, { role: 'assistant', content }] }, body.messages.length, 0));
        const events = [{ eventType: 'message_start', data: { message: { id: `msg_${n}`, model: body.model, usage: { input_tokens: 10 },
            ...(enforced ? { input_transformations: (mode === 'drop_block' ? drops.map((d) => ({ type: 'thinking_dropped', path: d.path, reason: 'prefix_binding_mismatch' })) : []) } : {}) } } }];
        content.forEach((b, i) => {
            if (b.type === 'thinking') {
                events.push({ eventType: 'content_block_start', data: { index: i, content_block: { type: 'thinking', thinking: '', signature: '' } } });
                events.push({ eventType: 'content_block_delta', data: { index: i, delta: { type: 'signature_delta', signature: b.signature } } });
            } else if (b.type === 'text') {
                events.push({ eventType: 'content_block_start', data: { index: i, content_block: { type: 'text', text: '' } } });
                events.push({ eventType: 'content_block_delta', data: { index: i, delta: { type: 'text_delta', text: b.text } } });
            } else {
                events.push({ eventType: 'content_block_start', data: { index: i, content_block: { type: 'tool_use', id: b.id, name: b.name, input: {} } } });
                events.push({ eventType: 'content_block_delta', data: { index: i, delta: { type: 'input_json_delta', partial_json: JSON.stringify(b.input) } } });
            }
            events.push({ eventType: 'content_block_stop', data: { index: i } });
        });
        events.push({ eventType: 'message_delta', data: { delta: { stop_reason: wantsTool ? 'tool_use' : 'end_turn' }, usage: { output_tokens: 5 } } });
        events.push({ eventType: 'message_stop', data: {} });
        return { status: 200, data: http.assembleClaudeStreamMessage(events) };
    };
}

async function selfCheck() {
    let failures = 0;
    const check = (label, cond) => { console.log(`${cond ? 'PASS' : 'FAIL'}: ${label}`); if (!cond) failures++; };
    for (const model of ['claude-fable-5-1', 'claude-opus-5-5']) {
        ROWS.length = 0;
        const ctx = { model, auth: 'api_key', key: 'self-check-not-a-key', send: selfCheckTransport({ breakLoopFinalTools: false }) };
        await runConversation(ctx);
        const by = (s) => ROWS.find((r) => r.scenario.startsWith(s));
        check(`${model}: T1R1 replays no pre-anchor thinking`, by('T1R1') && by('T1R1').replayed === 0);
        check(`${model}: T1R2 replays in-turn thinking and is accepted under "error"`, by('T1R2') && by('T1R2').replayed > 0 && by('T1R2').verdict === 'OK');
        check(`${model}: T2R1 replays no cross-turn thinking`, by('T2R1') && by('T2R1').replayed === 0);
        check(`${model}: T2R2 accepted with no drops`, by('T2R2') && by('T2R2').verdict === 'OK');
        check(`${model}: EDIT-ERR detects the signature 400`, by('EDIT-ERR') && by('EDIT-ERR').status === 400 && by('EDIT-ERR').verdict === 'OK');
        check(`${model}: EDIT-DROP reports a prefix drop`, by('EDIT-DROP') && by('EDIT-DROP').verdict === 'OK');
        if (model === 'claude-fable-5-1') check(`${model}: loop-final (frozen tools + none) accepted, no drops`, by('T1R3') && by('T1R3').verdict === 'OK');
        else check(`${model}: loop-final with tools removed is DETECTED as a prefix break by the fake API`, by('T1R3') && by('T1R3').status === 400);
    }
    // Negative self-check: the probe must flag a broken implementation. Make the
    // adapter replay pre-anchor thinking (no anchor gate) → T1R1 must not be OK.
    {
        ROWS.length = 0;
        const orig = claude.toApiMessages;
        claude.toApiMessages = (msgs, m, ro) => orig(msgs, m, Object.assign({}, ro, { stripAllThinking: true }));
        const ctx = { model: 'claude-fable-5-1', auth: 'api_key', key: 'x', send: selfCheckTransport({}) };
        try { await runConversation(ctx); } finally { claude.toApiMessages = orig; }
        const r = ROWS.find((x) => x.scenario.startsWith('T1R2'));
        check('negative: with replay disabled, T1R2 is NOT reported OK (inconclusive/unexpected)', !!r && r.verdict !== 'OK');
    }
    {
        // The probe must call a wrong edit outcome UNEXPECTED: fake API that never enforces.
        ROWS.length = 0;
        const ctx = { model: 'claude-fable-5-1', auth: 'api_key', key: 'x', send: async (req) => {
            const t = selfCheckTransport({});
            const r = await t(req);
            if (r.status === 400) return t(Object.assign({}, req, { body: Object.assign({}, req.body, { thinking: { type: 'adaptive' } }) }));
            return r;
        } };
        await runConversation(ctx);
        const r = ROWS.find((x) => x.scenario.startsWith('EDIT-ERR'));
        check('negative: an API that accepts the edited history is flagged UNEXPECTED', !!r && r.verdict === 'UNEXPECTED');
    }
    {
        // --compat path against the fake API (it enforces only when opted in).
        ROWS.length = 0;
        const ctx = { model: 'claude-opus-5', auth: 'api_key', key: 'x', send: selfCheckTransport({}) };
        await runCompat(ctx);
        const by = (s) => ROWS.find((r) => r.scenario.startsWith(s));
        check('compat: T1R3-NOBIND accepted by a non-enforcing account', by('T1R3-NOBIND') && by('T1R3-NOBIND').status === 200);
        check('compat: EDIT-DROP reports the model runs the check', by('EDIT-DROP') && /RUNS the prefix check/.test(by('EDIT-DROP').note));
        check('compat: T1R3-ERR sent and rejected with the signature 400', by('T1R3-ERR') && by('T1R3-ERR').status === 400);
        check('compat: at most 4 requests per model × auth', ROWS.filter((r) => r.status !== 'n/a').length <= 4);
    }
    {
        // ok200Empty must reject ANY transformation entry on an unedited path.
        const mk = (list) => ({ status: 200, data: { content: [], input_transformations: list } });
        const modelDrop = mk([{ type: 'thinking_dropped', path: 'messages.1.content.0', reason: 'model_binding_mismatch' }]);
        const unknown = mk([{ type: 'thinking_mismatch_allowed', path: 'messages.1.content.0', reason: 'prefix_binding_mismatch' }]);
        check('ok200Empty: a 200 with model_binding_mismatch is NOT OK', EXPECT.ok200Empty(modelDrop, transformCounts(modelDrop)) === false);
        check('ok200Empty: a 200 with an unrecognised entry is NOT OK', EXPECT.ok200Empty(unknown, transformCounts(unknown)) === false);
        check('ok200Empty: a 200 with an empty array is OK', EXPECT.ok200Empty(mk([]), transformCounts(mk([]))) === true);
        // Exit code: any non-OK row → process.exitCode = 1 (restored afterwards).
        const saved = process.exitCode;
        process.exitCode = 0;
        applyExitCode([{ verdict: 'OK' }]);
        const afterOk = process.exitCode;
        applyExitCode([{ verdict: 'OK' }, { verdict: 'UNEXPECTED' }]);
        const afterBad = process.exitCode;
        process.exitCode = saved;
        check('exit code: all-OK rows leave exitCode 0', afterOk === 0);
        check('exit code: a non-OK row sets exitCode 1', afterBad === 1);
    }
    console.log(`\nself-check: ${failures === 0 ? 'ALL PASS' : failures + ' FAILED'} (requests simulated: ${REQUESTS})`);
    process.exit(failures === 0 ? 0 : 1);
}

// ── main ────────────────────────────────────────────────────────────────────
async function main() {
    if (SELF_CHECK) return selfCheck();
    const { out: creds, found } = loadCreds();
    if (!found) { console.log('STOP: credentials file not found (path not printed).'); process.exit(2); }
    const credFor = { api_key: creds.ANTHROPIC_API_KEY, setup_token: creds.SETUP_TOKEN };
    console.log(`credentials: api_key ${credFor.api_key ? `present (len ${credFor.api_key.length})` : 'MISSING'}, setup_token ${credFor.setup_token ? `present (len ${credFor.setup_token.length})` : 'MISSING'}`);
    console.log(`models: ${MODELS.join(', ')} | auths: ${AUTHS.join(', ')} | max_tokens=${MAX_TOKENS}`);
    for (const m of MODELS) console.log(`  ${m}: registry thinkingBinding(api_key)=${catalog.thinkingBindingFor('claude', m, 'api_key')} reasoningSupport=${catalog.reasoningSupportFor('claude', m, 'api_key')}`);
    let stopped = null;
    outer:
    for (const auth of AUTHS) {
        if (!credFor[auth]) { console.log(`STOP: ${auth} credential missing.`); stopped = `${auth} credential missing`; break; }
        for (const model of MODELS) {
            const ctx = { model, auth, key: credFor[auth], send: liveSend };
            try {
                await (COMPAT ? runCompat(ctx) : runConversation(ctx));
            } catch (e) {
                if (e instanceof StopRun) { stopped = e.message; break outer; }
                ROWS.push({ model, auth, scenario: 'harness', mode: '-', status: 'error', replayed: '-', bind: '-', drops: '-', thinkingOut: '-', verdict: 'UNEXPECTED', note: scrub(e && e.message) });
            }
        }
    }
    printTable();
    console.log(`\nrequests: ${REQUESTS} | tokens: input=${TOKENS.input} output=${TOKENS.output} cacheRead=${TOKENS.cacheRead} cacheWrite=${TOKENS.cacheWrite}`);
    if (stopped) { console.log(`STOPPED: ${stopped}`); process.exit(3); }
    const bad = applyExitCode(ROWS);
    console.log(`verdicts: ${ROWS.length - bad} OK, ${bad} not OK`);
}

// Any non-OK row fails the run (non-zero exit) without cutting off output.
function applyExitCode(rows) {
    const bad = rows.filter((r) => r.verdict !== 'OK').length;
    if (bad > 0) process.exitCode = 1;
    return bad;
}

main().catch((e) => { console.log(`FATAL: ${scrub(e && e.stack ? e.stack : e)}`); process.exit(1); });
