#!/usr/bin/env node
// tool-call-log-perf.test.js — ensure the buffered logger doesn't
// regress p99 tool latency under a 1000-call burst.
// Target: 1000 records + flush < 200ms wall-clock total. If this
// fails, the buffered-insert path is slower than expected.

const path = require('path');
const { setupConfigFixture } = require('./_fixtures');

async function main() {
    // database.js transitively requires config.js (reads config.json or exits);
    // stand up a minimal fixture before requiring it, even though we only use
    // createToolCallLogSchema from that module.
    setupConfigFixture('seekerclaw-tcl-perf-');

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

    await logger.stop();

    if (elapsed > 200) {
        console.error(`FAIL: 1000-record burst took ${elapsed}ms (budget: 200ms)`);
        process.exit(1);
    }
    console.log(`  ✓ 1000 records + flush = ${elapsed}ms (budget 200ms)`);
    console.log('all tests passed');
    process.exit(0);
}

main().catch(e => { console.error('FAIL', e); process.exit(1); });
