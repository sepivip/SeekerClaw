# OpenRouter live model probe — EXACT AGENT COPY (BAT-1144)

Hits the **live** OpenRouter Chat Completions API (`openrouter.ai/api/v1/chat/completions`)
with **your** key and reports, per model, whether it responds — but the point is
_how_ it builds the request.

## What "exact copy" means

Prior live harnesses fake the payload — a hand-written short system prompt and a
handful of dummy tools. That means a "works here / breaks on device" gap can hide
in everything they faked.

This harness **imports the real agent modules** and builds the wire body the
**exact way `ai.js chat()` does** — no re-implementation:

| Piece | Real module (from the device bundle) |
|-------|--------------------------------------|
| System prompt (~54 KB) | `ai.buildSystemBlocks()` → `{ stable, dynamic }` |
| Prompt formatting | `providers/openrouter.formatSystemPrompt(stable, dynamic)` |
| Tools (64, telegram channel) | `tools/index` `TOOLS` → `formatTools()` |
| Messages | `toApiMessages(messages, model, requestOptions)` |
| Wire body | `formatRequest(model, 4096, systemPrompt, messages, tools, requestOptions)` |
| Transport (live) | `http.js httpChatCompletionsStreamingRequest(options, body)` |

The only intentional difference from the device payload is **MCP tools** — the
harness omits them (no MCP manager), so it sends the 64 built-in tools. On device
`getTools()` returns `[...TOOLS, ...mcp]`.

## Single auth mode

OpenRouter authenticates with **one** mode: `api_key` (`Authorization: Bearer sk-or-v1-…`).
There is **no** OAuth/Codex fork like OpenAI — the parent forks exactly one worker
(`mode=apikey`). The Chat Completions body:

- **model** — the OpenRouter model id (e.g. `anthropic/claude-sonnet-4-6`).
- **stream** — `true` (the device path).
- **max_tokens** — `4096`.
- **messages** — `[{role:'system', content:<system prompt>}, {role:'user', …}]`.
- **cache_control** — `{type:'ephemeral'}` (top-level, cross-provider prompt caching).
- **tools** — 64 entries in Chat Completions shape:
  `{type:'function', function:{name, description, parameters}}`.
- **reasoning** — *omitted* on a normal turn (OpenRouter's `reasoningSupport`
  resolves to `unknown` for every OR-prefixed model, so the toggle is a no-op);
  synthetic/heartbeat turns send `reasoning:{effort:'none'}` as an explicit disable.

## Run

```bash
# OFFLINE acceptance test — no secrets, no OpenRouter/external network. This is the gate.
# (buildSystemBlocks fires a fire-and-forget localhost /burner/status probe that fails
#  silently with no bridge server, so it's "no external network", not literally no sockets.)
node tests/live/openrouter/live-models.probe.js --self-check

# Live sweep (needs credentials):
cp tests/live/openrouter/.env.test.example tests/live/openrouter/.env.test
# …edit .env.test, set OPENROUTER_API_KEY
node tests/live/openrouter/live-models.probe.js

# Options
node tests/live/openrouter/live-models.probe.js --diagnose
node tests/live/openrouter/live-models.probe.js --models anthropic/claude-sonnet-4-6,openai/gpt-5.4
node tests/live/openrouter/live-models.probe.js --base-url http://127.0.0.1:8080
node tests/live/openrouter/live-models.probe.js --help
```

Exit: **0** whenever the sweep/self-check ran; **1** only on setup/credential/assert error.

## Flags

- `--self-check` — offline. Seeds the fixture with a placeholder key, builds the
  real body, asserts the wire shape (endpoint, `stream:true`, `max_tokens`,
  `cache_control`, `messages[0]` is the system message, tool count == real
  `TOOLS.length` in OpenRouter's function shape, and that the prompt reflects the
  **seeded mock workspace** — proving it's the real payload, not a fake). Prints
  the body (token-redacted).
- `--mode apikey` — the only mode (OpenRouter has no OAuth). Default: `apikey`.
- `--models <csv|all>` — OpenRouter is freeform (`models[]` is empty in the
  registry), so the default is the registry `defaultModel`
  (`anthropic/claude-sonnet-4-6`) unless you pass an explicit CSV or set
  `TEST_MODELS`. Pass real OpenRouter ids (provider-prefixed).
- `--diagnose` — also sweeps the reasoning-effort ladder `none/low/medium/high`,
  clearly labelled **beyond agent parity — param exploration**. Live only.
- `--base-url <url>` — gateway override for the live POST (the adapter's real path
  is preserved).

## Security

- `.env.test` is gitignored. **Never commit it.** Tokens are never printed — only
  `present(len=N)`; any secret is scrubbed from printed bodies/errors.
- Generated `fixtures/**/config.json` + seeded workspace + `node_debug.log` are
  gitignored. The fixture dir is seeded at runtime by `_shared/fixture.js`.
- Node builtins only — no `npm install`, no dependencies.

## Fixtures

`fixtures/apikey/` is the workDir. `_shared/fixture.js` writes a `config.json`
(`provider=openrouter`, `channel=telegram`, `authType=api_key`,
`openrouterApiKey`, a canonical `bridgeToken`, a model) plus a
**mock-but-realistic** workspace (`SOUL.md`, `IDENTITY.md` = "TestBot",
`USER.md` = "Test User", `MEMORY.md`, two `memory/<date>.md`). All obviously
synthetic — no real user data.

## Shared helpers

`env.js` + `fixture.js` live in the repo-wide `tests/live/_shared/` (shared by
every live probe — `openai/`, `xai/`, `anthropic/`, `openrouter/`); this harness
imports them as `require('../_shared/…')`.

## Notes

- Real telegram tool count is **64** (no MCP) — asserted live by the self-check
  against `tools/index` `TOOLS.length`, so it stays correct if the real count
  changes.
