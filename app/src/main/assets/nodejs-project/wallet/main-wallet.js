// SeekerClaw — wallet/main-wallet.js
// MainWallet — wraps the existing user MWA wallet.
//
// pubkey comes from solana_wallet.json (written when the user authorizes
// MWA on first connect — see existing solana.js getConnectedWalletAddress).
// Balance is fetched via the existing RPC helpers in solana.js.
//
// Phase 1: stub structure. Phase 5 wires this into the wallet registry.

'use strict';

const { Wallet } = require('./wallet');
const { MwaSigner } = require('./mwa-signer');

class MainWallet extends Wallet {
    constructor() {
        super();
        this._signer = new MwaSigner();
        // Lazy: pubkey + balance helpers wired in Phase 5 against existing
        // solana.js (getConnectedWalletAddress, getBalance, etc.) so we
        // don't duplicate RPC code.
    }

    role() { return 'main'; }

    async pubkey() {
        // Phase 5: read from solana_wallet.json via existing helper.
        // Returns null when MWA hasn't authorized yet.
        return null;
    }

    async balance() {
        // Phase 5: call existing RPC helpers; return atomic-unit strings.
        return { sol: '0', usdc: '0' };
    }

    signer() { return this._signer; }
}

module.exports = { MainWallet };
