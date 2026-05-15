---
name: paysh-catalog
description: "Catalog of pay.sh services the burner wallet can pay autonomously via agent_pay (x402). Use when: the user asks for a capability that maps to a known pay.sh service (computation, screenshots, search, real-estate, etc.) without giving you the URL — e.g. 'take a screenshot of github.com', 'what's the mass of the sun', 'find hotels in Rome'. Also use when the user asks 'what can you pay for' or 'show me pay.sh services'. Don't use when: the user gives you the URL directly (just call agent_pay), wants free info that web_search can answer, or asks about the burner wallet itself (use the burner-wallet skill)."
version: "1.0.0"
metadata:
  openclaw:
    emoji: "🛒"
    requires:
      bins: []
      env: []
---

# pay.sh Service Catalog

A curated directory of HTTPS endpoints the agent can pay for autonomously using `agent_pay` and the burner wallet. Every service in this catalog has been verified to:

- Speak x402 v2 with a Solana-USDC payment leg
- Return a valid 402 our parser builds against
- Charge USDC on Solana mainnet

The agent's job, given intent, is to:

1. **Match intent → service** by reading `catalog.json` (the index in this folder)
2. **Read the matching `services/<name>.md`** for URL pattern + query construction
3. **Call `agent_pay(url, max_usdc, method?, body?)`** with the constructed URL. GET calls run silently when under cap. **POST calls always prompt the user for confirmation** regardless of caps (POST can send SMS, post content, or trigger paid actions — the confirmation is by design). Check each service's `method:` field in `catalog.json` before calling.
4. **Return the response** to the user

## The flow, with an example

User: *"What's the mass of the sun?"*

```
1. Read catalog.json → 'wolfram-alpha' matches "math/science/computation"
2. Read services/wolfram-alpha.md → URL pattern is
   https://wolframalpha.x402.paysponge.com/v1/result?i=<URL-encoded query>
3. Construct: https://wolframalpha.x402.paysponge.com/v1/result?i=mass+of+the+sun
4. Call agent_pay(url, max_usdc=0.05) → burner signs silently (cost $0.01)
5. Return: "About 1.989 × 10³⁰ kg" (paraphrased from Wolfram's response)
```

## Reading the catalog efficiently

`catalog.json` is small (~10 services, a few KB). Always load it first to pick the service. Then `read` only the service-specific markdown — never load every services/*.md at once. That's the whole point of the per-service layout.

## The `unsupported.json` companion registry

`unsupported.json` lists 41 additional services that exist on pay.sh today but our `agent_pay` cannot pay yet. Read it when:

- The user asks "do you know about service X?" or "is X on pay.sh?"
- The user asks for a capability (translation, image OCR, video analysis) that the supported 10 don't cover
- You want to give an honest "I know it exists but can't pay it because of Y" answer instead of a generic "I don't have a service for that"

Four reason buckets:

| Reason | What it means | Will we ever pay it? |
|---|---|---|
| `mpp_protocol` | Service uses Multi-Party Protocol (newer pay.sh settlement flow we don't implement) | Future BAT — not yet filed |
| `siwx_auth_required` | Service needs Sign-In-With-Solana auth before returning 402 | Adjacent to BAT-697 (Trigger V2 also needs SIWX) — likely unblocked when that lands |
| `invalid_demand` | Service demands $0 — it's actually free | Call directly via `web_fetch`, no payment needed |
| `requires_binary_response` | Service returns binary content (image/audio/video) we can't pipe to Telegram/Discord as attachment | Future BAT — needs `agent_pay` → workspace-file path |

**NEVER call `agent_pay` on a service in `unsupported.json`** — it will fail. The agent's job is to tell the user the service exists, explain the reason, and either offer the free alternative (for `invalid_demand`) or admit the gap (for `mpp_protocol` / `siwx_auth_required`).

## When NOT to use this catalog

- **Direct URL provided** — user gives `https://...` already, just call `agent_pay` directly.
- **Free info works** — math facts in your training data, definitions, public Wikipedia content. `web_search` is free; don't burn USDC for things web_search returns.
- **No matching service** — if no entry fits the user's intent in EITHER catalog.json OR unsupported.json, fall back to `web_search` / `web_fetch` and tell the user we don't have a pay.sh service for this yet.

## What's NOT in this catalog (yet)

- Auto-refresh from upstream pay.sh — V1 ships static (this file). V2 will add a refresh tool. Until then the catalog is whatever the APK shipped.
- Services that demand non-USDC assets or non-Solana chains only — filtered out at probe time (see `tests/paysh/catalog-summary.md`).

## Boundaries

- All charges go through the **burner wallet**, never the main wallet. `agent_pay` is **burner-only** — there is no main-wallet fallback. If the user doesn't have a burner configured, `agent_pay` refuses with `burner_not_configured` — tell them to set one up in Settings → Solana Wallet → Burner Wallet.
- `max_usdc` is a **ceiling**, not a target. The actual charge is whatever the service demands, capped at `max_usdc`. Default to `max_usdc = 2× the listed cost` for safety.
- Burner caps (per-tx / daily USDC) apply on top of `max_usdc`. If a single call exceeds the per-tx cap or the daily cap is exhausted, `agent_pay` returns `burner_cap_exceeded` and **does not fall back to the main wallet**. Tell the user to either raise the cap with `wallet_set_caps`, lower their request, or wait for the 00:00 UTC daily reset.

## Failure modes

| Error | What it means | What to do |
|-------|---------------|------------|
| `burner_not_configured` | No burner wallet set up | Tell user to set up in Settings |
| `demand_exceeds_max_usdc` | Service costs more than you offered | Retry with higher max_usdc, within burner cap |
| `burner_cap_exceeded` | Burner per-tx or daily USDC cap insufficient for this charge | Tell user to raise cap with `wallet_set_caps`, lower the request, or wait for 00:00 UTC daily reset. **No main-wallet fallback.** |
| `insufficient_burner_balance` | Burner USDC balance < demanded amount | Reason text states exact shortfall — tell user how much more USDC to send to the burner pubkey, offer to retry once funded |
| `non_usdc_asset` | Service demanded non-USDC payment | Service incompatible — not actionable |
| `no_solana_offer` | Service is EVM-only on this call | Service incompatible — not actionable |
| `unsupported_version` | Service speaks newer x402 than we support | Service incompatible — file a BAT to upgrade |
| HTTP 4xx after payment | Service-side issue (bad params, auth, etc.) | Reply with the error; refund is on the service, not us |
