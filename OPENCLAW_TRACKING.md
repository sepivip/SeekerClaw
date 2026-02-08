# OpenClaw Version Tracking

> **Purpose:** Track OpenClaw releases and identify changes to port to SeekerClaw.
> **Current OpenClaw Version:** 2026.2.6-3 (v2026.2.6-3, 2026-02-07)
> **Last Sync Review:** 2026-02-07

---

## Quick Reference

### Update OpenClaw Reference
```bash
cd openclaw-reference && git pull origin main
git log -1 --format="%H %ci %s"  # Check new version
```

### Compare Versions
```bash
# See what changed between versions
cd openclaw-reference
git diff <old-commit>..<new-commit> --stat

# See changes in specific critical files
git diff <old-commit>..<new-commit> -- src/agents/system-prompt.ts
git diff <old-commit>..<new-commit> -- src/memory/
git diff <old-commit>..<new-commit> -- src/cron/
git diff <old-commit>..<new-commit> -- skills/
```

---

## Critical Files to Monitor

These files in OpenClaw directly affect SeekerClaw behavior. Changes here require review.

### Priority 1: System Prompt (CRITICAL)
| OpenClaw File | SeekerClaw Equivalent | Notes |
|---------------|----------------------|-------|
| `src/agents/system-prompt.ts` | `main.js:buildSystemPrompt()` | Core agent behavior |
| `src/agents/system-prompt-sections.ts` | `main.js` (inline) | Prompt sections |
| `src/agents/identity.ts` | `main.js` (SOUL.md loading) | Agent identity |

### Priority 2: Memory System
| OpenClaw File | SeekerClaw Equivalent | Notes |
|---------------|----------------------|-------|
| `src/memory/manager.ts` | `main.js` (simplified) | Memory read/write |
| `src/memory/daily.ts` | `main.js:appendDailyMemory()` | Daily memory files |
| `src/memory/recall.ts` | `main.js:recallMemory()` | Memory retrieval |
| `src/memory/types.ts` | N/A | Type definitions |

### Priority 3: Skills System
| OpenClaw File | SeekerClaw Equivalent | Notes |
|---------------|----------------------|-------|
| `src/agents/skills/workspace.ts` | `main.js:loadSkills()` | Skill loading |
| `src/agents/skills/matching.ts` | `main.js:findMatchingSkills()` | Skill triggering |
| `src/agents/skills/types.ts` | N/A | SKILL.md format |
| `skills/*.md` | `workspace/skills/*.md` | Bundled skills |

### Priority 4: Tools & Capabilities
| OpenClaw File | SeekerClaw Equivalent | Notes |
|---------------|----------------------|-------|
| `src/agents/tools.ts` | `main.js:TOOLS[]` | Tool definitions |
| `src/agents/tool-execution.ts` | `main.js:executeTool()` | Tool runner |
| `src/web/fetch.ts` | `main.js:executeWebFetch()` | Web fetching |
| `src/web/search.ts` | `main.js:executeWebSearch()` | Web search |

### Priority 5: Cron & Scheduling
| OpenClaw File | SeekerClaw Equivalent | Notes |
|---------------|----------------------|-------|
| `src/cron/manager.ts` | `main.js:cronService` | Full cron service (ported) |
| `src/cron/natural-time.ts` | `main.js:parseTimeExpression()` | Time parsing (ported) |
| `src/cron/types.ts` | `main.js` (inline) | Job types (ported) |

### Priority 6: Channel/Telegram
| OpenClaw File | SeekerClaw Equivalent | Notes |
|---------------|----------------------|-------|
| `extensions/telegram/` | `main.js` (Telegram API) | Telegram integration |
| `src/channels/base.ts` | N/A | Channel abstraction |

---

## Version History & Changes

### 2026.2.2 (Current - 1c4db91)
- **Release Date:** 2026-02-03
- **SeekerClaw Sync Status:** Partially synced
- **Key Changes:**
  - [ ] Review system prompt changes
  - [ ] Check memory system updates
  - [ ] Review new skills
  - [ ] Check tool changes

### Baseline (Initial Clone)
- **SeekerClaw Created:** 2026-02-03
- **Based On:** OpenClaw 2026.2.2
- **Initial Sync Notes:**
  - System prompt adapted for mobile
  - Memory system simplified (no SQLite)
  - Skills system ported (keyword matching)
  - Cron system ported from OpenClaw (full service with JSON persistence, atomic writes, recurring jobs)

---

## Feature Parity Checklist

### System Prompt Sections
- [x] Identity line (`You are {agentName}...`)
- [x] Tooling section
- [x] Tool Call Style
- [x] Safety section (exact copy from OpenClaw)
- [x] Skills section (matched skills injected)
- [x] Memory Recall section
- [x] Workspace section
- [x] Project Context (SOUL.md, MEMORY.md)
- [x] Heartbeats section
- [x] Runtime info (date, time, platform)
- [x] Silent Replies (SILENT_REPLY token)
- [x] Reply Tags (`[[reply_to_current]]`)
- [x] User Identity (owner ID, username)
- [ ] Agentic mode flags
- [ ] Extended thinking

### Memory System
- [x] MEMORY.md long-term storage
- [x] Daily memory files (`memory/YYYY-MM-DD.md`)
- [x] HEARTBEAT.md
- [x] Memory append tool
- [x] Memory recall tool
- [ ] Vector search (requires Node 22+)
- [ ] FTS full-text search (requires SQLite)
- [ ] Line citations in recall

### Skills System
- [x] SKILL.md loading from workspace
- [x] Trigger keyword matching
- [x] Skill injection into system prompt
- [x] Basic YAML frontmatter parsing
- [ ] Full YAML frontmatter (requires field)
- [ ] Semantic triggering (AI picks skills)
- [ ] Requirements gating (bins, env, config)

### Tools
- [x] web_search (Brave Search)
- [x] web_fetch (HTTP GET)
- [x] memory_append
- [x] memory_recall
- [x] daily_note
- [x] cron_create (one-shot and recurring)
- [x] cron_list
- [x] cron_cancel
- [x] cron_status
- [x] datetime
- [x] session_status
- [x] memory_stats
- [x] Android Bridge tools (12 total)
- [ ] read_file (filesystem access)
- [ ] write_file (filesystem access)
- [ ] bash (command execution)
- [ ] edit (file editing)

### Cron/Scheduling (Ported from OpenClaw)
- [x] cron_create tool (one-shot + recurring)
- [x] cron_list tool
- [x] cron_cancel tool
- [x] cron_status tool
- [x] Natural language time parsing ("in X min", "every X hours", "tomorrow at 9am")
- [x] JSON file persistence with atomic writes + .bak backup
- [x] JSONL execution history per job
- [x] Timer-based delivery (no polling)
- [x] Zombie detection (2hr threshold)
- [x] Recurring intervals ("every" schedule)
- [x] HEARTBEAT_OK protocol
- [ ] Cron expressions (needs croner lib)
- [ ] Scheduled tasks (non-reminder payloads)

### Telegram Features
- [x] Long polling
- [x] Owner-only access
- [x] Message chunking (4000 chars)
- [x] Markdown formatting
- [x] Reply-to messages
- [x] Typing indicators
- [ ] Media attachments
- [ ] Inline keyboards
- [ ] Multiple owners
- [ ] Group chat support

---

## Update Process

When a new OpenClaw version is released:

### Step 1: Update Reference
```bash
cd e:/GIT/SeekerClaw/openclaw-reference
git fetch origin
git log --oneline HEAD..origin/main  # See new commits
git pull origin main
```

### Step 2: Generate Diff Report
```bash
# Get the commit range
OLD_COMMIT="1c4db91"  # Previous version
NEW_COMMIT="HEAD"

# Check critical files
git diff $OLD_COMMIT..$NEW_COMMIT -- src/agents/system-prompt.ts
git diff $OLD_COMMIT..$NEW_COMMIT -- src/memory/
git diff $OLD_COMMIT..$NEW_COMMIT -- src/cron/
git diff $OLD_COMMIT..$NEW_COMMIT -- skills/
```

### Step 3: Review Changes
For each changed file in the priority list above:
1. Read the diff carefully
2. Determine if change affects SeekerClaw
3. If yes, create a task to port the change
4. Update this document with the new version

### Step 4: Port Changes
1. Update `main.js` with new logic
2. Update skills in `workspace/skills/`
3. Test on device
4. Update Feature Parity Checklist above

### Step 5: Document
1. Add entry to Version History section
2. Update "Current OpenClaw Version" at top
3. Update "Last Sync Review" date
4. Commit changes to SeekerClaw

---

## Known Incompatibilities

These OpenClaw features cannot be ported to SeekerClaw due to platform limitations:

| Feature | Reason | Workaround |
|---------|--------|------------|
| SQLite memory | nodejs-mobile uses Node 18 (no `node:sqlite`) | File-based memory |
| Vector embeddings | Requires Node 22+ native modules | Keyword matching |
| FTS5 search | Requires SQLite | Full file search |
| Browser skill | No browser on headless Android | Web fetch only |
| Screen skill | No display access | N/A |
| Canvas skill | No GUI | N/A |
| Nodes skill | No Node.js REPL in mobile | N/A |
| File system tools | Security sandbox | Android Bridge |

---

## Automated Checks (Future)

TODO: Create a script that:
1. Fetches latest OpenClaw
2. Compares critical files
3. Generates a report of changes
4. Creates GitHub issues for needed updates

```bash
# Future: ./scripts/check-openclaw-updates.sh
```

---

## Contact & Resources

- **OpenClaw Repository:** https://github.com/niccolobocook/OpenClaw
- **SeekerClaw Repository:** (this repo)
- **nodejs-mobile:** https://github.com/niccolobocook/nodejs-mobile
