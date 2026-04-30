// SeekerClaw — custom-config-signature.js (BAT-549 Commit 3d)
//
// Deterministic signature for the "Custom" provider configuration tuple
// (model | baseUrl | format | sortedHeaderKeys). Used to detect when a
// user changes their Custom gateway in Settings — at which point the
// per-Custom advanced override (RuntimeState.customEchoReasoning) is
// reset to `false` and the user is prompted to re-enable it on the new
// gateway. Same algorithm is implemented Kotlin-side in
// `state/CustomConfigSignature.kt`; mismatches are caught by
// dual-side equivalence tests.
//
// ## What's IN the signature
//   - customModel (trimmed)
//   - customBaseUrl (trimmed)
//   - customFormat (trimmed)
//   - sorted lowercased header KEYS (trimmed; non-empty; not __proto__/constructor/prototype)
//
// ## What's NOT in the signature (and why)
//   - apiKey: rotation is common (security best practice). Hashing it
//     would falsely flag a rotation as a "config change" and reset the
//     user's override every time they update their key.
//   - header VALUES: headers may carry secret material (auth tokens,
//     custom-header-based bearer keys). Hashing values would persist a
//     leakable digest of secrets on disk. Header keys alone capture the
//     "shape" of the gateway integration without leaking values.
//
// ## Output
//   - Full SHA-256 hex (64 chars, lowercase) when ANY of model/baseUrl/
//     format are non-blank OR parsed headers have at least one valid key
//   - `null` when ALL inputs are blank/empty (user not on Custom; no
//     signature to track)
//
// The algorithm is deliberately simple — both Node and Kotlin can
// implement it without pulling in URL-parsing libraries that might
// disagree on edge cases (default ports, percent-encoding, etc.). For
// the "did the user touch this config?" question, lossless equality
// of the canonical input string is the right primitive.

'use strict';

const crypto = require('crypto');

/**
 * Parse the customHeaders JSON string and return sorted, lowercased,
 * de-duplicated header keys. Returns `[]` for invalid/empty input.
 *
 * Rejects prototype-poisoning keys (`__proto__`, `constructor`,
 * `prototype`) for parity with `config.js:parseCustomHeaders`. A
 * malformed JSON string (parse failure) is treated as no headers
 * rather than throwing — the signature is a best-effort change-
 * detector, not a config validator.
 */
function _sortedHeaderKeys(rawHeadersJson) {
    if (typeof rawHeadersJson !== 'string') return [];
    const trimmed = rawHeadersJson.trim();
    if (!trimmed) return [];
    let parsed;
    try { parsed = JSON.parse(trimmed); }
    catch (_) { return []; }
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return [];
    const seen = new Set();
    for (const key of Object.keys(parsed)) {
        const k = String(key || '').trim().toLowerCase();
        if (!k) continue;
        if (k === '__proto__' || k === 'constructor' || k === 'prototype') continue;
        seen.add(k);
    }
    return Array.from(seen).sort();
}

/**
 * Compute the BAT-549 customConfigSignature for the provided Custom-
 * config tuple. See file header for inputs/outputs.
 */
function computeCustomConfigSignature(input) {
    const model = (input && typeof input.customModel === 'string') ? input.customModel.trim() : '';
    const baseUrl = (input && typeof input.customBaseUrl === 'string') ? input.customBaseUrl.trim() : '';
    const format = (input && typeof input.customFormat === 'string') ? input.customFormat.trim() : '';
    const headerKeys = _sortedHeaderKeys(input && input.customHeaders);

    // null sentinel: no Custom config means no signature to track.
    // Returning the same hash for two genuinely-different "all blank"
    // states wouldn't be wrong, but using null lets callers distinguish
    // "user hasn't touched Custom" from "user touched and cleared".
    if (!model && !baseUrl && !format && headerKeys.length === 0) {
        return null;
    }

    // Canonical input: stable across both Kotlin and Node sides. The
    // pipe separator was chosen because it's not a valid character in
    // header names (RFC 7230 token-set excludes it) so an inputs-
    // interchange ambiguity is impossible. Header keys are joined with
    // "," — also disallowed in HTTP token names.
    const canonical = `${model}|${baseUrl}|${format}|${headerKeys.join(',')}`;
    return crypto.createHash('sha256').update(canonical, 'utf8').digest('hex');
}

module.exports = {
    computeCustomConfigSignature,
    // Exposed for parity tests with Kotlin's CustomConfigSignature.kt
    _sortedHeaderKeys,
};
