#!/usr/bin/env node
// tool-call-log.test.js — schema + insert smoke test for tool_call_log.
// Run: node tests/nodejs-project/tool-call-log.test.js

const fs = require('fs');
const os = require('os');
const path = require('path');

async function main() {
    // database.js transitively requires config.js, which reads config.json from
    // process.argv[2] (falls back to __dirname) and calls process.exit(1) if it's
    // missing. Stand up a minimal fixture workdir so the require succeeds in a
    // standalone test environment.
    const fixtureDir = fs.mkdtempSync(path.join(os.tmpdir(), 'seekerclaw-tcl-test-'));
    fs.writeFileSync(path.join(fixtureDir, 'config.json'), JSON.stringify({
        channel: 'telegram',
        botToken: 'test-bot-token',
        ownerId: '1',
        provider: 'claude',
        anthropicApiKey: 'test-anthropic-key',
        agentName: 'TestAgent',
    }));
    process.argv[2] = fixtureDir;

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
