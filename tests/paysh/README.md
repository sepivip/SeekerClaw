# pay.sh / x402 test suite

End-to-end fixtures and probes for the SeekerClaw `agent_pay` x402 client,
per BAT-582 contract addendum v1.6 (Codex sign-off 2026-05-10).

## Why this exists

During BAT-582 device testing we discovered that `agent_pay` silently
rejected real pay.sh endpoints (Tripadvisor, CoinGecko, Textbelt) as
`no_protocol_match`. Root cause: the committed fixture
(`tests/payment/fixtures/paysh-sandbox-402.json`) was synthetic, based
on the canonical x402 v1 draft, while pay.sh has moved to **x402 v2**.
v2 changes vs v1:
- Field names: `amount` vs `maxAmountRequired`
- Network format: CAIP-2 `solana:<genesis>` vs bare `"solana"`
- Requirements delivery: `payment-required` header (base64) on some
  services (CoinGecko) vs body-only (Tripadvisor, Textbelt)
- Multi-chain offers: Base + Solana side-by-side in a single 402

This directory holds the regression net for **x402 v2 protocol support** —
real-wire captures, synthetic edge-case fixtures, dry-run validators,
and a mocked-settle full-protocol-path validator.

Quick coverage check:

```bash
node tests/paysh/validate-detect.js   # Layer 2 — detect+build, 8/8
node tests/paysh/validate-settle.js   # Layer 2.5 — detect+build+settle, 6/6
```

As of this change, **8/8 detect+build + 3/3 captures + 3/3 invariants pass**:
- **3 real captures build → settle** (Tripadvisor, CoinGecko, Textbelt POST)
  with correctly-shaped `PAYMENT-SIGNATURE` headers.
- **1 real capture** (Textbelt status endpoint) correctly REJECTS at
  build with `invalid_demand` — pay.sh returns 402 with `amount=0` for
  free endpoints; zero-demand isn't a supported mode. Free endpoints
  should be called directly, not via `agent_pay`.
- **4 synthetic edge cases** reject with their documented codes
  (`no_payment_requirements`, `no_solana_offer`, `unsupported_version`,
  `non_usdc_asset`).
- **3 cross-cutting invariants** asserted across all v2 captures: CAIP-2
  network shape preserved, non-empty memo, wire-valid 2-sig v0 tx.

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
├── validate-detect.js       # Layer 2   — detect+build for every capture ($0)
├── validate-settle.js       # Layer 2.5 — detect+build+settle, mocked network ($0)
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

### Layer 2 — Detect/build dry-run (`validate-detect.js`) — SHIPPED

Runs every committed capture through `X402Protocol.detect()` +
`build()`. Stops short of proof-header construction (Layer 2.5) and
the real network call (Layer 3).

Current Layer 2 behavior:
- Real captures (tripadvisor, coingecko, textbelt-text, textbelt-status) →
  detect/build matches their `EXPECTATIONS` entry.
- Synthetic captures → detect/build reject with the documented
  `expectedRejection` code.
- A capture file with no `EXPECTATIONS` entry fails loud (exit 1) so
  new captures can't slip past the regression gate uncovered.

**Cost: $0.** No live network, no signing, no broadcast.

```bash
node tests/paysh/validate-detect.js
```

### Layer 2.5 — Full protocol path with mocked settle (`validate-settle.js`) — SHIPPED

Runs `detect()` → `build()` → `settle()` for every real capture, with
the settle network call MOCKED. Validates the v2 `PAYMENT-SIGNATURE`
proof-header construction and the `PAYMENT-RESPONSE` parsing path
end-to-end without spending USDC.

**Scope:** currently v2-only — all committed real captures (tripadvisor,
coingecko, textbelt-text) are v2. The v1 settle path is exercised by
the legacy tests in `tests/nodejs-project/x402.test.js` against the
pinned `tests/payment/fixtures/paysh-sandbox-success.json` fixture; no
real v1 pay.sh endpoint exists in the wild to capture. If a v1 service
shows up in the future, add a v1 fixture + `expectV2: false` entry and
extend the assertions to cover `x-payment` header shape.

`X402Protocol.settle()` covers both versions in production:
- **v1**: shipped, pinned against `tests/payment/fixtures/paysh-sandbox-success.json`,
  used by `tools/agent_pay.js` for legacy x402 v1 endpoints.
- **v2**: shipped per BAT-582 v1.6 Phase 5 (PRs #366 + #367). Settle()
  emits `PAYMENT-SIGNATURE` (base64 JSON) and parses `PAYMENT-RESPONSE`.
  The bridge multi-sig piece (partial v0 versioned tx signing) lives in
  `SolanaTxSigner.insertSignature(allowPartiallySigned=true)`.

What Layer 2.5 asserts for each real capture:
- Outbound request has correct proof header (v2 → `payment-signature`,
  v1 → `x-payment`).
- Decoded payload has `x402Version`, `resource.url` (R-pr367-fix-1
  regression — pre-fix this was empty), `accepted.{scheme,network,
  amount,asset,payTo,maxTimeoutSeconds,extra}`, `payload.transaction`.
- `accepted.network` is the CAIP-2 wire-form the challenge sent
  (e.g. `solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp`), not normalized to
  bare `"solana"` (R20+ negotiation invariant).
- `accepted.extra` shallow-clones server-provided fields and overrides
  only `memo` (R-pr367-fix-7).
- Header serialized size ≤ 8KB (R-pr367-fix-8 DoS cap).
- `settle()` extracts the on-chain `.signature` from `PAYMENT-RESPONSE`.

Plus 3 cross-cutting invariants over all real captures: CAIP-2 network
shape, non-empty memo, wire-valid 2-sig v0 tx.

**Cost: $0.** No live network, no broadcast. Signing is via a stable
test pubkey (no secret).

```bash
node tests/paysh/validate-settle.js
```

### Layer 3 — Curated live-pay (`live-pay-curated.js`)

(Coming in Phase 7 — to pin a real PAYMENT-RESPONSE success fixture
in addition to the mocked Layer 2.5 path.) Runs full e2e payment
against 3-5 hand-picked services. **Gated on `--live` flag (default
off).** CI never runs this.

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
4. **Add an `EXPECTATIONS` entry in `validate-detect.js` covering the new
   capture file.** The regression gate fails loud on captures with no
   expectation defined, so the build forces this step.
5. Commit `probe-all.js`, the new capture, and the `EXPECTATIONS`
   update together.

## Adding a new synthetic edge-case fixture

For fail-closed proofs that don't have a real-wire equivalent:
1. Author the JSON file directly under `captures/synthetic-<name>.json`.
2. Include the full `_meta` block: `kind: synthetic`, `purpose`,
   `expectedRejection`.
3. **Add an `EXPECTATIONS` entry in `validate-detect.js`** with the
   `expectedBuildError` matching `_meta.expectedRejection`.

## Security notes

- Never commit `.env`, API keys, burner secrets, phone numbers, or
  paid-response bodies with private data. The sanitizer is the gate;
  manually inspect every new capture in `git diff` before push.
- Live payment scripts MUST default to off and require explicit
  `--live` opt-in, even when secrets are present in the environment.
  Currently the only such script is planned (`live-pay-curated.js`);
  none exists yet at the time of this change.
