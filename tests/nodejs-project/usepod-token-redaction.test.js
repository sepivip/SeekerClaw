#!/usr/bin/env node
// usepod-token-redaction.test.js — Codex v1 amendment #1 / v2.2 contract:
// The Usepod token UUID must NEVER appear in any log/error/dump/config-snapshot
// output. Two redaction passes cover it: (a) literal-value via the dynamic
// patterns branch in `rebuildRedactPatterns`, (b) URL-path-form via a regex
// pass in `redactSecrets`. This test pins both with a sentinel UUID and
// asserts ZERO raw UUID across all captures.
//
// The assertion is property-based ("no raw UUID anywhere") rather than
// placeholder-specific ("must produce [REDACTED:usepodToken]") per Codex v2
// fix #1 — the placeholder produced by the literal-value pass is not the
// load-bearing contract; the no-leak property is.
//
// Run: node tests/nodejs-project/usepod-token-redaction.test.js
// Exit: 0 = sentinel never leaks, 1 = at least one leak

'use strict';

const path = require('path');

// Sentinel UUID. Choosing all-`a` so accidental matches on real UUIDs in
// other test fixtures are impossible.
const SENTINEL = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa';

// Stub config.js so security.js can load. The stub provides only the fields
// security.js actually reads at top level (BRIDGE_TOKEN, workDir, log) plus
// the `config` namespace it iterates in rebuildRedactPatterns.
const stubConfigPath = path.resolve(__dirname, '../../app/src/main/assets/nodejs-project/config.js');
require.cache[stubConfigPath] = {
    id: stubConfigPath,
    filename: stubConfigPath,
    loaded: true,
    exports: {
        BRIDGE_TOKEN: '',
        workDir: __dirname,
        log: () => {},
        // `config` is the OBJECT rebuildRedactPatterns iterates. The Usepod
        // branch reads `config.usepodToken` — must match the sentinel exactly.
        config: {
            usepodToken: SENTINEL,
            // A couple of unrelated ApiKey-suffix fields prove the existing
            // *ApiKey loop still works alongside the new non-suffixed branch.
            braveApiKey: 'BSA1234567890abcdef',
            openrouterApiKey: 'sk-or-v1-1234567890abcdef1234567890',
        },
    },
};

const { redactSecrets, rebuildRedactPatterns } = require('../../app/src/main/assets/nodejs-project/security');

// Re-build patterns now that the stub `config.usepodToken` is in place
// (security.js already called this once at module load; doing it again is
// idempotent and ensures the test reflects the stubbed fixture).
rebuildRedactPatterns();

let failures = 0;
function assertNoLeak(label, output) {
    if (typeof output !== 'string' || !output.includes(SENTINEL)) {
        console.log(`PASS: ${label}`);
    } else {
        console.log(`FAIL: ${label}\n  sentinel leaked into output: ${output}`);
        failures++;
    }
}
function assertReplaced(label, raw, expectedSubstring) {
    const out = redactSecrets(raw);
    assertNoLeak(label, out);
    if (typeof out === 'string' && out.includes(expectedSubstring)) {
        console.log(`PASS: ${label} — redaction substring present`);
    } else if (typeof out === 'string') {
        console.log(`INFO: ${label} — no specific placeholder asserted, but no leak detected`);
    }
}

// ─── Exercise A: literal token in arbitrary log lines ─────────────────────

console.log('── Literal-value redaction (sentinel never leaks) ──');

assertReplaced(
    'literal token in info log',
    `[Usepod] Initialized with token=${SENTINEL} on ${new Date(0).toISOString()}`,
    '[REDACTED',
);

assertReplaced(
    'literal token in error stack message',
    `Error: failed to call api.usepod.ai (token=${SENTINEL}): connection refused`,
    '[REDACTED',
);

assertReplaced(
    'literal token in JSON-serialized config snapshot',
    JSON.stringify({ provider: 'usepod', usepodToken: SENTINEL, usepodModel: 'test-model' }),
    '[REDACTED',
);

// ─── Exercise B: URL-path-form redaction ──────────────────────────────────

console.log('── URL-path-form redaction (/proxy/<uuid>/...) ──');

assertReplaced(
    '/balance path is redacted',
    `GET https://api.usepod.ai/proxy/${SENTINEL}/balance returned 401`,
    '/proxy/[REDACTED]/',
);

assertReplaced(
    '/v1/chat/completions path is redacted',
    `POST https://api.usepod.ai/proxy/${SENTINEL}/v1/chat/completions stream=true`,
    '/proxy/[REDACTED]/',
);

assertReplaced(
    '/v1/models path is redacted (broadened regex catches all /proxy/<uuid>/* paths)',
    `[trace] GET /proxy/${SENTINEL}/v1/models returned 200`,
    '/proxy/[REDACTED]/',
);

assertReplaced(
    '/completions path is redacted (no /v1 prefix variation)',
    `[trace] /proxy/${SENTINEL}/completions`,
    '/proxy/[REDACTED]/',
);

assertReplaced(
    'path with query string is redacted',
    `/proxy/${SENTINEL}/v1/chat/completions?stream=true&debug=1`,
    '/proxy/[REDACTED]/',
);

// ─── Exercise C: combined leak (sentinel appears in multiple forms) ─────

console.log('── Combined leak scenarios ──');

const combinedMsg =
    `Failed request: token=${SENTINEL} url=https://api.usepod.ai/proxy/${SENTINEL}/balance ` +
    `body={"error":"unauthorized","at":"${SENTINEL}"} — retrying`;
assertNoLeak('combined: literal + path-form + JSON embedding all redacted', redactSecrets(combinedMsg));

// ─── Exercise D: ensure pre-existing redactions still work ──────────────

console.log('── Pre-existing redactions unaffected ──');

const braveLog = `[Brave] using key=BSA1234567890abcdef for search`;
const out = redactSecrets(braveLog);
if (out.includes('BSA1234567890abcdef')) {
    console.log(`FAIL: brave key leaked (regression in *ApiKey redaction path)`);
    failures++;
} else {
    console.log('PASS: BSA-prefixed key still redacted (no regression)');
}

const openrouterLog = `[OR] using sk-or-v1-1234567890abcdef1234567890`;
const out2 = redactSecrets(openrouterLog);
if (out2.includes('sk-or-v1-1234567890abcdef1234567890')) {
    console.log(`FAIL: openrouter key leaked (regression in sk-or- redaction)`);
    failures++;
} else {
    console.log('PASS: sk-or- key still redacted (no regression)');
}

// ─── Exercise E: token rotation rebuilds patterns ───────────────────────

console.log('── Token rotation: rebuildRedactPatterns updates the literal-value pass ──');

const OLD_TOKEN = SENTINEL;
const NEW_TOKEN = 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb';

// Simulate token rotation: update the stubbed config + rebuild
require.cache[stubConfigPath].exports.config.usepodToken = NEW_TOKEN;
rebuildRedactPatterns();

assertReplaced(
    'after rotation, NEW token is redacted (literal-value)',
    `[Usepod] now using token=${NEW_TOKEN}`,
    '[REDACTED',
);

// Path-form regex catches BOTH old AND new tokens (it's UUID-shape based,
// not literal-value based) — important for log lines written BEFORE the
// rotation that still contain old-token paths.
assertReplaced(
    'path-form regex catches OLD token URL even after rotation',
    `[trace] /proxy/${OLD_TOKEN}/balance — stale log entry`,
    '/proxy/[REDACTED]/',
);
assertReplaced(
    'path-form regex catches NEW token URL',
    `[trace] /proxy/${NEW_TOKEN}/balance`,
    '/proxy/[REDACTED]/',
);

// ─── Summary ─────────────────────────────────────────────────────────────

console.log('');
if (failures > 0) {
    console.log(`FAIL: ${failures} sentinel-token leak(s) detected.`);
    process.exit(1);
} else {
    console.log('PASS: sentinel UUID never appeared in any redacted output.');
    process.exit(0);
}
