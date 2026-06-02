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

    // ── ensureVault (contract: GET /vault → vaultPubkey; GET /vault/register) ─
    console.log('\nensureVault:');
    triggerV2._resetCachesForTests();
    _resetHttp();
    _enqueue({ status: 200, data: { userPubkey: FIXTURE_PUBKEY, vaultPubkey: 'VauLTpk111', privyVaultId: 'pv1' } });
    await check('GET /vault returns vaultPubkey + caches', async () => {
        const r = await triggerV2.ensureVault(FIXTURE_PUBKEY, 'jwt');
        assert.strictEqual(r.ok, true);
        assert.strictEqual(r.vaultPubkey, 'VauLTpk111');
        // Second call must hit cache, not HTTP.
        const callsBefore = httpCalls.length;
        const r2 = await triggerV2.ensureVault(FIXTURE_PUBKEY, 'jwt');
        assert.strictEqual(r2.ok, true);
        assert.strictEqual(httpCalls.length, callsBefore);
    });

    // No vault yet → GET /vault 404, then idempotent GET /vault/register creates it.
    triggerV2._resetCachesForTests();
    _resetHttp();
    _enqueue({ status: 404, data: { error: 'Vault not found' } });
    _enqueue({ status: 200, data: { userPubkey: FIXTURE_PUBKEY, vaultPubkey: 'VauLTpk222', privyVaultId: 'pv2' } });
    await check('GET /vault 404 → GET /vault/register (idempotent) → vaultPubkey', async () => {
        const callsBefore = httpCalls.length;
        const r = await triggerV2.ensureVault(FIXTURE_PUBKEY, 'jwt');
        assert.strictEqual(r.ok, true);
        assert.strictEqual(r.vaultPubkey, 'VauLTpk222');
        assert.strictEqual(httpCalls.length, callsBefore + 2, 'GET /vault then GET /vault/register');
        // Both calls must be GET (no POST register).
        assert.ok(httpCalls.slice(-2).every(c => c.options.method === 'GET'), 'vault calls must be GET');
    });

    // ── depositCraft + submitCreateOrder happy path ─────────────────────────
    console.log('\ndepositCraft + submitCreateOrder:');
    triggerV2._resetCachesForTests();
    _resetHttp();
    _enqueue({ status: 200, data: { transaction: 'UNSIGNED_DEPOSIT', requestId: 'dr-001' } });
    _enqueue({ status: 200, data: { id: 'order-001', txSignature: 'sig-001' } });
    await check('happy path: craft → submit → order id', async () => {
        const craft = await triggerV2.depositCraft({
            pubkey: FIXTURE_PUBKEY, token: 'jwt',
            inputMint: FIXTURE_INPUT_MINT, outputMint: FIXTURE_OUTPUT_MINT, inputAmount: '1000000',
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
    _enqueue({ status: 200, data: { transaction: 'UNSIGNED_DEPOSIT', requestId: 'dr-002' } });
    _enqueue({ status: 500, data: { error: 'jupiter_internal' } });        // ambiguous create
    _enqueue({                                                                 // recovery /orders/history
        status: 200,
        data: { orders: [
            { id: 'order-recovered-002', orderState: 'pending_deposit',
              inputMint: FIXTURE_INPUT_MINT, outputMint: FIXTURE_OUTPUT_MINT,
              initialInputAmount: '1000000', remainingInputAmount: '1000000',
              createdAt: new Date().toISOString(),
              events: [{ type: 'deposit', txSignature: 'deposit-sig-recovered', state: 'success' }] },
        ] },
    });
    await check('ambiguous (500) + history match → success with recovered flag', async () => {
        const craft = await triggerV2.depositCraft({
            pubkey: FIXTURE_PUBKEY, token: 'jwt',
            inputMint: FIXTURE_INPUT_MINT, outputMint: FIXTURE_OUTPUT_MINT, inputAmount: '1000000',
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
    _enqueue({ status: 200, data: { transaction: 'U', requestId: 'dr-003' } });
    _enqueue({ status: 500, data: { error: 'oops' } });
    _enqueue({ status: 200, data: { orders: [] } });
    await check('ambiguous (500) + empty history → create_ambiguous_no_recovery', async () => {
        const craft = await triggerV2.depositCraft({
            pubkey: FIXTURE_PUBKEY, token: 'jwt',
            inputMint: FIXTURE_INPUT_MINT, outputMint: FIXTURE_OUTPUT_MINT, inputAmount: '1000000',
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

    // ── Blind-sign guard: byte-accurate parser tests (BAT-697 review pass) ──
    //
    // The fixtures above use literal base58 strings whose decode is padding-
    // sensitive. This block instead drives the parser with REAL 32-byte keys
    // whose base58 form is produced by the adapter's own _base58Encode, so the
    // fee-payer comparison round-trips exactly. This is what lets us test the
    // ACCEPTANCE path (a guard that rejected everything would pass the older
    // rejection-only tests).
    console.log('\nblind-sign parser (byte-accurate):');

    const _B58 = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';
    function b58decodeStrict(s) {
        let n = 0n;
        for (const c of s) {
            const i = _B58.indexOf(c);
            if (i < 0) throw new Error('bad b58 char: ' + c);
            n = n * 58n + BigInt(i);
        }
        const out = [];
        while (n > 0n) { out.push(Number(n & 0xffn)); n >>= 8n; }
        for (const c of s) { if (c !== '1') break; out.push(0); }
        return Buffer.from(out.reverse());
    }
    function cu16(n) {
        const out = []; let v = n;
        do { let b = v & 0x7f; v >>= 7; if (v > 0) b |= 0x80; out.push(b); } while (v > 0);
        return Buffer.from(out);
    }
    function key32(seed) {
        const b = Buffer.alloc(32);
        for (let i = 0; i < 32; i++) b[i] = (seed + i * 7 + 1) & 0xff;
        return b;
    }
    // accounts: array of 32-byte Buffers (idx 0 = fee payer). instrProgramIdx:
    // account index each instruction targets. versioned: prefix v0 (0x80) byte.
    function buildTxBytes({ accounts, instrProgramIdx, versioned = false, dataLen = 4 }) {
        const parts = [];
        if (versioned) parts.push(Buffer.from([0x80]));
        parts.push(Buffer.from([1, 0, 0]));            // header
        parts.push(cu16(accounts.length));             // account count (compact-u16)
        for (const a of accounts) parts.push(a);
        parts.push(Buffer.alloc(32));                  // recent blockhash
        parts.push(cu16(1));                           // 1 instruction
        parts.push(Buffer.from([instrProgramIdx]));    // program id index (idx < 128 → 1 byte)
        parts.push(cu16(0));                           // 0 accounts in instruction
        parts.push(cu16(dataLen));                     // data length
        parts.push(Buffer.alloc(dataLen, 0x61));       // data bytes
        const message = Buffer.concat(parts);
        return Buffer.concat([Buffer.from([1]), Buffer.alloc(64), message]).toString('base64');
    }

    const MEMO_BYTES = b58decodeStrict(triggerV2.MEMO_PROGRAM_V2);
    const SYS_BYTES = Buffer.alloc(32); // SystemProgram = all-zero pubkey
    const PAYER_BUF = key32(7);
    const PAYER_B58 = triggerV2._base58Encode(PAYER_BUF);
    const OTHER_B58 = triggerV2._base58Encode(key32(200));

    await check('base58 round-trip: _base58Encode(decode(MEMO)) === MEMO', async () => {
        assert.strictEqual(MEMO_BYTES.length, 32, 'memo program must decode to 32 bytes');
        assert.strictEqual(triggerV2._base58Encode(MEMO_BYTES), triggerV2.MEMO_PROGRAM_V2);
    });

    await check('ACCEPTS a real Memo-only tx whose fee payer matches', async () => {
        const tx = buildTxBytes({ accounts: [PAYER_BUF, MEMO_BYTES], instrProgramIdx: 1 });
        const r = triggerV2._validateAuthTransaction(tx, PAYER_B58);
        assert.strictEqual(r.ok, true, `expected accept, got: ${JSON.stringify(r)}`);
    });

    await check('REJECTS Memo-only tx when fee payer does not match expected pubkey', async () => {
        const tx = buildTxBytes({ accounts: [PAYER_BUF, MEMO_BYTES], instrProgramIdx: 1 });
        const r = triggerV2._validateAuthTransaction(tx, OTHER_B58);
        assert.strictEqual(r.ok, false);
        assert.strictEqual(r.error, 'auth_tx_invalid');
        assert.ok(/fee payer/i.test(r.reason), `expected fee-payer reason, got: ${r.reason}`);
    });

    await check('REJECTS tx referencing SystemProgram (Transfer) — value-moving guard', async () => {
        const tx = buildTxBytes({ accounts: [PAYER_BUF, SYS_BYTES], instrProgramIdx: 1 });
        const r = triggerV2._validateAuthTransaction(tx, PAYER_B58);
        assert.strictEqual(r.ok, false);
        assert.strictEqual(r.error, 'auth_tx_invalid');
    });

    // Multi-instruction builder for the Memo+ComputeBudget case — Jupiter's
    // REAL challenge (verified live 2026-05-29) bundles a ComputeBudget instr
    // alongside the Memo. A Memo-only guard would reject the real challenge.
    const COMPUTE_BUDGET_BYTES = b58decodeStrict('ComputeBudget111111111111111111111111111111');
    function buildMultiInstrTx({ accounts, instrIdxs, versioned = false }) {
        const parts = [];
        if (versioned) parts.push(Buffer.from([0x80]));
        parts.push(Buffer.from([1, 0, 0]));
        parts.push(cu16(accounts.length));
        for (const a of accounts) parts.push(a);
        parts.push(Buffer.alloc(32)); // blockhash
        parts.push(cu16(instrIdxs.length));
        for (const idx of instrIdxs) {
            parts.push(Buffer.from([idx])); // program id index
            parts.push(cu16(0));            // 0 accounts
            parts.push(cu16(2));            // data len
            parts.push(Buffer.from([0x01, 0x02]));
        }
        const message = Buffer.concat(parts);
        return Buffer.concat([Buffer.from([1]), Buffer.alloc(64), message]).toString('base64');
    }

    await check('ACCEPTS Memo + ComputeBudget (Jupiter real-challenge shape)', async () => {
        const tx = buildMultiInstrTx({ accounts: [PAYER_BUF, MEMO_BYTES, COMPUTE_BUDGET_BYTES], instrIdxs: [2, 1] });
        const r = triggerV2._validateAuthTransaction(tx, PAYER_B58);
        assert.strictEqual(r.ok, true, `expected accept, got: ${JSON.stringify(r)}`);
    });

    // PR #388 R2 finding: ComputeBudget-only txs were in the program
    // allowlist but contain no challenge payload to commit to. Signing one
    // would be signing nothing meaningful. Must require ≥1 Memo instruction.
    await check('REJECTS ComputeBudget-only tx (no Memo — no challenge payload)', async () => {
        const tx = buildMultiInstrTx({ accounts: [PAYER_BUF, COMPUTE_BUDGET_BYTES], instrIdxs: [1] });
        const r = triggerV2._validateAuthTransaction(tx, PAYER_B58);
        assert.strictEqual(r.ok, false, 'a ComputeBudget-only tx must NOT pass the blind-sign guard');
        assert.strictEqual(r.error, 'auth_tx_invalid');
        assert.ok(/Memo/i.test(r.reason || ''), `expected Memo-related reason, got: ${r.reason}`);
    });
    await check('REJECTS multi-ComputeBudget-only tx (two ComputeBudgets, still no Memo)', async () => {
        const tx = buildMultiInstrTx({ accounts: [PAYER_BUF, COMPUTE_BUDGET_BYTES], instrIdxs: [1, 1] });
        const r = triggerV2._validateAuthTransaction(tx, PAYER_B58);
        assert.strictEqual(r.ok, false);
        assert.strictEqual(r.error, 'auth_tx_invalid');
    });

    // PR #388 R7 finding: a tx with a Memo instruction whose data length is
    // 0 commits to NO challenge payload — the blind-sign guard is moot.
    // Memo must carry actual bytes. Build a tx with the same structure as the
    // happy-path multi-instr but force the memo's data length to zero.
    function buildEmptyMemoTx({ accounts, instrIdxs }) {
        const parts = [];
        parts.push(Buffer.from([1, 0, 0]));
        parts.push(cu16(accounts.length));
        for (const a of accounts) parts.push(a);
        parts.push(Buffer.alloc(32)); // blockhash
        parts.push(cu16(instrIdxs.length));
        for (const idx of instrIdxs) {
            parts.push(Buffer.from([idx]));
            parts.push(cu16(0)); // 0 accounts
            parts.push(cu16(0)); // ZERO data — the regression
        }
        const message = Buffer.concat(parts);
        return Buffer.concat([Buffer.from([1]), Buffer.alloc(64), message]).toString('base64');
    }
    await check('R7 REJECTS empty-Memo tx (Memo present but zero-byte data)', async () => {
        const tx = buildEmptyMemoTx({ accounts: [PAYER_BUF, MEMO_BYTES], instrIdxs: [1] });
        const r = triggerV2._validateAuthTransaction(tx, PAYER_B58);
        assert.strictEqual(r.ok, false, 'a Memo with zero-byte data must NOT pass the blind-sign guard');
        assert.strictEqual(r.error, 'auth_tx_invalid');
        assert.ok(/empty|zero-byte/i.test(r.reason || ''),
            `expected empty/zero-byte reason, got: ${r.reason}`);
    });
    await check('R7 REJECTS empty-Memo + ComputeBudget combo (still no payload to commit)', async () => {
        const tx = buildEmptyMemoTx({ accounts: [PAYER_BUF, MEMO_BYTES, COMPUTE_BUDGET_BYTES], instrIdxs: [2, 1] });
        const r = triggerV2._validateAuthTransaction(tx, PAYER_B58);
        assert.strictEqual(r.ok, false, 'empty-Memo cannot be salvaged by a sibling ComputeBudget instruction');
        assert.strictEqual(r.error, 'auth_tx_invalid');
    });

    // ── PR #388 R10: ComputeBudget priority-fee cap ─────────────────────────
    // Reviewer concern: pre-fix, ComputeBudget instructions were whitelisted
    // without decoding their data. A hostile/compromised challenge endpoint
    // could include a SetComputeUnitPrice with u64::MAX micro_lamports/CU and
    // drain the fee payer's SOL when the signed auth tx is broadcast. The
    // burner path zero-cap-signs auth challenges silently, so this was a
    // real fee-drain vector even with TLS to Jupiter. Post-fix: ComputeBudget
    // data is decoded and SetComputeUnitLimit / SetComputeUnitPrice are
    // capped before the auth tx is accepted.
    await check('R10 _validateComputeBudgetInstr accepts empty data (no-op ix)', async () => {
        const r = triggerV2._validateComputeBudgetInstr(Buffer.alloc(0));
        assert.strictEqual(r.ok, true);
    });
    await check('R10 _validateComputeBudgetInstr accepts SetComputeUnitLimit at cap', async () => {
        const data = Buffer.alloc(5);
        data[0] = 0x02;
        data.writeUInt32LE(triggerV2._AUTH_MAX_CU_LIMIT, 1);
        assert.strictEqual(triggerV2._validateComputeBudgetInstr(data).ok, true);
    });
    await check('R10 _validateComputeBudgetInstr REJECTS SetComputeUnitLimit above cap', async () => {
        const data = Buffer.alloc(5);
        data[0] = 0x02;
        data.writeUInt32LE(triggerV2._AUTH_MAX_CU_LIMIT + 1, 1);
        const r = triggerV2._validateComputeBudgetInstr(data);
        assert.strictEqual(r.ok, false);
        assert.ok(/SetComputeUnitLimit/i.test(r.reason || ''));
    });
    await check('R10 _validateComputeBudgetInstr accepts SetComputeUnitPrice at cap', async () => {
        const data = Buffer.alloc(9);
        data[0] = 0x03;
        const cap = triggerV2._AUTH_MAX_CU_PRICE_MICROLAMPORTS;
        data.writeUInt32LE(Number(cap & 0xFFFFFFFFn), 1);
        data.writeUInt32LE(Number((cap >> 32n) & 0xFFFFFFFFn), 5);
        assert.strictEqual(triggerV2._validateComputeBudgetInstr(data).ok, true);
    });
    // PR #393 / BAT-995 device test 2026-06-02: Jupiter's real auth tx
    // observed using SetComputeUnitPrice=1_000_000 micro_lamports/CU. The
    // original PR #388 R10 cap of 10_000 rejected this. Cap was bumped to
    // 2_000_000 (2× observed). Lock in the "Jupiter's observed real value
    // is accepted" contract so a future tightening doesn't silently
    // re-break the device path.
    await check('R10/R12 accepts Jupiter\'s observed mainnet CU price of 1_000_000 micro_lamports/CU', async () => {
        const data = Buffer.alloc(9);
        data[0] = 0x03;
        // Observed at 2026-06-02 in Beka's Seeker logs:
        //   "ComputeBudget SetComputeUnitPrice=1000000 exceeds auth-tx cap 10000"
        data.writeUInt32LE(1_000_000, 1);
        data.writeUInt32LE(0, 5);
        const r = triggerV2._validateComputeBudgetInstr(data);
        assert.strictEqual(r.ok, true, 'must accept Jupiter\'s observed real mainnet value (1M micro_lamports/CU)');
    });
    await check('R10 _validateComputeBudgetInstr REJECTS SetComputeUnitPrice at u64::MAX (the attack value)', async () => {
        const data = Buffer.alloc(9);
        data[0] = 0x03;
        data.writeUInt32LE(0xFFFFFFFF, 1);
        data.writeUInt32LE(0xFFFFFFFF, 5);
        const r = triggerV2._validateComputeBudgetInstr(data);
        assert.strictEqual(r.ok, false, 'u64::MAX micro_lamports/CU was the unbounded fee-drain vector pre-fix');
        assert.ok(/SetComputeUnitPrice/i.test(r.reason || ''));
    });
    await check('R10 _validateComputeBudgetInstr REJECTS truncated SetComputeUnitPrice (8 bytes instead of 9)', async () => {
        const data = Buffer.from([0x03, 0, 0, 0, 0, 0, 0, 0]); // tag + 7 bytes, need 8
        const r = triggerV2._validateComputeBudgetInstr(data);
        assert.strictEqual(r.ok, false);
        assert.ok(/truncated/i.test(r.reason || ''));
    });
    await check('R10 _validateComputeBudgetInstr accepts non-fee-affecting tags (HeapFrame, LoadedAccountsDataSizeLimit)', async () => {
        // 0x01 RequestHeapFrame, 0x04 SetLoadedAccountsDataSizeLimit
        // Neither drains SOL → accept silently.
        for (const tag of [0x01, 0x04]) {
            const r = triggerV2._validateComputeBudgetInstr(Buffer.from([tag, 0, 0, 0, 0]));
            assert.strictEqual(r.ok, true, `tag 0x0${tag} (no fee impact) should be accepted`);
        }
    });

    // PR #388 R11 finding: tag 0x00 (RequestUnitsDeprecated) carries a
    // u32 `additional_fee` lamport field. Pre-R11 it was accepted as
    // "unknown safe" — that left a SOL-drain path the same magnitude as
    // the unbounded SetComputeUnitPrice path. Now decoded + capped.
    await check('R11 _validateComputeBudgetInstr accepts RequestUnitsDeprecated with zero additional_fee', async () => {
        // tag(1) + units(4) + additional_fee(4) = 9 bytes
        const data = Buffer.alloc(9);
        data[0] = 0x00;
        data.writeUInt32LE(150_000, 1);  // units, under cap
        data.writeUInt32LE(0, 5);        // additional_fee = 0
        assert.strictEqual(triggerV2._validateComputeBudgetInstr(data).ok, true);
    });
    await check('R11 _validateComputeBudgetInstr accepts RequestUnitsDeprecated with additional_fee at cap', async () => {
        const data = Buffer.alloc(9);
        data[0] = 0x00;
        data.writeUInt32LE(triggerV2._AUTH_MAX_CU_LIMIT, 1);
        data.writeUInt32LE(triggerV2._AUTH_MAX_ADDITIONAL_FEE_LAMPORTS, 5);
        assert.strictEqual(triggerV2._validateComputeBudgetInstr(data).ok, true);
    });
    await check('R11 _validateComputeBudgetInstr REJECTS RequestUnitsDeprecated with additional_fee above cap (the attack value)', async () => {
        const data = Buffer.alloc(9);
        data[0] = 0x00;
        data.writeUInt32LE(150_000, 1);
        data.writeUInt32LE(0xFFFFFFFF, 5); // u32::MAX lamports ≈ 4.29 SOL drain pre-fix
        const r = triggerV2._validateComputeBudgetInstr(data);
        assert.strictEqual(r.ok, false, 'u32::MAX additional_fee was the deprecated fee-drain vector');
        assert.ok(/additional_fee/i.test(r.reason || ''));
    });
    await check('R11 _validateComputeBudgetInstr REJECTS RequestUnitsDeprecated with units above cap', async () => {
        const data = Buffer.alloc(9);
        data[0] = 0x00;
        data.writeUInt32LE(triggerV2._AUTH_MAX_CU_LIMIT + 1, 1);
        data.writeUInt32LE(0, 5);
        const r = triggerV2._validateComputeBudgetInstr(data);
        assert.strictEqual(r.ok, false);
        assert.ok(/units/i.test(r.reason || ''));
    });
    await check('R11 _validateComputeBudgetInstr REJECTS truncated RequestUnitsDeprecated (5 bytes instead of 9)', async () => {
        const data = Buffer.from([0x00, 0, 0, 0, 0]); // tag + units only, missing additional_fee
        const r = triggerV2._validateComputeBudgetInstr(data);
        assert.strictEqual(r.ok, false);
        assert.ok(/truncated/i.test(r.reason || ''));
    });

    // Integration: ComputeBudget cap fires from within _validateAuthTransaction.
    function buildTxWithComputeBudget({ cbTag, cbValue }) {
        // Build a tx with Memo (non-empty) + ComputeBudget (custom payload).
        const accounts = [PAYER_BUF, MEMO_BYTES, COMPUTE_BUDGET_BYTES];
        const memoData = Buffer.from('challenge-payload');
        const cbData = (() => {
            if (cbTag === 0x03) {
                const buf = Buffer.alloc(9);
                buf[0] = 0x03;
                buf.writeUInt32LE(Number(cbValue & 0xFFFFFFFFn), 1);
                buf.writeUInt32LE(Number((cbValue >> 32n) & 0xFFFFFFFFn), 5);
                return buf;
            }
            // 0x02 SetComputeUnitLimit (u32)
            const buf = Buffer.alloc(5);
            buf[0] = 0x02;
            buf.writeUInt32LE(Number(cbValue), 1);
            return buf;
        })();
        const parts = [];
        parts.push(Buffer.from([1, 0, 0]));
        parts.push(cu16(accounts.length));
        for (const a of accounts) parts.push(a);
        parts.push(Buffer.alloc(32)); // blockhash
        parts.push(cu16(2));          // 2 instructions
        // Instruction 0: memo (program idx 1)
        parts.push(Buffer.from([1]));
        parts.push(cu16(0));
        parts.push(cu16(memoData.length));
        parts.push(memoData);
        // Instruction 1: compute budget (program idx 2)
        parts.push(Buffer.from([2]));
        parts.push(cu16(0));
        parts.push(cu16(cbData.length));
        parts.push(cbData);
        const message = Buffer.concat(parts);
        return Buffer.concat([Buffer.from([1]), Buffer.alloc(64), message]).toString('base64');
    }
    await check('R10 integration: Memo + ComputeBudget at u64::MAX CU price is REJECTED', async () => {
        const tx = buildTxWithComputeBudget({ cbTag: 0x03, cbValue: (1n << 64n) - 1n });
        const r = triggerV2._validateAuthTransaction(tx, PAYER_B58);
        assert.strictEqual(r.ok, false, 'fee-drain attack via SetComputeUnitPrice=MAX must be blocked');
        assert.strictEqual(r.error, 'auth_tx_invalid');
        assert.ok(/SetComputeUnitPrice|ComputeBudget/i.test(r.reason || ''),
            `expected ComputeBudget-related reason, got: ${r.reason}`);
    });
    await check('R10 integration: Memo + reasonable ComputeBudget (CU price 5_000) is ACCEPTED', async () => {
        const tx = buildTxWithComputeBudget({ cbTag: 0x03, cbValue: 5_000n });
        const r = triggerV2._validateAuthTransaction(tx, PAYER_B58);
        assert.strictEqual(r.ok, true, `expected accept under cap, got: ${JSON.stringify(r)}`);
    });

    await check('REJECTS Memo + SystemProgram even when a Memo instr is present', async () => {
        const tx = buildMultiInstrTx({ accounts: [PAYER_BUF, MEMO_BYTES, SYS_BYTES], instrIdxs: [1, 2] });
        const r = triggerV2._validateAuthTransaction(tx, PAYER_B58);
        assert.strictEqual(r.ok, false, 'a value-moving instr alongside a Memo must still be rejected');
        assert.strictEqual(r.error, 'auth_tx_invalid');
    });

    await check('ACCEPTS a v0 versioned (0x80-prefixed) Memo-only tx', async () => {
        const tx = buildTxBytes({ accounts: [PAYER_BUF, MEMO_BYTES], instrProgramIdx: 1, versioned: true });
        const r = triggerV2._validateAuthTransaction(tx, PAYER_B58);
        assert.strictEqual(r.ok, true, `expected v0 accept, got: ${JSON.stringify(r)}`);
    });

    // Multi-byte compact-u16: account counts ≥128 encode to 2 bytes. Direct
    // unit test of the reader (the funds-safety parser depends on it).
    await check('_readCompactU16 single-byte values', async () => {
        assert.deepStrictEqual(triggerV2._readCompactU16(Buffer.from([0x00]), 0), { value: 0, offset: 1 });
        assert.deepStrictEqual(triggerV2._readCompactU16(Buffer.from([0x7f]), 0), { value: 127, offset: 1 });
    });
    await check('_readCompactU16 multi-byte values (128, 300, 16383)', async () => {
        // 128 = 0x80,0x01 ; 300 = 0xAC,0x02 ; 16383 = 0xFF,0x7F
        assert.deepStrictEqual(triggerV2._readCompactU16(Buffer.from([0x80, 0x01]), 0), { value: 128, offset: 2 });
        assert.deepStrictEqual(triggerV2._readCompactU16(Buffer.from([0xAC, 0x02]), 0), { value: 300, offset: 2 });
        assert.deepStrictEqual(triggerV2._readCompactU16(Buffer.from([0xFF, 0x7F]), 0), { value: 16383, offset: 2 });
    });
    await check('_readCompactU16 honors offset + rejects truncated continuation', async () => {
        // value 300 starting at offset 2 in a longer buffer
        assert.deepStrictEqual(triggerV2._readCompactU16(Buffer.from([0xFF, 0xFF, 0xAC, 0x02]), 2), { value: 300, offset: 4 });
        // continuation bit set but buffer ends → malformed → null
        assert.strictEqual(triggerV2._readCompactU16(Buffer.from([0x80]), 0), null);
    });
    await check('_readCompactU16 rejects 3-byte sequence (strict 2-byte cap)', async () => {
        // Pre-fix: this returned 32767 (silent u16 overflow risk).
        // Post-fix: gate-at-top of loop refuses to read a 3rd byte.
        assert.strictEqual(triggerV2._readCompactU16(Buffer.from([0xFF, 0xFF, 0x01]), 0), null);
        assert.strictEqual(triggerV2._readCompactU16(Buffer.from([0x80, 0x80, 0x00]), 0), null);
    });
    await check('parser handles a tx with a multi-byte account count (130 accounts)', async () => {
        // 130 accounts: payer + memo + 128 filler. instruction targets memo (idx 1).
        const accounts = [PAYER_BUF, MEMO_BYTES];
        for (let i = 0; i < 128; i++) accounts.push(key32(50 + i));
        const tx = buildTxBytes({ accounts, instrProgramIdx: 1 });
        const r = triggerV2._validateAuthTransaction(tx, PAYER_B58);
        assert.strictEqual(r.ok, true, `expected accept with 130 accounts, got: ${JSON.stringify(r)}`);
    });

    // ── recovery hardening (real-API row shape, verified live 2026-05-30) ──
    // History rows use orderState/initialInputAmount/events[]; NO status,
    // vaultState, inputAmount, or depositRequestId fields on the row.
    console.log('\nrecovery hardening (real-API row shape):');

    // (a) Terminal-state orders MUST NOT be reported as recovered.
    triggerV2._resetCachesForTests();
    _resetHttp();
    _enqueue({ status: 200, data: { transaction: 'U', requestId: 'dr-fail' } });
    _enqueue({ status: 500, data: { error: 'oops' } });
    _enqueue({ status: 200, data: { orders: [
        { id: 'dead-order', orderState: 'cancelled', rawState: 'cancelled',
          inputMint: FIXTURE_INPUT_MINT,
          initialInputAmount: '1000000', remainingInputAmount: '1000000',
          createdAt: new Date().toISOString() },
    ] } });
    await check('terminal orderState (cancelled) is NOT recovered', async () => {
        const craft = await triggerV2.depositCraft({
            pubkey: FIXTURE_PUBKEY, token: 'jwt',
            inputMint: FIXTURE_INPUT_MINT, outputMint: FIXTURE_OUTPUT_MINT, inputAmount: '1000000',
        });
        const origSetTimeout = global.setTimeout;
        global.setTimeout = (fn) => origSetTimeout(fn, 0);
        try {
            const submit = await triggerV2.submitCreateOrder({
                token: 'jwt', recoveryContext: craft.recoveryContext, depositSignedTx: 'SIGNED',
                order: { inputMint: FIXTURE_INPUT_MINT, inputAmount: '1000000',
                    outputMint: FIXTURE_OUTPUT_MINT, triggerPriceUsd: 50,
                    triggerCondition: 'below', expiresAtMs: Date.now() + 86400_000 },
            });
            assert.strictEqual(submit.ok, false, 'a dead order must not be reported as success');
            assert.strictEqual(submit.error, 'create_ambiguous_no_recovery');
        } finally { global.setTimeout = origSetTimeout; }
    });

    // (b) Active order matches on real fields (orderState/initialInputAmount/events);
    // recovered result surfaces the deposit-event txSignature.
    triggerV2._resetCachesForTests();
    _resetHttp();
    _enqueue({ status: 200, data: { transaction: 'U', requestId: 'dr-active' } });
    _enqueue({ status: 500, data: { error: 'oops' } });
    _enqueue({ status: 200, data: { orders: [
        { id: 'our-order', orderState: 'active', rawState: 'active',
          inputMint: FIXTURE_INPUT_MINT, outputMint: FIXTURE_OUTPUT_MINT,
          initialInputAmount: '1000000', remainingInputAmount: '1000000',
          createdAt: new Date().toISOString(),
          events: [{ type: 'deposit', txSignature: 'real-deposit-sig', state: 'success' }] },
    ] } });
    await check('active order matched on real row shape + deposit txSig surfaced', async () => {
        const craft = await triggerV2.depositCraft({
            pubkey: FIXTURE_PUBKEY, token: 'jwt',
            inputMint: FIXTURE_INPUT_MINT, outputMint: FIXTURE_OUTPUT_MINT, inputAmount: '1000000',
        });
        const origSetTimeout = global.setTimeout;
        global.setTimeout = (fn) => origSetTimeout(fn, 0);
        try {
            const submit = await triggerV2.submitCreateOrder({
                token: 'jwt', recoveryContext: craft.recoveryContext, depositSignedTx: 'SIGNED',
                order: { inputMint: FIXTURE_INPUT_MINT, inputAmount: '1000000',
                    outputMint: FIXTURE_OUTPUT_MINT, triggerPriceUsd: 50,
                    triggerCondition: 'below', expiresAtMs: Date.now() + 86400_000 },
            });
            assert.strictEqual(submit.ok, true);
            assert.strictEqual(submit.id, 'our-order');
            assert.strictEqual(submit.recovered, true);
            assert.strictEqual(submit.txSignature, 'real-deposit-sig', 'should surface deposit txSignature from events[]');
        } finally { global.setTimeout = origSetTimeout; }
    });

    // (c) Stale identical order (outside the time window) is NOT matched.
    triggerV2._resetCachesForTests();
    _resetHttp();
    _enqueue({ status: 200, data: { transaction: 'U', requestId: 'dr-stale' } });
    _enqueue({ status: 500, data: { error: 'oops' } });
    // An order from 10 minutes ago with identical mint+amount must not be falsely
    // matched as "ours" — the tight time window is the only safeguard now.
    _enqueue({ status: 200, data: { orders: [
        { id: 'stale-other-order', orderState: 'active', rawState: 'active',
          inputMint: FIXTURE_INPUT_MINT, outputMint: FIXTURE_OUTPUT_MINT,
          initialInputAmount: '1000000', remainingInputAmount: '1000000',
          createdAt: new Date(Date.now() - 10 * 60 * 1000).toISOString() },
    ] } });
    await check('stale same-amount order outside time window is NOT matched', async () => {
        const craft = await triggerV2.depositCraft({
            pubkey: FIXTURE_PUBKEY, token: 'jwt',
            inputMint: FIXTURE_INPUT_MINT, outputMint: FIXTURE_OUTPUT_MINT, inputAmount: '1000000',
        });
        const origSetTimeout = global.setTimeout;
        global.setTimeout = (fn) => origSetTimeout(fn, 0);
        try {
            const submit = await triggerV2.submitCreateOrder({
                token: 'jwt', recoveryContext: craft.recoveryContext, depositSignedTx: 'SIGNED',
                order: { inputMint: FIXTURE_INPUT_MINT, inputAmount: '1000000',
                    outputMint: FIXTURE_OUTPUT_MINT, triggerPriceUsd: 50,
                    triggerCondition: 'below', expiresAtMs: Date.now() + 86400_000 },
            });
            assert.strictEqual(submit.ok, false, 'old unrelated order must not be falsely matched');
            assert.strictEqual(submit.error, 'create_ambiguous_no_recovery');
        } finally { global.setTimeout = origSetTimeout; }
    });

    // (d) PR #388 R2: a live order with the SAME inputMint + initialInputAmount
    // but DIFFERENT outputMint must NOT false-match. Pre-fix, the heuristic
    // only checked input mint + amount, so a wallet running two limit orders
    // on the same input token could see recovery pick the wrong order id.
    triggerV2._resetCachesForTests();
    _resetHttp();
    _enqueue({ status: 200, data: { transaction: 'U', requestId: 'dr-discrim' } });
    _enqueue({ status: 500, data: { error: 'oops' } });
    const OTHER_OUTPUT_MINT = 'Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB'; // USDT
    _enqueue({ status: 200, data: { orders: [
        { id: 'other-output-order', orderState: 'active', rawState: 'active',
          inputMint: FIXTURE_INPUT_MINT, outputMint: OTHER_OUTPUT_MINT,
          initialInputAmount: '1000000', remainingInputAmount: '1000000',
          createdAt: new Date().toISOString() },
    ] } });
    await check('different-outputMint same-amount order is NOT matched (PR #388 R2)', async () => {
        const craft = await triggerV2.depositCraft({
            pubkey: FIXTURE_PUBKEY, token: 'jwt',
            inputMint: FIXTURE_INPUT_MINT, outputMint: FIXTURE_OUTPUT_MINT, inputAmount: '1000000',
        });
        const origSetTimeout = global.setTimeout;
        global.setTimeout = (fn) => origSetTimeout(fn, 0);
        try {
            const submit = await triggerV2.submitCreateOrder({
                token: 'jwt', recoveryContext: craft.recoveryContext, depositSignedTx: 'SIGNED',
                order: { inputMint: FIXTURE_INPUT_MINT, inputAmount: '1000000',
                    outputMint: FIXTURE_OUTPUT_MINT, triggerPriceUsd: 50,
                    triggerCondition: 'below', expiresAtMs: Date.now() + 86400_000 },
            });
            assert.strictEqual(submit.ok, false, 'order with different outputMint must NOT be matched as ours');
            assert.strictEqual(submit.error, 'create_ambiguous_no_recovery');
        } finally { global.setTimeout = origSetTimeout; }
    });

    // ── submitCreateOrder: 2xx-with-id acceptance + 2xx-without-id recovery ─
    // Pre-fix the success gate demanded status===200 exactly; a 201/202 with
    // a valid order id silently fell into create_failed even though the order
    // was live on-chain — funds/cap inconsistency.
    console.log('\nsubmitCreateOrder 2xx handling (BAT-697 double-check):');
    triggerV2._resetCachesForTests();
    _resetHttp();
    _enqueue({ status: 200, data: { transaction: 'U', requestId: 'dr-201' } });
    _enqueue({ status: 201, data: { id: 'order-201', txSignature: 'sig-201' } });
    await check('HTTP 201 with id is accepted as success', async () => {
        const craft = await triggerV2.depositCraft({
            pubkey: FIXTURE_PUBKEY, token: 'jwt',
            inputMint: FIXTURE_INPUT_MINT, outputMint: FIXTURE_OUTPUT_MINT, inputAmount: '1000000',
        });
        const submit = await triggerV2.submitCreateOrder({
            token: 'jwt', recoveryContext: craft.recoveryContext, depositSignedTx: 'SIGNED',
            order: { inputMint: FIXTURE_INPUT_MINT, inputAmount: '1000000',
                outputMint: FIXTURE_OUTPUT_MINT, triggerPriceUsd: 50,
                triggerCondition: 'below', expiresAtMs: Date.now() + 86400_000 },
        });
        assert.strictEqual(submit.ok, true, 'a 201 + id must be a success, not a hidden failure');
        assert.strictEqual(submit.id, 'order-201');
    });

    triggerV2._resetCachesForTests();
    _resetHttp();
    _enqueue({ status: 200, data: { transaction: 'U', requestId: 'dr-202' } });
    _enqueue({ status: 202, data: { /* no id */ } });
    _enqueue({ status: 200, data: { orders: [] } });
    await check('HTTP 202 without id triggers recovery (ambiguous)', async () => {
        const craft = await triggerV2.depositCraft({
            pubkey: FIXTURE_PUBKEY, token: 'jwt',
            inputMint: FIXTURE_INPUT_MINT, outputMint: FIXTURE_OUTPUT_MINT, inputAmount: '1000000',
        });
        const origSetTimeout = global.setTimeout;
        global.setTimeout = (fn) => origSetTimeout(fn, 0);
        try {
            const submit = await triggerV2.submitCreateOrder({
                token: 'jwt', recoveryContext: craft.recoveryContext, depositSignedTx: 'SIGNED',
                order: { inputMint: FIXTURE_INPUT_MINT, inputAmount: '1000000',
                    outputMint: FIXTURE_OUTPUT_MINT, triggerPriceUsd: 50,
                    triggerCondition: 'below', expiresAtMs: Date.now() + 86400_000 },
            });
            assert.strictEqual(submit.ok, false);
            assert.strictEqual(submit.error, 'create_ambiguous_no_recovery');
        } finally { global.setTimeout = origSetTimeout; }
    });

    // ── Recovery: 401 from /orders/history invalidates JWT ──────────────────
    triggerV2._resetCachesForTests();
    _resetHttp();
    // Prime the JWT cache by running authenticate.
    _enqueue({ status: 200, data: { type: 'transaction', transaction: _buildAuthTx(FIXTURE_PUBKEY) } });
    _enqueue({ status: 200, data: { token: 'jwt-recover-401' } });
    await triggerV2.authenticate(FIXTURE_PUBKEY, {
        signTransaction: async () => 'X', signMessage: null,
    });
    // Now drive an ambiguous create → recovery path that 401's.
    _enqueue({ status: 200, data: { transaction: 'U', requestId: 'dr-recover-401' } });
    _enqueue({ status: 500, data: { error: 'jupiter_internal' } });
    _enqueue({ status: 401, data: { error: 'expired' } });
    // PR #388 R4: recovery 401 must route through `create_ambiguous_no_recovery`
    // (NOT `auth_expired`) so the upstream broadcast callback commits the
    // burner cap conservatively — the deposit may have landed and we just
    // lost our only way to confirm it. The JWT cache is still invalidated
    // so the next call re-auths cleanly.
    await check('401 from /orders/history during recovery → invalidateJwt + ambiguous-no-recovery', async () => {
        const craft = await triggerV2.depositCraft({
            pubkey: FIXTURE_PUBKEY, token: 'jwt-recover-401',
            inputMint: FIXTURE_INPUT_MINT, outputMint: FIXTURE_OUTPUT_MINT, inputAmount: '1000000',
        });
        const origSetTimeout = global.setTimeout;
        global.setTimeout = (fn) => origSetTimeout(fn, 0);
        try {
            const submit = await triggerV2.submitCreateOrder({
                token: 'jwt-recover-401', recoveryContext: craft.recoveryContext, depositSignedTx: 'SIGNED',
                order: { inputMint: FIXTURE_INPUT_MINT, inputAmount: '1000000',
                    outputMint: FIXTURE_OUTPUT_MINT, triggerPriceUsd: 50,
                    triggerCondition: 'below', expiresAtMs: Date.now() + 86400_000 },
            });
            assert.strictEqual(submit.ok, false);
            assert.strictEqual(submit.error, 'create_ambiguous_no_recovery',
                'recovery 401 must commit-conservatively via ambiguous bucket (PR #388 R4)');
            // Confirm the JWT cache was invalidated — next auth should NOT hit cache.
            _enqueue({ status: 200, data: { type: 'transaction', transaction: _buildAuthTx(FIXTURE_PUBKEY) } });
            _enqueue({ status: 200, data: { token: 'jwt-fresh-after-recover' } });
            const reauth = await triggerV2.authenticate(FIXTURE_PUBKEY, {
                signTransaction: async () => 'X', signMessage: null,
            });
            assert.strictEqual(reauth.ok, true);
            assert.notStrictEqual(reauth.cached, true, 'recovery 401 must have invalidated the cache');
            assert.strictEqual(reauth.token, 'jwt-fresh-after-recover');
        } finally { global.setTimeout = origSetTimeout; }
    });

    // PR #388 R4: a transport throw during /orders/history must also route
    // through the ambiguous bucket (the deposit may have landed and we lost
    // our ability to confirm). Pre-fix, the throw propagated out and
    // routeAndSign treated it as broadcast failure → released the burner
    // reservation → under-counted spend if the deposit actually landed.
    triggerV2._resetCachesForTests();
    _resetHttp();
    _enqueue({ status: 200, data: { transaction: 'U', requestId: 'dr-throw' } });
    _enqueue({ status: 500, data: { error: 'jupiter_internal' } });
    // Next dequeue intentionally throws (simulate transport error).
    httpQueue.push(() => { throw new Error('ECONNRESET during /orders/history'); });
    await check('transport throw during /orders/history → ambiguous-no-recovery (PR #388 R4)', async () => {
        const craft = await triggerV2.depositCraft({
            pubkey: FIXTURE_PUBKEY, token: 'jwt',
            inputMint: FIXTURE_INPUT_MINT, outputMint: FIXTURE_OUTPUT_MINT, inputAmount: '1000000',
        });
        const origSetTimeout = global.setTimeout;
        global.setTimeout = (fn) => origSetTimeout(fn, 0);
        try {
            const submit = await triggerV2.submitCreateOrder({
                token: 'jwt', recoveryContext: craft.recoveryContext, depositSignedTx: 'SIGNED',
                order: { inputMint: FIXTURE_INPUT_MINT, inputAmount: '1000000',
                    outputMint: FIXTURE_OUTPUT_MINT, triggerPriceUsd: 50,
                    triggerCondition: 'below', expiresAtMs: Date.now() + 86400_000 },
            });
            assert.strictEqual(submit.ok, false);
            assert.strictEqual(submit.error, 'create_ambiguous_no_recovery',
                'transport throw must commit-conservatively via ambiguous bucket (PR #388 R4)');
            assert.ok(submit.reason && /threw/i.test(submit.reason),
                `reason should mention the throw — got: ${submit.reason}`);
        } finally { global.setTimeout = origSetTimeout; }
    });

    // ── PR #388 R5: _inferTriggerMint fail-closed behavior ──────────────────
    // Reviewer concern (R5): for non-stable↔non-stable pairs (SOL↔JUP) and
    // both-stable pairs (USDC↔USDT) there is no safe inference for which
    // asset's USD price the trigger should watch. Pre-fix silently defaulted
    // to outputMint, which can make the order fire on the wrong asset OR
    // never fire at all. Post-fix: returns null → handler returns
    // trigger_mint_required → tx never gets signed.
    const solanaTools = require('../../app/src/main/assets/nodejs-project/tools/solana.js');
    const _inferTriggerMint = solanaTools._inferTriggerMint;
    const SOL = 'So11111111111111111111111111111111111111112';
    const USDC = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v';
    const USDT = 'Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB';
    const JUP = 'JUPyiwrYJFskUPiHa7hkeR8VUtAeFoSYbKedZNsDvCN';

    await check('R5 _inferTriggerMint: stable→non-stable (USDC→SOL) returns SOL (outputMint)', async () => {
        assert.strictEqual(_inferTriggerMint(USDC, SOL), SOL);
    });
    await check('R5 _inferTriggerMint: non-stable→stable (SOL→USDC) returns SOL (inputMint)', async () => {
        assert.strictEqual(_inferTriggerMint(SOL, USDC), SOL);
    });
    await check('R5 _inferTriggerMint: non-stable↔non-stable (SOL↔JUP) returns null (caller must override)', async () => {
        assert.strictEqual(_inferTriggerMint(SOL, JUP), null,
            'must fail closed — Jupiter would otherwise watch the wrong asset\'s USD price');
        assert.strictEqual(_inferTriggerMint(JUP, SOL), null);
    });
    await check('R5 _inferTriggerMint: both-stable (USDC↔USDT) returns null (caller must override)', async () => {
        assert.strictEqual(_inferTriggerMint(USDC, USDT), null);
        assert.strictEqual(_inferTriggerMint(USDT, USDC), null);
    });
    await check('R5 _inferTriggerMint: explicit override always wins, even for ambiguous pairs', async () => {
        assert.strictEqual(_inferTriggerMint(SOL, JUP, JUP), JUP,
            'explicit caller-supplied triggerMint must short-circuit the inference');
        assert.strictEqual(_inferTriggerMint(USDC, USDT, USDC), USDC);
    });
    await check('R5 _inferTriggerMint: explicit empty-string/non-string is ignored, fall through to inference', async () => {
        assert.strictEqual(_inferTriggerMint(SOL, USDC, ''), SOL, 'empty string is not a valid override');
        assert.strictEqual(_inferTriggerMint(SOL, USDC, null), SOL);
        assert.strictEqual(_inferTriggerMint(SOL, USDC, undefined), SOL);
    });

    // ── BAT-995 Self-Debug Layer 1: checkSolForTrigger pre-flight ───────────
    console.log('\n[BAT-995] Layer 1 — checkSolForTrigger');

    const { checkSolForTrigger, MIN_SOL_FOR_TRIGGER_LAMPORTS } = triggerV2;

    await check('L1 floor constant is 0.005 SOL (5_000_000 lamports)', async () => {
        assert.strictEqual(MIN_SOL_FOR_TRIGGER_LAMPORTS, 5_000_000,
            'BAT-995 contract: trigger orders need at least 0.005 SOL for rent + fees');
    });

    await check('L1 rejects when balance < floor (returns insufficient_sol_for_rent with both numbers)', async () => {
        const r = await checkSolForTrigger('Wallet1111111111111111111111111111111111111', async () => 1_733_602);
        assert.strictEqual(r.ok, false);
        assert.strictEqual(r.error, 'insufficient_sol_for_rent');
        assert.strictEqual(r.haveLamports, 1_733_602);
        assert.strictEqual(r.needLamports, 5_000_000);
        assert.match(r.reason, /0\.005 SOL/, 'reason should mention the 0.005 SOL minimum');
        assert.match(r.reason, /0\.00173[34]/, 'reason should mention the current balance (rounded to 6 decimals)');
        assert.match(r.reason, /Wallet1111/, 'reason should mention the wallet address so user knows where to send');
    });

    await check('L1 accepts when balance >= floor', async () => {
        const r = await checkSolForTrigger('Wallet1111111111111111111111111111111111111', async () => 5_000_000);
        assert.strictEqual(r.ok, true);
        assert.strictEqual(r.balance, 5_000_000);
    });

    await check('L1 accepts both lamports-number AND { value: lamports } RPC shapes', async () => {
        const r1 = await checkSolForTrigger('Wallet1', async () => 10_000_000);
        const r2 = await checkSolForTrigger('Wallet1', async () => ({ value: 10_000_000 }));
        assert.strictEqual(r1.ok, true);
        assert.strictEqual(r2.ok, true);
        assert.strictEqual(r2.balance, 10_000_000);
    });

    await check('L1 returns sol_balance_check_failed when RPC returns { error }', async () => {
        const r = await checkSolForTrigger('Wallet1', async () => ({ error: 'RPC timeout' }));
        assert.strictEqual(r.ok, false);
        assert.strictEqual(r.error, 'sol_balance_check_failed');
        assert.match(r.reason, /RPC timeout/);
    });

    await check('L1 returns sol_balance_check_failed when RPC fn throws', async () => {
        const r = await checkSolForTrigger('Wallet1', async () => { throw new Error('network'); });
        assert.strictEqual(r.ok, false);
        assert.strictEqual(r.error, 'sol_balance_check_failed');
        assert.match(r.reason, /network/);
    });

    await check('L1 R14: non-Error throws are handled defensively (e?.message ?? String(e))', async () => {
        // Copilot R14 #3342208795: pre-fix code did `${e.message}` which
        // either produced "undefined" (Error without .message) OR THREW a
        // TypeError when e itself was undefined/null/primitive (e.message on
        // undefined throws). Post-fix uses `e?.message ?? String(e)` so the
        // function ALWAYS returns a structured error and carries the
        // thrown-value's string form into the reason.
        const cases = [
            { thrown: 'string error', expectInReason: 'string error' },
            { thrown: undefined, expectInReason: 'undefined' }, // String(undefined) = "undefined" — clean output where pre-fix would TypeError
            { thrown: null, expectInReason: 'null' },
            { thrown: 42, expectInReason: '42' },
            { thrown: { code: 'WEIRD' }, expectInReason: '[object Object]' }, // degraded but stable
        ];
        for (const c of cases) {
            const r = await checkSolForTrigger('Wallet1', async () => { throw c.thrown; });
            assert.strictEqual(r.error, 'sol_balance_check_failed',
                `non-Error throw (${String(c.thrown)}) should still produce sol_balance_check_failed (not crash the function)`);
            assert.ok(r.reason.includes(c.expectInReason),
                `reason "${r.reason}" should include "${c.expectInReason}"`);
        }
    });

    await check('L1 rejects malformed RPC response shapes (null, string, NaN, Infinity, negative, wrong-typed value)', async () => {
        for (const garbage of [null, 'wrong', NaN, Infinity, -1, { value: 'not a number' }]) {
            const r = await checkSolForTrigger('Wallet1', async () => garbage);
            assert.strictEqual(r.ok, false, `expected fail on ${JSON.stringify(garbage)}`);
            assert.strictEqual(r.error, 'sol_balance_check_failed', `expected sol_balance_check_failed on ${JSON.stringify(garbage)}`);
        }
    });

    await check('L1 input validation: requires walletAddress + getSolBalance', async () => {
        const r1 = await checkSolForTrigger('', async () => 0);
        assert.strictEqual(r1.error, 'invalid_input');
        const r2 = await checkSolForTrigger('Wallet1', null);
        assert.strictEqual(r2.error, 'invalid_input');
    });

    // ── BAT-995 Self-Debug Layer 2: diagnoseFailedDeposit sim parser ────────
    console.log('\n[BAT-995] Layer 2 — diagnoseFailedDeposit');

    const { diagnoseFailedDeposit } = triggerV2;

    await check('L2 Custom(1) on SystemProgram → insufficient_sol_for_rent (disambiguated by logs)', async () => {
        const r = await diagnoseFailedDeposit('FAKE_TX_B64', async () => ({
            value: {
                err: { InstructionError: [4, { Custom: 1 }] },
                logs: [
                    'Program 11111111111111111111111111111111 invoke [1]',
                    'Program 11111111111111111111111111111111 failed: custom program error: 0x1',
                ],
            },
        }));
        assert.strictEqual(r.error, 'insufficient_sol_for_rent');
        assert.match(r.reason, /instruction 4/, 'should mention which instruction failed');
        assert.match(r.reason, /SystemProgram/, 'should name the failing program');
        assert.match(r.reason, /0\.005 SOL/, 'should mention the minimum');
    });

    await check('L2 Custom(1) on TokenProgram → insufficient_token_balance (NOT misclassified as SOL — Copilot review fix)', async () => {
        const r = await diagnoseFailedDeposit('FAKE', async () => ({
            value: {
                err: { InstructionError: [6, { Custom: 1 }] },
                logs: [
                    'Program TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA invoke [1]',
                    'Program log: Instruction: Transfer',
                    'Program TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA failed: custom program error: 0x1',
                ],
            },
        }));
        assert.strictEqual(r.error, 'insufficient_token_balance',
            'TokenProgram Custom(1) must NOT be reported as insufficient_sol_for_rent — that would tell the user to send more SOL when they actually need more input token');
        assert.match(r.reason, /TokenProgram/);
        assert.match(r.reason, /InsufficientFunds/);
        assert.match(r.reason, /input token/);
        assert.match(r.reason, /USDC/, 'should hint at the common case');
    });

    await check('L2 Custom(1) on unknown program → deposit_sim_failed (do NOT guess SOL-vs-token)', async () => {
        const r = await diagnoseFailedDeposit('FAKE', async () => ({
            value: {
                err: { InstructionError: [3, { Custom: 1 }] },
                logs: [
                    'Program JupiterUnknown1111111111111111111111111111 invoke [1]',
                    'Program JupiterUnknown1111111111111111111111111111 failed: custom program error: 0x1',
                ],
            },
        }));
        assert.strictEqual(r.error, 'deposit_sim_failed');
        assert.match(r.reason, /JupiterUnknown1111/);
        assert.match(r.reason, /both SOL and token balances|SOL and token/i,
            'should tell the agent NOT to guess which is short');
    });

    await check('L2 Custom(1) with NO failed log entry → deposit_sim_failed with unknown program', async () => {
        const r = await diagnoseFailedDeposit('FAKE', async () => ({
            value: {
                err: { InstructionError: [2, { Custom: 1 }] },
                logs: ['Program 11111111111111111111111111111111 invoke [1]'], // no `failed` line
            },
        }));
        assert.strictEqual(r.error, 'deposit_sim_failed',
            'absent disambiguation we must NOT pick a side');
        assert.match(r.reason, /unknown/);
    });

    await check('L2 Custom(1) with empty logs array → deposit_sim_failed (defensive)', async () => {
        const r = await diagnoseFailedDeposit('FAKE', async () => ({
            value: { err: { InstructionError: [4, { Custom: 1 }] }, logs: [] },
        }));
        assert.strictEqual(r.error, 'deposit_sim_failed',
            'no logs = no disambiguation possible; must not assume SOL');
    });

    await check('L2 maps non-Custom(1) InstructionError to deposit_sim_failed with index + raw code', async () => {
        const r = await diagnoseFailedDeposit('FAKE', async () => ({
            value: { err: { InstructionError: [6, { Custom: 6001 }] }, logs: [] },
        }));
        assert.strictEqual(r.error, 'deposit_sim_failed');
        assert.match(r.reason, /instruction 6/);
        assert.match(r.reason, /6001/);
    });

    await check('L2 maps enum-string InstructionError code to deposit_sim_failed', async () => {
        const r = await diagnoseFailedDeposit('FAKE', async () => ({
            value: { err: { InstructionError: [2, 'InvalidAccountData'] }, logs: [] },
        }));
        assert.strictEqual(r.error, 'deposit_sim_failed');
        assert.match(r.reason, /InvalidAccountData/);
    });

    await check('L2 maps top-level BlockhashNotFound string to blockhash_expired with retry advice', async () => {
        const r = await diagnoseFailedDeposit('FAKE', async () => ({
            value: { err: 'BlockhashNotFound', logs: [] },
        }));
        assert.strictEqual(r.error, 'blockhash_expired');
        assert.match(r.reason, /retry|Retry|fresh/i, 'should tell user to retry');
    });

    await check('L2 returns deposit_failed_unknown when sim itself returns { error }', async () => {
        const r = await diagnoseFailedDeposit('FAKE', async () => ({ error: 'RPC down' }));
        assert.strictEqual(r.error, 'deposit_failed_unknown');
        assert.match(r.reason, /RPC down/);
    });

    await check('L2 returns deposit_failed_unknown when sim shows NO on-chain error (Jupiter-side issue)', async () => {
        const r1 = await diagnoseFailedDeposit('FAKE', async () => ({ value: { err: null, logs: [] } }));
        const r2 = await diagnoseFailedDeposit('FAKE', async () => ({ value: { logs: [] } }));
        assert.strictEqual(r1.error, 'deposit_failed_unknown');
        assert.strictEqual(r2.error, 'deposit_failed_unknown');
        assert.match(r1.reason, /Jupiter backend|stale blockhash/);
    });

    await check('L2 returns deposit_failed_unknown when simulate throws', async () => {
        const r = await diagnoseFailedDeposit('FAKE', async () => { throw new Error('boom'); });
        assert.strictEqual(r.error, 'deposit_failed_unknown');
        assert.match(r.reason, /boom/);
    });

    await check('L2 R14: non-Error throws from simulate are handled defensively (e?.message ?? String(e))', async () => {
        // Copilot R14 #3342208868: same defensive issue as L1 R14.
        const cases = [
            { thrown: 'rpc died', expectInReason: 'rpc died' },
            { thrown: undefined, expectInReason: 'undefined' },
            { thrown: null, expectInReason: 'null' },
            { thrown: { code: 'WEIRD' }, expectInReason: '[object Object]' },
        ];
        for (const c of cases) {
            const r = await diagnoseFailedDeposit('FAKE', async () => { throw c.thrown; });
            assert.strictEqual(r.error, 'deposit_failed_unknown',
                `non-Error throw (${String(c.thrown)}) should still produce deposit_failed_unknown (not crash)`);
            assert.ok(r.reason.includes(c.expectInReason),
                `reason "${r.reason}" should include "${c.expectInReason}"`);
        }
    });

    await check('L2 requires simulate fn (defensive)', async () => {
        const r = await diagnoseFailedDeposit('FAKE', null);
        assert.strictEqual(r.error, 'deposit_failed_unknown');
        assert.match(r.reason, /no simulate fn/);
    });

    await check('L2 surfaces unknown structured err shape via JSON.stringify', async () => {
        const r = await diagnoseFailedDeposit('FAKE', async () => ({
            value: { err: { WeirdError: { detail: 42 } }, logs: [] },
        }));
        assert.strictEqual(r.error, 'deposit_failed_unknown');
        assert.match(r.reason, /WeirdError/);
    });

    await check('L2 preserves rawError for downstream debugging', async () => {
        const rawErr = { InstructionError: [4, { Custom: 1 }] };
        const r = await diagnoseFailedDeposit('FAKE', async () => ({ value: { err: rawErr, logs: [] } }));
        assert.deepStrictEqual(r.rawError, rawErr);
    });

    await check('L2 CONTRACT — deposit_failed_unknown is the "non-actionable" sentinel (Copilot R12: callers preserve original error instead of overriding with this)', async () => {
        // This rule is load-bearing for tools/solana.js create_failed branch:
        //   if (diag.error !== 'deposit_failed_unknown') { override }
        //   else { preserve original HTTP cause }
        // Verify the helper actually emits this exact string in the non-
        // actionable paths so the caller's check stays accurate.
        const cases = [
            { name: 'simulate returns { error }', sim: async () => ({ error: 'RPC down' }) },
            { name: 'simulate throws', sim: async () => { throw new Error('boom'); } },
            { name: 'sim returns no err (Jupiter-side issue)', sim: async () => ({ value: { err: null, logs: [] } }) },
            { name: 'no simulate fn', sim: null },
        ];
        for (const c of cases) {
            const r = await diagnoseFailedDeposit('FAKE', c.sim);
            assert.strictEqual(r.error, 'deposit_failed_unknown',
                `${c.name}: must return the sentinel so caller preserves original HTTP cause`);
        }
    });

    // ── BAT-995 Layer 3: export contract ────────────────────────────────────
    console.log('\n[BAT-995] Layer 3 — export contract');

    await check('L3 trigger-v2 exports the self-debug primitives + constant', async () => {
        assert.strictEqual(typeof triggerV2.checkSolForTrigger, 'function');
        assert.strictEqual(typeof triggerV2.diagnoseFailedDeposit, 'function');
        assert.strictEqual(typeof triggerV2.MIN_SOL_FOR_TRIGGER_LAMPORTS, 'number');
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
