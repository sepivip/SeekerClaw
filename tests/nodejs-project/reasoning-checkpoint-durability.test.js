#!/usr/bin/env node
// reasoning-checkpoint-durability.test.js — BAT-1290.
//
// The defect: quarantineActiveSegment() probed `path.join(workDir,'task-store')`
// while checkpoints live at TASKS_DIR = <workDir>/tasks, so the ON-DISK half of
// reasoning-400 recovery never ran on a device — silently, because the block was
// a bare `if (fs.existsSync(...))` with no else.
//
// WHY THE OLD TESTS DID NOT CATCH IT: their fixtures hand-built the same wrong
// directory name (reasoning-recovery.test.js:127, reasoning-pipeline.test.js:30),
// so they validated the consumer's assumption instead of the producer's shape.
// Worse, BOTH files sat in ci-coverage-manifest's SKIP_REASONS and never ran in
// CI at all. This suite uses the REAL taskStore.saveCheckpoint with TASKS_DIR
// stubbed exactly as production defines it: <tmp>/tasks.
//
// Run:  node tests/nodejs-project/reasoning-checkpoint-durability.test.js
'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const BUNDLE = path.join(__dirname, '..', '..', 'app', 'src', 'main', 'assets', 'nodejs-project');

// ── stub config.js BEFORE anything requires it ──────────────────────────────
const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'bat1290-'));
const workDir = path.join(tmpRoot, 'workspace');
// PRODUCTION shape — config.js:833 is `path.join(workDir, 'tasks')`. Naming this
// anything else is the exact mistake that hid the bug for a release cycle.
const TASKS_DIR = path.join(workDir, 'tasks');
fs.mkdirSync(TASKS_DIR, { recursive: true });

const configPath = require.resolve(path.join(BUNDLE, 'config.js'));
require.cache[configPath] = {
    id: configPath, filename: configPath, loaded: true,
    exports: { TASKS_DIR, workDir, config: {}, log: () => {}, getBridgeToken: () => null },
};

const taskStore = require(path.join(BUNDLE, 'task-store'));
const recovery = require(path.join(BUNDLE, 'reasoning-recovery'));

let passed = 0, failed = 0;
function test(name, fn) {
    try { fn(); passed++; console.log(`  ✓ ${name}`); }
    catch (e) { failed++; console.error(`  ✗ ${name}`); console.error(`    ${e.message}`); process.exitCode = 1; }
}

// ── helpers ─────────────────────────────────────────────────────────────────

// step 1 cuts AFTER the last user message, so this shrinks 3 -> 1.
const SHRINKABLE = () => ([
    { role: 'user', content: 'do the thing' },
    { role: 'assistant', content: 'working' },
    { role: 'assistant', content: 'still working' },
]);
// No user message at all => findLastUserBoundary returns -1 => no safe cut.
const UNCUTTABLE = () => ([
    { role: 'assistant', content: 'a' },
    { role: 'assistant', content: 'b' },
]);

let seq = 0;
function writeCp(slice, extra) {
    const taskId = `t${String(++seq).padStart(15, '0')}`;
    taskStore.saveCheckpoint(taskId, Object.assign({
        taskId, chatId: '900', startedAt: Date.now(), complete: false,
        conversationSlice: slice,
    }, extra || {}));
    return taskId;
}

const logs = [];
const capture = (msg, level) => logs.push(`${level || 'INFO'}|${msg}`);
function repair(taskId, kind, step, over) {
    logs.length = 0;
    return recovery._repairCheckpoint(Object.assign({
        tasksDir: TASKS_DIR, taskId, checkpointKind: kind,
        recoveryDir: path.join(workDir, 'recovery'),
        fileBase: `fb-${taskId}`, step: step || 1,
        now: Date.now(), log: capture, safeTask: taskId,
    }, over || {}));
}
const readCp = (taskId) => JSON.parse(fs.readFileSync(path.join(TASKS_DIR, `${taskId}.json`), 'utf8'));

console.log('\nBAT-1290 — on-disk checkpoint durability\n');

// ── the fix itself ──────────────────────────────────────────────────────────

test('REGRESSION: a producer-written checkpoint is actually repaired', () => {
    // This is the test the old code fails. It asserts MUTATION, not byte-identity:
    // asserting "unchanged" would pass on broken code and fail after the fix, which
    // is the inverted-control trap Codex flagged on contract v2.
    const id = writeCp(SHRINKABLE());
    const before = readCp(id).conversationSlice.length;
    const out = repair(id, 'current', 1);
    const after = readCp(id);

    assert.strictEqual(out.status, 'repaired', `expected repaired, got ${out.status}/${out.reason}`);
    assert.ok(after.conversationSlice.length < before,
        `slice must be strictly shorter (${before} -> ${after.conversationSlice.length})`);
    assert.strictEqual(after.recoveryQuarantineStep, 1, 'marker recorded on a real mutation');
    assert.ok(out.path && fs.existsSync(out.path), 'forensic copy written');
});

test('an unrelated checkpoint is left byte-identical', () => {
    const victim = writeCp(SHRINKABLE());
    const other = writeCp(SHRINKABLE());
    const otherBefore = fs.readFileSync(path.join(TASKS_DIR, `${other}.json`));
    repair(victim, 'current', 1);
    assert.deepStrictEqual(fs.readFileSync(path.join(TASKS_DIR, `${other}.json`)), otherBefore);
});

// ── D3: no marker without a persisted mutation ──────────────────────────────

test('D3: no safe cut point => unchanged, and NO marker is stamped', () => {
    // The old code truncated nothing here yet still wrote recoveryQuarantineStep,
    // recording a repair that never happened.
    const id = writeCp(UNCUTTABLE());
    const before = fs.readFileSync(path.join(TASKS_DIR, `${id}.json`));
    const out = repair(id, 'current', 1);

    assert.strictEqual(out.status, 'unchanged');
    assert.strictEqual(out.reason, 'no-cut-point');
    assert.strictEqual(readCp(id).recoveryQuarantineStep, undefined, 'marker must NOT be stamped');
    assert.deepStrictEqual(fs.readFileSync(path.join(TASKS_DIR, `${id}.json`)), before,
        'a current-turn checkpoint with no cut point is left alone entirely');
});

// ── D2: the outcome enum, incl. absent semantics ────────────────────────────

test('D2: absent means BOTH primary and .bak are gone', () => {
    const out = repair('tNOPEnopeNOPEnop', 'current', 1);
    assert.strictEqual(out.status, 'absent');
    assert.strictEqual(out.reason, 'no-file');
});

test('D2: a backup-only checkpoint is NOT reported absent', () => {
    // loadCheckpoint falls back to .bak (task-store.js:192), so calling this
    // "absent" would be a lie in the dangerous direction.
    const id = writeCp(SHRINKABLE());
    const primary = path.join(TASKS_DIR, `${id}.json`);
    fs.copyFileSync(primary, primary + '.bak');
    fs.unlinkSync(primary);

    const out = repair(id, 'current', 1);
    assert.notStrictEqual(out.status, 'absent', `backup-only must not be 'absent' (got ${out.status})`);
});

test('D2/D4: absent on a RESUMED checkpoint is a WARN, on a current one it is not', () => {
    repair('tGONEgoneGONEgon', 'resumed', 1);
    assert.ok(logs.some(l => l.startsWith('WARN')), 'resumed absence must be loud');
    repair('tGONEgoneGONEgon', 'current', 1);
    assert.ok(!logs.some(l => l.startsWith('WARN')), 'a fresh task with no checkpoint is normal');
});

test('D1: a missing tasksDir is rejected, never derived from workDir', () => {
    const id = writeCp(SHRINKABLE());
    const out = repair(id, 'current', 1, { tasksDir: null });
    assert.strictEqual(out.status, 'rejected');
    assert.strictEqual(out.reason, 'no-tasks-dir');
    assert.strictEqual(readCp(id).recoveryQuarantineStep, undefined, 'nothing mutated');
});

test('D4: an invalid checkpointKind fails loudly rather than defaulting', () => {
    // Defaulting to 'current' would silently disable the resumed-path quarantine,
    // which is the entire point of D4.
    const id = writeCp(SHRINKABLE());
    for (const kind of [undefined, null, 'CURRENT', 'other']) {
        const out = repair(id, kind, 1);
        assert.strictEqual(out.status, 'failed', `kind=${String(kind)}`);
        assert.strictEqual(out.reason, 'invalid-checkpoint-kind');
    }
});

test('containment: a taskId that escapes tasksDir is rejected', () => {
    const out = repair('..' + path.sep + 'escape', 'current', 1);
    assert.strictEqual(out.status, 'rejected');
    assert.strictEqual(out.reason, 'path-escape');
});

// ── D4: the resumed path quarantines ────────────────────────────────────────

test('D4: a resumed checkpoint with no cut point is QUARANTINED out of tasksDir', () => {
    const id = writeCp(UNCUTTABLE());
    const out = repair(id, 'resumed', 1);

    assert.strictEqual(out.status, 'quarantined');
    assert.ok(!fs.existsSync(path.join(TASKS_DIR, `${id}.json`)),
        'the poisoned file must no longer be resumable');
    assert.strictEqual(taskStore.loadCheckpoint(id), null,
        'and loadCheckpoint must not be able to return it');
    assert.ok(out.path && fs.existsSync(out.path), 'forensic copy retained');
});

test('D4/D5: quarantine takes the .bak with it', () => {
    const id = writeCp(UNCUTTABLE());
    const primary = path.join(TASKS_DIR, `${id}.json`);
    fs.copyFileSync(primary, primary + '.bak');

    repair(id, 'resumed', 1);
    assert.ok(!fs.existsSync(primary), 'primary quarantined');
    assert.ok(!fs.existsSync(primary + '.bak'), 'backup quarantined too — it can resurrect the slice');
    assert.strictEqual(taskStore.loadCheckpoint(id), null);
});

test('D4: a resumed checkpoint that CAN be repaired is repaired, not quarantined', () => {
    // Negative control for the quarantine policy: without this, a fix that
    // quarantined every resumed checkpoint would pass the two tests above.
    const id = writeCp(SHRINKABLE());
    const out = repair(id, 'resumed', 1);
    assert.strictEqual(out.status, 'repaired');
    assert.ok(fs.existsSync(path.join(TASKS_DIR, `${id}.json`)), 'still resumable');
});

// ── D5: the poisoned backup cannot come back ────────────────────────────────

test('D5: after a repair, a stale .bak cannot resurrect the bad slice', () => {
    const id = writeCp(SHRINKABLE());
    const primary = path.join(TASKS_DIR, `${id}.json`);
    // A poisoned backup exists alongside — exactly what saveCheckpoint leaves.
    fs.copyFileSync(primary, primary + '.bak');
    const poisonedLen = JSON.parse(fs.readFileSync(primary + '.bak', 'utf8')).conversationSlice.length;

    const out = repair(id, 'current', 1);
    assert.strictEqual(out.status, 'repaired');
    assert.ok(!fs.existsSync(primary + '.bak'), 'the poisoned backup is gone');

    // Corrupt the primary and force the .bak fallback path.
    fs.writeFileSync(primary, '{ not json', 'utf8');
    const loaded = taskStore.loadCheckpoint(id);
    if (loaded) {
        assert.ok(loaded.conversationSlice.length < poisonedLen,
            'a fallback load must never return the pre-repair slice');
    }
});

test('D5: staging is separate from publication', () => {
    // The ordering guarantee (stage -> drop .bak -> publish) is only expressible
    // if these are two calls. writeJsonAtomic did both in one.
    assert.strictEqual(typeof recovery.stageJson, 'function');
    assert.strictEqual(typeof recovery.publishStaged, 'function');

    const target = path.join(tmpRoot, 'stage-probe.json');
    fs.writeFileSync(target, JSON.stringify({ original: true }), 'utf8');
    const tmp = recovery.stageJson(target, { staged: true });

    assert.ok(fs.existsSync(tmp), 'staged file written');
    assert.deepStrictEqual(JSON.parse(fs.readFileSync(target, 'utf8')), { original: true },
        'the original is untouched until publish — a crash here leaves nothing half-written');

    recovery.publishStaged(tmp, target);
    assert.deepStrictEqual(JSON.parse(fs.readFileSync(target, 'utf8')), { staged: true });
    assert.ok(!fs.existsSync(tmp), 'temp consumed by the rename');
});

test('a parse failure on a resumed checkpoint quarantines rather than silently passing', () => {
    const id = writeCp(SHRINKABLE());
    fs.writeFileSync(path.join(TASKS_DIR, `${id}.json`), '{ truncated', 'utf8');

    const out = repair(id, 'resumed', 1);
    assert.strictEqual(out.status, 'quarantined');
    assert.strictEqual(out.reason, 'parse-failed');
    assert.strictEqual(taskStore.loadCheckpoint(id), null);
});

// ── D6 + D1 wiring: source guards ───────────────────────────────────────────
// ai.js has no module.exports and requiring it boots the agent, so the caller
// contract is pinned by source inspection. Weaker than behavioural coverage and
// labelled as such; its own negative control is run by hand (revert the line,
// watch this go red).

test('SOURCE GUARD: ai.js injects TASKS_DIR and both kinds, and consumes the resumed outcome', () => {
    const src = fs.readFileSync(path.join(BUNDLE, 'ai.js'), 'utf8');
    assert.ok(/^\s*TASKS_DIR,\s*$/m.test(src), 'ai.js must import TASKS_DIR from config');
    assert.ok(/tasksDir: TASKS_DIR, checkpointKind: 'current'/.test(src), 'current call injects both');
    assert.ok(/tasksDir: TASKS_DIR, checkpointKind: 'resumed'/.test(src), 'resumed call injects both');
    assert.ok(/const resumedResult = _reasoningRecovery\.quarantineActiveSegment/.test(src),
        'the resumed outcome must be CAPTURED — it used to be discarded entirely');
});

test('SOURCE GUARD: reasoning-recovery never re-derives the checkpoint dir', () => {
    const src = fs.readFileSync(path.join(BUNDLE, 'reasoning-recovery.js'), 'utf8');
    const code = src.split('\n').filter(l => !l.trim().startsWith('*') && !l.trim().startsWith('//')).join('\n');
    assert.ok(!/path\.join\(\s*workDir\s*,\s*['"]task-store['"]\s*\)/.test(code),
        'the wrong directory must not reappear');
    assert.ok(!/path\.join\(\s*workDir\s*,\s*['"]tasks['"]\s*\)/.test(code),
        'and it must not derive the RIGHT one either — tasksDir is injected (D1)');
});

test('SOURCE GUARD: the repair does not go through saveCheckpoint', () => {
    // saveCheckpoint copies the existing primary into .bak BEFORE publishing
    // (task-store.js:156-165), which would re-poison the backup with the exact
    // slice being removed.
    const src = fs.readFileSync(path.join(BUNDLE, 'reasoning-recovery.js'), 'utf8');
    // Strip comments first — the code deliberately EXPLAINS why saveCheckpoint is
    // avoided, and a naive grep matches that explanation.
    const code = src.split('\n').filter(l => !l.trim().startsWith('*') && !l.trim().startsWith('//')).join('\n');
    assert.ok(!/saveCheckpoint\s*\(/.test(code), 'reasoning-recovery must not call saveCheckpoint');
});

try { fs.rmSync(tmpRoot, { recursive: true, force: true }); } catch { /* best effort */ }

if (failed > 0) {
    console.error(`\nFAIL: reasoning-checkpoint-durability.test.js — ${failed} failed, ${passed} passed\n`);
} else {
    console.log(`\nPASS: reasoning-checkpoint-durability.test.js (${passed} cases)\n`);
}
