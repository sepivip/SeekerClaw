# xAI live model-matrix probe (BAT-1124)

Hits the **live** `api.x.ai` with **your** credential and reports, per Grok model:

- **EXISTS?** — is it in `GET /v1/models` for this credential
- **RESPONDS?** — `POST /v1/chat/completions`, both **non-streaming** and **streaming**
  (streaming is the exact path the on-device agent uses)
- **PARAMS** — which request parameters a failing model actually needs

Purpose: turn "grok-4.5 doesn't respond on device" into a data question, then
compare this output directly against on-device behaviour.

## Run

```bash
cp tests/xai-models/.env.example tests/xai-models/.env.test
# edit .env.test — set XAI_API_KEY and/or XAI_OAUTH_TOKEN
node tests/xai-models/live-models.test.js
```

Or test the **real OAuth path** with no token on disk (in-browser login, token
held in memory only — this is the closest possible match to the device):

```bash
node tests/xai-models/live-models.test.js --login
```

## Output

- **[A]** `/v1/models` — the models your credential can actually see (and whether `grok-4.5` is among them).
- **[B]** non-streaming chat — HTTP status + verdict per model.
- **[C]** streaming chat — the device path; a model that 200s in [B] but yields **0 chunks** here is the "agent not responding" signature.
- **[D]** parameter probing on `grok-4.5` / any failing model — isolates a rejected-param cause.
- **DIAGNOSIS** — `grok-4.3` (known-good baseline) vs `grok-4.5`, with the likely fix.

## Security

- `.env.test` is gitignored (`.env.*`). **Never commit it.**
- Tokens are never printed — only `present(len=N)`.
- Node builtins only (`https`/`http`/`fs`/`crypto`/`url`) — no `npm install`, no dependencies.

## Compare with device

Match the per-model verdict here against Settings → model picker + a live
Telegram message on the device. A `404`/`403` for grok-4.5 here explains a
non-responding agent there; a stream-only failure ([C] fails, [B] passes)
points at the streaming path specifically.
