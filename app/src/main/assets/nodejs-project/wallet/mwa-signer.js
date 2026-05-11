// SeekerClaw — wallet/mwa-signer.js
// MwaSigner — wraps the existing /solana/sign and /solana/sign-only bridge
// endpoints. This is the user's main wallet path: every call pops the
// MWA wallet app for explicit user approval.
//
// Phase 1: stub. Phase 5 wires it into the wallet registry alongside
// BurnerSigner. The actual /solana/sign endpoints already exist in
// AndroidBridge.kt — no Android changes needed for this signer.

'use strict';

const { Signer } = require('./signer');
const { androidBridgeCall } = require('../bridge');

class MwaSigner extends Signer {
    /**
     * Pops MWA wallet for user approval, returns signed (but not broadcast) tx.
     * Existing endpoint: /solana/sign-only. ReservationId is ignored — main
     * wallet is not capped.
     */
    async signTransaction(txBase64, _opts = {}) {
        if (typeof txBase64 !== 'string' || !txBase64) {
            return { error: 'invalid_input', reason: 'txBase64 must be a non-empty string' };
        }
        const res = await androidBridgeCall('/solana/sign-only', { txBase64 }, 120000);
        return res;
    }

    /**
     * Pops MWA wallet, signs, and broadcasts. broadcastVia is informational
     * only — the wallet itself broadcasts via its configured RPC.
     */
    async signAndSend(txBase64, _opts = {}) {
        if (typeof txBase64 !== 'string' || !txBase64) {
            return { error: 'invalid_input', reason: 'txBase64 must be a non-empty string' };
        }
        const res = await androidBridgeCall('/solana/sign', { txBase64 }, 120000);
        return res;
    }
}

module.exports = { MwaSigner };
