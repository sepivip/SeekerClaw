// silent-reply.js — centralized silent-reply token handling.
//
// CANONICAL TOKEN: [[SILENT_REPLY]]  (double-bracketed, Wiki/Obsidian-link style)
//
// Why brackets? The original bare `SILENT_REPLY` string collided with natural
// English prose whenever the agent needed to *discuss* the protocol (e.g.
// answering "What is SILENT_REPLY?"). Our aggressive strip passes would eat
// legitimate mentions of the word inside sentences — the agent would write
// "SILENT_REPLY is a token used for..." and the user would see "is a token
// used for..." with the opening word removed. That over-strip was shipped
// accidentally in the BAT-488 parity port and caught during BAT-489 device
// testing.
//
// Disambiguation must be STRUCTURAL, not heuristic. The bracketed form
// [[SILENT_REPLY]] cannot appear in natural English prose — it looks like
// Wiki/Obsidian markup or a template variable, never a word. That
// structurally prevents collision: the agent would never write
// "[[SILENT_REPLY]] is a token used for..." in discussion.
//
// LEGACY COMPATIBILITY
// --------------------
// Existing agents (running older system prompts or mid-turn before they've
// adapted to the new canonical form) may still emit bare `SILENT_REPLY`. To
// protect those users' conversations, bare `SILENT_REPLY` is still honored
// as a sentinel — but ONLY when it is the entire trimmed message. Inline
// bare mentions in prose are never stripped, so discussion of the protocol
// passes through unchanged. This dual-recognition shim can be removed in a
// future release once telemetry confirms the bracketed form is reliable.
//
// Variants that must all be stripped from mixed-content text:
//   1. Right-glued:      "[[SILENT_REPLY]]hello"        → "hello"
//   2. Left-glued:       "OK[[SILENT_REPLY]]"           → "OK"
//   3. Both-sides glued: "foo[[SILENT_REPLY]]bar"       → "foobar"
//   4. Mid-token spaced: "Hello [[SILENT_REPLY]] world" → "Hello world"
//                        (surrounding spaces collapse to ONE space, not two)
//   5. Markdown wrapped: "**[[SILENT_REPLY]]**"         → ""
//   6. JSON envelope:    '{"action":"[[SILENT_REPLY]]"}' → ""
//   7. Leading spaced:   "[[SILENT_REPLY]] hello"       → "hello"
//
// The previous iteration of this file (bare `SILENT_REPLY`, BAT-488 port)
// used ASCII `\w` lookbehind/lookahead boundaries to prevent false matches
// inside identifiers like `MY_SILENT_REPLY_HANDLE`. That concern is moot
// with the bracketed form — `[[` and `]]` cannot appear in any legitimate
// identifier — so the canonical strip now uses plain literal matching
// without boundary constraints. This catches the glued-left variant
// (e.g. `OK[[SILENT_REPLY]]`) that the boundary-constrained form would
// leak to the user (flagged by Copilot round 1 on PR #324).

// The canonical sentinel. Wiki-link style: `[[...]]` cannot appear in
// natural English prose, so the agent can freely say "the silent reply
// token" or "SILENT_REPLY" (bare) in discussion without being over-stripped.
const TOKEN = '[[SILENT_REPLY]]';

// Legacy bare form — honored only as a whole-message match, never inline.
const LEGACY_BARE_TOKEN = 'SILENT_REPLY';

// Single source of truth: build all regexes from TOKEN so renaming the
// protocol token is a one-line change. escapeRegex handles the `[` and `]`
// metacharacters in the canonical form so they become literal in patterns.
function escapeRegex(s) { return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'); }
const T = escapeRegex(TOKEN);
const LT = escapeRegex(LEGACY_BARE_TOKEN);

// Exact match of the CANONICAL form — "[[SILENT_REPLY]]" with optional
// surrounding whitespace. Case-insensitive.
const EXACT_REGEX = new RegExp(`^\\s*${T}\\s*$`, 'i');

// Exact match of the LEGACY bare form — whole-message only. This is the
// dual-recognition safety net for agents that still emit bare SILENT_REPLY
// as a standalone message. Inline bare is intentionally NOT matched.
const LEGACY_BARE_EXACT_REGEX = new RegExp(`^\\s*${LT}\\s*$`, 'i');

// Whole-message markdown-wrapped LEGACY bare form. The old silent-reply
// module used to strip `**SILENT_REPLY**`, `` `SILENT_REPLY` ``,
// `_SILENT_REPLY_`, etc. as sentinels — an agent running an older system
// prompt may still emit these as their entire message. We preserve that
// behavior BUT only for whole-message matches, so an agent that writes
// "When I say **SILENT_REPLY** I mean stay quiet" in normal prose is NOT
// over-stripped (that's discussion, same as bare inline).
//
// The wrapper char class matches MARKDOWN_WRAPPED_REGEX's below so the
// set of accepted wrapper forms is consistent across canonical and legacy.
const LEGACY_BARE_WRAPPED_EXACT_REGEX = new RegExp(
    `^[\\s\`*_~\\[\\]()<>]*${LT}[\\s\`*_~\\[\\]()<>]*$`,
    'i'
);

// Plain literal canonical strip — matches `[[SILENT_REPLY]]` wherever it
// appears in the text, case-insensitive, no boundary constraints.
//
// WHY NO BOUNDARIES:
//   The bracketed form is structurally unambiguous — `[[` and `]]` never
//   appear in natural prose or legitimate identifiers, so there is no
//   false-match surface to protect against. Left- and right-glued cases
//   like `OK[[SILENT_REPLY]]` or `foo[[SILENT_REPLY]]bar` are always
//   model-output bugs, and we WANT to strip them so the user doesn't see
//   the sentinel leak. Adding word-boundary lookbehind/lookahead would
//   cause those cases to silently leak (flagged by Copilot round 1 on
//   PR #324: `OK[[SILENT_REPLY]]` wasn't being stripped because `K` is a
//   word char).
//
// The caller still handles markdown orphans and leading-whitespace trim
// via MARKDOWN_WRAPPED_REGEX and LEADING_SPACED_REGEX below.
//
// The strip pattern captures adjacent horizontal whitespace (space/tab,
// NOT newlines) on both sides so stripSilentReply can collapse
// "Hello [[SILENT_REPLY]] world" to "Hello world" (single space) instead
// of "Hello  world" (double space left behind by a naked token strip).
// The replacer logic lives in stripSilentReply — see the comment there.
// Newlines are deliberately NOT in the boundary class so multi-line
// structure is preserved: `Line 1\n[[SILENT_REPLY]]\nLine 2` → the token
// is removed but the newlines stay, giving `Line 1\n\nLine 2`.
const CANONICAL_STRIP_REGEX = new RegExp(`([ \\t]*)${T}([ \\t]*)`, 'gi');
// Non-global twin for .test() — avoids the stateful lastIndex bug that
// /g regexes have when reused across calls.
const CANONICAL_TEST_REGEX = new RegExp(T, 'i');

// Leading canonical form with whitespace after, repeated occurrences:
// "[[SILENT_REPLY]] [[SILENT_REPLY]] hello" → "hello". This pass exists
// to collapse repeated leading sentinels into a clean trim; the main
// CANONICAL_STRIP_REGEX above would leave double spaces behind otherwise.
const LEADING_SPACED_REGEX = new RegExp(`^(?:\\s*${T})+\\s*`, 'i');

// Markdown-wrapped canonical variants:
//   **[[SILENT_REPLY]]**, *[[SILENT_REPLY]]*, `[[SILENT_REPLY]]`,
//   ```[[SILENT_REPLY]]```, _[[SILENT_REPLY]]_, etc.
// Matches the token plus its surrounding wrapper chars in one pass so we
// don't leave behind orphan punctuation like `****` or `\`\``. No left
// boundary constraint — same rationale as CANONICAL_STRIP_REGEX.
const MARKDOWN_WRAPPED_REGEX = new RegExp(
    `[\`*_~\\[\\]()<>]+\\s*${T}\\s*[\`*_~\\[\\]()<>]+`,
    'gi'
);

// "Empty after strip" check — if the only thing left is whitespace and
// markdown punctuation (no actual content), treat as fully silent. Prevents
// orphan `****` / `\`\`` / `[]` from being sent to the user when the model
// emits a markdown-wrapped variant the regex pass missed.
const ONLY_MARKDOWN_PUNCT_REGEX = /^[\s`*_~\[\]()<>]*$/;

/**
 * Exact silent-reply check. True when the entire (trimmed) text is:
 *   - the canonical `[[SILENT_REPLY]]` token (EXACT_REGEX), OR
 *   - the legacy bare `SILENT_REPLY` token (LEGACY_BARE_EXACT_REGEX), OR
 *   - a markdown-wrapped legacy form like `**SILENT_REPLY**` or
 *     `` `SILENT_REPLY` `` as the WHOLE message
 *     (LEGACY_BARE_WRAPPED_EXACT_REGEX)
 *
 * Inline bare mentions of SILENT_REPLY in prose return FALSE — that's
 * discussion, not a sentinel.
 */
function isSilentReplyText(text) {
    if (!text) return false;
    return EXACT_REGEX.test(text)
        || LEGACY_BARE_EXACT_REGEX.test(text)
        || LEGACY_BARE_WRAPPED_EXACT_REGEX.test(text);
}

/**
 * JSON envelope check — catches `{"action":"[[SILENT_REPLY]]"}` OR the
 * legacy `{"action":"SILENT_REPLY"}` shape. Some models emit structured
 * output instead of the bare token.
 */
function isSilentReplyEnvelopeText(text) {
    if (!text) return false;
    const trimmed = text.trim();
    if (!trimmed || !trimmed.startsWith('{') || !trimmed.endsWith('}')) return false;
    const upper = trimmed.toUpperCase();
    // Early reject if neither form appears anywhere in the string — saves
    // the JSON.parse cost on normal JSON payloads.
    if (!upper.includes(TOKEN.toUpperCase()) &&
        !upper.includes(LEGACY_BARE_TOKEN.toUpperCase())) {
        return false;
    }
    try {
        const parsed = JSON.parse(trimmed);
        if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return false;
        const keys = Object.keys(parsed);
        if (keys.length !== 1 || keys[0] !== 'action') return false;
        if (typeof parsed.action !== 'string') return false;
        const action = parsed.action.trim().toUpperCase();
        return action === TOKEN.toUpperCase() ||
               action === LEGACY_BARE_TOKEN.toUpperCase();
    } catch (_) {
        return false;
    }
}

/**
 * Full silent-reply check — exact token (canonical or legacy) OR JSON
 * envelope. Use this at send gates where either form should suppress the
 * outbound message.
 */
function isSilentReplyPayloadText(text) {
    return isSilentReplyText(text) || isSilentReplyEnvelopeText(text);
}

/**
 * Strip all canonical silent-reply occurrences from mixed-content text.
 *
 * Order matters:
 *   1. JSON envelope short-circuit (otherwise token strip leaves a mangled
 *      `{"action":""}` string)
 *   2. Legacy bare whole-message short-circuit (safety net for agents that
 *      still emit the bare form as their entire message)
 *   3. Legacy bare markdown-wrapped whole-message short-circuit — catches
 *      `**SILENT_REPLY**`, `` `SILENT_REPLY` ``, `_SILENT_REPLY_`, etc.
 *      when they are the ENTIRE message. Older agents running the pre-
 *      BAT-491 system prompt may still emit these.
 *   4. Markdown-wrapped canonical pass — strips wrapper+token+wrapper
 *      atoms together so we don't leave behind orphan `****` or `\`\``
 *   5. Leading-spaced pass — collapses repeated leading sentinels plus
 *      their trailing whitespace so the result trims cleanly
 *   6. Plain canonical strip — removes every remaining `[[SILENT_REPLY]]`
 *      occurrence anywhere in the text, left-glued / right-glued / mid /
 *      end — no boundary constraints because the bracketed form is
 *      structurally unambiguous
 *
 * Bare `SILENT_REPLY` inline in prose is DELIBERATELY NOT stripped. That's
 * the whole point of the rename — discussion of the protocol passes
 * through unchanged. The trade-off: if an older agent falls back to bare
 * inline (e.g. "Handled it. SILENT_REPLY"), the user sees it raw. Rare
 * and recoverable, vs. the over-strip bug which was a certainty.
 *
 * An empty result means the entire message should be treated as silent.
 */
function stripSilentReply(text) {
    if (!text) return '';
    if (isSilentReplyEnvelopeText(text)) return '';
    if (LEGACY_BARE_EXACT_REGEX.test(text)) return '';
    // Legacy whole-message markdown-wrapped form (`**SILENT_REPLY**`,
    // `` `SILENT_REPLY` ``, etc.) — older agents may still emit this.
    // Only strips when the entire message is the wrapped bare token;
    // inline wrapped bare in prose still passes through as discussion.
    if (LEGACY_BARE_WRAPPED_EXACT_REGEX.test(text)) return '';
    const stripped = text
        .replace(MARKDOWN_WRAPPED_REGEX, '')
        .replace(LEADING_SPACED_REGEX, '')
        // Replacer collapses surrounding horizontal whitespace:
        //   "Hello [[SILENT_REPLY]] world"  → "Hello world"   (both sides → 1 space)
        //   "done[[SILENT_REPLY]] and more" → "done and more" (trailing only → 1 space)
        //   "hello [[SILENT_REPLY]]"        → "hello"         (leading only → 1 space, then .trim())
        //   "OK[[SILENT_REPLY]]bar"          → "OKbar"         (neither side → empty)
        //   "foo[[SILENT_REPLY]]bar"         → "foobar"        (neither side → empty)
        //   "Handled it.[[SILENT_REPLY]]"   → "Handled it."   (neither side → empty)
        // Rule: if EITHER side has horizontal whitespace, emit a single
        // space so word boundaries are preserved. Only when there is NO
        // whitespace on either side (glued case) do we emit empty. This
        // prevents the "double space left behind by a naked strip" output
        // bug Copilot flagged on PR #324 round 2 while still handling the
        // fully-glued variants from round 1 correctly.
        .replace(CANONICAL_STRIP_REGEX, (_match, before, after) => {
            if (before || after) return ' ';
            return '';
        })
        .trim();
    // If the model wrapped the token in markdown and only orphan punctuation
    // remains, treat the whole message as silent.
    if (ONLY_MARKDOWN_PUNCT_REGEX.test(stripped)) return '';
    return stripped;
}

/**
 * Quick "contains any silent-reply signal form" check for logging/audit hooks.
 *
 * Returns true when:
 *   - The canonical `[[SILENT_REPLY]]` token appears ANYWHERE in the text
 *     (inline, left-glued, right-glued, mid, wrapped — no boundary check)
 *   - The legacy bare `SILENT_REPLY` form is the ENTIRE trimmed message
 *   - A JSON envelope form is present (canonical or legacy inner action)
 *
 * Inline bare `SILENT_REPLY` in prose returns FALSE — that's discussion,
 * not a signal.
 */
function containsSilentReply(text) {
    if (!text) return false;
    return CANONICAL_TEST_REGEX.test(text)
        || LEGACY_BARE_EXACT_REGEX.test(text)
        || LEGACY_BARE_WRAPPED_EXACT_REGEX.test(text)
        || isSilentReplyEnvelopeText(text);
}

module.exports = {
    TOKEN,
    LEGACY_BARE_TOKEN,
    isSilentReplyText,
    isSilentReplyEnvelopeText,
    isSilentReplyPayloadText,
    stripSilentReply,
    containsSilentReply,
};
