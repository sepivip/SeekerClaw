# Node.js Agent — Architecture Guide

## Module Overview

Core CommonJS modules in `nodejs-project/`:

| Module | Role |
|--------|------|
| `main.js` | Entry point, orchestrator, dependency wiring |
| `tools.js` | Tool definitions (`TOOLS` array) and `executeTool()` dispatch |
| `claude.js` | Claude API (chat, conversations, sessions, health) |
| `solana.js` | Solana RPC, Jupiter DEX, wallet management |
| `mcp-client.js` | MCP Streamable HTTP client (standalone) |
| `cron.js` | Cron scheduling, job persistence, time parsing |
| `telegram.js` | Telegram Bot API, formatting, file handling |
| `database.js` | SQL.js init, persistence, memory indexing, stats |
| `skills.js` | Skill file loading, matching, prompt building |
| `web.js` | HTTP helpers, search providers, web fetch |
| `config.js` | Config loading, constants, logging (root module) |
| `memory.js` | Soul, memory, heartbeat management |
| `security.js` | Secret redaction, prompt injection defense |
| `bridge.js` | Android bridge HTTP client |

Also present: `sql-wasm.js` (third-party SQL.js WASM bundle, not a SeekerClaw module).

## Dependency Graph

```
main.js (orchestrator)
├── tools.js ← config, security, bridge, memory, cron, database, solana, web, telegram, claude, skills
├── claude.js ← config, telegram, web, bridge, memory, skills, database
├── mcp-client.js (standalone)
├── solana.js ← config, web, bridge
├── telegram.js ← config, web
├── database.js ← config, memory
├── cron.js ← config
├── skills.js ← config
├── web.js ← config
├── memory.js ← config
├── security.js ← config
├── bridge.js ← config
└── config.js (root, no deps)
```

## Dependency Injection

Six injection points break circular dependencies:

| Setter | Target | Wired in | Injects |
|--------|--------|----------|---------|
| `setSendMessage(fn)` | cron.js | main.js | `sendMessage` from telegram.js |
| `setShutdownDeps(obj)` | database.js | main.js | `{conversations, saveSessionSummary, MIN_MESSAGES_FOR_SUMMARY}` |
| `setChatDeps(obj)` | claude.js | main.js | `{executeTool, getTools, getMcpStatus, requestConfirmation, lastToolUseTime, lastIncomingMessages}` |
| `setMcpExecuteTool(fn)` | tools.js | main.js | MCP tool executor from MCPManager |
| `setRedactFn(fn)` | config.js | main.js | `redactSecrets` from security.js |
| `setDb(fn)` | memory.js | database.js | DB getter (`() => db`) at module load time |

## Error Signaling Convention

### Tool results (tools.js → claude.js → Claude API)

Tools return **plain objects** with an `error` key on failure:

```js
// Success
return { balance: "1.5 SOL", address: "..." };

// Failure
return { error: "Wallet not connected" };
```

This is the **only** pattern for tool results. Claude sees the error text as the tool
response and can retry or inform the user. Tool handlers may throw internally, but
`executeTool()` must always catch and convert failures to `{ error }` (no exceptions escape).

### Internal module functions

Internal functions (not tool handlers) **throw** on unrecoverable errors:

```js
// solana.js
async function solanaRpc(method, params) {
    const res = await httpRequest(url, opts);
    if (res.status !== 200) throw new Error(`RPC failed: ${res.status}`);
    return res.data.result;
}
```

Callers in tools.js catch these and convert to `{ error }`:

```js
case 'solana_balance': {
    try {
        const result = await solanaRpc('getBalance', [address]);
        return { balance: result.value / 1e9 };
    } catch (e) {
        return { error: e.message };
    }
}
```

### Silent catches

Silent catches (`catch (_) {}`) are **only** permitted for:
- Best-effort cleanup (file rename/backup before the real write)
- Non-fatal side effects (debug logging, stats updates)

All silent catches **must** have a comment or use `log()`:

```js
// OK — annotated
try { fs.copyFileSync(src, bak); } catch (e) { log(`[Mod] Backup failed: ${e.message}`); }

// OK — harmless cleanup with comment
try { fs.renameSync(old, bak); } catch (_) { /* best-effort backup */ }

// NOT OK — unexplained
try { doSomething(); } catch (_) {}
```

## Module Export Policy

Export only symbols that other modules actually import. Internal helpers, constants,
and state objects stay private. Re-evaluate on each extraction or refactor.

Current public API surface: **134 exports** across 13 modules (main.js exports nothing).
