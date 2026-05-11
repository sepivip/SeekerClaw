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
//   - paid-response private payloads — caller passes `{ paidSummary: true }`
//     as the second arg to `sanitize(capture, opts)` to replace
//     200-after-settle bodies with a one-line summary placeholder; we
//     never want to commit Tripadvisor's actual photo URLs or Textbelt's
//     textIds. (See the JSDoc on `sanitize()` below for the exact API.)
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
// BAT-582 R20: matches any ALL-CAPS env-style line at line start. Pre-fix
// required key length ≥4 chars, which let short secrets through
// (KEY=foo, AWS=secret, DB=pwd). Broaden to ≥1 char while keeping
// uppercase-first-letter constraint so common JSON / config values like
// "a: 1" aren't false-positive matched.
const ENV_LINE_RE = /^[A-Z][A-Z0-9_]*=.+$/m;
// Generic "secret-shaped" patterns: long hex (>=32 chars), long base64 (>=40
// chars), explicit prefixes like sk-/key-/bearer-/token-/secret-/api-.
const SECRET_PREFIX_RE = /\b(sk|key|bearer|token|secret|api|priv|prv|seed)[-_][A-Za-z0-9_-]{16,}/gi;
const LONG_HEX_RE = /\b[a-fA-F0-9]{32,}\b/g;
// base64 (URL-safe and standard) — flag any 40+ char token that looks
// base64-ish, with optional `=` padding. The 40-char threshold is
// intentionally aggressive: real base58-encoded Solana pubkeys are
// 43-44 chars, base64-encoded signed transactions are 200+ chars,
// and base64 payment-required headers are hundreds-to-thousands.
//
// BAT-582 R25: pre-fix used `\b...\b` framing, but `\b` is a word
// boundary that triggers between \w ([A-Za-z0-9_]) and \W. Base64
// padding `=` is \W, and tokens often appear inside JSON strings
// followed by another \W (`"`, `,`, `}`). The trailing `\b` then
// FAILED to match (\W → \W is not a boundary) and the redactor
// silently dropped the token. Real captures with `=`-padded base64
// would slip through unredacted.
//
// Use explicit char-class lookarounds instead so the boundaries are
// "anything-not-in-the-alphabet" on either side. This correctly
// captures padded tokens inside JSON strings.
//
// Preservation of x402 protocol values does NOT happen via length —
// it happens via the X402_PUBLIC_FIELDS allowlist in the recursive
// walk below. When a value is the direct child of a key like `payTo`,
// `asset`, `network`, `extra.feePayer`, etc., we skip this redactor
// entirely (preserveBase64Hex=true). Anywhere else in the body, a
// long-base64 token is treated as suspicious and redacted.
const LONG_BASE64_RE = /(?<![A-Za-z0-9+/=_-])[A-Za-z0-9+/_-]{40,}={0,2}(?![A-Za-z0-9+/=_-])/g;

const REDACTED = '[REDACTED]';

// Header names whose VALUES carry public x402 protocol data that must be
// preserved verbatim for the fixture to be useful. Anything outside this
// allowlist goes through `sanitizeString()` so secret-shaped values in
// unexpected headers can't leak into committed captures.
//
// BAT-582 R31: pre-fix, sanitizeHeaders() redacted ONLY by header name
// (denylist) and passed every other header's value through unchanged.
// A header like `X-Request-Id: sk-abc12345...` would commit verbatim
// because `X-Request-Id` isn't in the denylist — the README promises
// sk-/key-/bearer- token redaction throughout, but headers got a free
// pass. Now non-denylist + non-allowlist header values run through the
// same secret-scrub regex stack the bodies use.
const HEADER_PROTOCOL_ALLOWLIST = new Set([
    'payment-required',   // x402 v2: base64-encoded payment requirements payload — the data we WANT to commit
    'content-type',
    'content-length',
    'transfer-encoding',
    'connection',
    'date',
    'server',
    'cache-control',
    'access-control-allow-origin',
    'access-control-allow-methods',
    'access-control-request-method',
    'x-frame-options',
    'x-xss-protection',
    'x-content-type-options',
    'x-permitted-cross-domain-policies',
    'referrer-policy',
    'vary',
    'cf-ray',
    'cf-cache-status',
]);

function sanitizeHeaders(headers) {
    if (!headers || typeof headers !== 'object') return headers;
    const out = {};
    for (const [k, v] of Object.entries(headers)) {
        const key = String(k).toLowerCase();
        if (HEADER_DENYLIST.has(key)) {
            out[k] = REDACTED;
        } else if (HEADER_PROTOCOL_ALLOWLIST.has(key)) {
            // Preserve verbatim — these are public protocol/transport
            // metadata that the fixture relies on.
            out[k] = v;
        } else if (typeof v === 'string') {
            // Unknown header — scrub its value against the secret-shape
            // regex stack so e.g. an X-Request-Id full of an sk-/key-/
            // bearer-prefixed token doesn't leak through.
            out[k] = sanitizeString(v);
        } else if (Array.isArray(v)) {
            // Multi-value headers (rare in JSON capture but possible)
            out[k] = v.map(item => typeof item === 'string' ? sanitizeString(item) : item);
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
        // BAT-582 R25 (order matters): apply LONG_BASE64_RE FIRST so a
        // base64 token like "AAAA...AAAA==" (which is also valid hex up
        // to the padding) is captured WITH its `=` padding in one
        // match. If LONG_HEX_RE ran first, it would greedily match the
        // hex-valid prefix and leave the `==` orphaned in the output —
        // partial redaction. Base64 first means the entire token gets
        // redacted as a single unit.
        out = out.replace(LONG_BASE64_RE, REDACTED);
        out = out.replace(LONG_HEX_RE, REDACTED);
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
