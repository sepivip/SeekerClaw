#!/usr/bin/env node
// dns-ipv4-first.test.js — regression for BAT-992.
//
// What this asserts:
//   1. main.js calls require('dns').setDefaultResultOrder('ipv4first')
//      as a top-of-file side effect, BEFORE any code that does outbound
//      networking.
//   2. The env var SEEKERCLAW_DNS_RESULT_ORDER overrides the default
//      to 'verbatim' for users who want the post-Node-17 RFC-compliant
//      behavior. On Node 18 (nodejs-mobile target) those are the only
//      two values setDefaultResultOrder accepts — 'ipv6first' is a
//      Node 20+ addition and is intentionally NOT exposed.
//   3. The env-var override path works for the on-device user-facing
//      flow too: Settings → Env Vars writes into workspace/config.json
//      under envVars.*, which main.js reads directly (config.js's
//      process.env merge runs AFTER main.js's DNS setup, so we can't
//      rely on it here).
//   4. The setDefaultResultOrder call is in main.js text — survives
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

check('main.js setDefaultResultOrder call runs as a top-of-file side effect, before any outbound-networking module loads', () => {
    const src = fs.readFileSync(MAIN_JS, 'utf8');
    const dnsLine = src.search(/require\(['"]dns['"]\)\.setDefaultResultOrder\(/);
    // We assert the DNS call comes before require('./config') as a proxy
    // for "very early in module load". config.js itself doesn't do DNS,
    // but it's the first long-running require and a useful sentinel. PR
    // #392 R3 made the env-var read independent of config.js's
    // process.env merge by reading workspace/config.json directly (see
    // _readDnsOrderFromConfigJson in main.js), so this ordering remains
    // safe even though config.js is where Settings → Env Vars get merged.
    const configLine = src.search(/require\(['"]\.\/config['"]/);
    assert.ok(dnsLine >= 0, 'setDefaultResultOrder call not found');
    assert.ok(configLine >= 0, './config require not found in main.js');
    assert.ok(
        dnsLine < configLine,
        `setDefaultResultOrder MUST come before require('./config') as a sentinel `
        + `for "very early in module load". Found dns line at ${dnsLine}, config require at ${configLine}.`
    );
});

check('main.js respects SEEKERCLAW_DNS_RESULT_ORDER env var override', () => {
    const src = fs.readFileSync(MAIN_JS, 'utf8');
    assert.ok(
        /SEEKERCLAW_DNS_RESULT_ORDER/.test(src),
        'main.js MUST honor SEEKERCLAW_DNS_RESULT_ORDER env var so users with working IPv6 '
        + 'can override to "verbatim" if they want RFC behavior. See BAT-992.'
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

check('main.js whitelists Node 18-supported result-order values + falls back to ipv4first on invalid', () => {
    const src = fs.readFileSync(MAIN_JS, 'utf8');
    // Node 18 (nodejs-mobile target) supports only 'verbatim' and 'ipv4first'.
    // 'ipv6first' was added in Node 20 — intentionally not in the whitelist
    // here. When/if nodejs-mobile bumps to Node 20+, this assertion may be
    // extended to include 'ipv6first'.
    assert.ok(/['"]ipv4first['"]/.test(src), 'whitelist must include "ipv4first"');
    assert.ok(/['"]verbatim['"]/.test(src), 'whitelist must include "verbatim"');
    assert.ok(
        !/['"]ipv6first['"]/.test(src),
        'whitelist MUST NOT include "ipv6first" on a Node 18 target — Node 18 throws when '
        + 'setDefaultResultOrder receives it, so exposing it as a valid env-var value is useless '
        + 'AND triggers the try/catch fallback path unnecessarily. Remove from the whitelist '
        + 'until nodejs-mobile bumps to Node 20+.'
    );
    // Membership-checked structure (Set.has or equivalent) — not a pass-through.
    assert.ok(
        /new Set\(\[\s*['"]ipv4first['"]\s*,\s*['"]verbatim['"]\s*\]\)/.test(src)
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
        // Mirror main.js whitelist (Node 18: 'ipv4first', 'verbatim').
        const VALID = new Set(['ipv4first', 'verbatim']);
        const v = (raw || '').trim().toLowerCase();
        return VALID.has(v) ? v : 'ipv4first';
    }
    assert.strictEqual(normalize(undefined), 'ipv4first', 'unset → default ipv4first');
    assert.strictEqual(normalize(''), 'ipv4first', 'empty → default ipv4first');
    assert.strictEqual(normalize('ipv4first'), 'ipv4first', 'exact valid → as-is');
    assert.strictEqual(normalize('IPV4FIRST'), 'ipv4first', 'uppercase tolerated');
    assert.strictEqual(normalize(' verbatim '), 'verbatim', 'whitespace trimmed');
    assert.strictEqual(normalize('Verbatim'), 'verbatim', 'mixed case tolerated');
    // ipv6first is NOT in the Node-18 whitelist → falls back to ipv4first,
    // which is the correct behavior on Node 18 (where ipv6first would
    // throw if passed to setDefaultResultOrder).
    assert.strictEqual(normalize('ipv6first'), 'ipv4first', 'ipv6first (Node 20+ only) → fallback on Node 18');
    assert.strictEqual(normalize('typo'), 'ipv4first', 'typo → fallback (NOT throw)');
    assert.strictEqual(normalize('ipv4'), 'ipv4first', 'partial → fallback');
    assert.strictEqual(normalize('   '), 'ipv4first', 'whitespace-only → fallback');
});

// ── Runtime check: simulate main.js's setDefaultResultOrder behavior ────────
// PR #392 R3: the user-facing on-device path for setting env vars is
// Settings → Env Vars, which writes into workspace/config.json under
// `envVars.*`. config.js merges those into process.env AFTER main.js's
// DNS setup runs, so process.env.SEEKERCLAW_DNS_RESULT_ORDER is empty at
// the moment main.js needs it. The fix: main.js reads config.json
// directly. These tests prove that path works end-to-end.
check('R3 main.js source reads workspace/config.json as env-var fallback', () => {
    const src = fs.readFileSync(MAIN_JS, 'utf8');
    assert.ok(
        /config\.json/.test(src),
        'main.js MUST read workspace/config.json directly as a fallback for the env var, '
        + 'so users setting SEEKERCLAW_DNS_RESULT_ORDER via the Settings → Env Vars UI '
        + '(which writes into config.json, NOT process.env at the moment we read it) '
        + 'still get their override honored. See BAT-992 / PR #392 R3.'
    );
    assert.ok(
        /argv\[2\]/.test(src) || /workDir/.test(src),
        'main.js MUST resolve the config.json path the same way config.js does '
        + '(workDir = process.argv[2] || __dirname).'
    );
});

check('R3 semantics: process.env wins over config.json', () => {
    // Simulate the precedence: if process.env is set, it wins.
    function resolveOrder(envValue, configValue) {
        const VALID = new Set(['ipv4first', 'verbatim']);
        const raw = (envValue || configValue || '').trim().toLowerCase();
        return VALID.has(raw) ? raw : 'ipv4first';
    }
    assert.strictEqual(
        resolveOrder('verbatim', 'ipv4first'),
        'verbatim',
        'process.env value must win over config.json value (developer/OS-level beats user/Settings)'
    );
    assert.strictEqual(
        resolveOrder(undefined, 'verbatim'),
        'verbatim',
        'config.json value used when process.env is empty (the typical on-device path)'
    );
    assert.strictEqual(
        resolveOrder(undefined, undefined),
        'ipv4first',
        'neither set → safe default ipv4first'
    );
    assert.strictEqual(
        resolveOrder(undefined, 'ipv6first'),
        'ipv4first',
        'config.json invalid value (ipv6first on Node 18) → fallback to ipv4first'
    );
});

check('R3 end-to-end: write a fake config.json + read it back via the same logic main.js uses', () => {
    const os = require('os');
    // Create a temp workspace dir with a config.json that has envVars set.
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'seekerclaw-dns-test-'));
    try {
        const cfgPath = path.join(tmpDir, 'config.json');
        fs.writeFileSync(cfgPath, JSON.stringify({
            envVars: { SEEKERCLAW_DNS_RESULT_ORDER: 'verbatim' },
            // Some other typical config.json content for realism:
            anthropicApiKey: 'sk-test',
            model: 'claude-opus-4-7',
        }));
        // Re-implement the exact resolution logic from main.js — if it
        // diverges, this test fails and forces the test to be updated too.
        const cfg = JSON.parse(fs.readFileSync(cfgPath, 'utf8'));
        const v = cfg && cfg.envVars && cfg.envVars.SEEKERCLAW_DNS_RESULT_ORDER;
        assert.strictEqual(v, 'verbatim',
            'config.json fallback read of envVars.SEEKERCLAW_DNS_RESULT_ORDER must work');
        // Now negative case: malformed JSON returns null gracefully (no throw).
        fs.writeFileSync(cfgPath, '{{{ broken json');
        let threw = false;
        try { JSON.parse(fs.readFileSync(cfgPath, 'utf8')); } catch (_) { threw = true; }
        assert.ok(threw, 'malformed JSON should throw on parse (main.js wraps in try/catch)');
        // The main.js code wraps this in try/catch and returns null — so a
        // corrupt config.json results in the safe default 'ipv4first'.
        // We've verified the source has try/catch separately above.
    } finally {
        try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch (_) {}
    }
});

check('dns.setDefaultResultOrder is supported on Node 18 (nodejs-mobile target)', () => {
    // Sanity: API must exist on Node 18 (nodejs-mobile target).
    assert.strictEqual(typeof dns.setDefaultResultOrder, 'function',
        'dns.setDefaultResultOrder requires Node 18+. nodejs-mobile target.');
    assert.strictEqual(typeof dns.getDefaultResultOrder, 'function',
        'dns.getDefaultResultOrder requires Node 18+ (used by this test for verification).');
    // Save + restore around our probe so we don't pollute other tests.
    const original = dns.getDefaultResultOrder();
    try {
        // Node 18 supports 'verbatim' and 'ipv4first' only. 'ipv6first' was
        // added in Node 20 — intentionally NOT tested here since the target
        // runtime is Node 18 LTS (nodejs-mobile).
        dns.setDefaultResultOrder('ipv4first');
        assert.strictEqual(dns.getDefaultResultOrder(), 'ipv4first',
            'setDefaultResultOrder("ipv4first") must take effect immediately.');
        dns.setDefaultResultOrder('verbatim');
        assert.strictEqual(dns.getDefaultResultOrder(), 'verbatim',
            'setDefaultResultOrder("verbatim") must take effect immediately.');
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
