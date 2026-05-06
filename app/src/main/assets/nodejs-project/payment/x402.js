// SeekerClaw — payment/x402.js
// X402 implementation (BAT-582). V1 supports the pay.sh header set,
// verified by a committed sandbox fixture (Phase 6).
//
// Phase 1: skeleton. The detect/build/settle methods throw "not implemented"
// until Phase 6 fills in fixture-driven behavior. Boundary checks (HTTPS-only,
// private-IP rejection, GET-only, network=solana, asset=USDC, max body, timeout)
// are pinned in the Phase 6 implementation against the committed fixture.

'use strict';

const { PaymentProtocol } = require('./protocol');

class X402Protocol extends PaymentProtocol {
    get name() { return 'x402'; }

    detect(response) {
        // V1: status === 402 with pay.sh-shaped JSON body.
        // Phase 6 pins exact header/body schema from committed fixture.
        return !!(response && response.status === 402);
    }

    // eslint-disable-next-line no-unused-vars
    async build(response, ctx) {
        return { error: 'not_implemented', reason: 'X402 build pending Phase 6 fixture commit' };
    }

    // eslint-disable-next-line no-unused-vars
    async settle(originalRequest, signedTxBase64, paymentMeta) {
        return { error: 'not_implemented', reason: 'X402 settle pending Phase 6 fixture commit' };
    }
}

module.exports = { X402Protocol };
