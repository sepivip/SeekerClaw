# SAB-AUDIT-v15 — SeekerClaw Agent Self-Knowledge Audit

> **Date:** 2026-03-23
> **Scope:** Re-audit after Search Provider System (BAT-481): DDG removal, Exa/Tavily/Firecrawl addition, http.js extraction, SearchProviderConfigScreen
> **Method:** Full read of buildSystemBlocks() + diagnostic coverage map + tool consistency spot-check
> **Baseline:** SAB-AUDIT-v14.md (2026-03-22, 147/147 = 100%)

## Overall Scorecard

| Section | v14 Score | v15 Score | Max | % |
|---------|-----------|-----------|-----|---|
| A: Knowledge & Doors | 69/69 | 72/72 | 72 | 100% |
| B: Diagnostic Coverage | 48/48 | 54/54 | 54 | 100% |
| C: Tool Consistency | 30/30 | 30/30 | 30 | 100% |
| **Combined** | **147/147** | **156/156** | **156** | **100%** |

## Section A: Knowledge & Doors (72/72)

### Identity (5/5 = 15/15)
| Item | v14 | v15 | Notes |
|------|-----|-----|-------|
| Own name/version | ✅ | ✅ | SeekerClaw v1.7.0 |
| Model | ✅ | ✅ | Dynamic from config |
| Device/hardware | ✅ | ✅ | Android/Seeker phone |
| Who built it | ✅ | ✅ | OpenClaw gateway |
| Official channels | ✅ | ✅ | Website, X, Telegram, GitHub |

### Architecture (4/4 = 12/12)
| Item | v14 | v15 | Notes |
|------|-----|-----|-------|
| Node↔Kotlin bridge | ✅ | ✅ | localhost:8765 |
| UI vs :node process | ✅ | ✅ | Two-process model |
| Health monitoring | ✅ | ✅ | Heartbeat every 60s, stale at 120s |
| Telegram polling | ✅ | ✅ | grammy long-polling |

### Capabilities (5/5 = 15/15) — was 4, now 5
| Item | v14 | v15 | Notes |
|------|-----|-----|-------|
| Full tool list | ✅ | ✅ | 71 tools across 10 domain files |
| Sandboxed tools | ✅ | ✅ | shell_exec allowlist, js_eval VM |
| What it cannot do | ✅ | ✅ | 6/6 negative boundaries |
| Skills load/trigger | ✅ | ✅ | Semantic matching + requirements |
| **NEW: Search provider system** | — | ✅ | Line 465: 5 providers, provider param, Settings guidance |

### Negative Knowledge Sub-Score (6/6)
| Boundary | Present |
|----------|---------|
| No internet browsing | ✅ |
| No image/audio/video generation | ✅ |
| No direct cloud/infra access | ✅ |
| No cross-device reach | ✅ |
| No persistent background tasks | ✅ |
| No real-time data without tools | ✅ |

### Configuration (4/4 = 12/12)
| Item | v14 | v15 | Notes |
|------|-----|-----|-------|
| Config files | ✅ | ✅ | agent_settings.json, PLATFORM.md |
| Settings agent can change | ✅ | ✅ | agent_settings.json keys |
| API keys needed | ✅ | ✅ | Line 636 updated: search provider keys listed |
| Model/heartbeat change | ✅ | ✅ | Via agent_settings.json |

### Self-Diagnosis (4/4 = 12/12)
| Item | v14 | v15 | Notes |
|------|-----|-----|-------|
| Health stale | ✅ | ✅ | Heartbeat playbook |
| Telegram disconnects | ✅ | ✅ | 401/429 playbook |
| Skill fails | ✅ | ✅ | Requirements gating |
| Conversation corruption | ✅ | ✅ | Loop detector + /new + /reset |

### New Door Added
- **Search provider system** (line 465): Agent knows about all 5 providers, the `provider` parameter, Settings > Search Provider guidance, and provider-specific result formats. This is a new capability door — users will ask "how do I search?" or get "not configured" errors.

### Constants Verification
| Constant | Code | Prompt | Match |
|----------|------|--------|-------|
| MAX_TOOL_USES | 25 | 25 | ✅ |
| MAX_HISTORY | 35 | 35 | ✅ |
| max_tokens | 4096 | 4096 | ✅ |
| CONFIRM_REQUIRED | 8 tools | 8 tools | ✅ |
| LOOP_WARN | 3 | 3 | ✅ |
| LOOP_BREAK | 5 | 5 | ✅ |
| CONTEXT_SUMMARIZE | 0.85 | ~85% | ✅ |
| BLOCKED_MODULES | 7 | 7 | ✅ |
| js_eval timeout | 30s | 30s | ✅ |
| shell_exec timeout | 30s | 30s | ✅ |

---

## Section B: Diagnostic Coverage (54/54)

18 failure modes (was 16, +2 new web search modes).

| Subsystem | Failure Mode | Coverage | Source |
|-----------|-------------|----------|--------|
| Telegram | Bot token invalid/revoked | ✅ | DIAGNOSTICS.md |
| Telegram | Rate limited (429) | ✅ | DIAGNOSTICS.md |
| LLM API | Transport timeout | ✅ | DIAGNOSTICS.md |
| LLM API | Context overflow | ✅ | DIAGNOSTICS.md |
| Tools | Confirmation gate timeout (60s) | ✅ | System prompt |
| Tools | Tool result truncated (>120KB) | ✅ | DIAGNOSTICS.md |
| Memory | memory_save fails (fs full) | ✅ | DIAGNOSTICS.md |
| Memory | memory_search returns nothing | ✅ | DIAGNOSTICS.md |
| Cron | Job fails to send reminder | ✅ | DIAGNOSTICS.md |
| Cron | Jobs lost after restart | ✅ | DIAGNOSTICS.md |
| Bridge | Service down (ECONNREFUSED) | ✅ | DIAGNOSTICS.md |
| Bridge | Permission-specific errors | ✅ | DIAGNOSTICS.md |
| MCP | Server unreachable | ✅ | DIAGNOSTICS.md |
| MCP | Tool definition changed (rug-pull) | ✅ | DIAGNOSTICS.md |
| MCP | Rate limit exceeded | ✅ | DIAGNOSTICS.md |
| Skills | Requirements not met | ✅ | DIAGNOSTICS.md |
| **NEW: Web Search** | **Provider not configured** | ✅ | **DIAGNOSTICS.md (added)** |
| **NEW: Web Search** | **Provider API error (401/429/5xx)** | ✅ | **DIAGNOSTICS.md (added)** |

---

## Section C: High-Risk Tool Consistency (30/30)

10 tools checked, all 3 sources agree.

| Tool | Description | Prompt | DIAG | Score |
|------|------------|--------|------|-------|
| shell_exec | Sandboxed, allowlist, 30s | ✅ | ✅ | ✅ |
| js_eval | VM sandbox, 30s, 7 blocked | ✅ | ✅ | ✅ |
| jupiter_swap | Confirmation required, quote first | ✅ | ✅ | ✅ |
| android_sms | Confirmation required | ✅ | ✅ | ✅ |
| android_call | Confirmation required | ✅ | ✅ | ✅ |
| android_notification | User-visible | ✅ | N/A | ✅ |
| memory_save | File-based, workspace path | ✅ | ✅ | ✅ |
| web_fetch | 50K limit, timeout | ✅ | ✅ | ✅ |
| cron_create | Persistent, JSON storage | ✅ | ✅ | ✅ |
| tool_search | Deferred loading, on-demand | ✅ | N/A | ✅ |

**Provider-specific gaps:** None. System prompt and DIAGNOSTICS.md both handle multi-provider correctly (Claude/OpenAI/OpenRouter for LLM, 5 providers for search).

---

## Gaps Fixed (This Audit)

1. **DIAGNOSTICS.md** — Added "Web Search" section with 2 failure modes + provider-specific troubleshooting notes
2. **PROJECT.md** — Updated web search description (removed DDG, added 5 providers), updated tool count (56 → 71)
3. **New door scored** — "Search provider system" added to Section A Capabilities (item 5)

## Code Issues Found

None. All changes are documentation/prompt fixes.

## Remaining Gaps

None. All items pass.

## Score Progression

```
v5  ████████████████████░░░░░  78% (35/45)
v6  ██████████████████████░░░  88% (53/60)
v7  ██████████████████████░░░  88% (53/60)
v8  ████████████████████████░  94% (85/90)
v9  ████████████████████████░  96% (87/90)
v10 █████████████████████████  98% (115/117)
v11 █████████████████████████ 100% (117/117)
v12 █████████████████████████ 100% (129/129)
v13 █████████████████████████ 100% (141/141)
v14 █████████████████████████ 100% (147/147)
v15 █████████████████████████ 100% (156/156)
```

**Delta from v14:** +9 points (1 new capability door × 3 + 2 new diagnostic failure modes × 3)
