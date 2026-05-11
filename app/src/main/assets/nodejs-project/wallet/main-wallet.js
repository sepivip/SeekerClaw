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
     * atomic-unit BigInt-compatible strings.
     *
     * BAT-582 R27: returns `null` for sol/usdc when the underlying RPC
     * fetch FAILS (network error, RPC error envelope) so callers can
     * distinguish "transient outage" from "real zero balance". Pre-fix
     * returned "0"/"0" in both cases, making a flaky RPC look exactly
     * like an empty wallet — the worst possible failure mode for a
     * wallet UI (user thinks funds vanished). Matches the burner-side
     * fix in SolanaBalanceFetcher.fetch() (R15).
     *
     * Returns:
     *   - { sol: null, usdc: null } when wallet isn't authorized
     *   - { sol: null, usdc: "<n>" } when SOL fetch fails but USDC succeeds (or vice versa)
     *   - { sol: "<n>", usdc: "<n>" } when both succeed (n = "0" is a real zero)
     *
     * Never throws.
     */
    async balance() {
        let address;
        try { address = _solanaMod().getConnectedWalletAddress(); } catch (_) { return { sol: null, usdc: null }; }
        if (!address) return { sol: null, usdc: null };

        // BAT-582 R27: null sentinels distinguish "fetch never succeeded"
        // (transient RPC failure → show "unavailable") from "fetch succeeded
        // with zero" (real empty wallet → show "0").
        let solAtomic = null;
        let usdcAtomic = null;
        try {
            const balanceResult = await _solanaMod().solanaRpc('getBalance', [address]);
            if (balanceResult && !balanceResult.error && balanceResult.value != null) {
                // SOL RPC returns lamports (atomic) directly.
                solAtomic = String(balanceResult.value);
            }
        } catch (_) { /* leave null — caller renders "unavailable" */ }

        try {
            // BAT-582 R6: filter directly by the USDC mint instead of fetching
            // every SPL token account. The previous programId filter could
            // pull dozens of accounts for NFT collectors / memecoin holders.
            //
            // BAT-582 R21 (correctness fix): SUM across all matching token
            // accounts, not just the first. getTokenAccountsByOwner with a
            // mint filter typically returns 1 row (the ATA) but is NOT
            // guaranteed to — a wallet can legitimately hold USDC across
            // multiple token accounts (e.g. one ATA + one auxiliary account
            // created manually or by a dApp). Pre-fix the function returned
            // only the first account's balance, under-reporting in those
            // cases. Sum with BigInt to avoid precision loss for amounts
            // larger than Number.MAX_SAFE_INTEGER microunits (≈ 9 trillion
            // USDC; very unlikely but defensive).
            const tokenResult = await _solanaMod().solanaRpc('getTokenAccountsByOwner', [
                address,
                { mint: 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v' },
                { encoding: 'jsonParsed' },
            ]);
            if (tokenResult && !tokenResult.error && tokenResult.value) {
                let total = 0n;
                for (const acc of tokenResult.value) {
                    try {
                        const info = acc.account.data.parsed.info;
                        if (info && info.mint === 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v') {
                            const raw = String(info.tokenAmount.amount || '0').trim();
                            // Defensive parse: only accept digit strings (no
                            // signs, no decimals); silently skip malformed
                            // entries — we already wrap a try/catch around
                            // each account so malformed shapes don't poison
                            // the whole sum.
                            if (/^[0-9]+$/.test(raw)) total += BigInt(raw);
                        }
                    } catch (_) { /* skip malformed accounts */ }
                }
                // Empty array (no USDC ATA, wallet never held USDC) is a
                // REAL zero balance, not an error — return "0", not null.
                // null is reserved for "we couldn't fetch."
                usdcAtomic = total.toString();
            }
            // If tokenResult had an error or null value, usdcAtomic
            // stays null → caller renders "unavailable."
        } catch (_) { /* leave null — caller renders "unavailable" */ }

        return { sol: solAtomic, usdc: usdcAtomic };
    }

    signer() { return this._signer; }
}

module.exports = { MainWallet };
