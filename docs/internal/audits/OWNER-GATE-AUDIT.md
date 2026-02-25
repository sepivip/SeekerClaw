# Owner Gate Security Audit — SeekerClaw

**Date:** 2026-02-20
**Scope:** All inbound Telegram update paths → AI/tool execution gate
**Method:** Static code analysis (no code changes)

---

## Executive Summary

The owner gate is **correctly implemented** across all primary message paths. The owner check fires **before** any AI call, Claude API call, or tool execution. Two conditional findings require documentation; one architectural dependency requires attention.

**Overall verdict: PASS with two conditional findings.**

---

## Audit Checklist

| # | Path | File | Lines | Status |
|---|------|------|-------|--------|
| 1 | Text messages | main.js | 286, 329 | ✅ PASS |
| 2 | Photo / video / document / audio / voice / video_note | main.js | 286, 329 | ✅ PASS |
| 3 | Stickers & other message types | main.js | 286, 329 | ✅ PASS |
| 4 | Reply messages | main.js | 286, 329 | ✅ PASS |
| 5 | Forwarded messages | main.js | 286, 329 | ✅ PASS |
| 6 | Callback queries (inline buttons) | main.js | 614, 622 | ✅ PASS |
| 7 | Message reactions | main.js | 501, 512 | ⚠️ CONDITIONAL |
| 8 | Cron / scheduled reminders | cron.js | 497, 511 | ✅ PASS |
| 9 | Skill auto-install via attachment | main.js | 423 | ✅ PASS |
| 10 | Owner not yet set (first-run auto-detect) | main.js | 316 | ⚠️ CONDITIONAL |
| 11 | Owner set — non-owner message | main.js | 329 | ✅ PASS |
| 12 | Sensitive data in logs | security.js | 14–29, 38 | ✅ PASS |

---

## Path-by-Path Findings

### 1–5 · Text / Media / Reply / Forwarded Messages

**File:** [main.js](app/src/main/assets/nodejs-project/main.js)

All inbound messages (text, photos, documents, audio, voice, video notes, stickers, replies, forwarded) are handled by a single entry function `handleMessage()` at **line 286**. The owner check is applied at **lines 329–332**, unconditionally, before any branch that could call `chat()` or execute a tool:

```
enqueueMessage(msg)
  → handleMessage(msg)           [line 286]
      → senderId extracted        [line 295]
      → auto-detect if !OWNER_ID  [lines 317–326]  ← see Finding 10
      → if (senderId !== OWNER_ID) return           [line 329]  ← GATE
      → chat(chatId, userContent) [line 341+]       ← AI execution
```

No message type bypasses this path. `extractMedia()` is called inside `handleMessage()` **after** the owner gate, so media processing cannot happen without owner validation.

**Result: PASS**

---

### 6 · Callback Queries (Inline Keyboard Buttons)

**File:** [main.js](app/src/main/assets/nodejs-project/main.js) — lines 614–636

Callback queries are handled in the `poll()` loop, separate from `handleMessage()`. Owner check at **line 622**:

```javascript
const cbSenderId = String(cb.from?.id);
if (!OWNER_ID || cbSenderId !== OWNER_ID) {
    log(`[Callback] Ignoring callback from ${cbSenderId} (not owner)`, 'WARN');
} else {
    // enqueue as synthetic message → goes through handleMessage() → re-validated
    enqueueMessage(syntheticMsg);
}
```

- Blocks if `OWNER_ID` is not yet set (harder constraint than the message handler).
- Non-owner callbacks are silently dropped with a WARN log — no `answerCallbackQuery` rejection text is sent (spinner dismisses by timeout), which is fine.
- Callback enqueued as synthetic message → goes through full `handleMessage()` flow including the second owner check at line 329.

**Result: PASS**

---

### 7 · Message Reactions

**File:** [main.js](app/src/main/assets/nodejs-project/main.js) — line 501
**File:** [config.js](app/src/main/assets/nodejs-project/config.js) — line 113

Owner check at **line 512** is **conditional on `REACTION_NOTIFICATIONS` setting**:

```javascript
if (REACTION_NOTIFICATIONS === 'own' && (!OWNER_ID || userId !== OWNER_ID)) return;
```

| Mode | Behavior |
|------|----------|
| `'own'` (default) | Reactions from non-owners are dropped. PASS. |
| `'all'` | Reactions from any user reach the agent as informational events. |

**With `'all'` mode:** A non-owner emoji reaction is surfaced to the agent as an event. However, this does **not** trigger a Claude API call or tool execution by itself — reactions are informational annotations on existing conversations, not executable commands. The agent would only act on them if it was already in an owner-initiated conversation turn.

**Risk level: Low.** Non-owners cannot use reactions to execute tools or start new AI conversations.

**Result: CONDITIONAL PASS** (default config is secure; `'all'` mode is low-risk but undocumented)

---

### 8 · Cron / Scheduled Jobs

**File:** [cron.js](app/src/main/assets/nodejs-project/cron.js) — lines 497–519

Cron jobs are created exclusively by the AI agent via the `cron_create` tool — which can only be called after the owner gate in `handleMessage()`. Delivery at **line 511**:

```javascript
const ownerId = getOwnerId();
await _sendMessage(ownerId, message);
```

- Jobs always deliver to `ownerId`, never to arbitrary user IDs.
- No mechanism for non-owner to inject cron jobs (requires tool call → requires owner message → requires owner gate pass).

**Result: PASS**

---

### 9 · Skill Auto-Install via Attachment

**File:** [main.js](app/src/main/assets/nodejs-project/main.js) — line 423

Skill installation from a `.md` file attachment is triggered inside `handleMessage()` at line 423 — after the owner gate at line 329. No separate handler; fully protected.

**Result: PASS**

---

### 10 · First-Run: Owner Not Yet Set (Auto-Detect)

**File:** [main.js](app/src/main/assets/nodejs-project/main.js) — lines 316–326

When `OWNER_ID` is falsy, the **first person to send a message becomes the owner**:

```javascript
if (!OWNER_ID) {
    OWNER_ID = senderId;
    setOwnerId(senderId);
    log(`Owner claimed by ${senderId} (auto-detect)`, 'INFO');
    androidBridgeCall('/config/save-owner', { ownerId: senderId }).catch(() => {});
    await sendMessage(chatId, `Owner set to your account (${senderId}). Only you can use this bot.`);
}
```

**Vulnerability window:** Between service start and first owner message, any Telegram user who discovers the bot and sends first gets owner privileges. This is a **race condition**, not a runtime bypass.

**Existing mitigation:** The Setup screen (`SetupScreen.kt`) captures `telegramOwnerId` during onboarding and passes it to `ConfigManager`, which writes it to Android Keystore-backed encrypted storage before the service starts. The service reads it via `config.js` → `OWNER_ID` is already set before polling begins.

**Residual risk:** If the app is misconfigured (owner ID field left blank in setup), the race window opens. There is no enforcement that blocks service start when `OWNER_ID` is empty.

**Result: CONDITIONAL PASS** — secure in the happy path; service-start enforcement is an architectural dependency, not a code-level bypass.

---

### 11 · Non-Owner Message After Owner Set

**File:** [main.js](app/src/main/assets/nodejs-project/main.js) — lines 329–332

```javascript
if (senderId !== OWNER_ID) {
    log(`Ignoring message from ${senderId} (not owner)`, 'WARN');
    return;
}
```

- Returns immediately; no Claude call, no tool call, no file write.
- No response is sent to the non-owner (silent ignore, correct behavior — avoids confirming bot existence).
- Sender ID is logged at WARN level for operator awareness.

**Result: PASS**

---

### 12 · Log Redaction (Secret Leakage)

**File:** [security.js](app/src/main/assets/nodejs-project/security.js) — lines 14–29
**File:** [main.js](app/src/main/assets/nodejs-project/main.js) — line 38

Secret redaction is applied globally via `setRedactFn()` before any log output. Patterns covered:

| Pattern | Redacted To |
|---------|-------------|
| `sk-ant-...` | `sk-ant-***` |
| Bot token (`digits:alphanum`) | `***:***` |
| `BSA...` (Brave) | `BSA***` |
| `pplx-...` (Perplexity) | `pplx-***` |
| `sk-or-...` (OpenRouter) | `sk-or-***` |
| Bridge token (UUID) | `***bridge-token***` |

**Owner ID is logged in plain text** (e.g., `Owner claimed by 987654321`). This is acceptable — Telegram user IDs are not secret and are needed for operational debugging.

**Result: PASS**

---

## Execution Flow Diagram (Critical Path)

```
Telegram update
    │
    ├─ message ──────────────────────────────────┐
    │                                            ▼
    │                                   handleMessage() [main.js:286]
    │                                       │
    │                                       ├─ if !OWNER_ID → auto-detect [line 317]
    │                                       │
    │                                       ├─ if senderId ≠ OWNER_ID → return [line 329]  ← GATE
    │                                       │
    │                                       └─ chat() → Claude API → tools [line 341+]
    │
    ├─ callback_query ────────────────────────────┐
    │                                            ▼
    │                                   poll() handler [main.js:614]
    │                                       │
    │                                       ├─ if !OWNER_ID || cbSender ≠ OWNER_ID → drop [line 622]  ← GATE
    │                                       │
    │                                       └─ enqueueMessage() → handleMessage() [re-validated]
    │
    ├─ message_reaction_count ───────────────────┐
    │                                           ▼
    │                                  handleReactionUpdate() [main.js:501]
    │                                       │
    │                                       └─ if 'own' mode && ≠ OWNER_ID → return [line 512]  ← CONDITIONAL GATE
    │
    └─ (all other update types) ─────────────────── unhandled / silently ignored
```

---

## Fix List

### FIX-1 (Medium Priority) — Block service start if owner ID is empty

**Path:** Android → `OpenClawService.kt` / `NodeBridge.kt`
**Issue:** If Setup screen is skipped or owner ID is cleared, the service starts with no owner set, opening the auto-detect race window.
**Fix:** In service `onStartCommand()`, read owner ID from `ConfigManager`. If empty, log an error and do NOT start Node.js. Post a notification: "Setup incomplete — open SeekerClaw to configure."

### FIX-2 (Low Priority) — Document `REACTION_NOTIFICATIONS = 'all'` security implication

**Path:** [config.js](app/src/main/assets/nodejs-project/config.js) — line 113
**Issue:** No comment warns that `'all'` mode surfaces non-owner reactions to the agent.
**Fix:** Add inline comment:

```javascript
// 'own' = only owner reactions (recommended); 'all' = any user (low risk — informational only)
const REACTION_NOTIFICATIONS = 'own';
```

### FIX-3 (Low Priority) — Confirm auto-detect window in startup log

**Path:** [main.js](app/src/main/assets/nodejs-project/main.js) — config.js:147
**Issue:** If `OWNER_ID` is empty at startup, a DEBUG log is emitted but it doesn't clearly flag the security implication.
**Fix:** Upgrade log level from `DEBUG` to `WARN`:

```javascript
if (!OWNER_ID) {
    log('WARNING: Owner ID not set — first message will claim ownership. Configure via Setup screen.', 'WARN');
}
```

---

## Non-Issues (Confirmed Safe)

- **Group chats:** `senderId` check uses `msg.from.id`, not `msg.chat.id`. If the bot is added to a group, non-owner members still fail the check. Bot should only respond in private chats with the owner.
- **Forwarded messages:** `msg.from.id` is the forwarder's ID, not the original sender. Forwarded messages from non-owners are blocked. Owner-forwarded messages pass (owner is responsible for what they forward).
- **Channel posts:** `msg.from` is null for channel posts → `senderId` would be `"null"` which never equals `OWNER_ID`. Safe.
- **Bot-to-bot:** Same check applies; other bots cannot claim ownership.
- **MCP tool results:** MCP tools execute inside the Node.js process after owner validation; they cannot inject unsolicited messages back through the owner gate.

---

*Audit completed. No code changes made. See fix list above for recommended hardening.*
