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

// Stub config.js for transitive requires. tools/index.js → security.js
// destructures `config` and iterates its keys at module load, so the
// stub must include `config: {}` (empty object) to avoid the load crash.
const configPath = require.resolve(path.join(BUNDLE, 'config.js'));
require.cache[configPath] = {
    id: configPath, filename: configPath, loaded: true,
    exports: { BRIDGE_TOKEN: 't', log: () => {}, config: {}, workDir: '/tmp' },
};

// Stub bridge.js so the handler-level tests don't need a live bridge.
// Use a mutable handler reference so tests can swap behavior between
// "no burner" (default) and "configured burner" — the agent_pay module
// captures `androidBridgeCall` at require time, so we need the wrapper
// to delegate through a mutable function ref.
const bridgeCalls = [];
let _bridgeHandler = async (endpoint /* , body */) => {
    if (endpoint === '/burner/status') return { configured: false };
    return {};
};
const bridgePath = require.resolve(path.join(BUNDLE, 'bridge.js'));
require.cache[bridgePath] = {
    id: bridgePath, filename: bridgePath, loaded: true,
    exports: {
        androidBridgeCall: async (endpoint, body) => {
            bridgeCalls.push({ endpoint, body });
            return _bridgeHandler(endpoint, body);
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

    await check('validateAndSerializeBody: POST + body sized at exactly MAX_POST_BODY_BYTES is accepted', () => {
        // R-pr370-fix-8: compute filler from actual JSON overhead so the
        // resulting serialized size is exactly MAX_POST_BODY_BYTES, not
        // "approximately 8 KB". The overhead for {"k":"…"} is 8 bytes
        // (`{"k":""}`) in ASCII; filler needs to fill the remaining
        // MAX_POST_BODY_BYTES - 8 bytes.
        const JSON_OVERHEAD = JSON.stringify({ k: '' }).length;  // 8
        const filler = 'A'.repeat(MAX_POST_BODY_BYTES - JSON_OVERHEAD);
        const r = validateAndSerializeBody('POST', { k: filler });
        assert.ok(r.bodyJsonStr, `expected accept, got ${JSON.stringify(r)}`);
        // Tight boundary: exactly equal to the cap, not "≤".
        assert.strictEqual(Buffer.byteLength(r.bodyJsonStr, 'utf8'), MAX_POST_BODY_BYTES,
            `serialized body should be exactly MAX_POST_BODY_BYTES (${MAX_POST_BODY_BYTES}) bytes`);
    });

    await check('validateAndSerializeBody: POST + body 1 byte over the cap is rejected', () => {
        // Pair with the exact-cap test above — together they pin the
        // boundary at MAX_POST_BODY_BYTES inclusive.
        const JSON_OVERHEAD = JSON.stringify({ k: '' }).length;
        const filler = 'A'.repeat(MAX_POST_BODY_BYTES - JSON_OVERHEAD + 1);  // 1 byte over
        const r = validateAndSerializeBody('POST', { k: filler });
        assert.strictEqual(r.error, 'body_too_large');
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

    // ── Deep integration: handler-level Idempotency-Key generation ──────────
    // R-pr370-fix-7 (BAT-664): proves the FULL contract — agent_pay
    // generates a UUID at the handler level, attaches it to the probe
    // request, and reuses the same value on settle replay. Two distinct
    // tool invocations get distinct keys. Pre-fix the suite only checked
    // settle forwarding from a hand-set key; this exercises generation.

    await check('handler: agent_pay POST attaches Idempotency-Key to probe; distinct invocations get distinct keys', async () => {
        // Swap the no-burner bridge stub for a configured-burner one,
        // and inject DNS + fetch overrides that bypass the network.
        // Returning a synthetic 200 from the probe means agent_pay
        // returns after probe without going through settle — we cover
        // settle byte-identity in the X402Protocol.settle test above.
        const oldHandler = _bridgeHandler;
        _bridgeHandler = async (endpoint) => {
            if (endpoint === '/burner/status') return { configured: true, pubkey: '7xKXTg2CW87d97TXJSDpbD5jBkheTqA83TZRuJosgAsU' };
            return {};
        };
        // Restore a passing DNS so the probe is reached (the suite-level
        // override throws to enforce zero-network on pre-flight rejections).
        agentPay._setDnsLookup(async () => ({ address: '1.2.3.4', family: 4 }));

        const probeCalls = [];
        agentPay._setFetchOverride(async (parsed, ip, fam, headers, timeout, opts) => {
            probeCalls.push({ url: parsed.toString(), headers: { ...headers }, opts: { ...opts } });
            // Return non-402 so the handler returns after probe.
            return { status: 200, headers: {}, bodyJson: { ok: true } };
        });

        try {
            const r1 = await handlers.agent_pay({
                url: 'https://api.example.com/text',
                max_usdc: '0.10',
                method: 'POST',
                body: { phone: '+15555550000', message: 'hi' },
            });
            const r2 = await handlers.agent_pay({
                url: 'https://api.example.com/text',
                max_usdc: '0.10',
                method: 'POST',
                body: { phone: '+15555550000', message: 'hi' },
            });
            assert.ok(!r1.error, `r1 should succeed (non-402 path): ${JSON.stringify(r1)}`);
            assert.ok(!r2.error, `r2 should succeed: ${JSON.stringify(r2)}`);
            assert.strictEqual(probeCalls.length, 2, 'should have probed twice');

            // (a) Each probe has an Idempotency-Key header.
            const key1 = probeCalls[0].headers['idempotency-key'];
            const key2 = probeCalls[1].headers['idempotency-key'];
            assert.ok(typeof key1 === 'string' && key1.length > 0, 'probe 1 must attach Idempotency-Key');
            assert.ok(typeof key2 === 'string' && key2.length > 0, 'probe 2 must attach Idempotency-Key');

            // (b) Distinct invocations get DISTINCT keys.
            assert.notStrictEqual(key1, key2, 'distinct agent_pay invocations must have distinct Idempotency-Keys');

            // (c) Each key is RFC 4122 UUID-shaped.
            const uuidRe = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
            assert.ok(uuidRe.test(key1));
            assert.ok(uuidRe.test(key2));

            // (d) POST method propagates to the fetch opts; same byte body.
            assert.strictEqual(probeCalls[0].opts.method, 'POST');
            assert.strictEqual(probeCalls[0].opts.bodyJsonStr, JSON.stringify({ phone: '+15555550000', message: 'hi' }));
        } finally {
            agentPay._setFetchOverride(null);
            // Re-arm the throwing DNS override so subsequent pre-flight tests
            // still enforce zero-network.
            agentPay._setDnsLookup(async () => {
                dnsLookupCalled++;
                throw new Error('dns lookup should not have been called');
            });
            _bridgeHandler = oldHandler;
        }
    });

    await check('handler: agent_pay GET does NOT attach Idempotency-Key (regression)', async () => {
        const oldHandler = _bridgeHandler;
        _bridgeHandler = async (endpoint) => {
            if (endpoint === '/burner/status') return { configured: true, pubkey: '7xKXTg2CW87d97TXJSDpbD5jBkheTqA83TZRuJosgAsU' };
            return {};
        };
        agentPay._setDnsLookup(async () => ({ address: '1.2.3.4', family: 4 }));
        const probeCalls = [];
        agentPay._setFetchOverride(async (parsed, ip, fam, headers, timeout, opts) => {
            probeCalls.push({ headers: { ...headers }, opts: { ...opts } });
            return { status: 200, headers: {}, bodyJson: { ok: true } };
        });
        try {
            await handlers.agent_pay({
                url: 'https://api.example.com/x',
                max_usdc: '0.10',
                // No method (defaults to GET), no body
            });
            assert.strictEqual(probeCalls.length, 1);
            assert.ok(!probeCalls[0].headers['idempotency-key'],
                'GET probe must NOT have Idempotency-Key header');
            assert.ok(!probeCalls[0].opts.bodyJsonStr, 'GET probe must not have a serialized body');
        } finally {
            agentPay._setFetchOverride(null);
            agentPay._setDnsLookup(async () => {
                dnsLookupCalled++;
                throw new Error('dns lookup should not have been called');
            });
            _bridgeHandler = oldHandler;
        }
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

    // ── Policy-hook body validation (R-pr370-fix-4) ─────────────────────────
    // The confirmation policy now validates the body BEFORE returning
    // `confirm`. Invalid POST bodies return `block` with a stable reason
    // so the agent doesn't ask the user to confirm a call that would
    // deterministically reject downstream.

    const { getConfirmationPolicy } = require(path.join(BUNDLE, 'confirmation', 'policy'));

    await check('policy: POST + valid body → confirm', () => {
        const r = getConfirmationPolicy('agent_pay', {
            url: 'https://api.example.com/x', max_usdc: '0.10',
            method: 'POST', body: { phone: '+15555550000', message: 'hi' },
        }, { burnerConfigured: true });
        assert.strictEqual(r.policy, 'confirm');
        assert.ok(typeof r.message === 'string' && r.message.includes('POST'));
        assert.ok(r.message.includes('https://api.example.com/x'));
        assert.ok(r.message.includes('0.10'));
    });

    await check('policy: POST confirm hook literalizes newlines in url/max_usdc too (R-pr370-fix-16)', () => {
        // Newlines in url or max_usdc would inject extra structural lines
        // into the multi-line confirmation card and could be used to
        // misrepresent what's being confirmed.
        const r = getConfirmationPolicy('agent_pay', {
            url: 'https://api.example.com/x\n[FAKE PHISH LINE]',
            max_usdc: '0.10\nIGNORE PREVIOUS LINE',
            method: 'POST', body: { ok: true },
        }, { burnerConfigured: true });
        assert.strictEqual(r.policy, 'confirm');
        const lines = r.message.split('\n');
        // EXACTLY 3 structural lines (POST line, max_usdc line, body line).
        assert.strictEqual(lines.length, 3, `expected exactly 3 structural lines, got ${lines.length}: ${JSON.stringify(lines)}`);
        // The injected newlines in url and max_usdc must appear as literal "\\n".
        assert.ok(lines[0].includes('\\n[FAKE PHISH LINE]'), 'url newline must be literalized');
        assert.ok(lines[1].includes('\\nIGNORE PREVIOUS LINE'), 'max_usdc newline must be literalized');
    });

    await check('policy: POST confirm hook literalizes body newlines (no structural breakout)', () => {
        // Body content with real \n must NOT break out into a new
        // structural line of the confirmation card. The hook is responsible
        // for collapsing body newlines to literal "\\n" — Markdown escaping
        // itself happens at the render boundary (formatConfirmationMessage).
        const r = getConfirmationPolicy('agent_pay', {
            url: 'https://api.example.com/x', max_usdc: '0.10',
            method: 'POST', body: { evil: 'line1\nline2\rline3' },
        }, { burnerConfigured: true });
        assert.strictEqual(r.policy, 'confirm');
        const bodyLine = r.message.split('\n').find(l => l.startsWith('body:')) || '';
        assert.ok(!bodyLine.includes('\n'), 'body line must be a single structural line');
        assert.ok(bodyLine.includes('\\n'), 'embedded newline must be literalized');
    });

    await check('render: formatConfirmationMessage escapes Markdown in policyMessage (R-pr370-fix-13)', () => {
        // Security: the WHOLE policyMessage gets Markdown-escaped at the
        // render boundary so EVERY policy hook is safe by default — agent_pay
        // POST, wallet_set_caps diff, any future hook. Test by routing a
        // policy hook with model-controlled content through format() and
        // asserting the rendered message has all metachars escaped.
        const { formatConfirmationMessage } = require(path.join(BUNDLE, 'tools', 'index'));
        const policy = getConfirmationPolicy('agent_pay', {
            url: 'https://api.example.com/`evil`',
            max_usdc: '0.10',
            method: 'POST',
            body: { evil: '`code` [click](http://bad) **bold** <script>alert(1)</script>' },
        }, { burnerConfigured: true });
        assert.strictEqual(policy.policy, 'confirm');
        const rendered = formatConfirmationMessage('agent_pay', {}, policy.message);
        // Every Markdown metacharacter from the input must be backslash-escaped.
        assert.ok(rendered.includes('\\`'), 'backtick must be escaped');
        assert.ok(rendered.includes('\\['), 'left bracket must be escaped');
        assert.ok(rendered.includes('\\]'), 'right bracket must be escaped');
        assert.ok(rendered.includes('\\('), 'left paren must be escaped');
        assert.ok(rendered.includes('\\)'), 'right paren must be escaped');
        assert.ok(rendered.includes('\\*'), 'asterisk must be escaped');
        assert.ok(rendered.includes('\\<'), 'less-than must be escaped');
        assert.ok(rendered.includes('\\>'), 'greater-than must be escaped');
        // Structural newlines (between POST line / max_usdc line / body line)
        // MUST be preserved so the card renders multi-line.
        const lines = rendered.split('\n');
        assert.ok(lines.length >= 3, `expected ≥3 structural lines, got ${lines.length}`);
    });

    await check('render: formatConfirmationMessage de-linkifies BARE DOMAINS (R-pr370-fix-32/34, fuzzyLink defense)', () => {
        // markdown-it linkify with fuzzyLink: true (default) auto-detects
        // patterns like "attacker.evil.com" without any scheme. We use a
        // lookbehind/lookahead regex to insert ZWSP before EVERY dot in a
        // multi-label domain (api.example.com → api[ZWSP].example[ZWSP].com).
        const { formatConfirmationMessage } = require(path.join(BUNDLE, 'tools', 'index'));
        const policy = getConfirmationPolicy('agent_pay', {
            url: 'https://api.example.com/x', max_usdc: '0.10',
            method: 'POST',
            // Body contains a bare-domain phishing target.
            body: { phish: 'visit attacker.evil.com today' },
        }, { burnerConfigured: true });
        const rendered = formatConfirmationMessage('agent_pay', {}, policy.message);
        const ZWSP = String.fromCharCode(0x200B);
        // EVERY dot in a multi-label domain gets a ZWSP. The bare-domain
        // "attacker.evil.com" → "attacker[ZWSP].evil[ZWSP].com".
        assert.ok(rendered.includes(`attacker${ZWSP}.evil${ZWSP}.com`),
            `bare domain should be fully de-linkified (got: ${JSON.stringify(rendered)})`);
        // Numeric "0.10" (USDC amount) MUST NOT be mangled — the lookbehind
        // requires alpha-led label.
        assert.ok(rendered.includes('0.10'),
            'numeric decimals like 0.10 must not have ZWSP injected');
    });

    await check('policy: body preview truncation respects post-literalize length (R-pr370-fix-33)', () => {
        // Literalizing newlines is a 2-char expansion (\\n). Truncating
        // BEFORE literalization could produce a string longer than the
        // 200-char budget after literalization. The fix truncates AFTER
        // literalize so the bound holds on the rendered content.
        const manyNewlines = 'a\n'.repeat(150);  // 300 chars, 150 newlines
        const r = getConfirmationPolicy('agent_pay', {
            url: 'https://api.example.com/x', max_usdc: '0.10',
            method: 'POST', body: manyNewlines,
        }, { burnerConfigured: true });
        // The body might block (string body must JSON.parse), so verify
        // through the policy + render with a valid body that has newlines.
        const r2 = getConfirmationPolicy('agent_pay', {
            url: 'https://api.example.com/x', max_usdc: '0.10',
            method: 'POST', body: { k: 'long\n'.repeat(100) },  // many real \n inside JSON
        }, { burnerConfigured: true });
        assert.strictEqual(r2.policy, 'confirm');
        const bodyLine = r2.message.split('\n').find(l => l.startsWith('body:')) || '';
        // The body LINE (post-literalize) is bounded at body: + 200 chars.
        // The "body: " prefix is 6 chars; the rest is the preview, max 200.
        assert.ok(bodyLine.length <= 6 + 200,
            `body line length ${bodyLine.length} exceeds 6+200 cap (truncation order bug)`);
    });

    await check('render: formatConfirmationMessage de-linkifies URLs in policyMessage (R-pr370-fix-18)', () => {
        // markdown-it linkify auto-converts raw URLs to clickable links.
        // Even after metachar escaping, a body preview with a URL would
        // render as a one-click phishing link. The render boundary
        // inserts a zero-width space between scheme and "//" to break
        // linkify detection.
        const { formatConfirmationMessage } = require(path.join(BUNDLE, 'tools', 'index'));
        const policy = getConfirmationPolicy('agent_pay', {
            url: 'https://api.example.com/x',
            max_usdc: '0.10',
            method: 'POST',
            body: { phish: 'http://attacker.evil.com/take-money' },
        }, { burnerConfigured: true });
        const rendered = formatConfirmationMessage('agent_pay', {}, policy.message);
        // R-pr370-fix-19/24/26/28: ZWSP via String.fromCharCode so the
        // literal U+200B never appears in source (matches the production
        // impl in tools/index.js).
        const ZWSP = String.fromCharCode(0x200B);
        // Raw `http://...` would be linkified. After the fix, the scheme
        // has a zero-width space inserted before //.
        assert.ok(!new RegExp(`(?<!:${ZWSP})http:\\/\\/`).test(rendered),
            `attacker URL should be de-linkified (no raw http:// substring left); rendered: ${JSON.stringify(rendered)}`);
        assert.ok(rendered.includes(`http:${ZWSP}//`),
            'URL should have zero-width-space inserted between scheme and //');
        // The agent_pay URL (also in the rendered message) gets the same
        // treatment — it's part of the policyMessage too. With the
        // bare-domain ZWSP fix, the domain part also has ZWSPs in every
        // dot, so the assertion checks both layers of defense.
        assert.ok(rendered.includes(`https:${ZWSP}//`),
            'agent_pay URL should have schemed-URL de-linkify applied');
        assert.ok(rendered.includes(`api${ZWSP}.example${ZWSP}.com`),
            'agent_pay URL domain should also have bare-domain de-linkify applied');
    });

    await check('render: formatConfirmationMessage escapes line-start list markers (R-pr370-fix-40)', () => {
        // markdown-it renders `- foo`, `+ foo`, `1. foo` at start of line
        // as list items. Body preview newlines are intentionally preserved
        // for structural lines, so a model-controlled value containing
        // `\n- malicious-item` would render as a fake bullet list.
        const { formatConfirmationMessage } = require(path.join(BUNDLE, 'tools', 'index'));
        const policyMessage = 'POST /endpoint\n- bullet item\n+ plus item\n1. numbered item\n2. another\nbody: ok';
        const rendered = formatConfirmationMessage('agent_pay', {}, policyMessage);
        // Each list marker at start of line must be backslash-escaped.
        // Note: '- ' becomes '\\- ', '1. ' becomes '1\\. '.
        assert.ok(rendered.includes('\\- bullet'),
            `dash list marker should be escaped (got: ${JSON.stringify(rendered)})`);
        assert.ok(rendered.includes('\\+ plus'),
            'plus list marker should be escaped');
        assert.ok(rendered.includes('1\\. numbered'),
            'numbered list marker should be escaped (1.)');
        assert.ok(rendered.includes('2\\. another'),
            'numbered list marker should be escaped (2.)');
    });

    await check('render: formatConfirmationMessage escapes horizontal-rule patterns (R-pr370-fix-42)', () => {
        // markdown-it renders `---` / `===` at line start as horizontal
        // rules or setext heading underlines. Escape the first char so
        // they render as literal text.
        const { formatConfirmationMessage } = require(path.join(BUNDLE, 'tools', 'index'));
        const policyMessage = 'POST /endpoint\n---\nfake heading\n===\nbody: ok';
        const rendered = formatConfirmationMessage('agent_pay', {}, policyMessage);
        // `---` becomes `\---` (first dash escaped).
        assert.ok(rendered.includes('\\---'),
            `horizontal-rule dashes should be escaped (got: ${JSON.stringify(rendered)})`);
        // `===` becomes `\===`.
        assert.ok(rendered.includes('\\==='),
            'setext H1 equals should be escaped');
    });

    await check('render: formatConfirmationMessage escapes wallet_set_caps diff content (defense-in-depth)', () => {
        // Even other policy hooks benefit from the render-boundary escape.
        // wallet_set_caps's diff message embeds raw arg values; a malicious
        // value with backticks would inject without the format-level escape.
        const { formatConfirmationMessage } = require(path.join(BUNDLE, 'tools', 'index'));
        const policy = getConfirmationPolicy('wallet_set_caps', {
            per_tx_sol: '0.05`evil`',  // crafted to look like a normal decimal
        }, {
            burnerConfigured: true,
            burnerCaps: { capPerTxSol: '50000000' },
        });
        const rendered = formatConfirmationMessage('wallet_set_caps', {}, policy.message);
        // The crafted backticks in the arg must be escaped, not rendered.
        assert.ok(rendered.includes('\\`'), 'wallet_set_caps args must be escaped at render');
    });

    await check('policy: POST + no body → block (body_required_for_post)', () => {
        const r = getConfirmationPolicy('agent_pay', {
            url: 'https://api.example.com/x', max_usdc: '0.10',
            method: 'POST', // no body
        }, { burnerConfigured: true });
        assert.strictEqual(r.policy, 'block');
        assert.strictEqual(r.reason, 'body_required_for_post');
    });

    await check('policy: POST + invalid JSON string → block (body_not_json)', () => {
        const r = getConfirmationPolicy('agent_pay', {
            url: 'https://api.example.com/x', max_usdc: '0.10',
            method: 'POST', body: 'not actually json',
        }, { burnerConfigured: true });
        assert.strictEqual(r.policy, 'block');
        assert.strictEqual(r.reason, 'body_not_json');
    });

    await check('policy: POST + primitive body → block (body_not_json — object/array required)', () => {
        const r = getConfirmationPolicy('agent_pay', {
            url: 'https://api.example.com/x', max_usdc: '0.10',
            method: 'POST', body: 42,
        }, { burnerConfigured: true });
        assert.strictEqual(r.policy, 'block');
        assert.strictEqual(r.reason, 'body_not_json');
    });

    await check('policy: POST + oversized body → block (body_too_large)', () => {
        const r = getConfirmationPolicy('agent_pay', {
            url: 'https://api.example.com/x', max_usdc: '0.10',
            method: 'POST', body: { k: 'A'.repeat(10_000) },
        }, { burnerConfigured: true });
        assert.strictEqual(r.policy, 'block');
        assert.strictEqual(r.reason, 'body_too_large');
    });

    await check('policy: POST + missing/invalid url → block (invalid_input, R-pr370-fix-39)', () => {
        // Tool inputs aren't runtime schema-validated, so a malformed call
        // could pass an empty/missing/non-string url. Block at the gate
        // so the agent doesn't prompt the user to confirm an action that
        // will deterministically fail.
        for (const url of [undefined, null, '', 42, {}, []]) {
            const r = getConfirmationPolicy('agent_pay', {
                url, max_usdc: '0.10', method: 'POST', body: { ok: true },
            }, { burnerConfigured: true });
            assert.strictEqual(r.policy, 'block', `${typeof url}: expected block, got ${JSON.stringify(r)}`);
            assert.strictEqual(r.reason, 'invalid_input');
        }
    });

    await check('policy: POST + unparseable url → block (invalid_url, R-pr370-fix-43)', () => {
        const r = getConfirmationPolicy('agent_pay', {
            url: 'not a url at all', max_usdc: '0.10',
            method: 'POST', body: { ok: true },
        }, { burnerConfigured: true });
        assert.strictEqual(r.policy, 'block');
        assert.strictEqual(r.reason, 'invalid_url');
    });

    await check('policy: POST + non-http(s) scheme → block (non_https, R-pr370-fix-43)', () => {
        for (const url of ['ftp://example.com/file', 'data:text/plain,foo', 'javascript:alert(1)']) {
            const r = getConfirmationPolicy('agent_pay', {
                url, max_usdc: '0.10', method: 'POST', body: { ok: true },
            }, { burnerConfigured: true });
            assert.strictEqual(r.policy, 'block', `${url}: expected block, got ${JSON.stringify(r)}`);
            assert.strictEqual(r.reason, 'non_https');
        }
    });

    await check('policy: POST + http://non-localhost → block (non_https, R-pr370-fix-44)', () => {
        // http:// is only allowed for localhost in debug builds; mirror
        // agent_pay's preflightUrlSync at the policy gate.
        const oldEnv = process.env.NODE_ENV;
        delete process.env.NODE_ENV;
        try {
            const r = getConfirmationPolicy('agent_pay', {
                url: 'http://attacker.com/x', max_usdc: '0.10',
                method: 'POST', body: { ok: true },
            }, { burnerConfigured: true });
            assert.strictEqual(r.policy, 'block');
            assert.strictEqual(r.reason, 'non_https');
        } finally {
            if (oldEnv) process.env.NODE_ENV = oldEnv;
        }
    });

    await check('policy: POST + http://localhost in debug → confirm (R-pr370-fix-44)', () => {
        const oldEnv = process.env.NODE_ENV;
        process.env.NODE_ENV = 'development';
        try {
            const r = getConfirmationPolicy('agent_pay', {
                url: 'http://localhost:3000/x', max_usdc: '0.10',
                method: 'POST', body: { ok: true },
            }, { burnerConfigured: true });
            assert.strictEqual(r.policy, 'confirm');
        } finally {
            if (oldEnv !== undefined) process.env.NODE_ENV = oldEnv;
            else delete process.env.NODE_ENV;
        }
    });

    await check('policy: POST + no burner → block (burner_not_configured, R-pr370-fix-20)', () => {
        // Fail-fast at gate when no burner. POST without a burner deterministically
        // rejects at the handler; the policy gate should block early instead of
        // prompting the user to confirm an action that can't succeed.
        const r = getConfirmationPolicy('agent_pay', {
            url: 'https://api.example.com/x', max_usdc: '0.10',
            method: 'POST', body: { ok: true },
        }, { burnerConfigured: false });
        assert.strictEqual(r.policy, 'block');
        assert.strictEqual(r.reason, 'burner_not_configured');
    });

    await check('policy: GET unchanged (no body validation needed)', () => {
        const r = getConfirmationPolicy('agent_pay', {
            url: 'https://api.example.com/x', max_usdc: '0.10',
        }, { burnerConfigured: true });
        assert.strictEqual(r, 'none');
    });

    await check('policy: PUT/PATCH/DELETE blocked at gate with method_not_allowed (R-pr370-fix-9)', () => {
        for (const m of ['PUT', 'PATCH', 'DELETE', 'HEAD', 'OPTIONS']) {
            const r = getConfirmationPolicy('agent_pay', {
                url: 'https://api.example.com/x', max_usdc: '0.10', method: m,
            }, { burnerConfigured: true });
            assert.strictEqual(r.policy, 'block', `${m}: expected block, got ${JSON.stringify(r)}`);
            assert.strictEqual(r.reason, 'method_not_allowed');
        }
    });

    await check('policy: non-string method blocked with method_not_allowed', () => {
        for (const m of [42, true, {}, []]) {
            const r = getConfirmationPolicy('agent_pay', {
                url: 'https://api.example.com/x', max_usdc: '0.10', method: m,
            }, { burnerConfigured: true });
            assert.strictEqual(r.policy, 'block', `${typeof m}: expected block, got ${JSON.stringify(r)}`);
            assert.strictEqual(r.reason, 'method_not_allowed');
        }
    });

    // Cross-check: policy duplicates the body rules from agent_pay's
    // validateAndSerializeBody. Same inputs must produce same outcomes so
    // a future refactor that moves the validation can't drift.
    await check('policy + agent_pay body rules stay in lock-step (R-pr370-fix-4 cross-check)', () => {
        const cases = [
            [undefined,                     'body_required_for_post'],
            [null,                          'body_required_for_post'],
            ['not-json',                    'body_not_json'],
            [42,                            'body_not_json'],
            [true,                          'body_not_json'],
            ['"a-json-string"',             'body_not_json'],
            [{ a: 1 },                      'ok'],
            [['a', 'b'],                    'ok'],
            [{ k: 'X'.repeat(10_000) },     'body_too_large'],
        ];
        for (const [body, expectedError] of cases) {
            const fromValidator = validateAndSerializeBody('POST', body);
            const validatorErr = fromValidator.error || 'ok';
            const fromPolicy = getConfirmationPolicy('agent_pay', {
                url: 'https://example.com', max_usdc: '0.10', method: 'POST', body,
            }, { burnerConfigured: true });
            const policyErr = (fromPolicy && fromPolicy.policy === 'block') ? fromPolicy.reason : 'ok';
            assert.strictEqual(validatorErr, expectedError,
                `validator: body=${JSON.stringify(body)} expected ${expectedError}, got ${validatorErr}`);
            assert.strictEqual(policyErr, expectedError,
                `policy: body=${JSON.stringify(body)} expected ${expectedError}, got ${policyErr}`);
        }
    });

    if (failures === 0) {
        console.log('\n✓ All agent-pay-post.test.js cases passed');
        process.exit(0);
    } else {
        console.error(`\n✗ ${failures} case(s) failed`);
        process.exit(1);
    }
})();
