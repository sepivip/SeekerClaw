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

'use strict';

const { Signer } = require('./signer');
const { androidBridgeCall } = require('../bridge');

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
        const res = await androidBridgeCall('/burner/sign-transaction', {
            txBase64,
            reservationId: opts.reservationId,
        }, 15000);
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
        const body = { txBase64, broadcastVia };
        if (opts.reservationId) body.reservationId = opts.reservationId;
        const res = await androidBridgeCall('/burner/sign-and-send', body, 30000);
        return res;
    }
}

module.exports = { BurnerSigner };
