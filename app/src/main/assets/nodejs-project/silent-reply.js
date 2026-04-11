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

// Single source of truth: build all regexes from TOKEN so renaming the
// protocol token is a one-line change.
function escapeRegex(s) { return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'); }
const T = escapeRegex(TOKEN);

// Exact match — "SILENT_REPLY" with optional surrounding whitespace
const EXACT_REGEX = new RegExp(`^\\s*${T}\\s*$`, 'i');

// Trailing token (optionally preceded by whitespace or markdown emphasis stars)
const TRAILING_REGEX = new RegExp(`(?:^|\\s+|\\*+)${T}\\s*$`, 'gi');

// Two char-class fragments for boundary detection.
// - IDENT_CHAR includes underscore — used for OUTER boundary lookbehind/ahead
//   so legitimate identifiers like `MY_SILENT_REPLY_HANDLE` aren't mangled.
// - CONTENT_CHAR excludes underscore — used to detect "token glued to a word"
//   in the special `SILENT_REPLY_word` pass below.
//
// IMPORTANT: these use ASCII character classes, NOT Unicode property escapes
// (`\p{L}\p{N}`). The Unicode-property-escape form worked on desktop Node 22
// but crashed nodejs-mobile v18.20.4's V8 at module-load time with
// "Invalid property name in character class" (discovered 2026-04-11 when
// BAT-489 RC5 failed to start on device — the regex constructor threw during
// require() and the entire Node runtime failed to initialize).
//
// Trade-off: `\w` in JavaScript is ASCII-only (`[A-Za-z0-9_]`), so a non-ASCII
// letter adjacent to the token — e.g. `SILENT_REPLYこんにちは` — is NOT treated
// as a boundary hit and the token IS stripped, leaving `こんにちは`. That's
// the correct outcome for our use case (the model emits the token in ASCII
// and we want to strip it regardless of what follows). The identifier
// preservation case (`MY_SILENT_REPLY_HANDLE`) still works because the
// surrounding `_` IS in `\w` so the lookbehind fires.
const IDENT_CHAR = '\\w';           // [A-Za-z0-9_]
const CONTENT_CHAR = '[^\\W_]';     // [A-Za-z0-9] (word char minus underscore)

// Token attached to following content, anywhere in the text. Two alternations:
//   1. `SILENT_REPLY_` followed by letter/number → strip the trailing underscore too
//      (catches `SILENT_REPLY_hello` cleanly → `hello`)
//   2. `SILENT_REPLY` followed by any identifier char → strip just the token
//      (catches `SILENT_REPLYhello` → `hello`)
// Outer lookbehind requires non-identifier so identifiers like
// `MY_SILENT_REPLY_HANDLE` don't match (preceding `_` is in IDENT).
// Allows preceding repeated tokens ("SILENT_REPLY SILENT_REPLYhello").
const LEADING_ATTACHED_PATTERN = `(?<!${IDENT_CHAR})(?:${T}\\s+)*(?:${T}_(?=${CONTENT_CHAR})|${T}(?=${IDENT_CHAR}))`;
const LEADING_ATTACHED_REGEX = new RegExp(LEADING_ATTACHED_PATTERN, 'gi');
// Non-global twin used by .test() to avoid stateful lastIndex bugs.
const LEADING_ATTACHED_TEST = new RegExp(LEADING_ATTACHED_PATTERN, 'i');

// Leading with any whitespace after: "SILENT_REPLY The user..." or "SILENT_REPLY\nhello"
const LEADING_SPACED_REGEX = new RegExp(`^(?:\\s*${T})+\\s*`, 'i');

// Generic strip — matches the token in any position when not glued to an
// identifier char on EITHER side. Catches `Hello SILENT_REPLY world` and
// preserves underscore-containing identifiers like `MY_SILENT_REPLY_HANDLE`.
// NOTE: only used with .replace(). For .test() use TEST_REGEX (no /g flag) to
// avoid the stateful lastIndex bug.
const WORD_BOUNDARY_PATTERN = `(?<!${IDENT_CHAR})${T}(?!${IDENT_CHAR})`;
const WORD_BOUNDARY_REGEX = new RegExp(WORD_BOUNDARY_PATTERN, 'gi');
const TEST_REGEX = new RegExp(WORD_BOUNDARY_PATTERN, 'i');

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
    // Case-insensitive contains check — model may emit lowercase variants.
    if (!trimmed || !trimmed.startsWith('{') || !trimmed.endsWith('}') ||
        !trimmed.toUpperCase().includes(TOKEN.toUpperCase())) {
        return false;
    }
    try {
        const parsed = JSON.parse(trimmed);
        if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return false;
        const keys = Object.keys(parsed);
        return keys.length === 1 && keys[0] === 'action'
            && typeof parsed.action === 'string'
            // Case-insensitive comparison — matches the rest of the SILENT_REPLY
            // handling which uses /i flag throughout.
            && parsed.action.trim().toUpperCase() === TOKEN.toUpperCase();
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
    `(?<!${IDENT_CHAR})[\`*_~\\[\\]()<>]+\\s*${T}\\s*[\`*_~\\[\\]()<>]+`,
    'gi'
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
