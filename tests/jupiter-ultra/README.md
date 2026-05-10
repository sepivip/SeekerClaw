# Jupiter Ultra + x402 — local tests

Local end-to-end tests for the BAT-582 burner-wallet swap and pay.sh / x402
payment flows. Same code path as production (`payment/x402.js`,
`solana.js:jupiterUltraOrder/Execute`) but signed locally with a Node-only
Ed25519 helper instead of going through Android KeyVault.

**Why these exist:** the agent reported "Jupiter Ultra did not return a
transaction" on a 0.005 SOL → USDC swap. The on-device path makes that hard
to diagnose (system prompt → Telegram → bridge → Node → Ultra). These tests
hit Ultra directly with the same params and surface the full response body
(including the `errorCode`/`errorMessage` fields the production code throws
away).

## Layout

```
tests/jupiter-ultra/
├── .env.test.example       # Template — copy to .env.test (gitignored)
├── lib/
│   ├── load-env.js         # Reads .env.test, validates per-layer
│   ├── base58.js           # Base58 encode/decode (matches payment/x402.js)
│   ├── jupiter.js          # Minimal Jupiter Ultra REST client
│   ├── sign-tx.js          # Local Ed25519 signer (mirrors Android KeyVault)
│   ├── derive-pubkey.js    # Print base58 pubkey from secret
│   └── generate-wallet.js  # Fresh keypair generator
├── 01-probe-order.js       # Layer 1: order probes at multiple amounts
├── 02-find-threshold.js    # Layer 2: binary-search Ultra's minimum trade size
├── 03-sign-execute.js      # Layer 3: real swap end-to-end
└── 04-x402-paysh.js        # Layer 4: pay.sh + x402 flow
```

## Setup

1. **Generate a fresh test wallet:**

   ```bash
   node tests/jupiter-ultra/lib/generate-wallet.js
   ```

   Copy the printed `BURNER_PUBKEY` and `BURNER_SECRET_KEY` lines.

2. **Create `.env.test`:**

   ```bash
   cp tests/jupiter-ultra/.env.test.example tests/jupiter-ultra/.env.test
   ```

   Open it and fill in:
   - `JUPITER_API_KEY` — free key from [portal.jup.ag](https://portal.jup.ag)
   - `BURNER_PUBKEY` + `BURNER_SECRET_KEY` — from step 1
   - `SOLANA_RPC` — leave default or use Helius/Triton if you have one
   - `MAX_USDC_ATOMIC` — Layer 4 only; 1_000_000 = 1 USDC cap

3. **Fund the test wallet:**

   Send ~0.02 SOL to the printed pubkey on Solana mainnet. For Layer 4
   (x402), also send ~1 USDC and ~0.005 SOL extra for ATA rent.

## Running

Each layer is independent. Run in order or skip ahead.

### Layer 1 — Order probes (no signing, no funds at risk)

```bash
node tests/jupiter-ultra/01-probe-order.js
```

Hits Ultra `/order` at 0.001, 0.005, 0.01, 0.02, 0.05, 0.1 SOL. Prints
HTTP status, whether the response had a `transaction` field, and any
`errorCode`/`errorMessage`. **This is the diagnostic for the 0.005 SOL
mystery.**

### Layer 2 — Threshold finder (no signing)

```bash
node tests/jupiter-ultra/02-find-threshold.js
```

Binary-searches the cutoff lamport amount for SOL → USDC. Output: "cutoff
is between X and Y SOL." Use this to add a pre-flight check in
`tools/solana.js`.

### Layer 3 — Real swap (real funds spent)

```bash
node tests/jupiter-ultra/03-sign-execute.js [amountSol]
```

Default 0.01 SOL. Runs Ultra `/order` → local Ed25519 sign → Ultra
`/execute`, prints the on-chain signature. Same code path the production
agent runs.

### Layer 4 — pay.sh + x402 (real funds spent)

```bash
# Build + sign only (no settle):
node tests/jupiter-ultra/04-x402-paysh.js --dry-run

# Full flow:
node tests/jupiter-ultra/04-x402-paysh.js
```

Imports the **real** `payment/x402.js` module — same code agent_pay calls.
Demonstrates 402 detection → tx build → sign → settle round-trip.

## What this proves vs. doesn't prove

✓ Confirms Ultra's actual response shape at tiny amounts
✓ Confirms the Ed25519 sign path works against real Ultra
✓ Confirms x402 build + settle work against the real pay.sh fixture
✓ Confirms `payment/x402.js` is loadable + correct without the bridge

✗ Does NOT exercise Android KeyVault, BurnerSigner bridge, or cap reservation —
  those layers must still be device-tested.
✗ Does NOT exercise the agent's confirmation gates — that's a Telegram-flow
  concern.

## Security notes

- `.env.test` is gitignored under the repo-root `.env.*` rule. Verify with
  `git status` before committing test changes.
- Use a **fresh, dedicated test wallet** — never paste your production
  burner secret here.
- Test wallet should hold only the test budget (~0.02 SOL + ~1 USDC).
  Drain it after testing.
