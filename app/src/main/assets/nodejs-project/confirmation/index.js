// SeekerClaw — confirmation/index.js
// Confirmation policy registry. Default policy is the matrix in policy.js;
// future tool-specific overrides plug in here without touching ai.js.

'use strict';

const {
    getConfirmationPolicy: defaultPolicy,
    normalizePolicy,
    V1_STATIC_CONFIRM,
    SOLANA_WRITE_TOOLS,
    JUPITER_CANCEL_TOOLS,
} = require('./policy');

let _override = null;

function setPolicyOverrideForTests(fn) {
    _override = fn;
}
function clearPolicyOverrideForTests() {
    _override = null;
}

function getConfirmationPolicy(toolName, args, walletState) {
    if (_override) return _override(toolName, args, walletState);
    return defaultPolicy(toolName, args, walletState);
}

module.exports = {
    getConfirmationPolicy,
    normalizePolicy,
    setPolicyOverrideForTests,
    clearPolicyOverrideForTests,
    V1_STATIC_CONFIRM,
    SOLANA_WRITE_TOOLS,
    JUPITER_CANCEL_TOOLS,
};
