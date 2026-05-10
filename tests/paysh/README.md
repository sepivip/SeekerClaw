# pay.sh / x402 test suite

End-to-end fixtures and probes for the SeekerClaw `agent_pay` x402 client,
per BAT-582 contract addendum v1.6 (Codex sign-off 2026-05-10).

## Why this exists

Mid-PR-364 device test, we discovered the agent's `agent_pay` tool
silently rejected real pay.sh endpoints (Tripadvisor, CoinGecko, Textbelt)
as `no_protocol_match`. Root cause: our v1.4 fixture
(`tests/payment/fixtures/paysh-sandbox-402.json`) was synthetic and based
on the canonical x402 v1 draft, while pay.sh has moved to **x402 v2** —
different field names (`amount` vs `maxAmountRequired`), different
network format (CAIP-2 `solana:<genesis>` vs bare `"solana"`), different
proof-header path (`payment-required` header vs body-only), and
multi-chain offers (Base + Solana side-by-side).

This directory holds the regression net for v2 protocol support:
real-wire captures, synthetic edge-case fixtures, and dry-run validators.

## Layout

```
tests/paysh/
├── lib/
│   ├── probe.js             # one-shot HTTP probe (GET/POST), no payment
│   └── sanitize.js          # strips secrets/PII before commit (per contract amendment 6)
├── captures/                # committed fixtures — sanitized 402 + success responses
│   ├── tripadvisor-search-402.json           # v2, body-form, multi-chain
│   ├── coingecko-trending-pools.json         # v2, header-form (payment-required base64)
│   ├── textbelt-text-402.json                # v2, body-form, POST endpoint
│   ├── textbelt-status-free.json             # v2, body-form, GET endpoint
│   ├── synthetic-malformed-402.json          # 402 with no x402 fields → reject
│   ├── synthetic-no-solana-multichain-402.json  # EVM-only multi-chain → reject
│   ├── synthetic-v3-402.json                 # x402Version: 3 → reject (forward-compat)
│   └── synthetic-non-usdc-402.json           # USDT asset on Solana → reject
├── probe-all.js             # Layer 1 — capture real 402 responses (no payment)
└── README.md
```

## Layers (per contract v1.6)

### Layer 1 — Catalog probe (`probe-all.js`)

Hits each curated pay.sh service once, captures the 402 response
verbatim, sanitizes via `lib/sanitize.js`, and writes to `captures/`.

**Cost: $0.** No `X-PAYMENT` or `PAYMENT-SIGNATURE` header is sent.
Paid endpoints respond with 402 + their requirements — that's exactly
the data we want to commit as a fixture.

```bash
# Probe everything in the curated list
node tests/paysh/probe-all.js

# Probe a single service
node tests/paysh/probe-all.js --service tripadvisor
```

Re-run when:
- A service's protocol shape may have changed (capture diff in PR review)
- Adding a new service to the regression set (edit `PROBE_LIST` in `probe-all.js`)

### Layer 2 — Detect/build/settle dry-run (`validate-detect.js`)

(Coming in Phase 7 of the v1.6 implementation.) Runs every committed
capture through `X402Protocol.detect()` + `build()` + `settle()` (with
mocked HTTP for settle). Validates:
- Real captures → detect=true, build=ok, settle uses correct proof header per version
- Synthetic captures → detect/build/settle reject with the documented `expectedRejection` code

**Cost: $0.** No live network, no signing, no broadcast.

### Layer 3 — Curated live-pay (`live-pay-curated.js`)

(Coming in Phase 7.) Runs full e2e payment against 3-5 hand-picked
services. **Gated on `--live` flag (default off).** CI never runs this.

**Cost: ~$0.30 USDC** total across the curated set.

## Sanitization (per contract amendment 6)

All committed captures pass through `lib/sanitize.js` which strips:

- `Authorization`, `x-api-key`, `cookie`, `set-cookie`, `x-payment`,
  `payment-signature` headers
- Phone numbers (regex `\+\d{6,}`)
- Email addresses
- `.env`-shaped lines (`KEY=VALUE` with ALL-CAPS key)
- Secret-prefixed tokens (`sk-…`, `key-…`, `bearer-…`, etc.)
- Long hex (≥32 chars) and long base64 (≥40 chars) — except inside
  documented x402 protocol fields (`payTo`, `asset`, `network`,
  `extra.feePayer`, etc.) which ARE the data we want.

What we PRESERVE: x402 protocol fields verbatim (`x402Version`,
`accepts`, `amount`, `payTo`, `asset`, `network`, `scheme`, `errorCode`,
`errorMessage`), public service metadata (URL, method, content-type),
HTTP status, and structural shape.

## Adding a new service to the regression set

1. Edit `probe-all.js` `PROBE_LIST` — add a new entry with `label`,
   `description`, `url`, `method`, optional `body`, `expect`.
2. Run `node tests/paysh/probe-all.js --service <new-label>` to capture.
3. Inspect the new capture in `captures/` — check sanitization is clean.
4. Commit both `probe-all.js` change and the new capture together.
5. Once `validate-detect.js` exists, ensure it covers the new shape.

## Adding a new synthetic edge-case fixture

For fail-closed proofs that don't have a real-wire equivalent:
1. Author the JSON file directly under `captures/synthetic-<name>.json`.
2. Include the full `_meta` block: `kind: synthetic`, `purpose`,
   `expectedRejection`.
3. Add a corresponding test case in `validate-detect.js` (Phase 7).

## Security notes

- Never commit `.env`, API keys, burner secrets, phone numbers, or
  paid-response bodies with private data. The sanitizer is the gate;
  manually inspect every new capture in `git diff` before push.
- `--live` payment scripts (Phase 7) MUST default to off and require
  explicit opt-in, even when secrets are present in the environment.
