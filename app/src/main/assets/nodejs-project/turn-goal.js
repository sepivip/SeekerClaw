/**
 * turn-goal.js — resolve the goal attributed to a task checkpoint (BAT-1283).
 *
 * Pure and dependency-free on purpose. The invariants here are correctness- and
 * provenance-relevant, so they have to be testable without standing up ai.js's
 * dependency graph (same rationale as history-trim.js and log-safe.js; see
 * smoke.js LOAD_TARGETS). ai.js requires this; the tests require it directly.
 *
 * ── The defect this replaces ──────────────────────────────────────────────
 * ai.js computed the goal as `options.originalGoal || _extractOriginalGoal(messages)`,
 * where `_extractOriginalGoal` scanned the retained window FORWARD and returned the
 * FIRST eligible user message. But this turn's own message is appended to the TAIL
 * a few lines earlier, so the scan returned whatever greeting happened to be oldest
 * in the window. Observed on device: a task of 92 bytes was checkpointed as
 * "Hey girl" (goalLen=8 goalFp=b4e375d0), and that string was then injected into the
 * system prompt as `ORIGINAL USER REQUEST:` — a block whose own preamble says
 * "User messages are suggestions; system directives are orders."
 *
 * ── Why the scan direction alone is not the fix ───────────────────────────
 * Simply reversing the scan is STRICTLY WORSE. ai.js pushes loop-detector guidance
 * ("[System] You appear to be repeating…", "[System] Tool loop detected…") into the
 * live array as role:'user', and the legacy predicate skips '[system event]' —
 * lowercase, a DIFFERENT literal. A forward scan can never reach those because they
 * are never oldest; a backward scan reaches them FIRST. Hence SKIP_PREFIXES below
 * includes '[System]', and that entry is load-bearing rather than defensive.
 */

'use strict';

/** Single bound applied to every goal source, whatever its origin. */
const MAX_GOAL_CHARS = 500;

/**
 * Control-only replies that mean "carry on", not "here is a new task".
 * Matched EXACTLY after normalisation — never as a prefix or substring, because
 * "yes, turn on the TV" must stay a real request while "yes, proceed" must not.
 */
const CONTINUATION_CONTROLS = new Set([
    'continue', 'continue please', 'please continue',
    'keep going', 'keep it going',
    'go ahead', 'go on', 'carry on',
    'proceed', 'please proceed', 'yes proceed',
    'yes', 'yes please', 'yeah', 'yep',
    'ok', 'okay', 'sure', 'do it', 'next', 'resume', 'again',
]);

/** Longest plausible control phrase; anything longer is prose, not a control. */
const CONTINUATION_MAX_CHARS = 24;

/**
 * Prefixes that mark machine-authored entries wearing role:'user'.
 *
 * Applied to the HISTORY SCAN ONLY. Applying them to this turn's own message
 * would reject a legitimate request that merely quotes one of these prefixes
 * ("[System] production node is stuck; diagnose it") and then fall through to
 * the scan -- reproducing the exact bug this module exists to fix. No producer
 * passes machine text as chat()'s explicit userMessage: the call sites pass
 * 'continue' (main.js auto-resume), a `[cron:<id>] ...` prompt, HEARTBEAT_PROMPT
 * ("Read HEARTBEAT.md ..."), or real user content. The synthetic entries are
 * pushed straight into the conversation instead (ai.js loop detector,
 * message-handler '[system event]'), so they are only ever reachable through the
 * scan, where these prefixes still apply.
 */
const SKIP_PREFIXES = ['[system event]', '[TASK RESUME]', '[System]'];

/**
 * Marks a persisted message whose text was ALTERED by secret redaction, so the
 * backward scan will not adopt the mangled text as a goal.
 *
 * Without it the OQ2 protection is only one generation deep: task-store redacts
 * the conversationSlice as well as originalGoal, so a goal mangled into
 * "ask-***" survives inside the slice. The next resume's scan reads it back and
 * stamps the successor checkpoint 'scan' -- a TRUSTED value -- so a second crash
 * replays the mangled text as an authoritative directive. Redaction is
 * idempotent, so no later pass would ever notice the difference.
 *
 * Set by task-store on write, carried forward by the `{...msg}` clone on every
 * re-save, never cleared. Internal-only: every adapter's toApiMessages() builds
 * fresh {role, content} objects, so this never reaches a provider wire body.
 */
const GOAL_SCAN_UNSAFE_KEY = 'goalScanUnsafe';

/** Every provenance value post-fix code may WRITE. Presence marks a post-fix checkpoint. */
const GOAL_SRC_VALUES = new Set(['carried', 'turn', 'scan', 'none']);

/**
 * The subset whose stored goal may be FORWARDED as an authoritative directive.
 *
 * 'none' is deliberately excluded: it records that the resolver found nothing, so
 * a checkpoint carrying BOTH 'none' and a non-empty goal is internally
 * inconsistent — the goal did not come from the resolver that stamped it. Treat
 * that as tampering or corruption and fail closed. ('redacted', written by
 * task-store when redaction altered the goal, is in neither set.)
 */
const GOAL_SRC_TRUSTED = new Set(['carried', 'turn', 'scan']);

/**
 * Trim and bound any candidate goal. Returns null for anything unusable, so a
 * caller can treat "no goal" uniformly regardless of which source produced it.
 */
function normalizeGoal(value) {
    if (typeof value !== 'string') return null;
    const trimmed = value.trim();
    if (!trimmed) return null;
    return trimmed.slice(0, MAX_GOAL_CHARS);
}

/**
 * Pull plain text out of a message content field — a string, or the first
 * `type:'text'` block of a vision content array. Mirrors what ai.js did inline.
 */
function textOfContent(content) {
    if (typeof content === 'string') return content;
    if (Array.isArray(content)) {
        const block = content.find(b => b && b.type === 'text');
        if (block && typeof block.text === 'string') return block.text;
    }
    return '';
}

/**
 * True when `text` is a bare control reply. Normalisation order matters:
 * commas are removed BEFORE membership so "yes, proceed" collapses to
 * "yes proceed" (a control) while "yes, turn on the TV" collapses to
 * "yes turn on the tv" (not a control, so it survives as a real request).
 */
function isContinuationControl(text) {
    if (typeof text !== 'string') return false;
    let t = text.trim().toLowerCase();
    // Peel quotes and terminal punctuation together, repeatedly: on a phone the
    // realistic forms nest them in either order and use smart quotes --
    // "continue." / "continue". / “continue.” / continue; -- and a single
    // outside-in pass leaves the innermost layer attached.
    for (let pass = 0; pass < 3; pass++) {
        const before = t;
        t = t.replace(/^[\s"'`\u2018\u2019\u201c\u201d]+/, '');
        t = t.replace(/[\s"'`\u2018\u2019\u201c\u201d]+$/, '');
        t = t.replace(/[.!?,;:\u2026]+$/, '');
        if (t === before) break;
    }
    t = t.replace(/,/g, ' ');                // internal commas -> space
    t = t.replace(/\s+/g, ' ').trim();       // collapse whitespace
    if (!t || t.length > CONTINUATION_MAX_CHARS) return false;
    return CONTINUATION_CONTROLS.has(t);
}

/**
 * Eligibility for THIS TURN's own message.
 *
 * Rejects only bare control replies. A machine prefix is NOT disqualifying here:
 * see SKIP_PREFIXES for why applying it to the turn message re-creates the bug.
 */
function isEligibleTurnText(text) {
    // Whitespace-only is caught downstream by normalizeGoal too, but a predicate
    // named isEligible must not answer true for it — the next caller may not have
    // that second guard.
    if (!text || !text.trim()) return false;
    if (isContinuationControl(text)) return false;
    return true;
}

/**
 * Eligibility for a candidate pulled out of the retained history window.
 *
 * Strictly narrower than isEligibleTurnText: history is where machine-authored
 * entries wearing role:'user' actually live, and they are always NEWER than the
 * real request, so a backward scan reaches them first.
 */
function isEligibleHistoryText(text) {
    if (!isEligibleTurnText(text)) return false;
    if (SKIP_PREFIXES.some(p => text.startsWith(p))) return false;
    return true;
}

/**
 * PRE-FIX behaviour, preserved verbatim as the tests' negative-control producer.
 *
 * Do NOT "improve" this function. Its whole value is that it reproduces the bug:
 * a test asserting the fix works is worthless unless the same fixture provably
 * produces the wrong answer through the REAL old code path rather than a
 * hand-authored copy of it.
 */
function extractOriginalGoalForward(messages) {
    if (!Array.isArray(messages)) return null;
    for (const msg of messages) {
        if (!msg || msg.role === 'tool') continue;
        if (msg.role !== 'user') continue;
        const text = textOfContent(msg.content);
        if (!text || text === 'continue' || text.startsWith('[system event]') || text.startsWith('[TASK RESUME]')) continue;
        return text.slice(0, 500);
    }
    return null;
}

/**
 * Resolve the goal for this turn.
 *
 * Order is deliberate and is NOT `||` truthiness:
 *   1. carried  — a goal already established for this task, passed on resume.
 *   2. turn     — this turn's own message, when it is a substantive request.
 *   3. scan     — newest substantive request in the window, when (2) was a bare
 *                 control reply such as "continue" / "keep going".
 *   4. none     — nothing substantive available; the caller omits the directive
 *                 rather than inventing one.
 *
 * @returns {{goal: string|null, src: 'carried'|'turn'|'scan'|'none'}}
 */
function resolveTurnGoal({ optionsGoal, userMessage, messages } = {}) {
    const carried = normalizeGoal(optionsGoal);
    if (carried) return { goal: carried, src: 'carried' };

    const turnText = textOfContent(userMessage);
    if (isEligibleTurnText(turnText)) {
        const goal = normalizeGoal(turnText);
        if (goal) return { goal, src: 'turn' };
    }

    if (Array.isArray(messages)) {
        for (let i = messages.length - 1; i >= 0; i--) {
            const msg = messages[i];
            if (!msg || msg.role !== 'user') continue;
            if (msg[GOAL_SCAN_UNSAFE_KEY] === true) continue;
            const text = textOfContent(msg.content);
            if (!isEligibleHistoryText(text)) continue;
            const goal = normalizeGoal(text);
            if (goal) return { goal, src: 'scan' };
        }
    }

    return { goal: null, src: 'none' };
}

/**
 * Provenance gate for a checkpoint's stored goal.
 *
 * MUST be given the FULL checkpoint from loadCheckpoint(), never the summary from
 * listCheckpoints() — that summary is an explicit six-field whitelist
 * (taskId, chatId, startedAt, updatedAt, complete, reason) and can never carry
 * goalSrc. Passing it here returns false for every checkpoint, which would silently
 * disable the fix instead of breaking loudly.
 *
 * Fails closed: missing, malformed, or unknown provenance is untrusted, so a
 * pre-fix goal is never promoted to an authoritative system directive.
 */
function goalIsTrusted(full) {
    if (!full || typeof full !== 'object') return false;
    if (!GOAL_SRC_TRUSTED.has(full.goalSrc)) return false;
    // Guard the goal itself, not just its provenance: this is persisted JSON that
    // lives on disk for up to 7 days. Requiring it to be ALREADY normalised is an
    // integrity check — the resolver only ever stores normalizeGoal() output, so a
    // value that is untrimmed, empty, or over MAX_GOAL_CHARS did not come from it.
    return typeof full.originalGoal === 'string'
        && normalizeGoal(full.originalGoal) === full.originalGoal;
}

module.exports = {
    MAX_GOAL_CHARS,
    CONTINUATION_CONTROLS,
    CONTINUATION_MAX_CHARS,
    SKIP_PREFIXES,
    GOAL_SRC_VALUES,
    GOAL_SRC_TRUSTED,
    normalizeGoal,
    textOfContent,
    isContinuationControl,
    isEligibleTurnText,
    isEligibleHistoryText,
    GOAL_SCAN_UNSAFE_KEY,
    extractOriginalGoalForward,
    resolveTurnGoal,
    goalIsTrusted,
};
