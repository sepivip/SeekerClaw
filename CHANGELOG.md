# Changelog

All notable changes to SeekerClaw are documented in this file.
Format based on [Keep a Changelog](https://keepachangelog.com/).

## [Unreleased]

### Fixed

- Fixed a condition where the agent could stop responding — showing a misleading "out of extra usage" error — on a Pro/Max sign-in even with usage remaining. An automatically-generated internal note summarizing routine background check-ins could contain a phrase the AI service rejected; because that note was included in every request, it blocked all replies until it aged out. These trivial check-in notes are no longer generated, any left over from a previous version are filtered out, and the agent now automatically retries once without recent-activity context if a request is unexpectedly rejected — so a single bad note can no longer stall it. The background check-in (heartbeat) mechanism itself is unchanged.
- Clearer authentication-error message: it no longer suggests "API key might be wrong" for Pro/Max sign-in users, who have no API key.
- Grok (xAI) error messages now show the provider's real reason instead of a fabricated "your subscription tier doesn't include API access — add an xAI API key" notice. This applies to both chat replies and the Settings "Test connection" check, and Grok users signed in with a subscription are no longer wrongly told to add an API key. Debug logs also now record the real error code and message. (BAT-1172)

### Changed

- The agent's system prompt now caches more effectively across background check-ins by keeping frequently-changing recent-activity context out of the cached section, lowering token usage per turn.
- Refreshed the Claude Code client version reported on Pro/Max sign-in requests to the current stable, keeping the integration up to date.

### Security

- Hardened `web_fetch` against credential exfiltration on cross-origin redirects: caller-supplied headers (API keys, bearer tokens) are now dropped when a request redirects to a different origin, and a cross-origin `307`/`308` can no longer forward the request body to the new host. Same-origin flows are unchanged. (BAT-1086)
- API-key values stored in `agent_settings.json` are now masked before they reach the AI model. The agent can still read its settings and save keys, but raw key values are never exposed to the model or the chat — the read tool returns them masked, and the `js_eval`/`shell_exec` paths are blocked for that file. Protects provider billing keys even against prompt injection. This is model-facing output masking; the file on disk and the save flow are unchanged. (BAT-1087)
- Strengthened `web_fetch`'s SSRF guard to block private/loopback/link-local addresses across all IPv4 and IPv6 encodings — including IPv6 loopback, IPv4-mapped, ULA, link-local, zone-identifier, and decimal/hex/octal literal forms — and applied the same guard to the file-download path. Only requests to internal addresses are affected. (BAT-1088)

## [2.1.1] - 2026-07-03

> **Reasoning & message-delivery reliability hotfix for the latest Claude
> models.** Fixes three issues that could surface on Claude Sonnet 5, Opus 4.8,
> and other current models — an API error during tool use, a failure when
> Extended Thinking is on with a personal Anthropic API key, and the agent's
> own text being dropped when it used a tool mid-reply. Fully backward-
> compatible; no configuration or data changes.

### Fixed

- Resolved an API error that could interrupt a Claude reply during tool use or
  multi-step responses on the latest models (including Sonnet 5 and Opus 4.8):
  a reasoning step from one turn could be rejected on the next. Reasoning is now
  carried across turns intact.
- Fixed Extended Thinking failing to start on current Claude models when
  connected with a personal Anthropic API key. Reasoning now uses Anthropic's
  adaptive thinking mode, which the newest models require.
- Fixed the agent's own message being dropped when it used a tool in the same
  turn — text the agent sends alongside a tool action is now delivered, not
  only the final reply.

## [2.1.0] - 2026-06-30

> **Autonomous on-chain trading + richer chat.** v2.0 let the agent's burner
> wallet spend USDC autonomously on paid (x402) endpoints; v2.1 extends that to
> trading — the burner can now swap tokens, convert held tokens back to USDC/SOL,
> and place limit/recurring orders, all bounded by the same per-tx and daily caps,
> with a single clean confirmation model. Telegram replies also gain optional rich
> formatting. Fully backward-compatible: the burner is opt-in, so upgrading without
> configuring one behaves exactly as in 2.0.

### Added

- **Autonomous burner swaps & orders** — token swaps, SOL/SPL sends, and limit /
  recurring (DCA) orders can run from the burner under your per-tx and daily caps:
  under cap signs silently; over cap (or with no burner) falls back to a main-wallet
  approval. Every transaction is simulated and validated before signing.
- **Convert held tokens back to USDC/SOL** — the burner can cash a token it holds
  (including fee-free Token-2022 tokens like PYUSD) back to USDC or SOL on its own,
  within caps and a 1% price-impact limit.
- **Autonomous SPL token transfers** — send USDC, BONK, or any classic SPL token
  from the burner, cap-routed like other actions.
- **Telegram Rich Messages** — optional rich formatting (tables, headings, task
  lists, math, spoilers) with automatic fallback to plain text. Toggle in
  Settings → Channel → Telegram → Rich Messages.
- **Better token visibility** — balances now show Token-2022 holdings alongside
  classic SPL tokens and flag partial reads; wallet holdings report correctly.

### Fixed

- **One clean confirmation for wallet actions** — removed a confusing double-prompt;
  each action that needs approval now asks once. Spending capped assets (USDC/SOL)
  under your caps is silent; selling or converting other tokens asks once.
- **More reliable swaps** — burner swaps automatically re-quote and retry on
  transient market slippage instead of failing.
- **Token-2022 swaps** — correct account handling for swaps like USDC→PYUSD.
- **Fewer wallet pop-ups** — the main wallet no longer re-prompts on every signature.
- **Custom model selection sticks** — a custom model chosen in Settings no longer
  reverts on restart; model names display correctly (no more mislabeled "Opus 4.6"),
  and switching OpenAI auth type no longer drops a custom model.
- **Clearer answers about the active model** — after you switch models mid-chat
  (Settings or `/model`), the agent reports the current model and no longer invents
  a past model when asked why an earlier reply differed.

### Changed

- **Updated Claude model lineup** — added **Fable 5** (`claude-fable-5`, new top
  tier), **Opus 4.8** (`claude-opus-4-8`, new default), and **Sonnet 5**
  (`claude-sonnet-5`, the speed/intelligence tier). Opus 4.6 remains available.

### Security

- **Autonomous-signing safety gate** — every burner transaction is simulated and
  checked before signing (drainer detection, balance-change validation, per-account
  loss limits) and fails closed if anything can't be verified.
- **Hardened the internal Node↔Android channel** — DNS-rebind defense, strict
  transaction parsing, and tightened auth-token validation.

## [2.0.0] - 2026-05-19

> **Major version bump.** Promoted from `v2.0.0-rc1` (tagged 2026-05-18) after on-device smoke test on Solana Seeker confirmed all four checklist items: install-over-1.10.0 preserves user memory, System screen reads `2.0.0 (20)` with SHA `54696d42`, Telegram round-trip, paid call via tripadvisor returns real data for $0.01 first try with no retry burn.
>
> The agent now has economic agency: it can hold and spend USDC autonomously on x402-protected paid HTTP endpoints, within user-configured per-tx and daily caps. This is the largest single-release surface expansion in SeekerClaw's history (44 new endpoints across 10 services, 3 new agent-facing tools, a new on-device key-management subsystem). The 1.x → 2.0 jump signals the inflection: pre-2.0, the agent was a smart assistant; post-2.0, the agent can transact.

### Added

#### Burner Wallet & x402 (BAT-582)

- **Burner wallet subsystem** — a small, app-managed Ed25519 keypair encrypted at rest under `filesDir/burner_keys/<id>` using a Keystore-derived AES-256-GCM key (BouncyCastle Ed25519 signing happens inside the vault; the Keystore AES key itself is non-extractable, `userAuthenticationRequired = false`). The agent can sign with the burner autonomously, within user-configured caps. The user-controlled MAIN wallet (via MWA) is unchanged — every action there still triggers an approval popup. The burner is opt-in; until the user imports a key in Settings → Burner Wallet, the agent has one wallet and behaves exactly as in 1.x.
- **`agent_pay` tool** — fetches x402-protected HTTPS endpoints, settles in USDC from the burner. GET runs silently when under cap; POST always asks for user confirmation. Validates the 402 response against a Solana-mainnet + USDC-asset boundary; rejects non-HTTPS, private IPs (SSRF defense), non-Solana networks, non-USDC assets, and demands exceeding the per-call `max_usdc` ceiling.
- **`wallet_status` tool** — reports caps, today's spend, and remaining daily budget for the burner. Surfaces both wallets when the burner is configured; when not, reports only the main wallet and points at Settings → Burner Wallet.
- **`wallet_set_caps` tool** — raise/lower per-tx or daily caps; always confirmed; shows old → new diff.
- **Two independent ceilings** for paid calls — `max_usdc` is the agent-side per-call cap, the burner per-tx + daily caps are the user-controlled hard ceiling. Both must allow the on-chain demand. Pre-flight USDC balance check on the burner ATA refuses underfunded calls BEFORE any 402 probe so users see "send X more USDC to <pubkey>" instead of confusing downstream protocol errors.
- **Cap-routed swap & DCA** — `solana_swap`, `jupiter_dca_create`, `jupiter_trigger_create` are now cap-aware. Under cap → silent burner sign; over cap or burner not configured → main wallet popup. The agent never silently transacts above caps, and never silently transacts WITHOUT a configured burner.
- **POST + body support (BAT-664)** — `agent_pay` accepts `method: "POST"` with `body: <JSON object | array | parseable string>`, up to 8 KB UTF-8 compact. Powers paid services like Textbelt SMS, Reducto document parsing, Perplexity agent queries, and the 21-endpoint stablecrypto market-data wrapper.

#### Paysh-Catalog — 44 Endpoints Across 10 Services

- **`paysh-catalog` skill (BAT-704)** — bundled folder skill listing pay.sh services the agent can reach via `agent_pay`. **OPT-IN ONLY** — activates only when the user's message contains an explicit pay-intent keyword (`pay.sh`, `paysh`, `x402`, `pay for X`, `use <service> to pay`, etc.) or one of the capability-ask phrases ("what can you pay for", "show me pay.sh services"). For all other queries — including ones the catalog could technically answer — the agent uses free tools (training data, `web_search`, `web_fetch`, `solana_*`/`jupiter_*`). Prevents the pre-BAT-704 footgun where the agent autonomously paid for trivia.
- **v2 catalog schema (BAT-761)** — per-endpoint entries (not per-service) with `upstream_ref`, `verification` metadata, `service_id` grouping, `doc_anchor` per-section, and an `audit_pending[]` list of sibling endpoints found-but-not-yet-catalogued. See `paysh-catalog/SCHEMA.md` for the full spec.
- **44 catalogued endpoints across 10 services:**
  - **stablecrypto-market-data (21)** — CoinGecko (price/markets/chart/ohlc/top-movers/trending/categories/onchain-pool/onchain-trending/new-pools, 10 endpoints) + DefiLlama (protocols/protocol/chains/chain-tvl/yields-pools/yields-perps/stablecoins/dex-overview/fees-overview/derivatives-overview/coins-prices-historical, 11 endpoints).
  - **tripadvisor (5)** — nearby-search, search, location-details, location-reviews, location-photos.
  - **rentcast (5)** — markets, avm-value, properties, listings-sale, listings-rental.
  - **crushrewards-pricing (4)** — shopper-best-price, shopper-price-history, shopper-deal-finder, analyst-inflation.
  - **perplexity (2)** — search, v1-agent.
  - **wolframalpha (2)** — v1-result, v2-query.
  - **reducto (2)** — extract, parse (document AI).
  - **2captcha (1)**, **textbelt-sms (1)**, **purch (1)** — singletons.
- **63 unsupported entries** — services we've identified but can't safely route the agent to. Four documented failure sub-cases: (1) protocol-fail (mpp_protocol / siwx_auth_required / invalid_demand), (2) can-pay-can't-deliver (requires_binary_response — would burn USDC on PNG/MP4 bytes), (3) non-402-at-probe (broken/moved/auth-gated catalog URL), (4) unverified_paid_response_shape (evidence about the paid response is contested). Lets the agent answer "I know about X but can't use it because Y" honestly.
- **Catalog maintenance tooling (BAT-761)** — `tests/paysh/probe-catalog.js` with `--audit`, `--drift`, `--status`, `--refresh <id>` modes. Drift mode checks captured 402 responses against current upstream without writing; `--write-checked-at` updates verification timestamps after a clean sweep.
- **BAT-706 audit crawler** — audited 72 pay.sh services, discovered 824 endpoints, of which 384 returned a parseable Solana-USDC 402 (the rest were either non-Solana-USDC paywalls, non-402 HTTP responses, or fetch failures). Snapshot in `tests/paysh/catalog-audit.md`. Roughly 30 of the 384 parsed_ok endpoints are user-facing-meaningful and migrated into the catalog; the rest live in unsupported.json with structured "why not" reasons.

#### Doc Fidelity Fixes

- **BAT-768 fix: stablecrypto body shapes from openapi (#382)** — six blocking shape bugs fixed where the doc inferred bodies from CoinGecko's public REST API (strings, comma-separated) but the gateway openapi declared arrays and string-typed `days`. Six optional-param completions added. The doc now uses `Field | Type | Required | Notes` tables sourced directly from `openapi.json` `requestBody.content.application/json.schema`.
- **BAT-768 fix: rentcast query params from openapi (#383)** — three blocking shape bugs fixed (`/markets` invented `city`/`state`/`bedrooms`; `/properties` invented `id` query param; `/listings/{sale,rental}` invented `priceMin`/`priceMax` instead of the single `price` with numeric-range syntax). Plus completed missing optional params on `/avm/value` and others.

#### Infrastructure & Tests

- **402 detect/settle test harnesses** — `tests/paysh/validate-detect.js` (Layer 2) + `validate-settle.js` (Layer 2.5 mocked) cover 42 `EXPECTATIONS` entries and 37 `SETTLE_CAPTURES` entries with byte-exact pay.sh challenge captures. Catches gateway-protocol regressions before they ship.
- **Capture sanitize hardening (BAT-769)** — `tests/paysh/lib/sanitize.js` redacts payment-signature headers, long base64/hex blobs, and transport-noise headers (`report-to`, `nel`, `rndr-id`, `x-render-origin-server`) so committed capture fixtures contain no live secrets.
- **Tool input-schema validity CI gate** — every tool's `input_schema` is now validated as JSON Schema in pre-push and CI. Catches the BAT-664 schema-kill class (`type: ['object', 'array', 'string']` without `items`) before it takes down agent turns.

#### Agent Self-Awareness

- **Wallets section in `buildSystemBlocks()`** — agent knows about both wallets, their roles, the burner's caps, the network constraint (Solana mainnet only), the OPT-IN policy for `paysh-catalog`, the two-ceiling semantic, the multi-call composition cost transparency rule, and the "do not auto-retry on HTTP 4xx — consult DIAGNOSTICS" guidance.
- **DIAGNOSTICS.md `agent_pay` section** — covers every rejection error code (`non_https`, `private_ip`, `non_solana_network`, `non_usdc_asset`, `demand_exceeds_max_usdc`, `method_not_allowed`, `body_required_for_post`, `body_not_json`, `body_too_large`, `invalid_url`, `dns_timeout`, `dns_lookup_failed`, `response_too_large`, `timeout`, `burner_not_configured`, `no_protocol_match`, `insufficient_burner_balance`, `burner_cap_exceeded`) with symptoms / diagnosis / fix.
- **DIAGNOSTICS.md `paysh-catalog` section** (SAB-AUDIT-v27) — three new entries: (1) doc-vs-gateway divergence (the bug class behind #382/#383), (2) OPT-IN regression (agent autonomously paid for trivia), (3) cost discrepancy (paid more than the catalog `cost_usdc` says).
- **Tool description hardening** — both `memory_save` AND `daily_note` descriptions now explicitly forbid storing secrets (mirrors the prompt's negative-knowledge anchor). Same rule on both dispatch surfaces because daily_note writes to the same plain-text-on-disk + SQL-indexed store as memory_save.

### Changed

- **App version 1.10.0 → 2.0.0 (versionCode 19 → 20).** Major bump signals the burner-wallet inflection.
- **SKILL.md version bumps for `paysh-catalog`** — 1.1.0 (BAT-704 opt-in, #377) → 1.4.0 (BAT-761 v2 schema, #379) → 1.5.0 (BAT-769 perplexity, #380) → 1.6.0 (BAT-768/766 Tier 1 expansion, #381) → 1.7.0 (stablecrypto doc fix, #382) → 1.8.0 (rentcast doc fix, #383). `ConfigManager.seedSkill()` re-seeds workspace files on each bump so existing devices get the latest doc without WIPE.

### Fixed

- **BAT-582 R9 / BAT-664 false-positive `burner_not_configured` for POST only** (commit `6957604c`). The confirmation gate's `_BURNER_STATUS_GATE_TOOLS` had `agent_pay` excluded under R9's v1.4-era optimization, so the BAT-664 POST branch fast-failed every call even when the burner was configured. Now agent_pay is in the gate set; `wallet-registry.test.js` regression-guard locks the membership.
- **agent_pay schema-kill that took down every agent turn** (commit `36e54b1a`). Input-schema had `type: ['object', 'array', 'string']` without `items` for the `body` field — Anthropic API rejected with 400 on every turn before any tool dispatched. New tool-schema validity test + pre-push + CI gate.
- **Insufficient-burner-balance false-protocol-error** — pre-fix, under-funded burners produced confusing `no_protocol_match` or `payment_rejected — server returned 402 again` errors (red herrings; root cause was always "not enough USDC at source"). Now a pre-flight ATA balance check surfaces the exact shortfall with the funding pubkey BEFORE any probe is sent.
- **Layer 3 live-pay memo encoding** (PR #369). Settlement payments now include the correct memo per pay.sh contract.

### Security

- **SSRF defense in `agent_pay`** — DNS-resolves the URL host BEFORE any HTTP request; refuses if the resolved IP is in a private range (10/8, 172.16/12, 192.168/16, 127/8, 169.254/16, ::1, fc00::/7, fe80::/10). Pre-DNS rejections (non-HTTPS, invalid URL, disallowed method) fire even earlier — operator typos diagnosed cleanly without touching attacker-supplied hosts.
- **Burner key never leaves the Kotlin vault.** The Ed25519 seed lives encrypted under `filesDir/burner_keys/<id>` (Keystore-derived AES-256-GCM); BouncyCastle Ed25519 signing happens inside `EncryptedPrefsKeyVault`. Per the Codex pivot: signing is bridge-backed — Node sends a signing request to Kotlin via the localhost bridge; Kotlin decrypts, signs, returns the signed transaction; Node never sees the raw key bytes. No Node-side raw-key handling anywhere in the codebase. App manifest sets `android:allowBackup="false"` so the burner files never enter cloud backups.
- **Bridge auth token** — the localhost bridge between `:node` and Kotlin requires a per-boot auth token that's freshly generated each service start. No process can spoof a request without it.

### Migration

For existing 1.10.0 users on Solana Seeker (or any Android 14+ device):

- **App update (Store / `adb install -r`):** user memory files (SOUL.md, MEMORY.md, IDENTITY.md, USER.md, daily notes, cron jobs) preserved verbatim — no impact on prior conversations, agent personality, or scheduled tasks. User-created skills (anything not shipped in the bundled `assets/default-skills/` set) preserved verbatim. **Bundled default skills** (the 22 in `assets/default-skills/`) are version-aware via `ConfigManager.seedSkill()`:
   - If the user has NOT modified the bundled `SKILL.md` (hash matches manifest), a bundled-version bump **overwrites both `SKILL.md` and all support files** in the skill folder (e.g., paysh-catalog's `catalog.json` + `services/*.md` are re-seeded through 1.1.0 → 1.4.0 → … → 1.8.0 this release). This is the intended path — how 2.0.0 ships updated catalog docs to existing devices.
   - If the user HAS modified the bundled `SKILL.md` (hash mismatch), the seed is skipped entirely and the user's customized version is kept; support files are NOT touched in that case.
   - There is currently no per-support-file hash tracking, so if you edited `catalog.json` or `services/<id>.md` directly on a bundled skill while leaving the `SKILL.md` unchanged, those edits will be overwritten on the next version bump. Bundled folder-shaped skills are intended as curated catalogs — fork them under a new name if you need persistent customization.
- **DIAGNOSTICS.md (behavior change in 2.0.0):** now overwritten from the bundled asset on every service start, replacing the prior one-time `if (!exists)` seed. DIAGNOSTICS.md is bundled documentation read by the agent on demand — same overwrite pattern as PLATFORM.md. Without this change, existing 1.10.0 users would never receive new troubleshooting entries (including the SAB-AUDIT-v27 paysh-catalog section). If a user had hand-edited their workspace DIAGNOSTICS.md (uncommon — there's no UI for it), those edits will be replaced on next launch.
- **Burner wallet:** the agent does NOT auto-create one. Until the user opens Settings → Burner Wallet and imports a key (or uses the in-app "Generate New" flow), the agent runs in single-wallet mode exactly like 1.10.0. The `paysh-catalog` skill stays dormant.
- **Paysh-catalog skill:** auto-seeds on first launch (because it's a default-skill), but OPT-IN means it stays inert until the user invokes a pay-intent keyword. Zero behavior change for users who don't intentionally engage it.
- **Settings changes:** no Settings layout migration needed — Burner Wallet is a new section, doesn't move anything existing.

## [1.10.0] - 2026-05-02

### Added
- **Graceful Node shutdown on user-initiated Stop (BAT-525)** — tapping Stop Agent now triggers a bounded flush handshake (POST `/shutdown/flush` over loopback) before `killProcess()`. The `:node` side persists pending session summaries + dirty SQL.js writes within ~1.5s; Kotlin caps the wait at 2s. The last ~60s of `api_request_log` activity now survives user-Stop. Worst-case wall time 1750ms ≤ 2000ms outer budget; HttpURLConnection timeouts (250ms connect / 1500ms read) are the hard ceiling because HttpURLConnection isn't cooperatively cancellable. Includes 14+ drift-guard tests.
- **Loopback cleartext exemption scoped to 127.0.0.1 only** — added `app/src/main/res/xml/network_security_config.xml` allowing cleartext to the internal control server only. TLS enforcement for all real remote endpoints (Anthropic, OpenAI, OpenRouter, Telegram, Discord, Custom gateway) is unchanged. Surfaced during BAT-525 device test — was a pre-existing latent BAT-514 bug silently breaking every `NodeControlClient.reconcile()` / `healthz()` call in production.
- **Cross-process state migration (BAT-512/513/514/515)** — generic `CrossProcessStore<T>` abstraction (BAT-512) plus migrations of runtime config (provider/authType/model — BAT-513), MCP server configs (BAT-514), and searchProvider + agentName (BAT-515) out of process-local SharedPreferences into shared JSON files. Settings UI changes are LIVE across processes — Settings writes propagate to the `:node` process without a service restart. `saveConfig` does atomic dual-writes with rollback so all three stores stay convergent on FS failure.
- **Internal control server (BAT-514)** — new `internal-control-server.js` hosts loopback HTTP endpoints `/healthz`, `/mcp/reconcile`, `/shutdown/flush` on `127.0.0.1:8766` with per-boot bridge-token auth. Replaces process-local timers for cross-process state propagation.
- **Shared model registry (BAT-517)** — single `model-registry.json` source of truth for the model picker, replacing scattered hardcoded lists. New models slot in by editing one file.
- **`/model` and `/provider` Telegram commands (BAT-504)** — switch model or provider live from chat instead of opening Settings. Both write to `runtime_state.json` overlay and survive restart. `/think` follows the same pattern for reasoning toggles.
- **GPT-5.5 added, GPT-5.2 dropped** — OpenAI model picker refresh.
- **User-configurable max tool uses per turn** — was hardcoded `MAX_TOOL_USES = 25`, now `MAX_STEPS` reads `agent_settings.json` `maxStepsPerTurn` (default **35**, configurable). Settings → Agent → Max tool uses per turn.
- **Message Activity Heatmap (BAT-500)** — System screen now shows a 26-week heatmap of daily `api_request_log` counts. Data persisted in `db_summary_state.dailyActivity` (up to 13 months). Agent has a system-prompt door for "show me my activity" / "how many requests last week" type questions. Fixed weight-based cell sizing prevents right-column clipping.
- **Claude Opus 4.7** — promoted to default for fresh installs (BAT-498). `${activeModel}` substitution in system prompt auto-reflects the new default.
- **User-managed env var store (BAT-495)** — Settings → Env Vars surface for storing API keys / secrets the agent's tool code can read at runtime via `process.env.KEY`. Single-add UI for one-off keys, plus a Raw editor that accepts `.env`-style bulk paste. Values are accessible inside `shell_exec`, `js_eval`, and skills (e.g., `curl -H "Authorization: Bearer $GITHUB_TOKEN"`). New `env_list` tool returns key NAMES only — values stay out of the agent's context unless explicitly read inside a tool call. Skills can gate on env vars via `requires.env` in YAML frontmatter; missing keys block skill activation with a "Settings → Env Vars" prompt to the user. Values registered as secrets to the debug-log mask so they never surface in `node_debug.log` or bug-report screenshots. Caps: 256 keys total, 8 KB per value.
- **Reasoning content preservation across all 4 providers (BAT-549)** — captures and (when supported) replays provider-native reasoning artifacts across tool-loop turns so multi-step thinking survives `/resume` and tool calls without re-prompting. Each provider preserves its own wire shape byte-exact:
  - Anthropic: `thinking` / `redacted_thinking` blocks with signature byte-exact, replayed with the `interleaved-thinking-2025-05-14` beta header
  - OpenAI Responses: full reasoning items with `encrypted_content` for `store:false` (OAuth/Codex) and api_key paths via `include:["reasoning.encrypted_content"]`
  - OpenRouter: `reasoning_details[]` echoed verbatim, plus `reasoning_content` echo gated by R1/V4 model regex
  - Custom: wraps the delegate (OpenAI Responses or OpenRouter Chat Completions) with model-gated echo policy (DeepSeek R1 strip, V4 echo-on-tool-loop, unknown capture-only) — fixes the `/resume` 400 loop on Custom + DeepSeek-V4 gateways
- **Adaptive 3-step quarantine recovery** — when a provider returns "reasoning_content must be passed back" 400, the chat loop runs progressive recovery: cut at last user-message boundary → cut at earliest provider-relevant tool-call turn → full conversation reset. Each step also rewrites the active task-store checkpoint so a later `/resume` can't reload the bad segment. User memory, skills, cron, credentials, and other-chat checkpoints are untouched at every step.
- **`reasoningSupport` tri-state in model registry** — known reasoning models marked `"yes"` (Opus 4.7/4.6, Sonnet 4.6, GPT-5.5/5.4/5.3-codex, gpt-5.4-mini), Haiku 4.5 marked `"no"`, everything else (incl. freeform OpenRouter / Custom model ids) resolves to `"unknown"`. The "yes" gate is authoritative — toggles never send the request param for non-yes models even when the user has them on.
- **Settings > AI Provider > Reasoning** — unified section with two master toggles plus a Custom-only Echo override. (1) **Extended thinking** drives the request enablement; (2) **Show thinking status** controls a temporary "Thinking..." Telegram bubble during extended-thinking turns. UI surfaces a user-facing hint when the active model is unsupported or unknown so users know the toggle is a no-op for that model. Reasoning content itself is never rendered in chat (v4 contract).
- **Settings > AI Provider > Reasoning > Echo reasoning to gateway** (Custom-only block) — per-Custom advanced override `customEchoReasoning` for power users on V4-shaped gateways whose model id doesn't match the known regex. Resets automatically when any signed Custom config field (model | baseUrl | format | header keys) changes — `CustomConfigSignature` mirrors algorithm Kotlin/Node-side with a golden-hash dual-side equivalence test.
- **Telegram `/think` command** — toggle reasoning fields from chat: `/think` shows status, `/think on/off` flips Extended thinking, `/think show/hide` flips the "Thinking..." status indicator, `/think echo on/off` flips the Custom override. Mirrors the Settings UI so power users don't have to leave the conversation. The no-args output uses user-facing language only (no `reasoningSupport=...` raw field, no jargon); the Custom block is hidden unless `provider === 'custom'`.
- **Centralized log-redaction helper** (`reasoning-redact.js`) — every reasoning-related log line goes through `fingerprint()` (sha256[:8]) + length-only summaries. Mobile logs end up in bug-report screenshots; raw thinking text, signatures, and `encrypted_content` MUST never leak there. Buffer / BigInt / circular-ref inputs all handled safely (no throw, no JSON expansion of secrets).
- **Cross-provider reasoning hotfix (BAT-558/559)** — fixes a `/think` echo override bug + provider label cleanup ("OpenAI" vs "OpenAI (Codex OAuth)" vs "ChatGPT" inconsistency in dashboard pills, Settings, and `displayNameForProvider`).
- **Pre-push check script (BAT-502)** — `scripts/pre-push-check.sh` runs Node smoke + Kotlin compile via Android Studio's JBR in ~5–10s before push. Catches missing imports, type errors, and regex/V8 crashes before CI burns 4 minutes. Auto-detects JDK 17+ and Android SDK from `local.properties`.
- **SAB pre-merge checklist in PR template (BAT-503)** — `.github/PULL_REQUEST_TEMPLATE.md` now requires authors to confirm SAB audit ran (or N/A) on PRs touching `buildSystemBlocks()`, `DIAGNOSTICS.md`, new error log sites, or shipping new user-visible AI capability. Honor-system gate; CI-enforcement follow-up tracked in BAT-574.
- **`DIAGNOSTICS.md` Reasoning section** — playbook for the most likely user-visible reasoning issues (toggle no-op surprise, V4 400 loop, R1 400 with echo, "Thinking..." bubble not appearing, "why doesn't this show reasoning text", signature spurious reset, redacted-log confusion).
- **`DIAGNOSTICS.md` Service Lifecycle section (SAB-AUDIT-v24)** — playbooks for shutdown flush failures (BAT-525), `/model` and `/provider` switch failures (BAT-504/513/558/559), and MCP reconcile silent failures (BAT-514 cleartext story).
- **`DIAGNOSTICS.md` Activity Heatmap section (SAB-AUDIT-v23)** — playbooks for blank heatmap and right-column-clipped heatmap.
- **Agent self-knowledge** — `buildSystemBlocks` injects a "Reasoning (Extended Thinking)" block per turn with the live state of all 3 toggles + active model's `reasoningSupport`, so the agent can answer "is reasoning on?" / "does my model support it?" without making things up. Plus new doors for `/model`/`/provider` slash commands and the BAT-525 graceful-shutdown guarantee.
- **Migrate searchProvider + agentName to CrossProcessStore (BAT-515)** — both fields move out of process-local SharedPreferences into a shared `agent_preferences.json` file, mirroring the BAT-513/BAT-514 pattern.
  - Settings UI changes are LIVE across processes — provider switch + agent-name edit take effect on the next AI turn / `web_search` / `/status` without a service restart. The `:node` process reads `agent_preferences.json` per call via the new `getAgentName()` / `getSearchProvider()` getters in `config.js`.
  - `saveConfig` now atomically dual-writes prefs + RuntimeStateStore + AgentPreferencesStore. Pre-validation runs before persistence; if the second cross-process write (AgentPreferencesStore) fails, the rollback path restores prefs (5 keys + `setup_complete`) AND undoes the RuntimeStateStore forward update via a captured pre-forward snapshot — keeps all three stores convergent on FS failure.
  - Migration of an existing over-cap `agentName` is preserved verbatim with a single WARN — the 64-char cap applies only to NEW writes, not migration paths (BAT-515 v3 §1, Codex final guard via context-sensitive `validateForWrite`).
  - `tools/session.js` `webSearchProvider` now reports the live provider — replaces the long-stale `'duckduckgo'` fallback (BAT-481 dropped DDG, the report didn't follow).
  - Settings > Search Provider switch follows the BAT-549 R14/R17/R24 pattern (StateFlow `collectAsState` + optimistic local override + `Dispatchers.IO` + clear-on-failure) so taps feel instant and survive concurrent cross-process writes without lost-update-clobber.

### Fixed
- **DeepSeek V4-via-Custom `/resume` 400 crash** — the headline fix from BAT-549 Commit 1. V4 server requires reasoning_content echoed after tool calls; pre-BAT-549 the Custom adapter stripped it unconditionally and looped on the 400. Now the gating echoes for V4, strips for R1, captures-only for unknown gateways.
- **`NodeControlClient.reconcile()` / `healthz()` silently failing on device** — the cleartext loopback fix (above) repaired this. Pre-fix, every Settings → MCP server toggle was firing `IOException: Cleartext HTTP traffic to 127.0.0.1 not permitted` and falling through to the file-based fallback at next service start. Symptoms were invisible because both paths had quiet best-effort semantics; surfaced when BAT-525's `flushShutdown()` (which lacks a fallback) tripped the same bug.
- **Stale "25 tool calls per turn" prompt value** — system prompt at `ai.js:913` claimed `MAX_TOOL_USES = 25` after the constant was renamed to `MAX_STEPS` and the default raised to 35. SAB-AUDIT-v24 caught the drift; now reads "max 35 tool calls per turn (configurable in Settings → Agent → Max tool uses per turn)".
- **`webSearchProvider` reporting `'duckduckgo'` long after BAT-481 dropped DDG** — `tools/session.js` now reads the live provider via `getSearchProvider()` instead of carrying the stale fallback string.

### Performance
- **Per-chat idle-summary timers replace global 60s sweep (BAT-524)** — per-chat `setTimeout` fired once on idle replaces a 1Hz global scan of all conversations. Cancels cleanly on shutdown via the BAT-524 → BAT-525 handoff.
- **Dirty-flag + debounced DB autosave (BAT-523)** — replaces the 60s `setInterval(saveDatabase)` with mutation-driven dirty flag + 60s coalesce. Idle agent now produces zero database writes. `flushForShutdown` (BAT-525) closes the user-Stop boundary case.
- **Derive uptime locally instead of writing it every second (BAT-522)** — service writes a one-shot start-timestamp; the UI computes `now - serviceStartTimeMs` locally and ticks every second for display only. Eliminates 1 disk write per second 24/7.
- **FileObserver replaces 1s/500ms polling (BAT-518 phase 1)** — Kotlin `agent_health_state` reader and node-debug log tail switched from coroutine-driven polling to `FileObserver`. Single observer per directory dispatches to all consumers. Battery-positive on Solana Seeker.

### Security
- **Loopback cleartext exemption is `127.0.0.1`-only** — explicit `<domain includeSubdomains="false">127.0.0.1</domain>`; not `0.0.0.0`, not LAN ranges, not hostname patterns. Public-network TLS enforcement unchanged for all real remote endpoints.
- **Bridge-token auth on every loopback control call** — `X-Bridge-Token` header, per-boot UUID, validated by `internal-control-server.js`. Tokens cleared on `onDestroy` AFTER the flush call, before `killProcess`.
- **Header-VALUE bytes never hashed in `customConfigSignature`** — only sortedHeaderKeys (lowercase, deduped) participate in the hash, so secret material in `Authorization` / `X-API-Key` header values doesn't persist a leakable digest on disk.
- **API-key rotation invisible to the override-reset trigger** — the user's per-Custom advanced override survives normal key rotation (rotating `apiKey` doesn't change the signature). Only meaningful gateway-shape edits reset.
- **Locale-invariant Kotlin lowercase** — header-key lowercasing uses `Locale.ROOT` so Turkish-locale devices don't produce a different signature than other devices and the Node side (the dotted-I problem).
- **Sanitize-on-merge for corrupt `runtime_state.json`** — if the file got a wrong-type value (manual edit, schema rolled back), legacy 3-field writes fall back to defaults instead of carrying the bad value forward.

### Changed
- **`OpenClawService` → `SeekerClawService` (BAT-509)** — internal rename; foreground service notification + Logcat tags now read "SeekerClaw" consistently. No user-facing change.
- **Adapter `formatRequest` and `toApiMessages` accept an optional `requestOptions` arg** — additive 6th parameter (formatRequest) / 3rd parameter (toApiMessages). Existing call sites that don't pass it get the same pre-BAT-549 behavior. Used to thread `reasoningEnabled` / `reasoningSupport` / `customEchoOverride` through to per-adapter request-side decisions.
- **Anthropic `anthropic-beta` header** — now always includes `interleaved-thinking-2025-05-14` (no-op when reasoning is off; required so the API accepts replayed thinking blocks AFTER tool_use on the next turn — Commit 2a's capture path was inert without this).

## [1.9.0] - 2026-04-13

### Added
- **OpenAI Codex OAuth** — sign in with a ChatGPT Plus/Pro subscription instead of a platform API key. Browser PKCE flow, Keystore-encrypted token storage, automatic token refresh, per-provider auth-type memory across provider switches (BAT-485, #316)
- **Discord channel** — run the agent on Discord as an alternative to Telegram. Gateway v10 WebSocket, full media/reactions/reply threading, channel abstraction layer so future channels plug in cleanly (BAT-483, #310)
- **Custom AI Provider** — connect any OpenAI-compatible gateway (DeepSeek, Ollama, LiteLLM, etc.) via a base URL, API key, custom headers, and a model ID. Supports both Chat Completions and OpenAI Responses formats (BAT-482, #309)

### Fixed
- **OpenAI OAuth callback unreachable on IPv6-first devices** — the NanoHTTPD callback server was bound to literal `"localhost"`, which some Android builds resolve to `::1` only. Chrome's Custom Tab resolves `localhost` to `127.0.0.1`, so the callback hit a socket the server wasn't listening on. Server now binds wildcard and accepts both IPv4 and IPv6 loopback (including IPv4-mapped IPv6 `::ffff:127.0.0.1`), with a remote-IP filter rejecting non-loopback clients (BAT-489, #323)
- **OAuth callback server destroyed during browser authentication** — Android could destroy the stopped Activity while the user authenticated in Chrome Custom Tab, killing the localhost callback server. Moved the server and flow state to companion-object scope (application lifetime) so it survives Activity destruction. Concurrency model uses `synchronized(FLOW_LOCK)` with per-flow isolation via `activeFlowId` (BAT-493, #327)
- **OAuth token exchange failed on background-restricted devices** — when Chrome Custom Tab takes the foreground, Android restricts the background app's internet access on some devices. DNS resolution for `auth.openai.com` would fail with `UnknownHostException`. Added a temporary foreground service (`OAuthKeepAliveService`) that starts before Chrome opens and stops after the OAuth flow completes, giving the process unrestricted network access for the duration of authentication (BAT-494, #328, #329)
- **Fresh-install OAuth deadlock** — the token exchange threw `IllegalStateException("Config not loaded")` because `ConfigManager.loadConfig` returns null until setup is marked complete. New `loadConfigOrBootstrap` + `persistOpenAIOAuthTokens` paths let OAuth persist tokens mid-onboarding without marking setup complete prematurely (BAT-489, #323)
- **Fresh-install default provider** — setup and settings screens now both default to OpenAI + Sign in with ChatGPT on fresh installs, matching the intended onboarding flow (BAT-489, #323; BAT-495, #330)
- **Setup form state wiped by OAuth** — the `configVersion` bump from OAuth token persistence cascaded into `remember(configVersion)` field initializers, blanking out already-typed bot tokens. Form state is now `rememberSaveable`, surviving mid-flow OAuth writes and process death (BAT-489, #323)
- **Cross-provider OAuth token wipe** — saving setup as Claude or OpenRouter used to overwrite existing OpenAI OAuth tokens with empty strings. Preserved-OAuth values are now threaded through every provider branch (BAT-489, #323)
- **Legacy plaintext email pref PII leak** — the plaintext-to-encrypted `openai_oauth_email` migration only cleared the plaintext key on read. Every OAuth write/clear now wipes both forms (BAT-489, #323)
- **Agent runtime crash from regex SyntaxError** — `silent-reply.js` used Unicode property escapes (`\p{L}\p{N}`) that crashed nodejs-mobile's Node 18 V8 at module load. Rewrote boundary regexes to use ASCII `\w` instead (#325)
- **SILENT_REPLY sentinel over-stripped protocol discussion** — renamed the canonical sentinel from `SILENT_REPLY` to `[[SILENT_REPLY]]` so discussion of the protocol in prose passes through untouched, while the bracketed form is reserved for the control signal. Legacy whole-message compatibility path preserved for bare `SILENT_REPLY` and markdown-wrapped variants. 43 unit tests across 6 coverage sections (BAT-491, #324)
- **Silent Replies system prompt over-priming** — removed explicit right/wrong examples containing the literal sentinel string from the system prompt. The literal form now appears exactly once. Cron and heartbeat prompts reference the Silent Replies section by name instead of inlining the token (BAT-492, #326)
- **Google Play SMS hotfix** — `android_sms` on the googlePlay flavor now uses an intent handoff instead of `SEND_SMS` permission (BAT-484, #312) *(also tagged as v1.8.1)*
- **Codex SSE parsing** — handle missing Content-Type header from chatgpt.com
- **Web search provider reporting** — agent now knows which search backend actually ran with `provider: "auto"`
- **Dashboard credential check** — OpenAI OAuth users now see a green pill instead of "Credential missing"
- **Sign Out button color** — uses ActionDanger red for consistency with Reset/Wipe

### Changed
- **OAuth callback page redesigned** — DarkOps-themed card with Material Design checkmark/X icon, status badge, navigation hint, and inline SeekerClaw logo SVG. Matches the app's design system (BAT-495, #330)
- **Settings layout** — Quick Setup moved up, MCP Servers extracted to its own screen (#313)
- **Renamed user-visible "OpenClaw service" → "Claw Engine"** in log messages and Settings/System About rows
- **Provider switching is now atomic** — batched into a single `saveConfig` call instead of 2–3 sequential writes
- **Agent self-knowledge** — added OpenAI OAuth Provider block, OAuth Self-Diagnosis playbook, and OAuth sections in `DIAGNOSTICS.md` (SAB-AUDIT-v19)
- **Node smoke test harness** — `tests/nodejs-project/smoke.js` validates module load on every commit to catch regex/V8 crashes before they reach devices (#325)

### Security
- **OAuth tokens never touch disk in plaintext** — persisted directly via `ConfigManager` (Android Keystore), result files carry only status flags (RFC 6819 §5.1.4, OWASP MASVS-STORAGE-1)
- **`config.js` strict authType validation** — hard-fails on unsupported values for the OpenAI provider, with legacy-alias migration so older installs don't crash
- **OAuth callback listener** accepts only loopback clients (127.0.0.0/8, `::1`, and IPv4-mapped IPv6 forms) via a remote-IP check in `serve()` — wildcard bind is required for cross-platform loopback compatibility, so security is enforced at the request layer, not the socket layer
- **OAuth diagnostic logging sanitized** — token endpoint error responses are logged with only the `error` and `error_description` JSON fields, not the raw response body, to prevent accidental data exposure in production logcat (BAT-494, #328)
- **`requestId` Intent extra** validated against a strict UUID regex (path-traversal defense)

## [1.8.0] - 2026-03-30

### Added
- **Search Provider System** — choose from 5 web search providers: Brave, Perplexity, Exa, Tavily, Firecrawl (BAT-481)
- **Quick Actions** — `/quick` command with inline keyboard buttons (#295)
- **Multi-provider setup wizard** — pick provider first, model second, Telegram last (BAT-478)
- **Multi-provider QR import** — supports OpenAI and OpenRouter credentials (BAT-471)
- **Loop detection** — detects repeated tool call patterns, 3 warnings then breaks at 5 (BAT-474)
- **Context summarization** — summarizes oldest messages at 85% context usage instead of dropping them (BAT-475)
- **Memory scrubbing** — strips tool narration, file uploads, temp paths from memory saves (BAT-474)
- **Dashboard animations** — smooth AnimatedVisibility for status banners (BAT-479)
- **Git SHA in debug builds** — System screen shows commit hash for debugging
- **Shared UI components** — 9 reusable composables: TopAppBar, SectionLabel, CardSurface, InfoRow, ConfigField, InfoDialog, Scaffold, Switch (#306, #307, #308)
- **UI/UX audit polish** — onboarding flow, terminology, settings consolidation (BAT-476)
- **Restart prompt** — app prompts restart when provider, model, or API key changes (BAT-468)

### Fixed
- **Heartbeat status leaks** — port ackMaxChars from OpenClaw, suppress filler text alongside HEARTBEAT_OK (#302)
- **Heartbeat conversation isolation** — probes no longer pollute user conversation history (#298)
- **Repetition detector** — catches degenerate model output before Telegram send (#300)
- **Logs toggle color** — was red, now green matching all other toggles
- **System screen back arrow** — standardized to M3 TopAppBar
- **HorizontalDivider colors** — standardized to CardBorder across all screens
- **Setup credential preservation** — switching providers no longer wipes API keys (BAT-478)
- **Banner spacing** — dashboard cards properly spaced from banners (BAT-479)
- **Step indicator labels** — no longer truncate on narrow screens (BAT-478)
- **Poll timeout logs** — downgraded from ERROR to DEBUG (no longer alarming in logs)
- **Dead ProGuard rule** — removed unused rule, fixed incorrect GitHub URLs

### Security
- **js_eval sandbox** — Function constructor shadows, sensitive path blocking, output redaction (BAT-466)
- **Emulator IP gate** — 10.0.2.2 restricted to DEBUG builds only (BAT-467)

### Changed
- `main.js` split into focused modules — `message-handler.js` extracted (#296, #303)
- `claude.js` renamed to `ai.js` (provider-agnostic naming)
- Tools refactored into 12 modular files under `tools/` (BAT-470)
- RestartDialog extracted as shared component (BAT-469)
- Deferred tool loading disabled — free OpenRouter models leak raw XML (BAT-475)
- UI components consolidated: ~500 lines removed across 10 files

## [1.7.0] - 2026-03-19

### Added
- **OpenRouter provider** — access 100+ models through a single endpoint with prompt caching, model fallbacks, and freeform model input (BAT-447)
- **Cron reliability improvements** — ported from OpenClaw: zombie detection, missed job recovery, atomic file writes (BAT-461)

### Fixed
- Setup token now works with Sonnet 4.6 and Opus 4.6 — billing attribution fix (BAT-460)
- Dashboard metrics relabeled as "Device Memory" / "Device Storage" for honesty (BAT-463)
- Added "Last message: Xm ago" to Telegram connection status (BAT-463)
- Added App Storage breakdown: Workspace, Database, Logs, Runtime (BAT-463)
- API Limits no longer shows bogus "100% left" when usage data is unavailable (BAT-464)
- System screen Material Design polish: M3 spacing tokens, removed decorative accent bars (BAT-464)
- Settings screen: merged Preferences + Permissions sections, renamed to "AI Configuration", collapsible state preserved across tabs (BAT-459)
- Removed dead OAuth usage polling that caused repeated 429 errors in logs and confused agent into reporting phantom issues (BAT-465)

## [1.6.1] - 2026-03-14

### Added
- **Button styling** — telegram_send buttons support "destructive" (red) and "primary" (blue) colors via Telegram Bot API 9.4 (BAT-439)
- **Analytics opt-out** — toggle in Settings to disable usage analytics

### Fixed
- **Session auto-save** — never worked since provider system shipped; empty system prompt block caused Claude API 400 on every attempt (BAT-448)
- **Vision analysis** — same empty prompt block bug broke image analysis
- Bridge rate limiting for /contacts/add endpoint

### Security
- JSON injection fix + bridge rate limiting

## [1.6.0] - 2026-03-10

### Added
- **NFT Holdings** — view NFTs (including compressed/cNFTs) in any Solana wallet via Helius DAS API (BAT-319)
- **Cron agent turns** — scheduled jobs can now run full AI turns, not just reminders (BAT-326)
- **Temporal context** — agent session awareness with conversation summaries for continuity (BAT-322)
- **OpenClaw 2026.3.8 parity** — 4 upstream features ported (BAT-359)

### Fixed
- Heartbeat chat pollution suppressed when nothing needs attention
- Background API calls no longer pollute health status display
- Tool confirmation gates enforce proper YES/NO flow for dangerous actions
- Solana address validation strengthened across all wallet tools
- SHA-256 verification + Zip Slip guard for nodejs-mobile asset extraction
- SILENT_REPLY now properly logged in audit trail

### Security
- Gitignore patterns updated to prevent accidental key commits
- R8/ProGuard hardened for release builds

## [1.4.1] - 2026-02-25

**First public release.** Everything below shipped across v1.0.0–v1.4.1 (293 commits, 185 PRs).

### Core
- **On-device AI agent** — Claude (Opus / Sonnet / Haiku) running 24/7 as an Android foreground service via embedded Node.js (nodejs-mobile, Node 18 LTS ARM64)
- **56 tools** — file I/O, shell exec, web search/fetch, device sensors, Solana transactions, MCP remote tools, and more
- **35 skills** — bundled YAML-frontmatter skills with semantic trigger routing, plus install-from-URL and Telegram file attachment
- **Multi-turn tool use** — up to 25 tool-call rounds per conversation turn with per-round checkpoints and crash-safe resume
- **Prompt caching** — reduces cost and latency on repeated context across Claude API calls

### Telegram
- Full bot integration — reactions, inline keyboards, file send/download, blockquote rendering, typing indicators
- 12 slash commands — /help, /version, /logs, /approve, /deny, and more
- File sharing with Claude vision (send an image, agent sees it)
- Owner-gate hardening — blocks service start without valid Telegram owner ID

### Solana
- **Jupiter DEX** — swaps, quotes, limit orders, DCA via Jupiter Ultra API with sign-only MWA flow
- **Mobile Wallet Adapter** (MWA) integration for on-device transaction signing
- Wallet & secrets protection with encrypted credentials store (Android Keystore, AES-256-GCM)

### Device Control
- **Android Bridge** — local HTTP bridge exposing battery, storage, network, GPS, camera, SMS, calls, clipboard, TTS, contacts, app launch/listing
- **Screenshots** — agent captures screen via `screencap -p`
- **34 shell commands** in sandboxed allowlist (ls, cat, grep, find, curl, wget, sed, diff, base64, screencap, and more)
- **Boot receiver** — auto-start agent after device reboot
- **Watchdog** — 30s health checks with auto-restart on unresponsive Node.js

### Intelligence
- **Persistent memory** — daily notes, personality, ranked keyword search across memory files (SQL.js backed)
- **Web search** — Brave, DuckDuckGo, Perplexity with zero-config DDG fallback
- **Web fetch** — markdown conversion, caching, redirect handling
- **Cron/scheduling** — one-shot or recurring jobs with natural language time parsing ("remind me in 30 min")
- **Remote MCP servers** — add external tool providers via Streamable HTTP (JSON-RPC 2.0)
- **Auto session summary** — agent saves memory before session dies
- **Ephemeral session awareness** — agent knows when Node.js restarted mid-conversation

### Security
- Prompt injection defense with content trust scoring
- Tool confirmation gates (YES/NO for dangerous actions)
- Secrets blocked from agent access (config files, database)
- js_eval sandbox for in-process code execution
- Setup-token authentication for initial configuration

### Android App
- **Jetpack Compose + Material 3** — DarkOps theme (dark navy + crimson + green)
- **6 screens** — Setup (QR scan + manual entry), Dashboard (status/uptime/stats), Logs (searchable monospace viewer), Settings (config editor), Skills (browse + diagnostics), System
- **Redesigned onboarding** — branded cards, step indicator, themed QR scanner, success screen
- Haptic feedback, network offline banner, loading states, navigation transitions
- Log viewer with text search/filter, export/share, structured log levels (DEBUG/INFO/WARN/ERROR)
- Agent health dashboard with real heartbeat probes
- WCAG AA text contrast, 48dp touch targets

### Architecture
- **14 focused Node.js modules** — main, claude, tools, solana, telegram, memory, skills, cron, web, database, security, bridge, config, mcp-client (refactored from 6,924-line monolith)
- **API resilience** — retry with exponential backoff on 429/529, rate-limit-aware throttling, centralized API wrapper with mutex
- **Firebase Analytics** build-optional — build succeeds without google-services.json
- **OpenClaw parity** synced to v2026.2.25 (reviewed 936+ upstream commits)

### Open Source
- MIT license
- README with screenshots and architecture diagram
- CONTRIBUTING.md, SECURITY.md, issue/PR templates
- GitHub Actions CI (build on push) + release workflow (tag → signed APK → GitHub Release)
- CHANGELOG, DIAGNOSTICS.md, SAB self-awareness audit (111/111, 100%)

## [1.3.0] - 2026-02-20

### Added
- **Telegram slash commands** — /help, /version, /logs, /approve, /deny for in-chat control
- **Netwatch** bundled skill — network monitoring and security audit
- **Skill requirements gating** — skills with `requires.bins`/`requires.env` checked at runtime, unmet deps reported
- **Permission revoke dialog** — tapping granted permission toggles in Settings shows system revoke dialog
- **Skills tab** — browse installed skills with search and marketplace teaser
- **Skill install tool** — install skills from URL or Telegram file attachment
- **Skills diagnostics** panel for debugging skill loading issues
- **Structured log levels** — DEBUG/INFO/WARN/ERROR pipeline with console filter button
- **Real heartbeat probes** — end-to-end agent health check with configurable interval
- **Owner gate hardening** — block service start without valid Telegram owner ID, reaction-based auth feedback
- **OpenClaw parity** sync to v2026.2.20

### Fixed
- Agent health file now written immediately on startup (was delayed)
- False trigger warning for YAML frontmatter skills suppressed
- Misleading "Heartbeat" debug log label renamed to [Runtime]
- Duplicate [Health] logs from multi-process polling eliminated
- Agent HEARTBEAT.md no longer overwritten every 5 minutes by the app
- Duplicate health transition logs at startup eliminated
- Prompt cache hit rate now uses total tokens as denominator (was under-reporting)
- Skill install race condition where early return skipped YAML trigger parsing
- Setup token session expiry and rate-limit tracking
- Critical P0: conversation corruption + usage poll spam
- Wallet cold-start rejection on first launch
- OOM crash in LogCollector when reading large log files
- Material 3 compatibility (replaced PullToRefreshBox with plain Box)
- Duplicate `version` field in bundled skill frontmatter

### Changed
- **Major architecture refactor** — split monolithic `main.js` into 11 focused modules: config, security, bridge, web, telegram, memory, skills, cron, database, solana, claude, tools
- Pruned 36 dead exports and fixed silent error catches
- Removed cost metrics from all UI surfaces
- Reordered Settings sections, improved Brave search hint text, refined onboarding colors

## [1.2.0] - 2026-02-10

### Added
- **Remote MCP servers** — add external tool providers via Streamable HTTP (JSON-RPC 2.0) with rate limiting and rug-pull detection
- **DuckDuckGo search** — zero-config default web search with DDG Lite fallback (no API key needed)
- **Jupiter DEX integration** — 9 swap/quote/limit-order tools, API key management, Ultra API with sign-only MWA flow
- **Telegram enhancements** — inline keyboard buttons, file send/delete, bidirectional reactions, file download with Claude vision, blockquote rendering
- **New agent tools** — sandboxed shell exec, in-process js_eval, file delete, web fetch with markdown/caching/redirects, multi-provider web search
- **SQL.js database** — request logging, memory file indexing, ranked keyword search across memory
- **Prompt caching** for Claude API calls (reduces cost and latency on repeated context)
- **API resilience** — retry with exponential backoff on 429/529, rate-limit-aware throttling, centralized API call wrapper with mutex
- **Auto session summary** — agent saves memory before session dies
- **Ephemeral session awareness** — agent knows when Node.js restarted mid-conversation
- **User-friendly API errors** — classified error messages instead of raw status codes
- **Cron/scheduling system** — create one-shot or recurring jobs with natural language time parsing
- **Security hardening** — prompt injection defense, tool confirmation gates (YES/NO for dangerous actions), wallet & secrets protection, js_eval sandbox
- **Agent health dashboard** — detects API error states and shows health indicators
- **Contextual status messages** for long-running tool calls
- **CalClaw** bundled skill — AI calorie tracking via Telegram
- **13 bundled agent skills** (git-tracked) with YAML frontmatter, version-aware seeding
- **Sonnet 4.6** model added to model picker
- **Redesigned onboarding** — branded cards, step indicator, themed QR scanner, pre-permission notification explanation, success screen
- **Log viewer improvements** — text search/filter, export/share via system share sheet, increased font size
- **UI polish** — haptic feedback, network offline banner, loading states, navigation fade transitions, semantic color roles, animations, collapsible settings sections
- **Smart /start message** — context-aware welcome with centralized message templates
- **Run Setup Again** option in Settings
- **PLATFORM.md** auto-generated on startup with device info
- **OpenClaw parity** updates v2026.2.12–2026.2.14, full YAML frontmatter parser, skill routing blocks

### Fixed
- Jupiter API endpoints corrected across multiple iterations
- Shell exec PATH resolution on Android (3 rounds of fixes)
- File download race condition on mobile networks
- Silent response handling (SILENT_REPLY protocol)
- Cron job re-fire and duplicate execution prevention
- Timestamps now use local timezone with UTC offset
- Typing indicator stays alive during long Claude API calls
- Removed AD_ID permission leaked from dependencies
- LazyColumn key duplication crash in Logs screen
- Emoji rendering in Telegram (UTF-8 encoding fix)
- Setup token authentication (Bearer auth)
- Config recomposition thrashing (cached reads)
- Touch targets expanded to 48dp minimum (accessibility)
- Text contrast improved to WCAG AA compliance
- Memory WIPE now requires typing confirmation
- Navigation after config reset correctly returns to Setup
- Skill trigger matching uses word boundaries (no partial matches)

### Changed
- **DarkOps is now the only theme** — removed Terminal, Pixel, and Clean themes
- Replaced hardcoded colors with theme tokens throughout
- Upgraded Gradle 8.10.2 → 8.13 and AGP 8.7.3 → 8.13.2
- Model picker uses aliases (`claude-sonnet-4-6`) instead of snapshot IDs
- Settings info texts extracted to centralized constants
- Replaced broken Canvas logo with proper SVG vector drawable
- Solana swap migrated from v6 to Jupiter Ultra API

### Removed
- Firebase Analytics (all metrics are now local-only)
- Dead theme code (Terminal, Pixel, Clean)
- Duplicate tool descriptions from system prompt

## [1.1.0] - 2026-02-08

### Added
- **Jupiter DEX** initial integration with SOUL.md personality template
- **Cron job delivery** system ported from OpenClaw
- **Brave Search** API key support for web search
- **App versioning** centralized in `build.gradle.kts` (BuildConfig fields)
- Claude account rate-limit handling and reply context tracking
- Wallet connection timeout handling
- Separate encrypted credentials store

### Changed
- Ported OpenClaw 2026.2.9 stability fixes

## [1.0.0] - 2026-02-03

### Added
- **Android app shell** — Jetpack Compose with Material 3, dark-only theme
- **4 screens** — Setup (QR scan + manual entry), Dashboard (status/uptime/stats), Logs (monospace viewer), Settings (config editor)
- **Node.js runtime** via nodejs-mobile community fork (Node 18 LTS, ARM64)
- **OpenClaw gateway** running as Android foreground service
- **DarkOps theme** — dark navy + crimson red + green status indicators
- **Solana wallet** MWA (Mobile Wallet Adapter) integration
- **Setup-token authentication** for initial configuration
- **Cron system** ported from OpenClaw with timer-based delivery
- **Editable settings** with encrypted storage (Android Keystore, AES-256-GCM)
- **Owner auto-detect** from Telegram bot token
- **Boot receiver** — auto-start agent after device reboot
- **Watchdog** — 30s health checks with auto-restart on unresponsive Node.js
- **Bottom navigation** — Dashboard, Logs, Settings tabs
- **Android Bridge** — local HTTP bridge exposing device APIs (battery, storage, network, clipboard, SMS, calls, location, TTS, apps) to the Node.js agent
