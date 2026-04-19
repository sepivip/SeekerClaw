#!/usr/bin/env node
// school-tools.test.js — tool handler behavior.
// Run: node tests/nodejs-project/school-tools.test.js

const path = require('path');
const fs = require('fs');
const os = require('os');

let fails = 0;
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'school-tools-'));
process.env.WORKDIR = tmp;

(async () => {
    const { schoolBeginHandler, schoolEndHandler } = require(
        path.join(__dirname, '../../app/src/main/assets/nodejs-project/tools/school.js')
    );

    const beginRes = await schoolBeginHandler({ reason: 'on_demand' }, { workDir: tmp });
    if (!beginRes.ok || !beginRes.session_id) { console.error('FAIL begin fresh', beginRes); process.exit(1); }
    console.log('  ✓ school_begin creates new session + SCHOOL.md');

    const sch = fs.readFileSync(path.join(tmp, 'SCHOOL.md'), 'utf8');
    if (!sch.includes(beginRes.session_id)) { console.error('FAIL SCHOOL.md missing session_id'); process.exit(1); }
    console.log('  ✓ SCHOOL.md contains session_id');

    const beginRes2 = await schoolBeginHandler({ reason: 'on_demand' }, { workDir: tmp });
    if (beginRes2.ok && !beginRes2.resumed) { console.error('FAIL: expected concurrent-session return', beginRes2); process.exit(1); }
    console.log('  ✓ school_begin detects existing SCHOOL.md (resumed or rejected)');

    const endRes = await schoolEndHandler({
        session_id: beginRes.session_id,
        summary: { patterns_found: 0, proposals_made: 0, approved: [], drafted_but_denied: [], skipped: [], ignored: [], rejected_by_rubric: [], rejected_as_duplicate: [] }
    }, { workDir: tmp });
    if (!endRes.ok) { console.error('FAIL end', endRes); process.exit(1); }
    if (fs.existsSync(path.join(tmp, 'SCHOOL.md'))) { console.error('FAIL: SCHOOL.md not deleted after end'); process.exit(1); }
    console.log('  ✓ school_end deletes SCHOOL.md');

    const logPath = path.join(tmp, 'school', 'log.jsonl');
    const logContent = fs.readFileSync(logPath, 'utf8').trim();
    const parsed = JSON.parse(logContent);
    if (parsed.session_id !== beginRes.session_id) { console.error('FAIL: log entry session_id mismatch'); process.exit(1); }
    console.log('  ✓ school_end appends log.jsonl entry');
})().catch(e => { console.error('FAIL', e); process.exit(1); }).finally(() => {
    try { fs.rmSync(tmp, { recursive: true, force: true }); } catch (_) {}
    if (fails > 0) process.exit(1);
    console.log('all tests passed');
    process.exit(0);
});
