# NikitaMWM — Engineering Brief & Agent Prompt

> **For:** Software engineer building NikitaMWM
> **Reference project:** SeekerClaw (in this repo — Android AI agent with memory system)
> **Date:** 2026-03-01

---

## 1. What Is NikitaMWM

NikitaMWM is a **self-improving AI trading agent** that runs on a VPS (Node.js), receives trading signals from an existing analysis system, makes informed decisions (take or skip), monitors open positions, and learns from outcomes by updating its own strategy.

### One-Sentence Summary

**An AI agent that sits between your signal engine and Binance Futures — it decides which signals to trade, monitors positions, writes post-mortems on every trade, and rewrites its own strategy rules based on what it learns.**

### What Makes It Different From a Normal Trading Bot

A normal bot executes rules mechanically. NikitaMWM:

1. **Decides** — receives a signal, fetches context (market data, structure, clusters, volume profile, prediction accuracy), compares against its strategy, and makes a reasoned GO/NO-GO decision
2. **Monitors** — after opening a trade, schedules its own follow-up checks ("wake me in 30 min to see how this trade is doing")
3. **Learns** — after every trade closes, writes a post-mortem (what happened, why, was the strategy followed?), logs mistakes, and periodically rewrites its own strategy rules
4. **Remembers** — has structured persistent memory (7 separate files, each for a different purpose), searchable via SQLite FTS5
5. **Talks** — the owner can ask anything via Telegram ("how's my ETH trade?", "why did you skip the last signal?", "what mistakes have you made this week?")

---

## 2. Why SeekerClaw Was Studied (And What We Take From It)

SeekerClaw is an Android app that runs an AI agent 24/7. Its memory system was studied to understand what works and what doesn't for persistent AI memory.

### What SeekerClaw Does Well (We Keep These Ideas)

| SeekerClaw Pattern | NikitaMWM Equivalent |
|---|---|
| Auto session summaries (on idle, checkpoint, shutdown) | Auto post-mortems on trade close + daily/weekly reviews |
| SQL.js memory indexing with ranked search | SQLite FTS5 (native, better — VPS has no Node 18 constraint) |
| Memory injected into every system prompt | Dynamic context injection per trigger type (smarter — less token waste) |
| SOUL.md personality file | IDENTITY.md + STRATEGY.md (split personality from trading rules) |
| Daily memory files (memory/YYYY-MM-DD.md) | Same — daily notes for observations and decisions |
| Agent can read/write its own memory | Agent can read/write/overwrite — including rewriting its own strategy |

### What SeekerClaw Does Poorly (We Fix These)

| SeekerClaw Problem | NikitaMWM Solution |
|---|---|
| **One big MEMORY.md blob** — everything in one file, truncated at 3000 chars in system prompt | **7 separate files** — each injected only when relevant to the trigger |
| **Keyword search only** — "my dog" won't match "pet" | **SQLite FTS5** — proper full-text search (still keyword, but much better tokenization and ranking) |
| **No learning loop** — agent saves memories but doesn't act on them | **Closed feedback loop** — Signal → Decision → Trade → Outcome → Post-Mortem → Strategy Update → better decisions |
| **Append-only memory** — MEMORY.md only grows, never consolidates | **Overwrite where appropriate** — MARKET_STATE.md is refreshed, STRATEGY.md is rewritten |
| **Same context for every call** — wastes tokens on irrelevant memory | **Dynamic context assembly** — signal trigger gets STRATEGY + SIGNAL_TRUST, trade check gets risk rules + trade details |
| **No outcome tracking** — agent doesn't know if its decisions were good | **Structured decision log** — every signal → TAKE/SKIP, with outcome tracked in SQLite |

---

## 3. The Data Source (Already Built)

The agent reads from an existing analysis API that runs on a separate VPS. This system already does the hard analytical work — the agent's job is synthesis + decision-making + learning.

**Base URL:** `http://38.242.154.6:8000`
**Auth:** `X-API-Key` header
**Symbols:** BTCUSDT, ETHUSDT, SOLUSDT

### API Endpoints and What They Return

| Endpoint | Returns | Agent Uses It For |
|---|---|---|
| `GET /api/v1/status` | Bot version, enabled features, tracked symbols, cluster stats, fill rates | System health check |
| `GET /api/v1/market/{symbol}` | Real-time price, CVD (5m/1h/4h/1d), bias, OI signal, funding, liquidations, sentiment, market_intent, stop hunt status, cross-exchange spread | **Primary decision input** — market_intent is a human-readable synthesis |
| `GET /api/v1/structure/{symbol}` | Daily/4h trend (direction + strength), swing highs/lows (with broken status), BOS/CHOCH events, FVGs, weekly S/R | Structural context — trend alignment check |
| `GET /api/v1/predictions/{symbol}` | Active signals, direction, strength, entry details, timeframe balance (buy/sell clusters at 5m-8h) | **Signal details** — what triggered the webhook |
| `GET /api/v1/predictions/{symbol}/stats` | Per-rule accuracy at 1h/4h, per-direction accuracy, sample sizes, average returns | **Critical for signal trust** — R1 long 75% accurate, R2 short 12.5% |
| `GET /api/v1/predictions/{symbol}/history` | Historical signals with forward returns | Pattern analysis — which signals performed? |
| `GET /api/v1/clusters/{symbol}` | Individual volume clusters with price, type, delta, OI change, forward returns at 1m-1h | Where large volume events happened and what followed |
| `GET /api/v1/clusters/{symbol}/zones` | Price zones with buy/sell cluster counts, forward return stats per direction | Zone-level edge quantification |
| `GET /api/v1/clusters/{symbol}/outcomes` | Aggregate BUY vs SELL cluster performance across all timeframes | "Do buy clusters actually predict up?" |
| `GET /api/v1/clusters/{symbol}/stats` | Summary cluster counts, average volume ratio | Quick overview |
| `GET /api/v1/volume-profile/{symbol}` | POC, value area, per-zone volume, node types (HVN/LVN), S/R quality, bounce/break rates | Support/resistance zones and price acceptance |
| `GET /api/v1/candles/{symbol}` | 100 most recent 4h OHLCV candles | Price action context |
| `GET /api/v1/trades/active` | Current open position(s) with entry, SL, TP1/TP2, signal_score, deviation_type, ATR, R:R | Trade monitoring |
| `GET /api/v1/trades/history` | Closed trades with full details and PnL | Performance review |
| `GET /api/v1/trades/stats` | Win rate, avg PnL, total trades, hold times | Aggregate performance |

### Key Data Characteristics

1. **`market_intent`** field is a human-readable AI synthesis — e.g., "Short liquidation cascade in progress - forced buying driving price up; Bullish reversal setup forming." This is gold for the agent.

2. **Prediction fields (`state`, `phase`, `strength`, `phase_detail`)** are in **Georgian language**. Claude can read Georgian natively — no translation layer needed.

3. **Forward returns are pre-computed** — `fwd_return_1m` through `fwd_return_1h` on clusters and predictions. The feedback loop is partially built into the data.

4. **Prediction stats track accuracy per rule type:**
   - R1 (Absorption — SELL spike + 5m UP + OI rise): 75% accurate on longs at 1h, 90.9% at 4h
   - R2 (Exhaustion — BUY spike + 5m DOWN): 12.5% accurate on shorts
   - The agent should learn to weight these differently

5. **Active trade structure** already has everything: entry, SL, TP1/TP2, signal_score, deviation_type, htf_trend, risk_reward.

---

## 4. Architecture

```
YOUR SIGNAL ENGINE                    NIKITAMWM (AI AGENT)
┌──────────────────┐                  ┌─────────────────────────────────┐
│                  │  webhook:signal  │                                 │
│  Cluster         │ ───────────────► │  1. Fetch full context (API)    │
│  Detection       │                  │  2. Read STRATEGY.md            │
│  Prediction      │                  │  3. Read SIGNAL_TRUST.md        │
│  Engine          │                  │  4. Decide: TAKE or SKIP        │
│                  │                  │  5. If TAKE → execute_trade     │
│  ┌────────────┐  │  webhook:opened  │  6. Schedule self-callbacks     │
│  │ Binance    │  │ ◄─────────────── │  7. Log decision + reasoning    │
│  │ Futures    │  │ ───────────────► │                                 │
│  │ Execution  │  │  webhook:closed  │  On self-callback:              │
│  └────────────┘  │ ───────────────► │  - Fetch fresh data             │
│                  │                  │  - Check trade status            │
└──────────────────┘                  │  - HOLD / CLOSE / ADJUST        │
                                      │  - Schedule next check           │
      ┌──────────┐                    │                                 │
      │ Telegram │ ◄────────────────► │  On trade close:                │
      │ (owner)  │  user messages +   │  - Post-mortem → JOURNAL.md     │
      └──────────┘  proactive alerts  │  - Failures → MISTAKES.md       │
                                      │  - Update SIGNAL_TRUST.md       │
      ┌──────────┐                    │  - Refine STRATEGY.md           │
      │ Claude   │ ◄────────────────► │                                 │
      │ API      │  reasoning engine  │  On user message:               │
      └──────────┘                    │  - Full context + memory search │
                                      │  - Answer anything              │
                                      └─────────────────────────────────┘
```

### Three Trigger Types

| Trigger | Source | What Happens |
|---|---|---|
| **Signal webhook** | Your system POSTs when signal fires | Agent fetches context, reads strategy, decides TAKE/SKIP, logs everything |
| **Self-scheduled callback** | Agent sets its own timer ("check this trade in 30 min") | Agent wakes up, fetches fresh data, evaluates, acts or reschedules |
| **User message** | Owner sends Telegram message | Agent responds with full context — can analyze, explain, take instructions |

### The Learning Loop (This Is The Core Innovation)

```
Signal → Decision → Trade → Outcome → Post-Mortem → Strategy Update
  ↑                                                        │
  └────────────────────────────────────────────────────────┘
```

After every trade closes:
1. **Journal Entry** — structured (entry, exit, PnL, reasoning, context snapshot, lesson learned)
2. **If loss → Mistake Entry** — root cause, rule violated, pattern detection ("this is the 3rd time I...")
3. **Signal Trust Update** — track which signal types + conditions produce winners
4. **Weekly Review** — agent rewrites STRATEGY.md based on accumulated evidence

The agent tracks skipped signals too — "would-have PnL" shows whether the skip was right or wrong.

---

## 5. Memory Architecture (7 Separate Files)

Why 7 files instead of 1 (like SeekerClaw's MEMORY.md):
- Each trigger type needs different context
- Smaller prompts = better reasoning + lower API cost
- Agent can overwrite MARKET_STATE.md without touching STRATEGY.md
- Search can target specific files

| File | Purpose | Update Pattern | Injected When |
|---|---|---|---|
| **IDENTITY.md** | Agent name, role, owner, timezone | Rarely (setup + refinements) | Always |
| **STRATEGY.md** | Trading rules, signal trust weights, risk params, symbol notes | Agent rewrites after learning | Signal decisions, reviews |
| **JOURNAL.md** | Every trade: entry, exit, reasoning, outcome, lesson | Append on open, fill on close | Trade checks, post-mortems |
| **MARKET_STATE.md** | Current market analysis snapshot (overwritten, not appended) | Refreshed on analysis | User questions, signal analysis |
| **MISTAKES.md** | Failure log with root cause + pattern detection | Append after losing trade | Post-mortems, reviews |
| **SIGNAL_TRUST.md** | Tracks which signals the agent took/skipped and outcomes | Append after every decision | Signal decisions |
| **memory/YYYY-MM-DD.md** | Daily observations, decisions, session summaries | Append throughout day | General context |

### System Prompt Assembly (Dynamic)

The system prompt is NOT static. It's assembled per invocation based on what triggered the agent:

| Trigger | Context Injected | Token Budget |
|---|---|---|
| Signal arrives | IDENTITY + STRATEGY + SIGNAL_TRUST + last 3 daily notes + signal payload | ~4,500 |
| Trade check | IDENTITY + STRATEGY (risk section) + trade journal entry + current market | ~3,000 |
| Trade closed | IDENTITY + STRATEGY + last 5 MISTAKES + journal template | ~4,000 |
| User message | IDENTITY + STRATEGY + MARKET_STATE + recent daily notes | ~5,000 |
| Weekly review | IDENTITY + STRATEGY + week's journal + MISTAKES + SIGNAL_TRUST stats | ~6,000 |

---

## 6. Tools (26 Total)

### Data Tools (15) — Read from your analysis API
`get_market_data`, `get_market_structure`, `get_predictions`, `get_prediction_stats`, `get_prediction_history`, `get_clusters`, `get_cluster_zones`, `get_cluster_outcomes`, `get_cluster_stats`, `get_volume_profile`, `get_candles`, `get_active_trades`, `get_trade_history`, `get_trade_stats`, `get_system_status`

### Memory Tools (6) — Read/write/search persistent memory
`memory_read`, `memory_write`, `memory_append`, `memory_search`, `daily_note`, `memory_stats`

### Schedule Tools (3) — Agent controls its own callbacks
`schedule_callback`, `cancel_callback`, `list_callbacks`

### Action Tools (4) — Execute decisions
`execute_trade`, `close_trade`, `modify_trade`, `send_telegram`

Full tool schemas are in `TRADING_AGENT_PLAN.md` (Section 4).

---

## 7. Self-Scheduling System

The agent schedules its own callbacks. This is critical — it's what makes it autonomous rather than purely reactive.

**When a trade opens:**
- Agent auto-schedules `trade_check` every 30 minutes
- Can modify interval ("approaching TP1, check every 15 min")
- All related callbacks auto-cancel when trade closes

**Agent-initiated:**
```javascript
// Agent calls schedule_callback tool:
{
  "time": "in 2h",
  "type": "analysis",
  "reason": "Re-check BTCUSDT — approaching 68k resistance. If rejected, consider short.",
  "context": { "symbol": "BTCUSDT", "key_level": 68000 }
}
```

**Recurring:**
- Daily review at configured time (e.g., 21:00 UTC)
- Weekly review every Sunday

**Persistence:** Callbacks saved to `data/schedule.json` with atomic writes. On restart, past-due callbacks fire immediately (catch-up).

---

## 8. Tech Stack

| Component | Technology | Why |
|---|---|---|
| Runtime | Node.js 22+ (VPS) | Full SQLite support, no mobile constraints |
| AI | Claude API (Anthropic SDK) | Best reasoning for trading decisions |
| Telegram | Grammy | Lightweight, well-maintained |
| Webhook server | Express | Receives signals from your system |
| Database | better-sqlite3 | Native SQLite with FTS5 (fast, no WASM) |
| Dates | dayjs | Timezone-aware, lightweight |
| Config | dotenv | Simple .env loading |
| Process manager | PM2 / systemd | Keeps agent alive on VPS |

---

## 9. Open Questions (Must Answer Before Building)

1. **Trade execution** — Does your system have an API endpoint to open/close trades? Or should the agent call Binance directly?

2. **Webhook push** — Can you add webhook output from your signal engine to POST to the agent's webhook server?

3. **Risk limits** — Maximum position size? Maximum daily loss before agent stops trading?

4. **Multiple positions** — Can the agent hold BTC + ETH + SOL simultaneously, or one at a time?

5. **Agent name** — What do you want to call it?

---

## 10. Implementation Order

1. Project setup — package.json, .env, config.js, directory structure
2. Memory system — memory.js, workspace seeding, SQLite FTS5 indexing
3. Data API client — data-api.js (15 endpoint wrappers)
4. Tool definitions — tools.js (26 tools + dispatch)
5. System prompt builder — context.js (dynamic per-trigger assembly)
6. Claude API integration — brain.js (streaming + tool use loop)
7. Telegram bot — telegram.js (user messages → brain)
8. Webhook server — webhook.js (signals → brain)
9. Scheduler — scheduler.js (callbacks, persistence, timers)
10. Trade monitor — trade-monitor.js (auto-scheduling on trade open/close)
11. Learning loop — learning.js (post-mortem, daily/weekly reviews)
12. Testing — end-to-end with mock signals
13. Deploy — PM2 on VPS

---

## 11. Claude Code Prompt for Engineering Agent

Use this prompt when starting a Claude Code session to build NikitaMWM:

```
You are building NikitaMWM — a self-improving AI trading agent for Binance
Futures (BTCUSDT, ETHUSDT, SOLUSDT). It runs on a VPS (Node.js 22+), receives
signals from an existing analysis system via webhooks, and communicates with the
owner via Telegram.

CRITICAL ARCHITECTURE:
- Agent does NOT generate signals. It receives them from an external system.
- Agent DECIDES whether to take or skip each signal based on its STRATEGY.md.
- Agent MONITORS open trades via self-scheduled callbacks.
- Agent LEARNS from outcomes by writing post-mortems and updating strategy rules.
- Agent has 7 separate memory files (not one blob) — each injected only when relevant.

MEMORY FILES (in workspace/):
- IDENTITY.md — who the agent is, owner info
- STRATEGY.md — trading playbook (AGENT REWRITES THIS as it learns)
- JOURNAL.md — structured trade log (entry, exit, reasoning, outcome, lesson)
- MARKET_STATE.md — current market snapshot (overwritten on each analysis)
- MISTAKES.md — failure log with root cause + pattern detection
- SIGNAL_TRUST.md — tracks signal accuracy from agent's perspective
- memory/*.md — daily observation notes

TOOLS (26 total):
- Data (15): Wrappers for analysis API (market, structure, predictions, clusters, VP, trades)
- Memory (6): read, write, append, search (FTS5), daily_note, stats
- Schedule (3): schedule_callback, cancel_callback, list_callbacks
- Action (4): execute_trade, close_trade, modify_trade, send_telegram

THREE TRIGGER TYPES:
1. Webhook (signal from analysis system) → agent analyzes + decides
2. Self-scheduled callback (agent set its own timer) → agent re-evaluates
3. User message (Telegram) → agent responds with full context

THE LEARNING LOOP:
Signal → Decision → Trade → Outcome → Post-Mortem → Strategy Update → Loop

SYSTEM PROMPT IS DYNAMIC — assembled per trigger type:
- Signal: IDENTITY + STRATEGY + SIGNAL_TRUST + recent daily notes
- Trade check: IDENTITY + STRATEGY (risk only) + trade details
- Trade closed: IDENTITY + STRATEGY + MISTAKES + journal template
- User message: IDENTITY + STRATEGY + MARKET_STATE + recent notes
- Review: IDENTITY + STRATEGY + full journal + MISTAKES + SIGNAL_TRUST

KEY RULES:
1. Memory files are sacred — never delete workspace/ contents
2. STRATEGY.md is the agent's brain — it reads before every decision
3. Every early return in async handlers must clean up state
4. All setTimeout/setInterval must be tracked and clearable
5. Tool results: success = { data } / failure = { error: "message" }
6. Guard persisted JSON defensively (type check + isFinite)
7. Use ?? null for optional fields (not undefined)
8. Webhook auth: verify X-Webhook-Secret header on every request

DATA API:
- Base: http://38.242.154.6:8000
- Auth: X-API-Key header
- Key endpoints: /api/v1/market/{symbol}, /api/v1/predictions/{symbol},
  /api/v1/clusters/{symbol}, /api/v1/volume-profile/{symbol},
  /api/v1/trades/active, /api/v1/trades/stats
- Prediction fields (state, phase, strength) are in Georgian — Claude reads them natively

REFERENCE: See TRADING_AGENT_PLAN.md for full tool schemas, memory file
templates, webhook formats, scheduler design, and database schema.

PROJECT FILES:
src/index.js        — entry point, starts all services
src/brain.js        — Claude API + tool use loop
src/context.js      — dynamic system prompt builder
src/tools.js        — 26 tool definitions + dispatch
src/telegram.js     — Telegram bot (Grammy)
src/webhook.js      — Express server for signal webhooks
src/scheduler.js    — self-scheduling callback system
src/memory.js       — memory file CRUD + SQLite FTS5 indexing
src/data-api.js     — analysis API client (15 endpoints)
src/trade-api.js    — trade execution client
src/trade-monitor.js — monitors open positions, auto-schedules checks
src/learning.js     — post-mortem engine + performance reviews
src/config.js       — .env loading + validation
```

---

## 12. Key Design Decisions (Rationale)

### Why separate memory files, not one big file?
Each trigger needs different context. A signal analysis doesn't need the mistake log. A post-mortem doesn't need market state. Separate files = targeted injection = smarter decisions + lower token cost.

### Why the agent edits its own strategy?
Prediction accuracy changes over time. Market regimes change. The agent learns which signals to trust through experience. The owner can always override via Telegram.

### Why self-scheduling instead of fixed intervals?
A signal at 66,000 might need re-evaluation at 67,000 (30 min later). Open trades need context-aware monitoring, not dumb polling. The agent knows best when to check back.

### Why structured journal, not free-form?
Enables pattern analysis ("show me all R1 LONG trades on BTC"), consistent post-mortems, and aggregated weekly reviews.

### Why track skipped signals?
"Would-have PnL" for skipped signals is critical feedback. If the agent consistently skips profitable signals, its strategy is too conservative. If it skips unprofitable ones, the strategy is working.

### Why dynamic system prompt, not static?
A static prompt wastes tokens on irrelevant context. A signal trigger needs strategy + signal trust data. A trade check needs risk rules + position details. Each invocation gets exactly what it needs.

---

*Full technical plan with tool schemas, memory templates, webhook formats, database schema, and implementation order: see `TRADING_AGENT_PLAN.md`*
