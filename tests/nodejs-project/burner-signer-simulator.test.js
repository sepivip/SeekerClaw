#!/usr/bin/env node
// burner-signer-simulator.test.js — BAT-1013 v8.4 (post-amendment) follow-up.
//
// Covers the default simulator factory inside `wallet/burner-signer.js`
// (`_lazyDefaultSimulator()`) along the four failure modes that previously
// shipped without test coverage:
//
//   - C8: `_burnerPubkeyCache` mid-process invalidation when /burner/status
//         starts reporting a different burner pubkey.
//   - C9: partial-null GMA response — pre-snapshot length / shape mismatch
//         is thrown at the simulator boundary so the policy can wrap it as
//         `simulation_metadata_missing` instead of proceeding on bogus
//         pre-state.
//   - C12: same-RPC URL drift — `getSolanaRpcUrl()` returns different
//          URLs across the two reads (e.g. user toggled Helius mid-call).
//   - Q4: same-URL slot drift — load-balanced public RPC serves
//         `getMultipleAccounts` from slot N and `simulateTransaction` from
//         slot N − K where K > 8.
//   - Q6: `_getSolanaRpcUrl()` THROWS instead of returning a string — drift
//         check degrades but is now logged, not silent.
//
// All tests mock `../solana` and `../bridge` via require.cache so the
// burner-signer module talks to deterministic stubs.

'use strict';

const assert = require('assert');
const path = require('path');

const BUNDLE = path.resolve(__dirname, '..', '..', 'app', 'src', 'main', 'assets', 'nodejs-project');

// ── Mock config.js BEFORE bridge.js / burner-signer.js load ────────────────
const capturedLogs = [];
const configPath = require.resolve(path.join(BUNDLE, 'config.js'));
require.cache[configPath] = {
    id: configPath,
    filename: configPath,
    loaded: true,
    exports: {
        BRIDGE_TOKEN: 't',
        log: (msg, level) => capturedLogs.push({ level: level || 'INFO', msg: String(msg) }),
    },
};

// ── Mock bridge.js — programmable /burner/status response ─────────────────
let bridgeResponse = { configured: true, pubkey: 'BURNER111111111111111111111111111111111111' };
const bridgeCalls = [];
const bridgePath = require.resolve(path.join(BUNDLE, 'bridge.js'));
require.cache[bridgePath] = {
    id: bridgePath,
    filename: bridgePath,
    loaded: true,
    exports: {
        androidBridgeCall: async (endpoint, body, timeoutMs) => {
            bridgeCalls.push({ endpoint, body, timeoutMs });
            if (endpoint === '/burner/status') {
                if (bridgeResponse && bridgeResponse.__throw) {
                    throw new Error(bridgeResponse.__throw);
                }
                return bridgeResponse;
            }
            return { ok: true };
        },
    },
};

// ── Mock ../solana via require.cache BEFORE burner-signer loads ──────────
const stub = {
    // call sequence:
    //   solanaRpc('getMultipleAccounts', [addrs, opts])  → gmaResponse()
    //   solanaRpc('simulateTransaction', [tx, opts])     → simResponse()
    nextGma: () => ({
        value: [],
        context: { slot: 100 },
    }),
    nextSim: () => ({
        value: { err: null, logs: [], accounts: [], loadedAddresses: { writable: [], readonly: [] } },
        context: { slot: 100 },
    }),
    urlAtPre: 'https://api.mainnet-beta.solana.com',
    urlAtPost: 'https://api.mainnet-beta.solana.com',
    urlThrowsPre: false,
    urlThrowsPost: false,
    // R-next-12: per-call capture of rpcUrlOverride for URL-pinning contract test.
    urlOverrides: [],
    urlCallCount: 0,
};

const solanaPath = require.resolve(path.join(BUNDLE, 'solana.js'));
require.cache[solanaPath] = {
    id: solanaPath,
    filename: solanaPath,
    loaded: true,
    exports: {
        solanaRpc: async (method, params, rpcUrlOverride) => {
            // R-next-12: capture the third arg so the URL-pinning contract
            // can be machine-verified. Each call gets pushed; tests can
            // inspect stub.urlOverrides to assert both GMA + sim received
            // the same pinned URL.
            stub.urlOverrides.push({ method, rpcUrlOverride: rpcUrlOverride ?? null });
            if (method === 'getMultipleAccounts') return stub.nextGma(params);
            if (method === 'simulateTransaction') return stub.nextSim(params);
            return { error: 'unhandled method ' + method };
        },
        getSolanaRpcUrl: () => {
            stub.urlCallCount += 1;
            // First call = pre (before GMA). Second call = post (after sim).
            if (stub.urlCallCount === 1) {
                if (stub.urlThrowsPre) throw new Error('boom-pre');
                return stub.urlAtPre;
            }
            if (stub.urlThrowsPost) throw new Error('boom-post');
            return stub.urlAtPost;
        },
    },
};

// ── Load the module under test ─────────────────────────────────────────────
const burnerSigner = require(path.join(BUNDLE, 'wallet', 'burner-signer'));
const { _lazyDefaultSimulator, _getBurnerPubkey, _resetBurnerPubkeyCache, _resetPublicShaper } = burnerSigner;

let failures = 0;
async function check(label, fn) {
    // Reset all module-singleton state so window/cache from one test does
    // not bleed into the next.
    _resetPublicShaper();
    capturedLogs.length = 0;
    bridgeCalls.length = 0;
    stub.urlCallCount = 0;
    stub.urlAtPre = 'https://api.mainnet-beta.solana.com';
    stub.urlAtPost = 'https://api.mainnet-beta.solana.com';
    stub.urlThrowsPre = false;
    stub.urlThrowsPost = false;
    stub.urlOverrides = [];
    stub.nextGma = () => ({ value: [], context: { slot: 100 } });
    stub.nextSim = () => ({ value: { err: null, logs: [], accounts: [], loadedAddresses: { writable: [], readonly: [] } }, context: { slot: 100 } });
    try { await fn(); console.log(`  ✓ ${label}`); }
    catch (e) { failures++; console.error(`  ✗ ${label}\n    ${e.stack || e.message}`); }
}

const ADDR_A = 'AaAa1111111111111111111111111111111111111111';
const ADDR_B = 'BbBb1111111111111111111111111111111111111111';

(async () => {
    console.log('burner-signer-simulator.test.js');
    console.log();

    // ── C12: URL-drift detection ─────────────────────────────────────────
    console.log('C12 url-drift');

    await check('helius → public URL flip between GMA and sim → rpc_url_drift throw', async () => {
        stub.urlAtPre = 'https://mainnet.helius-rpc.com/?api-key=abc';
        stub.urlAtPost = 'https://api.mainnet-beta.solana.com';
        stub.nextGma = () => ({ value: [null, null], context: { slot: 100 } });
        const sim = _lazyDefaultSimulator();
        let threw = null;
        try { await sim('TX', { addresses: [ADDR_A, ADDR_B] }); }
        catch (e) { threw = e; }
        assert.ok(threw, 'expected throw on URL flip');
        assert.match(threw.message, /rpc_url_drift/, `got: ${threw && threw.message}`);
    });

    await check('public → helius URL flip → rpc_url_drift throw', async () => {
        stub.urlAtPre = 'https://api.mainnet-beta.solana.com';
        stub.urlAtPost = 'https://mainnet.helius-rpc.com/?api-key=abc';
        stub.nextGma = () => ({ value: [null], context: { slot: 100 } });
        const sim = _lazyDefaultSimulator();
        let threw = null;
        try { await sim('TX', { addresses: [ADDR_A] }); }
        catch (e) { threw = e; }
        assert.ok(threw, 'expected throw on URL flip');
        assert.match(threw.message, /rpc_url_drift/);
    });

    await check('same URL across reads → no drift throw', async () => {
        stub.urlAtPre = 'https://api.mainnet-beta.solana.com';
        stub.urlAtPost = 'https://api.mainnet-beta.solana.com';
        stub.nextGma = () => ({ value: [null], context: { slot: 100 } });
        const sim = _lazyDefaultSimulator();
        const r = await sim('TX', { addresses: [ADDR_A] });
        assert.strictEqual(r.simulatorBacking, 'public');
        assert.deepStrictEqual(r.preSnapshot, [null]);
    });

    await check('R-next-12: urlAtStart pinned as rpcUrlOverride on BOTH RPC calls', async () => {
        // Contract test: both getMultipleAccounts and simulateTransaction
        // must receive the SAME urlAtStart sample (captured at line 122 in
        // burner-signer.js) as their third arg, so a config flip mid-
        // validation cannot send the two calls to different backings.
        // Without pinning, both internal solanaRpc calls would re-read live
        // config and could land on different URLs without detection.
        const PINNED = 'https://mainnet.helius-rpc.com/?api-key=PINNED-TEST-KEY';
        stub.urlAtPre = PINNED;
        stub.urlAtPost = PINNED;
        stub.nextGma = () => ({ value: [null], context: { slot: 100 } });
        const sim = _lazyDefaultSimulator();
        await sim('TX', { addresses: [ADDR_A] });
        const gmaCall = stub.urlOverrides.find(c => c.method === 'getMultipleAccounts');
        const simCall = stub.urlOverrides.find(c => c.method === 'simulateTransaction');
        assert.ok(gmaCall, 'expected getMultipleAccounts call captured');
        assert.ok(simCall, 'expected simulateTransaction call captured');
        assert.strictEqual(gmaCall.rpcUrlOverride, PINNED,
            `getMultipleAccounts must receive urlAtStart as override, got ${JSON.stringify(gmaCall)}`);
        assert.strictEqual(simCall.rpcUrlOverride, PINNED,
            `simulateTransaction must receive urlAtStart as override, got ${JSON.stringify(simCall)}`);
    });

    await check('R-next-12: when _getSolanaRpcUrl throws PRE, both RPCs receive null override (degraded path)', async () => {
        // When urlAtStart capture fails, the pinning degrades to null. Both
        // RPCs then re-read live config independently (restoring the original
        // race window, but this is the explicit fallback the WARN log calls
        // out). This test pins that degraded behavior.
        stub.urlThrowsPre = true;
        stub.nextGma = () => ({ value: [null], context: { slot: 100 } });
        const sim = _lazyDefaultSimulator();
        await sim('TX', { addresses: [ADDR_A] });
        const gmaCall = stub.urlOverrides.find(c => c.method === 'getMultipleAccounts');
        const simCall = stub.urlOverrides.find(c => c.method === 'simulateTransaction');
        assert.strictEqual(gmaCall.rpcUrlOverride, null, 'GMA receives null override on degraded path');
        assert.strictEqual(simCall.rpcUrlOverride, null, 'sim receives null override on degraded path');
        const warnLogs = capturedLogs.filter(l => l.level === 'WARN' && /BOTH drift check AND URL pinning degraded/i.test(l.msg));
        assert.ok(warnLogs.length >= 1, 'expected the extended WARN message that calls out degraded pinning');
    });

    await check('Q6: _getSolanaRpcUrl throws on PRE-read → drift check degraded, log emitted, no throw', async () => {
        stub.urlThrowsPre = true;
        stub.nextGma = () => ({ value: [null], context: { slot: 100 } });
        const sim = _lazyDefaultSimulator();
        const r = await sim('TX', { addresses: [ADDR_A] });
        assert.strictEqual(r.simulatorBacking, 'public', 'fallback to public backing when URL accessor throws');
        const warnLogs = capturedLogs.filter(l => l.level === 'WARN' && /_getSolanaRpcUrl threw/i.test(l.msg));
        assert.ok(warnLogs.length >= 1, `expected ≥1 WARN log on pre-throw, got: ${JSON.stringify(capturedLogs)}`);
    });

    await check('Q6: _getSolanaRpcUrl throws on POST-read → drift check degraded, log emitted, no throw', async () => {
        stub.urlAtPre = 'https://api.mainnet-beta.solana.com';
        stub.urlThrowsPost = true;
        stub.nextGma = () => ({ value: [null], context: { slot: 100 } });
        const sim = _lazyDefaultSimulator();
        const r = await sim('TX', { addresses: [ADDR_A] });
        assert.strictEqual(typeof r.simulatorBacking, 'string');
        const warnLogs = capturedLogs.filter(l => l.level === 'WARN' && /_getSolanaRpcUrl threw/i.test(l.msg));
        assert.ok(warnLogs.length >= 1, `expected ≥1 WARN log on post-throw, got: ${JSON.stringify(capturedLogs)}`);
    });

    // ── Q4: slot-drift detection ─────────────────────────────────────────
    console.log();
    console.log('Q4 slot-drift');

    await check('slot delta 9 (just over threshold) → slot_drift throw', async () => {
        stub.nextGma = () => ({ value: [null], context: { slot: 1_000_000 } });
        stub.nextSim = () => ({ value: { err: null, accounts: [], loadedAddresses: { writable: [], readonly: [] } }, context: { slot: 1_000_009 } });
        const sim = _lazyDefaultSimulator();
        let threw = null;
        try { await sim('TX', { addresses: [ADDR_A] }); }
        catch (e) { threw = e; }
        assert.ok(threw, 'expected throw on slot drift > 8');
        assert.match(threw.message, /slot_drift/);
        assert.match(threw.message, /1000000/);
        assert.match(threw.message, /1000009/);
    });

    await check('slot delta 50 (large drift) → slot_drift throw', async () => {
        stub.nextGma = () => ({ value: [null], context: { slot: 1_000_000 } });
        stub.nextSim = () => ({ value: { err: null, accounts: [], loadedAddresses: { writable: [], readonly: [] } }, context: { slot: 1_000_050 } });
        const sim = _lazyDefaultSimulator();
        let threw = null;
        try { await sim('TX', { addresses: [ADDR_A] }); }
        catch (e) { threw = e; }
        assert.ok(threw, 'expected throw on slot drift > 8');
        assert.match(threw.message, /slot_drift/);
    });

    await check('slot delta 8 (at threshold) → accepted', async () => {
        stub.nextGma = () => ({ value: [null], context: { slot: 1_000_000 } });
        stub.nextSim = () => ({ value: { err: null, accounts: [], loadedAddresses: { writable: [], readonly: [] } }, context: { slot: 1_000_008 } });
        const sim = _lazyDefaultSimulator();
        const r = await sim('TX', { addresses: [ADDR_A] });
        assert.strictEqual(r.slot, 1_000_008);
        assert.strictEqual(r.preSlot, 1_000_000);
    });

    await check('slot delta 0 (same slot) → accepted', async () => {
        stub.nextGma = () => ({ value: [null], context: { slot: 1_000_000 } });
        stub.nextSim = () => ({ value: { err: null, accounts: [], loadedAddresses: { writable: [], readonly: [] } }, context: { slot: 1_000_000 } });
        const sim = _lazyDefaultSimulator();
        const r = await sim('TX', { addresses: [ADDR_A] });
        assert.strictEqual(r.slot, 1_000_000);
    });

    await check('reverse drift (sim slot earlier than pre) > 8 → slot_drift throw', async () => {
        stub.nextGma = () => ({ value: [null], context: { slot: 1_000_020 } });
        stub.nextSim = () => ({ value: { err: null, accounts: [], loadedAddresses: { writable: [], readonly: [] } }, context: { slot: 1_000_000 } });
        const sim = _lazyDefaultSimulator();
        let threw = null;
        try { await sim('TX', { addresses: [ADDR_A] }); }
        catch (e) { threw = e; }
        assert.ok(threw, 'expected throw on reverse drift > 8');
        assert.match(threw.message, /slot_drift/);
    });

    await check('preSlot missing (no addresses requested) → slot check skipped', async () => {
        // No GMA call → preSlot stays null → check is skipped even if sim slot is wildly different.
        stub.nextSim = () => ({ value: { err: null, accounts: [], loadedAddresses: { writable: [], readonly: [] } }, context: { slot: 99_999_999 } });
        const sim = _lazyDefaultSimulator();
        const r = await sim('TX', { addresses: [] });
        assert.strictEqual(r.preSlot, null);
        assert.strictEqual(r.slot, 99_999_999);
    });

    await check('preSlot missing on response (older RPC) → slot check skipped', async () => {
        stub.nextGma = () => ({ value: [null] }); // no context.slot
        stub.nextSim = () => ({ value: { err: null, accounts: [], loadedAddresses: { writable: [], readonly: [] } }, context: { slot: 9_000_000 } });
        const sim = _lazyDefaultSimulator();
        const r = await sim('TX', { addresses: [ADDR_A] });
        assert.strictEqual(r.preSlot, null);
    });

    // ── C9: partial-null GMA shape ──────────────────────────────────────
    console.log();
    console.log('C9 partial-null GMA');

    await check('GMA returns no value array at all → simulation_metadata_missing throw', async () => {
        stub.nextGma = () => ({ context: { slot: 100 } }); // no `value`
        const sim = _lazyDefaultSimulator();
        let threw = null;
        try { await sim('TX', { addresses: [ADDR_A] }); }
        catch (e) { threw = e; }
        assert.ok(threw, 'expected throw on missing value');
        assert.match(threw.message, /simulation_metadata_missing/);
        assert.match(threw.message, /no `value` array/);
    });

    await check('GMA returns shorter value array than requested → simulation_metadata_missing throw', async () => {
        stub.nextGma = () => ({ value: [null], context: { slot: 100 } }); // 1 entry for 2 addrs
        const sim = _lazyDefaultSimulator();
        let threw = null;
        try { await sim('TX', { addresses: [ADDR_A, ADDR_B] }); }
        catch (e) { threw = e; }
        assert.ok(threw, 'expected throw on length mismatch');
        assert.match(threw.message, /simulation_metadata_missing/);
        assert.match(threw.message, /1 entries for 2/);
    });

    await check('GMA returns longer value array than requested → simulation_metadata_missing throw', async () => {
        stub.nextGma = () => ({ value: [null, null, null], context: { slot: 100 } });
        const sim = _lazyDefaultSimulator();
        let threw = null;
        try { await sim('TX', { addresses: [ADDR_A, ADDR_B] }); }
        catch (e) { threw = e; }
        assert.ok(threw, 'expected throw on length mismatch');
        assert.match(threw.message, /simulation_metadata_missing/);
        assert.match(threw.message, /3 entries for 2/);
    });

    await check('GMA returns matching-length array with per-entry nulls → accepted (passed through)', async () => {
        // Per-entry nulls are legitimate (ATA may not exist yet); the policy
        // layer applies mustExistBefore per declared account.
        stub.nextGma = () => ({ value: [null, { lamports: 1_000_000, owner: 'sys', data: ['', 'base64'], executable: false, rentEpoch: 0 }], context: { slot: 100 } });
        stub.nextSim = () => ({ value: { err: null, accounts: [null, null], loadedAddresses: { writable: [], readonly: [] } }, context: { slot: 100 } });
        const sim = _lazyDefaultSimulator();
        const r = await sim('TX', { addresses: [ADDR_A, ADDR_B] });
        assert.deepStrictEqual(r.preSnapshot.length, 2);
        assert.strictEqual(r.preSnapshot[0], null);
        assert.ok(r.preSnapshot[1] !== null);
    });

    // ── R12 regression (Copilot PR #398, live test mirror) ──────────────
    // solanaRpc() returns {error: string} on failure (it does NOT throw).
    // _lazyDefaultSimulator must detect this and throw so the burner-policy
    // gate classifies it as availability-class simulation_failed instead
    // of silently treating the RPC failure as "all accounts null" pre-state.
    await check('R12: GMA returns {error} field → throw with error info', async () => {
        stub.nextGma = () => ({ error: 'getMultipleAccounts: connection timeout' });
        const sim = _lazyDefaultSimulator();
        let threw = null;
        try { await sim('TX', { addresses: [ADDR_A] }); }
        catch (e) { threw = e; }
        assert.ok(threw, 'expected throw when GMA returns {error}');
        assert.match(threw.message, /getMultipleAccounts/, `got: ${threw && threw.message}`);
    });

    await check('R12: GMA returns null entirely → simulation_metadata_missing throw', async () => {
        stub.nextGma = () => null;
        const sim = _lazyDefaultSimulator();
        let threw = null;
        try { await sim('TX', { addresses: [ADDR_A] }); }
        catch (e) { threw = e; }
        assert.ok(threw, 'expected throw when GMA returns null');
        assert.match(threw.message, /simulation_metadata_missing/);
    });

    // ── C8: _burnerPubkeyCache invalidation ─────────────────────────────
    console.log();
    console.log('C8 burner-pubkey cache');

    await check('first call populates cache from /burner/status', async () => {
        _resetBurnerPubkeyCache();
        bridgeResponse = { configured: true, pubkey: 'BURNER111111111111111111111111111111111111' };
        const pk = await _getBurnerPubkey();
        assert.strictEqual(pk, 'BURNER111111111111111111111111111111111111');
        assert.strictEqual(bridgeCalls.length, 1);
        assert.strictEqual(bridgeCalls[0].endpoint, '/burner/status');
    });

    await check('cache invalidates when /burner/status reports a NEW pubkey', async () => {
        _resetBurnerPubkeyCache();
        // First, prime the cache with pubkey A.
        bridgeResponse = { configured: true, pubkey: 'AAAA1111111111111111111111111111111111111111' };
        const first = await _getBurnerPubkey();
        assert.strictEqual(first, 'AAAA1111111111111111111111111111111111111111');

        // Simulate a mid-process wipe + re-setup: status now reports pubkey B.
        bridgeResponse = { configured: true, pubkey: 'BBBB1111111111111111111111111111111111111111' };
        const second = await _getBurnerPubkey();
        assert.strictEqual(second, 'BBBB1111111111111111111111111111111111111111',
            'cache MUST adopt the new pubkey when the bridge reports a different one (C8)');

        const warnLogs = capturedLogs.filter(l => l.level === 'WARN' && /burner pubkey changed/i.test(l.msg));
        assert.ok(warnLogs.length >= 1, 'expected WARN log on pubkey rotation');
    });

    await check('bridge transient error falls back to cached value (no over-invalidation)', async () => {
        _resetBurnerPubkeyCache();
        bridgeResponse = { configured: true, pubkey: 'CCCC1111111111111111111111111111111111111111' };
        const first = await _getBurnerPubkey();
        assert.strictEqual(first, 'CCCC1111111111111111111111111111111111111111');

        bridgeResponse = { __throw: 'bridge_offline' };
        const cached = await _getBurnerPubkey();
        assert.strictEqual(cached, 'CCCC1111111111111111111111111111111111111111',
            'bridge error must not blank the cache — fall back to last-known value');
    });

    await check('bridge returns not-configured → falls back to cached value', async () => {
        _resetBurnerPubkeyCache();
        bridgeResponse = { configured: true, pubkey: 'DDDD1111111111111111111111111111111111111111' };
        await _getBurnerPubkey();

        bridgeResponse = { configured: false }; // status sentinel for "no burner"
        const r = await _getBurnerPubkey();
        // Per current contract we fall back to the cached pubkey rather than
        // returning null — production sees this only on transient mismatches.
        assert.strictEqual(r, 'DDDD1111111111111111111111111111111111111111');
    });

    // ── Result summary ──────────────────────────────────────────────────
    if (failures > 0) {
        console.error(`\n${failures} failure(s).`);
        process.exit(1);
    }
    console.log('\nPASS: burner-signer-simulator.test.js');
})();
