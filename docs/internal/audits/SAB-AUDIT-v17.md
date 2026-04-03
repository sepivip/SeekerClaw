# SAB-AUDIT-v17 — SeekerClaw Agent Self-Knowledge Audit

> **Date:** 2026-04-03
> **Scope:** Re-audit after Discord channel support (BAT-483, PR #310) — Gateway v10 WebSocket client, channel.js abstraction layer, vendored ws@8.18.0, message normalization, channel-aware system prompt, conditional tool loading, ChannelConfigScreen, DiscordConfigScreen. 41 files changed, +8,133/-198.
> **Method:** Full read of buildSystemBlocks() + diagnostic coverage map + tool consistency spot-check
> **Baseline:** SAB-AUDIT-v16.md (2026-03-31, 165/165 = 100%)

## Overall Scorecard

| Section | v16 Score | v17 Score | Max | % |
|---------|-----------|-----------|-----|---|
| A: Knowledge & Doors | 78/78 | 84/84 | 84 | 100% |
| B: Diagnostic Coverage | 57/57 | 66/66 | 66 | 100% |
| C: Tool Consistency | 30/30 | 30/30 | 30 | 100% |
| **Combined** | **165/165** | **180/180** | **180** | **100%** |

## Section A: Knowledge & Doors (84/84)

### Identity (5/5 = 15/15)
| Item | v16 | v17 | Notes |
|------|-----|-----|-------|
| Own name/version | OK | OK | SeekerClaw v1.8.0 (via PLATFORM.md) |
| Model | OK | OK | Dynamic from config — line 678 |
| Device/hardware | OK | OK | PLATFORM.md injected |
| Who built it | OK | OK | OpenClaw gateway — line 439 |
| Official channels | OK | OK | Website, X, Telegram, GitHub — line 440 |

### Architecture (5/5 = 15/15) — was 4, now 5
| Item | v16 | v17 | Notes |
|------|-----|-----|-------|
| Node<>Kotlin bridge | OK | OK | localhost:8765 — line 448 |
| UI vs :node process | OK | OK | Two-process model — lines 444-449 |
| Health monitoring | OK | OK | Heartbeat every 60s, stale at 120s — line 700 |
| Channel connection | OK | OK | Dynamic: Telegram polling (lines 527-532) OR Discord WebSocket (lines 533-538) depending on CHANNEL |
| **NEW: Channel abstraction** | — | OK | channel.js routes to telegram.js or discord.js — line 22 in ai.js, channel.js read |

### Capabilities (6/6 = 18/18)
| Item | v16 | v17 | Notes |
|------|-----|-----|-------|
| Full tool list | OK | OK | 71 tools across 11 domain files |
| Sandboxed tools | OK | OK | shell_exec allowlist, js_eval VM |
| What it cannot do | OK | OK | 6/6 negative boundaries |
| Skills load/trigger | OK | OK | Semantic matching + requirements |
| Search provider system | OK | OK | 5 providers, provider param, Settings guidance — line 481 |
| Custom provider | OK | OK | Provider section line 957-962, Config Awareness line 681, troubleshooting lines 765-779 |

### Negative Knowledge Sub-Score (6/6)
| Boundary | Present |
|----------|---------|
| No internet browsing | OK |
| No image/audio/video generation | OK |
| No direct cloud/infra access | OK |
| No cross-device reach | OK |
| No persistent background tasks | OK |
| No real-time data without tools | OK |

### Configuration (4/4 = 12/12)
| Item | v16 | v17 | Notes |
|------|-----|-----|-------|
| Config files | OK | OK | agent_settings.json, PLATFORM.md |
| Settings agent can change | OK | OK | agent_settings.json keys |
| API keys needed | OK | OK | Search provider keys, Jupiter, custom provider credentials |
| Model/heartbeat change | OK | OK | Via agent_settings.json |

### Self-Diagnosis (7/7 = 21/21) — was 6, now 7
| Item | v16 | v17 | Notes |
|------|-----|-----|-------|
| Health stale | OK | OK | Heartbeat playbook |
| Telegram disconnects | OK | OK | 401/429 playbook |
| Skill fails | OK | OK | Requirements gating |
| Conversation corruption | OK | OK | Loop detector + /new + /reset |
| Loop detection | OK | OK | DeerFlow identical-call detector (warn@3, break@5) |
| Search provider errors | OK | OK | "not configured" + API error guidance |
| **NEW: Discord connection issues** | — | OK | Gateway errors (4004/4014), WebSocket disconnect/reconnect, rate limits — DIAGNOSTICS.md + system prompt lines 533-538, 734 |

### New Doors Added
1. **Channel abstraction** (Architecture): Agent knows about channel.js routing layer. System prompt dynamically switches all channel-specific text (21+ references) between Telegram and Discord based on CHANNEL config. Architecture section (line 447) names the correct channel. This covers: formatting guidance, file sending limits, reply tags, reactions, polling vs WebSocket, debug log labels.
2. **Discord connection issues** (Self-Diagnosis): DIAGNOSTICS.md now covers 3 Discord failure modes: invalid token/missing intents (4004/4014), WebSocket disconnect/reconnection, rate limits (429). System prompt playbook (line 734) dynamically references "Discord gateway" or "Telegram poll" based on channel.

### 3-Part Test for Discord Feature
| Feature | Changes behavior? | Users ask about it? | Wrong answer without door? | Door needed? |
|---------|-------------------|---------------------|---------------------------|--------------|
| Discord channel support | YES (new channel) | YES ("how do I switch to Discord?") | YES (agent would reference only Telegram) | YES — ADDED |
| channel.js abstraction | Internal refactor | No | No (transparent to user) | Architectural awareness — ADDED |
| ChannelConfigScreen/DiscordConfigScreen | Yes (new UI) | Yes | No (agent doesn't control Android UI) | No |
| vendored ws@8.18.0 | No (internal dependency) | No | No | No |
| Message normalization | No (transparent) | No | No | No |

### Constants Verification
| Constant | Code | Prompt | Match |
|----------|------|--------|-------|
| MAX_TOOL_USES | 25 | 25 | OK |
| MAX_HISTORY | 35 | 35 | OK |
| max_tokens | 4096 | 4096 | OK |
| CONFIRM_REQUIRED | 8 tools | 8 tools | OK |
| LOOP_WARN | 3 | 3 | OK |
| LOOP_BREAK | 5 | 5 | OK |
| CONTEXT_SUMMARIZE | 0.85 | ~85% | OK |
| BLOCKED_MODULES | 7 | 7 | OK |
| js_eval timeout | 30s | 30s | OK |
| shell_exec timeout | 30s | 30s | OK |

---

## Section B: Diagnostic Coverage (66/66)

22 failure modes (was 19, +3 Discord modes).

| Subsystem | Failure Mode | Coverage | Source |
|-----------|-------------|----------|--------|
| Channel | Channel identification | OK | DIAGNOSTICS.md (new header section) |
| Telegram | Bot token invalid/revoked | OK | DIAGNOSTICS.md |
| Telegram | Rate limited (429) | OK | DIAGNOSTICS.md |
| **NEW: Discord** | **Bot token invalid / missing intents (4004/4014)** | OK | **DIAGNOSTICS.md (added)** |
| **NEW: Discord** | **WebSocket disconnect / reconnection** | OK | **DIAGNOSTICS.md (added)** |
| **NEW: Discord** | **Rate limited (429)** | OK | **DIAGNOSTICS.md (added)** |
| LLM API | Transport timeout | OK | DIAGNOSTICS.md |
| LLM API | Context overflow | OK | DIAGNOSTICS.md |
| LLM API | Custom provider connection/format errors | OK | DIAGNOSTICS.md |
| Tools | Confirmation gate timeout (60s) | OK | System prompt |
| Tools | Tool result truncated (~50K chars) | OK | DIAGNOSTICS.md (fixed from stale ~120KB) |
| Memory | memory_save fails (fs full) | OK | DIAGNOSTICS.md |
| Memory | memory_search returns nothing | OK | DIAGNOSTICS.md |
| Cron | Job fails to send reminder | OK | DIAGNOSTICS.md |
| Cron | Jobs lost after restart | OK | DIAGNOSTICS.md |
| Bridge | Service down (ECONNREFUSED) | OK | DIAGNOSTICS.md |
| Bridge | Permission-specific errors | OK | DIAGNOSTICS.md |
| MCP | Server unreachable | OK | DIAGNOSTICS.md |
| MCP | Tool definition changed (rug-pull) | OK | DIAGNOSTICS.md |
| MCP | Rate limit exceeded | OK | DIAGNOSTICS.md |
| Skills | Requirements not met | OK | DIAGNOSTICS.md |
| Web Search | Provider not configured | OK | DIAGNOSTICS.md |
| Web Search | Provider API error (401/429/5xx) | OK | DIAGNOSTICS.md |

---

## Section C: High-Risk Tool Consistency (30/30)

10 tools checked, all 3 sources agree.

| Tool | Description | Prompt | DIAG | Score |
|------|------------|--------|------|-------|
| shell_exec | Sandboxed, allowlist, 30s | OK | OK | OK |
| js_eval | VM sandbox, 30s, 7 blocked | OK | OK | OK |
| jupiter_swap | Confirmation required, quote first | OK | OK | OK |
| android_sms | Confirmation required | OK | OK | OK |
| android_call | Confirmation required | OK | OK | OK |
| android_notification | User-visible | OK | N/A | OK |
| memory_save | File-based, workspace path | OK | OK | OK |
| web_fetch | 50K limit, timeout | OK | OK | OK |
| cron_create | Persistent, JSON storage | OK | OK | OK |
| tool_search | Deferred loading, on-demand | OK | N/A | OK |

**Channel-specific gaps:** None. System prompt dynamically switches all 21+ channel references. Discord and Telegram each get correct formatting guidance, file size limits, connection diagnostics, and tooling hints.

---

## Gaps Fixed (This Audit)

1. **DIAGNOSTICS.md** — Added "Channel Connection" header section explaining channel.js routing and how to determine which channel is active
2. **DIAGNOSTICS.md** — Added 3 Discord failure modes: invalid token/missing intents (4004/4014), WebSocket disconnect/reconnection, rate limits (429) with grep commands and fix steps
3. **DIAGNOSTICS.md** — Fixed stale tool truncation value: "~120KB" corrected to "~50K characters (HARD_MAX_TOOL_RESULT_CHARS)" matching actual config.js value of 50000
4. **PROJECT.md** — Fixed "Single channel" limitation to "Two channels (Telegram + Discord)"
5. **PROJECT.md** — Updated architecture diagram: "User (Telegram)" to "User (Telegram/Discord)", "HTTPS/polling" to "HTTPS/WSS polling/WS"
6. **PROJECT.md** — Updated roadmap: "Multi-channel (Discord, WhatsApp)" to "Multi-channel (WhatsApp, Slack)" since Discord is shipped
7. **PROJECT.md** — Updated stats: commits 490+, PRs 310+, added Channels row (2), JS ~17,800 lines (was ~16,400), Kotlin 45 files
8. **PROJECT.md** — Added Discord feature and SAB-AUDIT-v17 to changelog

## Code Issues Found

- **DIAGNOSTICS.md stale value:** Tool result truncation documented as "~120KB" but actual `HARD_MAX_TOOL_RESULT_CHARS` in config.js is 50,000 characters (~50KB). Fixed.

## System Prompt Channel Coverage Audit

The system prompt (buildSystemBlocks in ai.js) has 21+ dynamic `CHANNEL` references that correctly switch between Telegram and Discord. Key channel-aware sections:

| Section | Telegram | Discord | Dynamic? |
|---------|----------|---------|----------|
| Identity line (438) | "through Telegram" | "through Discord" | YES |
| Architecture (447) | "Telegram polling" | "Discord polling" | YES |
| Screenshots (466-469) | telegram_send_file | shell_exec only | YES |
| File sending (486-490) | 50MB/10MB limits | 25MB limit | YES |
| Channel polling (527-538) | Long-polling section | WebSocket section | YES |
| Formatting (542-559) | No headers, emoji+bold | Markdown headers OK | YES |
| Workspace layout (641) | "Telegram files" | "Discord files" | YES |
| Environment (647) | "use Telegram" | "use Discord" | YES |
| File system doors (668,672) | "Telegram polling" | "Discord polling" | YES |
| Diagnostics (718) | "Telegram polling" | "Discord polling" | YES |
| Self-diagnosis (734) | "Telegram poll" | "Discord gateway" | YES |
| Cron delivery (871) | "Telegram" | "Discord" | YES |
| Silent replies (887) | "Telegram" | "Discord" | YES |
| Reply tags (892-899) | Telegram-only section | Skipped | YES |
| Reactions (904-912) | telegram_react | Generic | YES |

**Verdict:** The system prompt is fully channel-aware. No additional doors needed in ai.js.

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
v17 █████████████████████████ 100% (180/180)
```

**Delta from v16:** +15 points (1 new architecture door x 3 + 1 new diagnosis door x 3 + 3 new diagnostic failure modes x 3)
