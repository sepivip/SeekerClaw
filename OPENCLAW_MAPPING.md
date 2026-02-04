# OpenClaw → SeekerClaw Mapping Document

> **Purpose:** Track OpenClaw features and their SeekerClaw implementations.
> **Reference:** `openclaw-reference/` (cloned OpenClaw repo)
> **Last Updated:** 2026-02-03

---

## Quick Reference

| OpenClaw Location | SeekerClaw Location | Status |
|-------------------|---------------------|--------|
| `src/agents/system-prompt.ts` | `main.js:buildSystemPrompt()` | ✅ Aligned |
| `src/memory/` | `main.js` (file-based) | 🟡 Partial |
| `src/agents/skills/` | `main.js` (simplified) | 🟡 Partial |
| `src/cron/` | Not implemented | 🔴 Missing |
| `skills/` (76 bundled) | 3 example skills | 🟡 Partial |
| SOUL.md template | ConfigManager.kt | ✅ Matched |

---

## 1. System Prompt Structure

### OpenClaw (`src/agents/system-prompt.ts`)

```
1. Identity line: "You are a personal assistant running inside OpenClaw."
2. ## Tooling - Tool availability list with descriptions
3. ## Tool Call Style - When to narrate vs just call
4. ## Safety - Anthropic-inspired safety rules
5. ## Skills (mandatory) - Skill selection logic
6. ## Memory Recall - How to search/get memory
7. ## OpenClaw CLI Quick Reference
8. ## Model Aliases
9. ## Workspace - Working directory info
10. ## Documentation - OpenClaw docs paths
11. ## Sandbox (if enabled)
12. ## User Identity - Owner numbers
13. ## Current Date & Time
14. ## Workspace Files (injected)
15. ## Reply Tags - [[reply_to_current]] etc
16. ## Messaging - Channel routing
17. ## Voice (TTS)
18. # Project Context - SOUL.md, MEMORY.md injected here
19. ## Silent Replies - SILENT_REPLY token
20. ## Heartbeats - HEARTBEAT_OK protocol
21. ## Runtime - agent/host/os/model info
```

### SeekerClaw (`main.js:buildSystemPrompt()`)

```
1. Identity line ✅
2. ## Tooling ✅
3. ## Tool Call Style ✅
4. ## Skills ✅ (simplified)
5. ## Safety ✅ (exact copy)
6. ## Memory Recall ✅
7. ## Workspace ✅
8. # Project Context ✅ (SOUL.md, MEMORY.md)
9. ## Heartbeats ✅
10. ## User Identity ✅
11. ## Silent Replies ✅
12. ## Reply Tags ✅
13. ## Runtime ✅
```

**Not applicable for mobile:** CLI Reference, Model Aliases, Documentation, Sandbox, Voice
**Future:** Messaging (multi-channel)

### Action Items:
- [x] Add Silent Replies section (`SILENT_REPLY` token)
- [x] Add Reply Tags for Telegram (`[[reply_to_current]]`)
- [x] Add User Identity section with owner ID

---

## 2. Memory System

### OpenClaw (`src/memory/`)

**Architecture:**
- SQLite database with FTS5 full-text search
- Vector embeddings for semantic search (node:sqlite)
- Files: MEMORY.md, memory/*.md (daily), session files
- Tools: `memory_search` (search), `memory_get` (retrieve lines)
- Chunking with line numbers for citations

**Key Files:**
- `memory-schema.ts` - SQLite schema (chunks, files, embeddings)
- `manager.ts` - 75k lines, full memory manager
- `embeddings.ts` - Vector embedding generation
- `search-manager.ts` - Hybrid search (FTS + vector)

### SeekerClaw (Current)

**Architecture:**
- File-based only (no SQLite/vectors - Node 18 limitation)
- Files: MEMORY.md, memory/*.md (daily), HEARTBEAT.md
- Tools: `memory_save`, `memory_read`, `daily_note`

**Differences:**
| Feature | OpenClaw | SeekerClaw |
|---------|----------|------------|
| Storage | SQLite + files | Files only |
| Search | FTS + vector | None (full read) |
| Citations | Line numbers | None |
| Chunking | Yes | No |
| Embeddings | Yes | No |

### Action Items:
- [ ] Consider adding basic keyword search in files
- [ ] Add line number tracking for citations
- [ ] Memory size limits for mobile

---

## 3. SOUL.md / Personality

### OpenClaw

**Location:** Workspace files, injected into Project Context section
**Handling:** `system-prompt.ts` line 553-562

```typescript
if (hasSoulFile) {
  lines.push(
    "If SOUL.md is present, embody its persona and tone. Avoid stiff, generic replies; follow its guidance unless higher-priority instructions override it.",
  );
}
```

**Default Template:** (from their SOUL.md)
```markdown
# SOUL.md - Who You Are

_You're not a chatbot. You're becoming someone._

## Core Truths
- Be genuinely helpful, not performatively helpful
- Have opinions
- Be resourceful before asking
- Earn trust through competence
- Remember you're a guest

## Boundaries
- Private things stay private
- When in doubt, ask before acting externally
...
```

### SeekerClaw

**Status:** ✅ Exact SOUL.md template copied
**Location:** `ConfigManager.kt:seedWorkspace()`

---

## 4. Skills System

### OpenClaw (`src/agents/skills/`)

**SKILL.md Format:**
```yaml
---
name: skill-name
description: "What the skill does. AI reads this to decide when to use."
homepage: https://example.com
metadata:
  openclaw:
    emoji: "🔧"
    requires:
      bins: ["required-binary"]
      env: ["REQUIRED_ENV_VAR"]
      config: ["config.path"]
    install:
      - kind: brew
        formula: package-name
---

# Skill Name

Instructions for using the skill...
```

**Key Features:**
- YAML frontmatter with metadata
- Description triggers skill (semantic, not keywords)
- Requirements gating (bins, env, config)
- Installation specs for dependencies
- Precedence: workspace > managed > bundled
- 76 bundled skills

**System Prompt Injection:**
```
## Skills (mandatory)
Before replying: scan <available_skills> <description> entries.
- If exactly one skill clearly applies: read its SKILL.md at <location> with `read`, then follow it.
- If multiple could apply: choose the most specific one, then read/follow it.
- If none clearly apply: do not read any SKILL.md.
```

### SeekerClaw (Current)

**SKILL.md Format:**
```markdown
# Skill Name

Trigger: keyword1, keyword2, keyword3

## Description
What this skill does

## Instructions
How to handle matching requests
```

**Differences:**
| Feature | OpenClaw | SeekerClaw |
|---------|----------|------------|
| Format | YAML frontmatter | Markdown only |
| Triggering | Semantic (AI reads description) | Keyword matching |
| Requirements | bins, env, config gating | None |
| Install specs | Yes | No |
| Bundled skills | 76 | 3 examples |

### Action Items:
- [ ] Switch to YAML frontmatter format
- [ ] Change to semantic triggering (list all skills, let AI pick)
- [ ] Add more bundled skills for mobile use

---

## 5. Cron / Heartbeat / Scheduled Tasks

### OpenClaw (`src/cron/`)

**Types of schedules:**
```typescript
type CronSchedule =
  | { kind: "at"; atMs: number }           // One-time at timestamp
  | { kind: "every"; everyMs: number }     // Repeating interval
  | { kind: "cron"; expr: string; tz?: string };  // Cron expression

type CronPayload =
  | { kind: "systemEvent"; text: string }  // Internal event
  | { kind: "agentTurn"; message: string; ... };  // Trigger agent
```

**Features:**
- Cron tool available to agent
- Reminders with context
- One-shot or repeating
- Session isolation options
- Heartbeat polling

**Heartbeat Protocol:**
```
If you receive a heartbeat poll, and nothing needs attention, reply:
HEARTBEAT_OK

If something needs attention, do NOT include "HEARTBEAT_OK"; reply with the alert text instead.
```

### SeekerClaw (Current)

**Heartbeat:** File-based (HEARTBEAT.md), 5-minute interval
**Cron:** Not implemented

### Action Items:
- [ ] Add cron tool for reminders
- [ ] Implement HEARTBEAT_OK protocol
- [ ] Add one-shot scheduled tasks

---

## 6. Tools Comparison

### OpenClaw Core Tools:
```
read, write, edit, apply_patch, grep, find, ls, exec, process,
web_search, web_fetch, browser, canvas, nodes, cron, message,
gateway, agents_list, sessions_list, sessions_history, sessions_send,
sessions_spawn, session_status, image
```

### SeekerClaw Tools:
```
web_search, web_fetch, memory_save, memory_read, daily_note
```

### Mobile-Safe Tools to Add:
- [ ] `cron` - Reminders/scheduling
- [ ] `read` - Read workspace files
- [ ] `write` - Write workspace files
- [ ] `edit` - Edit workspace files
- [ ] `session_status` - Show agent status

---

## 7. Channel/Messaging

### OpenClaw

**Supported Channels:**
- Telegram, Discord, Slack, Signal, iMessage, WhatsApp, Line
- Web interface
- Voice calls

**Features:**
- Reply tags: `[[reply_to_current]]`, `[[reply_to:<id>]]`
- Inline buttons
- Reactions (minimal/extensive modes)
- Cross-session messaging

### SeekerClaw

**Supported:** Telegram only (for now)
**Missing:** Reply tags, inline buttons, reactions

---

## 8. Configuration

### OpenClaw (`~/.openclaw/openclaw.json`)

```json
{
  "skills": {
    "entries": { "skill-name": { "enabled": true, "apiKey": "..." } },
    "load": { "watch": true, "extraDirs": [...] }
  },
  "memory": { "embeddings": {...}, "fts": {...} },
  "channels": { "telegram": {...} }
}
```

### SeekerClaw (`workspace/config.json`)

```json
{
  "botToken": "...",
  "ownerId": "...",
  "anthropicApiKey": "...",
  "model": "...",
  "agentName": "..."
}
```

---

## 9. Future Skills to Create

Based on OpenClaw's bundled skills that make sense for mobile:

### High Priority (Mobile-First):
1. **reminders** - Schedule reminders via cron
2. **notes** - Quick note-taking to memory
3. **web-summary** - Summarize web pages
4. **translate** - Translation helper
5. **calculator** - Math operations
6. **unit-convert** - Unit conversions

### Medium Priority:
7. **location** - Location-based queries (weather, places)
8. **calendar** - Calendar integration (future)
9. **contacts** - Contact lookup (future)
10. **todo** - Task management

### Low Priority (Desktop-like):
11. **github** - GitHub CLI (if available)
12. **coding-agent** - Code assistance

---

## 10. Version Tracking

### OpenClaw Versions to Monitor:
- Current commit: (check `openclaw-reference/.git/HEAD`)
- Key files to watch for changes:
  - `src/agents/system-prompt.ts`
  - `src/agents/skills/workspace.ts`
  - `src/cron/types.ts`
  - `skills/` directory

### Update Process:
1. `cd openclaw-reference && git pull`
2. Compare key files with our implementation
3. Update this mapping document
4. Update SeekerClaw code as needed

---

## Appendix: Key OpenClaw Files

```
src/
├── agents/
│   ├── system-prompt.ts      # Main system prompt builder
│   ├── skills.ts             # Skills exports
│   └── skills/
│       ├── types.ts          # Skill types
│       ├── workspace.ts      # Skill loading/merging
│       └── frontmatter.ts    # YAML parsing
├── memory/
│   ├── manager.ts            # Memory manager (75k lines!)
│   ├── memory-schema.ts      # SQLite schema
│   └── embeddings.ts         # Vector embeddings
├── cron/
│   ├── types.ts              # Cron job types
│   ├── service.ts            # Cron service
│   └── service/ops.ts        # Cron operations
└── telegram/                 # Telegram channel
```
