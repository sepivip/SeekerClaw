// silent-reply.js — centralized SILENT_REPLY token handling.
//
// Ported from OpenClaw's src/auto-reply/tokens.ts (v2026.4.10). We keep the
// legacy SILENT_REPLY token instead of upstream's NO_REPLY so existing user
// prompts/memory continue to work.
//
// Handles failure modes the old `\bSILENT_REPLY\b` regex missed:
//   1. Leading glued:    "SILENT_REPLYhello"        — \b fails between word chars
//   2. Mid-glued:        "Hello SILENT_REPLYworld"  — same \b failure mid-message
//   3. Underscore-glued: "SILENT_REPLY_hello"       — _ is a word char, \b fails
//   4. Markdown wrapped: "**SILENT_REPLY**"         — leaves orphan punctuation
//   5. JSON envelope:    '{"action":"SILENT_REPLY"}' — model emits structured form
//   6. Leading spaced:   "SILENT_REPLY hello"       — \b ok but cleaner with own pass
//
// Boundaries use identifier-aware lookbehind/lookahead instead of `\b` so all
// of the above strip cleanly without stripping legitimate identifier matches
// like `MY_SILENT_REPLY_HANDLE`.

const TOKEN = 'SILENT_REPLY';

// Exact match — "SILENT_REPLY" with optional surrounding whitespace
const EXACT_REGEX = /^\s*SILENT_REPLY\s*$/i;

// Trailing token (optionally preceded by whitespace or markdown emphasis stars)
const TRAILING_REGEX = /(?:^|\s+|\*+)SILENT_REPLY\s*$/gi;

// Letter-or-number class (NO underscore). Used by lookbehind/lookahead to
// detect identifier boundaries without `\b` (which fails between word chars).
// Underscore is excluded because we want `_` to count as a strip boundary so
// `SILENT_REPLY_hello` strips cleanly instead of being treated as one ident.
const LN = '[\\p{L}\\p{N}]';

// Token attached to following letter/number content, anywhere in the text:
// matches "SILENT_REPLYhello" at start AND "Hello SILENT_REPLYworld" mid-message.
// Lookbehind ensures the token isn't itself glued to a preceding letter/number.
// Allows preceding repeated tokens ("SILENT_REPLY SILENT_REPLYhello").
const LEADING_ATTACHED_REGEX = new RegExp(
    `(?<!${LN})(?:SILENT_REPLY\\s+)*SILENT_REPLY(?=${LN})`,
    'giu'
);
// Non-global twin used by .test() to avoid stateful lastIndex bugs.
const LEADING_ATTACHED_TEST = new RegExp(
    `(?<!${LN})(?:SILENT_REPLY\\s+)*SILENT_REPLY(?=${LN})`,
    'iu'
);

// Leading with any whitespace after: "SILENT_REPLY The user..." or "SILENT_REPLY\nhello"
const LEADING_SPACED_REGEX = /^(?:\s*SILENT_REPLY)+\s*/i;

// Generic strip — matches the token in any position when not glued to a
// letter/number on EITHER side. Catches `Hello SILENT_REPLY world` and the
// word-boundary mid-cases.
// NOTE: only used with .replace(). For .test() use TEST_REGEX (no /g flag) to
// avoid the stateful lastIndex bug.
const WORD_BOUNDARY_REGEX = new RegExp(`(?<!${LN})SILENT_REPLY(?!${LN})`, 'giu');
const TEST_REGEX = new RegExp(`(?<!${LN})SILENT_REPLY(?!${LN})`, 'iu');

/**
 * Exact silent-reply check. True only when the entire (trimmed) text is just
 * the token. Used for "should we reply at all?" gating.
 */
function isSilentReplyText(text) {
    if (!text) return false;
    return EXACT_REGEX.test(text);
}

/**
 * JSON envelope check — catches `{"action":"SILENT_REPLY"}` shape. Some models
 * emit structured output instead of the bare token.
 */
function isSilentReplyEnvelopeText(text) {
    if (!text) return false;
    const trimmed = text.trim();
    if (!trimmed || !trimmed.startsWith('{') || !trimmed.endsWith('}') || !trimmed.includes(TOKEN)) {
        return false;
    }
    try {
        const parsed = JSON.parse(trimmed);
        if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return false;
        const keys = Object.keys(parsed);
        return keys.length === 1 && keys[0] === 'action'
            && typeof parsed.action === 'string' && parsed.action.trim() === TOKEN;
    } catch (_) {
        return false;
    }
}

/**
 * Full silent-reply check — exact token OR JSON envelope. Use this at send
 * gates where either form should suppress the outbound message.
 */
function isSilentReplyPayloadText(text) {
    return isSilentReplyText(text) || isSilentReplyEnvelopeText(text);
}

// Markdown-wrapped variants the system prompt explicitly calls out as wrong:
//   **SILENT_REPLY**, *SILENT_REPLY*, `SILENT_REPLY`, ```SILENT_REPLY```,
//   _SILENT_REPLY_, [SILENT_REPLY], (SILENT_REPLY), <SILENT_REPLY>, ~SILENT_REPLY~
// Lookbehind anchors the opening wrapper to a non-letter/number context so we
// don't grab `_SILENT_REPLY_` out of `MY_SILENT_REPLY_HANDLE` (legitimate
// identifier). Match the token + its surrounding wrapper chars in one pass so
// we don't leave behind orphan punctuation like `****` or `\`\``.
const MARKDOWN_WRAPPED_REGEX = new RegExp(
    `(?<!${LN})[\`*_~\\[\\]()<>]+\\s*SILENT_REPLY\\s*[\`*_~\\[\\]()<>]+`,
    'giu'
);

// "Empty after strip" check — if the only thing left is whitespace and
// markdown punctuation (no actual content), treat as fully silent. Prevents
// orphan `****` / `\`\`` / `[]` from being sent to the user when the model
// emits a markdown-wrapped variant the regex pass missed.
const ONLY_MARKDOWN_PUNCT_REGEX = /^[\s`*_~\[\]()<>]*$/;

/**
 * Strip all SILENT_REPLY occurrences from mixed-content text. Runs the passes
 * in order: JSON envelope short-circuit → markdown-wrapped → leading-attached →
 * leading-spaced → trailing → word-boundary. Returns the cleaned text (trimmed).
 * An empty result means the entire message should be treated as silent.
 *
 * Short-circuits to '' for:
 *   - Exact `{"action":"SILENT_REPLY"}` envelope (otherwise the token strip
 *     would leave a mangled `{"action":""}` JSON string)
 *   - Result that is only whitespace + markdown punctuation after stripping
 *     (otherwise `**SILENT_REPLY**` would leave orphan `****`)
 *
 * Replaces the old inline pattern:
 *   .replace(/(?:^|\s+|\*+)SILENT_REPLY\s*$/gi, '').replace(/\bSILENT_REPLY\b/gi, '')
 * which missed leading-attached, JSON envelope, and markdown-wrapped cases.
 */
function stripSilentReply(text) {
    if (!text) return '';
    if (isSilentReplyEnvelopeText(text)) return '';
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
 * Quick "contains any silent-reply form" check for logging/audit hooks.
 * Uses the non-global TEST_REGEX so repeated calls aren't stateful via
 * lastIndex (which would flip true→false intermittently with /g).
 * Also catches the leading-attached form (`SILENT_REPLYhello`) and the
 * JSON envelope form so audit logs match what stripSilentReply() can strip.
 */
function containsSilentReply(text) {
    if (!text) return false;
    return TEST_REGEX.test(text)
        || LEADING_ATTACHED_TEST.test(text)
        || isSilentReplyEnvelopeText(text);
}

module.exports = {
    TOKEN,
    isSilentReplyText,
    isSilentReplyEnvelopeText,
    isSilentReplyPayloadText,
    stripSilentReply,
    containsSilentReply,
};
