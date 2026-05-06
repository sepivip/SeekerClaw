// SeekerClaw — wallet/signer.js
// Signer interface (BAT-582). Burner and MWA both implement this.
//
// Contract:
//   - signTransaction(txBase64) → Promise<{signedTxBase64} | {error, reason?}>
//   - signAndSend(txBase64, opts) → Promise<{signature} | {error, reason?}>
//   - opts.broadcastVia: "rpc" | "jupiter" (signAndSend only)
//   - opts.reservationId: pre-reserved cap slot id (burner-only); ignored by MWA
//
// No signer holds key material in Node. Burner signing is bridge-backed
// (Android KeyVault). MWA signing pops the user's wallet app.

'use strict';

/**
 * Throw a clear error if a Signer impl forgets to override these.
 * This is the only enforcement Node has — Android is the final authority.
 */
class Signer {
    // eslint-disable-next-line no-unused-vars
    async signTransaction(txBase64, opts) {
        throw new Error('Signer.signTransaction not implemented');
    }
    // eslint-disable-next-line no-unused-vars
    async signAndSend(txBase64, opts) {
        throw new Error('Signer.signAndSend not implemented');
    }
}

module.exports = { Signer };
