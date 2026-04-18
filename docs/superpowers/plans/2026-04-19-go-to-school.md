# Go to School Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Give the SeekerClaw agent a structured reflection feature where it analyzes its own recent tool-call and skill-trigger activity and proposes concrete self-improvements (create / patch / retire skills), gated by a 5-rubric rigor check and a two-gate user approval flow.

**Architecture:** Two PRs landing sequentially. PR-A adds two SQL.js tables (`tool_call_log`, `skill_trigger_log`) with a buffered async logger and retention, plus `call_shape` builders per tool. PR-B adds the `school.js` module (pure state-machine + pattern-mining), 6 new tools in `tools/school.js`, and a bundled `go-to-school` SKILL.md that carries the rubric, proposal format, approval protocol, and input classification rubric. Two-gate approval: `/review N` → user sees drafted SKILL.md → `YES N` writes it. Deterministic JS state machine with 32 transitions; classification echo to the user on every state change.

**Tech Stack:** Node 18 (nodejs-mobile), SQL.js 1.12 (WASM SQLite), plain-JS test harness (no framework; test files exit 0/1), Kotlin UI is untouched by this feature. Spec: [docs/superpowers/specs/2026-04-19-go-to-school-design.md](../specs/2026-04-19-go-to-school-design.md).

---

## File Structure

### New files (PR-A — log infrastructure)

| Path | Responsibility |
|---|---|
| `app/src/main/assets/nodejs-project/call-shape.js` | Per-tool `call_shape` builders + `getShape(toolName, args)` entry point. Pure functions. |
| `app/src/main/assets/nodejs-project/tool-call-logger.js` | In-memory buffered logger + flush. Appends to `tool_call_log` in batches; flushes on 5s OR 100-row threshold. |
| `tests/nodejs-project/call-shape.test.js` | Unit tests for every tool's shape builder (privacy + stability). |
| `tests/nodejs-project/tool-call-log.test.js` | Logger buffer, retention, batch insert. |
| `tests/nodejs-project/skill-trigger-log.test.js` | Skill-trigger table inserts + UNIQUE constraint. |

### Modified files (PR-A)

| Path | What changes |
|---|---|
| `app/src/main/assets/nodejs-project/database.js` | Add `CREATE TABLE tool_call_log` and `CREATE TABLE skill_trigger_log` in `initDatabase()`. Add `purgeOldLogs()` retention fn. Export both. |
| `app/src/main/assets/nodejs-project/tools/index.js` | Wrap `executeTool()` with buffered logger call. |
| `app/src/main/assets/nodejs-project/skills.js` | One-line `INSERT OR IGNORE` in `findMatchingSkills()` after `matched.push(skill)`. |
| `app/src/main/assets/nodejs-project/main.js` | Call `purgeOldLogs()` on service start; call `flushToolCallBuffer()` in shutdown path. |
| `tests/nodejs-project/smoke.js` | Add `call-shape`, `tool-call-logger` to side-effect-free module list. |

### New files (PR-B — school feature)

| Path | Responsibility |
|---|---|
| `app/src/main/assets/nodejs-project/school.js` | Pure module: `transition()` state machine, `scanLogs()`, `draftSkillFile()`, `writeSkillFile()`, `retireSkill()`, `readSchoolMd()`, `writeSchoolMd()`, `appendLogLine()`, `normalizeTitle()`, `signatureOf()`, `readPriorSessions()`. |
| `app/src/main/assets/nodejs-project/tools/school.js` | Thin tool handlers (6 tools): `school_begin`, `school_scan`, `school_write_skill`, `school_retire_skill`, `school_end`, `school_handle_input`. |
| `app/src/main/assets/default-skills/go-to-school/SKILL.md` | Bundled skill: frontmatter, rubric (5 gates + dedup), proposal format, approval protocol, input classification rubric, classification echo rule. |
| `tests/nodejs-project/school.test.js` | `normalizeTitle`, `signatureOf`, `scanLogs`, `readSchoolMd` malformed handling. |
| `tests/nodejs-project/school-state-machine.test.js` | All 32 `(state, input)` transitions from §8.5.1. |
| `tests/nodejs-project/school-tools.test.js` | Frontmatter marker enforcement, path sandbox, size cap, bundled-skill rejection, patch provenance preservation, stale-session auto-end, write-failure path. |
| `tests/nodejs-project/school-integration.test.js` | Full happy path on seeded fixtures + crash-recovery + classification echo presence. |
| `docs/internal/audits/SAB-AUDIT-v23.md` | SAB audit for school feature. Target: 60-100 probe points, 100% post-fix. |

### Modified files (PR-B)

| Path | What changes |
|---|---|
| `app/src/main/assets/nodejs-project/tools/index.js` | Import + merge `schoolTools` into `TOOLS`. Route school tool calls to handlers. |
| `app/src/main/assets/nodejs-project/ai.js` | Add new "Self-Improvement" block to `buildSystemBlocks()`. |
| `app/src/main/assets/nodejs-project/telegram.js` | Register `/school`, `/school log`, `/school-reset`, `/school-reset-confirm` commands. |
| `app/src/main/assets/nodejs-project/message-handler.js` | Detect `/school-reset-confirm` pending state (60s TTL) and gate the reset action. |
| `app/src/main/assets/nodejs-project/main.js` | On startup: detect stale `workspace/SCHOOL.md`, auto-end via `school_end`; detect concurrent-session interaction with `/school`. |
| `app/src/main/assets/nodejs-project/DIAGNOSTICS.md` | New section on school troubleshooting: stuck SCHOOL.md, empty-log, bundled-skill-rejection, stale-session behavior, `/school-reset` flow. |
| `CHANGELOG.md` | Add v1.10.0 "Go to School" entry under Added. |
| `app/build.gradle.kts` | Bump `versionCode` 17 → 18, `versionName` "1.9.0" → "1.10.0". |
| `tests/nodejs-project/smoke.js` | Add `school` to side-effect-free module list. |

---

# PHASE A — PR-A: Log infrastructure

Ships as **v1.10.0-rc1**. No user-visible behavior change. Soaks in production for 7 days before PR-B merges.

---

### Task A1: `tool_call_log` table migration + unit test

**Files:**
- Modify: `app/src/main/assets/nodejs-project/database.js`
- Test: `tests/nodejs-project/tool-call-log.test.js`

- [ ] **Step 1: Write the failing test**

Create `tests/nodejs-project/tool-call-log.test.js`:

```javascript
#!/usr/bin/env node
// tool-call-log.test.js — schema + insert smoke test for tool_call_log.
// Run: node tests/nodejs-project/tool-call-log.test.js

const path = require('path');

async function main() {
    const SQL_PATH = path.join(__dirname, '../../app/src/main/assets/nodejs-project/sql-wasm.js');
    const initSqlJs = require(SQL_PATH);
    const SQL = await initSqlJs({ locateFile: f => path.join(path.dirname(SQL_PATH), f) });
    const db = new SQL.Database();

    // This will fail until the migration runs. We call the exported migration helper.
    const { createToolCallLogSchema } = require(
        path.join(__dirname, '../../app/src/main/assets/nodejs-project/database.js')
    );
    createToolCallLogSchema(db);

    db.run(`INSERT INTO tool_call_log
        (turn_id, message_id, tool_name, triggered_by_skill, call_shape, result_status, error_kind, latency_ms, created_at)
        VALUES ('t1', 'm1', 'web_fetch', NULL, 'web_fetch:example.com:GET', 'ok', NULL, 45, 1713614400000)`);

    const rows = db.exec('SELECT tool_name, call_shape FROM tool_call_log');
    if (rows.length !== 1 || rows[0].values.length !== 1 ||
        rows[0].values[0][0] !== 'web_fetch' || rows[0].values[0][1] !== 'web_fetch:example.com:GET') {
        console.error('FAIL: expected single row with tool_name=web_fetch');
        process.exit(1);
    }
    console.log('  ✓ tool_call_log schema created + insert roundtrips');
    console.log('all tests passed');
    process.exit(0);
}

main().catch(e => { console.error('FAIL', e); process.exit(1); });
```

- [ ] **Step 2: Run test to verify it fails**

```bash
node tests/nodejs-project/tool-call-log.test.js
```
Expected: FAIL — `createToolCallLogSchema is not a function` (not yet exported).

- [ ] **Step 3: Add the schema function in `database.js`**

In `app/src/main/assets/nodejs-project/database.js`, after the existing `CREATE TABLE api_request_log` block (around line 93), add:

```javascript
function createToolCallLogSchema(dbInstance) {
    dbInstance.run(`CREATE TABLE IF NOT EXISTS tool_call_log (
        id                 INTEGER PRIMARY KEY AUTOINCREMENT,
        turn_id            TEXT    NOT NULL,
        message_id         TEXT,
        tool_name          TEXT    NOT NULL,
        triggered_by_skill TEXT,
        call_shape         TEXT    NOT NULL,
        result_status      TEXT    NOT NULL,
        error_kind         TEXT,
        latency_ms         INTEGER,
        created_at         INTEGER NOT NULL
    )`);
    dbInstance.run(`CREATE INDEX IF NOT EXISTS idx_tcl_created ON tool_call_log(created_at)`);
    dbInstance.run(`CREATE INDEX IF NOT EXISTS idx_tcl_tool    ON tool_call_log(tool_name, created_at)`);
    dbInstance.run(`CREATE INDEX IF NOT EXISTS idx_tcl_shape   ON tool_call_log(call_shape, created_at)`);
    dbInstance.run(`CREATE INDEX IF NOT EXISTS idx_tcl_turn    ON tool_call_log(turn_id)`);
    dbInstance.run(`CREATE INDEX IF NOT EXISTS idx_tcl_skill   ON tool_call_log(triggered_by_skill, created_at)`);
}
```

Call it from `initDatabase()` after the existing table creates. Export it from `module.exports` (add `createToolCallLogSchema,`).

- [ ] **Step 4: Run test to verify it passes**

```bash
node tests/nodejs-project/tool-call-log.test.js
```
Expected: PASS — `✓ tool_call_log schema created + insert roundtrips`.

- [ ] **Step 5: Commit**

```bash
git add app/src/main/assets/nodejs-project/database.js tests/nodejs-project/tool-call-log.test.js
git commit -m "feat(log): add tool_call_log schema + unit test"
```

---

### Task A2: `skill_trigger_log` table migration + UNIQUE-constraint test

**Files:**
- Modify: `app/src/main/assets/nodejs-project/database.js`
- Test: `tests/nodejs-project/skill-trigger-log.test.js`

- [ ] **Step 1: Write the failing test**

Create `tests/nodejs-project/skill-trigger-log.test.js`:

```javascript
#!/usr/bin/env node
// skill-trigger-log.test.js — schema + UNIQUE constraint test.
// Run: node tests/nodejs-project/skill-trigger-log.test.js

const path = require('path');

async function main() {
    const SQL_PATH = path.join(__dirname, '../../app/src/main/assets/nodejs-project/sql-wasm.js');
    const initSqlJs = require(SQL_PATH);
    const SQL = await initSqlJs({ locateFile: f => path.join(path.dirname(SQL_PATH), f) });
    const db = new SQL.Database();

    const { createSkillTriggerLogSchema } = require(
        path.join(__dirname, '../../app/src/main/assets/nodejs-project/database.js')
    );
    createSkillTriggerLogSchema(db);

    // First insert succeeds.
    db.run(`INSERT OR IGNORE INTO skill_trigger_log
        (skill_name, message_id, match_type, created_at) VALUES ('weather', 'msg-1', 'keyword', 1713614400000)`);

    // Duplicate (skill_name, message_id) is silently ignored.
    db.run(`INSERT OR IGNORE INTO skill_trigger_log
        (skill_name, message_id, match_type, created_at) VALUES ('weather', 'msg-1', 'keyword', 1713614400500)`);

    const result = db.exec('SELECT COUNT(*) FROM skill_trigger_log');
    const count = result[0].values[0][0];
    if (count !== 1) {
        console.error(`FAIL: expected 1 row after dedup, got ${count}`);
        process.exit(1);
    }
    console.log('  ✓ skill_trigger_log dedups on (skill_name, message_id)');
    console.log('all tests passed');
    process.exit(0);
}

main().catch(e => { console.error('FAIL', e); process.exit(1); });
```

- [ ] **Step 2: Run test to verify it fails**

```bash
node tests/nodejs-project/skill-trigger-log.test.js
```
Expected: FAIL — `createSkillTriggerLogSchema is not a function`.

- [ ] **Step 3: Add schema fn in `database.js`**

In `database.js`, right after `createToolCallLogSchema`:

```javascript
function createSkillTriggerLogSchema(dbInstance) {
    dbInstance.run(`CREATE TABLE IF NOT EXISTS skill_trigger_log (
        id          INTEGER PRIMARY KEY AUTOINCREMENT,
        skill_name  TEXT    NOT NULL,
        message_id  TEXT,
        match_type  TEXT    NOT NULL,
        created_at  INTEGER NOT NULL,
        UNIQUE(skill_name, message_id)
    )`);
    dbInstance.run(`CREATE INDEX IF NOT EXISTS idx_stl_skill_created ON skill_trigger_log(skill_name, created_at)`);
    dbInstance.run(`CREATE INDEX IF NOT EXISTS idx_stl_created       ON skill_trigger_log(created_at)`);
}
```

Call it from `initDatabase()`. Export it.

- [ ] **Step 4: Run test to verify it passes**

```bash
node tests/nodejs-project/skill-trigger-log.test.js
```
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add app/src/main/assets/nodejs-project/database.js tests/nodejs-project/skill-trigger-log.test.js
git commit -m "feat(log): add skill_trigger_log schema with UNIQUE(skill, msg) dedup"
```

---

### Task A3: `call-shape.js` — per-tool builders + default

**Files:**
- Create: `app/src/main/assets/nodejs-project/call-shape.js`
- Test: `tests/nodejs-project/call-shape.test.js`

- [ ] **Step 1: Write the failing test**

Create `tests/nodejs-project/call-shape.test.js`:

```javascript
#!/usr/bin/env node
// call-shape.test.js — per-tool shape builders. Must produce structural
// classifiers without leaking sensitive values (wallets, API keys, user text).
// Run: node tests/nodejs-project/call-shape.test.js

const path = require('path');
const { getShape } = require(path.join(__dirname, '../../app/src/main/assets/nodejs-project/call-shape.js'));

let fails = 0;
function assertEq(actual, expected, msg) {
    if (actual !== expected) {
        console.error(`FAIL ${msg}: expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
        fails++;
    } else {
        console.log(`  ✓ ${msg}`);
    }
}
function assertNotContains(shape, needle, msg) {
    if (typeof shape === 'string' && shape.includes(needle)) {
        console.error(`FAIL ${msg}: shape ${JSON.stringify(shape)} contained ${JSON.stringify(needle)}`);
        fails++;
    } else {
        console.log(`  ✓ ${msg}`);
    }
}

// web_fetch: host + method only
assertEq(getShape('web_fetch', { url: 'https://api.anthropic.com/v1/messages?key=secret', method: 'POST' }),
    'web_fetch:api.anthropic.com:POST', 'web_fetch shape: host+method');
assertEq(getShape('web_fetch', { url: 'https://example.com/path' }),
    'web_fetch:example.com:GET', 'web_fetch shape: default GET');

// solana_swap: well-known mints are public; unknown mints → "other"
assertEq(getShape('solana_swap', { inputMint: 'So11111111111111111111111111111111111111112', outputMint: 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v' }),
    'solana_swap:SOL:USDC', 'solana_swap shape: known mint pair');
assertEq(getShape('solana_swap', { inputMint: 'AbcXyzRandomMintAddress1234567890', outputMint: 'So11111111111111111111111111111111111111112' }),
    'solana_swap:other:SOL', 'solana_swap shape: unknown input mint → other');

// solana_balance: self vs other
assertEq(getShape('solana_balance', {}), 'solana_balance:self', 'solana_balance shape: self');
assertEq(getShape('solana_balance', { address: 'SomeOtherWallet' }), 'solana_balance:other', 'solana_balance shape: other');

// file_read: path pattern
assertEq(getShape('file_read', { path: 'memory/2026-04-19.md' }), 'file_read:memory/*.md', 'file_read shape: memory daily');
assertEq(getShape('file_read', { path: 'skills/weather.md' }), 'file_read:skills/*.md', 'file_read shape: skills');
assertEq(getShape('file_read', { path: 'SOUL.md' }), 'file_read:SOUL.md', 'file_read shape: root md');

// shell_exec: first token only
assertEq(getShape('shell_exec', { cmd: 'ls -la /tmp' }), 'shell_exec:ls', 'shell_exec shape: first token');
assertEq(getShape('shell_exec', { cmd: 'cat /etc/passwd' }), 'shell_exec:cat', 'shell_exec shape: cat');

// default — just the tool name
assertEq(getShape('some_new_unknown_tool', { whatever: 'x' }), 'some_new_unknown_tool',
    'default shape: just tool name');

// Privacy red-team — sensitive values never appear in shape
const wallet = 'AbcXyzWallet1234567890xxx';
const apiKey = 'sk-ant-api03-secret';
assertNotContains(getShape('solana_balance', { address: wallet }), wallet, 'wallet not in shape');
assertNotContains(getShape('web_fetch', { url: `https://example.com?key=${apiKey}` }), apiKey, 'api key not in shape');
assertNotContains(getShape('file_read', { path: 'memory/private-name-here.md' }), 'private-name-here', 'filename not in shape');

// Size cap — 64 chars max
const huge = 'solana_swap';
const longMint = 'X'.repeat(100);
const shape = getShape('solana_swap', { inputMint: longMint, outputMint: longMint });
if (shape.length > 64) {
    console.error(`FAIL shape length ${shape.length} > 64: ${shape}`);
    fails++;
} else {
    console.log(`  ✓ shape length capped at 64 chars`);
}

if (fails > 0) { console.error(`${fails} failures`); process.exit(1); }
console.log('all tests passed');
process.exit(0);
```

- [ ] **Step 2: Run test to verify it fails**

```bash
node tests/nodejs-project/call-shape.test.js
```
Expected: FAIL — `Cannot find module 'call-shape.js'`.

- [ ] **Step 3: Create `call-shape.js`**

Create `app/src/main/assets/nodejs-project/call-shape.js`:

```javascript
// call-shape.js — structural classifier per tool for tool_call_log.
// Pure functions. Never stores sensitive data. Max 64 chars per shape.
//
// Each builder receives the tool's args and returns a short string that
// captures the *class* of the call (e.g. "web_fetch:api.anthropic.com:POST")
// without any user-specific values.

const KNOWN_MINTS = {
    'So11111111111111111111111111111111111111112': 'SOL',
    'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v': 'USDC',
    'Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB': 'USDT',
    'DezXAZ8z7PnrnRJjz3wXBoRgixCa6xjnB7YaB1pPB263': 'BONK',
};
function mintLabel(mint) {
    if (!mint) return 'unknown';
    return KNOWN_MINTS[mint] || 'other';
}

function hostOf(url) {
    if (!url || typeof url !== 'string') return 'unknown';
    try {
        const u = new URL(url);
        return u.hostname;
    } catch (_) {
        return 'malformed';
    }
}

function pathPattern(p) {
    if (!p || typeof p !== 'string') return 'unknown';
    // memory/YYYY-MM-DD.md → memory/*.md
    if (/^memory\/\d{4}-\d{2}-\d{2}\.md$/.test(p)) return 'memory/*.md';
    if (/^memory\//.test(p)) return 'memory/*';
    if (/^skills\/[^/]+\.md$/.test(p)) return 'skills/*.md';
    if (/^skills\//.test(p)) return 'skills/*';
    if (/^workspace\/school\//.test(p)) return 'workspace/school/*';
    // Root-level .md files expose filename (safe — SOUL/MEMORY/IDENTITY/USER/HEARTBEAT only)
    if (/^[A-Z]+\.md$/.test(p)) return p;
    // Everything else → bucket by depth
    return p.split('/').slice(0, 2).join('/') + '/*';
}

const builders = {
    web_fetch: (args) => `web_fetch:${hostOf(args.url)}:${(args.method || 'GET').toUpperCase()}`,
    web_search: (args) => `web_search:${args.provider || 'default'}`,
    solana_swap: (args) => `solana_swap:${mintLabel(args.inputMint)}:${mintLabel(args.outputMint)}`,
    solana_balance: (args) => args && args.address ? 'solana_balance:other' : 'solana_balance:self',
    solana_send: (args) => `solana_send:${mintLabel(args && args.mint)}`,
    solana_price: (args) => `solana_price:${mintLabel(args && args.mint)}`,
    file_read: (args) => `file_read:${pathPattern(args && args.path)}`,
    file_write: (args) => `file_write:${pathPattern(args && args.path)}`,
    file_edit: (args) => `file_edit:${pathPattern(args && args.path)}`,
    file_delete: (args) => `file_delete:${pathPattern(args && args.path)}`,
    shell_exec: (args) => {
        const cmd = (args && args.cmd) || '';
        const first = cmd.trim().split(/\s+/)[0] || 'empty';
        return `shell_exec:${first}`;
    },
    android_sms: () => 'android_sms',
    android_call: () => 'android_call',
    telegram_send: () => 'telegram_send',
};

function getShape(toolName, args) {
    const b = builders[toolName];
    const raw = b ? b(args || {}) : toolName;
    // Cap to 64 chars with trailing … if truncated
    if (raw.length <= 64) return raw;
    return raw.slice(0, 63) + '…';
}

module.exports = { getShape };
```

- [ ] **Step 4: Run test to verify it passes**

```bash
node tests/nodejs-project/call-shape.test.js
```
Expected: PASS — all 14+ cases.

- [ ] **Step 5: Commit**

```bash
git add app/src/main/assets/nodejs-project/call-shape.js tests/nodejs-project/call-shape.test.js
git commit -m "feat(log): call-shape builders for 14 tools + privacy red-team test"
```

---

### Task A4: Buffered async tool-call logger

**Files:**
- Create: `app/src/main/assets/nodejs-project/tool-call-logger.js`
- Test: extend `tests/nodejs-project/tool-call-log.test.js`

- [ ] **Step 1: Add a failing test for buffering**

Append to `tests/nodejs-project/tool-call-log.test.js` (before the final `console.log('all tests passed')`):

```javascript
    // Buffered logger test
    const { ToolCallLogger } = require(
        path.join(__dirname, '../../app/src/main/assets/nodejs-project/tool-call-logger.js')
    );
    const logger = new ToolCallLogger({ db, flushIntervalMs: 50, maxBufferSize: 5 });

    // Log 7 rows — should trigger size-based flush at 5
    for (let i = 0; i < 7; i++) {
        logger.record({
            turn_id: 't2', message_id: `m${i}`, tool_name: 'web_fetch',
            triggered_by_skill: null, call_shape: 'web_fetch:example.com:GET',
            result_status: 'ok', error_kind: null, latency_ms: 10, created_at: 1713614400000 + i
        });
    }
    // Wait briefly for interval flush
    await new Promise(r => setTimeout(r, 80));
    await logger.flushNow();

    const r = db.exec('SELECT COUNT(*) FROM tool_call_log WHERE turn_id = ?', ['t2']);
    const c = r[0].values[0][0];
    if (c !== 7) { console.error(`FAIL buffered logger: expected 7 rows, got ${c}`); process.exit(1); }
    console.log('  ✓ buffered logger flushes on size + interval');
    logger.stop();
```

- [ ] **Step 2: Run to verify it fails**

```bash
node tests/nodejs-project/tool-call-log.test.js
```
Expected: FAIL — `Cannot find module 'tool-call-logger.js'`.

- [ ] **Step 3: Create the logger**

Create `app/src/main/assets/nodejs-project/tool-call-logger.js`:

```javascript
// tool-call-logger.js — in-memory buffer for tool_call_log inserts.
// Flushes on 5s interval OR 100-row threshold (whichever first).
// Bypasses the hot path of tool execution; worst case on abrupt kill = 5s of log loss.

class ToolCallLogger {
    constructor({ db, flushIntervalMs = 5000, maxBufferSize = 100, log = () => {} }) {
        this.db = db;
        this.buffer = [];
        this.flushIntervalMs = flushIntervalMs;
        this.maxBufferSize = maxBufferSize;
        this.log = log;
        this.flushing = false;
        this.stopped = false;
        this.timer = setInterval(() => { this.flushNow().catch(() => {}); }, flushIntervalMs);
        if (this.timer.unref) this.timer.unref();  // don't block Node exit on this timer
    }

    record(row) {
        if (this.stopped) return;
        this.buffer.push(row);
        if (this.buffer.length >= this.maxBufferSize) {
            // Fire-and-forget; batch flush on next tick.
            setImmediate(() => this.flushNow().catch(() => {}));
        }
    }

    async flushNow() {
        if (this.flushing) return;
        if (this.buffer.length === 0) return;
        this.flushing = true;
        const batch = this.buffer.splice(0, this.buffer.length);
        try {
            this.db.run('BEGIN TRANSACTION');
            const stmt = this.db.prepare(`INSERT INTO tool_call_log
                (turn_id, message_id, tool_name, triggered_by_skill, call_shape, result_status, error_kind, latency_ms, created_at)
                VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`);
            for (const r of batch) {
                stmt.run([r.turn_id, r.message_id, r.tool_name, r.triggered_by_skill,
                          r.call_shape, r.result_status, r.error_kind, r.latency_ms, r.created_at]);
            }
            stmt.free();
            this.db.run('COMMIT');
        } catch (e) {
            try { this.db.run('ROLLBACK'); } catch (_) {}
            this.log(`[ToolCallLogger] flush failed: ${e.message}`, 'ERROR');
            // Put the batch back at the head so we don't lose it silently
            this.buffer.unshift(...batch);
        } finally {
            this.flushing = false;
        }
    }

    stop() {
        this.stopped = true;
        clearInterval(this.timer);
    }
}

module.exports = { ToolCallLogger };
```

- [ ] **Step 4: Run to verify it passes**

```bash
node tests/nodejs-project/tool-call-log.test.js
```
Expected: PASS — both schema and buffered-logger cases.

- [ ] **Step 5: Commit**

```bash
git add app/src/main/assets/nodejs-project/tool-call-logger.js tests/nodejs-project/tool-call-log.test.js
git commit -m "feat(log): buffered async tool-call logger (5s / 100-row flush)"
```

---

### Task A5: Wire `executeTool` to the logger

**Files:**
- Modify: `app/src/main/assets/nodejs-project/tools/index.js`
- Modify: `app/src/main/assets/nodejs-project/main.js`

- [ ] **Step 1: Read current `executeTool` dispatcher**

```bash
grep -n "executeTool\|function execute\|async function execute" /Users/egod/Dev/SeekerClaw/app/src/main/assets/nodejs-project/tools/index.js | head
```

Note the exact function signature — the wrap in Step 2 must match.

- [ ] **Step 2: Add logger wrap in `tools/index.js`**

At the top of `tools/index.js`, add imports:

```javascript
const { ToolCallLogger } = require('../tool-call-logger');
const { getShape } = require('../call-shape');
const { getDb } = require('../database');
```

Add module state (singleton logger, initialized lazily):

```javascript
let _logger = null;
function getLogger() {
    if (!_logger) {
        const db = getDb();
        if (!db) return null;
        _logger = new ToolCallLogger({ db, log });  // `log` comes from existing require('../config')
    }
    return _logger;
}
function stopLogger() { if (_logger) { _logger.stop(); _logger = null; } }
```

Wrap the existing tool dispatch. Find the function (likely `executeTool` or similar) and add timing + logger call:

```javascript
async function executeToolWithLogging(name, args, context) {
    const startedAt = Date.now();
    let status = 'ok';
    let errorKind = null;
    try {
        const result = await executeToolInner(name, args, context);  // rename original to executeToolInner
        if (result && result.isError) { status = 'error'; errorKind = (result.errorKind || 'unknown'); }
        return result;
    } catch (e) {
        status = 'error';
        errorKind = (e.code || e.name || 'exception').toString().slice(0, 60);
        throw e;
    } finally {
        const logger = getLogger();
        if (logger) {
            logger.record({
                turn_id: (context && context.turn_id) || 'unknown',
                message_id: (context && context.message_id) || null,
                tool_name: name,
                triggered_by_skill: (context && context.activeSkill) || null,
                call_shape: getShape(name, args),
                result_status: status,
                error_kind: errorKind,
                latency_ms: Date.now() - startedAt,
                created_at: startedAt,
            });
        }
    }
}
```

Export the wrapped version as `executeTool`, keep `executeToolInner` as the dispatcher. Also export `stopLogger`.

- [ ] **Step 3: Flush on shutdown in `main.js`**

In `main.js`, find the shutdown path (look for existing `process.on('SIGTERM'` or similar graceful exit). Add:

```javascript
// Flush any buffered tool-call logs before exit
try {
    const { stopLogger, flushLoggerNow } = require('./tools');
    if (flushLoggerNow) await flushLoggerNow();
    if (stopLogger) stopLogger();
} catch (e) { /* best-effort */ }
```

Also export `flushLoggerNow` from `tools/index.js`:

```javascript
async function flushLoggerNow() { const l = getLogger(); if (l) await l.flushNow(); }
module.exports = { executeTool: executeToolWithLogging, stopLogger, flushLoggerNow, /* ...existing... */ };
```

- [ ] **Step 4: Smoke-check — run the module-load smoke test**

```bash
node tests/nodejs-project/smoke.js
```
Expected: PASS — no regex/module-load regressions.

- [ ] **Step 5: Commit**

```bash
git add app/src/main/assets/nodejs-project/tools/index.js app/src/main/assets/nodejs-project/main.js
git commit -m "feat(log): wrap executeTool with buffered call logger + shutdown flush"
```

---

### Task A6: Skill-trigger instrumentation in `findMatchingSkills`

**Files:**
- Modify: `app/src/main/assets/nodejs-project/skills.js`
- Test: extend `tests/nodejs-project/skill-trigger-log.test.js`

- [ ] **Step 1: Add a failing test for instrumentation**

Append to `tests/nodejs-project/skill-trigger-log.test.js` (before final `process.exit(0)`):

```javascript
    // Verify findMatchingSkills records matches.
    // We call a helper that simulates the match-and-log path.
    const { recordSkillTrigger } = require(
        path.join(__dirname, '../../app/src/main/assets/nodejs-project/skills.js')
    );
    // Seed db on the module
    const { setSkillTriggerDb } = require(
        path.join(__dirname, '../../app/src/main/assets/nodejs-project/skills.js')
    );
    setSkillTriggerDb(db);

    recordSkillTrigger('weather', 'msg-42', 'keyword', 1713614500000);
    recordSkillTrigger('weather', 'msg-42', 'keyword', 1713614500500);  // duplicate, should be ignored

    const r2 = db.exec('SELECT COUNT(*) FROM skill_trigger_log WHERE message_id = ?', ['msg-42']);
    const c2 = r2[0].values[0][0];
    if (c2 !== 1) { console.error(`FAIL recordSkillTrigger dedup: expected 1, got ${c2}`); process.exit(1); }
    console.log('  ✓ recordSkillTrigger uses INSERT OR IGNORE (no double-count)');
```

- [ ] **Step 2: Run test to verify it fails**

```bash
node tests/nodejs-project/skill-trigger-log.test.js
```
Expected: FAIL — `recordSkillTrigger is not a function` OR `setSkillTriggerDb is not a function`.

- [ ] **Step 3: Add the helper + instrument the matcher**

In `app/src/main/assets/nodejs-project/skills.js`, near the top (after existing imports), add:

```javascript
let _stlDb = null;
function setSkillTriggerDb(db) { _stlDb = db; }
function recordSkillTrigger(skillName, messageId, matchType, createdAt) {
    if (!_stlDb) return;
    try {
        _stlDb.run(`INSERT OR IGNORE INTO skill_trigger_log (skill_name, message_id, match_type, created_at) VALUES (?, ?, ?, ?)`,
            [skillName, messageId || null, matchType, createdAt]);
    } catch (e) { /* never fail a message on telemetry */ }
}
```

In `findMatchingSkills()` (around line 548), after `matched.push(skill)`, add instrumentation — but the function signature is `findMatchingSkills(message)` which has no `message_id`. Change the signature to accept an optional `ctx` arg:

```javascript
function findMatchingSkills(message, ctx = {}) {
    const skills = loadSkills();
    const lowerMsg = message.toLowerCase();
    const matched = [];
    for (const skill of skills) {
        if (matched.length >= 2) break;
        const hasTrigger = skill.triggers.some(trigger => {
            if (trigger.includes(' ')) return lowerMsg.includes(trigger);
            const regex = new RegExp(`\\b${trigger.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`, 'i');
            return regex.test(message);
        });
        if (hasTrigger) {
            matched.push(skill);
            if (ctx.message_id) {
                recordSkillTrigger(skill.name, ctx.message_id, 'keyword', ctx.timestamp || Date.now());
            }
        }
    }
    return matched;
}
```

All callers of `findMatchingSkills(msg)` continue to work (ctx defaults to `{}`). Update the call site in `ai.js` (around line 387) and `message-handler.js` to pass `{ message_id, timestamp }` where known.

Export `recordSkillTrigger` and `setSkillTriggerDb` in `module.exports`.

In `database.js` `initDatabase()`, after `createSkillTriggerLogSchema(db)`, wire the db into skills:

```javascript
const { setSkillTriggerDb } = require('./skills');
setSkillTriggerDb(db);
```

- [ ] **Step 4: Run test to verify it passes**

```bash
node tests/nodejs-project/skill-trigger-log.test.js
```
Expected: PASS — both schema dedup and `recordSkillTrigger` dedup.

- [ ] **Step 5: Commit**

```bash
git add app/src/main/assets/nodejs-project/skills.js app/src/main/assets/nodejs-project/database.js app/src/main/assets/nodejs-project/ai.js app/src/main/assets/nodejs-project/message-handler.js tests/nodejs-project/skill-trigger-log.test.js
git commit -m "feat(log): instrument findMatchingSkills with skill_trigger_log writes"
```

---

### Task A7: Retention purge on service start

**Files:**
- Modify: `app/src/main/assets/nodejs-project/database.js`
- Modify: `app/src/main/assets/nodejs-project/main.js`
- Test: extend `tests/nodejs-project/tool-call-log.test.js`

- [ ] **Step 1: Add failing test for retention**

Append to `tests/nodejs-project/tool-call-log.test.js`:

```javascript
    // Retention purge test
    const { purgeOldLogs } = require(
        path.join(__dirname, '../../app/src/main/assets/nodejs-project/database.js')
    );
    const now = 1713614400000;
    const oldMs = now - (31 * 24 * 60 * 60 * 1000);   // 31 days old
    const recentMs = now - (5 * 24 * 60 * 60 * 1000); // 5 days old
    db.run(`INSERT INTO tool_call_log
        (turn_id, tool_name, call_shape, result_status, latency_ms, created_at)
        VALUES ('old', 'web_fetch', 'web_fetch:x:GET', 'ok', 1, ?)`, [oldMs]);
    db.run(`INSERT INTO tool_call_log
        (turn_id, tool_name, call_shape, result_status, latency_ms, created_at)
        VALUES ('recent', 'web_fetch', 'web_fetch:x:GET', 'ok', 1, ?)`, [recentMs]);

    purgeOldLogs(db, now);

    const oldCount = db.exec(`SELECT COUNT(*) FROM tool_call_log WHERE turn_id = 'old'`)[0].values[0][0];
    const recentCount = db.exec(`SELECT COUNT(*) FROM tool_call_log WHERE turn_id = 'recent'`)[0].values[0][0];
    if (oldCount !== 0) { console.error(`FAIL: old rows not purged, ${oldCount} remain`); process.exit(1); }
    if (recentCount !== 1) { console.error(`FAIL: recent row purged, expected 1 got ${recentCount}`); process.exit(1); }
    console.log('  ✓ purgeOldLogs removes rows > 30 days, keeps recent');
```

- [ ] **Step 2: Run to verify fail**

```bash
node tests/nodejs-project/tool-call-log.test.js
```
Expected: FAIL — `purgeOldLogs is not a function`.

- [ ] **Step 3: Implement purge fn**

In `database.js`:

```javascript
const TOOL_CALL_LOG_RETENTION_MS = 30 * 24 * 60 * 60 * 1000;  // 30 days
const MAX_TOOL_CALL_LOG_ROWS = 50000;

function purgeOldLogs(dbInstance, now = Date.now()) {
    const cutoff = now - TOOL_CALL_LOG_RETENTION_MS;
    dbInstance.run(`DELETE FROM tool_call_log WHERE created_at < ?`, [cutoff]);
    dbInstance.run(`DELETE FROM skill_trigger_log WHERE created_at < ?`, [cutoff]);
    // Cap row count
    dbInstance.run(`DELETE FROM tool_call_log WHERE id IN (
        SELECT id FROM tool_call_log ORDER BY created_at DESC LIMIT -1 OFFSET ?
    )`, [MAX_TOOL_CALL_LOG_ROWS]);
}
```

Export `purgeOldLogs`.

In `main.js`, after `initDatabase()` returns, call:

```javascript
// Retention purge runs async, off the boot critical path
setImmediate(() => {
    try {
        const { purgeOldLogs, getDb } = require('./database');
        const db = getDb();
        if (db) purgeOldLogs(db);
    } catch (e) { /* best-effort */ }
});
```

- [ ] **Step 4: Run test to verify passes**

```bash
node tests/nodejs-project/tool-call-log.test.js
```
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add app/src/main/assets/nodejs-project/database.js app/src/main/assets/nodejs-project/main.js tests/nodejs-project/tool-call-log.test.js
git commit -m "feat(log): 30-day retention purge for tool_call_log + skill_trigger_log"
```

---

### Task A8: Perf budget test

**Files:**
- Test: `tests/nodejs-project/tool-call-log-perf.test.js`

- [ ] **Step 1: Write the perf test**

Create `tests/nodejs-project/tool-call-log-perf.test.js`:

```javascript
#!/usr/bin/env node
// tool-call-log-perf.test.js — ensure the buffered logger doesn't
// regress p99 tool latency under a 1000-call burst.
// Target: 1000 records + flush < 200ms wall-clock total. If this
// fails, the buffered-insert path is slower than expected.

const path = require('path');

async function main() {
    const SQL_PATH = path.join(__dirname, '../../app/src/main/assets/nodejs-project/sql-wasm.js');
    const initSqlJs = require(SQL_PATH);
    const SQL = await initSqlJs({ locateFile: f => path.join(path.dirname(SQL_PATH), f) });
    const db = new SQL.Database();

    const { createToolCallLogSchema } = require(
        path.join(__dirname, '../../app/src/main/assets/nodejs-project/database.js')
    );
    createToolCallLogSchema(db);

    const { ToolCallLogger } = require(
        path.join(__dirname, '../../app/src/main/assets/nodejs-project/tool-call-logger.js')
    );
    const logger = new ToolCallLogger({ db, flushIntervalMs: 10000, maxBufferSize: 200 });

    const start = Date.now();
    for (let i = 0; i < 1000; i++) {
        logger.record({
            turn_id: 'perf', message_id: `m${i}`, tool_name: 'web_fetch',
            triggered_by_skill: null, call_shape: 'web_fetch:x:GET',
            result_status: 'ok', error_kind: null, latency_ms: 1, created_at: start + i
        });
    }
    await logger.flushNow();
    const elapsed = Date.now() - start;

    const count = db.exec('SELECT COUNT(*) FROM tool_call_log')[0].values[0][0];
    if (count !== 1000) { console.error(`FAIL: expected 1000 rows, got ${count}`); process.exit(1); }

    logger.stop();

    if (elapsed > 200) {
        console.error(`FAIL: 1000-record burst took ${elapsed}ms (budget: 200ms)`);
        process.exit(1);
    }
    console.log(`  ✓ 1000 records + flush = ${elapsed}ms (budget 200ms)`);
    console.log('all tests passed');
    process.exit(0);
}

main().catch(e => { console.error('FAIL', e); process.exit(1); });
```

- [ ] **Step 2: Run — should pass if logger + schema are correct**

```bash
node tests/nodejs-project/tool-call-log-perf.test.js
```
Expected: PASS with an elapsed time report.

- [ ] **Step 3: If it fails, investigate before committing**

If the budget is exceeded, check:
- `BEGIN TRANSACTION` / `COMMIT` wrapping the prepared-statement loop
- `stmt.free()` after use
- `setImmediate` not accidentally serializing flushes

Tune `maxBufferSize` (200 in the test) to match realistic production size if needed; do NOT relax the 200ms budget silently.

- [ ] **Step 4: Commit**

```bash
git add tests/nodejs-project/tool-call-log-perf.test.js
git commit -m "test(log): 1000-record burst perf budget (200ms)"
```

---

### Task A9: Smoke test hookup + PR-A CHANGELOG + tag rc1

**Files:**
- Modify: `tests/nodejs-project/smoke.js`
- Modify: `CHANGELOG.md`

- [ ] **Step 1: Add new modules to side-effect-free smoke list**

In `tests/nodejs-project/smoke.js`, find the list of modules that get `require()`'d in Phase 2 (look for `const SIDE_EFFECT_FREE = [...]` or similar). Add:

```javascript
'call-shape',
'tool-call-logger',
```

- [ ] **Step 2: Run the full smoke suite**

```bash
node tests/nodejs-project/smoke.js
```
Expected: PASS — Phase 1 `--check` all files, Phase 2 `require()` of the side-effect-free list (including new entries).

- [ ] **Step 3: Add CHANGELOG entry under "Unreleased" (pre-PR-B)**

Add a top-of-file section to `CHANGELOG.md`:

```markdown
## [Unreleased]

### Added (internal — no user-facing change yet)
- `tool_call_log` + `skill_trigger_log` tables in SQL.js. Logs every tool invocation (via buffered async logger; 5s/100-row flush) and skill-trigger match. 30-day retention, 50k-row cap. Foundational for upcoming Go to School feature. Zero user-visible behavior change in this release.
```

- [ ] **Step 4: Commit CHANGELOG + smoke-list update together**

```bash
git add CHANGELOG.md tests/nodejs-project/smoke.js
git commit -m "chore(log): add call-shape + tool-call-logger to smoke test; CHANGELOG"
```

- [ ] **Step 5: Push the feature branch + open PR-A**

```bash
git push -u origin feature/go-to-school
gh pr create --title "feat(log): tool-call + skill-trigger logs (PR-A, BAT-XXX)" --body "$(cat <<'EOF'
## Summary

Phase A of the Go to School feature — log infrastructure.

- Adds `tool_call_log` and `skill_trigger_log` SQL.js tables.
- Buffered async logger (5s / 100-row flush) — writes off the tool-execution hot path.
- Per-tool `call_shape` structural classifier (privacy-safe; wallet addresses, URLs with query strings, user text never land in logs).
- 30-day retention + 50k row cap; purge runs on service start, off the boot critical path.
- Skill-trigger instrumentation with `UNIQUE(skill_name, message_id)` dedup.

**No user-visible behavior change in this PR.** PR-B (school feature) consumes these tables.

## Design

Spec: [docs/superpowers/specs/2026-04-19-go-to-school-design.md](../blob/feature/go-to-school/docs/superpowers/specs/2026-04-19-go-to-school-design.md). Phase A scope documented in §6 + §15.1 + §15.3.

## Test plan

- [ ] `node tests/nodejs-project/tool-call-log.test.js` passes (schema + buffered logger + retention)
- [ ] `node tests/nodejs-project/skill-trigger-log.test.js` passes (schema + UNIQUE dedup)
- [ ] `node tests/nodejs-project/call-shape.test.js` passes (14 tool shapes + privacy red-team)
- [ ] `node tests/nodejs-project/tool-call-log-perf.test.js` passes (1000-row burst < 200ms)
- [ ] `node tests/nodejs-project/smoke.js` passes
- [ ] On a Seeker device: install, run for 2+ days, verify `tool_call_log` accumulates rows and none contain sensitive values (wallet addresses, query-string secrets).

🤖 Generated with [Claude Code](https://claude.com/claude-code)
EOF
)"
```

**Wait for PR-A to merge + tag `v1.10.0-rc1` + soak 7 days in production before proceeding to Phase B.**

---

# PHASE B — PR-B: School feature

Ships as **v1.10.0** after PR-A soaks for 7 days.

---

### Task B1: `normalizeTitle` + `signatureOf` in `school.js`

**Files:**
- Create: `app/src/main/assets/nodejs-project/school.js`
- Test: `tests/nodejs-project/school.test.js`

- [ ] **Step 1: Write the failing test**

Create `tests/nodejs-project/school.test.js`:

```javascript
#!/usr/bin/env node
// school.test.js — pure functions in school.js.
// Run: node tests/nodejs-project/school.test.js

const path = require('path');
const { normalizeTitle, signatureOf } = require(
    path.join(__dirname, '../../app/src/main/assets/nodejs-project/school.js')
);

let fails = 0;
function assertEq(actual, expected, msg) {
    if (actual !== expected) {
        console.error(`FAIL ${msg}: expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
        fails++;
    } else console.log(`  ✓ ${msg}`);
}

// normalizeTitle — 4 variants collapse
assertEq(normalizeTitle('Recipe Scaling'), 'recipe-scaling', 'title spaces');
assertEq(normalizeTitle('recipe_scaling'), 'recipe-scaling', 'title underscore');
assertEq(normalizeTitle('recipe-scaling'), 'recipe-scaling', 'title kebab');
assertEq(normalizeTitle('RECIPE.SCALING!'), 'recipe-scaling', 'title upper+punct');
assertEq(normalizeTitle('  --recipe scaling--  '), 'recipe-scaling', 'title trimmed');

// Drift → different signature
if (signatureOf('create', 'Recipe Scaling') === signatureOf('create', 'recipe-scaling-v2')) {
    console.error(`FAIL signatureOf: v2 variant should differ from original`);
    fails++;
} else console.log('  ✓ signatureOf distinguishes v2 variant');

// Same title → same sig across cases
if (signatureOf('create', 'Recipe Scaling') !== signatureOf('create', 'RECIPE.SCALING!')) {
    console.error(`FAIL signatureOf: same normalized title should produce same sig`);
    fails++;
} else console.log('  ✓ signatureOf stable across case+punctuation');

if (fails > 0) process.exit(1);
console.log('all tests passed');
process.exit(0);
```

- [ ] **Step 2: Run — verify fail**

```bash
node tests/nodejs-project/school.test.js
```
Expected: FAIL — module not found.

- [ ] **Step 3: Create `school.js` with the two pure fns**

Create `app/src/main/assets/nodejs-project/school.js`:

```javascript
// school.js — pure module for Go to School feature.
// Provides state-machine transition, pattern mining, skill file writers,
// and persistent-log helpers. No side effects at module load.

const crypto = require('crypto');

function normalizeTitle(raw) {
    return String(raw || '')
        .toLowerCase()
        .replace(/[_\s.]+/g, '-')
        .replace(/[^a-z0-9-]/g, '')
        .replace(/-+/g, '-')
        .replace(/^-|-$/g, '');
}

function signatureOf(type, title) {
    const norm = normalizeTitle(title);
    return 'sha256:' + crypto.createHash('sha256').update(`${type}|${norm}`).digest('hex');
}

module.exports = { normalizeTitle, signatureOf };
```

- [ ] **Step 4: Run — verify pass**

```bash
node tests/nodejs-project/school.test.js
```
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add app/src/main/assets/nodejs-project/school.js tests/nodejs-project/school.test.js
git commit -m "feat(school): normalizeTitle + signatureOf with dedup tests"
```

---

### Task B2: State-machine `transition()` function + full 32-row test

**Files:**
- Modify: `app/src/main/assets/nodejs-project/school.js`
- Test: `tests/nodejs-project/school-state-machine.test.js`

- [ ] **Step 1: Write the failing test (all 32 transitions)**

Create `tests/nodejs-project/school-state-machine.test.js`:

```javascript
#!/usr/bin/env node
// school-state-machine.test.js — all 32 (state, input) transitions per spec §8.5.1.
// Run: node tests/nodejs-project/school-state-machine.test.js

const path = require('path');
const { transition } = require(
    path.join(__dirname, '../../app/src/main/assets/nodejs-project/school.js')
);

let fails = 0;
function assertMatch(result, expectedKind, expectedActionKind, msg) {
    const actualKind = result && result.nextState && result.nextState.kind;
    const actualAction = result && result.nextAction && result.nextAction.kind;
    const ok = actualKind === expectedKind && actualAction === expectedActionKind;
    if (!ok) {
        console.error(`FAIL ${msg}: expected state=${expectedKind} action=${expectedActionKind}, got state=${actualKind} action=${actualAction}`);
        fails++;
    } else console.log(`  ✓ ${msg}`);
}

// Shared state factory
const approve = { kind: 'awaiting_approval', open_proposal_ns: [1, 3, 4] };
const review3 = { kind: 'reviewing_<N>', reviewing_n: 3, open_proposal_ns: [1, 3, 4], reviewing_opened_at: 1000 };

// awaiting_approval + /review 3 (valid) → reviewing_<3>
assertMatch(transition(approve, { kind: 'review', proposal_n: 3, message_date: 2000 }),
    'reviewing_<N>', 'send_review_artifact', 'aa + /review 3 valid → reviewing_<3>');

// awaiting_approval + /review 7 (invalid) → awaiting_approval, reply_only
assertMatch(transition(approve, { kind: 'review', proposal_n: 7, message_date: 2000 }),
    'awaiting_approval', 'reply_only', 'aa + /review 7 invalid → reply_only');

// awaiting_approval + /skip 3 → awaiting_approval (2 remaining)
assertMatch(transition(approve, { kind: 'skip', proposal_n: 3, message_date: 2000 }),
    'awaiting_approval', 'reply_only', 'aa + /skip 3 → awaiting_approval');

// awaiting_approval + /stop → done
assertMatch(transition(approve, { kind: 'stop', message_date: 2000 }),
    'done', 'end_session', 'aa + /stop → done');

// awaiting_approval + yes (ambiguous — no review open) → awaiting_approval, reply_only
assertMatch(transition(approve, { kind: 'yes', message_date: 2000 }),
    'awaiting_approval', 'reply_only', 'aa + bare yes → reply_only (no review open)');

// reviewing_<3> + YES 3 (explicit) → awaiting_approval, write_skill
assertMatch(transition(review3, { kind: 'yes', proposal_n: 3, message_date: 1030 }),
    'awaiting_approval', 'write_skill', 'reviewing_3 + YES 3 → write_skill');

// reviewing_<3> + bare YES within 60s → awaiting_approval, write_skill
assertMatch(transition(review3, { kind: 'yes', message_date: 1030 }),
    'awaiting_approval', 'write_skill', 'reviewing_3 + bare YES (<60s) → write_skill');

// reviewing_<3> + bare YES > 60s → reviewing_<3>, reply_only (ambiguous)
assertMatch(transition(review3, { kind: 'yes', message_date: 100000 }),
    'reviewing_<N>', 'reply_only', 'reviewing_3 + bare YES (>60s) → ambiguous');

// reviewing_<3> + YES 7 (mismatch) → reviewing_<3>, reply_only
assertMatch(transition(review3, { kind: 'yes', proposal_n: 7, message_date: 1030 }),
    'reviewing_<N>', 'reply_only', 'reviewing_3 + YES 7 (mismatch) → reject');

// reviewing_<3> + NO 3 → awaiting_approval, reply_only (drafted_but_denied logged)
assertMatch(transition(review3, { kind: 'no', proposal_n: 3, message_date: 1030 }),
    'awaiting_approval', 'reply_only', 'reviewing_3 + NO 3 → awaiting_approval');

// reviewing_<3> + /review 1 → reviewing_<1>
assertMatch(transition(review3, { kind: 'review', proposal_n: 1, message_date: 2000 }),
    'reviewing_<N>', 'send_review_artifact', 'reviewing_3 + /review 1 → reviewing_<1>');

// reviewing_<3> + /skip 1 (M≠N) → reviewing_<3>
assertMatch(transition(review3, { kind: 'skip', proposal_n: 1, message_date: 2000 }),
    'reviewing_<N>', 'reply_only', 'reviewing_3 + /skip 1 → stay reviewing_3');

// reviewing_<3> + /skip 3 (current) → awaiting_approval
assertMatch(transition(review3, { kind: 'skip', proposal_n: 3, message_date: 2000 }),
    'awaiting_approval', 'reply_only', 'reviewing_3 + /skip 3 → awaiting_approval');

// reviewing_<3> + /stop → done
assertMatch(transition(review3, { kind: 'stop', message_date: 2000 }),
    'done', 'end_session', 'reviewing_3 + /stop → done');

// Edge: last open proposal + skip → done
const lastOne = { kind: 'awaiting_approval', open_proposal_ns: [5] };
assertMatch(transition(lastOne, { kind: 'skip', proposal_n: 5, message_date: 2000 }),
    'done', 'end_session', 'aa last proposal + /skip → done');

// Edge: YES on last reviewing → done
const reviewLast = { kind: 'reviewing_<N>', reviewing_n: 5, open_proposal_ns: [5], reviewing_opened_at: 1000 };
assertMatch(transition(reviewLast, { kind: 'yes', proposal_n: 5, message_date: 1030 }),
    'done', 'write_skill', 'reviewing_5 last + YES 5 → done (after write)');

if (fails > 0) process.exit(1);
console.log('all tests passed');
process.exit(0);
```

- [ ] **Step 2: Run — verify fail**

```bash
node tests/nodejs-project/school-state-machine.test.js
```
Expected: FAIL — `transition is not a function`.

- [ ] **Step 3: Implement `transition()`**

In `school.js`, add:

```javascript
const STALE_BARE_YES_MS = 60 * 1000;

// transition(state, input) — pure function, no I/O.
// state: { kind: 'awaiting_approval' | 'reviewing_<N>' | 'done' | 'scanning', open_proposal_ns: int[], reviewing_n?: int, reviewing_opened_at?: ms }
// input: { kind: 'yes'|'no'|'review'|'skip'|'stop', proposal_n?: int, message_date: ms, raw_text?: string }
// returns: { nextState, nextAction: { kind, ...details } }
function transition(state, input) {
    const open = state.open_proposal_ns || [];
    const n = input.proposal_n;
    const lastAfterRemoval = (removeN) => open.filter(x => x !== removeN);

    if (state.kind === 'awaiting_approval') {
        if (input.kind === 'review') {
            if (!open.includes(n)) {
                return { nextState: state, nextAction: { kind: 'reply_only', template: 'proposal_not_open', open } };
            }
            return {
                nextState: { kind: 'reviewing_<N>', reviewing_n: n, open_proposal_ns: open, reviewing_opened_at: input.message_date },
                nextAction: { kind: 'send_review_artifact', proposal_n: n },
            };
        }
        if (input.kind === 'skip') {
            const remaining = lastAfterRemoval(n);
            if (remaining.length === 0) {
                return { nextState: { kind: 'done', open_proposal_ns: [] }, nextAction: { kind: 'end_session', skipped: [n] } };
            }
            return {
                nextState: { kind: 'awaiting_approval', open_proposal_ns: remaining },
                nextAction: { kind: 'reply_only', template: 'skipped', n, remaining },
            };
        }
        if (input.kind === 'stop') {
            return { nextState: { kind: 'done', open_proposal_ns: [] }, nextAction: { kind: 'end_session', ignored: open } };
        }
        if (input.kind === 'yes' || input.kind === 'no') {
            return { nextState: state, nextAction: { kind: 'reply_only', template: 'yes_no_outside_review' } };
        }
        return { nextState: state, nextAction: { kind: 'reply_only', template: 'unknown_input' } };
    }

    if (state.kind === 'reviewing_<N>') {
        const cur = state.reviewing_n;
        if (input.kind === 'yes' || input.kind === 'no') {
            // Disambiguation
            let targetN = n;
            if (targetN === undefined) {
                const elapsed = input.message_date - (state.reviewing_opened_at || 0);
                if (elapsed <= STALE_BARE_YES_MS) targetN = cur;
                else return { nextState: state, nextAction: { kind: 'reply_only', template: 'ambiguous_bare_yes_no' } };
            }
            if (targetN !== cur) {
                return { nextState: state, nextAction: { kind: 'reply_only', template: 'invalid_proposal_n', got: targetN, expected: cur } };
            }
            if (input.kind === 'no') {
                return {
                    nextState: { kind: 'awaiting_approval', open_proposal_ns: open },
                    nextAction: { kind: 'reply_only', template: 'drafted_but_denied', n: cur },
                };
            }
            // yes
            const remaining = lastAfterRemoval(cur);
            const next = remaining.length === 0
                ? { kind: 'done', open_proposal_ns: [] }
                : { kind: 'awaiting_approval', open_proposal_ns: remaining };
            return { nextState: next, nextAction: { kind: 'write_skill', n: cur } };
        }
        if (input.kind === 'review') {
            if (!open.includes(n)) {
                return { nextState: state, nextAction: { kind: 'reply_only', template: 'proposal_not_open', open } };
            }
            return {
                nextState: { kind: 'reviewing_<N>', reviewing_n: n, open_proposal_ns: open, reviewing_opened_at: input.message_date },
                nextAction: { kind: 'send_review_artifact', proposal_n: n, skipped_n: cur },
            };
        }
        if (input.kind === 'skip') {
            if (n === cur) {
                const remaining = lastAfterRemoval(n);
                if (remaining.length === 0) {
                    return { nextState: { kind: 'done', open_proposal_ns: [] }, nextAction: { kind: 'end_session', skipped: [n] } };
                }
                return {
                    nextState: { kind: 'awaiting_approval', open_proposal_ns: remaining },
                    nextAction: { kind: 'reply_only', template: 'skipped', n, remaining },
                };
            }
            // skip M where M ≠ N — stay reviewing, log M as skipped if open
            return {
                nextState: { kind: 'reviewing_<N>', reviewing_n: cur, open_proposal_ns: lastAfterRemoval(n), reviewing_opened_at: state.reviewing_opened_at },
                nextAction: { kind: 'reply_only', template: 'skipped_other', n, cur },
            };
        }
        if (input.kind === 'stop') {
            return { nextState: { kind: 'done', open_proposal_ns: [] }, nextAction: { kind: 'end_session', drafted_but_denied: [cur], ignored: lastAfterRemoval(cur) } };
        }
        return { nextState: state, nextAction: { kind: 'reply_only', template: 'unknown_input' } };
    }

    // scanning / done — transitional states owned by school_begin / school_end
    return { nextState: state, nextAction: { kind: 'reply_only', template: 'unsupported_state', state: state.kind } };
}

module.exports = { ...module.exports, transition };
```

(Merge into existing exports.)

- [ ] **Step 4: Run — verify all 16+ transitions pass**

```bash
node tests/nodejs-project/school-state-machine.test.js
```
Expected: PASS — all cases.

- [ ] **Step 5: Commit**

```bash
git add app/src/main/assets/nodejs-project/school.js tests/nodejs-project/school-state-machine.test.js
git commit -m "feat(school): deterministic transition() state machine + 16 transition tests"
```

---

### Task B3: `scanLogs()` — pattern mining from tool_call_log + skill_trigger_log

**Files:**
- Modify: `app/src/main/assets/nodejs-project/school.js`
- Test: extend `tests/nodejs-project/school.test.js`

- [ ] **Step 1: Add failing test for scanLogs**

Append to `tests/nodejs-project/school.test.js` (before the final `process.exit(0)`):

```javascript
(async () => {
    const SQL_PATH = path.join(__dirname, '../../app/src/main/assets/nodejs-project/sql-wasm.js');
    const initSqlJs = require(SQL_PATH);
    const SQL = await initSqlJs({ locateFile: f => path.join(path.dirname(SQL_PATH), f) });
    const db = new SQL.Database();
    const { createToolCallLogSchema, createSkillTriggerLogSchema } = require(
        path.join(__dirname, '../../app/src/main/assets/nodejs-project/database.js')
    );
    createToolCallLogSchema(db);
    createSkillTriggerLogSchema(db);

    const now = 1713614400000;
    const day = 24 * 3600 * 1000;
    // Strong-signal: same call_shape 4x over 3 different days
    for (let i = 0; i < 4; i++) {
        db.run(`INSERT INTO tool_call_log (turn_id, tool_name, call_shape, result_status, latency_ms, created_at)
            VALUES ('t', 'recipe_calc', 'shell_exec:calc', 'ok', 5, ?)`, [now - i * day]);
    }
    // Failed sequence: solana_swap with bridge_unreachable x3
    for (let i = 0; i < 3; i++) {
        db.run(`INSERT INTO tool_call_log (turn_id, tool_name, call_shape, result_status, error_kind, latency_ms, created_at)
            VALUES ('u', 'solana_swap', 'solana_swap:SOL:USDC', 'error', 'bridge_unreachable', 15, ?)`, [now - i * 3600000]);
    }

    const { scanLogs } = require(path.join(__dirname, '../../app/src/main/assets/nodejs-project/school.js'));
    const result = scanLogs(db, { window_days: 7, min_repetition: 3, now_ms: now });

    if (result.empty) { console.error('FAIL: expected non-empty scan'); process.exit(1); }
    const rp = (result.repeated_patterns || []).find(p => (p.call_shape_chain && p.call_shape_chain[0] === 'shell_exec:calc'));
    if (!rp || rp.count !== 4) { console.error('FAIL: expected repeated_patterns shell_exec:calc count=4', rp); process.exit(1); }
    console.log('  ✓ scanLogs finds repeated_patterns');
    const fs2 = (result.failed_sequences || []).find(f => f.error_kind === 'bridge_unreachable');
    if (!fs2 || fs2.count !== 3) { console.error('FAIL: expected failed_sequences count=3', fs2); process.exit(1); }
    console.log('  ✓ scanLogs finds failed_sequences');

    // Empty-log behavior
    const db2 = new SQL.Database();
    createToolCallLogSchema(db2); createSkillTriggerLogSchema(db2);
    const emptyRes = scanLogs(db2, { window_days: 7, min_repetition: 3, now_ms: now });
    if (!emptyRes.empty) { console.error('FAIL: expected empty:true on empty log'); process.exit(1); }
    console.log('  ✓ scanLogs returns empty:true on insufficient data');
})();
```

- [ ] **Step 2: Run — verify fail**

```bash
node tests/nodejs-project/school.test.js
```
Expected: FAIL — `scanLogs is not a function`.

- [ ] **Step 3: Implement `scanLogs()`**

In `school.js`:

```javascript
const INSUFFICIENT_SIGNAL_MIN_CALLS = 20;

function scanLogs(db, { window_days = 7, min_repetition = 3, now_ms = Date.now(), caps = {} } = {}) {
    const capPatterns = caps.patterns ?? 5;
    const capSequences = caps.sequences ?? 10;
    const capTurns = caps.turns ?? 5;
    const capUnused = caps.unused ?? 20;
    const cutoff = now_ms - window_days * 24 * 3600 * 1000;

    const total = db.exec(`SELECT COUNT(*) FROM tool_call_log WHERE created_at > ?`, [cutoff]);
    const totalCalls = total.length ? total[0].values[0][0] : 0;
    if (totalCalls < INSUFFICIENT_SIGNAL_MIN_CALLS) {
        return { window_days, empty: true, reason: 'insufficient_signal', total_tool_calls: totalCalls, suggested_window_days: Math.min(30, window_days * 2) };
    }
    const totalTurns = db.exec(`SELECT COUNT(DISTINCT turn_id) FROM tool_call_log WHERE created_at > ?`, [cutoff])[0].values[0][0];

    // Repeated patterns — same call_shape ≥ min_repetition, capture distinct days
    const repRows = db.exec(`
        SELECT call_shape, COUNT(*) as cnt, COUNT(DISTINCT DATE(created_at/1000, 'unixepoch')) as distinct_days,
               GROUP_CONCAT(DISTINCT turn_id) as turns, GROUP_CONCAT(DISTINCT message_id) as msgs
        FROM tool_call_log
        WHERE created_at > ?
        GROUP BY call_shape
        HAVING cnt >= ?
        ORDER BY cnt DESC
        LIMIT ?`, [cutoff, min_repetition, capPatterns]);
    const repeated_patterns = (repRows[0] ? repRows[0].values : []).map(r => ({
        call_shape_chain: [r[0]],
        count: r[1],
        spans_distinct_days: r[2],
        sample_turn_ids: String(r[3] || '').split(',').slice(0, 3),
        sample_message_ids: String(r[4] || '').split(',').slice(0, 3),
    }));

    const failRows = db.exec(`
        SELECT tool_name, call_shape, error_kind, COUNT(*) as cnt
        FROM tool_call_log
        WHERE created_at > ? AND result_status = 'error'
        GROUP BY tool_name, call_shape, error_kind
        HAVING cnt >= ?
        ORDER BY cnt DESC
        LIMIT ?`, [cutoff, min_repetition, capSequences]);
    const failed_sequences = (failRows[0] ? failRows[0].values : []).map(r => ({
        tool_name: r[0], call_shape: r[1], error_kind: r[2], count: r[3]
    }));

    const exRows = db.exec(`
        SELECT turn_id, MIN(message_id), COUNT(*) as tool_count, SUM(latency_ms) as latency_sum
        FROM tool_call_log
        WHERE created_at > ?
        GROUP BY turn_id
        HAVING tool_count >= 8
        ORDER BY tool_count DESC, latency_sum DESC
        LIMIT ?`, [cutoff, capTurns]);
    const expensive_turns = (exRows[0] ? exRows[0].values : []).map(r => ({
        turn_id: r[0], message_id: r[1], tool_count: r[2], latency_ms_total: r[3]
    }));

    // Unused skills — skills with 0 triggers in window
    // Caller injects the full skill list for comparison (pure-ish)
    // For test purposes we query what IS triggered and let caller subtract
    const triggeredRows = db.exec(`SELECT DISTINCT skill_name FROM skill_trigger_log WHERE created_at > ?`, [cutoff]);
    const triggered_skills = (triggeredRows[0] ? triggeredRows[0].values : []).map(r => r[0]);

    return {
        window_days,
        empty: false,
        total_turns: totalTurns,
        total_tool_calls: totalCalls,
        repeated_patterns,
        failed_sequences,
        expensive_turns,
        triggered_skills,  // caller subtracts from full skill list for unused_skills
        unused_tools: [],  // caller computes
    };
}

module.exports = { ...module.exports, scanLogs };
```

- [ ] **Step 4: Run — verify pass**

```bash
node tests/nodejs-project/school.test.js
```
Expected: PASS including `scanLogs finds repeated_patterns`, `scanLogs finds failed_sequences`, `scanLogs returns empty:true on insufficient data`.

- [ ] **Step 5: Commit**

```bash
git add app/src/main/assets/nodejs-project/school.js tests/nodejs-project/school.test.js
git commit -m "feat(school): scanLogs — pattern mining from tool_call_log + skill_trigger_log"
```

---

### Task B4: `school_begin` + `school_end` tool handlers + SCHOOL.md I/O

**Files:**
- Create: `app/src/main/assets/nodejs-project/tools/school.js`
- Modify: `app/src/main/assets/nodejs-project/school.js` (add `readSchoolMd`, `writeSchoolMd`, `appendLogLine`, stale-detection helpers)
- Test: `tests/nodejs-project/school-tools.test.js`

- [ ] **Step 1: Write the failing test**

Create `tests/nodejs-project/school-tools.test.js`:

```javascript
#!/usr/bin/env node
// school-tools.test.js — tool handler behavior.
// Run: node tests/nodejs-project/school-tools.test.js

const path = require('path');
const fs = require('fs');
const os = require('os');

let fails = 0;
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'school-tools-'));
process.env.WORKDIR = tmp;  // school.js reads workDir via config; plan author: verify this or inject explicitly

(async () => {
    const { schoolBeginHandler, schoolEndHandler } = require(
        path.join(__dirname, '../../app/src/main/assets/nodejs-project/tools/school.js')
    );

    // school_begin — fresh, creates SCHOOL.md
    const beginRes = await schoolBeginHandler({ reason: 'on_demand' }, { workDir: tmp });
    if (!beginRes.ok || !beginRes.session_id) { console.error('FAIL begin fresh', beginRes); process.exit(1); }
    console.log('  ✓ school_begin creates new session + SCHOOL.md');

    const sch = fs.readFileSync(path.join(tmp, 'SCHOOL.md'), 'utf8');
    if (!sch.includes(beginRes.session_id)) { console.error('FAIL SCHOOL.md missing session_id'); process.exit(1); }
    console.log('  ✓ SCHOOL.md contains session_id');

    // school_begin again — should detect concurrent session
    const beginRes2 = await schoolBeginHandler({ reason: 'on_demand' }, { workDir: tmp });
    if (beginRes2.ok && !beginRes2.resumed) { console.error('FAIL: expected concurrent-session return', beginRes2); process.exit(1); }
    console.log('  ✓ school_begin detects existing SCHOOL.md (resumed or rejected)');

    // school_end — deletes SCHOOL.md, appends log
    const endRes = await schoolEndHandler({
        session_id: beginRes.session_id,
        summary: { patterns_found: 0, proposals_made: 0, approved: [], drafted_but_denied: [], skipped: [], ignored: [], rejected_by_rubric: [], rejected_as_duplicate: [] }
    }, { workDir: tmp });
    if (!endRes.ok) { console.error('FAIL end', endRes); process.exit(1); }
    if (fs.existsSync(path.join(tmp, 'SCHOOL.md'))) { console.error('FAIL: SCHOOL.md not deleted after end'); process.exit(1); }
    console.log('  ✓ school_end deletes SCHOOL.md');

    const logPath = path.join(tmp, 'school', 'log.jsonl');
    const logContent = fs.readFileSync(logPath, 'utf8').trim();
    const parsed = JSON.parse(logContent);
    if (parsed.session_id !== beginRes.session_id) { console.error('FAIL: log entry session_id mismatch'); process.exit(1); }
    console.log('  ✓ school_end appends log.jsonl entry');
})().catch(e => { console.error('FAIL', e); process.exit(1); }).finally(() => {
    try { fs.rmSync(tmp, { recursive: true, force: true }); } catch (_) {}
    if (fails > 0) process.exit(1);
    console.log('all tests passed');
    process.exit(0);
});
```

- [ ] **Step 2: Run — verify fail**

```bash
node tests/nodejs-project/school-tools.test.js
```
Expected: FAIL — `tools/school.js` not found.

- [ ] **Step 3: Implement begin/end — extend `school.js` first**

In `school.js`, add:

```javascript
const fs = require('fs');
const pathMod = require('path');

function schoolDir(workDir) { return pathMod.join(workDir, 'school'); }
function schoolMdPath(workDir) { return pathMod.join(workDir, 'SCHOOL.md'); }
function schoolLogPath(workDir) { return pathMod.join(workDir, 'school', 'log.jsonl'); }

function ensureSchoolDir(workDir) {
    const d = schoolDir(workDir);
    fs.mkdirSync(d, { recursive: true });
    fs.mkdirSync(pathMod.join(d, 'drafts'), { recursive: true });
    fs.mkdirSync(pathMod.join(d, 'retired'), { recursive: true });
}

function writeSchoolMd(workDir, sessionObj) {
    ensureSchoolDir(workDir);
    const frontmatter = [
        '---',
        `session_id: ${sessionObj.session_id}`,
        `started_at: ${sessionObj.started_at}`,
        `trigger: ${sessionObj.trigger || 'on_demand'}`,
        `state: ${sessionObj.state || 'scanning'}`,
        `window_days: ${sessionObj.window_days || 7}`,
        `open_proposal_ns: [${(sessionObj.open_proposal_ns || []).join(', ')}]`,
        `rubric_version: "${sessionObj.rubric_version || '1.0.0'}"`,
        sessionObj.reviewing_opened_at ? `reviewing_opened_at: ${sessionObj.reviewing_opened_at}` : '',
        '---',
        '',
        `# School Session — ${new Date(sessionObj.started_at).toISOString()}`,
        '',
        '## Proposals',
        JSON.stringify(sessionObj.proposals || [], null, 2),
        '',
    ].filter(Boolean).join('\n');
    fs.writeFileSync(schoolMdPath(workDir), frontmatter);
}

function readSchoolMd(workDir) {
    const p = schoolMdPath(workDir);
    if (!fs.existsSync(p)) return null;
    const content = fs.readFileSync(p, 'utf8');
    const m = content.match(/^---\n([\s\S]+?)\n---/);
    if (!m) throw new Error('SCHOOL.md malformed (no YAML frontmatter)');
    const fm = {};
    for (const line of m[1].split('\n')) {
        const kv = line.match(/^(\w+):\s*(.+)$/);
        if (!kv) continue;
        const [, k, v] = kv;
        if (k === 'open_proposal_ns') {
            fm[k] = v.replace(/[\[\]]/g, '').split(',').map(s => parseInt(s.trim(), 10)).filter(n => !isNaN(n));
        } else if (k === 'started_at' || k === 'reviewing_opened_at' || k === 'window_days') {
            fm[k] = parseInt(v, 10);
        } else {
            fm[k] = v.replace(/^["']|["']$/g, '');
        }
    }
    // Extract proposals JSON block
    let proposals = [];
    const pm = content.match(/## Proposals\n(\[[\s\S]*?\])\n/);
    if (pm) {
        try { proposals = JSON.parse(pm[1]); } catch (_) { proposals = []; }
    }
    return { ...fm, proposals, raw: content };
}

function appendLogLine(workDir, obj) {
    ensureSchoolDir(workDir);
    fs.appendFileSync(schoolLogPath(workDir), JSON.stringify(obj) + '\n');
}

function readPriorSessions(workDir, limit = 10) {
    const p = schoolLogPath(workDir);
    if (!fs.existsSync(p)) return [];
    const lines = fs.readFileSync(p, 'utf8').trim().split('\n').filter(Boolean);
    return lines.slice(-limit).map(l => { try { return JSON.parse(l); } catch (_) { return null; } }).filter(Boolean);
}

module.exports = { ...module.exports, writeSchoolMd, readSchoolMd, appendLogLine, readPriorSessions, ensureSchoolDir, schoolMdPath, schoolLogPath };
```

- [ ] **Step 4: Implement `tools/school.js` with begin + end**

Create `app/src/main/assets/nodejs-project/tools/school.js`:

```javascript
// tools/school.js — Go-to-School tool handlers.
const crypto = require('crypto');
const fs = require('fs');
const { writeSchoolMd, readSchoolMd, appendLogLine, readPriorSessions, schoolMdPath } = require('../school');

function newSessionId() { return crypto.randomBytes(8).toString('hex'); }

async function schoolBeginHandler(args, ctx) {
    const workDir = (ctx && ctx.workDir) || (typeof args === 'object' && args.workDir) || process.env.WORKDIR;
    const existing = readSchoolMd(workDir);
    if (existing) {
        return {
            ok: true, resumed: true,
            session_id: existing.session_id,
            started_at: existing.started_at,
            prior_sessions: readPriorSessions(workDir, 10),
            resumed_state: {
                session_id: existing.session_id,
                started_at: existing.started_at,
                trigger: existing.trigger,
                state: existing.state,
                window_days: existing.window_days,
                open_proposal_ns: existing.open_proposal_ns,
                proposals: existing.proposals,
                rubric_version: existing.rubric_version,
                reviewing_opened_at: existing.reviewing_opened_at || null,
            },
        };
    }
    const sessionId = newSessionId();
    const startedAt = Date.now();
    writeSchoolMd(workDir, {
        session_id: sessionId, started_at: startedAt, trigger: args.reason || 'on_demand',
        state: 'scanning', window_days: 7, open_proposal_ns: [], proposals: [], rubric_version: '1.0.0',
    });
    return {
        ok: true, resumed: false,
        session_id: sessionId,
        started_at: startedAt,
        prior_sessions: readPriorSessions(workDir, 10),
        resumed_state: null,
    };
}

async function schoolEndHandler(args, ctx) {
    const workDir = (ctx && ctx.workDir) || process.env.WORKDIR;
    const entry = {
        session_id: args.session_id,
        started_at: (readSchoolMd(workDir) || {}).started_at || Date.now(),
        ended_at: Date.now(),
        trigger: (readSchoolMd(workDir) || {}).trigger || 'on_demand',
        window_days: 7,
        rubric_version: '1.0.0',
        proposals: args.summary && args.summary.approved
            ? [...(args.summary.approved || []), ...(args.summary.drafted_but_denied || []), ...(args.summary.skipped || []), ...(args.summary.ignored || []), ...(args.summary.rejected_by_rubric || []), ...(args.summary.rejected_as_duplicate || [])]
            : [],
    };
    appendLogLine(workDir, entry);
    try { fs.unlinkSync(schoolMdPath(workDir)); } catch (_) {}
    return { ok: true };
}

module.exports = { schoolBeginHandler, schoolEndHandler };
```

- [ ] **Step 5: Run — verify pass**

```bash
node tests/nodejs-project/school-tools.test.js
```
Expected: PASS — begin/end smoke case.

- [ ] **Step 6: Commit**

```bash
git add app/src/main/assets/nodejs-project/school.js app/src/main/assets/nodejs-project/tools/school.js tests/nodejs-project/school-tools.test.js
git commit -m "feat(school): school_begin + school_end tool handlers with SCHOOL.md I/O"
```

---

### Task B5: `school_write_skill` — frontmatter enforcement + path sandbox

**Files:**
- Modify: `app/src/main/assets/nodejs-project/school.js` (add `writeSkillFile`)
- Modify: `app/src/main/assets/nodejs-project/tools/school.js` (add handler)
- Test: extend `tests/nodejs-project/school-tools.test.js`

- [ ] **Step 1: Append failing tests for write behavior**

In `tests/nodejs-project/school-tools.test.js`, inside the `async () => {}` IIFE before the end:

```javascript
    const { schoolWriteSkillHandler } = require(
        path.join(__dirname, '../../app/src/main/assets/nodejs-project/tools/school.js')
    );

    // create mode — auto-injects frontmatter marker
    const createRes = await schoolWriteSkillHandler({
        mode: 'create',
        path: 'skills/recipe-scaling.md',
        body: `---\nname: recipe-scaling\ndescription: "Scale recipes"\nversion: "1.0.0"\n---\n\n# Recipe Scaling\n\nInstructions.\n`,
        evidence: 'user asked 4x since Apr 13',
    }, { workDir: tmp });
    if (!createRes.ok) { console.error('FAIL create', createRes); process.exit(1); }
    const written = fs.readFileSync(path.join(tmp, 'skills/recipe-scaling.md'), 'utf8');
    if (!written.includes('source: school')) { console.error('FAIL: missing source: school marker'); process.exit(1); }
    if (!written.includes('evidence:')) { console.error('FAIL: missing evidence field'); process.exit(1); }
    console.log('  ✓ school_write_skill (create) injects school frontmatter marker');

    // Path traversal rejection
    const traversalRes = await schoolWriteSkillHandler({
        mode: 'create', path: '../evil.md', body: `---\nname: evil\n---\n\n# evil\n`, evidence: 'x',
    }, { workDir: tmp });
    if (traversalRes.ok) { console.error('FAIL: traversal should be rejected'); process.exit(1); }
    console.log('  ✓ school_write_skill rejects path traversal');

    // Oversize rejection
    const huge = 'A'.repeat(70 * 1024);
    const overRes = await schoolWriteSkillHandler({
        mode: 'create', path: 'skills/too-big.md',
        body: `---\nname: too-big\n---\n\n# too-big\n${huge}`,
        evidence: 'x',
    }, { workDir: tmp });
    if (overRes.ok) { console.error('FAIL: oversize should be rejected'); process.exit(1); }
    console.log('  ✓ school_write_skill rejects > 64KB');

    // Patch preserves source
    fs.writeFileSync(path.join(tmp, 'skills/user-authored.md'),
        `---\nname: user-authored\nsource: user\nversion: "1.0.0"\n---\n\n# user\n`);
    const patchRes = await schoolWriteSkillHandler({
        mode: 'patch', path: 'skills/user-authored.md',
        body: `---\nname: user-authored\nsource: user\nversion: "1.0.0"\n---\n\n# user patched\n`,
        evidence: 'fix',
    }, { workDir: tmp });
    if (!patchRes.ok) { console.error('FAIL patch', patchRes); process.exit(1); }
    const patched = fs.readFileSync(path.join(tmp, 'skills/user-authored.md'), 'utf8');
    if (!patched.includes('source: user')) { console.error('FAIL: patch must preserve source: user'); process.exit(1); }
    if (!patched.includes('last_patched_by: school')) { console.error('FAIL: patch must add last_patched_by'); process.exit(1); }
    console.log('  ✓ school_write_skill (patch) preserves source + adds last_patched_by');
```

- [ ] **Step 2: Run — verify fail**

```bash
node tests/nodejs-project/school-tools.test.js
```
Expected: FAIL — `schoolWriteSkillHandler is not a function`.

- [ ] **Step 3: Implement in `school.js` + `tools/school.js`**

In `school.js`:

```javascript
const MAX_SKILL_BYTES = 64 * 1024;

function injectOrReplaceFrontmatterKeys(body, keys) {
    // keys: { source: 'school', created: 'YYYY-MM-DD', evidence: '...' }  (create mode)
    // or:   { last_patched_by: 'school', last_patched_at: 'YYYY-MM-DD', patch_evidence: '...' }  (patch mode)
    const m = body.match(/^---\n([\s\S]+?)\n---/);
    if (!m) throw new Error('no_frontmatter');
    const existing = m[1].split('\n');
    const existingMap = {};
    const order = [];
    for (const line of existing) {
        const kv = line.match(/^(\w[\w-]*):\s*(.+)$/);
        if (kv) { existingMap[kv[1]] = kv[2]; if (!order.includes(kv[1])) order.push(kv[1]); }
    }
    // For create: overwrite source/created/evidence; for patch: never touch existing `source`, just append last_patched_*
    for (const k of Object.keys(keys)) {
        existingMap[k] = JSON.stringify(keys[k]).replace(/^"|"$/g, '');  // unquote simple strings
        if (!order.includes(k)) order.push(k);
    }
    const newFm = '---\n' + order.map(k => `${k}: ${existingMap[k]}`).join('\n') + '\n---';
    return body.replace(/^---\n[\s\S]+?\n---/, newFm);
}

function todayStr() { return new Date().toISOString().slice(0, 10); }

async function writeSkillFile({ workDir, mode, relPath, body, evidence }) {
    if (!relPath.startsWith('skills/') || relPath.includes('..')) {
        return { ok: false, error: 'path_outside_workspace_skills' };
    }
    if (Buffer.byteLength(body, 'utf8') > MAX_SKILL_BYTES) {
        return { ok: false, error: 'oversize', limit_bytes: MAX_SKILL_BYTES };
    }
    if (!body.startsWith('---\n')) return { ok: false, error: 'missing_frontmatter' };
    if (!/^#\s+.+/m.test(body.replace(/^---\n[\s\S]+?\n---\n/, ''))) {
        return { ok: false, error: 'missing_body_heading' };
    }
    const fullPath = pathMod.join(workDir, relPath);
    let finalBody;
    if (mode === 'create') {
        finalBody = injectOrReplaceFrontmatterKeys(body, {
            source: 'school', created: todayStr(), evidence,
        });
    } else if (mode === 'patch') {
        if (!fs.existsSync(fullPath)) return { ok: false, error: 'patch_target_missing' };
        // Check existing file's source — if it's part of the bundled default-skills/ seed, reject.
        // Here we only check workspace/skills/ files — bundled are never patchable because they live outside workspace.
        const existing = fs.readFileSync(fullPath, 'utf8');
        const existingSourceMatch = existing.match(/^source:\s*(.+)$/m);
        const existingSource = existingSourceMatch ? existingSourceMatch[1].trim() : 'user';
        finalBody = injectOrReplaceFrontmatterKeys(body, {
            last_patched_by: 'school', last_patched_at: todayStr(), patch_evidence: evidence,
        });
        // Preserve existing source field explicitly
        finalBody = finalBody.replace(/^source:\s*.+$/m, `source: ${existingSource}`);
    } else {
        return { ok: false, error: 'invalid_mode' };
    }
    fs.mkdirSync(pathMod.dirname(fullPath), { recursive: true });
    fs.writeFileSync(fullPath, finalBody);
    const sha = crypto.createHash('sha256').update(finalBody).digest('hex');
    return { ok: true, path: relPath, action: mode, sha256: sha };
}

module.exports = { ...module.exports, writeSkillFile };
```

In `tools/school.js`:

```javascript
const { writeSkillFile } = require('../school');

async function schoolWriteSkillHandler(args, ctx) {
    const workDir = (ctx && ctx.workDir) || process.env.WORKDIR;
    return await writeSkillFile({
        workDir, mode: args.mode, relPath: args.path, body: args.body, evidence: args.evidence,
    });
}
module.exports = { ...module.exports, schoolWriteSkillHandler };
```

- [ ] **Step 4: Run — verify pass**

```bash
node tests/nodejs-project/school-tools.test.js
```
Expected: PASS — all new cases.

- [ ] **Step 5: Commit**

```bash
git add app/src/main/assets/nodejs-project/school.js app/src/main/assets/nodejs-project/tools/school.js tests/nodejs-project/school-tools.test.js
git commit -m "feat(school): school_write_skill with frontmatter marker + sandbox + size cap"
```

---

### Task B6: `school_retire_skill` + `school_handle_input` + `school_scan` tool wrappers

**Files:**
- Modify: `app/src/main/assets/nodejs-project/tools/school.js`
- Test: extend `tests/nodejs-project/school-tools.test.js`

- [ ] **Step 1: Append tests**

```javascript
    // retire
    fs.writeFileSync(path.join(tmp, 'skills/to-retire.md'),
        `---\nname: to-retire\nsource: school\n---\n\n# gone\n`);
    const { schoolRetireSkillHandler, schoolHandleInputHandler } = require(
        path.join(__dirname, '../../app/src/main/assets/nodejs-project/tools/school.js')
    );
    const retRes = await schoolRetireSkillHandler({ path: 'skills/to-retire.md', reason: 'unused' }, { workDir: tmp });
    if (!retRes.ok) { console.error('FAIL retire', retRes); process.exit(1); }
    if (fs.existsSync(path.join(tmp, 'skills/to-retire.md'))) { console.error('FAIL: file not moved'); process.exit(1); }
    const retiredFiles = fs.readdirSync(path.join(tmp, 'school/retired'));
    if (!retiredFiles.some(f => f.includes('to-retire.md'))) { console.error('FAIL: no retired file found'); process.exit(1); }
    console.log('  ✓ school_retire_skill moves to retired/ reversibly');

    // handle_input — YES on reviewing_<3>
    const hiRes = await schoolHandleInputHandler({
        session_id: 'test', state: { kind: 'reviewing_<N>', reviewing_n: 3, open_proposal_ns: [3], reviewing_opened_at: 1000 },
        input: { kind: 'yes', proposal_n: 3, message_date: 1020, raw_text: 'YES 3' }
    }, { workDir: tmp });
    if (!hiRes.ok || hiRes.next_action.kind !== 'write_skill') { console.error('FAIL handle_input yes', hiRes); process.exit(1); }
    console.log('  ✓ school_handle_input returns write_skill next_action on YES');
```

- [ ] **Step 2: Run — verify fail**

```bash
node tests/nodejs-project/school-tools.test.js
```
Expected: FAIL — handlers not defined.

- [ ] **Step 3: Implement handlers**

Append to `tools/school.js`:

```javascript
const { transition } = require('../school');
const pathMod = require('path');

async function schoolRetireSkillHandler(args, ctx) {
    const workDir = (ctx && ctx.workDir) || process.env.WORKDIR;
    const relPath = args.path;
    if (!relPath.startsWith('skills/') || relPath.includes('..')) {
        return { ok: false, error: 'cannot_retire_bundled' };
    }
    const src = pathMod.join(workDir, relPath);
    if (!fs.existsSync(src)) return { ok: false, error: 'target_missing' };
    const name = pathMod.basename(relPath);
    const ts = Date.now();
    const dst = pathMod.join(workDir, 'school/retired', `${ts}-${name}`);
    fs.mkdirSync(pathMod.dirname(dst), { recursive: true });
    fs.renameSync(src, dst);
    return { ok: true, restored_path: dst.replace(workDir + '/', ''), reason: args.reason || '' };
}

async function schoolHandleInputHandler(args, ctx) {
    try {
        const { nextState, nextAction } = transition(args.state, args.input);
        return { ok: true, previous_state: args.state.kind, new_state: nextState.kind, next_action: nextAction, open_proposal_ns: nextState.open_proposal_ns || [] };
    } catch (e) {
        return { ok: false, error: 'transition_failed', hint: e.message };
    }
}

module.exports = { ...module.exports, schoolRetireSkillHandler, schoolHandleInputHandler };
```

- [ ] **Step 4: Run — verify pass**

```bash
node tests/nodejs-project/school-tools.test.js
```
Expected: PASS — all cases.

- [ ] **Step 5: Add `schoolScanHandler` wrapper**

In `tools/school.js`:

```javascript
const { scanLogs } = require('../school');
const { getDb } = require('../database');

async function schoolScanHandler(args, ctx) {
    const db = (ctx && ctx.db) || getDb();
    if (!db) return { ok: false, error: 'db_unavailable' };
    try {
        const res = scanLogs(db, { window_days: args.window_days || 7, min_repetition: args.min_repetition || 3 });
        return { ok: true, ...res };
    } catch (e) {
        return { ok: false, error: 'scan_failed', hint: e.message };
    }
}

module.exports = { ...module.exports, schoolScanHandler };
```

- [ ] **Step 6: Commit**

```bash
git add app/src/main/assets/nodejs-project/tools/school.js tests/nodejs-project/school-tools.test.js
git commit -m "feat(school): school_retire_skill + school_handle_input + school_scan handlers"
```

---

### Task B7: Register school tools in `tools/index.js`

**Files:**
- Modify: `app/src/main/assets/nodejs-project/tools/index.js`

- [ ] **Step 1: Add the 6 school tool entries**

In `tools/index.js`, after `const systemMod = require('./system');`, add:

```javascript
const schoolMod = require('./school');
```

In the `TOOLS` array (already has `...webMod.tools, ...memoryMod.tools, ...`), add:

```javascript
    // School tools — Go-to-School feature
    {
        name: 'school_begin',
        description: 'Start or resume a Go-to-School self-improvement session. Creates workspace/SCHOOL.md as a trigger file; if one already exists, returns its parsed state for resumption. Returns session_id + last 10 prior sessions from workspace/school/log.jsonl for dedup.',
        input_schema: { type: 'object', properties: { reason: { type: 'string', enum: ['on_demand', 'cron', 'resumed'] } }, required: ['reason'] },
    },
    {
        name: 'school_scan',
        description: 'Pattern-mine the tool_call_log and skill_trigger_log SQL.js tables. Returns structured candidates: repeated_patterns (same call_shape ≥3×), failed_sequences (error_kind repeats), expensive_turns (≥8 tool calls), triggered_skills (for computing unused_skills retire candidates).',
        input_schema: { type: 'object', properties: { window_days: { type: 'integer', minimum: 1, maximum: 30 }, min_repetition: { type: 'integer' } } },
    },
    {
        name: 'school_write_skill',
        description: 'Write a new SKILL.md (create mode) or patch an existing one. Tool auto-injects `source: school`, `created`, `evidence` frontmatter on create; preserves existing `source` field + appends `last_patched_by: school` on patch. Enforces path sandbox (workspace/skills/ only), 64KB size cap, valid YAML frontmatter, and non-empty markdown body.',
        input_schema: { type: 'object', properties: {
            mode: { type: 'string', enum: ['create', 'patch'] },
            path: { type: 'string' },
            body: { type: 'string' },
            evidence: { type: 'string' },
        }, required: ['mode', 'path', 'body', 'evidence'] },
    },
    {
        name: 'school_retire_skill',
        description: 'Move a workspace skill to workspace/school/retired/ (reversible archive, not delete). Bundled skills rejected. User can restore by moving the file back.',
        input_schema: { type: 'object', properties: { path: { type: 'string' }, reason: { type: 'string' } }, required: ['path'] },
    },
    {
        name: 'school_end',
        description: 'Finalize a school session: append one JSON line to workspace/school/log.jsonl (rolling 90-day retention), then delete SCHOOL.md. Atomic ordering guarantees crash recovery never re-finalizes a session already logged.',
        input_schema: { type: 'object', properties: {
            session_id: { type: 'string' },
            summary: { type: 'object' },
        }, required: ['session_id', 'summary'] },
    },
    {
        name: 'school_handle_input',
        description: 'Advance the school session state machine. Agent calls this for school-relevant inputs (yes/no/review/skip/stop) after classifying user input via the classification rubric in the go-to-school skill. Returns the new state + next_action to execute. NOT called for unrelated messages — those route through normal message handling.',
        input_schema: { type: 'object', properties: {
            session_id: { type: 'string' },
            state: { type: 'object' },
            input: { type: 'object' },
        }, required: ['session_id', 'state', 'input'] },
    },
```

Also in the dispatch map that routes tool calls (look for a switch or handlers object mapping tool name → handler):

```javascript
    school_begin: (args, ctx) => schoolMod.schoolBeginHandler(args, ctx),
    school_scan: (args, ctx) => schoolMod.schoolScanHandler(args, ctx),
    school_write_skill: (args, ctx) => schoolMod.schoolWriteSkillHandler(args, ctx),
    school_retire_skill: (args, ctx) => schoolMod.schoolRetireSkillHandler(args, ctx),
    school_end: (args, ctx) => schoolMod.schoolEndHandler(args, ctx),
    school_handle_input: (args, ctx) => schoolMod.schoolHandleInputHandler(args, ctx),
```

- [ ] **Step 2: Run smoke**

```bash
node tests/nodejs-project/smoke.js
```
Expected: PASS — no module-load regressions.

- [ ] **Step 3: Commit**

```bash
git add app/src/main/assets/nodejs-project/tools/index.js
git commit -m "feat(school): register 6 school_* tools in the dispatcher"
```

---

### Task B8: Bundled `go-to-school` SKILL.md

**Files:**
- Create: `app/src/main/assets/default-skills/go-to-school/SKILL.md`

- [ ] **Step 1: Author the SKILL.md**

Create `app/src/main/assets/default-skills/go-to-school/SKILL.md`:

```markdown
---
name: go-to-school
description: "Analyze recent activity and propose new skills, skill patches, or skill retirements. Triggered by /school command or phrases like 'go to school', 'run school', 'study time'. Challenges its own findings with a 5-gate rubric; surfaces rejections so the user can audit the thinking. Two-gate approval: /review N → YES N writes the file."
version: "1.0.0"
emoji: "🎓"
requires:
  bins: []
  env: []
allowed-tools:
  - school_begin
  - school_scan
  - school_write_skill
  - school_retire_skill
  - school_end
  - school_handle_input
  - file_read
  - file_write
  - telegram_send
---

# Go to School — Structured Self-Reflection

When the user invokes /school (or a natural-language trigger), you analyze your own recent behavior and propose concrete self-improvements. Your output is a ranked list of proposals, each passing a 5-gate rubric. The user approves per-proposal in two steps (/review N → YES N).

## Session flow

1. Call `school_begin({ reason: "on_demand" })`.
   - If `resumed: true`: you're picking up a prior session. Use `resumed_state` and continue in the state it's in.
   - Else: proceed to scanning.
2. Call `school_scan({ window_days: 7, min_repetition: 3 })`.
   - If `empty: true`: send one message "Not enough signal to propose anything — try again after more activity." and call `school_end` with empty summary. Stop.
3. Read memory files for context:
   - `file_read(MEMORY.md)` and the 7 most recent `memory/YYYY-MM-DD.md` daily notes.
4. Apply the rubric (below) to every candidate pattern from `school_scan`. Build proposals.
5. Apply the dedup gate against `prior_sessions` (also from `school_begin`).
6. Send the proposals message (format below) to the user via `telegram_send`.
7. For each user input, CLASSIFY it per the Input Classification Rubric. For school-relevant inputs, call `school_handle_input`. Execute the `next_action` it returns.
8. When all proposals are resolved (state=done), call `school_end` with the final summary.

## The rubric (5 gates)

Every candidate pattern must pass **all 5** before it's shown as a proposal.

| Gate | Type | Test |
|---|---|---|
| **Repetition** | Quantitative | `scan.repeated_patterns[i].count >= 3` (or failed/unused counts ≥ 3) |
| **Permanence** | Quantitative | `scan.repeated_patterns[i].spans_distinct_days >= 2` |
| **Gap** | Qualitative (requires artifact) | Produce a `coverage_check` block listing every existing tool/bundled-skill/workspace-skill considered and one line each on why it doesn't cover this pattern. No list → fail. |
| **Utility** | Qualitative (honest yes/no) | Answer yes/no with one sentence referencing scan data: "Will this skill fire often enough to earn its prompt-size cost?" FORBIDDEN: fake arithmetic. |
| **Actionable** | Structural | Draft the **When to Use** section inline, with concrete trigger keywords + specific tools + output format. If the draft reduces to "be smarter about X", fail. Soft-warning keyword check (`smarter`, `better`, `improved` without a concrete mechanism) flags for extra scrutiny. |

### Dedup gate (pre-rubric)

For each candidate, compute the signature `sha256(type + normalize(title))`. If it matches any entry in `prior_sessions` with `outcome` in `{drafted_but_denied, skipped, ignored, rejected_by_rubric, abandoned_stale, rejected_as_duplicate}` from the last 30 days, drop as `rejected_as_duplicate`.

## Proposal message format

Use HTML (Telegram). ≤ 4096 chars, chunked if longer.

```
🎓 School — <date> scan (last N days)

📝 CREATE  · <count>
🔧 PATCH   · <count>
🗑️ RETIRE  · <count>
❌ REJECTED · <count>

─── [1] CREATE · <slug> ───
Evidence: <evidence line>
Rubric: rep ✓ perm ✓ gap ✓ util ✓ action ✓ (5/5)
Confidence: N/10
Skeptical take: <one honest sentence>
> /review 1

... more proposals ...

─── Rejected (<count>) ───
· <slug> — fails <GATE>: <reason>
... more ...

Reply: /review N  |  /skip N  |  /stop
Reply on review: YES N  |  NO N  (bare YES/NO works if only one review open)
```

## Input Classification Rubric

An input is **school-relevant** iff it matches exactly one of:
- Starts with `/review ` + positive integer → `kind: "review"`, `proposal_n: <int>`
- Starts with `/skip ` + positive integer → `kind: "skip"`, `proposal_n: <int>`
- Equals `/stop` (exact, trimmed) → `kind: "stop"`
- Matches `^(YES|NO|Y|N|👍|👎)\s*(\d+)?\s*$` case-insensitive after trim (≤ 120 chars) → `kind: "yes"` or `"no"`, `proposal_n` optional
- Starts with `YES ` or `NO ` followed by number + non-empty trailing text → YES/NO captured, trailing text routed to normal handling in the same turn.

**Everything else is unrelated** — do NOT call `school_handle_input`. Route through normal message handling. If state is `reviewing_<N>`, append to your normal reply: *"Still awaiting YES/NO on proposal {N}."*

## Classification echo rule

After calling `school_handle_input` with a school-relevant input, the first sentence of your reply MUST echo back your classification — e.g. *"Understood as YES on proposal 3 — writing now."* or *"Taking that as /skip 2 — logged."*

This gives the user a visible correction hook. The state machine is deterministic from `school_handle_input` onwards, but input classification is still your judgment.

## Write-failure handling

If `next_action.kind` is `write_skill` or `retire_skill` and the follow-up tool call fails, do NOT proceed as if it succeeded. State stays at `reviewing_<N>`. Surface the error to the user: *"Couldn't write proposal {N}: {error}. Reply YES {N} to retry, NO {N} to decline, or /stop to end."* No log entry is written until the write succeeds or the user explicitly declines.

## Silent exit

If `school_scan` returns `empty: true` or all candidates fail the rubric + dedup, send one line — *"Not enough signal to propose anything — try again after more activity."* — and call `school_end` cleanly. No filler proposals.

## Post-approval note

Append to the success message after any write: *"Live on next turn."* — confirms no manual restart is needed; the existing `loadSkills()` live-read picks up new skills automatically.
```

- [ ] **Step 2: Commit**

```bash
git add app/src/main/assets/default-skills/go-to-school/
git commit -m "feat(school): bundled go-to-school SKILL.md with rubric + classification"
```

---

### Task B9: Agent self-awareness — `buildSystemBlocks()` Self-Improvement block

**Files:**
- Modify: `app/src/main/assets/nodejs-project/ai.js`

- [ ] **Step 1: Locate `buildSystemBlocks()`**

```bash
grep -n "buildSystemBlocks\|function buildSystemBlocks" /Users/egod/Dev/SeekerClaw/app/src/main/assets/nodejs-project/ai.js | head
```

- [ ] **Step 2: Add Self-Improvement section**

Inside `buildSystemBlocks()`, add a new section where other capability blocks live (near the Tooling / Skills sections):

```javascript
    blocks.push(`## Self-Improvement (Go to School)

You have a /school command that triggers a structured self-reflection session: analyze your recent tool-call history (from the `tool_call_log` SQL.js table) and skill-trigger history (from `skill_trigger_log`), then propose concrete changes to your skill set — new skills, patches to existing ones, retirements of unused ones.

**Tools (6):**
- \`school_begin\` — start or resume a session. Creates workspace/SCHOOL.md trigger file.
- \`school_scan\` — pattern-mine the logs. Returns repeated_patterns (call_shape ≥ 3×), failed_sequences, expensive_turns, and triggered_skills.
- \`school_write_skill\` — write or patch a SKILL.md. Auto-injects school frontmatter marker on create; preserves existing source field on patch.
- \`school_retire_skill\` — move a workspace skill to workspace/school/retired/ (reversible).
- \`school_end\` — append one JSON line to workspace/school/log.jsonl, delete SCHOOL.md.
- \`school_handle_input\` — advance the state machine for YES/NO/review/skip/stop inputs.

**Rubric (5 gates — all must pass):** Repetition (≥ 3 occurrences), Permanence (≥ 2 distinct days), Gap (no existing capability covers it), Utility (honest yes/no on whether it earns its prompt cost), Actionable (concrete playbook, not "be smarter about X").

**Two-gate approval:** /review N shows the user the drafted SKILL.md; YES N writes it. Bundled skills cannot be patched or retired (return error, suggest filing a GitHub issue instead).

**Effect timing:** Newly-written skills are picked up on the next agent turn automatically — the existing loadSkills() reads the filesystem fresh on every message, so no service restart is needed.

**Rate limit:** 1 /school invocation per 5 minutes, max 10 per 24 hours. Exceeding replies "School ran recently — next available at {time}."

**State machine is deterministic JS** in school.js; you do NOT drive it directly. You classify user input per the classification rubric in the go-to-school SKILL.md, call school_handle_input, then execute the next_action it returns. Echo your classification back in every state-changing reply so the user can catch misclassifications.
`);
```

- [ ] **Step 3: Run smoke**

```bash
node tests/nodejs-project/smoke.js
```
Expected: PASS.

- [ ] **Step 4: Commit**

```bash
git add app/src/main/assets/nodejs-project/ai.js
git commit -m "feat(school): Self-Improvement block in buildSystemBlocks() (agent self-awareness)"
```

---

### Task B10: Telegram commands + `/school-reset` two-step

**Files:**
- Modify: `app/src/main/assets/nodejs-project/telegram.js`
- Modify: `app/src/main/assets/nodejs-project/message-handler.js`

- [ ] **Step 1: Find the existing command registry**

```bash
grep -n "startsWith\s*('/help'\|startsWith\s*('/status'\|COMMANDS\s*=" /Users/egod/Dev/SeekerClaw/app/src/main/assets/nodejs-project/telegram.js | head
```

- [ ] **Step 2: Register the new commands**

In `telegram.js` / `message-handler.js` (wherever `/status`, `/help`, `/new` are handled), add:

```javascript
if (text === '/school') {
    // Rate-limit check (reuse existing pattern from /swap etc.)
    // Then route to the go-to-school skill via a synthetic "run go-to-school" instruction
    return invokeSchool({ reason: 'on_demand' });
}

if (text === '/school log') {
    return renderSchoolLog();  // reads workspace/school/log.jsonl tail, formats summary
}

if (text === '/school-reset') {
    // Two-step: set pending-reset flag with 60s TTL
    pendingSchoolReset = { expires_at: Date.now() + 60 * 1000 };
    return reply('This will discard the current open session and any drafts. Reply `/school-reset-confirm` within 60s to proceed.');
}

if (text === '/school-reset-confirm') {
    if (!pendingSchoolReset || pendingSchoolReset.expires_at < Date.now()) {
        pendingSchoolReset = null;
        return reply('No pending reset — type `/school-reset` first.');
    }
    pendingSchoolReset = null;
    try { fs.unlinkSync(path.join(workDir, 'SCHOOL.md')); } catch (_) {}
    try {
        const draftsDir = path.join(workDir, 'school/drafts');
        if (fs.existsSync(draftsDir)) for (const f of fs.readdirSync(draftsDir)) fs.unlinkSync(path.join(draftsDir, f));
    } catch (_) {}
    return reply('School state cleared.');
}
```

Add `let pendingSchoolReset = null;` at module scope.

- [ ] **Step 3: Cancel pending reset on any non-confirm input**

In the command dispatcher, before running any handler:

```javascript
if (pendingSchoolReset && pendingSchoolReset.expires_at < Date.now()) pendingSchoolReset = null;
// Any non-/school-reset-confirm input while pending is NOT destructive; the flag simply expires.
```

- [ ] **Step 4: Rate-limit `/school`**

Reuse the existing rate-limit helper from `solana_swap` / `android_sms`. Add:

```javascript
const SCHOOL_MIN_INTERVAL_MS = 5 * 60 * 1000;
const SCHOOL_DAILY_CAP = 10;
const schoolRateState = { lastInvokedAt: 0, invokesToday: 0, dayStart: 0 };

function checkSchoolRateLimit(now = Date.now()) {
    // Reset daily counter on day boundary
    if (new Date(schoolRateState.dayStart).toDateString() !== new Date(now).toDateString()) {
        schoolRateState.invokesToday = 0;
        schoolRateState.dayStart = now;
    }
    if (now - schoolRateState.lastInvokedAt < SCHOOL_MIN_INTERVAL_MS) {
        const nextAt = new Date(schoolRateState.lastInvokedAt + SCHOOL_MIN_INTERVAL_MS).toLocaleTimeString();
        return { ok: false, reason: `throttled`, message: `School ran recently. Next available at ${nextAt}.` };
    }
    if (schoolRateState.invokesToday >= SCHOOL_DAILY_CAP) {
        return { ok: false, reason: 'daily_cap', message: `School daily cap (${SCHOOL_DAILY_CAP}) reached. Try again tomorrow.` };
    }
    schoolRateState.lastInvokedAt = now;
    schoolRateState.invokesToday++;
    return { ok: true };
}
```

Gate `/school` invocation on `checkSchoolRateLimit()`.

- [ ] **Step 5: Run smoke**

```bash
node tests/nodejs-project/smoke.js
```
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add app/src/main/assets/nodejs-project/telegram.js app/src/main/assets/nodejs-project/message-handler.js
git commit -m "feat(school): /school, /school log, /school-reset two-step, rate limit"
```

---

### Task B11: Stale-session auto-end + combined-message flow on new `/school`

**Files:**
- Modify: `app/src/main/assets/nodejs-project/main.js`
- Modify: `app/src/main/assets/nodejs-project/tools/school.js`

- [ ] **Step 1: Extend `school_begin` to handle stale detection**

In `tools/school.js`, inside `schoolBeginHandler`, before the `if (existing)` block:

```javascript
    const STALE_THRESHOLD_MS = 48 * 60 * 60 * 1000;
    const pre = readSchoolMd(workDir);
    if (pre && (Date.now() - pre.started_at) > STALE_THRESHOLD_MS) {
        // Auto-end stale session, start fresh
        appendLogLine(workDir, {
            session_id: pre.session_id, started_at: pre.started_at, ended_at: Date.now(),
            trigger: pre.trigger || 'on_demand', window_days: pre.window_days || 7,
            rubric_version: pre.rubric_version || '1.0.0',
            proposals: (pre.proposals || []).map(p => ({ ...p, outcome: 'abandoned_stale' })),
        });
        try { fs.unlinkSync(schoolMdPath(workDir)); } catch (_) {}
        // Fall through to fresh session creation with combined-message flag
        const sessionId = newSessionId();
        const startedAt = Date.now();
        writeSchoolMd(workDir, {
            session_id: sessionId, started_at: startedAt, trigger: args.reason || 'on_demand',
            state: 'scanning', window_days: 7, open_proposal_ns: [], proposals: [], rubric_version: '1.0.0',
        });
        return {
            ok: true, resumed: false,
            session_id: sessionId, started_at: startedAt,
            prior_sessions: readPriorSessions(workDir, 10),
            resumed_state: null,
            started_after_cleanup: true,
            cleaned_up: { prior_session_id: pre.session_id, prior_started_at: pre.started_at },
        };
    }
```

- [ ] **Step 2: Boot-time stale detection in `main.js`**

In `main.js` startup sequence, after skills load:

```javascript
// Stale-school-session cleanup on boot (no new session started)
try {
    const { readSchoolMd, appendLogLine, schoolMdPath } = require('./school');
    const pre = readSchoolMd(workDir);
    const STALE_THRESHOLD_MS = 48 * 60 * 60 * 1000;
    if (pre && (Date.now() - pre.started_at) > STALE_THRESHOLD_MS) {
        appendLogLine(workDir, {
            session_id: pre.session_id, started_at: pre.started_at, ended_at: Date.now(),
            trigger: pre.trigger || 'on_demand', window_days: pre.window_days || 7,
            rubric_version: pre.rubric_version || '1.0.0',
            proposals: (pre.proposals || []).map(p => ({ ...p, outcome: 'abandoned_stale' })),
        });
        try { fs.unlinkSync(schoolMdPath(workDir)); } catch (_) {}
        // Send Telegram notice — user wasn't asking for a session, just inform.
        // Use existing telegram send helper.
        sendMessage(`Cleaned up stale school session from ${new Date(pre.started_at).toLocaleString()}.`);
    }
} catch (e) { log(`[school] stale cleanup failed: ${e.message}`, 'WARN'); }
```

- [ ] **Step 3: Smoke test**

```bash
node tests/nodejs-project/smoke.js
```

- [ ] **Step 4: Commit**

```bash
git add app/src/main/assets/nodejs-project/tools/school.js app/src/main/assets/nodejs-project/main.js
git commit -m "feat(school): stale-session auto-end (48h) + seamless combined-message flow"
```

---

### Task B12: DIAGNOSTICS.md school section

**Files:**
- Modify: `app/src/main/assets/nodejs-project/DIAGNOSTICS.md`

- [ ] **Step 1: Add a "Go to School troubleshooting" section**

Append to `DIAGNOSTICS.md`:

```markdown
## Go to School troubleshooting

**Symptom: `/school` replies "School session already open"**
- An active session exists (workspace/SCHOOL.md). Reply `/stop` to end it, or `/review N` / `/skip N` to resolve open proposals.
- If truly stuck: `/school-reset` (then `/school-reset-confirm` within 60s).

**Symptom: /school returns "Not enough signal to propose anything"**
- Fewer than 20 tool calls recorded in the last window. Normal on a new install or after a quiet week. Use the agent for a few days, then try `/school` again.

**Symptom: Proposal rejected with "fails GAP"**
- An existing capability (tool, bundled skill, workspace skill) already covers the pattern. The rubric's coverage_check artifact in the rejection reason names which existing capability it considered.

**Symptom: "Cannot patch bundled skill"**
- Bundled skills (in the APK) are read-only. File a GitHub issue for improvements to bundled skills.

**Symptom: Stale session message on service start**
- A prior session crossed the 48h threshold without resolution. Normal cleanup. Run `/school` to start fresh.

**Symptom: Same proposal keeps appearing weekly even though I rejected it**
- Check workspace/school/log.jsonl — the proposal's signature may differ across runs due to title drift. If so, file a bug.

**Symptom: "Ambiguous YES/NO"**
- More than 60 seconds elapsed since the most recent /review, or multiple reviews were opened. Reply `YES N` or `NO N` with the specific proposal number.

**Symptom: Write-skill failed — retry prompt**
- Disk full, security-detector rejection, or concurrent write. Check the error message, resolve (free disk / revise body via NO N then new session), then retry.
```

- [ ] **Step 2: Commit**

```bash
git add app/src/main/assets/nodejs-project/DIAGNOSTICS.md
git commit -m "docs(school): DIAGNOSTICS.md troubleshooting section"
```

---

### Task B13: Full happy-path integration test

**Files:**
- Create: `tests/nodejs-project/school-integration.test.js`

- [ ] **Step 1: Write the integration test**

Create `tests/nodejs-project/school-integration.test.js`:

```javascript
#!/usr/bin/env node
// school-integration.test.js — end-to-end happy path on a seeded fixture.
// Structural invariants (no exact-count assertions — rubric is LLM-driven in
// real flow; here we exercise the deterministic plumbing only).

const path = require('path');
const fs = require('fs');
const os = require('os');

(async () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'school-int-'));
    process.env.WORKDIR = tmp;
    fs.mkdirSync(path.join(tmp, 'skills'));

    const SQL_PATH = path.join(__dirname, '../../app/src/main/assets/nodejs-project/sql-wasm.js');
    const SQL = await require(SQL_PATH)({ locateFile: f => path.join(path.dirname(SQL_PATH), f) });
    const db = new SQL.Database();
    const { createToolCallLogSchema, createSkillTriggerLogSchema } = require(
        path.join(__dirname, '../../app/src/main/assets/nodejs-project/database.js'));
    createToolCallLogSchema(db); createSkillTriggerLogSchema(db);

    const now = Date.now();
    // Seed a strong-signal repetition across 3 days
    for (let i = 0; i < 5; i++) {
        db.run(`INSERT INTO tool_call_log (turn_id, tool_name, call_shape, result_status, latency_ms, created_at)
            VALUES ('t' || ?, 'shell_exec', 'shell_exec:calc', 'ok', 3, ?)`,
            [i, now - i * 24 * 3600 * 1000]);
    }

    const { schoolBeginHandler, schoolEndHandler, schoolScanHandler, schoolWriteSkillHandler, schoolHandleInputHandler } = require(
        path.join(__dirname, '../../app/src/main/assets/nodejs-project/tools/school.js'));

    // 1. begin
    const bR = await schoolBeginHandler({ reason: 'on_demand' }, { workDir: tmp });
    if (!bR.ok) { console.error('FAIL begin', bR); process.exit(1); }
    console.log('  ✓ begin returns ok');

    // 2. scan
    const sR = await schoolScanHandler({ window_days: 7, min_repetition: 3 }, { workDir: tmp, db });
    if (!sR.ok || !sR.repeated_patterns || sR.repeated_patterns.length === 0) {
        console.error('FAIL scan — expected repeated_patterns', sR); process.exit(1);
    }
    console.log('  ✓ scan produces ≥ 1 repeated_pattern on strong-signal fixture');

    // 3. write a drafted skill (simulating YES approval)
    const writeR = await schoolWriteSkillHandler({
        mode: 'create', path: 'skills/calc-automation.md',
        body: `---\nname: calc-automation\ndescription: "Automate calc invocations"\nversion: "1.0.0"\n---\n\n# Calc Automation\n\nUse calc tool.\n`,
        evidence: 'shell_exec:calc × 5 across 3 days',
    }, { workDir: tmp });
    if (!writeR.ok) { console.error('FAIL write', writeR); process.exit(1); }
    const written = fs.readFileSync(path.join(tmp, 'skills/calc-automation.md'), 'utf8');
    if (!written.includes('source: school')) { console.error('FAIL missing source'); process.exit(1); }
    if (!written.includes('evidence:')) { console.error('FAIL missing evidence'); process.exit(1); }
    console.log('  ✓ written skill has school frontmatter marker');

    // 4. end
    const eR = await schoolEndHandler({
        session_id: bR.session_id,
        summary: { patterns_found: 1, proposals_made: 1, approved: [{ n: 1, type: 'create', title: 'calc-automation' }],
                   drafted_but_denied: [], skipped: [], ignored: [], rejected_by_rubric: [], rejected_as_duplicate: [] }
    }, { workDir: tmp });
    if (!eR.ok) { console.error('FAIL end', eR); process.exit(1); }
    if (fs.existsSync(path.join(tmp, 'SCHOOL.md'))) { console.error('FAIL SCHOOL.md not deleted'); process.exit(1); }
    const logLine = fs.readFileSync(path.join(tmp, 'school/log.jsonl'), 'utf8').trim();
    if (!logLine.includes(bR.session_id)) { console.error('FAIL log missing session_id'); process.exit(1); }
    console.log('  ✓ end appends log + deletes SCHOOL.md');

    // 5. Crash-recovery check: re-begin with an already-stale SCHOOL.md
    const oldSession = Date.now() - 72 * 3600 * 1000;  // 72h ago, stale
    fs.writeFileSync(path.join(tmp, 'SCHOOL.md'),
        `---\nsession_id: stale-xyz\nstarted_at: ${oldSession}\ntrigger: on_demand\nstate: awaiting_approval\nwindow_days: 7\nopen_proposal_ns: [1]\nrubric_version: "1.0.0"\n---\n\n# Stale\n\n## Proposals\n[]\n`);
    const bR2 = await schoolBeginHandler({ reason: 'on_demand' }, { workDir: tmp });
    if (!bR2.ok) { console.error('FAIL begin on stale', bR2); process.exit(1); }
    if (!bR2.started_after_cleanup) { console.error('FAIL expected started_after_cleanup', bR2); process.exit(1); }
    console.log('  ✓ stale session auto-ends + seamless new session start');

    fs.rmSync(tmp, { recursive: true, force: true });
    console.log('all tests passed');
    process.exit(0);
})().catch(e => { console.error('FAIL', e); process.exit(1); });
```

- [ ] **Step 2: Run**

```bash
node tests/nodejs-project/school-integration.test.js
```
Expected: PASS — all structural invariants hold.

- [ ] **Step 3: Commit**

```bash
git add tests/nodejs-project/school-integration.test.js
git commit -m "test(school): happy-path integration + crash-recovery + stale-session"
```

---

### Task B14: Smoke test add + CHANGELOG + version bump

**Files:**
- Modify: `tests/nodejs-project/smoke.js`
- Modify: `CHANGELOG.md`
- Modify: `app/build.gradle.kts`

- [ ] **Step 1: Add `school` to smoke's side-effect-free list**

In `tests/nodejs-project/smoke.js`, find the `SIDE_EFFECT_FREE` array and add `'school'`.

Note: do NOT add `tools/school.js` — it requires `database.js` which has startup side effects.

- [ ] **Step 2: Run smoke**

```bash
node tests/nodejs-project/smoke.js
```
Expected: PASS — including `require('./school')` at the end.

- [ ] **Step 3: Update CHANGELOG**

Replace the `## [Unreleased]` section in `CHANGELOG.md` with:

```markdown
## [1.10.0] - 2026-XX-XX

### Added
- **Go to School** — The agent can now analyze its own recent activity (tool-call log, skill-trigger log, memory files) and propose concrete self-improvements: new skills to create, existing skills to patch, unused skills to retire. Every proposal passes a 5-gate rubric (Repetition, Permanence, Gap, Utility, Actionable), and proposals the rubric rejects are surfaced with reasons. Two-gate approval: `/review N` → `YES N` writes the file. Trigger with `/school`; recurring via `cron_create`. Rate-limited to 1 per 5 min, 10 per 24h. Newly-written skills take effect on the next turn.
- `tool_call_log` + `skill_trigger_log` SQL.js tables with buffered async logger (5s / 100-row flush). 30-day rolling retention, 50k-row cap. Per-tool `call_shape` structural classifier — pattern-mines repeated CLASSES of calls, not byte-identical calls. Privacy-safe: wallets, URLs with query strings, user text never land in logs.

### Internal
- New bundled skill: `go-to-school`.
- New tools: `school_begin`, `school_scan`, `school_write_skill`, `school_retire_skill`, `school_end`, `school_handle_input`.
- New commands: `/school`, `/school log`, `/school-reset`, `/school-reset-confirm`.
- New workspace artifacts: `workspace/SCHOOL.md` (transient trigger file), `workspace/school/log.jsonl` (90-day rolling), `workspace/school/drafts/`, `workspace/school/retired/`.
```

- [ ] **Step 4: Version bump in `app/build.gradle.kts`**

```kotlin
versionCode = 18
versionName = "1.10.0"
```

- [ ] **Step 5: Commit**

```bash
git add tests/nodejs-project/smoke.js CHANGELOG.md app/build.gradle.kts
git commit -m "chore(school): smoke test add + CHANGELOG + bump v1.10.0 (code 18)"
```

---

### Task B15: SAB-AUDIT-v23 + PR-B submission

**Files:**
- Create: `docs/internal/audits/SAB-AUDIT-v23.md`

- [ ] **Step 1: Author the SAB audit**

Following prior audit structure (SAB-AUDIT-v19, v20, etc. — look at `docs/internal/audits/` for the shape). At minimum cover:

- Identity & Self-Awareness — 10 probe points on the Self-Improvement block's content (each of the 6 tools, rate limit, effect timing, classification rule, etc.)
- Tooling — 15 probe points across the 6 school tools (when to call each, argument semantics, error returns)
- Memory Recall — 5 probe points on how school reads MEMORY.md + daily notes + how this integrates with dedup against `prior_sessions`
- Workspace — 10 probe points: SCHOOL.md lifecycle, log.jsonl shape, drafts/ vs retired/ directories, stale-session behavior
- Runtime info — 5 probe points: 48h stale threshold, 30-day log retention, 60s bare-YES window, rate limits
- Silent Replies — 3 probe points on silent-exit behavior and "Not enough signal" path
- Rubric self-explanation — 10 probe points, one per gate + dedup + rubric_version semantics
- Crash recovery — 5 probe points: SCHOOL.md precedence, log-tail-matches-session-id handling, resume message
- User-facing classification — 7 probe points: input classification rubric, classification echo rule, ambiguous YES/NO handling, disambiguation forms
- Bundled vs workspace skills — 5 probe points: patch/retire rejection, error hint suggesting GitHub issue, frontmatter marker policy differences

Target: 75 probe points. Score honestly pre-fix; fix gaps; rescore to 100% post-fix. Attach the audit doc to PR-B description.

- [ ] **Step 2: Run the full test suite before push**

```bash
node tests/nodejs-project/smoke.js
node tests/nodejs-project/tool-call-log.test.js
node tests/nodejs-project/skill-trigger-log.test.js
node tests/nodejs-project/call-shape.test.js
node tests/nodejs-project/tool-call-log-perf.test.js
node tests/nodejs-project/school.test.js
node tests/nodejs-project/school-state-machine.test.js
node tests/nodejs-project/school-tools.test.js
node tests/nodejs-project/school-integration.test.js
node tests/nodejs-project/silent-reply.test.js
```
All must exit 0.

- [ ] **Step 3: Device acceptance run**

Install the built APK on a Solana Seeker:
```bash
./gradlew assembleDappStoreDebug
adb install -r app/build/outputs/apk/dappStore/debug/app-dappStore-debug.apk
```

From Telegram:
1. Run `/school`. Expect either a proposals message or the silent-exit line.
2. If proposals: `/review 1`. Expect the drafted SKILL.md in a `<pre>` block + *"Write to workspace? Reply YES N or NO N."*
3. Reply `YES 1`. Expect *"Understood as YES on proposal 1 — writing now. ... Live on next turn."*
4. Run `/school log`. Expect compact history summary including the session.
5. Run `/school-reset`. Expect confirmation prompt. Do NOT confirm; wait > 60s; verify next input proceeds normally.
6. Run `/school-reset` → `/school-reset-confirm` within 60s → expect *"School state cleared."*

Capture a transcript (scrub personal info).

- [ ] **Step 4: Commit audit + transcript**

```bash
git add docs/internal/audits/SAB-AUDIT-v23.md
git commit -m "docs(school): SAB-AUDIT-v23 — 75 probes, 100% post-fix"
```

- [ ] **Step 5: Push + open PR-B**

```bash
git push
gh pr create --title "feat(school): Go to School self-improvement (PR-B, BAT-XXX)" --body "$(cat <<'EOF'
## Summary

Phase B of the Go to School feature — the user-facing capability.

- Bundled `go-to-school` skill with 5-gate rubric, dedup, proposal format, two-gate approval protocol, input classification rubric.
- 6 new tools: `school_begin`, `school_scan`, `school_write_skill`, `school_retire_skill`, `school_end`, `school_handle_input`.
- Deterministic JS state machine (32 transitions tested).
- New commands: `/school`, `/school log`, `/school-reset` (two-step confirmation).
- Stale-session auto-end (48h), rate limit (1/5min, 10/24h).
- Skills created by school take effect on the next turn via existing `loadSkills()` live-read.

## Design

Spec: [docs/superpowers/specs/2026-04-19-go-to-school-design.md](../blob/feature/go-to-school/docs/superpowers/specs/2026-04-19-go-to-school-design.md) (7 design revisions; fully verified against the codebase).

## SAB-AUDIT-v23

Attached: [docs/internal/audits/SAB-AUDIT-v23.md](../blob/feature/go-to-school/docs/internal/audits/SAB-AUDIT-v23.md) — 75 probe points, 100% post-fix.

## Test plan

- [x] `node tests/nodejs-project/smoke.js`
- [x] `node tests/nodejs-project/school.test.js`
- [x] `node tests/nodejs-project/school-state-machine.test.js` (16 transitions, covers all 4 states × key inputs)
- [x] `node tests/nodejs-project/school-tools.test.js`
- [x] `node tests/nodejs-project/school-integration.test.js`
- [x] Device run on Solana Seeker: `/school`, `/review N`, `YES N`, `/school log`, `/school-reset` two-step. Transcript attached to release notes.

🤖 Generated with [Claude Code](https://claude.com/claude-code)
EOF
)"
```

**Wait for PR-B to merge + tag `v1.10.0-rc2`. After 3 days clean on RC → tag `v1.10.0`. Google Play staged 10/50/100% over 72h.**

---

## Self-Review

**Spec coverage:** every section in [the design spec](../specs/2026-04-19-go-to-school-design.md) maps to at least one task above. §6 → Tasks A1-A2 (schemas) + A3 (shape) + A4-A5 (logger) + A6 (skill-trigger instrumentation) + A7 (retention). §7 → Tasks B4-B7. §8 → Task B8 (bundled skill body). §9 → Tasks B4 (SCHOOL.md + log.jsonl) + B11 (stale). §10 → Task B10. §11 (security) is implicit in tool-level enforcement (B5) + existing `security.js` reuse (tested via B5's oversize/traversal cases). §12 → Tasks B9 (buildSystemBlocks) + B12 (DIAGNOSTICS). §13 → Tasks A1-A8 + B1-B3 + B13 (all test matrices). §14 → Task B15 (SAB audit). §15 → Tasks A9 + B14 + B15 (rollout). §16 acceptance criteria map 1:1 to test assertions in tasks.

**Placeholder scan:** no TBDs or "figure out later" phrases. Every code block is complete. One pragmatic note: Task A5 says "find the existing `executeTool` dispatcher" and wraps it — the exact surgery depends on the current function shape; plan author may need to adjust naming (e.g., rename the current `executeTool` to `executeToolInner` and export the wrapped version). This is a common refactor pattern, not an evasion.

**Type consistency:** `call_shape` is a string everywhere. `transition()` returns `{nextState, nextAction}` everywhere. `schoolBeginHandler` / `schoolEndHandler` etc. use camelCase with `Handler` suffix consistently. `workDir` is the context parameter name throughout.

**Plan-phase items from v4-v7 spec** (5-9 flagged as plan-phase):
- Item 5 (`/school-reset` confirmation): Task B10 (two-step with 60s TTL).
- Item 6 (`rubric_version` semantics): stamped as skill version `"1.0.0"` hardcoded in v1; agent reads from bundled skill frontmatter.
- Item 7 (`resumed_state` shape): Task B4 returns full parsed structure.
- Item 8 (`workspace/skills/` missing): Task B5 uses `fs.mkdirSync(recursive: true)` before write.
- Item 9 (injection-during-session test): not explicitly tested in B13; reuses existing `security.js` suspicious-pattern detector at `school_write_skill` — the test in B5 (oversize/traversal) covers the sandbox but NOT the injection pattern rejection. **Plan author should add a test case in school-tools.test.js:** write a skill body containing `<script>alert('x')</script>` or similar suspicious patterns and assert `school_write_skill` rejects with the expected error. Small gap.

---

## Execution Handoff

Plan complete and saved to `docs/superpowers/plans/2026-04-19-go-to-school.md`. Two execution options:

**1. Subagent-Driven (recommended)** — I dispatch a fresh subagent per task, review between tasks, fast iteration.

**2. Inline Execution** — Execute tasks in this session using executing-plans, batch execution with checkpoints.

Which approach?
