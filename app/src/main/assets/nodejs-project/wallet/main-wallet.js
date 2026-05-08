// SeekerClaw — wallet/main-wallet.js
// MainWallet — wraps the existing user MWA wallet.
//
// pubkey comes from solana_wallet.json (written when the user authorizes
// MWA on first connect — see existing solana.js getConnectedWalletAddress).
// Balance is fetched via the existing RPC helpers in solana.js. We DO NOT
// duplicate any of that code here — this file is a thin façade.
//
// Phase 1: stub structure. Phase 4: pubkey + balance wired against
// existing solana.js helpers (lazy require to keep this module pure for
// smoke loading).

'use strict';

const { Wallet } = require('./wallet');
const { MwaSigner } = require('./mwa-signer');

// Lazy-load solana.js so smoke harness can require this module under
// fixtures that don't have a workDir / config.json yet. solana.js itself
// requires config.js at top level.
function _solanaMod() {
    // eslint-disable-next-line global-require
    return require('../solana');
}

class MainWallet extends Wallet {
    constructor() {
        super();
        this._signer = new MwaSigner();
    }

    role() { return 'main'; }

    /**
     * Returns the connected MWA wallet address (base58) or null if MWA has
     * not been authorized yet. Never throws — getConnectedWalletAddress()
     * does throw when the file is missing/malformed; we catch and return null.
     */
    async pubkey() {
        try {
            return _solanaMod().getConnectedWalletAddress();
        } catch (_) {
            return null;
        }
    }

    /**
     * SOL + USDC balance for the connected MWA wallet, returned as
     * atomic-unit BigInt-compatible strings. Returns "0" / "0" if the
     * wallet isn't authorized or RPC fails — never throws.
     */
    async balance() {
        let address;
        try { address = _solanaMod().getConnectedWalletAddress(); } catch (_) { return { sol: '0', usdc: '0' }; }
        if (!address) return { sol: '0', usdc: '0' };

        let solAtomic = '0';
        let usdcAtomic = '0';
        try {
            const balanceResult = await _solanaMod().solanaRpc('getBalance', [address]);
            if (balanceResult && !balanceResult.error && balanceResult.value != null) {
                // SOL RPC returns lamports (atomic) directly.
                solAtomic = String(balanceResult.value);
            }
        } catch (_) { /* ignore — keep "0" */ }

        try {
            const tokenResult = await _solanaMod().solanaRpc('getTokenAccountsByOwner', [
                address,
                { programId: 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA' },
                { encoding: 'jsonParsed' },
            ]);
            if (tokenResult && tokenResult.value) {
                for (const acc of tokenResult.value) {
                    try {
                        const info = acc.account.data.parsed.info;
                        if (info && info.mint === 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v') {
                            // USDC. info.tokenAmount.amount is the atomic-unit string.
                            usdcAtomic = String(info.tokenAmount.amount || '0');
                            break;
                        }
                    } catch (_) { /* skip malformed accounts */ }
                }
            }
        } catch (_) { /* ignore — keep "0" */ }

        return { sol: solAtomic, usdc: usdcAtomic };
    }

    signer() { return this._signer; }
}

module.exports = { MainWallet };
