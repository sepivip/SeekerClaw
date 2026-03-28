# Split main.js into focused modules + rename claude.js

**Date:** 2026-03-28
**Issue:** #296
**Risk:** HIGH — 5,300+ live users depend on the message processing pipeline daily.
**Rule:** Zero behavior changes. Pure structural refactor. Every line traceable to its origin.

---

## Current State

`main.js` is 1,447 lines. Prior extractions already removed telegram I/O (`telegram.js`), tools (`tools/`), and providers (`providers/`). What remains:

| Section | Lines | Description |
|---------|-------|-------------|
| Config & imports | 1-150 | require() calls, config loading |
| handleCommand() | 153-497 | /start, /help, /status, /skill, /resume, etc. |
| handleMessage() | 500-747 | Message processing, media, skill auto-install, chat() |
| handleReactionUpdate() | 750-792 | Telegram emoji reaction processing |
| enqueueMessage() + chatQueues | 798-831 | Per-chat promise chain serialization |
| autoResumeOnStartup() | 837-951 | Checkpoint scan + resume on service start |
| poll() | 955-1128 | Telegram getUpdates infinite loop |
| Startup + wiring | 1130-1290 | initDatabase, setChatDeps, timers, shutdown |
| Heartbeat | 1296-1447 | getHeartbeatIntervalMs, runCronAgentTurn, runHeartbeat |

## Changes

### 1. Rename `claude.js` to `ai.js`

The file handles all AI providers (Claude, OpenAI, OpenRouter) — not just Claude. Rename to `ai.js` for honesty and to prepare for Discord (#301) which will import from it.

**Files to update:**
- `git mv claude.js ai.js`
- `main.js` — `require('./claude')` to `require('./ai')`
- `providers/index.js` — `require('./claude')` to `require('./ai')`
- `tools/session.js` — `require('../claude')` to `require('../ai')`
- `tools/android.js` — `require('../claude')` to `require('../ai')`

No other files import claude.js.

### 2. Extract `message-handler.js`

Move these functions out of main.js:

| Function | Lines | What it does |
|----------|-------|-------------|
| `handleCommand()` | 153-497 | Slash command dispatch (/start, /help, /status, /skill, /resume, etc.) |
| `handleMessage()` | 500-747 | Core message processing — owner detection, media handling, skill auto-install, chat() call, response formatting |
| `handleReactionUpdate()` | 750-792 | Process Telegram emoji reactions, add to conversation |

**Pattern:** Same `init()` dependency injection used by `tools/index.js`.

```javascript
// message-handler.js
let deps = {};

function init(d) {
    deps = d;
}

// handleCommand, handleMessage, handleReactionUpdate move here verbatim
// All references to imported functions (sendMessage, chat, executeTool, etc.)
// change from direct imports to deps.sendMessage, deps.chat, etc.

module.exports = {
    init,
    handleCommand,
    handleMessage,
    handleReactionUpdate,
};
```

**Dependencies received via init():**

From telegram.js: `sendMessage`, `sendTyping`, `downloadTelegramFile`, `extractMedia`, `createStatusReactionController`, `MAX_FILE_SIZE`, `MAX_IMAGE_SIZE`
From ai.js: `chat`, `getConversation`, `addToConversation`, `clearConversation`, `saveSessionSummary`, `MIN_MESSAGES_FOR_SUMMARY`
From tools/: `executeTool`, `pendingConfirmations`, `lastToolUseTime`, `requestConfirmation`
From memory.js: `loadBootstrap`, `loadIdentity`, `loadSoul`, `loadMemory`
From skills.js: `loadSkills`
From task-store.js: `loadCheckpoint`, `listCheckpoints`, `saveCheckpoint`, `deleteCheckpoint`
From config.js: `ANTHROPIC_KEY`, `AUTH_TYPE`, `MODEL`, `AGENT_NAME`, `PROVIDER`, `REACTION_NOTIFICATIONS`, `localTimestamp`, `log`, `getOwnerId`, `setOwnerId`, `workDir`, `config`, `debugLog`
From security.js: `redactSecrets`
From bridge.js: `androidBridgeCall`
From quick-actions.js: `handleQuickCommand`
From cron.js: `cronService`
Shared state: `chatQueues` (Map, passed by reference)

### 3. What remains in main.js (~400 lines)

After extraction, main.js is the entry point with:

- **Imports** — require all modules
- **Shared state** — `chatQueues`, `lastIncomingMessages`, polling state (`offset`, `pollErrors`, etc.)
- **enqueueMessage()** — serialization layer (stays in main because it owns chatQueues)
- **poll()** — Telegram getUpdates loop, callback_query dispatch, message_reaction dispatch
- **autoResumeOnStartup()** — checkpoint scan + resume
- **runCronAgentTurn()** — isolated cron agent sessions
- **runHeartbeat()** — heartbeat probe with ackMaxChars
- **getHeartbeatIntervalMs()** — read interval from agent_settings.json
- **Startup block** — telegram('getMe'), initDatabase, setChatDeps, wiring, timers
- **Graceful shutdown** — process.on('SIGTERM'/'SIGINT')

### 4. What does NOT change

- `telegram.js` — already extracted, no modifications
- `tools/` — already extracted, no modifications (except require path claude→ai)
- `providers/` — already extracted, no modifications (except require path claude→ai)
- `config.js`, `security.js`, `bridge.js`, `memory.js`, `cron.js`, `database.js`, `solana.js`, `skills.js`, `mcp-client.js`, `task-store.js`, `quick-actions.js` — untouched

## Dependency Graph (after refactor)

```
main.js (entry point)
  ├── ai.js (renamed from claude.js)
  ├── message-handler.js (NEW)
  │     └── init({ sendMessage, chat, executeTool, ... })
  ├── telegram.js (existing, unchanged)
  ├── tools/index.js (existing, require path updated)
  ├── providers/index.js (existing, require path updated)
  ├── config.js, security.js, bridge.js, memory.js
  ├── cron.js, database.js, solana.js, skills.js
  ├── mcp-client.js, task-store.js, quick-actions.js
  └── loop-detector.js (via ai.js)
```

No circular dependencies. message-handler.js does not import main.js. All cross-module communication via init() callbacks.

## Risks and Mitigations

| Risk | Impact | Mitigation |
|------|--------|-----------|
| Closure references break when functions move files | Messages stop processing | Every moved function gets its dependencies via init() — verify each reference in smoke test |
| `this` binding issues | Subtle bugs | No functions use `this` — all are plain functions, safe to move |
| require() ordering on nodejs-mobile | Service crash on start | Rename + require changes committed separately, syntax-checked before message-handler extraction |
| Shared mutable state (chatQueues) | Race conditions | chatQueues Map passed by reference in init() — same object, same behavior |
| Missing dependency in init() | Runtime crash on first message | Smoke test covers: syntax check + dependency enumeration test |

## Extraction Order (commits)

1. **Rename `claude.js` → `ai.js`** — git mv + 4 require path updates. Separate commit for clean git history.
2. **Extract `message-handler.js`** — move 3 functions verbatim, wire via init(). Separate commit.
3. **Verify** — syntax check all modified files, run on device.

## Discord Readiness

This refactor does NOT add the channel abstraction. But it structures main.js so #301 can cleanly:
- Move `poll()` from main.js → `channels/telegram.js`
- `enqueueMessage()` stays in main (channel-agnostic)
- `message-handler.js` doesn't change — it already receives `sendMessage` via init()

## Acceptance Criteria

- [ ] main.js is ~400 lines (startup + wiring + polling + heartbeat)
- [ ] message-handler.js owns handleCommand, handleMessage, handleReactionUpdate
- [ ] claude.js renamed to ai.js with all require paths updated
- [ ] No circular require() calls
- [ ] All syntax checks pass (node --check on every modified .js file)
- [ ] No behavior changes — identical functionality pre/post refactor
- [ ] Each extraction is a separate commit for easy bisection
- [ ] RC tested on physical device before merge
