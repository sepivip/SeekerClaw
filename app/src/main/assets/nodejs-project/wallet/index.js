// SeekerClaw — wallet/index.js
// Wallet registry. Tools never construct signers/wallets directly — they go
// through getWallet(role). This is the seam that lets V2 plug in a hardware
// wallet or Seed Vault signer without touching tool code.
//
// Phase 1: registry skeleton with both roles wired but most methods returning
// safe defaults until Phases 4-5 fill in behavior.

'use strict';

const { BurnerWallet } = require('./burner-wallet');
const { MainWallet } = require('./main-wallet');

let _burner = null;
let _main = null;

/**
 * Get a wallet by role. Returns null if the role doesn't exist.
 * Caller-side null-check pattern: `if (!w) { ... no burner configured ... }`
 *
 * Wallet instances are singletons within a Node lifetime — they hold no
 * mutable state beyond their signer reference, so reuse is safe.
 */
function getWallet(role) {
    if (role === 'burner') {
        if (!_burner) _burner = new BurnerWallet();
        return _burner;
    }
    if (role === 'main') {
        if (!_main) _main = new MainWallet();
        return _main;
    }
    return null;
}

/**
 * Test-only reset. Production code never calls this. Tests use it to
 * inject mock signers for behavioral tests.
 */
function _resetForTests() {
    _burner = null;
    _main = null;
}

module.exports = { getWallet, _resetForTests };
