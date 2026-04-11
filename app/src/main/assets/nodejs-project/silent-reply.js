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
// Handles failure modes the old `\b[[SILENT_REPLY]]\b` regex would miss:
//   1. Leading glued:    "[[SILENT_REPLY]]hello"        → "hello"
//   2. Mid-glued:        "Hello [[SILENT_REPLY]]world"  → "Hello world"
//   3. Markdown wrapped: "**[[SILENT_REPLY]]**"         → ""
//   4. JSON envelope:    '{"action":"[[SILENT_REPLY]]"}' → ""
//   5. Leading spaced:   "[[SILENT_REPLY]] hello"       → "hello"
//
// Boundaries use ASCII `\w` lookbehind/lookahead (not Unicode property
// escapes — those crash nodejs-mobile's V8 at module-load time; see the
// BAT-489 comment in the earlier iteration for the full story).

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

// Trailing canonical token (optionally preceded by whitespace or markdown
// emphasis stars). Matches `something [[SILENT_REPLY]]` at end of message.
const TRAILING_REGEX = new RegExp(`(?:^|\\s+|\\*+)${T}\\s*$`, 'gi');

// ASCII boundary fragments. Identical to BAT-489's rewrite — no Unicode
// property escapes (those crash nodejs-mobile v18.20.4's V8).
const IDENT_CHAR = '\\w';           // [A-Za-z0-9_]
const CONTENT_CHAR = '[^\\W_]';     // [A-Za-z0-9]

// Canonical token attached to following content (e.g. `[[SILENT_REPLY]]hello`).
// The lookahead `(?=${IDENT_CHAR})` catches the glue; the outer lookbehind
// `(?<!${IDENT_CHAR})` anchors the start to a non-word context so we don't
// match inside a larger identifier. Two alternations handle the edge case
// where the token has a trailing underscore glued to content.
const LEADING_ATTACHED_PATTERN = `(?<!${IDENT_CHAR})(?:${T}\\s+)*(?:${T}_(?=${CONTENT_CHAR})|${T}(?=${IDENT_CHAR}))`;
const LEADING_ATTACHED_REGEX = new RegExp(LEADING_ATTACHED_PATTERN, 'gi');
const LEADING_ATTACHED_TEST = new RegExp(LEADING_ATTACHED_PATTERN, 'i');

// Leading canonical form with whitespace after: "[[SILENT_REPLY]] The user..."
// or "[[SILENT_REPLY]]\nhello".
const LEADING_SPACED_REGEX = new RegExp(`^(?:\\s*${T})+\\s*`, 'i');

// Generic strip — canonical token in any position when not glued to an
// identifier char on EITHER side. Catches `Hello [[SILENT_REPLY]] world`.
// IMPORTANT: this only targets the bracketed canonical form. Bare
// `SILENT_REPLY` inline in prose is NEVER stripped by this regex (or any
// other in this file), which is the entire point of the rename.
const WORD_BOUNDARY_PATTERN = `(?<!${IDENT_CHAR})${T}(?!${IDENT_CHAR})`;
const WORD_BOUNDARY_REGEX = new RegExp(WORD_BOUNDARY_PATTERN, 'gi');
const TEST_REGEX = new RegExp(WORD_BOUNDARY_PATTERN, 'i');

// Markdown-wrapped canonical variants:
//   **[[SILENT_REPLY]]**, *[[SILENT_REPLY]]*, `[[SILENT_REPLY]]`,
//   ```[[SILENT_REPLY]]```, _[[SILENT_REPLY]]_, etc. Match the token plus
//   its surrounding wrapper chars in one pass so we don't leave behind
//   orphan punctuation like `****` or `\`\``.
const MARKDOWN_WRAPPED_REGEX = new RegExp(
    `(?<!${IDENT_CHAR})[\`*_~\\[\\]()<>]+\\s*${T}\\s*[\`*_~\\[\\]()<>]+`,
    'gi'
);

// "Empty after strip" check — if the only thing left is whitespace and
// markdown punctuation (no actual content), treat as fully silent. Prevents
// orphan `****` / `\`\`` / `[]` from being sent to the user when the model
// emits a markdown-wrapped variant the regex pass missed.
const ONLY_MARKDOWN_PUNCT_REGEX = /^[\s`*_~\[\]()<>]*$/;

/**
 * Exact silent-reply check. True when the entire (trimmed) text is the
 * canonical `[[SILENT_REPLY]]` token OR the legacy bare `SILENT_REPLY`
 * token. Used for "should we reply at all?" gating.
 *
 * Inline bare mentions of SILENT_REPLY in prose return FALSE — that's
 * discussion, not a sentinel.
 */
function isSilentReplyText(text) {
    if (!text) return false;
    return EXACT_REGEX.test(text) || LEGACY_BARE_EXACT_REGEX.test(text);
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
 *   3. Markdown-wrapped → leading-attached → leading-spaced → trailing →
 *      word-boundary passes, ALL targeting the canonical bracketed form only
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
    const stripped = text
        .replace(MARKDOWN_WRAPPED_REGEX, '')
        .replace(LEADING_ATTACHED_REGEX, '')
        .replace(LEADING_SPACED_REGEX, '')
        .replace(TRAILING_REGEX, '')
        .replace(WORD_BOUNDARY_REGEX, '')
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
 *   - The canonical `[[SILENT_REPLY]]` token appears (inline, glued, or wrapped)
 *   - The legacy bare `SILENT_REPLY` form is the ENTIRE trimmed message
 *   - A JSON envelope form is present (canonical or legacy inner action)
 *
 * Inline bare `SILENT_REPLY` in prose returns FALSE — that's discussion,
 * not a signal.
 */
function containsSilentReply(text) {
    if (!text) return false;
    return TEST_REGEX.test(text)
        || LEADING_ATTACHED_TEST.test(text)
        || LEGACY_BARE_EXACT_REGEX.test(text)
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
