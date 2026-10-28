// shell-recipes.js — BAT-1409 P1-G drift guard helper: extracts every shell_exec example from the
// texts the agent reads (ai.js, DIAGNOSTICS.md, TEMPLATES.md, default-skills/*/SKILL.md, and the
// shell_exec tool description).
//
// Extraction rule (contract v3.2 P1-G): a backticked span, or any line inside any fenced block,
// whose first word is an allowlisted command. In JavaScript sources, also every double-quoted
// string on a line that mentions shell_exec (`shell_exec with "grep -i error node_debug.log"`).
// A line carrying <!-- not-shell-recipe --> is skipped (developer-machine commands, prose that
// names a command). <placeholders> and ${expressions} become a sample value.

'use strict';

const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..', '..');
const ASSETS = path.join(ROOT, 'app', 'src', 'main', 'assets');
const BUNDLE = path.join(ASSETS, 'nodejs-project');
const EXEMPT = '<!-- not-shell-recipe -->';

function sources() {
    const files = [
        path.join(BUNDLE, 'ai.js'),
        path.join(BUNDLE, 'tools', 'system.js'),
        path.join(BUNDLE, 'DIAGNOSTICS.md'),
        path.join(BUNDLE, 'TEMPLATES.md'),
    ];
    const skills = path.join(ASSETS, 'default-skills');
    for (const d of fs.readdirSync(skills)) {
        const f = path.join(skills, d, 'SKILL.md');
        if (fs.existsSync(f)) files.push(f);
    }
    return files.filter((f) => fs.existsSync(f));
}

function sample(name) {
    const n = name.toLowerCase();
    if (n.includes('scheme')) return 'https';
    if (n.includes('host')) return 'example.com';
    if (n.includes('url') || n.includes('base')) return 'https://example.com';
    if (n.includes('path') || n.includes('file')) return 'notes.txt';
    return 'sample';
}

function samplePlaceholders(s) {
    return s
        .replace(/\$\{([^}]+)\}/g, (_, name) => sample(name))
        .replace(/<([A-Za-z0-9_ .:/-]+)>/g, (_, name) => sample(name));
}

/** Returns [{ file, line, text }] for every recipe whose first word is in [allowlist]. */
function extractRecipes(allowlist, files = sources()) {
    const out = [];
    for (const file of files) {
        const isJs = file.endsWith('.js');
        const lines = fs.readFileSync(file, 'utf8').split(/\r?\n/);
        let inFence = false;
        lines.forEach((raw, i) => {
            if (/^\s*```/.test(raw)) { inFence = !inFence; return; }
            if (raw.includes(EXEMPT)) return;
            // JS comments quote refused commands on purpose; only the text the agent reads counts.
            if (isJs && /^\s*(\/\/|\*|\/\*)/.test(raw)) return;
            const candidates = [];
            if (inFence) candidates.push(raw.trim());
            for (const m of raw.matchAll(/`([^`\n]+)`/g)) candidates.push(m[1].trim());
            if (isJs && /shell_exec|One command to run/.test(raw)) {
                for (const m of raw.matchAll(/"([^"\n]+)"/g)) candidates.push(m[1].trim());
            }
            for (const c of candidates) {
                const first = c.split(/\s/)[0];
                if (!allowlist.has(first)) continue;
                if (c === first && !inFence) continue; // a bare command name in prose is not a recipe
                out.push({ file: path.relative(ROOT, file).replace(/\\/g, '/'), line: i + 1, text: samplePlaceholders(c) });
            }
        });
    }
    return out;
}

module.exports = { extractRecipes, sources, EXEMPT };
