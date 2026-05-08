// SeekerClaw — payment/protocol.js
// PaymentProtocol interface (BAT-582). x402 implements this V1; MPP plugs in
// V2 by adding payment/mpp.js + registering it in payment/index.js.
//
// Contract (per impl):
//   - name: short identifier ("x402")
//   - detect(response): does this protocol claim ownership of the response?
//   - build(response, ctx): build the unsigned payment payload (e.g., USDC SPL transfer)
//   - settle(response, signed): retry the original request with the proof header(s)

'use strict';

class PaymentProtocol {
    get name() {
        throw new Error('PaymentProtocol.name not implemented');
    }
    /**
     * @param {object} response - { status, headers, bodyJson }
     * @returns {boolean}
     */
    // eslint-disable-next-line no-unused-vars
    detect(response) {
        throw new Error('PaymentProtocol.detect not implemented');
    }
    /**
     * Build an unsigned payment transaction + metadata. ctx provides:
     *   - maxUsdcAtomic: BigInt cap from caller
     *   - signerWallet: Wallet (burner) instance
     * Returns { txBase64, paymentMeta } or { error, reason }.
     */
    // eslint-disable-next-line no-unused-vars
    async build(response, ctx) {
        throw new Error('PaymentProtocol.build not implemented');
    }
    /**
     * Replay the original request with the payment proof. Returns the
     * resource response or { error, reason }.
     */
    // eslint-disable-next-line no-unused-vars
    async settle(originalRequest, signedTxBase64, paymentMeta) {
        throw new Error('PaymentProtocol.settle not implemented');
    }
}

module.exports = { PaymentProtocol };
