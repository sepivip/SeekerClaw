# Pitfalls: Full Write-ups

> Moved out of `CLAUDE.md` on 2026-10-28. `CLAUDE.md` › *Coding Patterns & Pitfalls* keeps a short rule for each one; this file keeps the full story — the misleading error text, the probe evidence and why each fix is shaped the way it is.

## Provider Wire Contracts (BAT-1033)

### SSE Streaming — Handle EVERY Delta Type (thinking signatures)

**When assembling a streamed API response, handle every `*_delta` type used by the content blocks we enable — a dropped delta silently corrupts the block.** The Claude SSE reducer in `http.js` (`applyClaudeStreamEvent`) currently accumulates `text_delta`, `input_json_delta`, `thinking_delta`, and `signature_delta`. That is today's coverage, not the whole wire contract: enabling another block type (for example citations, which stream `citations_delta`) means adding its delta here. Anthropic streams a thinking block as an empty shell followed by deltas:

```text
content_block_start  { type:'thinking', thinking:'', signature:'' }
content_block_delta  { thinking_delta:  <reasoning text> }
content_block_delta  { signature_delta: <the signature> }   ← easy to forget
```

**The v2.1.0 bug (BAT-1033):** the reducer handled only `text_delta` + `input_json_delta`, so it dropped `signature_delta`. The assembled thinking block kept the empty signature from `content_block_start`. On the next tool-loop round the block was echoed back (Anthropic requires thinking blocks to be replayed **unchanged** on tool-use turns) and the API rejected the whole request:

```text
API error (400): messages.N.content.0.thinking: each thinking block must contain thinking
```

**The message is misleading — the trigger is the empty SIGNATURE, not empty text.** Proven with a live probe (`tests/live/anthropic/test-thinking-poison.js`): a signed *empty-text* thinking block replays 200; the *same* block with `signature:''` replays 400. So:

- **Capture side:** never lose the signature. `signature_delta` MUST be accumulated.
- **Capture guard (`claude.js:_isValidWireBlock`, applied in `fromApiResponse` to `reasoningBlocks` and the verbatim `wireContent` snapshot):** drop a thinking block whose `signature` is empty/whitespace — **key on the signature, not the text** (an empty-text signed block is valid and must still replay). Since BAT-1664 only the in-memory snapshot of the CURRENT turn is ever replayed, so a poisoned block from an older build's checkpoint can no longer reach the wire.
- **Why only Sonnet 5 surfaced it:** with `/think` off, Sonnet 5 emits a thinking block by default while Opus 4.8 doesn't — and emission is stochastic, which is why it flapped ("works now" → "broke again"). Any model that emits a thinking block hits it on the first tool-using turn.

### Adaptive Thinking — `budget_tokens` was removed (verify per auth path)

**A second, distinct BAT-1033 bug:** with `/think` **ON**, `formatRequest` used to send `thinking:{type:'enabled', budget_tokens}` (extended thinking). Anthropic **removed** extended thinking from the current models — fable-5/opus-4-8/opus-4-7/sonnet-5 reject it with `400 "thinking.type.enabled is not supported for this model. Use thinking.type.adaptive"`. Fix: send `thinking:{type:'adaptive'}` uniformly (the model auto-sizes its budget; accepted by every reasoning model). This retired the BAT-558 budget clamp (no `budget_tokens` → no `budget_tokens < max_tokens` constraint).

**The trap that nearly made us defer it — auth path matters.** The `cc_version` billing masquerade on the **setup_token** path still *tolerated* the deprecated `budget_tokens` (returned 200), so probing only that path made it look "latent." On the **raw API-key** path (the common dApp-Store user, QR `anthropic_api_key`), the same request **400s**. **Always verify a provider-shape claim on BOTH auth paths** — `tests/live/anthropic/test-thinking-matrix.js` runs the per-model × extended/adaptive grid on the api-key path; `test-thinking-repro.js` covers setup_token.

### Thinking Signatures Are Bound to the Prefix (BAT-1664)

**A thinking block's signature is valid only for the exact request prefix that produced it** — the top-level `system`, the `tools` array, every earlier message byte-for-byte — and for the model that wrote it. Enforcing models (`claude-fable-5-1` for accounts created on/after 2026-08-31, the 5.5 family, Fable 5.2 for everyone) reject a replayed block whose prefix changed: `400 messages.N.content.M: Invalid \`signature\` in \`thinking\` block. The block is bound to a different conversation.` Older accounts never saw it, which is why a single-turn probe passed and production broke on the turn after a tool turn.

**Why our edits invalidate replay:** anything that changes bytes before a block breaks every block after the edit — a rebuilt system prompt (time/uptime), aged or trimmed tool results, a sanitizer that filters an orphan `tool_use`, a summary splice, a tool-name `trim()`, and even our own neutral rebuild (it joined multiple `text` blocks and moved thinking to the front of the content array).

**The rules (slice A):**
- **Replay only the current turn.** `toApiMessages` takes the turn anchor (THIS turn's user message) by identity in `requestOptions.turnAnchor`. Nothing before it carries thinking; no anchor / no `requestOptions` → no thinking at all. Never find the boundary by scanning roles — the loop-warn `[System]` messages are role `user`.
- **Replay verbatim.** `fromApiResponse` returns `wireContent` (the content array as received, through the same signature-validity check). ai.js stores a deep copy as `claudeWireContent` — **non-enumerable**, so `JSON.stringify` and `{...msg}` never carry it and it can never reach a checkpoint (task-store also deletes it defensively). In-turn replay emits that array unchanged; `reasoningBlocks` is never replayed by the Claude adapter.
- **Every edit goes through `invalidateWireSnapshot(msg, messages, toolCalls?)`** (providers/claude.js). It deletes the snapshot and bumps the conversation's edit epoch; chat() sees the epoch move and sets the turn-sticky `stripAllThinking`, so the rest of the turn replays no thinking — including messages that still hold a valid snapshot (an edit before them broke their prefix). A source-guard test fails on any direct `.toolCalls =` outside the helper. If you add a new place that edits an assistant message's `content` or `toolCalls`, call the helper first.
- **Missing snapshot = strip from here on.** A message after the anchor with no snapshot (invalidated, legacy array, restored) strips thinking on itself and every later message.
- **Keep the history stable within a turn (C0, flagged models — `thinkingBinding: true`).** Tool-result aging runs once, before the turn's first request, on messages before the anchor only; there is no per-round `MAX_HISTORY` trim (a `'turnEnd'` trim and the `addToConversation` trim instead); the wire `tools` array is frozen at turn start, and the loop-final round keeps it with `tool_choice: {type:'none'}` rather than dropping it. Do not add a new per-round edit of earlier messages, the system prompt or the tools array on these models — the stable-history test compares every request's prefix byte-for-byte. Emergency edits (sanitize repair, quarantine, lean self-heal, anchor-guard repair, budget reduction, summary/pressure trim) are allowed but must set `stripAllThinking` (most do it via `noteHistoryEdit` / the edit epoch).
- **Budget gate (all first-party Claude).** The running estimate does not see replayed thinking or JSON escaping, so the formatted body is measured before every send (the C3 / C2 retries included — they loop back through the same emission path). Over 90% of the limit → one reduction (strip thinking, age, adaptiveTrim) → still over → the request is not sent and the turn ends with `context_budget_exceeded`.
- **Defense in depth:** registry-flagged models send `thinking.block_binding.prefix_mismatch_behavior: "drop_block"` + the `thinking-binding-controls-2026-08-01` beta (header and field from ONE decision — the field alone is a 400); a signature 400 is healed once per turn by stripping; a rejected binding control is remembered per credential (in memory only) and retried without it.

### Wire-Contract Bugs Need Live Probes, Not Just Mocks

**A fully-mocked test cannot catch a bug in what the *live API* actually accepts.** BAT-1033 shipped even though `claude-reasoning-roundtrip.test.js` existed — its mocks only covered *missing*-signature/wrong-type blocks, never the *empty-string* signature the real stream produces. Two-layer defense:

1. **Offline (CI/smoke):** extract wire-assembly into a pure exported reducer and feed it the EXACT bytes the API streams (`tests/nodejs-project/claude-thinking-signature.test.js` drives `http.js`'s real `assembleClaudeStreamMessage`). The test must fail if the fix is reverted — verify that.
2. **Live (opt-in, `tests/live/anthropic/`):** `test-thinking-repro.js` (per-model × reasoning on/off/extended/adaptive matrix) and `test-thinking-poison.js` (verbatim vs signature-stripped replay) hit the real endpoint with a setup_token. Run before any release that touches provider request/response shaping.

### Verify External API Contracts via context7 (not training memory)

**Before writing or changing any provider request/response shaping — Anthropic, OpenAI, OpenRouter — pull the CURRENT API contract via the context7 MCP first; do not rely on training memory.** Model APIs change faster than the training cutoff. In BAT-1033, context7 (`platform.claude.com`) is what surfaced that Anthropic **removed** `thinking:{type:'enabled', budget_tokens}` from the current models and requires `type:'adaptive'` — a fact no amount of code-reading or memory would have revealed, and which the fix hinged on. Pair it with a live probe (above): context7 tells you the documented contract, the probe tells you what the endpoint (and our specific auth path) actually enforces. Applies to any hardcoded external identifier — API params, model ids, header/beta tags, endpoint paths.
