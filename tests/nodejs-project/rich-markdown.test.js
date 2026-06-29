#!/usr/bin/env node
// rich-markdown.test.js — BAT-1050 P1A Slice 3.
// Pins the posture-A sanitizer (sanitizeRichMarkdown): escape raw HTML angle
// brackets outside code, neuter markdown images, enforce the {https,mailto}
// link-scheme allowlist, and round-trip code spans/fences verbatim.
//
// Run:  node tests/nodejs-project/rich-markdown.test.js

'use strict';

const { sanitizeRichMarkdown, ALLOWED_LINK_SCHEMES } =
    require('../../app/src/main/assets/nodejs-project/rich-markdown');

let failures = 0;
function eq(label, actual, expected) {
    const a = JSON.stringify(actual), e = JSON.stringify(expected);
    if (a === e) console.log(`PASS: ${label}`);
    else { console.log(`FAIL: ${label}\n  actual:   ${a}\n  expected: ${e}`); failures++; }
}
function ok(label, cond, hint = '') {
    if (cond) console.log(`PASS: ${label}`);
    else { console.log(`FAIL: ${label}${hint ? ' — ' + hint : ''}`); failures++; }
}

console.log('── escape raw HTML outside code ──');
eq('html tag escaped', sanitizeRichMarkdown('<details>x</details>'), '&lt;details&gt;x&lt;/details&gt;');
eq('comparison ops escaped (literal render)', sanitizeRichMarkdown('5 < 10 and 10 > 5'), '5 &lt; 10 and 10 &gt; 5');
eq('sub/sup HTML-only tags become literal', sanitizeRichMarkdown('H<sub>2</sub>O'), 'H&lt;sub&gt;2&lt;/sub&gt;O');

console.log();
console.log('── code round-trips verbatim (NOT escaped) ──');
const fence = '```html\n<details>hi</details>\n```';
eq('fenced code round-trips verbatim', sanitizeRichMarkdown(fence), fence);
const inline = 'see `<b>x</b>` here';
eq('inline code round-trips verbatim', sanitizeRichMarkdown(inline), inline);
eq('mixed: escape prose, preserve code',
    sanitizeRichMarkdown('a <b> then `<c>` then <d>'),
    'a &lt;b&gt; then `<c>` then &lt;d&gt;');
eq('link inside code NOT neutered',
    sanitizeRichMarkdown('`[a](tg://x)`'), '`[a](tg://x)`');

console.log();
console.log('── link-scheme allowlist {https, mailto} ──');
eq('https kept', sanitizeRichMarkdown('[ok](https://example.com)'), '[ok](https://example.com)');
eq('mailto kept', sanitizeRichMarkdown('[mail](mailto:a@b.com)'), '[mail](mailto:a@b.com)');
eq('https query string & preserved (not mangled)',
    sanitizeRichMarkdown('[q](https://x.com/?a=1&b=2)'), '[q](https://x.com/?a=1&b=2)');
eq('tg://user link neutered to text', sanitizeRichMarkdown('[click](tg://user?id=1)'), 'click');
eq('javascript: link neutered to text', sanitizeRichMarkdown('[x](javascript:foo)'), 'x');
eq('relative link neutered to text', sanitizeRichMarkdown('[a](/path)'), 'a');
eq('#anchor link neutered to text', sanitizeRichMarkdown('[b](#sec)'), 'b');
eq('http (non-s) neutered per allowlist', sanitizeRichMarkdown('[c](http://x.com)'), 'c');
eq('https link WITH title kept', sanitizeRichMarkdown('[ok](https://x.com "t")'), '[ok](https://x.com "t")');
eq('tg:// link WITH title still neutered (no bypass)', sanitizeRichMarkdown('[click](tg://user?id=1 "title")'), 'click');

console.log();
console.log('── parenthesized URLs (BAT-1050 device-test regression) ──');
// A bad-scheme URL with balanced parens (e.g. javascript:alert(1)) must neuter
// CLEANLY — the original [^)\s]+ regex stopped at the first inner ')' and leaked
// a dangling ')'. Device test (safety scenario) surfaced this as "a js link)".
eq('js link w/ inner parens neutered, no stray paren',
    sanitizeRichMarkdown('a [js link](javascript:alert(1)) b'), 'a js link b');
eq('js link w/ deeper inner parens neutered',
    sanitizeRichMarkdown('[x](javascript:alert(document.cookie))'), 'x');
// A legit https URL with balanced parens (Wikipedia disambiguation, etc.) must be
// KEPT intact — not truncated at the first inner ')'.
eq('https URL w/ balanced parens kept intact',
    sanitizeRichMarkdown('[Mercury](https://en.wikipedia.org/wiki/Mercury_(planet))'),
    '[Mercury](https://en.wikipedia.org/wiki/Mercury_(planet))');
eq('image w/ paren URL neutered to alt',
    sanitizeRichMarkdown('![pic](https://e.com/a_(b).png)'), 'pic');

console.log();
console.log('── image syntax neutered (no remote fetch / custom emoji) ──');
eq('remote image neutered to alt', sanitizeRichMarkdown('![pic](https://img.com/a.png)'), 'pic');
eq('tg://emoji custom emoji neutered to alt', sanitizeRichMarkdown('![👍](tg://emoji?id=5)'), '👍');
eq('empty-alt image neutered', sanitizeRichMarkdown('x ![](https://i) y'), 'x  y');
eq('titled remote image neutered to alt (no bypass)', sanitizeRichMarkdown('![pic](https://img/x.png "a caption")'), 'pic');
eq('titled custom-emoji image neutered to alt', sanitizeRichMarkdown('![👍](tg://emoji?id=5 "e")'), '👍');

console.log();
console.log('── allowlist export + passthrough ──');
ok('allowlist = {https, mailto} (no http, no tg)',
    ALLOWED_LINK_SCHEMES.has('https') && ALLOWED_LINK_SCHEMES.has('mailto')
    && !ALLOWED_LINK_SCHEMES.has('http') && !ALLOWED_LINK_SCHEMES.has('tg'));
eq('null passthrough', sanitizeRichMarkdown(null), null);
eq('empty-string passthrough', sanitizeRichMarkdown(''), '');

console.log();
if (failures === 0) { console.log('ALL TESTS PASS'); process.exit(0); }
else { console.log(`${failures} TEST(S) FAILED`); process.exit(1); }
