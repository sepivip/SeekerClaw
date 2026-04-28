#!/usr/bin/env node
// db-dirty-debounce.test.js — tests for the BAT-523 dirty-flag + debounced
// save logic in database.js.
//
// Run:  node tests/nodejs-project/db-dirty-debounce.test.js
// Exit: 0 = all pass, 1 = at least one failure.
//
// WHY THIS FILE EXISTS
// --------------------
// Phase 3A of BAT-518 replaces the prior unconditional
// `setInterval(saveDatabase, 60000)` in database.js with a dirty-flag +
// trailing-debounce model. The change has two correctness invariants
// that aren't visible from a plain code read:
//
//   1. Multiple mutations within the debounce window must coalesce into
//      ONE disk save (the whole point of the change).
//   2. A graceful shutdown / forced flush must persist any pending dirty
//      state — losing in-memory rows on process exit would be a
//      regression worse than the pre-BAT-523 behaviour.
//
// Both invariants are pure flag/timer logic, but they live in
// database.js next to live SQL.js calls and config requires. Following
// the active-model.test.js pattern, we mirror the logic locally and
// grep the source at the end to fail loudly on drift.

'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');

const DATABASE_JS = path.join(__dirname, '..', '..', 'app', 'src', 'main',
    'assets', 'nodejs-project', 'database.js');

// --- mirrored logic (must match database.js dirty/debounce primitives) ---
//
// `db` is an opaque truthy/falsy stand-in for the SQL.js Database — we
// only check that markDbDirty is a no-op when the DB doesn't exist yet.
// The actual export()+rename inside saveDatabase is replaced by a
// recorded counter so tests can assert "how many disk saves happened."
function makeHarness({ debounceMs = 60_000 } = {}) {
    let db = null;
    let dirty = false;
    let saveTimer = null;
    let saveCount = 0;
    let forcedSaveCount = 0;
    // Synthetic-failure injection for the retry-on-save-error test.
    // Real code throws when fs.writeFileSync / fs.renameSync fail; we
    // mirror only the throw path because the rescheduling logic is
    // what we're testing, not the FS plumbing.
    let saveShouldFail = false;
    let saveAttempts = 0;

    function attachDb(stub) { db = stub; }
    function detachDb() { db = null; }
    function setSaveShouldFail(v) { saveShouldFail = v; }

    function markDbDirty() {
        if (!db) return;
        dirty = true;
        if (saveTimer) return;
        saveTimer = setTimeout(() => {
            saveTimer = null;
            saveDatabase();
        }, debounceMs);
    }

    function saveDatabase({ force = false } = {}) {
        if (!db) return;
        if (!dirty && !force) return;
        saveAttempts++;
        try {
            if (saveShouldFail) throw new Error('synthetic save failure');
            saveCount++;
            if (force) forcedSaveCount++;
            dirty = false;
            if (saveTimer) {
                clearTimeout(saveTimer);
                saveTimer = null;
            }
        } catch (err) {
            // Mirrors database.js retry-on-failure: if dirty is still
            // true and no timer is already armed, schedule a fresh one
            // SAVE_DEBOUNCE_MS later. Bounded retry, no tight loop.
            if (dirty && !saveTimer) {
                saveTimer = setTimeout(() => {
                    saveTimer = null;
                    saveDatabase();
                }, debounceMs);
            }
        }
    }

    return {
        attachDb, detachDb, markDbDirty, saveDatabase, setSaveShouldFail,
        get dirty() { return dirty; },
        get saveCount() { return saveCount; },
        get saveAttempts() { return saveAttempts; },
        get forcedSaveCount() { return forcedSaveCount; },
        get hasPendingTimer() { return saveTimer !== null; },
    };
}

// --- tests ---
//
// Tests are collected first then run sequentially via an async loop —
// Copilot caught (correctly) that the original synchronous runner ran
// `try { fn() }` without awaiting, so any test returning a Promise
// recorded PASS based on the synchronous prologue and the assertions
// inside setTimeout callbacks never ran. Async tests are needed here
// because debounce/coalescing is inherently time-based.

const tests = [];
let pass = 0;
let fail = 0;

function test(name, fn) {
    tests.push({ name, fn });
}

async function run() {
    for (const { name, fn } of tests) {
        try {
            await fn();
            pass++;
            console.log(`PASS  ${name}`);
        } catch (e) {
            fail++;
            console.log(`FAIL  ${name}`);
            console.log(`  ${e.message}`);
            if (e.stack) console.log(e.stack.split('\n').slice(1, 4).join('\n'));
        }
    }
    console.log(`\n${pass} passed, ${fail} failed`);
    process.exit(fail === 0 ? 0 : 1);
}

test('markDbDirty is a no-op when db is null (init failed / not loaded)', () => {
    const h = makeHarness();
    h.markDbDirty();
    assert.strictEqual(h.dirty, false, 'dirty should remain false');
    assert.strictEqual(h.hasPendingTimer, false, 'no timer should be scheduled');
});

test('markDbDirty sets dirty + schedules a timer when db is loaded', () => {
    const h = makeHarness({ debounceMs: 60 });
    h.attachDb({});
    h.markDbDirty();
    assert.strictEqual(h.dirty, true);
    assert.strictEqual(h.hasPendingTimer, true);
    h.saveDatabase({ force: true }); // tear down the timer
});

test('multiple markDbDirty within debounce window coalesce into ONE save', async () => {
    const h = makeHarness({ debounceMs: 50 });
    h.attachDb({});
    // Burst: 50 mutations in ~10ms — pre-BAT-523 setInterval-based
    // approach would still be 1 save (waiting for the next 60s tick),
    // but the NEW debounce must show the same coalescing behaviour.
    for (let i = 0; i < 50; i++) h.markDbDirty();
    assert.strictEqual(h.saveCount, 0, 'no save yet — debounce in flight');
    await new Promise(r => setTimeout(r, 100));
    assert.strictEqual(h.saveCount, 1, 'exactly one save after debounce window');
    assert.strictEqual(h.dirty, false, 'dirty cleared post-save');
    assert.strictEqual(h.hasPendingTimer, false, 'no timer pending after save');
});

test('saveDatabase() is a no-op when not dirty', () => {
    const h = makeHarness();
    h.attachDb({});
    h.saveDatabase();
    assert.strictEqual(h.saveCount, 0);
});

test('saveDatabase({force: true}) saves even when not dirty', () => {
    const h = makeHarness();
    h.attachDb({});
    h.saveDatabase({ force: true });
    assert.strictEqual(h.saveCount, 1);
    assert.strictEqual(h.forcedSaveCount, 1);
});

test('saveDatabase({force: true}) cancels any pending debounced save', () => {
    const h = makeHarness({ debounceMs: 60_000 });
    h.attachDb({});
    h.markDbDirty();
    assert.strictEqual(h.hasPendingTimer, true);
    h.saveDatabase({ force: true });
    assert.strictEqual(h.saveCount, 1, 'force save fired');
    assert.strictEqual(h.hasPendingTimer, false, 'timer cancelled');
    assert.strictEqual(h.dirty, false);
});

test('saveDatabase clears dirty so subsequent !force calls are no-ops', () => {
    const h = makeHarness();
    h.attachDb({});
    h.markDbDirty();
    h.saveDatabase({ force: true });
    h.saveDatabase(); // not dirty, not force
    h.saveDatabase(); // not dirty, not force
    assert.strictEqual(h.saveCount, 1, 'only the original force save');
});

test('mark + save + mark again schedules a NEW debounced save', async () => {
    const h = makeHarness({ debounceMs: 50 });
    h.attachDb({});
    h.markDbDirty();
    h.saveDatabase({ force: true }); // flush eagerly — saveCount=1, timer cancelled
    h.markDbDirty(); // a new mutation arrives later
    assert.strictEqual(h.hasPendingTimer, true, 'fresh timer for the new dirty cycle');
    await new Promise(r => setTimeout(r, 100));
    assert.strictEqual(h.saveCount, 2, 'second save fired from the new debounce');
});

test('save failure during debounce reschedules a retry timer (no tight loop)', async () => {
    const h = makeHarness({ debounceMs: 30 });
    h.attachDb({});
    h.setSaveShouldFail(true);

    // First mutation schedules a debounced save 30ms out. Wait long
    // enough for the timer to fire — it should attempt + fail + arm a
    // new retry timer.
    h.markDbDirty();
    assert.strictEqual(h.hasPendingTimer, true, 'initial debounce armed');

    await new Promise(r => setTimeout(r, 50));
    // The timer fired, called saveDatabase, which threw inside try
    // (saveShouldFail=true). Catch must have rescheduled — bounded by
    // debounceMs, NOT a tight loop.
    assert.strictEqual(h.saveCount, 0, 'no successful save');
    assert.strictEqual(h.dirty, true, 'still dirty after failure');
    assert.strictEqual(h.hasPendingTimer, true, 'retry timer rescheduled');
    assert.ok(h.saveAttempts >= 1, 'save was attempted');

    // Now flip the failure flag and let the retry succeed.
    h.setSaveShouldFail(false);
    await new Promise(r => setTimeout(r, 50));
    assert.strictEqual(h.saveCount, 1, 'retry succeeded once flag cleared');
    assert.strictEqual(h.dirty, false, 'dirty cleared after successful save');
    assert.strictEqual(h.hasPendingTimer, false, 'no pending timer post-success');
});

test('save failure does NOT tight-loop (one attempt per debounce window)', async () => {
    // Spec phrasing: "Fix failed-save retry/re-arm without tight loop."
    // If the catch branch ran a synchronous retry, saveAttempts would
    // explode. With a setTimeout-based retry, saveAttempts grows by 1
    // per debounceMs window — bounded.
    const h = makeHarness({ debounceMs: 25 });
    h.attachDb({});
    h.setSaveShouldFail(true);
    h.markDbDirty();

    await new Promise(r => setTimeout(r, 100));
    // 100ms / 25ms ≈ 4 windows. Allow some scheduler jitter — assert
    // a loose upper bound. A tight loop would be in the 100,000+ range
    // (synchronous JS in a 100ms window).
    assert.ok(h.saveAttempts >= 1, 'at least one attempt');
    assert.ok(h.saveAttempts <= 10, `saveAttempts ${h.saveAttempts} suggests tight loop`);
});

test('shutdown-style force save flushes pending mutations', () => {
    // Simulates: process gets SIGTERM, mutations from the last few
    // seconds are still dirty, gracefulShutdown calls
    // saveDatabase({ force: true }). Pre-BAT-523, this was already the
    // behaviour. Phase 3A must preserve it.
    const h = makeHarness({ debounceMs: 60_000 });
    h.attachDb({});
    h.markDbDirty();
    h.markDbDirty();
    h.markDbDirty();
    assert.strictEqual(h.saveCount, 0);
    assert.strictEqual(h.dirty, true);
    h.saveDatabase({ force: true });
    assert.strictEqual(h.saveCount, 1, 'shutdown flush persisted the dirty rows');
    assert.strictEqual(h.dirty, false);
    assert.strictEqual(h.hasPendingTimer, false);
});

// --- structural drift guard ---
// If someone edits database.js without updating this test mirror, fail
// loudly. Identifiers are pinned to exactly the names callers depend on.

test('drift: live database.js exports markDbDirty', () => {
    const src = fs.readFileSync(DATABASE_JS, 'utf8');
    assert.ok(/module\.exports\s*=\s*\{[\s\S]*\bmarkDbDirty\b/.test(src),
        'database.js must export markDbDirty');
});

test('drift: live database.js no longer has setInterval(saveDatabase, ...)', () => {
    const src = fs.readFileSync(DATABASE_JS, 'utf8');
    assert.ok(!/setInterval\s*\(\s*saveDatabase\b/.test(src),
        'the unconditional 60s setInterval must be removed (BAT-523 phase 3A)');
});

test('drift: live saveDatabase accepts a {force} option', () => {
    const src = fs.readFileSync(DATABASE_JS, 'utf8');
    assert.ok(/function\s+saveDatabase\s*\(\s*\{[^}]*\bforce\b/.test(src),
        'saveDatabase signature must take {force} so shutdown/init can bypass the dirty check');
});

test('drift: live database.js declares a dirty flag', () => {
    const src = fs.readFileSync(DATABASE_JS, 'utf8');
    assert.ok(/\blet\s+dirty\b/.test(src),
        'database.js must declare a `dirty` flag to drive markDbDirty');
});

test('drift: saveDatabase catch path reschedules on failure (retry guard)', () => {
    // Pin the retry behaviour so a future refactor cannot silently
    // remove the bounded-retry property. A tight grep on
    // "saveTimer = setTimeout" inside the catch clause is enough — the
    // exact wording can drift, but the structural shape must remain.
    const src = fs.readFileSync(DATABASE_JS, 'utf8');
    const catchMatch = src.match(/}\s*catch\s*\(\s*err\s*\)\s*\{[\s\S]*?\}\s*\}\s*\n\}/);
    assert.ok(catchMatch, 'saveDatabase catch block not found');
    const catchBody = catchMatch[0];
    assert.ok(/saveTimer\s*=\s*setTimeout/.test(catchBody),
        'saveDatabase catch block must reschedule a retry timer (BAT-523 — bounded retry on transient I/O failures)');
});

test('drift: indexMemoryFiles marks dirty unconditionally', () => {
    const src = fs.readFileSync(DATABASE_JS, 'utf8');
    // The bug was: `if (indexed > 0) markDbDirty();` left the
    // unconditional `meta.last_indexed` INSERT unsaved when no files
    // were re-indexed. Reject any code that gates markDbDirty inside
    // indexMemoryFiles on a length/count condition.
    const fnMatch = src.match(/function\s+indexMemoryFiles\s*\(\s*\)[\s\S]*?\n\}/);
    assert.ok(fnMatch, 'indexMemoryFiles function body not found');
    const body = fnMatch[0];
    assert.ok(/markDbDirty\s*\(\s*\)/.test(body),
        'indexMemoryFiles must call markDbDirty()');
    assert.ok(!/if\s*\(\s*indexed\s*>\s*0\s*\)\s*markDbDirty/.test(body),
        'markDbDirty must NOT be gated on indexed > 0 (BAT-523 fix — meta.last_indexed always mutates)');
});

run();
