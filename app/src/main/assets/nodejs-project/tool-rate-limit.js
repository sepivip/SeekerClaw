// tool-rate-limit.js — per-tool rate limits (config.js TOOL_RATE_LIMITS) for the ai.js tool loop.
//
// v1.0 rule: a tool is rate-limited on the confirm path only (confirmable tools are the ones
// guarded against rapid-fire abuse), so a burner action under cap, which runs silently, is not.
//
// BAT-1409 P1-H: message and call drafts (android_sms / android_call) left the confirm set — the
// user already confirms on the phone by tapping the draft and pressing Send or Dial — but keep
// their rate limit. A draft counts once it is posted, so one refused for, say, notifications off
// can be retried at once.

'use strict';

const RATE_LIMITED_WITHOUT_CONFIRM = new Set(['android_sms', 'android_call']);

/**
 * The refusal for a tool still inside its rate-limit window, or null when it may run.
 * @param {string} toolName
 * @param {Object<string, number>} limits  ms per tool (TOOL_RATE_LIMITS)
 * @param {Map<string, number>|null} lastToolUseTime
 * @param {(msg: string, level: string) => void} log
 */
function rateLimitRefusal(toolName, limits, lastToolUseTime, log, now = Date.now()) {
    const rateLimit = limits[toolName];
    const lastUse = lastToolUseTime ? lastToolUseTime.get(toolName) : undefined;
    if (!rateLimit || !lastUse || (now - lastUse) >= rateLimit) return null;
    const waitSec = Math.ceil((rateLimit - (now - lastUse)) / 1000);
    log(`[RateLimit] ${toolName} blocked — ${waitSec}s remaining`, 'WARN');
    return {
        error: `Rate limited: ${toolName} can only be used once per ${rateLimit / 1000}s. Try again in ${waitSec}s.`,
        code: 'rate_limited',
    };
}

/**
 * Runs a tool whose confirmation policy is "none". Drafts are refused inside their window
 * (outcome `rate_limited`) and counted only when the result's outcome is `posted`.
 * @param {string} toolName
 * @param {() => Promise<any>} execute
 * @param {{ limits: Object<string, number>, lastToolUseTime: Map<string, number>|null, log: Function }} deps
 */
async function runWithoutConfirm(toolName, execute, { limits, lastToolUseTime, log }) {
    const draftTool = RATE_LIMITED_WITHOUT_CONFIRM.has(toolName);
    if (draftTool) {
        const limited = rateLimitRefusal(toolName, limits, lastToolUseTime, log);
        if (limited) return { ...limited, outcome: 'rate_limited' };
    }
    const result = await execute();
    if (draftTool && result && result.outcome === 'posted' && lastToolUseTime) {
        lastToolUseTime.set(toolName, Date.now());
    }
    return result;
}

module.exports = { RATE_LIMITED_WITHOUT_CONFIRM, rateLimitRefusal, runWithoutConfirm };
