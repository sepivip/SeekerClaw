#!/usr/bin/env node
// shell-args-mksh.test.js — BAT-1409 P1-G differential test. shell_exec runs argv without a shell,
// so what was validated is what runs; this test pins that the tokenizer also splits words the way
// Android's shell (mksh) does, so a command means what its author expects. Corpus: every bundled
// recipe plus the quoting forms the tokenizer accepts. CI installs mksh; without it, it skips.
// The device phase repeats this against /system/bin/sh.
//
// Run:  node tests/nodejs-project/shell-args-mksh.test.js

'use strict';

const assert = require('assert');
const { spawnSync } = require('child_process');
const path = require('path');

const BUNDLE = path.resolve(__dirname, '..', '..', 'app', 'src', 'main', 'assets', 'nodejs-project');
const { tokenize } = require(path.join(BUNDLE, 'tools', 'shell-args.js'));
const { extractRecipes } = require('./shell-recipes');

const probe = spawnSync('mksh', ['-c', 'echo ok'], { encoding: 'utf8' });
if (probe.error || probe.stdout.trim() !== 'ok') {
    // CI sets REQUIRE_MKSH=1 (it installs mksh), so a missing shell fails there instead of passing.
    if (process.env.REQUIRE_MKSH === '1') {
        console.log('FAIL: mksh is required (REQUIRE_MKSH=1) but not installed');
        process.exit(1);
    }
    console.log('SKIP: mksh is not installed (CI installs it)');
    process.exit(0);
}

const FORMS = [
    `grep -iE "a|b" 'c d' e\\ f ""`,
    `echo "x\\"y" 'it''s' "\\q" "\\\\" "a\\$b"`,
    'echo a"b"c\'d\'e',
    `sed -e 's/a b/c/g' -e "/x y/d" notes.txt`,
    `curl -H "Accept: application/json" -d '{"a":1}' https://example.com/x`,
    `find . -name '*.md' -type f`,
    'echo "#x" "a;b" "*" "(y)" "!z" "^w" "~v" "[u]"',
    'echo -n \t tabs\t "and  spaces"',
    `grep -c "" notes.txt`,
];

function mkshArgv(line) {
    // Replace the command word with a dumper: mksh parses the rest exactly as it would for the
    // real command, and prints each resulting word NUL-terminated.
    const rest = line.slice(line.split(/[ \t]/)[0].length);
    const script = `dump() { for a in "$@"; do printf '%s\\0' "$a"; done; }; dump${rest}`;
    const r = spawnSync('mksh', ['-c', script], { encoding: 'utf8' });
    if (r.status !== 0) throw new Error('mksh failed: ' + r.stderr);
    const out = r.stdout.split('\0');
    out.pop();
    return out;
}

// The harness itself: mksh's dump must split a known line into exactly these words. (In a template
// literal `\ ` is just a space, so the escaped space is written `\\ `, as in FORMS.)
assert.deepStrictEqual(mkshArgv(`x "a b" c '' d\\ e`), ['a b', 'c', '', 'd e']);

let failures = 0;
const corpus = [...extractRecipes(new Set(['cat', 'ls', 'mkdir', 'cp', 'mv', 'echo', 'pwd', 'which', 'head', 'tail', 'wc', 'sort', 'uniq',
    'grep', 'find', 'curl', 'ping', 'date', 'df', 'du', 'uname', 'printenv', 'touch', 'diff', 'sed', 'cut', 'base64', 'stat', 'file',
    'sleep', 'getprop', 'md5sum', 'sha256sum', 'screencap'])).map((r) => r.text), ...FORMS];
for (const line of corpus) {
    try {
        const ours = tokenize(line).argv.slice(1);
        assert.deepStrictEqual(ours, mkshArgv(line));
    } catch (e) {
        failures++;
        console.log('FAIL: ' + line + '\n      ' + e.message.split('\n').slice(0, 6).join('\n      '));
    }
}
if (failures) {
    console.log(`\n${failures} of ${corpus.length} lines tokenize differently from mksh`);
    process.exit(1);
}
console.log(`PASS: ${corpus.length} command lines tokenize exactly as mksh splits them`);
