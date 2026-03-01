# Trading Agent — Full Implementation Plan

> **Codename:** TBD (your choice)
> **Runtime:** VPS (Node.js 22+, Linux)
> **Exchange:** Binance Futures
> **AI:** Claude API (Anthropic)
> **Interface:** Telegram Bot
> **Data Source:** Your analysis API (http://38.242.154.6:8000)

---

## 1. Architecture Overview

```
┌─────────────────────────────────────────────────────────────────┐
│                        TRIGGER LAYER                             │
│                                                                  │
│  ┌──────────────┐  ┌───────────────┐  ┌──────────────────────┐  │
│  │ Webhook       │  │ Self-Scheduled │  │ Telegram Messages   │  │
│  │ (your system  │  │ Callbacks      │  │ (user asks anything)│  │
│  │  pushes       │  │ (agent set     │  │                     │  │
│  │  signals)     │  │  its own       │  │                     │  │
│  │               │  │  timers)       │  │                     │  │
│  └──────┬────────┘  └──────┬────────┘  └──────────┬──────────┘  │
│         └──────────────┬───┴──────────────────────┘              │
│                        ▼                                         │
│  ┌─────────────────────────────────────────────────────────────┐ │
│  │                  CONTEXT ASSEMBLER                           │ │
│  │  Builds system prompt dynamically based on trigger type:    │ │
│  │  - Signal → STRATEGY + MARKET_STATE + SIGNAL_TRUST          │ │
│  │  - Trade check → STRATEGY (risk) + trade details            │ │
│  │  - Trade closed → JOURNAL template + MISTAKES + STRATEGY    │ │
│  │  - User message → full context                              │ │
│  │  - Weekly review → JOURNAL + SIGNAL_TRUST + MISTAKES        │ │
│  └──────────────────────┬──────────────────────────────────────┘ │
│                         ▼                                        │
│  ┌─────────────────────────────────────────────────────────────┐ │
│  │                    BRAIN (Claude API)                        │ │
│  │  System Prompt + Tools → Tool Use Loop → Final Response     │ │
│  └──────────────────────┬──────────────────────────────────────┘ │
│                         ▼                                        │
│  ┌─────────────────────────────────────────────────────────────┐ │
│  │                     TOOL LAYER                               │ │
│  │  ┌────────────┐ ┌────────────┐ ┌─────────────┐             │ │
│  │  │ Data Tools │ │Memory Tools│ │ Action Tools│             │ │
│  │  │ (your API) │ │ (read/write│ │ (trade mgmt)│             │ │
│  │  │            │ │  /search)  │ │             │             │ │
│  │  └────────────┘ └────────────┘ └─────────────┘             │ │
│  │  ┌────────────┐ ┌────────────┐                              │ │
│  │  │ Schedule   │ │ Self-Edit  │                              │ │
│  │  │ Tools      │ │ Tools      │                              │ │
│  │  └────────────┘ └────────────┘                              │ │
│  └──────────────────────┬──────────────────────────────────────┘ │
│                         ▼                                        │
│  ┌─────────────────────────────────────────────────────────────┐ │
│  │                   MEMORY LAYER (persistent)                  │ │
│  │  Files: IDENTITY / STRATEGY / JOURNAL / MARKET_STATE /      │ │
│  │         MISTAKES / SIGNAL_TRUST / SCHEDULE                  │ │
│  │  Database: SQLite (indexed search + analytics)              │ │
│  └─────────────────────────────────────────────────────────────┘ │
│                         ▼                                        │
│  ┌─────────────────────────────────────────────────────────────┐ │
│  │                   OUTPUT LAYER                               │ │
│  │  Telegram (user comms) + Your API (trade execution)         │ │
│  └─────────────────────────────────────────────────────────────┘ │
└─────────────────────────────────────────────────────────────────┘
```

---

## 2. Project Structure

```
trading-agent/
├── src/
│   ├── index.js              # Entry point — starts all services
│   ├── brain.js              # Claude API integration + tool use loop
│   ├── context.js            # System prompt builder (per trigger type)
│   ├── tools.js              # Tool definitions + dispatch
│   ├── telegram.js           # Telegram bot (Grammy) — user messages
│   ├── webhook.js            # Express server — receives signals from your system
│   ├── scheduler.js          # Self-scheduling callback system
│   ├── memory.js             # Memory file CRUD + SQLite indexing
│   ├── data-api.js           # Your analysis API client (typed wrappers)
│   ├── trade-api.js          # Binance Futures API client
│   ├── trade-monitor.js      # Watches open positions, auto-schedules checks
│   ├── learning.js           # Post-mortem engine + performance reviews
│   └── config.js             # Environment config (.env loading)
├── workspace/                # Persistent memory (survives restarts)
│   ├── IDENTITY.md
│   ├── STRATEGY.md
│   ├── JOURNAL.md
│   ├── MARKET_STATE.md
│   ├── MISTAKES.md
│   ├── SIGNAL_TRUST.md
│   ├── HEARTBEAT.md
│   └── memory/              # Daily memory files (YYYY-MM-DD.md)
├── data/
│   ├── schedule.json         # Persisted callbacks
│   └── agent.db              # SQLite database
├── package.json
├── .env                      # API keys, tokens (never committed)
├── .env.example
└── README.md
```

---

## 3. Memory Architecture

### 3.1 IDENTITY.md — Who the Agent Is

Created during first-run setup. Agent can refine over time.

```markdown
# Identity

## Name
[Agent name — set during setup or by user]

## Role
Futures trading analyst and executor for Binance USDT-M perpetuals.
Symbols: BTCUSDT, ETHUSDT, SOLUSDT.

## Philosophy
[Evolves over time — agent writes its trading philosophy here]

## Owner
[Your name / handle]

## Timezone
[Your timezone — affects quiet hours, session timing]
```

### 3.2 STRATEGY.md — The Trading Playbook (Agent Edits This)

This is the core brain. The agent reads it before every decision and rewrites it based on what it learns.

```markdown
# Trading Strategy

## Core Rules
1. Never trade against the daily trend unless signal confidence > 80%
2. Require minimum signal_score of 5 for entry
3. Maximum 1 position per symbol at a time
4. Maximum 2 total positions across all symbols

## Signal Trust Weights
### Rule 1 (Absorption — SELL spike + 5m UP + OI rise)
- LONG: Trust. 75% accuracy at 1h, 90.9% at 4h. Average return +0.55% (1h), +1.01% (4h)
- SHORT: Skip. Only 12.5% accuracy.

### Rule 2 (Exhaustion — BUY spike + 5m DOWN)
- LONG: Skip. Low sample, poor accuracy.
- SHORT: Skip. 12.5% accuracy.

### Rule 3 (Volume Activity — 6x+ volume)
- Additional confluence only. Never trade R3 alone.

## Entry Conditions
- Signal from webhook + Rule 1 LONG active
- HTF trend alignment (daily OR 4h must agree with direction)
- Price near support zone (volume profile VA low or HVN bounce)
- No opposing liquidation cascade in progress

## Risk Management
- Stop loss: Based on ATR (value from signal)
- TP1: Signal's tp1_price
- TP2: Signal's tp2_price
- Max risk per trade: 2% of account
- Trailing stop: Activate after TP1 hit

## Position Sizing
- Base: ATR-based from signal
- Reduce 50% if volatility = HIGH
- Reduce 50% if against 4h trend (only with strong daily alignment)

## Symbol-Specific Notes
### BTCUSDT
[Agent fills in observations over time]

### ETHUSDT
[Agent fills in observations over time]

### SOLUSDT
[Agent fills in observations over time]

## Quiet Hours
- No new positions between 00:00-06:00 UTC (low liquidity)
- Monitor existing positions normally during quiet hours

## Last Updated
[Agent updates this timestamp whenever it modifies strategy]
```

### 3.3 JOURNAL.md — Trade Log (Structured, Searchable)

```markdown
# Trade Journal

## Trade #4 — ETHUSDT SHORT — OPEN
- **Entry:** 2004.69 | **SL:** 2032.88 | **TP1:** 1929.99 | **TP2:** 1906.91
- **Time:** 2026-03-01T16:27:24Z
- **Signal:** score 5, deviation S, R:R 3.47
- **HTF Trend:** BEARISH (daily + 4h aligned)
- **Context at Entry:**
  - Market bias: BULLISH (divergent — contrarian entry)
  - OI signal: LONG_CAPITULATION
  - Sentiment: DIVERGENCE_BULLISH
  - CVD 1h: -41,700 (strong selling flow)
  - Funding: 0.004 (elevated, longs paying)
- **Reasoning:** [Agent writes why it took/approved this trade]
- **Outcome:** [Filled on close]
- **Lesson:** [Filled on close]

---
[Previous trades above, newest at top]
```

### 3.4 MARKET_STATE.md — Current Analysis (Refreshed Frequently)

Agent overwrites this during analysis. Not append-only — it's a snapshot.

```markdown
# Market State — Last Updated: 2026-03-01T17:45:00Z

## BTCUSDT — $65,764
- **Daily:** BEARISH (strength 1.0) | **4h:** BEARISH
- **Bias:** BULLISH (divergence from structure)
- **OI Signal:** LONG_CAPITULATION → SHORT_CASCADE
- **Sentiment:** DIVERGENCE_BULLISH
- **Funding:** 0.000018 (near neutral)
- **Key Levels:**
  - POC: 66,200 | VA: 66,000-67,400
  - Nearest support HVN: 66,200 (bounce rate 66%)
  - Daily swing low (unbroken): 59,800
  - 4h resistance: 68,687
- **Volume Profile Character:** Price below POC, in lower VA range
- **Liquidation:** LONG_CASCADE active, short squeeze potential
- **My Read:** [Agent writes its synthesis]

## ETHUSDT — $1,963
[Same format]

## SOLUSDT — $84.02
[Same format]
```

### 3.5 MISTAKES.md — Failure Log (Append-Only)

```markdown
# Mistakes Log

## #1 — 2026-03-XX
- **Trade:** #X SYMBOL DIRECTION
- **What happened:** [Description]
- **Root cause:** [Why it failed]
- **Rule violated:** [Which strategy rule was broken, if any]
- **Pattern:** [Is this a repeat mistake?]
- **Action taken:** [What was updated in STRATEGY.md]
```

### 3.6 SIGNAL_TRUST.md — Learned Signal Performance

```markdown
# Signal Trust Tracker

## Overall Stats (from API)
- R1 (Absorption) LONG: 75% accuracy (1h), 90.9% (4h)
- R1 (Absorption) SHORT: 12.5% accuracy
- R2 (Exhaustion): 12.5% accuracy

## My Decisions vs Outcomes
### Signals Taken
| Date | Symbol | Rule | Dir | Entry | Outcome | PnL% | Notes |
|------|--------|------|-----|-------|---------|------|-------|

### Signals Skipped
| Date | Symbol | Rule | Dir | Price | Would-Have PnL% | Skip Reason |

## Observations
[Agent writes patterns it notices — e.g., "R1 longs work better when funding is negative"]
```

### 3.7 Daily Memory Files (workspace/memory/YYYY-MM-DD.md)

Auto-created. Contains session summaries, observations, notes.

```markdown
# 2026-03-01

## 17:45 — Signal Analysis
Received BTCUSDT R1 LONG signal at 66,759. Skipped: price above POC (66,200),
entering resistance zone. Would-have return: +0.63% in 1h.
Note: maybe I'm too conservative at resistance — log for review.

## 18:30 — Trade Check
ETHUSDT SHORT #4 still open. Entry 2004.69, current 1963.22 (+2.1% unrealized).
Approaching TP1 at 1929.99. Moved SL to breakeven. Next check in 2h.
```

---

## 4. Tool Definitions

### 4.1 Data Tools (Your Analysis API)

```javascript
// Each tool wraps one API endpoint with clear description

{
    name: "get_market_data",
    description: "Get real-time market data for a symbol. Returns: price, CVD (multi-timeframe), bias (BULLISH/BEARISH/NEUTRAL), volatility, OI signal, funding rate, liquidation data, sentiment, market_intent (human-readable analysis), and orderbook imbalance. Use this to understand current market conditions before making decisions.",
    input_schema: {
        type: "object",
        properties: {
            symbol: { type: "string", enum: ["BTCUSDT", "ETHUSDT", "SOLUSDT"] }
        },
        required: ["symbol"]
    }
}

{
    name: "get_market_structure",
    description: "Get market structure analysis: daily and 4h trends, swing highs/lows (with broken status), BOS/CHOCH events, FVG zones, and key weekly S/R zones. Use this to understand the structural context — trend direction, key levels, and whether price is near important zones.",
    input_schema: {
        type: "object",
        properties: {
            symbol: { type: "string", enum: ["BTCUSDT", "ETHUSDT", "SOLUSDT"] }
        },
        required: ["symbol"]
    }
}

{
    name: "get_predictions",
    description: "Get current prediction state: active signals, direction, strength, entry details, signal count by direction, and timeframe balance (buy/sell cluster counts at 5m to 8h). State and phase are in Georgian — read them naturally. When signals[] is populated, there is an active trading signal.",
    input_schema: {
        type: "object",
        properties: {
            symbol: { type: "string", enum: ["BTCUSDT", "ETHUSDT", "SOLUSDT"] }
        },
        required: ["symbol"]
    }
}

{
    name: "get_prediction_stats",
    description: "Get historical prediction accuracy broken down by direction (LONG/SHORT) at 1h and 4h horizons, and by rule type (R1=absorption, R2=exhaustion). Shows accuracy %, average return, sample size. Critical for knowing which signals to trust.",
    input_schema: {
        type: "object",
        properties: {
            symbol: { type: "string", enum: ["BTCUSDT", "ETHUSDT", "SOLUSDT"] }
        },
        required: ["symbol"]
    }
}

{
    name: "get_prediction_history",
    description: "Get history of all prediction signals with their forward returns and outcomes. Each signal includes: direction, active rules, strength, entry price, and measured forward returns at 1h/4h. Use to analyze signal patterns over time.",
    input_schema: {
        type: "object",
        properties: {
            symbol: { type: "string", enum: ["BTCUSDT", "ETHUSDT", "SOLUSDT"] }
        },
        required: ["symbol"]
    }
}

{
    name: "get_clusters",
    description: "Get recent volume clusters (last 24h). Each cluster has: price, type (BUY_VOL/SELL_VOL/DELTA_BUY/DELTA_SELL), buy/sell volumes, delta at multiple timeframes, OI change, funding, liquidation data, and forward returns at 1m/5m/15m/30m/1h. Use to see where large volume events occurred and what happened after.",
    input_schema: {
        type: "object",
        properties: {
            symbol: { type: "string", enum: ["BTCUSDT", "ETHUSDT", "SOLUSDT"] }
        },
        required: ["symbol"]
    }
}

{
    name: "get_cluster_zones",
    description: "Get price zones with aggregated cluster stats. Each zone ($100 bucket) shows: total buy/sell cluster counts, average volume ratio, and forward return stats per direction. Use to identify which price zones have edge.",
    input_schema: {
        type: "object",
        properties: {
            symbol: { type: "string", enum: ["BTCUSDT", "ETHUSDT", "SOLUSDT"] }
        },
        required: ["symbol"]
    }
}

{
    name: "get_cluster_outcomes",
    description: "Get aggregate forward return statistics for BUY vs SELL clusters at all timeframes (1m to 1h). Shows mean return, std dev, directional hit rate, and max up/down means. Use to evaluate if cluster types have predictive value.",
    input_schema: {
        type: "object",
        properties: {
            symbol: { type: "string", enum: ["BTCUSDT", "ETHUSDT", "SOLUSDT"] }
        },
        required: ["symbol"]
    }
}

{
    name: "get_cluster_stats",
    description: "Get summary cluster stats: total/buy/sell counts, average volume ratio over last 24h.",
    input_schema: {
        type: "object",
        properties: {
            symbol: { type: "string", enum: ["BTCUSDT", "ETHUSDT", "SOLUSDT"] }
        },
        required: ["symbol"]
    }
}

{
    name: "get_volume_profile",
    description: "Get volume profile analysis: POC (point of control), value area (high/low with %), and per-zone details including volume, node type (HVN/LVN), character (breakout/absorption/mixed), S/R quality, bias, bounce/break rates. Use to identify support/resistance zones and where price has the most/least traded volume.",
    input_schema: {
        type: "object",
        properties: {
            symbol: { type: "string", enum: ["BTCUSDT", "ETHUSDT", "SOLUSDT"] }
        },
        required: ["symbol"]
    }
}

{
    name: "get_candles",
    description: "Get 100 most recent 4h OHLCV candles. Use for price action analysis and trend confirmation.",
    input_schema: {
        type: "object",
        properties: {
            symbol: { type: "string", enum: ["BTCUSDT", "ETHUSDT", "SOLUSDT"] }
        },
        required: ["symbol"]
    }
}

{
    name: "get_active_trades",
    description: "Get all currently open trades. Each trade has: symbol, direction, entry/exit prices, SL, TP1, TP2, signal_score, deviation_type, htf_trend, ATR, risk_reward, hold_seconds, quantity, status, trailing_sl. Returns {active: bool, trade: object} or {active: false} if no open trades.",
    input_schema: {
        type: "object",
        properties: {},
        required: []
    }
}

{
    name: "get_trade_history",
    description: "Get all closed trades with full details including PnL, exit reason, hold time.",
    input_schema: {
        type: "object",
        properties: {},
        required: []
    }
}

{
    name: "get_trade_stats",
    description: "Get aggregate trade statistics: total trades, win rate, avg win/loss %, total PnL, average hold time, average R:R.",
    input_schema: {
        type: "object",
        properties: {},
        required: []
    }
}

{
    name: "get_system_status",
    description: "Get system status: bot version, enabled features (deviation/sweep), tracked symbols, data source status, cluster collection stats (totals, fill rates, per-symbol counts).",
    input_schema: {
        type: "object",
        properties: {},
        required: []
    }
}
```

### 4.2 Memory Tools

```javascript
{
    name: "memory_read",
    description: "Read a memory file. Available files: IDENTITY.md, STRATEGY.md, JOURNAL.md, MARKET_STATE.md, MISTAKES.md, SIGNAL_TRUST.md, HEARTBEAT.md, or any daily file (memory/YYYY-MM-DD.md). Returns full content or a line range.",
    input_schema: {
        type: "object",
        properties: {
            file: { type: "string", description: "Filename (e.g., 'STRATEGY.md' or 'memory/2026-03-01.md')" },
            start_line: { type: "integer", description: "Optional start line" },
            end_line: { type: "integer", description: "Optional end line" }
        },
        required: ["file"]
    }
}

{
    name: "memory_write",
    description: "Write/overwrite a memory file completely. Use for files that represent current state (MARKET_STATE.md, STRATEGY.md). For append-only files (JOURNAL, MISTAKES), prefer memory_append.",
    input_schema: {
        type: "object",
        properties: {
            file: { type: "string" },
            content: { type: "string" }
        },
        required: ["file", "content"]
    }
}

{
    name: "memory_append",
    description: "Append content to a memory file. Use for JOURNAL.md, MISTAKES.md, SIGNAL_TRUST.md tables. Adds content at the top (after header) for journal entries, or at the bottom for other files.",
    input_schema: {
        type: "object",
        properties: {
            file: { type: "string" },
            content: { type: "string" },
            position: { type: "string", enum: ["top", "bottom"], default: "bottom" }
        },
        required: ["file", "content"]
    }
}

{
    name: "memory_search",
    description: "Search across all memory files using keywords. Returns ranked results with file path, line numbers, matched text, and relevance score. Uses SQLite FTS5 for fast full-text search with recency weighting.",
    input_schema: {
        type: "object",
        properties: {
            query: { type: "string", description: "Search keywords" },
            max_results: { type: "integer", default: 10 }
        },
        required: ["query"]
    }
}

{
    name: "daily_note",
    description: "Append a timestamped note to today's daily memory file (memory/YYYY-MM-DD.md). Use for logging observations, analysis results, decisions, and session events.",
    input_schema: {
        type: "object",
        properties: {
            note: { type: "string" }
        },
        required: ["note"]
    }
}

{
    name: "memory_stats",
    description: "Get stats about memory system: file sizes, daily file count, database index status, total memory size.",
    input_schema: {
        type: "object",
        properties: {},
        required: []
    }
}
```

### 4.3 Schedule Tools

```javascript
{
    name: "schedule_callback",
    description: "Schedule a future callback. The agent will be invoked at the specified time with the given context. Use for: trade monitoring checks, re-analysis after X time, periodic reviews. Types: 'trade_check' (monitor position), 'analysis' (re-analyze a setup), 'review' (performance review), 'custom'.",
    input_schema: {
        type: "object",
        properties: {
            time: { type: "string", description: "ISO 8601 time OR relative ('in 30m', 'in 2h', 'tomorrow 09:00')" },
            type: { type: "string", enum: ["trade_check", "analysis", "review", "custom"] },
            reason: { type: "string", description: "Why this callback exists — this becomes the prompt context when it fires" },
            context: { type: "object", description: "Additional context (trade_id, symbol, etc.)" },
            recurring: { type: "string", description: "Optional: 'every 30m', 'every 4h', 'daily 09:00'" }
        },
        required: ["time", "type", "reason"]
    }
}

{
    name: "cancel_callback",
    description: "Cancel a scheduled callback by ID.",
    input_schema: {
        type: "object",
        properties: {
            id: { type: "string" }
        },
        required: ["id"]
    }
}

{
    name: "list_callbacks",
    description: "List all pending scheduled callbacks with their IDs, times, types, and reasons.",
    input_schema: {
        type: "object",
        properties: {},
        required: []
    }
}
```

### 4.4 Action Tools

```javascript
{
    name: "execute_trade",
    description: "Send a trade execution command to the trading system. This will open a position on Binance Futures via your existing bot. The agent decides; the system executes.",
    input_schema: {
        type: "object",
        properties: {
            symbol: { type: "string", enum: ["BTCUSDT", "ETHUSDT", "SOLUSDT"] },
            direction: { type: "string", enum: ["LONG", "SHORT"] },
            reason: { type: "string", description: "Why this trade is being taken — logged to journal" },
            signal_data: { type: "object", description: "Original signal data for record-keeping" }
        },
        required: ["symbol", "direction", "reason"]
    }
}

{
    name: "close_trade",
    description: "Close an active trade position.",
    input_schema: {
        type: "object",
        properties: {
            trade_id: { type: "integer" },
            reason: { type: "string", description: "Why closing — logged to journal" }
        },
        required: ["trade_id", "reason"]
    }
}

{
    name: "modify_trade",
    description: "Modify stop loss or take profit on an active trade.",
    input_schema: {
        type: "object",
        properties: {
            trade_id: { type: "integer" },
            new_sl: { type: "number", description: "New stop loss price" },
            new_tp1: { type: "number", description: "New TP1 price" },
            new_tp2: { type: "number", description: "New TP2 price" },
            reason: { type: "string" }
        },
        required: ["trade_id", "reason"]
    }
}

{
    name: "send_telegram",
    description: "Send a message to the owner via Telegram. Use for alerts, trade notifications, and proactive updates.",
    input_schema: {
        type: "object",
        properties: {
            message: { type: "string" },
            parse_mode: { type: "string", enum: ["Markdown", "HTML"], default: "Markdown" }
        },
        required: ["message"]
    }
}
```

---

## 5. System Prompt Architecture

The system prompt is NOT static. It's assembled dynamically per invocation based on what triggered the agent.

### 5.1 Base Prompt (Always Included)

```
You are {agent_name}, a professional futures trading agent operating on Binance USDT-M perpetuals.
You trade {symbols}. You receive signals from an analysis system and make informed trading decisions.

You are NOT a chatbot. You are a trader with memory, strategy, and the ability to learn from outcomes.
Your owner is {owner_name} ({timezone}).

## Your Capabilities
- Analyze real-time market data, structure, clusters, volume profiles, and predictions
- Make trade decisions (open, close, modify, skip) with documented reasoning
- Monitor open positions and adjust based on changing conditions
- Schedule your own callbacks for future analysis or trade checks
- Learn from outcomes by updating your strategy and tracking mistakes
- Search your memory for past decisions, patterns, and observations

## Decision Framework
Before any trade decision:
1. Read STRATEGY.md for current rules
2. Fetch relevant market data (structure, predictions, clusters, volume profile)
3. Check SIGNAL_TRUST.md for rule accuracy
4. Search memory for similar past situations
5. Make decision with explicit reasoning
6. Log everything

## Memory Protocol
- Before answering about past trades/decisions: use memory_search FIRST
- After every trade decision (open or skip): log to daily_note
- After trade close: write post-mortem to JOURNAL.md and MISTAKES.md (if loss)
- Weekly: review and update STRATEGY.md based on outcomes

## SILENT_REPLY
If no response is needed (e.g., heartbeat with nothing to report), return exactly: SILENT_REPLY
```

### 5.2 Context Injection (Dynamic Per Trigger)

| Trigger | Injected Files | Additional Context |
|---------|---------------|-------------------|
| **Signal webhook** | IDENTITY + STRATEGY + SIGNAL_TRUST + last 3 daily notes | Signal payload + "Analyze this signal and decide: TAKE or SKIP" |
| **Trade check callback** | IDENTITY + STRATEGY (risk section) + JOURNAL (current trade entry) | Trade details + current market data + "Check this position" |
| **Trade closed event** | IDENTITY + STRATEGY + MISTAKES (last 5) + JOURNAL template | Closed trade details + "Write post-mortem" |
| **User message** | IDENTITY + STRATEGY + MARKET_STATE + recent daily notes | Full context for conversation |
| **Daily review** | IDENTITY + STRATEGY + today's JOURNAL entries + SIGNAL_TRUST | "Review today's trading activity" |
| **Weekly review** | IDENTITY + STRATEGY + week's JOURNAL + MISTAKES + SIGNAL_TRUST stats | "Full week performance review. Update STRATEGY.md." |
| **Heartbeat** | IDENTITY + HEARTBEAT.md | "Check heartbeat tasks. Reply SILENT_REPLY if nothing to report." |

### 5.3 Token Budget

| Section | Max Tokens | Notes |
|---------|-----------|-------|
| Base prompt | ~800 | Always included |
| IDENTITY.md | ~200 | Small file |
| STRATEGY.md | ~1500 | Agent's full playbook |
| MARKET_STATE.md | ~1000 | Current snapshot |
| SIGNAL_TRUST.md | ~500 | Truncated if large |
| JOURNAL.md (recent) | ~1000 | Last 5 trades only |
| MISTAKES.md (recent) | ~500 | Last 5 mistakes |
| Daily notes (today) | ~500 | Truncated |
| Signal payload | ~300 | Webhook data |
| **Total max** | **~6300** | Well within limits |

---

## 6. Webhook System

### 6.1 Express Server (webhook.js)

Receives signals from your trading system. Your system needs to POST to this endpoint when a signal fires.

```
POST /webhook/signal
{
    "type": "signal",
    "symbol": "BTCUSDT",
    "direction": "LONG",
    "rule": 1,
    "signal_score": 7,
    "entry_price": 66285.7,
    "sl_price": 65800.0,
    "tp1_price": 67200.0,
    "tp2_price": 67800.0,
    "risk_reward": 2.85,
    "deviation_type": "S",
    "htf_trend": "BEARISH",
    "strength": "საშუალო",
    "phase_detail": "აბსორბცია — SELL spike + 5წთ UP + OI↑ (77% accuracy)",
    "timestamp": "2026-03-01T17:30:00Z"
}

POST /webhook/trade-opened
{
    "type": "trade_opened",
    "trade_id": 5,
    "symbol": "BTCUSDT",
    "direction": "LONG",
    "entry_price": 66285.7,
    "sl_price": 65800.0,
    "tp1_price": 67200.0,
    "tp2_price": 67800.0,
    "timestamp": "2026-03-01T17:30:15Z"
}

POST /webhook/trade-closed
{
    "type": "trade_closed",
    "trade_id": 5,
    "symbol": "BTCUSDT",
    "direction": "LONG",
    "entry_price": 66285.7,
    "exit_price": 67100.0,
    "pnl_pct": 1.23,
    "pnl_usd": 45.60,
    "exit_reason": "TP1",
    "hold_seconds": 14400,
    "timestamp": "2026-03-01T21:30:15Z"
}
```

### 6.2 Webhook → Brain Flow

```
webhook received
    → validate payload + auth token
    → determine trigger type (signal / trade_opened / trade_closed)
    → context.js assembles system prompt for that trigger type
    → brain.js calls Claude API with tools
    → agent analyzes, uses tools, makes decision
    → action tools execute (or not)
    → daily_note logged
    → if trade opened: trade-monitor starts watching
    → if trade closed: post-mortem runs
```

---

## 7. Scheduler System (scheduler.js)

### 7.1 How It Works

```javascript
// Persisted in data/schedule.json
{
    "callbacks": [
        {
            "id": "cb_1709312400_abc",
            "fire_at": "2026-03-01T20:00:00Z",
            "type": "trade_check",
            "reason": "Check ETHUSDT SHORT #4 — approaching TP1 zone at 1929.99",
            "context": { "trade_id": 4, "symbol": "ETHUSDT" },
            "recurring": null,
            "created_at": "2026-03-01T18:00:00Z"
        },
        {
            "id": "cb_recurring_daily_review",
            "fire_at": "2026-03-02T21:00:00Z",
            "type": "review",
            "reason": "Daily performance review. Check all trades, signals taken/skipped, update STRATEGY if needed.",
            "context": {},
            "recurring": "daily 21:00",
            "created_at": "2026-03-01T12:00:00Z"
        }
    ]
}
```

### 7.2 On Startup

1. Load `schedule.json`
2. For each callback:
   - If `fire_at` is in the past: fire immediately (catch up)
   - If `fire_at` is in the future: set timer
3. When timer fires:
   - Build context for trigger type
   - Call brain with callback's `reason` as the prompt
   - If recurring: calculate next `fire_at` and reschedule
   - Save updated `schedule.json`

### 7.3 Trade Monitor Integration

When a trade opens:
- Auto-schedule `trade_check` every 30 minutes
- Agent can modify the interval ("check every 15m, it's near TP1")
- When trade closes, all related callbacks auto-cancel

---

## 8. Learning Loop (learning.js)

### 8.1 Post-Mortem (Auto on Trade Close)

When `/webhook/trade-closed` fires:

1. **Fetch full context:**
   - Read JOURNAL.md entry for this trade (agent's reasoning at entry)
   - Fetch prediction_stats (current accuracy)
   - Fetch the signal that triggered this trade (from prediction history)

2. **Call Claude with post-mortem prompt:**
   ```
   Trade #{id} has closed. Analyze the outcome:
   - Entry reasoning: {from journal}
   - Outcome: {pnl_pct}%, {exit_reason}, held {hold_seconds}s
   - Was the strategy followed?
   - What would you do differently?

   Update:
   1. JOURNAL.md — fill in Outcome and Lesson
   2. SIGNAL_TRUST.md — update the signal tracking table
   3. If loss: MISTAKES.md — add entry with root cause
   4. If pattern found: STRATEGY.md — refine rules
   ```

3. **Agent uses tools to update all relevant memory files**

### 8.2 Daily Review (Scheduled, Recurring)

Every day at a configured time (e.g., 21:00 UTC):

```
Perform daily review:
1. How many signals received today? How many taken vs skipped?
2. Open trades: status update
3. Closed trades: were post-mortems thorough?
4. Any repeated mistakes?
5. Write summary to daily_note
```

### 8.3 Weekly Review (Scheduled, Recurring)

Every Sunday:

```
Perform weekly review:
1. Total trades: W/L, win rate, total PnL
2. Best and worst trade — why?
3. Signal performance: which rules/directions were profitable?
4. Compare SIGNAL_TRUST.md against actual prediction_stats
5. Any strategy rules to add, remove, or modify?
6. Update STRATEGY.md with any changes (with changelog note)
7. Write comprehensive summary to daily_note
```

---

## 9. Telegram Integration (telegram.js)

### 9.1 Message Types

| User Says | Agent Does |
|-----------|-----------|
| "How's my ETH trade?" | Fetches active_trades + market_data, reads JOURNAL entry, gives analysis |
| "Analyze BTC" | Fetches all BTC data (market, structure, clusters, VP, predictions), writes MARKET_STATE, gives synthesis |
| "Why did you skip the last signal?" | Searches memory for skip decision, explains reasoning |
| "What's your win rate?" | Calls get_trade_stats, supplements with JOURNAL data |
| "Show me your strategy" | Reads STRATEGY.md, presents key rules |
| "Don't trade SOL during Asian session" | Updates STRATEGY.md with new rule |
| "What mistakes have you made?" | Reads MISTAKES.md, summarizes patterns |
| "Set a reminder to check BTC in 2 hours" | Uses schedule_callback tool |
| "Do a full review" | Triggers weekly review process |
| Any other message | Full context, agent responds naturally |

### 9.2 Proactive Messages

The agent sends messages to Telegram when:
- Signal received → "Signal: BTCUSDT R1 LONG at 66,285. Analyzing..."
- Trade decision → "TAKING trade: BTCUSDT LONG. Reason: ..." or "SKIPPING: ..."
- Trade opened confirmation → "Position opened: ..."
- Trade check alert → "ETHUSDT SHORT: approaching TP1. Moving SL to breakeven."
- Trade closed → "ETHUSDT SHORT closed at TP1: +3.7%. Post-mortem logged."
- Daily/weekly review → Summary message

---

## 10. Configuration (.env)

```bash
# Claude API
ANTHROPIC_API_KEY=sk-ant-api03-...
CLAUDE_MODEL=claude-sonnet-4-6

# Telegram
TELEGRAM_BOT_TOKEN=123456789:ABCdefGHI...
TELEGRAM_OWNER_ID=987654321

# Your Analysis API
DATA_API_URL=http://38.242.154.6:8000
DATA_API_KEY=anBd-7HlVRT7YVuIMER8-zPb9pgZkyOJ-aKHLaXqLwA

# Webhook Server (receives signals from your system)
WEBHOOK_PORT=3000
WEBHOOK_SECRET=your-webhook-auth-token

# Agent Settings
AGENT_NAME=TradingAgent
OWNER_NAME=YourName
OWNER_TIMEZONE=Asia/Tbilisi
HEARTBEAT_INTERVAL_MINUTES=30
TRADE_CHECK_INTERVAL_MINUTES=30

# Workspace
WORKSPACE_DIR=./workspace
DATA_DIR=./data
```

---

## 11. Startup Sequence (index.js)

```
1. Load .env configuration
2. Initialize SQLite database (data/agent.db)
3. Seed workspace files if first run:
   - IDENTITY.md (template)
   - STRATEGY.md (initial rules from prediction stats)
   - JOURNAL.md (empty)
   - MARKET_STATE.md (empty)
   - MISTAKES.md (empty)
   - SIGNAL_TRUST.md (initial from API stats)
   - HEARTBEAT.md (default checks)
4. Index memory files into SQLite (FTS5)
5. Load scheduled callbacks from schedule.json, set timers
6. Start Telegram bot (long polling)
7. Start webhook Express server (port 3000)
8. Start heartbeat interval (every 30 min)
9. Check for active trades → start trade monitor if any
10. Log: "Agent online. Listening for signals and messages."
```

---

## 12. Database Schema (agent.db — SQLite)

```sql
-- Memory indexing (FTS5 for fast search)
CREATE VIRTUAL TABLE IF NOT EXISTS memory_fts USING fts5(
    file, text, content='memory_chunks'
);

CREATE TABLE IF NOT EXISTS memory_chunks (
    id INTEGER PRIMARY KEY,
    file TEXT NOT NULL,
    start_line INTEGER,
    end_line INTEGER,
    text TEXT NOT NULL,
    hash TEXT,
    updated_at TEXT DEFAULT CURRENT_TIMESTAMP
);

-- Trade decision log (every signal → decision)
CREATE TABLE IF NOT EXISTS decisions (
    id INTEGER PRIMARY KEY,
    timestamp TEXT NOT NULL,
    symbol TEXT NOT NULL,
    signal_type TEXT,         -- 'R1', 'R2', 'R3'
    direction TEXT,           -- 'LONG', 'SHORT'
    decision TEXT NOT NULL,   -- 'TAKE', 'SKIP'
    reason TEXT,
    signal_score INTEGER,
    entry_price REAL,
    outcome_pnl REAL,         -- filled on trade close
    outcome_reason TEXT,       -- filled on trade close
    would_have_pnl REAL       -- for SKIP decisions, track what would have happened
);

-- API call log (cost tracking)
CREATE TABLE IF NOT EXISTS api_calls (
    id INTEGER PRIMARY KEY,
    timestamp TEXT NOT NULL,
    trigger_type TEXT,        -- 'signal', 'trade_check', 'user_message', 'review', 'heartbeat'
    model TEXT,
    input_tokens INTEGER,
    output_tokens INTEGER,
    cost_usd REAL,
    tool_calls INTEGER
);

-- Signal performance tracking
CREATE TABLE IF NOT EXISTS signal_outcomes (
    id INTEGER PRIMARY KEY,
    timestamp TEXT NOT NULL,
    symbol TEXT NOT NULL,
    rule INTEGER,
    direction TEXT,
    entry_price REAL,
    fwd_return_1h REAL,
    fwd_return_4h REAL,
    taken INTEGER DEFAULT 0,  -- did agent take this?
    trade_pnl REAL            -- if taken, actual trade PnL
);
```

---

## 13. Key Design Decisions

### Why Separate Memory Files (Not One Big File)
- Each trigger type needs different context
- Smaller, targeted prompts = better decisions + lower cost
- Agent can overwrite MARKET_STATE.md without touching STRATEGY.md
- Search can target specific files

### Why the Agent Edits Its Own Strategy
- Prediction accuracy changes over time (R1 is 75% now, might shift)
- Market regimes change (what works in trending doesn't work in ranging)
- The agent learns which signals to trust through experience
- Human can always override via Telegram ("add this rule: ...")

### Why Self-Scheduling
- A signal at 66,000 might need re-evaluation at 67,000 (30 min later)
- Open trades need periodic monitoring (not constant polling)
- The agent knows best when to check back — it has the context
- Reviews should happen on schedule without human reminder

### Why Structured Journal (Not Free-Form)
- Enables SQL queries later ("show me all R1 LONG trades on BTC")
- Agent can search its own history for patterns
- Post-mortems are consistent and comparable
- Weekly reviews can aggregate structured data

### Why Track Skipped Signals
- "Would-have PnL" for skipped signals is critical feedback
- If agent consistently skips profitable signals, strategy needs updating
- If agent consistently skips unprofitable ones, strategy is working

---

## 14. Implementation Order

1. **Project setup** — package.json, .env, config.js, directory structure
2. **Memory system** — memory.js, workspace seeding, SQLite indexing
3. **Data API client** — data-api.js (all 15 endpoint wrappers)
4. **Tool definitions** — tools.js (all tools defined + dispatch)
5. **System prompt builder** — context.js (per-trigger assembly)
6. **Claude API integration** — brain.js (API call + tool use loop)
7. **Telegram bot** — telegram.js (user messages → brain)
8. **Webhook server** — webhook.js (signals → brain)
9. **Scheduler** — scheduler.js (callbacks, persistence, timers)
10. **Trade monitor** — trade-monitor.js (auto-scheduling on trade open/close)
11. **Learning loop** — learning.js (post-mortem, daily/weekly reviews)
12. **Testing** — end-to-end with mock signals
13. **Deploy** — PM2 on VPS, systemd service

---

## 15. Dependencies

```json
{
    "dependencies": {
        "@anthropic-ai/sdk": "latest",
        "grammy": "latest",
        "express": "latest",
        "better-sqlite3": "latest",
        "dotenv": "latest",
        "dayjs": "latest"
    }
}
```

Minimal. No bloat. Each dependency has a clear purpose:
- `@anthropic-ai/sdk` — Claude API
- `grammy` — Telegram bot
- `express` — Webhook receiver
- `better-sqlite3` — Native SQLite (not WASM — we're on a VPS)
- `dotenv` — Environment config
- `dayjs` — Date/time handling (timezone-aware)

---

## 16. Open Questions for You

1. **Trade execution:** Does your system have an API endpoint to open/close trades? Or should the agent call Binance directly?
2. **Webhook from your system:** Can you add webhook push from your signal engine? What format works best?
3. **Agent name:** What do you want to call it?
4. **Risk limits:** Maximum position size? Maximum daily loss before stopping?
5. **Multiple positions:** Can the agent hold BTC + ETH + SOL simultaneously, or one at a time?
