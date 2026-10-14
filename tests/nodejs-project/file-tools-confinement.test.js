#!/usr/bin/env node
// file-tools-confinement.test.js — BAT-1409 P1-E. The agent's file tools stay inside the
// workspace by REAL path (a link cannot lead out), writers never write through a link, and the
// protected names are anchored at the workspace root on both the lexical and the real path.
//
// Drives the real handlers (tools/file.js, tools/memory.js) against a scratch workDir that is
// itself reached through an alias (a link to the real directory), so every check also covers the
// /data/user/0 <-> /data/data alias. Negative control: the alias really differs from its realpath.
//
// Run:  node tests/nodejs-project/file-tools-confinement.test.js

'use strict';

const assert = require('assert');
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

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'p1e-'));
const realWs = path.join(tmp, 'real-workspace');
const aliasWs = path.join(tmp, 'alias-workspace');
const outside = path.join(tmp, 'outside');
fs.mkdirSync(realWs);
fs.mkdirSync(outside);
fs.writeFileSync(path.join(outside, 'sentinel.txt'), 'sentinel');
fs.writeFileSync(path.join(outside, 'bridge_token'), 'secret-token');
fs.symlinkSync(realWs, aliasWs, process.platform === 'win32' ? 'junction' : 'dir');
fs.writeFileSync(path.join(realWs, 'config.json'), JSON.stringify({
    botToken: 'placeholder-not-a-real-bot-token',
    anthropicApiKey: 'placeholder-not-a-real-api-key',
    ownerId: '111',
    channel: 'telegram',
}), 'utf8');
fs.writeFileSync(path.join(realWs, 'agent_settings.json'), JSON.stringify({ apiKeys: { brave: 'SENTINEL_BRAVE_VALUE_123' } }));
process.argv[2] = aliasWs;
process.on('exit', () => { try { fs.rmSync(tmp, { recursive: true, force: true }); } catch (_) {} });

// Probe both link kinds the cases use (Windows can allow one and not the other).
let canLink = true;
try {
    fs.symlinkSync(path.join(outside, 'sentinel.txt'), path.join(tmp, 'probe-file'));
    fs.symlinkSync(outside, path.join(tmp, 'probe-dir'), 'dir');
    fs.unlinkSync(path.join(tmp, 'probe-file'));
    fs.unlinkSync(path.join(tmp, 'probe-dir'));
} catch (_) {
    canLink = false;
}

const wp = require(path.join(BUNDLE, 'workspace-path.js'));
const fileTool = require(path.join(BUNDLE, 'tools', 'file.js'));
const memoryTool = require(path.join(BUNDLE, 'tools', 'memory.js'));
const H = fileTool.handlers;
const sentinel = () => fs.readFileSync(path.join(outside, 'sentinel.txt'), 'utf8');

(async () => {
    await check('negative control: the workspace alias differs from its realpath', () => {
        assert.notStrictEqual(path.resolve(aliasWs), fs.realpathSync(aliasWs));
    });

    // ---- the path rule
    await check('a new file under a new directory is allowed', async () => {
        const r = await H.write({ path: 'nutrition/2026-09-24.json', content: '{"kcal":1}' });
        assert.ok(r.success, JSON.stringify(r));
        assert.strictEqual(fs.readFileSync(path.join(realWs, 'nutrition', '2026-09-24.json'), 'utf8'), '{"kcal":1}');
    });
    await check('.. out of the workspace is refused', async () => {
        assert.ok((await H.read({ path: '../outside/sentinel.txt' })).error);
        assert.ok((await H.write({ path: '../outside/x.txt', content: 'x' })).error);
        assert.ok(!fs.existsSync(path.join(outside, 'x.txt')));
    });
    await check('resolveInWorkspace refuses NUL and non-string paths', () => {
        assert.strictEqual(wp.resolveInWorkspace(aliasWs, 'a\0b'), null);
        assert.strictEqual(wp.resolveInWorkspace(aliasWs, 42), null);
        assert.ok(wp.resolveInWorkspace(aliasWs, Buffer.from('notes.txt')));
    });

    // ---- calclaw's nested config.json (live bug fix) and root-anchored names
    await check('nested nutrition/config.json is readable and writable', async () => {
        const w = await H.write({ path: 'nutrition/config.json', content: '{"goal":2000}' });
        assert.ok(w.success, JSON.stringify(w));
        const r = await H.read({ path: 'nutrition/config.json' });
        assert.strictEqual(r.content, '{"goal":2000}');
    });
    await check('root config.json is refused for read, write, delete and send', async () => {
        assert.ok((await H.read({ path: 'config.json' })).error);
        assert.ok((await H.read({ path: './x/../config.json' })).error);
        assert.ok((await H.write({ path: 'config.json', content: '{}' })).error);
        assert.ok((await H.delete({ path: 'config.json' })).error);
        assert.ok((await H.send_file({ path: 'config.json', chat_id: '1' })).error);
        assert.ok(fs.existsSync(path.join(realWs, 'config.json')));
    });
    await check('protected root writes: owner_ids, solana_wallet.json, skills-manifest.json, seekerclaw.db.tmp', async () => {
        for (const n of ['owner_ids', 'owner_ids.tmp', 'solana_wallet.json', 'skills-manifest.json', 'seekerclaw.db', 'seekerclaw.db.tmp', 'config.yaml']) {
            const r = await H.write({ path: n, content: 'x' });
            assert.ok(r.error, n + ' must be refused');
            assert.ok(!fs.existsSync(path.join(realWs, n)), n + ' must not be created');
        }
    });
    await check('bridge_token and xai_oauth.json are refused at any depth', async () => {
        assert.ok((await H.write({ path: 'a/b/bridge_token', content: 'x' })).error);
        fs.mkdirSync(path.join(realWs, 'deep'), { recursive: true });
        fs.writeFileSync(path.join(realWs, 'deep', 'xai_oauth.json'), '{}');
        assert.ok((await H.read({ path: 'deep/xai_oauth.json' })).error);
        assert.ok((await H.send_file({ path: 'deep/xai_oauth.json', chat_id: '1' })).error);
    });
    await check('agent_settings.json: write allowed (BAT-236), read masked, send refused', async () => {
        const r = await H.read({ path: 'agent_settings.json' });
        assert.ok(r.content && !r.content.includes('SENTINEL_BRAVE_VALUE_123'), 'masked read');
        const m = await memoryTool.handlers.memory_get({ file: 'agent_settings.json', start_line: 1 });
        assert.ok(m.content && !m.content.includes('SENTINEL_BRAVE_VALUE_123'), 'memory_get masked');
        assert.ok((await H.send_file({ path: 'agent_settings.json', chat_id: '1' })).error);
        const w = await H.write({ path: 'agent_settings.json', content: JSON.stringify({ apiKeys: {} }) });
        assert.ok(w.success, JSON.stringify(w));
    });
    await check('a root name that starts with .. is an ordinary file', async () => {
        const w = await H.write({ path: '..notes', content: 'x' });
        assert.ok(w.success, JSON.stringify(w));
        assert.ok((await H.delete({ path: '..notes' })).success);
    });
    await check('an absolute path through the real (other-alias) root is rebased onto workDir', async () => {
        const r = wp.resolveInWorkspace(aliasWs, path.join(fs.realpathSync(aliasWs), 'notes', 'a.txt'));
        assert.strictEqual(r.abs, path.join(path.resolve(aliasWs), 'notes', 'a.txt'));
        const w = await H.write({ path: path.join(fs.realpathSync(aliasWs), 'notes', 'a.txt'), content: 'y' });
        assert.ok(w.success, JSON.stringify(w));
        const blocked = await H.read({ path: path.join(fs.realpathSync(aliasWs), 'config.json') });
        assert.ok(blocked.error, 'root config.json through the other alias is still refused');
    });
    await check('telegram_send_file refuses the secret names and agent_settings.json', async () => {
        const tg = require(path.join(BUNDLE, 'tools', 'telegram.js')).handlers;
        for (const p of ['config.json', 'agent_settings.json', '../outside/sentinel.txt']) {
            const r = await tg.telegram_send_file({ path: p, chat_id: '1' });
            assert.ok(r.error, p + ' must be refused');
        }
    });
    await check('delete refuses the workspace root', async () => {
        assert.ok((await H.delete({ path: '.' })).error);
        assert.ok((await H.delete({ path: '' })).error);
        assert.ok(fs.existsSync(realWs));
    });

    // ---- links
    if (!canLink) {
        console.log('SKIP: symlink cases (this platform cannot create links)');
    } else {
        fs.symlinkSync(outside, path.join(realWs, 'escape'), 'dir');
        fs.symlinkSync(path.join(outside, 'sentinel.txt'), path.join(realWs, 'notes-link.txt'));
        fs.mkdirSync(path.join(realWs, 'inner'));
        fs.writeFileSync(path.join(realWs, 'inner', 'real.txt'), 'inside');
        fs.symlinkSync(path.join(realWs, 'inner', 'real.txt'), path.join(realWs, 'inside-link.txt'));

        await check('read through a link that leads outside is refused', async () => {
            assert.ok((await H.read({ path: 'escape/sentinel.txt' })).error);
            assert.ok((await H.read({ path: 'notes-link.txt' })).error);
            assert.ok((await memoryTool.handlers.memory_get({ file: 'escape/bridge_token', start_line: 1 })).error);
            assert.ok((await H.send_file({ path: 'escape/sentinel.txt', chat_id: '1' })).error);
        });
        await check('read through a link that stays inside is allowed', async () => {
            assert.strictEqual((await H.read({ path: 'inside-link.txt' })).content, 'inside');
        });
        await check('writes, edits and deletes through any link are refused; the target survives', async () => {
            assert.ok((await H.write({ path: 'escape/sentinel.txt', content: 'pwned' })).error);
            assert.ok((await H.write({ path: 'notes-link.txt', content: 'pwned' })).error);
            assert.ok((await H.edit({ path: 'notes-link.txt', operation: 'append', content: 'pwned' })).error);
            assert.ok((await H.write({ path: 'inside-link.txt', content: 'x' })).error, 'even a link that stays inside');
            assert.ok((await H.delete({ path: 'escape/sentinel.txt' })).error);
            assert.strictEqual(sentinel(), 'sentinel');
            assert.strictEqual(fs.readFileSync(path.join(realWs, 'inner', 'real.txt'), 'utf8'), 'inside');
        });
        await check('a dangling link at the target is not written through', async () => {
            const target = path.join(outside, 'would-be-created.txt');
            fs.symlinkSync(target, path.join(realWs, 'dangling.txt'));
            assert.ok((await H.write({ path: 'dangling.txt', content: 'x' })).error);
            assert.ok(!fs.existsSync(target));
        });
        await check('a link to root config.json is refused by its real name', async () => {
            fs.symlinkSync(path.join(realWs, 'config.json'), path.join(realWs, 'innocent.json'));
            assert.ok((await H.read({ path: 'innocent.json' })).error);
        });
        await check('a directory link back to the root cannot reach root config.json', async () => {
            fs.symlinkSync(realWs, path.join(realWs, 'loop'), 'dir');
            assert.ok((await H.read({ path: 'loop/config.json' })).error, 'read by real name');
            assert.ok((await H.send_file({ path: 'loop/config.json', chat_id: '1' })).error, 'send by real name');
            assert.ok((await H.write({ path: 'loop/config.json', content: '{}' })).error, 'write through a link');
            assert.ok(fs.readFileSync(path.join(realWs, 'config.json'), 'utf8').includes('placeholder'));
        });
        await check('ls reports links as symlink and does not follow them', async () => {
            const r = await H.ls({ path: '', recursive: true });
            const esc = r.entries.find((e) => e.name === 'escape');
            assert.strictEqual(esc.type, 'symlink');
            assert.ok(!r.entries.some((e) => e.name.startsWith('escape/')), 'not recursed into');
        });
    }

    if (failures > 0) {
        console.log(`\n${failures} failure(s)`);
        process.exit(1);
    }
    console.log('\nAll file-tool confinement checks passed.');
})();
