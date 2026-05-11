// SeekerClaw — wallet/wallet.js
// Wallet interface (BAT-582). Burner and Main both implement this.
//
// Contract:
//   - role()      → "burner" | "main"
//   - pubkey()    → Promise<string | null> (base58; null if unconfigured)
//   - balance()   → Promise<{sol: string | null, usdc: string | null}>
//       - Atomic-unit strings (lamports for SOL, microunits for USDC)
//       - Either field MAY be null when the value is currently unavailable
//         (e.g., burner balance pending RPC wiring — BAT-582 R2). Callers
//         MUST handle null explicitly — do NOT interpolate `null` into a
//         user-facing string and do NOT treat null as "0" (that was the
//         R2 bug: a configured-but-funded burner read as empty).
//       - MainWallet currently always returns strings; BurnerWallet returns
//         null fields when /burner/status omits balance values.
//   - signer()    → Signer instance
//
// Wallets never expose keys. Balance is read-through; cache lifetime is
// the caller's responsibility. Atomic units always — no Number math.

'use strict';

class Wallet {
    role() {
        throw new Error('Wallet.role not implemented');
    }
    async pubkey() {
        throw new Error('Wallet.pubkey not implemented');
    }
    async balance() {
        throw new Error('Wallet.balance not implemented');
    }
    signer() {
        throw new Error('Wallet.signer not implemented');
    }
}

module.exports = { Wallet };
