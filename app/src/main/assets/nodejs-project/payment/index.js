// SeekerClaw — payment/index.js
// PaymentProtocol registry. Implementations register themselves; agent_pay
// dispatches to the first that detect()s the response.
//
// V1: x402 only. Adding MPP V2 = one new file (payment/mpp.js) + one
// registry line — no agent_pay code change.

'use strict';

const { X402Protocol } = require('./x402');

const _registry = [];

function register(protocol) {
    _registry.push(protocol);
}

function detectProtocol(response) {
    for (const p of _registry) {
        if (p.detect(response)) return p;
    }
    return null;
}

function listProtocols() {
    return _registry.slice();
}

function _resetForTests() {
    _registry.length = 0;
    register(new X402Protocol());
}

// Default V1 registration
register(new X402Protocol());

module.exports = { register, detectProtocol, listProtocols, _resetForTests };
