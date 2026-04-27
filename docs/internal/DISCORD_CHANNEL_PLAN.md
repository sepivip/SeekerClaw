# Discord Channel Integration — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add Discord as a second messaging channel alongside Telegram, so users can interact with their SeekerClaw agent via Discord DMs or guild channels.

**Architecture:** Introduce a thin channel abstraction layer that normalizes message I/O. Telegram stays as-is but behind the abstraction. Discord connects via WebSocket gateway (outbound, no public IP needed). Both channels share the same `chat()` engine, tools, memory, and conversation history (keyed by `discord:<channelId>` or `telegram:<chatId>`). Config is extended with optional Discord fields — if no Discord token, Discord is simply disabled.

**Tech Stack:**
- `@discordjs/ws@^1.2.3` — WebSocket gateway (Node 18 compatible, pure JS)
- `@discordjs/rest@^2.6.0` — REST API client (Node 18 compatible, pure JS)
- `discord-api-types@^0.38.0` — Type constants (intents, events)
- Kotlin/Compose — Discord bot token setup UI

---

## File Structure

### New Files (Node.js)

| File | Responsibility |
|------|----------------|
| `channels/index.js` | Channel registry — register, get, route `sendMessage()` by chatId prefix |
| `channels/telegram.js` | Telegram adapter — wraps existing telegram.js, polling loop, message normalization |
| `channels/discord.js` | Discord adapter — gateway connection, message receive/send, normalization |

### New Files (Kotlin)

| File | Responsibility |
|------|----------------|
| `ui/settings/DiscordConfigScreen.kt` | Discord bot token input + connection test screen |

### Modified Files (Node.js)

| File | Changes |
|------|---------|
| `main.js` | Replace hardcoded Telegram polling with channel registry startup. Route `handleMessage()` through normalized message format. |
| `config.js` | Add `DISCORD_TOKEN`, `DISCORD_OWNER_ID`, `DISCORD_GUILD_ID` fields from config.json |
| `telegram.js` | Export `sendMessage` as `sendTelegramMessage`. Keep all internals unchanged. |
| `claude.js` | `sendTyping()` injection becomes channel-aware (Discord has its own typing indicator) |
| `tools/telegram.js` | `telegram_send` uses channel registry instead of direct telegram import |

### Modified Files (Kotlin)

| File | Changes |
|------|---------|
| `config/ConfigManager.kt` | Add `discordBotToken`, `discordOwnerId`, `discordGuildId` to AppConfig + encrypted storage |
| `ui/settings/SettingsScreen.kt` | Add Discord config navigation item in settings |
| `ui/navigation/NavGraph.kt` | Add route for DiscordConfigScreen |

---

## Task 0: Rename `claude.js` → `ai.js` (Provider-Agnostic)

**Files:**
- Rename: `app/src/main/assets/nodejs-project/claude.js` → `ai.js`
- Modify: `app/src/main/assets/nodejs-project/main.js` (line 134: `require('./claude')` → `require('./ai')`)
- Modify: `app/src/main/assets/nodejs-project/providers/index.js` (line 34: `require('./claude')` → `require('./ai')`)
- Modify: `app/src/main/assets/nodejs-project/tools/session.js` (line 10: `require('../claude')` → `require('../ai')`)
- Modify: `app/src/main/assets/nodejs-project/tools/android.js` (line 12: `require('../claude')` → `require('../ai')`)

The file handles all AI provider interactions (Claude, OpenAI, OpenRouter), not just Claude. Rename before building the channel layer since multiple new files will import from it.

- [ ] **Step 1: Rename the file**

```bash
git mv app/src/main/assets/nodejs-project/claude.js app/src/main/assets/nodejs-project/ai.js
```

- [ ] **Step 2: Update all 4 require paths**

- `main.js:134` — `require('./claude')` → `require('./ai')`
- `providers/index.js:34` — `require('./claude')` → `require('./ai')`
- `tools/session.js:10` — `require('../claude')` → `require('../ai')`
- `tools/android.js:12` — `require('../claude')` → `require('../ai')`

- [ ] **Step 3: Smoke test**

```bash
node --check app/src/main/assets/nodejs-project/ai.js
node --check app/src/main/assets/nodejs-project/main.js
node --check app/src/main/assets/nodejs-project/tools/session.js
node --check app/src/main/assets/nodejs-project/tools/android.js
```

- [ ] **Step 4: Commit**

```bash
git add -A
git commit -m "refactor: rename claude.js → ai.js (multi-provider)"
```

---

## Task 1: Channel Abstraction Layer (`channels/index.js`)

**Files:**
- Create: `app/src/main/assets/nodejs-project/channels/index.js`

This is the routing layer. Every `sendMessage()` call goes through here. ChatId prefixes (`telegram:` / `discord:`) determine which channel handles it.

- [ ] **Step 1: Create the channel registry module**

```javascript
// channels/index.js
// Channel registry — routes messages to the right channel adapter.

const { log } = require('../config');

const channels = new Map(); // name → { sendMessage, sendTyping, name }

function registerChannel(name, adapter) {
    if (!adapter.sendMessage) throw new Error(`Channel ${name} missing sendMessage()`);
    channels.set(name, adapter);
    log(`[Channels] Registered: ${name}`, 'INFO');
}

function getChannel(name) {
    return channels.get(name) || null;
}

// Resolve channel from prefixed chatId (e.g., "discord:123" → discord adapter)
// Unprefixed numeric IDs default to telegram for backward compatibility.
function resolveChannel(chatId) {
    const str = String(chatId);
    const colonIdx = str.indexOf(':');
    if (colonIdx > 0) {
        const prefix = str.slice(0, colonIdx);
        const ch = channels.get(prefix);
        if (ch) return { channel: ch, rawId: str.slice(colonIdx + 1) };
    }
    // Default: telegram (backward compat for numeric IDs, cron, heartbeat)
    return { channel: channels.get('telegram') || null, rawId: str };
}

// Universal sendMessage — resolves channel from chatId prefix, delegates.
async function sendMessage(chatId, text, replyTo, buttons) {
    const { channel, rawId } = resolveChannel(chatId);
    if (!channel) {
        log(`[Channels] No channel for chatId=${chatId}`, 'WARN');
        return null;
    }
    return channel.sendMessage(rawId, text, replyTo, buttons);
}

// Universal sendTyping — same routing logic.
function sendTyping(chatId) {
    const { channel, rawId } = resolveChannel(chatId);
    if (channel && channel.sendTyping) channel.sendTyping(rawId);
}

function getRegisteredChannels() {
    return [...channels.keys()];
}

module.exports = {
    registerChannel,
    getChannel,
    resolveChannel,
    sendMessage,
    sendTyping,
    getRegisteredChannels,
};
```

- [ ] **Step 2: Smoke test syntax**

Run: `node --check app/src/main/assets/nodejs-project/channels/index.js`
Expected: No output (clean parse)

- [ ] **Step 3: Inline logic test**

```bash
node -e "
// Test resolveChannel prefix parsing
const tests = [
    ['discord:123456', 'discord', '123456'],
    ['telegram:789', 'telegram', '789'],
    ['7581373860', 'telegram', '7581373860'],
    ['__heartbeat__', 'telegram', '__heartbeat__'],
    ['cron:abc', 'telegram', 'cron:abc'],
];
// Simulate without real channels registered
let pass = true;
for (const [input, expectedPrefix, expectedRaw] of tests) {
    const str = String(input);
    const colonIdx = str.indexOf(':');
    let prefix, rawId;
    if (colonIdx > 0 && ['discord','telegram'].includes(str.slice(0, colonIdx))) {
        prefix = str.slice(0, colonIdx);
        rawId = str.slice(colonIdx + 1);
    } else {
        prefix = 'telegram';
        rawId = str;
    }
    if (prefix !== expectedPrefix || rawId !== expectedRaw) {
        console.log('FAIL:', input, 'got', prefix, rawId, 'expected', expectedPrefix, expectedRaw);
        pass = false;
    }
}
console.log(pass ? 'ALL PASSED' : 'SOME FAILED');
process.exit(pass ? 0 : 1);
"
```

Expected: `ALL PASSED`

- [ ] **Step 4: Commit**

```bash
git add app/src/main/assets/nodejs-project/channels/index.js
git commit -m "feat: add channel abstraction layer for multi-channel support"
```

---

## Task 2: Telegram Channel Adapter (`channels/telegram.js`)

**Files:**
- Create: `app/src/main/assets/nodejs-project/channels/telegram.js`
- Modify: `app/src/main/assets/nodejs-project/main.js` (import + register)

Wraps existing `telegram.js` as a channel adapter. The existing `telegram.js` stays unchanged — this adapter just implements the channel interface on top of it.

- [ ] **Step 1: Create the Telegram adapter**

```javascript
// channels/telegram.js
// Telegram channel adapter — wraps telegram.js behind the channel interface.

const {
    telegram,
    sendMessage: sendTelegramMessage,
    sendTyping: sendTelegramTyping,
    extractMedia,
    downloadTelegramFile,
    createStatusReactionController,
    STATUS_EMOJIS,
    sentMessageCache,
    SENT_CACHE_TTL,
    recordSentMessage,
} = require('../telegram');
const { log, getOwnerId } = require('../config');

// Normalize a Telegram update.message into a channel-agnostic format.
function normalizeMessage(msg) {
    return {
        chatId: `telegram:${msg.chat.id}`,
        rawChatId: msg.chat.id,
        senderId: String(msg.from?.id || ''),
        text: (msg.text || msg.caption || '').trim(),
        messageId: msg.message_id,
        replyToMessageId: msg.reply_to_message?.message_id || null,
        replyToText: msg.reply_to_message?.text || null,
        channel: 'telegram',
        raw: msg, // Keep original for media extraction etc.
    };
}

// Check if a senderId is the owner on this channel.
function isOwner(senderId) {
    const ownerId = getOwnerId();
    return ownerId && senderId === String(ownerId);
}

module.exports = {
    name: 'telegram',
    sendMessage: sendTelegramMessage,
    sendTyping: sendTelegramTyping,
    normalizeMessage,
    isOwner,
    extractMedia,
    downloadTelegramFile,
    createStatusReactionController,
    STATUS_EMOJIS,
    sentMessageCache,
    SENT_CACHE_TTL,
    recordSentMessage,
    // Re-export raw API for tools that need it
    telegram,
};
```

- [ ] **Step 2: Smoke test**

Run: `node --check app/src/main/assets/nodejs-project/channels/telegram.js`
Expected: No output (clean parse)

- [ ] **Step 3: Commit**

```bash
git add app/src/main/assets/nodejs-project/channels/telegram.js
git commit -m "feat: wrap Telegram as channel adapter"
```

---

## Task 3: Discord Channel Adapter (`channels/discord.js`)

**Files:**
- Create: `app/src/main/assets/nodejs-project/channels/discord.js`

This is the core Discord integration. Uses `@discordjs/ws` for gateway events and `@discordjs/rest` for API calls. Connects via WebSocket (outbound only — no public IP needed).

- [ ] **Step 1: Bundle Discord dependencies**

Discord libraries must be bundled in the APK assets since there's no `npm install` on device. Pre-install them and commit the `node_modules` subset.

```bash
cd app/src/main/assets/nodejs-project
npm install @discordjs/ws@^1.2.3 @discordjs/rest@^2.6.0 discord-api-types@^0.38.0 --save
```

Verify no native bindings:
```bash
find node_modules -name binding.gyp 2>/dev/null | head -5
# Expected: empty (no native deps)
```

**Note:** If the full `node_modules` is too large, use a bundler (esbuild) to create a single `discord-bundle.js`. Document this in a follow-up task.

- [ ] **Step 2: Create the Discord adapter**

```javascript
// channels/discord.js
// Discord channel adapter — WebSocket gateway + REST API.
// Requires: @discordjs/ws ^1.2.3, @discordjs/rest ^2.6.0, discord-api-types

const { log } = require('../config');

let REST, WebSocketManager, WebSocketShardEvents, GatewayDispatchEvents,
    GatewayIntentBits, Routes;

// Lazy-load Discord libs (may not be installed if Discord is disabled)
function loadDiscordLibs() {
    if (REST) return true;
    try {
        ({ REST } = require('@discordjs/rest'));
        ({ WebSocketManager, WebSocketShardEvents } = require('@discordjs/ws'));
        ({
            GatewayDispatchEvents,
            GatewayIntentBits,
            Routes,
        } = require('discord-api-types/v10'));
        return true;
    } catch (e) {
        log(`[Discord] Libraries not available: ${e.message}`, 'WARN');
        return false;
    }
}

let rest = null;
let gateway = null;
let botUserId = null;
let discordOwnerId = null;
let onMessageCallback = null;

async function start(token, ownerId, onMessage) {
    if (!loadDiscordLibs()) return false;

    discordOwnerId = String(ownerId);
    onMessageCallback = onMessage;

    // REST client for API calls
    rest = new REST({ version: '10' }).setToken(token);

    // Verify token by fetching bot user
    try {
        const me = await rest.get(Routes.user());
        botUserId = me.id;
        log(`[Discord] Logged in as ${me.username}#${me.discriminator} (${me.id})`, 'INFO');
    } catch (e) {
        log(`[Discord] Invalid token: ${e.message}`, 'ERROR');
        return false;
    }

    // WebSocket gateway — intents for DMs + guild messages
    gateway = new WebSocketManager({
        token,
        intents:
            GatewayIntentBits.Guilds |
            GatewayIntentBits.GuildMessages |
            GatewayIntentBits.MessageContent |
            GatewayIntentBits.DirectMessages,
        rest,
    });

    // Listen for dispatched events
    gateway.on(WebSocketShardEvents.Dispatch, (event) => {
        if (event.t === GatewayDispatchEvents.MessageCreate) {
            handleMessageCreate(event.d);
        }
    });

    await gateway.connect();
    log('[Discord] Gateway connected', 'INFO');
    return true;
}

function handleMessageCreate(msg) {
    // Ignore own messages
    if (msg.author.id === botUserId) return;
    // Ignore bots
    if (msg.author.bot) return;

    // Owner check — only respond to configured owner
    if (discordOwnerId && msg.author.id !== discordOwnerId) {
        log(`[Discord] Ignoring message from non-owner ${msg.author.id}`, 'DEBUG');
        return;
    }

    if (onMessageCallback) {
        onMessageCallback(normalizeMessage(msg));
    }
}

function normalizeMessage(msg) {
    return {
        chatId: `discord:${msg.channel_id}`,
        rawChatId: msg.channel_id,
        senderId: msg.author.id,
        text: (msg.content || '').trim(),
        messageId: msg.id,
        replyToMessageId: msg.message_reference?.message_id || null,
        replyToText: null, // Would need an API call to fetch — skip for v1
        channel: 'discord',
        raw: msg,
    };
}

function isOwner(senderId) {
    return discordOwnerId && senderId === discordOwnerId;
}

async function sendMessage(channelId, text, replyTo, buttons) {
    if (!rest) return null;

    // Discord max message length is 2000 chars
    const chunks = chunkText(text, 2000);
    let lastMessageId = null;

    for (const chunk of chunks) {
        try {
            const payload = { content: chunk };
            if (replyTo && !lastMessageId) {
                payload.message_reference = { message_id: replyTo };
            }
            const result = await rest.post(
                Routes.channelMessages(channelId),
                { body: payload },
            );
            lastMessageId = result.id;
        } catch (e) {
            log(`[Discord] Send failed: ${e.message}`, 'ERROR');
        }
    }
    return lastMessageId;
}

function sendTyping(channelId) {
    if (!rest) return;
    rest.post(Routes.channelTyping(channelId), { body: {} }).catch(() => {});
}

// Simple text chunker for Discord's 2000 char limit
function chunkText(text, limit) {
    if (text.length <= limit) return [text];
    const chunks = [];
    let remaining = text;
    while (remaining.length > 0) {
        if (remaining.length <= limit) {
            chunks.push(remaining);
            break;
        }
        // Try to break at newline
        let breakIdx = remaining.lastIndexOf('\n', limit);
        if (breakIdx < limit * 0.3) breakIdx = limit; // No good newline, hard break
        chunks.push(remaining.slice(0, breakIdx));
        remaining = remaining.slice(breakIdx).trimStart();
    }
    return chunks;
}

async function stop() {
    if (gateway) {
        try { await gateway.destroy(); } catch (e) {}
        gateway = null;
    }
    rest = null;
    botUserId = null;
    log('[Discord] Disconnected', 'INFO');
}

module.exports = {
    name: 'discord',
    start,
    stop,
    sendMessage,
    sendTyping,
    normalizeMessage,
    isOwner,
};
```

- [ ] **Step 3: Smoke test**

Run: `node --check app/src/main/assets/nodejs-project/channels/discord.js`
Expected: No output (clean parse)

- [ ] **Step 4: Commit**

```bash
git add app/src/main/assets/nodejs-project/channels/discord.js
git commit -m "feat: add Discord channel adapter with gateway + REST"
```

---

## Task 4: Wire Channels into main.js

**Files:**
- Modify: `app/src/main/assets/nodejs-project/main.js`

This is the biggest change. We need to:
1. Import and register both channel adapters
2. Generalize `handleMessage()` to accept normalized messages
3. Start Discord gateway alongside Telegram polling
4. Route `sendMessage()` through the channel registry

- [ ] **Step 1: Add channel imports and registration (near top of main.js)**

After the existing telegram.js require block (~line 115), add:

```javascript
// ============================================================================
// CHANNELS (multi-channel abstraction — BAT-XXX)
// ============================================================================

const { registerChannel, sendMessage: channelSendMessage, sendTyping: channelSendTyping, resolveChannel } = require('./channels/index');
const telegramChannel = require('./channels/telegram');
const discordChannel = require('./channels/discord');

// Register Telegram (always available)
registerChannel('telegram', telegramChannel);
```

- [ ] **Step 2: Replace sendMessage references**

The existing `sendMessage` is imported from `telegram.js`. We need to swap it for the channel-aware version. Find the line where `sendMessage` is imported from `telegram.js` and alias it:

```javascript
// Before (existing):
const { sendMessage, sendTyping, ... } = require('./telegram');

// After:
const { sendMessage: sendTelegramMessage, sendTyping: sendTelegramTyping, ... } = require('./telegram');
```

Then create local aliases that route through the channel registry:

```javascript
// Channel-aware message sending — routes by chatId prefix
const sendMessage = channelSendMessage;
const sendTyping = channelSendTyping;
```

**Important:** Also update `setSendMessage(sendMessage)` for cron.js to use the channel-aware version.

- [ ] **Step 3: Generalize handleMessage()**

Rename the existing `handleMessage(msg)` to `handleTelegramMessage(msg)` which normalizes then calls the generic handler:

```javascript
// Telegram-specific entry point — normalizes and delegates
async function handleTelegramMessage(msg) {
    const normalized = telegramChannel.normalizeMessage(msg);
    return handleChannelMessage(normalized);
}

// Channel-agnostic message handler
async function handleChannelMessage(normalized) {
    const chatId = normalized.chatId;     // prefixed: "telegram:123" or "discord:456"
    const senderId = normalized.senderId;
    const rawText = normalized.text;
    const media = normalized.channel === 'telegram' ? extractMedia(normalized.raw) : null;

    // ... rest of existing handleMessage logic, using chatId and rawText ...
    // Replace msg.chat.id → chatId
    // Replace msg.from?.id → senderId
    // Replace msg.text → rawText
    // Replace msg.message_id → normalized.messageId
}
```

- [ ] **Step 4: Add Discord startup alongside Telegram polling**

After the existing `poll().catch(...)` call (~line 1198), add Discord startup:

```javascript
// Start Discord if configured
const DISCORD_TOKEN = config.discordBotToken;
const DISCORD_OWNER = config.discordOwnerId;
if (DISCORD_TOKEN) {
    discordChannel.start(DISCORD_TOKEN, DISCORD_OWNER, (normalized) => {
        // Route Discord messages through the same queue as Telegram
        const chatId = normalized.chatId;
        const prev = chatQueues.get(chatId) || Promise.resolve();
        const task = prev.then(() => handleChannelMessage(normalized));
        chatQueues.set(chatId, task);
    }).then(ok => {
        if (ok) log('[Main] Discord channel started', 'INFO');
    }).catch(e => {
        log(`[Main] Discord start failed: ${e.message}`, 'ERROR');
    });
} else {
    log('[Main] Discord not configured — skipping', 'DEBUG');
}
```

- [ ] **Step 5: Smoke test**

Run: `node --check app/src/main/assets/nodejs-project/main.js`
Expected: No output

- [ ] **Step 6: Commit**

```bash
git add app/src/main/assets/nodejs-project/main.js
git commit -m "feat: wire multi-channel routing into main.js message flow"
```

---

## Task 5: Extend Config for Discord

**Files:**
- Modify: `app/src/main/assets/nodejs-project/config.js`
- Modify: `app/src/main/java/com/seekerclaw/app/config/ConfigManager.kt`

- [ ] **Step 1: Add Discord fields to config.js**

In the config loading section (~line 101), add:

```javascript
const DISCORD_TOKEN = normalizeSecret(config.discordBotToken || '');
const DISCORD_OWNER_ID = config.discordOwnerId ? String(config.discordOwnerId).trim() : '';
const DISCORD_GUILD_ID = config.discordGuildId ? String(config.discordGuildId).trim() : '';
```

Export them alongside existing fields.

- [ ] **Step 2: Add Discord fields to ConfigManager.kt**

In the `AppConfig` data class, add:

```kotlin
val discordBotToken: String = "",
val discordOwnerId: String = "",
val discordGuildId: String = "",
```

Add corresponding encrypted storage keys and save/load methods following the same pattern as `telegramBotToken`.

- [ ] **Step 3: Generate Discord fields in config.json**

In the config.json generation code (ConfigManager or SeekerClawService), add the Discord fields:

```kotlin
put("discordBotToken", config.discordBotToken)
put("discordOwnerId", config.discordOwnerId)
put("discordGuildId", config.discordGuildId)
```

- [ ] **Step 4: Commit**

```bash
git add app/src/main/assets/nodejs-project/config.js
git add app/src/main/java/com/seekerclaw/app/config/ConfigManager.kt
git commit -m "feat: extend config for Discord bot token, owner ID, guild ID"
```

---

## Task 6: Discord Settings UI

**Files:**
- Create: `app/src/main/java/com/seekerclaw/app/ui/settings/DiscordConfigScreen.kt`
- Modify: `app/src/main/java/com/seekerclaw/app/ui/settings/SettingsScreen.kt`
- Modify: `app/src/main/java/com/seekerclaw/app/ui/navigation/NavGraph.kt`

- [ ] **Step 1: Create DiscordConfigScreen**

Follow the same pattern as `ProviderConfigScreen.kt` or `TelegramConfigScreen.kt`:

```kotlin
@Composable
fun DiscordConfigScreen(onBack: () -> Unit) {
    val context = LocalContext.current

    var botToken by rememberSaveable { mutableStateOf(ConfigManager.getDiscordBotToken(context)) }
    var ownerId by rememberSaveable { mutableStateOf(ConfigManager.getDiscordOwnerId(context)) }
    var guildId by rememberSaveable { mutableStateOf(ConfigManager.getDiscordGuildId(context)) }
    var showRestartDialog by remember { mutableStateOf(false) }

    // Standard SeekerClaw settings screen layout:
    // - Bot Token (masked input)
    // - Owner ID (your Discord user ID)
    // - Guild/Server ID (optional — for guild-specific features)
    // - Save button → saves to ConfigManager, shows restart dialog
    // - Connection test button → validates token via Discord API
}
```

- [ ] **Step 2: Add navigation route in NavGraph.kt**

```kotlin
composable("discord_config") {
    DiscordConfigScreen(onBack = { navController.popBackStack() })
}
```

- [ ] **Step 3: Add Discord entry in SettingsScreen.kt**

In the "Channels" or "AI Configuration" section, add a navigation item:

```kotlin
SettingsNavRow(
    label = stringResource(R.string.settings_discord),
    value = if (ConfigManager.getDiscordBotToken(context).isNotEmpty()) "Connected" else "Not configured",
    onClick = { navController.navigate("discord_config") },
)
```

- [ ] **Step 4: Add string resources**

In `res/values/strings.xml`:
```xml
<string name="settings_discord">Discord</string>
<string name="settings_discord_bot_token">Bot Token</string>
<string name="settings_discord_owner_id">Owner User ID</string>
<string name="settings_discord_guild_id">Server ID (optional)</string>
```

- [ ] **Step 5: Commit**

```bash
git add app/src/main/java/com/seekerclaw/app/ui/settings/DiscordConfigScreen.kt
git add app/src/main/java/com/seekerclaw/app/ui/settings/SettingsScreen.kt
git add app/src/main/java/com/seekerclaw/app/ui/navigation/NavGraph.kt
git add app/src/main/res/values/strings.xml
git commit -m "feat: add Discord configuration screen in Settings"
```

---

## Task 7: Update System Prompt (Agent Self-Awareness)

**Files:**
- Modify: `app/src/main/assets/nodejs-project/claude.js` (buildSystemBlocks)

The agent must know it can receive messages from both Telegram and Discord.

- [ ] **Step 1: Add channel awareness to system prompt**

In `buildSystemBlocks()`, add a section after the runtime info:

```javascript
// Channel info
const activeChannels = [];
if (BOT_TOKEN) activeChannels.push('Telegram');
if (DISCORD_TOKEN) activeChannels.push('Discord');
if (activeChannels.length > 1) {
    dynamicLines.push(`Active channels: ${activeChannels.join(', ')}`);
    dynamicLines.push('Messages arrive from multiple channels. The chatId prefix (telegram: or discord:) tells you which channel sent the message.');
    dynamicLines.push('Your replies are automatically routed to the correct channel.');
}
```

- [ ] **Step 2: Update telegram_send tool description**

If Discord is active, the tool descriptions should mention which channel they target. The `telegram_send` tool stays Telegram-specific. Consider adding a `discord_send` tool or making `telegram_send` channel-aware in a follow-up.

- [ ] **Step 3: Commit**

```bash
git add app/src/main/assets/nodejs-project/claude.js
git commit -m "feat: update system prompt with multi-channel awareness"
```

---

## Task 8: Handle Cross-Channel Edge Cases

**Files:**
- Modify: `app/src/main/assets/nodejs-project/main.js`
- Modify: `app/src/main/assets/nodejs-project/tools/telegram.js`

- [ ] **Step 1: Heartbeat uses telegram channel directly**

Heartbeat should always alert via the primary channel (Telegram). Verify the heartbeat code uses `telegram:` prefixed chatId:

```javascript
// In runHeartbeat():
addToConversation(`telegram:${ownerChatId}`, 'assistant', cleaned);
await sendMessage(`telegram:${ownerChatId}`, cleaned);
```

- [ ] **Step 2: Cron delivers to the right channel**

Cron already uses `sendMessage(ownerChatId, ...)`. After the prefix migration, this needs updating to `sendMessage(\`telegram:${ownerChatId}\`, ...)` — or to a configurable "primary channel" for notifications.

- [ ] **Step 3: Tool telegram_send stays Telegram-specific**

The `telegram_send` tool in `tools/telegram.js` should continue using the raw Telegram chatId (without prefix). It's explicitly a Telegram tool. Add a note in the tool description:

```javascript
description: "Send a message via Telegram. For Discord messages, use the channel's native reply mechanism."
```

- [ ] **Step 4: Conversation history is per-channel**

Since chatIds are now prefixed (`telegram:123` vs `discord:456`), conversations are automatically separated per channel. The same user can have different conversation histories on Telegram and Discord. This is correct behavior — each channel is a different context.

- [ ] **Step 5: Commit**

```bash
git add app/src/main/assets/nodejs-project/main.js
git add app/src/main/assets/nodejs-project/tools/telegram.js
git commit -m "fix: handle cross-channel edge cases (heartbeat, cron, tools)"
```

---

## Task 9: Integration Testing on Device

- [ ] **Step 1: Test Telegram still works unchanged**

1. Build and install APK
2. Send messages via Telegram — verify all features work as before
3. Check logs for `[Channels] Registered: telegram`
4. Verify no `[Discord]` errors when Discord is not configured

- [ ] **Step 2: Configure Discord**

1. Go to https://discord.com/developers/applications — create a bot
2. Enable **Message Content Intent** in Bot settings
3. Copy bot token
4. Invite bot to a test server with `applications.commands` + `bot` scopes
5. Get your Discord user ID (enable Developer Mode → right-click your name → Copy User ID)
6. Enter token + owner ID in SeekerClaw Settings → Discord

- [ ] **Step 3: Test Discord**

1. Restart service
2. Check logs for `[Discord] Logged in as BotName#1234`
3. Check logs for `[Discord] Gateway connected`
4. DM the bot — verify it responds
5. Send in a guild channel where bot is present — verify it responds
6. Test a multi-turn conversation — verify context is maintained
7. Verify Telegram still works simultaneously

- [ ] **Step 4: Test cross-channel isolation**

1. Send "What's 2+2?" on Telegram
2. Send "What did I just ask?" on Discord — should NOT know about the Telegram conversation
3. Send "What's 2+2?" on Discord
4. Reply "multiply by 10" on Discord — should respond "40"

---

## Migration Notes

### Backward Compatibility

- **No Discord token?** Discord adapter simply doesn't start. Zero impact on existing users.
- **chatId format change:** The prefix migration (`123` → `telegram:123`) must be handled carefully. During the transition, unprefixed numeric IDs default to Telegram via `resolveChannel()`. Existing conversation history (keyed by unprefixed IDs) will start fresh after migration — this is acceptable since conversations are ephemeral (cleared on restart per BAT-30).
- **config.json:** New fields (`discordBotToken`, etc.) are optional with empty string defaults. Old configs work unchanged.

### What's NOT in This Plan (Future Work)

- Discord slash commands
- Discord embeds / rich formatting
- Discord reactions / status emojis
- Discord media upload/download
- Discord voice channels
- `discord_send` tool for the agent
- Shared conversation across channels (same user, both channels)
- Discord Quick Actions (buttons)
- Discord thread support
