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

    // Patch body that OMITS source: entirely must still have the original source
    // preserved (provenance contract). Previously the post-hoc regex replace
    // had nothing to match and source was silently dropped.
    fs.writeFileSync(path.join(tmp, 'skills/needs-source.md'),
        `---\nname: needs-source\nsource: user\nversion: "1.0.0"\n---\n\n# needs source\n`);
    const patchNoSrcRes = await schoolWriteSkillHandler({
        mode: 'patch', path: 'skills/needs-source.md',
        body: `---\nname: needs-source\nversion: "1.0.0"\n---\n\n# updated body\n`,
        evidence: 'refactor',
    }, { workDir: tmp });
    if (!patchNoSrcRes.ok) { console.error('FAIL patch-no-src', patchNoSrcRes); process.exit(1); }
    const patchedNoSrc = fs.readFileSync(path.join(tmp, 'skills/needs-source.md'), 'utf8');
    if (!patchedNoSrc.includes('source: user')) {
        console.error('FAIL: patch-no-src must still inject source: user, got:\n', patchedNoSrc); process.exit(1);
    }
    console.log('  ✓ school_write_skill (patch) injects source when body omits it');

    // Test nested frontmatter preservation: requires: block + allowed-tools: list
    // must survive a patch operation (issue: old code dropped nested YAML).
    const nestedSkillBody = `---
name: my-skill
source: user
version: "1.0.0"
requires:
  bins: []
  env:
    - OPENAI_KEY
allowed-tools:
  - file_read
  - web_fetch
---

# My Skill

Instructions.
`;
    fs.writeFileSync(path.join(tmp, 'skills/nested-fm.md'), nestedSkillBody);
    const nestedPatchRes = await schoolWriteSkillHandler({
        mode: 'patch', path: 'skills/nested-fm.md',
        body: nestedSkillBody,  // Same shape, triggers injection of last_patched_by
        evidence: 'fixing X',
    }, { workDir: tmp });
    if (!nestedPatchRes.ok) { console.error('FAIL nested patch', nestedPatchRes); process.exit(1); }
    const nestedPatched = fs.readFileSync(path.join(tmp, 'skills/nested-fm.md'), 'utf8');

    // Assert: requires block is still present
    if (!/\nrequires:\n {2}bins:/m.test(nestedPatched)) {
        console.error('FAIL: requires: block was dropped in nested patch, got:\n', nestedPatched); process.exit(1);
    }
    // Assert: allowed-tools list items are still present
    if (!nestedPatched.includes('- file_read')) {
        console.error('FAIL: allowed-tools list item "file_read" was dropped'); process.exit(1);
    }
    if (!nestedPatched.includes('- web_fetch')) {
        console.error('FAIL: allowed-tools list item "web_fetch" was dropped'); process.exit(1);
    }
    // Assert: source: user still present
    if (!nestedPatched.includes('source: user')) {
        console.error('FAIL: source: user was not preserved in nested patch'); process.exit(1);
    }
    // Assert: last_patched_by: school was added
    if (!nestedPatched.includes('last_patched_by: school')) {
        console.error('FAIL: last_patched_by: school was not added'); process.exit(1);
    }
    console.log('  ✓ school_write_skill (patch) preserves nested YAML blocks and list items');

    // Evidence with YAML-hostile chars (newlines, colons, #) must be quoted so the
    // frontmatter stays parseable by readSchoolMd's simple regex.
    const nastyRes = await schoolWriteSkillHandler({
        mode: 'create', path: 'skills/nasty.md',
        body: `---\nname: nasty\ndescription: "nasty"\nversion: "1.0.0"\n---\n\n# nasty\n`,
        evidence: 'user: said\nfoo: bar # not-a-key',
    }, { workDir: tmp });
    if (!nastyRes.ok) { console.error('FAIL nasty', nastyRes); process.exit(1); }
    const nastyText = fs.readFileSync(path.join(tmp, 'skills/nasty.md'), 'utf8');
    const nastyFm = nastyText.match(/^---\n([\s\S]+?)\n---/)[1];
    const evLine = nastyFm.split('\n').find(l => l.startsWith('evidence:'));
    if (!evLine || !evLine.startsWith('evidence: "')) {
        console.error('FAIL: nasty evidence must be quoted, got:', evLine); process.exit(1);
    }
    if (nastyFm.split('\n').some(l => l.startsWith('foo:'))) {
        console.error('FAIL: nasty evidence injected a phantom foo: key'); process.exit(1);
    }
    console.log('  ✓ school_write_skill quotes YAML-hostile evidence');

    // ========== B6 Assertions (school_retire_skill + school_handle_input + school_scan) ==========
    fs.writeFileSync(path.join(tmp, 'skills/to-retire.md'),
        `---\nname: to-retire\nsource: school\n---\n\n# gone\n`);
    const { schoolRetireSkillHandler, schoolHandleInputHandler } = require(
        path.join(__dirname, '../../app/src/main/assets/nodejs-project/tools/school.js')
    );
    const retRes = await schoolRetireSkillHandler({ path: 'skills/to-retire.md', reason: 'unused' }, { workDir: tmp });
    if (!retRes.ok) { console.error('FAIL retire', retRes); process.exit(1); }
    if (fs.existsSync(path.join(tmp, 'skills/to-retire.md'))) { console.error('FAIL: file not moved'); process.exit(1); }
    const retiredFiles = fs.readdirSync(path.join(tmp, 'school/retired'));
    if (!retiredFiles.some(f => f.includes('to-retire.md'))) { console.error('FAIL: no retired file found'); process.exit(1); }
    console.log('  ✓ school_retire_skill moves to retired/ reversibly');

    // Seed SCHOOL.md in the state the handler will read from. After B4's /end
    // earlier in this test, SCHOOL.md was deleted — reseed for the handler test.
    const { writeSchoolMd: _writeSchoolMd } = require(
        path.join(__dirname, '../../app/src/main/assets/nodejs-project/school.js')
    );
    _writeSchoolMd(tmp, {
        session_id: 'hi-test', started_at: 1000, trigger: 'on_demand',
        state: 'reviewing_<N>', window_days: 7, open_proposal_ns: [3],
        reviewing_n: 3, reviewing_opened_at: 1000, rubric_version: '1.0.0',
        proposals: [],
    });
    const hiRes = await schoolHandleInputHandler({
        session_id: 'hi-test',
        state: { kind: 'reviewing_<N>', reviewing_n: 3, open_proposal_ns: [3], reviewing_opened_at: 1000 },
        input: { kind: 'yes', proposal_n: 3, message_date: 1020, raw_text: 'YES 3' }
    }, { workDir: tmp });
    if (!hiRes.ok || hiRes.next_action.kind !== 'write_skill') { console.error('FAIL handle_input yes', hiRes); process.exit(1); }
    console.log('  ✓ school_handle_input returns write_skill next_action on YES');

    // Verify state was persisted back to SCHOOL.md. YES on the only open
    // proposal transitions to `done` with empty open_proposal_ns.
    const { readSchoolMd: _readSchoolMd } = require(
        path.join(__dirname, '../../app/src/main/assets/nodejs-project/school.js')
    );
    const fmAfter = _readSchoolMd(tmp);
    if (!fmAfter || fmAfter.state !== 'done') {
        console.error('FAIL handle_input must persist new state=done, got:', fmAfter && fmAfter.state); process.exit(1);
    }
    if (fmAfter.open_proposal_ns.length !== 0) {
        console.error('FAIL handle_input must drain open_proposal_ns, got:', fmAfter.open_proposal_ns); process.exit(1);
    }
    console.log('  ✓ school_handle_input persists new state back to SCHOOL.md');

    // No-session safety: delete SCHOOL.md + omit args.state; expect clean error.
    try { fs.unlinkSync(path.join(tmp, 'SCHOOL.md')); } catch (_) {}
    const hiNoSessRes = await schoolHandleInputHandler({
        session_id: 'no-sess', input: { kind: 'yes', message_date: 1 }
    }, { workDir: tmp });
    if (hiNoSessRes.ok || hiNoSessRes.error !== 'no_session_state') {
        console.error('FAIL no-session handle_input must return no_session_state, got:', hiNoSessRes); process.exit(1);
    }
    console.log('  ✓ school_handle_input rejects when no SCHOOL.md + no args.state');
})().catch(e => { console.error('FAIL', e); process.exit(1); }).finally(() => {
    try { fs.rmSync(tmp, { recursive: true, force: true }); } catch (_) {}
    if (fails > 0) process.exit(1);
    console.log('all tests passed');
    process.exit(0);
});
