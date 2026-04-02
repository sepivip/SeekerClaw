# Channel Abstraction Layer — Design Spec

**Date:** 2026-04-02
**Status:** Approved
**Context:** Discord PR #310 audit found 12+ issues where peripheral systems (cron, heartbeat, confirmations, deferStatus) bypass the channel abstraction and call Telegram directly. This spec completes the abstraction so all outbound communication goes through a unified interface.

---

## Goal

Create a `channel.js` module that ALL outbound message sending goes through. Adding a new channel (WhatsApp, Slack, etc.) means implementing the interface — zero changes to cron, heartbeat, confirmations, or any other caller.

## Constraints

- Fix all 12 audit findings from PR #310 review
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
    getOwnerChatId() { return impl.getOwnerChatId(); },
    deleteMessage(chatId, messageId) { return impl.deleteMessage(chatId, messageId); },
    createStatusReactionController(chatId, messageId) {
        return impl.createStatusReactionController(chatId, messageId);
    },
};
```

### Owner ID vs Owner Chat ID

| Concept | Purpose | Telegram | Discord |
|---------|---------|----------|---------|
| Owner ID | Who the owner IS (identity) | Numeric user ID | Snowflake user ID |
| Owner Chat ID | Where to SEND messages | Same as owner ID | DM channel ID (different from user ID) |

- `getOwnerId()` stays in `config.js` — identity, used for auth gates
- `getOwnerChatId()` lives on the channel module — delivery address
- Telegram: `getOwnerChatId()` returns `getOwnerId()` (they're the same)
- Discord: `getOwnerChatId()` returns cached DM channel ID from first `MESSAGE_CREATE`

### telegram.js additions

Export channel interface methods:

```javascript
module.exports = {
    // Existing exports (unchanged)
    telegram, sendMessage, sendTyping, downloadTelegramFile,
    extractMedia, createStatusReactionController,
    MAX_FILE_SIZE, MAX_IMAGE_SIZE,
    
    // New channel interface methods
    start(onMessage, onReaction) { /* wraps existing poll loop */ },
    stop() { /* clean shutdown */ },
    sendFile(chatId, filePath, caption) { /* telegram_send_file logic */ },
    getOwnerChatId() { return getOwnerId(); }, // Same on Telegram
    deleteMessage(chatId, messageId) { /* existing telegram('deleteMessage') */ },
};
```

### discord.js additions

```javascript
let ownerDmChannelId = null; // Cached from first MESSAGE_CREATE

module.exports = {
    start(onMessage, onReaction) { /* existing gateway connect */ },
    stop() { /* clean WebSocket close + clear timers */ },
    sendMessage(chatId, text, replyTo) { /* existing REST send */ },
    sendTyping(chatId) { /* POST /channels/{id}/typing */ },
    sendFile(chatId, filePath, caption) { /* multipart upload or "not supported" */ },
    getOwnerChatId() { return ownerDmChannelId; },
    deleteMessage(chatId, messageId) { /* DELETE /channels/{id}/messages/{id} */ },
    createStatusReactionController() { /* no-op */ },
};
```

## Callers to Migrate

Every system that sends messages outside the main message path:

| System | File | Current (broken on Discord) | After |
|--------|------|---------------------------|-------|
| Heartbeat alert | main.js | `sendMessage(ownerChatId)` with `parseInt` | `channel.sendMessage(channel.getOwnerChatId())` |
| Cron delivery | cron.js | `_sendMessage(ownerId)` | `setSendMessage(channel.sendMessage)` — already uses setter, just wire to channel |
| Confirmations | tools/index.js | `telegram()` direct call | `channel.sendMessage()` |
| deferStatus | ai.js | `telegram()` via import | Channel-aware: `sendTyping` on Telegram, no-op on Discord |
| Session expiry | ai.js | `telegram('sendMessage')` direct | `channel.sendMessage(channel.getOwnerChatId())` |
| "Back online" | main.js | `sendMessage(ownerId)` | `channel.sendMessage(channel.getOwnerChatId())` |
| Auto-resume | main.js | `sendMessage(chatId)` | `channel.sendMessage(chatId)` — already correct shape |
| Sent message cache | ai.js | `recordSentMessage` after `telegram()` | Discord `sendMessage` returns message ID, feeds same cache |

## Audit Fixes Addressed

| ID | Issue | How channel.js fixes it |
|----|-------|------------------------|
| C-1 | parseInt on Discord snowflake | `getOwnerChatId()` returns string, no parseInt needed |
| C-2 | Confirmation silently denies | Confirmations use `channel.sendMessage()` — works on both |
| C-3 | Session expiry hardcoded telegram() | Uses `channel.sendMessage(channel.getOwnerChatId())` |
| C-NEW-1 | deferStatus fires Telegram API on Discord | `deferStatus` uses channel-aware sendTyping |
| C-NEW-2 | Cron sends to user ID not channel ID | Cron uses `channel.sendMessage` which routes to correct channel |
| I-1 | No "back online" on Discord | Uses `channel.getOwnerChatId()` — works when DM channel cached |
| I-2 | Auto-resume mangled ID | No parseInt — string IDs throughout |
| I-3 | System prompt references telegram_send_file | Conditional in ai.js based on CHANNEL |
| I-4 | telegram_delete referenced on Discord | Conditional in ai.js |
| I-5 | Duplicate createStatusReactionController | Single source: `channel.createStatusReactionController()` |
| I-6 | Cron delivery needs DM channel ID | `channel.getOwnerChatId()` returns correct ID |
| I-7 | Chunking newline boundary | Fix in discord.js `sendMessage` |
| I-NEW-1 | Heartbeat non-functional on Discord | Uses `channel.getOwnerChatId()` and string-based queue key |
| I-NEW-2 | Duplicate owner-gate | Remove from discord.js, keep in message-handler.js only |
| I-NEW-5 | Discord sendMessage returns no ID | Return message ID from REST response |

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

## What Does NOT Change

- `message-handler.js` — already uses normalized message shape, no changes
- `config.js` — CHANNEL, tokens, owner ID stay as-is
- `tools/` — tool registration still conditional on CHANNEL
- `ai.js` — system prompt still channel-aware (just fix the audit items)
- Android Kotlin — ConfigManager, NavGraph, DiscordConfigScreen stay as-is (except Settings grouping)

## Acceptance Criteria

- [ ] `channel.js` created with thin router pattern
- [ ] `telegram.js` exports channel interface methods
- [ ] `discord.js` exports channel interface methods + caches DM channel ID
- [ ] ALL 15 audit findings fixed
- [ ] Zero direct `telegram()` calls outside telegram.js
- [ ] `main.js` uses `channel.start()` — no `if (CHANNEL)` blocks for startup
- [ ] Heartbeat, cron, confirmations, deferStatus work on Discord
- [ ] Settings UI groups Telegram + Discord under "Channel" header
- [ ] `./gradlew compileDappStoreDebugKotlin` passes
- [ ] Device test: Telegram still works perfectly
- [ ] Device test: Discord DM → agent responds
