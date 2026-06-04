#!/usr/bin/env node
// tools-solana-balance.test.js — BAT-1002 PR-C.
//
// Locks the four return-shape scenarios of the solana_balance handler
// in tools/solana.js. (Conceptually three "states" — success / partial-
// failure / full-failure — but success has two sub-shapes, so the
// numbered list below has four entries.)
//
//   (1) RPC success, populated wallet → { address, sol, tokens: [...], tokenCount: N }
//   (2) RPC success, empty wallet     → { address, sol, tokens: [],    tokenCount: 0 }
//   (3) SPL RPC failure (SOL ok)      → { address, sol, tokens: null,  tokenCount: null, tokensError: '<reason>' }
//   (4) SOL RPC failure (full fail)   → { error: '<reason>' }
//
// Why these matter: pre-fix, (3) collapsed into (2) — an RPC timeout
// looked identical to a genuinely-empty wallet, so the agent reported
// "you have 0 USDC" on a freshly-funded burner (2026-06-03 BAT-995
// device incident). The `tokens: null` + `tokensError` shape is the
// load-bearing signal the agent reads to say "balance temporarily
// unavailable" instead of "0 tokens".
//
// Test strategy: stub `solana.js` via require.cache before requiring
// `tools/solana.js`, then drive the handler with canned solanaRpc
// responses per scenario. Mirrors the stubbing pattern in
// tests/nodejs-project/main-wallet-balance.test.js:38-85.
//
// Run: node tests/nodejs-project/tools-solana-balance.test.js
// Exit: 0 = all pass, 1 = at least one failure.

'use strict';

const assert = require('assert');
const path = require('path');

const BUNDLE = path.resolve(__dirname, '..', '..', 'app', 'src', 'main', 'assets', 'nodejs-project');
const USDC_MINT = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v';
const FAKE_PUBKEY = 'FAKEBURNER1111111111111111111111111111';

// ── Stub config.js so anything downstream doesn't blow up the fixture.
const configPath = require.resolve(path.join(BUNDLE, 'config.js'));
require.cache[configPath] = {
    id: configPath,
    filename: configPath,
    loaded: true,
    exports: {
        BRIDGE_TOKEN: 'test-token',
        getBridgeToken: () => 'test-token',
        log: () => {},
        workDir: '/tmp/fixture-wd',
        config: {},
    },
};

// ── Stub solana.js — controllable solanaRpc per scenario.
// `setRpcResponses({ getBalance: <result>, getTokenAccountsByOwner: <result> })`
// installs the canned responses; the handler invokes them by method
// name.
let _rpcResponses = {};
function setRpcResponses(responses) {
    _rpcResponses = responses;
}

const solanaPath = require.resolve(path.join(BUNDLE, 'solana.js'));
require.cache[solanaPath] = {
    id: solanaPath,
    filename: solanaPath,
    loaded: true,
    exports: {
        getConnectedWalletAddress: () => FAKE_PUBKEY,
        solanaRpc: async (method, _params) => {
            if (_rpcResponses[method] === undefined) {
                throw new Error(`unmocked solanaRpc method: ${method}`);
            }
            return _rpcResponses[method];
        },
    },
};

// ── Load the tool handler. tools/solana.js's `handlers` is the dispatch
// table for tool-call execution.
const solanaTool = require(path.join(BUNDLE, 'tools', 'solana.js'));

// Find the solana_balance handler. tools/solana.js's exports vary
// across rounds — we tolerate either `{ handlers: { solana_balance } }`
// or `{ solana_balance }` directly.
function getHandler() {
    if (solanaTool.handlers && typeof solanaTool.handlers.solana_balance === 'function') {
        return solanaTool.handlers.solana_balance;
    }
    if (typeof solanaTool.solana_balance === 'function') {
        return solanaTool.solana_balance;
    }
    // Fall back to scanning the `handlers` object for a function named
    // solana_balance (the in-file object literal at the bottom of
    // tools/solana.js).
    for (const key of Object.keys(solanaTool)) {
        const val = solanaTool[key];
        if (val && typeof val === 'object' && typeof val.solana_balance === 'function') {
            return val.solana_balance;
        }
    }
    throw new Error('could not find solana_balance handler in tools/solana.js exports: ' +
        JSON.stringify(Object.keys(solanaTool)));
}

const solana_balance = getHandler();

// ── Test runner.
let failures = 0;
async function check(label, fn) {
    try { await fn(); console.log(`  ✓ ${label}`); }
    catch (e) { failures++; console.error(`  ✗ ${label}\n    ${e.stack || e.message}`); }
}

(async () => {
    // ── (1) Success: populated wallet returns tokens array + count.
    await check('populated wallet → { tokens: [...accounts], tokenCount: N } (no tokensError)', async () => {
        setRpcResponses({
            getBalance: { value: 1_000_000_000 }, // 1 SOL in lamports
            getTokenAccountsByOwner: {
                value: [
                    {
                        account: {
                            data: {
                                parsed: {
                                    info: {
                                        mint: USDC_MINT,
                                        tokenAmount: { uiAmountString: '5.0', decimals: 6 },
                                    },
                                },
                            },
                        },
                    },
                ],
            },
        });
        const result = await solana_balance({ address: FAKE_PUBKEY }, 'test-chat');
        assert.strictEqual(result.address, FAKE_PUBKEY);
        assert.strictEqual(result.sol, 1, 'sol = 1 (1B lamports / 1e9)');
        assert.ok(Array.isArray(result.tokens), 'tokens MUST be an array (not null) on success');
        assert.strictEqual(result.tokens.length, 1);
        assert.strictEqual(result.tokens[0].mint, USDC_MINT);
        assert.strictEqual(result.tokenCount, 1);
        assert.strictEqual(result.tokensError, undefined, 'no tokensError on success');
        assert.strictEqual(result.error, undefined, 'no top-level error on success');
    });

    // ── (2) Success but empty: tokens: [] + tokenCount: 0, NOT null.
    await check('genuinely empty wallet → { tokens: [], tokenCount: 0 } (NOT tokens: null)', async () => {
        setRpcResponses({
            getBalance: { value: 500_000_000 }, // 0.5 SOL
            getTokenAccountsByOwner: { value: [] }, // RPC succeeded; wallet just has no SPL accounts
        });
        const result = await solana_balance({ address: FAKE_PUBKEY }, 'test-chat');
        assert.strictEqual(result.sol, 0.5);
        // Critical: empty wallet returns [], not null. The agent
        // distinguishes "genuinely empty" from "RPC failed" by the
        // null vs [] distinction.
        assert.ok(Array.isArray(result.tokens), 'empty wallet MUST return tokens: [], not tokens: null');
        assert.strictEqual(result.tokens.length, 0);
        assert.strictEqual(result.tokenCount, 0);
        assert.strictEqual(result.tokensError, undefined, 'no tokensError on RPC success');
    });

    // ── (3) SPL RPC failure (SOL ok) — load-bearing PR-C contract.
    await check('SPL RPC failure (SOL ok) → preserve sol, tokens: null + tokenCount: null + tokensError set', async () => {
        setRpcResponses({
            getBalance: { value: 2_000_000_000 }, // 2 SOL — SOL fetch succeeded
            getTokenAccountsByOwner: { error: 'simulated SPL timeout' },
        });
        const result = await solana_balance({ address: FAKE_PUBKEY }, 'test-chat');
        // SOL value MUST be preserved on partial failure — the agent
        // can still report SOL truthfully.
        assert.strictEqual(result.sol, 2);
        // The three signature fields that distinguish RPC-fail from
        // genuinely-empty:
        assert.strictEqual(result.tokens, null, 'tokens MUST be null on SPL RPC failure (NOT [])');
        assert.strictEqual(result.tokenCount, null, 'tokenCount MUST be null on SPL RPC failure (NOT 0)');
        assert.strictEqual(typeof result.tokensError, 'string', 'tokensError MUST be a string');
        assert.ok(result.tokensError.includes('simulated SPL timeout'),
            'tokensError MUST contain the upstream RPC reason');
        // CRITICAL: no top-level `error`. The handler reserves top-
        // level `error` for full-failure (SOL side). On SPL-only fail
        // the consumer must see sol still present.
        assert.strictEqual(result.error, undefined, 'NO top-level error on SPL-only failure');
    });

    // ── (3b) Object-shaped tokenResult.error survives JSON.stringify.
    await check('SPL RPC failure with object error → tokensError is JSON-stringified', async () => {
        setRpcResponses({
            getBalance: { value: 1_000_000 },
            getTokenAccountsByOwner: { error: { code: -32602, message: 'invalid params' } },
        });
        const result = await solana_balance({ address: FAKE_PUBKEY }, 'test-chat');
        assert.strictEqual(result.tokens, null);
        assert.strictEqual(typeof result.tokensError, 'string', 'tokensError MUST always be a string');
        assert.ok(result.tokensError.includes('invalid params') || result.tokensError.includes('-32602'),
            'object-shaped errors must JSON-stringify into tokensError');
    });

    // ── (4) SOL RPC failure (full fail) — top-level { error }, no partial data.
    await check('SOL RPC failure → top-level { error }, no partial sol/tokens fields', async () => {
        setRpcResponses({
            getBalance: { error: 'simulated SOL outage' },
            // Should never be reached — handler must return BEFORE the
            // SPL call when SOL fails.
            getTokenAccountsByOwner: { value: [] },
        });
        const result = await solana_balance({ address: FAKE_PUBKEY }, 'test-chat');
        assert.strictEqual(typeof result.error, 'string', 'SOL fail returns top-level error');
        assert.ok(result.error.includes('simulated SOL outage'));
        // No partial data: handler returned early, so no sol/tokens
        // fields should be present.
        assert.strictEqual(result.sol, undefined, 'no partial sol field on full failure');
        assert.strictEqual(result.tokens, undefined, 'no partial tokens field on full failure');
        assert.strictEqual(result.tokensError, undefined, 'no tokensError on full failure');
    });

    // ── (5) Degraded RPC success ({ value: null }) — surface as
    // partial-failure shape, not empty-success. Adversarial sweep
    // w0hswp0yu blocker: pre-fix this fell through to tokens: [] /
    // tokenCount: 0, exactly the empty-wallet/RPC-fail collision
    // PR-C is supposed to eliminate. The Array.isArray guard at
    // tools/solana.js:1100 makes this case surface as the null-
    // sentinel shape instead.
    await check('degraded RPC ({ value: null }) → tokens: null + tokensError (NOT empty-success)', async () => {
        setRpcResponses({
            getBalance: { value: 500_000_000 }, // SOL fetch fine
            getTokenAccountsByOwner: { value: null }, // 200 OK but null value
        });
        const result = await solana_balance({ address: FAKE_PUBKEY }, 'test-chat');
        // SOL value preserved — same as the SPL-only-fail case.
        assert.strictEqual(result.sol, 0.5);
        // Null-sentinel shape, NOT empty-success. The whole point
        // of PR-C is that this case must NOT collapse to tokens: [].
        assert.strictEqual(result.tokens, null,
            'degraded { value: null } MUST surface as tokens: null, NOT tokens: []');
        assert.strictEqual(result.tokenCount, null);
        assert.strictEqual(typeof result.tokensError, 'string',
            'tokensError MUST be set for degraded RPC responses');
    });

    // ── (5b) Same case but value is some non-array junk (e.g. an
    // object instead of an array). Same expected outcome.
    await check('degraded RPC ({ value: <object> }) → tokens: null + tokensError', async () => {
        setRpcResponses({
            getBalance: { value: 1_000_000_000 },
            getTokenAccountsByOwner: { value: { unexpected: 'shape' } },
        });
        const result = await solana_balance({ address: FAKE_PUBKEY }, 'test-chat');
        assert.strictEqual(result.sol, 1);
        assert.strictEqual(result.tokens, null);
        assert.strictEqual(result.tokenCount, null);
        assert.strictEqual(typeof result.tokensError, 'string');
    });

    // ── Contract drift guard: tokens: null is a distinct value (NOT
    // tokens: undefined). undefined silently disappears through
    // JSON.stringify, breaking the load-bearing signal the agent reads.
    // This locks the CLAUDE.md "Consistent JSON Output" rule for this
    // specific surface.
    await check('contract: tokens: null survives JSON round-trip (must not be undefined)', async () => {
        setRpcResponses({
            getBalance: { value: 0 },
            getTokenAccountsByOwner: { error: 'transient' },
        });
        const result = await solana_balance({ address: FAKE_PUBKEY }, 'test-chat');
        const roundTripped = JSON.parse(JSON.stringify(result));
        assert.ok('tokens' in roundTripped, 'tokens field MUST survive JSON.stringify');
        assert.strictEqual(roundTripped.tokens, null, 'tokens MUST round-trip as null');
        assert.ok('tokenCount' in roundTripped, 'tokenCount field MUST survive JSON.stringify');
        assert.strictEqual(roundTripped.tokenCount, null);
        assert.ok('tokensError' in roundTripped, 'tokensError field MUST survive JSON.stringify');
    });

    console.log(`\n${failures} failures`);
    process.exit(failures === 0 ? 0 : 1);
})();
