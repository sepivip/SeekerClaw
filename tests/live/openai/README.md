# OpenAI live model probe — EXACT AGENT COPY (BAT-1144, Part 2)

Hits the **live** OpenAI Responses API with **your** credential and reports, per
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
| Prompt formatting | `providers/openai.formatSystemPrompt(stable, dynamic, AUTH_TYPE)` |
| Tools (64, telegram channel) | `tools/index` `TOOLS` → `formatTools()` |
| Messages | `toApiMessages(messages, model, requestOptions)` |
| Wire body | `formatRequest(model, 4096, instructions, input, tools, requestOptions)` |
| Transport (live) | `http.js httpOpenAIStreamingRequest(options, body)` |

The only intentional difference from the device payload is **MCP tools** — the
harness omits them (no MCP manager), so it sends the 64 built-in tools. On device
`getTools()` returns `[...TOOLS, ...mcp]`.

## One process per auth mode

`providers/openai.js` freezes `isOAuth` **and** the `endpoint` object at
module-load time from `OPENAI_AUTH_TYPE`. A single process can therefore only be
`api_key` **or** `oauth`. The parent forks **one worker per mode**:

- **api_key** → `api.openai.com` `/v1/responses` — body has `max_output_tokens`, no `store`.
- **oauth** (Codex) → `chatgpt.com` `/backend-api/codex/responses` — body has
  `store:false`, no `max_output_tokens`, `reasoning:{effort:'medium',summary:'auto'}`,
  `include:['reasoning.encrypted_content']`.

## Run

```bash
# OFFLINE acceptance test — no secrets, no OpenAI/external network. This is the gate.
# (buildSystemBlocks fires a fire-and-forget localhost /burner/status probe that fails
#  silently with no bridge server, so it's "no external network", not literally no sockets.)
node tests/live/openai/live-models.probe.js --self-check

# Live sweep (needs credentials):
cp tests/live/openai/.env.test.example tests/live/openai/.env.test
# …edit .env.test, set OPENAI_API_KEY and/or OPENAI_OAUTH_TOKEN
node tests/live/openai/live-models.probe.js

# Options
node tests/live/openai/live-models.probe.js --mode oauth --diagnose
node tests/live/openai/live-models.probe.js --models gpt-5.4,gpt-5.5
node tests/live/openai/live-models.probe.js --base-url http://127.0.0.1:8080
node tests/live/openai/live-models.probe.js --help
```

Exit: **0** whenever the sweep/self-check ran; **1** only on setup/credential/assert error.

## Flags

- `--self-check` — offline. Seeds both fixtures with placeholder tokens, builds
  the real body per mode, asserts the wire shape (endpoint, `store`/
  `max_output_tokens`/`reasoning`/`include`, `stream:true`, tool count == real
  `TOOLS.length`, and that the prompt reflects the **seeded mock workspace** —
  proving it's the real payload, not a fake). Prints both bodies (token-redacted).
- `--mode apikey|oauth|both` — default: whichever creds exist.
- `--models <csv|all|newest>` — `all` = the registry set for the mode (ignores
  `TEST_MODELS`); `newest` currently sweeps the registry set too, but the worker
  fetches `/v1/models` live and prints a **registry-vs-listed diff** so newly-listed
  ids surface for the show/hide decision. (Auto-sweeping *only* the new ids from
  `/v1/models` is a documented follow-up — the plumbing to resolve them in the
  parent before dispatch isn't in place yet.) Default = `TEST_MODELS` if set, else
  the registry set. **Verify live model ids** (e.g. `gpt-5.6-*`) via a live
  `/v1/models` or context7 — do not hardcode from memory.
- `--diagnose` — also sweeps the reasoning-effort ladder
  `none/minimal/low/medium/high/xhigh/max`, clearly labelled **beyond agent
  parity — param exploration** (the agent only ever sends `medium/auto`). Live only.
- `--base-url <url>` — gateway override for the live POST (the adapter's real
  path is preserved).

## Security

- `.env.test` is gitignored. **Never commit it.** Tokens are never printed — only
  `present(len=N)`; any secret is scrubbed from printed bodies/errors.
- Generated `fixtures/**/config.json` + seeded workspace + `node_debug.log` are
  gitignored. The fixture dirs are seeded at runtime by `_shared/fixture.js`.
- Node builtins only — no `npm install`, no dependencies.

## Fixtures

`fixtures/{apikey,oauth}/` are per-mode workDirs. `_shared/fixture.js` writes a
`config.json` (provider=openai, channel=telegram, the mode's auth fields, a
canonical `bridgeToken`, a model) plus a **mock-but-realistic** workspace
(`SOUL.md`, `IDENTITY.md` = "TestBot", `USER.md` = "Test User", `MEMORY.md`, two
`memory/<date>.md`). All obviously synthetic — no real user data. `config.js`
does **not** hard-require `bridgeToken` to load; it's included for realism.

### DB fixture — follow-up

The SQL.js **Recent-Sessions** DB is intentionally **not** seeded.
`getRecentSessions()` returns `[]` when the DB is absent, so the system prompt
simply omits the Recent-Sessions rollup. Seeding real rows means driving the
SQL.js WASM loader (async) + the `api_request_log` schema — punted to a follow-up
so the harness stays synchronous and dependency-free.

## Part-1 note

`_shared/` currently lives here (`tests/live/openai/_shared/`). Part 1 (repo-wide)
will introduce a shared `tests/live/_shared/`; `env.js` + `fixture.js` move there
then and the two `require('./_shared/…')` paths become `require('../_shared/…')`.

## Notes

- Real telegram tool count is **64** (no MCP). The "66" in project memory and the
  `~67` `input_schema` string count in `tools/*.js` count schema occurrences in
  source, which differ from the assembled runtime array — reconciling that memory
  note is a follow-up. The harness asserts against the **live** `TOOLS.length`, so
  it stays correct if the real count changes.
