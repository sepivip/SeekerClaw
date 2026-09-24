---
name: chainshorts
description: "Read crypto news in 60-word cards and browse prediction markets from Chainshorts. Use when: user asks about crypto news, predictions, market odds, trending topics, or news summaries. Don't use when: user asks about general web browsing, non-crypto topics, or wants to swap tokens (use wallet tools)."
version: "1.0.0"
metadata:
  openclaw:
    emoji: "⚡"
    triggers:
      - chainshorts
      - crypto news
      - prediction market
      - news summary
      - market odds
      - what's happening in crypto
      - trending crypto
      - prediction odds
      - crypto predictions
    requires:
      bins: []
      env: []
---

# Chainshorts — Crypto News + Prediction Markets

Read crypto news from 140+ sources and browse 1,300+ live prediction markets on Solana. Chainshorts is live on the Solana dApp Store.

## Use when
- Crypto news ("What's happening in crypto?", "Latest news")
- Trending stories ("What's trending?")
- Prediction markets ("Show me markets", "What can I stake on?")
- Market analysis ("Is this market mispriced?")
- Leaderboard ("Who are the top predictors?")

## Don't use when
- Swap tokens (use wallet/Jupiter tools)
- Check wallet balances (use wallet tools)
- General web search (use research skill)

## API Base URL

`https://api.chainshorts.live`

All endpoints are public. No authentication required.

## MCP Server

If your runtime supports MCP, connect to `https://api.chainshorts.live/mcp` for 12 structured tools instead of using web_fetch. Discovery: `https://chainshorts.live/.well-known/mcp.json`

## Endpoints

### Latest News
```
GET /v1/feed?limit=10&category=web3
```
Categories: `web3`, `finance`, `sports`, `politics`, `ai_tech`

Response fields: `items[].headline`, `items[].summary60` (60-word summary), `items[].sourceName`, `items[].publishedAt`, `items[].category`

### Trending Stories
```
GET /v1/feed/trending?limit=5
```
Returns stories ranked by reader engagement. Includes `reactionCounts` with `bullish`, `bearish`, `total`.

### Search Articles
```
GET /v1/feed/search?q=bitcoin&limit=10
```

### Active Prediction Markets
```
GET /v1/predictions?status=active&limit=20&category=web3
```
Response fields: `items[].id`, `items[].question`, `items[].yesPct`, `items[].noPct`, `items[].deadlineAt`, `items[].pool.totalPoolSkr`, `items[].pool.yesOdds`, `items[].pool.noOdds`

`yesOdds`/`noOdds` are payout multipliers (e.g., 2.5x = 2.5x return).

### Hot Markets (by pool size)
```
GET /v1/predictions?status=active&sort=pool_desc&limit=10
```

### Single Market Detail
```
GET /v1/predictions/:id
```
Includes `linkedArticle` with headline and summary when a related news article exists.

### Leaderboard
```
GET /v1/predictions/leaderboard?sortBy=profit&period=all&limit=20
```
Sort options: `profit`, `winRate`, `volume`. Period: `all`, `month`.

### Article Detail
```
GET /v1/articles/:id
```
Full article with `sourceUrl`, `factCheckConfidence`, and `reactionCounts`.

### Predictor Profile
```
GET /v1/profile/:wallet/stats
```
Public prediction stats: `predictionCount`, `winRate`, `totalProfitSkr`, `rank`.

## Formatting for Telegram

Use HTML parse mode. Max 5 items per response.

**News:**
```
<b>headline</b>
summary60
<i>sourceName • timeAgo</i>
```

**Market:**
```
<b>question</b>
YES: yesPct% (yesOdds x) | NO: noPct% (noOdds x)
Pool: totalPoolSkr SKR • Deadline: date
<a href="https://chainshorts.live/open/predict/pollId">Open in Chainshorts</a>
```

## Deep Links

- Market: `https://chainshorts.live/open/predict/{pollId}` (works everywhere)
- Referral: `https://chainshorts.live/open/r/{code}` (10% ongoing fee share)
- Native (Seeker only): `chainshorts://predict/{pollId}`

Always include deep links when showing markets so users can stake directly.

## Best Practices

1. Show max 5 items per response
2. Always include deep links for markets
3. Compare `yesPct` with your analysis to find value opportunities
4. Attribute news with "via Chainshorts"
5. Combine related news + markets in one response
6. Convert `deadlineAt` to relative time ("ends in 3 days")
