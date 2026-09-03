#!/usr/bin/env node
// logging-substrate.test.js — BAT-1161 P1A Node log() substrate (gates 1, 2, 5).
//
// Run:  node tests/nodejs-project/logging-substrate.test.js
// Exit: 0 = all pass, 1 = at least one failure.
//
// WHY THIS FILE EXISTS
// --------------------
// config.js log() is the Node half of a one-wire contract with the Kotlin forwarder
// parser (SeekerClawService). We can't require('config.js') directly (it reads a real
// config.json and process.exit(1)s on missing — same constraint active-model.test.js
// works around), so we MIRROR the pure formatting/truncation logic here and add a
// structural grep drift-guard against the live source. The real end-to-end wire behavior
// is exercised from the Kotlin parser side; continuous-rotation byte bounds are locked by
// the gate-8 device measurement.
//
// Invariants pinned:
//   - format: `LEVEL|epochMs|message` per PHYSICAL line (multiline framed, shared epoch)
//   - later `|` in the message are preserved (parser owns the split)
//   - per-record UTF-8 cap, no multibyte split
//   - rotation marker + session banner shapes
//   - NO carryover on rotation (whole current → .old), old keep-~1MB path removed

'use strict';

const fs = require('fs');
const path = require('path');

const CONFIG_JS = path.join(__dirname, '..', '..', 'app', 'src', 'main',
    'assets', 'nodejs-project', 'config.js');
const src = fs.readFileSync(CONFIG_JS, 'utf8');

let failures = 0;
function ok(label, cond, hint) {
    if (cond) { console.log('PASS: ' + label); }
    else { console.log('FAIL: ' + label + (hint ? ' — ' + hint : '')); failures++; }
}

// ── mirror of config.js pure logic (MUST match — drift-grep below guards it) ──
const LOG_MAX_RECORD_BYTES = 64 * 1024;
const LOG_MAX_CALL_BYTES = 128 * 1024;
const LOG_CALL_NOTE_RESERVE = 128;
const LOG_FMT_VERSION = 1;

function truncateUtf8(s, maxBytes) {
    const buf = Buffer.from(s, 'utf8');
    if (buf.length <= maxBytes) return s;
    let end = maxBytes;
    while (end > 0 && (buf[end] & 0xC0) === 0x80) end--;
    return buf.subarray(0, end).toString('utf8') + '…[truncated]';
}
function formatRecords(level, epoch, redactedMsg) {
    const text = String(redactedMsg);
    const parts = text.length ? text.split('\n') : [''];
    let out = '';
    let outBytes = 0;
    let dropped = 0;
    for (let i = 0; i < parts.length; i++) {
        let ln = parts[i];
        if (Buffer.byteLength(ln, 'utf8') > LOG_MAX_RECORD_BYTES) ln = truncateUtf8(ln, LOG_MAX_RECORD_BYTES);
        const rec = `${level}|${epoch}|${ln}\n`;
        const recBytes = Buffer.byteLength(rec, 'utf8');
        if (i > 0 && outBytes + recBytes > LOG_MAX_CALL_BYTES - LOG_CALL_NOTE_RESERVE) {
            dropped = parts.length - i;
            break;
        }
        out += rec;
        outBytes += recBytes;
    }
    if (dropped > 0) out += `${level}|${epoch}|…[${dropped} line(s) dropped: per-call cap]\n`;
    return out;
}

// ── gate 1: line format + multiline framing ──
console.log('\n── gate 1: LEVEL|epochMs|message framing ──');
ok('single line → one framed record', formatRecords('INFO', 123, 'hello') === 'INFO|123|hello\n');
ok('multiline → one record per physical line, shared epoch',
    formatRecords('WARN', 777, 'a\nb\nc') === 'WARN|777|a\nWARN|777|b\nWARN|777|c\n');
ok('empty message → one framed record (not zero)', formatRecords('INFO', 5, '') === 'INFO|5|\n');
ok('later pipes are PRESERVED in the message (parser owns the split)',
    formatRecords('INFO', 9, 'a|b|c') === 'INFO|9|a|b|c\n',
    formatRecords('INFO', 9, 'a|b|c'));
ok('trailing newline → a final empty record is framed (no silent drop)',
    formatRecords('INFO', 1, 'x\n') === 'INFO|1|x\nINFO|1|\n');

// ── gate 2: per-record cap (UTF-8, no multibyte split) ──
console.log('\n── gate 2: per-record UTF-8 cap ──');
const big = 'x'.repeat(200 * 1024);
const rec = formatRecords('INFO', 1, big).replace(/^INFO\|1\|/, '').replace(/\n$/, '');
ok('over-cap ASCII line is truncated to <= cap + marker',
    Buffer.byteLength(rec, 'utf8') <= LOG_MAX_RECORD_BYTES + Buffer.byteLength('…[truncated]', 'utf8'),
    `bytes=${Buffer.byteLength(rec, 'utf8')}`);
ok('truncation marker is appended', /…\[truncated]$/.test(rec));
// A multibyte line right at the boundary must not split a character (valid UTF-8 out).
const multibyte = '✓'.repeat(30 * 1024); // 3 bytes each = 90KB > 64KB cap
const mrec = truncateUtf8(multibyte, LOG_MAX_RECORD_BYTES);
ok('multibyte truncation yields valid UTF-8 (no split char)',
    Buffer.from(mrec, 'utf8').toString('utf8') === mrec && /…\[truncated]$/.test(mrec));

// ── gate 2b: per-CALL output ceiling (BAT-1161 gate-8 fold, Codex F1(a)) ──
//
// The per-record cap alone does NOT bound a call: log() frames one record per physical line and
// appends the whole batch before the next size check, so without a per-call ceiling one log() of an
// N-line message overshoots LOG_MAX_BYTES by N records. Every caller happens to clamp its input
// today, but that is caller discipline, not a structural invariant — these pin the structure.
console.log('\n── gate 2b: per-call output ceiling ──');

const parseable = (framed) => framed.split('\n').filter(Boolean)
    .every((l) => /^(DEBUG|INFO|WARN|ERROR)\|\d{1,14}\|/.test(l));

// The case that motivated the fix: a many-line call.
const many = formatRecords('ERROR', 1784290000000, Array.from({ length: 5000 }, (_, i) => `line ${i}`).join('\n'));
ok('5,000-line single call stays within the per-call ceiling',
    Buffer.byteLength(many, 'utf8') <= LOG_MAX_CALL_BYTES,
    `bytes=${Buffer.byteLength(many, 'utf8')} cap=${LOG_MAX_CALL_BYTES}`);
ok('...and every emitted physical line is still a parseable record (no byte-sliced tail)',
    parseable(many));
ok('...and the drop is announced, not silent', /…\[\d+ line\(s\) dropped: per-call cap]\n$/.test(many));

// Worst amplification: payload is empty, but EVERY line still costs framing bytes. This is the
// input that makes a payload-only cap useless — 200k empty lines = ~4.2 MB of pure framing.
const allNewlines = formatRecords('DEBUG', 1784290000000, '\n'.repeat(200000));
ok('200k empty lines (framing-only amplification) stays within the ceiling',
    Buffer.byteLength(allNewlines, 'utf8') <= LOG_MAX_CALL_BYTES,
    `bytes=${Buffer.byteLength(allNewlines, 'utf8')}`);
ok('...and remains parseable', parseable(allNewlines));

// A single max-size line must NOT be dropped by the per-call ceiling: the first record is always
// admitted. Regression guard for a cap that would silently swallow one legitimate big line.
const loneBig = formatRecords('INFO', 1784290000000, 'x'.repeat(200 * 1024));
ok('a lone over-cap line is still emitted (record cap applies, per-call cap does not drop it)',
    loneBig.startsWith('INFO|1784290000000|x') && /…\[truncated]\n$/.test(loneBig)
    && !/dropped: per-call cap/.test(loneBig),
    `bytes=${Buffer.byteLength(loneBig, 'utf8')}`);
ok('...and that lone record is within one max framed record (<= 65,571 B)',
    Buffer.byteLength(loneBig, 'utf8') <= LOG_MAX_RECORD_BYTES + Buffer.byteLength('…[truncated]', 'utf8') + 21,
    `bytes=${Buffer.byteLength(loneBig, 'utf8')}`);

// Under the ceiling nothing is dropped — the cap must not fire on ordinary traffic (the measured
// worst real call is ~4 KB).
const ordinary = formatRecords('INFO', 1784290000000, Array.from({ length: 50 }, () => 'x'.repeat(437)).join('\n'));
ok('an ordinary 50-line/437-B-per-line call is untouched (cap does not fire on real traffic)',
    !/dropped: per-call cap/.test(ordinary) && ordinary.split('\n').filter(Boolean).length === 50);

// ── gate 5 / gate 2: marker + banner shapes ──
console.log('\n── gate 2/5: rotation marker + session banner shapes ──');
ok('rotation marker shape', /^INFO\|\d+\|=== ROTATED gen=\d+ logfmt=1 ===$/.test(`INFO|123|=== ROTATED gen=3 logfmt=${LOG_FMT_VERSION} ===`));

// ── structural drift-guard against the live config.js source ──
console.log('\n── drift-guard: config.js source matches the mirror ──');
ok('config.js frames records as `${level}|${epoch}|${ln}` ', src.includes('`${level}|${epoch}|${ln}\\n`') || /\$\{level\}\|\$\{epoch\}\|\$\{ln\}/.test(src), 'framing template changed');
ok('config.js uses Date.now() for the record epoch', /const epoch = Date\.now\(\);/.test(src));
ok('config.js defines LOG_MAX_RECORD_BYTES = 64 * 1024', /LOG_MAX_RECORD_BYTES = 64 \* 1024/.test(src));
ok('config.js defines LOG_FMT_VERSION = 1', /LOG_FMT_VERSION = 1\b/.test(src));
ok('config.js emits the ROTATED gen marker', /=== ROTATED gen=\$\{_logRotationSeq\} logfmt=\$\{LOG_FMT_VERSION\} ===/.test(src));
ok('config.js emits the SESSION banner (boot/build/dirty/ver/logfmt/pid)',
    /=== SESSION boot=\$\{config\.bootId[^]*build=\$\{config\.gitSha[^]*dirty=\$\{config\.gitDirty[^]*ver=\$\{APP_VERSION\} logfmt=\$\{LOG_FMT_VERSION\} pid=\$\{process\.pid\} ===/.test(src));
ok('config.js rotation renames the WHOLE current to .old (no carryover)',
    /fs\.renameSync\(debugLog, debugLog \+ '\.old'\)/.test(src) && /fs\.writeFileSync\(debugLog, marker\)/.test(src));
ok('OLD keep-~1MB carryover rotation is REMOVED', !/kept last ~1 MB/.test(src) && !/KEEP_BYTES/.test(src));
ok('OLD untimestamped `${level}|${safe}` single-line format is REMOVED',
    !/const line = `\$\{level\}\|\$\{safe\}\\n`;/.test(src));
ok('config.js defines LOG_MAX_CALL_BYTES = 128 * 1024', /LOG_MAX_CALL_BYTES = 128 \* 1024/.test(src));
ok('config.js defines LOG_CALL_NOTE_RESERVE = 128', /LOG_CALL_NOTE_RESERVE = 128\b/.test(src));
ok('log() enforces the per-call ceiling BETWEEN records (never slices framed `out`)',
    /outBytes \+ recBytes > LOG_MAX_CALL_BYTES - LOG_CALL_NOTE_RESERVE/.test(src)
    && !/out\.slice\(|out = out\.substring\(|_truncateUtf8\(out/.test(src),
    'per-call cap missing, or `out` is being byte-sliced (would emit a torn record)');
ok('log() always admits the first record (a lone max-size line is not dropped)',
    /if \(i > 0 && outBytes \+ recBytes >/.test(src));
ok('log() announces dropped lines as a well-framed record',
    /\$\{level\}\|\$\{epoch\}\|…\[\$\{dropped\} line\(s\) dropped: per-call cap]/.test(src));

// Q3 (Codex F3(a)): rotation failure must surface ONE bounded diagnostic on a NON-recursive path.
ok('_rotateDiag exists and writes one framed ROTATE_FAILED record directly (not via log())',
    /function _rotateDiag\(reason\)/.test(src)
    && /=== ROTATE_FAILED reason=\$\{reason\} ===/.test(src)
    && (() => { const m = src.match(/function _rotateDiag\(reason\)[^]*?\n}/); return m && !/\blog\(/.test(m[0]); })(),
    '_rotateDiag missing, wrong shape, or routes through log()');
ok('_rotateDiag carries a stable reason code, never an exception message',
    (() => { const m = src.match(/function _rotateDiag\(reason\)[^]*?\n}/); return m && !/\.message|\$\{e\}|String\(e\)/.test(m[0]); })());
ok('_rotateLog USES the diagnostic on BOTH failure paths (rename + fresh-current write)',
    (() => {
        const m = src.match(/function _rotateLog\(\)[^]*?\n}/);
        return m && /_rotateDiag\('rename_failed'\)/.test(m[0]) && /_rotateDiag\('write_current_failed'\)/.test(m[0]);
    })(),
    'a rotation failure path still fails silently');
ok('_rotateLog must not call log() (no recursion)',
    (() => { const m = src.match(/function _rotateLog\(\)[^]*?\n}/); return m && !/\blog\(/.test(m[0]); })(),
    '_rotateLog contains a log() call');
ok('the FALSE "overshoot <= one max record" claim is gone from config.js',
    !/[Oo]vershoot is bounded to at most one max record/.test(src),
    'config.js still asserts a bound the code does not enforce');

console.log(`\n${failures === 0 ? 'PASS' : 'FAIL'}: logging-substrate.test.js (${failures} failure(s))`);
process.exit(failures === 0 ? 0 : 1);
