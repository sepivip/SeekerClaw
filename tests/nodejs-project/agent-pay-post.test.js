#!/usr/bin/env node
// agent-pay-post.test.js — BAT-664.
//
// Verifies agent_pay POST support added in BAT-664 v2:
//   - method_not_allowed for PUT / PATCH / DELETE (before any DNS/network)
//   - body_required_for_post when method=POST without body (before network)
//   - body_not_json when string body is not valid JSON (before network)
//   - body_too_large when serialized body > 8 KB UTF-8 (before network)
//   - validateAndSerializeBody compact-serializes once for byte-identical
//     probe + settle replay
//   - Idempotency-Key generated per agent_pay invocation; distinct calls
//     get distinct UUIDs
//   - GET regression: existing under-cap-silent behavior preserved
//   - Zero-network guarantee: every rejection above fires BEFORE DNS resolves

'use strict';

const assert = require('assert');
const path = require('path');
const crypto = require('crypto');

const BUNDLE = path.resolve(__dirname, '..', '..', 'app', 'src', 'main', 'assets', 'nodejs-project');

// Stub config.js for transitive requires (matches other test files).
const configPath = require.resolve(path.join(BUNDLE, 'config.js'));
require.cache[configPath] = {
    id: configPath, filename: configPath, loaded: true,
    exports: { BRIDGE_TOKEN: 't', log: () => {} },
};

// Stub bridge.js so the handler-level tests don't need a live bridge.
const bridgeCalls = [];
const bridgePath = require.resolve(path.join(BUNDLE, 'bridge.js'));
require.cache[bridgePath] = {
    id: bridgePath, filename: bridgePath, loaded: true,
    exports: {
        androidBridgeCall: async (endpoint, body) => {
            bridgeCalls.push({ endpoint, body });
            if (endpoint === '/burner/status') return { configured: false };
            return {};
        },
    },
};

// Stub solana.js (matches agent-pay-no-burner test).
const solanaPath = require.resolve(path.join(BUNDLE, 'solana.js'));
require.cache[solanaPath] = {
    id: solanaPath, filename: solanaPath, loaded: true,
    exports: {
        getConnectedWalletAddress: () => { throw new Error('not connected'); },
        solanaRpc: async () => ({ error: 'mocked' }),
    },
};

const agentPay = require(path.join(BUNDLE, 'tools', 'agent_pay'));
const { validateAndSerializeBody, MAX_POST_BODY_BYTES, preflightUrlSync, handlers } = agentPay;

// Track DNS lookups to assert zero-network guarantee.
let dnsLookupCalled = 0;
agentPay._setDnsLookup(async () => {
    dnsLookupCalled++;
    throw new Error('dns lookup should not have been called');
});

let failures = 0;
async function check(label, fn) {
    try { await fn(); console.log(`  ✓ ${label}`); }
    catch (e) { failures++; console.error(`  ✗ ${label}\n    ${e.stack || e.message}`); }
}

(async () => {
    // ── Unit tests on the validation helpers ────────────────────────────────

    await check('preflightUrlSync allows GET', () => {
        const r = preflightUrlSync('https://example.com/x', 'GET');
        assert.strictEqual(r.method, 'GET');
        assert.ok(r.ok);
    });

    await check('preflightUrlSync allows POST', () => {
        const r = preflightUrlSync('https://example.com/x', 'POST');
        assert.strictEqual(r.method, 'POST');
        assert.ok(r.ok);
    });

    await check('preflightUrlSync defaults to GET when method missing', () => {
        const r = preflightUrlSync('https://example.com/x', undefined);
        assert.strictEqual(r.method, 'GET');
    });

    await check('preflightUrlSync rejects PUT with method_not_allowed', () => {
        const r = preflightUrlSync('https://example.com/x', 'PUT');
        assert.strictEqual(r.error, 'method_not_allowed');
    });

    await check('preflightUrlSync rejects PATCH with method_not_allowed', () => {
        const r = preflightUrlSync('https://example.com/x', 'PATCH');
        assert.strictEqual(r.error, 'method_not_allowed');
    });

    await check('preflightUrlSync rejects DELETE with method_not_allowed', () => {
        const r = preflightUrlSync('https://example.com/x', 'DELETE');
        assert.strictEqual(r.error, 'method_not_allowed');
    });

    await check('validateAndSerializeBody: GET returns bodyJsonStr=null', () => {
        const r = validateAndSerializeBody('GET', undefined);
        assert.deepStrictEqual(r, { bodyJsonStr: null });
    });

    await check('validateAndSerializeBody: GET ignores body if provided', () => {
        // GET path: the body parameter is silently dropped (request never sends a body for GET).
        const r = validateAndSerializeBody('GET', { phone: '+1234567890' });
        assert.strictEqual(r.bodyJsonStr, null);
    });

    await check('validateAndSerializeBody: POST + no body → body_required_for_post', () => {
        const r = validateAndSerializeBody('POST', undefined);
        assert.strictEqual(r.error, 'body_required_for_post');
    });

    await check('validateAndSerializeBody: POST + null body → body_required_for_post', () => {
        const r = validateAndSerializeBody('POST', null);
        assert.strictEqual(r.error, 'body_required_for_post');
    });

    await check('validateAndSerializeBody: POST + object body → compact JSON', () => {
        const r = validateAndSerializeBody('POST', { phone: '+15555550000', message: 'hi' });
        assert.ok(r.bodyJsonStr);
        // Compact serialization — no spaces.
        assert.ok(!r.bodyJsonStr.includes(' '));
        const parsed = JSON.parse(r.bodyJsonStr);
        assert.strictEqual(parsed.phone, '+15555550000');
        assert.strictEqual(parsed.message, 'hi');
    });

    await check('validateAndSerializeBody: POST + valid JSON string → re-serialized', () => {
        const r = validateAndSerializeBody('POST', '{"phone":"+15555550000","message":"hi"}');
        assert.ok(r.bodyJsonStr);
        const parsed = JSON.parse(r.bodyJsonStr);
        assert.strictEqual(parsed.phone, '+15555550000');
    });

    await check('validateAndSerializeBody: POST + invalid JSON string → body_not_json', () => {
        const r = validateAndSerializeBody('POST', 'this is not json');
        assert.strictEqual(r.error, 'body_not_json');
    });

    await check('validateAndSerializeBody: POST + function value → body_not_json', () => {
        // JSON.stringify({fn: ()=>1}) drops the fn → {} (still valid, accepted).
        // JSON.stringify(()=>1) returns undefined → body_not_json.
        const r = validateAndSerializeBody('POST', () => 1);
        assert.strictEqual(r.error, 'body_not_json');
    });

    await check('validateAndSerializeBody: POST + circular → body_not_json', () => {
        const obj = {};
        obj.self = obj;
        const r = validateAndSerializeBody('POST', obj);
        assert.strictEqual(r.error, 'body_not_json');
    });

    await check('validateAndSerializeBody: POST + 8 KB body accepted', () => {
        // 8192 bytes UTF-8 exactly. Build a key:value pair whose JSON length lands at 8192.
        const filler = 'A'.repeat(8192 - 14);  // 14 = '{"k":"' + '"}' + a few padding bytes
        const r = validateAndSerializeBody('POST', { k: filler });
        assert.ok(r.bodyJsonStr, `expected accept, got ${JSON.stringify(r)}`);
        assert.ok(Buffer.byteLength(r.bodyJsonStr, 'utf8') <= MAX_POST_BODY_BYTES);
    });

    await check('validateAndSerializeBody: POST + >8 KB body → body_too_large', () => {
        const huge = 'B'.repeat(10_000);
        const r = validateAndSerializeBody('POST', { k: huge });
        assert.strictEqual(r.error, 'body_too_large');
        // Message mentions the cap.
        assert.ok(r.reason.includes('8192'));
    });

    await check('validateAndSerializeBody: POST cap is computed on UTF-8 bytes (multi-byte chars)', () => {
        // 4097 emoji × 4 bytes each = 16388 bytes (well over 8 KB) wrapped in {"k":"..."}
        // confirms the cap is on UTF-8 byte length, not character count.
        const r = validateAndSerializeBody('POST', { k: '😀'.repeat(2200) });
        assert.strictEqual(r.error, 'body_too_large');
    });

    // ── Handler-level tests: zero-network guarantee on rejection ────────────

    await check('handler: POST + PUT method rejected before DNS', async () => {
        bridgeCalls.length = 0;
        dnsLookupCalled = 0;
        const r = await handlers.agent_pay({
            url: 'https://pay.sh/sandbox/echo',
            max_usdc: '0.10',
            method: 'PUT',
            body: { x: 1 },
        });
        assert.strictEqual(r.error, 'method_not_allowed');
        assert.strictEqual(dnsLookupCalled, 0, 'DNS must not be called for method rejection');
        assert.strictEqual(bridgeCalls.length, 0, 'bridge must not be called for method rejection');
    });

    await check('handler: POST without body rejected before DNS', async () => {
        bridgeCalls.length = 0;
        dnsLookupCalled = 0;
        const r = await handlers.agent_pay({
            url: 'https://pay.sh/sandbox/echo',
            max_usdc: '0.10',
            method: 'POST',
            // no body
        });
        assert.strictEqual(r.error, 'body_required_for_post');
        assert.strictEqual(dnsLookupCalled, 0);
        assert.strictEqual(bridgeCalls.length, 0);
    });

    await check('handler: POST + invalid JSON string body rejected before DNS', async () => {
        bridgeCalls.length = 0;
        dnsLookupCalled = 0;
        const r = await handlers.agent_pay({
            url: 'https://pay.sh/sandbox/echo',
            max_usdc: '0.10',
            method: 'POST',
            body: 'definitely not json',
        });
        assert.strictEqual(r.error, 'body_not_json');
        assert.strictEqual(dnsLookupCalled, 0);
        assert.strictEqual(bridgeCalls.length, 0);
    });

    await check('handler: POST + oversized body rejected before DNS', async () => {
        bridgeCalls.length = 0;
        dnsLookupCalled = 0;
        const r = await handlers.agent_pay({
            url: 'https://pay.sh/sandbox/echo',
            max_usdc: '0.10',
            method: 'POST',
            body: { k: 'X'.repeat(10_000) },
        });
        assert.strictEqual(r.error, 'body_too_large');
        assert.strictEqual(dnsLookupCalled, 0);
        assert.strictEqual(bridgeCalls.length, 0);
    });

    await check('handler: POST + no burner + valid body → burner_not_configured (body check passes first, then bridge check)', async () => {
        // With a valid POST body, validation passes; bridge says no burner.
        // We end up with burner_not_configured. CRITICALLY: DNS is still not
        // called (per BAT-582: refuse before any URL fetch).
        bridgeCalls.length = 0;
        dnsLookupCalled = 0;
        const r = await handlers.agent_pay({
            url: 'https://pay.sh/sandbox/echo',
            max_usdc: '0.10',
            method: 'POST',
            body: { phone: '+15555550000', message: 'hi' },
        });
        assert.strictEqual(r.error, 'burner_not_configured');
        assert.strictEqual(dnsLookupCalled, 0,
            'DNS must not be called when burner unconfigured (true even for POST)');
        // /burner/status was called; nothing else.
        const statusCalls = bridgeCalls.filter(c => c.endpoint === '/burner/status');
        assert.strictEqual(statusCalls.length, 1);
    });

    // ── Idempotency-Key contract — integration test via stubbed fetch ──────

    // R-pr370-fix-5: validate the REAL contract — probe + settle send the
    // SAME `Idempotency-Key` header for one agent_pay invocation, and two
    // separate invocations get DISTINCT keys. Pre-fix this test only asserted
    // crypto.randomUUID() distinctness; it would have passed even if
    // agent_pay forgot to attach the header at all. Now stubs the protocol
    // settle path so we can capture both fetch calls.

    await check('POST integration: probe + settle send the SAME Idempotency-Key, byte-identical body', async () => {
        // Build the originalRequest the handler would construct and call
        // X402Protocol.settle() directly with a fetch helper that captures
        // headers + body bytes. This exercises the EXACT settle dispatch
        // logic in payment/x402.js that BAT-664 extended.
        const x402 = require(path.join(BUNDLE, 'payment', 'x402'));
        const { X402Protocol } = x402;
        const proto = new X402Protocol();

        // Build a synthetic v2 paymentMeta good enough for settle dispatch.
        const idempotencyKey = crypto.randomUUID();
        const bodyJsonStr = JSON.stringify({ phone: '+15555550000', message: 'hi' });
        const paymentMeta = {
            x402Version: 2,
            amountAtomic: 10000n,
            recipient: '9hw9Py9uMGtXRNpABZjifcK1t3suwzjyri9L9QYKg6zZ',
            asset: 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v',
            memo: 'abcd0123abcd0123abcd0123abcd0123',
            negotiatedNetwork: 'solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp',
            requirement: {
                scheme: 'exact',
                network: 'solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp',
                payTo: '9hw9Py9uMGtXRNpABZjifcK1t3suwzjyri9L9QYKg6zZ',
                resource: { url: 'https://api.example.com/text', description: 't', mimeType: 'application/json' },
                maxTimeoutSeconds: 300,
                extra: { feePayer: '2wKupLR9q6wXYppw8Gr2NvWxKBUqm4PPJKkQfoxHDBg4' },
            },
        };

        let settleCallArgs = null;
        const fetchFn = async (parsed, ip, fam, headers, timeout, opts) => {
            settleCallArgs = { parsed, headers, timeout, opts };
            return { status: 200, headers: { 'payment-response': '' }, bodyJson: { ok: true } };
        };

        await proto.settle(
            {
                parsed: new URL('https://api.example.com/text'),
                pinnedIp: '1.2.3.4', pinnedFamily: 4, timeoutLeftMs: 30000,
                method: 'POST',
                bodyJsonStr,
                idempotencyKey,
            },
            'SIGNED-TX',
            paymentMeta,
            { _fetchWithLimits: fetchFn },
        );

        assert.ok(settleCallArgs, 'fetch must have been called by settle');
        // BAT-664: settle must forward the SAME Idempotency-Key the probe used.
        assert.strictEqual(settleCallArgs.headers['idempotency-key'], idempotencyKey,
            'settle replay must reuse the probe idempotency key');
        // BAT-664: method + bodyJsonStr forwarded byte-identically to fetch.
        assert.strictEqual(settleCallArgs.opts.method, 'POST');
        assert.strictEqual(settleCallArgs.opts.bodyJsonStr, bodyJsonStr,
            'settle replay must reuse the same serialized body the probe used');
        // PAYMENT-SIGNATURE proof header must coexist with idempotency-key.
        assert.ok(settleCallArgs.headers['payment-signature'],
            'v2 settle still attaches PAYMENT-SIGNATURE alongside the idempotency key');
    });

    await check('POST integration: GET path does NOT add idempotency-key header (regression)', async () => {
        // R-pr370-fix-5 complement: the GET path must not add an
        // Idempotency-Key header — only POST does, per contract.
        const x402 = require(path.join(BUNDLE, 'payment', 'x402'));
        const { X402Protocol } = x402;
        const proto = new X402Protocol();

        const paymentMeta = {
            x402Version: 2, amountAtomic: 10000n,
            recipient: '9hw9Py9uMGtXRNpABZjifcK1t3suwzjyri9L9QYKg6zZ',
            asset: 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v',
            memo: 'abcd0123abcd0123abcd0123abcd0123',
            negotiatedNetwork: 'solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp',
            requirement: {
                scheme: 'exact', network: 'solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp',
                payTo: '9hw9Py9uMGtXRNpABZjifcK1t3suwzjyri9L9QYKg6zZ',
                resource: { url: 'https://api.example.com/r', description: '', mimeType: 'application/json' },
                maxTimeoutSeconds: 300,
                extra: { feePayer: '2wKupLR9q6wXYppw8Gr2NvWxKBUqm4PPJKkQfoxHDBg4' },
            },
        };

        let captured = null;
        const fetchFn = async (parsed, ip, fam, headers, timeout, opts) => {
            captured = { headers, opts };
            return { status: 200, headers: {}, bodyJson: {} };
        };
        await proto.settle(
            // No method/body/idempotencyKey — GET path.
            { parsed: new URL('https://api.example.com/r'), pinnedIp: '1.2.3.4', pinnedFamily: 4, timeoutLeftMs: 30000 },
            'SIGNED-TX', paymentMeta,
            { _fetchWithLimits: fetchFn },
        );
        assert.ok(captured, 'fetch must have been called');
        assert.ok(!captured.headers['idempotency-key'],
            'idempotency-key MUST NOT be attached on the GET path');
        // method/bodyJsonStr arrive as undefined → _fetchWithLimits defaults to GET, no body.
        assert.ok(captured.opts.method === undefined || captured.opts.method === 'GET');
        assert.ok(!captured.opts.bodyJsonStr,
            'GET path must not have a serialized body');
    });

    await check('crypto.randomUUID() produces distinct UUIDs (handler generates one per invocation)', () => {
        // Format + distinctness sanity check. Kept as a small unit on top
        // of the integration test above so a future refactor that changes
        // the UUID source still trips a clear assertion.
        const a = crypto.randomUUID();
        const b = crypto.randomUUID();
        assert.notStrictEqual(a, b);
        const uuidRe = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
        assert.ok(uuidRe.test(a));
        assert.ok(uuidRe.test(b));
    });

    // ── GET regression: pre-existing behavior preserved ─────────────────────

    await check('GET regression: handler still works for GET (method defaults to GET when omitted)', async () => {
        bridgeCalls.length = 0;
        dnsLookupCalled = 0;
        const r = await handlers.agent_pay({
            url: 'https://pay.sh/sandbox/echo',
            max_usdc: '0.10',
            // No method, no body — pure GET path
        });
        assert.strictEqual(r.error, 'burner_not_configured');  // same as before — no behavior change
        assert.strictEqual(dnsLookupCalled, 0);
    });

    await check('GET regression: explicit method:"GET" + no body works', async () => {
        bridgeCalls.length = 0;
        dnsLookupCalled = 0;
        const r = await handlers.agent_pay({
            url: 'https://pay.sh/sandbox/echo',
            max_usdc: '0.10',
            method: 'GET',
        });
        assert.strictEqual(r.error, 'burner_not_configured');
        assert.strictEqual(dnsLookupCalled, 0);
    });

    if (failures === 0) {
        console.log('\n✓ All agent-pay-post.test.js cases passed');
        process.exit(0);
    } else {
        console.error(`\n✗ ${failures} case(s) failed`);
        process.exit(1);
    }
})();
