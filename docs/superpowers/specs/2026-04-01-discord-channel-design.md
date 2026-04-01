# Discord Channel — Design Spec

**Date:** 2026-04-01
**Status:** Approved
**Reference:** GitHub Issue #301, existing plan at docs/internal/DISCORD_CHANNEL_PLAN.md (superseded)

## Goal

Add Discord as an alternative messaging channel to Telegram. User picks one active channel at a time (like picking an AI provider). Single active channel — no dual-channel routing.

## Constraints

- Single active channel (Telegram OR Discord, not both)
- Owner-only DMs (same security model as Telegram)
- Settings-only configuration (not in setup wizard)
- One vendored dependency: `ws` (191 KB, pure JS, MIT)
- Custom Discord Gateway protocol handler (~300 lines, no discord.js/Eris)
- Zero impact on existing Telegram-only users
- Safe for 5,000+ users

## Two-PR Approach

**PR 1 (refactor):** Make `main.js` channel-pluggable. Extract the `sendMessage`/`sendTyping` coupling so main.js gets channel functions from config, not hardcoded `require('./telegram')`. Test on device — Telegram works exactly the same. Merge.

**PR 2 (feature):** Add `discord.js`, vendored `ws`, Kotlin UI. Plug Discord into the channel interface from PR 1. Purely additive — no changes to Telegram code. Test on device. Merge.

PR 2 depends on PR 1.

## Config Fields (3 new)

| Field | Required | Encrypted | Default |
|-------|----------|-----------|---------|
| `channel` | no | no | `"telegram"` |
| `discordBotToken` | yes (if Discord) | yes | `""` |
| `discordOwnerId` | no (auto-detect from first DM) | no | `""` |

`channel: "telegram"` = Telegram active, Discord disabled (zero overhead).
`channel: "discord"` = Discord active, Telegram disabled.

## PR 1: Channel-Pluggable Refactor

### Goal
Decouple `main.js` from direct `require('./telegram')` for `sendMessage`/`sendTyping`. Instead, main.js gets these functions from a channel module selected by config.

### Changes

**`main.js`:**
- Replace `const { sendMessage, sendTyping, ... } = require('./telegram')` with channel-aware loading:
  ```javascript
  const CHANNEL = config.channel || 'telegram';
  const channelModule = CHANNEL === 'discord' ? require('./discord') : require('./telegram');
  const { sendMessage, sendTyping } = channelModule;
  ```
- Polling/connection startup also delegated to `channelModule.start(handleMessage)`
- Everything else unchanged — `sendMessage(chatId, text)` signature stays the same

**`telegram.js`:**
- Export a `start(onMessage)` function that wraps the existing polling setup
- `sendMessage`, `sendTyping` already exported — no changes needed
- All other exports (formatting, file handling) stay available for `tools/telegram.js`

**`config.js`:**
- Add `CHANNEL` constant: `const CHANNEL = (config.channel || 'telegram').trim().toLowerCase()`
- Add to `_knownKeyMap` if applicable
- Export `CHANNEL`

### What stays unchanged
- `telegram.js` internals — zero behavior change
- `message-handler.js` — receives messages same as before
- All tools — `tools/telegram.js` still imports from `../telegram` directly
- Heartbeat, cron — use `sendMessage` which now comes from channel module

## PR 2: Discord Channel

### New Files (JS)

**`discord.js` (~300 lines):**
Discord Gateway v10 protocol handler + REST message sending.

Exports (same interface as telegram.js):
- `start(onMessage)` — connect to gateway, call `onMessage(msg)` on inbound DMs
- `sendMessage(chatId, text)` — REST `POST /channels/{id}/messages`
- `sendTyping(chatId)` — REST `POST /channels/{id}/typing`
- `stop()` — close WebSocket gracefully

Gateway protocol:
1. Connect via vendored `ws` to `wss://gateway.discord.gg/?v=10&encoding=json`
2. Receive Hello (opcode 10) → start heartbeat at server interval
3. Send Identify (opcode 2) with token + intents: `DIRECT_MESSAGES (1<<12)` + `MESSAGE_CONTENT (1<<15)`
4. Listen for `MESSAGE_CREATE` events → filter: DM only, not from bot, owner check
5. Owner auto-detect: first DM sender becomes owner (same as Telegram), saved via Bridge
6. On disconnect: session resume (opcode 6) with `session_id` + `seq`
7. Reconnect with exponential backoff (1s, 2s, 4s, 8s, max 30s)

REST sends via existing `httpRequest` from `http.js`:
```javascript
httpRequest({
    hostname: 'discord.com',
    path: `/api/v10/channels/${channelId}/messages`,
    method: 'POST',
    headers: { 'Authorization': `Bot ${DISCORD_TOKEN}`, 'Content-Type': 'application/json' },
}, JSON.stringify({ content: text }))
```

**`lib/ws.js` (191 KB):**
Vendored `ws@8.20.0`. Single file, pure JS, MIT license. Audited for security (no native bindings, no transitive deps in production).

### New Files (Kotlin)

**`ui/settings/DiscordConfigScreen.kt`:**
- Bot token field (encrypted, masked)
- Owner ID field (optional, hint: "Leave empty for auto-detect")
- Connection test button (sends Identify, checks for READY event)
- Help text with link to Discord Developer Portal

### Modified Files (JS)

**`config.js`:**
- Add `DISCORD_TOKEN = normalizeSecret(config.discordBotToken || '')`
- Add `DISCORD_OWNER_ID = (config.discordOwnerId || '').trim()`
- Add `CHANNEL` constant
- Validation: if `CHANNEL === 'discord' && !DISCORD_TOKEN` → exit with error
- Export all new constants

**`ai.js`:**
- System prompt: mention active channel (Telegram or Discord)
- Troubleshooting: channel-specific guidance

### Modified Files (Kotlin)

**`ConfigManager.kt`:**
- Add `channel`, `discordBotToken`, `discordOwnerId` to AppConfig
- Encrypted storage for `discordBotToken`
- `writeConfigJson()` support
- `hasCredential` check: `"discord"` requires `discordBotToken.isNotBlank()`

**`SettingsScreen.kt`:**
- Channel selector (Telegram / Discord) — same UX pattern as AI provider
- Discord config nav entry (only visible when Discord selected)

**`NavGraph.kt`:**
- Add route for DiscordConfigScreen

**`DashboardScreen.kt`:**
- Show active channel in status
- Credential check for Discord

### Discord Message Format

Inbound `MESSAGE_CREATE` event normalized to match Telegram message shape:
```javascript
{
    chatId: msg.channel_id,      // Discord DM channel ID
    senderId: msg.author.id,     // Discord user ID
    text: msg.content,           // Message text
    media: null,                 // v1: text only, media later
    replyTo: null,               // v1: no reply threading
}
```

### Edge Cases

| Scenario | Handling |
|----------|----------|
| No Discord token | Discord disabled, zero overhead |
| Switch Telegram→Discord | Restart required, clean handoff |
| WebSocket drops (network) | Auto-reconnect with session resume + backoff |
| WiFi→cellular handoff | Socket drops, reconnect within ~5s |
| Discord rate limit (429) | Parse `Retry-After`, wait, retry |
| Owner sends from non-DM | Ignored (DMs only in v1) |
| Bot not in any guild | Works — DMs don't require shared guild if user initiates |
| Invalid bot token | Connection test fails with clear error |

### What stays unchanged

- `telegram.js` — zero changes (PR 1 refactored the interface, PR 2 is additive)
- `message-handler.js` — receives normalized messages, channel-agnostic
- Tools, memory, skills, cron — all work via `sendMessage` which routes to active channel
- Setup wizard — Telegram only
- QR v1 — untouched
- Existing user configs — `channel` defaults to `"telegram"`

### Future (not in scope)

- Guild/group chat support
- Discord media (images, files)
- Discord reactions
- Discord slash commands
- Both channels active simultaneously
- `discord_send` tool
