# Custom-provider live model probe — EXACT AGENT COPY (BAT-1144, Part 2)

Hits a **live** user-configured OpenAI-compatible gateway (the "custom" provider)
with **your** credential and reports whether the configured model responds — but
the point is _how_ it builds the request.

## What "exact copy" means

Prior live harnesses fake the payload — a hand-written short system prompt and a
handful of dummy tools. That means a "works here / breaks on device" gap can hide
in everything they faked.

This harness **imports the real agent modules** and builds the wire body the
**exact way `ai.js chat()` does** — no re-implementation:

| Piece | Real module (from the device bundle) |
|-------|--------------------------------------|
| System prompt (~54 KB) | `ai.buildSystemBlocks()` → `{ stable, dynamic }` |
| Prompt formatting | `providers/custom.formatSystemPrompt(stable, dynamic, AUTH_TYPE)` |
| Tools (64, telegram channel) | `tools/index` `TOOLS` → `formatTools()` |
| Messages | `toApiMessages(messages, model, requestOptions)` |
| Wire body | `formatRequest(model, 4096, instructions, input, tools, requestOptions)` |
| Transport (live) | `http.js httpChatCompletionsStreamingRequest(options, body)` |

The only intentional difference from the device payload is **MCP tools** — the
harness omits them (no MCP manager), so it sends the 64 built-in tools. On device
`getTools()` returns `[...TOOLS, ...mcp]`.

## The custom provider

`custom` is a **user-configured OpenAI-compatible gateway** (a middleman or
self-hosted endpoint). Its default `customFormat` is `chat_completions`, so
`providers/custom.js` delegates the request-shaping to `providers/openrouter.js`
but emits its **own clean Chat Completions body** (no OpenRouter cache_control /
fallback decorations):

```json
{ "model": "…", "stream": true, "max_tokens": 4096,
  "messages": [ { "role": "system", "content": "‹the real system prompt›" }, … ],
  "tools": [ { "type": "function", "function": { "name": "…", "parameters": {…} } }, … ] }
```

- **Single auth mode** — `api_key` only (bearer token). **No fork.**
- **Endpoint** — built from your `customBaseUrl` **verbatim** (`config.js`
  `parseCustomEndpoint`): the whole URL path is used, not just the host.
- **Tools** — chat_completions shape `{type:'function', function:{name, description, parameters}}`.

## Run

```bash
# OFFLINE acceptance test — no secrets, no gateway/external network. This is the gate.
# (buildSystemBlocks fires a fire-and-forget localhost /burner/status probe that fails
#  silently with no bridge server, so it's "no external network", not literally no sockets.)
node tests/live/custom/live-models.probe.js --self-check

# Live sweep (needs credentials):
cp tests/live/custom/.env.test.example tests/live/custom/.env.test
# …edit .env.test, set CUSTOM_API_KEY, CUSTOM_BASE_URL, CUSTOM_MODEL
node tests/live/custom/live-models.probe.js

# Options
node tests/live/custom/live-models.probe.js --models gpt-4o-mini,llama-3.3-70b
node tests/live/custom/live-models.probe.js --base-url http://127.0.0.1:8080
node tests/live/custom/live-models.probe.js --help
```

Exit: **0** whenever the sweep/self-check ran; **1** only on setup/credential/assert error.

## Flags

- `--self-check` — offline. Seeds a fixture with a **placeholder** base URL
  (`https://api.example.com/v1`) and model, builds the real chat_completions body,
  asserts the wire shape (`stream:true`, `max_tokens`, `model`, a `system` message,
  tool count == real `TOOLS.length` with the `{type:'function', function:{…}}`
  shape, the endpoint host reflects the seeded `customBaseUrl`, and that the prompt
  reflects the **seeded mock workspace** — proving it's the real payload, not a
  fake). Prints the body (token-redacted).
- `--models <csv>` — default: `CUSTOM_MODEL` from `.env.test`. Custom is freeform
  (no registry model list).
- `--mode apikey` — accepted for symmetry only; custom is single-auth.
- `--diagnose` — accepted for symmetry; a documented **no-op** for chat_completions
  custom (the body carries no `reasoning` field to sweep).
- `--base-url <url>` — gateway override for the live POST (the adapter's real path
  is preserved).

## Security

- `.env.test` is gitignored. **Never commit it.** Tokens are never printed — only
  `present(len=N)`; any secret is scrubbed from printed bodies/errors via
  `redactIn`.
- Generated `fixtures/**/config.json` + seeded workspace + `node_debug.log` are
  gitignored. The fixture dir is seeded at runtime by `_shared/fixture.js`.
- Node builtins only — no `npm install`, no dependencies.

## Fixtures

`fixtures/apikey/` is the fixture workDir. `_shared/fixture.js` writes a
`config.json` (provider=custom, channel=telegram, `customApiKey` / `customBaseUrl`
/ `customFormat`, a canonical `bridgeToken`, a model) plus a **mock-but-realistic**
workspace (`SOUL.md`, `IDENTITY.md` = "TestBot", `USER.md` = "Test User",
`MEMORY.md`, two `memory/<date>.md`). All obviously synthetic — no real user data.

## Shared helpers

`env.js` + `fixture.js` live in the repo-wide `tests/live/_shared/` (shared by
every live probe — `openai/`, `xai/`, `anthropic/`, `custom/`); this harness
imports them as `require('../_shared/…')`.

## Notes

- Real telegram tool count is **64** (no MCP) — asserted live against
  `tools/index` `TOOLS`, so the check stays correct if the real count changes.
- A gateway configured for the Responses API (`customFormat: 'responses'`)
  delegates to `openai.js` and produces a **different** body shape — out of scope
  for this worker (use the openai harness). The worker fails loudly if booted with
  a non-`chat_completions` format.
