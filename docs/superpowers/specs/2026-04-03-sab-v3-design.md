# SAB v3 — Self-Awareness Benchmark Redesign

**Date:** 2026-04-03
**Status:** Approved
**Baseline:** SAB v2 (17 audits, last 4 at 100%)

## Problem

SAB v2 has been scoring 100% for 4 consecutive audits. The benchmark is no longer challenging — it checks boxes rather than finding real gaps. Specific issues:

1. **Stale file references** — skill references `claude.js` (renamed to `ai.js`) and `tools.js` (split to `tools/` directory)
2. **Static failure modes** — 16 hardcoded modes, doesn't discover new error paths from shipped features
3. **No behavioral verification** — checks source code strings, never traces whether the agent would actually find the right guidance
4. **Fix-and-score** — auditor fixes gaps in the same pass, so score is always 100%. Never shows real drift.
5. **Static tool list** — same 10 tools checked every time, 61 others never audited

## Design

### Two-Score System

Every audit reports two scores:
- **Pre-fix score** — raw state BEFORE any changes. The real quality signal. Measures how well the team maintains agent self-awareness as features ship.
- **Post-fix score** — after gaps are addressed. Should always be 100%.

Pre-fix trend is tracked across audits. Dropping below 90% signals features are shipping without prompt/diagnostics coverage.

### Section A: Knowledge & Doors (same as v2, with fixes)

Score baseline items across 5 categories. Same scoring (✅=3, ⚠️=1, ❌=0).

**File reference fixes:**
- `claude.js` → `ai.js`
- `tools.js` → `tools/*.js` (domain files)
- Remove hardcoded line numbers — use function name search: `grep -n "function buildSystemBlocks" ai.js`
- Update all grep commands for current file structure

**Categories (unchanged):**
- Identity (5): Own name/version, Model, Device/hardware, Who built it, Official channels
- Architecture (dynamic): Node↔Kotlin bridge, UI vs :node process, Health monitoring, Channel connection, Channel abstraction
- Capabilities (dynamic): Full tool list, Sandboxed tools, What it cannot do, Skills load/trigger, Search providers, Custom provider
- Configuration (4): Config files, Settings agent can change, API keys needed, Model/heartbeat change
- Self-Diagnosis (dynamic): Health stale, Channel disconnects, Skill fails, Conversation corruption, Loop detection, Search provider errors, Discord connection issues

**Negative knowledge checks:** same 6 boundaries.

**New doors:** same 3-part test. Max 30 total items (was 25).

### Section B: Diagnostic Coverage (hybrid discovery)

**Phase 1 — Curated critical list:** Keep the existing failure modes as a baseline. These are always checked:

| Subsystem | Failure Modes |
|-----------|--------------|
| Telegram | Token invalid, rate limited |
| Discord | Token invalid, WebSocket disconnect, rate limited |
| AI API | Transport timeout, context overflow, auth error |
| Tools | Confirmation timeout, result truncated |
| Memory | Save fails (fs full), search returns nothing |
| Cron | Job fails to deliver, jobs lost after restart |
| Bridge | Service down, permission errors |
| MCP | Server unreachable, rug-pull, rate limited |
| Skills | Requirements not met |
| Search | Provider API error, no provider configured |
| Custom Provider | Connection failed, format mismatch |

**Phase 2 — Auto-discovery:** Scan all JS files for error patterns:
```bash
grep -rn "log(.*'ERROR'\|throw new Error" app/src/main/assets/nodejs-project/*.js app/src/main/assets/nodejs-project/tools/*.js | grep -v node_modules
```
Extract unique error categories. For each, check if DIAGNOSTICS.md covers it. Flag uncovered error paths as ⚠️ (new errors aren't always user-facing — auditor decides if it needs coverage).

**Scoring:** ✅=3 (diagnosis path exists), ⚠️=1 (error visible but no guidance), ❌=0 (silent/no path)

### Section C: Tool Consistency (dynamic rotation)

**Fixed 5 (always checked):**
- `shell_exec` — command execution
- `js_eval` — code execution in VM
- `jupiter_swap` — financial transaction
- `android_sms` — sends SMS
- `android_call` — places calls

**Rotated 5 (different each audit):**
Pick 5 tools pseudo-randomly from the remaining pool. Use audit version number as seed for reproducibility:
```javascript
// Pseudo-random selection based on audit version
const pool = allTools.filter(t => !fixedTools.includes(t.name));
const selected = [];
let seed = auditVersion;
for (let i = 0; i < 5; i++) {
    seed = (seed * 31 + 7) % pool.length;
    selected.push(pool.splice(seed % pool.length, 1)[0]);
}
```

This ensures full tool coverage over ~14 audits (71 tools / 5 per rotation).

**Verification:** same 3-source check (tool description, system prompt, DIAGNOSTICS.md).

### Section D: Behavioral Probes (NEW)

Trace 5 "user asks for help" scenarios end-to-end. Don't call the AI — trace what it *would find* by following the doors.

**Probe methodology:**
1. Identify the door in the system prompt (the 1-2 line pointer)
2. Follow the door to the target file (DIAGNOSTICS.md, workspace file, etc.)
3. Check if the target has actionable content for the scenario
4. Score the full path

**5 Probe scenarios (rotate 3, keep 2 fixed):**

Fixed probes (always):
1. **"Web search is broken"** → system prompt mentions search provider → DIAGNOSTICS.md has search section → section has provider-specific troubleshooting
2. **"Agent won't respond to messages"** → system prompt mentions channel connection → DIAGNOSTICS.md has channel section → section covers both Telegram polling and Discord WebSocket

Rotated probes (3 per audit, from pool):
- "My swap failed" → jupiter/solana troubleshooting path
- "Discord disconnected" → Discord gateway troubleshooting path
- "Cron job didn't fire" → cron troubleshooting path
- "Memory search returns nothing" → memory troubleshooting path
- "MCP tool disappeared" → MCP rug-pull troubleshooting path
- "Agent is in a loop" → loop detector troubleshooting path
- "File too large to send" → file/media troubleshooting path
- "Custom provider errors" → custom provider troubleshooting path

**Scoring per probe:**
- ✅=3 — door exists, target file has section, content is actionable (steps to diagnose/fix)
- ⚠️=1 — door exists but target content is vague or incomplete
- ❌=0 — no door, or door points to nonexistent content

### Audit Report Format

```markdown
# SAB-AUDIT-v{N} — SeekerClaw Agent Self-Knowledge Audit

> Date / Scope / Method / Baseline

## Scores
| Section | Pre-fix | Post-fix | Max |
|---------|---------|----------|-----|
| A: Knowledge & Doors | X | X' | ... |
| B: Diagnostics (curated) | Y1 | Y1' | ... |
| B: Diagnostics (discovered) | Y2 | Y2' | ... |
| C: Tool Consistency (fixed) | Z1 | Z1' | 15 |
| C: Tool Consistency (rotated) | Z2 | Z2' | 15 |
| D: Behavioral Probes | W | W' | 15 |
| **Combined** | **total** | **total'** | **max** |

## Pre-fix Trend
| Audit | Pre-fix % | Post-fix % |
|-------|-----------|------------|
| v17 | (retroactive estimate) | 100% |
| v18 | X% | 100% |

## Section details...
## Gaps Found (pre-fix)
## Fixes Applied
## Remaining Gaps (should be "None")
```

### Skill File Updates

The skill file (`sab-audit/skill.md`) needs:
- Title: "SAB v3"
- All `claude.js` → `ai.js`
- All `tools.js` → `tools/*.js`
- Remove hardcoded line numbers
- Add Section D (behavioral probes)
- Add hybrid failure mode discovery
- Add dynamic tool rotation
- Add two-score reporting
- Update grep commands for current file structure
