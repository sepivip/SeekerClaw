#!/usr/bin/env node
// bridge-port-guard.test.js — BAT-1409 P1-L. No code in the Node process reaches the app's
// internal ports (8765 bridge, 8766 control server) on a loopback address, checked on the RESOLVED
// address, except bridge.js's own marked requests. Other loopback ports and other hosts work.
// Also pins: netwatch no longer probes those ports (drift), its shipped js_eval snippets are not
// refused, and agent_pay's localhost exception stays unreachable (NODE_ENV unset and reserved).
//
// A stand-in server listens on 127.0.0.1:8765 (the real bridge is Kotlin). If the port is taken
// on this machine the behavioural cases are skipped and the pins still run.
//
// Run:  node tests/nodejs-project/bridge-port-guard.test.js

'use strict';

const assert = require('assert');
const fs = require('fs');
const http = require('http');
const net = require('net');
const os = require('os');
const path = require('path');

const ROOT = path.resolve(__dirname, '..', '..');
const BUNDLE = path.join(ROOT, 'app', 'src', 'main', 'assets', 'nodejs-project');
const NETWATCH = path.join(ROOT, 'app', 'src', 'main', 'assets', 'default-skills', 'netwatch');

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

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'p1l-'));
const ws = path.join(tmp, 'workspace');
fs.mkdirSync(ws);
fs.writeFileSync(path.join(ws, 'config.json'), JSON.stringify({
    botToken: 'placeholder-not-a-real-bot-token',
    anthropicApiKey: 'placeholder-not-a-real-api-key',
    ownerId: '111',
    channel: 'telegram',
    envVars: { NODE_ENV: 'development', MY_FLAG: 'on' },
}));
fs.writeFileSync(path.join(tmp, 'bridge_token'), '00000000-0000-0000-0000-000000000000');
process.argv[2] = ws;
delete process.env.NODE_ENV;
process.on('exit', () => { try { fs.rmSync(tmp, { recursive: true, force: true }); } catch (_) {} });

const guard = require(path.join(BUNDLE, 'net-guard.js'));
guard.install();

/** Resolves 'connected' or the error code/message of a raw TCP attempt. */
function tcp(opts) {
    return new Promise((resolve) => {
        const s = net.connect(opts, () => { s.destroy(); resolve('connected'); });
        s.on('error', (e) => resolve(e.code || e.message));
        setTimeout(() => { s.destroy(); resolve('timeout'); }, 3000);
    });
}
function httpGet(urlOrOpts) {
    return new Promise((resolve) => {
        const req = http.get(urlOrOpts, (res) => { res.resume(); res.on('end', () => resolve('status ' + res.statusCode)); });
        req.on('error', (e) => resolve(e.code || e.message));
        setTimeout(() => { req.destroy(); resolve('timeout'); }, 3000);
    });
}
const REFUSED = 'ERR_SEEKERCLAW_SOCKET_REFUSED';

(async () => {
    // ---- pins that need no server
    await check('the bridge ports are 8765 and 8766', () => {
        assert.deepStrictEqual([...guard.BRIDGE_PORTS].sort(), [8765, 8766]);
    });
    await check('loopback detection covers 127/8, 0/8, ::1, ::, mapped and compatible forms', () => {
        for (const a of ['127.0.0.1', '127.1.2.3', '0.0.0.0', '::1', '[::1]', '::', '0:0:0:0:0:0:0:1', '::ffff:127.0.0.1', '::ffff:7f00:1', '::127.0.0.1', '::1%lo']) {
            assert.ok(guard.isLoopbackAddress(a), a);
        }
        for (const a of ['10.0.0.1', '192.168.1.5', '8.8.8.8', '::ffff:8.8.8.8', '2001:db8::1', 'localhost', '']) {
            assert.ok(!guard.isLoopbackAddress(a), a);
        }
    });
    await check('netwatch no longer names the internal ports (drift)', () => {
        for (const f of ['SKILL.md', 'TESTING.md']) {
            const text = fs.readFileSync(path.join(NETWATCH, f), 'utf8');
            assert.ok(!/8765|8766/.test(text), `${f} still mentions an internal port`);
        }
    });
    await check("agent_pay's localhost exception is off: NODE_ENV is unset and reserved", () => {
        const cfg = require(path.join(BUNDLE, 'config.js'));
        assert.ok(!cfg.USER_ENV_KEYS.includes('NODE_ENV'), 'a user env var cannot set NODE_ENV');
        assert.ok(cfg.USER_ENV_KEYS.includes('MY_FLAG'), 'negative control: ordinary user env vars apply');
        assert.strictEqual(process.env.NODE_ENV, undefined);
        const pay = require(path.join(BUNDLE, 'tools', 'agent_pay.js'));
        const r = pay.preflightUrlSync('http://127.0.0.1:8765/x', 'GET');
        assert.strictEqual(r.error, 'non_https', JSON.stringify(r));
    });

    // ---- P1-F: no Unix-socket connect, by any route (no server needed: the refusal comes first)
    await check('Unix-socket connects are refused on every route (net, plain Socket, tls, agent)', async () => {
        const sock = os.platform() === 'win32' ? '\\\\.\\pipe\\seekerclaw-p1f-test' : path.join(tmp, 'p1f.sock');
        const settle = (s) => new Promise((resolve) => {
            s.on('error', (e) => resolve(e.code || e.message));
            s.on('connect', () => { s.destroy(); resolve('connected'); });
            setTimeout(() => { s.destroy(); resolve('timeout'); }, 3000);
        });
        assert.strictEqual(await settle(net.connect({ path: sock })), REFUSED, 'net.connect({ path })');
        assert.strictEqual(await settle(net.connect(sock)), REFUSED, 'net.connect(path)');
        assert.strictEqual(await settle(new net.Socket().connect(sock)), REFUSED, 'new net.Socket().connect(path)');
        assert.strictEqual(await settle(new net.Socket().connect({ path: sock })), REFUSED, 'Socket#connect({ path })');
        assert.strictEqual(await settle(require('tls').connect({ path: sock })), REFUSED, 'tls.connect({ path })');
        assert.strictEqual(await settle(new http.Agent().createConnection({ path: sock })), REFUSED, 'Agent#createConnection({ path })');
        assert.strictEqual(await httpGet({ socketPath: sock, path: '/' }), REFUSED, 'http.get({ socketPath })');
        // Negative control: a TCP connect whose http options carry `path: null` (the URL-path slot)
        // is not mistaken for a pipe — it fails for its own reason, not ours.
        const tcpNullPath = await settle(net.connect({ host: '127.0.0.1', port: 9, path: null }));
        assert.notStrictEqual(tcpNullPath, REFUSED, 'path: null is a TCP connect');
    });
    await check('an array first argument is checked as the options object Node reads it as', async () => {
        // A caller's array has no net-internal marker, so Node normalizes it again and reads the
        // array itself as options. Both the socket-path and the bridge-port checks must see it.
        const sock = os.platform() === 'win32' ? '\\\\.\\pipe\\seekerclaw-p1f-array' : path.join(tmp, 'p1f-array.sock');
        const settle = (s) => new Promise((resolve) => {
            s.on('error', (e) => resolve(e.code || e.message));
            s.on('connect', () => { s.destroy(); resolve('connected'); });
            setTimeout(() => { s.destroy(); resolve('timeout'); }, 3000);
        });
        assert.strictEqual(await settle(new net.Socket().connect(Object.assign([], { path: sock }))), REFUSED, 'array with path');
        assert.strictEqual(await settle(new net.Socket().connect(Object.assign([], { port: 8765, host: '127.0.0.1' }))), REFUSED, 'array with the bridge port');
        assert.strictEqual(await settle(new net.Socket().connect([{ port: 8765, host: '127.0.0.1' }])), REFUSED, '[options] array');
        // js_eval reaches a real net.Socket through its facade's factory.
        const sys = require(path.join(BUNDLE, 'tools', 'system.js'));
        const r = await sys.handlers.js_eval({ code: `
            return await new Promise((resolve) => {
                const s = new (require('net').Socket)().connect(Object.assign([], { port: 8765, host: '127.0.0.1' }));
                s.on('error', (e) => resolve(e.code || e.message));
                s.on('connect', () => { s.destroy(); resolve('connected'); });
                setTimeout(() => resolve('timeout'), 2000);
            });` }, 'chat');
        assert.strictEqual(r.result, REFUSED, 'js_eval array with the bridge port: ' + r.result);
    });
    await check('js_eval cannot open a Unix socket through tls, an agent or a plain Socket', async () => {
        const sys = require(path.join(BUNDLE, 'tools', 'system.js'));
        const run = async (code) => (await sys.handlers.js_eval({ code }, 'chat')).result;
        const sock = os.platform() === 'win32' ? '\\\\\\\\.\\\\pipe\\\\x' : '/tmp/x.sock';
        const settle = (expr) => `
            return await new Promise((resolve) => {
                const s = ${expr};
                s.on('error', (e) => resolve(e.code || e.message));
                s.on('connect', () => { s.destroy(); resolve('connected'); });
                setTimeout(() => resolve('timeout'), 2000);
            });`;
        for (const expr of [
            `require('tls').connect({ path: '${sock}' })`,
            `new (require('http').Agent)().createConnection({ path: '${sock}' })`,
            `new (require('net').Socket)().connect('${sock}')`,
        ]) {
            const r = await run(settle(expr));
            assert.strictEqual(r, REFUSED, `${expr} → ${r}`);
        }
    });

    // ---- behaviour against a stand-in bridge
    const bridge = http.createServer((req, res) => res.end('bridge')).on('error', () => {});
    const listening = await new Promise((resolve) => {
        bridge.once('error', () => resolve(false));
        bridge.listen(8765, '127.0.0.1', () => resolve(true));
    });
    if (!listening) {
        console.log('SKIP: behavioural cases (port 8765 is in use on this machine)');
    } else {
        const other = http.createServer((req, res) => res.end('other')).listen(0, '127.0.0.1');
        await new Promise((r) => other.once('listening', r));
        const otherPort = other.address().port;
        try {
            await check('raw TCP to the bridge port on loopback is refused (literal, localhost, mapped, 0.0.0.0)', async () => {
                assert.strictEqual(await tcp({ host: '127.0.0.1', port: 8765 }), REFUSED);
                assert.strictEqual(await tcp({ host: 'localhost', port: 8765 }), REFUSED);
                assert.strictEqual(await tcp({ port: 8765 }), REFUSED);
                assert.strictEqual(await tcp({ host: '::ffff:127.0.0.1', port: 8765 }), REFUSED);
                assert.strictEqual(await tcp({ host: '0.0.0.0', port: 8765 }), REFUSED);
                assert.strictEqual(await tcp({ host: '127.0.0.1', port: '8766' }), REFUSED);
                assert.strictEqual(await new Promise((resolve) => {
                    const s = new net.Socket();
                    s.on('error', (e) => resolve(e.code));
                    s.connect(8765, '127.0.0.1', () => resolve('connected'));
                }), REFUSED);
            });
            await check('a host name that resolves to loopback is refused (checked on the resolved address)', async () => {
                const lookup = (h, o, cb) => (o && o.all ? cb(null, [{ address: '127.0.0.1', family: 4 }]) : cb(null, '127.0.0.1', 4));
                assert.strictEqual(await tcp({ host: 'bridge.example', port: 8765, lookup }), REFUSED);
            });
            await check('http and tls clients are refused too', async () => {
                assert.strictEqual(await httpGet('http://127.0.0.1:8765/'), REFUSED);
                assert.strictEqual(await httpGet('http://localhost:8765/status'), REFUSED);
                assert.strictEqual(await httpGet({ host: '127.0.0.1', port: 8765, agent: new http.Agent({ keepAlive: true }) }), REFUSED);
                const viaTls = await new Promise((resolve) => {
                    const s = require('tls').connect({ host: '127.0.0.1', port: 8765, rejectUnauthorized: false });
                    s.on('error', (e) => resolve(e.code || e.message));
                    s.on('secureConnect', () => { s.destroy(); resolve('connected'); });
                });
                assert.strictEqual(viaTls, REFUSED);
            });
            await check('short IPv4 forms are caught on the resolved address', async () => {
                const r = await tcp({ host: '127.1', port: 8765 });
                assert.ok(r === REFUSED || r === 'ENOTFOUND', r);
            });
            await check('options are read once: a getter cannot show one port to the check and another to connect', async () => {
                let n = 0;
                const r = await new Promise((resolve) => {
                    const s = new net.Socket();
                    s.on('error', (e) => resolve(e.code || e.message));
                    s.connect({ get port() { return n++ ? 8765 : otherPort; }, host: '127.0.0.1' }, () => { const rp = s.remotePort; s.destroy(); resolve('connected:' + rp); });
                });
                // Whatever the first read said is what connect used.
                assert.strictEqual(r, 'connected:' + otherPort);
                const opts = { host: 'bridge.example', port: 8765 };
                Object.defineProperty(opts, 'lookup', { get: () => (h, o, cb) => (o && o.all ? cb(null, [{ address: '127.0.0.1', family: 4 }]) : cb(null, '127.0.0.1', 4)), set: () => {}, enumerable: true });
                assert.strictEqual(await tcp(opts), REFUSED);
                assert.strictEqual(Object.getOwnPropertyDescriptor(opts, 'lookup').set !== undefined, true, "the caller's object is not changed");
            });
            await check('negative control: other loopback ports still work', async () => {
                assert.strictEqual(await tcp({ host: '127.0.0.1', port: otherPort }), 'connected');
                assert.strictEqual(await httpGet(`http://127.0.0.1:${otherPort}/`), 'status 200');
            });
            await check("bridge.js's own marked request reaches the bridge", async () => {
                const { androidBridgeCall } = require(path.join(BUNDLE, 'bridge.js'));
                const r = await androidBridgeCall('/ping', {}, 3000);
                // The stand-in answers 'bridge' (not JSON): reaching it is what counts here.
                assert.deepStrictEqual(r, { error: 'Invalid response from Android Bridge' });
            });
            await check('js_eval cannot reach the bridge port; a TCP probe elsewhere still works', async () => {
                const sys = require(path.join(BUNDLE, 'tools', 'system.js'));
                const run = async (code) => (await sys.handlers.js_eval({ code }, 'chat')).result;
                const probe = (port) => `
                    return await new Promise((resolve) => {
                        const s = require('net').createConnection({ host: '127.0.0.1', port: ${port}, timeout: 2000 }, () => { s.destroy(); resolve('open'); });
                        s.on('error', (e) => resolve(e.code || e.message));
                    });`;
                assert.strictEqual(await run(probe(8765)), REFUSED);
                assert.strictEqual(await run(probe(otherPort)), 'open');
                const viaHttp = await run(`
                    return await new Promise((resolve) => {
                        const r = require('http').get('http://localhost:8765/', () => resolve('reached'));
                        r.on('error', (e) => resolve(e.code || e.message));
                    });`);
                assert.strictEqual(viaHttp, REFUSED);
                // After a bridge call (a pooled keep-alive socket on newer Node), js_eval's request
                // still opens its own connection and is refused.
                await require(path.join(BUNDLE, 'bridge.js')).androidBridgeCall('/ping', {}, 3000);
                const afterBridge = await run(`
                    return await new Promise((resolve) => {
                        const r = require('http').get('http://127.0.0.1:8765/', () => resolve('reached'));
                        r.on('error', (e) => resolve(e.code || e.message));
                    });`);
                assert.strictEqual(afterBridge, REFUSED);
            });
            await check("netwatch's shipped TCP probe snippets are not refused", async () => {
                const sys = require(path.join(BUNDLE, 'tools', 'system.js'));
                const text = fs.readFileSync(path.join(NETWATCH, 'SKILL.md'), 'utf8');
                const blocks = [...text.matchAll(/```javascript\r?\n([\s\S]*?)```/g)].map((m) => m[1]).filter((b) => b.includes("require('net')"));
                assert.ok(blocks.length >= 2, 'netwatch ships its local and deep-scan TCP probes');
                for (const code of blocks) {
                    // Local probes target the stand-in's neighbour; the deep-scan IP is a TEST-NET
                    // address, so the probe ends quickly with a timeout or an unreachable error.
                    const local = code.replace(/const port = \d+;/, `const port = ${otherPort};`).replace(/'192\.168\.31\.89'/g, "'192.0.2.1'");
                    const r = await sys.handlers.js_eval({ code: local }, 'chat');
                    assert.ok(r.success, 'snippet failed to run: ' + r.error);
                    const out = JSON.parse(r.result);
                    assert.ok(typeof out.open === 'boolean', 'a real probe result: ' + r.result);
                    assert.ok(!String(out.error || '').includes(REFUSED), 'probe refused: ' + r.result);
                }
                // Negative control: the same snippet aimed at the bridge port is refused.
                const toBridge = blocks[0].replace(/const port = \d+;/, 'const port = 8765;');
                const nr = await sys.handlers.js_eval({ code: toBridge }, 'chat');
                assert.ok(String(nr.result).includes('internal app port'), 'expected a refusal: ' + nr.result);
            });
        } finally {
            other.close();
        }
    }
    bridge.close();

    if (failures > 0) {
        console.log(`\n${failures} failure(s)`);
        process.exit(1);
    }
    console.log('\nAll bridge-port guard checks passed.');
    process.exit(0);
})();
