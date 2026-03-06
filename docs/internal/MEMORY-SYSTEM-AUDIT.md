# Memory System Audit — SeekerClaw

> **Audit Date:** 2026-03-07
> **Purpose:** Full audit of how memory works end-to-end, to inform temporal context awareness feature

---

## Architecture Overview

```
┌─────────────────────────────────────────────────────────────┐
│                    MEMORY LIFECYCLE                          │
│                                                             │
│  User Message → Conversation History (RAM, 35 msgs max)    │
│       │                                                     │
│       ├─→ Agent calls memory_save → MEMORY.md (append)      │
│       ├─→ Agent calls daily_note → memory/YYYY-MM-DD.md     │
│       │                                                     │
│       ├─→ Idle 10min? → Auto Session Summary                │
│       ├─→ 50 messages? → Auto Session Summary               │
│       ├─→ 30min active? → Auto Session Summary              │
│       │       └─→ memory/YYYY-MM-DD-{slug}.md               │
│       │       └─→ Re-indexed into SQL.js chunks             │
│       │                                                     │
│       └─→ Every API call: buildSystemBlocks() injects:      │
│               • SOUL.md (full)                              │
│               • IDENTITY.md (full)                          │
│               • USER.md (full)                              │
│               • MEMORY.md (first 3000 chars)                │
│               • Today's daily memory (first 1500 chars)     │
│               • Dynamic: timestamp, uptime, cron status     │
└─────────────────────────────────────────────────────────────┘
```

---

## Storage Locations

### On-Device Paths (`/data/data/com.seekerclaw.app/files/`)

```
workspace/
├── SOUL.md              # Agent personality (seeded once, never overwritten)
├── IDENTITY.md          # Agent identity (created during bootstrap ritual)
├── USER.md              # Owner profile (created during bootstrap ritual)
├── BOOTSTRAP.md         # First-run ritual (deleted by agent after completion)
├── HEARTBEAT.md         # Persistent task checklist for heartbeat checks
├── MEMORY.md            # Long-term memory (flat markdown, append-only)
├── memory/              # Daily + session files
│   ├── YYYY-MM-DD.md              # Daily notes (one per calendar day)
│   └── YYYY-MM-DD-{slug}.md       # Session summaries (auto-generated)
├── seekerclaw.db        # SQL.js database (chunks index + API logs)
└── node_debug.log       # Debug log (rotated at 5MB)
```

### Key Code Locations

| Component | File | Key Lines |
|-----------|------|-----------|
| Path definitions | `config.js` | 181-187 |
| Memory read/write | `memory.js` | 138-169 |
| Memory search | `memory.js` | 181-272 |
| Session summaries | `claude.js` | 250-335 |
| Conversation history | `claude.js` | 171-228 |
| System prompt injection | `claude.js` | 341-810 |
| Session tracking | `claude.js` | 193-211 |
| Database tables | `database.js` | 55-134 |
| Workspace seeding (Kotlin) | `ConfigManager.kt` | 628-824 |
| Export/Import (Kotlin) | `ConfigManager.kt` | 1422-1577 |
| Wipe/Reset (Kotlin) | `ConfigManager.kt` | 1373-1382 |

---

## The Two Memory Layers

### Layer 1: Ephemeral (RAM — Lost on Restart)

| What | Storage | Limit | Code |
|------|---------|-------|------|
| Conversation history | `Map<chatId, messages[]>` | 35 messages per chat (FIFO) | claude.js:171-228 |
| Session tracking | `Map<chatId, {lastMessageTime, messageCount, ...}>` | Per-chat, resets daily | claude.js:193-211 |
| Active task state | In-memory variables | N/A | Various |

**Critical gap:** When the process restarts, ALL conversation context is lost. The agent starts fresh with no knowledge of what was just discussed — only what's in persistent files.

### Layer 2: Persistent (Disk — Survives Restarts)

| File | Written By | When | Format | In System Prompt? |
|------|-----------|------|--------|-------------------|
| `MEMORY.md` | Agent (`memory_save` tool) | Explicitly by agent | Markdown, `---` separated entries | Yes, first 3000 chars |
| `memory/YYYY-MM-DD.md` | Agent (`daily_note` tool) | Explicitly by agent | `## HH:MM:SS` headers + content | Yes, today only, first 1500 chars |
| `memory/YYYY-MM-DD-{slug}.md` | Auto-summarizer | On idle/threshold/interval | Session summary with metadata header | No (only via `memory_search`) |
| `SOUL.md` | Seeded once | First launch | Personality template | Yes, full |
| `IDENTITY.md` | Agent (bootstrap ritual) | After first convo | Agent-chosen identity | Yes, full |
| `USER.md` | Agent (bootstrap ritual) | After first convo | Owner profile | Yes, full |
| `HEARTBEAT.md` | Seeded once | First launch | Task checklist | Read during heartbeats only |
| `seekerclaw.db` | SQL.js | Continuous | SQLite (chunks, api_log, files, meta) | No (queried by tools) |

---

## How Memory Gets Into Context (System Prompt)

### What the Agent Sees Every Turn

`buildSystemBlocks()` runs on **every API call** and injects:

1. **IDENTITY.md** — full content, no truncation
2. **USER.md** — full content, no truncation
3. **SOUL.md** — full content, no truncation
4. **MEMORY.md** — first 3000 characters, then `...(truncated)`
5. **Today's daily memory** — first 1500 characters of `memory/YYYY-MM-DD.md`
6. **Dynamic block** — current timestamp, uptime, pending cron jobs, matched skills

### What the Agent Does NOT See Automatically

- **Previous days' daily memory** — only today's file is loaded
- **Session summaries** — stored but NOT injected into prompt
- **Old conversation history** — gone after restart
- **Database contents** — only accessible via `memory_search` tool

---

## Session Summaries (Auto-Generated)

### Trigger Conditions

| Trigger | Threshold | Code |
|---------|-----------|------|
| Idle timeout | 10 minutes no messages | `IDLE_TIMEOUT_MS` claude.js:195 |
| Message count | Every 50 messages | `CHECKPOINT_MESSAGES` claude.js:196 |
| Time interval | Every 30 min active chat | `CHECKPOINT_INTERVAL_MS` claude.js:197 |
| Manual | `/new` command | main.js:248 |
| Shutdown | Process exit | Signal handlers |

### Summary Format

```markdown
# Session Summary — 2026-03-07T14:32:45+00:00

> Trigger: idle | Exchanges: 12 | Model: claude-sonnet-4-6

- Reviewed quarterly financial results with focus on budget variances
- Identified 3 department overruns and created action items
- Discussed API caching strategy; will benchmark next week
- Scheduled follow-up for final report sign-off
```

### How Summaries Are Generated

1. Last 20 messages condensed into text (500 char per message cap)
2. Sent to Claude with summarization prompt
3. Saved to `memory/YYYY-MM-DD-{adjective}-{noun}.md`
4. Immediately re-indexed into SQL.js `chunks` table
5. Debounce: minimum 1 minute between summaries per chat

---

## Memory Search (SQL.js)

### Database Schema

```sql
-- Searchable memory chunks
chunks (id, path, source, start_line, end_line, hash, text, updated_at)

-- File change tracking (skip re-indexing unchanged files)
files (path, source, hash, mtime, size)

-- API usage logging
api_request_log (id, timestamp, chat_id, input_tokens, output_tokens, ...)

-- Key-value metadata
meta (key, value)
```

### Search Algorithm

- **Tokenization:** Query split on whitespace, stop words filtered, min 3 chars
- **Matching:** AND logic — all keywords must appear in chunk
- **Scoring:** 70% term frequency + 30% recency (30-day decay window)
- **Fallback:** If SQL.js unavailable, grep through files directly
- **Default results:** Top 5 (configurable via `max_results`)

---

## Timestamps — Where They Exist

| Location | Format | Example |
|----------|--------|---------|
| Daily memory headers | `HH:MM:SS` (local) | `## 14:32:45` |
| Session summary headers | ISO 8601 with TZ | `2026-03-07T14:32:45+00:00` |
| Session summary metadata | Trigger + count + model | `Trigger: idle \| Exchanges: 12` |
| Database `chunks.updated_at` | ISO 8601 | `2026-03-07T14:32:45+00:00` |
| Database `api_request_log.timestamp` | ISO 8601 | `2026-03-07T14:32:45+00:00` |
| Dynamic system prompt block | Current time + weekday | Updated every turn |
| Daily memory filename | `YYYY-MM-DD` | `2026-03-07.md` |
| Session summary filename | `YYYY-MM-DD-{slug}` | `2026-03-07-swift-cedar.md` |

### What's Missing (No Timestamps)

- **Conversation messages** — no timestamp stored per message
- **MEMORY.md entries** — no timestamp on individual entries (just `---` separator)
- **Session tracking** — `lastMessageTime` exists in RAM but lost on restart
- **Cross-session gap** — agent has NO way to know when the last conversation happened

---

## The Temporal Awareness Gap

### What the Agent Knows About Time

| Question | Can Answer? | How |
|----------|-------------|-----|
| "What time is it now?" | YES | Dynamic block in system prompt |
| "What day is it?" | YES | Dynamic block + daily memory filename |
| "What happened today?" | PARTIAL | Today's daily memory (first 1500 chars) |
| "What happened yesterday?" | NO (auto) / YES (search) | Must call `memory_search` tool |
| "When did we last talk?" | NO | No persistent session timing |
| "How long since my last message?" | NO (after restart) | Session tracking is ephemeral |
| "What were we discussing last time?" | NO (after restart) | Conversation history is ephemeral |
| "What happened this week?" | ONLY via search | Must call `memory_search` with keywords |
| "Was there a pattern in our recent conversations?" | NO | No cross-session awareness |

### Root Causes

1. **Conversation history is RAM-only** — 35 messages, lost on restart
2. **Session summaries exist but aren't injected** — stored in files, searchable, but never in system prompt
3. **No "last session" pointer** — no file/field tracking when the last conversation started/ended
4. **Only today's daily memory is loaded** — previous days invisible without explicit search
5. **MEMORY.md has no timestamps** — entries separated by `---` with no date/time context
6. **Session tracking is ephemeral** — `lastMessageTime`, `messageCount` lost on restart

---

## Preservation Rules (Android Side)

| Action | Memory Preserved? | Details |
|--------|-------------------|---------|
| App update (store) | YES | Workspace never deleted |
| `adb install -r` | YES | Data preserved |
| Uninstall + reinstall | NO | Use export first |
| "WIPE MEMORY" button | PARTIAL | MEMORY.md emptied, memory/ deleted; SOUL/IDENTITY/USER preserved |
| "RESET CONFIG" button | YES | Only config/credentials wiped |
| Factory reset | NO | Use export first |

### Export/Import

- **Export allowlist:** SOUL.md, MEMORY.md, IDENTITY.md, USER.md, HEARTBEAT.md, BOOTSTRAP.md, cron/jobs.json, memory/*, skills/*
- **NOT exported:** Database, config, wallet, logs, media
- **Import safety:** Pre-import backup auto-created, 50MB cap, path traversal prevention
- **Database NOT included** — search index must be rebuilt after import

---

## Recommendations for Temporal Context Feature

Based on this audit, here's what needs to change to give the agent temporal awareness:

### 1. Persist Session Metadata

Create `workspace/sessions.json` (or use SQL.js `sessions` table):
```json
[
  {
    "id": "2026-03-07-swift-cedar",
    "started": "2026-03-07T14:30:00+00:00",
    "ended": "2026-03-07T15:45:00+00:00",
    "duration_min": 75,
    "message_count": 23,
    "summary_file": "memory/2026-03-07-swift-cedar.md",
    "topics": ["dashboard redesign", "log viewer"],
    "open_threads": ["log viewer color coding unfinished"]
  }
]
```

### 2. Inject "Recent Sessions" Block in System Prompt

In `buildSystemBlocks()`, after the Project Context section, add:
```markdown
## Recent Sessions
- **2 hours ago** (75min, 23 msgs): Dashboard redesign. Log viewer styling unfinished.
- **Yesterday** (20min, 8 msgs): Quick boot receiver fix. You mentioned testing on device.
- **3 days ago** (2hr, 45 msgs): MCP server integration deep dive.

Open threads: Log viewer color coding, device testing
```

### 3. Add Timestamps to MEMORY.md Entries

Change `memory_save` to prepend timestamp:
```markdown
## 2026-03-07 14:32
User prefers green accent over crimson for status indicators.

---

## 2026-03-05 09:15
MCP server rate limiting set to 10/min per server.
```

### 4. Load Recent Daily Memory (Not Just Today)

Change from loading only today's file to loading last 2-3 days:
- Today: full (1500 chars)
- Yesterday: summary only (500 chars)
- 2 days ago: one-liner

### 5. Session Continuity on Restart

On process startup, read `sessions.json` to populate a "last session" context block. This bridges the gap between ephemeral RAM and persistent files.

### 6. Relative Time Labels

Replace absolute timestamps with human-relative labels in the system prompt:
- "2 hours ago" instead of "2026-03-07T12:30:00"
- "yesterday" instead of "2026-03-06"
- "last week" instead of "2026-02-28"

---

## Size Budget for System Prompt Additions

Current memory in system prompt:
- SOUL.md: ~2KB (full)
- IDENTITY.md: ~500B (full)
- USER.md: ~500B (full)
- MEMORY.md: 3000 chars max
- Daily memory: 1500 chars max
- **Total: ~7.5KB**

Proposed additions:
- Recent Sessions block: ~500B (3-5 session one-liners)
- Yesterday's daily summary: ~500B
- **Added: ~1KB** (minimal impact on token budget)
