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
 *                           emits unconditionally whenever blocks are
 *                           present (R8 thread 1: the delegate does NOT
 *                           re-decide based on tool-use context — gating
 *                           lives entirely in this Custom-adapter layer).
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

    // DeepSeek R1 family — server REJECTS reasoning_content echo (returns 400)
    if (/^deepseek-(reasoner|r1)/i.test(m)) return 'strip';

    // DeepSeek V4 family — server REQUIRES reasoning_content echo after tool calls
    if (/^deepseek-v4/i.test(m)) return 'echo-on-tool-loop';

    // Everything else (incl. qwen3-thinking, mistral-large-2407, gemini-deep-think,
    // llama-4-thinking, etc.) — start unknown until tested.
    return 'unknown';
}

/**
 * Filter the messages array to remove Custom-stamped reasoningBlocks when
 * the gating decision is 'strip' or 'unknown'. Used by `providers/custom.js`
 * BEFORE handing to its delegate's `toApiMessages`.
 *
 * Pure function — returns a new array with shallow-cloned assistant messages
 * that have `reasoningBlocks` cleared. Other messages pass through by reference.
 *
 * Why filter rather than skip-the-emit-in-delegate: the delegate (openrouter
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
            const clone = { ...msg };
            clone.reasoningBlocks = [];
            return clone;
        }
        return msg;
    });
}

module.exports = {
    detectCustomEchoBehavior,
    stripReasoningForCustomGating,
};
