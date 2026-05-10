// tests/paysh/lib/sanitize.js
//
// Per BAT-582 contract addendum v1.6 amendment 6 (Codex sign-off
// 2026-05-10): committed pay.sh captures must be stripped of any data
// that could leak secrets or user-identifying info. This module is the
// single chokepoint for that sanitization — every capture written to
// tests/paysh/captures/ goes through `sanitize()` first.
//
// What we strip (matches the contract's amendment 6 rules verbatim):
//   - Authorization, x-api-key, cookie, set-cookie request/response headers
//   - phone numbers (RFC-loose: + followed by 6+ digits)
//   - .env-shaped values (KEY=VALUE lines with ALL-CAPS keys)
//   - obvious secret-shaped tokens (sk-..., key-..., bearer-..., long hex/base64)
//   - email addresses (foo@bar.tld)
//   - paid-response private payloads — caller decides via `body: 'truncate'` to
//     replace 200-after-settle bodies with a summary placeholder; we never
//     want to commit Tripadvisor's actual photo URLs or Textbelt's textIds.
//
// What we PRESERVE:
//   - x402 protocol fields (x402Version, accepts, amount, payTo, asset,
//     network, scheme, errorCode, errorMessage, etc.) — these are the
//     whole point of the fixture.
//   - public service metadata (URL, method, content-type)
//   - HTTP status code, structural shape of body

'use strict';

const HEADER_DENYLIST = new Set([
    'authorization',
    'x-api-key',
    'apikey',
    'api-key',
    'cookie',
    'set-cookie',
    // Probe-side headers that could contain our test wallet's signed payloads —
    // not relevant for 402 captures (they happen pre-payment) but defensive
    // for any settle-success captures we add later.
    'x-payment',
    'payment-signature',
]);

const PHONE_RE = /\+\d{6,}/g;
const EMAIL_RE = /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g;
const ENV_LINE_RE = /^[A-Z][A-Z0-9_]{3,}=.+$/m;
// Generic "secret-shaped" patterns: long hex (>=32 chars), long base64 (>=40
// chars), explicit prefixes like sk-/key-/bearer-/token-/secret-/api-.
const SECRET_PREFIX_RE = /\b(sk|key|bearer|token|secret|api|priv|prv|seed)[-_][A-Za-z0-9_-]{16,}/gi;
const LONG_HEX_RE = /\b[a-fA-F0-9]{32,}\b/g;
// base64 (URL-safe and standard) — avoid being too aggressive: only flag
// when 40+ chars AND not part of a structured field we want to keep
// (handled by recursive walk, this regex is conservative). We still keep
// short base58 pubkeys and base64-encoded tx fragments under the 40-char
// threshold by design — those are part of the fixture's value.
const LONG_BASE64_RE = /\b[A-Za-z0-9+/_-]{40,}={0,2}\b/g;

const REDACTED = '[REDACTED]';

function sanitizeHeaders(headers) {
    if (!headers || typeof headers !== 'object') return headers;
    const out = {};
    for (const [k, v] of Object.entries(headers)) {
        const key = String(k).toLowerCase();
        if (HEADER_DENYLIST.has(key)) {
            out[k] = REDACTED;
        } else {
            out[k] = v;
        }
    }
    return out;
}

function sanitizeString(s, opts = {}) {
    if (typeof s !== 'string') return s;
    let out = s;
    out = out.replace(PHONE_RE, REDACTED);
    out = out.replace(EMAIL_RE, REDACTED);
    if (ENV_LINE_RE.test(out)) {
        out = out.split(/\r?\n/).map(l => ENV_LINE_RE.test(l) ? l.split('=')[0] + '=' + REDACTED : l).join('\n');
    }
    out = out.replace(SECRET_PREFIX_RE, REDACTED);
    if (!opts.preserveBase64Hex) {
        out = out.replace(LONG_HEX_RE, REDACTED);
        out = out.replace(LONG_BASE64_RE, REDACTED);
    }
    return out;
}

// x402 fields whose values are public protocol data and should NOT be
// matched against the long-hex/base64 redactor. payTo addresses, asset
// mints, network strings, error codes — all part of the fixture's value.
const X402_PUBLIC_FIELDS = new Set([
    'payTo', 'recipient', 'to',
    'asset', 'mint', 'network',
    'scheme', 'x402Version',
    'maxAmountRequired', 'amount', 'maxTimeoutSeconds',
    'errorCode', 'errorMessage', 'error', 'message',
    'description', 'mimeType', 'resource',
    'method', 'path',
    'feePayer', 'name', 'version',
]);

function sanitizeBody(body) {
    if (body === null || body === undefined) return body;
    if (typeof body === 'string') return sanitizeString(body);
    if (typeof body === 'number' || typeof body === 'boolean') return body;
    if (Array.isArray(body)) return body.map(item => sanitizeBody(item));
    if (typeof body === 'object') {
        const out = {};
        for (const [k, v] of Object.entries(body)) {
            if (X402_PUBLIC_FIELDS.has(k)) {
                // Preserve protocol data verbatim — but still strip phone/email
                // if somehow embedded (defensive).
                out[k] = typeof v === 'string'
                    ? sanitizeString(v, { preserveBase64Hex: true })
                    : sanitizeBody(v);
            } else {
                out[k] = sanitizeBody(v);
            }
        }
        return out;
    }
    return body;
}

/**
 * Sanitize a full capture { status, headers, body } object before commit.
 * Returns a NEW object — never mutates input.
 *
 * @param {object} capture — { status, headers, body, ... }
 * @param {object} opts
 *   - paidSummary (default false) — if true, replace `body` with a one-line
 *     summary string. Use for 200-after-settle captures where the response
 *     content is private (e.g. Tripadvisor restaurant photo URLs).
 */
function sanitize(capture, opts = {}) {
    const out = { ...capture };
    if (out.headers) out.headers = sanitizeHeaders(out.headers);
    if (opts.paidSummary === true) {
        out.body = `[REDACTED — paid response body summarized; ${typeof capture.body === 'string' ? capture.body.length : '?'} bytes original]`;
    } else if (out.body !== undefined) {
        out.body = sanitizeBody(out.body);
    }
    return out;
}

module.exports = { sanitize, sanitizeHeaders, sanitizeBody, sanitizeString, HEADER_DENYLIST };
