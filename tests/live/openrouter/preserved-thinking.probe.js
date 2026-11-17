#!/usr/bin/env node
// preserved-thinking.probe.js (OpenRouter) — BAT-1664 decision 5 live evidence.
//
// Question: does OpenRouter (Claude models, whatever upstream serves them)
// reproduce Anthropic's prefix-binding 400 ("Invalid `signature` in `thinking`
// block") when SeekerClaw replays reasoning after (a) a next-turn system-prompt
// change or (b) a same-turn edit of a message before the turn anchor?
//
// It drives SeekerClaw's REAL OpenRouter path against https://openrouter.ai:
//   providers/openrouter.js  formatSystemPrompt / formatTools / toApiMessages /
//                            formatRequest / buildHeaders / fromApiResponse
//   http.js                  httpChatCompletionsStreamingRequest (the streaming
//                            reducer production uses)
//
// Two replay modes per request:
//   production    exactly what ships: the body production builds (no `reasoning`
//                 field — OpenRouter is freeform, reasoningSupport resolves
//                 "unknown") and the history the real reducer produced. NOTE: the
//                 chat-completions reducer does not read delta.reasoning /
//                 delta.reasoning_details, so production stores no reasoning
//                 blocks and replays none.
//   wire-capture  what the adapter WOULD send if the reducer kept reasoning: a
//                 read-only tap on the raw SSE (https.request is wrapped; the
//                 reducer still parses the same bytes) merges the streamed
//                 reasoning_details deltas into message.reasoning_details, then
//                 the real fromApiResponse → reasoningBlocks → toApiMessages
//                 echoes them verbatim (the adapter's existing BAT-549 path; it
//                 has no turn anchor, so every turn's reasoning is replayed).
//                 Reasoning is forced through the adapter's OWN branch
//                 (reasoningEnabled + reasoningSupport "yes" → reasoning:
//                 {effort:"medium"}), constant across the conversation.
//
// Per model (≤7 requests; 4 default models = 28 ≤ cap 30):
//   T1R1      turn 1, round 1, forced reasoning           → tool call + reasoning
//   W-c       CONTROL: round 2, no edit, replay           → must be 200
//   W-t       TAMPER: W-c with the replayed reasoning text altered, signature
//             kept — does the route verify replayed reasoning at all?
//   W-b       SAME-TURN: round 2 after editing a pre-anchor message, replay
//   W-a-ctl   CONTROL: turn 2, system UNCHANGED, replays turn-1 reasoning → 200
//   W-a       NEXT-TURN: turn 2, system changed (new time line), replays turn-1
//   P-ab      production body, turn 2 with system changed + the pre-anchor edit
//             → must be 200
// W-b / W-a record a finding: "REPRODUCES" (signature 400) or "no repro" (200),
// the latter qualified by W-t (a 200 is only meaningful if tampering is
// rejected). Both are valid observations (verdict OK) — but only when the
// paired control passed; otherwise INCONCLUSIVE. A response with no reasoning
// makes the wire rows INCONCLUSIVE (a replay of nothing proves nothing).
//
// Per request it records: HTTP status, scrubbed error text, the OpenRouter
// `provider` that served it (SSE chunks, or error.metadata.provider_name), the
// served model, and whether reasoning came back.
//
// Credentials: ONLY process.env.OPENROUTER_API_KEY. Never printed (length only);
// API error text is scrubbed. A 401/402/403 stops the run. Hard cap OR_PT_CAP
// (default 30) live requests. Exit non-zero on any not-OK row.
//
// Run:  OP_ACCOUNT=my.1password.com op run --env-file=tests/live/openrouter/.env.op -- \
//         node tests/live/openrouter/preserved-thinking.probe.js
//       node tests/live/openrouter/preserved-thinking.probe.js --self-check   (offline:
//         a local fake OpenRouter on 127.0.0.1 that enforces the binding)
// Env:  OR_PT_MODELS=anthropic/claude-fable-5.1,…   OR_PT_CAP=30
//       OR_PT_PIN_PROVIDER=Anthropic  (optional, adds provider:{order,allow_fallbacks:false}
//         to every body — NOT production; off by default)

'use strict';

const path = require('path');
const nodeHttp = require('http');
const nodeHttps = require('https');

const BUNDLE = path.resolve(__dirname, '..', '..', '..', 'app', 'src', 'main', 'assets', 'nodejs-project');

// openrouter.js / http.js require ../config (log, API_TIMEOUT_MS,
// OPENROUTER_FALLBACK_MODEL). Stub it so the real config (device files) never runs.
// OPENROUTER_FALLBACK_MODEL '' = the production default (no fallback configured).
{
    const cfgPath = require.resolve(path.join(BUNDLE, 'config.js'));
    require.cache[cfgPath] = { id: cfgPath, filename: cfgPath, loaded: true,
        exports: { log: () => {}, API_TIMEOUT_MS: 180000, OPENROUTER_FALLBACK_MODEL: '' } };
}
const or = require(path.join(BUNDLE, 'providers', 'openrouter.js'));
const http = require(path.join(BUNDLE, 'http.js'));
const catalog = require(path.join(BUNDLE, 'model-catalog.js'));
const REGISTRY = require(path.join(BUNDLE, 'model-registry.json'));

const SELF_CHECK = process.argv.includes('--self-check');
const OR_DEFAULT = (REGISTRY.providers.find((p) => p.id === 'openrouter') || {}).defaultModel;
// OpenRouter twins of the first-party set the Anthropic probe covers
// (fable-5-1 is the registry-flagged model; opus/sonnet-5-5 are BAT-1661's),
// plus the OpenRouter registry default a user gets out of the box.
const MODELS = process.env.OR_PT_MODELS
    ? process.env.OR_PT_MODELS.split(',').map((s) => s.trim()).filter(Boolean)
    : ['anthropic/claude-fable-5.1', 'anthropic/claude-opus-5.5', 'anthropic/claude-sonnet-5.5', OR_DEFAULT].filter(Boolean);
const MAX_TOKENS = 4096; // ai.js sends 4096
let CAP = parseInt(process.env.OR_PT_CAP || '30', 10);
const PIN = (process.env.OR_PT_PIN_PROVIDER || '').trim();

// ── scrubbing ───────────────────────────────────────────────────────────────
let SECRET = null;
function scrub(s, max = 240) {
    let t = String(s == null ? '' : s);
    if (SECRET) t = t.split(SECRET).join('[redacted]');
    return t.replace(/sk-or-v1-[A-Za-z0-9]+/g, '[redacted]')
        .replace(/sk-[A-Za-z0-9_\-]{16,}/g, '[redacted]')
        .replace(/Bearer\s+\S+/g, 'Bearer [redacted]')
        .replace(/\s+/g, ' ')
        .slice(0, max);
}

// ── fixtures ────────────────────────────────────────────────────────────────
const TOOLS_RAW = [{
    name: 'get_weather',
    description: 'Get the current weather for a city. Returns temperature in Celsius.',
    input_schema: { type: 'object', properties: { city: { type: 'string' } }, required: ['city'] },
}];
const STABLE = 'You are a careful planning assistant. Think step by step before acting. When the user asks about several cities, call get_weather for ONE city per message, then reason about the results before the next call.';
const dynamicFor = (turn) => `Current time: Tue 2026-11-17 10:0${turn}:00 (turn ${turn})`; // production rebuilds this every turn
const T1_PROMPT = 'I am planning a 3-day trip: Tbilisi, Batumi, Kutaisi. Work out an itinerary that minimises total travel distance and puts the warmest city on day 2. Check the weather for each city with get_weather, one city per call, before deciding.';
const T2_PROMPT = 'Now compare: if I swapped day 1 and day 3, how much extra distance would that add? Re-check the weather in Kutaisi with get_weather first.';
const CLOSING = 'I have the first reading; tell me when to continue with the other cities.';
const toolResult = (city) => JSON.stringify({ ok: true, city, temp_c: { Tbilisi: 21, Batumi: 24, Kutaisi: 19 }[city] || 20, condition: 'clear' });
const PRE_ANCHOR_TEXT = 'Mestia was 9°C and cloudy yesterday.';
const PRE_ANCHOR_EDIT = 'Mestia was 10°C and cloudy yesterday.';

function seedMatureHistory() {
    // Pre-anchor history (no reasoning: a fake signature would 400 regardless).
    return [
        { role: 'user', content: 'Hi, I am planning travel in Georgia soon.' },
        { role: 'assistant', content: 'Great — tell me the cities and dates and I will help.', reasoningBlocks: [] },
        { role: 'user', content: 'What was the weather in Mestia yesterday?' },
        { role: 'assistant', content: 'Let me check.', toolCalls: [{ id: 'call_prior_1', name: 'get_weather', input: { city: 'Mestia' } }], reasoningBlocks: [] },
        { role: 'tool', toolCallId: 'call_prior_1', content: '[Trimmed: get_weather result — 1532 chars]' },
        { role: 'assistant', content: PRE_ANCHOR_TEXT, reasoningBlocks: [] },
    ];
}
const editPreAnchor = (msgs) => msgs.map((m) => (m.role === 'assistant' && m.content === PRE_ANCHOR_TEXT)
    ? { role: 'assistant', content: PRE_ANCHOR_EDIT, reasoningBlocks: [] } : m);

// ── request building (production adapter path) ─────────────────────────────
function buildBody(model, messages, { turn, forced }) {
    const systemPrompt = or.formatSystemPrompt(STABLE, dynamicFor(turn));
    const tools = or.formatTools(TOOLS_RAW);
    const ro = forced
        ? { reasoningEnabled: true, reasoningSupport: 'yes' } // the adapter's own reasoning branch
        : { reasoningEnabled: true, reasoningSupport: catalog.reasoningSupportFor('openrouter', model, 'api_key') }; // production: "unknown" → omitted
    const apiMessages = or.toApiMessages(messages, model, ro);
    const body = JSON.parse(or.formatRequest(model, MAX_TOKENS, systemPrompt, apiMessages, tools, ro));
    if (PIN) body.provider = { order: [PIN], allow_fallbacks: false };
    let replayed = 0;
    for (const m of body.messages) if (m.role === 'assistant' && Array.isArray(m.reasoning_details)) replayed += m.reasoning_details.length;
    return { body, replayed };
}

// ── read-only SSE tap ───────────────────────────────────────────────────────
// http.js calls getClient(options).request(options, cb). Wrapping .request on
// the http/https module objects lets us observe the same bytes the reducer
// parses; the reducer itself is untouched.
let CURRENT_TAP = null;
function newTap() { return { status: null, sse: false, providers: new Set(), model: null, id: null, reasoningChars: 0, details: [], raw: '' }; }
function installTap(mod) {
    if (mod.__orPtTapped) return;
    const orig = mod.request;
    mod.request = function tappedRequest(options, cb) {
        const tap = CURRENT_TAP;
        if (typeof cb !== 'function' || !tap) return orig.apply(mod, arguments);
        return orig.call(mod, options, (res) => { attachTap(res, tap); cb(res); });
    };
    mod.__orPtTapped = true;
}
installTap(nodeHttps);
installTap(nodeHttp);

const CONCAT_FIELDS = new Set(['text', 'summary', 'data', 'signature']);
function mergeReasoningDetails(acc, deltas) {
    for (const d of deltas) {
        if (!d || typeof d !== 'object') continue;
        const idx = typeof d.index === 'number' ? d.index : null;
        let tgt = idx !== null ? acc.find((x) => x.index === idx)
            : (acc.length && acc[acc.length - 1].type === d.type ? acc[acc.length - 1] : null);
        if (!tgt) { tgt = {}; acc.push(tgt); }
        for (const [k, v] of Object.entries(d)) {
            if (CONCAT_FIELDS.has(k) && typeof v === 'string') tgt[k] = (tgt[k] || '') + v;
            else if (v !== null && v !== undefined && tgt[k] === undefined) tgt[k] = v;
        }
    }
    acc.sort((a, b) => (a.index ?? 0) - (b.index ?? 0));
}
function tapEvent(tap, raw) {
    let data = '';
    for (const line of raw.split('\n')) {
        if (line.startsWith(':')) continue;
        if (line.startsWith('data:')) { const d = line.slice(5); data += (data ? '\n' : '') + (d.startsWith(' ') ? d.slice(1) : d); }
    }
    if (!data || data.trim() === '[DONE]') return;
    let p; try { p = JSON.parse(data); } catch (_) { return; }
    if (p.provider) tap.providers.add(String(p.provider));
    if (p.model) tap.model = p.model;
    if (p.id && !tap.id) tap.id = p.id;
    if (p.error && p.error.metadata && p.error.metadata.provider_name) tap.providers.add(String(p.error.metadata.provider_name));
    const delta = p.choices && p.choices[0] && p.choices[0].delta;
    if (!delta) return;
    if (typeof delta.reasoning === 'string') tap.reasoningChars += delta.reasoning.length;
    if (Array.isArray(delta.reasoning_details)) MERGE(tap.details, delta.reasoning_details);
}
let MERGE = mergeReasoningDetails; // swappable for the self-check negative control
function attachTap(res, tap) {
    tap.status = res.statusCode;
    tap.sse = String(res.headers['content-type'] || '').includes('text/event-stream');
    let buf = '';
    res.on('data', (chunk) => {
        const s = typeof chunk === 'string' ? chunk : chunk.toString('utf8');
        if (!tap.sse) { if (tap.raw.length < 65536) tap.raw += s; return; }
        buf += s.replace(/\r\n/g, '\n').replace(/\r/g, '\n');
        let b;
        while ((b = buf.indexOf('\n\n')) !== -1) { const ev = buf.slice(0, b); buf = buf.slice(b + 2); tapEvent(tap, ev); }
    });
    res.on('end', () => { if (buf.trim()) tapEvent(tap, buf); buf = ''; });
}

// The non-streamed shape OpenRouter documents: message.reasoning_details[].
function withDetails(data, tap) {
    const d = JSON.parse(JSON.stringify(data));
    if (d && d.choices && d.choices[0] && d.choices[0].message && tap.details.length) {
        d.choices[0].message.reasoning_details = JSON.parse(JSON.stringify(tap.details));
    }
    if (tap.id) d.id = tap.id;
    return d;
}

// ── transport ───────────────────────────────────────────────────────────────
let REQUESTS = 0;
const TOKENS = { prompt: 0, completion: 0, cached: 0, cost: 0, costSeen: false };
class StopRun extends Error {}

function liveTarget(key) {
    return { hostname: or.endpoint.hostname, path: or.endpoint.path, method: 'POST', headers: or.buildHeaders(key), timeout: 180000 };
}
async function exchange(ctx, body) {
    if (REQUESTS >= CAP) throw new StopRun(`request cap ${CAP} reached`);
    REQUESTS++;
    const tap = newTap();
    CURRENT_TAP = tap;
    let res;
    try {
        res = await http.httpChatCompletionsStreamingRequest(ctx.target(), JSON.stringify(body));
    } catch (e) {
        res = { status: 'network', data: { error: { message: e && e.message } } };
    } finally {
        CURRENT_TAP = null;
    }
    if (res && res.status === 200 && res.data && res.data.usage) {
        const u = or.normalizeUsage(res.data.usage);
        TOKENS.prompt += u.inputTokens; TOKENS.completion += u.outputTokens; TOKENS.cached += u.cacheRead;
        if (typeof res.data.usage.cost === 'number') { TOKENS.cost += res.data.usage.cost; TOKENS.costSeen = true; }
    }
    // 401/403 (auth) and 402 (credits) stop the run: every later request would fail the same way.
    if (res && (res.status === 401 || res.status === 402 || res.status === 403)) {
        throw new StopRun(`${res.status} on ${ctx.model}: ${scrub(errText(res))}`);
    }
    return { res, tap };
}

// ── classification ──────────────────────────────────────────────────────────
function errText(res) {
    const d = res && res.data;
    if (!d) return '';
    if (typeof d === 'string') return d;
    const parts = [];
    const e = d.error || d;
    if (e && e.message) parts.push(String(e.message));
    const raw = e && e.metadata && e.metadata.raw;
    if (raw) parts.push(typeof raw === 'string' ? raw : JSON.stringify(raw));
    if (!parts.length && d.message) parts.push(String(d.message));
    return parts.join(' | ');
}
const SIG_RE = /Invalid\s*`?signature`?\s*in\s*`?thinking`?\s*block/i;
const isSig400 = (res) => !!res && res.status === 400 && SIG_RE.test(errText(res));
const isServerSide = (res) => !res || typeof res.status !== 'number' || res.status >= 500;
function providerOf(res, tap) {
    if (tap && tap.providers.size) return [...tap.providers].join('+');
    const pn = res && res.data && res.data.error && res.data.error.metadata && res.data.error.metadata.provider_name;
    return pn ? String(pn) : '-';
}
function reasoningOut(res, tap) {
    if (!res || res.status !== 200) return '-';
    const sig = tap.details.some((d) => typeof d.signature === 'string' && d.signature.length > 0);
    const enc = tap.details.some((d) => d.type === 'reasoning.encrypted');
    return `details=${tap.details.length} chars=${tap.reasoningChars} sig=${sig ? 'y' : 'n'}${enc ? ' enc=y' : ''}`;
}
const gotReasoning = (tap) => tap.details.length > 0 || tap.reasoningChars > 0;

// ── rows ────────────────────────────────────────────────────────────────────
const ROWS = [];
function addRow(ctx, scenario, mode, req, ex, verdict, finding, note) {
    const res = ex && ex.res; const tap = ex && ex.tap;
    ROWS.push({
        model: ctx.model, scenario, mode,
        status: res ? res.status : 'not sent',
        provider: res ? providerOf(res, tap) : '-',
        served: (res && res.data && res.data.model) || (tap && tap.model) || '-',
        replayed: req ? req.replayed : '-',
        reasoningOut: res ? reasoningOut(res, tap) : '-',
        finding: finding || '',
        verdict,
        note: note || (res && res.status !== 200 ? scrub(errText(res)) : ''),
    });
    return ROWS[ROWS.length - 1];
}

function controlVerdict(req, res) {
    if (req.replayed === 0) return ['INCONCLUSIVE', '', 'nothing replayed'];
    if (res.status === 200) return ['OK', 'replay accepted', ''];
    if (isServerSide(res)) return ['INCONCLUSIVE', '', `server-side ${res.status}: ${scrub(errText(res))}`];
    if (isSig400(res)) return ['UNEXPECTED', 'unedited replay REJECTED', `capture/merge/routing broke the block: ${scrub(errText(res))}`];
    return ['UNEXPECTED', '', scrub(errText(res))];
}
// Tamper control: both answers are observations. 400 → the route forwards the
// replayed reasoning to an upstream that verifies it; 200 → it does not.
function tamperVerdict(req, res) {
    if (req.replayed === 0) return ['INCONCLUSIVE', '', 'nothing replayed'];
    if (res.status === 200) return ['OK', 'tamper ACCEPTED (replayed reasoning not verified)', ''];
    if (isSig400(res)) return ['OK', 'tamper rejected (signature verified upstream)', scrub(errText(res))];
    if (isServerSide(res)) return ['INCONCLUSIVE', '', `server-side ${res.status}: ${scrub(errText(res))}`];
    return ['OK', `tamper rejected (${res.status}, not the signature text)`, scrub(errText(res))];
}
function testVerdict(req, res, controlRow, tamperRow) {
    if (req.replayed === 0) return ['INCONCLUSIVE', '', 'nothing replayed'];
    if (!controlRow || controlRow.verdict !== 'OK') return ['INCONCLUSIVE', res.status === 200 ? 'accepted' : (isSig400(res) ? 'signature 400' : ''), `paired control not OK${res.status !== 200 ? ' — ' + scrub(errText(res), 160) : ''}`];
    if (res.status === 200) {
        if (!tamperRow || tamperRow.verdict !== 'OK') return ['INCONCLUSIVE', 'accepted', 'tamper control missing/inconclusive — cannot tell "no binding" from "not forwarded"'];
        if (tamperRow.status === 200) return ['OK', 'no repro (route does not verify replayed reasoning)', ''];
        return ['OK', 'no repro (accepted; signatures ARE verified)', ''];
    }
    if (isSig400(res)) return ['OK', 'REPRODUCES (signature 400)', scrub(errText(res))];
    if (isServerSide(res)) return ['INCONCLUSIVE', '', `server-side ${res.status}: ${scrub(errText(res))}`];
    return ['UNEXPECTED', '', scrub(errText(res))];
}
function productionVerdict(req, res) {
    if (res.status === 200) return ['OK', `production accepted (replayed=${req.replayed})`, ''];
    if (isServerSide(res)) return ['INCONCLUSIVE', '', `server-side ${res.status}: ${scrub(errText(res))}`];
    if (isSig400(res)) return ['UNEXPECTED', 'PRODUCTION REPRODUCES', scrub(errText(res))];
    return ['UNEXPECTED', '', scrub(errText(res))];
}

function asstFrom(data) {
    const p = or.fromApiResponse(data);
    return { parsed: p, msg: { role: 'assistant', content: p.text || '', toolCalls: p.toolCalls, reasoningBlocks: p.reasoningBlocks } };
}
const resultsFor = (toolCalls) => toolCalls.map((tc) => ({ role: 'tool', toolCallId: tc.id, content: toolResult(tc.input && tc.input.city) }));

// ── per-model scenario chain ────────────────────────────────────────────────
async function runModel(ctx) {
    const seed = seedMatureHistory();
    const a1 = { role: 'user', content: T1_PROMPT };
    const a2 = { role: 'user', content: T2_PROMPT };

    // T1R1
    let req = buildBody(ctx.model, [...seed, a1], { turn: 1, forced: true });
    let ex = await exchange(ctx, req.body);
    if (ex.res.status !== 200) {
        addRow(ctx, 'T1R1 turn 1 round 1', 'forced', req, ex, isServerSide(ex.res) ? 'INCONCLUSIVE' : 'UNEXPECTED', '', undefined);
        return;
    }
    const prod1 = asstFrom(ex.res.data);
    const wire1 = asstFrom(withDetails(ex.res.data, ex.tap));
    const hasTool = prod1.parsed.toolCalls.length > 0;
    const t1 = addRow(ctx, 'T1R1 turn 1 round 1', 'forced', req, ex,
        hasTool && gotReasoning(ex.tap) ? 'OK' : 'INCONCLUSIVE',
        `tool_calls=${prod1.parsed.toolCalls.length} reasoningBlocks prod=${prod1.parsed.reasoningBlocks.length} wire=${wire1.parsed.reasoningBlocks.length}`,
        !hasTool ? 'no tool call — chain skipped' : (!gotReasoning(ex.tap) ? 'no reasoning returned — chain skipped' : ''));
    if (t1.verdict !== 'OK') return;

    const results = resultsFor(prod1.parsed.toolCalls);
    const wireT1 = [...seed, a1, wire1.msg, ...results];
    const prodT1 = [...seed, a1, prod1.msg, ...results];

    // W-c control: same turn, round 2, no edit.
    req = buildBody(ctx.model, wireT1, { turn: 1, forced: true });
    let closingWire = { role: 'assistant', content: CLOSING, reasoningBlocks: [] };
    let closingProd = closingWire;
    let ctlC = null;
    if (req.replayed === 0) {
        ctlC = addRow(ctx, 'W-c CONTROL same turn, no edit', 'wire-capture', req, null, 'INCONCLUSIVE', '', 'T1R1 reasoning had no reasoning_details — nothing to replay; wire rows skipped');
    } else {
        ex = await exchange(ctx, req.body);
        const [v, f, n] = controlVerdict(req, ex.res);
        ctlC = addRow(ctx, 'W-c CONTROL same turn, no edit', 'wire-capture', req, ex, v, f, n);
        if (ex.res.status === 200) {
            const w2 = asstFrom(withDetails(ex.res.data, ex.tap));
            const p2 = asstFrom(ex.res.data);
            if (!w2.parsed.toolCalls.length) { closingWire = w2.msg; closingProd = p2.msg; }
        }
    }
    const wireT2 = [...wireT1, closingWire, a2];
    const prodT2 = [...prodT1, closingProd, a2];

    if (req.replayed > 0) {
        // W-t TAMPER control: the round-2 body of W-c with the replayed reasoning
        // TEXT altered and the signature kept. A route that forwards replayed
        // reasoning to a verifying upstream must reject it; if it is accepted the
        // route does not verify replayed reasoning, so a W-a/W-b 200 is vacuous.
        const tampered = wireT1.map((m) => (m === wire1.msg ? Object.assign({}, m, {
            reasoningBlocks: m.reasoningBlocks.map((b) => (b.wire && typeof b.wire.text === 'string'
                ? Object.assign({}, b, { wire: Object.assign({}, b.wire, { text: b.wire.text + ' (edited)' }) }) : b)),
        }) : m));
        req = buildBody(ctx.model, tampered, { turn: 1, forced: true });
        ex = await exchange(ctx, req.body);
        const tamper = addRow(ctx, 'W-t TAMPER reasoning text edited, signature kept', 'wire-capture', req, ex, ...tamperVerdict(req, ex.res));

        // W-b SAME-TURN mature prefix edit.
        req = buildBody(ctx.model, editPreAnchor(wireT1), { turn: 1, forced: true });
        ex = await exchange(ctx, req.body);
        addRow(ctx, 'W-b SAME-TURN pre-anchor edit', 'wire-capture', req, ex, ...testVerdict(req, ex.res, ctlC, tamper));

        // W-a-ctl next turn, system unchanged.
        req = buildBody(ctx.model, wireT2, { turn: 1, forced: true });
        ex = await exchange(ctx, req.body);
        const ctlA = addRow(ctx, 'W-a-ctl CONTROL next turn, system unchanged', 'wire-capture', req, ex, ...controlVerdict(req, ex.res));

        // W-a NEXT-TURN system change.
        req = buildBody(ctx.model, wireT2, { turn: 2, forced: true });
        ex = await exchange(ctx, req.body);
        addRow(ctx, 'W-a NEXT-TURN system changed', 'wire-capture', req, ex, ...testVerdict(req, ex.res, ctlA, tamper));
    }

    // Production row: today's body + today's reducer history, next turn with the
    // system changed AND the pre-anchor edit (the reducer stores no reasoning, so
    // nothing is replayed; one row covers both edits).
    req = buildBody(ctx.model, editPreAnchor(prodT2), { turn: 2, forced: false });
    ex = await exchange(ctx, req.body);
    addRow(ctx, 'P-ab NEXT-TURN system changed + pre-anchor edit', 'production', req, ex, ...productionVerdict(req, ex.res));
}

function printTable() {
    const cols = ['model', 'scenario', 'mode', 'status', 'provider', 'served', 'replayed', 'reasoningOut', 'finding', 'verdict', 'note'];
    console.log('\n| ' + cols.join(' | ') + ' |');
    console.log('|' + cols.map(() => '---').join('|') + '|');
    for (const r of ROWS) console.log('| ' + cols.map((c) => String(r[c] === undefined ? '' : r[c]).replace(/\|/g, '/')).join(' | ') + ' |');
}
function applyExitCode(rows) {
    const bad = rows.filter((r) => r.verdict !== 'OK').length;
    if (bad > 0) process.exitCode = 1;
    return bad;
}
function summary() {
    const lines = [];
    for (const m of [...new Set(ROWS.map((r) => r.model))]) {
        const rs = ROWS.filter((r) => r.model === m);
        const f = (p) => { const r = rs.find((x) => x.scenario.startsWith(p)); return r ? `${r.finding || r.status} [${r.verdict}; ${r.provider}]` : 'n/a'; };
        lines.push(`  ${m}: next-turn(W-a)=${f('W-a NEXT')} | same-turn(W-b)=${f('W-b')} | tamper(W-t)=${f('W-t')} | production P-ab=${f('P-ab')}`);
    }
    return lines.join('\n');
}

// ── self-check: local fake OpenRouter through the REAL reducer ─────────────
// The fake binds each signature it issues to sha256(system+messages before the
// assistant message + tools) and to the exact reasoning text; a replayed detail
// with a missing/unknown signature, a different prefix, or different text is a
// mismatch. enforce:false → mismatches are accepted (no binding, no verification);
// verifyText:true (with enforce:false) → only the text/signature pair is checked
// (signatures verified, prefix not bound); credits0 → 402 on every request.
function startFake(opts) {
    const crypto = require('crypto');
    const issued = new Map(); // signature → { prefix, text }
    let n = 0;
    const hash = (msgs, tools) => crypto.createHash('sha256').update(JSON.stringify([msgs, tools || null])).digest('hex');
    const server = nodeHttp.createServer((req, res) => {
        let s = '';
        req.on('data', (c) => { s += c; });
        req.on('end', () => {
            n++;
            if (opts.deny || !/^Bearer\s+\S+/.test(req.headers.authorization || '')) {
                res.writeHead(401, { 'content-type': 'application/json' });
                res.end(JSON.stringify({ error: { message: 'No auth credentials found', code: 401 } }));
                return;
            }
            if (opts.credits0) {
                res.writeHead(402, { 'content-type': 'application/json' });
                res.end(JSON.stringify({ error: { message: "This request's maximum cost exceeds your available credits.", code: 402 } }));
                return;
            }
            const body = JSON.parse(s);
            let mismatch = null;
            let textMismatch = null;
            body.messages.forEach((m, i) => {
                if (m.role !== 'assistant' || !Array.isArray(m.reasoning_details)) return;
                m.reasoning_details.forEach((d, j) => {
                    if (d.type !== 'reasoning.text') return;
                    const want = issued.get(d.signature);
                    if (!want || want.text !== d.text) textMismatch = textMismatch || `messages.${i}.content.${j}`;
                    if (!want || want.prefix !== hash(body.messages.slice(0, i), body.tools) || want.text !== d.text) mismatch = mismatch || `messages.${i}.content.${j}`;
                });
            });
            if (!opts.enforce && opts.verifyText) mismatch = textMismatch;
            if (mismatch && (opts.enforce || opts.verifyText)) {
                res.writeHead(400, { 'content-type': 'application/json' });
                res.end(JSON.stringify({ error: { message: 'Provider returned error', code: 400, metadata: {
                    raw: JSON.stringify({ type: 'error', error: { type: 'invalid_request_error', message: `${mismatch}: Invalid \`signature\` in \`thinking\` block` } }),
                    provider_name: 'FakeUpstream' } } }));
                return;
            }
            const reason = !opts.noReasoning && body.reasoning && body.reasoning.effort !== 'none';
            const last = body.messages[body.messages.length - 1];
            const wantTool = last.role === 'user';
            const sig = `FAKESIG-${n}-` + crypto.randomBytes(6).toString('hex');
            const text = `Reasoning ${n}: weigh distance against warmth.`;
            const base = { id: `gen-fake-${n}`, provider: 'FakeUpstream', model: body.model, object: 'chat.completion.chunk' };
            const chunks = [];
            if (reason) {
                chunks.push({ ...base, choices: [{ index: 0, delta: { role: 'assistant', content: '', reasoning: text.slice(0, 10), reasoning_details: [{ type: 'reasoning.text', text: text.slice(0, 10), format: 'anthropic-claude-v1', index: 0 }] } }] });
                chunks.push({ ...base, choices: [{ index: 0, delta: { reasoning: text.slice(10), reasoning_details: [{ type: 'reasoning.text', text: text.slice(10), format: 'anthropic-claude-v1', index: 0 }] } }] });
                chunks.push({ ...base, choices: [{ index: 0, delta: { reasoning_details: [{ type: 'reasoning.text', signature: sig, format: 'anthropic-claude-v1', index: 0 }] } }] });
            }
            if (wantTool) {
                const city = ['Tbilisi', 'Batumi', 'Kutaisi'][n % 3];
                chunks.push({ ...base, choices: [{ index: 0, delta: { content: `Checking ${city}.` } }] });
                chunks.push({ ...base, choices: [{ index: 0, delta: { tool_calls: [{ index: 0, id: `call_fake_${n}`, type: 'function', function: { name: 'get_weather', arguments: '' } }] } }] });
                chunks.push({ ...base, choices: [{ index: 0, delta: { tool_calls: [{ index: 0, function: { arguments: JSON.stringify({ city }) } }] } }] });
                chunks.push({ ...base, choices: [{ index: 0, delta: {}, finish_reason: 'tool_calls' }] });
            } else {
                chunks.push({ ...base, choices: [{ index: 0, delta: { content: 'Here is the plan.' } }] });
                chunks.push({ ...base, choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] });
            }
            chunks.push({ ...base, choices: [], usage: { prompt_tokens: 100, completion_tokens: 10, cost: 0.0001 } });
            if (reason) {
                // The assistant message this response becomes sits right after the request's messages.
                issued.set(sig, { prefix: hash(body.messages, body.tools), text });
            }
            res.writeHead(200, { 'content-type': 'text/event-stream' });
            res.write(': OPENROUTER PROCESSING\n\n');
            for (const c of chunks) res.write(`data: ${JSON.stringify(c)}\n\n`);
            res.end('data: [DONE]\n\n');
        });
    });
    return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve({ server, port: server.address().port })));
}

async function selfCheck() {
    let failures = 0;
    const check = (label, cond) => { console.log(`${cond ? 'PASS' : 'FAIL'}: ${label}`); if (!cond) failures++; };
    const KEY = 'sk-or-v1-selfcheckselfcheckselfcheck0000';
    CAP = Infinity; // simulated requests are free; the cap test below sets its own
    async function runFake(opts, model = 'anthropic/claude-fable-5.1') {
        ROWS.length = 0;
        const { server, port } = await startFake(opts);
        const ctx = { model, target: () => ({ protocol: 'http:', hostname: '127.0.0.1', port, path: or.endpoint.path, method: 'POST', headers: or.buildHeaders(KEY), timeout: 10000 }) };
        let stopped = null;
        try { await runModel(ctx); } catch (e) { if (e instanceof StopRun) stopped = e.message; else throw e; } finally { server.close(); }
        const by = (p) => ROWS.find((r) => r.scenario.startsWith(p));
        return { by, stopped };
    }

    {
        const { by } = await runFake({ enforce: true });
        check('enforcing fake: T1R1 OK with reasoning + tool call', by('T1R1') && by('T1R1').verdict === 'OK' && /details=1/.test(by('T1R1').reasoningOut));
        check('enforcing fake: tap records the serving provider', by('T1R1') && by('T1R1').provider === 'FakeUpstream');
        check('enforcing fake: real reducer drops reasoning (production reasoningBlocks=0) but wire capture has 1', by('T1R1') && /prod=0 wire=1/.test(by('T1R1').finding));
        check('enforcing fake: W-c control replays and is accepted', by('W-c') && by('W-c').replayed >= 1 && by('W-c').verdict === 'OK');
        check('enforcing fake: W-b same-turn edit → REPRODUCES (OK)', by('W-b') && by('W-b').status === 400 && /REPRODUCES/.test(by('W-b').finding) && by('W-b').verdict === 'OK');
        check('enforcing fake: W-b note carries the scrubbed signature text', by('W-b') && /Invalid `signature` in `thinking` block/.test(by('W-b').note));
        check('enforcing fake: W-a-ctl (system unchanged) accepted', by('W-a-ctl') && by('W-a-ctl').verdict === 'OK');
        check('enforcing fake: W-a next-turn system change → REPRODUCES (OK)', by('W-a NEXT') && /REPRODUCES/.test(by('W-a NEXT').finding) && by('W-a NEXT').verdict === 'OK');
        check('enforcing fake: W-t tamper is rejected (signature verified)', by('W-t') && by('W-t').status === 400 && /tamper rejected/.test(by('W-t').finding) && by('W-t').verdict === 'OK');
        check('enforcing fake: production row replays nothing and is accepted', by('P-ab') && by('P-ab').replayed === 0 && by('P-ab').verdict === 'OK');
        check('enforcing fake: production body omits `reasoning` (freeform → unknown)', buildBody('anthropic/claude-fable-5.1', [{ role: 'user', content: 'x' }], { turn: 1, forced: false }).body.reasoning === undefined);
        check('forced body carries the adapter branch reasoning:{effort:"medium"}', JSON.stringify(buildBody('anthropic/claude-fable-5.1', [{ role: 'user', content: 'x' }], { turn: 1, forced: true }).body.reasoning) === '{"effort":"medium"}');
        check('enforcing fake: ≤7 requests per model', ROWS.filter((r) => r.status !== 'not sent').length <= 7);
    }
    {
        const { by } = await runFake({ enforce: false });
        check('non-verifying fake: W-t tamper accepted', by('W-t') && by('W-t').status === 200 && /ACCEPTED/.test(by('W-t').finding));
        check('non-verifying fake: W-b → no repro, qualified "does not verify"', by('W-b') && /does not verify/.test(by('W-b').finding) && by('W-b').verdict === 'OK');
        check('non-verifying fake: W-a → no repro, qualified "does not verify"', by('W-a NEXT') && /does not verify/.test(by('W-a NEXT').finding) && by('W-a NEXT').verdict === 'OK');
    }
    {
        const { by } = await runFake({ enforce: false, verifyText: true });
        check('verify-only fake: W-t tamper rejected', by('W-t') && by('W-t').status === 400);
        check('verify-only fake: W-b → no repro, signatures verified', by('W-b') && /signatures ARE verified/.test(by('W-b').finding) && by('W-b').verdict === 'OK');
        check('verify-only fake: W-a → no repro, signatures verified', by('W-a NEXT') && /signatures ARE verified/.test(by('W-a NEXT').finding) && by('W-a NEXT').verdict === 'OK');
    }
    {
        const { stopped } = await runFake({ credits0: true });
        check('402 (credits) stops the run immediately', !!stopped && /^402/.test(stopped) && ROWS.length === 0);
    }
    {
        const { by } = await runFake({ enforce: true, noReasoning: true });
        check('no-reasoning fake: T1R1 INCONCLUSIVE and chain skipped', by('T1R1') && by('T1R1').verdict === 'INCONCLUSIVE' && ROWS.length === 1);
    }
    {
        // Negative control: a broken merge (signature chunk lost) must fail the control
        // and make the test rows INCONCLUSIVE, never a false "no repro"/"REPRODUCES".
        MERGE = (acc, deltas) => mergeReasoningDetails(acc, deltas.filter((d) => !d || !d.signature));
        let r;
        try { r = await runFake({ enforce: true }); } finally { MERGE = mergeReasoningDetails; }
        check('negative: broken capture → W-c control UNEXPECTED', r.by('W-c') && r.by('W-c').verdict === 'UNEXPECTED');
        check('negative: broken capture → W-b INCONCLUSIVE (paired control failed)', r.by('W-b') && r.by('W-b').verdict === 'INCONCLUSIVE');
    }
    {
        const { stopped } = await runFake({ enforce: true, deny: true });
        check('401 stops the run immediately', !!stopped && /^401/.test(stopped) && ROWS.length === 0);
    }
    {
        const saved = CAP; const before = REQUESTS; CAP = REQUESTS + 3;
        let r;
        try { r = await runFake({ enforce: true }); } finally { CAP = saved; }
        check('request cap stops the run', !!r.stopped && /cap/.test(r.stopped) && REQUESTS - before === 3);
    }
    {
        SECRET = 'sk-or-v1-abcdefabcdefabcdef1234';
        const s = scrub(`key ${SECRET} and sk-or-v1-zzzzzzzzzzzz9999 and Bearer tok123`);
        SECRET = null;
        check('scrub removes the key, sk-or-v1-*, and Bearer tokens', !/abcdef|zzzz|tok123/.test(s));
        check('isSig400 matches the wrapped OpenRouter raw text', isSig400({ status: 400, data: { error: { message: 'Provider returned error', metadata: { raw: '{"error":{"message":"messages.3.content.0: Invalid `signature` in `thinking` block"}}' } } } }));
        check('isSig400 ignores an unrelated 400', !isSig400({ status: 400, data: { error: { message: 'max_tokens too large' } } }));
        const saved = process.exitCode;
        process.exitCode = 0; applyExitCode([{ verdict: 'OK' }]); const okExit = process.exitCode;
        applyExitCode([{ verdict: 'OK' }, { verdict: 'INCONCLUSIVE' }]); const badExit = process.exitCode;
        process.exitCode = saved;
        check('exit code: all-OK → 0, any not-OK → 1', okExit === 0 && badExit === 1);
    }
    console.log(`\nself-check: ${failures === 0 ? 'ALL PASS' : failures + ' FAILED'} (requests simulated: ${REQUESTS})`);
    process.exit(failures === 0 ? 0 : 1);
}

// ── main ────────────────────────────────────────────────────────────────────
async function main() {
    if (SELF_CHECK) return selfCheck();
    const key = (process.env.OPENROUTER_API_KEY || '').trim();
    if (!key) { console.log('STOP: OPENROUTER_API_KEY not set in the environment (run under `op run`).'); process.exit(2); }
    SECRET = key;
    console.log(`credential: OPENROUTER_API_KEY present (len ${key.length}) | cap ${CAP} live requests | max_tokens=${MAX_TOKENS}${PIN ? ` | PINNED provider=${PIN} (not production)` : ''}`);
    console.log(`models: ${MODELS.join(', ')}`);
    for (const m of MODELS) console.log(`  ${m}: registry reasoningSupport(openrouter)=${catalog.reasoningSupportFor('openrouter', m, 'api_key')} (production omits \`reasoning\` unless "yes")`);
    let stopped = null;
    for (const model of MODELS) {
        const ctx = { model, target: () => liveTarget(key) };
        try {
            await runModel(ctx);
        } catch (e) {
            if (e instanceof StopRun) { stopped = e.message; break; }
            ROWS.push({ model, scenario: 'harness', mode: '-', status: 'error', provider: '-', served: '-', replayed: '-', reasoningOut: '-', finding: '', verdict: 'UNEXPECTED', note: scrub(e && e.message) });
        }
    }
    printTable();
    console.log(`\nsummary:\n${summary()}`);
    console.log(`\nrequests: ${REQUESTS} | tokens: prompt=${TOKENS.prompt} completion=${TOKENS.completion} cached=${TOKENS.cached}${TOKENS.costSeen ? ` | cost=$${TOKENS.cost.toFixed(4)}` : ''}`);
    if (stopped) { console.log(`STOPPED: ${scrub(stopped)}`); process.exit(3); }
    const bad = applyExitCode(ROWS);
    console.log(`verdicts: ${ROWS.length - bad} OK, ${bad} not OK`);
}

main().catch((e) => { console.log(`FATAL: ${scrub(e && e.stack ? e.stack : e, 600)}`); process.exit(1); });
