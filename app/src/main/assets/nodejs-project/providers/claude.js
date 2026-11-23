// SeekerClaw — providers/claude.js
// Claude (Anthropic) provider adapter. Translates between neutral internal
// message format and Claude Messages API format.

const { log } = require('../config');
const { logSuppression, SUPPRESSION_REASONS } = require('../reasoning-gating');

// BAT-1033 — Claude adaptive thinking.
//
// Anthropic REMOVED extended thinking (`thinking.type:'enabled'` +
// `budget_tokens`) from the current models. fable-5, opus-4-8, opus-4-7,
// and sonnet-5 reject it with HTTP 400 ("thinking.type.enabled is not
// supported for this model. Use thinking.type.adaptive"); only the older
// opus-4-6 / sonnet-4-6 still accept it. `thinking.type:'adaptive'` (the
// model auto-sizes its own budget — no `budget_tokens`) is accepted by
// EVERY reasoning model, so we send it uniformly.
//
// This also retires the BAT-558 budget clamp: with no `budget_tokens`
// there is no `budget_tokens < max_tokens` constraint to satisfy, which
// removes that entire 400 class (the reason BAT-558 existed).
//
// Verified live on the RAW api-key path (tests/live/anthropic/test-thinking-matrix.js):
//   extended → fable-5/opus-4-8/opus-4-7/sonnet-5: 400 removed; opus-4-6/sonnet-4-6: 200
//   adaptive → all six: 200
// The 400 only surfaced for users on their own API key — setup_token's
// `cc_version` billing lane still tolerated the deprecated extended shape.
//
// MIN_THINKING_TURN is retained purely as a UX guard: on a sub-2048
// max_tokens turn, reasoning would eat most of the answer budget, so we
// skip it. It is no longer an API constraint (adaptive has no budget floor).
const MIN_THINKING_TURN = 2048;

// BAT-1664 — preserved thinking. A thinking block's signature is bound to
// the exact request prefix (system + tools + every earlier message) that
// produced it, and to the model. Newer models (claude-fable-5-1 for accounts
// created on/after 2026-08-31, and later) ENFORCE that binding: replaying a
// block whose prefix changed is a 400 `Invalid \`signature\` in \`thinking\`
// block`. Three defences live in this adapter:
//
//   C1 — current-turn-only replay. Only assistant messages AFTER this turn's
//        anchor (the user message that started the turn, passed by identity
//        as `requestOptions.turnAnchor`) may carry thinking. Everything before
//        the anchor is emitted with thinking stripped (both `reasoningBlocks`
//        and legacy Anthropic-array content). No anchor / no requestOptions
//        (vision, summaries) → no thinking at all. Never a role scan: the
//        mid-turn `[System]` loop-warn messages are role 'user'.
//   Verbatim — in-turn assistant messages are replayed from the content
//        array exactly as received (`claudeWireContent`, captured in
//        fromApiResponse as `wireContent`), not rebuilt from the neutral
//        form (which joins text blocks and reorders thinking to the front).
//        A missing/invalidated snapshot strips thinking from that message
//        and every later one in the turn.
//   C2 — `thinking.block_binding.prefix_mismatch_behavior: 'drop_block'` on
//        registry-flagged models (`thinkingBinding: true`), so a residual
//        prefix edit drops the block instead of failing the request. Needs
//        the THINKING_BINDING_BETA header; ai.js sends header and field
//        together from one `bind` decision.
const THINKING_BINDING_BETA = 'thinking-binding-controls-2026-08-01';

// ── Wire snapshot (verbatim in-turn replay) ─────────────────────────────────
//
// The snapshot lives on the neutral assistant message as a NON-enumerable
// property so it can never reach a checkpoint, a conversation dump or any
// `{...msg}` clone: JSON.stringify and object spread both skip it. It is
// in-memory only and meaningful only for the turn that produced it.
const WIRE_SNAPSHOT_KEY = 'claudeWireContent';

// Per-conversation invalidation epoch. invalidateWireSnapshot(msg, messages)
// bumps it so chat() can turn on stripAllThinking for the rest of the turn
// (the edit changed a prefix later signatures are bound to). WeakMap keyed by
// the live messages array — no cross-chat leakage, no retention.
const _wireEditEpochs = new WeakMap();

function setWireSnapshot(msg, wireContent) {
    if (!msg || typeof msg !== 'object' || !Array.isArray(wireContent)) return;
    let copy;
    try { copy = JSON.parse(JSON.stringify(wireContent)); } catch (_) { return; }
    Object.defineProperty(msg, WIRE_SNAPSHOT_KEY, {
        value: copy, enumerable: false, writable: true, configurable: true,
    });
}

function getWireSnapshot(msg) {
    if (!msg || typeof msg !== 'object') return null;
    const snap = msg[WIRE_SNAPSHOT_KEY];
    return Array.isArray(snap) ? snap : null;
}

// THE single mutation gate for a neutral assistant message's toolCalls /
// content (BAT-1664 decision 7). Every edit site calls this BEFORE editing:
// it drops the verbatim snapshot (it no longer matches the message) and
// bumps the conversation's epoch so the rest of the turn strips thinking.
// Pass `toolCalls` to have the helper perform the assignment itself — the
// source guard test pins that no other `.toolCalls =` assignment exists.
function invalidateWireSnapshot(msg, messages, toolCalls) {
    if (!msg || typeof msg !== 'object') return;
    if (Object.prototype.hasOwnProperty.call(msg, WIRE_SNAPSHOT_KEY)) delete msg[WIRE_SNAPSHOT_KEY];
    if (Array.isArray(messages)) _wireEditEpochs.set(messages, (_wireEditEpochs.get(messages) || 0) + 1);
    if (Array.isArray(toolCalls)) msg.toolCalls = toolCalls;
}

// BAT-1664 C0: a structural history edit that does not touch an assistant
// message's own content (a splice of an orphan tool result, a summary splice,
// a trim, a recovery truncation) still changes the prefix every later thinking
// signature is bound to. Bump the epoch so chat() strips thinking for the rest
// of the turn.
function noteHistoryEdit(messages) {
    if (Array.isArray(messages)) _wireEditEpochs.set(messages, (_wireEditEpochs.get(messages) || 0) + 1);
}

function wireEditEpoch(messages) {
    return Array.isArray(messages) ? (_wireEditEpochs.get(messages) || 0) : 0;
}

function _isThinkingBlock(b) {
    return !!b && (b.type === 'thinking' || b.type === 'redacted_thinking');
}

// The capture validity rule (BAT-1033), applied in fromApiResponse to both
// `reasoningBlocks` and the verbatim `wireContent` snapshot: a `thinking`
// block needs a string `thinking` + a NON-EMPTY string `signature`;
// `redacted_thinking` needs a string `data`. Non-thinking blocks pass.
//
// The signature — not the thinking text — is what Anthropic validates. A
// thinking block with an empty/whitespace signature is rejected with 400
// "each thinking block must contain thinking" (the message is misleading); an
// empty-TEXT block WITH a valid signature is accepted (and is the default on
// display:"omitted" models). Pre-fix builds streamed thinking blocks with an
// empty signature (http.js dropped signature_delta). Key on the signature,
// never on the text.
function _isValidWireBlock(c) {
    if (!c || typeof c !== 'object') return false;
    if (c.type === 'thinking') {
        return typeof c.thinking === 'string'
            && typeof c.signature === 'string' && c.signature.trim() !== '';
    }
    if (c.type === 'redacted_thinking') return typeof c.data === 'string';
    return true;
}

// Does an emitted (Anthropic-format) messages array carry any thinking
// block? Drives the C2 `bind` decision: binding is only sent when there is
// something to bind.
function messagesHaveThinking(apiMessages) {
    if (!Array.isArray(apiMessages)) return false;
    for (const m of apiMessages) {
        if (!m || m.role !== 'assistant' || !Array.isArray(m.content)) continue;
        if (m.content.some(_isThinkingBlock)) return true;
    }
    return false;
}

// ── Neutral ↔ Claude message translation ────────────────────────────────────

// Normalized assistant emission: text + tool_use, NO thinking. Used for every
// assistant message that is not replayed verbatim (BAT-1664). The neutral form
// cannot reproduce the received content array (it joins text blocks and would
// have to reorder thinking to the front), so a thinking block replayed from
// `reasoningBlocks` would fail the signature's prefix binding on enforcing
// models. `reasoningBlocks` stays captured (history, diagnostics) but is never
// replayed by this adapter.
function _normalizedAssistant(msg) {
    const hasToolCalls = Array.isArray(msg.toolCalls) && msg.toolCalls.length > 0;
    const content = [];
    if (msg.content) {
        content.push({ type: 'text', text: msg.content });
    }
    if (hasToolCalls) {
        for (const tc of msg.toolCalls) {
            content.push({
                type: 'tool_use',
                id: tc.id,
                name: tc.name,
                input: tc.input,
            });
        }
    }
    return { role: 'assistant', content: content.length > 0 ? content : [{ type: 'text', text: '' }] };
}

/**
 * Convert neutral internal messages to Claude API messages format.
 *
 * Neutral:
 *   { role:'user', content:'text' }
 *   { role:'assistant', content:'text', toolCalls:[{id,name,input}] }
 *   { role:'tool', toolCallId:'tc_1', content:'...' }
 *
 * Claude:
 *   { role:'user', content:[{type:'text', text:'...'}] }
 *   { role:'assistant', content:[{type:'text',text:'...'},{type:'tool_use',id,name,input}] }
 *   { role:'user', content:[{type:'tool_result', tool_use_id, content}] }
 *
 * BAT-1664: `requestOptions` (3rd arg) drives thinking replay.
 *   - `turnAnchor`: identity of THIS turn's user message. Only assistant
 *     messages after it may carry thinking (C1). Absent/not found → none.
 *   - `stripAllThinking`: turn-sticky; strips every thinking block (set
 *     after a signature 400, a binding rejection, a wire-snapshot
 *     invalidation, and — slice B — the emergency history edits).
 * Stored history is never mutated: every filter here builds new arrays.
 */
function toApiMessages(messages, _model, requestOptions) {
    const out = [];
    let pendingToolResults = [];
    const anchor = (requestOptions && requestOptions.turnAnchor) || null;
    const anchorIdx = anchor ? messages.indexOf(anchor) : -1;
    // Once set, every LATER assistant message in this emission is stripped too
    // (a signature binds the whole prefix, so a gap invalidates what follows).
    let stripRest = anchorIdx < 0 || !!(requestOptions && requestOptions.stripAllThinking === true);

    for (let i = 0; i < messages.length; i++) {
        const msg = messages[i];

        if (msg.role === 'tool') {
            // Accumulate tool results — they'll be grouped into a single user message
            pendingToolResults.push({
                type: 'tool_result',
                tool_use_id: msg.toolCallId,
                content: typeof msg.content === 'string' ? msg.content : JSON.stringify(msg.content),
            });
            // Flush if next message is not a tool result
            const next = messages[i + 1];
            if (!next || next.role !== 'tool') {
                out.push({ role: 'user', content: pendingToolResults });
                pendingToolResults = [];
            }
            continue;
        }

        // Flush any pending tool results before non-tool messages
        if (pendingToolResults.length > 0) {
            out.push({ role: 'user', content: pendingToolResults });
            pendingToolResults = [];
        }

        if (msg.role === 'assistant') {
            const inTurn = anchorIdx >= 0 && i > anchorIdx;
            // Legacy Claude-native array (old checkpoint). It never has a wire
            // snapshot, so it can never be replayed with thinking: strip its
            // thinking/redacted_thinking blocks (new array — stored content is
            // untouched). Inside the turn it also counts as a missing snapshot.
            if (Array.isArray(msg.content)) {
                if (inTurn) stripRest = true;
                const kept = msg.content.filter(b => !_isThinkingBlock(b));
                out.push({ role: 'assistant', content: kept.length > 0 ? kept : [{ type: 'text', text: '' }] });
                continue;
            }
            // Verbatim in-turn replay: the content array exactly as received
            // (order, multi-text, interleaved thinking). Only while nothing
            // earlier in the turn forced stripping.
            if (inTurn && !stripRest) {
                const snap = getWireSnapshot(msg);
                if (snap) {
                    out.push({ role: 'assistant', content: snap.slice() });
                    continue;
                }
                // Missing / invalidated snapshot: this message AND every later
                // one go out without thinking.
                stripRest = true;
            }
            out.push(_normalizedAssistant(msg));
        } else if (msg.role === 'user') {
            // User message — can be string or array of content blocks (vision)
            if (typeof msg.content === 'string') {
                out.push({ role: 'user', content: msg.content });
            } else if (Array.isArray(msg.content)) {
                out.push({ role: 'user', content: msg.content });
            } else {
                out.push({ role: 'user', content: String(msg.content || '') });
            }
        }
    }

    // Flush trailing tool results
    if (pendingToolResults.length > 0) {
        out.push({ role: 'user', content: pendingToolResults });
    }

    return out;
}

/**
 * Parse Claude API response into neutral format.
 * @param {object} raw - Raw Claude response (data field from httpStreamingRequest)
 * @returns {{ text, toolCalls, reasoningBlocks, stopReason, usage, refusal }}
 *
 * BAT-1705: `refusal` is null, or { kind: 'model_refusal' | 'provider_content_filter',
 * category: string|null (raw; ai.js allowlists it before logging), modelMessage: string|null,
 * partialChars, droppedToolCalls }. When set, text is null and toolCalls / reasoningBlocks /
 * wireContent are empty — a refused response is never shown, executed or replayed.
 *
 * BAT-549 Commit 2: also captures `thinking` and `redacted_thinking`
 * content blocks verbatim into `reasoningBlocks[]` (raw wire payloads,
 * never re-normalized — Codex v3 finding 1). Required for tool-use
 * loops with extended thinking enabled: Anthropic server-validates
 * the `signature` field on every echoed block, so we MUST preserve
 * them byte-exact + in original order.
 *
 * BAT-1664: also returns
 *   - `wireContent`: the content array AS RECEIVED (order, multi-text,
 *     interleaved thinking), each block through the same validity check as
 *     reasoningBlocks. ai.js stores a deep copy as the non-enumerable
 *     `claudeWireContent` snapshot; toApiMessages replays it verbatim for
 *     in-turn messages. `reasoningBlocks` is no longer replayed.
 *   - `inputTransformations`: the response's top-level
 *     `input_transformations` array (present only when the
 *     thinking-binding beta was sent), or null.
 */
function fromApiResponse(raw) {
    const content = raw.content || [];
    const textParts = content.filter(c => c.type === 'text').map(c => c.text);
    const text = textParts.length > 0 ? textParts.join('\n') : null;

    const toolCalls = content
        .filter(c => c.type === 'tool_use')
        .map(c => ({ id: c.id, name: c.name, input: c.input || {} }));

    // BAT-549 Commit 2: capture thinking + redacted_thinking blocks
    // verbatim — preserves the signature byte-exactly so a future
    // request that echoes them passes Anthropic's server-side
    // validation. raw.id is the message id (turn id from Anthropic).
    const reasoningBlocks = [];
    const turnId = (raw && typeof raw.id === 'string') ? raw.id : null;
    const sourceModel = (raw && typeof raw.model === 'string') ? raw.model : null;
    for (const c of content) {
        if (!c || (c.type !== 'thinking' && c.type !== 'redacted_thinking')) continue;
        // BAT-1033: reject malformed blocks at the CAPTURE boundary too, not
        // just on replay, so a poisoned block never enters a checkpoint in the
        // first place (same rule as _isValidWireBlock): a `thinking`
        // block needs a string `thinking` + a NON-EMPTY string `signature`
        // (empty TEXT is valid — an empty-signature block is the poison);
        // `redacted_thinking` needs a string `data`. With the http.js delta
        // fix the normal streamed path won't produce these, but a malformed
        // block from any other source (older build, non-streaming edge) is
        // dropped here instead of persisted.
        if (!_isValidWireBlock(c)) continue;
        reasoningBlocks.push({
            schemaVersion: 1,
            provider: 'anthropic',
            sourceAdapter: 'claude',
            sourceModel,
            turnId,
            wire: c, // verbatim block; signature stays unchanged
        });
    }

    // BAT-1664: the verbatim snapshot source. Same validity filter, nothing
    // else touched — no join, no reorder, no re-normalization.
    const wireContent = content.filter(_isValidWireBlock);
    const inputTransformations = (raw && Array.isArray(raw.input_transformations))
        ? raw.input_transformations : null;

    // BAT-1705: a refusal (classifier block or the model's own) can fire before any
    // output or mid-stream after partial output. Branch on stop_reason only, never
    // stop_details (which may be null). Nothing from the refused response survives:
    // no partial text, no (possibly cut-off) tool call, no reasoning / wire replay.
    if (raw.stop_reason === 'refusal') {
        const sd = raw.stop_details;
        return {
            text: null,
            toolCalls: [],
            reasoningBlocks: [],
            wireContent: [],
            inputTransformations,
            stopReason: 'model_refusal',
            usage: raw.usage || {},
            refusal: {
                kind: 'model_refusal',
                category: (sd && typeof sd.category === 'string') ? sd.category : null,
                modelMessage: null,
                partialChars: text ? text.length : 0,
                droppedToolCalls: toolCalls.length,
            },
        };
    }

    return {
        text,
        toolCalls,
        reasoningBlocks,
        wireContent,
        inputTransformations,
        stopReason: raw.stop_reason || 'end_turn',
        usage: raw.usage || {},
        refusal: null,
    };
}

// ── Billing attribution (required for OAuth/setup-token access to non-Haiku models) ─

// BAT-1123: cc_version tracks the Claude Code CLI version we identify as on the
// setup_token billing path. Bumped 2.1.116 → 2.1.195 (verified HTTP 200 on our
// models on the setup_token path via tests/live/anthropic/test-messages.js). Keep in sync with tests/live/anthropic/lib.js.
const CC_BILLING_HEADER = 'x-anthropic-billing-header: cc_version=2.1.195; cc_entrypoint=cli; cch=00000;';

// ── System prompt ───────────────────────────────────────────────────────────

/**
 * Format system prompt for Claude API (cached stable block + optional dynamic block).
 * @param {string} stable - Stable system prompt text
 * @param {string} dynamic - Dynamic system prompt text
 * @param {string} [authType] - Auth type ('api_key' or 'setup_token')
 */
function formatSystemPrompt(stable, dynamic, authType) {
    const blocks = [];
    // Billing attribution — required for OAuth tokens to access Sonnet/Opus
    if (authType === 'setup_token') {
        blocks.push({ type: 'text', text: CC_BILLING_HEADER });
    }
    blocks.push({ type: 'text', text: stable, cache_control: { type: 'ephemeral' } });
    if (typeof dynamic === 'string' && dynamic.trim()) blocks.push({ type: 'text', text: dynamic });
    return blocks;
}

// ── Tool schema formatting ──────────────────────────────────────────────────

/**
 * Format tools for Claude API. Pass-through (Claude's native format IS JSON Schema)
 * but adds cache_control on last tool for prompt caching.
 */
function formatTools(tools) {
    if (!tools || tools.length === 0) return [];
    // Shallow-clone last tool to avoid mutating shared array
    const out = [...tools];
    out[out.length - 1] = {
        ...out[out.length - 1],
        cache_control: { type: 'ephemeral' },
    };
    return out;
}

// ── API request building ────────────────────────────────────────────────────

/**
 * Build full Claude API request body.
 *
 * BAT-549 Commit 3c gated `body.thinking` emission on the user toggle
 * (`reasoningEnabled === true`) AND registry confirmation
 * (`reasoningSupport === "yes"`). BAT-558 v4 R3 added the
 * `reasoningMode: 'off'` short-circuit so heartbeats / synthetic turns
 * opt out even when the user toggle is on.
 *
 * BAT-1033 replaced the extended-thinking budget clamp with
 * `thinking: { type: 'adaptive' }`. Anthropic removed extended thinking
 * (`type:'enabled'` + `budget_tokens`) from the current models — they 400
 * — while adaptive (model auto-sizes its own budget) is accepted by every
 * reasoning model. Adaptive carries no `budget_tokens`, so the old
 * `budget_tokens < max_tokens` clamp is gone; see the module header for
 * the per-model matrix and the live-probe evidence.
 *
 * The `maxTokens < MIN_THINKING_TURN` (2048) skip is retained as a UX
 * guard so a tiny answer budget isn't consumed by reasoning. Existing
 * call sites (vision/summary) that pass small `maxTokens` (256, 500) or
 * no `requestOptions` continue to emit no `thinking` — additive change.
 *
 * BAT-1664: what "off" means depends on the model. Omitting `thinking`
 * does NOT stop a model that thinks by default: Fable 5.x, Opus 5/5.5 and
 * Sonnet 5.5 run adaptive when the field is absent. So the off / heartbeat /
 * toggle-off paths below are "app does not ASK for thinking", not "model
 * does not think". For registry-flagged models (`thinkingBinding: true`)
 * whose emitted messages carry thinking, ai.js sets `bindThinking` and this
 * function sends `{type:'adaptive', block_binding:{prefix_mismatch_behavior:
 * 'drop_block'}}` regardless of those paths (it runs first) — that changes
 * nothing about whether the model thinks, only how a prefix mismatch is
 * handled.
 */
function formatRequest(model, maxTokens, systemBlocks, messages, tools, requestOptions) {
    const body = {
        model,
        max_tokens: maxTokens,
        stream: true,
        system: systemBlocks,
        messages,
    };
    if (tools && tools.length > 0) body.tools = tools;
    // BAT-1664 C0 — the loop-final round on a stable-history (flagged) model
    // keeps the turn's FROZEN tools array (removing it would change the prefix
    // every in-turn thinking signature is bound to) and forbids tool use with
    // `tool_choice: none` instead. `none` is accepted alongside thinking (only
    // forced `any`/`tool` are rejected). Without tools there is nothing to forbid.
    if (requestOptions && requestOptions.toolChoiceNone === true && body.tools) {
        body.tool_choice = { type: 'none' };
    }

    // BAT-1664 C2 — thinking block binding. `bindThinking` is the per-request
    // decision ai.js makes ONCE (registry `thinkingBinding` flag && the
    // emitted messages carry ≥1 thinking block && no negative capability for
    // this route+credential); ai.js sends the THINKING_BINDING_BETA header from
    // the SAME decision, so header and field always travel together (the field
    // without the header is a 400).
    //
    // This branch runs BEFORE the reasoning-off / toggle-off / small-turn
    // early returns on purpose. Flagged models think adaptively whether or not
    // `thinking` is sent ("flagged models default to adaptive when thinking is
    // omitted" — Anthropic model docs, 2026-11-06), so sending
    // `{type:'adaptive', block_binding}` on a heartbeat / toggle-off / small
    // turn changes nothing about whether the model thinks — it only turns a
    // prefix-mismatch 400 into a dropped block.
    if (requestOptions && requestOptions.bindThinking === true) {
        body.thinking = { type: 'adaptive', block_binding: { prefix_mismatch_behavior: 'drop_block' } };
        return JSON.stringify(body);
    }

    // BAT-558 v4 R3 — synthetic / opt-out short-circuit. Heartbeats
    // pass `reasoningMode: 'off'` explicitly; ai.js also defensively
    // sets it for `chatId === '__heartbeat__'`. Either path skips the
    // thinking block regardless of user-toggle / registry-support state
    // (those gates apply to the OPTIONAL emission below this).
    const reasoningOff = !!(requestOptions && requestOptions.reasoningMode === 'off');
    const userWantsReasoning = !!(requestOptions
        && requestOptions.reasoningEnabled === true
        && requestOptions.reasoningSupport === 'yes');
    if (reasoningOff || !userWantsReasoning) {
        return JSON.stringify(body);
    }

    // Small-turn skip (retained from BAT-558 as a UX guard): a sub-2048
    // max_tokens turn has no headroom for useful reasoning AND a usable
    // answer, so thinking is skipped (rate-limited INFO log so the
    // suppression is discoverable in field reports without flooding Logs).
    if (maxTokens < MIN_THINKING_TURN) {
        logSuppression(
            SUPPRESSION_REASONS.MAX_TOKENS_BELOW_FLOOR,
            `claude maxTokens=${maxTokens}`,
        );
        return JSON.stringify(body);
    }

    // BAT-1033 — adaptive thinking: the model auto-sizes its own budget.
    // No `budget_tokens` (extended thinking was removed from the current
    // models; adaptive is accepted by all). See module header for the matrix.
    body.thinking = { type: 'adaptive' };
    return JSON.stringify(body);
}

// ── Connection details ──────────────────────────────────────────────────────

const endpoint = { hostname: 'api.anthropic.com', path: '/v1/messages' };

// BAT-1664: `extra` is an optional array of additional anthropic-beta tags for
// THIS request (today only THINKING_BINDING_BETA, from ai.js's `bind`
// decision via traceCtx.anthropicBetaExtra). Omitted → the historical header
// set, byte-for-byte.
function buildHeaders(apiKey, authType, extra) {
    const auth = authType === 'setup_token'
        ? { 'Authorization': `Bearer ${apiKey}` }
        : { 'x-api-key': apiKey };

    // BAT-549 Commit 3c: include the `interleaved-thinking-2025-05-14` beta
    // so the API accepts replayed `thinking` blocks AFTER `tool_use` blocks
    // on the next turn. Without this, a tool-loop turn that splices the
    // captured thinking back into content[] would be rejected. Adding it
    // is a no-op when reasoning is OFF — the beta only activates when the
    // request actually emits thinking blocks. Safe-by-default for both
    // setup_token and api_key auth modes.
    let betaTags = authType === 'setup_token'
        ? 'prompt-caching-2024-07-31,oauth-2025-04-20,interleaved-thinking-2025-05-14'
        : 'prompt-caching-2024-07-31,interleaved-thinking-2025-05-14';
    if (Array.isArray(extra)) {
        const have = betaTags.split(',');
        for (const tag of extra) {
            if (typeof tag === 'string' && /^[a-z0-9-]+$/.test(tag) && !have.includes(tag)) {
                have.push(tag);
            }
        }
        betaTags = have.join(',');
    }
    return {
        'Content-Type': 'application/json',
        'anthropic-version': '2023-06-01',
        'anthropic-beta': betaTags,
        ...auth,
    };
}

// ── Streaming ───────────────────────────────────────────────────────────────
// Claude uses named SSE events: message_start, content_block_start,
// content_block_delta, content_block_stop, message_delta, message_stop.
// The existing httpStreamingRequest in web.js handles this natively.
// We just mark that Claude uses the 'claude' streaming protocol.

const streamProtocol = 'claude';

// ── Error classification ────────────────────────────────────────────────────

function classifyError(status, data) {
    if (status === 401 || status === 403) {
        // BAT-1130: auth-agnostic copy — setup_token users have no "API key", so
        // "API key might be wrong" was misleading. Covers both auth modes.
        return {
            type: 'auth', retryable: false,
            userMessage: '🔑 The AI rejected the credentials. If you use an API key, re-check it in Settings; if you signed in with a Pro/Max token, re-pair in Settings.'
        };
    }
    if (status === 402) {
        return {
            type: 'billing', retryable: false,
            userMessage: 'Your API account needs attention — check billing at console.anthropic.com'
        };
    }
    if (status === 429) {
        const msg = data?.error?.message || '';
        if (/quota|credit/i.test(msg)) {
            return {
                type: 'quota', retryable: false,
                userMessage: 'API usage quota exceeded. Please try again later or upgrade your plan.'
            };
        }
        return {
            type: 'rate_limit', retryable: true,
            userMessage: '⏳ Got rate limited. Trying again in a moment...'
        };
    }
    if (status === 529) {
        return {
            type: 'overloaded', retryable: true,
            userMessage: 'Claude API is temporarily overloaded. Please try again in a moment.'
        };
    }
    if (status >= 520 && status <= 527) {
        return {
            type: 'cloudflare', retryable: true,
            userMessage: 'Claude API is temporarily unreachable. Retrying...'
        };
    }
    if (status >= 500 && status < 600) {
        return {
            type: 'server', retryable: true,
            userMessage: 'Claude API is temporarily unavailable. Retrying...'
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

function classifyNetworkError(err) {
    const raw = err.message || String(err);
    if (err.code === 'SESSION_EXPIRED') {
        return { type: 'session_expired', userMessage: 'Your session has expired. Please re-pair with Settings.' };
    }
    if (err.timeoutSource === 'transport' || /timeout/i.test(raw)) {
        return { type: 'timeout', userMessage: 'The AI took too long to respond. Please try again.' };
    }
    if (/ENOTFOUND|EAI_AGAIN/i.test(raw)) {
        return { type: 'dns', userMessage: 'Cannot reach the AI service — check your internet connection.' };
    }
    if (/ECONNREFUSED|ECONNRESET|EPIPE/i.test(raw)) {
        return { type: 'connection', userMessage: 'Connection to the AI service was lost. Please try again.' };
    }
    return { type: 'network', userMessage: 'A network error occurred. Please try again.' };
}

// ── Rate limit headers ──────────────────────────────────────────────────────

function parseRateLimitHeaders(headers) {
    if (!headers) return { tokensRemaining: Infinity, tokensReset: '' };
    const remaining = parseInt(headers['anthropic-ratelimit-tokens-remaining'], 10);
    return {
        tokensRemaining: Number.isFinite(remaining) ? remaining : Infinity,
        tokensReset: headers['anthropic-ratelimit-tokens-reset'] || '',
        // Full breakdown for usage state file
        requests: {
            limit: parseInt(headers['anthropic-ratelimit-requests-limit']) || 0,
            remaining: parseInt(headers['anthropic-ratelimit-requests-remaining']) || 0,
            reset: headers['anthropic-ratelimit-requests-reset'] || '',
        },
        tokens: {
            limit: parseInt(headers['anthropic-ratelimit-tokens-limit']) || 0,
            remaining: parseInt(headers['anthropic-ratelimit-tokens-remaining']) || 0,
            reset: headers['anthropic-ratelimit-tokens-reset'] || '',
        },
    };
}

// ── Usage normalization ─────────────────────────────────────────────────────

function normalizeUsage(usage) {
    if (!usage) return { inputTokens: 0, outputTokens: 0, cacheRead: 0, cacheWrite: 0 };
    return {
        inputTokens: usage.input_tokens || 0,
        outputTokens: usage.output_tokens || 0,
        cacheRead: usage.cache_read_input_tokens || 0,
        cacheWrite: usage.cache_creation_input_tokens || 0,
    };
}

// ── Vision ──────────────────────────────────────────────────────────────────

function formatVision(base64, mediaType) {
    return {
        type: 'image',
        source: {
            type: 'base64',
            media_type: mediaType || 'image/jpeg',
            data: base64,
        },
    };
}

// ── Connection test ─────────────────────────────────────────────────────────

const testEndpoint = { hostname: 'api.anthropic.com', path: '/v1/models', method: 'GET' };

// ── Export adapter ──────────────────────────────────────────────────────────

module.exports = {
    id: 'claude',
    name: 'Claude (Anthropic)',

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
    normalizeUsage,
    parseRateLimitHeaders,

    // Capabilities
    supportsCache: true,
    authTypes: ['api_key', 'setup_token'],

    // BAT-1664: preserved-thinking support (verbatim replay + block binding)
    THINKING_BINDING_BETA,
    WIRE_SNAPSHOT_KEY,
    messagesHaveThinking,
    setWireSnapshot,
    getWireSnapshot,
    invalidateWireSnapshot,
    noteHistoryEdit,
    wireEditEpoch,
};
