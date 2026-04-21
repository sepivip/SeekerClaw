# SeekerClaw API Testing

Standalone scripts to test Anthropic API calls without building the app.

## Setup

```bash
cd testing
cp .env.example .env
# Edit .env with your credentials
```

## Scripts

| Script | Purpose |
|--------|---------|
| `test-auth.js` | Test both auth types (API key + setup token) against /v1/models |
| `test-messages.js` | Send PING to each model — verifies end-to-end message flow |
| `test-headers.js` | Test different header combos per model — diagnostic for 400/429 errors |
| `test-production-shape.js` | Reproduce `ai.js`'s exact wire shape (streaming + tools with `cache_control` + cached system prompt + billing block). Complements `test-headers.js` by testing the real production payload instead of minimal probes. |
| `lib.js` | Shared helpers (env loader, model list, billing constant) |

## Usage

```bash
node test-auth.js              # Quick auth check
node test-messages.js          # Test all models with proper billing attribution
node test-headers.js           # Diagnose which header combos work per model (minimal payload)
node test-production-shape.js  # Diagnose which production payloads work per model
```

## .env Config

```env
ANTHROPIC_API_KEY=          # Standard API key (sk-ant-api03-...)
SETUP_TOKEN=                # Max Pro setup token (sk-ant-oat01-...)
TEST_MODELS=all             # "all" or comma-separated: claude-opus-4-7,claude-haiku-4-5
```

## Test Results (2026-04-21, `cc_version=2.1.116`)

Re-run against the current model set when the `cc_version` was bumped in BAT-498.
The original 2026-03-18 run used `cc_version=2.1.78` and returned the same pass/fail
pattern, just with 400s instead of 429s for the "rejected" cases — Anthropic
switched the reject code to 429 at some point between the two runs.

### Setup Token WITHOUT billing attribution

| Model | Status |
|-------|--------|
| claude-opus-4-7 | ❌ 429 (rate_limit) |
| claude-opus-4-6 | ❌ 429 (rate_limit) |
| claude-sonnet-4-6 | ❌ 429 (rate_limit) |
| claude-haiku-4-5 | ✅ 200 — Haiku doesn't require billing |

### Setup Token WITH billing attribution (production wire shape)

| Model | Status | Response |
|-------|--------|----------|
| claude-opus-4-7 | ✅ 200 | SSE stream, 11 events |
| claude-opus-4-6 | ✅ 200 | SSE stream, 10 events |
| claude-sonnet-4-6 | ✅ 200 | SSE stream, 12 events |
| claude-haiku-4-5 | ✅ 200 | SSE stream, 7 events |

### Root Cause

Anthropic requires a **billing attribution string in the system prompt** for OAuth
tokens (`sk-ant-oat01-*`) to access non-Haiku models. This string identifies the
request as originating from a Claude Code-compatible client:

```
x-anthropic-billing-header: cc_version=2.1.116; cc_entrypoint=cli; cch=00000;
```

- Must be a **separate text block** in the `system` array (not concatenated)
- Only needed for `setup_token` auth — standard API keys are unaffected
- Placed **before** other system prompt blocks, no `cache_control` on this block
- `cch` value was not validated in our testing
- `cc_version` lags the current Claude Code release; bump when it falls multiple
  minor releases behind (defensive — Anthropic has not enforced a minimum)

Fix applied in `providers/claude.js` → `formatSystemPrompt()`.

### Header Combo Results (per model, setup token, 2026-04-21)

| Combo | Opus 4.7 | Opus 4.6 | Sonnet 4.6 | Haiku 4.5 |
|-------|----------|----------|------------|-----------|
| Bearer + oauth+cache beta (no billing) | ❌ 429 | ❌ 429 | ❌ 429 | ✅ 200 |
| Bearer + oauth+cache beta + **billing** | ✅ 200 | ✅ 200 | ✅ 200 | ✅ 200 |
| Bearer + oauth only + **billing** | ✅ 200 | ✅ 200 | ✅ 200 | ✅ 200 |
| Bearer + cache only (no oauth beta) | ❌ 401 | ❌ 401 | ❌ 401 | ❌ 401 |
| Bearer + no beta | ❌ 401 | ❌ 401 | ❌ 401 | ❌ 401 |
| x-api-key auth (oat01 token) | ❌ 429 | ❌ 429 | ❌ 429 | ✅ 200 |
