#!/usr/bin/env node
// shell-recipes.test.js — BAT-1409 P1-G drift guard. Every shell_exec example the agent reads
// (ai.js, DIAGNOSTICS.md, TEMPLATES.md, default-skills/*/SKILL.md) must pass the FULL validator:
// tokenizer, allowlist, grammar and workspace path rule. A recipe that is not a shell_exec
// command carries <!-- not-shell-recipe --> on its line.
//
// Run:  node tests/nodejs-project/shell-recipes.test.js

'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const BUNDLE = path.resolve(__dirname, '..', '..', 'app', 'src', 'main', 'assets', 'nodejs-project');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'p1g-recipes-'));
const ws = path.join(tmp, 'workspace');
fs.mkdirSync(ws);
fs.writeFileSync(path.join(ws, 'config.json'), JSON.stringify({ botToken: 'placeholder', anthropicApiKey: 'placeholder', ownerId: '1', channel: 'telegram' }));
process.argv[2] = ws;
process.on('exit', () => { try { fs.rmSync(tmp, { recursive: true, force: true }); } catch (_) {} });

const cfg = require(path.join(BUNDLE, 'config.js'));
const { tokenize } = require(path.join(BUNDLE, 'tools', 'shell-args.js'));
const { validateArgv } = require(path.join(BUNDLE, 'tools', 'shell-validate.js'));
const { extractRecipes } = require('./shell-recipes');

const ctx = {
    workDir: ws,
    cwd: ws,
    names: { ROOT_SECRET_NAMES: cfg.ROOT_SECRET_NAMES, SECRETS_ANYWHERE: cfg.SECRETS_ANYWHERE, WRITE_PROTECTED_ROOT: cfg.WRITE_PROTECTED_ROOT },
    agentSettingsFile: 'agent_settings.json',
    lookup: async () => ['93.184.216.34'],
};

async function passes(text) {
    try {
        await validateArgv(tokenize(text).argv, ctx);
        return true;
    } catch (_) {
        return false;
    }
}

(async () => {
    // Negative control for the whole guard: a synthetic file with a fenced recipe, a backticked
    // one and a quoted JS example, each refused by the validator, must all be extracted and fail.
    const probe = path.join(tmp, 'probe.js');
    fs.writeFileSync(probe, [
        "lines.push('use shell_exec with \"cat ../outside/secret\"');",
        '```',
        'grep -i x node_debug.log | tail -5',
        '```',
        'Run `cp -r a b` to copy.',
        'Ignore this `adb logcat | grep x` <!-- not-shell-recipe -->',
    ].join('\n'));
    const probed = extractRecipes(cfg.SHELL_ALLOWLIST, [probe]);
    assert.deepStrictEqual(probed.map((r) => r.text), ['cat ../outside/secret', 'grep -i x node_debug.log | tail -5', 'cp -r a b']);
    for (const r of probed) assert.ok(!(await passes(r.text)), 'the validator must refuse: ' + r.text);

    const recipes = extractRecipes(cfg.SHELL_ALLOWLIST);
    assert.ok(recipes.some((r) => r.file.endsWith('tools/system.js')), 'the tool description examples are covered');
    assert.ok(recipes.some((r) => r.text === 'grep -i error node_debug.log'), "ai.js's quoted shell_exec examples are covered");
    // Negative control for the extractor: the corpus is not empty and covers both sources.
    assert.ok(recipes.length >= 20, `only ${recipes.length} recipes extracted`);
    assert.ok(recipes.some((r) => r.file.endsWith('DIAGNOSTICS.md')) && recipes.some((r) => r.file.endsWith('ai.js')));
    const bad = [];
    for (const r of recipes) {
        try {
            const { argv } = tokenize(r.text);
            await validateArgv(argv, ctx);
        } catch (e) {
            bad.push(`${r.file}:${r.line}  ${r.text}\n      → ${e.message}`);
        }
    }
    if (bad.length) {
        console.log(`FAIL: ${bad.length} of ${recipes.length} recipes do not pass the shell_exec validator:\n  ` + bad.join('\n  '));
        process.exit(1);
    }
    console.log(`PASS: all ${recipes.length} shell recipes pass the shell_exec validator`);
    process.exit(0);
})();
