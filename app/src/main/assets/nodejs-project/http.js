// SeekerClaw — http.js
// HTTP transport layer: plain requests + SSE streaming for Claude/OpenAI/ChatCompletions APIs.
// Depends on: config.js

const http = require('http');
const https = require('https');

function getClient(options) {
    return options?.protocol === 'http:' ? http : https;
}
const { API_TIMEOUT_MS } = require('./config');

// BAT-244: timeout is configurable via options.timeout (ms). Defaults to API_TIMEOUT_MS from config.
function httpRequest(options, body = null) {
    const timeoutMs = options.timeout ?? API_TIMEOUT_MS;
    return new Promise((resolve, reject) => {
        const req = getClient(options).request(options, (res) => {
            res.setEncoding('utf8'); // Handle multi-byte chars (emoji) split across chunks
            let data = '';
            res.on('data', chunk => data += chunk);
            res.on('end', () => {
                try {
                    resolve({ status: res.statusCode, data: JSON.parse(data), headers: res.headers });
                } catch (e) {
                    resolve({ status: res.statusCode, data: data, headers: res.headers });
                }
            });
        });
        req.on('error', reject);
        req.setTimeout(timeoutMs, () => { req.destroy(); const err = new Error('Timeout'); err.timeoutSource = 'transport'; reject(err); });
        if (body) req.write(typeof body === 'string' ? body : JSON.stringify(body));
        req.end();
    });
}

// BAT-259: Streaming HTTP request for Claude API — SSE parsing, same return shape as httpRequest.
// Eliminates transport timeouts: SSE events reset the socket idle timer every few seconds,
// so even 120s responses never trigger the 60s timeout.
function httpStreamingRequest(options, body = null) {
    const timeoutMs = options.timeout ?? API_TIMEOUT_MS;
    const HARD_TIMEOUT_MS = 5 * 60 * 1000; // 5 min absolute cap

    return new Promise((resolve, reject) => {
        let settled = false;
        const settle = (fn, val) => { if (!settled) { settled = true; fn(val); } };

        let req = null;
        let hardTimer = null;

        // Hard timeout — prevent infinite hanging (armed after req is created)
        const armHardTimeout = () => {
            hardTimer = setTimeout(() => {
                if (req) req.destroy();
                const err = new Error('Streaming hard timeout (5 min)');
                err.timeoutSource = 'transport';
                settle(reject, err);
            }, HARD_TIMEOUT_MS);
        };

        try {
        req = getClient(options).request(options, (res) => {
            // Non-2xx with non-SSE content-type → fall back to buffered read
            const ct = res.headers['content-type'] || '';
            if (res.statusCode !== 200 || !ct.includes('text/event-stream')) {
                res.setEncoding('utf8');
                let data = '';
                res.on('data', chunk => data += chunk);
                res.on('end', () => {
                    clearTimeout(hardTimer);
                    try {
                        settle(resolve, { status: res.statusCode, data: JSON.parse(data), headers: res.headers });
                    } catch (_) {
                        settle(resolve, { status: res.statusCode, data, headers: res.headers });
                    }
                });
                return;
            }

            // SSE streaming — accumulate content blocks into a non-streaming response shape
            res.setEncoding('utf8');
            const message = { id: null, type: 'message', role: 'assistant', content: [], model: null, stop_reason: null, usage: {} };
            const blocks = []; // indexed by content_block index
            let sseBuffer = '';

            res.on('data', chunk => {
                // Normalize CRLF/CR to LF (SSE spec, matches mcp-client.js parseSSEEvents)
                sseBuffer += chunk.replace(/\r\n/g, '\n').replace(/\r/g, '\n');

                // Process complete SSE events (double newline delimited)
                let boundary;
                while ((boundary = sseBuffer.indexOf('\n\n')) !== -1) {
                    const raw = sseBuffer.slice(0, boundary);
                    sseBuffer = sseBuffer.slice(boundary + 2);

                    // Parse event type and data
                    let eventType = 'message', eventData = '';
                    for (const line of raw.split('\n')) {
                        if (line.startsWith('event:')) eventType = line.slice(6).trim();
                        else if (line.startsWith('data:')) {
                            const d = line.slice(5);
                            eventData += (eventData ? '\n' : '') + (d.startsWith(' ') ? d.slice(1) : d);
                        }
                    }
                    if (!eventData) continue;

                    // SSE error event — map to HTTP-style error for retry logic
                    if (eventType === 'error') {
                        clearTimeout(hardTimer);
                        try {
                            const errPayload = JSON.parse(eventData);
                            const status = errPayload.error?.type === 'overloaded_error' ? 529 : 500;
                            settle(resolve, { status, data: errPayload, headers: res.headers });
                        } catch (_) {
                            settle(resolve, { status: 500, data: { error: { message: eventData } }, headers: res.headers });
                        }
                        res.destroy();
                        return;
                    }

                    let parsed;
                    try { parsed = JSON.parse(eventData); } catch (_) { continue; }

                    switch (eventType) {
                        case 'message_start':
                            if (parsed.message) {
                                message.id = parsed.message.id;
                                message.model = parsed.message.model;
                                Object.assign(message.usage, parsed.message.usage || {});
                            }
                            break;
                        case 'content_block_start':
                            if (typeof parsed.index === 'number' && parsed.content_block) {
                                blocks[parsed.index] = parsed.content_block;
                                if (blocks[parsed.index].type === 'tool_use') {
                                    blocks[parsed.index]._inputJson = '';
                                }
                            }
                            break;
                        case 'content_block_delta': {
                            const blk = blocks[parsed.index];
                            if (!blk || !parsed.delta) break;
                            if (parsed.delta.type === 'text_delta') {
                                blk.text = (blk.text || '') + parsed.delta.text;
                            } else if (parsed.delta.type === 'input_json_delta') {
                                if (typeof blk._inputJson !== 'string') blk._inputJson = '';
                                blk._inputJson += parsed.delta.partial_json;
                            }
                            break;
                        }
                        case 'content_block_stop': {
                            const blk = blocks[parsed.index];
                            if (blk?.type === 'tool_use' && blk._inputJson) {
                                try { blk.input = JSON.parse(blk._inputJson); } catch (_) { blk.input = {}; }
                                delete blk._inputJson;
                            }
                            break;
                        }
                        case 'message_delta':
                            if (parsed.delta) {
                                message.stop_reason = parsed.delta.stop_reason ?? message.stop_reason;
                            }
                            Object.assign(message.usage, parsed.usage || {});
                            break;
                        case 'message_stop':
                            clearTimeout(hardTimer);
                            message.content = blocks.filter(Boolean).map(b => {
                                if (b.type === 'text') return { type: 'text', text: b.text || '' };
                                if (b.type === 'tool_use') return { type: 'tool_use', id: b.id, name: b.name, input: b.input || {} };
                                return b;
                            });
                            settle(resolve, { status: 200, data: message, headers: res.headers });
                            break;
                    }
                }
            });

            res.on('end', () => {
                clearTimeout(hardTimer);
                if (!settled) {
                    // Stream ended without message_stop — always treat as transport error
                    // so the existing retry logic can handle it. Attach partial message for diagnostics.
                    const err = new Error('Stream ended before message_stop');
                    err.timeoutSource = 'transport';
                    if (blocks.length > 0) {
                        message.content = blocks.filter(Boolean);
                        err.partialMessage = message;
                    }
                    settle(reject, err);
                }
            });
        });

        armHardTimeout();
        req.on('error', (err) => { clearTimeout(hardTimer); settle(reject, err); });
        req.setTimeout(timeoutMs, () => {
            req.destroy();
            clearTimeout(hardTimer);
            const err = new Error('Timeout');
            err.timeoutSource = 'transport';
            settle(reject, err);
        });
        if (body) req.write(typeof body === 'string' ? body : JSON.stringify(body));
        req.end();
        } catch (syncErr) {
            if (hardTimer) clearTimeout(hardTimer);
            settle(reject, syncErr);
        }
    });
}

// BAT-315: Streaming HTTP request for OpenAI Responses API — typed SSE events.
// Responses API uses semantic events: response.output_text.delta, response.completed, etc.
// Tool call arguments stream via response.function_call_arguments.delta.
// The response.completed event contains the full authoritative response.
function httpOpenAIStreamingRequest(options, body = null) {
    const timeoutMs = options.timeout ?? API_TIMEOUT_MS;
    const HARD_TIMEOUT_MS = 5 * 60 * 1000;

    return new Promise((resolve, reject) => {
        let settled = false;
        const settle = (fn, val) => { if (!settled) { settled = true; fn(val); } };

        let req = null;
        let hardTimer = null;

        const armHardTimeout = () => {
            hardTimer = setTimeout(() => {
                if (req) req.destroy();
                const err = new Error('Streaming hard timeout (5 min)');
                err.timeoutSource = 'transport';
                settle(reject, err);
            }, HARD_TIMEOUT_MS);
        };

        try {
        req = getClient(options).request(options, (res) => {
            const ct = res.headers['content-type'] || '';
            // Codex endpoint (chatgpt.com) sometimes streams SSE without a Content-Type
            // header. We treat 200-from-chatgpt.com-without-CT as SSE on faith; if Codex
            // ever returns a non-SSE 200 with an empty Content-Type, the SSE parser below
            // tracks parsedEventCount and throws a clear "looked like SSE but no events
            // parsed" error at end-of-stream rather than the generic "Stream ended" one.
            const isCodexHost = options.hostname === 'chatgpt.com';
            const isSSE = ct.includes('text/event-stream') ||
                (res.statusCode === 200 && isCodexHost && ct.trim() === '');
            if (res.statusCode !== 200 || !isSSE) {
                res.setEncoding('utf8');
                let data = '';
                res.on('data', chunk => data += chunk);
                res.on('end', () => {
                    clearTimeout(hardTimer);
                    try {
                        settle(resolve, { status: res.statusCode, data: JSON.parse(data), headers: res.headers });
                    } catch (_) {
                        settle(resolve, { status: res.statusCode, data, headers: res.headers });
                    }
                });
                return;
            }

            // Responses API SSE accumulators (fallback if stream disconnects)
            res.setEncoding('utf8');
            const outputItems = {};  // output_index → item skeleton
            const textAccum = {};    // "output_index:content_index" → accumulated text
            const funcArgAccum = {}; // output_index → accumulated arguments string
            // item_id → output_index lookup. Codex backend (gpt-5.x reasoning models
            // served via chatgpt.com/backend-api/codex/responses) emits delta events
            // with `item_id` instead of `output_index` — we build this map from the
            // earlier `response.output_item.added` events (which carry both fields)
            // and use it to resolve item_id back to output_index in the delta handlers.
            // Object.create(null) avoids prototype pollution since the keys come from
            // server-controlled item.id values.
            const itemIdToOutputIndex = Object.create(null);
            let accumulatedUsage = null;
            let sseBuffer = '';
            let parsedEventCount = 0; // tracks successful SSE event parses for end-of-stream diagnostics

            // Resolve output_index from either the event's own `output_index`
            // (older Responses API shape, used by api.openai.com) or by looking
            // up `item_id` in our map (Codex backend / gpt-5.x reasoning models —
            // they only emit `item_id` on delta events, not `output_index`).
            // Returns null if neither is available. Hoisted out of the per-event
            // hot path so it's allocated once per request, not per SSE event.
            const resolveOutputIndex = (p) => {
                if (typeof p.output_index === 'number') return p.output_index;
                if (typeof p.item_id === 'string' && Object.prototype.hasOwnProperty.call(itemIdToOutputIndex, p.item_id)) {
                    return itemIdToOutputIndex[p.item_id];
                }
                return null;
            };

            // Build response from accumulated deltas (fallback path)
            const buildFromAccum = () => {
                const output = [];
                const indices = Object.keys(outputItems).map(Number).sort((a, b) => a - b);
                for (const idx of indices) {
                    const item = outputItems[idx];
                    if (item.type === 'message') {
                        const content = [];
                        // Collect all text parts for this output index
                        for (const key of Object.keys(textAccum)) {
                            if (key.startsWith(`${idx}:`)) {
                                content.push({ type: 'output_text', text: textAccum[key] });
                            }
                        }
                        output.push({ ...item, content });
                    } else if (item.type === 'function_call') {
                        output.push({
                            ...item,
                            arguments: funcArgAccum[idx] || item.arguments || '',
                        });
                    } else {
                        output.push(item);
                    }
                }
                return { output, status: 'completed', usage: accumulatedUsage || {} };
            };

            res.on('data', chunk => {
                sseBuffer += chunk.replace(/\r\n/g, '\n').replace(/\r/g, '\n');

                let boundary;
                while ((boundary = sseBuffer.indexOf('\n\n')) !== -1) {
                    const raw = sseBuffer.slice(0, boundary);
                    sseBuffer = sseBuffer.slice(boundary + 2);

                    let eventType = '', eventData = '';
                    for (const line of raw.split('\n')) {
                        if (line.startsWith('event:')) eventType = line.slice(6).trim();
                        else if (line.startsWith('data:')) {
                            const d = line.slice(5);
                            eventData += (eventData ? '\n' : '') + (d.startsWith(' ') ? d.slice(1) : d);
                        }
                    }
                    if (!eventData) continue;

                    let parsed;
                    try { parsed = JSON.parse(eventData); } catch (_) { continue; }
                    parsedEventCount++;

                    switch (eventType) {
                        case 'response.output_item.added':
                            if (typeof parsed.output_index === 'number' && parsed.item) {
                                outputItems[parsed.output_index] = parsed.item;
                                if (parsed.item.id) {
                                    itemIdToOutputIndex[parsed.item.id] = parsed.output_index;
                                }
                                if (parsed.item.type === 'function_call') {
                                    funcArgAccum[parsed.output_index] = '';
                                }
                            }
                            break;

                        case 'response.output_text.delta': {
                            const oi = resolveOutputIndex(parsed);
                            if (oi !== null) {
                                const key = `${oi}:${parsed.content_index ?? 0}`;
                                textAccum[key] = (textAccum[key] || '') + (parsed.delta || '');
                            }
                            break;
                        }

                        case 'response.function_call_arguments.delta': {
                            const oi = resolveOutputIndex(parsed);
                            if (oi !== null) {
                                funcArgAccum[oi] = (funcArgAccum[oi] || '') + (parsed.delta || '');
                            }
                            break;
                        }

                        case 'response.completed':
                            clearTimeout(hardTimer);
                            // Codex backend's `response.completed` event sometimes carries
                            // an empty `output: []` array because the actual content was
                            // delivered piece-by-piece via earlier delta events. If the
                            // server's response.output is empty BUT we accumulated items
                            // ourselves, prefer our local accumulation so the user sees
                            // the model's actual reply instead of an empty response.
                            //
                            // Use `parsed.response || parsed` to match the existing
                            // `fromApiResponse(raw.response || raw)` logic — handles both
                            // wrapped (`{type, response: {output, ...}}`) and unwrapped
                            // (`{output, ...}`) backend payload shapes.
                            {
                                const serverResp = parsed.response || parsed;
                                const serverOutput = Array.isArray(serverResp.output) ? serverResp.output : [];
                                if (serverOutput.length === 0 && Object.keys(outputItems).length > 0) {
                                    settle(resolve, { status: 200, data: buildFromAccum(), headers: res.headers });
                                } else {
                                    settle(resolve, { status: 200, data: parsed, headers: res.headers });
                                }
                            }
                            return;

                        case 'response.incomplete':
                            clearTimeout(hardTimer);
                            // Truncated response — use what we have
                            settle(resolve, { status: 200, data: parsed, headers: res.headers });
                            return;

                        case 'error': {
                            clearTimeout(hardTimer);
                            const rawErrCode = parsed.code ?? parsed.status ?? parsed.http_status ?? 500;
                            const errCode = (typeof rawErrCode === 'number' && Number.isFinite(rawErrCode)) ? rawErrCode
                                : (Number.isFinite(Number(rawErrCode)) ? Number(rawErrCode) : 500);
                            settle(resolve, { status: errCode, data: parsed, headers: res.headers });
                            res.destroy();
                            return;
                        }
                    }

                    // Track usage from any event that includes it
                    if (parsed.usage) accumulatedUsage = parsed.usage;
                }
            });

            res.on('end', () => {
                clearTimeout(hardTimer);
                if (!settled) {
                    // Stream ended without response.completed — build from accumulated deltas
                    if (Object.keys(outputItems).length > 0) {
                        settle(resolve, { status: 200, data: buildFromAccum(), headers: res.headers });
                    } else if (parsedEventCount === 0 && sseBuffer.length > 0) {
                        // We assumed SSE (Codex header-less case) but the body never produced
                        // a single parseable SSE event. Keep the error message generic so
                        // arbitrary response-body content isn't embedded into err.message
                        // (which ai.js logs verbatim).
                        console.warn(`[http] Expected SSE but no events parsed (${sseBuffer.length} bytes); body preview: ${sseBuffer.slice(0, 200).replace(/\s+/g, ' ')}`);
                        const err = new Error('Expected SSE but no events parsed');
                        err.timeoutSource = 'transport';
                        settle(reject, err);
                    } else {
                        const err = new Error('Stream ended before response.completed');
                        err.timeoutSource = 'transport';
                        settle(reject, err);
                    }
                }
            });
        });

        armHardTimeout();
        req.on('error', (err) => { clearTimeout(hardTimer); settle(reject, err); });
        req.setTimeout(timeoutMs, () => {
            req.destroy();
            clearTimeout(hardTimer);
            const err = new Error('Timeout');
            err.timeoutSource = 'transport';
            settle(reject, err);
        });
        if (body) req.write(typeof body === 'string' ? body : JSON.stringify(body));
        req.end();
        } catch (syncErr) {
            if (hardTimer) clearTimeout(hardTimer);
            settle(reject, syncErr);
        }
    });
}

// BAT-447: Streaming HTTP request for Chat Completions API (OpenRouter, etc.)
// Simple data-only SSE: no typed event: lines, just data: lines + data: [DONE].
// OpenRouter sends ": OPENROUTER PROCESSING" keepalive comments (SSE spec: ignore).
// Tool call deltas stream via delta.tool_calls[i] with index-based accumulation.
function httpChatCompletionsStreamingRequest(options, body = null) {
    const timeoutMs = options.timeout ?? API_TIMEOUT_MS;
    const HARD_TIMEOUT_MS = 5 * 60 * 1000;

    return new Promise((resolve, reject) => {
        let settled = false;
        const settle = (fn, val) => { if (!settled) { settled = true; fn(val); } };

        let req = null;
        let hardTimer = null;

        const armHardTimeout = () => {
            hardTimer = setTimeout(() => {
                if (req) req.destroy();
                const err = new Error('Streaming hard timeout (5 min)');
                err.timeoutSource = 'transport';
                settle(reject, err);
            }, HARD_TIMEOUT_MS);
        };

        try {
        req = getClient(options).request(options, (res) => {
            const ct = res.headers['content-type'] || '';
            if (res.statusCode !== 200 || !ct.includes('text/event-stream')) {
                // Non-streaming error response
                res.setEncoding('utf8');
                let data = '';
                res.on('data', chunk => data += chunk);
                res.on('end', () => {
                    clearTimeout(hardTimer);
                    try {
                        settle(resolve, { status: res.statusCode, data: JSON.parse(data), headers: res.headers });
                    } catch (_) {
                        settle(resolve, { status: res.statusCode, data, headers: res.headers });
                    }
                });
                return;
            }

            // Chat Completions SSE accumulators
            res.setEncoding('utf8');
            let textContent = '';
            const toolCalls = {};    // index → { id, name, arguments }
            let finishReason = null;
            let usage = null;
            let actualModel = null;
            let sseBuffer = '';

            // Build accumulated response in fromApiResponse() shape
            const buildResponse = () => {
                const accToolCalls = Object.keys(toolCalls)
                    .map(Number).sort((a, b) => a - b)
                    .map(idx => ({
                        id: toolCalls[idx].id || `tc_cc_${idx}`,
                        type: 'function',
                        function: {
                            name: toolCalls[idx].name,
                            arguments: toolCalls[idx].arguments,
                        },
                    }));
                return {
                    choices: [{
                        message: {
                            role: 'assistant',
                            content: textContent || null,
                            tool_calls: accToolCalls.length > 0 ? accToolCalls : undefined,
                        },
                        finish_reason: finishReason || 'stop',
                    }],
                    usage: usage || {},
                    model: actualModel,
                };
            };

            // Process a single SSE event (may have multiple data: lines)
            const processEvent = (raw) => {
                let eventData = '';

                for (const line of raw.split('\n')) {
                    // SSE comments (keepalive: ": OPENROUTER PROCESSING") — ignore
                    if (line.startsWith(':')) continue;
                    // Accumulate data: lines (SSE spec: multi-line data concatenated with \n)
                    if (line.startsWith('data:')) {
                        const d = line.slice(5);
                        eventData += (eventData ? '\n' : '') + (d.startsWith(' ') ? d.slice(1) : d);
                    }
                }

                if (!eventData) return;

                // Stream termination
                if (eventData.trim() === '[DONE]') {
                    clearTimeout(hardTimer);
                    settle(resolve, { status: 200, data: buildResponse(), headers: res.headers });
                    return;
                }

                let parsed;
                try { parsed = JSON.parse(eventData); } catch (_) { return; }

                // Track actual model (may differ from requested if fallback triggered)
                if (parsed.model) actualModel = parsed.model;

                // In-band error (no choices, just error object)
                if (parsed.error && !parsed.choices) {
                    clearTimeout(hardTimer);
                    const rawCode = parsed.error.code ?? parsed.error.status ?? parsed.error.http_status ?? 500;
                    const code = (typeof rawCode === 'number' && Number.isFinite(rawCode)) ? rawCode
                        : (Number.isFinite(Number(rawCode)) ? Number(rawCode) : 500);
                    settle(resolve, { status: code, data: { error: parsed.error }, headers: res.headers });
                    res.destroy();
                    return;
                }

                const choice = parsed.choices?.[0];
                if (!choice) {
                    // Usage-only chunk (some providers send usage separately)
                    if (parsed.usage) usage = parsed.usage;
                    return;
                }

                const delta = choice.delta || {};

                // Text content delta
                if (delta.content) textContent += delta.content;

                // Tool call deltas — accumulate by index
                if (delta.tool_calls) {
                    for (const tc of delta.tool_calls) {
                        const idx = tc.index ?? 0;
                        if (!toolCalls[idx]) {
                            toolCalls[idx] = { id: tc.id || `tc_cc_${idx}`, name: '', arguments: '' };
                        }
                        if (tc.id) toolCalls[idx].id = tc.id;
                        if (tc.function?.name) toolCalls[idx].name = tc.function.name;
                        if (tc.function?.arguments) toolCalls[idx].arguments += tc.function.arguments;
                    }
                }

                // Track finish_reason and usage
                if (choice.finish_reason) finishReason = choice.finish_reason;
                if (parsed.usage) usage = parsed.usage;

                // Mid-stream error: finish_reason is "error"
                if (finishReason === 'error') {
                    clearTimeout(hardTimer);
                    const errData = parsed.error || { message: 'Mid-stream error', code: 500 };
                    const rawErrCode = errData.code ?? errData.status ?? errData.http_status ?? 500;
                    const errCode = (typeof rawErrCode === 'number' && Number.isFinite(rawErrCode)) ? rawErrCode
                        : (Number.isFinite(Number(rawErrCode)) ? Number(rawErrCode) : 500);
                    settle(resolve, { status: errCode, data: { error: errData }, headers: res.headers });
                    res.destroy();
                }
            };

            res.on('data', chunk => {
                sseBuffer += chunk.replace(/\r\n/g, '\n').replace(/\r/g, '\n');

                let boundary;
                while ((boundary = sseBuffer.indexOf('\n\n')) !== -1) {
                    const raw = sseBuffer.slice(0, boundary);
                    sseBuffer = sseBuffer.slice(boundary + 2);
                    if (settled) return;
                    processEvent(raw);
                }
            });

            res.on('end', () => {
                clearTimeout(hardTimer);
                if (!settled) {
                    // Flush any trailing partial event in buffer (missing final \n\n)
                    if (sseBuffer.trim()) processEvent(sseBuffer);
                }
                if (!settled) {
                    // Stream ended without [DONE] — build from accumulated data
                    if (textContent || Object.keys(toolCalls).length > 0) {
                        settle(resolve, { status: 200, data: buildResponse(), headers: res.headers });
                    } else {
                        const err = new Error('Stream ended before [DONE]');
                        err.timeoutSource = 'transport';
                        settle(reject, err);
                    }
                }
            });
        });

        armHardTimeout();
        req.on('error', (err) => { clearTimeout(hardTimer); settle(reject, err); });
        req.setTimeout(timeoutMs, () => {
            req.destroy();
            clearTimeout(hardTimer);
            const err = new Error('Timeout');
            err.timeoutSource = 'transport';
            settle(reject, err);
        });
        if (body) req.write(typeof body === 'string' ? body : JSON.stringify(body));
        req.end();
        } catch (syncErr) {
            if (hardTimer) clearTimeout(hardTimer);
            settle(reject, syncErr);
        }
    });
}

module.exports = {
    httpRequest,
    httpStreamingRequest,
    httpOpenAIStreamingRequest,
    httpChatCompletionsStreamingRequest,
};
