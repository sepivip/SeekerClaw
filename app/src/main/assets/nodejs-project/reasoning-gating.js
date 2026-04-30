// SeekerClaw — reasoning-gating.js (BAT-549)
//
// Conservative model-gating for the Custom adapter's reasoning-echo behavior.
//
// Codex v4.1 review finding 4 explicitly rejected blanket sniff-and-passthrough.
// DeepSeek R1/reasoner returns 400 if `reasoning_content` is echoed; DeepSeek
// V4-pro returns 400 if it ISN'T echoed after a tool call. Opposite contracts
// on similar-looking field names — we MUST gate by model.
//
// Other "thinking" model families (Qwen3-thinking, Mistral large-2407, Gemini
// deep-think, Llama 4 thinking) start as `unknown` and capture-only until
// tested against their actual gateway contract. User can flip the per-Custom-
// config advanced override (`customEchoReasoning`) if their gateway requires
// it.

'use strict';

/**
 * Decide echo behavior for a Custom-adapter request.
 *
 * Returns one of:
 *  - 'strip'              : known-do-not-echo (e.g. DeepSeek R1). Strip
 *                           reasoningBlocks before delegating, so the
 *                           delegate's emit path has nothing to attach.
 *  - 'echo-on-tool-loop'  : known-must-echo-after-tool-call (e.g. DeepSeek
 *                           V4) OR user enabled the advanced override.
 *                           Pass blocks through to the delegate, which
 *                           emits whenever blocks are present and the
 *                           delegate's OWN model-gating agrees. The
 *                           OpenRouter delegate has its own model
 *                           regex (added in Commit 2a for native
 *                           OpenRouter R1/V4 protection), so gating is
 *                           layered: Custom decides "should we even
 *                           pass blocks", and the delegate decides
 *                           "given this model, do I emit them". For
 *                           V4-shaped models both layers say "yes"; for
 *                           R1-shaped both say "no"; for unknown the
 *                           Custom layer can override (echo-on-tool-loop
 *                           via the user toggle) and the delegate's
 *                           freeform-default wins (no extra emit).
 *                           The "tool-loop" suffix in this name reflects
 *                           the V4 SERVER contract that requires echo
 *                           after a tool call, not a per-call delegate
 *                           decision.
 *  - 'unknown'            : capture-only — do NOT echo. Log once per session
 *                           if blocks are present. User can flip the override
 *                           if their gateway needs it.
 *
 * @param {string} modelId            — the configured Custom `model` field
 * @param {boolean} customEchoOverride — RuntimeState.customEchoReasoning flag
 */
function detectCustomEchoBehavior(modelId, customEchoOverride) {
    if (customEchoOverride === true) return 'echo-on-tool-loop';

    const m = (typeof modelId === 'string' ? modelId : '').toLowerCase().trim();

    // DeepSeek R1 family — server REJECTS reasoning_content echo (returns 400).
    // Match the family substring anywhere in the id (handles raw
    // `deepseek-r1` for the Custom adapter pointed at api.deepseek.com AND
    // OpenRouter-prefixed `deepseek/deepseek-r1-0528` etc.).
    if (/(?:^|\/)deepseek-(?:reasoner|r1)(?:-|$)/i.test(m)) return 'strip';

    // DeepSeek V4 family — server REQUIRES reasoning_content echo after tool calls.
    // Same family-substring matching as R1.
    if (/(?:^|\/)deepseek-v4(?:-|$)/i.test(m)) return 'echo-on-tool-loop';

    // Everything else (incl. qwen3-thinking, mistral-large-2407, gemini-deep-think,
    // llama-4-thinking, etc.) — start unknown until tested.
    return 'unknown';
}

/**
 * Clear `reasoningBlocks` on every assistant message in `messages` when the
 * gating decision is 'strip' or 'unknown'. Used by `providers/custom.js`
 * BEFORE handing to its delegate's `toApiMessages`. R9 doc fix: this
 * function strips reasoningBlocks REGARDLESS of provenance — it does not
 * inspect block.provider / block.sourceAdapter. In practice that's safe
 * because the only caller is the Custom adapter, which has already
 * re-stamped every captured block with `provider: 'custom'` /
 * `sourceAdapter: 'custom'` in its `fromApiResponse`. If a future caller
 * outside the Custom path needs provenance-aware filtering, refactor at
 * that point — over-engineering today is a YAGNI hazard.
 *
 * R16 Copilot wire-shape filter: the strip targets the chat-completions-
 * style `reasoning_content` field (the DeepSeek R1/V4 echo-or-strip
 * problem), NOT the OpenAI Responses-style `wire.type === 'reasoning'`
 * items. Responses items carry encrypted_content and are required for
 * tool-loop continuation regardless of model — stripping them would
 * break Commit 2b's encrypted_content preservation for any Custom+
 * Responses gateway pointing at a model that doesn't match the R1/V4
 * regex (e.g., gpt-5.4 on a self-hosted Responses proxy → behavior
 * 'unknown' → previously cleared the Responses items).
 *
 * Pure function — returns a new array with shallow-cloned assistant messages
 * that have chat-completions-style `reasoningBlocks` removed. Other
 * messages pass through by reference.
 *
 * Why clear rather than skip-the-emit-in-delegate: the delegate (openrouter
 * or openai) is also used by the *native* OpenRouter / OpenAI adapter where
 * echo is correct. The gating is Custom-specific, so the cleanest place to
 * enforce it is at the Custom-adapter boundary BEFORE delegation, by removing
 * the data the delegate would otherwise pick up.
 */
function stripReasoningForCustomGating(messages, behavior) {
    if (behavior === 'echo-on-tool-loop') return messages;
    if (!Array.isArray(messages)) return messages;
    return messages.map((msg) => {
        if (msg && msg.role === 'assistant' && Array.isArray(msg.reasoningBlocks) && msg.reasoningBlocks.length > 0) {
            const filtered = msg.reasoningBlocks.filter((blk) => {
                // Defensive: drop malformed blocks regardless of behavior.
                if (!blk || !blk.wire || typeof blk.wire !== 'object' || Array.isArray(blk.wire)) return false;
                // Preserve OpenAI Responses-style reasoning items (encrypted_content
                // is required for tool-loop replay; gating is irrelevant to these
                // because they aren't the DeepSeek R1/V4 echo-problem field).
                if (blk.wire.type === 'reasoning') return true;
                // Strip chat-completions-style reasoning_content blocks (the
                // gating target — this is what R1 rejects with 400 and V4
                // requires after tool calls).
                if (typeof blk.wire.reasoning_content === 'string') return false;
                // Unknown wire shape — drop conservatively. If a future
                // adapter introduces a third reasoning shape, an explicit
                // case here keeps gating semantics clear; until then,
                // unknown shapes are treated as chat-completions-style
                // (the safer side for R1's 400-loop scenario).
                return false;
            });
            if (filtered.length === msg.reasoningBlocks.length) return msg;
            const clone = { ...msg };
            clone.reasoningBlocks = filtered;
            return clone;
        }
        return msg;
    });
}

module.exports = {
    detectCustomEchoBehavior,
    stripReasoningForCustomGating,
};
