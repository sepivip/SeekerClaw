// SeekerClaw — tools/agent_pay.js
// BAT-582 Phase 6 + BAT-664 — agent_pay tool: pay an x402-protected HTTPS
// endpoint and fetch its response. HTTPS-only by contract (debug builds
// also accept http://localhost for sandbox testing).
//
// FLOW
// ----
//   1. Pre-flight rejections: HTTPS-only (debug-localhost exception),
//      GET/POST only, private-IP rejection, DNS rebinding defense
//      (resolve once, pin IP), POST body validation (JSON-only, ≤ 8 KB).
//   2. Burner-configured check via /burner/status — if no burner, refuse
//      WITHOUT issuing any HTTP request to the URL.
//   3. Issue HTTPS GET or POST (same byte-identical body if POST) with
//      size + timeout limits + per-invocation Idempotency-Key (POST only).
//   4. If response is NOT 402, return resource directly (URL might not be
//      x402-protected; treat as a regular successful fetch).
//   5. If 402: detect protocol via payment/index.js → build unsigned tx via
//      protocol.build(response, ctx) → reserve cap → sign via burner →
//      protocol.settle() with proof header (replay sends same method +
//      same byte-identical body + same idempotency key for POST).
//   6. Commit on success / release on error. Return resource response.
//
// The dynamic confirmation hook in confirmation/policy.js authorizes
// agent_pay GET silently when under cap (existing behavior). POST always
// returns `confirm` (side-effect-aware, BAT-664). The demand-vs-max_usdc
// check happens INSIDE this tool because Node only learns the real demand
// after fetching the 402 challenge.
//
// HARD RULES (per BAT-582 contract v1.4 + BAT-664 contract v2)
// ------------------------------------------------------------
//   - HTTPS only (with localhost exception gated by NODE_ENV=development)
//   - Method must be GET or POST (BAT-664); other methods rejected with
//     `method_not_allowed`
//   - POST body: JSON-serializable, ≤ 8 KB UTF-8 bytes compact-serialized,
//     validated BEFORE any DNS or network call
//   - POST sends byte-identical compact JSON body on both probe and settle
//     replay; same Content-Length and Idempotency-Key headers
//   - Idempotency-Key: one `crypto.randomUUID()` per agent_pay invocation,
//     attached only when method === 'POST', reused for probe + settle
//   - Single retry only after payment (no retry chains)
//   - Response body capped at 1 MB; total timeout 30 s
//   - DNS rebinding defense: resolve once, pin IP for the request
//   - Burner is the only signer; no main-wallet fallback for agent_pay
//   - No cap-state writes from Node — Android via /burner/reserve is canonical

'use strict';

const { URL } = require('url');
const crypto = require('crypto');
const dns = require('dns');
const https = require('https');
const http = require('http');

const { log } = require('../config');
const { androidBridgeCall } = require('../bridge');
const { getWallet } = require('../wallet');
const { detectProtocol } = require('../payment');
const { wouldReserve } = require('../caps/preflight');

const USDC_DECIMALS = 6;
const MAX_BODY_BYTES = 1024 * 1024;        // 1 MB response cap
const MAX_POST_BODY_BYTES = 8 * 1024;      // 8 KB compact-serialized body cap (BAT-664, per v1.6 contract)
// R-pr370-fix-35: separate DoS guard on raw string input BEFORE
// JSON.parse. Without this, a model-supplied multi-MB JSON string
// would burn CPU/memory in the parser even though the post-serialize
// 8 KB cap would eventually reject it. 2× MAX_POST_BODY_BYTES gives
// callers slack for whitespace/formatting in their JSON string while
// keeping the worst-case parse cost bounded.
const MAX_RAW_STRING_BYTES = MAX_POST_BODY_BYTES * 2;
const TOTAL_TIMEOUT_MS = 30 * 1000;        // 30 s
const RESERVE_TTL_MS = 60 * 1000;          // 60 s (matches dispatch.js)
const ALLOWED_METHODS = new Set(['GET', 'POST']);

// ── Decimal → atomic helper (USDC, 6 decimals) ───────────────────────────────

// BAT-582 R10: bound model-controlled input length BEFORE the regex +
// BigInt() pipeline. `max_usdc` is model-supplied; a 10MB digit payload
// would burn O(n²) CPU in BigInt parsing. 40 chars covers any realistic
// USDC value (1 trillion USDC is 19 digits at 6 decimals) and rejects
// pathological prompt-injection inputs.
const _MAX_DECIMAL_INPUT_LEN = 40;

function _decimalToAtomic(decimal, decimals = USDC_DECIMALS) {
    if (decimal == null) return null;
    const s = String(decimal).trim();
    if (s.length === 0 || s.length > _MAX_DECIMAL_INPUT_LEN) return null;
    if (!/^[0-9]+(\.[0-9]+)?$/.test(s)) return null;
    const [intPart, fracPart = ''] = s.split('.');
    if (fracPart.length > decimals) return null;
    const padded = fracPart.padEnd(decimals, '0');
    const full = (intPart + padded).replace(/^0+/, '') || '0';
    try { return BigInt(full); } catch (_) { return null; }
}

// ── Pre-flight URL validation ────────────────────────────────────────────────

// IPv4 dotted-quad → 32-bit integer. Returns null on parse failure.
function _ipv4ToInt(ip) {
    const parts = String(ip).split('.');
    if (parts.length !== 4) return null;
    let n = 0;
    for (const p of parts) {
        if (!/^\d+$/.test(p)) return null;
        const v = parseInt(p, 10);
        if (v < 0 || v > 255) return null;
        n = (n << 8) | v;
    }
    return n >>> 0; // unsigned
}

// Returns true when `ip` (a resolved address string) is in a private/loopback
// range. Covers IPv4 (10/8, 172.16/12, 192.168/16, 127.0.0.0/8, 169.254/16
// link-local) and IPv6 (::1, fc00::/7 unique-local, fe80::/10 link-local).
function isPrivateIp(ip) {
    if (!ip) return true;
    const s = String(ip).trim();

    // IPv6 — quick checks; full subnet math isn't needed for the V1 boundary.
    if (s.includes(':')) {
        const lower = s.toLowerCase();
        if (lower === '::1') return true;
        if (lower.startsWith('fe80:') || lower.startsWith('fe80::')) return true;
        if (lower.startsWith('fc') || lower.startsWith('fd')) return true;
        // ::ffff:1.2.3.4 form — strip mapping prefix and check IPv4
        const mapped = lower.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/);
        if (mapped) return isPrivateIp(mapped[1]);
        // V1 conservative: any non-public IPv6 we don't recognise as global
        // unicast 2000::/3 is treated as private to avoid SSRF surprises.
        const firstHex = parseInt(lower.split(':')[0] || '0', 16);
        if (!(firstHex >= 0x2000 && firstHex <= 0x3fff)) return true;
        return false;
    }

    // IPv4 — use unsigned 32-bit comparisons. JS bitwise & returns SIGNED
    // results (high bit = negative), so always >>> 0 to coerce to unsigned
    // before equality-comparing against the unsigned 32-bit constant.
    const n = _ipv4ToInt(s);
    if (n === null) return true; // can't parse → conservative reject

    // 10.0.0.0/8
    if (((n & 0xff000000) >>> 0) === 0x0a000000) return true;
    // 172.16.0.0/12
    if (((n & 0xfff00000) >>> 0) === 0xac100000) return true;
    // 192.168.0.0/16
    if (((n & 0xffff0000) >>> 0) === 0xc0a80000) return true;
    // 127.0.0.0/8 (loopback)
    if (((n & 0xff000000) >>> 0) === 0x7f000000) return true;
    // 169.254.0.0/16 (link-local)
    if (((n & 0xffff0000) >>> 0) === 0xa9fe0000) return true;
    // 0.0.0.0/8
    if (((n & 0xff000000) >>> 0) === 0x00000000) return true;

    return false;
}

// Resolve hostname once (DNS rebinding defense). Returns first IP from
// dns.lookup. Tests can override _setDnsLookup.
//
// BAT-582 R5 fix: a slow or hung resolver previously could block agent_pay
// indefinitely, breaking the advertised TOTAL_TIMEOUT_MS = 30s wall-clock
// contract. We now race the lookup against a deadline derived from the
// SHARED 30s budget — caller passes deadlineMs computed once at the start
// of agent_pay. DNS gets `deadlineMs - Date.now()` ms, NOT a fresh 30s,
// so DNS + HTTP fetch + sign + settle together respect the same overall
// budget.
let _dnsLookupOverride = null;
function _setDnsLookup(fn) { _dnsLookupOverride = fn; }

// R-pr370-fix-7 (BAT-664): test hook to intercept the internal
// `_fetchWithLimits` call. Production code calls the function by its
// closure-captured reference, NOT via module.exports — so replacing the
// export doesn't affect runtime behavior. This hook gives tests a way to
// capture the probe + settle requests and assert byte-identity of
// Idempotency-Key, body, etc.
let _fetchOverride = null;
function _setFetchOverride(fn) { _fetchOverride = fn; }

const DNS_DEFAULT_TIMEOUT_MS = TOTAL_TIMEOUT_MS;

function _lookupHost(hostname, deadlineMs) {
    // Compute remaining budget from shared deadline. Default to the full
    // total timeout when no deadline is given (back-compat for tests/
    // direct callers).
    const remainingMs = (typeof deadlineMs === 'number' && isFinite(deadlineMs))
        ? Math.max(0, deadlineMs - Date.now())
        : DNS_DEFAULT_TIMEOUT_MS;
    if (remainingMs === 0) {
        return Promise.reject(new Error('dns_timeout'));
    }

    const lookupPromise = _dnsLookupOverride
        ? Promise.resolve().then(() => _dnsLookupOverride(hostname))
        : new Promise((resolve, reject) => {
            dns.lookup(hostname, { all: false }, (err, address, family) => {
                if (err) reject(err);
                else resolve({ address, family });
            });
        });

    let timer = null;
    const timeoutPromise = new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error('dns_timeout')), remainingMs);
        // Intentionally NOT unref'd: we WANT the timer to keep the loop alive
        // long enough for the timeout to fire. Without that, a process whose
        // only outstanding work is a hung DNS lookup would exit early
        // (skipping the timeout) — which is what tests would observe but
        // also what would happen in agent shutdown scenarios where Telegram
        // long-polling has already been torn down.
    });

    return Promise.race([lookupPromise, timeoutPromise])
        .finally(() => {
            if (timer) clearTimeout(timer);
        });
}

// Determine whether localhost-debug exception applies. Gated by NODE_ENV.
function _isDebugBuild() {
    return process.env.NODE_ENV === 'development' || process.env.NODE_ENV === 'test';
}

function _isLocalhostHostname(h) {
    if (!h) return false;
    const s = String(h).toLowerCase();
    return s === 'localhost' || s === '127.0.0.1' || s === '::1';
}

// Validate URL + scheme + method (cheap, synchronous).
// Returns `{ ok: true, parsed, isLocal, method }` on success or
// `{ error, reason }` on rejection. NEVER opens a network connection.
//
// BAT-664: `method` can be 'GET' or 'POST'. Anything else rejected with
// `method_not_allowed` (stable code matching v1.6 contract).
function preflightUrlSync(url, method) {
    let parsed;
    try { parsed = new URL(url); }
    catch (_) { return { error: 'invalid_url', reason: 'URL parse failed' }; }

    // R-pr370-fix-6: defensive type check. Tool inputs aren't schema-validated
    // at runtime, so a malformed call could pass `method: 123` / `method: {}` /
    // method: []`. `(non-string).toUpperCase()` would throw an uninformative
    // TypeError. Behavior:
    //   - undefined / null → default to GET (treat as "method omitted")
    //   - any other non-string (number, boolean, object, array) → reject
    //     with method_not_allowed and the type name so the operator gets a
    //     clear signal
    //   - string → uppercase + check against ALLOWED_METHODS
    let m;
    if (method === undefined || method === null) m = 'GET';
    else if (typeof method !== 'string') {
        return { error: 'method_not_allowed', reason: `method must be a string (got ${typeof method})` };
    } else {
        m = method.toUpperCase();
    }
    if (!ALLOWED_METHODS.has(m)) {
        return { error: 'method_not_allowed', reason: `method must be GET or POST (got ${m})` };
    }

    const hostname = parsed.hostname;
    const isLocal = _isLocalhostHostname(hostname);
    const isHttp = parsed.protocol === 'http:';
    const isHttps = parsed.protocol === 'https:';

    if (!isHttp && !isHttps) {
        return { error: 'non_https', reason: `URL scheme must be https (got ${parsed.protocol})` };
    }
    if (isHttp && !(isLocal && _isDebugBuild())) {
        return { error: 'non_https', reason: 'http:// only allowed for localhost in debug builds' };
    }

    return { ok: true, parsed, isLocal, method: m };
}

// BAT-664: validate + serialize a POST body BEFORE DNS / network / payment.
// Returns { bodyJsonStr } on success, or { error, reason } on rejection.
//
// Rules (per contract v2 + R-pr370-fix-2):
//   - method === 'POST' ⇒ body required; `undefined` or `null` rejected as
//     body_required_for_post (treated as "no body supplied")
//   - body string ⇒ MUST parse as JSON via JSON.parse and the parsed value
//     MUST be a non-null object or array (else body_not_json)
//   - body non-null object or array ⇒ pass through
//   - body primitives (number, boolean, plain string-after-parse) ⇒
//     rejected as body_not_json — the input_schema describes body as a
//     JSON object/array, and paid POST endpoints expect structured payloads
//     (textbelt: {phone, message}; coingecko-like: query objects). A bare
//     primitive would deterministically confuse upstream services.
//   - body that JSON.stringify can't represent (functions, symbols-only,
//     circular refs) ⇒ body_not_json
//   - Final compact-serialized form ≤ 8192 UTF-8 bytes (body_too_large)
//
// The returned bodyJsonStr is REUSED byte-identically for probe and settle
// replay — never re-serialized. Drift between probe and settle would cause
// strict facilitators to reject the proof.
function validateAndSerializeBody(method, body) {
    if (method !== 'POST') {
        return { bodyJsonStr: null };  // GET path: no body
    }
    if (body === undefined || body === null) {
        return { error: 'body_required_for_post', reason: 'POST requires a JSON body' };
    }
    let parsed = body;
    if (typeof body === 'string') {
        // R-pr370-fix-4: bound raw string length BEFORE JSON.parse. A
        // model-controlled multi-MB string would burn CPU/memory in the
        // parser before being rejected by the post-serialize 8 KB cap.
        // 2× MAX_POST_BODY_BYTES is documented as a pre-parse DoS guard
        // (see MAX_RAW_STRING_BYTES); a JSON string with extreme
        // whitespace padding could exceed this even if its
        // post-compact-serialize form would fit. That's the documented
        // contract: BOTH caps apply (pre-parse + post-serialize).
        const rawLen = Buffer.byteLength(body, 'utf8');
        if (rawLen > MAX_RAW_STRING_BYTES) {
            return {
                error: 'body_too_large',
                reason: `raw POST body string is ${rawLen} bytes (pre-parse cap ${MAX_RAW_STRING_BYTES} = 2× compact-serialize cap, DoS guard)`,
            };
        }
        try { parsed = JSON.parse(body); }
        catch (_) {
            return { error: 'body_not_json', reason: 'string body must be valid JSON' };
        }
    }
    // R-pr370-fix-2: require parsed body to be a non-null object or array.
    // Bare primitives are rejected — the input_schema describes body as a
    // structured payload; paid POST endpoints expect objects.
    if (parsed === null || typeof parsed !== 'object') {
        return { error: 'body_not_json', reason: `body must be a JSON object or array (got ${parsed === null ? 'null' : typeof parsed})` };
    }
    let bodyJsonStr;
    try { bodyJsonStr = JSON.stringify(parsed); }
    catch (e) {
        return { error: 'body_not_json', reason: `body could not be serialized: ${e.message}` };
    }
    if (typeof bodyJsonStr !== 'string') {
        // JSON.stringify can return undefined (functions, symbols)
        return { error: 'body_not_json', reason: 'body did not produce a JSON value (functions/symbols not allowed)' };
    }
    const byteLen = Buffer.byteLength(bodyJsonStr, 'utf8');
    if (byteLen > MAX_POST_BODY_BYTES) {
        return {
            error: 'body_too_large',
            reason: `POST body is ${byteLen} bytes (max ${MAX_POST_BODY_BYTES} UTF-8 bytes per v1.6 contract)`,
        };
    }
    return { bodyJsonStr };
}

// DNS resolve (and pin) to detect private-IP rebinding. Skip resolution for
// localhost in debug mode — there's no rebinding attack against a fixed
// loopback host. Returns {pinnedIp, pinnedFamily} on success or {error, reason}.
//
// BAT-582 R5 fix: `deadlineMs` (optional) is the SHARED end-of-budget
// timestamp from agent_pay's caller. It's forwarded to _lookupHost so a
// hung DNS resolver can't burn the whole 30s budget on its own. Omitting
// it preserves back-compat for direct callers / tests (a fresh 30s
// fallback applies inside _lookupHost).
async function preflightDns(parsed, isLocal, deadlineMs) {
    if (isLocal) return { ok: true, pinnedIp: null, pinnedFamily: null };
    let r;
    try { r = await _lookupHost(parsed.hostname, deadlineMs); }
    catch (e) {
        const msg = e && e.message ? e.message : String(e);
        if (msg === 'dns_timeout') {
            return { error: 'dns_timeout', reason: 'dns lookup exceeded remaining budget' };
        }
        return { error: 'dns_lookup_failed', reason: msg };
    }
    if (isPrivateIp(r.address)) {
        return { error: 'private_ip', reason: `resolved to private IP ${r.address}` };
    }
    return { ok: true, pinnedIp: r.address, pinnedFamily: r.family };
}

// Combined pre-flight (sync + DNS). Kept for tests that want to assert the
// full chain. Internal call sites use the split sync/dns variants so the
// burner-not-configured check can short-circuit BEFORE DNS resolution.
async function preflightUrl(url, method, deadlineMs) {
    const sync = preflightUrlSync(url, method);
    if (sync.error) return sync;
    const dnsRes = await preflightDns(sync.parsed, sync.isLocal, deadlineMs);
    if (dnsRes.error) return dnsRes;
    return { ok: true, parsed: sync.parsed, pinnedIp: dnsRes.pinnedIp, pinnedFamily: dnsRes.pinnedFamily };
}

// ── Fetch with timeout + size cap, using pinned IP ───────────────────────────

// Returns { status, headers, bodyBuffer, bodyJson? } or { error, reason }.
// `parsed` is a URL instance; `pinnedIp` is the resolved IPv4/IPv6 string
// (or null for localhost).
//
// BAT-664: `opts.method` ('GET'|'POST') and `opts.bodyJsonStr` (cached
// pre-serialized compact JSON, or null) thread through here so the SAME
// byte-identical body is sent on probe and settle replay. The caller is
// responsible for sourcing both from one cached pair (no per-call
// re-serialization).
function _fetchWithLimits(parsed, pinnedIp, pinnedFamily, extraHeaders = {}, signalTimeoutLeftMs = TOTAL_TIMEOUT_MS, opts = {}) {
    if (_fetchOverride) {
        return _fetchOverride(parsed, pinnedIp, pinnedFamily, extraHeaders, signalTimeoutLeftMs, opts);
    }
    return new Promise((resolve) => {
        // R-pr370-fix-29: defensive method type check. settle() now passes
        // method via originalRequest; a future caller / test override that
        // sets opts.method to a non-string would crash here with an
        // uninformative TypeError. Treat non-strings as missing → GET.
        let method = 'GET';
        if (typeof opts.method === 'string') method = opts.method.toUpperCase();
        const bodyJsonStr = (method === 'POST' && typeof opts.bodyJsonStr === 'string')
            ? opts.bodyJsonStr
            : null;
        const isHttps = parsed.protocol === 'https:';
        const lib = isHttps ? https : http;
        const headers = Object.assign({
            host: parsed.host,
            'user-agent': 'SeekerClaw-agent_pay/1.0',
            accept: 'application/json,*/*;q=0.5',
        }, extraHeaders);
        if (bodyJsonStr !== null) {
            headers['content-type'] = 'application/json';
            // R-pr370-fix-28: Content-Length MUST be a string. Node's HTTP
            // client throws ERR_HTTP_INVALID_HEADER_VALUE for numeric
            // header values in strict modes; even when it works, normalized
            // header transport (HTTP/2) expects strings.
            headers['content-length'] = String(Buffer.byteLength(bodyJsonStr, 'utf8'));
        }

        const reqOptions = {
            method,
            // IP-pin: connect to the resolved address but send the original Host header
            // so TLS SNI and HTTP routing still work. For localhost we let Node resolve.
            host: pinnedIp || parsed.hostname,
            port: parsed.port || (isHttps ? 443 : 80),
            path: parsed.pathname + (parsed.search || ''),
            headers,
            servername: parsed.hostname, // TLS SNI
            timeout: signalTimeoutLeftMs,
        };
        if (pinnedIp && pinnedFamily) reqOptions.family = pinnedFamily;

        let settled = false;
        const settle = (v) => { if (!settled) { settled = true; resolve(v); } };
        const overall = setTimeout(() => {
            try { req.destroy(); } catch (_) { /* noop */ }
            settle({ error: 'timeout', reason: `total timeout (${signalTimeoutLeftMs} ms) exceeded` });
        }, signalTimeoutLeftMs);

        const req = lib.request(reqOptions, (res) => {
            const chunks = [];
            let total = 0;
            let aborted = false;
            res.on('data', (chunk) => {
                if (aborted) return;
                total += chunk.length;
                if (total > MAX_BODY_BYTES) {
                    aborted = true;
                    try { res.destroy(); } catch (_) { /* noop */ }
                    clearTimeout(overall);
                    settle({ error: 'response_too_large', reason: `response exceeded ${MAX_BODY_BYTES} bytes` });
                    return;
                }
                chunks.push(chunk);
            });
            res.on('end', () => {
                if (aborted) return;
                clearTimeout(overall);
                const bodyBuffer = Buffer.concat(chunks);
                const out = {
                    status: res.statusCode,
                    headers: res.headers,
                    bodyBuffer,
                };
                // Try JSON parse — best-effort; non-JSON bodies pass through.
                const ct = String(res.headers['content-type'] || '').toLowerCase();
                if (ct.includes('application/json') || ct.includes('+json')) {
                    try { out.bodyJson = JSON.parse(bodyBuffer.toString('utf8')); }
                    catch (_) { /* leave unset */ }
                } else if (bodyBuffer.length > 0 && bodyBuffer.length < MAX_BODY_BYTES) {
                    // Some servers return JSON without a content-type — try anyway.
                    const trimmed = bodyBuffer.toString('utf8').trim();
                    if (trimmed.startsWith('{') || trimmed.startsWith('[')) {
                        try { out.bodyJson = JSON.parse(trimmed); }
                        catch (_) { /* leave unset */ }
                    }
                }
                settle(out);
            });
            res.on('error', (e) => {
                if (aborted) return;
                clearTimeout(overall);
                settle({ error: 'response_error', reason: e.message });
            });
        });

        req.on('error', (e) => {
            clearTimeout(overall);
            settle({ error: 'request_failed', reason: e.message });
        });
        req.on('timeout', () => {
            try { req.destroy(); } catch (_) { /* noop */ }
            clearTimeout(overall);
            settle({ error: 'timeout', reason: 'socket idle timeout' });
        });
        // BAT-664: write the cached pre-serialized body for POST. We pass
        // it as a Node Buffer so http.request doesn't re-encode it — the
        // bytes on the wire are exactly `Buffer.from(bodyJsonStr, 'utf8')`.
        if (bodyJsonStr !== null) {
            req.write(Buffer.from(bodyJsonStr, 'utf8'));
        }
        req.end();
    });
}

// ── Tool definition ──────────────────────────────────────────────────────────

const tools = [
    {
        name: 'agent_pay',
        description:
            'Pay an x402-protected HTTPS endpoint (GET or POST) and fetch its response. Used for paid APIs ' +
            '(pay.sh catalog, x402-enabled endpoints). Solana mainnet, USDC only. ' +
            'Args: `url` (HTTPS) + `max_usdc` (max amount willing to spend, decimal string, e.g. "0.10") ' +
            '+ optional `method` ("GET" default, or "POST") + optional `body` (JSON-serializable object, required for POST, ≤ 8 KB). ' +
            'The burner wallet signs autonomously when the 402 demand is ≤ max_usdc; the call is rejected ' +
            'if the demand exceeds max_usdc, the network is not Solana, or the asset is not USDC. ' +
            'GET runs silently when under cap. POST always asks for user confirmation (side-effect-aware: ' +
            'POST can send SMS, post content, or trigger other paid actions). ' +
            'Refuses if no burner is configured (Settings → Burner Wallet to set up).',
        input_schema: {
            type: 'object',
            properties: {
                url: { type: 'string', description: 'Target URL (HTTPS).' },
                max_usdc: { type: 'string', description: 'Maximum USDC willing to spend, decimal string (e.g. "0.10").' },
                method: {
                    type: 'string',
                    enum: ['GET', 'POST'],
                    description: 'HTTP method. Defaults to "GET". POST always requires user confirmation regardless of cap.',
                },
                body: {
                    // R-pr370-fix-25: validator accepts both an object/array
                    // directly AND a JSON-string that PARSES to an object/array.
                    // Express that as a union type in the schema so model
                    // guidance + downstream schema-driven validators see the
                    // full surface. Bare primitives rejected at validate
                    // time (see validateAndSerializeBody).
                    type: ['object', 'array', 'string'],
                    description: 'Request body for POST. JSON object or array (or a JSON string that parses to an object/array). Bare primitives (numbers, booleans, plain strings) are rejected. Max 8 KB UTF-8 after compact serialization. String inputs are ALSO capped at 16 KB UTF-8 pre-parse (DoS guard against multi-MB strings that would compact down). Required when method=POST.',
                },
            },
            required: ['url', 'max_usdc'],
        },
    },
];

// ── Handler ──────────────────────────────────────────────────────────────────

async function _handle(input /* , chatId */) {
    const a = input || {};
    const url = a.url;
    const maxUsdcStr = a.max_usdc;
    const methodRaw = a.method;
    const bodyRaw = a.body;

    if (typeof url !== 'string' || !url) {
        return { error: 'invalid_input', reason: 'url is required' };
    }
    if (typeof maxUsdcStr !== 'string' && typeof maxUsdcStr !== 'number') {
        return { error: 'invalid_input', reason: 'max_usdc is required (decimal string)' };
    }

    const maxUsdcAtomic = _decimalToAtomic(String(maxUsdcStr), USDC_DECIMALS);
    if (maxUsdcAtomic == null) {
        return {
            error: 'invalid_input',
            reason: `max_usdc must be a non-negative decimal with ≤ ${USDC_DECIMALS} fractional digits (got "${maxUsdcStr}")`,
        };
    }

    // BAT-582 R5: SHARED 30s deadline. Computed once at the top so DNS,
    // initial fetch, sign, and settle all draw from the SAME wall-clock
    // budget. Pre-fix, DNS had no timeout (could hang the turn) AND the
    // settle phase computed `remaining` from a separate `startMs` after
    // DNS, which meant a slow DNS could push total wall-clock well past
    // 30s. Sharing one deadline closes that loophole.
    const startMs = Date.now();
    const deadlineMs = startMs + TOTAL_TIMEOUT_MS;

    // 1a. Cheap pre-flight (URL parse + scheme + method). Synchronous — no
    // bridge calls, no DNS. Fails fast on the dumbest input mistakes before
    // we bother the bridge at all.
    const sync = preflightUrlSync(url, methodRaw);
    if (sync.error) {
        log(`[agent_pay] rejected: ${sync.error} — ${sync.reason}`, 'WARN');
        return { error: sync.error, reason: sync.reason };
    }
    const { parsed, isLocal, method } = sync;

    // 1a.5. BAT-664: validate + compact-serialize the POST body BEFORE any
    // DNS resolve or network call. Pre-network validation is an explicit
    // acceptance gate — operator typos must not trigger DNS lookups on
    // attacker-supplied hosts.
    const bodyCheck = validateAndSerializeBody(method, bodyRaw);
    if (bodyCheck.error) {
        log(`[agent_pay] rejected: ${bodyCheck.error} — ${bodyCheck.reason}`, 'WARN');
        return { error: bodyCheck.error, reason: bodyCheck.reason };
    }
    const bodyJsonStr = bodyCheck.bodyJsonStr;  // string for POST, null for GET

    // BAT-664: per-invocation idempotency key for POST. Generated ONCE here
    // and reused for both the 402 probe and the settle replay so the
    // facilitator + upstream see the same key on the retried request.
    // Distinct agent_pay calls get distinct keys.
    const idempotencyKey = method === 'POST' ? crypto.randomUUID() : null;

    // 1b. Burner-configured check BEFORE DNS resolution. Per BAT-582 contract
    // "agent_pay refuses cleanly when no burner is configured AND makes no
    // outbound network call to the URL" — we check the bridge first so a
    // misconfigured agent never touches DNS for an attacker-supplied host.
    let status;
    try { status = await androidBridgeCall('/burner/status', {}, 5000); }
    catch (_) { status = null; }
    if (!status || status.error || !status.configured) {
        log('[agent_pay] burner not configured — refusing without HTTP fetch', 'WARN');
        return {
            error: 'burner_not_configured',
            message: 'agent_pay requires a burner wallet. Configure one in Settings → Burner Wallet.',
        };
    }

    // 1c. DNS resolution (with private-IP / rebinding defense). Only happens
    // once we know we have a burner to spend from. Threads the SHARED
    // deadline so a hung resolver can't burn the whole budget.
    const dnsRes = await preflightDns(parsed, isLocal, deadlineMs);
    if (dnsRes.error) {
        log(`[agent_pay] rejected: ${dnsRes.error} — ${dnsRes.reason}`, 'WARN');
        return { error: dnsRes.error, reason: dnsRes.reason };
    }
    const { pinnedIp, pinnedFamily } = dnsRes;

    // 3. Initial fetch (probe) — bounded by the SHARED remaining budget
    // so DNS + fetch can't together exceed TOTAL_TIMEOUT_MS. For POST,
    // sends the cached body + Idempotency-Key — the SAME pair will be
    // reused on the settle replay.
    const fetchTimeoutMs = Math.max(1, deadlineMs - Date.now());
    const probeHeaders = idempotencyKey ? { 'idempotency-key': idempotencyKey } : {};
    const firstResp = await _fetchWithLimits(
        parsed, pinnedIp, pinnedFamily,
        probeHeaders,
        fetchTimeoutMs,
        { method, bodyJsonStr },
    );
    if (firstResp.error) {
        log(`[agent_pay] initial fetch failed: ${firstResp.error}`, 'WARN');
        return { error: firstResp.error, reason: firstResp.reason };
    }

    // 4. Not a 402 → return resource directly.
    if (firstResp.status !== 402) {
        return _toolResponse(firstResp, /* payment */ null);
    }

    // 5. 402 → detect protocol.
    const protocol = detectProtocol(_protocolView(firstResp));
    if (!protocol) {
        log('[agent_pay] no x402 protocol detected for 402 response', 'WARN');
        return {
            error: 'no_protocol_match',
            reason: 'Received 402 but no registered payment protocol matched the response shape (V1 supports pay.sh-style x402 only).',
        };
    }

    // 6. Build unsigned tx via the protocol.
    const burner = getWallet('burner');
    const built = await protocol.build(_protocolView(firstResp), {
        maxUsdcAtomic,
        signerWallet: burner,
        burnerPubkey: status.pubkey,
    });
    if (built.error) {
        log(`[agent_pay] protocol.build rejected: ${built.error} — ${built.reason || ''}`, 'WARN');
        return { error: built.error, reason: built.reason };
    }
    const { txBase64, paymentMeta } = built;
    if (!txBase64 || !paymentMeta) {
        return { error: 'protocol_build_invalid', reason: 'protocol.build returned no txBase64 or paymentMeta' };
    }

    // 7. Cap preflight (USDC per-tx + daily). Bridge is canonical writer; we
    // just fail fast if the cap obviously won't fit.
    const demandAtomic = paymentMeta.amountAtomic;
    if (typeof demandAtomic !== 'bigint') {
        return { error: 'protocol_build_invalid', reason: 'paymentMeta.amountAtomic must be a BigInt' };
    }
    const perTx = await wouldReserve('burner.pertx.usdc', demandAtomic);
    if (!perTx.wouldAllow) {
        return {
            error: 'burner_cap_exceeded',
            reason: `per-tx USDC cap insufficient (${perTx.reason}). Raise with wallet_set_caps or lower max_usdc.`,
        };
    }
    const daily = await wouldReserve('burner.daily.usdc', demandAtomic);
    if (!daily.wouldAllow) {
        return {
            error: 'burner_cap_exceeded',
            reason: `daily USDC cap insufficient (${daily.reason}). Raise with wallet_set_caps or wait until 00:00 UTC.`,
        };
    }

    // 8. Reserve cap.
    const reserveRes = await androidBridgeCall('/burner/reserve', {
        name: 'burner.pertx.usdc',
        atomicAmount: demandAtomic.toString(),
        ttlMs: RESERVE_TTL_MS,
    }, 5000);
    if (!reserveRes || reserveRes.error || !reserveRes.reservationId) {
        return {
            error: reserveRes && reserveRes.error ? reserveRes.error : 'reserve_failed',
            reason: reserveRes && reserveRes.reason ? reserveRes.reason : 'cap reservation failed',
        };
    }
    const reservationId = reserveRes.reservationId;

    // 9. Sign via burner.
    //
    // BAT-582 v1.6 Phase 5d/5e: x402 v2 challenges produce partially-
    // signed txs (facilitator co-signs slot 0 server-side after we send
    // PAYMENT-SIGNATURE). The burner signs slot 1 only; the wire tx
    // leaving the device has slot 0 still empty. We must opt in to the
    // bridge's partial-sign mode for v2 — otherwise SolanaTxSigner
    // rejects with `additional_signers_required`. v1 callers (and
    // legacy v1-shaped pay.sh services) skip the flag and use the
    // fully-signed-only path.
    const isV2 = paymentMeta && paymentMeta.x402Version === 2;
    let signedTxBase64;
    try {
        const signOpts = { reservationId };
        if (isV2) signOpts.allowPartiallySigned = true;
        const signed = await burner.signer().signTransaction(txBase64, signOpts);
        if (!signed || signed.error) {
            await _release(reservationId, signed && signed.error ? signed.error : 'sign_failed');
            return {
                error: signed && signed.error ? signed.error : 'sign_failed',
                reason: signed && signed.reason ? signed.reason : 'signing failed',
            };
        }
        signedTxBase64 = signed.signedTxBase64;
        if (!signedTxBase64) {
            await _release(reservationId, 'no_signed_tx');
            return { error: 'sign_failed', reason: 'no signedTxBase64 in response' };
        }
    } catch (e) {
        await _release(reservationId, 'sign_threw');
        return { error: 'sign_failed', reason: e.message };
    }

    // 10. Settle: replay the same request (same method, same body for POST,
    //     same Idempotency-Key for POST) with proof header(s) added. Single
    //     retry only — no retry chains (per contract). BAT-582 R5: settle
    //     inherits the SAME shared deadline so total wall-clock is bounded
    //     by TOTAL_TIMEOUT_MS regardless of how DNS / fetch / sign spent it.
    //
    //     BAT-664: `originalRequest` carries `method`, `bodyJsonStr`, and
    //     `idempotencyKey`. settle() reads those and forwards through the
    //     fetch helper so probe + settle send byte-identical request shapes
    //     (modulo the additional PAYMENT-SIGNATURE / x-payment proof header).
    const remaining = Math.max(1000, deadlineMs - Date.now());
    const originalRequest = {
        parsed, pinnedIp, pinnedFamily,
        timeoutLeftMs: remaining,
        method,
        bodyJsonStr,
        idempotencyKey,
    };
    const settled = await protocol.settle(originalRequest, signedTxBase64, paymentMeta, { _fetchWithLimits });
    if (!settled || settled.error) {
        await _release(reservationId, settled && settled.error ? settled.error : 'settle_failed');
        return {
            error: settled && settled.error ? settled.error : 'settle_failed',
            reason: settled && settled.reason ? settled.reason : 'settle returned no result',
        };
    }

    // 11. Commit on success — anchor the spend in the daily ledger.
    try {
        await androidBridgeCall('/burner/commit', {
            reservationId,
            signature: settled.signature || null,
        }, 5000);
    } catch (e) {
        // Commit failure is logged but doesn't unwind a successful payment.
        // The TTL sweep will release the reservation eventually.
        log(`[agent_pay] commit after settle failed: ${e.message}`, 'WARN');
    }

    return _toolResponse(settled.response || settled, {
        amount_atomic_usdc: demandAtomic.toString(),
        recipient: paymentMeta.recipient || null,
        signature: settled.signature || null,
        protocol: protocol.name,
    });
}

// Build the protocol-facing view of a fetched response. Keeps the protocol
// abstraction free of Buffer/headers details that aren't part of its contract.
function _protocolView(resp) {
    return {
        status: resp.status,
        headers: resp.headers,
        bodyJson: resp.bodyJson,
        bodyBuffer: resp.bodyBuffer,
    };
}

// Shape the tool result for the agent. Body is best-effort UTF-8.
function _toolResponse(resp, payment) {
    const body = resp.bodyJson != null
        ? resp.bodyJson
        : (resp.bodyBuffer ? resp.bodyBuffer.toString('utf8').slice(0, 8 * 1024) : '');
    const out = {
        status: resp.status,
        headers: _safeHeaders(resp.headers),
        body,
    };
    if (payment) out.payment = payment;
    return out;
}

// Strip headers we don't want to surface to the agent (cookies, auth) — keep
// the rest. The agent doesn't need full headers for V1.
function _safeHeaders(headers) {
    if (!headers || typeof headers !== 'object') return {};
    const out = {};
    for (const k of Object.keys(headers)) {
        const lk = k.toLowerCase();
        if (lk === 'set-cookie' || lk === 'authorization' || lk === 'cookie') continue;
        out[lk] = headers[k];
    }
    return out;
}

async function _release(reservationId, reason) {
    if (!reservationId) return;
    try {
        await androidBridgeCall('/burner/release', { reservationId, reason: String(reason || 'released') }, 5000);
    } catch (e) {
        log(`[agent_pay] release(${reservationId}) failed: ${e.message}`, 'WARN');
    }
}

const handlers = {
    agent_pay: _handle,
};

module.exports = {
    tools,
    handlers,
    // Exposed for tests:
    _decimalToAtomic,
    _isPrivateIp: isPrivateIp,
    preflightUrl,
    preflightUrlSync,
    preflightDns,
    validateAndSerializeBody,   // BAT-664
    MAX_POST_BODY_BYTES,        // BAT-664
    _setDnsLookup,
    _setFetchOverride,          // BAT-664 (R-pr370-fix-7)
    _fetchWithLimits,
};
