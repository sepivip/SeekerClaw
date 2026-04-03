# Channel Abstraction Layer — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Create a `channel.js` thin router so ALL outbound communication goes through a unified interface. Fix all 15 Discord audit findings. Make adding future channels trivial.

**Architecture:** `channel.js` picks the right module (telegram/discord) at init and forwards all calls. Callers never import telegram.js or discord.js directly (except tools/telegram.js which is intentionally Telegram-specific). Each channel module exports the same interface: start, stop, sendMessage, sendTyping, sendFile, editMessage, deleteMessage, getOwnerChatId, createStatusReactionController.

**Tech Stack:** Node.js 18, Kotlin/Compose (Settings UI only)

**Spec:** `docs/superpowers/specs/2026-04-02-channel-abstraction-design.md`

---

## File Structure

### New Files

| File | Responsibility |
|------|----------------|
| `app/src/main/assets/nodejs-project/channel.js` | Thin router — picks telegram or discord, forwards all calls |

### Modified Files (JS)

| File | Changes |
|------|---------|
| `app/src/main/assets/nodejs-project/telegram.js` | Add channel interface methods: start(), stop(), sendFile(), editMessage(), getOwnerChatId(), deleteMessage(). Return { messageId } from sendMessage(). |
| `app/src/main/assets/nodejs-project/discord.js` | Add channel interface: proactive DM channel open, return { messageId }, stop() with timer cleanup, sendFile error stub, editMessage via PATCH. Fix chunking newline bug (I-7). |
| `app/src/main/assets/nodejs-project/main.js` | Replace CHANNEL conditional blocks with `channel.init()` + `channel.start()`. Migrate heartbeat to use channel.getOwnerChatId(). Remove parseInt on owner ID. |
| `app/src/main/assets/nodejs-project/ai.js` | Conditional deferStatus import. Session expiry uses channel.sendMessage. System prompt conditionals for telegram_send_file, telegram_delete. sentMessageCache recording from channel.sendMessage return. |
| `app/src/main/assets/nodejs-project/tools/index.js` | Confirmations use channel.sendMessage + channel.editMessage instead of telegram() direct. |
| `app/src/main/assets/nodejs-project/quick-actions.js` | Use channel.editMessage instead of telegramFn('editMessageReplyMarkup'). Gate quick actions on CHANNEL === 'telegram'. |

### Modified Files (Kotlin)

| File | Changes |
|------|---------|
| `app/src/main/java/com/seekerclaw/app/ui/settings/SettingsScreen.kt` | Add SectionLabel("Channel") before Telegram/Discord config entries |

---

## Task 1: Create channel.js thin router

**Files:**
- Create: `app/src/main/assets/nodejs-project/channel.js`

- [ ] **Step 1: Create channel.js**

```javascript
// channel.js — Thin router for channel abstraction
// Picks telegram or discord at init(), forwards all calls.
// Adding a new channel = implement the interface in a new file, add to init().

const { CHANNEL } = require('./config');
const { log } = require('./config');

let impl = null;

function assertInit() {
    if (!impl) throw new Error('channel.js: init() must be called before use');
}

function init() {
    if (CHANNEL === 'discord') {
        impl = require('./discord');
    } else {
        impl = require('./telegram');
    }
    log(`[Channel] Initialized: ${CHANNEL}`, 'INFO');
}

module.exports = {
    init,
    start(onMessage, onReaction) { assertInit(); return impl.start(onMessage, onReaction); },
    stop() { assertInit(); return impl.stop(); },
    sendMessage(chatId, text, replyTo) { assertInit(); return impl.sendMessage(chatId, text, replyTo); },
    sendTyping(chatId) { assertInit(); return impl.sendTyping(chatId); },
    sendFile(chatId, filePath, caption) { assertInit(); return impl.sendFile(chatId, filePath, caption); },
    editMessage(chatId, messageId, text, replyMarkup) { assertInit(); return impl.editMessage(chatId, messageId, text, replyMarkup); },
    deleteMessage(chatId, messageId) { assertInit(); return impl.deleteMessage(chatId, messageId); },
    getOwnerChatId() { assertInit(); return impl.getOwnerChatId(); },
    createStatusReactionController(chatId, messageId) {
        assertInit();
        return impl.createStatusReactionController(chatId, messageId);
    },
};
```

- [ ] **Step 2: Syntax check**

```bash
node --check app/src/main/assets/nodejs-project/channel.js
```

- [ ] **Step 3: Commit**

```bash
git add app/src/main/assets/nodejs-project/channel.js
git commit -m "feat: create channel.js thin router for channel abstraction

Co-Authored-By: Claude Opus 4.6 <noreply@anthropic.com>"
```

---

## Task 2: Add channel interface to telegram.js

**Files:**
- Modify: `app/src/main/assets/nodejs-project/telegram.js`

- [ ] **Step 1: Add start() method**

Add a `start(onMessage, onReaction)` function that wraps the existing Telegram startup sequence. This function should:
1. Call `telegram('getMe')` to get bot info
2. Flush pending updates (`getUpdates` with offset -1)
3. Register slash commands (`setMyCommands`)
4. Send "back online" notification to owner (if owner ID exists)
5. Start the poll loop
6. Return the bot info

Move the relevant startup code from main.js lines 578-661 into this function. The poll loop itself can call `onMessage(normalizedMsg)` for incoming messages and `onReaction(reactionUpdate)` for reactions.

Note: The actual poll loop code is currently in main.js. For now, `start()` can just export a flag that main.js checks, and main.js continues to own the poll loop. The key is that `channel.start()` is the entry point.

Actually — to keep this task manageable, implement `start()` as a thin wrapper that:
- Stores the callbacks
- Calls the getMe/flush/commands/notification sequence
- Kicks off polling

The poll loop stays in main.js for now but is wrapped inside `if (CHANNEL === 'telegram')` which will be removed in Task 5.

- [ ] **Step 2: Add stop() method**

```javascript
function stop() {
    // Stop polling by setting a flag
    _stopped = true;
}
```

Add `let _stopped = false;` at module scope and check it in the poll loop.

- [ ] **Step 3: Add sendFile(), editMessage(), deleteMessage(), getOwnerChatId()**

```javascript
async function sendFile(chatId, filePath, caption) {
    // Use existing telegram_send_file logic from tools/telegram.js
    // Or delegate to telegram('sendDocument', { chat_id, document, caption })
    const formData = /* multipart form with file */;
    return telegram('sendDocument', { chat_id: chatId, caption: caption || '' }, filePath);
}

async function editMessage(chatId, messageId, text, replyMarkup) {
    if (text) {
        return telegram('editMessageText', { chat_id: chatId, message_id: messageId, text, parse_mode: 'HTML' });
    }
    if (replyMarkup !== undefined) {
        return telegram('editMessageReplyMarkup', { chat_id: chatId, message_id: messageId, reply_markup: replyMarkup });
    }
}

async function deleteMessageFn(chatId, messageId) {
    return telegram('deleteMessage', { chat_id: chatId, message_id: messageId });
}

function getOwnerChatId() {
    const { getOwnerId } = require('./config');
    return getOwnerId() ? String(getOwnerId()) : null;
}
```

- [ ] **Step 4: Make sendMessage return { messageId }**

In the existing `sendMessage` function (line ~699), after the `telegram('sendMessage', ...)` call succeeds, capture the response and return `{ messageId: result.message_id }`.

Currently sendMessage chunks and sends multiple messages. Return the messageId of the LAST chunk (most recent message).

- [ ] **Step 5: Export new methods**

Add to `module.exports`:
```javascript
start, stop, sendFile, editMessage,
deleteMessage: deleteMessageFn, getOwnerChatId,
```

- [ ] **Step 6: Syntax check**

```bash
node --check app/src/main/assets/nodejs-project/telegram.js
```

- [ ] **Step 7: Commit**

```bash
git add app/src/main/assets/nodejs-project/telegram.js
git commit -m "feat: add channel interface to telegram.js — start, stop, sendFile, editMessage, getOwnerChatId

Co-Authored-By: Claude Opus 4.6 <noreply@anthropic.com>"
```

---

## Task 3: Add channel interface to discord.js + fix audit findings

**Files:**
- Modify: `app/src/main/assets/nodejs-project/discord.js`

- [ ] **Step 1: Add proactive DM channel open on startup**

In the `start()` function (line 378), after gateway connect, if `DISCORD_OWNER_ID` is set, call the Discord REST API to open a DM channel:

```javascript
// Proactively open DM channel so heartbeat/cron can send before first message
if (DISCORD_OWNER_ID) {
    try {
        const dmRes = await discordRest('POST', '/users/@me/channels', { recipient_id: DISCORD_OWNER_ID });
        if (dmRes && dmRes.id) {
            ownerDmChannelId = dmRes.id;
            log(`[Discord] Opened DM channel: ${ownerDmChannelId}`, 'INFO');
        }
    } catch (e) {
        log(`[Discord] Failed to open DM channel: ${e.message}`, 'WARN');
    }
}
```

Also cache `msg.channel_id` in `handleMessageCreate` when owner sends first message (backup).

- [ ] **Step 2: Make sendMessage return { messageId }**

In the `sendMessage` function (line 287), after the successful HTTP response, parse the response body and return `{ messageId: responseData.id }`.

For chunked messages, return the last chunk's messageId.

- [ ] **Step 3: Fix chunking newline boundary (I-7)**

At line 296-306, change:
```javascript
chunks.push(remaining.slice(0, cutoff));
remaining = remaining.slice(cutoff);
```
to:
```javascript
chunks.push(remaining.slice(0, cutoff));
remaining = remaining.slice(cutoff === 2000 ? cutoff : cutoff + 1); // Skip newline at boundary
```

- [ ] **Step 4: Add sendFile (v1 stub), editMessage, deleteMessage, getOwnerChatId**

```javascript
async function sendFile(chatId, filePath, caption) {
    log('[Discord] File sending not supported in v1', 'WARN');
    return { error: 'File sending not supported on Discord (v1)' };
}

async function editMessage(chatId, messageId, text, replyMarkup) {
    const body = {};
    if (text) body.content = text;
    // Discord doesn't use replyMarkup the same way — ignore for v1
    return discordRest('PATCH', `/channels/${chatId}/messages/${messageId}`, body);
}

async function deleteMessageFn(chatId, messageId) {
    return discordRest('DELETE', `/channels/${chatId}/messages/${messageId}`);
}

function getOwnerChatId() {
    return ownerDmChannelId;
}
```

- [ ] **Step 5: Fix stop() to clear ALL timers (S-NEW-4)**

```javascript
let _reconnectTimer = null; // Track reconnect setTimeout

function stop() {
    stopped = true;
    stopHeartbeat();
    if (_reconnectTimer) { clearTimeout(_reconnectTimer); _reconnectTimer = null; }
    if (ws) { ws.close(1000, 'Shutting down'); ws = null; }
}
```

Update `scheduleReconnect` to store the timer: `_reconnectTimer = setTimeout(...)`.

- [ ] **Step 6: Remove duplicate owner-gate from discord.js (I-NEW-2)**

In `handleMessageCreate` (line 174), remove the owner auto-detect and gate logic. Keep only the basic DM filter (`if (msg.guild_id) return`). Owner gating is handled in `message-handler.js`.

Keep the DM channel ID caching:
```javascript
if (!ownerDmChannelId && msg.channel_id) {
    ownerDmChannelId = msg.channel_id;
}
```

- [ ] **Step 7: Export new methods**

Add to `module.exports`:
```javascript
sendFile, editMessage, deleteMessage: deleteMessageFn, getOwnerChatId,
```

- [ ] **Step 8: Syntax check**

```bash
node --check app/src/main/assets/nodejs-project/discord.js
```

- [ ] **Step 9: Commit**

```bash
git add app/src/main/assets/nodejs-project/discord.js
git commit -m "feat: add channel interface to discord.js + fix audit findings

- Proactive DM channel open on startup (C-4)
- sendMessage returns { messageId } (I-NEW-5)
- Fix chunking newline boundary (I-7)
- stop() clears all timers (S-NEW-4)
- Remove duplicate owner-gate (I-NEW-2)
- sendFile v1 stub, editMessage, deleteMessage, getOwnerChatId

Co-Authored-By: Claude Opus 4.6 <noreply@anthropic.com>"
```

---

## Task 4: Migrate main.js to use channel.js

**Files:**
- Modify: `app/src/main/assets/nodejs-project/main.js`

- [ ] **Step 1: Replace CHANNEL conditional imports (lines 109-137) with channel.js**

Replace the entire `if (CHANNEL === 'telegram') { ... } else if (CHANNEL === 'discord') { ... }` block with:

```javascript
// ============================================================================
// CHANNEL (abstraction layer — routes to telegram or discord)
// ============================================================================

const channel = require('./channel');
channel.init();

// Channel-specific imports still needed for message normalization
const { CHANNEL } = require('./config');
const telegramModule = CHANNEL === 'telegram' ? require('./telegram') : null;
const { extractMedia, downloadTelegramFile, MAX_FILE_SIZE, MAX_IMAGE_SIZE } = telegramModule || {};
const discordModule = CHANNEL === 'discord' ? require('./discord') : null;
```

Wire cron with channel.sendMessage:
```javascript
setSendMessage((chatId, text) => channel.sendMessage(chatId, text));
```

- [ ] **Step 2: Wire initMessageHandler with channel methods**

Update the `initMessageHandler` call to pass channel methods instead of direct imports:

```javascript
initMessageHandler({
    // ... existing deps ...
    sendMessage: (chatId, text, replyTo) => channel.sendMessage(chatId, text, replyTo),
    sendTyping: (chatId) => channel.sendTyping(chatId),
    createStatusReactionController: (chatId, messageId) => channel.createStatusReactionController(chatId, messageId),
    // ... rest of deps ...
});
```

- [ ] **Step 3: Fix heartbeat probe — no parseInt, use channel.getOwnerChatId()**

In `runHeartbeat()` (line ~943), replace:
```javascript
const ownerChatId = parseInt(ownerIdStr, 10);
if (isNaN(ownerChatId)) return;
```
with:
```javascript
const ownerChatId = channel.getOwnerChatId();
if (!ownerChatId) return;
```

And update `sendMessage(ownerChatId, cleaned)` to `channel.sendMessage(ownerChatId, cleaned)`.

Update `addToConversation(ownerChatId, ...)` — this already works with string keys.

- [ ] **Step 4: Move "back online" into startup or channel.start()**

Remove the "back online" notification from main.js — it's now part of `channel.start()`.

- [ ] **Step 5: Simplify startup sequence**

Replace the large `telegram('getMe', ...)` callback with:
```javascript
channel.start(enqueueMessage, handleReactionUpdate);
```

Note: The poll loop, autoResumeOnStartup, and timer setup remain in main.js — they're not channel-specific.

- [ ] **Step 6: Add graceful shutdown**

In the SIGTERM/SIGINT handler, call `channel.stop()`:
```javascript
process.on('SIGTERM', async () => {
    channel.stop();
    // ... existing shutdown logic ...
});
```

- [ ] **Step 7: Syntax check**

```bash
node --check app/src/main/assets/nodejs-project/main.js
```

- [ ] **Step 8: Commit**

```bash
git add app/src/main/assets/nodejs-project/main.js
git commit -m "refactor: migrate main.js to channel.js — remove CHANNEL conditionals

- channel.init() + channel.start() replaces if/else blocks
- Heartbeat uses channel.getOwnerChatId() (fixes C-1, I-NEW-1)
- Cron wired to channel.sendMessage (fixes C-NEW-2, I-6)
- Graceful shutdown calls channel.stop()
- Back-online moved into channel.start()

Co-Authored-By: Claude Opus 4.6 <noreply@anthropic.com>"
```

---

## Task 5: Migrate ai.js — conditional deferStatus, session expiry, system prompt

**Files:**
- Modify: `app/src/main/assets/nodejs-project/ai.js`

- [ ] **Step 1: Conditional deferStatus import (C-NEW-1)**

At line 23, replace:
```javascript
const { telegram, sendTyping, sentMessageCache, SENT_CACHE_TTL, deferStatus } = require('./telegram');
```
with:
```javascript
const { CHANNEL } = require('./config');
const channel = require('./channel');
const { sentMessageCache, SENT_CACHE_TTL } = require('./telegram');
const deferStatus = CHANNEL === 'telegram' ? require('./telegram').deferStatus : () => ({ cleanup: async () => {} });
const _channelSendTyping = (chatId) => channel.sendTyping(chatId);
```

Note: `sentMessageCache` and `SENT_CACHE_TTL` stay imported from telegram.js — they're the data store, used by ai.js regardless of channel. Both channels feed into it.

- [ ] **Step 2: Fix session expiry notification (C-3)**

Find the `telegram('sendMessage', { chat_id: Number(ownerId), ... })` call for session expiry and replace with:
```javascript
channel.sendMessage(channel.getOwnerChatId(), '⚠️ Your session has expired. Please re-pair your device to continue.')
    .catch(e => log(`[Session] Failed to notify owner: ${e.message}`, 'WARN'));
```

- [ ] **Step 3: Make system prompt channel-aware for tools (I-3, I-4)**

Find lines referencing `telegram_send_file` and `telegram_delete` in the system prompt builder. Wrap them with CHANNEL checks:

```javascript
if (CHANNEL === 'telegram') {
    lines.push('**Screenshots:** Use `screencap -p screenshot.png` via shell_exec, then telegram_send_file to send it.');
    lines.push('**File sending (outbound):** Use telegram_send_file to send any workspace file...');
}
```

For the `telegram_delete` reference:
```javascript
if (CHANNEL === 'telegram') {
    dynamicLines.push(`Recent Sent Messages (use message_id with telegram_delete, never guess):`);
} else {
    dynamicLines.push(`Recent Sent Messages:`);
}
```

- [ ] **Step 4: Feed sentMessageCache from channel.sendMessage return value**

After any `channel.sendMessage()` call in ai.js that should be cached, record the sent message:
```javascript
const result = await channel.sendMessage(chatId, text);
if (result && result.messageId) {
    recordSentMessage(chatId, result.messageId, text);
}
```

- [ ] **Step 5: Syntax check**

```bash
node --check app/src/main/assets/nodejs-project/ai.js
```

- [ ] **Step 6: Commit**

```bash
git add app/src/main/assets/nodejs-project/ai.js
git commit -m "refactor: migrate ai.js to channel abstraction

- deferStatus conditional: real on Telegram, no-op on Discord (C-NEW-1)
- Session expiry uses channel.sendMessage (C-3)
- System prompt omits telegram_send_file/telegram_delete on Discord (I-3, I-4)
- sentMessageCache fed by channel.sendMessage return value

Co-Authored-By: Claude Opus 4.6 <noreply@anthropic.com>"
```

---

## Task 6: Migrate tools/index.js — confirmations via channel

**Files:**
- Modify: `app/src/main/assets/nodejs-project/tools/index.js`

- [ ] **Step 1: Replace _telegramSendMessage with channel imports**

At lines 7-12, replace:
```javascript
const _telegramSendMessage = CHANNEL === 'telegram'
    ? require('../telegram').telegram
    : (method, params) => { ... };
```
with:
```javascript
const channel = require('../channel');
```

- [ ] **Step 2: Update requestConfirmation to use channel.sendMessage**

In `requestConfirmation()` at line 152, replace:
```javascript
_telegramSendMessage('sendMessage', { chat_id: chatId, text: msg, parse_mode: 'HTML', ... })
```
with:
```javascript
channel.sendMessage(chatId, msg)
```

Note: The confirmation message currently uses HTML formatting. For Discord compatibility, convert to plain text (Discord auto-renders markdown). The confirmation is a simple text with bold tool name and parameters — use `**bold**` instead of `<b>bold</b>`.

- [ ] **Step 3: Update confirmation cleanup to use channel.editMessage/deleteMessage**

If the confirmation message is edited (e.g., after timeout to show "Expired"), use `channel.editMessage()`. If deleted, use `channel.deleteMessage()`.

- [ ] **Step 4: Syntax check**

```bash
node --check app/src/main/assets/nodejs-project/tools/index.js
```

- [ ] **Step 5: Commit**

```bash
git add app/src/main/assets/nodejs-project/tools/index.js
git commit -m "refactor: confirmations use channel.sendMessage (C-2)

Replace direct telegram() call with channel.sendMessage().
Confirmation formatting changed from HTML to plain text for
cross-channel compatibility.

Co-Authored-By: Claude Opus 4.6 <noreply@anthropic.com>"
```

---

## Task 7: Gate quick-actions on Telegram

**Files:**
- Modify: `app/src/main/assets/nodejs-project/quick-actions.js`

- [ ] **Step 1: Add CHANNEL check**

At the top of the file, add:
```javascript
const { CHANNEL } = require('./config');
```

In `handleQuickCommand`, return early if not Telegram:
```javascript
async function handleQuickCommand(chatId, telegramFn) {
    if (CHANNEL !== 'telegram') {
        return null; // Quick actions not supported on Discord v1
    }
    // ... existing logic ...
}
```

Same for `handleQuickCallback`:
```javascript
async function handleQuickCallback(cb, telegramFn) {
    if (CHANNEL !== 'telegram') return;
    // ... existing logic ...
}
```

- [ ] **Step 2: Syntax check**

```bash
node --check app/src/main/assets/nodejs-project/quick-actions.js
```

- [ ] **Step 3: Commit**

```bash
git add app/src/main/assets/nodejs-project/quick-actions.js
git commit -m "feat: gate quick-actions on Telegram — disabled on Discord v1

Co-Authored-By: Claude Opus 4.6 <noreply@anthropic.com>"
```

---

## Task 8: Settings UI — Channel section grouping

**Files:**
- Modify: `app/src/main/java/com/seekerclaw/app/ui/settings/SettingsScreen.kt`

- [ ] **Step 1: Add SectionLabel("Channel") before Telegram config**

At line ~450 (before the Telegram ConfigField), add:

```kotlin
SectionLabel("Channel")
```

This groups Telegram + Discord under a "Channel" header, matching the "AI Configuration" pattern above.

- [ ] **Step 2: Compile check**

```bash
./gradlew compileDappStoreDebugKotlin 2>&1 | tail -5
```

- [ ] **Step 3: Commit**

```bash
git add app/src/main/java/com/seekerclaw/app/ui/settings/SettingsScreen.kt
git commit -m "fix: group Telegram + Discord under 'Channel' section in Settings

Co-Authored-By: Claude Opus 4.6 <noreply@anthropic.com>"
```

---

## Task 9: Full smoke test

**Files:** None (verification only)

- [ ] **Step 1: Syntax check all JS files**

```bash
find app/src/main/assets/nodejs-project -name "*.js" -not -name "*.min.js" -not -name "sql-wasm.js" -not -path "*/node_modules/*" | xargs -I{} node --check "{}"
```

- [ ] **Step 2: Kotlin compile check**

```bash
./gradlew compileDappStoreDebugKotlin 2>&1 | tail -10
```

- [ ] **Step 3: Verify no direct telegram() imports outside telegram.js and tools/telegram.js**

```bash
grep -rn "require.*['\"].*telegram['\"]" app/src/main/assets/nodejs-project/ --include="*.js" | grep -v "node_modules" | grep -v "telegram.js:" | grep -v "tools/telegram" | grep -v "channel.js"
```

Expected: Only `main.js` importing telegramModule conditionally for media normalization, and any test files. No direct telegram imports from ai.js, cron.js, or tools/index.js.

- [ ] **Step 4: Verify channel.js interface completeness**

```bash
node -e "
const ch = require('./app/src/main/assets/nodejs-project/channel');
const methods = ['init','start','stop','sendMessage','sendTyping','sendFile','editMessage','deleteMessage','getOwnerChatId','createStatusReactionController'];
const exports = Object.keys(ch);
console.log('Exports:', exports);
const missing = methods.filter(m => !exports.includes(m));
if (missing.length) { console.log('MISSING:', missing); process.exit(1); }
console.log('ALL METHODS PRESENT');
"
```

- [ ] **Step 5: Commit if fixes needed**

```bash
git add -A
git commit -m "fix: address smoke test findings

Co-Authored-By: Claude Opus 4.6 <noreply@anthropic.com>"
```
