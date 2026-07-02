#!/usr/bin/env node
// tests/nodejs-project/web-fetch-ssrf-guard.test.js
//
// BAT-1088: web_fetch's SSRF guard is a pure canonical-host classifier,
// isBlockedAddress(hostname), that rejects private/loopback/link-local literals
// before any socket opens (per redirect hop). This is LITERAL screening only —
// NOT DNS-rebind protection (that's BAT-1093).
//
// `new URL()` already canonicalizes IPv4 decimal/octal/hex to dotted-quad, so those
// are regression cases (blocked today); the live add over the old prefix regex is
// IPv6 (loopback / IPv4-mapped / ULA / link-local). Per the BAT-1088 decision, CGNAT
// (100.64/10) and benchmark (198.18/15) are deliberately NOT blocked.

'use strict';

const assert = require('assert');
const path = require('path');
const fs = require('fs');
const os = require('os');

const BUNDLE = path.resolve(__dirname, '..', '..', 'app', 'src', 'main', 'assets', 'nodejs-project');

const workDir = fs.mkdtempSync(path.join(os.tmpdir(), 'bat1088-ssrf-'));
fs.writeFileSync(path.join(workDir, 'config.json'), JSON.stringify({
    botToken: 'placeholder-not-a-real-bot-token',
    anthropicApiKey: 'placeholder-not-a-real-api-key',
    ownerId: '111',
    channel: 'telegram',
}), 'utf8');
process.argv[2] = workDir;
process.on('exit', () => { try { fs.rmSync(workDir, { recursive: true, force: true }); } catch (_) {} });

// Stub the transport before loading web.js so we can assert the guard fires BEFORE
// any socket (the stub must never be called for a blocked host).
const httpMod = require(path.join(BUNDLE, 'http.js'));
let calls = 0;
httpMod.httpRequest = async () => { calls++; return { status: 200, headers: {}, data: 'ok' }; };

const { isBlockedAddress, webFetch } = require(path.join(BUNDLE, 'web.js'));
const tg = require(path.join(BUNDLE, 'telegram.js')); // BAT-1088: shares the same SSRF guard

let pass = 0, fail = 0;
function check(name, fn) {
    try { fn(); pass++; console.log(`  ✓ ${name}`); }
    catch (e) { fail++; console.error(`  ✗ ${name}: ${e.message}`); if (process.env.VERBOSE) console.error(e.stack); }
}
async function checkAsync(name, fn) {
    try { await fn(); pass++; console.log(`  ✓ ${name}`); }
    catch (e) { fail++; console.error(`  ✗ ${name}: ${e.message}`); if (process.env.VERBOSE) console.error(e.stack); }
}

console.log('web-fetch-ssrf-guard.test.js — BAT-1088 private/loopback literal screening');
console.log();

// ---------------------------------------------------------------------------
// isBlockedAddress — pure classifier
// ---------------------------------------------------------------------------
const BLOCK = [
    // IPv6 (the live gap): loopback, unspecified, IPv4-mapped, ULA, link-local
    '[::1]', '::1', '[::]', '[::ffff:127.0.0.1]', '[::ffff:7f00:1]', '[fd00::1]', 'fd00::1', '[fe80::1]', 'fe80::1',
    // IPv6 zone identifiers (RFC 6874) — classify the address, ignore the zone
    'fe80::1%eth0', '[fe80::1%eth0]', '::1%lo0',
    // Deprecated IPv4-compatible IPv6 (::w.x.y.z / ::7f00:1) embedding private/loopback IPv4
    '::127.0.0.1', '::7f00:1', '[::127.0.0.1]', '::10.0.0.1', '::192.168.1.1',
    // IPv4 private / loopback / link-local / this-host
    '127.0.0.1', '127.255.255.254', '10.0.0.1', '172.16.0.1', '172.31.255.255', '192.168.1.1', '169.254.169.254', '0.0.0.0',
    // hostnames — incl. FQDN-root trailing-dot forms (resolve like the un-dotted name)
    'localhost', 'api.localhost', 'localhost.', 'api.localhost.', 'localhost..',
    '127.0.0.1.', // trailing-dot IP literal (belt-and-suspenders; new URL also strips this)
];
const ALLOW = [
    '8.8.8.8', '1.1.1.1', '9.9.9.9',
    '[2606:4700::1111]', '2606:4700::1111',
    '::8.8.8.8', // IPv4-compatible embedding a PUBLIC IPv4 → allowed (consistent with 8.8.8.8)
    'example.com', 'api.example.com', 'example.com.', // trailing-dot public FQDN stays allowed
    // Boundaries just outside the private ranges
    '172.15.0.1', '172.32.0.1',
    // Deliberately allowed in V1 (per BAT-1088 decision)
    '100.64.0.1',  // CGNAT
    '198.18.0.1',  // benchmark
];

check('blocks every private/loopback/link-local literal (IPv4 + IPv6)', () => {
    for (const h of BLOCK) assert.strictEqual(isBlockedAddress(h), true, `should BLOCK ${h}`);
});

check('allows public IPs, hostnames, boundaries, and the V1-excluded CGNAT/benchmark ranges', () => {
    for (const h of ALLOW) assert.strictEqual(isBlockedAddress(h), false, `should ALLOW ${h}`);
});

check('IPv4 alt-radix literals: canonicalized by new URL() then blocked (regression)', () => {
    for (const u of ['https://2130706433/', 'https://0x7f000001/', 'https://0177.0.0.1/', 'https://0/']) {
        const hostname = new URL(u).hostname;
        assert.strictEqual(isBlockedAddress(hostname), true, `${u} -> ${hostname} should block`);
    }
});

check('userinfo confusion: host is the PUBLIC part, so allowed (not private-host SSRF)', () => {
    // https://127.0.0.1@api.example.com/ -> hostname is api.example.com (public)
    const hostname = new URL('https://127.0.0.1@api.example.com/').hostname;
    assert.strictEqual(hostname, 'api.example.com');
    assert.strictEqual(isBlockedAddress(hostname), false);
});

check('fails closed on junk input', () => {
    for (const h of ['', null, undefined, '   ']) assert.strictEqual(isBlockedAddress(h), true, `junk ${JSON.stringify(h)} should block`);
});

// ---------------------------------------------------------------------------
// webFetch integration — guard fires before any socket
// ---------------------------------------------------------------------------
console.log();

(async () => {
    await checkAsync('webFetch to a blocked host throws BEFORE any socket opens', async () => {
        calls = 0;
        await assert.rejects(() => webFetch('https://[::1]/'), /Blocked: private\/local address/);
        assert.strictEqual(calls, 0, 'transport must not be called for a blocked host');
    });

    await checkAsync('webFetch to an alt-radix loopback literal is blocked before socket', async () => {
        calls = 0;
        await assert.rejects(() => webFetch('https://2130706433/'), /Blocked: private\/local address/);
        assert.strictEqual(calls, 0);
    });

    await checkAsync('webFetch to a public host still reaches the transport (no regression)', async () => {
        calls = 0;
        const res = await webFetch('https://example.com/');
        assert.strictEqual(calls, 1, 'public host must reach the transport');
        assert.strictEqual(res.status, 200);
    });

    // Same-class sweep: telegram.js downloadFileByUrl shares the same classifier, so it
    // gets the same IPv6/private coverage. Drift-guard that it actually calls the guard.
    await checkAsync('telegram downloadFileByUrl rejects private hosts via the shared guard', async () => {
        for (const u of ['https://127.0.0.1/x', 'https://[::1]/x', 'https://[::ffff:127.0.0.1]/x', 'https://localhost./x']) {
            await assert.rejects(() => tg.downloadFileByUrl(u, 'f', 100), /Blocked: private\/local address/, `should block ${u}`);
        }
    });

    console.log();
    console.log(`Result: ${pass} passed, ${fail} failed`);
    if (fail > 0) { console.error('FAIL: web-fetch-ssrf-guard.test.js'); process.exit(1); }
    console.log('PASS: web-fetch-ssrf-guard.test.js');
})();
