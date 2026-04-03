# Channel Abstraction Layer — Design Spec

**Date:** 2026-04-02
**Status:** Approved (v2 — post quality review)
**Context:** Discord PR #310 audit found 15 issues where peripheral systems (cron, heartbeat, confirmations, deferStatus) bypass the channel abstraction and call Telegram directly. This spec completes the abstraction so all outbound communication goes through a unified interface.

---

## Goal

Create a `channel.js` module that ALL outbound message sending goes through. Adding a new channel (WhatsApp, Slack, etc.) means implementing the interface — zero changes to cron, heartbeat, confirmations, or any other caller.

## Constraints

- Fix all 15 audit findings from PR #310 review
- Zero Telegram regression (5,300+ users)
- Thin router pattern — `channel.js` picks the right module, no shared logic
- Settings UI: group Telegram + Discord under "Channel" section header

## Architecture

### channel.js (thin router)

```javascript
const CHANNEL = require('./config').CHANNEL;

let impl = null;

function init() {
    impl = CHANNEL === 'discord' ? require('./discord') : require('./telegram');
}

module.exports = {
    init,
    start(onMessage, onReaction) { return impl.start(onMessage, onReaction); },
    stop() { return impl.stop(); },
    sendMessage(chatId, text, replyTo) { return impl.sendMessage(chatId, text, replyTo); },
    sendTyping(chatId) { return impl.sendTyping(chatId); },
    sendFile(chatId, filePath, caption) { return impl.sendFile(chatId, filePath, caption); },
    editMessage(chatId, messageId, text, replyMarkup) { return impl.editMessage(chatId, messageId, text, replyMarkup); },
    getOwnerChatId() { return impl.getOwnerChatId(); },
    deleteMessage(chatId, messageId) { return impl.deleteMessage(chatId, messageId); },
    createStatusReactionController(chatId, messageId) {
        return impl.createStatusReactionController(chatId, messageId);
    },
};
```

**Init ordering:** `channel.init()` must be called before any method. Called at top of main.js startup sequence, before cron/heartbeat/tools wire up.

**Lazy safety:** Methods throw `Error('channel not initialized')` if called before init().

### Return contract for sendMessage

```javascript
// Returns: { messageId: string|number } on success
// Throws or returns { error: string } on failure
// Callers that chain .catch() continue to work
```

Both `telegram.js` and `discord.js` return `{ messageId }` from sendMessage. This feeds the `sentMessageCache` in ai.js for "Recent Sent Messages" in the system prompt.

### Owner ID vs Owner Chat ID

| Concept | Purpose | Telegram | Discord |
|---------|---------|----------|---------|
| Owner ID | Who the owner IS (identity) | Numeric user ID | Snowflake user ID |
| Owner Chat ID | Where to SEND messages | Same as owner ID | DM channel ID (different from user ID) |

- `getOwnerId()` stays in `config.js` — identity, used for auth gates
- `getOwnerChatId()` lives on the channel module — delivery address
- Telegram: `getOwnerChatId()` returns `getOwnerId()` (they're the same)
- Discord: `getOwnerChatId()` returns cached DM channel ID

**Discord DM channel caching:**
- On startup (if DISCORD_OWNER_ID is set): proactively call `POST /users/@me/channels` with `recipient_id` to get the DM channel ID. This ensures heartbeat/cron work immediately after restart without waiting for first message.
- On first `MESSAGE_CREATE`: cache `msg.channel_id` as the DM channel ID (backup, handles auto-detect case).
- `getOwnerChatId()` returns `null` only if owner ID is unknown (fresh install, never messaged). Heartbeat/cron gracefully skip when null.

**chatQueues key alignment:** On Discord, chatQueues key = DM channel ID (string), same as conversation key. Both come from `channel.getOwnerChatId()`. No parseInt anywhere in the heartbeat/cron path.

### telegram.js channel interface

Export channel interface methods alongside existing exports:

```javascript
module.exports = {
    // Existing exports (unchanged — used by tools/telegram.js directly)
    telegram, sendMessage, sendTyping, downloadTelegramFile,
    extractMedia, createStatusReactionController,
    MAX_FILE_SIZE, MAX_IMAGE_SIZE,
    deferStatus, sentMessageCache, SENT_CACHE_TTL,
    
    // Channel interface methods
    start(onMessage, onReaction) { /* wraps poll loop + getMe + flush + commands + "back online" */ },
    stop() { /* clean shutdown, stop polling */ },
    sendFile(chatId, filePath, caption) { /* existing telegram_send_file logic */ },
    editMessage(chatId, messageId, text, replyMarkup) { /* telegram('editMessageText'/'editMessageReplyMarkup') */ },
    getOwnerChatId() { return String(getOwnerId()); },
    deleteMessage(chatId, messageId) { /* telegram('deleteMessage') */ },
};
```

**start() complexity:** Wraps the entire Telegram startup: `telegram('getMe')`, update flushing, command registration, "back online" message, then kicks off `poll()`. This is ~30 lines of wiring, not trivial but well-bounded. The poll loop itself stays in telegram.js (already there in the Discord PR).

### discord.js channel interface

```javascript
let ownerDmChannelId = null;

module.exports = {
    start(onMessage, onReaction) { /* gateway connect + proactive DM channel open */ },
    stop() { /* close WebSocket + clear ALL timers (heartbeat, reconnect) */ },
    sendMessage(chatId, text, replyTo) { /* REST send, returns { messageId } */ },
    sendTyping(chatId) { /* POST /channels/{id}/typing */ },
    sendFile(chatId, filePath, caption) { return { error: 'File sending not supported on Discord (v1)' }; },
    editMessage(chatId, messageId, text, replyMarkup) { /* PATCH /channels/{id}/messages/{id} */ },
    getOwnerChatId() { return ownerDmChannelId; },
    deleteMessage(chatId, messageId) { /* DELETE /channels/{id}/messages/{id} */ },
    createStatusReactionController() {
        return { setQueued: () => {}, setThinking: () => {}, setDone: async () => {}, setError: async () => {}, clear: async () => {} };
    },
};
```

**stop() cleanup:** Clears heartbeat interval, reconnect setTimeout, closes WebSocket. Follows CLAUDE.md "Timer Cleanup" pattern.

## Callers to Migrate

| System | File | Current (broken on Discord) | After |
|--------|------|---------------------------|-------|
| Heartbeat alert | main.js | `sendMessage(ownerChatId)` with `parseInt` | `channel.sendMessage(channel.getOwnerChatId())` |
| Cron delivery | cron.js | `_sendMessage(ownerId)` | `setSendMessage(channel.sendMessage)` — already uses setter, just wire to channel |
| Confirmations | tools/index.js | `telegram()` direct call | `channel.sendMessage()` + `channel.editMessage()` |
| deferStatus | ai.js | `telegram()` via import | Conditional import: Telegram gets real deferStatus, Discord gets no-op (typing only) |
| Session expiry | ai.js | `telegram('sendMessage')` direct | `channel.sendMessage(channel.getOwnerChatId())` |
| "Back online" | main.js | `sendMessage(ownerId)` | Moved into `channel.start()` — each channel handles its own startup notification |
| Auto-resume | main.js | `sendMessage(chatId)` | `channel.sendMessage(chatId)` — already correct shape |
| Sent message cache | ai.js | `recordSentMessage` after `telegram()` | Both channel sendMessage implementations return `{ messageId }`, caller records it |
| Quick actions | quick-actions.js | `telegramFn('editMessageReplyMarkup')` | `channel.editMessage()` on Telegram; disabled on Discord v1 |

## Dependency Graph (verified — no circular deps)

```
channel.js → telegram.js or discord.js (conditional require)
main.js → channel.js, message-handler.js, ai.js, cron.js, tools/
ai.js → channel.js (for session expiry), config.js, providers/
cron.js → channel.js (via setSendMessage setter)
tools/index.js → channel.js (for confirmations)
tools/telegram.js → telegram.js (direct — Telegram-specific tools, only loaded when CHANNEL=telegram)
telegram.js → config.js, http.js, security.js
discord.js → config.js, http.js, bridge.js, security.js
```

No circular dependencies. `telegram.js` and `discord.js` do NOT import channel.js, ai.js, cron.js, or tools/.

## Decisions on Review Findings

### tools/telegram.js stays Telegram-specific
`telegram_send`, `telegram_send_file`, `telegram_delete`, `telegram_react` remain Telegram-only tools. They import directly from `../telegram` (not channel.js). They're already conditionally loaded (`CHANNEL === 'telegram'` gate in tools/index.js). Discord equivalents are a future enhancement, not v1.

### deferStatus stays in telegram.js
`deferStatus` sends visible status messages ("Searching...", "Fetching...") — a Telegram UX pattern. Discord uses typing indicator instead. `ai.js` conditionally imports: `const deferStatus = CHANNEL === 'telegram' ? require('./telegram').deferStatus : () => {};`

### Quick Actions disabled on Discord v1
Telegram inline keyboards have no direct Discord equivalent (Discord uses components — different API). Quick actions tools not loaded on Discord. System prompt omits quick action references when CHANNEL !== 'telegram'.

### sendFile returns error on Discord v1
Discord supports multipart file upload, but implementing it is deferred. `discord.js` returns `{ error: 'File sending not supported on Discord (v1)' }`. Agent gets a clear error message, not a silent failure.

### Confirmation formatting is channel-aware
`requestConfirmation()` in tools/index.js currently uses HTML (`<b>`, `<code>`). The message text should be plain text. The channel module wraps it: Telegram adds `parse_mode: 'HTML'`, Discord sends as-is (Discord auto-renders markdown).

### sentMessageCache location
`sentMessageCache` stays in ai.js (it's the consumer). Both channel implementations return `{ messageId }` from sendMessage. `ai.js` records the message ID into the cache after calling `channel.sendMessage()`.

## Settings UI

Group Telegram and Discord under a "Channel" section in Settings:

```
Channel
┌──────────────────────────────┐
│ Telegram    ⓘ         Edit  │
│ Bot Token, Owner ID          │
├──────────────────────────────┤
│ Discord     ⓘ         Edit  │
│ Not configured               │
└──────────────────────────────┘
```

Uses existing `SectionLabel("Channel")` shared component.

## main.js simplification

Before (scattered channel logic):
```javascript
if (CHANNEL === 'telegram') {
    // 50 lines of Telegram setup
} else if (CHANNEL === 'discord') {
    // 50 lines of Discord setup  
}
```

After:
```javascript
const channel = require('./channel');
channel.init();
channel.start(enqueueMessage, handleReactionUpdate);
```

## Graceful Shutdown

`channel.stop()` is called during graceful shutdown (wired via `setShutdownDeps` in database.js or directly in the SIGTERM/SIGINT handler). Telegram: stops polling. Discord: closes WebSocket + clears all timers.

## What Does NOT Change

- `message-handler.js` — already uses normalized message shape
- `config.js` — CHANNEL, tokens, owner ID stay as-is
- `tools/telegram.js` — stays Telegram-specific, imports `../telegram` directly
- Android Kotlin — ConfigManager, NavGraph, DiscordConfigScreen (except Settings grouping)

## v1 Known Limitations (Discord)

These are documented, not bugs:
1. No file sending (returns explicit error)
2. No quick actions (inline keyboards are Telegram-specific)
3. No deferStatus visible messages (uses typing indicator instead)
4. No message reactions (Discord MESSAGE_REACTION_ADD not handled)
5. `telegram_*` tools not available (by design — channel-conditional loading)

## Audit Fixes Addressed (15/15)

| ID | Issue | Fix |
|----|-------|-----|
| C-1 | parseInt on Discord snowflake | `getOwnerChatId()` returns string, no parseInt |
| C-2 | Confirmation silently denies | Confirmations use `channel.sendMessage()` + `channel.editMessage()` |
| C-3 | Session expiry hardcoded telegram() | Uses `channel.sendMessage(channel.getOwnerChatId())` |
| C-NEW-1 | deferStatus fires Telegram API on Discord | Conditional import: no-op on Discord |
| C-NEW-2 | Cron sends to user ID not channel ID | Cron wired to `channel.sendMessage`; Discord `getOwnerChatId()` returns DM channel ID |
| I-1 | No "back online" on Discord | Moved into `channel.start()` — proactive DM channel open |
| I-2 | Auto-resume mangled ID | String IDs throughout, no parseInt |
| I-3 | System prompt references telegram_send_file | Conditional in ai.js based on CHANNEL |
| I-4 | telegram_delete referenced on Discord | Conditional in ai.js |
| I-5 | Duplicate createStatusReactionController | Single source: `channel.createStatusReactionController()` |
| I-6 | Cron delivery needs DM channel ID | `channel.getOwnerChatId()` returns correct DM channel ID |
| I-7 | Chunking newline boundary | Fix `slice(cutoff)` → `slice(cutoff + 1)` in discord.js |
| I-NEW-1 | Heartbeat non-functional | Uses `channel.getOwnerChatId()` + string queue key |
| I-NEW-2 | Duplicate owner-gate | Remove from discord.js, keep in message-handler.js only |
| I-NEW-5 | Discord sendMessage returns no ID | Return `{ messageId }` from REST response |

## Acceptance Criteria

- [ ] `channel.js` created with thin router pattern (10 methods)
- [ ] `telegram.js` exports channel interface methods (start, stop, sendFile, editMessage, getOwnerChatId, deleteMessage)
- [ ] `discord.js` exports channel interface methods + proactive DM channel open on startup
- [ ] ALL 15 audit findings fixed
- [ ] No direct `telegram()` calls outside telegram.js and tools/telegram.js
- [ ] `main.js` uses `channel.start()` — no `if (CHANNEL)` blocks for startup
- [ ] Heartbeat, cron, confirmations work on Discord
- [ ] deferStatus conditional (real on Telegram, no-op on Discord)
- [ ] Quick actions conditional (active on Telegram, disabled on Discord)
- [ ] System prompt omits Telegram-specific tool references on Discord
- [ ] sentMessageCache fed by both channels
- [ ] Graceful shutdown calls `channel.stop()`
- [ ] Settings UI groups Telegram + Discord under "Channel" header
- [ ] `./gradlew compileDappStoreDebugKotlin` passes
- [ ] Device test: Telegram still works perfectly
- [ ] Device test: Discord DM → agent responds
