# xAI OAuth Proof-Spikes (BAT-1124)

Self-contained Node spikes (builtins only, no deps, no secrets on disk) that
prove the xAI OAuth flows against xAI's **live** OIDC endpoints, using the
**public** Grok-CLI client (`b1a00492-073a-47ea-816f-4c329264a828`, no secret).

Endpoints (from live xAI OIDC discovery):

| Purpose            | URL                                              |
| ------------------ | ------------------------------------------------ |
| Authorize          | `https://auth.x.ai/oauth2/authorize`             |
| Device code        | `https://auth.x.ai/oauth2/device/code`           |
| Token              | `https://auth.x.ai/oauth2/token`                 |
| Discovery          | `https://auth.x.ai/.well-known/openid-configuration` |
| Inference (chat)   | `https://api.x.ai/v1/chat/completions`           |
| Models             | `https://api.x.ai/v1/models`                     |

Scope: `openid profile email offline_access grok-cli:access api:access`

<!-- LOOPBACK-SECTION -->

---

## Loopback + PKCE Spike (`loopback-spike.js`)

The **primary** flow for a machine with a browser: OAuth 2.0 authorization-code
grant with PKCE and a `127.0.0.1` loopback redirect. Proves the full path a
human with a **SuperGrok / X Premium+** account can confirm.

### What it proves

1. **PKCE** — generates a high-entropy verifier + S256 `code_challenge`.
2. **Loopback server** — binds `127.0.0.1:56121`, handles `GET /callback`, and
   **fails fast with a clear message if the port is in use** (the public client
   only whitelists `http://127.0.0.1:56121/callback`, so the port is fixed).
3. **Authorize URL** — builds and prints (and tries to auto-open) the URL with
   `response_type=code`, the public `client_id`, the fixed `redirect_uri`, our
   scope, `code_challenge`/`S256`, `state`, and `nonce` — and **no OpenAI-only
   params**.
4. **Callback** — validates `state` (CSRF defense), captures the code.
5. **Token exchange** — `grant_type=authorization_code` + `code_verifier`;
   reports (REDACTED) whether `access_token` + `refresh_token` + `expires_in`
   were returned.
6. **Refresh** — immediately runs a `grant_type=refresh_token` grant and reports
   whether the `refresh_token` **rotated**.
7. **Inference auth** — `GET /v1/models` with the access token; prints HTTP
   status + model count.

Tokens, the auth code, and the id_token are **never printed raw** — only
`present` / length (no token material is logged, not even a prefix).

### Requirements

- Node **18+** (uses global `fetch` + `crypto`). Verified on Node 22.
- Port `56121` on `127.0.0.1` free; a browser signed into SuperGrok / X Premium+.

### How to run

```bash
cd testing/xai-oauth-spike
node loopback-spike.js
```

Then:

1. The script prints (and tries to auto-open) the authorize URL. If it did not
   auto-open, copy/paste it into a browser signed into your SuperGrok /
   X Premium+ account.
2. Log in and approve the consent screen.
3. xAI redirects to `http://127.0.0.1:56121/callback`; the local server catches
   it, validates `state`, and the script does the rest automatically.
4. Watch the terminal for the step-by-step `[n/7]` output and the final
   `RESULT:` line.

Login step timeout: **5 min**. Per network call to xAI: **30 s**.

### PASS criteria

Exits `0` and prints `RESULT: PASS` only when **all** hold:

- `access_token` returned by the code exchange,
- `refresh_token` returned (requires `offline_access` scope),
- `expires_in` returned,
- `POST /v1/chat/completions` **or** `/v1/responses` (model `grok-4.3`) returns HTTP `200` — real inference works. (`GET /v1/models` is reported for info but 403s on first-touch provisioning, so it does **not** gate PASS.)

The refresh-rotation line is **informational** (reports `true`/`false` so we
know how the app must persist refresh tokens); it does not by itself fail the run.

### Exit codes

| Exit | Meaning                                                                   |
| ---- | ------------------------------------------------------------------------- |
| 0    | PASS — every criterion met                                                |
| 1    | Unexpected error (stack printed)                                          |
| 2    | Loopback server could not bind — **port 56121 in use** (clear message)    |
| 3    | Authorization failed — denied, `state` mismatch (CSRF), or 5-min timeout  |
| 4    | Token exchange failed (HTTP error body shown, e.g. `invalid_grant`)       |
| 5    | Flow completed but a PASS criterion was not met (INCOMPLETE)              |

### How this was verified (without a real account)

The non-account plumbing was exercised against the **real** xAI endpoints:

- Port-in-use → exits `2` with the clear "port 56121 in use" message.
- Wrong `state` on the callback → friendly error page + exit `3`.
- Correct `state` + a fake code → captures it, then the real
  `https://auth.x.ai/oauth2/token` returned `{"error":"invalid_grant"}`
  (HTTP 400) → exit `4`, confirming the authorize URL shape and token-exchange
  request are correct. The live login, refresh rotation, and `/v1/models` steps
  are exactly what this spike hands to Beka to confirm.

## Device-Code Fallback Spike (`devicecode-spike.js`)

The fallback used when a loopback redirect (`http://127.0.0.1:56121/callback`)
is **not** available — e.g. a headless or on-device (Seeker) context. Implements
the RFC 8628 OAuth 2.0 Device Authorization Grant.

### What it proves

1. **Device authorization request** — POSTs the device endpoint with
   `client_id` + `scope`, prints the `user_code` and `verification_uri_complete`
   for a human to open and approve in a browser.
2. **Token polling** — polls the token endpoint with
   `grant_type=urn:ietf:params:oauth:grant-type:device_code`, correctly
   honoring:
   - `interval` (base poll cadence from the server),
   - `authorization_pending` → keep polling,
   - `slow_down` → widen the interval by +5s (per RFC 8628),
   - `expired_token` / local deadline → abort cleanly,
   - `access_denied` → abort (user rejected).
3. **Refresh rotation** — on success, exercises a `grant_type=refresh_token`
   grant and reports whether the `refresh_token` was **rotated** or **reused**.
4. **Inference auth** — `GET /v1/models` with the access token to prove the
   token authenticates against the inference plane. Re-checked with the
   freshly-refreshed token too.

Tokens are **never printed** — presence is shown `REDACTED` with lengths only.

### Safety / timeouts

- Per-HTTP-request socket timeout: **20 s**.
- Overall run hard-stop: **10 min**.
- Local device-code deadline derived from the server's `expires_in`.
- Poll interval capped at **60 s** even after repeated `slow_down`.

### How to run

```bash
cd testing/xai-oauth-spike
node devicecode-spike.js
```

Then:

1. The script prints an **ACTION REQUIRED** block with a URL and a `USER CODE`.
2. Open the URL in a browser, confirm the code if asked, and approve the
   "Grok CLI" access request.
3. On an interactive terminal (TTY), press `<Enter>` after opening the URL to
   begin polling. In a non-TTY context (CI) polling starts immediately.
4. Watch the log: it prints pending polls, the final token grant (redacted),
   the refresh rotation result, and the visible model list.

Expected success tail:

```
=== SPIKE COMPLETE — device-code fallback path proven ===
```

### Notes

- Node builtins only (`https`, `url`, `readline`) — no `npm install`, no lockfile.
- No secrets touch disk; nothing is logged in the clear.
- Exit code `0` on success, `1` on any failure (with a `[SPIKE FAILED]` reason).
