// bridge-token.js — pure, dependency-free bridge-token validation (BAT-1071).
//
// Kept separate from config.js on purpose: config.js does heavy require-time
// init (reads config.json, process.exit(1) on missing fields), so it can't be
// imported in a unit test. This module is pure (no deps, no IO) — config.js and
// the tests both import it.
'use strict';

// Canonical UUID shape (8-4-4-4-12 hex) — exactly what SeekerClawService writes
// via UUID.randomUUID().toString() (SeekerClawService.kt:351). The old bridge-
// token check (`length === 36 && /^[0-9a-f-]+$/`) accepted ANY 36 hex-or-dash
// chars — even 36 dashes or misplaced dashes — so a corrupt file was used
// instead of failing to the cold value. This enforces the real shape.
const CANONICAL_UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** True iff `raw` (after trim) is a canonical UUID string. Non-strings → false. */
function isCanonicalBridgeToken(raw) {
    return typeof raw === 'string' && CANONICAL_UUID.test(raw.trim());
}

module.exports = { isCanonicalBridgeToken, CANONICAL_UUID };
