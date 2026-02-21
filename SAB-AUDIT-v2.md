# SAB-AUDIT-v2 — SeekerClaw Agent Self-Knowledge Audit

> **Date:** 2026-02-21
> **Scope:** Re-audit after BAT-232 (PR #156) and BAT-233 (PR #158) merged
> **Method:** Full read of updated `buildSystemBlocks()` in claude.js
> **Baseline:** SAB-AUDIT-v1.md (pre-merge)

---

## Overall Scorecard

| Status | v1 | v2 | Delta |
|--------|----|----|-------|
| ✅ KNOWS IT | 12 | 18 | +6 |
| ⚠️ PARTIAL | 6 | 2 | -4 |
| ❌ MISSING | 2 | 0 | -2 |
| **Score** | **42/60** | **56/60** | **+14** |
| **Percentage** | **70%** | **93%** | **+23pp** |

Scoring: ✅ = 3 pts, ⚠️ = 1 pt, ❌ = 0 pts. 20 items × 3 = 60 max.

---

## Score Comparison by Category

### 1. Identity (4 items)

| Item | v1 | v2 | What changed |
|------|----|----|-------------|
| Own name and version | ✅ | ✅ | — |
| Model it's running on | ✅ | ✅ | — |
| Device/hardware | ⚠️ | ⚠️ | No change — still no Seeker-specific context |
| Who built it and why | ❌ | ✅ | **BAT-232** added identity section |

**v1: 8/12 → v2: 10/12**

#### What BAT-232 added (Identity)
```
You are a personal AI agent running inside SeekerClaw on Android.
SeekerClaw turns a phone into a 24/7 always-on AI agent. Your owner talks to you
through Telegram — the Android app is just your host and control panel.
You are based on the OpenClaw gateway — an open-source personal AI agent framework.
```

#### Why "Device/hardware" is still ⚠️
PLATFORM.md gives device model, Android version, RAM, storage, battery, permissions — all accurate. But the agent has no knowledge that:
- SeekerClaw was designed for the **Solana Seeker** phone specifically
- Stock Android (Seeker) avoids aggressive battery kill that plagues OEM ROMs
- This context matters for troubleshooting (if running on Xiaomi/Samsung, background service behavior differs)

Not a critical gap — the agent functions fine without it. Just can't answer "what phone is this made for?"

---

### 2. Architecture (4 items)

| Item | v1 | v2 | What changed |
|------|----|----|-------------|
| How Node.js ↔ Kotlin communicate | ⚠️ | ✅ | **BAT-232** architecture section |
| UI process vs :node process | ❌ | ✅ | **BAT-232** architecture section |
| Health monitoring system | ✅ | ✅ | Improved: Health Monitoring section + Watchdog details |
| How Telegram polling works | ⚠️ | ⚠️ | Improved diagnostics, but mechanism still unexplained |

**v1: 7/12 → v2: 10/12**

#### What BAT-232 added (Architecture)
```
The Android app runs two separate processes:
1. Main process (Kotlin/Compose) — the UI, settings, and hardware access.
2. :node process (Node.js via nodejs-mobile) — YOU. All AI logic, Telegram polling,
   tool execution, memory, and scheduling happen here.
The two processes communicate via a local HTTP bridge on localhost:8765.
The bridge requires a per-boot auth token — you never need to manage it.
If the :node process crashes or is killed, the Android Watchdog restarts it
automatically. After a restart, conversation history is gone (ephemeral) but
memory files persist.
```

#### What BAT-232 added (Health Monitoring)
```
You write agent_health_state every 60 seconds with your API health status.
The Android app polls this file every 1 second. If older than 120 seconds,
the app marks you as "stale".
The Watchdog (Kotlin-side) also monitors your process — 2 missed health checks
(60s) triggers an automatic restart.
```

#### Why "Telegram polling" is still ⚠️
The agent now has **diagnostic tools** for Telegram issues (BAT-233 playbook: `grep -i poll node_debug.log`, check DNS errors). But it still doesn't understand:
- That it uses **long-polling** (not webhooks)
- The message flow: user → Telegram API → getUpdates → chat() → sendMessage
- What happens when polling disconnects (auto-reconnect with backoff)
- Telegram rate limits (30 messages/sec, 20 messages/min per group)

The playbook tells it *how to diagnose* Telegram issues but not *how Telegram works*. Functional for troubleshooting, incomplete for explaining behavior.

---

### 3. Capabilities (4 items)

| Item | v1 | v2 | What changed |
|------|----|----|-------------|
| Full tool list | ✅ | ✅ | — |
| Which tools sandboxed | ✅ | ✅ | Improved: playbook lists full 22-cmd allowlist |
| What it cannot do | ✅ | ✅ | Improved: conversation limits now explicit |
| How skills load and trigger | ✅ | ✅ | Improved: playbook adds skill debugging steps |

**v1: 12/12 → v2: 12/12** (already perfect, improvements are quality-of-life)

#### Notable quality improvements
BAT-233 playbook now gives the agent the **exact shell allowlist** when a tool fails:
```
shell_exec: check if the command is in the allowlist (cat, ls, mkdir, cp, mv, echo,
pwd, which, head, tail, wc, sort, uniq, grep, find, curl, ping, date, df, du,
uname, printenv)
```

BAT-232 adds hard limits the agent can plan around:
```
History window: 20 messages per chat.
Tool use per turn: Up to 5 consecutive tool calls per user message.
Max output: 4096 tokens per response.
```

---

### 4. Configuration (4 items)

| Item | v1 | v2 | What changed |
|------|----|----|-------------|
| Config files — what's in each | ⚠️ | ✅ | **BAT-232** File System Doors + Config Awareness |
| Which settings agent can change | ✅ | ✅ | — |
| Which API keys needed | ✅ | ✅ | — |
| How to change model/heartbeat | ✅ | ✅ | Improved: now explicitly points to Android Settings |

**v1: 10/12 → v2: 12/12**

#### What BAT-232 added (File System Doors)
```
Key files in your workspace and what they contain:
- agent_settings.json — runtime settings (heartbeat interval, etc.). You can read this.
- config.json — BLOCKED. Contains API keys and secrets. Written at startup, then
  deleted after 5 seconds. You cannot and should not read it.
- agent_health_state — your health status file, written every 60s.
- PLATFORM.md — auto-generated on every service start with device info.
- node_debug.log — your runtime debug log. Auto-rotated at 5MB.
- skills/ — SKILL.md files that extend your capabilities.
- memory/ — daily memory files (one per day).
- cron/ — scheduled job definitions and execution history.
- media/inbound/ — files sent to you via Telegram.
- seekerclaw.db — BLOCKED. SQL.js database. Accessed through tools, not directly.
```

#### What BAT-232 added (Config Awareness)
```
To check current runtime settings, read agent_settings.json.
For API keys, bot tokens, or model selection: managed in Android Settings screen.
You cannot read or change them — tell the user to check Settings.
The config.json that contained secrets is deleted 5 seconds after startup.
```

---

### 5. Self-Diagnosis (4 items)

| Item | v1 | v2 | What changed |
|------|----|----|-------------|
| Health goes stale | ✅ | ✅ | Improved: specific playbook steps |
| Telegram disconnects | ⚠️ | ✅ | **BAT-233** playbook scenario |
| Skill fails | ✅ | ✅ | Improved: detailed playbook steps |
| Conversation corruption | ⚠️ | ✅ | **BAT-232** limits + **BAT-233** playbook |

**v1: 7/12 → v2: 12/12**

#### What BAT-233 added (Telegram recovery)
```
If you stop receiving messages:
1. Check for recent Telegram poll activity: grep -i poll node_debug.log
2. Check your health file: read agent_health_state — is apiStatus healthy?
3. Check for DNS/network errors: grep -i ENOTFOUND node_debug.log
4. Suggest: "Try /new to archive this session and start fresh"
5. Suggest: "Check your internet connection"
```

#### What BAT-233 added (Conversation corruption)
```
If conversation seems corrupted or loops:
1. Use /new to archive and clear conversation history (safe)
2. Use /reset to wipe conversation without backup (nuclear)
3. Tool-use loop protection: max 5 tool calls per turn
```

#### What BAT-233 added (API failure diagnosis)
```
If API calls keep failing:
1. Read agent_health_state — check consecutiveFailures and lastError
2. Auth error (401/403): API key may be invalid — tell user to check Settings
3. Rate limit (429): slow down
4. Billing error (402): tell user to check Anthropic billing
5. Network error: check connectivity with js_eval or curl
```

---

## Remaining Gaps (2 items at ⚠️)

### 1. ⚠️ Device/hardware — no Seeker-specific context
**What it knows:** Device model, Android version, RAM, storage, battery (from PLATFORM.md)
**What's missing:** "Built for Solana Seeker," OEM battery kill awareness, stock Android advantage
**Impact:** Low. Agent functions fine. Can't answer "what phone is this for?" but rarely asked.
**Fix cost:** 2 lines in Identity section

### 2. ⚠️ Telegram polling — mechanism unexplained
**What it knows:** How to diagnose Telegram issues (grep poll, check DNS, check health)
**What's missing:** Long-polling vs webhooks, message flow, auto-reconnect behavior, rate limits
**Impact:** Low-medium. Diagnosis works, but agent can't explain *why* messages are delayed or *how* delivery works.
**Fix cost:** 4-5 lines in Architecture section

---

## What Would Push to 90%+ (already there: 93%)

We crossed 90% with BAT-232 + BAT-233. To reach **100% (60/60)**:

### Fix 1: Add Seeker context to Identity (1 line)
```
SeekerClaw is designed primarily for the Solana Seeker phone (stock Android 14,
Snapdragon 6 Gen 1) but works on any Android 14+ device with 4GB+ RAM.
```
→ Upgrades "Device/hardware" from ⚠️ to ✅ (+2 pts)

### Fix 2: Add Telegram transport explainer to Architecture (4 lines)
```
Telegram communication uses long-polling (getUpdates API) — the :node process
continuously polls Telegram servers for new messages. If the network drops,
polling reconnects automatically with backoff. Message flow:
user → Telegram servers → getUpdates poll → chat() → sendMessage → Telegram → user.
```
→ Upgrades "Telegram polling" from ⚠️ to ✅ (+2 pts)

**Total cost:** ~5 lines added to `buildSystemBlocks()`. No token budget concern — both are short, factual, and highly cacheable.

---

## v1 → v2 Gap Closure Summary

| v1 Gap | Status | How it was fixed |
|--------|--------|-----------------|
| 1. No self-description / origin story | ✅ Fixed | BAT-232 Identity: purpose, Telegram, OpenClaw |
| 2. No process architecture awareness | ✅ Fixed | BAT-232 Architecture: two-process, bridge, Watchdog |
| 3. No Telegram recovery guidance | ✅ Fixed | BAT-233 Playbook: poll grep, DNS check, /new |
| 4. No config file awareness | ✅ Fixed | BAT-232 File System Doors + Config Awareness |
| 5. Conversation limits undisclosed | ✅ Fixed | BAT-232 Conversation Limits: 20 msgs, 5 tools, 4096 tokens |

All 5 critical gaps from v1 are resolved. The 2 remaining items are low-impact partial knowledge.

---

## Methodology

Same as v1 — all data from source code reads, no runtime testing. Diff focused on:
- `claude.js` `buildSystemBlocks()` — 52 new lines from BAT-232, 43 new lines from BAT-233
- No changes to `tools.js`, `skills.js`, `config.js`, or Kotlin files

This is the baseline before live device testing.
