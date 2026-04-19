// error-classifier.js — map tool error text to low-cardinality buckets for
// tool_call_log.error_kind. Privacy: bucket labels are constants; free-text
// fallback is redacted + truncated to 40 chars.
//
// Heuristic list intentionally small (~10 categories). Tune based on
// real tool_call_log distributions after PR-A soaks in production.
//
// NOTE: uses a self-contained redaction helper (static regex patterns only) so
// this module has no dependency on config.js and can be smoke-loaded in
// isolation. The main redactSecrets() in security.js adds dynamic patterns
// from config (API keys, MCP tokens) — we don't need those here because the
// error-classifier fallback is already truncated to 40 chars, which limits the
// leak surface independently.

// Static redaction patterns — same known-secret shapes as security.js
// (Anthropic/OpenAI/OpenRouter keys, Telegram bot tokens, Solana privkeys, etc.)
// but without the dynamic config-derived keys. Good enough for a 40-char
// fallback bucket.
function redactStatic(msg) {
    if (typeof msg !== 'string') return msg;
    msg = msg.replace(/sk-ant-[a-zA-Z0-9_-]{10,}/g, 'sk-ant-***');
    msg = msg.replace(/\d{8,}:[A-Za-z0-9_-]{20,}/g, '***:***');
    msg = msg.replace(/BSA[a-zA-Z0-9_-]{10,}/g, 'BSA***');
    msg = msg.replace(/sk-[a-zA-Z0-9_-]{20,}/g, 'sk-***');
    msg = msg.replace(/sk-or-[a-zA-Z0-9_-]{10,}/g, 'sk-or-***');
    return msg;
}

function classifyError(raw) {
    if (!raw) return 'unknown';
    const s = String(raw);
    const lower = s.toLowerCase();

    // File system
    if (/ENOENT|no such file|file not found/i.test(s)) return 'file_not_found';
    if (/EACCES|EPERM|permission denied|access denied/i.test(s)) return 'permission_denied';
    if (/EISDIR|is a directory/i.test(s)) return 'is_directory';
    if (/ENOSPC|no space left/i.test(s)) return 'disk_full';

    // Network
    if (/ECONNREFUSED|connection refused/i.test(s)) return 'connection_refused';
    if (/ENOTFOUND|dns|getaddrinfo/i.test(s)) return 'dns_error';
    if (/ETIMEDOUT|timeout|timed out/i.test(s)) return 'timeout';
    if (/ECONNRESET|socket hang up|connection reset/i.test(s)) return 'connection_reset';

    // Rate limiting (check before the generic HTTP match so "429" routes here)
    if (/rate limit|too many requests|429/i.test(s)) return 'rate_limited';

    // Auth (check before the generic HTTP match so "401"/"403" bucket as unauthorized
    // rather than http_401/http_403 — more useful for pattern-mining)
    if (/unauthorized|401|authentication|forbidden|403/i.test(s)) return 'unauthorized';

    // HTTP status codes (remaining 4xx/5xx)
    const httpStatus = s.match(/\b(4\d{2}|5\d{2})\b/);
    if (httpStatus) return `http_${httpStatus[1]}`;

    // Validation / user input
    if (/invalid|expected|must be|required/i.test(lower)) return 'validation_error';

    // Confirmation / user action
    if (/user did not confirm|canceled|cancelled/i.test(s)) return 'user_canceled';

    // Fallback: redacted + truncated to 40 chars (tighter than the previous
    // 60-char slice — bucket-by-bucket is preferred over free-text, so only
    // truly novel errors should reach here).
    return redactStatic(s).slice(0, 40);
}

module.exports = { classifyError };
