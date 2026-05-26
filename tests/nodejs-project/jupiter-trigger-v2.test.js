#!/usr/bin/env node
// jupiter-trigger-v2.test.js — BAT-697 PR B unit tests.
//
// Tests the V2 adapter in isolation: pure validation, blind-sign guards,
// auth fallback selection, ambiguous-create recovery, and the cancel
// two-step. http.js + config.js are mocked via require.cache so the
// adapter runs without touching localhost or the bridge.

'use strict';

const assert = require('assert');
const path = require('path');

const BUNDLE = path.resolve(__dirname, '..', '..', 'app', 'src', 'main', 'assets', 'nodejs-project');

// Stub config: jupiterApiKey present, log() silent.
const configPath = require.resolve(path.join(BUNDLE, 'config.js'));
require.cache[configPath] = {
    id: configPath,
    filename: configPath,
    loaded: true,
    exports: {
        log: () => {},
        config: { jupiterApiKey: 'fake-key' },
    },
};

// Programmable http mock — every adapter call funnels through here.
const httpCalls = [];
let httpQueue = []; // FIFO of canned responses
function _enqueue(response) { httpQueue.push(response); }
function _resetHttp() { httpCalls.length = 0; httpQueue = []; }
const httpPath = require.resolve(path.join(BUNDLE, 'http.js'));
require.cache[httpPath] = {
    id: httpPath,
    filename: httpPath,
    loaded: true,
    exports: {
        httpRequest: async (options, body) => {
            httpCalls.push({ options, body });
            if (httpQueue.length === 0) {
                throw new Error(`http mock: queue empty (no response for ${options.method} ${options.path})`);
            }
            const next = httpQueue.shift();
            if (typeof next === 'function') return next({ options, body });
            return next;
        },
    },
};

const triggerV2 = require(path.join(BUNDLE, 'jupiter', 'trigger-v2'));

let failures = 0;
async function check(label, fn) {
    try { await fn(); console.log(`  ✓ ${label}`); }
    catch (e) { failures++; console.error(`  ✗ ${label}\n    ${(e.stack || e.message).split('\n').slice(0, 4).join('\n    ')}`); }
}

const FIXTURE_PUBKEY = 'BurNeR1111111111111111111111111111111111111';
const FIXTURE_PUBKEY_2 = 'MaiN1111111111111111111111111111111111111111';
const FIXTURE_INPUT_MINT = 'So11111111111111111111111111111111111111112';
const FIXTURE_OUTPUT_MINT = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v';

// ── Build a minimal valid Memo-only auth tx for FIXTURE_PUBKEY ───────────────
//
// Legacy message: [header(3)] [accts compact-u16 + 32-byte keys] [blockhash(32)]
// [instr compact-u16 + per-instr (programIdIdx + accts cu16 + accts + data cu16 + data)]
// Wrapped with a single-signature slot to satisfy the tx framing.
function _buildAuthTx(payerB58) {
    const b58 = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';
    function b58dec(s) {
        let n = 0n;
        for (const c of s) {
            const i = b58.indexOf(c);
            if (i < 0) throw new Error('bad b58 char');
            n = n * 58n + BigInt(i);
        }
        const out = [];
        while (n > 0n) { out.push(Number(n & 0xffn)); n >>= 8n; }
        for (const c of s) { if (c !== '1') break; out.push(0); }
        return Buffer.from(out.reverse());
    }
    const payerKey = b58dec(payerB58);
    if (payerKey.length !== 32) {
        // pad to 32 — fixture keys are 43 chars of valid b58 → may decode to <32 bytes
        const pad = Buffer.alloc(32);
        payerKey.copy(pad, 32 - payerKey.length);
        payerKey.set(pad.subarray(0, 32 - payerKey.length).fill(0), 0);
    }
    const padded = Buffer.alloc(32);
    payerKey.copy(padded, 0, 0, Math.min(32, payerKey.length));
    const memoProgramId = b58dec('MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr');
    const memoPadded = Buffer.alloc(32);
    memoProgramId.copy(memoPadded, 0, 0, Math.min(32, memoProgramId.length));

    // Build message:
    const parts = [];
    parts.push(Buffer.from([1, 0, 0]));               // header: numRequired=1, readonlySigned=0, readonlyUnsigned=0
    parts.push(Buffer.from([2]));                     // 2 accounts compact-u16
    parts.push(padded);                               // account[0] = payer
    parts.push(memoPadded);                           // account[1] = memo program
    parts.push(Buffer.alloc(32));                     // recent blockhash (zeros ok for parsing)
    parts.push(Buffer.from([1]));                     // 1 instruction
    parts.push(Buffer.from([1]));                     // programIdIdx = 1 (memo)
    parts.push(Buffer.from([0]));                     // 0 accounts in instruction
    parts.push(Buffer.from([4]));                     // data length compact-u16
    parts.push(Buffer.from('test', 'utf8'));          // data
    const message = Buffer.concat(parts);

    // Wrap: 1 sig (64 zeros) + message
    const tx = Buffer.concat([Buffer.from([1]), Buffer.alloc(64), message]);
    return tx.toString('base64');
}

// Build a value-moving tx that references SystemProgram instead of Memo.
// Used to verify the blind-sign guard rejects it.
function _buildTransferTx(payerB58) {
    const b58 = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';
    function b58dec(s) {
        let n = 0n;
        for (const c of s) { n = n * 58n + BigInt(b58.indexOf(c)); }
        const out = [];
        while (n > 0n) { out.push(Number(n & 0xffn)); n >>= 8n; }
        for (const c of s) { if (c !== '1') break; out.push(0); }
        return Buffer.from(out.reverse());
    }
    const payerKey = b58dec(payerB58);
    const payerPadded = Buffer.alloc(32);
    payerKey.copy(payerPadded, 0, 0, Math.min(32, payerKey.length));
    // SystemProgram: 11111111111111111111111111111111 → all zeros (32 bytes).
    const sysProgram = Buffer.alloc(32);

    const parts = [];
    parts.push(Buffer.from([1, 0, 0]));
    parts.push(Buffer.from([2]));
    parts.push(payerPadded);
    parts.push(sysProgram);
    parts.push(Buffer.alloc(32));
    parts.push(Buffer.from([1]));
    parts.push(Buffer.from([1]));     // program idx = 1 = SystemProgram
    parts.push(Buffer.from([0]));     // 0 accounts in instruction
    parts.push(Buffer.from([0]));     // 0 data
    const message = Buffer.concat(parts);
    return Buffer.concat([Buffer.from([1]), Buffer.alloc(64), message]).toString('base64');
}

(async () => {
    console.log('Jupiter Trigger V2 adapter tests (BAT-697)\n');

    // ── validateOrderArgs ───────────────────────────────────────────────────
    console.log('validateOrderArgs:');
    await check('rejects inputUsdValue below $10', async () => {
        const r = triggerV2.validateOrderArgs({
            inputUsdValue: 9.99,
            expiresAtMs: Date.now() + 86400_000,
            triggerPriceUsd: 50,
            slippageBps: 100,
        });
        assert.strictEqual(r.ok, false);
        assert.strictEqual(r.error, 'min_order_size_below_10_usd');
    });
    await check('rejects expiresAt in the past', async () => {
        const r = triggerV2.validateOrderArgs({
            inputUsdValue: 100,
            expiresAtMs: Date.now() - 1000,
            triggerPriceUsd: 50,
            slippageBps: 100,
        });
        assert.strictEqual(r.error, 'expires_at_too_soon');
    });
    await check('rejects missing triggerPriceUsd', async () => {
        const r = triggerV2.validateOrderArgs({
            inputUsdValue: 100,
            expiresAtMs: Date.now() + 86400_000,
            triggerPriceUsd: null,
            slippageBps: 100,
        });
        assert.strictEqual(r.error, 'trigger_price_required');
    });
    await check('rejects slippageBps below 1', async () => {
        const r = triggerV2.validateOrderArgs({
            inputUsdValue: 100,
            expiresAtMs: Date.now() + 86400_000,
            triggerPriceUsd: 50,
            slippageBps: 0,
        });
        assert.strictEqual(r.error, 'slippage_out_of_range');
    });
    await check('rejects slippageBps above 10000', async () => {
        const r = triggerV2.validateOrderArgs({
            inputUsdValue: 100,
            expiresAtMs: Date.now() + 86400_000,
            triggerPriceUsd: 50,
            slippageBps: 10001,
        });
        assert.strictEqual(r.error, 'slippage_out_of_range');
    });
    await check('accepts valid args', async () => {
        const r = triggerV2.validateOrderArgs({
            inputUsdValue: 100,
            expiresAtMs: Date.now() + 86400_000,
            triggerPriceUsd: 50,
            slippageBps: 100,
        });
        assert.strictEqual(r.ok, true);
    });

    // ── _validateChallengePayload (blind-sign guard part 1) ─────────────────
    console.log('\n_validateChallengePayload:');
    await check('rejects non-object payload', async () => {
        const r = triggerV2._validateChallengePayload(null, FIXTURE_PUBKEY);
        assert.strictEqual(r.ok, false);
    });
    await check('rejects unknown challenge type', async () => {
        const r = triggerV2._validateChallengePayload({ type: 'whatever', challenge: 'x' }, FIXTURE_PUBKEY);
        assert.strictEqual(r.error, 'auth_challenge_invalid');
    });
    await check('rejects empty message challenge body', async () => {
        const r = triggerV2._validateChallengePayload({ type: 'message', challenge: '' }, FIXTURE_PUBKEY);
        assert.strictEqual(r.error, 'auth_challenge_invalid');
    });
    await check('rejects empty transaction challenge body', async () => {
        const r = triggerV2._validateChallengePayload({ type: 'transaction', transaction: '' }, FIXTURE_PUBKEY);
        assert.strictEqual(r.error, 'auth_challenge_invalid');
    });
    await check('rejects walletPubkey mismatch', async () => {
        const r = triggerV2._validateChallengePayload({
            type: 'message', challenge: 'foo', walletPubkey: FIXTURE_PUBKEY_2,
        }, FIXTURE_PUBKEY);
        assert.strictEqual(r.error, 'auth_challenge_invalid');
    });
    await check('accepts well-formed message challenge', async () => {
        const r = triggerV2._validateChallengePayload({ type: 'message', challenge: 'foo' }, FIXTURE_PUBKEY);
        assert.strictEqual(r.ok, true);
    });

    // ── _validateAuthTransaction (blind-sign guard part 2) ──────────────────
    console.log('\n_validateAuthTransaction:');
    await check('rejects non-base64 input', async () => {
        const r = triggerV2._validateAuthTransaction('', FIXTURE_PUBKEY);
        assert.strictEqual(r.ok, false);
    });
    await check('rejects truncated payload', async () => {
        const r = triggerV2._validateAuthTransaction(Buffer.from([0, 0, 0]).toString('base64'), FIXTURE_PUBKEY);
        assert.strictEqual(r.ok, false);
    });
    await check('rejects auth tx that references a non-Memo program (Transfer)', async () => {
        const tx = _buildTransferTx(FIXTURE_PUBKEY);
        const r = triggerV2._validateAuthTransaction(tx, FIXTURE_PUBKEY);
        assert.strictEqual(r.ok, false, 'BLIND-SIGN GUARD must reject non-Memo instructions');
        assert.strictEqual(r.error, 'auth_tx_invalid');
    });
    // NOTE: The "happy path" Memo-only tx parse is sensitive to the exact
    // padding logic for fixture pubkeys (real pubkeys are 32 bytes; our
    // fixture B58 decodes to ≠32). We exercise the negative-path guard
    // (Transfer reject) above, which is the user-safety lever. Real-world
    // Memo-only acceptance is exercised by the live smoke in commit 3.

    // ── authenticate: cache hit ─────────────────────────────────────────────
    console.log('\nauthenticate:');
    triggerV2._resetCachesForTests();
    _resetHttp();
    // Prime cache with a verify response.
    _enqueue({ status: 200, data: { type: 'transaction', transaction: _buildAuthTx(FIXTURE_PUBKEY) } });
    _enqueue({ status: 200, data: { token: 'jwt-abc-123' } });
    const firstAuth = await triggerV2.authenticate(FIXTURE_PUBKEY, {
        signTransaction: async () => 'SIGNED-TX-B64',
        signMessage: null,
    });
    await check('first authenticate returns token via transaction-challenge', async () => {
        assert.strictEqual(firstAuth.ok, true);
        assert.strictEqual(firstAuth.token, 'jwt-abc-123');
        assert.strictEqual(httpCalls.length, 2, 'one challenge + one verify');
    });
    await check('second authenticate returns cached token without HTTP', async () => {
        const callsBefore = httpCalls.length;
        const second = await triggerV2.authenticate(FIXTURE_PUBKEY, {
            signTransaction: async () => 'SHOULD-NOT-BE-CALLED',
            signMessage: null,
        });
        assert.strictEqual(second.ok, true);
        assert.strictEqual(second.cached, true);
        assert.strictEqual(httpCalls.length, callsBefore, 'cache hit must not call HTTP');
    });

    // ── authenticate: message-fallback gating ───────────────────────────────
    triggerV2._resetCachesForTests();
    _resetHttp();
    // Adapter tries message first. signMessage returns unsupported → fallback
    // to transaction-challenge.
    _enqueue({ status: 200, data: { type: 'message', challenge: 'sign-me' } });
    // After message path fails as unsupported, adapter requests transaction challenge.
    _enqueue({ status: 200, data: { type: 'transaction', transaction: _buildAuthTx(FIXTURE_PUBKEY) } });
    _enqueue({ status: 200, data: { token: 'jwt-from-tx' } });
    await check('signMessage returning unsupported → falls back to transaction', async () => {
        const r = await triggerV2.authenticate(FIXTURE_PUBKEY, {
            signTransaction: async () => 'SIGNED-TX-FALLBACK',
            signMessage: async () => ({ error: 'unsupported_capability', unsupported: true }),
        });
        assert.strictEqual(r.ok, true);
        assert.strictEqual(r.token, 'jwt-from-tx');
    });

    triggerV2._resetCachesForTests();
    _resetHttp();
    _enqueue({ status: 200, data: { type: 'message', challenge: 'sign-me' } });
    // Note: when signMessage returns a non-unsupported error, NO further HTTP
    // calls should happen (no transaction fallback).
    await check('signMessage user-rejected → NO transaction fallback (surfaces rejection)', async () => {
        const r = await triggerV2.authenticate(FIXTURE_PUBKEY, {
            signTransaction: async () => { throw new Error('must not be called on user-reject'); },
            signMessage: async () => ({ error: 'user_rejected', reason: 'cancelled' }),
        });
        assert.strictEqual(r.ok, false);
        assert.strictEqual(r.error, 'user_rejected');
        assert.strictEqual(httpCalls.length, 1, 'only the message-challenge HTTP call, no tx fallback');
    });

    // ── ensureVault ─────────────────────────────────────────────────────────
    console.log('\nensureVault:');
    triggerV2._resetCachesForTests();
    _resetHttp();
    _enqueue({ status: 200, data: { registered: true, vaultAddress: 'VaULTaddR111' } });
    await check('GET vault returns registered + caches', async () => {
        const r = await triggerV2.ensureVault(FIXTURE_PUBKEY, 'jwt');
        assert.strictEqual(r.ok, true);
        assert.strictEqual(r.vaultAddress, 'VaULTaddR111');
        // Second call must hit cache, not HTTP.
        const callsBefore = httpCalls.length;
        const r2 = await triggerV2.ensureVault(FIXTURE_PUBKEY, 'jwt');
        assert.strictEqual(r2.ok, true);
        assert.strictEqual(httpCalls.length, callsBefore);
    });

    triggerV2._resetCachesForTests();
    _resetHttp();
    _enqueue({ status: 200, data: { registered: false } });
    _enqueue({ status: 200, data: { vaultAddress: 'NewVaUlT22222' } });
    await check('GET unregistered → POST register → returns vault', async () => {
        const r = await triggerV2.ensureVault(FIXTURE_PUBKEY, 'jwt');
        assert.strictEqual(r.ok, true);
        assert.strictEqual(r.vaultAddress, 'NewVaUlT22222');
    });

    // ── depositCraft + submitCreateOrder happy path ─────────────────────────
    console.log('\ndepositCraft + submitCreateOrder:');
    triggerV2._resetCachesForTests();
    _resetHttp();
    _enqueue({ status: 200, data: { transaction: 'UNSIGNED_DEPOSIT', depositRequestId: 'dr-001' } });
    _enqueue({ status: 200, data: { id: 'order-001', txSignature: 'sig-001' } });
    await check('happy path: craft → submit → order id', async () => {
        const craft = await triggerV2.depositCraft({
            pubkey: FIXTURE_PUBKEY, token: 'jwt',
            inputMint: FIXTURE_INPUT_MINT, inputAmount: '1000000',
        });
        assert.strictEqual(craft.ok, true);
        assert.strictEqual(craft.depositRequestId, 'dr-001');
        const submit = await triggerV2.submitCreateOrder({
            token: 'jwt',
            recoveryContext: craft.recoveryContext,
            depositSignedTx: 'SIGNED_DEPOSIT',
            order: {
                inputMint: FIXTURE_INPUT_MINT, inputAmount: '1000000',
                outputMint: FIXTURE_OUTPUT_MINT, triggerPriceUsd: 50,
                triggerCondition: 'below', expiresAtMs: Date.now() + 86400_000,
            },
        });
        assert.strictEqual(submit.ok, true);
        assert.strictEqual(submit.id, 'order-001');
    });

    // ── submitCreateOrder: ambiguous + history-recovery ─────────────────────
    triggerV2._resetCachesForTests();
    _resetHttp();
    _enqueue({ status: 200, data: { transaction: 'UNSIGNED_DEPOSIT', depositRequestId: 'dr-002' } });
    _enqueue({ status: 500, data: { error: 'jupiter_internal' } });        // ambiguous create
    _enqueue({                                                                 // recovery /orders/history
        status: 200,
        data: { orders: [
            { id: 'order-recovered-002', status: 'pending_deposit',
              inputMint: FIXTURE_INPUT_MINT, inputAmount: '1000000',
              createdAt: new Date().toISOString() },
        ] },
    });
    await check('ambiguous (500) + history match → success with recovered flag', async () => {
        const craft = await triggerV2.depositCraft({
            pubkey: FIXTURE_PUBKEY, token: 'jwt',
            inputMint: FIXTURE_INPUT_MINT, inputAmount: '1000000',
        });
        // Use a stub setTimeout shim to skip the 5s recovery wait in tests
        const origSetTimeout = global.setTimeout;
        global.setTimeout = (fn) => origSetTimeout(fn, 0);
        try {
            const submit = await triggerV2.submitCreateOrder({
                token: 'jwt',
                recoveryContext: craft.recoveryContext,
                depositSignedTx: 'SIGNED_DEPOSIT',
                order: {
                    inputMint: FIXTURE_INPUT_MINT, inputAmount: '1000000',
                    outputMint: FIXTURE_OUTPUT_MINT, triggerPriceUsd: 50,
                    triggerCondition: 'below', expiresAtMs: Date.now() + 86400_000,
                },
            });
            assert.strictEqual(submit.ok, true);
            assert.strictEqual(submit.id, 'order-recovered-002');
            assert.strictEqual(submit.recovered, true);
        } finally {
            global.setTimeout = origSetTimeout;
        }
    });

    // ── submitCreateOrder: ambiguous + history miss → no-recovery ───────────
    triggerV2._resetCachesForTests();
    _resetHttp();
    _enqueue({ status: 200, data: { transaction: 'U', depositRequestId: 'dr-003' } });
    _enqueue({ status: 500, data: { error: 'oops' } });
    _enqueue({ status: 200, data: { orders: [] } });
    await check('ambiguous (500) + empty history → create_ambiguous_no_recovery', async () => {
        const craft = await triggerV2.depositCraft({
            pubkey: FIXTURE_PUBKEY, token: 'jwt',
            inputMint: FIXTURE_INPUT_MINT, inputAmount: '1000000',
        });
        const origSetTimeout = global.setTimeout;
        global.setTimeout = (fn) => origSetTimeout(fn, 0);
        try {
            const submit = await triggerV2.submitCreateOrder({
                token: 'jwt',
                recoveryContext: craft.recoveryContext,
                depositSignedTx: 'SIGNED_DEPOSIT',
                order: {
                    inputMint: FIXTURE_INPUT_MINT, inputAmount: '1000000',
                    outputMint: FIXTURE_OUTPUT_MINT, triggerPriceUsd: 50,
                    triggerCondition: 'below', expiresAtMs: Date.now() + 86400_000,
                },
            });
            assert.strictEqual(submit.ok, false);
            assert.strictEqual(submit.error, 'create_ambiguous_no_recovery');
            assert.ok(submit.recovery, 'should surface the recovery context');
            assert.strictEqual(submit.recovery.depositRequestId, 'dr-003');
        } finally {
            global.setTimeout = origSetTimeout;
        }
    });

    // ── cancelStep1 + confirmCancel ─────────────────────────────────────────
    console.log('\ncancelStep1 + confirmCancel:');
    triggerV2._resetCachesForTests();
    _resetHttp();
    _enqueue({ status: 200, data: { transaction: 'UNSIGNED_CANCEL', requestId: 'cr-001' } });
    _enqueue({ status: 200, data: { id: 'order-x', txSignature: 'cancel-sig-001' } });
    await check('two-step cancel happy path', async () => {
        const s1 = await triggerV2.cancelStep1({ orderId: 'order-x', pubkey: FIXTURE_PUBKEY, token: 'jwt' });
        assert.strictEqual(s1.ok, true);
        assert.strictEqual(s1.cancelRequestId, 'cr-001');
        const s2 = await triggerV2.confirmCancel({
            orderId: 'order-x', pubkey: FIXTURE_PUBKEY, token: 'jwt',
            signedTransaction: 'SIGNED_CANCEL', cancelRequestId: s1.cancelRequestId,
        });
        assert.strictEqual(s2.ok, true);
        assert.strictEqual(s2.txSignature, 'cancel-sig-001');
    });

    // ── 401 invalidates JWT cache ───────────────────────────────────────────
    triggerV2._resetCachesForTests();
    _resetHttp();
    // Prime the cache.
    _enqueue({ status: 200, data: { type: 'transaction', transaction: _buildAuthTx(FIXTURE_PUBKEY) } });
    _enqueue({ status: 200, data: { token: 'jwt-primed' } });
    await triggerV2.authenticate(FIXTURE_PUBKEY, {
        signTransaction: async () => 'X', signMessage: null,
    });
    // Now hit /orders/history with the cached token; 401 must invalidate.
    _enqueue({ status: 401, data: { error: 'expired' } });
    await check('401 from listOrders invalidates JWT', async () => {
        const r = await triggerV2.listOrders({ pubkey: FIXTURE_PUBKEY, token: 'jwt-primed' });
        assert.strictEqual(r.ok, false);
        assert.strictEqual(r.error, 'auth_expired');
        // Confirm cache was invalidated — next authenticate should NOT be cached.
        _enqueue({ status: 200, data: { type: 'transaction', transaction: _buildAuthTx(FIXTURE_PUBKEY) } });
        _enqueue({ status: 200, data: { token: 'jwt-fresh' } });
        const reauth = await triggerV2.authenticate(FIXTURE_PUBKEY, {
            signTransaction: async () => 'X', signMessage: null,
        });
        assert.strictEqual(reauth.ok, true);
        assert.notStrictEqual(reauth.cached, true);
        assert.strictEqual(reauth.token, 'jwt-fresh');
    });

    // ── Summary ─────────────────────────────────────────────────────────────
    if (failures > 0) {
        console.error(`\nFAILED: ${failures} test(s) failed`);
        process.exit(1);
    }
    console.log('\nAll Jupiter Trigger V2 adapter tests passed.');
})().catch((e) => {
    console.error('Test runner crashed:', e);
    process.exit(1);
});
