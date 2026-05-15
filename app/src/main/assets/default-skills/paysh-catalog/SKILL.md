---
name: paysh-catalog
description: "Catalog of pay.sh services payable via agent_pay (x402). OPT-IN ONLY — activate when the user explicitly invokes pay.sh / paysh / x402 / 'pay for'. Stay dormant otherwise; defer to free tools. Full keyword list and policy in SKILL.md body."
version: "1.1.0"
metadata:
  openclaw:
    emoji: "🛒"
    requires:
      bins: []
      env: []
---

# pay.sh Service Catalog

A curated directory of HTTPS endpoints the agent can pay for using `agent_pay` and the burner wallet, **only when the user explicitly opts in** via a pay-intent keyword.

## Default: this skill is DORMANT

For the **vast majority of user messages**, this skill should not activate. The agent's default behavior for any question is:

1. Try training data (facts, definitions, well-established knowledge)
2. Try `web_search` / `web_fetch` (live web data, free)
3. If neither answers and the user did NOT explicitly invoke pay/x402, give a best-effort honest answer noting the limitation — **do NOT autonomously reach for a paid catalog service**

This skill activates ONLY when the user's message contains one of the explicit pay-intent keywords listed below. If you're unsure whether a message is opting in, **prefer the free path** — paid lookups cost USDC and the user did not authorize a charge implicitly.

### Opt-in keywords (skill activates)

- `pay.sh` / `paysh` / `pay sh` — naming the platform
- `x402` — naming the protocol
- `pay for X` / `pay to X` / `pay <amount> to <service>` / `use pay` — explicit paying verb
- `look this up paid` / `fetch this paid` / `buy data from <service>` — explicit paid-fetch verb
- `use <service> to pay` / `pay <service> for X` — service-name + paying verb
- `what can you pay for` / `show me pay.sh services` / `list paid services` — capability question

### NOT opt-in (skill stays dormant)

- Topical / factual questions: *"what's the mass of the sun"*, *"who founded Solana"*, *"what time is it in Tokyo"* → training data or `web_search`
- Live-data questions WITHOUT a paying verb: *"find me a hotel in Rome"*, *"current price of SOL"*, *"best deal on a PS5"* → `web_search`
- General Solana / Jupiter operations: *"check my balance"*, *"send 0.1 SOL to Alice"*, *"swap SOL for USDC"* → use the relevant tool directly (`solana_balance`, `solana_send`, `solana_swap`); these are NOT x402 and don't involve this skill

## What this skill does (once activated)

Once an opt-in keyword fires the skill, the agent's job is:

1. **Match intent → service** by reading `catalog.json` (the index in this folder)
2. **Read the matching `services/<name>.md`** for URL pattern + query construction
3. **Call `agent_pay`** with object-shaped args: `{ url: "<constructed-url>", max_usdc: "<decimal-string-ceiling>", method?: "GET"|"POST", body?: <JSON object or array, required for POST> }`. `max_usdc` MUST be a decimal STRING (not number) — e.g. `"0.05"`. `body` MUST be a JSON object or array (or a JSON string that parses to one); primitives like numbers/strings/booleans are rejected with `body_not_json`. GET calls run silently when under cap. **POST calls always prompt the user for confirmation** regardless of caps (POST can send SMS, post content, or trigger paid actions — the confirmation is by design). Check each service's `method:` field in `catalog.json` before calling.
4. **Return the response** to the user

## Examples

### Activates → paid call

User: *"Use pay.sh to look up the current GDP of Japan in USD."*

Why it activates: contains `pay.sh` + naming a paid lookup.

```
1. Read catalog.json → 'wolfram-alpha' matches the math/facts intent.
2. Read services/wolfram-alpha.md → URL pattern is
   https://wolframalpha.x402.paysponge.com/v1/result?i=<URL-encoded query>
3. URL-encode the query with `encodeURIComponent`. It encodes spaces
   as `%20` and percent-encodes most special characters (`&` → `%26`,
   `=` → `%3D`, `+` → `%2B`, `#` → `%23`, `/` → `%2F`, etc.).
   **NOT encoded** by `encodeURIComponent` (per the JS spec — kept
   unchanged): A-Z a-z 0-9 `- _ . ~ ! * ' ( )`. These chars are valid
   in HTTP query strings as-is, so leaving them unencoded is fine for
   pay.sh's services. If a specific service requires stricter
   RFC3986-style encoding (rare), the service's `services/<id>.md`
   will say so.
   Example for this query:
     encodeURIComponent("current GDP of Japan in USD")
     → "current%20GDP%20of%20Japan%20in%20USD"
   Final URL:
     https://wolframalpha.x402.paysponge.com/v1/result?i=current%20GDP%20of%20Japan%20in%20USD
   Do NOT mix `+` for spaces with `encodeURIComponent` — `+` is form-
   encoded space, and applying encodeURIComponent over a string that
   already contains `+` would turn `+` into `%2B` (literal plus).
4. Invoke agent_pay with JSON args:
   agent_pay({ url: "<constructed-url-above>", max_usdc: "0.05" })
   max_usdc MUST be a decimal STRING (not number). Burner signs
   silently for this GET call since $0.01 << $0.05 ceiling.
5. Return Wolfram's answer with a brief framing.
```

### Activates → catalog browsing (no paid call yet)

User: *"What can you pay for?"*

Why it activates: matches the capability-ask phrase *"what can you pay for"*. (NOT every message containing the word "pay" — only the specific capability-ask phrases listed in the opt-in section above.) Agent reads `catalog.json`, lists the 9 supported services with costs, mentions the 63 known-but-not-usable ones. No `agent_pay` call.

### Does NOT activate → vanilla answer

User: *"What's the mass of the sun?"*

Why it stays dormant: no opt-in keyword. The agent answers from training data: *"The Sun's mass is about 1.989 × 10³⁰ kg."* — **no USDC charge**.

User: *"Find me a hotel in Rome."*

Why it stays dormant: "find" + "hotel" without any paying verb or service name. Use `web_search`. If the user then says *"pay Tripadvisor to find one"* the skill activates and we hit the catalog.

User: *"Check my Solana balance."*

Why it stays dormant: not an x402 query at all. Use `solana_balance` directly. The paysh-catalog skill is unrelated to Solana balance / send / swap operations.

## Reading the catalog efficiently

`catalog.json` is small (9 services, a few KB). Always load it first to pick the service. Then `read` only the service-specific markdown — never load every services/*.md at once. That's the whole point of the per-service layout.

## The `unsupported.json` companion registry

`unsupported.json` lists **63 additional services** that exist on pay.sh today but the agent cannot **end-to-end use** yet — either because `agent_pay` can't pay them (protocol/auth gap), it can pay but can't deliver the response (binary content with no channel attachment path), or the endpoint didn't return a 402 at probe time (broken / moved / re-routed). Read it when:

- The user asks "do you know about service X?" or "is X on pay.sh?"
- The user asks for a capability (translation, image OCR, video analysis, screenshots, Google Vision, etc.) that the supported 9 don't cover
- You want to give an honest "I know it exists but can't deliver it because of Y" answer instead of a generic "I don't have a service for that"

Five reason buckets:

| Reason | What it means | Will we ever use it? |
|---|---|---|
| `mpp_protocol` | Service uses Multi-Party Protocol (newer pay.sh settlement flow we don't implement) | Future BAT — not yet filed |
| `siwx_auth_required` | Service needs Sign-In-With-Solana auth before returning 402 | Adjacent to BAT-697 (Trigger V2 also needs SIWX) — likely unblocked when that lands |
| `invalid_demand` | Service returns 402 with amount=0; agent_pay refuses zero-demand AND our web_fetch throws on 402, so neither tool reaches them | Possible follow-up: a 402-tolerant fetch flag |
| `requires_binary_response` | Service returns binary content (image/audio/video) we can't pipe to Telegram/Discord as attachment | Future BAT — needs `agent_pay` → workspace-file path |
| `endpoint_not_402_at_probe` | Service is listed upstream but our probe got a non-402 HTTP status (4xx/5xx/200/301) — likely broken, moved, or auth-gated differently. Each entry's `note` records the probe-time status code | Re-probe via `tests/paysh/probe-catalog.js` if pay.sh announces the endpoint is back |

**NEVER call `agent_pay` on a service in `unsupported.json`.** Reasons and what to tell the user:

- **`mpp_protocol`** / **`siwx_auth_required`** — `agent_pay` fails at the protocol layer (free, no USDC spent). Tell the user the service is known but uses a protocol we don't support yet.
- **`invalid_demand`** — service returns 402 with amount=0. `agent_pay` refuses zero-demand AND our `web_fetch` throws on any non-2xx, so neither tool reaches it today. Tell the user the service is known but not currently usable via our tools.
- **`requires_binary_response`** — `agent_pay` would actually **succeed and spend USDC** — but the binary response (PNG/audio/video) can't be delivered to Telegram/Discord today. Don't burn their money. Tell them the service is recognized but the binary output isn't deliverable yet.
- **`endpoint_not_402_at_probe`** — service is in pay.sh's upstream catalog but our probe got a non-402 HTTP status (the entry's `note` field records the exact code). `agent_pay` needs a 402 to settle, so it can't pay these. Tell the user the service is listed upstream but our probe found it broken / moved / auth-gated at probe time; suggest re-probing later via `tests/paysh/probe-catalog.js` if pay.sh announces a fix.

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
