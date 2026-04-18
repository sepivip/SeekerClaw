#!/usr/bin/env node
// skill-trigger-log.test.js — schema + UNIQUE constraint test.
// Run: node tests/nodejs-project/skill-trigger-log.test.js

const fs = require('fs');
const os = require('os');
const path = require('path');

async function main() {
    // database.js transitively requires config.js, which reads config.json from
    // process.argv[2] (falls back to __dirname) and calls process.exit(1) if it's
    // missing. Stand up a minimal fixture workdir so the require succeeds in a
    // standalone test environment.
    const fixtureDir = fs.mkdtempSync(path.join(os.tmpdir(), 'seekerclaw-stl-test-'));
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
