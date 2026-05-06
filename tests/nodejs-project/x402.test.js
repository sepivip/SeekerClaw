#!/usr/bin/env node
// x402.test.js — BAT-582 Phase 6.
//
// Tests the x402 protocol implementation + the agent_pay tool's boundary
// rejections. Uses the committed pay.sh fixtures
// (tests/payment/fixtures/paysh-sandbox-{402,success}.json) as ground truth
// for the wire format. A local mock fetch helper replays the fixture so
// tests run offline.

'use strict';

const assert = require('assert');
const path = require('path');

const BUNDLE = path.resolve(__dirname, '..', '..', 'app', 'src', 'main', 'assets', 'nodejs-project');
const FIXTURES = path.resolve(__dirname, '..', 'payment');

// ── Mock config.js + bridge.js + solana.js ──────────────────────────────────
const configPath = require.resolve(path.join(BUNDLE, 'config.js'));
require.cache[configPath] = {
    id: configPath, filename: configPath, loaded: true,
    exports: { BRIDGE_TOKEN: 't', log: () => {} },
};

// Stub solana.js so payment/x402.js's lazy require for blockhash and
// wallet/main-wallet.js's lazy require don't hit real config.
const solanaPath = require.resolve(path.join(BUNDLE, 'solana.js'));
require.cache[solanaPath] = {
    id: solanaPath, filename: solanaPath, loaded: true,
    exports: {
        getConnectedWalletAddress: () => { throw new Error('not connected'); },
        solanaRpc: async (method) => {
            if (method === 'getLatestBlockhash') {
                return { result: { value: { blockhash: 'EkSnNWid2cvwEVnVx9aBqawnmiCNiDgp3gUdkDPTKN1N' } } };
            }
            return { error: 'unmocked' };
        },
    },
};

// Programmable bridge — captures every call. Tests overwrite the response
// object via _setBridgeResponse(endpoint, response).
const bridgeCalls = [];
const bridgeResponses = new Map();
function _setBridgeResponse(endpoint, response) { bridgeResponses.set(endpoint, response); }
const bridgePath = require.resolve(path.join(BUNDLE, 'bridge.js'));
require.cache[bridgePath] = {
    id: bridgePath, filename: bridgePath, loaded: true,
    exports: {
        androidBridgeCall: async (endpoint, body) => {
            bridgeCalls.push({ endpoint, body });
            return bridgeResponses.get(endpoint) || {};
        },
    },
};

// Default bridge state — burner configured, mid-range caps, zero spent.
const VALID_BURNER_PUBKEY = '8gJVFhrLEukGMVUwH1bmXtYXyXAkPtBFmhLKeKBDmKhE';
function _resetBridgeDefaults() {
    bridgeCalls.length = 0;
    bridgeResponses.clear();
    _setBridgeResponse('/burner/status', {
        configured: true,
        pubkey: VALID_BURNER_PUBKEY,
        balanceSol: '100000000', balanceUsdc: '50000000',
        capPerTxSol: '50000000', capDailySol: '100000000',
        capPerTxUsdc: '5000000', capDailyUsdc: '20000000',  // 5 USDC per-tx, 20 USDC daily
        spentTodaySol: '0', spentTodayUsdc: '0',
        network: 'mainnet',
    });
    _setBridgeResponse('/burner/reserve', { reservationId: 'res-fixture-1' });
    _setBridgeResponse('/burner/sign-transaction', { signedTxBase64: 'SIGNED-TX-FIXTURE-BASE64' });
    _setBridgeResponse('/burner/commit', { ok: true });
    _setBridgeResponse('/burner/release', { ok: true });
}

// ── Load modules ────────────────────────────────────────────────────────────

const { loadFixture } = require(path.join(FIXTURES, 'fixture-loader'));
const x402Mod = require(path.join(BUNDLE, 'payment', 'x402'));
const { X402Protocol } = x402Mod;
const paymentRegistry = require(path.join(BUNDLE, 'payment'));
const agentPay = require(path.join(BUNDLE, 'tools', 'agent_pay'));

// ── Programmable fetch mock — replays fixtures by URL ────────────────────────
// We override agent_pay's _fetchWithLimits via a closure swap. Since
// agent_pay exports the function, we monkey-patch the export.

const fetchLog = [];
let fetchPlan = []; // queue of { match: ({parsed, headers}) => bool, response }

function _resetFetchPlan() {
    fetchLog.length = 0;
    fetchPlan = [];
}

function _addFetchExpectation(match, response) {
    fetchPlan.push({ match, response });
}

async function _mockFetch(parsed, pinnedIp, pinnedFamily, headers, timeoutMs) {
    const call = { url: parsed.toString(), pinnedIp, pinnedFamily, headers, timeoutMs };
    fetchLog.push(call);
    for (let i = 0; i < fetchPlan.length; i++) {
        if (fetchPlan[i].match(call)) {
            const resp = fetchPlan[i].response;
            // One-shot: remove after matching so the same expectation doesn't
            // fire twice unless explicitly re-added.
            fetchPlan.splice(i, 1);
            return typeof resp === 'function' ? resp(call) : resp;
        }
    }
    return { error: 'unexpected_fetch', reason: `no expectation matched ${call.url}` };
}

// Replace the exported _fetchWithLimits with our mock. The agent_pay handler
// captures `_fetchWithLimits` via the module-level closure, but it ALSO passes
// a reference into protocol.settle via { _fetchWithLimits }. We patch the
// module export so the settle path picks up our mock.
agentPay._fetchWithLimits = _mockFetch;

// To override the closure-captured _fetchWithLimits inside agent_pay's _handle,
// we need a different approach: patch via require() reference. The simplest
// approach: pass through the module object since handlers reference the
// EXPORTED function. But agent_pay.js currently calls `_fetchWithLimits`
// directly (closure), not via module.exports. So we have to monkey-patch
// at the source. Workaround: use a thin shim — agent_pay's settle() calls
// `helpers._fetchWithLimits` from the agent_pay module; the initial 402 fetch
// uses the closure variable. To control BOTH, we replace the module's
// _fetchWithLimits export AND we ensure the test never calls the real handler
// directly when we need fetch control — instead we exercise the protocol's
// detect/build/settle methods directly with our mock as `helpers`.

// Hijack the DNS lookup so private-IP / rebinding defenses can be tested
// without hitting real DNS.
let dnsTable = new Map();
function _setDns(host, address, family = 4) { dnsTable.set(host, { address, family }); }
agentPay._setDnsLookup(async (hostname) => {
    if (dnsTable.has(hostname)) return dnsTable.get(hostname);
    throw new Error(`unmocked DNS lookup for ${hostname}`);
});

// ── Test runner ──────────────────────────────────────────────────────────────

let failures = 0;
async function check(label, fn) {
    try { await fn(); console.log(`  ✓ ${label}`); }
    catch (e) { failures++; console.error(`  ✗ ${label}\n    ${e.stack || e.message}`); }
}

// JSON.stringify replacer that turns BigInt into a string so error messages
// don't crash on `${JSON.stringify(result)}` when result has BigInt fields.
function _safeStringify(v) {
    return JSON.stringify(v, (_k, val) => typeof val === 'bigint' ? val.toString() + 'n' : val);
}

(async () => {
    // ── Fixture sanity ───────────────────────────────────────────────────────
    await check('fixture loader: paysh-sandbox-402 has 402 status + accepts array', () => {
        const { wire } = loadFixture('paysh-sandbox-402');
        assert.strictEqual(wire.status, 402);
        assert.ok(Array.isArray(wire.body.accepts), 'body.accepts must be an array');
        assert.strictEqual(wire.body.accepts[0].network, 'solana');
        assert.strictEqual(wire.body.accepts[0].asset, x402Mod.USDC_MINT);
    });

    await check('fixture loader: paysh-sandbox-success has 200 + x-payment-response header', () => {
        const { wire } = loadFixture('paysh-sandbox-success');
        assert.strictEqual(wire.status, 200);
        assert.ok(wire.headers['x-payment-response'], 'success fixture must carry x-payment-response header');
    });

    // ── X402Protocol.detect ──────────────────────────────────────────────────
    const proto = new X402Protocol();
    await check('detect: 402 with valid pay.sh body → true', () => {
        const { wire } = loadFixture('paysh-sandbox-402');
        const r = proto.detect({ status: wire.status, headers: wire.headers, bodyJson: wire.body });
        assert.strictEqual(r, true);
    });

    await check('detect: non-402 → false', () => {
        assert.strictEqual(proto.detect({ status: 200, bodyJson: {} }), false);
        assert.strictEqual(proto.detect({ status: 500, bodyJson: {} }), false);
    });

    await check('detect: 402 without accepts/paymentRequirements → false', () => {
        assert.strictEqual(proto.detect({ status: 402, bodyJson: { error: 'no payment' } }), false);
    });

    await check('detect: 402 with non-Solana network → false', () => {
        assert.strictEqual(
            proto.detect({ status: 402, bodyJson: { accepts: [{ scheme: 'exact', network: 'ethereum' }] } }),
            false
        );
    });

    // ── X402Protocol.build — happy path ──────────────────────────────────────
    await check('build: happy path produces txBase64 + paymentMeta', async () => {
        const { wire } = loadFixture('paysh-sandbox-402');
        const r = await proto.build(
            { status: 402, bodyJson: wire.body },
            {
                maxUsdcAtomic: 200000n,                  // 0.20 USDC cap
                signerWallet: null,
                burnerPubkey: VALID_BURNER_PUBKEY,
            }
        );
        assert.ok(!r.error, `build should not error: ${_safeStringify(r)}`);
        assert.ok(typeof r.txBase64 === 'string' && r.txBase64.length > 0, 'txBase64 must be non-empty string');
        assert.ok(r.paymentMeta, 'paymentMeta must be present');
        assert.strictEqual(typeof r.paymentMeta.amountAtomic, 'bigint');
        assert.strictEqual(r.paymentMeta.amountAtomic, 100000n, 'demand from fixture is 100000 microUSDC');
        assert.strictEqual(r.paymentMeta.recipient, '5Q544fKrFoe6tsEbD7S8EmxGTJYAKtTVhAW5Q5pge4j1');
        assert.strictEqual(r.paymentMeta.network, 'solana');
        assert.strictEqual(r.paymentMeta.scheme, 'exact');
    });

    // ── X402Protocol.build — boundary rejections ─────────────────────────────
    await check('build: demand > max_usdc → demand_exceeds_max_usdc', async () => {
        const { wire } = loadFixture('paysh-sandbox-402');
        const r = await proto.build(
            { status: 402, bodyJson: wire.body },
            { maxUsdcAtomic: 50000n, burnerPubkey: VALID_BURNER_PUBKEY }  // 0.05 < 0.10 demand
        );
        assert.strictEqual(r.error, 'demand_exceeds_max_usdc');
    });

    await check('build: non-Solana network → non_solana_network', async () => {
        const r = await proto.build(
            {
                status: 402,
                bodyJson: {
                    x402Version: 1,
                    accepts: [{
                        scheme: 'exact',
                        network: 'ethereum',
                        maxAmountRequired: '100000',
                        payTo: '0xabc',
                        asset: 'USDC',
                    }],
                },
            },
            { maxUsdcAtomic: 200000n, burnerPubkey: VALID_BURNER_PUBKEY }
        );
        // Either no_acceptable_requirement (filtered out) or non_solana_network
        // (if we squeeze through filter). Both are correct refusals.
        assert.ok(
            r.error === 'no_acceptable_requirement' || r.error === 'non_solana_network',
            `expected refusal, got ${r.error}`
        );
    });

    await check('build: non-USDC asset → non_usdc_asset', async () => {
        const r = await proto.build(
            {
                status: 402,
                bodyJson: {
                    x402Version: 1,
                    accepts: [{
                        scheme: 'exact',
                        network: 'solana',
                        maxAmountRequired: '100000',
                        payTo: VALID_BURNER_PUBKEY,
                        asset: 'So11111111111111111111111111111111111111112',  // SOL
                    }],
                },
            },
            { maxUsdcAtomic: 200000n, burnerPubkey: VALID_BURNER_PUBKEY }
        );
        assert.strictEqual(r.error, 'non_usdc_asset');
    });

    await check('build: invalid recipient (not base58 / wrong length) → invalid_recipient', async () => {
        const r = await proto.build(
            {
                status: 402,
                bodyJson: {
                    x402Version: 1,
                    accepts: [{
                        scheme: 'exact',
                        network: 'solana',
                        maxAmountRequired: '100000',
                        payTo: 'NOT_A_VALID_BASE58_KEY!!!!',
                        asset: x402Mod.USDC_MINT,
                    }],
                },
            },
            { maxUsdcAtomic: 200000n, burnerPubkey: VALID_BURNER_PUBKEY }
        );
        assert.strictEqual(r.error, 'invalid_recipient');
    });

    await check('build: zero / negative demand rejected', async () => {
        const r = await proto.build(
            {
                status: 402,
                bodyJson: {
                    x402Version: 1,
                    accepts: [{
                        scheme: 'exact',
                        network: 'solana',
                        maxAmountRequired: '0',
                        payTo: VALID_BURNER_PUBKEY,
                        asset: x402Mod.USDC_MINT,
                    }],
                },
            },
            { maxUsdcAtomic: 200000n, burnerPubkey: VALID_BURNER_PUBKEY }
        );
        assert.strictEqual(r.error, 'invalid_demand');
    });

    // ── X402Protocol.settle — fixture replay ─────────────────────────────────
    await check('settle: replays GET with X-PAYMENT header + surfaces signature', async () => {
        const { wire: succ } = loadFixture('paysh-sandbox-success');
        let capturedHeaders = null;
        const fetchFn = async (parsed, ip, fam, headers /* , timeoutMs */) => {
            capturedHeaders = headers;
            return {
                status: succ.status,
                headers: succ.headers,
                bodyJson: succ.body,
                bodyBuffer: Buffer.from(JSON.stringify(succ.body), 'utf8'),
            };
        };
        const parsed = new URL('https://pay.sh/sandbox/echo');
        const out = await proto.settle(
            { parsed, pinnedIp: '1.2.3.4', pinnedFamily: 4, timeoutLeftMs: 30000 },
            'SIGNED-TX-FIXTURE',
            { amountAtomic: 100000n, recipient: VALID_BURNER_PUBKEY, network: 'solana', asset: x402Mod.USDC_MINT },
            { _fetchWithLimits: fetchFn }
        );
        assert.ok(!out.error, `settle should succeed: ${JSON.stringify(out)}`);
        // X-PAYMENT header must be base64-encoded JSON with x402Version, scheme, network, payload.transaction.
        assert.ok(capturedHeaders['x-payment'], 'X-PAYMENT header must be set on retry');
        const decoded = JSON.parse(Buffer.from(capturedHeaders['x-payment'], 'base64').toString('utf8'));
        assert.strictEqual(decoded.x402Version, 1);
        assert.strictEqual(decoded.scheme, 'exact');
        assert.strictEqual(decoded.network, 'solana');
        assert.strictEqual(decoded.payload.transaction, 'SIGNED-TX-FIXTURE');
        // The success fixture's x-payment-response header decodes to a transaction signature.
        assert.ok(typeof out.signature === 'string' && out.signature.length > 0,
            `expected signature surfaced from x-payment-response, got: ${out.signature}`);
    });

    // ── agent_pay handler — pre-flight rejections (need DNS mock) ────────────
    const handle = agentPay.handlers.agent_pay;

    await check('handler: http://example.com → non_https (no fetch, no bridge)', async () => {
        _resetBridgeDefaults();
        _resetFetchPlan();
        const r = await handle({ url: 'http://example.com/api', max_usdc: '0.10' });
        assert.strictEqual(r.error, 'non_https');
        assert.strictEqual(bridgeCalls.length, 0, 'no bridge call on cheap pre-flight reject');
        assert.strictEqual(fetchLog.length, 0, 'no fetch on cheap pre-flight reject');
    });

    await check('handler: private IP (10.x) → private_ip', async () => {
        _resetBridgeDefaults();
        _resetFetchPlan();
        _setDns('private.example.com', '10.1.2.3', 4);
        const r = await handle({ url: 'https://private.example.com/data', max_usdc: '0.10' });
        assert.strictEqual(r.error, 'private_ip');
        // /burner/status was called (burner check happens BEFORE DNS), but no fetch.
        assert.ok(bridgeCalls.find(c => c.endpoint === '/burner/status'), 'should call /burner/status');
        assert.strictEqual(fetchLog.length, 0);
    });

    await check('handler: private IP (192.168.x) → private_ip', async () => {
        _resetBridgeDefaults();
        _resetFetchPlan();
        _setDns('lan.example.com', '192.168.1.10', 4);
        const r = await handle({ url: 'https://lan.example.com/data', max_usdc: '0.10' });
        assert.strictEqual(r.error, 'private_ip');
    });

    await check('handler: localhost IPv4 (loopback) → private_ip when not in debug', async () => {
        _resetBridgeDefaults();
        _resetFetchPlan();
        _setDns('rebind.example.com', '127.0.0.1', 4);
        const r = await handle({ url: 'https://rebind.example.com/data', max_usdc: '0.10' });
        assert.strictEqual(r.error, 'private_ip',
            'DNS rebinding via 127.0.0.1 must be rejected by the IP check');
    });

    await check('handler: link-local (169.254.x) → private_ip', async () => {
        _resetBridgeDefaults();
        _resetFetchPlan();
        _setDns('linklocal.example.com', '169.254.169.254', 4);
        const r = await handle({ url: 'https://linklocal.example.com/data', max_usdc: '0.10' });
        // 169.254.169.254 is the canonical AWS metadata endpoint — must reject.
        assert.strictEqual(r.error, 'private_ip',
            'AWS metadata-style link-local IP must be rejected');
    });

    // ── Boundary rejection: response_too_large + timeout via fetch mock ─────
    // These tests target the protocol/handler pair using a controlled mock.
    // Since agent_pay's _handle calls `_fetchWithLimits` via closure (not via
    // the module export), we exercise the timeout/size-cap behavior at the
    // fetch level by substituting agent_pay's exported function — which is
    // also what protocol.settle uses via the `helpers` argument.

    await check('handler: response_too_large surfaces from fetch helper', async () => {
        // Drive the protocol.settle path with a fake fetch returning response_too_large.
        const fetchFn = async () => ({ error: 'response_too_large', reason: 'fixture' });
        const out = await proto.settle(
            { parsed: new URL('https://pay.sh/x'), pinnedIp: '1.2.3.4', pinnedFamily: 4, timeoutLeftMs: 1000 },
            'SIGNED', { amountAtomic: 100000n, recipient: VALID_BURNER_PUBKEY },
            { _fetchWithLimits: fetchFn }
        );
        assert.strictEqual(out.error, 'response_too_large');
    });

    await check('handler: timeout surfaces from fetch helper', async () => {
        const fetchFn = async () => ({ error: 'timeout', reason: 'fixture' });
        const out = await proto.settle(
            { parsed: new URL('https://pay.sh/x'), pinnedIp: '1.2.3.4', pinnedFamily: 4, timeoutLeftMs: 1000 },
            'SIGNED', { amountAtomic: 100000n, recipient: VALID_BURNER_PUBKEY },
            { _fetchWithLimits: fetchFn }
        );
        assert.strictEqual(out.error, 'timeout');
    });

    // ── Protocol registry — fixture protocol plug-in ─────────────────────────
    await check('registry: detectProtocol routes 402 fixture to X402Protocol', () => {
        paymentRegistry._resetForTests();
        const { wire } = loadFixture('paysh-sandbox-402');
        const found = paymentRegistry.detectProtocol({ status: 402, bodyJson: wire.body, headers: wire.headers });
        assert.ok(found, 'should resolve a protocol');
        assert.strictEqual(found.name, 'x402');
    });

    await check('registry: 200 response → no protocol', () => {
        paymentRegistry._resetForTests();
        const found = paymentRegistry.detectProtocol({ status: 200, bodyJson: {} });
        assert.strictEqual(found, null);
    });

    // ── isPrivateIp — direct unit tests ──────────────────────────────────────
    await check('isPrivateIp: covers all required ranges', () => {
        const f = agentPay._isPrivateIp;
        assert.strictEqual(f('10.0.0.1'), true);
        assert.strictEqual(f('10.255.255.255'), true);
        assert.strictEqual(f('172.16.0.1'), true);
        assert.strictEqual(f('172.31.255.255'), true);
        assert.strictEqual(f('172.32.0.1'), false, '172.32 is OUTSIDE 172.16/12');
        assert.strictEqual(f('172.15.0.1'), false, '172.15 is OUTSIDE 172.16/12');
        assert.strictEqual(f('192.168.0.1'), true);
        assert.strictEqual(f('192.169.0.1'), false);
        assert.strictEqual(f('127.0.0.1'), true);
        assert.strictEqual(f('169.254.169.254'), true);
        assert.strictEqual(f('::1'), true);
        assert.strictEqual(f('fe80::1'), true);
        assert.strictEqual(f('fc00::1'), true);
        assert.strictEqual(f('fd00::1'), true);
        assert.strictEqual(f('::ffff:192.168.1.1'), true, 'IPv4-mapped private IP');
        // Public IPs
        assert.strictEqual(f('8.8.8.8'), false);
        assert.strictEqual(f('1.1.1.1'), false);
        assert.strictEqual(f('2606:4700:4700::1111'), false, 'Cloudflare DNS public IPv6');
    });

    // ── DNS rebinding defense — pinned IP per request ────────────────────────
    await check('DNS rebinding: hostname resolves to public IP first, then attacker swaps to private', async () => {
        // The contract is: resolve once, pin IP. If the attacker controls DNS
        // and swaps the answer between the resolve and the connect, the pinned
        // IP must still be used. We verify this by asserting `preflightDns`
        // returns the SAME ip on a single call AND that subsequent calls see
        // the new (malicious) value (proving each request resolves once, no
        // stale cache spans calls).
        let lookupCount = 0;
        const oldOverride = agentPay._setDnsLookup;
        const ips = ['8.8.8.8', '10.0.0.1']; // first call returns public, second returns private
        agentPay._setDnsLookup(async () => {
            const ip = ips[lookupCount] || '10.0.0.1';
            lookupCount++;
            return { address: ip, family: 4 };
        });

        const sync = agentPay.preflightUrlSync('https://attacker.example/data', 'GET');
        const dns1 = await agentPay.preflightDns(sync.parsed, sync.isLocal);
        assert.strictEqual(dns1.pinnedIp, '8.8.8.8', 'first resolve returns 8.8.8.8 (pinned for this request)');
        assert.strictEqual(lookupCount, 1, 'first call did exactly one DNS lookup');

        // Second request — DNS has been swapped to private. The check on the
        // second resolve catches it. (If the implementation cached the first
        // answer across calls, this would fail to catch the rebinding.)
        const dns2 = await agentPay.preflightDns(sync.parsed, sync.isLocal);
        assert.strictEqual(dns2.error, 'private_ip', 'second resolve catches private IP swap');
    });

    if (failures === 0) {
        console.log(`\n✓ All x402.test.js cases passed`);
        process.exit(0);
    } else {
        console.error(`\n✗ ${failures} case(s) failed`);
        process.exit(1);
    }
})();
