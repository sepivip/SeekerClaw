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

## Regenerating the pinned fixture

```bash
cd tests/jupiter-ultra
node live-capture-sim-fixture.js
```

The capture script writes both the canonical `sim-deposit-pinned.json` AND a
timestamped audit-trail copy. Verify the canonical file before committing
that it contains:
- `verdict: "option_c_confirmed_inputTokenAccount"`
- `optionConfirmed: "C"`
- `preSnapshot` and `sim` both populated (not null)
- `sim.accounts[indexOf(inputTokenAccount)]` post-state with decoded
  `splToken.owner === receiverAddress`
- No JWT, no Bearer tokens, no raw private key bytes
