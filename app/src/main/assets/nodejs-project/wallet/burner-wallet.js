// SeekerClaw — wallet/burner-wallet.js
// BurnerWallet — composes a BurnerSigner with status-fetching helpers.
//
// pubkey + balance + cap state all come from /burner/status (Android is
// the single source of truth). Signer is a BurnerSigner instance.
//
// Phase 1: structure + bridge wiring. Phase 4 wires this into wallet/index.js
// registry and exposes wallet_status / wallet_set_caps tools.

'use strict';

const { Wallet } = require('./wallet');
const { BurnerSigner } = require('./burner-signer');
const { androidBridgeCall } = require('../bridge');

class BurnerWallet extends Wallet {
    constructor() {
        super();
        this._signer = new BurnerSigner();
    }

    role() { return 'burner'; }

    /**
     * Fetch cached status from Android. Returns null fields when burner not
     * configured (graceful — never throws on unconfigured state).
     */
    async _status() {
        const res = await androidBridgeCall('/burner/status', {}, 5000);
        if (!res || res.error) return { configured: false };
        return res;
    }

    async pubkey() {
        const s = await this._status();
        return s.configured ? (s.pubkey || null) : null;
    }

    /**
     * Returns balances as atomic-unit strings, OR null fields when the
     * RPC fetch hasn't landed yet (BAT-582 R2 — /burner/status omits
     * balance fields until the RPC fetch is wired). Callers must treat
     * null as "unavailable", not "zero". Network is mainnet for V1
     * (per BAT-582 contract); the network field comes from /burner/status
     * for forward-compat.
     */
    async balance() {
        const s = await this._status();
        if (!s.configured) return { sol: null, usdc: null };
        // BAT-582 R2: surface null when /burner/status doesn't include
        // the field. The previous "|| '0'" fallback created the
        // user-facing bug where a configured-but-funded burner displayed
        // as "0 SOL, 0 USDC" — caller has to check for null.
        return {
            sol:  (s.balanceSol  != null) ? String(s.balanceSol)  : null,
            usdc: (s.balanceUsdc != null) ? String(s.balanceUsdc) : null,
        };
    }

    signer() { return this._signer; }
}

module.exports = { BurnerWallet };
