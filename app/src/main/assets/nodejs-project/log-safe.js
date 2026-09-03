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
 * GUARANTEE: the returned string contains no character that java.util.regex
 * treats as a line terminator — \n, \r, U+2028 LINE SEPARATOR, U+2029 PARAGRAPH
 * SEPARATOR, U+0085 NEL. Stating it as "no \n and no \r" was too weak: the
 * property the Share-path sanitizer actually needs is about the JVM's line
 * model, not Node's. See log-safe.test.js.
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
    // not produce a wall of glyphs.
    //
    // The class must match JAVA's line terminators, not Node's. LogShareSanitizer
    // is a Kotlin/JVM regex: `.` does not match a line terminator and `$` anchors
    // before one, so a body containing U+2028 makes `(.*)$` unable to reach the end
    // of input and `messageMarker.matches()` fails outright. Kotlin's `lines()`
    // splits only on \r\n / \n / \r, so such a line is ALSO never split and never
    // reaches the `[redacted continuation]` fallback — it lands in the `else`
    // branch and ships verbatim.
    //
    // Verified on JBR 21 against the exact LogShareSanitizer patterns:
    //   plain space   matches=true  find=true   -> scrubbed
    //   U+2028/9/0085 matches=false find=false  -> BODY LEAKS   (this fix)
    //   U+000B/U+000C matches=true  find=true   -> scrubbed     (not line
    //     terminators to java.util.regex, so `.` matches them; deliberately NOT
    //     stripped — doing so would mangle output for no security gain)
    // Precedent for the wider class: ai.js strips U+2028/U+2029 for the same reason.
    out = out.replace(/[\r\n\u2028\u2029\u0085]+/g, NEWLINE_GLYPH);
    return truncated ? out + '...' : out;
}

/**
 * BAT-1310 / CodeRabbit on #454. The session banner is formatted HERE rather
 * than inline in config.js so it can be tested against REAL OUTPUT.
 *
 * The previous guard was a regex over config.js's source text. That cannot tell
 * a correct implementation from one that interpolates the raw value -- both
 * contain the same fragment -- so it was a test that could not fail for the
 * thing it existed to check. config.js cannot be required from a test (it reads
 * a real config.json at load), which is why this lives in a module that can.
 *
 * Every field is type-checked before interpolation. config.json is PERSISTED
 * STATE: hand-editable, corruptible, and possibly written by an older version,
 * so a value that parsed is not a value whose shape may be trusted. In
 * particular a string "false" must not read as a clean tree, and a non-string
 * identifier must not be stringified into the banner.
 */
function formatSessionBanner(cfg, appVersion, logFmt, pid) {
    const c = (cfg && typeof cfg === 'object') ? cfg : {};
    const str = (v, fallback) => (typeof v === 'string' && v.trim()) ? v.trim() : fallback;
    // Only a real boolean is an answer; everything else is "we do not know".
    const dirty = c.gitDirty === true ? 'true' : c.gitDirty === false ? 'false' : '?';
    return '=== SESSION boot=' + str(c.bootId, 'unknown') +
        ' build=' + str(c.gitSha, '?') +
        ' dirty=' + dirty +
        ' ver=' + str(appVersion, '?') +
        ' logfmt=' + logFmt +
        ' pid=' + pid + ' ===';
}

module.exports = { flattenForLog, NEWLINE_GLYPH, formatSessionBanner };
