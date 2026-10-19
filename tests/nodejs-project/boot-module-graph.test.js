#!/usr/bin/env node
// boot-module-graph.test.js — BAT-1409 P1-B harness (contract v3.2 §5 "P1-B harness").
//
// P1-B claims that a bundle file changed during a session cannot be picked up later in that
// session: every bundle module is loaded at boot (no lazy require from disk after it) and every
// non-JS bundle read (sql-wasm.wasm, model-registry.json) completes before the first inbound
// dispatch. This test boots the REAL main.js in a child process and checks exactly that.
//
// HOW
//   node -r <preload> main.js <scratch workDir>, with the workspace seeded by
//   tests/live/_shared/fixture.js (provider claude/api_key, owner set). The preload:
//     - redirects every outbound https request to a stub HTTP server in this (parent) process
//       (Telegram Bot API, Anthropic, Discord REST, anything else gets a 404); DNS for every other
//       host fails, so nothing reaches the network;
//     - routes the Discord gateway (wss://gateway.discord.gg) to a local WebSocket server here;
//     - wraps fs.readFileSync / fs.readFile / fs.promises.readFile (and fs.createReadStream) and
//       records every read of a path inside the bundle directory;
//     - snapshots Object.keys(require.cache) at END OF BOOT;
//     - wraps database.initDatabase and message-handler.handleMessage (on their exports, as main.js
//       destructures them) to record when the DB is ready and when the first dispatch starts/ends;
//     - remaps the control server's 127.0.0.1:8766 listen to an ephemeral port, so a local run
//       never collides with another test holding 8766 (CI runs tests one at a time anyway).
//   The stub Android bridge listens on 127.0.0.1:8765 here and answers {}.
//
// END OF BOOT
//   Telegram: the first stubbed getUpdates. That is main.js's startup flush (offset -1), which
//   comes after initDatabase/indexing/control server and is answered empty (an update returned
//   there is discarded by main.js as stale). The owner's message is delivered by the first long
//   poll right after it.
//   Discord: there is no getUpdates; the analogue is the first gateway connect, made by
//   channel.start() after the same boot steps. The owner's message is a MESSAGE_CREATE after READY.
//   The dispatch is a full agent turn: the stub model asks for one js_eval tool call, then answers
//   with text, which is sent back to the owner. End of dispatch = handleMessage settles.
//
// ASSERTIONS (per channel)
//   1. Module graph: every bundle .js file is in require.cache at end of boot, or on ALLOWLIST with
//      a written reason. Allowlist reasons are cross-checked (test-only file is required by no
//      bundle module; a channel-specific file is loaded on the other channel's boot).
//   2. Read spy: zero bundle-path reads from end of boot to the end of the first dispatch.
//   3. initDatabase resolved (and the DB was created) before the first dispatch started.
//   Harness sanity (so a pass is never vacuous): the dispatch ran the tool loop and the reply
//   reached the stub channel.
// NEGATIVE CONTROL (built in): the bundle is copied to a temp dir and mutated — a new file
//   lazy-fixture.js is required only inside handleMessage, and main.js no longer awaits a delayed
//   initDatabase. All three assertions must then fail, each for the expected reason.
// bufferutil: a planted `bufferutil` next to a scratch copy of node_modules/ws is loaded when one
//   frame is sent without the env var (control), and is not loaded with WS_NO_BUFFER_UTIL=1 or
//   after main.js's own P1-B preamble.
//
// Run:  node tests/nodejs-project/boot-module-graph.test.js
//       (P1B_KEEP_TMP=1 keeps the scratch dirs for debugging.)

'use strict';

const assert = require('assert');
const fs = require('fs');
const http = require('http');
const os = require('os');
const path = require('path');
const { spawn, spawnSync } = require('child_process');

const ROOT = path.resolve(__dirname, '..', '..');
const BUNDLE = fs.realpathSync(path.join(ROOT, 'app', 'src', 'main', 'assets', 'nodejs-project'));
const { seedFixture, CANON_BRIDGE_TOKEN } = require(path.join(ROOT, 'tests', 'live', '_shared', 'fixture.js'));

const KEEP_TMP = process.env.P1B_KEEP_TMP === '1';
const BOOT_DEADLINE_MS = 45000;
const TG_OWNER = '100000001';
const DC_OWNER = '200000001';
const DC_DM = '300000001';
const USER_TEXT = 'hello from the P1-B harness';
const REPLY_TEXT = 'P1B harness reply 42';
const CLAUDE_MODEL = (() => {
    const reg = JSON.parse(fs.readFileSync(path.join(BUNDLE, 'model-registry.json'), 'utf8'));
    return reg.providers.find((p) => p.id === 'claude').defaultModel;
})();

// Bundle .js files that may legitimately be absent from require.cache at end of boot. Each entry
// has a reason; channel-specific reasons are cross-checked against the other channel's boot, and
// the test-only reason against a source scan. A trailing `/**` matches a whole directory.
const ALLOWLIST = {
    common: {
        'custom-config-signature.js': 'test-only: no bundle module requires it (source scan below); only its tests load it',
    },
    telegram: {
        'discord.js': 'Discord channel only: channel.js requires it when CHANNEL === "discord"',
        'node_modules/ws/**': 'the ws package is required only by discord.js, so it never loads on Telegram',
    },
    discord: {
        'tools/telegram.js': 'Telegram tools only: tools/index.js requires it when CHANNEL === "telegram"',
    },
};

let failures = 0;
async function check(label, fn) {
    try {
        await fn();
        console.log('PASS: ' + label);
    } catch (e) {
        const where = e && e.stack ? (e.stack.split('\n').find((l) => l.includes(__filename)) || '').trim() : '';
        console.log('FAIL: ' + label + ' — ' + (e && e.message ? e.message : e) + (where ? '\n    ' + where : ''));
        failures++;
    }
}

// ============================================================================
// The preload. Stringified into the child; it must not close over anything in this file.
// ============================================================================
function harnessPreload() {
    'use strict';
    const fs = require('fs');
    const path = require('path');
    const http = require('http');
    const https = require('https');
    const net = require('net');
    const dns = require('dns');
    const Module = require('module');
    const { fileURLToPath } = require('url');

    const H = JSON.parse(process.env.SC_P1B_HARNESS);
    const BUNDLE = H.bundle; // already a realpath; require.cache keys are realpaths too
    const fold = (p) => (process.platform === 'win32' ? p.toLowerCase() : p);
    const PREFIX = fold(BUNDLE + path.sep);
    const inBundle = (abs) => fold(abs).startsWith(PREFIX);
    const rel = (abs) => path.relative(BUNDLE, abs).split(path.sep).join('/');

    let seq = 0;
    let phase = 'boot'; // boot → post-boot (end of boot) → after-dispatch
    let finished = false;
    const events = [];
    const reads = [];
    const notes = [];
    const blockedHosts = [];
    let cacheAtBoot = null;
    const mark = (name, extra) => events.push(Object.assign({ seq: ++seq, name, phase, t: Date.now() }, extra || {}));
    const bundleCacheKeys = () => Object.keys(require.cache).map((k) => path.resolve(k)).filter(inBundle).map(rel).sort();

    // ---- read spy on bundle paths
    function pathOf(p) {
        if (typeof p === 'string') return p;
        if (Buffer.isBuffer(p)) return p.toString('utf8');
        if (p && typeof p === 'object' && p.protocol === 'file:' && typeof p.href === 'string') return fileURLToPath(p);
        return null; // a descriptor: not a path read
    }
    function spy(api, p) {
        const s = pathOf(p);
        if (s === null) return;
        const abs = path.resolve(s);
        if (inBundle(abs)) reads.push({ seq: ++seq, phase, api, file: rel(abs) });
    }
    const realReadFileSync = fs.readFileSync;
    fs.readFileSync = function readFileSync(p, ...rest) { spy('readFileSync', p); return realReadFileSync.call(this, p, ...rest); };
    const realReadFile = fs.readFile;
    fs.readFile = function readFile(p, ...rest) { spy('readFile', p); return realReadFile.call(this, p, ...rest); };
    const fsp = fs.promises;
    const realPReadFile = fsp.readFile;
    fsp.readFile = function readFile(p, ...rest) { spy('promises.readFile', p); return realPReadFile.call(this, p, ...rest); };
    const realCreateReadStream = fs.createReadStream;
    fs.createReadStream = function createReadStream(p, ...rest) { spy('createReadStream', p); return realCreateReadStream.call(this, p, ...rest); };

    function finish(reason) {
        if (finished) return;
        finished = true;
        mark('finish', { reason });
        const out = { reason, events, reads, notes, blockedHosts, cacheAtBoot, cacheAtEnd: bundleCacheKeys() };
        fs.writeFileSync(H.resultFile, JSON.stringify(out, null, 1));
        setTimeout(() => process.exit(0), 20);
    }
    setTimeout(() => finish('deadline'), H.deadlineMs).unref();

    function endOfBoot(how) {
        if (cacheAtBoot) return;
        cacheAtBoot = bundleCacheKeys();
        mark('end-of-boot', { how });
        phase = 'post-boot';
    }

    // ---- initDatabase / handleMessage hooks, on the exports objects main.js destructures
    const wrapped = new Set();
    function cacheEntry(name) {
        const want = fold(path.join(BUNDLE, name));
        const key = Object.keys(require.cache).find((k) => fold(path.resolve(k)) === want);
        return key ? require.cache[key] : null;
    }
    function hookExports() {
        const db = cacheEntry('database.js');
        if (!wrapped.has('db') && db && typeof db.exports.initDatabase === 'function') {
            wrapped.add('db');
            const real = db.exports.initDatabase;
            db.exports.initDatabase = async function initDatabase(...a) {
                mark('initDatabase-start');
                const r = await real.apply(this, a);
                mark('initDatabase-resolved');
                return r;
            };
        }
        const mh = cacheEntry('message-handler.js');
        if (!wrapped.has('mh') && mh && typeof mh.exports.handleMessage === 'function') {
            wrapped.add('mh');
            const real = mh.exports.handleMessage;
            let n = 0;
            mh.exports.handleMessage = async function handleMessage(...a) {
                const i = ++n;
                mark('dispatch-start', { i });
                try {
                    return await real.apply(this, a);
                } finally {
                    mark('dispatch-end', { i });
                    if (i === 1) {
                        phase = 'after-dispatch';
                        finish('dispatched');
                    }
                }
            };
        }
    }
    const realLoad = Module._load;
    Module._load = function _load(request) {
        const exp = realLoad.apply(this, arguments);
        if (typeof request === 'string' && /(^|[\\/])(database|message-handler)(\.js)?$/.test(request)) hookExports();
        return exp;
    };

    // ---- network: nothing leaves the machine
    const realLookup = dns.lookup;
    dns.lookup = function lookup(hostname, options, callback) {
        const cb = typeof options === 'function' ? options : callback;
        if (hostname === 'localhost' || net.isIP(String(hostname))) return realLookup.apply(this, arguments);
        blockedHosts.push(String(hostname));
        const err = Object.assign(new Error(`getaddrinfo ENOTFOUND ${hostname} (no network in the P1-B harness)`), { code: 'ENOTFOUND', hostname });
        process.nextTick(cb, err);
        return {};
    };

    const realHttpRequest = http.request;
    let getUpdatesSeen = 0;
    function requestArgs(args) {
        let url = null;
        let opts = {};
        let cb;
        for (const a of args) {
            if (typeof a === 'string') url = new URL(a);
            else if (a instanceof URL) url = a;
            else if (typeof a === 'function') cb = a;
            else if (a && typeof a === 'object') opts = a;
        }
        if (url) {
            opts = Object.assign({ protocol: url.protocol, hostname: url.hostname, port: url.port, path: url.pathname + url.search }, opts);
        }
        return { opts, cb };
    }
    https.request = function request(...args) {
        const { opts, cb } = requestArgs(args);
        const host = String(opts.hostname || opts.host || 'localhost').replace(/:\d+$/, '');
        if (host === 'gateway.discord.gg') {
            // ws builds the upgrade request with https.request + its own TLS createConnection; hand it
            // a plain TCP socket to the local gateway instead.
            endOfBoot('discord gateway connect');
            const o = Object.assign({}, opts, { createConnection: () => net.connect(H.gatewayPort, '127.0.0.1') });
            delete o.agent;
            return realHttpRequest(o, cb);
        }
        if (host === 'api.telegram.org' && /\/getUpdates$/.test(String(opts.path || ''))) {
            getUpdatesSeen++;
            if (getUpdatesSeen === 1) endOfBoot('first getUpdates');
        }
        const o = Object.assign({}, opts, {
            protocol: 'http:', host: '127.0.0.1', hostname: '127.0.0.1', port: H.stubPort, agent: false,
            headers: Object.assign({}, opts.headers || {}, { 'x-sc-host': host }),
        });
        delete o.createConnection;
        return realHttpRequest(o, cb);
    };
    https.get = function get(...args) {
        const req = https.request(...args);
        req.end();
        return req;
    };

    // The control server binds 127.0.0.1:8766; use an ephemeral port so a local run cannot collide.
    const realListen = net.Server.prototype.listen;
    net.Server.prototype.listen = function listen(...args) {
        const a0 = args[0];
        if (a0 === 8766 || (a0 && typeof a0 === 'object' && Number(a0.port) === 8766)) {
            notes.push('control server 8766 remapped to an ephemeral port');
            args[0] = typeof a0 === 'object' ? Object.assign({}, a0, { port: 0 }) : 0;
        }
        return realListen.apply(this, args);
    };
}

// ============================================================================
// Parent side: stub servers, one boot, result checks
// ============================================================================
function listJs(bundle) {
    const out = [];
    (function walk(dir) {
        for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
            const full = path.join(dir, e.name);
            if (e.isDirectory()) walk(full);
            else if (e.isFile() && e.name.endsWith('.js')) out.push(path.relative(bundle, full).split(path.sep).join('/'));
        }
    })(bundle);
    return out.sort();
}

/** Plain recursive copy (fs.cpSync is still experimental on Node 18). */
function copyDir(src, dst) {
    fs.mkdirSync(dst, { recursive: true });
    for (const e of fs.readdirSync(src, { withFileTypes: true })) {
        const s = path.join(src, e.name);
        const d = path.join(dst, e.name);
        if (e.isDirectory()) copyDir(s, d);
        else if (e.isFile()) fs.copyFileSync(s, d);
    }
}

function allowFor(channel) {
    return Object.assign({}, ALLOWLIST.common, ALLOWLIST[channel]);
}
function allowed(file, allow) {
    return Object.keys(allow).some((k) => (k.endsWith('/**') ? file.startsWith(k.slice(0, -2)) : file === k));
}

/** Bundle .js files neither loaded at end of boot nor allowlisted. */
function moduleGraphProblems(results, bundle, channel) {
    const loaded = new Set(results.cacheAtBoot || []);
    return listJs(bundle).filter((f) => !loaded.has(f) && !allowed(f, allowFor(channel)));
}
/** Bundle-path reads between end of boot and the end of the first dispatch. */
function lateReads(results) {
    return results.reads.filter((r) => r.phase === 'post-boot');
}
/** initDatabase must resolve before the first dispatch starts. */
function orderingProblems(results) {
    const start = results.events.find((e) => e.name === 'dispatch-start');
    const init = results.events.find((e) => e.name === 'initDatabase-resolved');
    if (!start) return ['no dispatch happened'];
    if (!init || init.seq > start.seq) return ['initDatabase had not resolved when the first dispatch started'];
    return [];
}

function json(res, status, obj) {
    const s = JSON.stringify(obj);
    res.writeHead(status, { 'content-type': 'application/json', 'content-length': Buffer.byteLength(s) });
    res.end(s);
}

function startStub(rec) {
    let polls = 0;
    const server = http.createServer((req, res) => {
        let body = '';
        req.setEncoding('utf8');
        req.on('data', (c) => { body += c; });
        req.on('end', () => {
            let parsed = null;
            try { parsed = body ? JSON.parse(body) : null; } catch (_) { /* not JSON */ }
            const host = req.headers['x-sc-host'];
            const now = Math.floor(Date.now() / 1000);
            if (host === 'api.telegram.org') {
                const method = req.url.split('/').pop();
                rec.tg.push(method);
                if (method === 'getMe') return json(res, 200, { ok: true, result: { id: 999000, is_bot: true, first_name: 'Harness', username: 'p1b_harness_bot' } });
                if (method === 'getUpdates') {
                    if (parsed && parsed.offset === -1) return json(res, 200, { ok: true, result: [] });
                    polls++;
                    if (polls === 1) {
                        const owner = Number(TG_OWNER);
                        return json(res, 200, { ok: true, result: [{ update_id: 5001, message: {
                            message_id: 77, date: now, text: USER_TEXT,
                            from: { id: owner, is_bot: false, first_name: 'Owner' },
                            chat: { id: owner, type: 'private', first_name: 'Owner' },
                        } }] });
                    }
                    const t = setTimeout(() => json(res, 200, { ok: true, result: [] }), 1000);
                    res.on('close', () => clearTimeout(t));
                    return undefined;
                }
                if (method === 'sendMessage' || method === 'sendRichMessage') {
                    // Classic text, or a Rich Message's markdown (the default send path for replies).
                    const text = method === 'sendMessage' ? parsed && parsed.text : parsed && parsed.rich_message && parsed.rich_message.markdown;
                    rec.sends.push(String(text));
                    return json(res, 200, { ok: true, result: { message_id: 1000 + rec.sends.length, date: now, chat: { id: parsed && parsed.chat_id } } });
                }
                return json(res, 200, { ok: true, result: true });
            }
            if (host === 'api.anthropic.com') {
                const msgs = (parsed && parsed.messages) || [];
                const toolResults = [];
                for (const m of msgs) {
                    if (Array.isArray(m.content)) for (const b of m.content) if (b && b.type === 'tool_result') toolResults.push(b);
                }
                rec.ai.push({ toolResults: toolResults.map((b) => JSON.stringify(b.content)) });
                const offersJsEval = Array.isArray(parsed && parsed.tools) && parsed.tools.some((t) => t && t.name === 'js_eval');
                const base = { id: 'msg_p1b_' + rec.ai.length, type: 'message', role: 'assistant', model: CLAUDE_MODEL, stop_sequence: null, usage: { input_tokens: 10, output_tokens: 5 } };
                if (offersJsEval && toolResults.length === 0) {
                    return json(res, 200, Object.assign(base, { stop_reason: 'tool_use', content: [{ type: 'tool_use', id: 'toolu_p1b_1', name: 'js_eval', input: { code: 'return 6 * 7;' } }] }));
                }
                return json(res, 200, Object.assign(base, { stop_reason: 'end_turn', content: [{ type: 'text', text: REPLY_TEXT }] }));
            }
            if (host === 'discord.com') {
                rec.discord.push(req.method + ' ' + req.url);
                if (/\/users\/@me\/channels$/.test(req.url)) return json(res, 200, { id: DC_DM, type: 1 });
                const m = req.url.match(/\/channels\/([^/]+)\/messages$/);
                if (m && req.method === 'POST') {
                    rec.sends.push(String(parsed && parsed.content));
                    return json(res, 200, { id: 'r' + rec.sends.length, channel_id: m[1], content: parsed && parsed.content });
                }
                res.writeHead(204);
                return res.end();
            }
            if (host === 'public.jupiterapi.com') return json(res, 200, {}); // main.js's boot-time label refresh
            rec.other.push(String(host) + ' ' + req.method + ' ' + req.url);
            return json(res, 404, { error: 'not stubbed by the P1-B harness' });
        });
    });
    return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve(server)));
}

function startGateway(rec) {
    // The parent may load the bundle's ws for the server side: only the child is under test.
    const WebSocket = require(path.join(BUNDLE, 'node_modules', 'ws'));
    const wss = new WebSocket.Server({ host: '127.0.0.1', port: 0 });
    wss.on('connection', (sock) => {
        rec.gateway.push('connect');
        sock.send(JSON.stringify({ op: 10, d: { heartbeat_interval: 45000 } }));
        sock.on('message', (data) => {
            let p;
            try { p = JSON.parse(String(data)); } catch (_) { return; }
            rec.gateway.push('op' + p.op);
            if (p.op === 1) sock.send(JSON.stringify({ op: 11 }));
            if (p.op === 2) {
                sock.send(JSON.stringify({ op: 0, t: 'READY', s: 1, d: { session_id: 'p1b-session', resume_gateway_url: 'wss://gateway.discord.gg', user: { id: '999000', username: 'p1b_harness_bot' } } }));
                sock.send(JSON.stringify({ op: 0, t: 'MESSAGE_CREATE', s: 2, d: {
                    id: 'm1', channel_id: DC_DM, content: USER_TEXT, attachments: [],
                    author: { id: DC_OWNER, username: 'owner' },
                } }));
            }
        });
    });
    return new Promise((resolve) => wss.on('listening', () => resolve(wss)));
}

function startBridge(rec) {
    const server = http.createServer((req, res) => {
        req.resume();
        req.on('end', () => {
            rec.bridge.push(req.url);
            json(res, 200, {});
        });
    });
    return new Promise((resolve) => {
        server.once('error', (e) => resolve({ server: null, error: e.code || e.message }));
        server.listen(8765, '127.0.0.1', () => resolve({ server, error: null }));
    });
}

function closeServer(s) {
    if (!s) return Promise.resolve();
    if (typeof s.closeAllConnections === 'function') s.closeAllConnections();
    return new Promise((resolve) => s.close(() => resolve()));
}

/** Boots [bundle]/main.js for [channel] under the preload; returns what the child recorded. */
async function runBoot(label, bundle, channel) {
    const tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'p1b-boot-')));
    const files = path.join(tmp, 'files');
    const ws = path.join(files, 'workspace');
    const home = path.join(tmp, 'home');
    fs.mkdirSync(ws, { recursive: true });
    fs.mkdirSync(home);
    seedFixture(ws, {
        provider: 'claude',
        authConfig: { authType: 'api_key', anthropicApiKey: 'sk-ant-api03-P1B-HARNESS-PLACEHOLDER-NOT-A-KEY' },
        model: CLAUDE_MODEL,
        ownerId: TG_OWNER,
    });
    if (channel === 'discord') {
        const cfgPath = path.join(ws, 'config.json');
        const cfg = JSON.parse(fs.readFileSync(cfgPath, 'utf8'));
        Object.assign(cfg, { channel: 'discord', discordBotToken: 'P1B.HARNESS.PLACEHOLDER-NOT-A-TOKEN', discordOwnerId: DC_OWNER });
        fs.writeFileSync(cfgPath, JSON.stringify(cfg, null, 2) + '\n');
    }
    fs.writeFileSync(path.join(files, 'bridge_token'), CANON_BRIDGE_TOKEN);
    // .cjs: a package.json with "type": "module" above the temp dir must not turn it into ESM.
    const preload = path.join(tmp, 'p1b-preload.cjs');
    fs.writeFileSync(preload, `(${harnessPreload.toString()})();\n`);
    const resultFile = path.join(tmp, 'result.json');

    const rec = { tg: [], sends: [], ai: [], discord: [], gateway: [], bridge: [], other: [] };
    let stub = null;
    let gateway = null;
    let bridge = { server: null, error: null };
    let child = null;
    let exitCode = null;
    let stderr = '';
    let results = null;
    let logTail = '';
    const started = Date.now();
    try {
        stub = await startStub(rec);
        gateway = channel === 'discord' ? await startGateway(rec) : null;
        bridge = await startBridge(rec);

        const env = Object.assign({}, process.env, {
            HOME: home,
            USERPROFILE: home,
            SC_P1B_HARNESS: JSON.stringify({
                bundle, resultFile, deadlineMs: BOOT_DEADLINE_MS - 5000,
                stubPort: stub.address().port, gatewayPort: gateway ? gateway.address().port : 0,
            }),
        });
        for (const k of ['NODE_OPTIONS', 'NODE_PATH', 'NODE_ENV', 'WS_NO_BUFFER_UTIL', 'WS_NO_UTF_8_VALIDATE']) delete env[k];

        child = spawn(process.execPath, ['-r', preload, path.join(bundle, 'main.js'), ws], { cwd: tmp, env, stdio: ['ignore', 'pipe', 'pipe'] });
        child.stderr.on('data', (c) => { stderr += c; });
        child.stdout.resume();
        exitCode = await new Promise((resolve) => {
            const killer = setTimeout(() => { child.kill('SIGKILL'); resolve('killed after ' + BOOT_DEADLINE_MS + 'ms'); }, BOOT_DEADLINE_MS);
            child.on('exit', (code) => { clearTimeout(killer); resolve(code); });
        });
        try { results = JSON.parse(fs.readFileSync(resultFile, 'utf8')); } catch (_) { /* reported by assertHarnessSane */ }
        try { logTail = fs.readFileSync(path.join(ws, 'node_debug.log'), 'utf8'); } catch (_) { /* none */ }
    } finally {
        if (child && child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
        await closeServer(stub);
        if (gateway) {
            for (const c of gateway.clients) c.terminate();
            await new Promise((resolve) => gateway.close(() => resolve()));
        }
        await closeServer(bridge.server);
        if (KEEP_TMP) console.log(`  (${label}: scratch kept at ${tmp})`);
        else fs.rmSync(tmp, { recursive: true, force: true });
    }
    const ms = Date.now() - started;

    const boot = { label, channel, bundle, results, rec, exitCode, stderr, log: logTail, ms, bridgeError: bridge.error };
    console.log(`  ${label}: ${ms} ms, exit ${exitCode}, finish=${results && results.reason}, bridge calls ${JSON.stringify(rec.bridge)}${bridge.error ? ' (stub bridge not bound: ' + bridge.error + ')' : ''}`);
    return boot;
}

/** Throws with diagnostics unless the boot produced results and a real, complete dispatch. */
function assertHarnessSane(boot) {
    const diag = () => `\n  exit=${boot.exitCode}\n  stderr=${boot.stderr.slice(-1500)}\n  log tail=${boot.log.split('\n').slice(-25).join('\n    ')}\n  rec=${JSON.stringify(boot.rec).slice(0, 1500)}`;
    assert.ok(boot.results, 'the child wrote no results' + diag());
    assert.strictEqual(boot.results.reason, 'dispatched', 'the first dispatch did not finish' + diag());
    assert.ok(boot.results.cacheAtBoot && boot.results.cacheAtBoot.includes('main.js'), 'no end-of-boot snapshot' + diag());
    // A real turn: the model asked for js_eval, the tool ran (6 * 7), and the reply reached the owner.
    assert.ok(boot.rec.ai.length >= 2, 'expected two model calls (tool round + answer)' + diag());
    assert.ok(boot.rec.ai.some((c) => c.toolResults.some((r) => r.includes('42'))), 'the js_eval tool result (42) never reached the model' + diag());
    assert.ok(boot.rec.sends.some((t) => t.includes(REPLY_TEXT)), 'the reply never reached the channel' + diag());
    assert.deepStrictEqual(boot.results.blockedHosts, [], 'something tried to resolve a real host');
    assert.deepStrictEqual(boot.rec.other, [], 'an unexpected host was called');
}

function runChild(args, opts) {
    const r = spawnSync(process.execPath, args, Object.assign({ encoding: 'utf8', timeout: 30000 }, opts));
    if (r.status !== 0) throw new Error(`child failed (${r.status}): ${r.stderr}`);
    return JSON.parse(r.stdout.trim().split('\n').pop());
}

// ============================================================================
(async () => {
    const t0 = Date.now();
    const boots = {};

    await check('allowlist: the test-only module is required by no bundle module', () => {
        const users = listJs(BUNDLE).filter((f) => !f.startsWith('node_modules/') && f !== 'custom-config-signature.js'
            && /require\(\s*['"][^'"]*custom-config-signature/.test(fs.readFileSync(path.join(BUNDLE, f), 'utf8')));
        assert.deepStrictEqual(users, []);
    });
    await check('allowlist: every entry names files that exist in the bundle', () => {
        const all = listJs(BUNDLE);
        for (const group of Object.values(ALLOWLIST)) {
            for (const [k, reason] of Object.entries(group)) {
                assert.ok(reason && reason.trim(), k + ' has no reason');
                assert.ok(all.some((f) => allowed(f, { [k]: reason })), `stale allowlist entry ${k}`);
            }
        }
    });

    for (const channel of ['telegram', 'discord']) {
        const boot = await runBoot(channel, BUNDLE, channel);
        boots[channel] = boot;
        await check(`${channel}: harness boots main.js and completes a real first dispatch (tool loop + reply)`, () => assertHarnessSane(boot));
        if (!boot.results || boot.results.reason !== 'dispatched') continue;
        await check(`${channel}: every bundle .js file is loaded at end of boot or allowlisted with a reason`, () => {
            const missing = moduleGraphProblems(boot.results, BUNDLE, channel);
            const lazy = missing.filter((f) => (boot.results.cacheAtEnd || []).includes(f));
            assert.deepStrictEqual(missing, [], `not loaded at end of boot: ${missing.join(', ')}` + (lazy.length ? ` (loaded lazily later: ${lazy.join(', ')})` : ''));
        });
        await check(`${channel}: no bundle-path read between end of boot and the end of the first dispatch`, () => {
            const late = lateReads(boot.results);
            assert.deepStrictEqual(late, [], 'late bundle reads: ' + JSON.stringify(late));
            // The spy is live: boot itself read the bundle (modules, sql-wasm.wasm, model-registry.json).
            const bootFiles = new Set(boot.results.reads.filter((r) => r.phase === 'boot').map((r) => r.file));
            for (const f of ['main.js', 'sql-wasm.wasm', 'model-registry.json']) assert.ok(bootFiles.has(f), 'the spy did not see the boot read of ' + f);
        });
        await check(`${channel}: initDatabase resolves (DB created) before the first dispatch`, () => {
            assert.deepStrictEqual(orderingProblems(boot.results), []);
            assert.ok(/\[DB\] (Created new|Loaded existing) database/.test(boot.log), 'the database was not initialized');
        });
    }

    await check('allowlist: each channel-specific entry is loaded on the other channel (so its reason holds)', () => {
        const tg = boots.telegram && boots.telegram.results && boots.telegram.results.cacheAtBoot;
        const dc = boots.discord && boots.discord.results && boots.discord.results.cacheAtBoot;
        assert.ok(tg && dc, 'both boots must have produced a snapshot');
        for (const k of Object.keys(ALLOWLIST.telegram)) {
            assert.ok(dc.some((f) => allowed(f, { [k]: 'x' })), `${k} (allowlisted on Telegram) is not loaded on Discord`);
        }
        for (const k of Object.keys(ALLOWLIST.discord)) {
            assert.ok(tg.some((f) => allowed(f, { [k]: 'x' })), `${k} (allowlisted on Discord) is not loaded on Telegram`);
        }
    });

    // ---- negative control: a mutated copy of the bundle makes all three assertions fail
    await check('negative control: a lazily required file, a deferred read and an un-awaited initDatabase are all caught', async () => {
        const tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'p1b-mutant-')));
        try {
            const mutant = path.join(tmp, 'nodejs-project');
            copyDir(BUNDLE, mutant);
            const edit = (file, from, to) => {
                const p = path.join(mutant, file);
                const src = fs.readFileSync(p, 'utf8');
                assert.strictEqual(src.split(from).length - 1, 1, `fixture drift: expected one "${from}" in ${file}`);
                fs.writeFileSync(p, src.replace(from, to));
            };
            fs.writeFileSync(path.join(mutant, 'lazy-fixture.js'), "'use strict';\nmodule.exports = { lazy: true };\n");
            edit('message-handler.js', 'async function handleMessage(normalized) {', "async function handleMessage(normalized) {\n    require('./lazy-fixture');");
            // The delay sits after sql-wasm.js is loaded, so only the ordering assertion sees it. It
            // costs nothing (the child exits when the dispatch ends) and leaves slow CI a wide margin.
            const dbAnchor = '        // Load existing DB or create new (with corrupted DB recovery)';
            edit('database.js', dbAnchor, '        await new Promise((r) => setTimeout(r, 15000));\n' + dbAnchor);
            edit('main.js', 'await initDatabase();', 'initDatabase();');

            const boot = await runBoot('telegram (mutant bundle)', fs.realpathSync(mutant), 'telegram');
            assertHarnessSane(boot);
            const missing = moduleGraphProblems(boot.results, boot.bundle, 'telegram');
            assert.deepStrictEqual(missing, ['lazy-fixture.js'], 'module-graph assertion must name exactly the lazily required file');
            const late = lateReads(boot.results).map((r) => r.file);
            assert.ok(late.includes('lazy-fixture.js'), 'the read spy must see the deferred read: ' + JSON.stringify(late));
            assert.deepStrictEqual(orderingProblems(boot.results), ['initDatabase had not resolved when the first dispatch started']);
        } finally {
            if (!KEEP_TMP) fs.rmSync(tmp, { recursive: true, force: true });
        }
    });

    // ---- bufferutil: planted next to a scratch copy of ws
    await check('bufferutil: a planted module is loaded without WS_NO_BUFFER_UTIL, and not with it or after the P1-B preamble', () => {
        const mainSrc = fs.readFileSync(path.join(BUNDLE, 'main.js'), 'utf8');
        const START = '// --- BAT-1409 P1-B preamble';
        const END = '// --- end BAT-1409 P1-B preamble ---';
        const a = mainSrc.indexOf(START);
        const b = mainSrc.indexOf(END);
        assert.ok(a >= 0 && b > a, 'main.js must carry the P1-B preamble markers');
        const preamble = mainSrc.slice(a, b + END.length);
        // The names main.js sets are the names ws reads.
        const wsLib = path.join(BUNDLE, 'node_modules', 'ws', 'lib');
        assert.ok(fs.readFileSync(path.join(wsLib, 'buffer-util.js'), 'utf8').includes('process.env.WS_NO_BUFFER_UTIL'));
        assert.ok(fs.readFileSync(path.join(wsLib, 'validation.js'), 'utf8').includes('process.env.WS_NO_UTF_8_VALIDATE'));
        assert.ok(/process\.env\.WS_NO_BUFFER_UTIL = '1'/.test(preamble) && /process\.env\.WS_NO_UTF_8_VALIDATE = '1'/.test(preamble), 'the preamble sets both names');

        const tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'p1b-bufferutil-')));
        try {
            const nm = path.join(tmp, 'node_modules');
            copyDir(path.join(BUNDLE, 'node_modules', 'ws'), path.join(nm, 'ws'));
            fs.mkdirSync(path.join(nm, 'bufferutil'));
            // Correct mask/unmask (so the frame still round-trips), plus a marker.
            fs.writeFileSync(path.join(nm, 'bufferutil', 'index.js'), [
                "'use strict';",
                'globalThis.__plantedBufferutil = { loaded: true, calls: 0 };',
                'exports.mask = (src, mask, out, offset, length) => { globalThis.__plantedBufferutil.calls++; for (let i = 0; i < length; i++) out[offset + i] = src[i] ^ mask[i & 3]; };',
                'exports.unmask = (buf, mask) => { globalThis.__plantedBufferutil.calls++; for (let i = 0; i < buf.length; i++) buf[i] ^= mask[i & 3]; };',
                '',
            ].join('\n'));
            const probe = `
                const WebSocket = require(${JSON.stringify(path.join(nm, 'ws'))});
                const payload = 'p1b-frame-'.padEnd(96, 'x'); // > 48 bytes: ws uses the native helper
                const wss = new WebSocket.Server({ host: '127.0.0.1', port: 0 }, () => {
                    const c = new WebSocket('ws://127.0.0.1:' + wss.address().port);
                    c.on('open', () => c.send(payload));
                });
                wss.on('connection', (s) => s.on('message', (d) => {
                    const marker = globalThis.__plantedBufferutil || { loaded: false, calls: 0 };
                    process.stdout.write(JSON.stringify({ received: String(d) === payload, loaded: marker.loaded, calls: marker.calls }) + '\\n');
                    process.exit(0);
                }));
                setTimeout(() => { process.stdout.write('{"timeout":true}\\n'); process.exit(0); }, 10000);
            `;
            const env = Object.assign({}, process.env);
            delete env.WS_NO_BUFFER_UTIL;
            delete env.WS_NO_UTF_8_VALIDATE;
            delete env.NODE_OPTIONS;
            const control = runChild(['-e', probe], { cwd: tmp, env });
            assert.deepStrictEqual(control, { received: true, loaded: true, calls: control.calls }, 'control run');
            assert.ok(control.calls > 0, 'control: the planted mask/unmask ran for the frame');
            const withEnv = runChild(['-e', probe], { cwd: tmp, env: Object.assign({}, env, { WS_NO_BUFFER_UTIL: '1' }) });
            assert.deepStrictEqual(withEnv, { received: true, loaded: false, calls: 0 }, 'WS_NO_BUFFER_UTIL=1 run');
            const withPreamble = runChild(['-e', preamble + '\n' + probe], { cwd: tmp, env });
            assert.deepStrictEqual(withPreamble, { received: true, loaded: false, calls: 0 }, "main.js's preamble run");
        } finally {
            fs.rmSync(tmp, { recursive: true, force: true });
        }
    });

    console.log(`\n(${Date.now() - t0} ms total)`);
    if (failures > 0) {
        console.log(`\n${failures} failure(s)`);
        process.exit(1);
    }
    console.log('\nAll P1-B boot module-graph checks passed.');
    process.exit(0);
})();
