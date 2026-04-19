#!/usr/bin/env node
// school.test.js — pure functions in school.js.
// Run: node tests/nodejs-project/school.test.js

const path = require('path');
const { setupConfigFixture } = require(path.join(__dirname, '_fixtures.js'));

let fails = 0;
function assertEq(actual, expected, msg) {
    if (actual !== expected) {
        console.error(`FAIL ${msg}: expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
        fails++;
    } else console.log(`  ✓ ${msg}`);
}

async function main() {
    // Setup config fixture before requiring modules that depend on config.js
    setupConfigFixture('seekerclaw-school-test-');

    // Now safe to require school.js and database-dependent modules
    const { normalizeTitle, signatureOf, scanLogs } = require(
        path.join(__dirname, '../../app/src/main/assets/nodejs-project/school.js')
    );

    // ========== B1 Assertions (sync) ==========
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

    // ========== B3 Assertions (async — scanLogs) ==========
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
    // Populate > INSUFFICIENT_SIGNAL_MIN_CALLS (20) total rows so scan doesn't return empty.
    // 4 repeated + 3 failed = 7 — need 13+ more. Add filler rows.
    for (let i = 0; i < 4; i++) {
        db.run(`INSERT INTO tool_call_log (turn_id, tool_name, call_shape, result_status, latency_ms, created_at)
            VALUES ('t', 'recipe_calc', 'shell_exec:calc', 'ok', 5, ?)`, [now - i * day]);
    }
    for (let i = 0; i < 3; i++) {
        db.run(`INSERT INTO tool_call_log (turn_id, tool_name, call_shape, result_status, error_kind, latency_ms, created_at)
            VALUES ('u', 'solana_swap', 'solana_swap:SOL:USDC', 'error', 'bridge_unreachable', 15, ?)`, [now - i * 3600000]);
    }
    // Filler to cross 20-call threshold
    for (let i = 0; i < 15; i++) {
        db.run(`INSERT INTO tool_call_log (turn_id, tool_name, call_shape, result_status, latency_ms, created_at)
            VALUES ('f' || ?, 'misc', 'misc:op', 'ok', 1, ?)`, [i, now - i * 1000]);
    }

    const result = scanLogs(db, { window_days: 7, min_repetition: 3, now_ms: now });

    if (result.empty) { console.error('FAIL: expected non-empty scan, got', result); fails++; }
    else {
        const rp = (result.repeated_patterns || []).find(p => (p.call_shape_chain && p.call_shape_chain[0] === 'shell_exec:calc'));
        if (!rp || rp.count !== 4) { console.error('FAIL: expected repeated_patterns shell_exec:calc count=4', rp); fails++; }
        else console.log('  ✓ scanLogs finds repeated_patterns');
        const fs2 = (result.failed_sequences || []).find(f => f.error_kind === 'bridge_unreachable');
        if (!fs2 || fs2.count !== 3) { console.error('FAIL: expected failed_sequences count=3', fs2); fails++; }
        else console.log('  ✓ scanLogs finds failed_sequences');
    }

    const db2 = new SQL.Database();
    createToolCallLogSchema(db2); createSkillTriggerLogSchema(db2);
    const emptyRes = scanLogs(db2, { window_days: 7, min_repetition: 3, now_ms: now });
    if (!emptyRes.empty) { console.error('FAIL: expected empty:true on empty log'); fails++; }
    else console.log('  ✓ scanLogs returns empty:true on insufficient data');

    // Exit with appropriate code
    if (fails > 0) process.exit(1);
    console.log('all tests passed');
    process.exit(0);
}

main().catch(e => {
    console.error('FAIL', e);
    process.exit(1);
});
