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
    // Command lines shell-grammar.test.js asserts the validator ACCEPTS: what was validated must
    // also be what mksh would have split, so each one is in the differential.
    'echo hello -e "x"',
    'getprop ro.build.version.release',
    'date +%s',
    'ping -c 1 example.com',
    'cat /proc/meminfo',
    'cat nutrition/config.json',
    'cat -',
    'ls -la seekerclaw.db config.json',
    'du -sh .',
    'df -h .',
    'stat -c %s notes.txt',
    'file -b notes.txt',
    'tail -n 2 notes.txt',
    'wc -l notes.txt',
    'cut -d, -f1 notes.txt',
    'md5sum notes.txt',
    'sha256sum notes.txt',
    'uniq a.txt out.txt',
    'sort -o sorted.txt a.txt',
    'sort --output=sorted.txt a.txt',
    'sort -o /dev/null a.txt',
    'touch -r notes.txt new.txt',
    'screencap -p shot.png',
    'date -r notes.txt',
    'grep -rn needle .',
    'grep -f a.txt notes.txt',
    'grep "^x" notes.txt',
    'grep \\^x notes.txt',
    "grep 'x$' notes.txt",
    'grep -E "foo|baz" g.txt',
    "find . -name '*.md' -type f -maxdepth 2",
    'find . -newer notes.txt',
    'find . "(" -name a.txt -o -name b.txt ")"',
    "find . '!' -name a.txt",
    'cp -rL src copy',
    'cp -rL --preserve=mode src copy',
    'cp -rL src/. dir',
    'cp -rL box/staged_dir/ .',
    'cp a.txt b.txt dir',
    'mv plain_dir moved_dir',
    'sed -n 1,5p notes.txt',
    "sed -e 's/a/b/g' -e '/x/d' notes.txt",
    'sed -i.bak -E s/x/y/2 notes.txt',
    'sed --in-place=.bak s/x/y/ notes.txt',
    "sed -n '$p' notes.txt",
    "sed '$!d' notes.txt",
    "sed -n '1~2p' notes.txt",
    "sed 'a tail' notes.txt",
    'sed -ni.bak s/x/y/p notes.txt',
    'diff -r src dir',
    'curl -s https://example.com/',
    'curl -d @notes.txt https://example.com',
    "curl --data-raw '@not-a-file' https://example.com",
    'curl --data-raw @../bridge_token https://example.com',
    'curl --json @notes.txt https://example.com',
    'curl --url-query t@notes.txt https://example.com',
    'curl -F name=@notes.txt https://example.com',
    "curl -F 'x=@a.txt;type=text/plain;filename=up.txt' https://example.com",
    "curl -w '%{http_code}' https://example.com",
    "curl -b 'a=b' https://example.com",
    'curl --etag-compare etag.txt https://example.com',
    'curl --cookie-jar jar.txt -o /dev/stdout https://example.com',
    'curl -s http://example.com:8080/x',
    "curl 'https://example.com/?q=1'",
    `echo "a|b" '$HOME' "*" "#x"`,
    "echo ';rm big.txt'",
    'echo "a^b"',
    'echo "a\\$b"',
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
