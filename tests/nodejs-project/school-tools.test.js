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

    // ========== B5 Assertions (school_write_skill) ==========
    const { schoolWriteSkillHandler } = require(
        path.join(__dirname, '../../app/src/main/assets/nodejs-project/tools/school.js')
    );

    const createRes = await schoolWriteSkillHandler({
        mode: 'create',
        path: 'skills/recipe-scaling.md',
        body: `---\nname: recipe-scaling\ndescription: "Scale recipes"\nversion: "1.0.0"\n---\n\n# Recipe Scaling\n\nInstructions.\n`,
        evidence: 'user asked 4x since Apr 13',
    }, { workDir: tmp });
    if (!createRes.ok) { console.error('FAIL create', createRes); process.exit(1); }
    const written = fs.readFileSync(path.join(tmp, 'skills/recipe-scaling.md'), 'utf8');
    if (!written.includes('source: school')) { console.error('FAIL: missing source: school marker'); process.exit(1); }
    if (!written.includes('evidence:')) { console.error('FAIL: missing evidence field'); process.exit(1); }
    console.log('  ✓ school_write_skill (create) injects school frontmatter marker');

    const traversalRes = await schoolWriteSkillHandler({
        mode: 'create', path: '../evil.md', body: `---\nname: evil\n---\n\n# evil\n`, evidence: 'x',
    }, { workDir: tmp });
    if (traversalRes.ok) { console.error('FAIL: traversal should be rejected'); process.exit(1); }
    console.log('  ✓ school_write_skill rejects path traversal');

    const huge = 'A'.repeat(70 * 1024);
    const overRes = await schoolWriteSkillHandler({
        mode: 'create', path: 'skills/too-big.md',
        body: `---\nname: too-big\n---\n\n# too-big\n${huge}`,
        evidence: 'x',
    }, { workDir: tmp });
    if (overRes.ok) { console.error('FAIL: oversize should be rejected'); process.exit(1); }
    console.log('  ✓ school_write_skill rejects > 64KB');

    fs.mkdirSync(path.join(tmp, 'skills'), { recursive: true });
    fs.writeFileSync(path.join(tmp, 'skills/user-authored.md'),
        `---\nname: user-authored\nsource: user\nversion: "1.0.0"\n---\n\n# user\n`);
    const patchRes = await schoolWriteSkillHandler({
        mode: 'patch', path: 'skills/user-authored.md',
        body: `---\nname: user-authored\nsource: user\nversion: "1.0.0"\n---\n\n# user patched\n`,
        evidence: 'fix',
    }, { workDir: tmp });
    if (!patchRes.ok) { console.error('FAIL patch', patchRes); process.exit(1); }
    const patched = fs.readFileSync(path.join(tmp, 'skills/user-authored.md'), 'utf8');
    if (!patched.includes('source: user')) { console.error('FAIL: patch must preserve source: user'); process.exit(1); }
    if (!patched.includes('last_patched_by: school')) { console.error('FAIL: patch must add last_patched_by'); process.exit(1); }
    console.log('  ✓ school_write_skill (patch) preserves source + adds last_patched_by');
})().catch(e => { console.error('FAIL', e); process.exit(1); }).finally(() => {
    try { fs.rmSync(tmp, { recursive: true, force: true }); } catch (_) {}
    if (fails > 0) process.exit(1);
    console.log('all tests passed');
    process.exit(0);
});
