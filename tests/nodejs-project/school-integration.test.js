#!/usr/bin/env node
// school-integration.test.js — end-to-end happy path on a seeded fixture.
// Structural invariants (no exact-count assertions — rubric is LLM-driven in
// real flow; here we exercise the deterministic plumbing only).

const path = require('path');
const fs = require('fs');
const os = require('os');
const { setupConfigFixture } = require('./_fixtures');

(async () => {
    // database.js transitively requires config.js which reads config.json or exits;
    // stand up a minimal fixture before requiring any school modules that touch db.
    setupConfigFixture('seekerclaw-school-int-');
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'school-int-'));
    process.env.WORKDIR = tmp;
    fs.mkdirSync(path.join(tmp, 'skills'));

    const SQL_PATH = path.join(__dirname, '../../app/src/main/assets/nodejs-project/sql-wasm.js');
    const SQL = await require(SQL_PATH)({ locateFile: f => path.join(path.dirname(SQL_PATH), f) });
    const db = new SQL.Database();
    const { createToolCallLogSchema, createSkillTriggerLogSchema } = require(
        path.join(__dirname, '../../app/src/main/assets/nodejs-project/database.js'));
    createToolCallLogSchema(db); createSkillTriggerLogSchema(db);

    const now = Date.now();
    // Seed strong-signal repetition across 3 days + filler to cross the
    // INSUFFICIENT_SIGNAL_MIN_CALLS=20 threshold.
    for (let i = 0; i < 5; i++) {
        db.run(`INSERT INTO tool_call_log (turn_id, tool_name, call_shape, result_status, latency_ms, created_at)
            VALUES ('t' || ?, 'shell_exec', 'shell_exec:calc', 'ok', 3, ?)`,
            [i, now - i * 24 * 3600 * 1000]);
    }
    for (let i = 0; i < 20; i++) {
        db.run(`INSERT INTO tool_call_log (turn_id, tool_name, call_shape, result_status, latency_ms, created_at)
            VALUES ('f' || ?, 'misc', 'misc:op', 'ok', 1, ?)`, [i, now - i * 1000]);
    }

    const { schoolBeginHandler, schoolEndHandler, schoolScanHandler, schoolWriteSkillHandler } = require(
        path.join(__dirname, '../../app/src/main/assets/nodejs-project/tools/school.js'));

    // 1. begin
    const bR = await schoolBeginHandler({ reason: 'on_demand' }, { workDir: tmp });
    if (!bR.ok) { console.error('FAIL begin', bR); process.exit(1); }
    console.log('  ✓ begin returns ok');

    // 2. scan
    const sR = await schoolScanHandler({ window_days: 7, min_repetition: 3 }, { workDir: tmp, db });
    if (!sR.ok || !sR.repeated_patterns || sR.repeated_patterns.length === 0) {
        console.error('FAIL scan — expected repeated_patterns', sR); process.exit(1);
    }
    console.log('  ✓ scan produces ≥ 1 repeated_pattern on strong-signal fixture');

    // 3. write a drafted skill (simulating YES approval)
    const writeR = await schoolWriteSkillHandler({
        mode: 'create', path: 'skills/calc-automation.md',
        body: `---\nname: calc-automation\ndescription: "Automate calc invocations"\nversion: "1.0.0"\n---\n\n# Calc Automation\n\nUse calc tool.\n`,
        evidence: 'shell_exec:calc × 5 across 3 days',
    }, { workDir: tmp });
    if (!writeR.ok) { console.error('FAIL write', writeR); process.exit(1); }
    const written = fs.readFileSync(path.join(tmp, 'skills/calc-automation.md'), 'utf8');
    if (!written.includes('source: school')) { console.error('FAIL missing source'); process.exit(1); }
    if (!written.includes('evidence:')) { console.error('FAIL missing evidence'); process.exit(1); }
    console.log('  ✓ written skill has school frontmatter marker');

    // 4. end
    const eR = await schoolEndHandler({
        session_id: bR.session_id,
        summary: { patterns_found: 1, proposals_made: 1, approved: [{ n: 1, type: 'create', title: 'calc-automation' }],
                   drafted_but_denied: [], skipped: [], ignored: [], rejected_by_rubric: [], rejected_as_duplicate: [] }
    }, { workDir: tmp });
    if (!eR.ok) { console.error('FAIL end', eR); process.exit(1); }
    if (fs.existsSync(path.join(tmp, 'SCHOOL.md'))) { console.error('FAIL SCHOOL.md not deleted'); process.exit(1); }
    const logLine = fs.readFileSync(path.join(tmp, 'school/log.jsonl'), 'utf8').trim();
    if (!logLine.includes(bR.session_id)) { console.error('FAIL log missing session_id'); process.exit(1); }
    console.log('  ✓ end appends log + deletes SCHOOL.md');

    // 5. Stale-session: re-begin with an already-stale SCHOOL.md (72h ago).
    // B11 auto-ends it and returns started_after_cleanup=true.
    const oldSession = Date.now() - 72 * 3600 * 1000;
    fs.writeFileSync(path.join(tmp, 'SCHOOL.md'),
        `---\nsession_id: stale-xyz\nstarted_at: ${oldSession}\ntrigger: on_demand\nstate: awaiting_approval\nwindow_days: 7\nopen_proposal_ns: [1]\nrubric_version: "1.0.0"\n---\n\n# Stale\n\n## Proposals\n[]\n`);
    const bR2 = await schoolBeginHandler({ reason: 'on_demand' }, { workDir: tmp });
    if (!bR2.ok) { console.error('FAIL begin on stale', bR2); process.exit(1); }
    if (!bR2.started_after_cleanup) { console.error('FAIL expected started_after_cleanup', bR2); process.exit(1); }
    console.log('  ✓ stale session auto-ends + seamless new session start');

    fs.rmSync(tmp, { recursive: true, force: true });
    console.log('all tests passed');
    process.exit(0);
})().catch(e => { console.error('FAIL', e); process.exit(1); });
