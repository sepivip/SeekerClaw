# Pitfalls: Full Write-ups

> Moved out of `CLAUDE.md` on 2026-10-28. `CLAUDE.md` › *Coding Patterns & Pitfalls* keeps a short rule for each one; this file keeps the full story — the misleading error text, the probe evidence and why each fix is shaped the way it is.

## Provider Wire Contracts (BAT-1033)

### SSE Streaming — Handle EVERY Delta Type (thinking signatures)

**When assembling a streamed API response, handle every `*_delta` type the wire can send — a dropped delta silently corrupts the block.** The Claude SSE reducer in `http.js` (`applyClaudeStreamEvent`) accumulates `text_delta`, `input_json_delta`, `thinking_delta`, and `signature_delta`. Anthropic streams a thinking block as an empty shell followed by deltas:

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
- **Replay guard (`claude.js:_collectClaudeWireBlocks`):** skip a thinking block whose `signature` is empty/whitespace — **key on the signature, not the text** (an empty-text signed block is valid and must still replay). This also recovers checkpoints poisoned by an older build after upgrade.
- **Why only Sonnet 5 surfaced it:** with `/think` off, Sonnet 5 emits a thinking block by default while Opus 4.8 doesn't — and emission is stochastic, which is why it flapped ("works now" → "broke again"). Any model that emits a thinking block hits it on the first tool-using turn.

### Adaptive Thinking — `budget_tokens` was removed (verify per auth path)

**A second, distinct BAT-1033 bug:** with `/think` **ON**, `formatRequest` used to send `thinking:{type:'enabled', budget_tokens}` (extended thinking). Anthropic **removed** extended thinking from the current models — fable-5/opus-4-8/opus-4-7/sonnet-5 reject it with `400 "thinking.type.enabled is not supported for this model. Use thinking.type.adaptive"`. Fix: send `thinking:{type:'adaptive'}` uniformly (the model auto-sizes its budget; accepted by every reasoning model). This retired the BAT-558 budget clamp (no `budget_tokens` → no `budget_tokens < max_tokens` constraint).

**The trap that nearly made us defer it — auth path matters.** The `cc_version` billing masquerade on the **setup_token** path still *tolerated* the deprecated `budget_tokens` (returned 200), so probing only that path made it look "latent." On the **raw API-key** path (the common dApp-Store user, QR `anthropic_api_key`), the same request **400s**. **Always verify a provider-shape claim on BOTH auth paths** — `tests/live/anthropic/test-thinking-matrix.js` runs the per-model × extended/adaptive grid on the api-key path; `test-thinking-repro.js` covers setup_token.

### Wire-Contract Bugs Need Live Probes, Not Just Mocks

**A fully-mocked test cannot catch a bug in what the *live API* actually accepts.** BAT-1033 shipped even though `claude-reasoning-roundtrip.test.js` existed — its mocks only covered *missing*-signature/wrong-type blocks, never the *empty-string* signature the real stream produces. Two-layer defense:

1. **Offline (CI/smoke):** extract wire-assembly into a pure exported reducer and feed it the EXACT bytes the API streams (`tests/nodejs-project/claude-thinking-signature.test.js` drives `http.js`'s real `assembleClaudeStreamMessage`). The test must fail if the fix is reverted — verify that.
2. **Live (opt-in, `tests/live/anthropic/`):** `test-thinking-repro.js` (per-model × reasoning on/off/extended/adaptive matrix) and `test-thinking-poison.js` (verbatim vs signature-stripped replay) hit the real endpoint with a setup_token. Run before any release that touches provider request/response shaping.

### Verify External API Contracts via context7 (not training memory)

**Before writing or changing any provider request/response shaping — Anthropic, OpenAI, OpenRouter — pull the CURRENT API contract via the context7 MCP first; do not rely on training memory.** Model APIs change faster than the training cutoff. In BAT-1033, context7 (`platform.claude.com`) is what surfaced that Anthropic **removed** `thinking:{type:'enabled', budget_tokens}` from the current models and requires `type:'adaptive'` — a fact no amount of code-reading or memory would have revealed, and which the fix hinged on. Pair it with a live probe (above): context7 tells you the documented contract, the probe tells you what the endpoint (and our specific auth path) actually enforces. Applies to any hardcoded external identifier — API params, model ids, header/beta tags, endpoint paths.
