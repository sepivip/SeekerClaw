# SAB-AUDIT-v1 — SeekerClaw Agent Self-Knowledge Audit

> **Date:** 2026-02-21
> **Scope:** Read-only audit of what the agent knows about itself at runtime
> **Method:** Full read of `buildSystemBlocks()` in claude.js, TOOLS array in tools.js, skill loading in skills.js, config injection in config.js/ConfigManager.kt, PLATFORM.md generation, workspace seed files

---

## Overall Scorecard

| Status | Count |
|--------|-------|
| ✅ KNOWS IT | 12 |
| ⚠️ PARTIAL | 6 |
| ❌ MISSING | 2 |

---

## 1. Identity

### ✅ Own name and version
The agent receives its name from `PLATFORM.md` (auto-generated every service start) and from `IDENTITY.md` (filled during bootstrap ritual).

**PLATFORM.md injection** (claude.js:462-476):
```
## Agent
- Name: {agentName}
- Model: {aiModel}
- Auth: {authLabel}
## Versions
- App: {appVersion} (build {appCode})
- OpenClaw: {openclawVersion}
- Node.js: {nodejsVersion}
```

If the bootstrap ritual hasn't happened, IDENTITY.md says `(not yet named)`. The app version, OpenClaw version, and Node.js version are all present via BuildConfig fields.

### ✅ Model it's running on
PLATFORM.md includes the model ID (e.g. `claude-sonnet-4-6`). Additionally, the system prompt includes model-specific behavioral guidance:

**Model Note** (claude.js, dynamic section):
```javascript
if (MODEL && MODEL.includes('haiku')) {
    lines.push('## Model Note');
    lines.push('You are running on a fast, lightweight model. Keep responses concise and focused.');
} else if (MODEL && MODEL.includes('opus')) {
    lines.push('## Model Note');
    lines.push('You are running on the most capable model. Take time for thorough analysis when needed.');
}
```

⚠️ **Minor gap:** No model note for Sonnet models. The agent gets the model ID in PLATFORM.md but no behavioral guidance when running Sonnet.

### ⚠️ Device/hardware it's deployed on — PARTIAL
PLATFORM.md includes device model, Android version, RAM, storage, battery, and permissions. **However**, the agent does NOT know:
- It's designed for the Solana Seeker phone specifically
- Why the Seeker is the primary target (stock Android, no aggressive battery kill)
- That OEM ROMs may kill background services

**What the agent sees** (PLATFORM.md):
```
## Device
- Model: {manufacturer} {deviceModel}
- Android: {androidVersion} (SDK {sdkVersion})
- RAM: {available} MB available / {total} MB total
- Storage: {used} GB used / {total} GB total
```

**What's missing:** No "you are designed for Solana Seeker" context. No awareness of device-specific behaviors.

### ❌ Who built it and why — MISSING
The system prompt says: `You are a personal assistant running inside SeekerClaw on Android.`

That's it. No mention of:
- Who created SeekerClaw
- What its purpose is ("turn a Solana Seeker into a 24/7 AI agent")
- That it's based on/compatible with OpenClaw
- That the user interacts primarily through Telegram

The agent learns its personality from SOUL.md, not from the system prompt. If a user asks "what is SeekerClaw?", the agent has no built-in answer.

---

## 2. Architecture

### ⚠️ How Node.js and Kotlin communicate — PARTIAL
The system prompt describes the bridge *implicitly* through android_* tool descriptions and the Runtime Limitations section:

**Runtime Limitations** (claude.js:588-594):
```
- Running inside nodejs-mobile on Android (Node.js runs as libnode.so via JNI, not a standalone binary)
- node/npm/npx are NOT available via shell_exec (no standalone node binary exists on this device)
```

The agent knows:
- It runs inside nodejs-mobile as libnode.so
- It can call android_* tools (which proxy to the bridge)
- The Android bridge exists on localhost:8765

The agent does NOT know:
- How the bridge auth works (per-boot random token in X-Bridge-Token header)
- That config.json is ephemeral (deleted 5 seconds after startup)
- That it's running in a separate `:node` process
- That restart means killing the entire process

### ❌ Difference between UI process and :node process — MISSING
Nothing in the system prompt mentions:
- Two separate Android processes (main app UI vs `:node` service)
- That the service has `START_STICKY` for auto-restart
- That the `:node` process is isolated and killed entirely on restart
- Wake lock behavior

### ✅ How the health monitoring system works
The heartbeat system is well-described to the agent:

**Heartbeats** (claude.js:557-566):
```
SeekerClaw sends you periodic heartbeat polls to check if anything needs attention.
During each heartbeat, read HEARTBEAT.md from your workspace and follow it strictly.
HEARTBEAT.md is your file — you can read it, edit it, and keep it organized.
If nothing needs attention, reply exactly: HEARTBEAT_OK
SeekerClaw discards HEARTBEAT_OK responses — they are never shown to the user.
```

⚠️ **Gap:** The agent knows about heartbeat *polls* (its side) but NOT about the Watchdog (Kotlin side) that monitors Node.js liveness. It doesn't know:
- Watchdog checks every 30s
- 2 missed checks = process kill
- 60s initial grace period
- Crash loop protection (3 crashes in 30s = stop)

### ⚠️ How Telegram polling works — PARTIAL
The agent knows it communicates via Telegram (tools like `telegram_send`, `telegram_send_file`, `telegram_react`, `telegram_delete`). The Telegram formatting section is detailed:

**Telegram Formatting** (claude.js:395-402):
```
In Telegram replies, do NOT use markdown headers (##, ###) — Telegram doesn't render them.
Use **bold text** for section titles instead.
Use emoji + bold for structure.
```

But the agent does NOT know:
- That it uses long-polling (not webhooks)
- What happens when polling disconnects
- How message flow works (user → Telegram API → polling → chat() → response → sendMessage)
- The message history limit (MAX_HISTORY = 20)

---

## 3. Capabilities

### ✅ Full tool list with what each does
56 built-in tools are defined in tools.js with detailed descriptions. The TOOLS array is passed directly via the Claude API `tools` parameter. Additionally, MCP tools are dynamically merged at runtime.

**Tool categories:**
- **Memory:** memory_save, memory_read, daily_note, memory_search, memory_get, memory_stats
- **Files:** read, write, edit, ls, delete
- **Skills:** skill_read, skill_install
- **Scheduling:** cron_create, cron_list, cron_cancel, cron_status
- **Web:** web_search, web_fetch
- **Telegram:** telegram_send, telegram_send_file, telegram_react, telegram_delete
- **Android:** android_battery, android_storage, android_clipboard_get/set, android_contacts_search, android_sms, android_call, android_location, android_tts, android_camera_capture, android_camera_check, android_apps_list, android_apps_launch
- **Solana/Jupiter:** solana_balance, solana_history, solana_address, solana_send, solana_price, solana_quote, solana_swap, jupiter_trigger_create/list/cancel, jupiter_dca_create/list/cancel, jupiter_token_search, jupiter_token_security, jupiter_wallet_holdings
- **Execution:** shell_exec, js_eval
- **Status:** datetime, session_status

All tools have accurate descriptions including parameters, return types, and constraints.

### ✅ Which tools are sandboxed and why
The system prompt clearly explains sandboxing for both execution tools:

**shell_exec** (claude.js:369):
```
Use shell_exec to run commands on the device. Sandboxed to workspace directory with
a predefined allowlist of common Unix utilities (ls, cat, grep, find, curl, etc.).
Note: node/npm/npx are NOT available. 30s timeout. No chaining, redirection, or
command substitution — one command at a time.
```

**js_eval** (claude.js:370):
```
Use js_eval to run JavaScript code inside the Node.js process. Supports async/await,
require(), and most Node.js built-ins (fs, path, http, crypto, etc. — child_process
and vm are blocked).
```

Additionally, confirmation-gated tools are documented (claude.js:444-449):
```
The following tools require explicit user confirmation before execution:
android_sms, android_call, jupiter_trigger_create, jupiter_dca_create.
```

The code also blocks reading `config.json`, `config.yaml`, and `seekerclaw.db` via `SECRETS_BLOCKED`.

### ✅ What it genuinely CANNOT do (and why)
The system prompt has two sections covering limitations:

**Environment Constraints** (claude.js:479-483):
```
- No browser or GUI — use Telegram for all user interaction.
- Battery-powered — avoid unnecessary long-running operations.
- Network may be unreliable — handle timeouts gracefully.
```

**Runtime Limitations** (claude.js:588-594):
```
- Running inside nodejs-mobile on Android (Node.js runs as libnode.so via JNI)
- node/npm/npx are NOT available via shell_exec
- js_eval runs JavaScript inside the Node.js process
- shell_exec is limited to common Unix utilities
- shell_exec: one command at a time, 30s timeout, no chaining
```

### ✅ How skills load and trigger
The system prompt has a semantic skill selection section:

**Skills (mandatory)** (claude.js:406-419):
```
Before replying: scan the <available_skills> list below.
- If exactly one skill clearly applies: use skill_read to load it, then follow its instructions.
- If multiple skills could apply: choose the most specific one.
- If none clearly apply: do not load any skill, just respond normally.

<available_skills>
{emoji} {name}: {description}
...
</available_skills>
```

The keyword trigger matching (skills.js:481-501) happens in the background — up to 2 skills are auto-matched and injected into the dynamic prompt block. The agent also has `skill_read` and `skill_install` tools with clear descriptions.

---

## 4. Configuration

### ⚠️ config.yaml vs agent_settings.json — what's in each — PARTIAL
The agent has **no direct knowledge** of the config file structure. Here's what actually exists:

| File | Contents | Agent Can Read? | Agent Knows About? |
|------|----------|-----------------|---------------------|
| `config.json` | All credentials, model, bridgeToken, API keys | ❌ BLOCKED | ❌ No |
| `config.yaml` | Not used (legacy reference) | ❌ BLOCKED | ❌ No |
| `agent_settings.json` | `{"heartbeatIntervalMinutes": N}` | ✅ (via fs) | ❌ Not told about it |
| `solana_wallet.json` | `{"publicKey": "...", "label": "..."}` | ✅ (via fs) | ❌ Not told about it |
| `PLATFORM.md` | Device, battery, permissions, versions, paths | ✅ Injected into prompt | ✅ Yes (implicitly) |

The agent knows config exists because it can see PLATFORM.md and uses tools that depend on config. But it has zero knowledge of the file structure, what fields exist, or how to troubleshoot config issues.

### ✅ Which settings the agent can change itself
The agent can modify:
- `SOUL.md`, `MEMORY.md`, `IDENTITY.md`, `USER.md`, `HEARTBEAT.md` (via write/edit tools)
- Skill files in `skills/` (via write/edit or skill_install)
- Daily memory files in `memory/` (via daily_note)
- Cron jobs in `cron/` (via cron_create/cancel)

It CANNOT modify:
- `config.json`, `config.yaml`, `seekerclaw.db` (SECRETS_BLOCKED)
- `agent_settings.json` (not explicitly blocked but not told about it)
- Android-side settings (no tool exists)

The system prompt says: "HEARTBEAT.md is your file — you can read it, edit it, and keep it organized." Similar implicit guidance exists for other workspace files.

### ✅ Which API keys are needed and what breaks without them
The system prompt documents this well for optional keys:

**Jupiter features** (claude.js:366):
```
If user tries these features without API key: explain the feature, then guide them to
get a free key at portal.jup.ag and add it in Settings > Configuration > Jupiter API Key.
```

**Web search** (claude.js:367):
```
web_search works out of the box — DuckDuckGo is the zero-config default. If a Brave API
key is configured, Brave is used automatically (better quality).
```

The Anthropic API key is never mentioned because the agent doesn't need to know — if it's missing, the service won't start at all (Kotlin-side guard).

### ✅ How to change model, heartbeat interval, etc.
The agent doesn't need to know this — these are Android UI settings. The agent correctly focuses on what it CAN do (read/write workspace files, use tools) rather than settings it has no control over.

---

## 5. Self-Diagnosis

### ✅ What to do if health goes stale
The Diagnostics section gives the agent self-diagnosis tools:

**Diagnostics** (claude.js:496-506):
```
Your debug log is at: {workDir}/node_debug.log
It records timestamped entries for: startup, API calls, tool executions (with errors),
message flow, Telegram polling, and cron job runs.
Check the log when: tools fail unexpectedly, responses go silent, network errors occur,
or the user asks "what happened?" or "what went wrong?"
Reading tips:
- Recent entries: shell_exec with "tail -n 50 node_debug.log"
- Search for errors: shell_exec with "grep -i error node_debug.log"
The log is auto-rotated at 5 MB.
```

Additionally, `session_status` provides runtime stats, and `memory_stats` shows memory system health.

### ⚠️ What to do if Telegram disconnects — PARTIAL
The Error Recovery section gives generic guidance:

**Error Recovery** (claude.js:388-392):
```
- If a tool call fails, explain what happened and try an alternative approach.
- Don't repeat the same failed action — adapt your strategy.
- For persistent failures, inform the user and suggest manual steps.
```

But there's no Telegram-specific recovery guidance. The agent doesn't know:
- That Telegram uses long-polling that auto-reconnects
- What error codes mean (409 = conflict, 429 = rate limit)
- That it can check `node_debug.log` for Telegram errors specifically
- What happens if the bot token is revoked

### ✅ What to do if a skill fails
The agent has both skill_read (to manually load and debug) and the Error Recovery section. The skill system also validates requirements and gates skills that can't run. The `skill_install` tool validates frontmatter before installing.

### ⚠️ How to recover from conversation corruption — PARTIAL
The Session Memory section documents auto-saves:

**Session Memory** (claude.js, late in buildSystemBlocks):
```
Sessions are automatically summarized and saved to memory/ when:
- Idle for 10+ minutes (no messages)
- Every 50 messages (periodic checkpoint)
- On /new command (manual save + clear)
- On shutdown/restart
```

But the agent doesn't know:
- The conversation history limit (MAX_HISTORY = 20 messages)
- What happens if history gets corrupted
- How to force a conversation reset (it knows /new exists from command handling but the system prompt doesn't document it)
- That the `:node` process kill is the nuclear recovery option

---

## Top 5 Biggest Gaps

### 1. ❌ No self-description / origin story
The agent has NO answer to "What is SeekerClaw?" or "Who made you?" or "What do you do?" The system prompt gives a single line: *"You are a personal assistant running inside SeekerClaw on Android."* There's no mention of:
- SeekerClaw's purpose (24/7 AI agent on Solana Seeker)
- Who created it or why
- Its relationship to OpenClaw
- That the user interacts primarily via Telegram

**Impact:** Users asking basic questions about the app get confused non-answers.

### 2. ❌ No awareness of its own process architecture
The agent doesn't know it runs in a `:node` process separate from the UI, that the Watchdog monitors it, that crashes kill the entire process, or that START_STICKY restarts it. When something goes wrong at the process level, the agent can't explain what happened.

**Impact:** After a crash/restart, the agent has no context for "why did you restart?" or "what happened?"

### 3. ⚠️ No Telegram recovery guidance
The agent communicates exclusively through Telegram but has zero knowledge of:
- How polling works
- Common Telegram error codes
- What to do when messages fail to send
- Rate limiting behavior

**Impact:** When Telegram issues occur, the agent can only say "something went wrong" without diagnosing the issue.

### 4. ⚠️ No config file awareness
The agent doesn't know what `config.json`, `agent_settings.json`, or `solana_wallet.json` contain. It can't help users troubleshoot configuration issues or explain what settings do.

**Impact:** "Why isn't my Jupiter API key working?" — the agent can't check or explain the config flow.

### 5. ⚠️ Conversation limits undisclosed
The agent doesn't know its conversation history is capped at 20 messages, that the max tool use loop is 5 iterations, or that max_tokens is 4096. These are hard constraints that affect behavior.

**Impact:** The agent may promise multi-step work that exceeds the tool-use loop limit, or fail to explain why it "forgot" something from earlier in a long conversation.

---

## Bonus: Things Done Well

- **Tool descriptions are excellent** — each of the 56 tools has specific, accurate descriptions with parameters, constraints, and usage examples
- **Security model is well-documented** — Content Trust Policy, confirmation gates, SECRETS_BLOCKED, sandboxed execution
- **Memory system is clear** — search-before-read pattern, auto-indexing, truncation limits
- **Heartbeat protocol is precise** — HEARTBEAT_OK, SILENT_REPLY, exact behavioral rules
- **Skill system is well-designed** — semantic selection, requirement gating, both trigger and AI-driven matching
- **PLATFORM.md is auto-generated** — device context is always fresh and accurate
- **Diagnostics section is practical** — specific grep/tail commands for the debug log

---

## Methodology

All data gathered from source code reads — no runtime testing. Files analyzed:

| File | What it contains |
|------|-----------------|
| `app/src/main/assets/nodejs-project/claude.js` | `buildSystemBlocks()` — the complete system prompt builder |
| `app/src/main/assets/nodejs-project/tools.js` | TOOLS array — all 56 tool definitions |
| `app/src/main/assets/nodejs-project/skills.js` | Skill loading, parsing, matching, requirements gating |
| `app/src/main/assets/nodejs-project/config.js` | Config reading, shell allowlist |
| `app/src/main/assets/nodejs-project/main.js` | Chat loop, heartbeat, session management |
| `app/src/main/assets/nodejs-project/memory.js` | Memory loading/searching functions |
| `app/src/main/java/.../config/ConfigManager.kt` | Config writing, PLATFORM.md generation, workspace seeding |
| `app/src/main/java/.../config/Models.kt` | Model list |
| `app/src/main/java/.../service/NodeBridge.kt` | JNI bridge, Node.js startup |
| `app/src/main/java/.../service/OpenClawService.kt` | Service lifecycle, startup sequence |
| `app/src/main/java/.../service/Watchdog.kt` | Health monitoring |
| `app/src/main/java/.../bridge/AndroidBridge.kt` | HTTP bridge endpoints |
