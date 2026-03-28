# Split main.js + Rename claude.js Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Split main.js from 1,447 lines to ~400 lines by extracting message handling into `message-handler.js`, and rename `claude.js` to `ai.js` for provider-agnostic naming.

**Architecture:** Extract `handleCommand()`, `handleMessage()`, and `handleReactionUpdate()` into a new `message-handler.js` module using the same `init()` dependency injection pattern proven in `tools/index.js`. Rename `claude.js` to `ai.js` with 4 require path updates. Zero behavior changes.

**Tech Stack:** Node.js 18 (nodejs-mobile), no new dependencies.

**Spec:** `docs/superpowers/specs/2026-03-28-split-mainjs-design.md`

---

## File Structure

### New Files

| File | Responsibility |
|------|----------------|
| `app/src/main/assets/nodejs-project/message-handler.js` | handleCommand, handleMessage, handleReactionUpdate — all user message processing |

### Renamed Files

| From | To |
|------|-----|
| `app/src/main/assets/nodejs-project/claude.js` | `app/src/main/assets/nodejs-project/ai.js` |

### Modified Files

| File | Changes |
|------|---------|
| `app/src/main/assets/nodejs-project/main.js` | Remove 3 functions (~600 lines), add require('./message-handler') + init() call, update require('./claude') to require('./ai') |
| `app/src/main/assets/nodejs-project/providers/index.js:34` | `require('./claude')` to `require('./ai')` |
| `app/src/main/assets/nodejs-project/tools/session.js:10` | `require('../claude')` to `require('../ai')` |
| `app/src/main/assets/nodejs-project/tools/android.js:12` | `require('../claude')` to `require('../ai')` |

---

## Task 1: Rename `claude.js` to `ai.js`

**Files:**
- Rename: `app/src/main/assets/nodejs-project/claude.js` → `ai.js`
- Modify: `app/src/main/assets/nodejs-project/main.js:134`
- Modify: `app/src/main/assets/nodejs-project/providers/index.js:34`
- Modify: `app/src/main/assets/nodejs-project/tools/session.js:10`
- Modify: `app/src/main/assets/nodejs-project/tools/android.js:12`

- [ ] **Step 1: Rename the file**

```bash
cd app/src/main/assets/nodejs-project
git mv claude.js ai.js
```

- [ ] **Step 2: Update require in main.js**

In `main.js`, line 134, change:
```javascript
} = require('./claude');
```
to:
```javascript
} = require('./ai');
```

Also update the section comment at line 123 from:
```javascript
// CLAUDE (extracted to claude.js — BAT-203)
```
to:
```javascript
// AI ENGINE (claude.js → ai.js — provider-agnostic rename)
```

- [ ] **Step 3: Update require in providers/index.js**

In `providers/index.js`, line 34, change:
```javascript
register(require('./claude'));
```
to:
```javascript
register(require('./ai'));
```

Note: `providers/claude.js` (the Claude-specific adapter) keeps its name — only the engine file is renamed.

- [ ] **Step 4: Update require in tools/session.js**

In `tools/session.js`, line 10, change:
```javascript
const { conversations } = require('../claude');
```
to:
```javascript
const { conversations } = require('../ai');
```

- [ ] **Step 5: Update require in tools/android.js**

In `tools/android.js`, line 12, change:
```javascript
const { visionAnalyzeImage } = require('../claude');
```
to:
```javascript
const { visionAnalyzeImage } = require('../ai');
```

- [ ] **Step 6: Syntax check all modified files**

```bash
node --check app/src/main/assets/nodejs-project/ai.js
node --check app/src/main/assets/nodejs-project/main.js
node --check app/src/main/assets/nodejs-project/providers/index.js
node --check app/src/main/assets/nodejs-project/tools/session.js
node --check app/src/main/assets/nodejs-project/tools/android.js
```

Expected: All pass with no output (exit code 0).

- [ ] **Step 7: Verify no remaining references to './claude' (except providers/claude.js which is the adapter)**

```bash
grep -rn "require.*['\"].*claude['\"]" app/src/main/assets/nodejs-project/ --include="*.js" | grep -v "providers/claude" | grep -v node_modules
```

Expected: No output (zero remaining references to the old path).

- [ ] **Step 8: Commit**

```bash
git add app/src/main/assets/nodejs-project/ai.js app/src/main/assets/nodejs-project/main.js app/src/main/assets/nodejs-project/providers/index.js app/src/main/assets/nodejs-project/tools/session.js app/src/main/assets/nodejs-project/tools/android.js
git commit -m "refactor: rename claude.js → ai.js (provider-agnostic) (#296)"
```

---

## Task 2: Create `message-handler.js` skeleton with init()

**Files:**
- Create: `app/src/main/assets/nodejs-project/message-handler.js`

- [ ] **Step 1: Create the module with init() pattern and empty function stubs**

Create `app/src/main/assets/nodejs-project/message-handler.js`:

```javascript
// message-handler.js — Command dispatch, message processing, reaction handling
// Extracted from main.js (#296). Uses init() dependency injection (same pattern as tools/index.js).

const fs = require('fs');

let deps = {};

function init(d) {
    deps = d;
}

// Functions will be moved here in Task 3

module.exports = {
    init,
};
```

- [ ] **Step 2: Syntax check**

```bash
node --check app/src/main/assets/nodejs-project/message-handler.js
```

Expected: Pass.

- [ ] **Step 3: Commit**

```bash
git add app/src/main/assets/nodejs-project/message-handler.js
git commit -m "refactor: add message-handler.js skeleton with init() (#296)"
```

---

## Task 3: Move handleCommand() to message-handler.js

**Files:**
- Modify: `app/src/main/assets/nodejs-project/message-handler.js`
- Modify: `app/src/main/assets/nodejs-project/main.js`

- [ ] **Step 1: Copy handleCommand() from main.js (lines 153-494) into message-handler.js**

Copy the entire `handleCommand()` function (lines 153-494 of main.js) into message-handler.js, between the `init()` function and `module.exports`.

Replace all direct references to imported functions/variables with `deps.` prefix. The function references these dependencies:

| Original reference | Replace with |
|---|---|
| `sendMessage(...)` | `deps.sendMessage(...)` |
| `chat(...)` | `deps.chat(...)` |
| `loadBootstrap()` | `deps.loadBootstrap()` |
| `loadIdentity()` | `deps.loadIdentity()` |
| `loadSoul()` | `deps.loadSoul()` |
| `loadMemory()` | `deps.loadMemory()` |
| `loadSkills()` | `deps.loadSkills()` |
| `loadCheckpoint(...)` | `deps.loadCheckpoint(...)` |
| `listCheckpoints(...)` | `deps.listCheckpoints(...)` |
| `saveCheckpoint(...)` | `deps.saveCheckpoint(...)` |
| `deleteCheckpoint(...)` | `deps.deleteCheckpoint(...)` |
| `getConversation(...)` | `deps.getConversation(...)` |
| `clearConversation(...)` | `deps.clearConversation(...)` |
| `clearActiveTask(...)` | `deps.clearActiveTask(...)` |
| `saveSessionSummary(...)` | `deps.saveSessionSummary(...)` |
| `executeTool(...)` | `deps.executeTool(...)` |
| `downloadTelegramFile(...)` | `deps.downloadTelegramFile(...)` |
| `addToConversation(...)` | `deps.addToConversation(...)` |
| `handleQuickCommand(...)` | `deps.handleQuickCommand(...)` |
| `cronService` | `deps.cronService` |
| `ANTHROPIC_KEY` | `deps.ANTHROPIC_KEY` |
| `AUTH_TYPE` | `deps.AUTH_TYPE` |
| `MODEL` | `deps.MODEL` |
| `AGENT_NAME` | `deps.AGENT_NAME` |
| `PROVIDER` | `deps.PROVIDER` |
| `localTimestamp` | `deps.localTimestamp` |
| `log(...)` | `deps.log(...)` |
| `getOwnerId()` | `deps.getOwnerId()` |
| `workDir` | `deps.workDir` |
| `config` | `deps.config` |
| `redactSecrets(...)` | `deps.redactSecrets(...)` |
| `MIN_MESSAGES_FOR_SUMMARY` | `deps.MIN_MESSAGES_FOR_SUMMARY` |

Keep `fs` as a direct require (already at top of file).

- [ ] **Step 2: Export handleCommand from message-handler.js**

Update `module.exports`:
```javascript
module.exports = {
    init,
    handleCommand,
};
```

- [ ] **Step 3: In main.js, remove handleCommand() (lines 150-494)**

Delete the section comment and entire function from line 150 (`// ============================================================================`) through line 494 (`}`).

Replace with:
```javascript
// ============================================================================
// MESSAGE HANDLER (extracted to message-handler.js — #296)
// ============================================================================

const { init: initMessageHandler, handleCommand, handleMessage, handleReactionUpdate } = require('./message-handler');
```

Note: `handleMessage` and `handleReactionUpdate` are not exported yet — that's Task 4 and 5. The require will work because JS destructuring silently ignores missing keys (they'll be `undefined` until Task 4/5 add them).

Wait — that would break calls to handleMessage before Task 4. Instead, add the require now but only destructure `handleCommand`:

```javascript
const messageHandler = require('./message-handler');
const { handleCommand } = messageHandler;
```

We'll add `handleMessage` and `handleReactionUpdate` destructuring in Tasks 4 and 5.

- [ ] **Step 4: Syntax check both files**

```bash
node --check app/src/main/assets/nodejs-project/message-handler.js
node --check app/src/main/assets/nodejs-project/main.js
```

Expected: Both pass.

- [ ] **Step 5: Commit**

```bash
git add app/src/main/assets/nodejs-project/message-handler.js app/src/main/assets/nodejs-project/main.js
git commit -m "refactor: move handleCommand() to message-handler.js (#296)"
```

---

## Task 4: Move handleMessage() to message-handler.js

**Files:**
- Modify: `app/src/main/assets/nodejs-project/message-handler.js`
- Modify: `app/src/main/assets/nodejs-project/main.js`

- [ ] **Step 1: Copy handleMessage() from main.js (lines ~496-744) into message-handler.js**

Copy the section comment and entire function into message-handler.js, after handleCommand().

Replace all direct references with `deps.` prefix. Additional dependencies beyond those in handleCommand():

| Original reference | Replace with |
|---|---|
| `sendTyping(...)` | `deps.sendTyping(...)` |
| `extractMedia(...)` | `deps.extractMedia(...)` |
| `createStatusReactionController(...)` | `deps.createStatusReactionController(...)` |
| `MAX_FILE_SIZE` | `deps.MAX_FILE_SIZE` |
| `MAX_IMAGE_SIZE` | `deps.MAX_IMAGE_SIZE` |
| `androidBridgeCall(...)` | `deps.androidBridgeCall(...)` |
| `setOwnerId(...)` | `deps.setOwnerId(...)` |
| `debugLog` | `deps.debugLog` |
| `pendingConfirmations` | `deps.pendingConfirmations` |
| `lastToolUseTime` | `deps.lastToolUseTime` |
| `requestConfirmation(...)` | `deps.requestConfirmation(...)` |
| `REACTION_NOTIFICATIONS` | `deps.REACTION_NOTIFICATIONS` |
| `MEMORY_DIR` | `deps.MEMORY_DIR` |
| `wrapExternalContent(...)` | `deps.wrapExternalContent(...)` |

Also: `OWNER_ID` is a mutable local variable in main.js. In message-handler.js, replace reads of `OWNER_ID` with `deps.getOwnerId()` and writes with `deps.setOwnerId(value)`. The `let OWNER_ID` variable stays in main.js.

handleMessage also calls `handleCommand()` internally — since both are now in the same file, this is a direct call (no deps prefix needed).

- [ ] **Step 2: Export handleMessage from message-handler.js**

Update `module.exports`:
```javascript
module.exports = {
    init,
    handleCommand,
    handleMessage,
};
```

- [ ] **Step 3: In main.js, remove handleMessage() (lines ~496-744)**

Delete the section comment and entire function.

Update the require to also destructure handleMessage:
```javascript
const messageHandler = require('./message-handler');
const { handleCommand, handleMessage } = messageHandler;
```

- [ ] **Step 4: Syntax check both files**

```bash
node --check app/src/main/assets/nodejs-project/message-handler.js
node --check app/src/main/assets/nodejs-project/main.js
```

Expected: Both pass.

- [ ] **Step 5: Commit**

```bash
git add app/src/main/assets/nodejs-project/message-handler.js app/src/main/assets/nodejs-project/main.js
git commit -m "refactor: move handleMessage() to message-handler.js (#296)"
```

---

## Task 5: Move handleReactionUpdate() to message-handler.js

**Files:**
- Modify: `app/src/main/assets/nodejs-project/message-handler.js`
- Modify: `app/src/main/assets/nodejs-project/main.js`

- [ ] **Step 1: Copy handleReactionUpdate() from main.js (lines ~746-792) into message-handler.js**

Copy the section comment and entire function.

This function accesses these dependencies:

| Original reference | Replace with |
|---|---|
| `addToConversation(...)` | `deps.addToConversation(...)` |
| `log(...)` | `deps.log(...)` |
| `OWNER_ID` (read) | `deps.getOwnerId()` |
| `REACTION_NOTIFICATIONS` | `deps.REACTION_NOTIFICATIONS` |
| `chatQueues` | `deps.chatQueues` |

`chatQueues` is a Map in main.js. It must be passed by reference in init() so both main.js and message-handler.js operate on the same Map instance.

- [ ] **Step 2: Export handleReactionUpdate from message-handler.js**

Update `module.exports`:
```javascript
module.exports = {
    init,
    handleCommand,
    handleMessage,
    handleReactionUpdate,
};
```

- [ ] **Step 3: In main.js, remove handleReactionUpdate() (lines ~746-792)**

Delete the section comment and entire function.

Update the require to destructure all three:
```javascript
const messageHandler = require('./message-handler');
const { handleCommand, handleMessage, handleReactionUpdate } = messageHandler;
```

- [ ] **Step 4: Syntax check both files**

```bash
node --check app/src/main/assets/nodejs-project/message-handler.js
node --check app/src/main/assets/nodejs-project/main.js
```

Expected: Both pass.

- [ ] **Step 5: Commit**

```bash
git add app/src/main/assets/nodejs-project/message-handler.js app/src/main/assets/nodejs-project/main.js
git commit -m "refactor: move handleReactionUpdate() to message-handler.js (#296)"
```

---

## Task 6: Wire init() in main.js startup

**Files:**
- Modify: `app/src/main/assets/nodejs-project/main.js`

- [ ] **Step 1: Add initMessageHandler() call in the startup block**

In main.js, after all modules are imported and before `poll()` is called, add the init call. Place it near the existing `setChatDeps()` and `setSendMessage()` wiring calls (around line ~1170 area after extraction):

```javascript
// Wire message handler with its dependencies
initMessageHandler({
    // Config
    ANTHROPIC_KEY, AUTH_TYPE, MODEL, AGENT_NAME, PROVIDER,
    REACTION_NOTIFICATIONS, MEMORY_DIR,
    localTimestamp, log, debugLog,
    getOwnerId, setOwnerId,
    workDir, config,
    // Security
    redactSecrets, wrapExternalContent,
    // Telegram
    sendMessage, sendTyping, downloadTelegramFile,
    extractMedia, createStatusReactionController,
    MAX_FILE_SIZE, MAX_IMAGE_SIZE,
    // AI engine
    chat, getConversation, addToConversation, clearConversation,
    saveSessionSummary, MIN_MESSAGES_FOR_SUMMARY,
    clearActiveTask,
    // Tools
    executeTool, pendingConfirmations, lastToolUseTime, requestConfirmation,
    // Memory
    loadBootstrap, loadIdentity, loadSoul, loadMemory,
    // Skills
    loadSkills,
    // Task store
    loadCheckpoint, listCheckpoints, saveCheckpoint, deleteCheckpoint,
    // Quick actions
    handleQuickCommand,
    // Cron
    cronService,
    // Bridge
    androidBridgeCall,
    // Shared state (passed by reference — same Map instance)
    chatQueues,
});
```

Update the require at top to include `initMessageHandler`:
```javascript
const messageHandler = require('./message-handler');
const { handleCommand, handleMessage, handleReactionUpdate } = messageHandler;
const initMessageHandler = messageHandler.init;
```

- [ ] **Step 2: Syntax check**

```bash
node --check app/src/main/assets/nodejs-project/main.js
```

Expected: Pass.

- [ ] **Step 3: Commit**

```bash
git add app/src/main/assets/nodejs-project/main.js
git commit -m "refactor: wire message-handler.js init() with dependencies (#296)"
```

---

## Task 7: Full smoke test + line count verification

**Files:** None (verification only)

- [ ] **Step 1: Syntax check every JS file in the project**

```bash
find app/src/main/assets/nodejs-project -name "*.js" -not -name "*.min.js" -not -name "sql-wasm.js" | xargs -I{} node --check "{}"
```

Expected: All pass.

- [ ] **Step 2: Verify main.js line count**

```bash
wc -l app/src/main/assets/nodejs-project/main.js
```

Expected: ~750-850 lines (startup + wiring + polling + heartbeat + cron + auto-resume).

- [ ] **Step 3: Verify message-handler.js line count**

```bash
wc -l app/src/main/assets/nodejs-project/message-handler.js
```

Expected: ~650-700 lines (handleCommand + handleMessage + handleReactionUpdate + init).

- [ ] **Step 4: Verify no remaining references to './claude' (except providers/claude.js)**

```bash
grep -rn "require.*['\"].*claude['\"]" app/src/main/assets/nodejs-project/ --include="*.js" | grep -v "providers/claude" | grep -v node_modules
```

Expected: No output.

- [ ] **Step 5: Verify message-handler.js has no direct imports of extracted modules**

```bash
grep -n "require(" app/src/main/assets/nodejs-project/message-handler.js
```

Expected: Only `require('fs')` and `require('path')` (if needed). All other dependencies come through `deps`.

- [ ] **Step 6: Run dependency enumeration smoke test**

```bash
node -e "
const mh = require('./app/src/main/assets/nodejs-project/message-handler');
// init with a Proxy that logs accessed keys
const accessed = new Set();
const proxy = new Proxy({}, {
    get(target, prop) {
        accessed.add(prop);
        return (...args) => {}; // stub all functions
    }
});
mh.init(proxy);
// Verify exports
const exports = Object.keys(mh);
console.log('Exports:', exports);
const expected = ['init', 'handleCommand', 'handleMessage', 'handleReactionUpdate'];
const missing = expected.filter(e => !exports.includes(e));
if (missing.length) {
    console.log('MISSING EXPORTS:', missing);
    process.exit(1);
}
console.log('ALL EXPORTS PRESENT');
"
```

Expected: `Exports: [ 'init', 'handleCommand', 'handleMessage', 'handleReactionUpdate' ]` and `ALL EXPORTS PRESENT`.

- [ ] **Step 7: Commit (no changes — verification only)**

No commit needed if all checks pass. If any fixes were required, commit them:
```bash
git add -A
git commit -m "fix: address smoke test findings (#296)"
```
