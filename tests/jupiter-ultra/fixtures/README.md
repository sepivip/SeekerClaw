# Jupiter test fixtures

This directory holds Jupiter Trigger V2 / DCA flow snapshots captured against
the burner test wallet at `tests/jupiter-ultra/.env.test`.

## What is tracked

Only the canonical `*-pinned.json` files are committed. These are reproducible
snapshots used as inputs to replay tests in `tests/nodejs-project/`.

- `sim-deposit-pinned.json` — BAT-1025 v9.1 C1 capture: Jupiter Trigger V2
  deposit transaction + simulator post-state. Drives the
  `burner-policy.validateSimDelta` owner-slot assertion replay test.

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
