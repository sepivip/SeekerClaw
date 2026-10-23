#!/usr/bin/env node
// module-paths-preamble.test.js — BAT-1409 P1-B. main.js's first statements rebuild Node's global
// module search list without HOME, USERPROFILE and NODE_PATH, so a module planted in
// $HOME/.node_modules, $HOME/.node_libraries or NODE_PATH can never resolve.
//
// Tested by behaviour, not by inspecting Module.globalPaths (an introspection copy): the REAL
// preamble text is cut out of main.js and run in a child process with planted modules, next to a
// negative control that runs without it.
//
// Run:  node tests/nodejs-project/module-paths-preamble.test.js

'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const MAIN = path.join(__dirname, '..', '..', 'app', 'src', 'main', 'assets', 'nodejs-project', 'main.js');
const START = '// --- BAT-1409 P1-B preamble';
const END = '// --- end BAT-1409 P1-B preamble ---';

let failures = 0;
function ok(label, cond) {
    if (cond) console.log('PASS: ' + label);
    else { console.log('FAIL: ' + label); failures++; }
}

const src = fs.readFileSync(MAIN, 'utf8');
const a = src.indexOf(START);
const b = src.indexOf(END);
assert(a >= 0 && b > a, 'main.js must carry the P1-B preamble markers');
const preamble = src.slice(a, b + END.length);

// The preamble must come before every require in main.js.
const firstRequire = src.search(/\brequire\(/);
ok('preamble precedes every require in main.js', firstRequire > a && src.indexOf("require('module')") === firstRequire);
ok('Module._initPaths exists on this Node (the preamble depends on it)', typeof require('module')._initPaths === 'function');

// Planted modules: one per global search location.
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'p1b-'));
const home = path.join(tmp, 'home');
const nodePath = path.join(tmp, 'node-path');
function plant(dir, name) {
    fs.mkdirSync(path.join(dir, name), { recursive: true });
    fs.writeFileSync(path.join(dir, name, 'index.js'), `module.exports = '${name}';\n`);
}
plant(path.join(home, '.node_modules'), 'p1b-home-modules');
plant(path.join(home, '.node_libraries'), 'p1b-home-libraries');
plant(nodePath, 'p1b-node-path');
const cwd = path.join(tmp, 'cwd'); // no node_modules anywhere under it
fs.mkdirSync(cwd);

const probe = `
const out = {};
for (const n of ['p1b-home-modules', 'p1b-home-libraries', 'p1b-node-path']) {
    try { require(n); out[n] = true; } catch (e) { out[n] = e.code; }
}
out.home = process.env.HOME;
out.ws = [process.env.WS_NO_BUFFER_UTIL, process.env.WS_NO_UTF_8_VALIDATE];
process.stdout.write(JSON.stringify(out));
`;

function runChild(code) {
    const env = { ...process.env, HOME: home, USERPROFILE: home, NODE_PATH: nodePath };
    delete env.WS_NO_BUFFER_UTIL;
    delete env.WS_NO_UTF_8_VALIDATE;
    const r = spawnSync(process.execPath, ['-e', code], { cwd, env, encoding: 'utf8' });
    if (r.status !== 0) throw new Error('child failed: ' + r.stderr);
    return JSON.parse(r.stdout);
}

try {
    // Negative control: without the preamble every planted module resolves (POSIX resolves the
    // $HOME paths; Windows uses USERPROFILE, which is set to the same directory).
    const control = runChild(probe);
    ok('control: $HOME/.node_modules resolves without the preamble', control['p1b-home-modules'] === true);
    ok('control: $HOME/.node_libraries resolves without the preamble', control['p1b-home-libraries'] === true);
    ok('control: NODE_PATH resolves without the preamble', control['p1b-node-path'] === true);

    const guarded = runChild(preamble + '\n' + probe);
    ok('preamble: $HOME/.node_modules does not resolve', guarded['p1b-home-modules'] === 'MODULE_NOT_FOUND');
    ok('preamble: $HOME/.node_libraries does not resolve', guarded['p1b-home-libraries'] === 'MODULE_NOT_FOUND');
    ok('preamble: NODE_PATH does not resolve', guarded['p1b-node-path'] === 'MODULE_NOT_FOUND');
    ok('preamble: HOME is restored', guarded.home === home);
    ok('preamble: ws native helpers are switched off', guarded.ws[0] === '1' && guarded.ws[1] === '1');
} finally {
    fs.rmSync(tmp, { recursive: true, force: true });
}

if (failures > 0) {
    console.log(`\n${failures} failure(s)`);
    process.exit(1);
}
console.log('\nAll module-path preamble checks passed.');
