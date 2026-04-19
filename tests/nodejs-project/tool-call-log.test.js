#!/usr/bin/env node
// tool-call-log.test.js — schema + insert smoke test for tool_call_log.
// Run: node tests/nodejs-project/tool-call-log.test.js

const path = require('path');
const { setupConfigFixture } = require('./_fixtures');

async function main() {
    setupConfigFixture('seekerclaw-tcl-test-');

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
    console.log('all tests passed');
    process.exit(0);
}

main().catch(e => { console.error('FAIL', e); process.exit(1); });
