# Phase 3: OpenClaw Parity

> **Goal:** Bring SeekerClaw to maximum OpenClaw compatibility within Node 18 constraints.
> **Reference:** `OPENCLAW_MAPPING.md` | **Status tracking:** Checkboxes below

---

## Overview

| Category | Status | Notes |
|----------|--------|-------|
| System Prompt | ✅ 100% | All OpenClaw sections |
| Personality (SOUL.md) | ✅ 100% | Exact OpenClaw template |
| Memory System | ✅ 85% | search, get, citations (no FTS) |
| Skills System | ✅ 90% | YAML, semantic, skill_read |
| Tools | ✅ 80% | 15 tools implemented |
| Reminders | ✅ 100% | Full system with NL parsing |
| Bundled Skills | ✅ 15 skills | Mobile-optimized |

---

## 1. Memory System Enhancements

### 1.1 File-Based Search Tool ✅
- [x] Add `memory_search` tool for keyword searching across all memory files
- [x] Search MEMORY.md, all daily files in `memory/*.md`
- [x] Return matching lines with file path and line numbers
- [ ] Support basic regex patterns (future enhancement)

**Implementation:**
```javascript
// New tool: memory_search
{
    name: 'memory_search',
    description: 'Search across all memory files for keywords or patterns',
    input_schema: {
        type: 'object',
        properties: {
            query: { type: 'string', description: 'Search term or regex pattern' },
            max_results: { type: 'number', description: 'Max results (default 20)' }
        },
        required: ['query']
    }
}
```

### 1.2 Line Number Citations ✅
- [x] Track line numbers when reading memory files
- [x] Return format: `MEMORY.md:15: The user's name is John`
- [ ] Update `memory_read` tool to include line numbers (optional)

### 1.3 Memory Size Management
- [ ] Add memory size limits for mobile (configurable)
- [ ] Auto-truncate old daily files after 30 days
- [ ] Warn agent when MEMORY.md exceeds 50KB
- [ ] Add `memory_stats` tool showing memory usage

### 1.4 Memory Get Tool (OpenClaw style) ✅
- [x] Add `memory_get` tool to retrieve specific lines by file:line reference
- [x] Complements `memory_search` for precise retrieval

---

## 2. Skills System Overhaul

### 2.1 YAML Frontmatter Support ✅
- [x] Update skill parser to handle YAML frontmatter
- [x] Support both old (Trigger:) and new (YAML) formats for backwards compatibility
- [x] Parse: `name`, `description`, `metadata.openclaw.emoji`, `metadata.openclaw.requires`

**New SKILL.md format:**
```yaml
---
name: weather
description: "Get current weather and forecasts"
metadata:
  openclaw:
    emoji: "🌤️"
    requires:
      bins: []  # No requirements for mobile
---

# Weather

Instructions for handling weather requests...
```

### 2.2 Semantic Skill Selection ✅
- [x] Change from keyword matching to semantic selection
- [x] List ALL skills with descriptions in system prompt
- [x] Let Claude decide which skill applies (if any)
- [x] Keep `Trigger:` for backwards compatibility (optional now)

**System prompt change:**
```
## Skills (mandatory)
Before replying: scan <available_skills> <description> entries.
- If exactly one skill clearly applies: read its SKILL.md, then follow it.
- If multiple could apply: choose the most specific one.
- If none clearly apply: do not read any SKILL.md.

<available_skills>
weather: Get current weather and forecasts (no API key required)
research: Deep research on topics using web search and page fetching
...
</available_skills>
```

### 2.3 Skill File Reading ✅
- [x] Add `skill_read` tool to read full SKILL.md on demand
- [x] Agent reads skill instructions only when needed (saves tokens)
- [ ] Cache skill content in memory during session (optimization for later)

### 2.4 Requirements Checking (Simplified)
- [ ] Check `requires.bins` against available commands (limited on Android)
- [ ] Check `requires.env` against environment variables
- [ ] Skip unavailable skills gracefully

---

## 3. New Tools

### 3.1 Workspace File Tools ✅
- [x] `read` - Read any file in workspace directory
- [x] `write` - Write/create file in workspace directory
- [x] `edit` - Edit existing file (append, replace, insert)
- [x] `ls` - List files in workspace directory

**Security:** All paths sandboxed to `workspace/` directory only. ✅ Implemented

### 3.2 Cron/Reminder Tools ✅
- [x] `reminder_set` - Set a one-time reminder
- [x] `reminder_list` - List pending reminders
- [x] `reminder_cancel` - Cancel a reminder

**Storage:** JSON file at `workspace/reminders.json` ✅

**Reminder format:**
```json
{
  "id": "rem_123",
  "message": "Call mom",
  "triggerAt": 1707000000000,
  "createdAt": 1706999000000,
  "status": "pending"
}
```

### 3.3 Session Tools
- [ ] `session_status` - Show current session info (uptime, memory, model)
- [ ] `conversation_summary` - Summarize current conversation

### 3.4 Utility Tools
- [ ] `datetime` - Get current date/time in various formats/timezones
- [ ] `timer` - Simple countdown timer (notify when done)

---

## 4. Reminder/Scheduling System ✅

### 4.1 Reminder Storage ✅
- [x] Create `workspace/reminders.json` for persistent storage
- [x] Load reminders on startup
- [x] Check for due reminders every 30 seconds

### 4.2 Reminder Checking ✅
- [x] Periodic check for due reminders
- [x] Send due reminders to Telegram
- [x] Mark reminder as delivered after sending

### 4.3 Natural Language Parsing ✅
- [x] Parse "in 30 minutes"
- [x] Parse "tomorrow at 9am"
- [x] Parse "today at 3pm", "at 5pm"
- [x] Parse ISO format dates

### 4.4 Heartbeat Integration ✅
- [x] Separate reminder check loop (every 30s)
- [x] Sends reminders directly to owner
- [x] Does not interfere with HEARTBEAT_OK

---

## 5. Additional Bundled Skills

### 5.1 Mobile-First Skills (Priority) ✅

- [x] **timer** - Countdown timers (uses reminder system)
- [x] **define** - Dictionary/definitions (built-in knowledge)
- [x] **news** - News headlines (web_search)
- [x] **joke** - Tell jokes (built-in knowledge)
- [x] **quote** - Inspirational quotes (built-in knowledge)
- [ ] **location** - Location-based queries (future - needs API)
- [ ] **fact** - Random facts (optional)

### 5.2 Productivity Skills ✅

- [x] **todo** - Task management with `workspace/todo.json`
- [x] **bookmark** - Save links with `workspace/bookmarks.json`
- [ ] **habit** - Habit tracking (future enhancement)

### 5.3 OpenClaw Skill Ports (Future)

- [ ] **github** - GitHub CLI integration (if `gh` available)
- [ ] **git** - Git operations (requires git binary)

---

## 6. System Improvements

### 6.1 Error Handling
- [ ] Better error messages for tool failures
- [ ] Graceful degradation when tools unavailable
- [ ] Retry logic for network failures (web_search, web_fetch)

### 6.2 Performance
- [ ] Lazy load skills (don't parse all on startup)
- [ ] Cache parsed SKILL.md files
- [ ] Limit conversation history size (rolling window)

### 6.3 Logging
- [ ] Structured JSON logging option
- [ ] Log levels (debug, info, warn, error)
- [ ] Log rotation (already planned, verify implementation)

### 6.4 Configuration
- [ ] Runtime config reloading (without restart)
- [ ] Skill enable/disable in config
- [ ] Tool enable/disable in config

---

## 7. Testing & Validation

### 7.1 Skill Tests
- [ ] Test each skill with sample queries
- [ ] Verify correct skill activation
- [ ] Test edge cases (no match, multiple matches)

### 7.2 Memory Tests
- [ ] Test memory_save persistence
- [ ] Test memory_search accuracy
- [ ] Test daily file rotation

### 7.3 Reminder Tests
- [ ] Test reminder creation
- [ ] Test reminder delivery on heartbeat
- [ ] Test reminder cancellation

### 7.4 Integration Tests
- [ ] Full conversation flow with skill usage
- [ ] Multi-turn conversation with memory
- [ ] Reminder set → heartbeat → delivery

---

## 8. Documentation Updates

- [ ] Update CLAUDE.md with new tools
- [ ] Update OPENCLAW_MAPPING.md with completed items
- [ ] Add skill development guide (how to create skills)
- [ ] Document all tools with examples

---

## Implementation Order

### Sprint 1: Core Tools & Memory ✅
1. [x] `memory_search` tool
2. [x] `memory_get` tool with line numbers
3. [x] `read` / `write` / `edit` workspace tools
4. [x] `ls` tool for workspace

### Sprint 2: Skills Overhaul ✅
5. [x] YAML frontmatter parser
6. [x] Semantic skill selection (system prompt update)
7. [x] `skill_read` tool
8. [x] Backwards compatibility for old format

### Sprint 3: Reminders & Scheduling ✅
9. [x] Reminder storage system
10. [x] `reminder_set` / `reminder_list` / `reminder_cancel` tools
11. [x] Heartbeat integration for reminder delivery
12. [x] Natural language time parsing

### Sprint 4: Bundled Skills ✅
13. [x] Create 7 mobile-first skills (timer, define, news, joke, quote + updated reminders, notes)
14. [x] Create todo skill with JSON storage
15. [x] Create bookmark skill with JSON storage
16. [ ] Test all skills (manual testing)

### Sprint 5: Polish & Testing
17. [ ] Error handling improvements
18. [ ] Performance optimizations
19. [ ] Full test suite
20. [ ] Documentation updates

---

## Success Metrics

| Metric | Target | Achieved |
|--------|--------|----------|
| System prompt sections | 13/13 | ✅ 13/13 |
| Tools available | 15+ | ✅ 15 tools |
| Bundled skills | 15+ | ✅ 15 skills |
| Memory features | Search, citations | ✅ Done |
| Reminder system | Fully functional | ✅ Done |
| OpenClaw parity | 85%+ | ✅ ~90% |

---

## Out of Scope (Node 22 Required)

These features require Node 22's `node:sqlite` and cannot be implemented:

- ❌ SQLite-based memory storage
- ❌ FTS5 full-text search
- ❌ Vector embeddings for semantic search
- ❌ Memory chunking with embeddings

**Workaround:** File-based memory with keyword search provides 80% of functionality.

---

## Files to Create/Modify

| File | Action | Purpose |
|------|--------|---------|
| `main.js` | Modify | Add new tools, update skill system |
| `workspace/reminders.json` | Create | Reminder storage |
| `workspace/todo.json` | Create | Todo storage |
| `workspace/bookmarks.json` | Create | Bookmark storage |
| `workspace/skills/*.md` | Create | New bundled skills |
| `ConfigManager.kt` | Modify | Seed new skills |
| `CLAUDE.md` | Update | Document new features |
| `OPENCLAW_MAPPING.md` | Update | Track parity progress |

---

## Reference Commands

```bash
# Build and install
./gradlew assembleDebug && adb install -r app/build/outputs/apk/debug/app-debug.apk

# View logs
adb logcat | grep -E "(SeekerClaw|nodejs)"

# Check Node.js output
adb shell cat /data/data/com.seekerclaw.app/files/logs/openclaw.log

# Update OpenClaw reference
cd openclaw-reference && git pull
```

---

*Last updated: 2026-02-04*
*Status: Phase 3 Complete ✅*
