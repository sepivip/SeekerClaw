# Testing Findings — hard-won diagnoses

Living log of non-obvious failures and how we proved/fixed them. When an outage
"makes no sense," check here first for the playbook.

---

## 2026-07-07 — "You're out of extra usage" 400 is a CONTENT-FILTER false-positive (NOT usage)

**Symptom.** The on-device agent (setup_token / Claude Code OAuth path) returned on
every turn:

```
status=400 type=invalid_request_error
"You're out of extra usage. Add more at claude.ai/settings/usage and keep going"
```

Started ~10:35 local, never recovered. The account was NOT out of usage.

**Root cause.** An auto-generated **session summary** injected into the system prompt
("Recent Sessions" block, `ai.js` `getRecentSessions()`, `sessions.summary_excerpt`)
contained the phrase:

> "…Responded with standard **heartbeat acknowledgment (HEARTBEAT_OK)** per instructions."

The **co-occurrence of the words `heartbeat` + `acknowledgment` + the token `HEARTBEAT_OK`**
in the request body deterministically makes Anthropic's setup_token endpoint reject the
request — and it dresses the rejection as the **billing** message above. It is a content
filter, not a usage cap.

**Proof (deterministic, 3/3).**
- `heartbeat acknowledgment (HEARTBEAT_OK)` → **400**
- drop any one of the three (`acknowledgment token (HEARTBEAT_OK)`, `heartbeat token (HEARTBEAT_OK)`, `heartbeat acknowledgment (HEARTBEAT)`) → **200**
- The phrases are ~40 chars → cost ≈ 0 → categorically NOT usage.

**Why it fooled us for hours (the trap).**
- The error *message* says billing → looks like a subscription cap.
- App can't poll usage for setup_token (`[Usage] Skipped`) → no counter-evidence.
- Repro tests with **synthetic** prompts always returned 200 — on the *same* token,
  account, model, and even from the *device's own network via curl*. Only the agent's
  **real** system prompt (carrying the poisoned summary) 400s.
- **Deadlock:** every turn 400s → the agent can't summarize new sessions → the poisoned
  summary never rotates out of the top-5.

**How we nailed it (reusable playbook).**
1. Pull `api_request_log` + `node_debug.log` from the device → read the *actual* error
   string and fingerprint (`msgFp`), not the user-facing copy.
2. Rule out the environment: replay an identical request with the same token from your
   machine AND **from the device's own network** (`curl` on-device). If both pass, it's
   the request bytes, not usage/token/headers/network.
3. Capture the agent's REAL outgoing request: instrument `http.js` `httpStreamingRequest`
   to dump `{headers (Authorization redacted), body}` to `workspace/seekerclaw-req-dump.json`,
   restart the `:node` process, trigger one turn, pull the dump, then revert `http.js`.
4. Replay the captured bytes → reproduce the 400. Then **binary-search the body**:
   system-vs-tools → quarter the system prompt → the offending section → the bullet →
   the phrase. Keep each slice tiny so cost can't be the variable.

**How to fight it in future.**
- Never trust the setup_token error *copy*. A 400 "out of extra usage" that a *tiny*
  probe on the same token does NOT reproduce = content-triggered, not billing.
- Regression probe: `tests/live/anthropic/test-content-filter-trigger.js` (LIVE=1) asserts the known
  trigger phrase still 400s and the neutralized form 200s — run it if this recurs.
- Repro of a full captured request: `tests/live/anthropic/test-recreate-failure.js`.

**Fix shipped.** (see PR) — (1) drop/neutralize trivial heartbeat-ack session summaries
before they enter the prompt; (2) self-heal: on a 400 whose minimal-probe doesn't
reproduce, retry the turn without the Recent-Sessions block; (3) correct the misleading
error copy.

**Ruled out (all on the exact same token/account):** usage/billing, token identity,
headers (device `claude.js` byte-identical to repo), model (Opus vs Sonnet), stream flag,
request size/cost, network/egress.
