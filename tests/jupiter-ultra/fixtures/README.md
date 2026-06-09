# Jupiter test fixtures

This directory holds Jupiter Trigger V2 / DCA flow snapshots captured against
real wallets, used as inputs to replay tests in `tests/nodejs-project/`.

## What is tracked

Only canonical, named snapshot files are committed. Each fixture is reproducible
from public on-chain data + the wallet identity recorded in its filename.

- `sim-deposit-pinned.json` — **ARCHIVAL.** BAT-1025 v9.1 C1 capture against
  the burner TEST WALLET at `tests/jupiter-ultra/.env.test`. The v9.1
  architecture this fixture was used to bless turned out to be premised on a
  capture from the wrong wallet (test wallet's Jupiter `inputTokenAccount`
  shape differs from prod burner's Anchor PDA shape). Preserved as historical
  evidence of the test-vs-prod divergence that triggered BAT-1031. **Not
  exercised by current replay tests after BAT-1031.**

- `prod-burner-v2-trigger-2026-06-09.json` — **CANONICAL** for BAT-1031.
  Gate 0 capture against the PROD BURNER (`221Y7STwi4XC8yzT39p8vuKMa8K5XemoXLeDQcsjP1dd`)
  during the v9.1 `simulation_mint_mismatch` reject. Drives the BAT-1031
  Path-A carve-out boundary tests. Contains only public on-chain data +
  policy schema; no secrets.

Audit-trail timestamped captures (`sim-deposit-<unix-ms>.json`,
`v2-flow-<unix-ms>.json`) are ignored by `.gitignore`. They accumulate locally
when the capture scripts are re-run; their value is the audit trail, not
reproducible test input.

## Privacy / secret hygiene

Captures must NEVER contain:
- JWTs from `/trigger/v2/auth/verify`
- Private key bytes
- Full RPC URLs that embed API keys

The capture scripts redact these before writing the fixture. Captures
contain only public Solana on-chain data (account post-state, unsigned tx
bytes) plus Jupiter session references which are redacted when the fixture
is committed.

## Regenerating fixtures

### `sim-deposit-pinned.json` (archival only — do not regenerate)

This is the BAT-1025 v9.1 capture against the test wallet. It is kept
purely as historical evidence of the test-wallet-vs-prod-burner divergence
documented in BAT-1031. The v9.1 verification rubric (Option-C re-pin,
`splToken.owner === receiverAddress` assertion) was retired with the
depositVault architecture and no longer applies to current code — do
NOT use it as a template for new fixtures.

### `prod-burner-v2-trigger-2026-06-09.json` (BAT-1031 canonical)

This fixture was captured against the user's prod burner on 2026-06-09
during the v9.1 `simulation_mint_mismatch` reject. It drives the
BAT-1031 Gate 0 carve-out boundary tests in
`tests/nodejs-project/burner-policy-carveout.test.js`.

To regenerate (only if the on-chain Jupiter response shape changes):
1. Build the throwaway Gate 0 capture APK described in BAT-1031 v1.2
   §"Gate 0 capture mechanism".
2. Install on the user's Seeker, trigger a `jupiter_trigger_create_deposit`
   on the prod burner.
3. `adb pull` the resulting `bat1031-capture-*.json` from
   `/data/data/com.seekerclaw.app/files/workspace/`.
4. Verify the dump contains, before committing:
   - `bat: "BAT-1031"`, `gate: 0`, `kind: "jupiter_trigger_create_deposit"`
   - `burnerPubkey` matches the prod burner pubkey (visible on the
     Seeker's Setup → Burner Wallet → Pubkey field)
   - `sim.value.accounts` + `sim.value.postTokenBalances` populated
   - Public on-chain data only — zero JWTs, zero Bearer tokens,
     zero private key bytes, zero RPC URLs with embedded API keys.
5. Revert the throwaway debug patch before opening any PR.

The matching wallet identity MUST be recorded in the PR description
to avoid repeating the BAT-1025 v9.1 capture-from-the-wrong-wallet
failure mode (see Linear BAT-1031 v1.1 + Appendix A for context).
