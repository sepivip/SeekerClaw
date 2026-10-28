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
const { config } = require(path.join(BUNDLE, 'config.js'));

// Spies on the two raw-byte send paths, installed before any handler runs: a send that is not
// refused becomes a recorded call (and never reaches a network), so a refusal cannot pass by way
// of a transport error. file.js calls channel.sendFile at call time; tools/telegram.js destructures
// telegramSendFile when it is first loaded, so that spy goes in before anything loads it.
const sendCalls = [];
require(path.join(BUNDLE, 'channel.js')).sendFile = async (chatId, filePath, caption) => {
    sendCalls.push({ chatId, filePath, caption });
    return { messageId: 42 };
};
const tgSendCalls = [];
require(path.join(BUNDLE, 'telegram.js')).telegramSendFile = async (method, params, field, filePath) => {
    tgSendCalls.push({ method, chatId: params.chat_id, filePath });
    return { ok: true, result: { message_id: 43 } };
};

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
    await check('BAT-236 key sync: a root agent_settings.json write or edit through the aliased workDir re-syncs config.braveApiKey; a nested one does not', async () => {
        // config.js synced the fixture's key at startup (config.json has no braveApiKey of its own).
        assert.strictEqual(config.braveApiKey, 'SENTINEL_BRAVE_VALUE_123', 'fixture: startup sync');
        // Negative control: the root file changes on disk behind the tools' back, then a NESTED
        // agent_settings.json is written through the tool. A re-sync would pick up the disk value
        // (syncAgentApiKeys always reads the root file), so an unchanged key proves none ran.
        fs.writeFileSync(path.join(realWs, 'agent_settings.json'), JSON.stringify({ apiKeys: { brave: 'DISK_ONLY_KEY' } }));
        const nested = await H.write({ path: 'sub/agent_settings.json', content: JSON.stringify({ apiKeys: { brave: 'NESTED_KEY' } }) });
        assert.ok(nested.success, JSON.stringify(nested));
        assert.strictEqual(config.braveApiKey, 'SENTINEL_BRAVE_VALUE_123', 'a nested agent_settings.json write must not re-sync');
        // The root write (tools/file.js write: filePath === path.join(workDir, 'agent_settings.json')).
        const w = await H.write({ path: 'agent_settings.json', content: JSON.stringify({ apiKeys: { brave: 'NEW_KEY' } }) });
        assert.ok(w.success, JSON.stringify(w));
        assert.strictEqual(config.braveApiKey, 'NEW_KEY');
        // The same re-sync on the edit path.
        const e = await H.edit({ path: 'agent_settings.json', operation: 'replace', search: 'NEW_KEY', content: 'EDITED_KEY' });
        assert.ok(e.success, JSON.stringify(e));
        assert.strictEqual(config.braveApiKey, 'EDITED_KEY');
    });
    await check('memory_get of root config.json is refused and returns no secret value', async () => {
        for (const file of ['config.json', './sub/../config.json', path.join(fs.realpathSync(aliasWs), 'config.json')]) {
            const r = await memoryTool.handlers.memory_get({ file, start_line: 1, end_line: 50 });
            assert.strictEqual(r.error, 'Reading config.json is blocked for security.', file + ': ' + JSON.stringify(r));
            const out = JSON.stringify(r);
            for (const secret of ['placeholder-not-a-real-bot-token', 'placeholder-not-a-real-api-key']) {
                assert.ok(!out.includes(secret), file + ' leaked ' + secret);
            }
        }
    });
    await check('send_file and telegram_send_file: allowed files reach the sender exactly once each; refused names never do', async () => {
        fs.mkdirSync(path.join(realWs, 'media', 'inbound'), { recursive: true });
        fs.writeFileSync(path.join(realWs, 'media', 'inbound', 'photo.jpg'), Buffer.from([0xff, 0xd8, 0xff, 0xe0]));
        fs.mkdirSync(path.join(realWs, 'nutrition'), { recursive: true });
        fs.writeFileSync(path.join(realWs, 'nutrition', 'config.json'), '{"goal":2000}');
        sendCalls.length = 0;
        tgSendCalls.length = 0;
        const photo = await H.send_file({ path: 'media/inbound/photo.jpg', chat_id: '777', caption: 'pic' });
        assert.deepStrictEqual(photo, { success: true, file: 'media/inbound/photo.jpg', size: 4, messageId: 42 });
        // Root-anchored: a skill's own nested config.json is an ordinary file for sending too.
        const nested = await H.send_file({ path: 'nutrition/config.json', chat_id: '777' });
        assert.ok(nested.success, JSON.stringify(nested));
        // Contract ruling S3: sending root seekerclaw.db is not newly restricted (read still refuses it).
        fs.writeFileSync(path.join(realWs, 'seekerclaw.db'), 'SQLite format 3');
        const db = await H.send_file({ path: 'seekerclaw.db', chat_id: '777' });
        assert.ok(db.success, 'S3: send_file of seekerclaw.db: ' + JSON.stringify(db));
        assert.match(String((await H.read({ path: 'seekerclaw.db' })).error), /seekerclaw\.db is blocked for security/, 'read still refuses it');
        for (const p of ['agent_settings.json', 'config.json', './nutrition/../config.json', 'sub/agent_settings.json']) {
            const r = await H.send_file({ path: p, chat_id: '777' });
            assert.match(String(r.error), /^Sending (agent_settings|config)\.json is blocked for security\.$/, p);
        }
        assert.deepStrictEqual(sendCalls, [
            { chatId: '777', filePath: fs.realpathSync(path.join(realWs, 'media', 'inbound', 'photo.jpg')), caption: 'pic' },
            { chatId: '777', filePath: fs.realpathSync(path.join(realWs, 'nutrition', 'config.json')), caption: undefined },
            { chatId: '777', filePath: fs.realpathSync(path.join(realWs, 'seekerclaw.db')), caption: undefined },
        ]);
        // The telegram spy is wired (one allowed send), so its zero-call checks below mean something.
        const tg = require(path.join(BUNDLE, 'tools', 'telegram.js')).handlers;
        assert.ok((await tg.telegram_send_file({ path: 'media/inbound/photo.jpg', chat_id: 777 })).success);
        for (const p of ['agent_settings.json', 'config.json']) {
            assert.match(String((await tg.telegram_send_file({ path: p, chat_id: 777 })).error), /is blocked for security\.$/, p);
        }
        assert.deepStrictEqual(tgSendCalls, [
            { method: 'sendPhoto', chatId: '777', filePath: fs.realpathSync(path.join(realWs, 'media', 'inbound', 'photo.jpg')) },
        ]);
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
        await check('file links tok -> ../bridge_token and x -> ../xai_oauth.json are refused by read, memory_get, send_file and telegram_send_file', async () => {
            // The device layout: both secrets are siblings of the workspace (filesDir/bridge_token,
            // filesDir/xai_oauth.json). The link names are innocent, so only the real path refuses them.
            fs.writeFileSync(path.join(tmp, 'bridge_token'), 'SECRET_BRIDGE_TOKEN_VALUE');
            fs.writeFileSync(path.join(tmp, 'xai_oauth.json'), '{"access_token":"SECRET_XAI_TOKEN_VALUE"}');
            fs.symlinkSync(path.join('..', 'bridge_token'), path.join(realWs, 'tok'));
            fs.symlinkSync(path.join('..', 'xai_oauth.json'), path.join(realWs, 'x'));
            assert.strictEqual(fs.readFileSync(path.join(realWs, 'tok'), 'utf8'), 'SECRET_BRIDGE_TOKEN_VALUE', 'fixture: the link resolves');
            const tg = require(path.join(BUNDLE, 'tools', 'telegram.js')).handlers;
            sendCalls.length = 0;
            tgSendCalls.length = 0;
            for (const name of ['tok', 'x', './tok', 'sub/../x']) {
                const results = {
                    read: await H.read({ path: name }),
                    memory_get: await memoryTool.handlers.memory_get({ file: name, start_line: 1 }),
                    send_file: await H.send_file({ path: name, chat_id: '777' }),
                    telegram_send_file: await tg.telegram_send_file({ path: name, chat_id: 777 }),
                };
                for (const [tool, r] of Object.entries(results)) {
                    assert.deepStrictEqual(r, { error: 'Access denied: path outside workspace' }, `${tool}(${name})`);
                }
            }
            assert.deepStrictEqual(sendCalls, [], 'send_file never reached the sender');
            assert.deepStrictEqual(tgSendCalls, [], 'telegram_send_file never reached the sender');
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
