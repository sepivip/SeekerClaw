// silent-reply.js — centralized SILENT_REPLY token handling.
//
// Ported from OpenClaw's src/auto-reply/tokens.ts (v2026.4.10). We keep the
// legacy SILENT_REPLY token instead of upstream's NO_REPLY so existing user
// prompts/memory continue to work.
//
// Handles three failure modes the old `\bSILENT_REPLY\b` regex missed:
//   1. Leading glued:  "SILENT_REPLYhello"   — \b fails between two word chars
//   2. Leading spaced: "SILENT_REPLY hello"  — picked up by \b but stripped cleanly
//   3. JSON envelope:  '{"action":"SILENT_REPLY"}' — model sometimes emits this

const TOKEN = 'SILENT_REPLY';

// Exact match — "SILENT_REPLY" with optional surrounding whitespace
const EXACT_REGEX = /^\s*SILENT_REPLY\s*$/i;

// Trailing token (optionally preceded by whitespace or markdown emphasis stars)
const TRAILING_REGEX = /(?:^|\s+|\*+)SILENT_REPLY\s*$/gi;

// Leading-attached: "SILENT_REPLYhello" — final token glued to word/number content.
// \p{L}=letter, \p{N}=number. `iu` flags for case-insensitive + Unicode.
const LEADING_ATTACHED_REGEX = /^\s*(?:SILENT_REPLY\s+)*SILENT_REPLY(?=[\p{L}\p{N}])/iu;

// Leading with any whitespace after: "SILENT_REPLY The user..." or "SILENT_REPLY\nhello"
const LEADING_SPACED_REGEX = /^(?:\s*SILENT_REPLY)+\s*/i;

// Generic word-boundary strip — catches mid-message tokens after specific cases
const WORD_BOUNDARY_REGEX = /\bSILENT_REPLY\b/gi;

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

/**
 * Strip all SILENT_REPLY occurrences from mixed-content text. Runs the four
 * passes in order: leading-attached → leading-spaced → trailing → word-boundary.
 * Returns the cleaned text (trimmed). An empty result means the entire message
 * should be treated as silent.
 *
 * Replaces the old inline pattern:
 *   .replace(/(?:^|\s+|\*+)SILENT_REPLY\s*$/gi, '').replace(/\bSILENT_REPLY\b/gi, '')
 * which missed leading-attached and JSON envelope cases.
 */
function stripSilentReply(text) {
    if (!text) return '';
    return text
        .replace(LEADING_ATTACHED_REGEX, '')
        .replace(LEADING_SPACED_REGEX, '')
        .replace(TRAILING_REGEX, '')
        .replace(WORD_BOUNDARY_REGEX, '')
        .trim();
}

/**
 * Quick "contains any silent-reply form" check for logging/audit hooks.
 */
function containsSilentReply(text) {
    if (!text) return false;
    return WORD_BOUNDARY_REGEX.test(text) || isSilentReplyEnvelopeText(text);
}

module.exports = {
    TOKEN,
    isSilentReplyText,
    isSilentReplyEnvelopeText,
    isSilentReplyPayloadText,
    stripSilentReply,
    containsSilentReply,
};
