// SeekerClaw — wallet/dispatch.js
// BAT-582 Phase 5 — autonomy gate.
//
// Routes a tool's unsigned transaction through the right wallet (burner or
// main) based on caps/preflight.routeFor(). Handles burner reservation,
// signing, broadcast (via caller-supplied callback), and commit/release.
//
// WHY THIS EXISTS
// ---------------
// Five tools (solana_send, solana_swap, jupiter_trigger_create,
// jupiter_dca_create, plus the two Jupiter cancels) share the exact same
// routing logic but differ in how the signed tx is broadcast (RPC vs Jupiter
// Ultra vs Jupiter Trigger vs Jupiter Recurring). This helper keeps the
// branchy reservation / commit / release dance in ONE place; the per-tool
// handlers stay focused on tx construction + post-broadcast bookkeeping.
//
// HARD RULES (per BAT-582 contract v1.4)
// --------------------------------------
//   - Per-tool principal extraction lives in caps/preflight.js's routeFor —
//     never inside the signer. Caller passes (toolName, args); routeFor
//     decides the routing.
//   - Burner key NEVER in Node. getWallet('burner').signer() is a thin
//     bridge wrapper; it doesn't see key bytes.
//   - Cancels don't consume principal but ARE ownership-gated. The cancel
//     dispatch path skips reserve/commit/release entirely and goes straight
//     to /burner/sign-transaction (Android validates burner is configured;
//     amount=0 means no cap-state mutation either).
//   - Single canonical writer for cap state: only Android writes; Node calls
//     bridge endpoints. No Node module touches CrossProcessStore directly.
//
// /BURNER/SIGN-AND-SEND IS A 501 STUB IN PHASE 4
// ----------------------------------------------
// Phase 2 left BurnerBridgeEndpoints.handleSignAndSend returning HTTP 501
// `broadcast_not_implemented` because the atomic Android-side broadcast
// path was scoped to a later phase. Phase 5 implements the autonomy gate
// WITHOUT finishing the atomic sign-and-send: instead we use the explicit
//
//     /burner/reserve  →  /burner/sign-transaction  →  Node-side broadcast
//                                                       (RPC or Jupiter)
//                      →  /burner/commit            (success)
//                      →  /burner/release           (failure)
//
// This is functionally equivalent for V1 (the burner key never leaves
// Android either way) and unblocks Phase 5. A future phase MAY collapse
// the three-step dance into a single bridge call once Android wires up
// RPC broadcast — at that point this helper switches to signAndSend
// with a one-line change.

'use strict';

const { getWallet } = require('./index');
const { routeFor } = require('../caps/preflight');
const { androidBridgeCall } = require('../bridge');
const { log } = require('../config');

/**
 * Route + sign + broadcast a tool's unsigned transaction through the
 * appropriate wallet.
 *
 * @param {Object} args
 * @param {string} args.toolName            - tool name for routing decisions
 * @param {Object} args.toolArgs            - args passed to the tool (for principal extraction)
 * @param {string} args.unsignedTxBase64    - serialized tx (base64) — NOT signed
 * @param {string} [args.broadcastVia]      - 'rpc' | 'jupiter' (advisory hint, used for sign-and-send)
 * @param {Function} args.broadcast         - async function(txBase64, signer, ctx) → {signature, ...}
 *                                            Caller-owned: each tool has its own broadcast (Jupiter Ultra,
 *                                            Trigger, Recurring, or RPC). On failure, throw or return
 *                                            {error}. Helper handles release on error.
 *                                            ctx = { wallet: 'burner' | 'main', signed: bool }
 *                                            - wallet: which path was chosen
 *                                            - signed: true when txBase64 is the signed bytes (burner
 *                                              path); false when caller must sign first (main path)
 * @param {string} [args.flowName]          - log tag for diagnostics
 *
 * @returns {Promise<{
 *     ok: boolean,
 *     wallet: 'burner' | 'main',
 *     signature?: string,
 *     broadcastResult?: any,
 *     error?: string,
 *     reason?: string,
 * }>}
 *
 * NOTE: this helper assumes the confirmation gate in ai.js has already
 * cleared the tool dispatch. For routing=burner+overCap, the gate would
 * have returned "block" before the handler ran. Defensive check is kept
 * here as belt-and-suspenders — if routing says under-cap=false at this
 * point, something raced or the gate was bypassed; we return an error.
 */
async function routeAndSign({ toolName, toolArgs, unsignedTxBase64, broadcastVia = 'rpc', broadcast, flowName = toolName }) {
    // 1. Decide routing.
    let route;
    try {
        route = await routeFor(toolName, toolArgs || {});
    } catch (e) {
        log(`[${flowName}] routeFor failed: ${e.message}`, 'WARN');
        // Defensive: degrade to main path so the user sees an MWA popup
        // rather than a silent failure.
        route = { routingDecision: 'main', underCap: true, principalAtomic: null, capName: null };
    }

    // 2. Burner over-cap defensive — gate should have blocked, but if we
    // got here, refuse to spend.
    if (route.routingDecision === 'burner' && route.underCap === false) {
        return {
            ok: false,
            wallet: 'burner',
            error: 'burner_over_cap',
            reason:
                'Burner over cap; the confirmation gate should have blocked this. ' +
                'Raise the cap with wallet_set_caps or pass _allowMainFallback: true.',
        };
    }

    // 3. Main path: existing MWA flow. broadcast callback decides whether
    // to use sign-only + Jupiter execute, or sign-and-send via /solana/sign.
    // We pass the UNSIGNED tx to the callback so it can choose the right
    // MWA endpoint (sign-only for Jupiter, sign-and-send for solana_send).
    if (route.routingDecision === 'main') {
        const main = getWallet('main');
        try {
            const result = await broadcast(unsignedTxBase64, main.signer(), { wallet: 'main', signed: false });
            if (result && result.error) {
                return { ok: false, wallet: 'main', error: result.error, reason: result.reason };
            }
            // Mirror burner-path shape: broadcastResult is the FULL callback
            // return so callers can pick out per-tool fields (e.g.,
            // dispatchResult.broadcastResult.recurring) without branching
            // on which wallet signed.
            return { ok: true, wallet: 'main', signature: result && result.signature, broadcastResult: result };
        } catch (e) {
            return { ok: false, wallet: 'main', error: 'broadcast_failed', reason: e.message };
        }
    }

    // 4. Burner under-cap path: reserve → sign-transaction → broadcast → commit / release.
    const burner = getWallet('burner');
    if (!burner) {
        return { ok: false, wallet: 'burner', error: 'no_burner_wallet', reason: 'getWallet("burner") returned null' };
    }

    // 4a. Reserve.
    const reserveBody = {
        name: route.capName,
        atomicAmount: route.principalAtomic,
        ttlMs: 60000,
    };
    const reserveRes = await androidBridgeCall('/burner/reserve', reserveBody, 5000);
    if (!reserveRes || reserveRes.error) {
        return {
            ok: false,
            wallet: 'burner',
            error: reserveRes && reserveRes.error ? reserveRes.error : 'reserve_failed',
            reason: reserveRes && reserveRes.reason ? reserveRes.reason : 'bridge_unreachable',
        };
    }
    const reservationId = reserveRes.reservationId;
    if (!reservationId) {
        return { ok: false, wallet: 'burner', error: 'reserve_failed', reason: 'no reservationId returned' };
    }

    // 4b. Sign-only via burner. The Phase 4 stub of /burner/sign-and-send
    // returns 501; we explicitly use sign-transaction + Node-side broadcast
    // until that endpoint is finished (see file header).
    let signedTxBase64;
    try {
        const signed = await burner.signer().signTransaction(unsignedTxBase64, { reservationId });
        if (!signed || signed.error) {
            await _release(reservationId, signed && signed.error ? signed.error : 'sign_failed');
            return {
                ok: false,
                wallet: 'burner',
                error: signed && signed.error ? signed.error : 'sign_failed',
                reason: signed && signed.reason ? signed.reason : 'signing failed',
            };
        }
        signedTxBase64 = signed.signedTxBase64;
        if (!signedTxBase64) {
            await _release(reservationId, 'no_signed_tx');
            return { ok: false, wallet: 'burner', error: 'sign_failed', reason: 'no signedTxBase64 in response' };
        }
    } catch (e) {
        await _release(reservationId, 'sign_threw');
        return { ok: false, wallet: 'burner', error: 'sign_failed', reason: e.message };
    }

    // 4c. Broadcast via caller-supplied callback. Caller knows which
    // execute API (RPC vs Jupiter) is appropriate. Burner path: callback
    // receives the SIGNED tx and just broadcasts.
    let broadcastResult;
    try {
        broadcastResult = await broadcast(signedTxBase64, burner.signer(), { wallet: 'burner', signed: true });
        if (!broadcastResult || broadcastResult.error) {
            await _release(reservationId, broadcastResult && broadcastResult.error ? broadcastResult.error : 'broadcast_failed');
            return {
                ok: false,
                wallet: 'burner',
                error: broadcastResult && broadcastResult.error ? broadcastResult.error : 'broadcast_failed',
                reason: broadcastResult && broadcastResult.reason ? broadcastResult.reason : 'broadcast returned no result',
            };
        }
    } catch (e) {
        await _release(reservationId, 'broadcast_threw');
        return { ok: false, wallet: 'burner', error: 'broadcast_failed', reason: e.message };
    }

    // 4d. Commit on success — anchor the spend in the daily ledger.
    try {
        await androidBridgeCall('/burner/commit', {
            reservationId,
            signature: broadcastResult.signature || null,
        }, 5000);
    } catch (e) {
        // Commit failure is logged but doesn't unwind a successful broadcast.
        // The Android-side TTL sweep will release the reservation eventually,
        // and a manual reconciliation can be added later if drift becomes
        // an issue. The user's signed-and-broadcast tx is already on-chain.
        log(`[${flowName}] commit after successful broadcast failed: ${e.message}`, 'WARN');
    }

    return { ok: true, wallet: 'burner', signature: broadcastResult.signature, broadcastResult };
}

/**
 * BAT-582 Phase 5 — sign a Jupiter-cancel tx. Cancels DON'T consume
 * principal: ownership-gated only.
 *
 * Per contract v1.4 "Cap principal per tool": cancel tools "reserve `0`
 * and are ownership-gated". Implementation:
 *   1. Reserve with atomicAmount=0 — Android's CapEnforcer.reserve
 *      verifies the burner is configured (refuses on null/zero per-tx
 *      cap → "burner_not_configured") but skips per-tx and daily window
 *      math entirely. Returns a reservationId.
 *   2. /burner/sign-transaction with the reservationId.
 *   3. Caller broadcasts (Jupiter Trigger / DCA cancel API).
 *   4. /burner/release — cancels don't commit to the daily ledger; the
 *      reservation is released cleanly so it doesn't sit in pending.
 *
 * The agent-facing semantic: a burner-owned Jupiter cancel goes through
 * silently (confirmation policy = "none"). A main-owned cancel pops MWA.
 * An "unknown" creator (order created on another device) defaults to the
 * main path with a confirmation popup AND a diagnostic.
 */
async function signCancelViaBurner({ unsignedTxBase64, broadcast, flowName = 'cancel' }) {
    const burner = getWallet('burner');
    if (!burner) {
        return { ok: false, wallet: 'burner', error: 'no_burner_wallet', reason: 'getWallet("burner") returned null' };
    }

    // Reserve atomicAmount=0 — verifies burner is configured (sole sanity
    // check we want for cancels) without touching cap state.
    const reserveRes = await androidBridgeCall('/burner/reserve', {
        name: 'burner.pertx.sol',
        atomicAmount: '0',
        ttlMs: 60000,
    }, 5000);
    if (!reserveRes || reserveRes.error || !reserveRes.reservationId) {
        return {
            ok: false,
            wallet: 'burner',
            error: reserveRes && reserveRes.error ? reserveRes.error : 'reserve_failed',
            reason: reserveRes && reserveRes.reason ? reserveRes.reason : 'cancel reservation failed',
        };
    }
    const reservationId = reserveRes.reservationId;

    // Sign.
    let signedTxBase64;
    try {
        const signed = await burner.signer().signTransaction(unsignedTxBase64, { reservationId });
        if (!signed || signed.error) {
            await _release(reservationId, signed && signed.error ? signed.error : 'sign_failed');
            return {
                ok: false,
                wallet: 'burner',
                error: signed && signed.error ? signed.error : 'sign_failed',
                reason: signed && signed.reason ? signed.reason : 'signing failed',
            };
        }
        signedTxBase64 = signed.signedTxBase64;
        if (!signedTxBase64) {
            await _release(reservationId, 'no_signed_tx');
            return { ok: false, wallet: 'burner', error: 'sign_failed', reason: 'no signedTxBase64 in response' };
        }
    } catch (e) {
        await _release(reservationId, 'sign_threw');
        return { ok: false, wallet: 'burner', error: 'sign_failed', reason: e.message };
    }

    // Broadcast.
    let broadcastResult;
    try {
        broadcastResult = await broadcast(signedTxBase64, burner.signer(), { wallet: 'burner', signed: true });
        if (!broadcastResult || broadcastResult.error) {
            await _release(reservationId, broadcastResult && broadcastResult.error ? broadcastResult.error : 'broadcast_failed');
            return {
                ok: false,
                wallet: 'burner',
                error: broadcastResult && broadcastResult.error ? broadcastResult.error : 'broadcast_failed',
                reason: broadcastResult && broadcastResult.reason ? broadcastResult.reason : 'broadcast returned no result',
            };
        }
    } catch (e) {
        await _release(reservationId, 'broadcast_threw');
        return { ok: false, wallet: 'burner', error: 'broadcast_failed', reason: e.message };
    }

    // Release the cancel reservation — cancels don't consume principal,
    // so we deliberately release (not commit). The zero-amount reservation
    // never affected cap state; release just clears the pending entry.
    try {
        await androidBridgeCall('/burner/release', {
            reservationId,
            reason: 'cancel_complete',
        }, 5000);
    } catch (e) {
        log(`[${flowName}] release after successful cancel failed: ${e.message}`, 'WARN');
    }

    return { ok: true, wallet: 'burner', signature: broadcastResult.signature, broadcastResult };
}

async function _release(reservationId, reason) {
    if (!reservationId) return;
    try {
        await androidBridgeCall('/burner/release', { reservationId, reason: String(reason || 'released') }, 5000);
    } catch (e) {
        // Best-effort. Android's TTL sweep will reclaim a stuck reservation
        // after 60s if the release call itself failed.
        log(`[wallet/dispatch] release(${reservationId}) failed: ${e.message}`, 'WARN');
    }
}

/**
 * BAT-582 Phase 5 — fire-and-forget Jupiter ownership write.
 *
 * Called by Jupiter create tools after a successful broadcast. Failure
 * here does NOT unwind the create — per contract v1.4 "tool returns the
 * order successfully but logs a diagnostic; subsequent cancel falls back
 * to the 'unknown order → main + confirm + diagnostic' path."
 */
async function recordJupiterOwnership(orderId, creatorWalletRole, flowName = 'jupiter') {
    if (!orderId || (creatorWalletRole !== 'burner' && creatorWalletRole !== 'main')) {
        log(`[${flowName}] recordJupiterOwnership skipped: orderId=${orderId} role=${creatorWalletRole}`, 'WARN');
        return { ok: false, error: 'invalid_input' };
    }
    try {
        const res = await androidBridgeCall('/jupiter/order-owner/set', {
            orderId,
            creatorWalletRole,
        }, 5000);
        if (!res || res.error) {
            log(`[${flowName}] /jupiter/order-owner/set failed: ${res && res.error ? res.error : 'no response'} — cancel will fall back to 'unknown' path`, 'WARN');
            return { ok: false, error: res && res.error ? res.error : 'bridge_unreachable' };
        }
        return { ok: true };
    } catch (e) {
        log(`[${flowName}] /jupiter/order-owner/set threw: ${e.message}`, 'WARN');
        return { ok: false, error: 'bridge_threw' };
    }
}

module.exports = {
    routeAndSign,
    signCancelViaBurner,
    recordJupiterOwnership,
};
