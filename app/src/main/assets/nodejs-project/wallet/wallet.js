// SeekerClaw — wallet/wallet.js
// Wallet interface (BAT-582). Burner and Main both implement this.
//
// Contract:
//   - role()      → "burner" | "main"
//   - pubkey()    → Promise<string | null> (base58; null if unconfigured)
//   - balance()   → Promise<{sol: string, usdc: string}> (atomic units, BigInt-compatible strings)
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
