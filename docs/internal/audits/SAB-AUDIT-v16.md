# SAB-AUDIT-v16 — SeekerClaw Agent Self-Knowledge Audit

> **Date:** 2026-03-31
> **Scope:** Re-audit after Custom AI Provider (BAT-482), main.js split (PR #303), SharedComponents consolidation (PRs #306-308), Repetition detector (PR #300), Quick Actions (PR #295), Git SHA + build date, v1.8.0
> **Method:** Full read of buildSystemBlocks() + diagnostic coverage map + tool consistency spot-check
> **Baseline:** SAB-AUDIT-v15.md (2026-03-23, 156/156 = 100%)

## Overall Scorecard

| Section | v15 Score | v16 Score | Max | % |
|---------|-----------|-----------|-----|---|
| A: Knowledge & Doors | 72/72 | 78/78 | 78 | 100% |
| B: Diagnostic Coverage | 54/54 | 57/57 | 57 | 100% |
| C: Tool Consistency | 30/30 | 30/30 | 30 | 100% |
| **Combined** | **156/156** | **165/165** | **165** | **100%** |

## Section A: Knowledge & Doors (78/78)

### Identity (5/5 = 15/15)
| Item | v15 | v16 | Notes |
|------|-----|-----|-------|
| Own name/version | ✅ | ✅ | SeekerClaw v1.8.0 (via PLATFORM.md) |
| Model | ✅ | ✅ | Dynamic from config — line 647 |
| Device/hardware | ✅ | ✅ | PLATFORM.md injected |
| Who built it | ✅ | ✅ | OpenClaw gateway — line 434 |
| Official channels | ✅ | ✅ | Website, X, Telegram, GitHub — line 435 |

### Architecture (4/4 = 12/12)
| Item | v15 | v16 | Notes |
|------|-----|-----|-------|
| Node<>Kotlin bridge | ✅ | ✅ | localhost:8765 — line 443 |
| UI vs :node process | ✅ | ✅ | Two-process model — lines 439-444 |
| Health monitoring | ✅ | ✅ | Heartbeat every 60s, stale at 120s — line 666 |
| Telegram polling | ✅ | ✅ | grammy long-polling — lines 514-518 |

### Capabilities (6/6 = 18/18) — was 5, now 6
| Item | v15 | v16 | Notes |
|------|-----|-----|-------|
| Full tool list | ✅ | ✅ | 71 tools across 10 domain files |
| Sandboxed tools | ✅ | ✅ | shell_exec allowlist, js_eval VM |
| What it cannot do | ✅ | ✅ | 6/6 negative boundaries |
| Skills load/trigger | ✅ | ✅ | Semantic matching + requirements |
| Search provider system | ✅ | ✅ | 5 providers, provider param, Settings guidance — line 472 |
| **NEW: Custom provider** | — | ✅ | Provider section line 920-924, Config Awareness line 650, troubleshooting lines 737-748 |

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
| Item | v15 | v16 | Notes |
|------|-----|-----|-------|
| Config files | ✅ | ✅ | agent_settings.json, PLATFORM.md |
| Settings agent can change | ✅ | ✅ | agent_settings.json keys |
| API keys needed | ✅ | ✅ | Search provider keys, Jupiter, custom provider credentials |
| Model/heartbeat change | ✅ | ✅ | Via agent_settings.json |

### Self-Diagnosis (6/6 = 18/18) — was 4, expanded to 6 (from v14)
| Item | v15 | v16 | Notes |
|------|-----|-----|-------|
| Health stale | ✅ | ✅ | Heartbeat playbook |
| Telegram disconnects | ✅ | ✅ | 401/429 playbook |
| Skill fails | ✅ | ✅ | Requirements gating |
| Conversation corruption | ✅ | ✅ | Loop detector + /new + /reset |
| Loop detection | ✅ | ✅ | DeerFlow identical-call detector (warn@3, break@5) |
| Search provider errors | ✅ | ✅ | "not configured" + API error guidance |

### New Door Added
- **Custom provider** (lines 650, 920-924): Agent knows about custom OpenAI-compatible gateways, where the user configures them (Settings > AI Provider > Custom), and how to troubleshoot when the custom endpoint fails. The Provider section (line 920) dynamically injects `CUSTOM_BASE_URL`. The troubleshooting playbook (lines 737-748) dynamically resolves billing URL and API hostname for custom providers. Config Awareness (line 650) explains the setup path.

### 3-Part Test for Other Recent Features
| Feature | Changes behavior? | Users ask about it? | Wrong answer without door? | Door needed? |
|---------|-------------------|---------------------|---------------------------|--------------|
| main.js split | No (internal refactor) | No | No | No |
| SharedComponents | No (UI-only refactor) | No | No | No |
| Repetition detector | Yes (silently blocks degenerate output) | Unlikely | No (invisible to user) | No |
| Quick Actions | Yes | Yes | No — already has door (lines 482-486) | Already covered |
| Git SHA + build date | No (debug info) | Unlikely | No | No |
| v1.8.0 bump | No (version in PLATFORM.md) | No | No | No |

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

## Section B: Diagnostic Coverage (57/57)

19 failure modes (was 18, +1 custom provider mode).

| Subsystem | Failure Mode | Coverage | Source |
|-----------|-------------|----------|--------|
| Telegram | Bot token invalid/revoked | ✅ | DIAGNOSTICS.md |
| Telegram | Rate limited (429) | ✅ | DIAGNOSTICS.md |
| LLM API | Transport timeout | ✅ | DIAGNOSTICS.md |
| LLM API | Context overflow | ✅ | DIAGNOSTICS.md |
| **NEW: LLM API** | **Custom provider connection/format errors** | ✅ | **DIAGNOSTICS.md (added)** |
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
| Web Search | Provider not configured | ✅ | DIAGNOSTICS.md |
| Web Search | Provider API error (401/429/5xx) | ✅ | DIAGNOSTICS.md |

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

**Provider-specific gaps:** None. System prompt and DIAGNOSTICS.md now handle all 4 LLM providers (Claude/OpenAI/OpenRouter/Custom) and 5 search providers.

---

## Gaps Fixed (This Audit)

1. **ai.js** — Added custom provider setup guidance to Config Awareness section (line 650): tells agent where users configure custom providers and how to troubleshoot
2. **DIAGNOSTICS.md** — Added "Custom Provider — Connection or Format Errors" failure mode with 5 specific diagnosis patterns (wrong URL, self-signed SSL, auth header mismatch, format mismatch, model ID mismatch) and fix steps
3. **DIAGNOSTICS.md** — Updated LLM API section header to include "Custom" alongside Claude/OpenAI/OpenRouter
4. **PROJECT.md** — Fixed architecture diagram tool count (56 -> 71), updated stats (commits 480+, PRs 309+, JS ~16,400 lines, Kotlin ~15,000 lines, 4 provider adapters), added Custom provider to AI Provider row, added 6 changelog entries for recent features

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
v16 █████████████████████████ 100% (165/165)
```

**Delta from v15:** +9 points (1 new capability door x 3 + 1 new diagnostic failure mode x 3)
