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
     * Build an unsigned payment transaction + metadata.
     *
     * ctx (provided by agent_pay caller):
     *   - maxUsdcAtomic: BigInt cap from caller (must be a BigInt; tool
     *     converts the agent's `max_usdc` decimal-string arg before
     *     calling).
     *   - burnerPubkey: string — base58 pubkey of the burner wallet
     *     (resolved via /burner/status upstream). The build path needs
     *     ONLY the pubkey to construct the unsigned tx; signing happens
     *     downstream via the bridge. There is NO `signerWallet` field
     *     in ctx — pre-fix the JSDoc claimed one, but the actual x402
     *     impl never used it and callers never supplied one. Future
     *     protocol impls should also follow the pubkey-only contract.
     *
     * Returns { txBase64, paymentMeta } on success, where paymentMeta
     * carries the version + protocol metadata settle() needs. Returns
     * { error, reason } on any rejection.
     */
    // eslint-disable-next-line no-unused-vars
    async build(response, ctx) {
        throw new Error('PaymentProtocol.build not implemented');
    }
    /**
     * Replay the original request with the payment proof.
     *
     * @param originalRequest  { parsed: URL, pinnedIp, pinnedFamily, timeoutLeftMs }
     * @param signedTxBase64   — caller signs build()'s txBase64 (via burner
     *                           bridge) and passes the result here.
     * @param paymentMeta      — opaque metadata from build(); the protocol
     *                           impl interprets it (e.g. x402 reads
     *                           paymentMeta.x402Version to choose the
     *                           proof header path).
     * @param helpers          — { _fetchWithLimits } injected by caller so
     *                           the protocol module avoids importing the
     *                           agent_pay tool (circular require).
     *
     * Returns the resource response on success or { error, reason } on
     * rejection.
     */
    // eslint-disable-next-line no-unused-vars
    async settle(originalRequest, signedTxBase64, paymentMeta, helpers) {
        throw new Error('PaymentProtocol.settle not implemented');
    }
}

module.exports = { PaymentProtocol };
