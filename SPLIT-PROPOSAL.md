# main.js Module Split Proposal

> **Current state:** ~8,690 lines, single monolith. Everything is globals/closures sharing state implicitly.
> **Target:** 12 focused modules + slim orchestrator

---

## Module Map

### 1. `config.js` — Configuration & Constants (~250 lines)

**Responsibility:** Load config.json, normalize secrets, export all constants and shared paths.

| What moves | Current lines |
|------------|---------------|
| `normalizeSecret()` | L78 |
| Config loading + validation | L68–133 |
| All config constants | `BOT_TOKEN`, `OWNER_ID`, `ANTHROPIC_KEY`, `AUTH_TYPE`, `MODEL`, `AGENT_NAME`, `BRIDGE_TOKEN`, `USER_AGENT`, `MCP_SERVERS`, reaction config |
| File path constants | L398–403: `SOUL_PATH`, `MEMORY_PATH`, `HEARTBEAT_PATH`, `MEMORY_DIR`, `SKILLS_DIR`, `DB_PATH` |
| Truncation constants | L417–420 |
| `SECRETS_BLOCKED` set | L277 |
| `CONFIRM_REQUIRED`, `TOOL_RATE_LIMITS`, `TOOL_STATUS_MAP` | L285–322 |
| `localTimestamp()`, `localDateStr()` | L38–52 |
| `log()` + log rotation | L16–59 |

**Shared state:** `OWNER_ID` is mutable (auto-detect from first message) — export getter/setter.

**Exports:**
```js
module.exports = {
  config, workDir, debugLog,
  BOT_TOKEN, ANTHROPIC_KEY, AUTH_TYPE, MODEL, AGENT_NAME, BRIDGE_TOKEN, USER_AGENT,
  MCP_SERVERS, REACTION_NOTIFICATIONS, REACTION_GUIDANCE,
  SOUL_PATH, MEMORY_PATH, HEARTBEAT_PATH, MEMORY_DIR, SKILLS_DIR, DB_PATH,
  SECRETS_BLOCKED, CONFIRM_REQUIRED, TOOL_RATE_LIMITS, TOOL_STATUS_MAP,
  HARD_MAX_TOOL_RESULT_CHARS, MAX_TOOL_RESULT_CONTEXT_SHARE, MIN_KEEP_CHARS, MODEL_CONTEXT_CHARS,
  log, localTimestamp, localDateStr, normalizeSecret,
  getOwnerId, setOwnerId, // getter/setter for mutable OWNER_ID
};
```

**Dependencies:** None (this is the root).

---

### 2. `security.js` — Security Helpers & Prompt Injection Defense (~150 lines)

**Responsibility:** Redact secrets from logs, validate workspace paths, detect/wrap untrusted external content.

| What moves | Current lines |
|------------|---------------|
| `redactSecrets()` | L140–156 |
| `safePath()` | L159–169 |
| `INJECTION_PATTERNS` | L176–187 |
| `normalizeWhitespace()` | L190–193 |
| `detectSuspiciousPatterns()` | L196–204 |
| `sanitizeBoundaryMarkers()` | L207–216 |
| `sanitizeBoundarySource()` | L219–222 |
| `wrapExternalContent()` | L225–243 |
| `wrapSearchResults()` | L250–272 |

**Needs from config:** `BRIDGE_TOKEN`, `log()`, `workDir`

**Exports:**
```js
module.exports = {
  redactSecrets, safePath,
  normalizeWhitespace, detectSuspiciousPatterns,
  sanitizeBoundaryMarkers, sanitizeBoundarySource,
  wrapExternalContent, wrapSearchResults,
};
```

---

### 3. `bridge.js` — Android Bridge HTTP Client (~50 lines)

**Responsibility:** HTTP calls to the local Android bridge on port 8765.

| What moves | Current lines |
|------------|---------------|
| `androidBridgeCall()` | L5736–5779 |

**Needs from config:** `BRIDGE_TOKEN`, `log()`

**Exports:**
```js
module.exports = { androidBridgeCall };
```

---

### 4. `web.js` — HTTP Helpers, Web Fetch, Search Providers (~350 lines)

**Responsibility:** Core HTTP client, web cache, HTML-to-markdown, search providers (Brave/Perplexity/DDG), URL fetching with SSRF protection.

| What moves | Current lines |
|------------|---------------|
| `httpRequest()` | L1618–1637 |
| Web cache: `webCache`, `cacheGet()`, `cacheSet()` | L1644–1665 |
| `decodeEntities()`, `stripTags()`, `htmlToMarkdown()` | L1669–1713 |
| `searchBrave()` | L1720–1744 |
| `searchPerplexity()` | L1746–1781 |
| `searchDDG()` | L1783–1835 |
| `searchDDGLite()` | L1838–1884 |
| `webFetch()` | L1888–1955 |
| `BRAVE_FRESHNESS_VALUES`, `PERPLEXITY_RECENCY_MAP` | L1717–1718 |

**Needs from config:** `config` (API keys), `USER_AGENT`, `log()`

**Exports:**
```js
module.exports = {
  httpRequest, cacheGet, cacheSet,
  decodeEntities, stripTags, htmlToMarkdown,
  searchBrave, searchPerplexity, searchDDG, searchDDGLite,
  webFetch,
  BRAVE_FRESHNESS_VALUES, PERPLEXITY_RECENCY_MAP,
};
```

---

### 5. `telegram.js` — Telegram API, File Downloads, Message Formatting (~450 lines)

**Responsibility:** All Telegram Bot API interaction — sending/receiving messages, file uploads/downloads, HTML formatting.

| What moves | Current lines |
|------------|---------------|
| `telegram()` | L1961–1969 |
| `telegramSendFile()` | L1981–2038 |
| `detectTelegramFileType()` | L2041–2051 |
| `extractMedia()` | L2063–2121 |
| `downloadTelegramFile()` | L2124–2239 |
| `cleanResponse()` | L2243–2261 |
| `toTelegramHtml()` | L2264–2283 |
| `sendMessage()` | L2285–2344 |
| `sendTyping()`, `sendStatusMessage()`, `deleteStatusMessage()` | L2346–2366 |
| `deferStatus()` | L2370–2389 |
| `recordSentMessage()` + `sentMessageCache` | L8068–8095 |
| `MEDIA_DIR`, `MAX_FILE_SIZE`, `MAX_IMAGE_BASE64`, `MAX_IMAGE_SIZE` | L2057–2060 |

**Needs from config:** `BOT_TOKEN`, `workDir`, `log()`

**Exports:**
```js
module.exports = {
  telegram, telegramSendFile, detectTelegramFileType,
  extractMedia, downloadTelegramFile,
  cleanResponse, toTelegramHtml,
  sendMessage, sendTyping, sendStatusMessage, deleteStatusMessage,
  deferStatus, recordSentMessage,
  MEDIA_DIR, MAX_FILE_SIZE, MAX_IMAGE_BASE64, MAX_IMAGE_SIZE,
  sentMessageCache,
};
```

---

### 6. `memory.js` — Soul, Memory, Heartbeat, Search, Indexing (~400 lines)

**Responsibility:** All workspace memory operations — loading soul/identity/user files, memory read/write/search, heartbeat updates, memory file indexing into SQL.js chunks.

| What moves | Current lines |
|------------|---------------|
| `DEFAULT_SOUL` constant | L451–510 |
| `loadSoul()`, `loadBootstrap()`, `loadIdentity()`, `loadUser()` | L512–545 |
| `loadMemory()`, `saveMemory()` | L547–557 |
| `getDailyMemoryPath()`, `loadDailyMemory()`, `appendDailyMemory()` | L559–578 |
| `STOP_WORDS`, `searchMemory()` | L581–677 |
| `updateHeartbeat()` + heartbeat interval | L679–694 |
| `indexMemoryFiles()` | L8362–8438 |
| `chunkMarkdown()` | L8441–8491 |
| `BOOTSTRAP_PATH`, `IDENTITY_PATH`, `USER_PATH` | L447–449 |

**Needs from config:** `SOUL_PATH`, `MEMORY_PATH`, `HEARTBEAT_PATH`, `MEMORY_DIR`, `workDir`, `log()`, `localTimestamp()`, `localDateStr()`
**Needs from database:** `db` reference (for `searchMemory()` and `indexMemoryFiles()`)

**Exports:**
```js
module.exports = {
  DEFAULT_SOUL,
  loadSoul, loadBootstrap, loadIdentity, loadUser,
  loadMemory, saveMemory,
  getDailyMemoryPath, loadDailyMemory, appendDailyMemory,
  searchMemory, updateHeartbeat,
  indexMemoryFiles, chunkMarkdown,
  setDb, // inject db reference
};
```

---

### 7. `skills.js` — Skills System (~400 lines)

**Responsibility:** Parse SKILL.md files (YAML frontmatter + legacy format), load skill directories, match skills to messages, build skills section for system prompt.

| What moves | Current lines |
|------------|---------------|
| `parseYamlFrontmatter()`, `tryJsonParse()`, `toArray()`, `parseYamlLines()` | L1264–1376 |
| `parseSkillFile()` | L1378–1492 |
| `validateSkillFormat()` | L1495–1508 |
| `loadSkills()` | L1510–1560 |
| `findMatchingSkills()` | L1562–1582 |
| `buildSkillsSection()` | L1584–1609 |
| `cachedSkills` | L1612 |

**Needs from config:** `SKILLS_DIR`, `log()`

**Exports:**
```js
module.exports = {
  parseSkillFile, loadSkills, findMatchingSkills, buildSkillsSection,
  cachedSkills,
};
```

---

### 8. `cron.js` — Cron/Scheduling System (~520 lines)

**Responsibility:** Scheduled jobs — one-shot reminders, recurring intervals. Persistence to JSON, timer management, natural language time parsing.

| What moves | Current lines |
|------------|---------------|
| `CRON_STORE_PATH`, `CRON_RUN_LOG_DIR`, `MAX_TIMEOUT_MS` | L707–709 |
| `loadCronStore()`, `saveCronStore()` | L712–759 |
| `appendCronRunLog()` | L763–784 |
| `generateJobId()` | L788–790 |
| `computeNextRunAtMs()` | L794–816 |
| `parseTimeExpression()` | L820–909 |
| `cronService` object (full) | L913–1212 |

**Needs from config:** `workDir`, `log()`, `localTimestamp()`, `getOwnerId()`
**Needs injected:** `sendMessage()` from telegram (for reminder delivery), `formatDuration()` from utils

**Exports:**
```js
module.exports = {
  cronService, parseTimeExpression,
  init(deps) { /* inject sendMessage, formatDuration */ },
};
```

---

### 9. `solana.js` — Solana RPC + Jupiter DEX + Wallet (~830 lines)

**Responsibility:** All blockchain interaction — Solana RPC calls, base58 encoding, transaction building, Jupiter token resolution/quotes/swaps/prices/triggers/DCA, wallet management.

| What moves | Current lines |
|------------|---------------|
| `SOLANA_RPC_URL`, `solanaRpc()` | L5896–5943 |
| `base58Decode()`, `base58Encode()` | L5946–5979 |
| `buildSolTransferTx()` | L5982–6014 |
| `jupiterTokenCache` + token resolution | L6020–6377 |
| `KNOWN_PROGRAM_NAMES`, `TRUSTED_PROGRAMS`, `refreshJupiterProgramLabels()` | L6036–6166 |
| `jupiterApiRequest()` | L6167–6240 |
| `validateSolanaAddress()`, `parseLamports()` | L6241–6280 |
| `warmWalletConnection()`, `getWalletAddress()` | L6282–6377 |
| `jupiterQuote()` | L6379–6409 |
| `verifyJupiterTransaction()` | L6410–6530 |
| `readCompactU16()` | L6531–6544 |
| `jupiterUltraOrder()`, `jupiterUltraExecute()` | L6545–6604 |
| `jupiterTriggerExecute()`, `jupiterRecurringExecute()` | L6605–6650 |
| `jupiterPrice()` | L6651–6676 |

**Needs from config:** `config` (jupiterApiKey), `log()`, `USER_AGENT`, `workDir`
**Needs from web:** `httpRequest()`
**Needs from security:** `wrapExternalContent()`
**Needs from bridge:** `androidBridgeCall()`

**Exports:**
```js
module.exports = {
  solanaRpc, base58Decode, base58Encode, buildSolTransferTx,
  resolveToken, jupiterQuote, jupiterPrice,
  jupiterUltraOrder, jupiterUltraExecute,
  jupiterTriggerExecute, jupiterRecurringExecute,
  verifyJupiterTransaction, validateSolanaAddress, parseLamports,
  warmWalletConnection, getWalletAddress,
  refreshJupiterProgramLabels, jupiterApiRequest,
  TRUSTED_PROGRAMS, KNOWN_PROGRAM_NAMES,
};
```

---

### 10. `claude.js` — Claude API, Conversations, Sessions, System Prompt (~960 lines)

**Responsibility:** Claude API calls (with retry/mutex/rate-limit), conversation history, session summaries, system prompt construction, usage/health state tracking, vision analysis.

| What moves | Current lines |
|------------|---------------|
| `conversations`, `MAX_HISTORY`, `sessionStartedAt` | L6730–6733 |
| Session tracking state + constants | L6736–6747 |
| `getConversation()`, `addToConversation()`, `clearConversation()` | L6749–6767 |
| Slug generator + `generateSlug()` | L6769–6782 |
| `generateSessionSummary()`, `saveSessionSummary()` | L6784–7263 |
| `reportUsage()` | L7264–7287 |
| `classifyApiError()` | L7298–7332 |
| `claudeApiCall()` | L7334–7486 |
| `chat()` (tool-use loop) | L7488–7682 |
| `buildSystemBlocks()` | L6871–~7260 |
| `writeClaudeUsageState()` | L5828–5836 |
| `agentHealth` + `writeAgentHealthFile()` + `updateAgentHealth()` | L5844–5890 |
| `visionAnalyzeImage()` | L5781–5822 |
| `truncateToolResult()` | L422–439 |

**Needs from config:** `MODEL`, `ANTHROPIC_KEY`, `AUTH_TYPE`, `getOwnerId()`, paths, `log()`, `localTimestamp()`, `localDateStr()`
**Needs from telegram:** `sendTyping()`
**Needs from memory:** `loadSoul()`, `loadBootstrap()`, `loadIdentity()`, `loadUser()`, `loadMemory()`, `loadDailyMemory()`
**Needs from skills:** `findMatchingSkills()`, `loadSkills()`, `buildSkillsSection()`
**Needs from database:** `db` reference, `markDbSummaryDirty()`
**Needs injected:** `executeTool()` from tools (circular — see below)

**Exports:**
```js
module.exports = {
  chat, buildSystemBlocks, claudeApiCall, visionAnalyzeImage,
  getConversation, addToConversation, clearConversation,
  getSessionTrack, sessionTracking, conversations,
  generateSessionSummary, saveSessionSummary,
  classifyApiError, reportUsage, truncateToolResult,
  writeClaudeUsageState, updateAgentHealth, agentHealth,
  MIN_MESSAGES_FOR_SUMMARY,
  setExecuteTool, // inject to break circular dep
  setDb,          // inject db reference
};
```

---

### 11. `tools.js` — TOOLS Array + executeTool() (~3,350 lines)

**Responsibility:** Tool definitions (schemas) and the `executeTool()` switch statement that dispatches all tool calls.

| What moves | Current lines |
|------------|---------------|
| `TOOLS` array (all tool definitions) | L2395–~3038 |
| `executeTool()` (entire switch) | L3040–5732 |
| `formatConfirmationMessage()` | L325–349 |
| `requestConfirmation()` | L352–392 |
| `pendingConfirmations`, `lastToolUseTime` | L300–301 |

**Needs from config:** All constants
**Needs from:** security, memory, cron, skills, web, telegram, solana, claude (vision), bridge, database

**Exports:**
```js
module.exports = {
  TOOLS, executeTool,
  formatConfirmationMessage, requestConfirmation,
  pendingConfirmations, lastToolUseTime,
};
```

> **Future split:** `tools.js` at 3,350 lines is still large. A follow-up pass could split `executeTool()` by domain into `tools/web.js`, `tools/memory.js`, `tools/solana.js`, `tools/android.js`, etc. — each exporting a handler map that tools.js merges.

---

### 12. `database.js` — SQL.js Initialization, Persistence, Stats Server (~370 lines)

**Responsibility:** Initialize WASM-based SQLite, create tables, periodic saves, stats HTTP server, graceful shutdown.

| What moves | Current lines |
|------------|---------------|
| `db` variable | L8254 |
| `initDatabase()` | L8256–8335 |
| `saveDatabase()` | L8493–8505 |
| `gracefulShutdown()` | L8339–8360 |
| `getDbSummary()` | L8513–8583 |
| `writeDbSummaryFile()`, `markDbSummaryDirty()` | L8586–8597 |
| Stats HTTP server | L8599–8616 |

**Needs from config:** `DB_PATH`, `workDir`, `log()`, `localTimestamp()`, `localDateStr()`
**Needs injected:** `indexMemoryFiles()` from memory (for shutdown), `saveSessionSummary()` from claude (for shutdown)

**Exports:**
```js
module.exports = {
  getDb,       // getter for db reference
  initDatabase, saveDatabase,
  gracefulShutdown,
  getDbSummary, writeDbSummaryFile, markDbSummaryDirty,
  startStatsServer,
};
```

---

### `main.js` (reduced orchestrator) — ~200 lines

**What stays:**
- `require()` all modules
- Wire dependencies (inject `executeTool` into claude, inject `sendMessage` into cron, etc.)
- Directory creation (`MEMORY_DIR`, `SKILLS_DIR`)
- Startup sequence: `telegram('getMe')` → `initDatabase()` → `indexMemoryFiles()` → `poll()` → `startCron()` → MCP init → timers
- Polling loop: `poll()`, `enqueueMessage()`, `chatQueues`
- `handleMessage()` — message processing pipeline
- `handleCommand()` — `/start`, `/help`, `/status`, `/reset`, `/new`, `/soul`, `/memory`, `/skills`
- `handleReactionUpdate()` — reaction processing
- Confirmation interception in polling loop
- `lastIncomingMessages` map

---

## Circular Dependency Analysis

### Primary Risk: `claude.js` ↔ `tools.js`

```
claude.js:chat()  ──calls──►  tools.js:executeTool()
tools.js:executeTool()  ──calls──►  claude.js:visionAnalyzeImage()
tools.js:executeTool()  ──calls──►  claude.js:claudeApiCall()
```

**Solution — Dependency Injection:**
```js
// main.js (wiring)
const claude = require('./claude');
const tools = require('./tools');

// Break the cycle: inject executeTool into claude after both are loaded
claude.setExecuteTool(tools.executeTool);
// tools.js imports claude directly for vision/API calls (no cycle because
// claude doesn't require tools at module load time)
```

### Secondary: `cron.js` → `telegram.js`

`cronService._executeJob()` calls `sendMessage()` for reminder delivery.

**Solution:** Inject at init time:
```js
const cron = require('./cron');
const telegram = require('./telegram');
cron.init({ sendMessage: telegram.sendMessage });
```

### Tertiary: `database.js` → `memory.js` + `claude.js`

`gracefulShutdown()` calls `indexMemoryFiles()` and `saveSessionSummary()`.

**Solution:** Inject at init time or move shutdown logic to `main.js`.

---

## Shared State Registry

| State | Current Location | Proposed Owner | Access Pattern |
|-------|-----------------|----------------|----------------|
| `OWNER_ID` | Mutable global `let` | `config.js` getter/setter | Read everywhere, written once |
| `db` | Global `let` | `database.js` getter | Read by memory, claude, tools |
| `conversations` | Global `Map` | `claude.js` (encapsulated) | R/W by claude, read by main |
| `pendingConfirmations` | Global `Map` | `tools.js` or `main.js` | R/W by polling + tools |
| `lastIncomingMessages` | Global `Map` | `main.js` | R/W by polling + system prompt |
| `sentMessageCache` | Global `Map` | `telegram.js` (encapsulated) | R/W by telegram + system prompt |
| `chatQueues` | Global `Map` | `main.js` | R/W by polling only |
| `apiCallInFlight` | Global `let` | `claude.js` (encapsulated) | R/W by claudeApiCall only |
| `cachedSkills` | Global `let` | `skills.js` (encapsulated) | R/W by skills only |
| `webCache` | Global `Map` | `web.js` (encapsulated) | R/W by web only |
| `cronService.store` | Object property | `cron.js` (encapsulated) | R/W by cron only |
| `agentHealth` | Global object | `claude.js` (encapsulated) | R/W by claude only |
| `jupiterTokenCache` | Global object | `solana.js` (encapsulated) | R/W by solana only |

---

## Migration Order

Split one module at a time, test after each. Least-coupled modules first.

| Order | Module | Risk | Rationale |
|-------|--------|------|-----------|
| 1 | `config.js` | **Zero** | Pure constants, no dependencies on other modules |
| 2 | `security.js` | **Minimal** | Only depends on config |
| 3 | `bridge.js` | **Minimal** | 50 lines, only depends on config |
| 4 | `web.js` | **Low** | Self-contained HTTP/search, depends on config only |
| 5 | `telegram.js` | **Low** | Depends on config + fs, no reverse deps issue |
| 6 | `memory.js` | **Low** | Depends on config + db ref (injected) |
| 7 | `skills.js` | **Low** | Depends on config only |
| 8 | `cron.js` | **Medium** | Needs `sendMessage` injected from telegram |
| 9 | `solana.js` | **Medium** | Large but self-contained; needs web + bridge |
| 10 | `database.js` | **Medium** | Needs careful db reference sharing |
| 11 | `claude.js` + `tools.js` | **High** | Circular dependency, biggest refactor — do together, last |

---

## Size Breakdown

| Module | Est. Lines | % of Total |
|--------|-----------|-----------|
| `config.js` | ~250 | 3% |
| `security.js` | ~150 | 2% |
| `bridge.js` | ~50 | 1% |
| `web.js` | ~350 | 4% |
| `telegram.js` | ~450 | 5% |
| `memory.js` | ~400 | 5% |
| `skills.js` | ~400 | 5% |
| `cron.js` | ~520 | 6% |
| `solana.js` | ~830 | 10% |
| `database.js` | ~370 | 4% |
| `claude.js` | ~960 | 11% |
| `tools.js` | ~3,350 | 39% |
| `main.js` (orchestrator) | ~200 | 2% |
| **Total** | **~8,280** | — |

---

## Testing Strategy

After each module extraction:
1. **Smoke test:** Bot starts, connects to Telegram, responds to a message
2. **Tool test:** Send a message that triggers a tool (e.g., "what time is it" for `datetime`)
3. **Cron test:** Create and cancel a reminder
4. **Memory test:** Save and search memory

No unit test framework exists — testing is manual via Telegram interaction on device.

---

## Future Follow-Up

`tools.js` at ~3,350 lines is still the largest module. A second pass could split `executeTool()` by domain:

```
tools/
  index.js        — TOOLS array + executeTool() dispatcher
  web-tools.js    — web_search, web_fetch handlers
  memory-tools.js — memory_save, memory_read, memory_search, etc.
  file-tools.js   — read, write, edit, ls, delete
  solana-tools.js — solana_balance, solana_send, solana_swap, etc.
  jupiter-tools.js — jupiter_trigger_*, jupiter_dca_*, jupiter_token_search
  android-tools.js — android_sms, android_call, android_location, etc.
  cron-tools.js   — cron_create, cron_list, cron_cancel, cron_status
```

Each sub-module exports a `{ [toolName]: handler }` map. `index.js` merges them into the switch.
