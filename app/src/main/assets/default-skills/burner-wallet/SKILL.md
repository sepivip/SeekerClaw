---
name: burner-wallet
description: "Operate the burner wallet — a small, app-managed Solana wallet that signs autonomously within caps. Use when: user asks about the burner, autonomous payments, x402, raising/lowering caps, funding the burner, or wiping/rotating it. Don't use when: user wants a regular MWA-popup transfer (just call solana_send / solana_swap and let routing decide)."
version: "1.0.0"
metadata:
  openclaw:
    emoji: "🔥"
    requires:
      bins: []
      env: []
---

# Burner Wallet

The burner wallet is a small, app-managed Solana wallet that lives inside SeekerClaw. Its private key is stored encrypted in Android's KeyVault and **never** crosses the bridge into the Node.js agent. The agent can ask the bridge to sign transactions on its behalf — but only within caps the user controls.

## When to use the burner vs the main wallet

| Situation | Wallet |
|-----------|--------|
| Small autonomous spend (<= per-tx cap) | **Burner** — silent, no popup |
| x402 payment for a paid API | **Burner** — autonomous by design |
| Recurring DCA inside daily cap | **Burner** |
| Price-triggered limit order inside cap | **Burner** |
| Large transfer (> per-tx cap) | **Main** — requires user popup |
| User says "send from my wallet" / "approve in Phantom" | **Main** |
| User explicitly opts into popup | **Main** |
| Burner not configured | **Main** (only choice) |

The agent does **not** decide routing — `caps/preflight.js` does, based on cap math. The agent's job is to USE the right wallet semantics in conversation:

> "I'll send 0.001 SOL from your **Burner wallet** — that's under your 0.05 per-tx cap, so it goes through silently."

> "0.5 SOL is over your burner per-tx cap. I can either raise the cap (let me know your new limit) or send it from your **Main wallet** (that'll pop your wallet app for approval)."

Never paraphrase as "your wallet" — always say "Burner wallet" or "Main wallet" so the user knows which is signing.

## Caps

The burner has four caps, all stored as atomic units (lamports for SOL, microunits for USDC):

- **per_tx_sol**: max SOL per single transaction
- **per_tx_usdc**: max USDC per single transaction
- **daily_sol**: max SOL spent in a 24-hour window (UTC midnight rollover)
- **daily_usdc**: max USDC spent in a 24-hour window (UTC midnight rollover)

A transaction must pass BOTH per-tx AND daily checks to route through the burner. Above either cap, the agent gets a "block" decision and must propose either a cap raise or a main-wallet fallback.

Daily windows reset at **00:00 UTC**. If the user is in a different timezone, mention this — "daily caps reset at midnight UTC, which is X your local time."

## Suggesting cap raises

When a transaction is blocked by the burner cap, ALWAYS confirm with the user before raising. Use `wallet_set_caps` — the confirmation gate auto-shows an old → new diff.

Good pattern:

> "0.2 SOL is over your burner per-tx cap of 0.05 SOL. Want me to raise per_tx_sol to 0.25 SOL so this can go through silently? Or should I send it from your Main wallet (popup required)?"

After approval:

> "Raised per_tx_sol from 0.05 → 0.25 SOL. Now sending 0.2 SOL from your Burner wallet."

Never raise caps without showing the diff. Never lower-then-raise to bypass a refusal — the user controls caps, period.

## Funding the burner

The burner has its own pubkey separate from the main wallet. To fund it, the user sends SOL or USDC from any source (their main wallet, an exchange, another wallet) to the burner's address.

The agent can show the burner address via `wallet_status`. Settings → Burner Wallet has a copy button for the address (QR code rendering is deferred to a follow-up). Users fund the burner by copying the address and pasting it into their main wallet's Send screen.

Recommend small amounts — the burner is **disposable**. Don't suggest funding it with more than the user is willing to lose to a bug, key compromise, or runaway spend (caps protect against the last but not the first two).

## Wipe + Rotate

- **Wipe**: deletes the burner private key. After wipe, the burner is unconfigured; tools fall back to MWA. The wipe dialog shows the burner address explicitly so the user can drain it first if they forgot.
- **Rotate**: generates a new burner key, deletes the old one. Old key is unrecoverable — recommend draining the old burner BEFORE rotating.

Both actions live in Settings → Burner Wallet → Danger Zone. The agent can REMIND the user to drain the burner before either action, but cannot trigger wipe/rotate from chat (they're Settings UI gestures, intentional friction).

## Network

V1 supports **Solana mainnet only**. Devnet is deferred to V2. Caps + the design (~$5 max at risk in any 24h window with conservative defaults) make mainnet device testing safe.

## Common patterns

**User: "Send 0.001 SOL to <addr>"**
→ Routing decision: burner (under cap) → silent send → reply with signature + "from your Burner wallet."

**User: "Buy 1 SOL of USDC"**
→ `solana_quote` first (always), confirm with user, `solana_swap`. Routing decides; the agent narrates which wallet signed.

**User: "Pay this x402 endpoint"**
→ `agent_pay(url, max_usdc)` reads the cap the user provided, fetches the 402 challenge, builds a USDC transfer, routes through burner. See **## agent_pay** below.

**User: "What's my burner balance?"**
→ `wallet_status` returns caps + today's spend + remaining daily for the burner. The burner's BALANCE field is currently `null` / "unavailable" (RPC balance fetch is a known follow-up). Tell the user "burner balance is temporarily unavailable" rather than reporting "0". Main-wallet balance is fetched live and is real.

**User: "Raise my daily SOL cap to 0.5"**
→ `wallet_set_caps({daily_sol: "0.5"})`. The confirmation card auto-shows the old → new diff.

**User: "Cancel my limit order #abc"**
→ `jupiter_trigger_cancel({orderId: "abc"})`. Ownership lookup decides routing — burner-created → silent, main-created → MWA popup. The agent should NOT pick a wallet for cancels; the bridge map is the source of truth.

## agent_pay

**What it does:** `agent_pay(url, max_usdc)` fetches an x402-protected HTTP endpoint and pays the demanded USDC fee from the burner wallet. The flow is: GET → 402 with payment requirements → build USDC transfer → burner signs → retry GET with proof header → return resource. The whole thing is one tool call.

**When to use it:**
- Paid APIs (pay.sh catalog services, x402-enabled endpoints)
- Micro-payments for individual data lookups, model inference, premium content
- Any endpoint that returns 402 Payment Required with x402 v1 OR v2 payment requirements

**x402 protocol version support:**
- **v1** — fully supported: detect, build, AND settle. Production-pinned against `tests/payment/fixtures/paysh-sandbox-success.json`.
- **v2** — detect + build supported (handles CAIP-2 `solana:<genesis>` network, `amount` field, `payment-required` header delivery, multi-chain pick-Solana). **Settle on v2 currently rejects with `v2_settle_not_implemented`** — the agent recognizes v2 challenges and can build the USDC transfer, but cannot complete payment until the v2 success-response fixture is captured from a real endpoint (Phase 5 of BAT-582 v1.6). If the user wants to pay a v2 endpoint right now, surface this honestly: "I can detect this is x402 v2 and prepare the payment, but settlement on v2 isn't yet wired — try again after the v2 capture lands."
- **v3+** — rejected as `unsupported_version` (forward-compat fail-closed).

**Hard limits (V1 envelope):**
- HTTPS only (debug builds also accept http://localhost for sandbox testing)
- GET only — no POST, PUT, DELETE (POST support is planned in a follow-up phase)
- Solana mainnet only — multi-chain offers (Base + Solana) pick Solana; EVM-only is rejected as `no_solana_offer`
- USDC only (asset must be the canonical USDC mint `EPjFWdd5...`; EVM USDC contracts rejected as `non_usdc_asset`)
- Single payment per call (no retry chains)
- Response body capped at 1 MB; total timeout 30 s
- Refuses if no burner is configured (no fallback to main wallet — agent_pay is burner-only by design)

**How `max_usdc` gates spending:** `max_usdc` is a per-call ceiling expressed as a decimal string (e.g. `"0.10"`). The tool rejects with `demand_exceeds_max_usdc` if the 402 demand exceeds it. This is independent of the burner's per-tx and daily USDC caps — the demand must fit BOTH ceilings.

**What NOT to use it for:**
- Regular HTTP fetches — use `web_fetch` for unauthenticated content
- POST / PUT / DELETE — agent_pay is GET-only (POST support is a future BAT)
- Authenticated APIs that use Bearer tokens, API keys, or OAuth — agent_pay only handles x402
- Endpoints that don't speak x402 — if the response isn't 402 with x402 v1/v2 requirements, the tool either returns the resource directly (200) or fails with `no_protocol_match`

**Example:**
```
Result: agent_pay(url="https://pay.sh/sandbox/echo", max_usdc="0.10")
→ returns the API response (status, headers, body) plus a `payment` block with
  amount_atomic_usdc, recipient, signature, protocol="x402".
```

**Patterns:**

> User: "Get me the latest data from <pay.sh url>, willing to spend up to 25 cents"
> → `agent_pay({url: "<url>", max_usdc: "0.25"})`. Tool either returns the resource (success) or a clear error (boundary rejection / cap insufficient / endpoint unreachable).

> User: "Try this paid API: <url>"
> → Ask: "What's the most you're willing to pay per call?" — never pick a `max_usdc` value yourself; the user controls the ceiling.

> 402 demand > max_usdc:
> → Tool returns `demand_exceeds_max_usdc`. Tell the user the actual demand and ask whether to retry with a higher cap.

**Diagnostics:** see DIAGNOSTICS.md → "agent_pay" section for the full error catalog (`non_https`, `private_ip`, `non_solana_network`, `non_usdc_asset`, `demand_exceeds_max_usdc`, `response_too_large`, `timeout`, `burner_not_configured`, `no_protocol_match`, `burner_cap_exceeded`).
