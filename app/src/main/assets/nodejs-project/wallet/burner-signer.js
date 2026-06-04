// SeekerClaw — wallet/burner-signer.js
// BurnerSigner — async bridge wrapper. NO crypto. NO key material in Node.
//
// All signing happens inside Android KeyVault (BouncyCastle Ed25519).
// This module exists ONLY to translate Signer calls into bridge HTTP calls
// against /burner/sign-transaction and /burner/sign-and-send.
//
// Cap reservations are also Android-side; Node never writes cap state.
// signTransaction expects an already-reserved reservationId; signAndSend
// can either be passed a reservationId or let Android reserve atomically.
//
// BAT-1013 POLICY HOOK
// --------------------
// As of BAT-1013, BurnerSigner is the CHOKEPOINT for all autonomous
// burner signing. Every caller (`routeAndSign`, `signCancelViaBurner`,
// `signZeroCapTxViaBurner` in wallet/dispatch.js, plus `tools/agent_pay.js`'s
// direct call) reaches the bridge through one of THIS class's methods —
// either `signTransaction()` or `signAndSend()`. Codex amendment #2
// explicitly required that BOTH be policy-gated; this commit wires the
// policy hook at both call sites.
//
// Policy invocation contract:
//   - Caller passes `opts.expectedDelta` (per-tool shape from
//     wallet/burner-policy.js's DELTA_KINDS) AND optionally
//     `opts.simulator` (async (txB64) → simResult).
//   - If `expectedDelta` is present, the policy gate runs BEFORE any
//     bridge HTTP call. If policy rejects, this method returns
//     `{ error: <reject code>, reason, policyClass }` and the bridge is
//     never called.
//   - **TRANSITIONAL (Phase 2d → Phase 3):** if `expectedDelta` is
//     ABSENT, we WARN-log and pass through to the bridge unchanged.
//     This is a knowing security gap during the BAT-1013 caller
//     migration period — once Phase 3 lands and all callers pass
//     `expectedDelta`, the transitional pass-through is removed and
//     missing-expectedDelta becomes a fail-closed `expected_delta_required`
//     reject. The warn-log fires every transitional-mode call so we
//     can spot unmigrated callers in production logs.
//   - `burnerPubkey` is fetched lazily from `/burner/status` on first
//     policy invocation per Node lifetime, then cached for the process.
//     A new mid-process burner setup invalidates the cache via the
//     `_resetBurnerPubkeyCache()` test hook (production never invalidates
//     — burner pubkey is immutable until wipe, which destroys the Node
//     process via service restart anyway).

'use strict';

const { Signer } = require('./signer');
const { androidBridgeCall } = require('../bridge');
const { validateBurnerTx } = require('./burner-policy');

// Lazy-required to avoid circular dependency with solana.js (which is the
// canonical simulator producer). The require fires only when a caller
// invokes signTransaction/signAndSend WITHOUT passing their own simulator.
let _solanaRpc = null;
function _lazyDefaultSimulator() {
    if (_solanaRpc === null) {
        // eslint-disable-next-line global-require
        const solana = require('../solana');
        _solanaRpc = solana.solanaRpc || (async () => ({ value: null }));
    }
    return async (txBase64) => {
        const r = await _solanaRpc('simulateTransaction', [
            txBase64,
            {
                commitment: 'processed',
                sigVerify: false,
                replaceRecentBlockhash: true,
                encoding: 'base64',
                innerInstructions: true,
            },
        ]);
        // solanaRpc returns the parsed JSON body; the policy contract
        // expects `{ value: {...} }`. Pass through.
        return r && r.value ? r : { value: r };
    };
}

let _burnerPubkeyCache = null;
async function _getBurnerPubkey() {
    if (_burnerPubkeyCache) return _burnerPubkeyCache;
    try {
        const s = await androidBridgeCall('/burner/status', {}, 5000);
        if (s && !s.error && s.configured && typeof s.pubkey === 'string' && s.pubkey.length >= 32) {
            _burnerPubkeyCache = s.pubkey;
            return s.pubkey;
        }
    } catch (_) {}
    return null;
}

function _resetBurnerPubkeyCache() {
    _burnerPubkeyCache = null;
}

// log() is also lazy-required — pulling config.js eagerly at module load
// triggers cross-process-store init which the smoke test scaffold doesn't
// provide. Lazy keeps burner-signer.js a pure no-IO module-load.
let _logFn = null;
function _log(msg, level) {
    if (_logFn === null) {
        try {
            // eslint-disable-next-line global-require
            _logFn = require('../config').log || (() => {});
        } catch (_) {
            _logFn = () => {};
        }
    }
    try { _logFn(msg, level); } catch (_) {}
}

/**
 * Run `validateBurnerTx` if `opts.expectedDelta` is present. Returns:
 *   - `null` if no policy was run (caller in transitional mode).
 *   - `{ error, reason, policyClass }` if policy rejected — caller MUST
 *     return this to its caller WITHOUT touching the bridge.
 *   - `{ ok: true }` if policy passed — caller continues to bridge call.
 *
 * Centralised so `signTransaction` and `signAndSend` share identical
 * gate semantics (Codex amendment #2: no bypass).
 */
async function _runPolicyGate(txBase64, opts, methodName) {
    if (!opts || typeof opts.expectedDelta === 'undefined') {
        // TRANSITIONAL Phase 2d → Phase 3: warn but pass through.
        _log(`[BurnerPolicy] ${methodName} called without expectedDelta — TRANSITIONAL pass-through. Migrate caller per BAT-1013 Phase 3.`, 'WARN');
        return null;
    }
    const burnerPubkey = await _getBurnerPubkey();
    if (!burnerPubkey) {
        return {
            error: 'payer_missing',
            reason: 'burner pubkey unavailable (burner not configured or /burner/status failed)',
            policyClass: 'contract_gap',
        };
    }
    const simulator = (typeof opts.simulator === 'function')
        ? opts.simulator
        : _lazyDefaultSimulator();
    const result = await validateBurnerTx(txBase64, opts.expectedDelta, {
        burnerPubkey,
        simulator,
    });
    if (!result.ok) {
        _log(`[BurnerPolicy] ${methodName} REJECT tool=${opts.expectedDelta.kind || 'unknown'} error=${result.error} reason="${result.reason}" class=${result.class}`, 'WARN');
        return {
            error: result.error,
            reason: result.reason,
            policyClass: result.class,
        };
    }
    _log(`[BurnerPolicy] ${methodName} ACCEPT tool=${opts.expectedDelta.kind || 'unknown'} simulated=${result.simulated ? 'true' : 'false'} programs=${(result.programs || []).length}`, 'DEBUG');
    return { ok: true };
}

class BurnerSigner extends Signer {
    /**
     * Sign a serialized transaction. Caller must pass a valid reservationId
     * (obtained from /burner/reserve). Bridge does NOT commit the reservation;
     * caller is responsible for /burner/commit on broadcast success or
     * /burner/release on failure.
     */
    async signTransaction(txBase64, opts = {}) {
        if (typeof txBase64 !== 'string' || !txBase64) {
            return { error: 'invalid_input', reason: 'txBase64 must be a non-empty string' };
        }
        if (!opts.reservationId) {
            return { error: 'missing_reservation', reason: 'reservationId required for sign-only flow' };
        }
        // BAT-1013: policy gate BEFORE any bridge call (Codex amendment #2).
        const policyResult = await _runPolicyGate(txBase64, opts, 'signTransaction');
        if (policyResult && policyResult.error) return policyResult;
        const body = {
            txBase64,
            reservationId: opts.reservationId,
        };
        // BAT-582 v1.6 Phase 5d: when the caller is signing a partially-
        // signed x402 v2 tx (facilitator co-signs server-side), set the
        // bridge flag so SolanaTxSigner skips its v1 "all other signers
        // must be cosigned" check. Default false preserves v1 behavior
        // for every existing caller (Jupiter Ultra swap, v1 x402, etc.).
        if (opts.allowPartiallySigned === true) {
            body.allowPartiallySigned = true;
        }
        const res = await androidBridgeCall('/burner/sign-transaction', body, 15000);
        return res;
    }

    /**
     * Sign + broadcast atomically. Bridge handles reserve+sign+broadcast+commit
     * (or release on error) in one round trip. broadcastVia: "rpc" | "jupiter".
     */
    async signAndSend(txBase64, opts = {}) {
        if (typeof txBase64 !== 'string' || !txBase64) {
            return { error: 'invalid_input', reason: 'txBase64 must be a non-empty string' };
        }
        const broadcastVia = opts.broadcastVia || 'rpc';
        if (broadcastVia !== 'rpc' && broadcastVia !== 'jupiter') {
            return { error: 'invalid_input', reason: 'broadcastVia must be "rpc" or "jupiter"' };
        }
        // BAT-1013: same policy gate as signTransaction (Codex amendment #2 —
        // signAndSend MUST NOT become a future bypass).
        const policyResult = await _runPolicyGate(txBase64, opts, 'signAndSend');
        if (policyResult && policyResult.error) return policyResult;
        const body = { txBase64, broadcastVia };
        if (opts.reservationId) body.reservationId = opts.reservationId;
        const res = await androidBridgeCall('/burner/sign-and-send', body, 30000);
        return res;
    }
}

module.exports = {
    BurnerSigner,
    // Test hooks
    _resetBurnerPubkeyCache,
};
