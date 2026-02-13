# OpenClaw Parity Plan — SeekerClaw

> **Reference:** OpenClaw v2026.2.12 (bdd0c12, 2026-02-12)
> **SeekerClaw:** main branch (7c96441)
> **Created:** 2026-02-12

---

## Sprint 1: Bug Fixes & Quick Wins (main.js only)

### 1.1 Cron Bug Fixes (HIGH priority, ~60 lines)
Port 4 recent OpenClaw cron fixes that prevent real bugs:

- [x] **One-shot re-fire prevention** — Jobs re-fire on restart after skip/error (OpenClaw a88ea42)
- [x] **Duplicate fire prevention** — Multiple jobs firing simultaneously (OpenClaw dd6047d)
- [x] **DeleteAfterRun on skipped jobs** — Clean up properly (OpenClaw f7e05d0)
- [x] **Timer re-arming during active execution** — Preserve jobs across restarts (OpenClaw d31caa8)

### 1.2 Error Handling Improvements (MEDIUM priority, ~50 lines)
Stop sending raw API errors to users:

- [x] **Billing 402 handling** — "Upgrade your account" instead of raw JSON (OpenClaw bdd0c12, 4f329f9)
- [x] **Cloudflare 521 detection** — Retry with longer delay (OpenClaw b912d39)
- [x] **Transient 5xx graceful degradation** — Retry 500/502/503/504 (OpenClaw b912d39)
- [x] **Error classification** — Retryable vs fatal vs auth vs quota

### 1.3 Timestamp Fix (LOW priority, ~10 lines)
- [x] **Local timezone with offset** — Replace `toISOString()` (UTC) with local time + offset (OpenClaw 2b5df1d, 468414c)

### 1.4 Telegram Blockquotes (LOW priority, ~5 lines)
- [x] **Native blockquote tags** — Render `> text` as `<blockquote>` in Telegram (OpenClaw 8dd60fc)

**Sprint 1 Total: ~125 lines in main.js**

---

## Sprint 2: SQL.js Memory System (main.js only)

### 2.1 Memory Tables (HIGH priority, ~100 lines)
Add OpenClaw-compatible memory indexing to existing sql.js DB:

- [x] **chunks table** — `id, path, source, start_line, end_line, hash, text, updated_at`
- [x] **files table** — `path, source, hash, mtime, size`
- [x] **meta table** — `key, value (JSON)`
- [x] **Index existing memory files** — Parse MEMORY.md + daily/*.md into chunks on startup

### 2.2 Improved Memory Search (HIGH priority, ~80 lines)
Replace basic keyword matching with ranked search:

- [x] **LIKE-based keyword search** — `WHERE text LIKE '%term%'` with AND logic
- [x] **Term frequency scoring** — Count matches per chunk, rank by relevance
- [x] **Recency weighting** — Newer memories score higher
- [x] **Return top-K results** with line citations

### 2.3 Request Analytics Queries (MEDIUM priority, ~30 lines)
Leverage existing `api_request_log` table:

- [x] **Daily/monthly usage stats** — Token counts, request counts, avg latency
- [x] **Expose via session_status tool** — So agent can report its own usage
- [x] **Error rate tracking** — Success vs failure percentages

**Sprint 2 Total: ~210 lines in main.js**

---

## Sprint 3: System Prompt Parity (main.js only)

### 3.1 Missing Prompt Sections (MEDIUM priority, ~100 lines)
Add sections present in OpenClaw but missing in SeekerClaw:

- [x] **Reasoning format hints** — Guide model on when to think step-by-step
- [x] **Error recovery guidance** — How agent should handle tool failures
- [x] **Memory search-before-read pattern** — "Search memory before reading full files"
- [x] **Sandbox awareness** — Agent knows it runs on mobile with limitations
- [x] **Model-specific instructions** — Different guidance for Opus vs Sonnet vs Haiku

### 3.2 Ephemeral Session on Boot (LOW priority, ~5 lines)
- [x] **Clear conversation on Node.js restart** — Prevent stale context (OpenClaw 4736fe7)

**Sprint 3 Total: ~105 lines in main.js**

---

## Sprint 4: Android UI Enhancements (Kotlin)

### 4.1 Request Analytics Dashboard (MEDIUM priority)
Surface SQL.js analytics data in the Android UI:

- [x] **System screen** — Show daily/monthly token usage from api_request_log
- [x] **Dashboard** — Mini stats from DB (total requests, avg latency)
- [x] **Bridge endpoint** — `/stats/db-summary` to query SQLite stats

### 4.2 Memory Status in System Screen (LOW priority)
- [x] **Show memory file count** — How many memory files indexed
- [x] **Show chunk count** — How many searchable chunks
- [x] **Show last indexed time** — When memory was last scanned

---

## Deferred (Not in current sprints)

| Feature | Why Deferred |
|---------|-------------|
| Vector embeddings | Requires embedding API calls (cost + latency on mobile) |
| FTS5 full-text search | Needs precompiled sql.js with FTS5 |
| Cross-agent skills | Single-agent only in v1 |
| Telegram reactions | Low user impact |
| Multi-channel support | Telegram-only in v1 |
| Extended thinking | Model-specific, low priority |
| Session transcript indexing | Not needed for Telegram-only |

---

## Summary

| Sprint | Focus | Files | Lines | Priority |
|--------|-------|-------|-------|----------|
| **1** | Bug fixes + quick wins | main.js | ~125 | HIGH |
| **2** | SQL.js memory system | main.js | ~210 | HIGH |
| **3** | System prompt parity | main.js | ~105 | MEDIUM |
| **4** | Android UI analytics | Kotlin + main.js | ~200 | MEDIUM |

**Total estimated: ~640 lines across 4 sprints**

All Sprint 1-3 changes are in main.js only (Node.js side). Sprint 4 touches Kotlin UI.
