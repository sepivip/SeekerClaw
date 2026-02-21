# P1: Production Timeout Reliability — Validation Guide

**Epic:** P1 Production timeout reliability hardening
**Tasks:** BAT-243 (tracing), BAT-244 (configurable timeout), BAT-245 (retry/backoff), BAT-246 (integrity hardening)
**Gate task:** BAT-247

## Prerequisites

- All P1 PRs merged: #167, #168, #169, #170
- Build and deploy fresh APK with merged code
- Access to device `node_debug.log` (via adb or Logs screen)

## Repro Steps

### Test 1: Normal Short Chat (Regression Check)

1. Send a simple message: "What is 2+2?"
2. Wait for response
3. **Expected:**
   - Response arrives within a few seconds
   - No `[Retry]` log entries
   - `[Trace]` log shows `attempt: 0`, `status: 200`, `timeoutSource: null`
   - `[Sanitize]` log shows `stripped: 0`

### Test 2: Heavy Task (Timeout Stress)

1. Send a complex multi-tool message, e.g.:
   "Search the web for the latest Bitcoin price, then fetch the top result page, then analyze the data and write a summary to a file, then read it back."
2. This triggers multiple tool iterations (web_search → web_fetch → write_file → read_file)
3. **Expected:**
   - Each API iteration shows a `[Trace]` entry with incrementing `iteration` values
   - `turnId` is consistent across all iterations in the same turn
   - If timeout occurs: `[Retry]` entries appear with backoff timing
   - Tool errors produce `[ToolError]` structured logs (if any tool fails)
   - No orphaned tool_use blocks (sanitizer `stripped: 0`)

### Test 3: Forced Timeout (Config Override)

1. Add to `config.json`:
   ```json
   "apiTimeoutMs": 1000,
   "apiTimeoutRetries": 2
   ```
2. Send any message
3. **Expected:**
   - First attempt times out after ~1 second
   - `[Trace]` log shows `timeoutSource: "transport"`, `status: -1`
   - `[Retry]` log: "Transport timeout, retry 1/2, backoff XXXms"
   - Second attempt after backoff delay (375-625ms range with jitter)
   - If all retries exhaust: error message returned to user
   - DB log (`api_request_log`) records `retry_count >= 1`, `status: -1`
4. Restore original config after test

### Test 4: Zero Retries (Config Edge Case)

1. Set in `config.json`:
   ```json
   "apiTimeoutMs": 1000,
   "apiTimeoutRetries": 0
   ```
2. Send any message
3. **Expected:**
   - Single attempt, no retries
   - `[Trace]` log shows timeout
   - No `[Retry]` entries
   - Error returned immediately after first timeout

### Test 5: Tool Failure Integrity

1. Trigger a tool that can fail (e.g., `web_fetch` with an invalid URL via agent prompt)
2. **Expected:**
   - `[ToolError]` log appears with `turnId`, `tool`, `toolUseId`, `error`
   - Error result is returned as `tool_result` (not an orphan)
   - `[Sanitize]` still shows `stripped: 0` (no orphans created)
   - Conversation continues normally after the error

## Gate Checklist

| # | Criterion | Pass/Fail | Evidence |
|---|-----------|-----------|----------|
| 1 | Normal short chats work without retry (no regression) | | `[Trace]` log: `attempt: 0, status: 200` |
| 2 | `[Trace]` structured JSON logged on every API attempt | | Log entries with turnId, chatId, iteration, attempt, timestamps |
| 3 | `turnId` correlates across all iterations in a turn | | Same 8-char hex in all `[Trace]` entries for one message |
| 4 | Forced timeout triggers retry with backoff | | `[Retry]` entries + increasing backoff times |
| 5 | Retry count respects `apiTimeoutRetries` config | | Set to 0: no retries; set to 2: exactly 2 retries |
| 6 | `timeoutSource` distinguishes transport vs API error | | `"transport"` for timeout, `"api_error"` for HTTP errors, `null` for success |
| 7 | Backoff uses jitter (not identical intervals) | | Two consecutive backoff values differ |
| 8 | Non-timeout network errors are NOT retried | | DNS failure → immediate error, no `[Retry]` |
| 9 | `[Sanitize]` logs on every invocation (DEBUG or WARN) | | Entries with `invocations` counter incrementing |
| 10 | Tool failure produces error `tool_result`, not orphan | | `[ToolError]` log + `[Sanitize] stripped: 0` |
| 11 | `retry_count` in DB matches actual attempts | | `api_request_log` table query |
| 12 | Configurable timeout via `config.json` overrides default 60s | | `apiTimeoutMs: 1000` causes faster timeout |

## Log Patterns to Verify

### Success (normal chat)
```
DEBUG|[Trace] {"turnId":"a1b2c3d4","chatId":"123","iteration":0,"attempt":0,"apiCallStart":"...","apiCallEnd":"...","elapsedMs":1234,"payloadSize":5000,"toolCount":0,"timeoutSource":null,"status":200}
DEBUG|[Sanitize] {"turnId":"a1b2c3d4","stripped":0,"cumulativeStripped":0,"invocations":1}
```

### Timeout with retry
```
WARN|[Trace] {"turnId":"a1b2c3d4","chatId":"123","iteration":0,"attempt":0,...,"timeoutSource":"transport","status":-1,"error":"Timeout"}
WARN|[Retry] Transport timeout, retry 1/2, backoff 412ms
WARN|[Trace] {"turnId":"a1b2c3d4","chatId":"123","iteration":0,"attempt":1,...,"timeoutSource":"transport","status":-1,"error":"Timeout"}
WARN|[Retry] Transport timeout, retry 2/2, backoff 823ms
WARN|[Trace] {"turnId":"a1b2c3d4","chatId":"123","iteration":0,"attempt":2,...,"timeoutSource":null,"status":200}
```

### Tool execution error
```
ERROR|[ToolError] {"turnId":"a1b2c3d4","tool":"web_fetch","toolUseId":"toolu_123","error":"ETIMEDOUT"}
DEBUG|[Sanitize] {"turnId":"a1b2c3d4","stripped":0,"cumulativeStripped":0,"invocations":5}
```

## Config Reference

| Key | Default | Range | Description |
|-----|---------|-------|-------------|
| `apiTimeoutMs` | 60000 | 5000+ | Per-request timeout in milliseconds |
| `apiTimeoutRetries` | 2 | 0-5 | Max transport timeout retries |
| `apiTimeoutBackoffMs` | 500 | 100+ | Base backoff between retries |
| `apiTimeoutMaxBackoffMs` | 5000 | 1000+ | Maximum backoff cap |

Environment variables (`API_TIMEOUT_MS`, `API_TIMEOUT_RETRIES`, etc.) serve as fallbacks when config.json values are not set.
