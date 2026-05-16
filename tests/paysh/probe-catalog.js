// tests/paysh/probe-catalog.js
//
// pay.sh CATALOG probe — sweeps the full ~71-service catalog from
// solana-foundation/pay-skills, probes one cheap GET per service (no
// payment), and reports which services our v2 parser handles cleanly.
//
// Differs from probe-all.js (which captures a curated 4-service
// regression set with committed fixtures): this script is a BREADTH
// survey, not a regression set. It writes a single summary markdown
// file (`tests/paysh/catalog-summary.md`) — not 71 individual capture
// files — so it scales without bloating the repo.
//
// Cost: $0. No X-PAYMENT or PAYMENT-SIGNATURE header sent.
//
// Run:
//   node tests/paysh/probe-catalog.js
//   node tests/paysh/probe-catalog.js --concurrency 8
//   node tests/paysh/probe-catalog.js --commit-captures   # write individual files too
//
// BAT-706 audit mode (--audit):
//   node tests/paysh/probe-catalog.js --audit             # probe every GET endpoint per service
//   node tests/paysh/probe-catalog.js --audit --filter paysponge
//   node tests/paysh/probe-catalog.js --audit --audit-side-effects  # also probe POST/PUT/PATCH/DELETE
//
// Standard mode probes ONE endpoint per service (typically the
// catalog-listed entry point) and writes to catalog-summary.md. Audit
// mode enumerates EVERY endpoint exposed in each service's
// openapi.json. By default audit only PROBES GET endpoints — non-GET
// (POST/PUT/PATCH/DELETE) endpoints are listed as
// `skipped:non_get_side_effect_risk` so the surface is still surveyed
// but no side effects can fire. Pass --audit-side-effects to actually
// probe them (most pay.sh services check x402 before any side effect,
// but it's not universally guaranteed).
//
// Audit writes to catalog-audit.md. Audit surfaces hidden paid
// endpoints the standard probe misses — e.g. paysponge/perplexity has
// /search + /v1/agent + /v1/sonar + /v1/async/sonar, but standard mode
// only captures one. Audit mode also takes longer (≈ services × avg
// endpoints × politeness delay).
//
// Per BAT-582 v1.6 spirit: pay.sh ecosystem is moving fast; this script
// surfaces drift across the WHOLE catalog (e.g. a new provider adopting
// a v3 field shape) in one pass.

'use strict';

const fs    = require('fs');
const path  = require('path');
const https = require('https');
const http  = require('http');
const { URL } = require('url');

const X402_PATH = require.resolve('../../app/src/main/assets/nodejs-project/payment/x402.js');
const { X402Protocol, _setBlockhashFetcher } = require(X402_PATH);

const { probe, sleep }  = require('./lib/probe');
const { sanitize }      = require('./lib/sanitize');

const CAPTURES_DIR = path.join(__dirname, 'captures', 'catalog');
const SUMMARY_FILE = path.join(__dirname, 'catalog-summary.md');
// BAT-706: audit mode probes every endpoint per service (vs the
// standard mode which probes one). Writes to a separate file so we
// don't churn the standard summary on every audit run.
const AUDIT_FILE = path.join(__dirname, 'catalog-audit.md');

// ── Static catalog (from solana-foundation/pay-skills `main` tree) ───────────
// Each entry = one PAY.md path. service_url is fetched from the file
// at probe time. We snapshot the path list here so the script can run
// offline-against-GitHub if needed (raw fetches still required for the
// service URL itself, but the catalog inventory is stable).
//
// To refresh: re-run the GitHub Trees API query against this repo (see
// README "Refreshing the catalog inventory").
const PAY_MD_PATHS = [
    'providers/agentmail/email/PAY.md',
    'providers/crushrewards/pricing/PAY.md',
    'providers/dtelecom/voice/PAY.md',
    'providers/merit-systems/stablecrypto/market-data/PAY.md',
    'providers/merit-systems/stabledomains/domains/PAY.md',
    'providers/merit-systems/stableemail/email/PAY.md',
    'providers/merit-systems/stableenrich/enrichment/PAY.md',
    'providers/merit-systems/stablemerch/merchandise/PAY.md',
    'providers/merit-systems/stablephone/calls/PAY.md',
    'providers/merit-systems/stablesocial/social-data/PAY.md',
    'providers/merit-systems/stableupload/hosting/PAY.md',
    'providers/paysponge/2captcha/PAY.md',
    'providers/paysponge/coingecko/PAY.md',
    'providers/paysponge/fal/PAY.md',
    'providers/paysponge/nyne/PAY.md',
    'providers/paysponge/perplexity/PAY.md',
    'providers/paysponge/reducto/PAY.md',
    'providers/paysponge/rentcast/PAY.md',
    'providers/paysponge/screenshotone/PAY.md',
    'providers/paysponge/textbelt/PAY.md',
    'providers/paysponge/tripadvisor/PAY.md',
    'providers/paysponge/wolframalpha/PAY.md',
    'providers/purch/marketplace/PAY.md',
    'providers/quicknode/rpc/PAY.md',
    'providers/socialintel/influencer-search/PAY.md',
    'providers/solana-foundation/alibaba/agentexplorer/PAY.md',
    'providers/solana-foundation/alibaba/aigen/PAY.md',
    'providers/solana-foundation/alibaba/anytrans/PAY.md',
    'providers/solana-foundation/alibaba/captcha/PAY.md',
    'providers/solana-foundation/alibaba/contactcenterai/PAY.md',
    'providers/solana-foundation/alibaba/documentparseservice/PAY.md',
    'providers/solana-foundation/alibaba/edututor/PAY.md',
    'providers/solana-foundation/alibaba/embeddings/PAY.md',
    'providers/solana-foundation/alibaba/facebody/PAY.md',
    'providers/solana-foundation/alibaba/farui/PAY.md',
    'providers/solana-foundation/alibaba/goodstech/PAY.md',
    'providers/solana-foundation/alibaba/green/PAY.md',
    'providers/solana-foundation/alibaba/imageaudit/PAY.md',
    'providers/solana-foundation/alibaba/imagerecog/PAY.md',
    'providers/solana-foundation/alibaba/imageseg/PAY.md',
    'providers/solana-foundation/alibaba/intelligentspeechinteraction/PAY.md',
    'providers/solana-foundation/alibaba/iqs/PAY.md',
    'providers/solana-foundation/alibaba/ivpd/PAY.md',
    'providers/solana-foundation/alibaba/machinetranslation/PAY.md',
    'providers/solana-foundation/alibaba/objectdet/PAY.md',
    'providers/solana-foundation/alibaba/ocr-api/PAY.md',
    'providers/solana-foundation/alibaba/ocr/PAY.md',
    'providers/solana-foundation/alibaba/paimodelgallery/PAY.md',
    'providers/solana-foundation/alibaba/rai/PAY.md',
    'providers/solana-foundation/alibaba/saf/PAY.md',
    'providers/solana-foundation/alibaba/speech/PAY.md',
    'providers/solana-foundation/alibaba/texttospeech/PAY.md',
    'providers/solana-foundation/alibaba/translate/PAY.md',
    'providers/solana-foundation/alibaba/viapi-ocr/PAY.md',
    'providers/solana-foundation/alibaba/videoenhan/PAY.md',
    'providers/solana-foundation/alibaba/videorecog/PAY.md',
    'providers/solana-foundation/alibaba/videoseg/PAY.md',
    'providers/solana-foundation/google/addressvalidation/PAY.md',
    'providers/solana-foundation/google/airquality/PAY.md',
    'providers/solana-foundation/google/bigquery/PAY.md',
    'providers/solana-foundation/google/civicinfo/PAY.md',
    'providers/solana-foundation/google/documentai/PAY.md',
    'providers/solana-foundation/google/factchecktools/PAY.md',
    'providers/solana-foundation/google/generativelanguage/PAY.md',
    'providers/solana-foundation/google/kgsearch/PAY.md',
    'providers/solana-foundation/google/language/PAY.md',
    'providers/solana-foundation/google/places/PAY.md',
    'providers/solana-foundation/google/speech/PAY.md',
    'providers/solana-foundation/google/texttospeech/PAY.md',
    'providers/solana-foundation/google/translate/PAY.md',
    'providers/solana-foundation/google/videointelligence/PAY.md',
    'providers/solana-foundation/google/vision/PAY.md',
];

const RAW_BASE = 'https://raw.githubusercontent.com/solana-foundation/pay-skills/main/';

// Test wallet pinned to the same fake-but-valid pubkey we use everywhere
// else (see validate-detect.js). build() needs SOME pubkey to construct
// the SPL transfer; we never sign so it doesn't have to control funds.
const TEST_BURNER_PUBKEY = '7xKXTg2CW87d97TXJSDpbD5jBkheTqA83TZRuJosgAsU';
const TEST_MAX_USDC_ATOMIC = 100_000_000n; // 100 USDC

// Stub blockhash so build() doesn't hit RPC.
_setBlockhashFetcher(async () => '2tLBHqeQdeq4Pzioote4ueMkQjrpdnNLBTuDtyKo4ds9');

// R-pr373-r4-2: validate --concurrency. parseInt returns NaN on garbage,
// and `runWithConcurrency(items, NaN, ...)` produces 0 workers (Array.from
// length NaN → 0) → script silently does no work. Reject invalid + clamp
// to [1, 50] (50 is a polite upper bound for raw.githubusercontent + pay.sh).
const MIN_CONCURRENCY = 1;
const MAX_CONCURRENCY = 50;
function _parseConcurrency(raw) {
    const n = parseInt(raw, 10);
    if (!Number.isFinite(n) || n < MIN_CONCURRENCY) {
        console.error(`Invalid --concurrency "${raw}" (must be integer ≥ ${MIN_CONCURRENCY}). Aborting.`);
        process.exit(1);
    }
    if (n > MAX_CONCURRENCY) {
        console.error(`--concurrency ${n} exceeds cap ${MAX_CONCURRENCY}; clamping to ${MAX_CONCURRENCY}.`);
        return MAX_CONCURRENCY;
    }
    return n;
}

function parseArgs(argv) {
    const out = {
        concurrency: 5,
        commitCaptures: false,
        limit: 0,
        filter: null,
        audit: false,
        // BAT-706 R2: by default, audit mode probes ONLY GET endpoints
        // to avoid triggering server-side side effects on POST/PUT/PATCH/
        // DELETE endpoints in the rare case the 402 check happens AFTER
        // body processing. Pass --audit-side-effects to opt in to probing
        // non-GET endpoints. POST in this codebase's other paid services
        // (Reducto, 2captcha, etc.) checks payment before any side effect,
        // but we can't assume that for every service in the upstream
        // catalog — be polite by default.
        auditSideEffects: false,
        // BAT-761 maintenance modes — mutually exclusive with standard/audit
        // AND with each other (R1 #7 — enforced below).
        drift: false,
        status: false,
        refreshId: null,
        // R1 #6 — --drift is a pure check by default. Caller passes
        // --write-checked-at to persist the manifest_checked_at bump
        // (e.g. in a scheduled job that wants the freshness signal).
        writeCheckedAt: false,
    };
    for (let i = 2; i < argv.length; i++) {
        if (argv[i] === '--concurrency' && argv[i + 1]) { out.concurrency = _parseConcurrency(argv[++i]); }
        else if (argv[i] === '--commit-captures') out.commitCaptures = true;
        else if (argv[i] === '--limit' && argv[i + 1]) out.limit = parseInt(argv[++i], 10);
        else if (argv[i] === '--filter' && argv[i + 1]) out.filter = argv[++i];
        else if (argv[i] === '--audit') out.audit = true;
        else if (argv[i] === '--audit-side-effects') out.auditSideEffects = true;
        else if (argv[i] === '--drift') out.drift = true;
        else if (argv[i] === '--status') out.status = true;
        else if (argv[i] === '--refresh') {
            // R8-1: --refresh requires an id argument. Pre-fix, `--refresh` without
            // a following arg silently fell through to standard probe mode — operator
            // would expect a single-entry refresh and get a full catalog probe instead.
            if (!argv[i + 1] || argv[i + 1].startsWith('--')) {
                console.error('ERROR: --refresh requires an entry id argument. Usage: --refresh <entry-id>');
                process.exit(2);
            }
            out.refreshId = argv[++i];
        }
        else if (argv[i] === '--write-checked-at') out.writeCheckedAt = true;
    }
    // R1 #7 — enforce mutual exclusion. Before this guard, "--audit --status"
    // silently ran status and ignored audit (or vice-versa).
    const modeFlags = [out.audit, out.drift, out.status, !!out.refreshId].filter(Boolean);
    if (modeFlags.length > 1) {
        console.error('ERROR: --audit / --drift / --status / --refresh are mutually exclusive. Pick one.');
        process.exit(2);
    }
    // R8-1: --write-checked-at only makes sense with --drift (the only mode
    // that writes manifest_checked_at). Pre-fix it was silently ignored when
    // passed to other modes — surprising the operator.
    if (out.writeCheckedAt && !out.drift) {
        console.error('ERROR: --write-checked-at only valid with --drift (it persists the manifest_checked_at bump after a drift check). Drop the flag or add --drift.');
        process.exit(2);
    }
    // R10-2: symmetric to R8-1 — --audit-side-effects only makes sense with
    // --audit (the only mode that probes endpoints with arbitrary methods).
    // Pre-fix the flag was silently ignored in standard/drift/status/refresh
    // modes; operator typo or misordered flags wouldn't surface.
    if (out.auditSideEffects && !out.audit) {
        console.error('ERROR: --audit-side-effects only valid with --audit (it opts into probing non-GET endpoints during the per-endpoint audit). Drop the flag or add --audit.');
        process.exit(2);
    }
    return out;
}

// Minimal frontmatter parser — pay-skills PAY.md uses 4-space-indented
// scalar values (no nesting beyond `tags:` list); we only need a handful
// of top-level fields, so a regex-per-field grab is enough.
function parseFrontmatter(md) {
    const m = md.match(/^---\s*\n([\s\S]*?)\n---/);
    if (!m) return {};
    const fm = m[1];
    const out = {};
    for (const field of ['service_url', 'name', 'service_id', 'category', 'description', 'provider']) {
        const re = new RegExp(`^${field}:\\s*"?([^"\\n]+)"?\\s*$`, 'm');
        const mf = fm.match(re);
        if (mf) out[field] = mf[1].trim();
    }
    return out;
}

// R-pr373-r4-1: bound redirect chain depth to prevent unbounded recursion
// on a misbehaving server (redirect loop, or long chain). Default budget
// is 5 hops — plenty for legitimate CDN redirects (raw.githubusercontent
// usually doesn't redirect; some openapi-hosting CDNs do once or twice).
// On exhaustion we return an error rather than throwing or stack-overflowing.
const MAX_REDIRECTS = 5;
function fetchText(url, timeoutMs = 15000, redirectsLeft = MAX_REDIRECTS) {
    return new Promise((resolve) => {
        const parsed = new URL(url);
        const lib = parsed.protocol === 'https:' ? https : http;
        const req = lib.request({
            hostname: parsed.hostname,
            port: parsed.port || (parsed.protocol === 'https:' ? 443 : 80),
            path: parsed.pathname + parsed.search,
            method: 'GET',
            headers: {
                'Accept': '*/*',
                'User-Agent': 'SeekerClaw-paysh-catalog/1.0 (+https://github.com/sepivip/SeekerClaw)',
            },
        }, (res) => {
            // Follow redirects up to MAX_REDIRECTS deep. Pre-fix the
            // comment claimed "one redirect" but the recursion had no
            // depth bound — a redirect loop would have hung the script.
            if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
                res.resume();
                if (redirectsLeft <= 0) {
                    return resolve({ error: `too many redirects (>${MAX_REDIRECTS}) starting at ${url}` });
                }
                return resolve(fetchText(new URL(res.headers.location, url).toString(), timeoutMs, redirectsLeft - 1));
            }
            const chunks = [];
            res.on('data', c => chunks.push(c));
            res.on('end', () => resolve({ status: res.statusCode, body: Buffer.concat(chunks).toString('utf8') }));
        });
        req.on('error', e => resolve({ error: e.message }));
        req.setTimeout(timeoutMs, () => req.destroy(new Error(`fetch timeout after ${timeoutMs}ms`)));
        req.end();
    });
}

function _substituteParams(p) {
    // OpenAPI uses {param}; Express-style services (merit-systems stable*)
    // use :param. Stub both with the literal "probe" — any 402 we want
    // to capture pre-empts the path parser server-side.
    // Express `:param` must be a whole path segment (preceded by `/`).
    // Google services use `:verb` suffixes (e.g. `/v1/images:annotate`)
    // which look similar but are NOT params — guard against those by
    // requiring the leading slash.
    return p.replace(/\{[^}]+\}/g, 'probe').replace(/(^|\/):[a-zA-Z_][a-zA-Z0-9_]*/g, '$1probe');
}

function _hasParam(p) { return /\{[^}]+\}|(^|\/):[a-zA-Z_][a-zA-Z0-9_]*/.test(p); }

// BAT-706: extract ALL endpoints from an OpenAPI spec (not just one).
// Used by audit mode (--audit) to surface hidden paid endpoints that
// the single-endpoint probe (pickProbeEndpoint) would miss for
// multi-endpoint providers like paysponge/perplexity (which exposes
// /search, /v1/agent, /v1/sonar, /v1/async/sonar) or paysponge/coingecko
// (/x402/simple/price, /x402/onchain/networks/{n}/trending_pools, etc.).
//
// Returns array of {method, path, hasParam} entries. Params are
// stubbed with "probe" using the same _substituteParams helper that
// pickProbeEndpoint uses for parametric paths.
function extractAllEndpoints(openapi) {
    const paths = openapi && openapi.paths;
    if (!paths || typeof paths !== 'object') return [];
    const out = [];
    const seen = new Set();
    for (const p of Object.keys(paths)) {
        const ops = paths[p];
        if (!ops || typeof ops !== 'object') continue;
        for (const method of ['get', 'post', 'put', 'patch', 'delete']) {
            if (!ops[method]) continue;
            const hasParam = _hasParam(p);
            const finalPath = hasParam ? _substituteParams(p) : p;
            const key = `${method.toUpperCase()} ${finalPath}`;
            if (seen.has(key)) continue;
            seen.add(key);
            out.push({ method: method.toUpperCase(), path: finalPath, hasParam, rawPath: p });
        }
    }
    return out;
}

function pickProbeEndpoint(openapi) {
    // Strategy: prefer parameter-free GET, then parametric GET (stub
    // params with "probe"), then POST as a last resort. Most pay.sh
    // services 402 before the body parser, so POST with empty body
    // still surfaces the payment requirement we need.
    const paths = openapi && openapi.paths;
    if (!paths || typeof paths !== 'object') return null;

    // Phase 1: parameter-free GET.
    for (const p of Object.keys(paths)) {
        const ops = paths[p];
        if (!ops || typeof ops !== 'object') continue;
        if (ops.get && !_hasParam(p)) return { method: 'GET', path: p };
    }
    // Phase 2: parametric GET.
    for (const p of Object.keys(paths)) {
        const ops = paths[p];
        if (!ops || typeof ops !== 'object') continue;
        if (ops.get) return { method: 'GET', path: _substituteParams(p) };
    }
    // Phase 3: parameter-free POST.
    for (const p of Object.keys(paths)) {
        const ops = paths[p];
        if (!ops || typeof ops !== 'object') continue;
        if (ops.post && !_hasParam(p)) return { method: 'POST', path: p };
    }
    // Phase 4: parametric POST.
    for (const p of Object.keys(paths)) {
        const ops = paths[p];
        if (!ops || typeof ops !== 'object') continue;
        if (ops.post) return { method: 'POST', path: _substituteParams(p) };
    }
    return null;
}

function detectAltProtocol(capture) {
    // pay.sh's catalog includes services that 402 but don't speak x402.
    // We surface them as distinct reject codes so the summary isn't a
    // wall of `no_payment_requirements` (which conflates "x402 with no
    // accepts" with "completely different protocol").
    //
    //   - MPP: alibaba + google gateways under `*.gateway-402.com`.
    //     Body has `payment.protocol === 'mpp'`, no x402 fields.
    //   - SIWX: merit-systems stable* services. Body has
    //     `extensions.sign-in-with-x` and `accepts: []`.
    const body = capture.body;
    if (!body || typeof body !== 'object') return null;
    if (body.payment && body.payment.protocol === 'mpp') return 'mpp_protocol';
    if (body.extensions && body.extensions['sign-in-with-x']) return 'siwx_auth_required';
    return null;
}

function extractRequirements(capture) {
    // Mirrors probe-all.js summarize402, but tolerant to non-402 status.
    const body = capture.body;
    let payload = null;
    let delivery = 'none';
    if (typeof body === 'object' && body !== null && (body.accepts || body.paymentRequirements)) {
        payload = body;
        delivery = 'body';
    } else if (capture.headers && capture.headers['payment-required']) {
        try {
            payload = JSON.parse(Buffer.from(capture.headers['payment-required'], 'base64').toString('utf8'));
            delivery = 'header';
        } catch (_) { delivery = 'header-malformed'; }
    }
    if (!payload) return { delivery, x402Version: null, networks: [], offerCount: 0 };
    const accepts = payload.accepts || payload.paymentRequirements || [];
    return {
        delivery,
        x402Version: payload.x402Version ?? null,
        networks: Array.isArray(accepts) ? accepts.map(a => a.network).filter(Boolean) : [],
        assets:   Array.isArray(accepts) ? accepts.map(a => a.asset).filter(Boolean) : [],
        amounts:  Array.isArray(accepts) ? accepts.map(a => a.amount ?? a.maxAmountRequired).filter(v => v !== undefined) : [],
        schemes:  Array.isArray(accepts) ? accepts.map(a => a.scheme).filter(Boolean) : [],
        offerCount: Array.isArray(accepts) ? accepts.length : 0,
    };
}

async function discoverOne(payMdPath) {
    // Returns { ok, operator, name, serviceUrl, probePath, probeMethod, error }
    const rawUrl = RAW_BASE + payMdPath;
    const md = await fetchText(rawUrl);
    if (md.error || md.status !== 200) {
        return { ok: false, payMdPath, error: `pay-md fetch failed: ${md.error || md.status}` };
    }
    const fm = parseFrontmatter(md.body);
    const serviceUrl = fm.service_url;
    const parts = payMdPath.split('/');
    // providers/<operator>/.../<svc-name>/PAY.md
    const operator = parts[1];
    const name = parts.slice(2, -1).join('/');
    if (!serviceUrl) {
        return { ok: false, payMdPath, operator, name, error: 'no service_url in frontmatter' };
    }

    // Discover a probe endpoint via openapi.json. Most pay.sh services
    // expose this at <service_url>/openapi.json (confirmed across
    // alibaba.gateway-402, google.gateway-402, paysponge, dtelecom,
    // agentmail, stablesocial, quicknode).
    const openapiUrl = serviceUrl.replace(/\/$/, '') + '/openapi.json';
    const oa = await fetchText(openapiUrl, 15000);
    let probePath = null, probeMethod = 'GET';
    // R11-B1: cache the parsed openapi (or the error) so auditService can
    // reuse it instead of re-fetching the same URL during Phase 2. This
    // halves the openapi traffic and tightens the rate-limit posture.
    let openapiCache = null;
    let openapiError = null;
    if (oa.status === 200) {
        try {
            const openapi = JSON.parse(oa.body);
            openapiCache = openapi;
            const picked = pickProbeEndpoint(openapi);
            if (picked) { probePath = picked.path; probeMethod = picked.method; }
        } catch (e) {
            openapiError = `openapi parse failed: ${e.message}`;
        }
    } else {
        openapiError = oa.error
            ? `openapi fetch failed: ${oa.error}`
            : `openapi fetch failed: status ${oa.status}`;
    }
    return {
        ok: true,
        payMdPath, operator, name,
        serviceUrl,
        probeUrl: probePath ? (serviceUrl.replace(/\/$/, '') + probePath) : serviceUrl,
        probeMethod,
        openapiOk: oa.status === 200 && !openapiError,
        openapi: openapiCache,
        openapiError,
    };
}

async function probeAndParse(disc, proto) {
    // Run a single probe + parse, return a row for the summary. For POST
    // probes we send an empty JSON body; pay.sh services check payment
    // before parsing body, so this still surfaces the 402.
    const probeOpts = { url: disc.probeUrl, method: disc.probeMethod };
    if (disc.probeMethod === 'POST') probeOpts.body = {};
    const captured = await probe(probeOpts);
    if (captured.error) {
        return {
            disc, captured: null,
            row: { result: 'fetch_failed', detail: captured.reason || captured.error },
        };
    }
    const reqs = extractRequirements(captured);
    const isV402 = captured.status === 402;

    // Run the parser
    let detected = null, builtError = null, builtOk = false;
    if (isV402) {
        const response = { status: captured.status, bodyJson: captured.body, headers: captured.headers };
        detected = proto.detect(response);
        try {
            const built = await proto.build(response, {
                burnerPubkey: TEST_BURNER_PUBKEY,
                maxUsdcAtomic: TEST_MAX_USDC_ATOMIC,
            });
            if (built && built.error) builtError = built.error;
            else if (built && built.txBase64 && built.paymentMeta) builtOk = true;
            else builtError = 'unexpected_shape';
        } catch (e) {
            builtError = `threw:${e.message.slice(0, 40)}`;
        }
    }

    let result;
    const altProto = isV402 ? detectAltProtocol(captured) : null;
    if (!isV402) result = `http_${captured.status}`;
    else if (builtOk) result = 'parsed_ok';
    else if (altProto) result = `reject:${altProto}`;
    else if (builtError) result = `reject:${builtError}`;
    else result = 'detect_false';

    return {
        disc, captured,
        row: {
            result,
            httpStatus: captured.status,
            delivery: reqs.delivery,
            x402Version: reqs.x402Version,
            networks: reqs.networks,
            assets: reqs.assets,
            schemes: reqs.schemes,
            amounts: reqs.amounts,
            offerCount: reqs.offerCount,
            detected,
            builtOk,
            builtError,
        },
    };
}

// BAT-706: audit one service by probing EVERY endpoint declared in its
// openapi.json (not just the one pickProbeEndpoint would pick). Used by
// --audit mode to surface hidden paid endpoints that the standard probe
// would miss.
//
// SAFETY (R2): by default, skips non-GET endpoints to avoid triggering
// server-side side effects. POST/PUT/PATCH/DELETE endpoints in the
// upstream pay.sh catalog generally check the x402 payment BEFORE any
// side effect runs, but we can't assume that universally — e.g. a
// temporarily ungated POST that accepts an empty body would actually
// execute when we probe. Pass --audit-side-effects to include them.
//
// RATE LIMIT (R3 #6 + R6): each service's endpoints are probed serially
// with a 1000ms inter-request delay (POLITE_DELAY_MS). Pre-R3-fix this
// was 150ms (~6-7 req/sec per service); R3 bumped to 1000ms to match
// probe-all.js's contract.
//
// CAVEAT (R6): the rate limit is enforced PER SERVICE, not per HOST.
// Different pay.sh services can share the same hostname — e.g. all 11
// paysponge services use *.x402.paysponge.com or api.paysponge.com.
// With the outer runWithConcurrency parallelizing across services, a
// shared-host group under --concurrency=N can issue up to N req/sec to
// that one host even though each individual service stays at 1 req/sec.
//
// Practical effect: for audits against multi-service hosts (paysponge,
// merit-systems, alibaba.gateway-402, google.gateway-402), use
// --concurrency 1 to enforce a true per-host 1 req/sec ceiling. With
// --concurrency 4 (the documented default in some examples), the
// per-host burst against api.paysponge.com can reach ~4 req/sec — still
// within most rate-limit policies but stricter than the per-host contract.
//
// A proper per-host rate limiter (semaphore keyed by hostname) is
// follow-up work; deferred to keep this script focused.
//
// Returns { disc, endpoints: [{ method, path, probeUrl, row, captured }] }
// where each `row` mirrors what probeAndParse produces for one probe.
async function auditService(disc, proto, opts = {}) {
    const includeSideEffects = !!opts.auditSideEffects;
    const POLITE_DELAY_MS = 1000;
    const result = { disc, endpoints: [] };
    if (!disc.ok) {
        result.error = disc.error;
        return result;
    }
    // R11-B1: reuse the openapi parsed during discoverOne (Phase 1).
    // Pre-fix this re-fetched the same URL, doubling openapi traffic
    // before any endpoint probes and bypassing per-service politeness.
    // Now we just consume the cached parsed object or propagate the
    // recorded error.
    let openapi;
    if (disc.openapi) {
        openapi = disc.openapi;
    } else if (disc.openapiError) {
        result.error = disc.openapiError;
        return result;
    } else {
        // Defensive: discoverOne should always set one of the two, but
        // if it doesn't (e.g. a future refactor), fall back to a fresh
        // fetch so audit doesn't silently drop the service.
        const openapiUrl = disc.serviceUrl.replace(/\/$/, '') + '/openapi.json';
        const oa = await fetchText(openapiUrl, 15000);
        if (oa.status !== 200) {
            result.error = oa.error
                ? `openapi fetch failed: ${oa.error}`
                : `openapi fetch failed: status ${oa.status}`;
            return result;
        }
        try {
            openapi = JSON.parse(oa.body);
        } catch (e) {
            result.error = `openapi parse failed: ${e.message}`;
            return result;
        }
    }
    const endpoints = extractAllEndpoints(openapi);
    if (!endpoints.length) {
        result.error = 'openapi has no endpoints';
        return result;
    }
    // Probe each endpoint serially within this service (avoid hammering
    // the same host). Outer runWithConcurrency parallelizes across
    // services, not within one.
    let isFirst = true;
    for (const ep of endpoints) {
        // R2 safety: skip non-GET unless explicitly opted in.
        if (ep.method !== 'GET' && !includeSideEffects) {
            result.endpoints.push({
                ...ep,
                probeUrl: disc.serviceUrl.replace(/\/$/, '') + ep.path,
                row: { result: 'skipped:non_get_side_effect_risk' },
            });
            continue;
        }
        // R2 politeness: brief inter-request delay per service.
        if (!isFirst) await sleep(POLITE_DELAY_MS);
        isFirst = false;
        const probeUrl = disc.serviceUrl.replace(/\/$/, '') + ep.path;
        const probeOpts = { url: probeUrl, method: ep.method };
        if (ep.method !== 'GET') probeOpts.body = {};
        const captured = await probe(probeOpts);
        if (captured.error) {
            result.endpoints.push({ ...ep, probeUrl, row: { result: 'fetch_failed', detail: captured.reason || captured.error } });
            continue;
        }
        const reqs = extractRequirements(captured);
        const isV402 = captured.status === 402;
        let detected = null, builtError = null, builtOk = false;
        if (isV402) {
            const response = { status: captured.status, bodyJson: captured.body, headers: captured.headers };
            detected = proto.detect(response);
            try {
                const built = await proto.build(response, {
                    burnerPubkey: TEST_BURNER_PUBKEY,
                    maxUsdcAtomic: TEST_MAX_USDC_ATOMIC,
                });
                if (built && built.error) builtError = built.error;
                else if (built && built.txBase64 && built.paymentMeta) builtOk = true;
                else builtError = 'unexpected_shape';
            } catch (e) {
                builtError = `threw:${e.message.slice(0, 40)}`;
            }
        }
        const altProto = isV402 ? detectAltProtocol(captured) : null;
        let outcome;
        if (!isV402) outcome = `http_${captured.status}`;
        else if (builtOk) outcome = 'parsed_ok';
        else if (altProto) outcome = `reject:${altProto}`;
        else if (builtError) outcome = `reject:${builtError}`;
        else outcome = 'detect_false';
        result.endpoints.push({
            ...ep,
            probeUrl,
            captured,
            row: {
                result: outcome,
                httpStatus: captured.status,
                delivery: reqs.delivery,
                x402Version: reqs.x402Version,
                networks: reqs.networks,
                assets: reqs.assets,
                amounts: reqs.amounts,
                offerCount: reqs.offerCount,
            },
        });
    }
    return result;
}

async function runWithConcurrency(items, limit, fn) {
    const out = new Array(items.length);
    let idx = 0;
    const workers = Array.from({ length: limit }, async () => {
        while (true) {
            const i = idx++;
            if (i >= items.length) return;
            out[i] = await fn(items[i], i);
        }
    });
    await Promise.all(workers);
    return out;
}

function fmtNetworks(ns) {
    return ns.map(n => n.startsWith('solana:') ? 'sol' : n.includes('eip155:8453') ? 'base' : n.split(':')[0] || n).join('+') || '—';
}

// BAT-706: write per-endpoint audit report.
function writeAuditReport(auditResults, elapsedMs, opts = {}) {
    const lines = [];
    lines.push('# pay.sh catalog audit — multi-endpoint probe per service');
    lines.push('');
    lines.push(`Generated: ${new Date().toISOString()}`);
    // R2 transparency: record the actual invocation so readers don't
    // assume "audit" means full-catalog when it was filtered.
    // R7: also record --concurrency since it affects per-host burst rate
    // (per R6's per-service-not-per-host caveat); without it the audit
    // run isn't reproducible or rate-reviewable from this Source line.
    const filterNote = opts.filter ? ` --filter ${opts.filter}` : '';
    const sideEffectsNote = opts.auditSideEffects ? ' --audit-side-effects' : '';
    const limitNote = opts.limit ? ` --limit ${opts.limit}` : '';
    const concurrencyNote = (typeof opts.concurrency === 'number') ? ` --concurrency ${opts.concurrency}` : '';
    lines.push(`Source: probe-catalog.js --audit${concurrencyNote}${filterNote}${sideEffectsNote}${limitNote}`);
    if (opts.filter) {
        lines.push(`**Scope note**: this run was FILTERED to "${opts.filter}" — aggregate counts below are for the filtered subset, NOT the full ~72-service upstream catalog. Re-run without --filter for a full-catalog audit.`);
    }
    if (!opts.auditSideEffects) {
        lines.push(`**Safety note**: non-GET endpoints were SKIPPED to avoid triggering server-side side effects. Use \`--audit-side-effects\` to include POST/PUT/PATCH/DELETE probes (most pay.sh services check x402 payment before any side effect runs, but it's not universally guaranteed).`);
    }
    lines.push('');

    // R3 #1: separate buckets so skipped/fetch-failed don't get counted
    // as live non-402 HTTP responses. Pre-fix any non-parsed_ok/non-reject
    // result fell into notV402, including `skipped:non_get_side_effect_risk`
    // (never probed) and `fetch_failed` (no HTTP response observed).
    let totalEndpoints = 0;
    let parsedOk = 0;
    let rejected = 0;
    let notV402 = 0;
    let skipped = 0;
    let fetchFailed = 0;
    for (const r of auditResults) {
        if (!r.endpoints) continue;
        for (const e of r.endpoints) {
            totalEndpoints++;
            if (e.row.result === 'parsed_ok') parsedOk++;
            else if (e.row.result.startsWith('reject:')) rejected++;
            else if (e.row.result.startsWith('skipped:')) skipped++;
            else if (e.row.result === 'fetch_failed') fetchFailed++;
            else if (e.row.result.startsWith('http_')) notV402++;
            else notV402++; // unknown classification — bucket conservatively
        }
    }

    lines.push('## Aggregate');
    lines.push('');
    lines.push('| Metric | Count |');
    lines.push('|--------|-------|');
    lines.push(`| Services audited | ${auditResults.length} |`);
    lines.push(`| Endpoints discovered (across all services) | ${totalEndpoints} |`);
    lines.push(`| **Parsed OK** (Solana-USDC parseable 402) | ${parsedOk} |`);
    lines.push(`| Rejected (402 but parser refused) | ${rejected} |`);
    lines.push(`| Non-402 HTTP response (http_4xx/5xx/3xx/2xx) | ${notV402} |`);
    lines.push(`| Skipped (non-GET, side-effect risk; opt in via --audit-side-effects) | ${skipped} |`);
    lines.push(`| Fetch failed (DNS / TLS / timeout — no HTTP response) | ${fetchFailed} |`);
    lines.push(`| Audit elapsed | ${(elapsedMs / 1000).toFixed(1)}s |`);
    lines.push('');

    // R2: section now honestly named — it's ALL parsed_ok endpoints, not
    // pre-filtered against catalog-summary.md. Reader must cross-reference
    // to find true "new candidates"; we don't auto-diff because catalog-
    // summary entries are per-service (one URL each) while audit entries
    // are per-endpoint, so the join isn't 1:1 trivial.
    lines.push('## All parsed_ok endpoints from this audit run');
    lines.push('');
    lines.push('Every endpoint that parsed_ok with a Solana-USDC leg. This includes endpoints already in our standard catalog (`tests/paysh/catalog-summary.md`) AND endpoints we don\'t currently catalog. Cross-reference manually with catalog-summary.md to identify the audit\'s new discoveries (multi-endpoint providers like paysponge/perplexity and paysponge/rentcast typically show many endpoints here that catalog-summary records as only one per service).');
    lines.push('');
    lines.push('| Service | Method | Path | Networks | Asset | Amount | Result |');
    lines.push('|---------|--------|------|----------|-------|--------|--------|');
    for (const r of auditResults) {
        if (!r.endpoints) continue;
        for (const e of r.endpoints) {
            if (e.row.result !== 'parsed_ok') continue;
            const svc = r.disc.payMdPath ? r.disc.payMdPath.split('/').slice(1, -1).join('/') : '?';
            const nets = fmtNetworks(e.row.networks || []);
            // R4 #1: parsed_ok means proto.build() picked the Solana
            // entry. Pre-fix the report rendered accepts[0] which is
            // typically the Base/EVM offer (multi-chain pay.sh challenges
            // list Base first), so rows tagged `parsed_ok` Solana-USDC
            // showed Asset=EVM and could show the wrong amount when
            // chains advertise different prices. Find the Solana index
            // explicitly and use that for asset/amount display.
            const networks = e.row.networks || [];
            const solanaIdx = networks.findIndex(n => typeof n === 'string' && n.startsWith('solana:'));
            const pickIdx = solanaIdx >= 0 ? solanaIdx : 0;
            const asset = fmtAssetKind((e.row.assets || [])[pickIdx]);
            const amount = fmtAmount(((e.row.amounts || [])[pickIdx]) !== undefined ? [(e.row.amounts || [])[pickIdx]] : []);
            lines.push(`| ${svc} | ${e.method} | \`${e.path}\` | ${nets} | ${asset} | ${amount} | \`${e.row.result}\` |`);
        }
    }
    lines.push('');

    // Per-service errors (services where audit couldn't probe anything)
    lines.push('## Audit errors (services where openapi.json was unreachable or empty)');
    lines.push('');
    let anyErrors = false;
    for (const r of auditResults) {
        if (r.error) {
            const svc = r.disc.payMdPath ? r.disc.payMdPath.split('/').slice(1, -1).join('/') : '?';
            lines.push(`- **${svc}**: ${r.error}`);
            anyErrors = true;
        }
    }
    if (!anyErrors) lines.push('_(none)_');
    lines.push('');

    // Per-service full results (every endpoint, every result code)
    lines.push('## Full per-service breakdown');
    lines.push('');
    for (const r of auditResults) {
        if (!r.endpoints || r.endpoints.length === 0) continue;
        const svc = r.disc.payMdPath ? r.disc.payMdPath.split('/').slice(1, -1).join('/') : '?';
        lines.push(`### ${svc}`);
        lines.push('');
        lines.push(`Service URL: \`${r.disc.serviceUrl}\``);
        lines.push('');
        lines.push('| Method | Path | Result | Networks | Amount |');
        lines.push('|--------|------|--------|----------|--------|');
        for (const e of r.endpoints) {
            const nets = fmtNetworks(e.row.networks || []);
            // R11-B2: match the parsed_ok summary table's Solana-index
            // pickup. Pre-fix this rendered `amounts[0]` which is typically
            // the Base/EVM offer (multi-chain pay.sh challenges list Base
            // first); a row whose `parsed_ok` status came from the Solana
            // leg could show a Base/EVM price. For non-parsed_ok rows
            // (rejected / non-402 / skipped) Solana-index isn't meaningful
            // — `findIndex` returns -1 and we fall back to amounts[0] as
            // before, so reject diagnostics still render.
            const networks = e.row.networks || [];
            const solanaIdx = networks.findIndex(n => typeof n === 'string' && n.startsWith('solana:'));
            const pickIdx = solanaIdx >= 0 ? solanaIdx : 0;
            const amounts = e.row.amounts || [];
            const amount = fmtAmount(amounts[pickIdx] !== undefined ? [amounts[pickIdx]] : amounts);
            lines.push(`| ${e.method} | \`${e.path}\` | \`${e.row.result}\` | ${nets} | ${amount} |`);
        }
        lines.push('');
    }

    fs.writeFileSync(AUDIT_FILE, lines.join('\n') + '\n', 'utf8');
    console.log(`\n═══ Audit summary ═══`);
    console.log(`  services audited:      ${auditResults.length}`);
    console.log(`  endpoints discovered:  ${totalEndpoints}`);
    console.log(`  parsed_ok:             ${parsedOk}`);
    console.log(`  rejected:              ${rejected}`);
    console.log(`  non-402 HTTP:          ${notV402}`);
    console.log(`  skipped (non-GET):     ${skipped}`);
    console.log(`  fetch_failed:          ${fetchFailed}`);
    console.log(`  elapsed:               ${(elapsedMs / 1000).toFixed(1)}s`);
    console.log(`\n  Summary written to ${path.relative(process.cwd(), AUDIT_FILE)}`);
}

function fmtAssetKind(asset) {
    if (!asset) return '—';
    if (asset === 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v') return 'USDC';
    if (asset.startsWith('0x')) return 'EVM';
    if (asset.length === 44 || asset.length === 43) return 'SPL';
    return asset.slice(0, 6) + '…';
}

function fmtAmount(amounts) {
    if (!amounts || !amounts.length) return '—';
    const a = String(amounts[0]);
    // Numeric atomic USDC → decimal USDC display ($x.yz)
    if (/^\d+$/.test(a)) {
        // R-pr373-r6-1: BigInt-safe formatting. Pre-fix used
        // `Number(atomic) / 1e6` which loses precision for values above
        // Number.MAX_SAFE_INTEGER (~9e15 — ~9 trillion USDC, unrealistic
        // but possible if a service advertises a malformed huge amount;
        // we'd render Infinity in the catalog summary, which is worse
        // than the raw string). String-math via padStart is BigInt-safe
        // for any value the protocol parser can construct.
        return `$${_bigIntAtomicToDecimal(BigInt(a), 6)}`;
    }
    return a;
}

// BigInt-safe USDC atomic → trimmed decimal string. Same algorithm as
// `_atomicBigIntToDecimal` in `app/.../tools/index.js` and
// `_atomicToDecimalString` in `app/.../tools/agent_pay.js` — kept local
// here to avoid pulling the Android app's tools/ module into a test
// script (which doesn't and shouldn't have those transitive requires).
function _bigIntAtomicToDecimal(atomicBig, decimals) {
    if (typeof atomicBig !== 'bigint') return '?';
    let s = atomicBig.toString();
    const negative = s.startsWith('-');
    if (negative) s = s.slice(1);
    if (s === '0') return '0';
    const pad = s.padStart(decimals + 1, '0');
    const head = pad.slice(0, pad.length - decimals);
    const tail = pad.slice(pad.length - decimals).replace(/0+$/, '');
    const out = tail.length ? `${head}.${tail}` : head;
    return negative ? `-${out}` : out;
}

// ── BAT-761: maintenance modes (--drift / --status / --refresh <id>) ────────

const SKILL_DIR = path.join(__dirname, '..', '..', 'app', 'src', 'main', 'assets', 'default-skills', 'paysh-catalog');
const CATALOG_V2 = path.join(SKILL_DIR, 'catalog.json');
const UNSUPPORTED_V2 = path.join(SKILL_DIR, 'unsupported.json');
const STATUS_FILE = path.join(__dirname, 'catalog-status.md');
const FRESHNESS_DAYS = 30;
const PAY_SKILLS_TREE_URL = 'https://api.github.com/repos/solana-foundation/pay-skills/git/trees/main?recursive=1';

function _readV2(p) {
    const data = JSON.parse(fs.readFileSync(p, 'utf8'));
    // R3-1: SCHEMA.md spec says v2 readers should accept `version >= 2` so
    // future schema bumps (v3+) don't break existing tooling. Treat unknown
    // future-version fields as opaque (we don't read them; pass-through on write).
    if (typeof data.version !== 'number' || data.version < 2) {
        const got = data.version === undefined ? 'v1 (no version field)' : `version=${data.version}`;
        throw new Error(`${p}: expected version >= 2, got ${got} — run "node tests/paysh/migrate-v1-to-v2.js" first`);
    }
    return data;
}

function _writeV2(p, data) {
    fs.writeFileSync(p, JSON.stringify(data, null, 2) + '\n', 'utf8');
}

function _ageDays(isoTimestamp) {
    if (!isoTimestamp) return Infinity;
    return (Date.now() - new Date(isoTimestamp).getTime()) / 86400000;
}

// ─── --drift: fetch upstream pay-skills tree, diff against catalog/unsupported ──
async function runDrift(args) {
    console.log(`drift check — fetching ${PAY_SKILLS_TREE_URL}\n`);
    const tree = await fetchText(PAY_SKILLS_TREE_URL, 30000);
    if (tree.status !== 200) {
        console.error(`Failed to fetch pay-skills tree: status ${tree.status}, error ${tree.error || ''}`);
        process.exit(2);
    }
    let upstreamPayMdPaths;
    try {
        const json = JSON.parse(tree.body);
        // R7-2: GitHub Trees API returns `{ truncated: true }` if the recursive
        // listing exceeds 100k entries OR 7MB. pay-skills today is far smaller
        // (a few hundred files) but if the repo grows or restructures, we'd
        // silently see false "no drift" / missing-services false negatives.
        // Fail loudly so operator notices and switches to a non-truncating
        // enumeration strategy (e.g. recursive contents API per provider/ dir).
        if (json.truncated === true) {
            console.error('ERROR: GitHub Trees API returned truncated=true — upstream PAY.md inventory is INCOMPLETE.');
            console.error('Drift comparison would be unreliable. Switch to a non-truncating enumeration before re-running --drift.');
            process.exit(2);
        }
        upstreamPayMdPaths = (json.tree || []).filter(n => n.path && n.path.endsWith('/PAY.md')).map(n => n.path);
    } catch (e) {
        console.error(`Failed to parse pay-skills tree: ${e.message}`);
        process.exit(2);
    }
    const upstream = new Set(upstreamPayMdPaths);

    const catalog = _readV2(CATALOG_V2);
    const unsupported = _readV2(UNSUPPORTED_V2);
    const localPayMdPaths = new Set([
        ...catalog.entries.map(e => e.upstream_ref.pay_md_path),
        ...unsupported.entries.map(e => e.upstream_ref.pay_md_path),
    ]);

    const upstreamAdded = [...upstream].filter(p => !localPayMdPaths.has(p));
    const localOnly = [...localPayMdPaths].filter(p => !upstream.has(p));
    // R1 #5 — only entries with a real last_captured_at can be "stale".
    // Pre-fix _ageDays(null) returned Infinity, so every never-captured entry
    // got reported as "older than 30d" — drastically inflated the stale count
    // and made the label misleading.
    const allEntries = [...catalog.entries, ...unsupported.entries];
    const stale = allEntries
        .filter(e => e.verification.last_captured_at && _ageDays(e.verification.last_captured_at) > FRESHNESS_DAYS)
        .map(e => ({ id: e.id, age_days: Math.floor(_ageDays(e.verification.last_captured_at)) }));
    const neverCaptured = allEntries.filter(e => !e.verification.last_captured_at);

    console.log(`Upstream PAY.md paths:           ${upstream.size}`);
    console.log(`Local catalog+unsupported:       ${localPayMdPaths.size}`);
    console.log(`Upstream added (NEW):            ${upstreamAdded.length}`);
    console.log(`Local-only (REMOVED upstream):   ${localOnly.length}`);
    console.log(`Captures older than ${FRESHNESS_DAYS}d:      ${stale.length}`);
    console.log(`Never captured (probe never 402): ${neverCaptured.length}`);
    if (upstreamAdded.length) {
        console.log(`\nNEW upstream services not yet in our catalog/unsupported:`);
        for (const p of upstreamAdded) console.log(`  + ${p}`);
    }
    if (localOnly.length) {
        console.log(`\nServices in our catalog/unsupported that no longer exist upstream:`);
        for (const p of localOnly) console.log(`  - ${p}`);
    }
    if (stale.length) {
        console.log(`\nEntries with stale captures (last_captured_at > ${FRESHNESS_DAYS}d):`);
        for (const s of stale.slice(0, 20)) console.log(`  ${s.id} (${s.age_days}d)`);
        if (stale.length > 20) console.log(`  … and ${stale.length - 20} more`);
    }

    // R1 #6 — --drift defaults to a PURE check (no file mutations). Pass
    // --write-checked-at to persist the manifest_checked_at bump (use in
    // scheduled jobs that want the freshness signal recorded).
    if (args && args.writeCheckedAt) {
        const now = new Date().toISOString();
        catalog.manifest_checked_at = now;
        unsupported.manifest_checked_at = now;
        // R9-1: SCHEMA.md says generated_at = "when this file was written".
        // --drift --write-checked-at mutates the file → must bump generated_at
        // too, else --status would report a stale "last modified" timestamp.
        catalog.generated_at = now;
        unsupported.generated_at = now;
        _writeV2(CATALOG_V2, catalog);
        _writeV2(UNSUPPORTED_V2, unsupported);
        console.log(`\nmanifest_checked_at + generated_at bumped to ${now} (--write-checked-at)`);
    } else {
        console.log(`\nPure check — neither catalog.json nor unsupported.json modified. Pass --write-checked-at to persist manifest_checked_at.`);
    }

    const drifted = upstreamAdded.length + localOnly.length;
    if (drifted > 0) {
        console.error(`\nDRIFT DETECTED — ${drifted} upstream changes`);
        process.exit(3);  // CI-friendly non-zero
    }
    console.log(`\nNo drift detected (all upstream paths accounted for).`);
}

// ─── --status: read local v2 files, write a human-readable maintenance report ─
async function runStatus() {
    const catalog = _readV2(CATALOG_V2);
    const unsupported = _readV2(UNSUPPORTED_V2);
    const allEntries = [
        ...catalog.entries.map(e => ({ ...e, _kind: 'catalog' })),
        ...unsupported.entries.map(e => ({ ...e, _kind: 'unsupported' })),
    ];
    // R1 #5 — filter out null timestamps from fresh/stale (_ageDays(null) returns
    // Infinity, which would silently land every never-captured entry into "stale"
    // and miscategorize the "fresh" bucket entirely).
    const withCapture = allEntries.filter(e => !!e.verification.last_captured_at);
    const fresh = withCapture.filter(e => _ageDays(e.verification.last_captured_at) <= FRESHNESS_DAYS);
    const stale = withCapture.filter(e => _ageDays(e.verification.last_captured_at) > FRESHNESS_DAYS);
    const noCapture = allEntries.filter(e => !e.verification.last_captured_at);
    const auditPending = unsupported.entries.filter(e => Array.isArray(e.audit_pending) && e.audit_pending.length > 0);
    const totalAuditPending = auditPending.reduce((sum, e) => sum + e.audit_pending.length, 0);

    const lines = [];
    lines.push(`# paysh-catalog maintenance status`);
    lines.push('');
    lines.push(`Generated: ${new Date().toISOString()}`);
    lines.push(`Catalog generated_at: ${catalog.generated_at}`);
    lines.push(`Manifest last checked: ${catalog.manifest_checked_at} (run \`node tests/paysh/probe-catalog.js --drift --write-checked-at\` to refresh — bare \`--drift\` is a pure check and won't update this timestamp)`);
    lines.push(`Freshness window: ${FRESHNESS_DAYS} days`);
    lines.push('');
    lines.push('## Summary');
    lines.push('');
    lines.push(`| Bucket | Count |`);
    lines.push(`|--------|-------|`);
    lines.push(`| Catalog entries | ${catalog.entries.length} |`);
    lines.push(`| Unsupported entries | ${unsupported.entries.length} |`);
    lines.push(`| Fresh (capture ≤ ${FRESHNESS_DAYS}d) | ${fresh.length} |`);
    lines.push(`| Stale (capture > ${FRESHNESS_DAYS}d) | ${stale.length} |`);
    lines.push(`| No capture (probe never reached 402) | ${noCapture.length} |`);
    lines.push(`| Entries with audit_pending siblings | ${auditPending.length} |`);
    lines.push(`| Total audit_pending sibling endpoints | ${totalAuditPending} |`);
    lines.push('');
    if (stale.length) {
        lines.push(`## Stale captures (> ${FRESHNESS_DAYS}d) — consider \`--refresh <id>\``);
        lines.push('');
        lines.push(`| id | kind | age (days) | last_captured_at |`);
        lines.push(`|---|---|---|---|`);
        for (const e of stale.sort((a, b) => _ageDays(b.verification.last_captured_at) - _ageDays(a.verification.last_captured_at))) {
            lines.push(`| \`${e.id}\` | ${e._kind} | ${Math.floor(_ageDays(e.verification.last_captured_at))} | ${e.verification.last_captured_at} |`);
        }
        lines.push('');
    }
    if (auditPending.length) {
        lines.push('## Audit-pending siblings (queued for catalog promotion)');
        lines.push('');
        lines.push(`| service_id | pending count | deferred_to |`);
        lines.push(`|---|---|---|`);
        for (const e of auditPending.sort((a, b) => b.audit_pending.length - a.audit_pending.length)) {
            const deferred = [...new Set(e.audit_pending.map(p => p.deferred_to).filter(Boolean))].join(', ') || '(unscheduled)';
            lines.push(`| \`${e.service_id}\` | ${e.audit_pending.length} | ${deferred} |`);
        }
        lines.push('');
    }
    fs.writeFileSync(STATUS_FILE, lines.join('\n') + '\n', 'utf8');
    console.log(`Status written to ${path.relative(process.cwd(), STATUS_FILE)}`);
    console.log(`  catalog: ${catalog.entries.length}, unsupported: ${unsupported.entries.length}, stale: ${stale.length}, audit_pending: ${totalAuditPending}`);
}

// ─── --refresh <id>: re-probe one entry, update verification metadata ───────
async function runRefresh(id) {
    const catalog = _readV2(CATALOG_V2);
    const unsupported = _readV2(UNSUPPORTED_V2);
    let entry = catalog.entries.find(e => e.id === id);
    let containingFile = CATALOG_V2;
    let containingObj = catalog;
    let kind = 'catalog';
    if (!entry) {
        entry = unsupported.entries.find(e => e.id === id);
        containingFile = UNSUPPORTED_V2;
        containingObj = unsupported;
        kind = 'unsupported';
    }
    if (!entry) {
        console.error(`No entry found with id "${id}" in catalog.json or unsupported.json`);
        process.exit(2);
    }
    console.log(`Refreshing ${kind}/${id}`);
    console.log(`  upstream_ref: ${entry.upstream_ref.pay_md_path}`);

    // Re-discover via existing discoverOne (also fetches PAY.md frontmatter + openapi).
    // R1 #3 — use discoverOne's freshly-read service_url, NOT entry.upstream_ref.service_url
    // (which may be null for unsupported entries that never had a capture). discoverOne
    // returns disc.serviceUrl from PAY.md frontmatter; combine with our entry's endpoint.path.
    const disc = await discoverOne(entry.upstream_ref.pay_md_path);
    if (!disc.ok) {
        console.error(`discoverOne failed: ${disc.error}`);
        // R7-1: parallel to R4-1 — catalog entries MUST stay parsed_ok per
        // v2 schema. If discoverOne fails (PAY.md unreachable, openapi gone,
        // etc.), refuse to mutate catalog.json with probe_status: fetch_failed
        // — that would silently degrade the catalog. Operator must investigate
        // + manually demote to unsupported.json. For unsupported entries,
        // recording fetch_failed is fine (they're already not in catalog).
        if (kind === 'catalog') {
            console.error(`REFUSING to write: catalog entry "${id}" failed discovery (would degrade catalog).`);
            console.error('catalog.json was NOT modified. Investigate the failure and manually move the entry to unsupported.json if confirmed broken.');
            process.exit(3);
        }
        const failNow = new Date().toISOString();
        entry.verification.last_probed_at = failNow;
        entry.verification.probe_status = 'fetch_failed';
        containingObj.generated_at = failNow;
        _writeV2(containingFile, containingObj);
        process.exit(2);
    }
    const baseUrl = disc.serviceUrl || entry.upstream_ref.service_url;
    if (!baseUrl) {
        console.error(`No service_url available (disc.serviceUrl and entry.upstream_ref.service_url both empty)`);
        process.exit(2);
    }
    // R3-3: persist disc.serviceUrl back into entry.upstream_ref.service_url so
    // future --refresh calls (and other tooling) don't need to re-discover. This
    // is especially useful for unsupported entries that started with null service_url.
    if (disc.serviceUrl && entry.upstream_ref.service_url !== disc.serviceUrl) {
        if (!entry.upstream_ref.service_url) {
            console.log(`  service_url backfilled from PAY.md: ${disc.serviceUrl}`);
        } else {
            console.log(`  service_url updated: ${entry.upstream_ref.service_url} → ${disc.serviceUrl}`);
        }
        entry.upstream_ref.service_url = disc.serviceUrl;
    }
    disc.probeUrl = baseUrl.replace(/\/$/, '') + entry.endpoint.path;
    disc.probeMethod = entry.endpoint.method;
    console.log(`  endpoint:     ${disc.probeMethod} ${disc.probeUrl}`);

    // R1 #4 — use a real X402Protocol instance, not the payment-registry module
    // (which exports { register, detectProtocol, ... } — no .detect()/.build()).
    // Pre-fix probeAndParse would crash on the first proto.detect() call.
    const proto = new X402Protocol();
    const probed = await probeAndParse(disc, proto);
    const status = probed.row.result;
    console.log(`  probe_status: ${status}`);

    // R4-1: catalog entries MUST have probe_status === 'parsed_ok' per SCHEMA.md.
    // If a refresh degrades a catalog entry (service broke upstream, parser now
    // rejects, etc.), refuse to write — otherwise we'd ship a "supported" entry
    // that doesn't probe. Surface the problem and exit non-zero so CI/operator
    // notices; demoting catalog → unsupported is intentionally OUT OF SCOPE here
    // (needs human review of which `reason` bucket applies, what to put in note,
    // whether other catalog endpoints from the same service still work, etc.).
    if (kind === 'catalog' && status !== 'parsed_ok') {
        console.error(`\nREFUSING to write: catalog entry "${id}" refreshed with probe_status="${status}" but catalog requires parsed_ok.`);
        console.error('The service may have degraded upstream. Human review needed:');
        console.error('  1. Investigate the probe failure (rerun in standard mode or check the service directly).');
        console.error(`  2. If genuinely broken, manually move "${id}" from catalog.json to unsupported.json with an appropriate reason bucket.`);
        console.error('  3. catalog.json and unsupported.json were NOT modified by this refresh.');
        process.exit(3);
    }

    const now = new Date().toISOString();
    entry.verification.last_probed_at = now;
    entry.verification.probe_status = status;

    if (status === 'parsed_ok' && probed.captured) {
        // R1 #4 — sanitize before committing. Pre-fix wrote raw headers/body
        // to the repo fixture, which could leak secret-shaped tokens (api keys,
        // session cookies, internal IDs). sanitize() is the same helper used by
        // --commit-captures and the live probe path.
        // R2-6: when no existing capture path, include entry.id in the default
        // filename. Pre-fix the default was operator+slug only — once we have
        // multiple v2 entries per service (e.g. stablecrypto-price + stablecrypto-charts),
        // they'd collide on the same capture file and overwrite each other.
        const captureName = entry.verification.last_capture_path
            ? path.basename(entry.verification.last_capture_path)
            : `${entry.upstream_ref.operator}-${entry.upstream_ref.slug.replace(/\//g, '_')}__${entry.id}.json`;
        const captureFullPath = path.join(__dirname, 'captures', 'catalog', captureName);
        // R3-2: capture path stored in v2 JSON must be relative to repo root
        // (e.g. `tests/paysh/captures/catalog/foo.json`), not relative to tests/
        // (`paysh/captures/catalog/foo.json`). __dirname is `tests/paysh`, so go
        // up TWO levels to reach repo root.
        const repoRoot = path.join(__dirname, '..', '..');
        const captureRel = path.relative(repoRoot, captureFullPath).split(path.sep).join('/');
        const captureContent = sanitize({
            _meta: {
                label: `${entry.upstream_ref.operator}-${entry.upstream_ref.slug.replace(/\//g, '_')}-402`,
                capturedAt: now,
                source: 'probe-catalog --refresh',
                payMdPath: entry.upstream_ref.pay_md_path,
                note: `Refreshed via probe-catalog.js --refresh ${id} (BAT-761).`,
            },
            url: disc.probeUrl,
            method: disc.probeMethod,
            status: probed.captured.status,
            headers: probed.captured.headers,
            body: probed.captured.body,
        });
        fs.mkdirSync(path.dirname(captureFullPath), { recursive: true });
        fs.writeFileSync(captureFullPath, JSON.stringify(captureContent, null, 2) + '\n', 'utf8');
        entry.verification.last_capture_path = captureRel;
        entry.verification.last_captured_at = now;
        console.log(`  capture written: ${captureRel}`);
    }

    containingObj.generated_at = now;
    _writeV2(containingFile, containingObj);
    console.log(`  ${path.relative(process.cwd(), containingFile)} updated`);
}

async function main() {
    const args = parseArgs(process.argv);

    // BAT-761 maintenance modes — dispatch before standard/audit flow.
    if (args.drift) return runDrift(args);
    if (args.status) return runStatus();
    if (args.refreshId) return runRefresh(args.refreshId);

    let workItems = PAY_MD_PATHS;
    if (args.filter) workItems = workItems.filter(p => p.toLowerCase().includes(args.filter.toLowerCase()));
    if (args.limit > 0) workItems = workItems.slice(0, args.limit);

    // R4 #2: status banner now reflects the actual scope. Default
    // audit probes GET endpoints only; non-GET are listed-but-not-probed.
    // Surface the side-effect flag state so operators don't assume a
    // default `--audit` run exercised every endpoint.
    let mode;
    if (args.audit) {
        mode = args.auditSideEffects
            ? 'AUDIT (probe every endpoint per service incl POST/PUT/PATCH/DELETE — side-effects opt-in)'
            : 'AUDIT (probe every GET endpoint per service; non-GET listed-but-skipped — pass --audit-side-effects to probe them)';
    } else {
        mode = 'STANDARD (probe one endpoint per service)';
    }
    console.log(`═══ pay.sh catalog probe — mode: ${mode} — ${workItems.length} services, concurrency=${args.concurrency} ═══\n`);
    console.log('Phase 1: discovering service URLs and probe endpoints from pay-skills repo…\n');

    const proto = new X402Protocol();
    const t0 = Date.now();

    const discoveries = await runWithConcurrency(workItems, args.concurrency, discoverOne);

    if (args.audit) {
        // BAT-706: audit mode. Probe every endpoint per service and
        // write the full breakdown to catalog-audit.md. Does NOT
        // touch catalog-summary.md (use STANDARD mode for that).
        // R6: clarify scope when --audit-side-effects is OFF (default).
        const phase2Msg = args.auditSideEffects
            ? 'Phase 2 (audit): probing EVERY endpoint per service (no payment, --audit-side-effects ON)…\n'
            : 'Phase 2 (audit): probing every GET endpoint per service; non-GET will be LISTED-BUT-SKIPPED (pass --audit-side-effects to probe them too)…\n';
        console.log(phase2Msg);
        const auditResults = [];
        let svcDone = 0;
        await runWithConcurrency(discoveries, args.concurrency, async (disc) => {
            const r = await auditService(disc, proto, { auditSideEffects: args.auditSideEffects });
            auditResults.push(r);
            svcDone++;
            const epCount = r.endpoints ? r.endpoints.length : 0;
            const ok = r.endpoints ? r.endpoints.filter(e => e.row.result === 'parsed_ok').length : 0;
            process.stdout.write(`\r  audited ${svcDone}/${discoveries.length} — last: ${disc.payMdPath ? disc.payMdPath.split('/').slice(1, -1).join('/') : '?'} (${ok}/${epCount} parsed_ok)            `);
        });
        process.stdout.write('\n\n');
        // Re-order by input order
        auditResults.sort((a, b) => discoveries.indexOf(a.disc) - discoveries.indexOf(b.disc));
        writeAuditReport(auditResults, Date.now() - t0, {
            filter: args.filter,
            auditSideEffects: args.auditSideEffects,
            limit: args.limit,
            concurrency: args.concurrency,
        });
        return;
    }

    console.log('Phase 2: probing each service (no payment)…\n');

    if (args.commitCaptures && !fs.existsSync(CAPTURES_DIR)) {
        fs.mkdirSync(CAPTURES_DIR, { recursive: true });
    }

    const rows = [];
    let probed = 0;
    await runWithConcurrency(discoveries, args.concurrency, async (disc) => {
        if (!disc.ok) {
            rows.push({ disc, row: { result: `discovery_failed:${disc.error}` } });
            return;
        }
        const out = await probeAndParse(disc, proto);
        rows.push(out);

        // Optional per-service capture
        if (args.commitCaptures && out.captured && out.captured.status === 402) {
            const safeName = `${disc.operator}-${disc.name.replace(/\//g, '_')}`;
            const sanitized = sanitize({
                _meta: {
                    label: `${safeName}-402`,
                    capturedAt: new Date().toISOString(),
                    source: 'probe-catalog',
                    payMdPath: disc.payMdPath,
                    note: 'Sanitized per BAT-582 v1.6 contract amendment 6.',
                },
                url: out.captured.url,
                method: out.captured.method,
                status: out.captured.status,
                headers: out.captured.headers,
                body: out.captured.body,
            });
            fs.writeFileSync(path.join(CAPTURES_DIR, `${safeName}.json`), JSON.stringify(sanitized, null, 2) + '\n', 'utf8');
        }
        probed++;
        process.stdout.write(`\r  probed ${probed}/${workItems.length}…  `);
    });
    process.stdout.write('\n\n');

    // Re-order rows by original input order (concurrency may shuffle)
    rows.sort((a, b) => {
        const ia = discoveries.indexOf(a.disc);
        const ib = discoveries.indexOf(b.disc);
        return ia - ib;
    });

    // ── Console summary ───────────────────────────────────────────────────
    const totalMs = Date.now() - t0;
    let counts = {
        total: rows.length,
        parsedOk: 0,
        reject: 0,
        notV402: 0,
        fetchFailed: 0,
        discoveryFailed: 0,
        solanaSupport: 0,
        v2: 0,
        v1: 0,
        bodyDelivery: 0,
        headerDelivery: 0,
    };
    const rejectsByReason = {};
    for (const r of rows) {
        if (r.row.result === 'parsed_ok') counts.parsedOk++;
        else if (r.row.result?.startsWith('reject:')) {
            counts.reject++;
            const reason = r.row.result.slice('reject:'.length);
            rejectsByReason[reason] = (rejectsByReason[reason] || 0) + 1;
        }
        else if (r.row.result?.startsWith('http_')) counts.notV402++;
        else if (r.row.result === 'fetch_failed') counts.fetchFailed++;
        else if (r.row.result?.startsWith('discovery_failed:')) counts.discoveryFailed++;
        if (r.row.networks && r.row.networks.some(n => /^solana/.test(n))) counts.solanaSupport++;
        if (r.row.x402Version === 2) counts.v2++;
        if (r.row.x402Version === 1) counts.v1++;
        if (r.row.delivery === 'body') counts.bodyDelivery++;
        if (r.row.delivery === 'header') counts.headerDelivery++;
    }

    console.log('═══ Per-service results ═══');
    console.log('');
    const header = `  ${'operator/name'.padEnd(38)} ${'http'.padEnd(5)} ${'v'.padEnd(2)} ${'chains'.padEnd(10)} ${'asset'.padEnd(5)} ${'amt'.padEnd(10)} result`;
    console.log(header);
    console.log('  ' + '─'.repeat(header.length - 2));
    for (const r of rows) {
        const label = r.disc.ok ? `${r.disc.operator}/${r.disc.name}` : r.disc.payMdPath;
        const httpStr = String(r.row.httpStatus ?? '—');
        const vStr = r.row.x402Version != null ? `v${r.row.x402Version}` : '—';
        const chains = fmtNetworks(r.row.networks || []);
        const asset = fmtAssetKind((r.row.assets || [])[0]);
        const amt = fmtAmount(r.row.amounts);
        const mark = r.row.result === 'parsed_ok' ? '✓' : (r.row.result?.startsWith('reject:') ? '✗' : '·');
        console.log(`  ${mark} ${label.padEnd(36)} ${httpStr.padEnd(5)} ${vStr.padEnd(2)} ${chains.padEnd(10)} ${asset.padEnd(5)} ${amt.padEnd(10)} ${r.row.result}`);
    }

    console.log('');
    console.log('═══ Aggregate ═══');
    console.log(`  total:                ${counts.total}`);
    console.log(`  parser OK (built):    ${counts.parsedOk}`);
    console.log(`  parser rejected:      ${counts.reject}`);
    console.log(`  non-402 response:     ${counts.notV402}`);
    console.log(`  fetch failed:         ${counts.fetchFailed}`);
    console.log(`  discovery failed:     ${counts.discoveryFailed}`);
    console.log(`  Solana offered:       ${counts.solanaSupport}`);
    console.log(`  x402Version v2 / v1:  ${counts.v2} / ${counts.v1}`);
    console.log(`  delivery body/header: ${counts.bodyDelivery} / ${counts.headerDelivery}`);
    if (Object.keys(rejectsByReason).length > 0) {
        console.log(`  rejects by reason:`);
        for (const [reason, n] of Object.entries(rejectsByReason).sort((a, b) => b[1] - a[1])) {
            console.log(`    ${String(n).padStart(3)}× ${reason}`);
        }
    }
    console.log(`  elapsed:              ${(totalMs / 1000).toFixed(1)}s`);

    // ── Markdown summary file ─────────────────────────────────────────────
    const lines = [];
    lines.push('# pay.sh catalog probe — summary');
    lines.push('');
    lines.push(`Generated: ${new Date().toISOString()}`);
    lines.push(`Source catalog: solana-foundation/pay-skills (${PAY_MD_PATHS.length} services)`);
    lines.push(`Probed: ${workItems.length} (concurrency ${args.concurrency})`);
    lines.push('');
    lines.push('## Aggregate');
    lines.push('');
    lines.push('| Metric | Count |');
    lines.push('|--------|-------|');
    lines.push(`| Total probed | ${counts.total} |`);
    lines.push(`| **Parser OK** (built x402 tx) | ${counts.parsedOk} |`);
    lines.push(`| Parser rejected (returned 402 we can't pay) | ${counts.reject} |`);
    lines.push(`| Non-402 HTTP response | ${counts.notV402} |`);
    lines.push(`| Fetch failed (DNS / TLS / timeout) | ${counts.fetchFailed} |`);
    lines.push(`| Discovery failed (no service_url) | ${counts.discoveryFailed} |`);
    lines.push(`| Solana offered | ${counts.solanaSupport} |`);
    lines.push(`| x402 v2 | ${counts.v2} |`);
    lines.push(`| x402 v1 | ${counts.v1} |`);
    lines.push(`| Requirements via body | ${counts.bodyDelivery} |`);
    lines.push(`| Requirements via \`payment-required\` header | ${counts.headerDelivery} |`);
    lines.push('');
    if (Object.keys(rejectsByReason).length > 0) {
        lines.push('### Rejects by reason');
        lines.push('');
        lines.push('| Reason | Count |');
        lines.push('|--------|-------|');
        for (const [reason, n] of Object.entries(rejectsByReason).sort((a, b) => b[1] - a[1])) {
            lines.push(`| \`${reason}\` | ${n} |`);
        }
        lines.push('');
    }
    lines.push('## Per-service');
    lines.push('');
    lines.push('| Service | HTTP | x402 | Chains | Asset | Amount | Result |');
    lines.push('|---------|------|------|--------|-------|--------|--------|');
    for (const r of rows) {
        const label = r.disc.ok ? `${r.disc.operator}/${r.disc.name}` : r.disc.payMdPath;
        const httpStr = String(r.row.httpStatus ?? '—');
        const vStr = r.row.x402Version != null ? `v${r.row.x402Version}` : '—';
        const chains = fmtNetworks(r.row.networks || []);
        const asset = fmtAssetKind((r.row.assets || [])[0]);
        const amt = fmtAmount(r.row.amounts);
        lines.push(`| ${label} | ${httpStr} | ${vStr} | ${chains} | ${asset} | ${amt} | \`${r.row.result}\` |`);
    }
    lines.push('');
    lines.push('## What "parser OK" means');
    lines.push('');
    lines.push('The service returned a 402 with x402 payment requirements that our `X402Protocol.detect() + build()` accepted: Solana mainnet offer, scheme=exact, USDC asset, valid payTo, amount within max. The script does NOT sign or settle — `parsed_ok` proves only that we *could* construct a payment, not that the upstream facilitator would accept it.');
    lines.push('');
    lines.push('## What rejections mean');
    lines.push('');
    lines.push('| Reject code | Meaning |');
    lines.push('|-------------|---------|');
    lines.push('| `no_solana_offer` | Service offers only EVM chains (Base) — our wallet is Solana-only |');
    lines.push('| `non_usdc_asset` | Service asks for an asset that isn\'t the canonical USDC mint |');
    lines.push('| `unsupported_version` | x402Version is 3+ (forward-compat block) |');
    lines.push('| `invalid_demand` | amount = 0 (pay.sh sometimes uses 402 + amount=0 to advertise free) |');
    lines.push('| `demand_exceeds_max_usdc` | amount > our 100 USDC probe ceiling |');
    lines.push('| `invalid_402_body` | 402 body shape we don\'t recognize (likely new pay.sh dialect) |');
    lines.push('| `mpp_protocol` | non-x402 paywall (Alibaba/Google `gateway-402.com` services use MPP) |');
    lines.push('| `siwx_auth_required` | requires Sign-In-With-X auth flow first (merit-systems stable* services) |');
    lines.push('| `no_payment_requirements` | 402 with no `accepts` / no `paymentRequirements` and no recognised alt-protocol |');
    lines.push('');
    lines.push('## Refreshing the catalog inventory');
    lines.push('');
    lines.push('The list of PAY.md paths is snapshotted in `PAY_MD_PATHS` inside `probe-catalog.js`. To refresh:');
    lines.push('');
    lines.push('```');
    lines.push('curl -s "https://api.github.com/repos/solana-foundation/pay-skills/git/trees/main?recursive=1" | jq -r \'.tree[].path | select(endswith("PAY.md"))\'');
    lines.push('```');
    lines.push('');
    lines.push('Paste the result over `PAY_MD_PATHS` and re-run.');
    lines.push('');
    fs.writeFileSync(SUMMARY_FILE, lines.join('\n'), 'utf8');
    console.log(`\nSummary written to ${path.relative(process.cwd(), SUMMARY_FILE)}`);
    console.log('');
    console.log('Notes:');
    console.log('  • Pure read survey ($0 spent). Re-run any time to detect catalog drift.');
    console.log('  • Pass --commit-captures to also write captures/catalog/<svc>.json files (heavier, opt-in).');
    if (counts.parsedOk === 0) process.exit(2);  // no services parsed cleanly → red flag
}

main().catch(e => { console.error('FATAL:', e); process.exit(2); });
