#!/usr/bin/env node
// js-eval-confinement.test.js — BAT-1409 P1-F (contract v3.2, amendment v3.3 M3). Drives the
// real js_eval handler: built-in modules only (explicit allowlist), fs confined to the workspace
// by real path, no descriptors, no links, read-only flags on reads, stream façades, and no socket
// wrapping a descriptor. Ordinary snippets (math, workspace files, TCP probes) keep working.
//
// Run:  node tests/nodejs-project/js-eval-confinement.test.js

'use strict';

const assert = require('assert');
const fs = require('fs');
const net = require('net');
const os = require('os');
const path = require('path');

const BUNDLE = path.resolve(__dirname, '..', '..', 'app', 'src', 'main', 'assets', 'nodejs-project');

let failures = 0;
async function check(label, fn) {
    try {
        await fn();
        console.log('PASS: ' + label);
    } catch (e) {
        console.log('FAIL: ' + label + ' — ' + (e && e.stack ? e.stack.split('\n').slice(0, 3).join(' | ') : e));
        failures++;
    }
}

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'p1f-'));
const ws = path.join(tmp, 'workspace');
const outside = path.join(tmp, 'outside');
fs.mkdirSync(ws);
fs.mkdirSync(outside);
fs.writeFileSync(path.join(outside, 'sentinel.txt'), 'sentinel');
fs.writeFileSync(path.join(ws, 'config.json'), JSON.stringify({
    botToken: 'placeholder-not-a-real-bot-token',
    anthropicApiKey: 'placeholder-not-a-real-api-key',
    ownerId: '111',
    channel: 'telegram',
}));
fs.writeFileSync(path.join(ws, 'agent_settings.json'), JSON.stringify({ apiKeys: { brave: 'SENTINEL_BRAVE_VALUE_123' } }));
fs.writeFileSync(path.join(ws, 'owner_ids'), '{"telegram":"111"}');
fs.writeFileSync(path.join(ws, 'data.txt'), 'hello');
fs.mkdirSync(path.join(ws, 'nutrition'));
fs.writeFileSync(path.join(ws, 'nutrition', 'config.json'), '{"goal":2000}');
process.argv[2] = ws;
process.on('exit', () => { try { fs.rmSync(tmp, { recursive: true, force: true }); } catch (_) {} });

let canLink = true;
try {
    fs.symlinkSync(path.join(outside, 'sentinel.txt'), path.join(tmp, 'probe-file'));
    fs.symlinkSync(outside, path.join(tmp, 'probe-dir'), 'dir');
} catch (_) {
    canLink = false;
}

require(path.join(BUNDLE, 'net-guard.js')).install();
const sys = require(path.join(BUNDLE, 'tools', 'system.js'));
const guard = require(path.join(BUNDLE, 'js-eval-guard.js'));

async function run(code) {
    return sys.handlers.js_eval({ code }, 'chat');
}
async function ok(code) {
    const r = await run(code);
    assert.ok(r.success, 'expected success, got: ' + (r.error || JSON.stringify(r)));
    return r.result;
}
async function refused(code, rx) {
    const r = await run(code);
    assert.ok(!r.success, 'expected a refusal for: ' + code + ' — got ' + r.result);
    if (rx) assert.ok(rx.test(r.error || ''), 'error ' + JSON.stringify(r.error) + ' should match ' + rx);
    return r;
}
const sentinel = () => fs.readFileSync(path.join(outside, 'sentinel.txt'), 'utf8');

(async () => {
    // ---- ordinary use keeps working
    await check('math and JSON still work', async () => {
        assert.strictEqual(await ok('return [1,2,3].map(x => x * 2).join(",")'), '2,4,6');
    });
    await check('relative paths resolve inside the workspace (read, write, append, mkdir, readdir)', async () => {
        assert.strictEqual(await ok("return require('fs').readFileSync('data.txt', 'utf8')"), 'hello');
        await ok("const fs = require('fs'); fs.mkdirSync('out/deep', { recursive: true }); fs.writeFileSync('out/deep/a.txt', 'x'); fs.appendFileSync('out/deep/a.txt', 'y'); return 1");
        assert.strictEqual(fs.readFileSync(path.join(ws, 'out', 'deep', 'a.txt'), 'utf8'), 'xy');
        assert.ok((await ok("return require('fs').readdirSync('out').join(',')")).includes('deep'));
    });
    await check('fs.promises and fs/promises work inside the workspace', async () => {
        assert.strictEqual(await ok("const p = require('fs/promises'); await p.writeFile('p.txt', 'pp'); return await require('fs').promises.readFile('p.txt', 'utf8')"), 'pp');
    });
    await check("a skill's own nested config.json is readable", async () => {
        assert.strictEqual(await ok("return require('fs').readFileSync('nutrition/config.json', 'utf8')"), '{"goal":2000}');
    });
    await check('stream façades: async iteration, pipe and readline work', async () => {
        const code = `
            const fs = require('fs');
            const { pipeline } = require('stream/promises');
            await pipeline(fs.createReadStream('data.txt'), fs.createWriteStream('copy.txt'));
            let s = '';
            for await (const chunk of fs.createReadStream('copy.txt', { encoding: 'utf8' })) s += chunk;
            const rl = require('readline').createInterface({ input: fs.createReadStream('copy.txt') });
            const lines = [];
            for await (const line of rl) lines.push(line);
            return s + '|' + lines.join(',');`;
        assert.strictEqual(await ok(code), 'hello|hello');
    });
    await check('stream façades expose no fd, path, flags, open or constructor', async () => {
        const code = `
            const fs = require('fs');
            const r = fs.createReadStream('data.txt'); const w = fs.createWriteStream('w.txt');
            const out = [r.fd, r.path, r.flags, r.open, r.constructor, w.fd, w.path, w.open, w.constructor].map(v => v === undefined);
            r.destroy(); w.end();
            return out.every(Boolean)`;
        assert.strictEqual(await ok(code), 'true');
    });
    await check('a TCP probe to a local non-bridge port works (netwatch-style)', async () => {
        const server = net.createServer((s) => s.end()).listen(0, '127.0.0.1');
        await new Promise((r) => server.once('listening', r));
        const port = server.address().port;
        try {
            const code = `
                const net = require('net');
                return await new Promise((resolve) => {
                    const sock = net.createConnection({ host: '127.0.0.1', port: ${port}, timeout: 3000 }, () => { sock.destroy(); resolve('open'); });
                    sock.on('error', (e) => resolve('error ' + e.message));
                });`;
            assert.strictEqual(await ok(code), 'open');
        } finally {
            server.close();
        }
    });

    // ---- modules
    await check('only allowlisted built-ins load', async () => {
        for (const m of ['child_process', 'vm', 'worker_threads', 'cluster', 'v8', 'module', 'perf_hooks',
            'async_hooks', 'diagnostics_channel', 'inspector', 'tty', 'dgram', 'http2', 'repl', 'wasi',
            'trace_events', 'domain', 'node:child_process', 'lodash', './config', '../config.js', '/etc/passwd']) {
            await refused(`return typeof require(${JSON.stringify(m)})`, /not available|must be a string/);
        }
        for (const m of ['crypto', 'path', 'https', 'http', 'dns', 'net', 'tls', 'zlib', 'os', 'util', 'url', 'node:path']) {
            assert.strictEqual(await ok(`return typeof require(${JSON.stringify(m)})`), 'object', m);
        }
    });
    await check('the allowlist is pinned (a new entry is a reviewed change)', () => {
        assert.deepStrictEqual([...guard.MODULE_ALLOWLIST].sort(), [
            'assert', 'assert/strict', 'buffer', 'crypto', 'dns', 'dns/promises', 'events', 'fs', 'fs/promises',
            'http', 'https', 'net', 'os', 'path', 'path/posix', 'path/win32', 'process', 'punycode',
            'querystring', 'readline', 'stream', 'stream/promises', 'string_decoder', 'timers',
            'timers/promises', 'tls', 'url', 'util', 'util/types', 'zlib',
        ]);
    });

    // ---- fs confinement
    await check('reads outside the workspace are refused', async () => {
        await refused(`return require('fs').readFileSync(${JSON.stringify(path.join(outside, 'sentinel.txt'))}, 'utf8')`, /outside the workspace/);
        await refused("return require('fs').readFileSync('../outside/sentinel.txt', 'utf8')", /outside the workspace/);
        await refused("return require('fs').readdirSync('..')", /outside the workspace/);
        await refused("return await require('fs/promises').readFile('../outside/sentinel.txt', 'utf8')", /outside the workspace/);
    });
    await check('writes outside the workspace are refused for every path argument', async () => {
        await refused("require('fs').writeFileSync('../outside/x.txt', 'x')", /outside the workspace/);
        await refused("require('fs').renameSync('data.txt', '../outside/moved.txt')", /outside the workspace/);
        await refused("require('fs').copyFileSync('data.txt', '../outside/copied.txt')", /outside the workspace/);
        await refused("require('fs').copyFileSync('../outside/sentinel.txt', 'stolen.txt')", /outside the workspace/);
        assert.ok(!fs.existsSync(path.join(outside, 'x.txt')) && !fs.existsSync(path.join(outside, 'moved.txt')));
        assert.ok(fs.existsSync(path.join(ws, 'data.txt')));
    });
    await check('protected names: root config.json, bridge_token anywhere, agent_settings.json, owner_ids writes', async () => {
        await refused("return require('fs').readFileSync('config.json', 'utf8')", /blocked/);
        await refused("require('fs').writeFileSync('deep/bridge_token', 'x')", /blocked/);
        await refused("return require('fs').readFileSync('agent_settings.json', 'utf8')", /blocked/);
        await refused("require('fs').writeFileSync('agent_settings.json', '{}')", /blocked/);
        await refused("require('fs').writeFileSync('owner_ids', '{}')", /blocked/);
        assert.strictEqual(fs.readFileSync(path.join(ws, 'owner_ids'), 'utf8'), '{"telegram":"111"}');
    });
    await check('descriptor, open, copy-tree and link APIs are refused', async () => {
        for (const call of ["fs.openSync('data.txt', 'r')", "fs.readSync(0, Buffer.alloc(1))", "fs.fstatSync(0)",
            "fs.writeSync(1, 'x')", "fs.closeSync(0)", "fs.cpSync('out', 'out2', { recursive: true })",
            "fs.symlinkSync('../outside', 'l')", "fs.linkSync('data.txt', 'h')", "fs.opendirSync('.')"]) {
            await refused(`const fs = require('fs'); return ${call}`, /not available/);
        }
        await refused("return await require('fs').promises.open('data.txt', 'r')", /not available/);
        await refused("return await require('fs/promises').cp('out', 'out3', { recursive: true })", /not available/);
    });
    await check('read APIs refuse write flags (string and numeric); the file is not truncated', async () => {
        await refused("return require('fs').readFileSync('data.txt', { flag: 'w' })", /write flag/);
        await refused("return require('fs').readFileSync('data.txt', { flag: 'r+' })", /write flag/);
        await refused(`return require('fs').readFileSync('data.txt', { flag: ${fs.constants.O_RDWR} })`, /write flag/);
        await refused(`return require('fs').readFileSync('data.txt', { flag: ${fs.constants.O_RDONLY | fs.constants.O_TRUNC} })`, /write flag/);
        await refused("return require('fs').createReadStream('data.txt', { flags: 'a+' })", /write flag/);
        await refused("return require('fs').readFileSync('data.txt', { flag: 'bogus' })", /unknown flag/);
        assert.strictEqual(fs.readFileSync(path.join(ws, 'data.txt'), 'utf8'), 'hello');
        assert.strictEqual(await ok("return require('fs').readFileSync('data.txt', { flag: 'r', encoding: 'utf8' })"), 'hello');
    });
    await check('fd and fs options are refused', async () => {
        await refused("return require('fs').createReadStream('data.txt', { fd: 0 })", /fd and fs options/);
        await refused("return require('fs').createWriteStream('w2.txt', { fs: { open() {} } })", /fd and fs options/);
    });
    await check('non-string paths are refused (fd numbers, URLs)', async () => {
        await refused("return require('fs').readFileSync(0)", /string or Buffer/);
        await refused("return require('fs').readFileSync(new URL('file:///etc/passwd'))", /string or Buffer/);
        assert.strictEqual(await ok("return require('fs').readFileSync(Buffer.from('data.txt'), 'utf8')"), 'hello');
    });
    await check('the fs façade is frozen and has no stream or Dir classes', async () => {
        await refused("const fs = require('fs'); fs.readFileSync = () => 'x'; return 1");
        assert.strictEqual(await ok("const fs = require('fs'); return [fs.ReadStream, fs.WriteStream, fs.Dir, fs.FileHandle].every(v => v === undefined)"), 'true');
    });
    if (process.platform === 'linux' && fs.existsSync('/proc/meminfo')) {
        await check('the exact /proc read list works; other /proc paths do not', async () => {
            assert.ok((await ok("return require('fs').readFileSync('/proc/meminfo', 'utf8').length > 0")) === 'true');
            await refused("return require('fs').readFileSync('/proc/self/environ', 'utf8')", /outside the workspace/);
            await refused("require('fs').writeFileSync('/proc/meminfo', 'x')", /outside the workspace/);
        });
    } else {
        console.log('SKIP: /proc cases (no /proc on this platform)');
    }

    // ---- links
    if (!canLink) {
        console.log('SKIP: link cases (this platform cannot create links)');
    } else {
        fs.symlinkSync(outside, path.join(ws, 'escape'), 'dir');
        fs.symlinkSync(path.join(outside, 'sentinel.txt'), path.join(ws, 'note-link.txt'));
        fs.symlinkSync(path.join(outside, 'created-through-link.txt'), path.join(ws, 'dangling.txt'));
        await check('a link out of the workspace is neither read nor written through', async () => {
            await refused("return require('fs').readFileSync('escape/sentinel.txt', 'utf8')", /outside the workspace/);
            await refused("return require('fs').readFileSync('note-link.txt', 'utf8')", /outside the workspace/);
            await refused("require('fs').writeFileSync('note-link.txt', 'pwned')");
            await refused("require('fs').appendFileSync('escape/sentinel.txt', 'pwned')");
            await refused("require('fs').writeFileSync('dangling.txt', 'x')", /is a link/);
            assert.strictEqual(sentinel(), 'sentinel');
            assert.ok(!fs.existsSync(path.join(outside, 'created-through-link.txt')));
        });
    }

    // ---- review round 1: option snapshots, roots, mkdtemp, encodings, module views
    await check('a Proxy or a getter cannot hide fd/fs or swap a flag after the check', async () => {
        await refused(`const p = new Proxy({}, { has: () => false, ownKeys: () => ['fd'],
            getOwnPropertyDescriptor: () => ({ value: 1, enumerable: true, configurable: true }), get: (t, k) => (k === 'fd' ? 1 : undefined) });
            return require('fs').createReadStream('data.txt', p)`, /proxy|fd and fs/);
        // A getter is read exactly once: the checked copy ('r') is what fs receives, so the read
        // succeeds and nothing is truncated.
        assert.strictEqual(await ok(`let n = 0; const o = { encoding: 'utf8', get flag() { n++; return n > 1 ? 'w+' : 'r'; } };
            return require('fs').readFileSync('data.txt', o) + n`), 'hello1');
        await refused("const net = require('net'); return new net.Socket(new Proxy({}, {}))", /proxy/);
        assert.strictEqual(fs.readFileSync(path.join(ws, 'data.txt'), 'utf8'), 'hello');
    });
    await check('the workspace root cannot be removed, renamed or changed (mkdir on it is fine)', async () => {
        await refused("require('fs').rmSync('.', { recursive: true, force: true })", /workspace folder itself/);
        await refused("require('fs').rmdirSync('.')", /workspace folder itself/);
        await refused("require('fs').renameSync('.', 'moved')", /workspace folder itself/);
        await refused("require('fs').chmodSync('.', 0)", /workspace folder itself/);
        await ok("require('fs').mkdirSync('.', { recursive: true }); return 1");
        assert.ok(fs.existsSync(path.join(ws, 'config.json')) && fs.existsSync(path.join(ws, 'owner_ids')));
    });
    await check('mkdtemp cannot create a directory beside the workspace', async () => {
        for (const prefix of ['', '.', 'sub/..']) {
            await refused(`return require('fs').mkdtempSync(${JSON.stringify(prefix)})`, /outside the workspace/);
        }
        const made = await ok("return require('fs').mkdtempSync('tmp-')");
        assert.ok(made.startsWith(path.join(path.resolve(ws), 'tmp-')), made);
        const inside = await ok("require('fs').mkdirSync('scratch', { recursive: true }); return require('fs').mkdtempSync('scratch/')");
        assert.ok(inside.startsWith(path.join(path.resolve(ws), 'scratch') + path.sep), inside);
        assert.ok(fs.readdirSync(tmp).every((n) => !n.startsWith('workspace') || n === 'workspace'));
    });
    await check('a read stream with an encoding yields strings and keeps multi-byte characters whole', async () => {
        fs.writeFileSync(path.join(ws, 'utf8.txt'), 'é'.repeat(5000));
        const code = `
            const chunks = [];
            for await (const c of require('fs').createReadStream('utf8.txt', { encoding: 'utf8', highWaterMark: 7 })) chunks.push(c);
            return JSON.stringify({ allStrings: chunks.every(c => typeof c === 'string'), text: chunks.join('') === 'é'.repeat(5000) })`;
        assert.strictEqual(await ok(code), JSON.stringify({ allStrings: true, text: true }));
    });
    await check('net.createConnection keeps its timeout option', async () => {
        const server = net.createServer(() => { /* never answers, never closes */ }).listen(0, '127.0.0.1');
        await new Promise((r) => server.once('listening', r));
        const port = server.address().port;
        try {
            const code = `
                return await new Promise((resolve) => {
                    const s = require('net').createConnection({ host: '127.0.0.1', port: ${port}, timeout: 300 });
                    s.on('timeout', () => { s.destroy(); resolve('timeout'); });
                    s.on('error', (e) => resolve('error ' + e.message));
                    setTimeout(() => resolve('no timeout fired'), 3000);
                });`;
            assert.strictEqual(await ok(code), 'timeout');
        } finally {
            server.close();
        }
    });
    await check('existsSync answers false for a path it may not look at (no throw)', async () => {
        assert.strictEqual(await ok("return require('fs').existsSync('../outside/sentinel.txt')"), 'false');
        assert.strictEqual(await ok("return require('fs').existsSync('data.txt')"), 'true');
    });
    await check('callback forms work and report refusals', async () => {
        const code = `
            const fs = require('fs');
            const read = await new Promise((res) => fs.readFile('data.txt', 'utf8', (e, d) => res(e ? 'err' : d)));
            await new Promise((res) => fs.writeFile('cb.txt', 'cb', res));
            let refused = 'no';
            try { fs.readFile('../outside/sentinel.txt', () => {}); } catch (e) { refused = 'yes'; }
            return read + ',' + fs.readFileSync('cb.txt', 'utf8') + ',' + refused`;
        assert.strictEqual(await ok(code), 'hello,cb,yes');
    });
    await check('allowlisted modules are read-only and process-wide setters are refused', async () => {
        await refused("require('https').request = () => 1; return 1", /cannot be modified/);
        await refused("Object.defineProperty(require('http'), 'get', { value: 1 }); return 1", /cannot be modified/);
        await refused("require('crypto').setEngine('/tmp/x.so')", /not available/);
        await refused("require('dns').setServers(['10.0.0.1'])", /not available/);
        await refused("require('dns').promises.setServers(['10.0.0.1'])", /not available/);
        assert.strictEqual(typeof require('https').request, 'function');
        assert.strictEqual(await ok("return require('https').globalAgent === require('https').globalAgent"), 'true');
        assert.strictEqual(await ok("return typeof require('crypto').randomBytes(4).length"), 'number');
    });
    await check('Unix-socket paths are refused (net, http, servers)', async () => {
        await refused("return require('net').connect({ path: '/tmp/x.sock' })", /Unix socket/);
        await refused("return require('net').connect('/tmp/x.sock')", /Unix socket/);
        await refused("return require('http').request({ socketPath: '/tmp/x.sock', path: '/' })", /Unix socket/);
        await refused("return require('net').createServer().listen('/tmp/x.sock')", /Unix socket/);
    });
    await check('an http request with a URL path option is not mistaken for a socket path', async () => {
        const server = require('http').createServer((req, res) => res.end(req.url)).listen(0, '127.0.0.1');
        await new Promise((r) => server.once('listening', r));
        const port = server.address().port;
        try {
            const code = `
                return await new Promise((resolve) => {
                    const req = require('http').request({ host: '127.0.0.1', port: ${port}, path: '/hello' }, (res) => {
                        let b = ''; res.setEncoding('utf8'); res.on('data', (c) => b += c); res.on('end', () => resolve(b));
                    });
                    req.on('error', (e) => resolve('error ' + e.message));
                    req.end();
                });`;
            assert.strictEqual(await ok(code), '/hello');
        } finally {
            server.close();
        }
    });
    await check('numeric flags must be 32-bit integers', async () => {
        await refused("return require('fs').readFileSync('data.txt', { flag: 2 ** 40 })", /unknown flag/);
    });

    // ---- sockets cannot wrap a descriptor
    await check('net.Socket / createConnection refuse fd and handle options', async () => {
        await refused("const net = require('net'); return new net.Socket({ fd: 0 })", /descriptor/);
        await refused("return require('net').createConnection({ fd: 0 })", /descriptor/);
        await refused("return require('net').connect({ handle: {} })", /descriptor/);
    });
    await check('the default HTTP agent and servers refuse descriptors (net-guard)', async () => {
        await refused("return require('http').globalAgent.createConnection({ fd: 0 })", /descriptor/);
        await refused("return require('http').createServer().listen({ fd: 0 })", /descriptor/);
        await refused("return require('net').createServer().listen({ handle: {} })", /descriptor/);
    });

    if (failures > 0) {
        console.log(`\n${failures} failure(s)`);
        process.exit(1);
    }
    console.log('\nAll js_eval confinement checks passed.');
    process.exit(0);
})();
