# Live-test credentials (1Password)

Live probes and the Jupiter/burner tests read their keys from the environment. The keys
live in the 1Password vault **SeekerClaw Dev**; nothing secret is stored in the repo or on disk.

Each folder that needs keys has a committed `.env.op` file. It holds only `op://` secret
references (plus a few plain, non-secret settings), never a key value:

| File | Provides |
|---|---|
| `.env.op` (repo root) | `LINEAR_API_KEY`, `DUNE_API_KEY` |
| `tests/live/anthropic/.env.op` | `ANTHROPIC_API_KEY`, `SETUP_TOKEN` |
| `tests/live/openai/.env.op` | `OPENAI_API_KEY` |
| `tests/live/openrouter/.env.op` | `OPENROUTER_API_KEY` |
| `tests/live/xai/.env.op` | `XAI_OAUTH_TOKEN` |
| `tests/live/oauth-spikes/.env.op` | `XAI_API_KEY` |
| `tests/jupiter-ultra/.env.op` | `JUPITER_API_KEY`, `BURNER_SECRET_KEY`, `BURNER_PUBKEY`, plain RPC/test settings — used by `tests/jupiter-ultra/*` and `tests/paysh/*` |

## Running a test

Install the 1Password CLI (`op`) with desktop-app integration, then run the test through
`op run`. It resolves the references and passes the keys to that one process only:

```bash
op run --env-file=tests/live/anthropic/.env.op -- node tests/live/anthropic/live-models.probe.js
op run --env-file=tests/live/openrouter/.env.op -- node tests/live/openrouter/live-models.probe.js
```

If you are signed in to more than one 1Password account, set `OP_ACCOUNT` to the account that
holds the vault (for example `OP_ACCOUNT=my.1password.com`).

`op run` masks secret values in the command's output by default; keep that on.

## Rules

- **Never write a key into a file in the repo.** Add or rotate keys in 1Password; the `.env.op`
  references stay the same.
- A local `.env` / `.env.test` still works as a fallback, but a variable already set in the
  environment always wins over it.
- **The ChatGPT-login (Codex OAuth) tokens are not in 1Password.** The Codex CLI rotates them
  within seconds, so a stored copy goes stale at once. For an `--mode oauth` run, read the fresh
  token from `~/.codex/auth.json` immediately before the run.
- Probes print credentials by length only. Never echo or log a value.
