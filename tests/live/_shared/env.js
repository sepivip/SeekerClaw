// tests/live/_shared/env.js
// ─────────────────────────────────────────────────────────────────────────────
// Hand-rolled .env.test parser + secret redaction. Node builtins only (no dotenv).
//
// Shared across every live probe (openai/, xai/, anthropic/) from the repo-wide
// tests/live/_shared/. Keep the API small (loadEnvTest / redact / redactIn) so
// probes depend on a stable surface.
'use strict';

const fs = require('fs');

/**
 * Parse a KEY=VALUE .env file. Ignores blank lines and #-comments. Strips one
 * layer of matching single/double quotes. Never throws on a missing file.
 *
 * @param {string} filePath absolute path to .env.test
 * @param {{assign?: boolean}} [opts] if assign (default true), copies parsed
 *        keys into process.env when not already set.
 * @returns {{loaded: boolean, values: Object<string,string>}}
 */
function loadEnvTest(filePath, { assign = true } = {}) {
    const values = {};
    if (!filePath || !fs.existsSync(filePath)) return { loaded: false, values };
    for (const line of fs.readFileSync(filePath, 'utf8').split(/\r?\n/)) {
        const t = line.trim();
        if (!t || t.startsWith('#')) continue;
        const eq = t.indexOf('=');
        if (eq < 0) continue;
        const k = t.slice(0, eq).trim();
        let v = t.slice(eq + 1).trim();
        if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) {
            v = v.slice(1, -1);
        }
        values[k] = v;
        if (assign && !(k in process.env)) process.env[k] = v;
    }
    return { loaded: true, values };
}

/** Redact a single token to a length-only witness. Never prints the value. */
function redact(tok) {
    return tok ? `present(len=${String(tok).length})` : '(none)';
}

/**
 * Redact any occurrence of known secret values inside an arbitrary string
 * (e.g. a request body dump). Defense-in-depth — the Responses body itself
 * carries no credential, but the Authorization header and any accidental echo
 * would. Only redacts secrets ≥ 6 chars so a short placeholder / empty value
 * can't blank out unrelated text.
 */
function redactIn(str, secrets) {
    let s = String(str == null ? '' : str);
    for (const sec of (secrets || [])) {
        const v = String(sec || '');
        if (v.length >= 6) s = s.split(v).join(`«redacted:present(len=${v.length})»`);
    }
    return s;
}

module.exports = { loadEnvTest, redact, redactIn };
