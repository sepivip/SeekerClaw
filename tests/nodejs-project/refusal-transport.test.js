#!/usr/bin/env node
// refusal-transport.test.js — BAT-1705 D1/D2 + v2.1 A4 (Codex sign-off 563398e8).
//
// A refusal (the model declines) or a provider content filter must survive the
// stream reducers intact and come out of every adapter as `refusal`, with nothing
// from the refused response left to show, execute or replay. Fed as REAL SSE bytes
// from a local HTTP server through the real http.js streaming functions, then the
// real adapters:
//   - Claude: stop_reason "refusal" (+ stop_details) before output and mid-stream,
//     after partial text and a cut-off tool_use with no content_block_stop;
//   - Chat Completions (OpenRouter / xAI / Custom): delta.refusal, finish_reason
//     content_filter, a refusal-only stream with no [DONE];
//   - Responses (OpenAI / Codex / Custom-responses): refusal.delta/.done (done
//     REPLACES the deltas), content_filter on response.incomplete, on both the
//     server-output path and the accumulator fallback, and with no terminal event.
// Detection runs before tool mapping / the reasoning-summary fallback / the empty
// WARN; a filter beats a refusal; a bare truncated stream is not a refusal.
//
// Run:  node tests/nodejs-project/refusal-transport.test.js

'use strict';

const http = require('http');
const path = require('path');

const BUNDLE = path.resolve(__dirname, '..', '..', 'app', 'src', 'main', 'assets', 'nodejs-project');
const LOGS = [];
function _stub(rel, exports) {
    const resolved = require.resolve(path.join(BUNDLE, rel));
    require.cache[resolved] = { id: resolved, filename: resolved, loaded: true, exports };
}
_stub('config.js', {
    API_TIMEOUT_MS: 10000,
    log: (msg, level) => LOGS.push({ msg: String(msg), level: level || 'INFO' }),
    resolveActiveModel: () => 'test-model',
    MODEL: 'test-model', PROVIDER: 'claude', AUTH_TYPE: 'api_key', OPENAI_AUTH_TYPE: 'api_key',
    ANTHROPIC_KEY: 'k', OPENAI_KEY: 'k', OPENROUTER_KEY: 'k', XAI_KEY: 'k', CUSTOM_KEY: 'k',
    CUSTOM_BASE_URL: 'http://127.0.0.1', CUSTOM_FORMAT: 'chat', OPENROUTER_FALLBACK_MODEL: '',
    workDir: require('os').tmpdir(), config: {},
    runtimeState: { read: () => ({}) },
});

const H = require(path.join(BUNDLE, 'http.js'));
const claude = require(path.join(BUNDLE, 'providers', 'claude.js'));
const openai = require(path.join(BUNDLE, 'providers', 'openai.js'));
const openrouter = require(path.join(BUNDLE, 'providers', 'openrouter.js'));

let failures = 0;
function ok(label, cond, hint) {
    if (cond) console.log(`PASS: ${label}`);
    else { failures++; console.log(`FAIL: ${label}${hint ? ' — ' + hint : ''}`); }
}
function eq(label, a, e) { ok(label, JSON.stringify(a) === JSON.stringify(e), `\n  actual:   ${JSON.stringify(a)}\n  expected: ${JSON.stringify(e)}`); }

// ── a local SSE server: each request gets the next scripted byte string ─────
let NEXT = '';
const server = http.createServer((req, res) => {
    req.resume();
    req.on('end', () => {
        res.writeHead(200, { 'content-type': 'text/event-stream' });
        // Split mid-event so the reducers' buffering is exercised too.
        const bytes = NEXT;
        const mid = Math.floor(bytes.length / 2);
        res.write(bytes.slice(0, mid));
        setTimeout(() => { res.end(bytes.slice(mid)); }, 5);
    });
});
let PORT = 0;
const opts = () => ({ hostname: '127.0.0.1', port: PORT, path: '/', method: 'POST', protocol: 'http:', headers: { 'content-type': 'application/json' } });
async function stream(fn, bytes) { NEXT = bytes; return fn(opts(), '{}'); }

const ev = (type, data) => `event: ${type}\ndata: ${JSON.stringify(data)}\n\n`;
const dat = (data) => `data: ${typeof data === 'string' ? data : JSON.stringify(data)}\n\n`;
const logMark = () => LOGS.length;
const logsSince = (m, re) => LOGS.slice(m).filter(l => re.test(l.msg));

/** Every refusal part in a Responses result, across all output items, in order. */
function refusalParts(data) {
    const inner = (data && data.response) || data || {};
    const parts = [];
    for (const it of (inner.output || [])) {
        if (it && it.type === 'message' && Array.isArray(it.content)) {
            for (const p of it.content) if (p && p.type === 'refusal') parts.push(p);
        }
    }
    return parts;
}

function assertRefused(label, p, kind, extra = {}) {
    ok(`${label}: refusal kind ${kind}`, p.refusal && p.refusal.kind === kind, JSON.stringify(p.refusal));
    ok(`${label}: no text`, p.text === null);
    eq(`${label}: no tool calls`, p.toolCalls, []);
    eq(`${label}: no reasoning replay`, p.reasoningBlocks, []);
    if ('wireContent' in p) eq(`${label}: no wire replay`, p.wireContent, []);
    ok(`${label}: stopReason is the kind`, p.stopReason === kind);
    for (const [k, v] of Object.entries(extra)) eq(`${label}: ${k}`, p.refusal && p.refusal[k], v);
}

async function main() {
    await new Promise(r => server.listen(0, '127.0.0.1', r));
    PORT = server.address().port;

    // ── Claude ──────────────────────────────────────────────────────────────
    console.log('── Claude (httpStreamingRequest + applyClaudeStreamEvent) ──');
    const start = ev('message_start', { type: 'message_start', message: { id: 'msg_1', model: 'claude-opus-5', usage: { input_tokens: 5 } } });
    {
        const r = await stream(H.httpStreamingRequest, start
            + ev('message_delta', { type: 'message_delta', delta: { stop_reason: 'refusal', stop_details: null }, usage: { output_tokens: 0 } })
            + ev('message_stop', { type: 'message_stop' }));
        assertRefused('empty refusal, stop_details null', claude.fromApiResponse(r.data), 'model_refusal',
            { category: null, partialChars: 0, droppedToolCalls: 0, modelMessage: null });
    }
    {
        const r = await stream(H.httpStreamingRequest, start
            + ev('content_block_start', { index: 0, content_block: { type: 'thinking', thinking: '', signature: '' } })
            + ev('content_block_delta', { index: 0, delta: { type: 'thinking_delta', thinking: 'hmm' } })
            + ev('content_block_delta', { index: 0, delta: { type: 'signature_delta', signature: 'SIG'.repeat(10) } })
            + ev('content_block_stop', { index: 0 })
            + ev('content_block_start', { index: 1, content_block: { type: 'text', text: '' } })
            + ev('content_block_delta', { index: 1, delta: { type: 'text_delta', text: 'Here is how to' } })
            + ev('content_block_stop', { index: 1 })
            + ev('content_block_start', { index: 2, content_block: { type: 'tool_use', id: 'tu_1', name: 'shell_exec', input: {} } })
            + ev('content_block_delta', { index: 2, delta: { type: 'input_json_delta', partial_json: '{"command":"rm -' } })
            // no content_block_stop for the cut-off tool_use
            + ev('message_delta', { type: 'message_delta', delta: { stop_reason: 'refusal', stop_details: { type: 'refusal', category: 'cyber', explanation: 'NEVER LOG THIS' } } })
            + ev('message_stop', { type: 'message_stop' }));
        ok('stop_details survives streaming', r.data.stop_details && r.data.stop_details.category === 'cyber');
        assertRefused('mid-stream refusal after text + cut-off tool_use', claude.fromApiResponse(r.data), 'model_refusal',
            { category: 'cyber', partialChars: 'Here is how to'.length, droppedToolCalls: 1 });
    }
    {
        const p = claude.fromApiResponse({ content: [{ type: 'text', text: 'hi' }], stop_reason: 'end_turn', usage: {} });
        ok('Claude end_turn is not a refusal', p.refusal === null && p.text === 'hi');
        const m = claude.fromApiResponse({ content: [{ type: 'text', text: 'cut' }], stop_reason: 'max_tokens', usage: {} });
        ok('Claude max_tokens is unchanged', m.refusal === null && m.stopReason === 'max_tokens' && m.text === 'cut');
    }

    // ── Chat Completions ────────────────────────────────────────────────────
    console.log('── Chat Completions (httpChatCompletionsStreamingRequest + openrouter) ──');
    const chunk = (delta, finish) => dat({ id: 'c1', model: 'm', choices: [{ index: 0, delta, finish_reason: finish || null }] });
    {
        const r = await stream(H.httpChatCompletionsStreamingRequest,
            chunk({ role: 'assistant', refusal: "I'm sorry, " }) + chunk({ refusal: "I can't help with that." }) + chunk({}, 'stop') + dat('[DONE]'));
        eq('delta.refusal reaches message.refusal', r.data.choices[0].message.refusal, "I'm sorry, I can't help with that.");
        assertRefused('message.refusal', openrouter.fromApiResponse(r.data), 'model_refusal', { modelMessage: "I'm sorry, I can't help with that." });
    }
    {
        const m = logMark();
        const r = await stream(H.httpChatCompletionsStreamingRequest,
            chunk({ role: 'assistant', content: 'partial ans' })
            + chunk({ tool_calls: [{ index: 0, id: 'call_1', type: 'function', function: { name: 'shell_exec', arguments: '{"command":"cu' } }] })
            + chunk({ refusal: 'also a refusal' }, 'content_filter') + dat('[DONE]'));
        assertRefused('content_filter with partial text + cut-off tool call (+ refusal)', openrouter.fromApiResponse(r.data), 'provider_content_filter',
            { modelMessage: null, partialChars: 'partial ans'.length, droppedToolCalls: 1 });
        eq('the cut-off arguments are never parsed', logsSince(m, /Failed to parse tool arguments/).length, 0);
    }
    {
        let r;
        try { r = await stream(H.httpChatCompletionsStreamingRequest, chunk({ role: 'assistant', refusal: 'No.' })); }
        catch (e) { r = { status: `rejected: ${e.message}`, data: { choices: [{ message: {} }] } }; }
        ok('a refusal-only stream with no [DONE] resolves (explicit evidence)', r.status === 200, String(r.status));
        assertRefused('refusal without [DONE]', openrouter.fromApiResponse(r.data), 'model_refusal', { modelMessage: 'No.' });
    }
    {
        let threw = false;
        try { await stream(H.httpChatCompletionsStreamingRequest, chunk({ role: 'assistant' })); } catch (e) { threw = /Stream ended before \[DONE\]/.test(e.message); }
        ok('a bare truncated stream still rejects as a transport error', threw);
        const p = openrouter.fromApiResponse({ choices: [{ message: { content: 'cut' }, finish_reason: 'length' }], usage: {} });
        ok('finish_reason length is unchanged (max_tokens, not a refusal)', p.refusal === null && p.stopReason === 'max_tokens');
    }

    // ── Responses ───────────────────────────────────────────────────────────
    console.log('── Responses (httpOpenAIStreamingRequest + openai) ──');
    const added = (oi, item) => ev('response.output_item.added', { type: 'response.output_item.added', output_index: oi, item });
    const reasoningItem = { type: 'reasoning', id: 'rs_1', summary: [{ type: 'summary_text', text: 'I should explain' }], encrypted_content: 'ENC' };
    {
        const m = logMark();
        const r = await stream(H.httpOpenAIStreamingRequest,
            added(0, reasoningItem)
            + added(1, { type: 'message', id: 'msg_a', role: 'assistant', content: [] })
            + ev('response.refusal.delta', { type: 'response.refusal.delta', item_id: 'msg_a', content_index: 0, delta: 'I can ' })
            + ev('response.refusal.delta', { type: 'response.refusal.delta', item_id: 'msg_a', content_index: 0, delta: 'not' })
            + ev('response.refusal.done', { type: 'response.refusal.done', item_id: 'msg_a', content_index: 0, refusal: "I can't help with that." })
            + ev('response.refusal.delta', { type: 'response.refusal.delta', item_id: 'msg_a', content_index: 0, delta: ' (late)' })
            + ev('response.completed', { type: 'response.completed', response: { id: 'resp_1', status: 'completed', output: [], usage: { input_tokens: 3 } } }));
        assertRefused('refusal parts via the accumulator fallback', openai.fromApiResponse(r.data), 'model_refusal', { modelMessage: "I can't help with that." });
        eq('done replaces the deltas; later deltas ignored', refusalParts(r.data), [{ type: 'refusal', refusal: "I can't help with that." }]);
        eq('no reasoning-summary fallback, no empty WARN', logsSince(m, /Empty visible response|Falling back to reasoning summary/).length, 0);
    }
    {
        const serverResp = { id: 'resp_2', status: 'completed', output: [
            reasoningItem,
            { type: 'message', id: 'msg_b', role: 'assistant', content: [{ type: 'refusal', refusal: 'Server-side refusal.' }] }] };
        const r = await stream(H.httpOpenAIStreamingRequest, ev('response.completed', { type: 'response.completed', response: serverResp }));
        assertRefused('refusal part on the server-output path', openai.fromApiResponse(r.data), 'model_refusal', { modelMessage: 'Server-side refusal.' });
    }
    {
        const m = logMark();
        const r = await stream(H.httpOpenAIStreamingRequest,
            added(0, reasoningItem)
            + added(1, { type: 'message', id: 'msg_c', role: 'assistant', content: [] })
            + ev('response.output_text.delta', { type: 'response.output_text.delta', item_id: 'msg_c', content_index: 0, delta: 'Sure, first' })
            + added(2, { type: 'function_call', id: 'fc_1', call_id: 'call_9', name: 'shell_exec', arguments: '' })
            + ev('response.function_call_arguments.delta', { type: 'response.function_call_arguments.delta', item_id: 'fc_1', delta: '{"command":"cu' })
            + ev('response.incomplete', { type: 'response.incomplete', response: { id: 'resp_3', status: 'incomplete', incomplete_details: { reason: 'content_filter' }, output: [] } }));
        const inner = r.data.response || r.data;
        eq('incomplete + content_filter: the terminal payload is used as-is', [inner.status, inner.incomplete_details], ['incomplete', { reason: 'content_filter' }]);
        // Codex 2b68f44a #1: an incomplete stream is never rebuilt from accumulated
        // items, so the counts describe the terminal payload (empty here), not the
        // half-streamed text and call.
        assertRefused('content_filter with text + reasoning + cut-off call', openai.fromApiResponse(r.data), 'provider_content_filter',
            { modelMessage: null, partialChars: 0, droppedToolCalls: 0 });
        eq('cut-off arguments never parsed; no fallback; no empty WARN', logsSince(m, /Failed to parse tool arguments|Empty visible response|Falling back to reasoning summary/).length, 0);
    }
    {
        const resp = { status: 'incomplete', incomplete_details: { reason: 'content_filter' }, output: [
            { type: 'message', content: [{ type: 'refusal', refusal: 'model text' }] }] };
        assertRefused('a filter beats a refusal part', openai.fromApiResponse(resp), 'provider_content_filter', { modelMessage: null });
    }
    {
        const r = await stream(H.httpOpenAIStreamingRequest,
            added(0, { type: 'message', id: 'msg_d', role: 'assistant', content: [] })
            + ev('response.refusal.delta', { type: 'response.refusal.delta', output_index: 0, content_index: 0, delta: 'Nope.' }));
        ok('no terminal event: explicit refusal content still resolves', r.status === 200);
        assertRefused('refusal with no terminal event', openai.fromApiResponse(r.data), 'model_refusal', { modelMessage: 'Nope.' });
    }
    {
        const r = await stream(H.httpOpenAIStreamingRequest,
            added(0, { type: 'message', id: 'msg_e', role: 'assistant', content: [] })
            + ev('response.output_text.delta', { type: 'response.output_text.delta', output_index: 0, content_index: 0, delta: 'half an answ' }));
        const p = openai.fromApiResponse(r.data);
        ok('a bare truncated Responses stream is not a refusal (existing fallback)', p.refusal === null && p.text === 'half an answ');
        const mx = openai.fromApiResponse({ status: 'incomplete', incomplete_details: { reason: 'max_output_tokens' }, output: [{ type: 'message', content: [{ type: 'output_text', text: 'long' }] }] });
        ok('max_output_tokens is unchanged (max_tokens, not a refusal)', mx.refusal === null && mx.stopReason === 'max_tokens');
        const failed = openai.fromApiResponse({ status: 'failed', error: { code: 'bio_policy' }, output: [] });
        ok('status failed is not classified as a refusal (out of scope)', failed.refusal === null);
    }

    // ── Codex 2b68f44a #1: a non-refusal incomplete never promotes partial tools ──
    // Reducer → adapter boundary, real SSE bytes.
    const textDelta = (id, d) => ev('response.output_text.delta', { type: 'response.output_text.delta', item_id: id, content_index: 0, delta: d });
    const cutCall = (oi, fcId) => added(oi, { type: 'function_call', id: fcId, call_id: `call_${fcId}`, name: 'shell_exec', arguments: '' })
        + ev('response.function_call_arguments.delta', { type: 'response.function_call_arguments.delta', item_id: fcId, delta: '{"command":"rm -' });
    const incomplete = (reason, output = []) => ev('response.incomplete', { type: 'response.incomplete', response: { id: 'resp_i', status: 'incomplete', incomplete_details: { reason }, output } });
    {
        const m = logMark();
        const r = await stream(H.httpOpenAIStreamingRequest,
            added(0, { type: 'message', id: 'msg_m', role: 'assistant', content: [] })
            + textDelta('msg_m', 'Running it now')
            + cutCall(1, 'fc_m')
            + incomplete('max_output_tokens'));
        const p = openai.fromApiResponse(r.data);
        eq('max_output_tokens + cut-off call: no tool calls reach the adapter result', p.toolCalls, []);
        ok('max_output_tokens + cut-off call: stopReason max_tokens, not tool_use', p.stopReason === 'max_tokens', p.stopReason);
        ok('max_output_tokens + cut-off call: not a refusal', p.refusal === null);
        eq('max_output_tokens: the cut-off arguments are never parsed', logsSince(m, /Failed to parse tool arguments/).length, 0);
    }

    {
        // CodeRabbit on #472: the server's own incomplete payload carries the cut-off
        // call with status "incomplete". It is never mapped to a tool.
        const m = logMark();
        const r = await stream(H.httpOpenAIStreamingRequest,
            added(0, { type: 'message', id: 'msg_t', role: 'assistant', content: [] })
            + textDelta('msg_t', 'Running it')
            + cutCall(1, 'fc_t')
            + incomplete('max_output_tokens', [
                { type: 'message', id: 'msg_t', role: 'assistant', status: 'incomplete', content: [{ type: 'output_text', text: 'Running it' }] },
                { type: 'function_call', id: 'fc_t', call_id: 'call_fc_t', name: 'shell_exec', arguments: '{"command":"rm -', status: 'incomplete' }]));
        const p = openai.fromApiResponse(r.data);
        eq('server incomplete payload with a cut-off call: no tool calls', p.toolCalls, []);
        ok('server incomplete payload with a cut-off call: max_tokens, text kept', p.stopReason === 'max_tokens' && p.text === 'Running it', `${p.stopReason} ${JSON.stringify(p.text)}`);
        eq('server incomplete payload: the cut-off arguments are never parsed', logsSince(m, /Failed to parse tool arguments/).length, 0);
        // Controls: a finished call is still mapped, and so is a skeleton rebuilt
        // from a stream, which carries status "in_progress" even when it finished.
        const done = openai.fromApiResponse({ status: 'completed', output: [
            { type: 'function_call', call_id: 'c1', name: 'read', arguments: '{"path":"a"}', status: 'completed' },
            { type: 'function_call', call_id: 'c2', name: 'read', arguments: '{"path":"b"}', status: 'in_progress' }] });
        eq('completed and rebuilt (in_progress) calls are still tool calls', done.toolCalls.map(t => t.id), ['c1', 'c2']);
        const mixed = openai.fromApiResponse({ status: 'incomplete', incomplete_details: { reason: 'max_output_tokens' }, output: [
            { type: 'function_call', call_id: 'ok1', name: 'read', arguments: '{"path":"a"}', status: 'completed' },
            { type: 'function_call', call_id: 'cut1', name: 'shell_exec', arguments: '{"command":"rm -', status: 'incomplete' }] });
        ok('mixed incomplete payload: only the finished call is kept', JSON.stringify(mixed.toolCalls.map(t => t.id)) === '["ok1"]' && mixed.stopReason === 'tool_use',
            `${JSON.stringify(mixed.toolCalls.map(t => t.id))} ${mixed.stopReason}`);
    }

    // ── Codex 2b68f44a #2: observed refusal evidence survives assembly ──────────
    {
        // Sparse terminal: the completed payload carries only a reasoning item, so the
        // accumulator is not used; the refusal seen on the stream must still win, and
        // the accumulated cut-off call must not get through.
        const r = await stream(H.httpOpenAIStreamingRequest,
            added(0, reasoningItem)
            + added(1, { type: 'message', id: 'msg_s', role: 'assistant', content: [] })
            + ev('response.refusal.done', { type: 'response.refusal.done', item_id: 'msg_s', content_index: 0, refusal: 'Sparse refusal.' })
            + cutCall(2, 'fc_s')
            + ev('response.completed', { type: 'response.completed', response: { id: 'resp_s', status: 'completed', output: [reasoningItem] } }));
        assertRefused('sparse terminal payload', openai.fromApiResponse(r.data), 'model_refusal', { modelMessage: 'Sparse refusal.' });
    }
    {
        // Missing skeleton: the refusal names an output_index no output_item.added
        // announced, while other accumulated items (text, a cut-off call) exist.
        const r = await stream(H.httpOpenAIStreamingRequest,
            added(0, { type: 'message', id: 'msg_k', role: 'assistant', content: [] })
            + textDelta('msg_k', 'partial')
            + cutCall(1, 'fc_k')
            + ev('response.refusal.delta', { type: 'response.refusal.delta', output_index: 5, content_index: 0, delta: 'No skeleton.' })
            + ev('response.completed', { type: 'response.completed', response: { id: 'resp_k', status: 'completed', output: [] } }));
        assertRefused('refusal with no message skeleton', openai.fromApiResponse(r.data), 'model_refusal', { modelMessage: 'No skeleton.' });
    }
    {
        // Unresolvable index: item_id never announced and no output_index.
        const r = await stream(H.httpOpenAIStreamingRequest,
            added(0, { type: 'message', id: 'msg_u', role: 'assistant', content: [] })
            + ev('response.refusal.delta', { type: 'response.refusal.delta', item_id: 'msg_unknown', content_index: 0, delta: 'Unresolved.' })
            + ev('response.completed', { type: 'response.completed', response: { id: 'resp_u', status: 'completed', output: [] } }));
        assertRefused('refusal with an unresolvable index', openai.fromApiResponse(r.data), 'model_refusal', { modelMessage: 'Unresolved.' });
    }
    {
        // A non-filter incomplete with refusal evidence: the refusal wins over the
        // partial call, which is never promoted.
        const r = await stream(H.httpOpenAIStreamingRequest,
            added(0, { type: 'message', id: 'msg_q', role: 'assistant', content: [] })
            + ev('response.refusal.delta', { type: 'response.refusal.delta', item_id: 'msg_q', content_index: 0, delta: 'Truncated refusal.' })
            + cutCall(1, 'fc_q')
            + incomplete('max_output_tokens'));
        assertRefused('max_output_tokens with refusal evidence', openai.fromApiResponse(r.data), 'model_refusal', { modelMessage: 'Truncated refusal.' });
    }
    {
        // Terminal filter priority is kept when refusal evidence was also streamed.
        const r = await stream(H.httpOpenAIStreamingRequest,
            added(0, { type: 'message', id: 'msg_f', role: 'assistant', content: [] })
            + ev('response.refusal.delta', { type: 'response.refusal.delta', item_id: 'msg_f', content_index: 0, delta: 'model text' })
            + incomplete('content_filter'));
        assertRefused('content_filter beats streamed refusal evidence', openai.fromApiResponse(r.data), 'provider_content_filter', { modelMessage: null });
    }
    {
        // No terminal event and no skeleton at all: explicit refusal evidence still
        // resolves as a refusal instead of a transport error.
        let r;
        try {
            r = await stream(H.httpOpenAIStreamingRequest,
                ev('response.refusal.delta', { type: 'response.refusal.delta', output_index: 0, content_index: 0, delta: 'Bare refusal.' }));
        } catch (e) { r = { status: `rejected: ${e.message}`, data: {} }; }
        ok('no terminal, no skeleton: explicit refusal resolves', r.status === 200, String(r.status));
        assertRefused('refusal with no terminal and no skeleton', openai.fromApiResponse(r.data), 'model_refusal', { modelMessage: 'Bare refusal.' });
    }
    {
        // The server payload already carries the refusal part: it is authoritative and
        // the streamed evidence is not added a second time.
        const r = await stream(H.httpOpenAIStreamingRequest,
            added(0, { type: 'message', id: 'msg_d2', role: 'assistant', content: [] })
            + ev('response.refusal.done', { type: 'response.refusal.done', item_id: 'msg_d2', content_index: 0, refusal: 'Once.' })
            + ev('response.completed', { type: 'response.completed', response: { id: 'resp_d2', status: 'completed', output: [
                { type: 'message', id: 'msg_d2', role: 'assistant', content: [{ type: 'refusal', refusal: 'Once.' }] }] } }));
        eq('a server refusal part is not duplicated by streamed evidence', refusalParts(r.data).length, 1);
        assertRefused('server refusal part plus streamed evidence', openai.fromApiResponse(r.data), 'model_refusal', { modelMessage: 'Once.' });
    }
    {
        // An unwrapped terminal payload (no `response` envelope) gets the evidence too.
        const r = await stream(H.httpOpenAIStreamingRequest,
            added(0, { type: 'message', id: 'msg_w', role: 'assistant', content: [] })
            + ev('response.refusal.delta', { type: 'response.refusal.delta', item_id: 'msg_w', content_index: 0, delta: 'Unwrapped.' })
            + cutCall(1, 'fc_w')
            + ev('response.incomplete', { status: 'incomplete', incomplete_details: { reason: 'max_output_tokens' }, output: [] }));
        assertRefused('unwrapped incomplete payload with refusal evidence', openai.fromApiResponse(r.data), 'model_refusal', { modelMessage: 'Unwrapped.' });
    }
    {
        // A normal completed stream with no refusal evidence is untouched.
        const r = await stream(H.httpOpenAIStreamingRequest,
            added(0, { type: 'message', id: 'msg_n', role: 'assistant', content: [] })
            + textDelta('msg_n', 'All good.')
            + ev('response.completed', { type: 'response.completed', response: { id: 'resp_n', status: 'completed', output: [] } }));
        const p = openai.fromApiResponse(r.data);
        ok('no refusal evidence: the accumulator path is unchanged', p.refusal === null && p.text === 'All good.' && refusalParts(r.data).length === 0);
    }

    // ── xAI and Custom inherit ──────────────────────────────────────────────
    {
        const xai = require(path.join(BUNDLE, 'providers', 'xai.js'));
        ok('xAI uses the Chat Completions parse', xai.fromApiResponse === openrouter.fromApiResponse);
        const custom = require(path.join(BUNDLE, 'providers', 'custom.js'));
        const p = custom.fromApiResponse({ choices: [{ message: { content: null, refusal: 'no' }, finish_reason: 'stop' }], usage: {} });
        assertRefused('Custom (chat format) inherits', p, 'model_refusal', { modelMessage: 'no' });
    }

    // ── every adapter returns the key ───────────────────────────────────────
    eq('every adapter returns `refusal` on a normal response', [
        'refusal' in claude.fromApiResponse({ content: [], stop_reason: 'end_turn' }),
        'refusal' in openai.fromApiResponse({ output: [] }),
        'refusal' in openrouter.fromApiResponse({ choices: [{ message: { content: 'x' }, finish_reason: 'stop' }] }),
        'refusal' in openrouter.fromApiResponse({}),
    ], [true, true, true, true]);
    ok('no raw stop_details explanation is ever logged', !LOGS.some(l => l.msg.includes('NEVER LOG THIS')));

    server.close();
    console.log(`\n${failures === 0 ? 'All' : failures + ' FAILED of'} refusal transport/adapter checks${failures === 0 ? ' passed' : ''}.`);
    process.exit(failures === 0 ? 0 : 1);
}

main().catch((e) => { console.error(e); server.close(); process.exit(1); });
