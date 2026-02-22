# OpenClaw Version Tracking

> **Purpose:** Track OpenClaw releases and identify changes to port to SeekerClaw.
> **Current OpenClaw Version:** 2026.2.22 (main 40a68a893, 2026-02-22)
> **Last Sync Review:** 2026-02-22
> **Parity Plan:** See `PARITY_PLAN.md`

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

### 2026.2.20 (Current - 741435aac)
- **Release Date:** 2026-02-20
- **SeekerClaw Sync Status:** Reviewed, nothing to port
- **505 new commits since last sync (f9e67f3)**
- **Versions reviewed:** v2026.2.19, v2026.2.20 (HEAD)
- **Skipped (not applicable):**
  - Memory: ENOENT hardening for readFile/buildFileEntry — requires node:sqlite (Node 22+)
  - Memory: fs-utils.ts helper module — Node 22+ infrastructure
  - Skills: symlink rejection in skill packaging — we don't package skills
  - Skills: `cask` → `formula` brew field fallback — no brew on Android
  - Cron: crypto.randomBytes for tmp file names — minor security hardening, our cron uses simpler paths
  - Cron: cache read/write token counts in /status — server-only
  - Cron: WhatsApp delivery routing to allowlisted recipients — no WhatsApp
  - Telegram: version bumps only (2026.2.18 → 2026.2.20), `resolveDefaultTo` — server-only delivery
  - Web media: LocalMediaAccessError codes, root guard refactoring — server-only WhatsApp media
  - Test deduplication across memory, cron, web suites — test-only

### 2026.2.17 (gap review — previously covered in 2026.2.18-dev)
- **Release Date:** 2026-02-17
- **SeekerClaw Sync Status:** Reviewed, already ported items noted in 2026.2.18-dev
- **Key Changes Reviewed:**
  - [x] System prompt: reply tags first-token rule — already ported (BAT-189)
  - [x] Skills: "Use when / Don't use when" routing blocks — already ported (BAT-189)
- **Skipped (not applicable):**
  - System prompt: sub-agent orchestration (`subagents` tool, push-based completion) — no sub-agents
  - System prompt: `[System Message]` rewrite guidance — no cron/sub-agent system messages
  - System prompt: sandbox container workspace paths, `sanitizeForPromptLiteral` — no Docker
  - Inline button `style` param (`primary`/`success`/`danger`) — Discord-only visual styling, Telegram ignores
  - Identity: `resolveAckReaction` per-channel/per-account — server-only multi-channel
  - Skills: `.agents/skills/` directories (personal + project), synced skill dedup, sandbox paths — server-only
  - Cron: massive refactor (stagger, webhook delivery, session scoped, skill filtering, subagent followup) — server-only
  - Memory: MMR reranking, temporal decay, query expansion, batch refactoring — all Node 22+/embedding

### 2026.2.12 (gap review)
- **Release Date:** 2026-02-12
- **SeekerClaw Sync Status:** Reviewed, nothing to port
- **Key Changes Reviewed:**
  - System prompt: prefer `[[reply_to_current]]` over `[[reply_to:<id>]]` — we only support `[[reply_to_current]]`, skip
  - System prompt: filter empty-path context files — defensive, our paths always valid
  - Skills: `.agents/skills/` personal/project directories, sandbox path resolution — server-only
  - Cron: session reaper (>24h), timer rearm fixes — server-only (we already have timer re-arm in finally)
  - Memory: embedding token limits, QMD query parser, session files — all Node 22+

### 2026.2.6 (gap review)
- **Release Date:** 2026-02-06
- **SeekerClaw Sync Status:** Key fix already present
- **Key Changes Reviewed:**
  - Cron: timer re-arm in `finally` block — **already in our code** (cron.js:477-479)
  - Cron: handle legacy `atMs` field, prevent recomputeNextRuns skipping — server-specific store migration
  - Memory: Voyage AI batch embedding — requires Node 22+

### 2026.2.3 (gap review)
- **Release Date:** 2026-02-03
- **SeekerClaw Sync Status:** Reviewed, nothing to port
- **Key Changes Reviewed:**
  - Identity: `resolveResponsePrefix` per-channel/per-account config — server-only multi-channel
  - Cron: major delivery normalization (`coerceDelivery`, legacy payload migration, `deleteAfterRun`) — server-only delivery routing; our cron is reminder-only
  - Skills: SKILL.md updates for bluebubbles, discord, imsg, tmux — platform-specific skills we don't bundle

### 2026.2.18-dev (f9e67f3)
- **Release Date:** 2026-02-18
- **SeekerClaw Sync Status:** Ported (BAT-189, PR #117)
- **1,563 new commits since last sync (e927fd1)**
- **Key Changes Ported:**
  - [x] System prompt: reply tags must be first token in message (no leading text/newlines)
  - [x] Skills: adopt "Use when / Don't use when" routing blocks across all 19 bundled skills
- **Skipped (not applicable):**
  - Cron: 48h daily job skip fix (#17852) — our per-job compute doesn't have this bug
  - Cron: spin loop on same-second completion (#17821) — we don't support cron expressions
  - Cron: stagger controls, webhook delivery, sessionKey routing — server-only features
  - Cron: run telemetry (model/token usage per run) — nice-to-have, defer
  - Sub-agent orchestration, sandbox paths, inline button styles — no sub-agents/sandbox
  - Memory: temporal decay for search scores — requires embedding search (Node 22+)
  - Memory: sync progress tracking — embedding-specific
  - Skills: path compaction with ~ — desktop-only pattern
  - Skills: nested root detection, limits (maxCandidates etc.) — not needed at 34 skills
  - Telegram: only version bumps, zero functional changes
  - Massive test/formatting refactoring (oxfmt, type fixes) — test-only
- **Notable upstream:**
  - Skills now use "Use when / Don't use when" routing blocks for better semantic matching
  - Temporal decay for memory search (30-day half-life, exponential) — future port candidate
  - Skills limits: max 300 candidates/root, 150 in prompt, 256KB file, 30K chars
  - Cron run telemetry with model/provider/usage tracking
  - New version tags: v2026.2.15, v2026.2.16, v2026.2.17

### 2026.2.14 (e927fd1)
- **Release Date:** 2026-02-15
- **SeekerClaw Sync Status:** Key changes ported
- **Key Changes Ported:**
  - [x] System prompt: poll loop avoidance guidance for shell_exec
- **Skipped (not applicable):**
  - Sub-agent orchestration (subagents tool, system message handling) — no sub-agents
  - Sandbox/container workspace path resolution — no Docker on mobile
  - Memory QMD/embedding refactoring — requires Node 22+ / node:sqlite
  - Skills refresh watch optimization (SKILL.md glob patterns) — no file watcher
  - Cron normalize partial agentTurn payloads — SeekerClaw uses reminder-only payloads
  - Cron sub-agent wait/poll logic — no sub-agent system
  - Web/auto-reply test infrastructure refactoring — test-only
- **Notable upstream:**
  - New `subagents` tool (list/steer/kill sub-agent runs)
  - Cron jobs now wait for sub-agent completion before delivering
  - Heavy test refactoring across web, cron, memory subsystems
  - Skills watcher switched to SKILL.md glob patterns to avoid FD exhaustion

### 2026.2.13 (71f357d)
- **Release Date:** 2026-02-14
- **SeekerClaw Sync Status:** Key changes ported
- **Key Changes Ported:**
  - [x] web-fetch: Accept header prefers `text/markdown` (Cloudflare Markdown for Agents)
  - [x] web-fetch: cf-markdown extractor for pre-rendered markdown responses
  - [x] web-search: Perplexity freshness/recency filter support
  - [x] Error handling: distinct user messages for rate limit vs overloaded
- **Skipped (not applicable):**
  - Memory QMD search mode default change (no QMD in SeekerClaw)
  - Discord skill rewrite (no Discord channel)
  - Skills-install archive hardening (no skill install)
  - Telegram poll support (defer)
  - Telegram replyToMode default change (SeekerClaw uses direct polling)
- **Notable upstream:**
  - 60+ commits, tags v2026.2.12 and v2026.2.13
  - Many security hardening fixes (channels, browser, media, archives)
  - New providers: Hugging Face, MiniMax CN, vLLM
  - Podman container support
  - Write-ahead delivery queue for crash recovery

### 2026.2.10-dev (029b77c)
- **Release Date:** 2026-02-11
- **SeekerClaw Sync Status:** Synced (critical fixes ported)
- **Key Changes Ported:**
  - [x] Strip `<think>` / `<thinking>` reasoning tags from responses before sendMessage()
  - [x] Strip `[Historical context:...]` markers from responses
- **Deferred:**
  - [ ] Cron session reaper (reap sessions >24h old)
  - [ ] Timezone-aware time parsing (Intl.DateTimeFormat)
  - [ ] Session compaction improvements
  - [ ] Extended thinking support

### 2026.2.9-dev (40b11db)
- **Release Date:** 2026-02-09
- **SeekerClaw Sync Status:** Stability fixes ported
- **Key Changes Ported:**
  - [x] Cross-process SharedPreferences fix
  - [x] BRIDGE_TOKEN TDZ fix
  - [x] Ephemeral credentials (config.json deleted after read)
  - [x] Per-boot bridge auth token

### 2026.2.2 (1c4db91)
- **Release Date:** 2026-02-03
- **SeekerClaw Sync Status:** Initial baseline
- **Key Changes:**
  - [x] System prompt adapted for mobile
  - [x] Memory system (file-based)
  - [x] Skills system (keyword matching)
  - [x] Cron system (full port)

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
OLD_COMMIT="71f357d"  # Previous version
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
