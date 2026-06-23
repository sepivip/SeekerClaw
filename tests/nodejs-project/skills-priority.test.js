// tests/nodejs-project/skills-priority.test.js
//
// BAT-1035: generic skill `priority` frontmatter + the two-skill-cap selection
// (collect → sort by priority DESC, load order ASC → slice 2).
//
// Covers:
//   - parseSkillPriority: default 0, integer parse, non-numeric/NaN/Infinity→0,
//     clamp to [-100,100], truncate toward zero.
//   - selectMatchingSkills: backward-compat (two priority-0 skills unchanged),
//     3-match retention (an authorized higher-priority skill survives the cap
//     REGARDLESS of directory load order — the original bug class), and
//     deterministic tie order (equal priority → load order ASC).
//   - paysh-catalog drift guard: exact 8 narrow triggers + priority 10 +
//     version 1.9.0, and no service-name / dropped-phrase triggers.

'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');

const BUNDLE = path.resolve(__dirname, '..', '..', 'app', 'src', 'main', 'assets', 'nodejs-project');

// config.js calls process.exit(1) at module load when no runtime config file is
// present (and again if API keys / owner are missing), so skills.js — which
// `require('./config')` at the top — cannot be loaded directly in a bare-node
// unit test. Stub config in the require cache BEFORE loading skills.js. The
// functions under test (parseSkillFile / parseSkillPriority /
// selectMatchingSkills) are pure and never read config at runtime.
const configPath = require.resolve(path.join(BUNDLE, 'config.js'));
require.cache[configPath] = {
    id: configPath,
    filename: configPath,
    loaded: true,
    exports: {
        SKILLS_DIR: path.join(BUNDLE, '..', 'default-skills'),
        log: () => {},
        config: {},
        // skills.js uses SHELL_ALLOWLIST.has(...) in requirements gating —
        // keep the stub shape accurate (a Set, not an Array) even though the
        // functions under test do not exercise that path.
        SHELL_ALLOWLIST: new Set(),
    },
};

const skills = require(path.join(BUNDLE, 'skills.js'));
const { parseSkillFile, parseSkillPriority, selectMatchingSkills } = skills;

let pass = 0, fail = 0;
function check(name, fn) {
    try { fn(); pass++; console.log(`  ✓ ${name}`); }
    catch (e) { fail++; console.error(`  ✗ ${name}: ${e.message}`); if (process.env.VERBOSE) console.error(e.stack); }
}

// A SKILL.md string with an optional `priority:` frontmatter line.
function skillMd({ name = 'x', priority, triggers = ['zzz'] }) {
    const pr = priority === undefined ? '' : `priority: ${priority}\n`;
    const tr = triggers.map(t => `  - "${t}"`).join('\n');
    return `---\nname: ${name}\ndescription: "d"\nversion: "1.0.0"\n${pr}triggers:\n${tr}\n---\n\n# ${name}\n\n## Instructions\nx\n`;
}
// A synthetic in-memory skill (the shape selectMatchingSkills consumes).
function mkSkill(name, priority, triggers) {
    return { name, priority, triggers, description: '', instructions: '' };
}

console.log('skills-priority.test.js — BAT-1035 generic priority + 2-skill cap');
console.log();

check('priority defaults to 0 when frontmatter omits it', () => {
    const s = parseSkillFile(skillMd({ name: 'a' }), '/tmp/a');
    assert.strictEqual(s.priority, 0);
});

check('priority parsed as integer when present', () => {
    const s = parseSkillFile(skillMd({ name: 'a', priority: 10 }), '/tmp/a');
    assert.strictEqual(s.priority, 10);
});

check('non-numeric / NaN / Infinity / null priority → 0', () => {
    assert.strictEqual(parseSkillPriority('abc'), 0);
    assert.strictEqual(parseSkillPriority(NaN), 0);
    assert.strictEqual(parseSkillPriority(Infinity), 0);
    assert.strictEqual(parseSkillPriority(-Infinity), 0);
    assert.strictEqual(parseSkillPriority(undefined), 0);
    assert.strictEqual(parseSkillPriority(null), 0);
    const s = parseSkillFile(skillMd({ name: 'a', priority: 'notanumber' }), '/tmp/a');
    assert.strictEqual(s.priority, 0);
});

check('priority clamps to [-100, 100] and truncates toward zero', () => {
    assert.strictEqual(parseSkillPriority(1000), 100);
    assert.strictEqual(parseSkillPriority(-1000), -100);
    assert.strictEqual(parseSkillPriority(100), 100);
    assert.strictEqual(parseSkillPriority(-100), -100);
    assert.strictEqual(parseSkillPriority(10.9), 10);
    assert.strictEqual(parseSkillPriority(-10.9), -10);
    assert.strictEqual(parseSkillPriority('50'), 50);
});

check('backward-compat: two priority-0 skills → kept in load order, capped at 2', () => {
    const list = [mkSkill('a', 0, ['alpha']), mkSkill('b', 0, ['alpha']), mkSkill('c', 0, ['alpha'])];
    const r = selectMatchingSkills(list, 'please alpha now');
    assert.deepStrictEqual(r.map(s => s.name), ['a', 'b'], 'unchanged 2-cap by load order when no priority set');
});

check('3-match retention: priority-10 skill survives the cap REGARDLESS of load order', () => {
    const high = mkSkill('high', 10, ['alpha']);
    const lo1 = mkSkill('lo1', 0, ['alpha']);
    const lo2 = mkSkill('lo2', 0, ['alpha']);
    // high LAST in load order — the old early-break dropped it; new code keeps it.
    const rA = selectMatchingSkills([lo1, lo2, high], 'alpha');
    assert.deepStrictEqual(rA.map(s => s.name), ['high', 'lo1'],
        'high-priority skill kept at index 0; earliest priority-0 skill takes the 2nd slot');
    // high FIRST — still kept (proves it is priority, not luck).
    const rB = selectMatchingSkills([high, lo1, lo2], 'alpha');
    assert.deepStrictEqual(rB.map(s => s.name), ['high', 'lo1']);
});

check('equal-priority skills keep load order (deterministic tie)', () => {
    const list = [mkSkill('first', 5, ['alpha']), mkSkill('second', 5, ['alpha']), mkSkill('third', 5, ['alpha'])];
    const r = selectMatchingSkills(list, 'alpha');
    assert.deepStrictEqual(r.map(s => s.name), ['first', 'second']);
});

check('paysh-catalog SKILL.md drift: exact 8 triggers + priority 10 + version 1.9.0, no service-name/dropped triggers', () => {
    const p = path.join(BUNDLE, '..', 'default-skills', 'paysh-catalog', 'SKILL.md');
    const content = fs.readFileSync(p, 'utf8');
    const s = parseSkillFile(content, path.dirname(p));
    assert.strictEqual(s.priority, 10, 'paysh-catalog priority must be 10');
    assert.strictEqual(s.version, '1.9.0', 'paysh-catalog version must be 1.9.0');
    const expected = ['pay.sh', 'paysh', 'x402', 'pay with burner', 'pay for', 'what can you pay for', 'show me pay.sh services', 'list paid services'];
    assert.deepStrictEqual(s.triggers, expected, `triggers must be exactly the 8 narrow set; got ${JSON.stringify(s.triggers)}`);
    for (const bad of ['purch', 'tripadvisor', 'perplexity', 'reducto', 'rentcast', '2captcha', 'pay with main', 'pay to']) {
        assert.ok(!s.triggers.includes(bad), `forbidden/service trigger "${bad}" must NOT be present`);
    }
});

console.log();
console.log(`Result: ${pass} passed, ${fail} failed`);
if (fail > 0) { console.error('FAIL: skills-priority.test.js'); process.exit(1); }
console.log('PASS: skills-priority.test.js');
