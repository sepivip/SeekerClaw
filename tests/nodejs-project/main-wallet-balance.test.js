#!/usr/bin/env node
// main-wallet-balance.test.js — BAT-582 R6.
//
// Verifies MainWallet.balance() uses the {mint: USDC_MINT} filter when
// querying getTokenAccountsByOwner, NOT the broader {programId: TOKEN_PROGRAM}
// filter. The mint filter returns at most one account (the user's USDC ATA);
// the programId filter returns ALL token accounts the wallet owns — for
// NFT collectors and memecoin holders that's a heavy RPC payload we never
// needed.
//
// tools/solana.js:635 (Jupiter swap balance check) already uses {mint:...};
// MainWallet now matches that pattern. tools/solana.js:283 (the listing-style
// solana_balance tool) intentionally still uses programId — that one
// enumerates all tokens.
//
// Pre-fix verification: temporarily revert main-wallet.js to {programId: ...}
// and rerun this test — it should fail on the mint-filter assertion.

'use strict';

const assert = require('assert');
const path = require('path');

const BUNDLE = path.resolve(__dirname, '..', '..', 'app', 'src', 'main', 'assets', 'nodejs-project');
const USDC_MINT = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v';
const TOKEN_PROGRAM_ID = 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA';

// Inject a fake config.js so anything downstream that requires it doesn't
// blow up the test fixture.
const configPath = require.resolve(path.join(BUNDLE, 'config.js'));
require.cache[configPath] = {
    id: configPath,
    filename: configPath,
    loaded: true,
    exports: {
        BRIDGE_TOKEN: 'test-token',
        log: () => {},
    },
};

// Stub solana.js — record every solanaRpc call for assertion. Return a
// canned getTokenAccountsByOwner response that exposes a single USDC
// account so the parsing path completes successfully.
const solanaPath = require.resolve(path.join(BUNDLE, 'solana.js'));
const rpcCalls = [];
require.cache[solanaPath] = {
    id: solanaPath,
    filename: solanaPath,
    loaded: true,
    exports: {
        getConnectedWalletAddress: () => 'FAKE-MAIN-WALLET-ADDRESS-1234567890',
        solanaRpc: async (method, params) => {
            rpcCalls.push({ method, params });
            if (method === 'getBalance') {
                return { value: 1_000_000_000 }; // 1 SOL in lamports
            }
            if (method === 'getTokenAccountsByOwner') {
                return {
                    value: [
                        {
                            account: {
                                data: {
                                    parsed: {
                                        info: {
                                            mint: USDC_MINT,
                                            tokenAmount: { amount: '5000000', decimals: 6 },
                                        },
                                    },
                                },
                            },
                        },
                    ],
                };
            }
            return { error: 'unmocked-method' };
        },
    },
};

const { MainWallet } = require(path.join(BUNDLE, 'wallet', 'main-wallet'));

let failures = 0;
async function check(label, fn) {
    try { await fn(); console.log(`  ✓ ${label}`); }
    catch (e) { failures++; console.error(`  ✗ ${label}\n    ${e.stack || e.message}`); }
}

(async () => {
    await check('MainWallet.balance() calls getTokenAccountsByOwner with {mint: USDC_MINT} (NOT {programId: ...})', async () => {
        rpcCalls.length = 0;
        const wallet = new MainWallet();
        const bal = await wallet.balance();

        const tokenCalls = rpcCalls.filter(c => c.method === 'getTokenAccountsByOwner');
        assert.strictEqual(tokenCalls.length, 1, `expected exactly 1 getTokenAccountsByOwner call, got ${tokenCalls.length}`);

        const filter = tokenCalls[0].params[1];
        assert.ok(filter, 'filter object missing from RPC params');
        assert.strictEqual(filter.mint, USDC_MINT,
            `filter.mint must equal USDC mint (was: ${JSON.stringify(filter)})`);
        assert.strictEqual(filter.programId, undefined,
            `filter.programId must NOT be set — old broad filter was a perf hazard for NFT/memecoin holders (was: ${JSON.stringify(filter)})`);

        // Sanity: balance parses correctly with the targeted response shape.
        assert.strictEqual(bal.sol, '1000000000', 'SOL balance returned in lamports');
        assert.strictEqual(bal.usdc, '5000000', 'USDC balance returned in micro-USDC');
    });

    await check('MainWallet.balance() returns "0"/"0" cleanly when address resolution fails', async () => {
        // Re-stub to throw on getConnectedWalletAddress.
        const prev = require.cache[solanaPath].exports.getConnectedWalletAddress;
        require.cache[solanaPath].exports.getConnectedWalletAddress = () => { throw new Error('not connected'); };

        try {
            const wallet = new MainWallet();
            const bal = await wallet.balance();
            assert.deepStrictEqual(bal, { sol: '0', usdc: '0' });
        } finally {
            require.cache[solanaPath].exports.getConnectedWalletAddress = prev;
        }
    });

    await check('MainWallet.balance() does not blow up on RPC error envelope', async () => {
        // Override solanaRpc to return an error envelope.
        const prev = require.cache[solanaPath].exports.solanaRpc;
        require.cache[solanaPath].exports.solanaRpc = async () => ({ error: 'rate-limited' });

        try {
            const wallet = new MainWallet();
            const bal = await wallet.balance();
            // Both fields fall back to "0" — the catch keeps things flowing.
            assert.strictEqual(bal.sol, '0');
            assert.strictEqual(bal.usdc, '0');
        } finally {
            require.cache[solanaPath].exports.solanaRpc = prev;
        }
    });

    // Negative anti-regression: assert TOKEN_PROGRAM_ID is never the filter.
    // This catches a careless revert where someone copy-pastes the listing
    // pattern from solana_balance back into MainWallet.balance().
    await check('Same-class sweep: anti-regression — programId filter must not be reintroduced', async () => {
        // Reset stubs to the working canned response.
        require.cache[solanaPath].exports.getConnectedWalletAddress = () => 'FAKE-MAIN-WALLET-ADDRESS-1234567890';
        require.cache[solanaPath].exports.solanaRpc = async (method, params) => {
            rpcCalls.push({ method, params });
            if (method === 'getBalance') return { value: 0 };
            if (method === 'getTokenAccountsByOwner') return { value: [] };
            return { error: 'unmocked' };
        };
        rpcCalls.length = 0;
        const wallet = new MainWallet();
        await wallet.balance();
        const tokenCalls = rpcCalls.filter(c => c.method === 'getTokenAccountsByOwner');
        for (const call of tokenCalls) {
            const filter = call.params[1];
            assert.notStrictEqual(filter.programId, TOKEN_PROGRAM_ID,
                'main-wallet.js must not use TOKEN_PROGRAM_ID filter — defeats the per-mint optimization');
        }
    });

    if (failures > 0) {
        console.error(`\n${failures} failure(s).`);
        process.exit(1);
    }
    console.log('\nPASS: main-wallet-balance.test.js (mint-filter contract verified).');
})().catch((e) => {
    console.error('Unhandled error in test runner:', e);
    process.exit(1);
});
