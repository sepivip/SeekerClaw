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
const { spawnSync } = require('child_process');

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

// Node's own NODE_* switches a user env var could try to set. config.js must drop all of them.
const NODE_NAMES = ['NODE_ENV', 'NODE_OPTIONS', 'NODE_TLS_REJECT_UNAUTHORIZED', 'NODE_EXTRA_CA_CERTS'];
// The environment this test was started with, before config.js merges user env vars.
const BASE_ENV = Object.assign({}, process.env);

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'p1l-'));
const ws = path.join(tmp, 'workspace');
fs.mkdirSync(ws);
fs.writeFileSync(path.join(ws, 'config.json'), JSON.stringify({
    botToken: 'placeholder-not-a-real-bot-token',
    anthropicApiKey: 'placeholder-not-a-real-api-key',
    ownerId: '111',
    channel: 'telegram',
    envVars: {
        NODE_ENV: 'development',
        NODE_OPTIONS: '--max-old-space-size=64',
        NODE_TLS_REJECT_UNAUTHORIZED: '0',
        NODE_EXTRA_CA_CERTS: '/sdcard/Download/p1l-test.pem',
        NODEJS_FLAG: 'on', // no underscore after NODE: an ordinary name
        MY_FLAG: 'on',
    },
}));
fs.writeFileSync(path.join(tmp, 'bridge_token'), '00000000-0000-0000-0000-000000000000');
process.argv[2] = ws;
// Start clean so the process.env checks below see only what config.js merged.
for (const k of NODE_NAMES) delete process.env[k];
process.on('exit', () => { try { fs.rmSync(tmp, { recursive: true, force: true }); } catch (_) {} });

const guard = require(path.join(BUNDLE, 'net-guard.js'));
guard.install();

/** Resolves 'connected' or the error code/message of a raw TCP attempt. */
function tcp(opts, timeoutMs = 3000) {
    return new Promise((resolve) => {
        const s = net.connect(opts, () => { s.destroy(); resolve('connected'); });
        s.on('error', (e) => resolve(e.code || e.message));
        setTimeout(() => { s.destroy(); resolve('timeout'); }, timeoutMs);
    });
}
/** A dns.lookup stand-in that answers [address] for every name (both lookup call shapes). */
function lookupTo(address) {
    return (h, o, cb) => {
        const done = typeof o === 'function' ? o : cb;
        return o && o.all ? done(null, [{ address, family: 4 }]) : done(null, address, 4);
    };
}
/** Runs [code] in a fresh Node with [env]; returns the JSON on its last stdout line. */
function runChild(code, env) {
    const r = spawnSync(process.execPath, ['-e', code], { cwd: tmp, env, encoding: 'utf8', timeout: 30000 });
    if (r.status !== 0) throw new Error(`child failed (${r.status}): ${r.stderr}`);
    return JSON.parse(r.stdout.trim().split('\n').pop());
}
/** Every file under [dir] (skipping node_modules) whose name ends with one of [exts]. */
function filesUnder(dir, exts) {
    const out = [];
    if (!fs.existsSync(dir)) return out;
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
        const f = path.join(dir, e.name);
        if (e.isDirectory()) { if (e.name !== 'node_modules') out.push(...filesUnder(f, exts)); } else if (exts.some((x) => e.name.endsWith(x))) out.push(f);
    }
    return out;
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
    // agent_pay's localhost exception needs NODE_ENV=development|test. Three facts keep it off in
    // the release build: nothing in the build sets NODE_ENV, a user env var cannot set any NODE_*
    // name, and with NODE_ENV unset the bridge URL is refused.
    await check('nothing in the native code, Gradle build, Kotlin or the JS bundle assigns NODE_ENV', () => {
        const rel = (f) => path.relative(ROOT, f).split(path.sep).join('/');
        // Native, Gradle and Kotlin: the name does not appear at all.
        const build = [
            ...filesUnder(path.join(ROOT, 'app', 'src', 'main', 'cpp'), ['.cpp', '.cc', '.c', '.h', '.hpp', 'CMakeLists.txt']),
            ...filesUnder(path.join(ROOT, 'app', 'src', 'main', 'java'), ['.kt', '.java']),
            ...filesUnder(path.join(ROOT, 'app', 'src', 'googlePlay'), ['.kt', '.java']),
            path.join(ROOT, 'app', 'build.gradle.kts'),
        ];
        assert.ok(build.some((f) => f.endsWith('native-lib.cpp')), 'the scan must cover native-lib.cpp');
        assert.deepStrictEqual(build.filter((f) => fs.readFileSync(f, 'utf8').includes('NODE_ENV')).map(rel), []);
        // The JS bundle: outside comments, every mention is a strict comparison of process.env.NODE_ENV.
        const writes = [];
        let reads = 0;
        for (const f of filesUnder(BUNDLE, ['.js'])) {
            const code = fs.readFileSync(f, 'utf8').replace(/\/\*[\s\S]*?\*\//g, '').split(/\r?\n/).map((l) => l.replace(/(^|[^:])\/\/.*$/, '$1'));
            code.forEach((line, i) => {
                for (const m of line.matchAll(/NODE_ENV/g)) {
                    const read = /process\.env\.$/.test(line.slice(0, m.index)) && /^\s*[!=]==/.test(line.slice(m.index + 8));
                    if (read) reads++;
                    else writes.push(`${rel(f)}:${i + 1}: ${line.trim()}`);
                }
            });
        }
        assert.deepStrictEqual(writes, [], 'a NODE_ENV mention that is not a comparison');
        assert.ok(reads >= 2, 'the scan sees the agent_pay and confirmation-policy reads');
    });
    await check('config.js drops every NODE_* user env var (the NODE_ prefix rule), ordinary names still apply', () => {
        const cfg = require(path.join(BUNDLE, 'config.js'));
        for (const k of NODE_NAMES) {
            assert.ok(!cfg.USER_ENV_KEYS.includes(k), `${k} became a user env var`);
            assert.strictEqual(process.env[k], undefined, `${k} reached process.env`);
        }
        // The rule is the `NODE_` prefix: NODEJS_FLAG is an ordinary name.
        assert.ok(cfg.USER_ENV_KEYS.includes('NODEJS_FLAG'), 'NODEJS_FLAG is not a NODE_ name');
        assert.ok(cfg.USER_ENV_KEYS.includes('MY_FLAG'), 'negative control: ordinary user env vars apply');
        assert.strictEqual(process.env.MY_FLAG, 'on');
    });
    await check("agent_pay refuses the bridge URL in a process with no NODE_ENV (as in the release build)", () => {
        const probe = `
            process.argv[2] = ${JSON.stringify(ws)};
            const pay = require(${JSON.stringify(path.join(BUNDLE, 'tools', 'agent_pay.js'))});
            const r = pay.preflightUrlSync('http://127.0.0.1:8765/x', 'GET');
            process.stdout.write('\\n' + JSON.stringify({ env: process.env.NODE_ENV === undefined ? null : process.env.NODE_ENV, ok: r.ok === true, error: r.error || null }) + '\\n');`;
        const env = Object.assign({}, BASE_ENV);
        for (const k of NODE_NAMES) delete env[k];
        const release = runChild(probe, env);
        assert.deepStrictEqual(release, { env: null, ok: false, error: 'non_https' });
        // Paired control: the same child with NODE_ENV=development takes the localhost exception.
        const dev = runChild(probe, Object.assign({}, env, { NODE_ENV: 'development' }));
        assert.deepStrictEqual(dev, { env: 'development', ok: true, error: null });
    });
    await check('an external host on a bridge port is allowed (resolved address is not loopback)', async () => {
        // ext.example resolves to TEST-NET-1, so the guard lets the connect go ahead; it then ends
        // on its own (timeout or unreachable), never with the guard's refusal.
        const viaName = await tcp({ host: 'ext.example', port: 8765, lookup: lookupTo('192.0.2.1') }, 500);
        assert.notStrictEqual(viaName, REFUSED, 'host name resolving to 192.0.2.1: ' + viaName);
        const viaLiteral = await tcp({ host: '192.0.2.1', port: 8765 }, 500);
        assert.notStrictEqual(viaLiteral, REFUSED, '192.0.2.1 literal: ' + viaLiteral);
        // Paired control: the same name resolving to loopback is refused (no server needed).
        assert.strictEqual(await tcp({ host: 'ext.example', port: 8765, lookup: lookupTo('127.0.0.1') }, 500), REFUSED);
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
            await check('a lookup answer is read once: getters, proxies, an overridden map() and a non-string host never reach a bridge port (Codex R2 on #459)', async () => {
                // A stand-in on 8766 too (both bridge ports); every case asserts the stand-in for
                // that port accepted no connection, not only that the result was an error.
                const ctl = http.createServer((q, r) => r.end('control')).on('error', () => {});
                const ctlUp = await new Promise((res) => { ctl.once('error', () => res(false)); ctl.listen(8766, '127.0.0.1', () => res(true)); });
                const accepted = { 8765: 0, 8766: 0 };
                const onConn8765 = () => accepted[8765]++;
                const onConn8766 = () => accepted[8766]++;
                bridge.on('connection', onConn8765);
                if (ctlUp) ctl.on('connection', onConn8766);
                // 192.0.2.1 (TEST-NET-1) never answers, so a connect there just times out.
                const attempt = (opts) => new Promise((resolve) => {
                    const s = net.connect(opts);
                    s.on('error', (e) => resolve(e.code || e.message));
                    s.on('connect', () => { const r = 'connected ' + s.remoteAddress; s.destroy(); resolve(r); });
                    setTimeout(() => { s.destroy(); resolve('timeout'); }, 1200);
                });
                try {
                    for (const port of ctlUp ? [8765, 8766] : [8765]) {
                        // autoSelectFamily: true makes net ask for every address (an array of
                        // records: the shape a getter or proxy can hide in); false asks for one
                        // address, a plain string with nothing mutable — kept as a control.
                        for (const autoSelectFamily of [true, false]) {
                            let reads = 0;
                            const getter = (h, o, cb) => {
                                const rec = { family: 4, get address() { return ++reads === 1 ? '192.0.2.1' : '127.0.0.1'; } };
                                return o && o.all ? cb(null, [rec]) : cb(null, rec.address, 4);
                            };
                            const r1 = await attempt({ host: 'r2.invalid', port, autoSelectFamily, lookup: getter });
                            assert.ok(!String(r1).startsWith('connected'), `getter, port ${port}, autoSelectFamily ${autoSelectFamily}: ${r1}`);
                            const proxied = (h, o, cb) => {
                                let n = 0;
                                const p = new Proxy([{ family: 4, address: '192.0.2.1' }], {
                                    get: (t, k) => (k === '0' ? (++n === 1 ? t[0] : { family: 4, address: '127.0.0.1' }) : t[k]),
                                });
                                return o && o.all ? cb(null, p) : cb(null, '192.0.2.1', 4);
                            };
                            const r2 = await attempt({ host: 'r2.invalid', port, autoSelectFamily, lookup: proxied });
                            assert.ok(!String(r2).startsWith('connected'), `proxy, port ${port}: ${r2}`);
                        }
                        const arr = [{ family: 4, address: '127.0.0.1' }];
                        arr.map = () => ['192.0.2.1'];
                        const overridden = (h, o, cb) => (o && o.all ? cb(null, arr) : cb(null, '127.0.0.1', 4));
                        assert.strictEqual(await attempt({ host: 'r2.invalid', port, autoSelectFamily: true, lookup: overridden }), REFUSED, `overridden map, port ${port}`);
                        let hreads = 0;
                        const hostObj = { toString() { return ++hreads <= 2 ? '192.0.2.1' : '127.0.0.1'; } };
                        // The guard refuses it before net (Node 22 would also reject it; Node 18 may not).
                        assert.strictEqual(await attempt({ host: hostObj, port }), REFUSED, `non-string host, port ${port}`);
                        // A length that changes between reads: read once, so the hidden loopback
                        // record at index 1 is never part of the answer net receives.
                        const growing = (h, o, cb) => {
                            let lenReads = 0;
                            const recs = [{ family: 4, address: '192.0.2.1' }, { family: 4, address: '127.0.0.1' }];
                            const p = new Proxy(recs, { get: (t, k) => (k === 'length' ? (++lenReads === 1 ? 1 : 2) : t[k]) });
                            return o && o.all ? cb(null, p) : cb(null, '192.0.2.1', 4);
                        };
                        const r4 = await attempt({ host: 'r2.invalid', port, autoSelectFamily: true, lookup: growing });
                        assert.ok(!String(r4).startsWith('connected'), `length proxy, port ${port}: ${r4}`);
                    }
                    assert.deepStrictEqual(accepted, { 8765: 0, 8766: 0 }, 'no connection reached a bridge-port stand-in');
                    // Controls: a custom lookup with a plain answer still works for another loopback
                    // port, and a plain external answer on a bridge port is not refused.
                    const plain = (h, o, cb) => (o && o.all ? cb(null, [{ family: 4, address: '127.0.0.1' }]) : cb(null, '127.0.0.1', 4));
                    assert.strictEqual(await attempt({ host: 'ok.invalid', port: otherPort, autoSelectFamily: true, lookup: plain }), 'connected 127.0.0.1');
                    const external = (h, o, cb) => (o && o.all ? cb(null, [{ family: 4, address: '192.0.2.1' }]) : cb(null, '192.0.2.1', 4));
                    assert.notStrictEqual(await attempt({ host: 'ext.invalid', port: 8765, autoSelectFamily: true, lookup: external }), REFUSED);
                    // js_eval reaches the same guard through its net façade.
                    const sys = require(path.join(BUNDLE, 'tools', 'system.js'));
                    const viaEval = await sys.handlers.js_eval({ code: `
                        let reads = 0;
                        const lookup = (h, o, cb) => cb(null, [{ family: 4, get address() { return ++reads === 1 ? '192.0.2.1' : '127.0.0.1'; } }]);
                        return await new Promise((resolve) => {
                            const s = require('net').connect({ host: 'r2.invalid', port: 8765, autoSelectFamily: true, lookup });
                            s.on('error', (e) => resolve(e.code || e.message));
                            s.on('connect', () => { s.destroy(); resolve('connected'); });
                            setTimeout(() => { s.destroy(); resolve('timeout'); }, 1200);
                        });` }, 'chat');
                    // The snippet must have run (an error shape has no result and would pass vacuously):
                    // the guard read the getter once, saw 192.0.2.1 and let net try that address,
                    // which times out or fails with a network error — never a connection.
                    assert.strictEqual(viaEval.success, true, 'js_eval snippet did not run: ' + JSON.stringify(viaEval));
                    assert.match(String(viaEval.result), /^(timeout|E[A-Z]+)$/, 'js_eval getter: ' + JSON.stringify(viaEval));
                    assert.deepStrictEqual(accepted, { 8765: 0, 8766: 0 }, 'js_eval reached no bridge-port stand-in');
                } finally {
                    bridge.removeListener('connection', onConn8765);
                    ctl.close();
                }
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
