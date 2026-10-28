#!/usr/bin/env node
// cap-raise-hints.test.js — BAT-1409 P1-I drift guard. Raising burner caps is Settings-only, so no
// text the agent reads may tell it to raise a cap with wallet_set_caps, and every message that talks
// about raising a cap points to Settings. Covers the bundle's JS sources, DIAGNOSTICS.md, TEMPLATES.md
// and every bundled SKILL.md. Negative control: a synthetic offending line is detected.
//
// Run:  node tests/nodejs-project/cap-raise-hints.test.js

'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..', '..');
const ASSETS = path.join(ROOT, 'app', 'src', 'main', 'assets');
const BUNDLE = path.join(ASSETS, 'nodejs-project');

function files() {
    const out = [];
    const walk = (dir) => {
        for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
            if (e.name === 'node_modules') continue;
            const p = path.join(dir, e.name);
            if (e.isDirectory()) walk(p);
            else if (/\.(js|md)$/.test(e.name)) out.push(p);
        }
    };
    walk(BUNDLE);
    walk(path.join(ASSETS, 'default-skills'));
    return out;
}

/** Lines that offer raising a cap through the tool, or mention a raise without the Settings pointer. */
function offending(text, isJs = true) {
    const bad = [];
    text.split(/\r?\n/).forEach((line, i) => {
        // JS comments are for maintainers, not the agent (a Markdown bullet starting with * is text).
        if (isJs && /^\s*(\/\/|\*|\/\*)/.test(line)) return;
        const mentionsRaise = /\braise[sd]?\b/i.test(line) && /\bcaps?\b/i.test(line);
        if (!mentionsRaise) return;
        const viaTool = /raise[sd]?[^.]{0,60}wallet_set_caps|wallet_set_caps[^.]{0,40}\braise/i.test(line);
        const pointsToSettings = /Settings\s*(→|->|>)\s*Burner Wallet/.test(line) || /CAP_RAISE_HINT/.test(line);
        if (viaTool && !/cannot raise|can only lower|refuses any raise|Do not call `wallet_set_caps` for a raise|is refused/i.test(line)) bad.push(i + 1);
        else if (!pointsToSettings && !/cannot raise|Settings-only|raised|cap_raise_settings_only|NoRaise|noRaise|no-raise/i.test(line)) bad.push(i + 1);
    });
    return bad;
}

let failures = 0;
// Negative control: the detector flags the pre-P1-I wording.
assert.deepStrictEqual(offending("reason: 'Raise the cap with wallet_set_caps, or use main.'"), [1]);
assert.deepStrictEqual(offending('Tell the user to raise the cap, or wait.'), [1]);
assert.deepStrictEqual(offending('Raising caps is only possible in the SeekerClaw app: Settings → Burner Wallet.'), []);

for (const f of files()) {
    const bad = offending(fs.readFileSync(f, 'utf8'), f.endsWith('.js'));
    if (bad.length) {
        failures++;
        console.log(`FAIL: ${path.relative(ROOT, f)} lines ${bad.join(', ')} mention raising a cap without the Settings pointer`);
    }
}
// The wallet_set_caps tool description (read by the model every turn) states the rule and its code.
const configPath = require.resolve(path.join(BUNDLE, 'config.js'));
require.cache[configPath] = { id: configPath, filename: configPath, loaded: true, exports: { log: () => {} } };
const bridgePath = require.resolve(path.join(BUNDLE, 'bridge.js'));
require.cache[bridgePath] = { id: bridgePath, filename: bridgePath, loaded: true, exports: { androidBridgeCall: async () => ({}) } };
const walletTool = require(path.join(BUNDLE, 'tools', 'wallet.js')).tools.find((t) => t.name === 'wallet_set_caps');
assert.ok(walletTool.description.includes('Settings → Burner Wallet'), 'wallet_set_caps description must point to Settings');
assert.ok(walletTool.description.includes('cap_raise_settings_only'), 'wallet_set_caps description must list cap_raise_settings_only');
assert.ok(!/^Update burner wallet spending caps/.test(walletTool.description), 'the description must not offer raises');
const hint = require(path.join(BUNDLE, 'wallet', 'cap-hint.js')).CAP_RAISE_HINT;
assert.strictEqual(hint, 'Raising caps is only possible in the SeekerClaw app: Settings → Burner Wallet.');
if (failures) process.exit(1);
console.log('PASS: every cap-raise hint points to Settings → Burner Wallet');
