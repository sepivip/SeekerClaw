#!/usr/bin/env node
// main-wallet-balance.test.js — BAT-582 R6.
//
// Verifies MainWallet.balance() uses the {mint: USDC_MINT} filter when
// querying getTokenAccountsByOwner, NOT the broader {programId: TOKEN_PROGRAM}
// filter. The mint filter returns ONLY token accounts whose mint matches
// USDC — typically the wallet's ATA but NOT guaranteed to be a single
// account (a wallet can legitimately hold USDC across multiple token
// accounts: one ATA + auxiliary accounts created manually or by a dApp).
// BAT-582 R21: MainWallet.balance() now sums across ALL returned accounts
// to handle the multi-account case correctly. Pre-fix it took the first
// account only and under-reported in that scenario.
//
// The programId filter is the old broad filter we left behind: it returns
// ALL token accounts the wallet owns — for NFT collectors and memecoin
// holders that's a heavy RPC payload we never needed.
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

    await check('MainWallet.balance() returns null/null when address resolution fails (R27)', async () => {
        // BAT-582 R27: null distinguishes "wallet unavailable" from real
        // zero balance. Pre-R27 returned "0"/"0", indistinguishable from
        // a real empty wallet — misleading users about funds vanishing.
        const prev = require.cache[solanaPath].exports.getConnectedWalletAddress;
        require.cache[solanaPath].exports.getConnectedWalletAddress = () => { throw new Error('not connected'); };

        try {
            const wallet = new MainWallet();
            const bal = await wallet.balance();
            assert.deepStrictEqual(bal, { sol: null, usdc: null });
        } finally {
            require.cache[solanaPath].exports.getConnectedWalletAddress = prev;
        }
    });

    await check('MainWallet.balance() SUMS across multiple USDC token accounts (BAT-582 R21)', async () => {
        // Stub a response with two USDC accounts (ATA + auxiliary). Pre-R21,
        // the function took only the first; post-R21 it sums them.
        rpcCalls.length = 0;
        const prev = require.cache[solanaPath].exports.solanaRpc;
        require.cache[solanaPath].exports.solanaRpc = async (method) => {
            if (method === 'getBalance') return { value: 1_000_000_000 };
            if (method === 'getTokenAccountsByOwner') {
                return {
                    value: [
                        { account: { data: { parsed: { info: {
                            mint: USDC_MINT,
                            tokenAmount: { amount: '3000000', decimals: 6 },
                        } } } } },
                        { account: { data: { parsed: { info: {
                            mint: USDC_MINT,
                            tokenAmount: { amount: '2500000', decimals: 6 },
                        } } } } },
                    ],
                };
            }
            return { error: 'unmocked' };
        };
        try {
            const wallet = new MainWallet();
            const bal = await wallet.balance();
            assert.strictEqual(bal.usdc, '5500000',
                `expected summed balance "5500000" (3000000 + 2500000), got "${bal.usdc}"`);
        } finally {
            require.cache[solanaPath].exports.solanaRpc = prev;
        }
    });

    await check('MainWallet.balance() ignores malformed account entries during sum', async () => {
        rpcCalls.length = 0;
        const prev = require.cache[solanaPath].exports.solanaRpc;
        require.cache[solanaPath].exports.solanaRpc = async (method) => {
            if (method === 'getBalance') return { value: 1_000_000_000 };
            if (method === 'getTokenAccountsByOwner') {
                return {
                    value: [
                        { account: { data: { parsed: { info: {
                            mint: USDC_MINT,
                            tokenAmount: { amount: '1000000', decimals: 6 },
                        } } } } },
                        // Malformed: missing info entirely
                        { account: { data: { parsed: {} } } },
                        // Malformed: tokenAmount.amount is not a digit string
                        { account: { data: { parsed: { info: {
                            mint: USDC_MINT,
                            tokenAmount: { amount: 'not-a-number', decimals: 6 },
                        } } } } },
                        // Wrong mint (defense — should never happen with mint
                        // filter, but defensive code shouldn't include it)
                        { account: { data: { parsed: { info: {
                            mint: 'OtherMint11111111111111111111111111111111111',
                            tokenAmount: { amount: '9999999', decimals: 6 },
                        } } } } },
                        { account: { data: { parsed: { info: {
                            mint: USDC_MINT,
                            tokenAmount: { amount: '500000', decimals: 6 },
                        } } } } },
                    ],
                };
            }
            return { error: 'unmocked' };
        };
        try {
            const wallet = new MainWallet();
            const bal = await wallet.balance();
            assert.strictEqual(bal.usdc, '1500000',
                `expected only valid USDC accounts summed (1000000 + 500000), got "${bal.usdc}"`);
        } finally {
            require.cache[solanaPath].exports.solanaRpc = prev;
        }
    });

    await check('MainWallet.balance() returns null on RPC error envelope (R27)', async () => {
        // BAT-582 R27: RPC error envelope ({error: ...}) is a transient
        // outage, not a confirmed-zero balance. Caller renders
        // "unavailable" — pre-R27 returned "0"/"0", indistinguishable
        // from a real empty wallet.
        const prev = require.cache[solanaPath].exports.solanaRpc;
        require.cache[solanaPath].exports.solanaRpc = async () => ({ error: 'rate-limited' });

        try {
            const wallet = new MainWallet();
            const bal = await wallet.balance();
            assert.strictEqual(bal.sol, null, 'sol must be null on RPC failure');
            assert.strictEqual(bal.usdc, null, 'usdc must be null on RPC failure');
        } finally {
            require.cache[solanaPath].exports.solanaRpc = prev;
        }
    });

    await check('MainWallet.balance() returns "0" for USDC when value array is empty (real zero, R27)', async () => {
        // Distinguishes the SUCCESS-with-zero case from RPC failure.
        // No USDC ATA exists yet (wallet never received USDC) — that's
        // a REAL zero, not unavailable.
        const prev = require.cache[solanaPath].exports.solanaRpc;
        require.cache[solanaPath].exports.solanaRpc = async (method) => {
            if (method === 'getBalance') return { value: 1_000_000_000 };
            if (method === 'getTokenAccountsByOwner') return { value: [] };
            return { error: 'unmocked' };
        };

        try {
            const wallet = new MainWallet();
            const bal = await wallet.balance();
            assert.strictEqual(bal.sol, '1000000000');
            assert.strictEqual(bal.usdc, '0', 'empty value array = real zero, NOT null');
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
