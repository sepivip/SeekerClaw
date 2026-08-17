/**
 * log-safe.js — helpers for putting UNTRUSTED text into a log line (BAT-1247).
 *
 * Pure and dependency-free on purpose: the invariant below is security-relevant,
 * so it has to be testable without standing up message-handler's dependency
 * graph (same rationale as history-trim.js).
 *
 * ── Why flattening matters ────────────────────────────────────────────────
 * `log()` in config.js frames a multiline message as one wire record PER
 * physical line (`LEVEL|epochMs|<line>`), because BAT-1161 requires every
 * forwarded line to be a complete, parseable record. SeekerClawService then
 * turns each record into its own LogEntry, and LogsScreen renders each one with
 * a full "[LEVEL] [time] [Node] " header.
 *
 * That is correct for diagnostics (a stack trace SHOULD split into readable
 * lines) but dangerous for user text. The Share-sheet sanitizer
 * (LogShareSanitizer.kt) is line-based: it scrubs the segment after a
 * `Message: ` marker, then treats following lines as body continuation only
 * until it sees a real entry header. If a user's multiline message is split
 * into N records, lines 2..N arrive wearing genuine headers — indistinguishable
 * from real console entries — so the sanitizer stops scrubbing and the rest of
 * the body ships off-device verbatim.
 *
 * Flattening before `log()` keeps the whole preview inside ONE record, behind
 * the marker, where the sanitizer can replace it wholesale.
 */

'use strict';

/** What a line break becomes. Visible, unambiguous, and not the `|` wire delimiter. */
const NEWLINE_GLYPH = ' ⏎ ';

/**
 * Collapse `text` to a single physical line, optionally truncating first.
 *
 * Truncation happens BEFORE flattening so `maxChars` still measures what the
 * user actually typed rather than the substituted glyphs. Returns '' for
 * non-strings and empty input — callers supply their own "(no text)" wording.
 *
 * GUARANTEE: the returned string contains no '\n' and no '\r'. That is the
 * property the Share-path sanitizer depends on; see log-safe.test.js.
 *
 * @param {string} text        untrusted input (a chat body, a goal, …)
 * @param {number} [maxChars]  optional cap; an ellipsis is appended if it bites
 * @returns {string}
 */
function flattenForLog(text, maxChars) {
    if (typeof text !== 'string' || text === '') return '';
    let out = text;
    let truncated = false;
    if (typeof maxChars === 'number' && maxChars >= 0 && out.length > maxChars) {
        out = out.slice(0, maxChars);
        truncated = true;
    }
    // One glyph per RUN of line breaks, so a blank line between paragraphs does
    // not produce a wall of glyphs. Covers \n, \r\n, and lone \r.
    out = out.replace(/[\r\n]+/g, NEWLINE_GLYPH);
    return truncated ? out + '...' : out;
}

module.exports = { flattenForLog, NEWLINE_GLYPH };
