# Production Timeout & Sanitizer Audit Report

**Date:** 2026-02-21
**Issue:** Agent hits `Error: Timeout` during heavy multi-tool turns (multiple parallel web_fetch calls). Turn is lost. Next message revives agent.
**Scope:** Audit only — no code changes.

---

## 0. Runtime Source-of-Truth

**SeekerClaw does NOT run `openclaw-reference/` in production.** It runs its own custom Node.js bundle.

| Claim | Evidence |
|-------|----------|
| Entry point is `main.js` in assets | `NodeBridge.kt` calls `startNodeWithArguments(arrayOf("node", "$nodeProjectDir/main.js", workDir))` |
| `openclaw-reference/` is reference-only | Never copied into APK; not referenced by any Gradle task or asset copy |
| Production files | `main.js`, `claude.js`, `web.js`, `tools.js`, `bridge.js` in `app/src/main/assets/nodejs-project/` |

**All findings below are from the production code path**, not `openclaw-reference/`.

---

## 1. Where "Error: Timeout" Is Thrown

**Primary source — `web.js:28`:**
```javascript
req.setTimeout(60000, () => { req.destroy(); reject(new Error('Timeout')); });
```

This is the **exact error message** from the logs: `Error: Timeout` (capital T, no prefix).

The `httpRequest()` function is used for:
- **Claude API calls** — `claude.js:962-974`
- **Telegram API calls** — `telegram.js:17-23`
- **web_fetch tool** — via `webFetch()` at `web.js:325`

Other timeout errors have **different messages** and are ruled out:

| Source | Error message | File:Line |
|--------|--------------|-----------|
| shell_exec | `"Command timed out after ${timeout}ms"` | `tools.js:3365` |
| js_eval | `"Execution timed out after ${timeout}ms"` | `tools.js:3482` |
| webFetch redirect chain | `"Request timeout (redirect chain)"` | `web.js:307` |
| Android bridge | `"Android Bridge timeout"` | `bridge.js:50` |
| MCP client | `"Request timed out after ${timeoutMs}ms"` | `mcp-client.js:160` |
| Solana RPC | `"Solana RPC timeout"` | `solana.js:60` |
| Telegram upload | `"Upload timed out"` | `telegram.js:80` |

**Only `web.js:28` produces the bare `"Timeout"` message.**

---

## 2. Timeout Value & Ownership

| Parameter | Value | Location | Configurable? |
|-----------|-------|----------|---------------|
| `httpRequest` socket timeout | **60,000 ms (60s)** | `web.js:28` | **No** — hardcoded |
| `webFetch` cumulative deadline | 30,000 ms (30s) | `web.js:285` | Only via `options.timeout` param |

**Critical bug:** `webFetch` passes `timeout: Math.min(remaining, timeout)` in the options object at `web.js:331`, but `httpRequest` **never reads `options.timeout`** — it always uses the hardcoded `60000`. The `timeout` option is silently ignored.

### Config Precedence (timeout-related)

There is **no config file, env var, or `agent_settings.json` override** for the HTTP timeout. Complete precedence:

| Priority | Source | Timeout Fields | File:Line |
|----------|--------|----------------|-----------|
| 1 (only) | Hardcoded in `httpRequest` | `60000` | `web.js:28` |
| — | `config.js` | No timeout fields | (confirmed: zero matches for "timeout" in config.js) |
| — | `agent_settings.json` | Not read for timeouts | Only referenced in system prompt text, not parsed for timeout values |
| — | Environment variables | None | No `process.env.*TIMEOUT*` patterns found |

**Owner: SeekerClaw's `web.js` — not the Anthropic SDK, not OpenClaw, not Telegram.**

---

## 3. Full Agent Loop Flow (Tool-Use Turns)

### Call Path: Telegram inbound → Timeout → Orphaned blocks

```
poll() [main.js:705]
  └─ telegram('getUpdates', { timeout: 30 }) [main.js:708-710]
      └─ httpRequest → api.telegram.org  [telegram.js:17, web.js:13]
  └─ enqueueMessage(msg) [main.js:752]
      └─ handleMessage(msg) [main.js:408]
          └─ chat(chatId, userContent) [main.js:592 → claude.js:1188]
              └─ sanitizeConversation(messages) [claude.js:1218]
              └─ WHILE toolUseCount < 5: [claude.js:1225]
                  ├─ claudeApiCall(body, chatId) [claude.js:1234 → claude.js:903]
                  │   └─ httpRequest → api.anthropic.com [claude.js:962 → web.js:13]
                  │       └─ req.setTimeout(60000, ...) [web.js:28] ← TIMEOUT FIRES HERE
                  ├─ On success: extract toolUses [claude.js:1245]
                  ├─ messages.push(assistant response with tool_use) [claude.js:1256]
                  ├─ FOR each toolUse: [claude.js:1260]
                  │   └─ executeTool(name, input, chatId) [claude.js:1293]
                  │       └─ (for web_fetch): webFetch → httpRequest [tools.js:932 → web.js:325 → web.js:13]
                  │           └─ req.setTimeout(60000, ...) [web.js:28] ← OR TIMEOUT FIRES HERE
                  ├─ messages.push(user tool_results) [claude.js:1307]
                  └─ LOOP BACK to claudeApiCall [claude.js:1225]
              └─ On throw: propagates to handleMessage [main.js:619]
                  └─ log(`Error: ${error.message}`) [main.js:620]
                  └─ sendMessage(chatId, `Error: ${error.message}`) [main.js:621]
```

### How Orphaned Blocks Are Created

The scenario that produces orphaned `tool_use` blocks:

1. **API call #1 succeeds** → response contains `tool_use` blocks
2. **`claude.js:1256`:** Assistant message with `tool_use` pushed to `messages[]`
3. **`claude.js:1260-1304`:** Tools execute sequentially, `toolResults[]` collected
4. **`claude.js:1307`:** User message with `tool_result` pushed to `messages[]`
5. **API call #2 (follow-up with tool results)** → `httpRequest` at `claude.js:962`
6. **60s timeout fires** at `web.js:28` → `new Error('Timeout')` thrown
7. **Caught at** `claude.js:975` → logged to DB → rethrown at `claude.js:989`
8. **Propagates out** of `chat()` (no try/catch around the while-loop) → caught at `main.js:619`
9. **User sees:** `Error: Timeout`
10. **Conversation state:** `messages[]` now contains the assistant's `tool_use` block AND the user's `tool_result` block from step 4. **Both are intact.** But the model's response to the tool results was never received.

**On the NEXT message** from the user:
- `chat()` is called again → `claude.js:1218` runs `sanitizeConversation()`
- If the last assistant message has `tool_use` blocks and the last user message has matching `tool_result` blocks, they are **correctly paired** — no stripping needed
- **BUT:** If the timeout happened during tool execution (between steps 2 and 4) — i.e., one tool's `web_fetch` timed out — then `executeTool` would throw inside the for-loop, and `toolResults` would be incomplete. The `messages.push(toolResults)` at line 1307 would **never execute**, leaving the assistant's `tool_use` block orphaned (no matching `tool_result` message follows it)

**This is the orphan path:** The sanitizer at `claude.js:1114-1144` detects the assistant message with `tool_use` IDs that have no corresponding `tool_result` in the next message, and strips them.

---

## 4. Sanitizer Location & Trigger

**Function:** `sanitizeConversation()` at `claude.js:1110-1182`

**When it runs:** Before every Claude API call, at `claude.js:1218` — inside `chat()`, before the tool-use while-loop begins.

**What it does (two passes):**

| Pass | Lines | Action |
|------|-------|--------|
| Pass 1: orphaned `tool_use` | `claude.js:1114-1144` | Scans assistant messages backwards; for each `tool_use` block, checks if the next user message has a matching `tool_result`. Strips unmatched `tool_use` blocks. Removes empty messages. |
| Pass 2: orphaned `tool_result` | `claude.js:1146-1176` | Scans user messages backwards; for each `tool_result` block, checks if the previous assistant message has a matching `tool_use`. Strips unmatched `tool_result` blocks. Removes empty messages. |

**Log output at `claude.js:1179`:**
```
[Sanitize] Stripped ${stripped} orphaned tool_use/tool_result block(s) from conversation
```

---

## 5. Tool Execution vs. Provider Request Lifecycle

**Tool execution is DECOUPLED from the API request.**

The flow is strictly sequential:
1. API request completes → response fully received → connection closed
2. Tool_use blocks extracted from response (`claude.js:1245`)
3. Tools executed one-by-one in a for-loop (`claude.js:1260`)
4. New API request opened with tool results (`claude.js:1234`, next loop iteration)

**Tools are NOT executed inside the streaming response.** There is no streaming at all — SeekerClaw uses synchronous (non-streaming) `POST /v1/messages`.

**Tools are executed SEQUENTIALLY, not in parallel.** The for-loop at `claude.js:1260` `await`s each tool before proceeding to the next.

---

## 6. Concrete Timeout Owner for This Incident

### Primary candidate (HIGH confidence): Claude API follow-up call timeout

**Evidence:**
- Log shows `Error: Timeout` — exact match to `web.js:28`
- The user reported "heavy multi-tool task (multiple parallel web_fetch calls)" — the model requested multiple `web_fetch` tool uses, they executed sequentially, then the **follow-up API call** to Claude (with all tool results) timed out at 60s
- The follow-up API call sends a large payload (system prompt + conversation + all tool results) — this can take >60s for the model to process and respond, especially when tool results are large (50KB per web_fetch result max)
- The sanitizer stripping "1 orphaned block" on the **next** message confirms the conversation had unmatched tool_use/tool_result pairs from the interrupted turn

### Alternative candidate (LOWER confidence): web_fetch tool timeout during execution

- If a `web_fetch` tool call itself timed out, the error would be caught at `tools.js:984` and returned as `{ error: "Timeout" }` — this would NOT propagate to `handleMessage`, so the user would NOT see `Error: Timeout` in the chat
- **This rules it out** as the source of the user-visible error

### Ruling

**The 60s `httpRequest` timeout at `web.js:28` fired during a Claude API call (likely the follow-up call after tool execution in the tool-use loop at `claude.js:962`).**

---

## 7. Config Precedence Summary

| Priority | Source | Exists? | Timeout Override? |
|----------|--------|---------|-------------------|
| 1 | `agent_settings.json` | Yes (runtime) | **No** — no timeout fields |
| 2 | `config.yaml` / `config.json` | Yes (startup) | **No** — no timeout fields |
| 3 | Environment variables | N/A (Android) | **No** — none defined |
| 4 | Hardcoded in `httpRequest` | **Yes** | **60000ms** — `web.js:28` |
| 5 | Anthropic SDK defaults | N/A | SeekerClaw uses raw HTTP, not the SDK |

**There is exactly one timeout source: the hardcoded `60000` at `web.js:28`.**

---

## 8. Minimal Instrumentation Plan (No Code Changes Yet)

To confirm timeout origin in a single reproduction run, add these **4 log points**:

| # | Where | What to Log | Expected Pattern |
|---|-------|-------------|------------------|
| 1 | `claude.js:1234` (before `claudeApiCall`) | `[API-START] iteration=${toolUseCount} bodyLen=${body.length} toolResultCount=${toolResults?.length}` | Shows which loop iteration times out and how large the payload is |
| 2 | `claude.js:975` (catch in `claudeApiCall`) | `[API-TIMEOUT] elapsed=${Date.now()-startTime}ms retries=${retries} chatId=${chatId}` | Should show `elapsed≈60000ms` confirming the 60s httpRequest timeout |
| 3 | `claude.js:1256` (after pushing assistant tool_use) | `[TOOL-LOOP] pushing assistant msg with ${toolUses.length} tool_use blocks, ids=[${toolUses.map(t=>t.id)}]` | Shows which tool_use IDs are in history before potential timeout |
| 4 | `web.js:28` (inside setTimeout callback) | `[HTTP-TIMEOUT] host=${options.hostname} path=${options.path} method=${options.method}` | Confirms whether timeout fires on `api.anthropic.com` or another host |

**Expected log pattern for the primary hypothesis:**
```
[API-START] iteration=1 bodyLen=85000 toolResultCount=3
[HTTP-TIMEOUT] host=api.anthropic.com path=/v1/messages method=POST
[API-TIMEOUT] elapsed=60002ms retries=0 chatId=12345
Error: Timeout
[Sanitize] Stripped 1 orphaned tool_use/tool_result block(s) from conversation
```

---

## 9. Unknowns Still Requiring Runtime Instrumentation

1. **Which loop iteration timed out?** — Was it the 2nd API call (after tool execution) or a later iteration? Needs log point #1 to confirm.
2. **Payload size at timeout?** — Were tool results large enough to cause slow model processing >60s? Needs `body.length` logged.
3. **Was the timeout on the request phase or the response phase?** — `req.setTimeout` fires for socket inactivity, not total request time. If the server sent partial data and then stalled, the timeout would NOT fire (Node.js `setTimeout` resets on each data chunk). This means the server either (a) never responded at all, or (b) stopped sending data for 60s mid-response. Needs timing instrumentation to distinguish.
4. **Retry behavior:** — The timeout at `web.js:28` throws immediately; it is caught at `claude.js:975` and **rethrown without retry** (network errors bypass the retry loop). This is unlike HTTP 429/5xx errors which DO retry. Whether the timeout should be retried is a design question.
5. **`req.setTimeout` semantics confirmation:** — Node.js `socket.setTimeout` measures inactivity (time since last data), NOT wall-clock elapsed time. A response that streams data slowly (1 byte/second) would never trigger it. Need to confirm whether the Anthropic API is non-streaming (single response body) in this code path — it is (no `stream: true` in the request body), so the 60s inactivity timeout effectively equals a 60s wall-clock timeout for the full response.
