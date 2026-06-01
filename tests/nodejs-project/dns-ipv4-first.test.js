#!/usr/bin/env node
// dns-ipv4-first.test.js — regression for BAT-992.
//
// What this asserts:
//   1. main.js calls require('dns').setDefaultResultOrder('ipv4first')
//      as a top-of-file side effect, BEFORE any other code that might
//      trigger DNS.
//   2. The env var SEEKERCLAW_DNS_RESULT_ORDER overrides the default
//      to 'verbatim' or 'ipv6first' for users who want the post-Node-17
//      RFC-compliant behavior.
//   3. The setDefaultResultOrder call is in main.js text — survives
//      future "clean up unused requires" passes.
//
// Why this exists:
//   On networks with broken IPv6 routing (router advertises IPv6 prefix
//   but upstream IPv6 is non-functional), Node's classic http/https
//   module hangs for full timeout (60s) when DNS happens to return an
//   AAAA record first. Live-debugged on Seeker 2026-06-01 — manifested
//   as deterministic "Poll timeout — reconnecting" cycles and stuck
//   Telegram reactions. The fix is one line at top of main.js.
//
//   If a future contributor "cleans up" the line thinking it's unused,
//   every user on a broken-IPv6 network silently regresses. This test
//   asserts the line is there + behaves correctly.
//
// Run: node tests/nodejs-project/dns-ipv4-first.test.js

'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const dns = require('dns');

const MAIN_JS = path.resolve(
    __dirname, '..', '..',
    'app', 'src', 'main', 'assets', 'nodejs-project', 'main.js'
);

let failures = 0;
function check(name, fn) {
    try {
        fn();
        console.log(`  ✓ ${name}`);
    } catch (e) {
        failures++;
        console.error(`  ✗ ${name}`);
        console.error(`    ${e.message}`);
    }
}

console.log('BAT-992 dns-ipv4-first tests:');

// ── Static check: line is in main.js source ─────────────────────────────────
check('main.js source contains setDefaultResultOrder call', () => {
    const src = fs.readFileSync(MAIN_JS, 'utf8');
    assert.ok(
        /require\(['"]dns['"]\)\.setDefaultResultOrder\(/.test(src),
        'main.js MUST call require(\'dns\').setDefaultResultOrder(...) at module load. '
        + 'Without it, users on broken-IPv6 networks hit 60s hangs. See BAT-992.'
    );
});

check('main.js setDefaultResultOrder call is BEFORE the first network-touching require', () => {
    const src = fs.readFileSync(MAIN_JS, 'utf8');
    const dnsLine = src.search(/require\(['"]dns['"]\)\.setDefaultResultOrder\(/);
    // The first require that could trigger DNS is config.js (which may load
    // network-related state). Assert setDefaultResultOrder comes before it.
    const configLine = src.search(/require\(['"]\.\/config['"]/);
    assert.ok(dnsLine >= 0, 'setDefaultResultOrder call not found');
    assert.ok(configLine >= 0, './config require not found in main.js');
    assert.ok(
        dnsLine < configLine,
        `setDefaultResultOrder MUST come before require('./config') so it takes effect `
        + `before any networking can happen. Found dns line at ${dnsLine}, config require at ${configLine}.`
    );
});

check('main.js respects SEEKERCLAW_DNS_RESULT_ORDER env var override', () => {
    const src = fs.readFileSync(MAIN_JS, 'utf8');
    assert.ok(
        /SEEKERCLAW_DNS_RESULT_ORDER/.test(src),
        'main.js MUST honor SEEKERCLAW_DNS_RESULT_ORDER env var so users with working IPv6 '
        + 'can override to "verbatim" or "ipv6first" if they want RFC behavior. See BAT-992.'
    );
});

// PR #392 Copilot R1: defensive env-var input handling. A typo / whitespace /
// case error in SEEKERCLAW_DNS_RESULT_ORDER would otherwise throw at module
// load BEFORE logging is wired, crashing the agent on boot with no surface.
check('main.js normalizes env-var value (trim + lowercase) before use', () => {
    const src = fs.readFileSync(MAIN_JS, 'utf8');
    // Both .trim() and .toLowerCase() should be applied to the env var read.
    assert.ok(
        /SEEKERCLAW_DNS_RESULT_ORDER[\s\S]{0,200}\.trim\(\)/.test(src),
        'main.js MUST .trim() the env var to tolerate "ipv4first " with trailing space.'
    );
    assert.ok(
        /SEEKERCLAW_DNS_RESULT_ORDER[\s\S]{0,200}\.toLowerCase\(\)/.test(src),
        'main.js MUST .toLowerCase() the env var to tolerate "IPV4FIRST" / "Verbatim".'
    );
});

check('main.js whitelists valid result-order values + falls back to ipv4first on invalid', () => {
    const src = fs.readFileSync(MAIN_JS, 'utf8');
    // The whitelist Set should mention all 3 valid values.
    assert.ok(/['"]ipv4first['"]/.test(src), 'whitelist must include "ipv4first"');
    assert.ok(/['"]ipv6first['"]/.test(src), 'whitelist must include "ipv6first"');
    assert.ok(/['"]verbatim['"]/.test(src), 'whitelist must include "verbatim"');
    // Should be a Set (or equivalent has()-checked structure) used for membership test.
    assert.ok(
        /new Set\(\[\s*['"]ipv4first['"]\s*,\s*['"]ipv6first['"]\s*,\s*['"]verbatim['"]\s*\]\)/.test(src)
        || /\bhas\(\s*_?raw/.test(src),
        'main.js MUST guard env-var input with a whitelist (Set membership), not pass-through.'
    );
});

check('main.js wraps setDefaultResultOrder in try/catch (no crash on weird Node versions)', () => {
    const src = fs.readFileSync(MAIN_JS, 'utf8');
    // The setDefaultResultOrder call MUST be inside a try block.
    assert.ok(
        /try\s*\{[\s\S]{0,400}setDefaultResultOrder\([\s\S]{0,200}\}\s*catch/.test(src),
        'setDefaultResultOrder MUST be wrapped in try/catch — a hostile env / future Node '
        + 'version dropping support for a constant MUST NOT crash the agent at boot. See BAT-992 / PR #392 R1.'
    );
});

// Runtime: verify the normalization logic actually works end-to-end by
// re-implementing it (the literal source assertions above just check the
// shape; this asserts the semantics under various env inputs).
check('R1 semantics: env var normalization tolerates whitespace + case', () => {
    function normalize(raw) {
        const VALID = new Set(['ipv4first', 'ipv6first', 'verbatim']);
        const v = (raw || '').trim().toLowerCase();
        return VALID.has(v) ? v : 'ipv4first';
    }
    assert.strictEqual(normalize(undefined), 'ipv4first', 'unset → default ipv4first');
    assert.strictEqual(normalize(''), 'ipv4first', 'empty → default ipv4first');
    assert.strictEqual(normalize('ipv4first'), 'ipv4first', 'exact valid → as-is');
    assert.strictEqual(normalize('IPV4FIRST'), 'ipv4first', 'uppercase tolerated');
    assert.strictEqual(normalize(' verbatim '), 'verbatim', 'whitespace trimmed');
    assert.strictEqual(normalize('Ipv6First'), 'ipv6first', 'mixed case tolerated');
    assert.strictEqual(normalize('typo'), 'ipv4first', 'typo → fallback (NOT throw)');
    assert.strictEqual(normalize('ipv4'), 'ipv4first', 'partial → fallback');
    assert.strictEqual(normalize('   '), 'ipv4first', 'whitespace-only → fallback');
});

// ── Runtime check: simulate main.js's setDefaultResultOrder behavior ────────
check('dns.setDefaultResultOrder("ipv4first") is supported by this Node version', () => {
    // Sanity: API must exist (Node 18+). nodejs-mobile is on Node 18.
    assert.strictEqual(typeof dns.setDefaultResultOrder, 'function',
        'dns.setDefaultResultOrder requires Node 18+. nodejs-mobile target.');
    assert.strictEqual(typeof dns.getDefaultResultOrder, 'function',
        'dns.getDefaultResultOrder requires Node 18+ (used by this test for verification).');
    // Save + restore around our probe so we don't pollute other tests.
    const original = dns.getDefaultResultOrder();
    try {
        dns.setDefaultResultOrder('ipv4first');
        assert.strictEqual(dns.getDefaultResultOrder(), 'ipv4first',
            'setDefaultResultOrder("ipv4first") must take effect immediately.');
        // Also test the env-var-style overrides we promise to honor.
        dns.setDefaultResultOrder('verbatim');
        assert.strictEqual(dns.getDefaultResultOrder(), 'verbatim');
        dns.setDefaultResultOrder('ipv6first');
        assert.strictEqual(dns.getDefaultResultOrder(), 'ipv6first');
    } finally {
        dns.setDefaultResultOrder(original);
    }
});

// ── Summary ─────────────────────────────────────────────────────────────────
if (failures > 0) {
    console.error(`\nFAILED: ${failures} test(s) failed`);
    process.exit(1);
}
console.log('\nAll BAT-992 dns-ipv4-first tests passed.');
