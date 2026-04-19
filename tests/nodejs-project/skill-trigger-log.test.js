#!/usr/bin/env node
// skill-trigger-log.test.js — schema + UNIQUE constraint test.
// Run: node tests/nodejs-project/skill-trigger-log.test.js

const path = require('path');
const { setupConfigFixture } = require('./_fixtures');

async function main() {
    setupConfigFixture('seekerclaw-stl-test-');

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

    // Verify findMatchingSkills records matches.
    // We call a helper that simulates the match-and-log path.
    const { recordSkillTrigger, setSkillTriggerDb } = require(
        path.join(__dirname, '../../app/src/main/assets/nodejs-project/skills.js')
    );
    setSkillTriggerDb(db);

    recordSkillTrigger('weather', 'msg-42', 'keyword', 1713614500000);
    recordSkillTrigger('weather', 'msg-42', 'keyword', 1713614500500);  // duplicate, should be ignored

    // recordSkillTrigger defers the INSERT via setImmediate (off the hot path).
    // Drain the queue before asserting so both writes have landed.
    await new Promise(resolve => setImmediate(resolve));
    await new Promise(resolve => setImmediate(resolve));

    const r2 = db.exec('SELECT COUNT(*) FROM skill_trigger_log WHERE message_id = ?', ['msg-42']);
    const c2 = r2[0].values[0][0];
    if (c2 !== 1) { console.error(`FAIL recordSkillTrigger dedup: expected 1, got ${c2}`); process.exit(1); }
    console.log('  ✓ recordSkillTrigger uses INSERT OR IGNORE (no double-count)');

    console.log('all tests passed');
    process.exit(0);
}

main().catch(e => { console.error('FAIL', e); process.exit(1); });
