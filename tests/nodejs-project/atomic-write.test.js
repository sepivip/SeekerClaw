#!/usr/bin/env node
// atomic-write.test.js — BAT-1734. A failed memory or file-tool write never damages the file.
//
// memory_save used fs.writeFileSync(MEMORY_PATH), which truncates first: an ENOSPC part-way
// through left MEMORY.md short or empty. daily_note appended, leaving a partial entry. The write
// and edit file tools had the same in-place write. All four now go through writeFileAtomicSync.
//
// Fault model (faithful to ENOSPC): while armed, fs.writeFileSync writes the FIRST HALF of the
// data to whatever target it was given (a path, which it truncates, or an fd), then throws an
// ENOSPC error. The in-test negative controls prove that this fault really damages a file
// written the old way, so the passes below are not vacuous.
//
// Drives the REAL handlers (tools/memory.js, tools/file.js) against a scratch workspace.
//
// Run:  node tests/nodejs-project/atomic-write.test.js

'use strict';

const assert = require('assert');
const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');

const BUNDLE = path.resolve(__dirname, '..', '..', 'app', 'src', 'main', 'assets', 'nodejs-project');

let failures = 0;
async function check(label, fn) {
    try {
        await fn();
        console.log('PASS: ' + label);
    } catch (e) {
        console.log('FAIL: ' + label + ' — ' + (e && e.message));
        failures++;
    }
}

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'bat1734-'));
const ws = path.join(tmp, 'workspace');
const outside = path.join(tmp, 'outside');
fs.mkdirSync(ws);
fs.mkdirSync(path.join(ws, 'memory'));
fs.mkdirSync(outside);
fs.writeFileSync(path.join(outside, 'sentinel.txt'), 'sentinel');
fs.writeFileSync(path.join(ws, 'config.json'), JSON.stringify({
    botToken: 'placeholder-not-a-real-bot-token',
    anthropicApiKey: 'placeholder-not-a-real-api-key',
    ownerId: '111',
    channel: 'telegram',
}), 'utf8');
process.argv[2] = ws;
process.on('exit', () => { try { fs.rmSync(tmp, { recursive: true, force: true }); } catch (_) {} });

const { writeFileAtomicSync } = require(path.join(BUNDLE, 'atomic-write.js'));
const memoryTool = require(path.join(BUNDLE, 'tools', 'memory.js'));
const fileTool = require(path.join(BUNDLE, 'tools', 'file.js'));
const { MEMORY_PATH, MEMORY_DIR } = require(path.join(BUNDLE, 'config.js'));
const { searchMemory } = require(path.join(BUNDLE, 'memory.js'));

// ---- fault injection
const realWriteFileSync = fs.writeFileSync;
function enospc() {
    const e = new Error('ENOSPC: no space left on device, write');
    e.code = 'ENOSPC';
    e.errno = -28;
    return e;
}
function armEnospc() {
    fs.writeFileSync = function (target, data, opts) {
        const buf = Buffer.isBuffer(data) ? data : Buffer.from(String(data), 'utf8');
        // Keep the caller's flag: fs.appendFileSync is writeFileSync(..., { flag: 'a' }), and a
        // full disk during an append leaves a partial entry at the end, it does not truncate.
        const flag = opts && typeof opts === 'object' ? opts.flag : undefined;
        realWriteFileSync.call(fs, target, buf.subarray(0, Math.floor(buf.length / 2)), flag ? { flag } : undefined);
        throw enospc();
    };
}
function disarm() { fs.writeFileSync = realWriteFileSync; }

const bytes = (p) => fs.readFileSync(p);
const sha = (p) => crypto.createHash('sha256').update(bytes(p)).digest('hex');
const tmpLeftovers = (dir) => fs.readdirSync(dir).filter((f) => f.endsWith('.tmp'));

const OLD_MEMORY = '# Memory\n\n- The owner likes green tea.\n- Birthday: 12 March.\n';

(async () => {
    // ---- negative controls: the fault model really damages an in-place write
    await check('negative control: an in-place writeFileSync under ENOSPC leaves the file cut short', () => {
        const p = path.join(tmp, 'nc-inplace.md');
        realWriteFileSync(p, OLD_MEMORY);
        armEnospc();
        try { assert.throws(() => fs.writeFileSync(p, OLD_MEMORY + 'new fact\n', 'utf8'), /ENOSPC/); } finally { disarm(); }
        assert.notStrictEqual(fs.readFileSync(p, 'utf8'), OLD_MEMORY, 'the fault did not damage the file');
    });

    // ---- memory_save (the bug)
    await check('memory_save under ENOSPC: the tool errors and MEMORY.md is byte-for-byte unchanged', async () => {
        realWriteFileSync(MEMORY_PATH, OLD_MEMORY);
        const before = sha(MEMORY_PATH);
        armEnospc();
        let threw = null;
        try { await memoryTool.handlers.memory_save({ content: 'The owner moved to Tbilisi.' }); } catch (e) { threw = e; } finally { disarm(); }
        assert.ok(threw && threw.code === 'ENOSPC', 'the ENOSPC must reach the caller (ai.js reports it as Tool execution failed)');
        assert.strictEqual(sha(MEMORY_PATH), before);
        assert.deepStrictEqual(tmpLeftovers(ws), [], 'no temp file left behind');
    });
    await check('memory_save without a fault still saves (and leaves no temp file)', async () => {
        realWriteFileSync(MEMORY_PATH, OLD_MEMORY);
        const r = await memoryTool.handlers.memory_save({ content: 'The owner moved to Tbilisi.' });
        assert.ok(r.success, JSON.stringify(r));
        const now = fs.readFileSync(MEMORY_PATH, 'utf8');
        assert.ok(now.startsWith(OLD_MEMORY.trim()) && now.includes('The owner moved to Tbilisi.'), now);
        assert.deepStrictEqual(tmpLeftovers(ws), []);
    });

    // ---- daily_note
    await check('daily_note under ENOSPC: today\'s file is unchanged (no partial entry)', async () => {
        const r0 = await memoryTool.handlers.daily_note({ note: 'Walked 5 km.' });
        assert.ok(r0.success, JSON.stringify(r0));
        const daily = fs.readdirSync(MEMORY_DIR).filter((f) => f.endsWith('.md'));
        assert.strictEqual(daily.length, 1, JSON.stringify(daily));
        const dailyPath = path.join(MEMORY_DIR, daily[0]);
        const before = sha(dailyPath);
        armEnospc();
        let threw = null;
        try { await memoryTool.handlers.daily_note({ note: 'Read a long book chapter about storage.' }); } catch (e) { threw = e; } finally { disarm(); }
        assert.ok(threw && threw.code === 'ENOSPC');
        assert.strictEqual(sha(dailyPath), before);
        assert.deepStrictEqual(tmpLeftovers(MEMORY_DIR), []);
    });
    await check('negative control: an append under ENOSPC leaves a partial entry at the end (not a truncation)', () => {
        const p = path.join(tmp, 'nc-append.md');
        realWriteFileSync(p, 'entry one\n');
        armEnospc();
        try { assert.throws(() => fs.appendFileSync(p, 'entry two, long enough to be cut\n', 'utf8'), /ENOSPC/); } finally { disarm(); }
        const t = fs.readFileSync(p, 'utf8');
        assert.ok(t.startsWith('entry one\n') && t.length > 'entry one\n'.length, JSON.stringify(t));
    });
    await check('daily_note keeps appending: earlier entries survive a later note', async () => {
        await memoryTool.handlers.daily_note({ note: 'Second note.' });
        const daily = fs.readdirSync(MEMORY_DIR).filter((f) => f.endsWith('.md'));
        const text = fs.readFileSync(path.join(MEMORY_DIR, daily[0]), 'utf8');
        assert.ok(text.includes('Walked 5 km.') && text.includes('Second note.'), text);
        assert.ok(text.indexOf('Walked 5 km.') < text.indexOf('Second note.'));
    });

    await check('daily_note copies the existing file byte for byte (invalid UTF-8 is not rewritten)', async () => {
        const daily = fs.readdirSync(MEMORY_DIR).filter((f) => f.endsWith('.md'));
        const dailyPath = path.join(MEMORY_DIR, daily[0]);
        // A multibyte character cut short (E2 82, the start of "€"), as an earlier crash could leave.
        const original = Buffer.concat([Buffer.from('entry\n'), Buffer.from([0xe2, 0x82]), Buffer.from('\n')]);
        realWriteFileSync(dailyPath, original);
        await memoryTool.handlers.daily_note({ note: 'After the damaged bytes.' });
        const now = fs.readFileSync(dailyPath);
        assert.ok(now.subarray(0, original.length).equals(original), 'the existing bytes changed');
        assert.ok(now.toString('utf8').includes('After the damaged bytes.'));
    });

    // ---- the write and edit file tools (same in-place write)
    await check('write tool under ENOSPC: the existing file is unchanged', async () => {
        const p = path.join(ws, 'notes.md');
        realWriteFileSync(p, 'original notes\n');
        const before = sha(p);
        armEnospc();
        let threw = null;
        try { await fileTool.handlers.write({ path: 'notes.md', content: 'replacement that will not fit\n' }); } catch (e) { threw = e; } finally { disarm(); }
        assert.ok(threw && threw.code === 'ENOSPC');
        assert.strictEqual(sha(p), before);
        assert.deepStrictEqual(tmpLeftovers(ws), []);
    });
    await check('edit tool under ENOSPC: the existing file is unchanged', async () => {
        const p = path.join(ws, 'notes.md');
        const before = sha(p);
        armEnospc();
        let threw = null;
        try { await fileTool.handlers.edit({ path: 'notes.md', operation: 'append', content: 'more' }); } catch (e) { threw = e; } finally { disarm(); }
        assert.ok(threw && threw.code === 'ENOSPC');
        assert.strictEqual(sha(p), before);
        assert.deepStrictEqual(tmpLeftovers(ws), []);
    });
    await check('write and edit without a fault still work', async () => {
        const w = await fileTool.handlers.write({ path: 'notes.md', content: 'v2\n' });
        assert.ok(w.success, JSON.stringify(w));
        const e = await fileTool.handlers.edit({ path: 'notes.md', operation: 'append', content: 'v3' });
        assert.ok(e.success, JSON.stringify(e));
        assert.strictEqual(fs.readFileSync(path.join(ws, 'notes.md'), 'utf8'), 'v2\n\nv3');
    });

    // ---- the helper's own failure paths
    await check('a failed rename leaves the target unchanged, removes the temp file and rethrows', () => {
        const p = path.join(tmp, 'rename-fail.md');
        realWriteFileSync(p, 'keep me');
        const realRename = fs.renameSync;
        fs.renameSync = () => { const e = new Error('EXDEV: simulated'); e.code = 'EXDEV'; throw e; };
        try { assert.throws(() => writeFileAtomicSync(p, 'new'), /EXDEV/); } finally { fs.renameSync = realRename; }
        assert.strictEqual(fs.readFileSync(p, 'utf8'), 'keep me');
        assert.deepStrictEqual(tmpLeftovers(tmp), []);
    });

    await check('a failed fsync leaves the target unchanged, removes the temp file and rethrows', () => {
        const p = path.join(tmp, 'fsync-fail.md');
        realWriteFileSync(p, 'keep me');
        const realFsync = fs.fsyncSync;
        fs.fsyncSync = () => { const e = new Error('EIO: simulated'); e.code = 'EIO'; throw e; };
        try { assert.throws(() => writeFileAtomicSync(p, 'new'), /EIO/); } finally { fs.fsyncSync = realFsync; }
        assert.strictEqual(fs.readFileSync(p, 'utf8'), 'keep me');
        assert.deepStrictEqual(tmpLeftovers(tmp), []);
    });
    await check('a failed close is not retried on the same fd (it may already be reused)', () => {
        const p = path.join(tmp, 'close-fail.md');
        realWriteFileSync(p, 'keep me');
        const realClose = fs.closeSync;
        const closed = [];
        fs.closeSync = (fd) => {
            closed.push(fd);
            if (closed.length === 1) { realClose(fd); const e = new Error('EIO: simulated'); e.code = 'EIO'; throw e; }
            return realClose(fd);
        };
        try { assert.throws(() => writeFileAtomicSync(p, 'new'), /EIO/); } finally { fs.closeSync = realClose; }
        assert.deepStrictEqual(closed.length, 1, `closeSync called ${closed.length} times`);
        assert.strictEqual(fs.readFileSync(p, 'utf8'), 'keep me');
        assert.deepStrictEqual(tmpLeftovers(tmp), []);
    });
    await check('a directory at the target is left alone, with no temp file left behind', () => {
        const d = path.join(tmp, 'a-directory');
        fs.mkdirSync(d);
        realWriteFileSync(path.join(d, 'inside.txt'), 'inside');
        assert.throws(() => writeFileAtomicSync(d, 'new'));
        assert.ok(fs.statSync(d).isDirectory());
        assert.strictEqual(fs.readFileSync(path.join(d, 'inside.txt'), 'utf8'), 'inside');
        assert.deepStrictEqual(tmpLeftovers(tmp), []);
    });

    // ---- a link at the temp name cannot redirect the write (sandbox)
    let canLink = true;
    try {
        fs.symlinkSync(path.join(outside, 'sentinel.txt'), path.join(tmp, 'probe-link'));
        fs.unlinkSync(path.join(tmp, 'probe-link'));
    } catch (_) { canLink = false; }

    if (!canLink) {
        console.log('SKIP: link cases (this OS user cannot create symlinks)');
    } else {
        await check('negative control: a naive "<file>.tmp" write follows a planted link out of the workspace', () => {
            const target = path.join(ws, 'nc-naive.md');
            fs.symlinkSync(path.join(outside, 'sentinel.txt'), target + '.tmp');
            realWriteFileSync(target + '.tmp', 'ESCAPED');
            assert.strictEqual(fs.readFileSync(path.join(outside, 'sentinel.txt'), 'utf8'), 'ESCAPED');
            realWriteFileSync(path.join(outside, 'sentinel.txt'), 'sentinel');
            fs.unlinkSync(target + '.tmp');
        });
        await check('a link planted at the exact temp name is refused (EEXIST), not followed and not removed', () => {
            const target = path.join(ws, 'planted.md');
            realWriteFileSync(target, 'keep me');
            const fixed = Buffer.from([0xde, 0xad, 0xbe, 0xef]);
            const realRandomBytes = crypto.randomBytes;
            crypto.randomBytes = () => fixed;
            const planted = `${target}.${process.pid}.deadbeef.tmp`;
            fs.symlinkSync(path.join(outside, 'sentinel.txt'), planted);
            try {
                assert.throws(() => writeFileAtomicSync(target, 'ESCAPED'), (e) => e.code === 'EEXIST');
            } finally {
                crypto.randomBytes = realRandomBytes;
            }
            assert.strictEqual(fs.readFileSync(path.join(outside, 'sentinel.txt'), 'utf8'), 'sentinel');
            assert.strictEqual(fs.readFileSync(target, 'utf8'), 'keep me');
            assert.ok(fs.lstatSync(planted).isSymbolicLink(), 'the planted entry is not ours to delete');
            fs.unlinkSync(planted);
        });
    }

    // ---- leftovers are never read as memory
    await check('a leftover temp file is never read as memory (real memory search)', () => {
        const left = path.join(MEMORY_DIR, '2026-11-27.md.4211.9f3a01c2.tmp');
        realWriteFileSync(left, 'zebracornucopia half-written\n');
        realWriteFileSync(path.join(MEMORY_DIR, '2026-11-26.md'), 'quokkavelvet real note\n');
        try {
            // No database in this harness, so searchMemory takes its file-scan path over MEMORY.md
            // and memory/, the same files the indexer collects.
            assert.ok(searchMemory('quokkavelvet').length > 0, 'positive control: a real daily file is found');
            assert.deepStrictEqual(searchMemory('zebracornucopia'), []);
        } finally {
            fs.unlinkSync(left);
        }
    });

    console.log(failures === 0 ? '\nAll atomic-write checks passed.' : `\n${failures} check(s) FAILED.`);
    process.exit(failures === 0 ? 0 : 1);
})();
