// error-classifier.js — map tool error text to a low-cardinality, privacy-safe
// bucket for tool_call_log.error_kind. All returns are constants from a fixed
// enum of ~14 buckets + 'unknown' + 'other'. No free-text, no user-derived strings.
//
// Heuristic list intentionally small. Tune based on real tool_call_log
// distributions after PR-A soaks in production.

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

    // HTTP status. Allowlist common codes to keep error_kind low-cardinality;
    // unknown 4xx/5xx collapse to http_4xx / http_5xx.
    const httpStatus = s.match(/\b(4\d{2}|5\d{2})\b/);
    if (httpStatus) {
        const code = httpStatus[1];
        const allowlist = new Set(['400','401','403','404','409','422','429','500','502','503','504']);
        if (allowlist.has(code)) return `http_${code}`;
        return code[0] === '4' ? 'http_4xx' : 'http_5xx';
    }

    // Validation / user input
    if (/invalid|expected|must be|required/i.test(lower)) return 'validation_error';

    // Confirmation / user action
    if (/user did not confirm|canceled|cancelled/i.test(s)) return 'user_canceled';

    // Fallback: constant bucket only. Never leak user-derived strings into
    // error_kind — paths, URL query strings, wallet-like identifiers, or any
    // other sensitive-but-non-key patterns would survive redactSecrets() and
    // show up in analytics. 'other' is low-cardinality and privacy-safe.
    // If a pattern keeps landing here, add a new bucket above, don't widen
    // the fallback.
    return 'other';
}

module.exports = { classifyError };
