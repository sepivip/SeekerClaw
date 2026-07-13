# Anthropic (Claude) live model probe — EXACT AGENT COPY (BAT-1144, Part 3)

> This file documents `live-models.probe.js` + `worker.js` — the exact-agent-copy
> model-matrix probe. The existing `README.md` in this folder documents the older
> `test-*.js` topic probes (auth / headers / thinking matrices); both are kept.

Hits the **live** Anthropic Messages API with **your** credential and reports, per
model, whether it responds — but the point is _how_ it builds the request.

## What "exact copy" means

Prior live harnesses fake the payload — a hand-written short system prompt and a
handful of dummy tools. That means a "works here / breaks on device" gap can hide
in everything they faked.

This harness **imports the real agent modules** and builds the wire body the
**exact way `ai.js chat()` does** — no re-implementation:

| Piece | Real module (from the device bundle) |
|-------|--------------------------------------|
| System prompt (~54 KB) | `ai.buildSystemBlocks()` → `{ stable, dynamic }` |
| Prompt formatting | `providers/claude.formatSystemPrompt(stable, dynamic, AUTH_TYPE)` |
| Tools (64, telegram channel) | `tools/index` `TOOLS` → `formatTools()` |
| Messages | `toApiMessages([{role:'user', content}])` |
| Wire body | `formatRequest(model, 4096, system, messages, tools, requestOptions)` |
| Transport (live) | `http.js httpStreamingRequest(options, body)` |

The only intentional difference from the device payload is **MCP tools** — the
harness omits them (no MCP manager), so it sends the 64 built-in tools. On device
`getTools()` returns `[...TOOLS, ...mcp]`.

## One process per auth mode

`config.js` freezes `AUTH_TYPE` (and therefore which Claude credential + billing
lane is live) at module-load time from the fixture's `config.json`. A single
process can therefore only be `api_key` **or** `setup_token`. The parent forks
**one worker per mode**:

- **api_key** → `api.anthropic.com` `/v1/messages`, `x-api-key` header, **no**
  billing block in `system`.
- **setup_token** (Pro/Max OAuth) → same endpoint, `Authorization: Bearer …`
  header, and a leading `cc_version` billing-attribution text block prepended to
  `system` (required for a Pro/Max token to reach non-Haiku models).

Both modes emit the same wire body otherwise: `model`, `max_tokens: 4096`,
`stream: true`, `system` (array of cache-controlled text blocks), `messages`, and
`tools` (Claude-native `{name, description, input_schema}`, last one carrying
`cache_control:{type:'ephemeral'}`). No `thinking` block unless the reasoning
toggle is on (adaptive thinking is gated on `reasoningEnabled` + registry support).

## Run

```bash
# OFFLINE acceptance test — no secrets, no Anthropic/external network. This is the gate.
# (buildSystemBlocks fires a fire-and-forget localhost /burner/status probe that fails
#  silently with no bridge server, so it's "no external network", not literally no sockets.)
node tests/live/anthropic/live-models.probe.js --self-check

# Live sweep (needs credentials):
cp tests/live/anthropic/.env.test.example tests/live/anthropic/.env.test
# …edit .env.test, set ANTHROPIC_API_KEY and/or SETUP_TOKEN
node tests/live/anthropic/live-models.probe.js

# Options
node tests/live/anthropic/live-models.probe.js --mode setup_token
node tests/live/anthropic/live-models.probe.js --models claude-opus-4-8,claude-sonnet-5
node tests/live/anthropic/live-models.probe.js --base-url http://127.0.0.1:8080
node tests/live/anthropic/live-models.probe.js --help
```

Exit: **0** whenever the sweep/self-check ran; **1** only on setup/credential/assert error.

## Flags

- `--self-check` — offline. Seeds both fixtures with placeholder tokens, builds
  the real body per mode, and asserts the wire shape (endpoint, `stream:true`,
  `max_tokens`, `system` block layout incl. the setup_token billing block, tool
  count == real `TOOLS.length` and Claude tool shape, and that the prompt reflects
  the **seeded mock workspace** — proving it's the real payload, not a fake).
  Prints both bodies (token-redacted).
- `--mode apikey|setup_token|both` — default: whichever creds exist.
- `--models <csv|all>` — `all` = the registry set for the provider (ignores
  `TEST_MODELS`). Default = `TEST_MODELS` if set, else the registry set. **Verify
  live model ids via a live `/v1/models` or context7** — do not hardcode from memory.
- `--diagnose` — accepted for parity with the sibling probes; no-op for Claude
  (no beyond-parity reasoning ladder).
- `--base-url <url>` — gateway override for the live POST (the adapter's real
  `/v1/messages` path is preserved).

## Security

- `.env.test` is gitignored. **Never commit it.** Tokens are never printed — only
  `present(len=N)`; any secret is scrubbed from printed bodies/errors via
  `redactIn`.
- Generated `fixtures/**/config.json` + seeded workspace + `node_debug.log` are
  gitignored. The fixture dirs are seeded at runtime by `_shared/fixture.js`.
- Node builtins only — no `npm install`, no dependencies.

## Fixtures

`fixtures/{apikey,setup_token}/` are per-mode workDirs. `_shared/fixture.js` writes
a `config.json` (`provider=claude`, `channel=telegram`, the mode's auth fields via
`authConfig`, a canonical `bridgeToken`, a model) plus a **mock-but-realistic**
workspace (`SOUL.md`, `IDENTITY.md` = "TestBot", `USER.md` = "Test User",
`MEMORY.md`, two `memory/<date>.md`). All obviously synthetic — no real user data.

## Shared helpers

`env.js` + `fixture.js` live in the repo-wide `tests/live/_shared/` (shared by
every live probe — `openai/`, `xai/`, `anthropic/`); this harness imports them as
`require('../_shared/…')`.

## Notes

- Real telegram tool count is **64** (no MCP) — assembled from `tools/index`
  `TOOLS` and asserted live by the self-check against `TOOLS.length`, so it stays
  correct if the real count changes.
