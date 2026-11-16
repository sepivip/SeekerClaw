// SeekerClaw — providers/openai.js
// OpenAI provider adapter. Translates between neutral internal
// message format and OpenAI Responses API format (/v1/responses).
// All OpenAI models route through the Responses API — future-proof
// as OpenAI transitions away from Chat Completions.

const {
    log, OPENAI_OAUTH_TOKEN, OPENAI_OAUTH_REFRESH, OPENAI_AUTH_TYPE,
    OPENAI_OAUTH_FAMILY, OPENAI_OAUTH_EPOCH, OPENAI_OAUTH_RECONNECT_REQUIRED,
} = require('../config');
const { androidBridgeCallWithStatus } = require('../bridge');
const crypto = require('crypto');

// Codex CLI public OAuth client id. Must stay in sync with
// app/src/main/java/com/seekerclaw/app/oauth/OpenAIOAuthActivity.kt:CLIENT_ID
// (the Node side never initiates an OAuth flow — only refreshes — so duplication
// is preferable to plumbing the value through the Android bridge.)
const OAUTH_CLIENT_ID = 'app_EMoamEEZ73f0CkXaXp7hrann';

// ── Neutral ↔ OpenAI Responses API message translation ──────────────────────

/**
 * Convert neutral internal messages to OpenAI Responses API `input` array.
 *
 * Key differences from Chat Completions:
 * - No `messages` array — uses `input` items
 * - Tool calls are top-level `function_call` items (not nested in assistant message)
 * - Tool results are `function_call_output` items (not role:'tool' messages)
 * - Vision uses `input_image` type (not `image_url`)
 */
// BAT-549 Commit 2b: collect OpenAI-stamped reasoning wire items from
// a stored assistant message's reasoningBlocks. These are the FULL
// `output[]` reasoning items as they came back from the Responses API
// (id, summary, encrypted_content, ...) and must be replayed verbatim
// into `input[]` on the next request when the assistant message has
// tool_calls — that's how `store:false` flows preserve reasoning state
// across turns. Returns an array of wire objects suitable for splicing
// at the position where the assistant's items would have been.
//
// Accepts blocks where sourceAdapter === 'openai' OR delegateAdapter ===
// 'openai'. The delegateAdapter case is the Custom-Responses path: the
// Custom adapter re-stamps captured blocks to provider/sourceAdapter
// 'custom' (preserving forensic provenance) and records the underlying
// transport in delegateAdapter. Without that branch, Custom+Responses
// reasoning items would be dropped on tool-use replay even though the
// wire shape is byte-exact OpenAI Responses items — symmetric to how
// openrouter.js accepts both 'openrouter' and delegateAdapter==='openrouter'.
// Other-provider blocks (claude/native-openrouter/custom-via-openrouter)
// pass through silently because neither field matches.
function _collectOpenAIReasoningItems(msg) {
    if (!msg || !Array.isArray(msg.reasoningBlocks)) return [];
    const out = [];
    for (const blk of msg.reasoningBlocks) {
        if (!blk) continue;
        const srcOk = blk.sourceAdapter === 'openai'
            || blk.delegateAdapter === 'openai';
        if (!srcOk) continue;
        if (typeof blk.wire !== 'object' || blk.wire === null || Array.isArray(blk.wire)) continue;
        if (blk.wire.type !== 'reasoning') continue;
        // Minimum viable Responses-API reasoning item shape: must have an
        // `id` (server-assigned identifier; the Responses API rejects
        // replay items without it).
        if (typeof blk.wire.id !== 'string' || blk.wire.id.length === 0) continue;
        out.push(blk.wire);
    }
    return out;
}

function toApiMessages(messages) {
    const input = [];

    for (const msg of messages) {
        if (msg.role === 'tool') {
            // Tool results → function_call_output items
            input.push({
                type: 'function_call_output',
                call_id: msg.toolCallId,
                output: typeof msg.content === 'string' ? msg.content : JSON.stringify(msg.content),
            });
            continue;
        }

        if (msg.role === 'assistant') {
            // BAT-549 Commit 2b: emit reasoning items FIRST in input[]
            // so the Responses API sees them in the original order before
            // the message + function_call items. Echo only on tool-use
            // turns (toolCalls or Claude-native tool_use blocks present)
            // — that's the contract: reasoning replay protects tool-loop
            // continuity, text-only turns are capture-only.
            const hasNeutralToolCalls = Array.isArray(msg.toolCalls) && msg.toolCalls.length > 0;
            const hasClaudeToolUse = Array.isArray(msg.content)
                && msg.content.some((b) => b && b.type === 'tool_use');
            if (hasNeutralToolCalls || hasClaudeToolUse) {
                for (const item of _collectOpenAIReasoningItems(msg)) {
                    input.push(item);
                }
            }

            // Handle Claude-native format: content is array with text/tool_use blocks
            if (Array.isArray(msg.content)) {
                const textParts = msg.content
                    .filter(b => b.type === 'text' && b.text)
                    .map(b => b.text);
                if (textParts.length > 0) {
                    input.push({ role: 'assistant', content: textParts.join('') });
                }
                // Convert Claude-native tool_use blocks → function_call items
                for (const b of msg.content) {
                    if (b.type === 'tool_use') {
                        input.push({
                            type: 'function_call',
                            call_id: b.id,
                            name: b.name,
                            arguments: JSON.stringify(b.input || {}),
                        });
                    }
                }
            } else if (msg.content) {
                // Neutral format: content is a string
                input.push({ role: 'assistant', content: msg.content });
            }
            // Neutral format: tool calls as separate array
            if (msg.toolCalls && msg.toolCalls.length > 0) {
                for (const tc of msg.toolCalls) {
                    input.push({
                        type: 'function_call',
                        call_id: tc.id,
                        name: tc.name,
                        arguments: JSON.stringify(tc.input || {}),
                    });
                }
            }
            continue;
        }

        if (msg.role === 'user') {
            if (typeof msg.content === 'string') {
                input.push({ role: 'user', content: msg.content });
            } else if (Array.isArray(msg.content)) {
                // Handle Claude-native tool_result blocks in user messages
                const toolResults = msg.content.filter(b => b.type === 'tool_result');
                const otherBlocks = msg.content.filter(b => b.type !== 'tool_result');

                // Convert tool_result blocks → function_call_output items
                for (const tr of toolResults) {
                    const output = typeof tr.content === 'string'
                        ? tr.content
                        : Array.isArray(tr.content)
                            ? tr.content.filter(b => b.type === 'text').map(b => b.text).join('')
                            : JSON.stringify(tr.content || '');
                    input.push({
                        type: 'function_call_output',
                        call_id: tr.tool_use_id,
                        output,
                    });
                }

                // Vision or multi-part content (non-tool blocks)
                if (otherBlocks.length > 0) {
                    const parts = otherBlocks.map(block => {
                        if (block.type === 'text') return { type: 'input_text', text: block.text };
                        if (block.type === 'image') {
                            const mediaType = block.source?.media_type || 'image/jpeg';
                            const data = block.source?.data || '';
                            return { type: 'input_image', image_url: `data:${mediaType};base64,${data}` };
                        }
                        if (block.type === 'image_url') {
                            return { type: 'input_image', image_url: block.image_url?.url || '' };
                        }
                        return { type: 'input_text', text: JSON.stringify(block) };
                    });
                    input.push({ role: 'user', content: parts });
                }
            } else {
                input.push({ role: 'user', content: String(msg.content || '') });
            }
        }
    }

    return input;
}

/**
 * Parse OpenAI Responses API response into neutral format.
 * The response comes from `response.completed` SSE event or non-streaming response.
 * Shape: { id, output: [...], status, usage, ... }
 */
function fromApiResponse(raw) {
    // Handle nested response object (from response.completed event)
    const resp = raw.response || raw;

    const textParts = [];
    const reasoningSummaryParts = [];
    const toolCalls = [];
    // BAT-549 Commit 2b: capture FULL reasoning items (id, summary,
    // encrypted_content, …) verbatim into reasoningBlocks for round-trip
    // replay on tool-use turns. Codex v3 finding 1: never re-normalize
    // — store the raw wire item so encrypted_content stays byte-exact
    // and the Responses API accepts the replay.
    const reasoningBlocks = [];
    const turnId = (resp && typeof resp.id === 'string') ? resp.id : null;
    const sourceModel = (resp && typeof resp.model === 'string') ? resp.model : null;

    for (const item of (resp.output || [])) {
        // Text output items (the user-facing answer)
        if (item.type === 'message' && item.content) {
            for (const part of item.content) {
                if (part.type === 'output_text' && part.text) textParts.push(part.text);
            }
        }
        // Reasoning items — Codex/gpt-5.x reasoning models emit these.
        // The `summary` field is the human-readable rollup of the model's thinking.
        // We collect it as a LAST-RESORT fallback if no `message` item is present
        // (the model sometimes returns reasoning-only on terse inputs like "hey").
        if (item.type === 'reasoning' && Array.isArray(item.summary)) {
            for (const part of item.summary) {
                if (part && typeof part.text === 'string' && part.text) {
                    reasoningSummaryParts.push(part.text);
                }
            }
        }
        // BAT-549 Commit 2b: ALSO capture the FULL reasoning item into
        // reasoningBlocks. Independent of the summary-text fallback
        // above (which is for empty-response display only). This is
        // what gets replayed on tool-use round-trips when `store:false`
        // (OAuth/Codex path) — encrypted_content is the only way the
        // Responses API can preserve reasoning across stateless turns.
        if (item && item.type === 'reasoning' && typeof item.id === 'string' && item.id.length > 0) {
            reasoningBlocks.push({
                schemaVersion: 1,
                provider: 'openai',
                sourceAdapter: 'openai',
                sourceModel,
                turnId,
                wire: item, // verbatim; preserves encrypted_content byte-exact
            });
        }
        // Function call output items
        if (item.type === 'function_call') {
            let input = {};
            try {
                input = typeof item.arguments === 'string'
                    ? JSON.parse(item.arguments)
                    : (item.arguments || {});
            } catch (e) {
                log(`[OpenAI] Failed to parse tool arguments for ${item.name}: ${e.message}`, 'WARN');
            }
            toolCalls.push({
                id: item.call_id,
                name: item.name || 'unknown',
                input,
            });
        }
    }

    let text = textParts.length > 0 ? textParts.join('') : null;

    // Diagnostic + fallback: if no message text AND no tool calls, this is the
    // "model produced nothing visible" case that surfaces as SILENT_REPLY upstream.
    // Log the response shape so we can see what actually came back, then try
    // reasoning-summary text as a last resort so the user gets *something*.
    if (text === null && toolCalls.length === 0) {
        const itemTypes = (resp.output || []).map(i => i.type || 'unknown').join(', ') || '(none)';
        const incompleteReason = resp.incomplete_details?.reason || 'none';
        log(`[OpenAI] Empty visible response — output items: [${itemTypes}], status: ${resp.status || 'unknown'}, incomplete_reason: ${incompleteReason}, reasoning_summary_chars: ${reasoningSummaryParts.join('').length}`, 'WARN');
        if (reasoningSummaryParts.length > 0) {
            text = reasoningSummaryParts.join('\n\n');
            log(`[OpenAI] Falling back to reasoning summary (${text.length} chars) since no message item was returned`, 'WARN');
        }
    }

    // Map Responses API status → neutral stopReason
    const status = resp.status || 'completed';
    let stopReason = 'end_turn';
    if (toolCalls.length > 0) {
        stopReason = 'tool_use';
    } else if (status === 'incomplete') {
        const reason = resp.incomplete_details?.reason || '';
        if (reason === 'max_output_tokens') stopReason = 'max_tokens';
        else stopReason = 'max_tokens'; // any incomplete = truncation
    }

    return { text, toolCalls, reasoningBlocks, stopReason, usage: resp.usage || {} };
}

// ── System prompt ───────────────────────────────────────────────────────────

/**
 * Format system prompt for OpenAI Responses API.
 * Returns a plain string — the `instructions` field in the request body.
 * No prompt caching support — combine stable + dynamic.
 */
function formatSystemPrompt(stable, dynamic) {
    return stable + '\n\n' + dynamic;
}

// ── Tool schema formatting ──────────────────────────────────────────────────

/**
 * Format tools for OpenAI Responses API.
 * Responses API uses a FLAT format (name/description/parameters at top level),
 * NOT the nested {function: {name, ...}} format used by Chat Completions.
 */
function formatTools(tools) {
    if (!tools || tools.length === 0) return [];
    return tools.map(tool => ({
        type: 'function',
        name: tool.name,
        description: tool.description || '',
        parameters: tool.input_schema || { type: 'object', properties: {} },
        strict: false, // Responses API defaults to strict:true which requires additionalProperties:false on all schemas
    }));
}

// ── API request building ────────────────────────────────────────────────────

/**
 * Build OpenAI Responses API request body.
 * Uses `instructions` (system prompt) + `input` (messages) instead of
 * Chat Completions' `messages` array.
 *
 * BAT-549 Commit 3c: optional 6th `requestOptions` arg adds the user
 * toggle path. Two reasoning-enabling triggers in order of precedence:
 *  1. Transport-required: OAuth/Codex endpoint OR a `*-codex` model id.
 *     Codex models return `output: []` without `reasoning` — this is
 *     non-negotiable, predates BAT-549, and stays unconditional.
 *  2. User toggle: `reasoningEnabled === true && reasoningSupport === "yes"`
 *     (e.g., gpt-5.4 on api_key path with the toggle on). Adds
 *     `body.reasoning` for non-codex api_key paths that the user opted
 *     into; "no" or "unknown" models stay silent (avoid surprise 400s
 *     or wasted output tokens on models that don't actually reason).
 * Existing call sites that don't pass requestOptions stay on (1) only.
 */
function formatRequest(model, maxTokens, instructions, input, tools, requestOptions) {
    const body = {
        model,
        stream: true,
        instructions: typeof instructions === 'string' ? instructions : (instructions?.content || String(instructions)),
        input,
    };

    // Codex endpoint rejects max_output_tokens — subscription manages limits
    if (!isOAuth) {
        body.max_output_tokens = maxTokens;
    }

    if (tools && tools.length > 0) {
        body.tools = tools;
    }

    // Codex endpoint REQUIRES store: false (returns 400 "Store must be set to
    // false" if omitted). Confirmed via device test on v1.9.0-rc1+. The OpenClaw
    // store:true convention does NOT apply here — that's for api.openai.com only.
    if (isOAuth) {
        body.store = false;
    }

    // Decide whether to enable reasoning. The Codex endpoint serves
    // reasoning models exclusively — every model on
    // chatgpt.com/backend-api/codex (gpt-5.6-sol, gpt-5.6-terra,
    // gpt-5.4, gpt-5.4-mini, etc.) REQUIRES the `reasoning` parameter or
    // it returns `output: []`. The 3c user-toggle branch adds a second
    // path: api_key calls to non-codex reasoning models (e.g., raw
    // gpt-5.4) when the user has explicitly toggled reasoning on AND
    // the registry confirms support.
    //
    // BAT-558 v4 R3 — `reasoningMode: 'off'` (heartbeats / future
    // synthetic turns) suppresses the OPTIONAL user-toggle path so
    // app-controlled reasoning isn't requested for liveness probes.
    // The TRANSPORT-required paths (OAuth/Codex endpoint OR a `*-codex`
    // model id) MUST remain unconditional — the Codex endpoint returns
    // `output: []` without `reasoning`, breaking Codex/OAuth users
    // entirely. Pinned exception per BAT-485 (the original Codex OAuth
    // contract); v4 R3 explicitly preserves it.
    const reasoningOff = !!(requestOptions && requestOptions.reasoningMode === 'off');
    const userToggleEnabled = !reasoningOff && !!(requestOptions
        && requestOptions.reasoningEnabled === true
        && requestOptions.reasoningSupport === 'yes');
    const wantReasoning = isOAuth
        || (model && model.includes('codex'))
        || userToggleEnabled;
    if (wantReasoning) {
        body.reasoning = { effort: 'medium', summary: 'auto' };
        // BAT-549 Commit 2b: stateless `store:false` flows (OAuth/Codex)
        // need `include:["reasoning.encrypted_content"]` to get the
        // encrypted reasoning item back in the response — that's the
        // only artifact the Responses API can replay across turns
        // when state isn't persisted server-side. Without this,
        // reasoningBlocks captured from a prior turn are useful only
        // for forensics; with it, they round-trip cleanly on tool-use
        // continuations. v4.1 contract + Codex sign-off watch-note 3
        // (don't regress existing reasoning hardcode) — this is
        // additive: same `reasoning` enablement, plus encrypted echo
        // capability.
        //
        // The api_key path with `store:true` (Responses default) ALSO
        // benefits from `include` so the API returns reasoning items
        // we can capture; without it, the openai.js capture path in
        // fromApiResponse only sees a redacted reference. Including it
        // for both transport modes keeps capture symmetric.
        body.include = ['reasoning.encrypted_content'];
    }

    return JSON.stringify(body);
}

// ── Connection details ──────────────────────────────────────────────────────

const isOAuth = OPENAI_AUTH_TYPE === 'oauth';
const CODEX_API_HOST = 'chatgpt.com';
const CODEX_API_PATH = '/backend-api/codex/responses';

const endpoint = {
    hostname: isOAuth ? CODEX_API_HOST : 'api.openai.com',
    path: isOAuth ? CODEX_API_PATH : '/v1/responses',
};

// ── OAuth credential state (BAT-1157) ───────────────────────────────────────
// One object, replaced whole on adoption, so a request never mixes an access token from one
// rotation with the refresh token, epoch or family of another. `confirmed`: this process has
// proven, through the bridge, that the token store durably holds this family (confirm-family, or a
// 200 to our own save). An upstream refresh is only ever sent for a confirmed credential.
let _cred = {
    access: OPENAI_OAUTH_TOKEN,
    refresh: OPENAI_OAUTH_REFRESH,
    epoch: OPENAI_OAUTH_EPOCH,
    familyId: OPENAI_OAUTH_FAMILY,
    confirmed: false,
};
// Incremented whenever a new pair is adopted. ai.js records it with each request's headers and
// hands it back on a 401 (handleUnauthorized(usedGen)).
let _gen = 0;
// 'ok' | 'latched' (the sign-in changed elsewhere: restart) | 'reconnect' (no usable sign-in).
let _authState = OPENAI_OAUTH_RECONNECT_REQUIRED ? 'reconnect' : 'ok';
// When a recovery last failed on storage (confirm-family not confirmed). classifyError shows the
// storage message for a 401 within STORAGE_FAILURE_WINDOW_MS of it; a new recovery clears it. A
// time window, not a flag cleared per request, so a concurrent request cannot erase it before the
// failing request's own message is chosen.
let _storageFailureAt = 0;
const STORAGE_FAILURE_WINDOW_MS = 15000;
// A save the bridge has not acknowledged: { familyId, expectedEpoch, rotationId, ... }.
let _pendingSave = null;
let _saveRetryTimer = null;
let _saveRetryAttempt = 0;
// Set by shutdownOAuthTimers (SIGTERM): a save still awaiting the bridge must not re-arm a retry.
let _shutDown = false;
let _recoverInFlight = null;

const SAVE_RETRY_DELAYS_MS = [2000, 10000, 60000];
const SAVE_RETRY_STEADY_MS = 5 * 60 * 1000;

const MSG_LATCHED = '🔐 Your ChatGPT sign-in changed. Restart the agent.';
const MSG_RECONNECT = '🔐 Reconnect OpenAI in Settings.';
const MSG_SAVE_PENDING = '⏳ Saving your refreshed sign-in. Try again in a moment.';
const MSG_STORAGE = '⚠️ Couldn\'t save your ChatGPT sign-in on this device. Try again in a moment; if this keeps happening, reconnect OpenAI in Settings.';

function currentRefreshGeneration() {
    return _gen;
}

function buildHeaders(apiKey) {
    const token = isOAuth ? _cred.access : apiKey;
    const headers = {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${token}`,
    };
    // Codex backend needs Accept header for SSE streaming
    if (isOAuth) {
        headers['Accept'] = 'text/event-stream';
    }
    return headers;
}

// ── Streaming ───────────────────────────────────────────────────────────────
// Responses API uses typed SSE events:
//   event: response.output_text.delta         → text chunks
//   event: response.function_call_arguments.delta → tool arg chunks
//   event: response.completed                 → final full response
//   event: response.incomplete                → truncated response

const streamProtocol = 'openai-responses';

// ── Error classification ────────────────────────────────────────────────────

function classifyError(status, data) {
    if (status === 401 || status === 403) {
        // BAT-1157: a sign-in that cannot recover by a refresh says why, as a non-retryable
        // 'reauth' — the message the user sees (ai.js classifies again after the retry loop).
        if (isOAuth && status === 401) {
            if (_authState === 'latched') return { type: 'reauth', retryable: false, userMessage: MSG_LATCHED };
            if (_authState === 'reconnect') return { type: 'reauth', retryable: false, userMessage: MSG_RECONNECT };
            // Transient states are NOT 'reauth' (that type drives ai.js's autonomous reconnect notice).
            if (_pendingSave) return { type: 'storage', retryable: false, userMessage: MSG_SAVE_PENDING };
            if (_storageFailureAt && Date.now() - _storageFailureAt < STORAGE_FAILURE_WINDOW_MS) {
                return { type: 'storage', retryable: false, userMessage: MSG_STORAGE };
            }
        }
        // OAuth 401s may be retryable after token refresh — caller must call handleUnauthorized()
        return {
            type: 'auth', retryable: isOAuth && status === 401 && !!_cred.refresh,
            userMessage: isOAuth
                ? '🔐 Can\'t reach the AI — your OpenAI sign-in may have expired. Please reconnect OpenAI in Settings and try again.'
                : '🔑 Can\'t reach the AI — OpenAI API key might be wrong. Check Settings?'
        };
    }
    if (status === 402) {
        return {
            type: 'billing', retryable: false,
            userMessage: 'Your OpenAI account needs attention — check billing at platform.openai.com'
        };
    }
    if (status === 429) {
        const msg = data?.error?.message || '';
        if (/quota|insufficient_quota/i.test(msg)) {
            return {
                type: 'quota', retryable: false,
                userMessage: 'OpenAI quota exceeded. Check your billing at platform.openai.com'
            };
        }
        return {
            type: 'rate_limit', retryable: true,
            userMessage: '⏳ Got rate limited. Trying again in a moment...'
        };
    }
    if (status >= 500 && status < 600) {
        return {
            type: 'server', retryable: true,
            userMessage: 'OpenAI API is temporarily unavailable. Retrying...'
        };
    }
    const rawReason = data?.error?.message || '';
    const reason = rawReason.replace(/[*_`\[\]()~>#+\-=|{}.!]/g, '').slice(0, 200);
    return {
        type: 'unknown', retryable: false,
        userMessage: reason.trim()
            ? `API error (${status}): ${reason.trim()}`
            : `Unexpected API error (${status}). Please try again.`
    };
}

/**
 * BAT-1157 (D15): called before every authenticated send (ai.js claudeApiCall, the context
 * summarizer, and after a recovery). Returns the 'reauth' error class when the sign-in is latched
 * or reconnect-required — the request is then never sent — else null.
 */
function preflightAuth() {
    if (!isOAuth) return null;
    if (_authState === 'latched') return { type: 'reauth', retryable: false, userMessage: MSG_LATCHED };
    if (_authState === 'reconnect') return { type: 'reauth', retryable: false, userMessage: MSG_RECONNECT };
    return null;
}

function _retryable(message) {
    const e = new Error(message);
    e.retryable = true;
    return e;
}

function _fatal(message) {
    const e = new Error(message);
    e.retryable = false;
    return e;
}

/** Drops this session's tokens and stops all OAuth sends until restart (a 409 from the store). */
function _latch(why) {
    _cred = { access: '', refresh: '', epoch: _cred.epoch, familyId: _cred.familyId, confirmed: false };
    _authState = 'latched';
    _clearSaveRetry();
    _pendingSave = null;
    log(`[OpenAI] OAuth token save rejected (sign-in changed) — dropped this session's tokens (${why})`, 'WARN');
}

/**
 * Handle an OAuth 401 (BAT-1157, contract v2–v4 + Codex sign-off).
 * - [usedGen] is the credential generation the failing request was sent with. If a newer pair has
 *   been adopted since (a delayed 401), retry on it — no refresh.
 * - Otherwise ONE recovery, single-flight across concurrent 401s: confirm the family with the
 *   bridge (a decoded familyId proves nothing), then one upstream refresh, then the save.
 * - No refresh while a save is unacknowledged, after a 409 latch, or when reconnect is required.
 * Signals a retry by THROWING { retryable:true } (ai.js contract), a stop with { retryable:false }.
 */
async function handleUnauthorized(usedGen) {
    if (!isOAuth) return;
    const base = (typeof usedGen === 'number') ? usedGen : _gen;
    if (base < _gen && _authState === 'ok') throw _retryable('OAuth credential already rotated — retry');
    if (!_recoverInFlight) {
        if (_authState !== 'ok') throw _fatal('OAuth sign-in needs attention');
        if (_pendingSave) throw _fatal('OAuth refreshed sign-in not saved yet');
        if (!_cred.refresh) throw _fatal('No OAuth refresh token');
        _storageFailureAt = 0; // a fresh attempt
        _recoverInFlight = _recover().finally(() => { _recoverInFlight = null; });
    }
    try {
        await _recoverInFlight;
    } catch (e) {
        log('[OpenAI] OAuth refresh failed: ' + e.message, 'ERROR');
        throw _fatal('OAuth token refresh failed: ' + e.message);
    }
    if (_authState === 'ok' && _gen > base) {
        log('[OpenAI] Token refreshed — caller should retry', 'INFO');
        throw _retryable('OAuth token refreshed — retry');
    }
    throw _fatal('OAuth refresh did not complete');
}

/** Confirm (once per process) then refresh. Sets the state; throws only on an upstream failure. */
async function _recover() {
    if (!_cred.confirmed) {
        const ok = await _confirmFamily();
        if (!ok) return;
    }
    log('[OpenAI] OAuth 401 — attempting token refresh...', 'INFO');
    await refreshOAuthToken();
}

function _fingerprint(secret) {
    // The canonical form Kotlin hashes too: normalizeSecret already applied in config.js.
    return crypto.createHash('sha256').update(String(secret), 'utf8').digest('hex');
}

/**
 * POST /openai/oauth/confirm-family. Only an EXACT 200 — echoing the requested family and epoch, or
 * for a legacy (null-family) request a well-formed family and epoch ≥ 1 — confirms. A 409 latches
 * or requires a reconnect; anything else (429, timeout, unparseable, a wrong 200) is a storage
 * failure: no refresh this time.
 */
async function _confirmFamily() {
    const req = {
        familyId: _cred.familyId || null,
        epoch: _cred.familyId ? _cred.epoch : 0,
        refreshFingerprint: _fingerprint(_cred.refresh),
    };
    const r = await androidBridgeCallWithStatus('/openai/oauth/confirm-family', req);
    const b = r.body;
    if (r.status === 200 && b && b.success === true) {
        const fam = typeof b.familyId === 'string' ? b.familyId : '';
        const ep = Number(b.epoch);
        const exact = req.familyId
            ? (fam === req.familyId && ep === req.epoch)
            : (fam.length > 0 && Number.isInteger(ep) && ep >= 1);
        if (exact) {
            _cred = { ..._cred, familyId: fam, epoch: ep, confirmed: true };
            return true;
        }
    } else if (r.status === 409 && b && b.code === 'OPENAI_OAUTH_RECONNECT') {
        _cred = { access: '', refresh: '', epoch: _cred.epoch, familyId: _cred.familyId, confirmed: false };
        _authState = 'reconnect';
        log('[OpenAI] Sign-in no longer usable on this device — reconnect required', 'WARN');
        return false;
    } else if (r.status === 409 && b && b.code === 'OPENAI_OAUTH_FAMILY_CHANGED') {
        _latch('family changed');
        return false;
    }
    _storageFailureAt = Date.now();
    log(`[OpenAI] Sign-in not confirmed on this device (status=${r.status === null ? 'none' : r.status}) — no refresh`, 'WARN');
    return false;
}

/** Send one save; returns 'ok' | 'conflict' | 'pending'. Never sends an upstream refresh. */
async function _sendSave(save) {
    const r = await androidBridgeCallWithStatus('/openai/oauth/save-tokens', save);
    const b = r.body;
    if (r.status === 200 && b && b.success === true && Number(b.epoch) === save.expectedEpoch + 1) {
        _cred = { ..._cred, epoch: Number(b.epoch), confirmed: true };
        _pendingSave = null;
        _clearSaveRetry();
        return 'ok';
    }
    if (r.status === 409) {
        _latch('epoch conflict');
        return 'conflict';
    }
    return 'pending';
}

function _clearSaveRetry() {
    if (_saveRetryTimer) clearTimeout(_saveRetryTimer);
    _saveRetryTimer = null;
    _saveRetryAttempt = 0;
}

/** Single-flight re-send of the SAME save (same rotationId), with backoff. */
function _scheduleSaveRetry() {
    if (_shutDown || _saveRetryTimer || !_pendingSave) return;
    const delay = _saveRetryAttempt < SAVE_RETRY_DELAYS_MS.length
        ? SAVE_RETRY_DELAYS_MS[_saveRetryAttempt]
        : SAVE_RETRY_STEADY_MS;
    _saveRetryAttempt++;
    _saveRetryTimer = setTimeout(async () => {
        _saveRetryTimer = null;
        const save = _pendingSave;
        if (!save) return;
        try {
            const outcome = await _sendSave(save);
            if (outcome === 'pending') _scheduleSaveRetry();
            else if (outcome === 'ok') log('[OpenAI] Refreshed sign-in saved', 'INFO');
        } catch (e) {
            log('[OpenAI] Save retry failed: ' + e.message, 'WARN');
            _scheduleSaveRetry();
        }
    }, delay);
    if (_saveRetryTimer && typeof _saveRetryTimer.unref === 'function') _saveRetryTimer.unref();
}

/**
 * BAT-1157: true while a refreshed pair is only in memory (its save not yet acknowledged). ai.js
 * reports health 'degraded' meanwhile — a restart now would leave only the spent pair on disk.
 */
function isPersistPending() {
    return !!_pendingSave;
}

/** BAT-1157: stop the save-retry timer (SIGTERM). */
function shutdownOAuthTimers() {
    _shutDown = true; // before clearing: an in-flight save's reply must not schedule a new timer
    _clearSaveRetry();
}

function classifyNetworkError(err) {
    const raw = err.message || String(err);
    if (err.timeoutSource === 'transport' || /timeout/i.test(raw)) {
        return { type: 'timeout', userMessage: 'The AI took too long to respond. Please try again.' };
    }
    if (/ENOTFOUND|EAI_AGAIN/i.test(raw)) {
        return { type: 'dns', userMessage: 'Cannot reach OpenAI — check your internet connection.' };
    }
    if (/ECONNREFUSED|ECONNRESET|EPIPE/i.test(raw)) {
        return { type: 'connection', userMessage: 'Connection to OpenAI was lost. Please try again.' };
    }
    return { type: 'network', userMessage: 'A network error occurred. Please try again.' };
}

// ── Rate limit headers ──────────────────────────────────────────────────────

function parseRateLimitHeaders(headers) {
    if (!headers) return { tokensRemaining: Infinity, tokensReset: '' };
    const remaining = parseInt(headers['x-ratelimit-remaining-tokens'], 10);
    const resetStr = headers['x-ratelimit-reset-tokens'] || '';
    let tokensReset = '';
    if (resetStr) {
        let ms = 0;
        const secMatch = resetStr.match(/([\d.]+)s/);
        const msMatch = resetStr.match(/([\d.]+)ms/);
        if (secMatch) ms += parseFloat(secMatch[1]) * 1000;
        if (msMatch) ms += parseFloat(msMatch[1]);
        if (ms > 0) tokensReset = new Date(Date.now() + ms).toISOString();
    }
    return {
        tokensRemaining: Number.isFinite(remaining) ? remaining : Infinity,
        tokensReset,
        requests: {
            limit: parseInt(headers['x-ratelimit-limit-requests']) || 0,
            remaining: parseInt(headers['x-ratelimit-remaining-requests']) || 0,
            reset: headers['x-ratelimit-reset-requests'] || '',
        },
        tokens: {
            limit: parseInt(headers['x-ratelimit-limit-tokens']) || 0,
            remaining: parseInt(headers['x-ratelimit-remaining-tokens']) || 0,
            reset: resetStr,
        },
    };
}

// ── Usage normalization ─────────────────────────────────────────────────────

function normalizeUsage(usage) {
    if (!usage) return { inputTokens: 0, outputTokens: 0, cacheRead: 0, cacheWrite: 0 };
    return {
        // Responses API: input_tokens/output_tokens
        inputTokens: usage.input_tokens || usage.prompt_tokens || 0,
        outputTokens: usage.output_tokens || usage.completion_tokens || 0,
        cacheRead: usage.input_tokens_details?.cached_tokens || usage.prompt_tokens_details?.cached_tokens || 0,
        cacheWrite: 0,
    };
}

// ── Vision ──────────────────────────────────────────────────────────────────

function formatVision(base64, mediaType) {
    return {
        type: 'image_url',
        image_url: {
            url: `data:${mediaType || 'image/jpeg'};base64,${base64}`,
        },
    };
}

// ── Connection test ─────────────────────────────────────────────────────────

const testEndpoint = { hostname: 'api.openai.com', path: '/v1/models', method: 'GET' };

// ── OAuth token refresh ─────────────────────────────────────────────────────

/**
 * One upstream refresh for a CONFIRMED credential (BAT-1157). The new pair is adopted in memory at
 * once — the old refresh token is now spent, so it is the only valid pair — and then saved with an
 * exact-status check. 200: the epoch advances. 409: the pair is dropped and OAuth latches off.
 * Anything else: the pair is kept, the save is re-sent (same rotationId) with backoff, and no other
 * refresh is sent until it is acknowledged.
 */
async function refreshOAuthToken() {
    if (!_cred.confirmed) throw new Error('refresh requested for an unconfirmed credential');
    const https = require('https');
    const body = new URLSearchParams({
        grant_type: 'refresh_token',
        client_id: OAUTH_CLIENT_ID,
        refresh_token: _cred.refresh,
    }).toString();

    const parsed = await new Promise((resolve, reject) => {
        const req = https.request({
            hostname: 'auth.openai.com',
            path: '/oauth/token',
            method: 'POST',
            headers: {
                'Content-Type': 'application/x-www-form-urlencoded',
                'Content-Length': Buffer.byteLength(body),
            },
            timeout: 15000,
        }, (res) => {
            let data = '';
            res.on('data', chunk => data += chunk);
            res.on('end', () => {
                const status = res.statusCode || 0;
                let json = null;
                try { json = JSON.parse(data); } catch (_) { /* non-JSON body */ }
                if (json && json.access_token) {
                    resolve(json);
                    return;
                }
                if (json) {
                    // JSON error response — surface error_description/error verbatim.
                    reject(new Error(`Token refresh failed (HTTP ${status}): ${json.error_description || json.error || 'unknown'}`));
                } else {
                    // Non-JSON body (HTML/empty/5xx page). Truncate to avoid log spam and
                    // never include credentials — refresh request body is not echoed back.
                    const truncated = (data || '').slice(0, 200).replace(/\s+/g, ' ');
                    reject(new Error(`Token refresh failed (HTTP ${status}): non-JSON response: ${truncated}`));
                }
            });
        });
        req.on('error', reject);
        req.on('timeout', () => { req.destroy(); reject(new Error('Refresh timeout')); });
        req.write(body);
        req.end();
    });

    const newRefresh = typeof parsed.refresh_token === 'string' ? parsed.refresh_token : '';
    const save = {
        familyId: _cred.familyId,
        expectedEpoch: _cred.epoch,
        rotationId: crypto.randomUUID(),
        accessToken: parsed.access_token,
        refreshToken: newRefresh,
        expiresAt: new Date(Date.now() + (parsed.expires_in || 28800) * 1000).toISOString(),
    };
    _cred = {
        access: parsed.access_token,
        refresh: newRefresh || _cred.refresh,
        epoch: _cred.epoch,
        familyId: _cred.familyId,
        confirmed: true,
    };
    _gen++;
    _pendingSave = save;
    const outcome = await _sendSave(save);
    if (outcome === 'pending') {
        log('[OpenAI] Failed to persist refreshed tokens — retrying the save, no new refresh until it lands', 'WARN');
        _scheduleSaveRetry();
    }
    return true;
}

// ── Export adapter ──────────────────────────────────────────────────────────

module.exports = {
    id: 'openai',
    name: 'OpenAI',

    // Connection
    endpoint,
    testEndpoint,
    buildHeaders,
    streamProtocol,

    // Message translation
    toApiMessages,
    fromApiResponse,
    formatSystemPrompt,
    formatTools,
    formatRequest,
    formatVision,

    // Error & usage
    classifyError,
    classifyNetworkError,
    handleUnauthorized,
    normalizeUsage,
    parseRateLimitHeaders,

    // OAuth
    refreshOAuthToken,
    isOAuth,
    preflightAuth,
    currentRefreshGeneration,
    shutdownOAuthTimers,
    isPersistPending,

    // Capabilities
    supportsCache: false,
    authTypes: ['api_key', 'oauth'],
};
