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

    // BAT-697 live-API finding: /vault/register does NOT exist; an unregistered
    // wallet GET returns 404 "Vault not found". ensureVault must fail loudly
    // (vault_registration_unsupported) rather than POST a 404 route.
    triggerV2._resetCachesForTests();
    _resetHttp();
    _enqueue({ status: 404, data: { error: 'Vault not found' } });
    await check('GET unregistered (404) → vault_registration_unsupported (no register POST)', async () => {
        const callsBefore = httpCalls.length;
        const r = await triggerV2.ensureVault(FIXTURE_PUBKEY, 'jwt');
        assert.strictEqual(r.ok, false);
        assert.strictEqual(r.error, 'vault_registration_unsupported');
        assert.strictEqual(httpCalls.length, callsBefore + 1, 'must NOT make a second (register) call');
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
    await check('parser handles a tx with a multi-byte account count (130 accounts)', async () => {
        // 130 accounts: payer + memo + 128 filler. instruction targets memo (idx 1).
        const accounts = [PAYER_BUF, MEMO_BYTES];
        for (let i = 0; i < 128; i++) accounts.push(key32(50 + i));
        const tx = buildTxBytes({ accounts, instrProgramIdx: 1 });
        const r = triggerV2._validateAuthTransaction(tx, PAYER_B58);
        assert.strictEqual(r.ok, true, `expected accept with 130 accounts, got: ${JSON.stringify(r)}`);
    });

    // ── recovery: terminal-fail orders must NOT be reported as recovered ────
    console.log('\nrecovery hardening (BAT-697 review pass):');
    triggerV2._resetCachesForTests();
    _resetHttp();
    _enqueue({ status: 200, data: { transaction: 'U', depositRequestId: 'dr-fail' } });
    _enqueue({ status: 500, data: { error: 'oops' } });
    // History returns a FAILED order that still carries vaultState:pending_deposit
    // AND matches mint+amount — the pre-fix OR-logic would have matched it.
    _enqueue({ status: 200, data: { orders: [
        { id: 'dead-order', status: 'failed', vaultState: 'pending_deposit',
          inputMint: FIXTURE_INPUT_MINT, inputAmount: '1000000',
          createdAt: new Date().toISOString() },
    ] } });
    await check('failed order with vaultState:pending_deposit is NOT recovered', async () => {
        const craft = await triggerV2.depositCraft({
            pubkey: FIXTURE_PUBKEY, token: 'jwt',
            inputMint: FIXTURE_INPUT_MINT, inputAmount: '1000000',
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

    triggerV2._resetCachesForTests();
    _resetHttp();
    _enqueue({ status: 200, data: { transaction: 'U', depositRequestId: 'dr-primary' } });
    _enqueue({ status: 500, data: { error: 'oops' } });
    // History exposes depositRequestId — primary correlation must match it
    // even though a SECOND same-amount active order also exists (no false alias).
    _enqueue({ status: 200, data: { orders: [
        { id: 'unrelated-same-amount', status: 'active',
          inputMint: FIXTURE_INPUT_MINT, inputAmount: '1000000', createdAt: new Date().toISOString() },
        { id: 'our-order', status: 'active', depositRequestId: 'dr-primary',
          inputMint: FIXTURE_INPUT_MINT, inputAmount: '1000000', createdAt: new Date().toISOString() },
    ] } });
    await check('recovery prefers depositRequestId correlation over amount heuristic', async () => {
        const craft = await triggerV2.depositCraft({
            pubkey: FIXTURE_PUBKEY, token: 'jwt',
            inputMint: FIXTURE_INPUT_MINT, inputAmount: '1000000',
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
            assert.strictEqual(submit.id, 'our-order', 'must match by depositRequestId, not the unrelated same-amount order');
            assert.strictEqual(submit.recovered, true);
        } finally { global.setTimeout = origSetTimeout; }
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
