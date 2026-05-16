#!/usr/bin/env node
/**
 * tests/paysh/migrate-v1-to-v2.js
 *
 * BAT-761 — one-shot migration from paysh-catalog v1 → v2 schema.
 *
 * Reads:
 *   - app/src/main/assets/default-skills/paysh-catalog/catalog.json (v1)
 *   - app/src/main/assets/default-skills/paysh-catalog/unsupported.json (v1)
 *   - tests/paysh/captures/catalog/*.json (per-service 402 captures)
 *   - tests/paysh/captures/textbelt-text-v2-success.json (textbelt live-pay capture)
 *   - tests/paysh/catalog-audit.md (BAT-706 full-audit parsed_ok table for audit_pending)
 *
 * Writes (after validation per paysh-catalog/SCHEMA.md):
 *   - app/src/main/assets/default-skills/paysh-catalog/catalog.json (v2)
 *   - app/src/main/assets/default-skills/paysh-catalog/unsupported.json (v2)
 *
 * Idempotent: re-running on an already-v2 file is a no-op (deterministic output).
 *
 * Usage: node tests/paysh/migrate-v1-to-v2.js [--dry-run]
 */

const fs = require('fs');
const path = require('path');

const REPO_ROOT = path.resolve(__dirname, '..', '..');
const SKILL_DIR = path.join(REPO_ROOT, 'app/src/main/assets/default-skills/paysh-catalog');
const CAPTURE_DIR = path.join(REPO_ROOT, 'tests/paysh/captures/catalog');
const TEXTBELT_CAPTURE = path.join(REPO_ROOT, 'tests/paysh/captures/textbelt-text-v2-success.json');
const AUDIT_REPORT = path.join(REPO_ROOT, 'tests/paysh/catalog-audit.md');

const CATALOG_PATH = path.join(SKILL_DIR, 'catalog.json');
const UNSUPPORTED_PATH = path.join(SKILL_DIR, 'unsupported.json');
const SERVICES_DIR = path.join(SKILL_DIR, 'services');

const DRY_RUN = process.argv.includes('--dry-run');

// ── v1 catalog id → capture file basename mapping ────────────────────────────
// Hardcoded for the 10 v1 entries. Single source of truth — keeps the migrate
// deterministic and obvious; not worth heuristic resolution for 10 known entries.
const CATALOG_CAPTURE_MAP = {
    'wolfram-alpha': 'paysponge-wolframalpha.json',
    'tripadvisor': 'paysponge-tripadvisor.json',
    '2captcha': 'paysponge-2captcha.json',
    'reducto': 'paysponge-reducto.json',
    'rentcast': 'paysponge-rentcast.json',
    'crushrewards': 'crushrewards-pricing.json',
    'stablecrypto-market-data': 'merit-systems-stablecrypto_market-data.json',
    'stableenrich': 'merit-systems-stableenrich_enrichment.json',
    'purch': 'purch-marketplace.json',
    // textbelt-sms uses the live-pay capture (probe-catalog only hit free GET /status)
    'textbelt-sms': '__TEXTBELT__',
};

// ── v1 catalog id → service_id (for grouping; flatten nested slugs) ─────────
const CATALOG_SERVICE_ID = {
    'wolfram-alpha': 'wolframalpha',
    'tripadvisor': 'tripadvisor',
    '2captcha': '2captcha',
    'reducto': 'reducto',
    'rentcast': 'rentcast',
    'crushrewards': 'crushrewards-pricing',
    'stablecrypto-market-data': 'stablecrypto-market-data',
    'stableenrich': 'stableenrich-enrichment',
    'purch': 'purch-marketplace',
    'textbelt-sms': 'textbelt',
};

// ── v1 catalog id → doc_file (services/<name>.md) ──────────────────────────
const CATALOG_DOC_FILE = {
    'wolfram-alpha': 'services/wolfram-alpha.md',
    'tripadvisor': 'services/tripadvisor.md',
    '2captcha': 'services/2captcha.md',
    'reducto': 'services/reducto.md',
    'rentcast': 'services/rentcast.md',
    'crushrewards': 'services/crushrewards.md',
    'stablecrypto-market-data': 'services/stablecrypto-market-data.md',
    'stableenrich': 'services/stableenrich.md',
    'purch': 'services/purch.md',
    'textbelt-sms': 'services/textbelt-sms.md',
};

// ── audit_pending deferred_to BAT mapping ─────────────────────────────────────
// Maps a service (operator/slug) → BAT ticket where the audit-discovered
// sibling endpoints will be promoted to catalog.json.
const DEFER_BAT = {
    'paysponge/perplexity': 'BAT-769',           // Tier 1c — perplexity (new service)
    'paysponge/fal': 'BAT-764',                  // Binary handler unblocks
    'paysponge/screenshotone': 'BAT-764',        // Binary handler; openapi says JSON, needs paid-response capture
    'paysponge/nyne': 'BAT-772',                 // Tier 2c — PII safety scoping
    'paysponge/rentcast': 'BAT-766',             // Tier 1a — same-provider extras
    'paysponge/tripadvisor': 'BAT-766',          // Tier 1a
    'paysponge/wolframalpha': 'BAT-766',         // Tier 1a
    'paysponge/reducto': 'BAT-766',              // Tier 1a
    'crushrewards/pricing': 'BAT-766',           // Tier 1a (already in catalog, extras)
    'paysponge/2captcha': 'BAT-766',             // Tier 1a (already in catalog, no extras)
    'merit-systems/stablecrypto/market-data': 'BAT-768',  // Tier 1b
    'merit-systems/stableemail/email': 'BAT-770',         // Tier 2a
    'merit-systems/stablephone/calls': 'BAT-771',         // Tier 2b
    'merit-systems/stableenrich/enrichment': 'BAT-772',   // Tier 2c
    // No ticket yet — leave deferred_to omitted (script writes null):
    // merit-systems/stablesocial/social-data
    // agentmail/email
    // quicknode/rpc
    // purch/marketplace (extras)
    // paysponge/textbelt (audit only saw 1 endpoint, already in catalog)
};

// ── Helpers ──────────────────────────────────────────────────────────────────

function readJson(p) {
    return JSON.parse(fs.readFileSync(p, 'utf8'));
}

function writeJson(p, obj) {
    const json = JSON.stringify(obj, null, 2) + '\n';
    if (DRY_RUN) {
        console.log(`[dry-run] would write ${p} (${json.length} bytes)`);
        return;
    }
    fs.writeFileSync(p, json, 'utf8');
    console.log(`wrote ${path.relative(REPO_ROOT, p)} (${json.length} bytes)`);
}

/** Parse payMdPath "providers/<operator>/<slug>/PAY.md" → {operator, slug} */
function parsePayMdPath(payMdPath) {
    const m = /^providers\/([^/]+)\/(.+)\/PAY\.md$/.exec(payMdPath);
    if (!m) throw new Error(`Bad payMdPath: ${payMdPath}`);
    return { operator: m[1], slug: m[2] };
}

/** From capture URL, extract serviceUrl (origin) + endpoint path */
function splitUrl(url) {
    const u = new URL(url);
    return { serviceUrl: u.origin, path: u.pathname + (u.search || '') };
}

/** Get relative capture path under tests/paysh/ */
function captureRelPath(captureName) {
    if (captureName === '__TEXTBELT__') return 'tests/paysh/captures/textbelt-text-v2-success.json';
    return `tests/paysh/captures/catalog/${captureName}`;
}

/** Try to find capture file for an unsupported entry by name (e.g. "paysponge/screenshotone"). */
function findUnsupportedCapture(name) {
    const parts = name.split('/');
    const candidates = [
        // a/b/c → a-b-c.json (all slashes → dashes)
        `${name.replace(/\//g, '-')}.json`,
        // a/b/c → a_b_c.json (all slashes → underscores)
        `${name.replace(/\//g, '_')}.json`,
        // a/b/c → a-b_c.json (probe-catalog hybrid: first → dash, rest → underscore)
        parts.length >= 2 ? `${parts[0]}-${parts.slice(1).join('_')}.json` : null,
        // a/b/c → a/b-c flatten then underscore-join
        parts.length >= 2 ? `${parts.slice(0, 2).join('-')}_${parts.slice(2).join('_')}.json` : null,
    ].filter(Boolean);
    for (const c of candidates) {
        const p = path.join(CAPTURE_DIR, c);
        if (fs.existsSync(p)) return c;
    }
    return null;
}

// ── Parse catalog-audit.md for parsed_ok endpoints per service ───────────────

function parseAuditReport() {
    if (!fs.existsSync(AUDIT_REPORT)) {
        console.warn(`No catalog-audit.md at ${AUDIT_REPORT} — audit_pending will be empty`);
        return new Map();
    }
    const lines = fs.readFileSync(AUDIT_REPORT, 'utf8').split(/\r?\n/);
    const serviceMap = new Map(); // "operator/slug" → [{method, path, cost_usdc}]
    let inAllOk = false;
    for (const line of lines) {
        if (line.startsWith('## All parsed_ok endpoints')) { inAllOk = true; continue; }
        if (inAllOk && line.startsWith('## ')) break;
        if (!inAllOk) continue;
        if (!line.startsWith('| ') || line.startsWith('| Service') || line.startsWith('|---')) continue;
        const cols = line.split('|').map(s => s.trim()).filter(Boolean);
        if (cols.length < 7) continue;
        const [svc, method, pathRaw, , , amount, result] = cols;
        if (result !== '`parsed_ok`') continue;
        const cleanPath = pathRaw.replace(/^`|`$/g, '');
        const cleanAmount = amount.replace(/^\$/, '').trim();
        const cost = parseFloat(cleanAmount);
        if (!serviceMap.has(svc)) serviceMap.set(svc, []);
        serviceMap.get(svc).push({
            method,
            path: cleanPath,
            cost_usdc: isNaN(cost) ? null : cost,
        });
    }
    return serviceMap;
}

// ── Build v2 catalog entry from v1 entry + capture ───────────────────────────

function buildCatalogEntry(v1Entry) {
    const captureName = CATALOG_CAPTURE_MAP[v1Entry.id];
    if (!captureName) throw new Error(`No capture mapping for v1 catalog id "${v1Entry.id}"`);
    const capturePath = captureName === '__TEXTBELT__'
        ? TEXTBELT_CAPTURE
        : path.join(CAPTURE_DIR, captureName);
    if (!fs.existsSync(capturePath)) {
        throw new Error(`Capture file missing: ${capturePath} (for v1 catalog id ${v1Entry.id})`);
    }
    const capture = readJson(capturePath);

    let operator, slug, pay_md_path, service_url, endpointPath, endpointMethod;
    if (captureName === '__TEXTBELT__') {
        // textbelt live-pay capture has a different shape — derive metadata
        // from the BAT-705 textbelt-sms.md doc rather than the capture.
        operator = 'paysponge';
        slug = 'textbelt';
        pay_md_path = 'providers/paysponge/textbelt/PAY.md';
        const u = new URL('https://api.paysponge.com/x402/purchase/svc_d6kszbre4qwg5n4n4/text');
        service_url = u.origin;
        endpointPath = u.pathname;
        endpointMethod = v1Entry.method;
    } else {
        const parsed = parsePayMdPath(capture._meta.payMdPath);
        operator = parsed.operator;
        slug = parsed.slug;
        pay_md_path = capture._meta.payMdPath;
        const split = splitUrl(capture.url);
        service_url = split.serviceUrl;
        endpointPath = split.path;
        // R1 #1 — v1Entry.method is the curated source of truth (matches the service doc).
        // capture.method reflects whatever probe-catalog picked (often /openapi defaults to GET);
        // for services like stableenrich the doc says POST while the probe-time capture is GET.
        // If they disagree, warn but trust v1Entry.method to keep catalog ↔ doc consistent.
        endpointMethod = v1Entry.method;
        if (capture.method && capture.method !== v1Entry.method) {
            console.warn(`  [warn] ${v1Entry.id}: v1 method=${v1Entry.method} but capture method=${capture.method} — keeping v1 (run probe-catalog --refresh after migration to verify the curated method actually returns 402)`);
        }
    }

    const capturedAt = capture._meta?.capturedAt
        || capture.capturedAt
        || capture._meta?.timestamp
        || new Date().toISOString();

    return {
        id: v1Entry.id,
        service_id: CATALOG_SERVICE_ID[v1Entry.id] || v1Entry.id,
        name: v1Entry.name,
        upstream_ref: { operator, slug, pay_md_path, service_url },
        endpoint: { method: endpointMethod, path: endpointPath, cost_usdc: v1Entry.cost_usdc },
        intents: v1Entry.intents,
        summary: v1Entry.summary,
        doc_file: CATALOG_DOC_FILE[v1Entry.id] || v1Entry.file,
        verification: {
            last_probed_at: capturedAt,
            last_capture_path: captureRelPath(captureName),
            last_captured_at: capturedAt,
            probe_status: 'parsed_ok',
        },
    };
}

// ── Build v2 unsupported entry from v1 entry ─────────────────────────────────

function buildUnsupportedEntry(v1Entry, auditMap) {
    const v1Name = v1Entry.name;
    // v1 name like "paysponge/screenshotone" or "merit-systems/stableenrich/enrichment"
    const parts = v1Name.split('/');
    const operator = parts[0];
    const slug = parts.slice(1).join('/');
    const pay_md_path = `providers/${operator}/${slug}/PAY.md`;
    const idFlat = v1Name.replace(/\//g, '-');
    const service_id = slug.replace(/\//g, '-');

    // Try to find a capture (some unsupported entries have one, most don't)
    const captureName = findUnsupportedCapture(v1Name);
    let verification = {
        last_probed_at: null,
        last_capture_path: null,
        last_captured_at: null,
        probe_status: deriveProbeStatusFromV1(v1Entry),
    };
    let service_url = null;
    let endpointMethod = 'GET'; // default for probe; we don't always know
    let endpointPath = '/';
    let cost_usdc = null;

    if (captureName) {
        try {
            const capture = readJson(path.join(CAPTURE_DIR, captureName));
            const split = splitUrl(capture.url);
            service_url = split.serviceUrl;
            endpointPath = split.path;
            endpointMethod = capture.method || endpointMethod;
            const capturedAt = capture._meta?.capturedAt || null;
            verification = {
                last_probed_at: capturedAt,
                last_capture_path: capturedAt ? captureRelPath(captureName) : null,
                last_captured_at: capturedAt,
                probe_status: capture.status === 402 ? 'parsed_ok' : `http_${capture.status}`,
            };
        } catch (e) {
            console.warn(`  could not read capture for ${v1Name}: ${e.message}`);
        }
    }

    const out = {
        id: idFlat,
        service_id,
        name: v1Name,
        upstream_ref: { operator, slug, pay_md_path, service_url },
        endpoint: { method: endpointMethod, path: endpointPath, cost_usdc },
        reason: v1Entry.reason,
        verification,
    };
    if (v1Entry.evidence_basis) out.evidence_basis = v1Entry.evidence_basis;
    if (v1Entry.note) out.note = v1Entry.note;

    // Attach audit_pending if the BAT-706 audit found parsed_ok endpoints for this service
    const auditEndpoints = auditMap.get(v1Name) || [];
    if (auditEndpoints.length > 0) {
        const deferBat = DEFER_BAT[v1Name] || null;
        out.audit_pending = auditEndpoints.map(ep => ({
            method: ep.method,
            path: ep.path,
            cost_usdc: ep.cost_usdc,
            deferred_to: deferBat,
        }));
    }
    return out;
}

/** Best-effort probe status from v1 note like "http_401 at 2026-05-14 probe — auth-gated before 402."
 *  R1 #2 fix: only assert parsed_ok when there's actually a capture proving it.
 *  Without a capture, return 'unknown' rather than claim parsed_ok — otherwise
 *  status/drift reporting reads stale "parsed_ok" entries as confirmed-working
 *  when really we never recorded supporting evidence.
 *  Caller may override when capture is available (probe-status derived from capture.status). */
function deriveProbeStatusFromV1(v1Entry) {
    if (v1Entry.note) {
        const m = /\bhttp_(\d{3})\b/.exec(v1Entry.note);
        if (m) return `http_${m[1]}`;
    }
    return 'unknown';
}

// ── Validation per SCHEMA.md ─────────────────────────────────────────────────

function validate(catalog, unsupported) {
    const errors = [];
    const ids = new Set();

    function checkEntry(e, kind) {
        const ctx = `${kind}/${e.id || '?'}`;
        if (!e.id || !/^[a-z0-9-]+$/.test(e.id)) errors.push(`${ctx}: bad id`);
        if (ids.has(e.id)) errors.push(`${ctx}: duplicate id (must be globally unique across catalog+unsupported)`);
        ids.add(e.id);
        if (!e.service_id || !/^[a-z0-9-]+$/.test(e.service_id)) errors.push(`${ctx}: bad service_id`);
        if (!e.name) errors.push(`${ctx}: missing name`);
        if (!e.upstream_ref || !e.upstream_ref.operator || !e.upstream_ref.slug || !e.upstream_ref.pay_md_path) {
            errors.push(`${ctx}: bad upstream_ref`);
        } else {
            const expected = `providers/${e.upstream_ref.operator}/${e.upstream_ref.slug}/PAY.md`;
            if (e.upstream_ref.pay_md_path !== expected) {
                errors.push(`${ctx}: pay_md_path "${e.upstream_ref.pay_md_path}" doesn't match operator+slug → expected "${expected}"`);
            }
        }
        if (!e.endpoint || !e.endpoint.method || !e.endpoint.path) errors.push(`${ctx}: bad endpoint`);
        if (kind === 'catalog' && (typeof e.endpoint.cost_usdc !== 'number' || e.endpoint.cost_usdc < 0)) {
            errors.push(`${ctx}: catalog cost_usdc must be non-negative number`);
        }
        if (kind === 'unsupported' && e.endpoint.cost_usdc !== null && (typeof e.endpoint.cost_usdc !== 'number' || e.endpoint.cost_usdc < 0)) {
            errors.push(`${ctx}: unsupported cost_usdc must be non-negative or null`);
        }
        if (!e.verification) errors.push(`${ctx}: missing verification`);
        else {
            const v = e.verification;
            const capNull = v.last_capture_path === null;
            const capAtNull = v.last_captured_at === null;
            if (capNull !== capAtNull) errors.push(`${ctx}: last_capture_path and last_captured_at must be null together`);
            if (v.probe_status === 'parsed_ok' && capNull && kind === 'catalog') {
                errors.push(`${ctx}: catalog entry with probe_status=parsed_ok must have a capture file`);
            }
            if (kind === 'catalog' && v.probe_status !== 'parsed_ok') {
                errors.push(`${ctx}: catalog probe_status must be parsed_ok (got ${v.probe_status})`);
            }
        }
        if (kind === 'catalog') {
            if (!e.intents || !Array.isArray(e.intents) || e.intents.length < 3) {
                errors.push(`${ctx}: intents must be array with min 3 items`);
            }
            if (!e.summary) errors.push(`${ctx}: missing summary`);
            if (!e.doc_file) errors.push(`${ctx}: missing doc_file`);
            else {
                const docPath = path.join(SKILL_DIR, e.doc_file);
                if (!fs.existsSync(docPath)) errors.push(`${ctx}: doc_file does not exist: ${e.doc_file}`);
            }
        }
        if (kind === 'unsupported') {
            const validReasons = Object.keys(unsupported.reasons || {});
            if (!validReasons.includes(e.reason)) {
                errors.push(`${ctx}: reason "${e.reason}" not in reasons registry`);
            }
        }
    }

    // Top-level checks
    if (catalog.version !== 2) errors.push(`catalog.version must be 2`);
    if (unsupported.version !== 2) errors.push(`unsupported.version must be 2`);
    if (!Array.isArray(catalog.entries)) errors.push(`catalog.entries must be array`);
    if (!Array.isArray(unsupported.entries)) errors.push(`unsupported.entries must be array`);
    if (!unsupported.reasons || typeof unsupported.reasons !== 'object') {
        errors.push(`unsupported.reasons registry missing`);
    }

    for (const e of catalog.entries || []) checkEntry(e, 'catalog');
    for (const e of unsupported.entries || []) checkEntry(e, 'unsupported');

    return errors;
}

// ── Main ─────────────────────────────────────────────────────────────────────

function main() {
    console.log(`migrate-v1-to-v2.js (BAT-761)${DRY_RUN ? ' [dry-run]' : ''}`);
    console.log('');

    const v1Catalog = readJson(CATALOG_PATH);
    const v1Unsupported = readJson(UNSUPPORTED_PATH);

    // Detect already-v2 and bail cleanly. Migration is one-shot per SCHEMA.md
    // — to refresh individual entries on v2, use `probe-catalog.js --refresh <id>`.
    // To re-run migration, restore v1 from git first (e.g. `git checkout HEAD~ -- <paths>`).
    if (v1Catalog.version === 2 && v1Unsupported.version === 2) {
        console.log('Both catalog.json and unsupported.json are already v2 — nothing to migrate.');
        console.log('To refresh individual entries, run: node tests/paysh/probe-catalog.js --refresh <id>');
        console.log('To re-run the full migration, restore v1 files from git first.');
        return;
    }

    const auditMap = parseAuditReport();
    console.log(`Audit report: ${auditMap.size} services with parsed_ok endpoints`);

    // Build v2 catalog entries
    const v1CatalogServices = v1Catalog.services || v1Catalog.entries || [];
    const v2CatalogEntries = v1CatalogServices.map(buildCatalogEntry);

    // Build v2 unsupported entries
    const v1UnsupportedServices = v1Unsupported.services || v1Unsupported.entries || [];
    const v2UnsupportedEntries = v1UnsupportedServices.map(e => buildUnsupportedEntry(e, auditMap));

    const now = new Date().toISOString();

    const v2Catalog = {
        version: 2,
        generated_at: now,
        manifest_checked_at: now,
        source: 'BAT-761 migration from v1 (BAT-699/704/705) + BAT-706 audit data',
        entries: v2CatalogEntries,
    };

    const v2Unsupported = {
        version: 2,
        generated_at: now,
        manifest_checked_at: now,
        source: 'BAT-761 migration from v1 (BAT-699 → PR #378 R10) + BAT-706 audit_pending population',
        reasons: v1Unsupported.reasons || {},
        entries: v2UnsupportedEntries,
    };

    // Validate
    const errors = validate(v2Catalog, v2Unsupported);
    if (errors.length > 0) {
        console.error('\nVALIDATION FAILED:');
        for (const err of errors) console.error(`  ✗ ${err}`);
        process.exit(1);
    }
    console.log(`\nValidation passed: ${v2CatalogEntries.length} catalog entries, ${v2UnsupportedEntries.length} unsupported entries`);

    // Write
    writeJson(CATALOG_PATH, v2Catalog);
    writeJson(UNSUPPORTED_PATH, v2Unsupported);

    // Summary
    const auditPendingCount = v2UnsupportedEntries.reduce((sum, e) => sum + (e.audit_pending?.length || 0), 0);
    console.log(`\nDone. v2 schema active.`);
    console.log(`  catalog.json:     ${v2CatalogEntries.length} entries`);
    console.log(`  unsupported.json: ${v2UnsupportedEntries.length} entries`);
    console.log(`  audit_pending:    ${auditPendingCount} sibling endpoints flagged for follow-up`);
}

main();
