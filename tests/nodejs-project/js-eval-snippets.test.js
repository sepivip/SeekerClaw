#!/usr/bin/env node
// js-eval-snippets.test.js — BAT-1409 P1-F / P1-L snippet harness (contract v3.2 §5: "A harness
// runs the netwatch SKILL.md, DIAGNOSTICS https, calclaw ... js_eval snippets with the network
// stubbed; every one passes under P1-F and P1-L").
//
// Every ```javascript / ```js block in the three shipped documents below is extracted and run
// through the REAL js_eval handler (tools/system.js) on a seeded scratch workspace, with the
// process-wide socket guard installed exactly as main.js installs it. Each must run without a
// refusal (no "outside the workspace", no "internal app port", no refused module, and no
// "[Security] js_eval refused" log line), and must produce the result its stubbed network or
// seeded files make deterministic. A network failure is reported as such, never as a refusal.
//
// WHERE THE STUBS SIT (verified, and pinned by the expectations below)
//   js_eval never hands snippets the real modules, but its views read the real ones live:
//   - http/https: its request/get wrappers call `mod.request` / `mod.get` on the real module at
//     call time, so https.request / https.get replaced on the real module here are what a snippet
//     reaches. The replacement sends the request to a local plain-HTTP stub server.
//   - dns, dns.promises: read-only proxies whose get trap returns the real module's member at
//     call time (`require('dns/promises') === require('dns').promises`), so replaced members show.
//   - net: snippets get real net.Sockets. The stub replaces net.Socket.prototype.connect FIRST and
//     net-guard is installed ON TOP of it, so P1-L checks the snippet's own target before the stub
//     sends any non-bridge-port TCP connect to a local always-open server. Bridge-port connects
//     are never rewritten, so a refusal can only come from the guard.
//
// TEMPLATES (substituted, documented here)
//   - DIAGNOSTICS paysh blocks: `<base>` → https://api.example.test, `<path>` → /v1/x.
//   - calclaw's blocks are tool-call notation (`read({ path })`, `write({ path, content })`,
//     `cron_create({...})`), not standalone JS. They run in js_eval with shims that do the same
//     file steps through js_eval's own fs (the route a model takes when it does them in js_eval),
//     and `config` (used by the write block) is the skill's own example config.
//   - netwatch: run verbatim (port 8080, the example LAN IP 192.168.31.89).
//   Partner-skill snippets live in the separate SeekerClaw_Web repo and are not covered here.
//
// NEGATIVE CONTROLS: the log-search snippet edited to read '../x' is refused (outside the
// workspace), and the local port probe edited to port 8765 is refused (internal app port).
//
// Run:  node tests/nodejs-project/js-eval-snippets.test.js

'use strict';

const assert = require('assert');
const dns = require('dns');
const fs = require('fs');
const http = require('http');
const https = require('https');
const net = require('net');
const os = require('os');
const path = require('path');

const ROOT = path.resolve(__dirname, '..', '..');
const ASSETS = path.join(ROOT, 'app', 'src', 'main', 'assets');
const BUNDLE = path.join(ASSETS, 'nodejs-project');
const NETWATCH = path.join(ASSETS, 'default-skills', 'netwatch', 'SKILL.md');
const DIAGNOSTICS = path.join(BUNDLE, 'DIAGNOSTICS.md');
const CALCLAW = path.join(ASSETS, 'default-skills', 'calclaw', 'SKILL.md');

const STUB_IPV4 = '192.0.2.10'; // TEST-NET-1: what every stubbed name resolves to
const STUB_PTR = 'router.example';
const REFUSAL_RE = /outside the workspace|internal app port|ERR_SEEKERCLAW_SOCKET_REFUSED|not available in js_eval|cannot be modified|is not allowed/i;
const NETWORK_ERROR_RE = /ECONNREFUSED|ENOTFOUND|EAI_AGAIN|ETIMEDOUT|EHOSTUNREACH|ENETUNREACH|ECONNRESET|timeout/i;

let failures = 0;
async function check(label, fn) {
    try {
        await fn();
        console.log('PASS: ' + label);
    } catch (e) {
        console.log('FAIL: ' + label + ' — ' + (e && e.message ? e.message : e));
        failures++;
    }
}

/** Every ```javascript / ```js block in [file], dedented by its fence's indentation. */
function extractBlocks(file) {
    const lines = fs.readFileSync(file, 'utf8').split(/\r?\n/);
    const blocks = [];
    for (let i = 0; i < lines.length; i++) {
        const open = lines[i].match(/^(\s*)```(javascript|js)\s*$/i);
        if (!open) continue;
        const indent = open[1].length;
        const body = [];
        let j = i + 1;
        for (; j < lines.length && !/^\s*```\s*$/.test(lines[j]); j++) body.push(lines[j].slice(Math.min(indent, lines[j].search(/\S|$/))));
        blocks.push({ line: i + 1, code: body.join('\n') });
        i = j;
    }
    return blocks;
}

// ---- scratch workspace
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'p1f-snippets-'));
const files = path.join(tmp, 'files');
const ws = path.join(files, 'workspace');
fs.mkdirSync(path.join(ws, 'nutrition'), { recursive: true });
fs.writeFileSync(path.join(ws, 'config.json'), JSON.stringify({
    botToken: 'placeholder-not-a-real-bot-token',
    anthropicApiKey: 'placeholder-not-a-real-api-key',
    ownerId: '111',
    channel: 'telegram',
}));
fs.writeFileSync(path.join(files, 'bridge_token'), '00000000-0000-0000-0000-000000000000');
fs.writeFileSync(path.join(files, 'x'), 'outside the workspace\n'); // the negative control's target
const LOG_429 = 'WARN|1760000001000|[Claude] HTTP 429 Too Many Requests — retrying in 2s';
const LOG_RATE = 'ERROR|1760000003000|[OpenAI] rate limit exceeded for this key';
fs.writeFileSync(path.join(ws, 'node_debug.log'), [
    'INFO|1760000000000|[Telegram] getUpdates ok',
    LOG_429,
    'INFO|1760000002000|Message: msgLen=5 msgFp=ab12cd34',
    LOG_RATE,
    'DEBUG|1760000004000|[Heartbeat] All clear',
    '',
].join('\n'));
// calclaw: the skill's own example config and a week of daily logs.
const CALCLAW_CONFIG = {
    stats: { height_cm: 180, weight_kg: 85, age: 30, sex: 'male', activity_level: 'moderate', goal: 'cut' },
    targets: { calories: 2000, protein: 160, carbs: 200, fat: 67 },
    preferences: { units: 'metric', auto_log_photos: true },
};
fs.writeFileSync(path.join(ws, 'nutrition', 'config.json'), JSON.stringify(CALCLAW_CONFIG, null, 2));
for (let d = 11; d <= 17; d++) {
    fs.writeFileSync(path.join(ws, 'nutrition', `2026-02-${d}.json`), JSON.stringify({ date: `2026-02-${d}`, meals: [{ id: 'm' + d, calories: 400 + d, protein: 30 }], water_ml: 1500, weight_kg: null, notes: '' }));
}
process.argv[2] = ws;
process.on('exit', () => { try { fs.rmSync(tmp, { recursive: true, force: true }); } catch (_) {} });

const logPath = path.join(ws, 'node_debug.log');
// js_eval's own refusals and net-guard's socket refusals (installed with config's log, as in main.js).
const refusalLines = () => fs.readFileSync(logPath, 'utf8').split(/\r?\n/)
    .filter((l) => l.includes('[Security] js_eval refused') || l.includes('[Security] socket refused')).length;

// ---- stub servers
const httpsCalls = [];
const tcpCalls = [];
function startHttpStub() {
    const server = http.createServer((req, res) => {
        req.resume();
        req.on('end', () => {
            const host = req.headers['x-sc-host'];
            httpsCalls.push(`${req.method} ${host}${req.url}`);
            const send = (status, body, headers) => {
                const s = typeof body === 'string' ? body : JSON.stringify(body);
                res.writeHead(status, Object.assign({ 'content-type': typeof body === 'string' ? 'text/plain' : 'application/json' }, headers || {}));
                res.end(s);
            };
            if (req.url === '/openapi.json') {
                return send(200, { openapi: '3.0.0', paths: { '/v1/x': {
                    post: { requestBody: { content: { 'application/json': { schema: { type: 'object', required: ['q'], properties: { q: { type: 'string' } } } } } } },
                    get: { parameters: [{ name: 'q', in: 'query', required: true }] },
                } } });
            }
            if (req.url === '/v1/x') {
                return send(402, { x402Version: 2, accepts: [{ scheme: 'exact', network: 'solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp', amount: '10000', asset: 'USDC' }] });
            }
            if (req.url === '/') return send(200, 'ok');
            return send(404, { error: 'not stubbed' });
        });
    });
    return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve(server)));
}
function startOpenTcp() {
    const server = net.createServer((s) => s.destroy());
    return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve(server)));
}

/** Installs the network stubs on the real modules. Must run before net-guard.install(). */
function installStubs(httpPort, openPort) {
    // https → the local stub over plain HTTP, whatever the target host.
    const realHttpRequest = http.request;
    https.request = function request(...args) {
        let url = null;
        let opts = {};
        let cb;
        for (const a of args) {
            if (typeof a === 'string') url = new URL(a);
            else if (a instanceof URL) url = a;
            else if (typeof a === 'function') cb = a;
            else if (a && typeof a === 'object') opts = a;
        }
        if (url) opts = Object.assign({ hostname: url.hostname, path: url.pathname + url.search }, opts);
        const host = String(opts.hostname || opts.host || 'localhost');
        const o = Object.assign({}, opts, {
            protocol: 'http:', host: '127.0.0.1', hostname: '127.0.0.1', port: httpPort, agent: false,
            headers: Object.assign({}, opts.headers || {}, { 'x-sc-host': host }),
        });
        return realHttpRequest(o, cb);
    };
    https.get = function get(...args) {
        const req = https.request(...args);
        req.end();
        return req;
    };

    // DNS: every name resolves to TEST-NET-1 (localhost to loopback); reverse gives a fixed PTR.
    const v4 = (h) => (h === 'localhost' ? '127.0.0.1' : STUB_IPV4);
    dns.lookup = function lookup(hostname, options, callback) {
        const cb = typeof options === 'function' ? options : callback;
        const all = options && typeof options === 'object' && options.all;
        const addr = net.isIP(String(hostname)) ? String(hostname) : v4(hostname);
        process.nextTick(() => (all ? cb(null, [{ address: addr, family: net.isIP(addr) }]) : cb(null, addr, net.isIP(addr))));
        return {};
    };
    const cbify = (fn) => function (...a) { const cb = a.pop(); Promise.resolve().then(() => fn(...a)).then((v) => cb(null, v), (e) => cb(e)); return {}; };
    const P = {
        lookup: async (h, o) => (o && o.all ? [{ address: v4(h), family: 4 }] : { address: v4(h), family: 4 }),
        resolve: async (h, rr) => (rr && rr !== 'A' ? [] : [v4(h)]),
        resolve4: async (h) => [v4(h)],
        resolve6: async () => [],
        reverse: async () => [STUB_PTR],
    };
    Object.assign(dns.promises, P);
    dns.resolve = cbify(P.resolve);
    dns.resolve4 = cbify(P.resolve4);
    dns.resolve6 = cbify(P.resolve6);
    dns.reverse = cbify(P.reverse);

    // TCP: below net-guard. Any non-bridge-port target becomes the local open server; the
    // harness's own servers and the bridge ports pass through untouched.
    const realConnect = net.Socket.prototype.connect;
    const own = new Set([httpPort, openPort]);
    net.Socket.prototype.connect = function stubConnect(...args) {
        let opts = null;
        let cb;
        if (Array.isArray(args[0])) { opts = args[0][0]; cb = args[0][1]; } else if (args[0] && typeof args[0] === 'object') { opts = args[0]; cb = args.find((a) => typeof a === 'function'); } else if (typeof args[0] === 'number') { opts = { port: args[0], host: typeof args[1] === 'string' ? args[1] : undefined }; cb = args.find((a) => typeof a === 'function'); }
        if (!opts || opts.path) return realConnect.apply(this, args);
        const port = Number(opts.port);
        const host = opts.host || 'localhost';
        if ((host === '127.0.0.1' && own.has(port)) || port === 8765 || port === 8766) return realConnect.apply(this, args);
        tcpCalls.push(`${host}:${port}`);
        const o = Object.assign({}, opts, { host: '127.0.0.1', port: openPort });
        delete o.lookup;
        return cb ? realConnect.call(this, o, cb) : realConnect.call(this, o);
    };
}

// ---- expectations: what each shipped snippet must produce under the stubs
const parse = (s) => { try { return JSON.parse(s); } catch (_) { return null; } };
const EXPECT = [
    { src: 'netwatch', has: 'https.get(url', check: (r) => { const o = parse(r.result); assert.ok(o && o.ok === true && o.status === 200, 'latency probe: ' + r.result); } },
    { src: 'netwatch', has: 'dns.resolve(host)', check: (r) => { const o = parse(r.result); assert.deepStrictEqual(o && o.addresses, [STUB_IPV4], 'DNS probe: ' + r.result); } },
    { src: 'netwatch', has: "host: '127.0.0.1', port", check: (r) => { const o = parse(r.result); assert.ok(o && o.open === true && o.port === 8080, 'local port probe: ' + r.result); } },
    { src: 'netwatch', has: "const host = '192.168.31.89'", check: (r) => { const o = parse(r.result); assert.ok(o && o.open === true && o.host === '192.168.31.89', 'deep-scan probe: ' + r.result); } },
    { src: 'netwatch', has: 'dns.reverse(', check: (r) => { const o = parse(r.result); assert.deepStrictEqual(o && o.hostnames, [STUB_PTR], 'reverse DNS: ' + r.result); } },
    { src: 'DIAGNOSTICS', has: "readFileSync('node_debug.log'", check: (r) => {
        assert.ok(String(r.result).includes(LOG_429) && String(r.result).includes(LOG_RATE), 'log search: ' + r.result);
        assert.ok(!String(r.result).includes('[Heartbeat] All clear'), 'log search filters');
    } },
    { src: 'DIAGNOSTICS', has: '/openapi.json', check: (r) => {
        const o = parse(r.output);
        assert.ok(o && o.status === 200 && o.post && o.post.required[0] === 'q' && o.get[0].name === 'q', 'openapi fetch: ' + r.output);
    } },
    { src: 'DIAGNOSTICS', has: "res.headers['payment-required']", check: (r) => {
        const o = parse(r.output);
        assert.deepStrictEqual(o, { status: 402, solanaAmount: '10000', source: 'body' }, '402 probe: ' + r.output);
    } },
    { src: 'calclaw', has: 'read({ path: "nutrition/config.json" })', check: (r) => {
        const calls = parse(r.result);
        assert.ok(calls && calls[0].read === 'nutrition/config.json' && calls[0].bytes > 0, 'config read: ' + r.result);
    } },
    { src: 'calclaw', has: 'write({ path: "nutrition/config.json"', check: (r) => {
        assert.deepStrictEqual(parse(r.result), [{ write: 'nutrition/config.json' }]);
        assert.strictEqual(fs.readFileSync(path.join(ws, 'nutrition', 'config.json'), 'utf8'), JSON.stringify(CALCLAW_CONFIG, null, 2), 'the write landed in the workspace');
    } },
    { src: 'calclaw', has: 'read({ path: "nutrition/2026-02-11.json" })', check: (r) => {
        const calls = parse(r.result);
        assert.deepStrictEqual(calls && calls.map((c) => c.read), ['nutrition/2026-02-11.json', 'nutrition/2026-02-17.json'], 'weekly reads: ' + r.result);
    } },
    { src: 'calclaw', has: 'cron_create(', check: (r) => { assert.strictEqual((parse(r.result) || []).length, 3, 'cron blocks: ' + r.result); } },
];

// calclaw blocks are tool-call notation: the same steps through js_eval's own fs.
const CALCLAW_PRELUDE = [
    "const __fs = require('fs');",
    'const __calls = [];',
    `const config = ${JSON.stringify(CALCLAW_CONFIG)};`,
    "const read = ({ path }) => { const v = __fs.readFileSync(path, 'utf8'); __calls.push({ read: path, bytes: v.length }); return v; };",
    "const write = ({ path, content }) => { __fs.mkdirSync(require('path').dirname(path), { recursive: true }); __fs.writeFileSync(path, content); __calls.push({ write: path }); return 'ok'; };",
    'const cron_create = (job) => { __calls.push({ cron_create: job.name }); return job; };',
    '',
].join('\n');

function prepare(src, code) {
    if (src === 'calclaw') return CALCLAW_PRELUDE + code + '\nreturn JSON.stringify(__calls);';
    if (src === 'DIAGNOSTICS') return code.split('<base>').join('https://api.example.test').split('<path>').join('/v1/x');
    return code;
}

/** Runs [code] through the real js_eval; returns the handler's result plus refusal bookkeeping. */
async function runSnippet(sys, code) {
    const before = refusalLines();
    const r = await sys.handlers.js_eval({ code }, 'chat');
    const text = [r.error, r.result, r.output].filter(Boolean).join('\n');
    return Object.assign({}, r, { text, refusedInLog: refusalLines() - before, refused: REFUSAL_RE.test(text) || refusalLines() > before });
}

(async () => {
    const t0 = Date.now();
    const httpStub = await startHttpStub();
    const openTcp = await startOpenTcp();
    installStubs(httpStub.address().port, openTcp.address().port);
    // As main.js does (with config's log), before any tool can run — on top of the TCP stub.
    const { log } = require(path.join(BUNDLE, 'config.js'));
    require(path.join(BUNDLE, 'net-guard.js')).install({ log });
    const sys = require(path.join(BUNDLE, 'tools', 'system.js'));

    const sources = [
        { src: 'netwatch', file: NETWATCH, count: 5 },
        { src: 'DIAGNOSTICS', file: DIAGNOSTICS, count: 3 },
        { src: 'calclaw', file: CALCLAW, count: 4 },
    ];
    const all = [];
    for (const s of sources) for (const b of extractBlocks(s.file)) all.push(Object.assign({ src: s.src }, b));

    await check('every shipped javascript/js block is found (update EXPECT when a document gains or loses one)', () => {
        for (const s of sources) {
            const n = all.filter((b) => b.src === s.src).length;
            assert.strictEqual(n, s.count, `${s.src}: ${n} blocks`);
        }
        for (const b of all) {
            const e = EXPECT.filter((x) => x.src === b.src && b.code.includes(x.has));
            assert.strictEqual(e.length, 1, `${b.src}:${b.line} matches ${e.length} expectations`);
        }
    });

    const used = new Set();
    for (const b of all) {
        await check(`${b.src}:${b.line} runs in js_eval with no refusal and the expected result`, async () => {
            const r = await runSnippet(sys, prepare(b.src, b.code));
            const shown = r.text.replace(/\s+/g, ' ').slice(0, 300);
            assert.ok(!r.refused, 'REFUSED: ' + shown);
            if (!r.success) {
                throw new Error((NETWORK_ERROR_RE.test(r.text) ? 'network failure (not a refusal): ' : 'snippet error (not a refusal): ') + shown);
            }
            const e = EXPECT.find((x) => x.src === b.src && b.code.includes(x.has));
            used.add(e);
            e.check(r);
        });
    }

    await check('the stubs were what the snippets reached (no real network)', () => {
        assert.ok(httpsCalls.some((c) => c.includes('api.telegram.org/')), 'https stub: ' + httpsCalls.join(', '));
        assert.ok(httpsCalls.some((c) => c.includes('api.example.test/openapi.json')) && httpsCalls.some((c) => c.includes('api.example.test/v1/x')), 'https stub (templates): ' + httpsCalls.join(', '));
        assert.deepStrictEqual(tcpCalls.slice().sort(), ['127.0.0.1:8080', '192.168.31.89:22'], 'TCP stub: ' + tcpCalls.join(', '));
        assert.strictEqual(used.size, EXPECT.length, 'every expectation ran');
    });

    // ---- negative controls
    await check("negative control: the log-search snippet edited to read '../x' is refused (outside the workspace)", async () => {
        const logSearch = all.find((b) => b.src === 'DIAGNOSTICS' && b.code.includes("readFileSync('node_debug.log'"));
        const edited = logSearch.code.replace("readFileSync('node_debug.log'", "readFileSync('../x'");
        assert.notStrictEqual(edited, logSearch.code);
        const r = await runSnippet(sys, edited);
        assert.strictEqual(r.success, false, JSON.stringify(r));
        assert.ok(/outside the workspace/.test(r.text), r.text);
        assert.strictEqual(r.refusedInLog, 1, 'the refusal is logged');
        assert.ok(r.refused, 'the classifier sees it');
    });
    await check('negative control: the local port probe edited to port 8765 is refused (internal app port)', async () => {
        const probe = all.find((b) => b.src === 'netwatch' && b.code.includes("host: '127.0.0.1', port"));
        const edited = probe.code.replace(/const port = \d+;/, 'const port = 8765;');
        assert.notStrictEqual(edited, probe.code);
        const before = tcpCalls.length;
        const r = await runSnippet(sys, edited);
        const o = parse(r.result);
        assert.ok(o && o.open === false && /internal app port/.test(o.error), r.text);
        assert.ok(r.refused, 'the classifier sees it');
        assert.strictEqual(r.refusedInLog, 1, 'the refusal is logged');
        assert.strictEqual(tcpCalls.length, before, 'the refused connect never reached the TCP stub');
    });

    httpStub.close();
    openTcp.close();
    console.log(`\n(${Date.now() - t0} ms)`);
    if (failures > 0) {
        console.log(`\n${failures} failure(s)`);
        process.exit(1);
    }
    console.log('\nAll shipped js_eval snippets run under P1-F and P1-L.');
    process.exit(0);
})();
