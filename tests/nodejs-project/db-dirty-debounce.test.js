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

    function attachDb(stub) { db = stub; }
    function detachDb() { db = null; }

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
        saveCount++;
        if (force) forcedSaveCount++;
        dirty = false;
        if (saveTimer) {
            clearTimeout(saveTimer);
            saveTimer = null;
        }
    }

    return {
        attachDb, detachDb, markDbDirty, saveDatabase,
        get dirty() { return dirty; },
        get saveCount() { return saveCount; },
        get forcedSaveCount() { return forcedSaveCount; },
        get hasPendingTimer() { return saveTimer !== null; },
    };
}

// --- tests ---

let pass = 0;
let fail = 0;

function test(name, fn) {
    try {
        fn();
        pass++;
        console.log(`PASS  ${name}`);
    } catch (e) {
        fail++;
        console.log(`FAIL  ${name}`);
        console.log(`  ${e.message}`);
        if (e.stack) console.log(e.stack.split('\n').slice(1, 4).join('\n'));
    }
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

test('multiple markDbDirty within debounce window coalesce into ONE save', (done) => {
    return new Promise((resolve, reject) => {
        const h = makeHarness({ debounceMs: 50 });
        h.attachDb({});
        // Burst: 50 mutations in ~10ms — pre-BAT-523 setInterval-based
        // approach would still be 1 save (waiting for the next 60s tick),
        // but the NEW debounce must show the same coalescing behaviour.
        for (let i = 0; i < 50; i++) h.markDbDirty();
        assert.strictEqual(h.saveCount, 0, 'no save yet — debounce in flight');
        setTimeout(() => {
            try {
                assert.strictEqual(h.saveCount, 1, 'exactly one save after debounce window');
                assert.strictEqual(h.dirty, false, 'dirty cleared post-save');
                assert.strictEqual(h.hasPendingTimer, false, 'no timer pending after save');
                resolve();
            } catch (e) { reject(e); }
        }, 100);
    });
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

test('mark + save + mark again schedules a NEW debounced save', (done) => {
    return new Promise((resolve, reject) => {
        const h = makeHarness({ debounceMs: 50 });
        h.attachDb({});
        h.markDbDirty();
        h.saveDatabase({ force: true }); // flush eagerly — saveCount=1, timer cancelled
        h.markDbDirty(); // a new mutation arrives later
        assert.strictEqual(h.hasPendingTimer, true, 'fresh timer for the new dirty cycle');
        setTimeout(() => {
            try {
                assert.strictEqual(h.saveCount, 2, 'second save fired from the new debounce');
                resolve();
            } catch (e) { reject(e); }
        }, 100);
    });
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

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
