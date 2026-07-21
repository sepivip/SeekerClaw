# Device-Test Record

> **Why this file exists.** Device tests are run on real hardware (Solana Seeker) but the
> result often lives only in a chat session or a PR thread. Release-readiness audits read
> the *repo*, so an untracked pass looks identical to "never tested" — and gets re-flagged
> every release. This file is the durable record. **If you device-test something, add a row.**
>
> Scope: on-device verification only. CI results live in GitHub Actions; unit/integration
> results live in the PR body.

| Date | Change | Build / commit | What was exercised | Result |
|------|--------|----------------|--------------------|--------|
| 2026-07-21 | **v2.2.0 RC acceptance** | `v2.2.0-rc1` (release artifact) | RC device test on the signed release build — maintainer-reported PASS. Covers the pre-tag gate for the 2.2.0 release. | PASS |
| 2026-07-20 | **BAT-1151** GPT-5.6 family (#442) | `f5b30c58` | Model picker propagation UI → agent (prefs / `agent_settings.json` / `runtime_state.json` all agreed); end-to-end on `gpt-5.6-sol` incl. multi-iteration turns, skills, `agent_pay` x402 (full 64-tool stack) | PASS |
| 2026-07-17 → 07-20 | **Soak: whole v2.2.0 tree** | `f5b30c58` (tree `418f5dbe`, identical to release tip `1d124574`) | ~2.5–3 days continuous real use: 1 boot, 0 crashes, 0 uncaught/FATAL, model held on `gpt-5.6-sol`, 0 logging faults (no redaction-error / drain error / rotation gap / forward error). Transient OpenAI 401/500/503 all self-healed via refresh/retry. | PASS |
| 2026-07-17 | **BAT-1161 P1A** logging substrate (#445) | `ff7a166f` | SESSION banner + `LEVEL\|epochMs\|message` wire format; event-time forwarding (node↔mirror lag 0); 37,101 retained legacy no-epoch lines coexisting (upgrade path); no secret leakage in mirror or Share; rotation state correct. Forced deep Doze (`deviceidle force-idle`) held 12.2 min: forward lag 1–2 coarse-clock ticks. | PASS |
| 2026-07-16 | **BAT-1172** xAI error-shape | (pre-merge branch) | Induced a real xAI 404 on device; log recorded `code=not-found msgLen=222` and the user-visible copy showed the provider's real reason — no fabricated "subscription tier / add an xAI API key" text | PASS |
| 2026-07-16 | **BAT-1155** xAI OAuth durability | (pre-merge branch) | Sign-in, Stop/Start, hard reboot, sign-out/in, live token rotation, rotation-adjacent restart; 4 restart cycles + 24h soak, 3 clean rotations | PASS — 0 bricks |
| 2026-07-06 | **BAT-1086 / 1087 / 1088** security hardening (#433) | `955991f8` | Tool-level negative-path verification on Seeker: `web_fetch` cross-origin header/body stripping, `agent_settings.json` model-facing key masking, SSRF guard across IPv4/IPv6 encodings | PASS |
| (various) | **BAT-1124** xAI Grok OAuth provider (#434) | pre-merge | Sign-in flow on device incl. a device-test-driven UX fix (foreground-on-sign-in) and `grok-4.5` default selection | PASS (dappStore flavor) |

## Known gaps at v2.2.0

- **googlePlay flavor** — BAT-1124's contract (D5) called for checking the OAuth tab on *both*
  flavors; recorded evidence is dappStore only. Covered by the RC device test.
- **Fresh install / first-run** — all rows above are in-place upgrades over an existing install.
  First-run setup from zero is exercised on the **RC artifact**, not pre-tag, by design.
