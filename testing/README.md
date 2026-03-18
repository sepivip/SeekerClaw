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
| `test-headers.js` | Test different header combos per model — diagnostic for 400 errors |
| `lib.js` | Shared helpers (env loader, model list, billing constant) |

## Usage

```bash
node test-auth.js       # Quick auth check
node test-messages.js   # Test all models with proper billing attribution
node test-headers.js    # Diagnose which header combos work per model
```

## .env Config

```env
ANTHROPIC_API_KEY=          # Standard API key (sk-ant-api03-...)
SETUP_TOKEN=                # Max Pro setup token (sk-ant-oat01-...)
TEST_MODELS=all             # "all" or comma-separated: claude-opus-4-6,claude-haiku-4-5
```

## Test Results (2026-03-18)

### Setup Token WITHOUT billing attribution

| Model | Status | Error |
|-------|--------|-------|
| claude-opus-4-6 | ❌ 400 | `invalid_request_error: "Error"` |
| claude-sonnet-4-6 | ❌ 400 | `invalid_request_error: "Error"` |
| claude-sonnet-4-5 | ❌ 400 | `invalid_request_error: "Error"` |
| claude-haiku-4-5 | ✅ 200 | Works without billing |

### Setup Token WITH billing attribution in system prompt

| Model | Status | Response |
|-------|--------|----------|
| claude-opus-4-6 | ✅ 200 | "PONG" |
| claude-sonnet-4-6 | ✅ 200 | "PONG" |
| claude-sonnet-4-5 | ✅ 200 | "PONG" |
| claude-haiku-4-5 | ✅ 200 | "PONG" |

### Root Cause

Anthropic requires a **billing attribution string in the system prompt** for OAuth
tokens (`sk-ant-oat01-*`) to access non-Haiku models. This string identifies the
request as originating from a Claude Code-compatible client:

```
x-anthropic-billing-header: cc_version=2.1.78; cc_entrypoint=cli; cch=00000;
```

- Must be a **separate text block** in the `system` array (not concatenated)
- Only needed for `setup_token` auth — standard API keys are unaffected
- Placed **before** other system prompt blocks, no `cache_control` on this block
- `cch` value is not validated server-side

Fix applied in `providers/claude.js` → `formatSystemPrompt()`.

### Header Combo Results (per model, setup token)

| Combo | Opus | Sonnet 4.6 | Sonnet 4.5 | Haiku |
|-------|------|------------|------------|-------|
| Bearer + oauth+cache beta (no billing) | ❌ 400 | ❌ 400 | ❌ 400 | ✅ 200 |
| Bearer + oauth+cache beta + **billing** | ✅ 200 | ✅ 200 | ✅ 200 | ✅ 200 |
| Bearer + oauth only + **billing** | ✅ 200 | ✅ 200 | ✅ 200 | ✅ 200 |
| Bearer + cache only (no oauth) | ❌ 401 | ❌ 401 | ❌ 401 | ❌ 401 |
| Bearer + no beta | ❌ 401 | ❌ 401 | ❌ 401 | ❌ 401 |
| x-api-key auth | ❌ 400 | ❌ 400 | ❌ 400 | ❌ 400 |
