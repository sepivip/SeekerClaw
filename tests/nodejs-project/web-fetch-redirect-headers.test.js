#!/usr/bin/env node
// tests/nodejs-project/web-fetch-redirect-headers.test.js
//
// BAT-1086: on a CROSS-ORIGIN redirect hop, web_fetch must
//   (1) drop ALL caller-supplied headers — only SAME-ORIGIN hops carry them, so
//       secret auth headers (Authorization, Cookie, x-api-key, bearer-in-custom-
//       header, ...) never follow a redirect to another host; and
//   (2) fail closed on a cross-origin 307/308 that would forward the request BODY
//       to a different origin (data-exfil path even after headers are stripped).
// Same-origin redirects preserve headers + method + body as before.
//
// Two layers: computeOutboundHeaders() is exercised as a pure function, and the
// body-block + per-hop stripping are exercised through the real webFetch redirect
// loop with a stubbed transport that records every outbound request.

'use strict';

const assert = require('assert');
const path = require('path');
const fs = require('fs');
const os = require('os');

const BUNDLE = path.resolve(__dirname, '..', '..', 'app', 'src', 'main', 'assets', 'nodejs-project');

// config.js (required transitively by http.js/web.js) reads its workDir from
// process.argv[2] and process.exit(1)s without a valid config.json. Point it at a
// throwaway fixture workDir BEFORE any bundle require so the real modules load.
const workDir = fs.mkdtempSync(path.join(os.tmpdir(), 'bat1086-webfetch-'));
// Fixtures use obviously-fake, non-credential-shaped placeholders (config.js only
// requires these to be non-empty) so secret scanners don't flag the test file.
fs.writeFileSync(path.join(workDir, 'config.json'), JSON.stringify({
    botToken: 'placeholder-not-a-real-bot-token',
    anthropicApiKey: 'placeholder-not-a-real-api-key',
    ownerId: '111',
    channel: 'telegram',
}), 'utf8');
process.argv[2] = workDir;
process.on('exit', () => { try { fs.rmSync(workDir, { recursive: true, force: true }); } catch (_) {} });

// Stub the transport BEFORE loading web.js so its `const { httpRequest } = require('./http')`
// destructure captures our stub. `calls` records every outbound hop; `responses` is the
// scripted response queue (one entry consumed per hop).
const httpMod = require(path.join(BUNDLE, 'http.js'));
let responses = [];
let calls = [];
httpMod.httpRequest = async (opts, body) => {
    calls.push({ opts, body });
    if (responses.length === 0) throw new Error('stub: no scripted response for this hop');
    return responses.shift();
};

const { webFetch, computeOutboundHeaders } = require(path.join(BUNDLE, 'web.js'));
const { USER_AGENT } = require(path.join(BUNDLE, 'config.js'));

let pass = 0, fail = 0;
function check(name, fn) {
    try { fn(); pass++; console.log(`  ✓ ${name}`); }
    catch (e) { fail++; console.error(`  ✗ ${name}: ${e.message}`); if (process.env.VERBOSE) console.error(e.stack); }
}
async function checkAsync(name, fn) {
    try { await fn(); pass++; console.log(`  ✓ ${name}`); }
    catch (e) { fail++; console.error(`  ✗ ${name}: ${e.message}`); if (process.env.VERBOSE) console.error(e.stack); }
}

function reset() { responses = []; calls = []; }
function redirect(status, location) { return { status, headers: { location }, data: '' }; }
function ok() { return { status: 200, headers: {}, data: 'done' }; }
function headerKeys(h) { return Object.keys(h).map(k => k.toLowerCase()); }

console.log('web-fetch-redirect-headers.test.js — BAT-1086 cross-origin header + body strip');
console.log();

// ---------------------------------------------------------------------------
// computeOutboundHeaders — pure
// ---------------------------------------------------------------------------
const ORIGIN = new URL('https://api.example.com/start');

check('same-origin hop carries caller headers + framework defaults', () => {
    const url = new URL('https://api.example.com/next');
    const h = computeOutboundHeaders({ 'X-Api-Key': 'SECRET', Authorization: 'Bearer T' }, url, ORIGIN, {}, null);
    assert.strictEqual(h['X-Api-Key'], 'SECRET');
    assert.strictEqual(h['Authorization'], 'Bearer T');
    assert.strictEqual(h['User-Agent'], USER_AGENT);
    assert.ok(h['Accept']);
});

check('cross-origin hop drops ALL caller headers, keeps only defaults', () => {
    const url = new URL('https://evil.example.com/collect');
    const h = computeOutboundHeaders(
        { 'X-Api-Key': 'SECRET', Authorization: 'Bearer T', Cookie: 'sid=1', 'X-Goog-Api-Key': 'G', 'X-Foo': 'bar' },
        url, ORIGIN, {}, null);
    const keys = headerKeys(h);
    for (const leaked of ['x-api-key', 'authorization', 'cookie', 'x-goog-api-key', 'x-foo']) {
        assert.ok(!keys.includes(leaked), `header ${leaked} must be absent cross-origin`);
    }
    assert.strictEqual(h['User-Agent'], USER_AGENT);
    assert.ok(h['Accept']);
});

check('same-origin object body derives Content-Type when caller omits it', () => {
    const url = new URL('https://api.example.com/next');
    const h = computeOutboundHeaders({}, url, ORIGIN, {}, { a: 1 });
    assert.strictEqual(h['Content-Type'], 'application/json');
});

check('same-origin caller Content-Type is preserved (not overwritten)', () => {
    const url = new URL('https://api.example.com/next');
    const h = computeOutboundHeaders({ 'Content-Type': 'text/plain' }, url, ORIGIN, {}, { a: 1 });
    assert.strictEqual(h['Content-Type'], 'text/plain');
});

check('same-origin: prototype-pollution header keys are filtered out', () => {
    const url = new URL('https://api.example.com/next');
    // JSON.parse (not an object literal) yields REAL own "__proto__"/"constructor"
    // properties that Object.entries enumerates — the shape an attacker would send.
    const malicious = JSON.parse('{"__proto__":"x","constructor":"y","prototype":"z","X-Ok":"v"}');
    const h = computeOutboundHeaders(malicious, url, ORIGIN, {}, null);
    const keys = headerKeys(h);
    for (const bad of ['__proto__', 'constructor', 'prototype']) {
        assert.ok(!keys.includes(bad), `dangerous key ${bad} must be filtered`);
    }
    assert.strictEqual(h['X-Ok'], 'v', 'safe caller header still passes through');
    assert.strictEqual(({}).polluted, undefined, 'Object.prototype must be untouched');
});

check('cross-origin never derives Content-Type from a (would-be) body', () => {
    // Guards the invariant even though webFetch blocks cross-origin bodies upstream.
    const url = new URL('https://evil.example.com/x');
    const h = computeOutboundHeaders({}, url, ORIGIN, {}, { a: 1 });
    assert.ok(!headerKeys(h).includes('content-type'));
});

// ---------------------------------------------------------------------------
// webFetch redirect loop — stubbed transport
// ---------------------------------------------------------------------------
console.log();

(async () => {
    await checkAsync('cross-origin 302: secret headers absent on 2nd hop, present on 1st', async () => {
        reset();
        responses = [redirect(302, 'https://evil.example.com/collect'), ok()];
        await webFetch('https://api.example.com/start', {
            headers: { 'X-Api-Key': 'SECRET', Authorization: 'Bearer T', Cookie: 'sid=1' },
        });
        assert.strictEqual(calls.length, 2, 'expected 2 hops');
        // hop 0 = original (same-origin) → headers present
        assert.strictEqual(calls[0].opts.headers['X-Api-Key'], 'SECRET');
        // hop 1 = cross-origin → headers stripped
        const k2 = headerKeys(calls[1].opts.headers);
        for (const leaked of ['x-api-key', 'authorization', 'cookie']) {
            assert.ok(!k2.includes(leaked), `hop2 must not carry ${leaked}`);
        }
        assert.strictEqual(calls[1].opts.headers['User-Agent'], USER_AGENT);
    });

    await checkAsync('same-origin 302: custom header preserved on 2nd hop', async () => {
        reset();
        responses = [redirect(302, 'https://api.example.com/other'), ok()];
        await webFetch('https://api.example.com/start', { headers: { 'X-Api-Key': 'SECRET' } });
        assert.strictEqual(calls.length, 2);
        assert.strictEqual(calls[1].opts.headers['X-Api-Key'], 'SECRET');
    });

    await checkAsync('A->B->A: header stripped on B, re-attached on the final A hop', async () => {
        reset();
        responses = [
            redirect(302, 'https://b.example.com/hop'),   // A -> B (cross-origin)
            redirect(302, 'https://api.example.com/back'), // B -> A (back to original origin)
            ok(),
        ];
        await webFetch('https://api.example.com/start', { headers: { 'X-Api-Key': 'SECRET' } });
        assert.strictEqual(calls.length, 3);
        assert.ok(!headerKeys(calls[1].opts.headers).includes('x-api-key'), 'B hop must be stripped');
        assert.strictEqual(calls[2].opts.headers['X-Api-Key'], 'SECRET', 'final A hop must re-attach');
    });

    await checkAsync('cross-origin 307 WITH body: blocked before the 2nd hop is sent', async () => {
        reset();
        responses = [redirect(307, 'https://evil.example.com/collect'), ok()];
        await assert.rejects(
            () => webFetch('https://api.example.com/start', { method: 'POST', body: { secret: 'payload' } }),
            /Blocked: cross-origin redirect with request body/,
        );
        assert.strictEqual(calls.length, 1, 'only the initial request may be sent; body must not reach the 2nd host');
    });

    await checkAsync('same-origin 307 WITH body: method + body preserved on 2nd hop', async () => {
        reset();
        responses = [redirect(307, 'https://api.example.com/other'), ok()];
        await webFetch('https://api.example.com/start', { method: 'POST', body: { a: 1 } });
        assert.strictEqual(calls.length, 2);
        assert.strictEqual(calls[1].opts.method, 'POST', 'method preserved on same-origin 307');
        assert.deepStrictEqual(calls[1].body, { a: 1 }, 'body preserved on same-origin 307');
    });

    await checkAsync('cross-origin 303 (GET, no body): allowed, headers stripped', async () => {
        // 303 downgrades to GET and drops body, so cross-origin is fine — only headers strip.
        reset();
        responses = [redirect(303, 'https://evil.example.com/x'), ok()];
        const res = await webFetch('https://api.example.com/start', {
            method: 'POST', body: { a: 1 }, headers: { Authorization: 'Bearer T' },
        });
        assert.strictEqual(calls.length, 2);
        assert.strictEqual(calls[1].opts.method, 'GET', '303 downgrades to GET');
        assert.strictEqual(calls[1].body, null, '303 drops body');
        assert.ok(!headerKeys(calls[1].opts.headers).includes('authorization'));
        assert.strictEqual(res.finalUrl, 'https://evil.example.com/x');
    });

    console.log();
    console.log(`Result: ${pass} passed, ${fail} failed`);
    if (fail > 0) { console.error('FAIL: web-fetch-redirect-headers.test.js'); process.exit(1); }
    console.log('PASS: web-fetch-redirect-headers.test.js');
})();
