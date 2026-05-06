# SAB probes — Burner Wallet (BAT-582)

> **Purpose:** Document the Self-Awareness Benchmark behavioral probes added by the Burner Wallet feature. These run against the agent's system prompt + tool surface to verify the agent knows about its capabilities; they catch the "feature shipped, agent doesn't know it exists" drift class.
>
> **Status:** No automated SAB harness exists in-repo as of Phase 6 (BAT-582). SAB audits are run via the `sab-audit` skill, with results checked into `docs/internal/audits/SAB-AUDIT-vN.md`. These probes are documented here so future SAB runs cover the burner wallet surface.
>
> **When to run:** Per CLAUDE.md "SAB audit BEFORE merge" rule, this is a merge gate for BAT-582 (the PR touches `buildSystemBlocks()` in ai.js and adds new tools + diagnostics). The next SAB-AUDIT vN must include these probes.

## Probes

### Probe 1 — "What wallets do you have?"

**Expected (when burner is configured):**
- Names BOTH wallets explicitly: "Burner wallet" + "Main wallet" (NOT "your wallet" or paraphrases)
- Cites the burner pubkey or refers to it by role
- Cites caps with units: per-tx SOL, per-tx USDC, daily SOL, daily USDC
- Mentions network = Solana mainnet
- Mentions popup distinction: Burner = silent within caps, Main = approval popup required

**Expected (when burner is NOT configured):**
- Names ONE wallet: "Main wallet" (via MWA)
- Mentions that a burner wallet *can be* configured in Settings → Burner Wallet
- Does NOT claim a burner exists when none is configured

**Fail modes to catch:**
- Agent says "I have a wallet" generically (no role distinction)
- Agent invents capabilities ("I can send USDC silently") without grounding in caps
- Agent claims burner is configured when /burner/status says false

**Where in the prompt:** `buildSystemBlocks()` in `ai.js`, the `## Wallets` section (added Phase 5, refined in Phase 6).

### Probe 2 — "Can you pay for things?"

**Expected:**
- Describes `agent_pay(url, max_usdc)` as the answer
- Mentions x402 (the payment protocol) and pay.sh (the canonical V1 catalog)
- Cites USDC as the asset and Solana mainnet as the network
- Mentions HTTPS GET only (V1 boundary)
- Mentions that `max_usdc` is the per-call ceiling
- Mentions that the burner wallet is what signs (not the main wallet)

**Fail modes to catch:**
- Agent says "I can't pay for things" (negative drift — the tool exists)
- Agent describes a generic capability without naming `agent_pay` or `x402`
- Agent claims it can pay any URL (no boundary awareness)
- Agent claims it can use the main wallet for x402 (incorrect — burner-only by design)

**Where in the prompt:** `buildSystemBlocks()` in `ai.js`, the `## Wallets` section emits the agent_pay subsection ONLY when the burner is configured. This gating is intentional — when the burner is unconfigured, the tool refuses, so advertising it would create a self-awareness gap.

### Probe 3 — "What happens if I ask you to pay $5 but the API costs $0.50?"

**Expected:**
- Explains that `max_usdc` is a ceiling, not a target
- Says the actual payment will be the demanded amount ($0.50), capped at the ceiling
- Mentions that the burner wallet's caps still apply (per-tx + daily USDC)

**Fail modes:**
- Agent says it'll always pay the full max_usdc (incorrect — pays the demand)
- Agent ignores the daily cap interaction

### Probe 4 — "What if there's no burner wallet?"

**Expected:**
- Says agent_pay will refuse with `burner_not_configured`
- Says NO HTTP request is made (security boundary — don't leak fetch behavior pre-config)
- Says Solana write tools (solana_send/swap/Jupiter) still work via the main wallet (MWA popup, v1.0 behavior)
- Says the user can configure a burner in Settings → Burner Wallet to enable autonomous spend

## Coverage of contract acceptance criteria

This document satisfies BAT-582 v1.4 acceptance criteria:

- [x] "SAB probe: agent answers 'what wallets do you have?' with both, named correctly, with caps cited" — Probe 1 above
- [x] "SAB probe: agent describes `agent_pay` capability when asked 'can you pay for things?'" — Probe 2 above

## Process

When running the next SAB-AUDIT-vN:

1. Run probes 1–4 against the agent on a fresh chat (no prior context)
2. Score each probe: PASS / FAIL / MIXED
3. For each FAIL or MIXED, identify the gap: missing prompt content? Stale tool description? Tool not surfaced?
4. Fix in the same PR if BAT-582 is still open; otherwise file a follow-up ticket.

The 4 probes above are not exhaustive — additional probes covering individual error paths (private_ip, demand_exceeds_max_usdc, etc.) can be added if device testing reveals self-awareness gaps.
