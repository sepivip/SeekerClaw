#!/usr/bin/env node
// smoke.js — Node smoke test for SeekerClaw's nodejs-project bundle.
//
// WHY THIS EXISTS
// ---------------
// On 2026-04-11, v1.9.0-rc5 shipped with a regex SyntaxError in silent-reply.js
// that only surfaced when `new RegExp(...)` ran on the device's V8 build.
// `node --check` passed (the syntax is valid JavaScript) — the crash was in
// CONSTANT EVALUATION at module-load time. This harness catches that class
// of bug by actually loading side-effect-free modules in a real Node process
// and failing loudly if any of them throws.
//
// WHAT IT CHECKS
// --------------
//   1. Phase 1: `node --check` on every .js file under nodejs-project/
//      (catches parse errors — fast, covers everything).
//
//   2. Phase 2: direct `require()` of a hand-picked set of side-effect-free
//      modules. This is where constant regex compilation, schema validation,
//      and other module-init code runs. A failure here would have caught
//      the silent-reply regex bug.
//
// Modules with real startup side effects (main.js, telegram.js, discord.js,
// cron.js, mcp-client.js, database.js, bridge.js, config.js, solana.js) are
// deliberately skipped — they open network connections, spawn timers, load
// SQL.js WASM, or read files from the runtime cwd. We rely on --check for
// those, plus the per-cut device deploy test before tagging.
//
// HOW TO RUN
// ----------
//   node tests/nodejs-project/smoke.js
//
// Exit code 0 = safe to commit. Non-zero = do not commit; fix first.
//
// ADDING A NEW FILE
// -----------------
// New file under nodejs-project/? Add it to either LOAD_TARGETS (if safe to
// require) or SKIP_REASONS (if it has side effects). The harness will warn
// if a file is neither loaded nor explicitly skipped, so new files never
// silently bypass smoke coverage.

const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const REPO_ROOT = path.resolve(__dirname, '..', '..');
const BUNDLE = path.join(REPO_ROOT, 'app', 'src', 'main', 'assets', 'nodejs-project');

// Modules that must load cleanly via require(). Adding a new pure module
// (no config.js dependency, no network, no timers)? Add it here so the
// smoke test covers it.
//
// Pure in this context means the top-level module code does not:
//   - require('./config') transitively
//   - open network connections or start WebSocket/long-poll loops
//   - spawn timers (setTimeout/setInterval) or intervals
//   - write to disk or spawn child processes
//   - load native/WASM modules
const LOAD_TARGETS = [
    'silent-reply.js',
    'loop-detector.js',
];

// Files skipped intentionally. Most modules depend on config.js (which
// reads config.json from cwd and calls process.exit(1) if required fields
// are missing), so they can't be loaded in a standalone test environment
// without a full fixture scaffold. Future work could add a fixture-backed
// "integration" phase that chdir's into a fake workDir with a valid
// config.json before loading — see tests/nodejs-project/README.md for
// the sketch.
//
// Vendored 3rd-party bundles (sql-wasm.js, markdown-it.min.js) are not
// our responsibility to smoke-test; they're verified upstream.
const SKIP_REASONS = {
    'main.js': 'entry point — boots the whole agent',
    'message-handler.js': 'depends on main.js globals',
    'ai.js': 'requires config.js',
    'telegram.js': 'starts long-polling on load',
    'discord.js': 'opens WebSocket on load',
    'channel.js': 'requires telegram.js / discord.js',
    'cron.js': 'requires config.js + schedules timers',
    'mcp-client.js': 'may initiate HTTP handshakes',
    'database.js': 'loads SQL.js WASM',
    'bridge.js': 'targets localhost:8765 Android bridge',
    'config.js': 'reads config.json from cwd (needs fixture)',
    'security.js': 'requires config.js',
    'memory.js': 'requires config.js',
    'task-store.js': 'requires config.js',
    'skills.js': 'requires config.js',
    'web.js': 'requires config.js',
    'http.js': 'requires config.js',
    'quick-actions.js': 'requires config.js',
    'solana.js': 'requires config.js + sol4k deps',
    'providers/index.js': 'requires adapters that require config.js',
    'providers/claude.js': 'requires config.js',
    'providers/openai.js': 'requires config.js',
    'providers/openrouter.js': 'requires config.js',
    'providers/custom.js': 'requires config.js',
    'tools/index.js': 'requires main.js + handlers',
    'tools/android.js': 'requires bridge.js',
    'tools/cron.js': 'requires cron.js',
    'tools/file.js': 'requires main.js globals',
    'tools/memory.js': 'requires memory.js state',
    'tools/session.js': 'requires ai.js',
    'tools/skill.js': 'requires skills.js state',
    'tools/solana.js': 'requires solana.js',
    'tools/system.js': 'runs shell commands',
    'tools/telegram.js': 'requires telegram.js',
    'tools/web.js': 'requires web.js caches',
    'sql-wasm.js': 'third-party bundle (sql.js)',
    'markdown-it.min.js': 'third-party bundle (markdown-it)',
};

const GREEN = '\x1b[32m';
const RED = '\x1b[31m';
const YELLOW = '\x1b[33m';
const DIM = '\x1b[2m';
const RESET = '\x1b[0m';

function walkJs(dir) {
    const out = [];
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        const full = path.join(dir, entry.name);
        // Skip node_modules — vendored deps are their own problem.
        if (entry.isDirectory()) {
            if (entry.name === 'node_modules') continue;
            out.push(...walkJs(full));
        } else if (entry.isFile() && entry.name.endsWith('.js')) {
            out.push(full);
        }
    }
    return out;
}

function rel(p) {
    return path.relative(BUNDLE, p).replace(/\\/g, '/');
}

let totalFailures = 0;

// ============================================================
// Phase 1 — node --check on every JS file (syntax parse)
// ============================================================
console.log(`\n${DIM}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${RESET}`);
console.log(`Phase 1: syntax check (node --check)`);
console.log(`${DIM}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${RESET}`);

const allFiles = walkJs(BUNDLE);
let checkPass = 0;
const checkFailures = [];

for (const file of allFiles) {
    try {
        execFileSync(process.execPath, ['--check', file], { stdio: 'pipe' });
        checkPass++;
    } catch (err) {
        checkFailures.push({
            file: rel(file),
            stderr: (err.stderr || err.message || '').toString(),
        });
    }
}

if (checkFailures.length === 0) {
    console.log(`${GREEN}✓${RESET} ${checkPass}/${allFiles.length} files parse cleanly`);
} else {
    console.log(`${RED}✗${RESET} ${checkFailures.length}/${allFiles.length} files failed to parse:`);
    for (const f of checkFailures) {
        console.log(`  ${RED}${f.file}${RESET}`);
        console.log(`    ${f.stderr.trim().split('\n').slice(0, 3).join('\n    ')}`);
    }
    totalFailures += checkFailures.length;
}

// ============================================================
// Phase 2 — actually require() side-effect-free modules
// ============================================================
// We use DIRECT require() in this process (not a subprocess) because Windows
// path escaping in subprocess args ate our backslashes in the first iteration
// of this harness. Direct require is simpler, faster, and more reliable —
// the trade-off is that one bad module's top-level side effects could in
// theory taint subsequent loads, but the LOAD_TARGETS set is deliberately
// curated to avoid that.
console.log(`\n${DIM}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${RESET}`);
console.log(`Phase 2: module load (require)`);
console.log(`${DIM}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${RESET}`);

let loadPass = 0;
let loadFail = 0;

for (const target of LOAD_TARGETS) {
    const fullPath = path.join(BUNDLE, target);
    if (!fs.existsSync(fullPath)) {
        console.log(`${YELLOW}?${RESET} ${target} — file not found (stale entry in LOAD_TARGETS?)`);
        totalFailures++;
        continue;
    }
    // Clear require cache so each target is a fresh module-load, which is
    // what the device actually does on startup.
    delete require.cache[require.resolve(fullPath)];
    try {
        require(fullPath);
        console.log(`${GREEN}✓${RESET} ${target}`);
        loadPass++;
    } catch (err) {
        loadFail++;
        console.log(`${RED}✗${RESET} ${target}`);
        const stack = (err.stack || err.message || String(err))
            .split('\n')
            .slice(0, 6)
            .map((l) => '    ' + l)
            .join('\n');
        console.log(stack);
    }
}

if (loadFail === 0) {
    console.log(`\n${GREEN}✓${RESET} ${loadPass}/${LOAD_TARGETS.length} modules loaded cleanly`);
} else {
    console.log(`\n${RED}✗${RESET} ${loadFail} module(s) failed to load`);
    totalFailures += loadFail;
}

// ============================================================
// Phase 3 — report on files neither loaded nor explicitly skipped
// ============================================================
const loaded = new Set(LOAD_TARGETS);
const skipped = allFiles.map(rel).filter((f) => !loaded.has(f));
const unaccountedFor = skipped.filter((f) => !(f in SKIP_REASONS));

if (unaccountedFor.length > 0) {
    console.log(`\n${YELLOW}!${RESET} ${unaccountedFor.length} file(s) neither loaded nor explicitly skipped:`);
    for (const f of unaccountedFor) {
        console.log(`    ${f}`);
    }
    console.log(`  ${DIM}Add to LOAD_TARGETS if safe to require(), or to SKIP_REASONS with an explanation.${RESET}`);
    // Warning only — don't fail the build on a new file. Just make noise.
}

// ============================================================
// Final verdict
// ============================================================
console.log(`\n${DIM}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${RESET}`);
if (totalFailures === 0) {
    console.log(`${GREEN}PASS${RESET} — safe to commit.`);
    process.exit(0);
} else {
    console.log(`${RED}FAIL${RESET} — ${totalFailures} issue(s) above. Fix before committing.`);
    process.exit(1);
}
