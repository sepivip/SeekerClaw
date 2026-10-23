// js-eval-guard.js — BAT-1409 P1-F (contract v3.2, amendment v3.3 M3): what js_eval code can
// reach through require().
//
// - Modules: an explicit allowlist of Node built-ins (MODULE_ALLOWLIST). Bare packages, paths and
//   every other built-in are refused. Allowlisted modules come back read-only (no monkeypatching
//   of shared module objects such as `https.request`), with process-wide setters refused.
// - fs / fs.promises / fs/promises: a façade object, not a proxy. Only listed members exist; every
//   path argument is resolved once against the workspace and checked with the P1-E rule
//   (workspace-path.js), and the checked absolute path is what the real method receives. Reads may
//   also name a short exact list of /proc files. Writes refuse links on the path, the protected
//   names and the workspace root itself. Descriptor APIs, open/opendir, cp and link creation are
//   refused. Option objects are copied once (Proxies refused) and the copy is what is checked and
//   passed on; `fd`/`fs` options are refused; read APIs accept only read-only flags. Streams come
//   back as façades with no descriptor, path or reopen.
// - net / http / https: sockets cannot wrap a descriptor and Unix-socket paths are refused.
//
// Guardrail-level (invariant 6): holds for code that stays inside the vm. The sandbox hands the
// vm host objects (intrinsics, and every socket or stream it creates, whose prototype chain
// reaches the real classes); code that walks those to the real constructors is the known vm
// escape, the owner-accepted residual S6′.

'use strict';

const fs = require('fs');
const path = require('path');
const stream = require('stream');
const util = require('util');
const { resolveInWorkspace, linkOnPath, isProtectedRootName } = require('./workspace-path');

const MODULE_ALLOWLIST = new Set([
    'assert', 'assert/strict', 'buffer', 'crypto', 'dns', 'dns/promises', 'events',
    'fs', 'fs/promises', 'http', 'https', 'net', 'os', 'path', 'path/posix', 'path/win32',
    'punycode', 'querystring', 'readline', 'stream', 'stream/promises', 'string_decoder',
    'timers', 'timers/promises', 'tls', 'url', 'util', 'util/types', 'zlib',
    'process', // the safe stub, never the real process
]);

// Members of allowlisted modules that change state for the whole process.
const MODULE_REFUSED_MEMBERS = {
    crypto: ['setEngine', 'setFips'],
    dns: ['setServers', 'setDefaultResultOrder'],
    'dns/promises': ['setServers', 'setDefaultResultOrder'],
    tls: ['setDefaultCACertificates'],
    events: ['setMaxListeners'],
};

// Read-only /proc files any device-info snippet may read (shared with P1-G). Exact strings only:
// never /proc/self/**, /proc/<pid>/**, environ, cmdline, fd, maps or mem.
const PROC_READ_ALLOW = new Set(['/proc/meminfo', '/proc/cpuinfo', '/proc/loadavg', '/proc/uptime', '/proc/version']);

class JsEvalRefusal extends Error {}

// Path argument kinds: 'r' read metadata, 'rc' read content, 'w' write, 'wp' a mkdtemp prefix.
const FS_SPEC = {
    existsSync: ['r'], exists: ['r'], accessSync: ['r'], access: ['r'],
    statSync: ['r'], stat: ['r'], lstatSync: ['r'], lstat: ['r'],
    statfsSync: ['r'], statfs: ['r'],
    readdirSync: ['r'], readdir: ['r'], readlinkSync: ['r'], readlink: ['r'],
    realpathSync: ['r'], realpath: ['r'],
    watch: ['r'], watchFile: ['r'], unwatchFile: ['r'],
    readFileSync: ['rc'], readFile: ['rc'],
    writeFileSync: ['w'], writeFile: ['w'], appendFileSync: ['w'], appendFile: ['w'],
    mkdirSync: ['w'], mkdir: ['w'], mkdtempSync: ['wp'], mkdtemp: ['wp'],
    rmSync: ['w'], rm: ['w'], rmdirSync: ['w'], rmdir: ['w'], unlinkSync: ['w'], unlink: ['w'],
    renameSync: ['w', 'w'], rename: ['w', 'w'], copyFileSync: ['rc', 'w'], copyFile: ['rc', 'w'],
    truncateSync: ['w'], truncate: ['w'], chmodSync: ['w'], chmod: ['w'],
    chownSync: ['w'], chown: ['w'], lchownSync: ['w'], lchown: ['w'],
    utimesSync: ['w'], utimes: ['w'], lutimesSync: ['w'], lutimes: ['w'],
};
const FSP_SPEC = {
    access: ['r'], stat: ['r'], lstat: ['r'], statfs: ['r'], readdir: ['r'], readlink: ['r'],
    realpath: ['r'], watch: ['r'], readFile: ['rc'],
    writeFile: ['w'], appendFile: ['w'], mkdir: ['w'], mkdtemp: ['wp'], rm: ['w'], rmdir: ['w'],
    unlink: ['w'], rename: ['w', 'w'], copyFile: ['rc', 'w'], truncate: ['w'], chmod: ['w'],
    chown: ['w'], lchown: ['w'], utimes: ['w'], lutimes: ['w'],
};
// mkdir on the workspace root is a harmless no-op; every other write there is refused.
const ROOT_WRITE_OK = new Set(['mkdirSync', 'mkdir']);
// Named so a snippet gets a clear refusal instead of "not a function".
const FS_REFUSED = [
    'open', 'openSync', 'opendir', 'opendirSync', 'cp', 'cpSync', 'symlink', 'symlinkSync',
    'link', 'linkSync', 'close', 'closeSync', 'read', 'readSync', 'write', 'writeSync',
    'readv', 'readvSync', 'writev', 'writevSync', 'fstat', 'fstatSync', 'fsync', 'fsyncSync',
    'fdatasync', 'fdatasyncSync', 'ftruncate', 'ftruncateSync', 'fchmod', 'fchmodSync',
    'fchown', 'fchownSync', 'futimes', 'futimesSync', 'lchmod', 'lchmodSync',
];
const FSP_REFUSED = ['open', 'opendir', 'cp', 'symlink', 'link', 'lchmod'];

// Flag strings Node accepts (lib/internal/fs/utils.js stringToFlags).
function flagBits(flag) {
    const C = fs.constants;
    const SYNC = C.O_SYNC || 0;
    const W = C.O_TRUNC | C.O_CREAT | C.O_WRONLY;
    const A = C.O_APPEND | C.O_CREAT | C.O_WRONLY;
    const map = {
        r: C.O_RDONLY, rs: C.O_RDONLY | SYNC, sr: C.O_RDONLY | SYNC,
        'r+': C.O_RDWR, 'rs+': C.O_RDWR | SYNC, 'sr+': C.O_RDWR | SYNC,
        w: W, wx: W | C.O_EXCL, xw: W | C.O_EXCL,
        'w+': C.O_TRUNC | C.O_CREAT | C.O_RDWR, 'wx+': C.O_TRUNC | C.O_CREAT | C.O_RDWR | C.O_EXCL,
        'xw+': C.O_TRUNC | C.O_CREAT | C.O_RDWR | C.O_EXCL,
        a: A, ax: A | C.O_EXCL, xa: A | C.O_EXCL, as: A | SYNC, sa: A | SYNC,
        'a+': C.O_APPEND | C.O_CREAT | C.O_RDWR, 'ax+': C.O_APPEND | C.O_CREAT | C.O_RDWR | C.O_EXCL,
        'xa+': C.O_APPEND | C.O_CREAT | C.O_RDWR | C.O_EXCL,
        'as+': C.O_APPEND | C.O_CREAT | C.O_RDWR | SYNC, 'sa+': C.O_APPEND | C.O_CREAT | C.O_RDWR | SYNC,
    };
    if (typeof flag === 'number') return Number.isInteger(flag) && (flag | 0) === flag ? flag : null;
    if (typeof flag === 'string' && Object.prototype.hasOwnProperty.call(map, flag)) return map[flag];
    return null;
}

/** True when [flag] (string or int32) opens read-only and creates, truncates and appends nothing. */
function isReadOnlyFlag(flag) {
    const bits = flagBits(flag);
    if (bits === null) return false;
    const C = fs.constants;
    const forbidden = (C.O_CREAT | C.O_TRUNC | C.O_APPEND | C.O_WRONLY | C.O_RDWR) >>> 0;
    return (bits & forbidden) === 0;
}

function isOptionsObject(v) {
    return v !== null && typeof v === 'object' && !Buffer.isBuffer(v) && !ArrayBuffer.isView(v);
}

function own(o, k) {
    return Object.prototype.hasOwnProperty.call(o, k);
}

/**
 * Creates the guards for one js_eval run. [names] carries the protected-name sets from config.js;
 * [onRefuse] logs a refusal (the message is model-influenced, so the caller flattens it).
 */
function createJsEvalGuards({ workDir, names, agentSettingsFile, onRefuse }) {
    const { ROOT_SECRET_NAMES, SECRETS_ANYWHERE, WRITE_PROTECTED_ROOT } = names;

    function refuse(message) {
        try { onRefuse(message); } catch (_) { /* logging never changes the outcome */ }
        return new JsEvalRefusal(message);
    }

    /**
     * Copies an options object once into a null-prototype host object: Proxies are refused, each
     * own enumerable key is read exactly once, and only the copy is checked and passed on.
     */
    function snapshot(o) {
        if (!isOptionsObject(o)) return o;
        if (util.types.isProxy(o)) throw refuse('js_eval: proxy objects are not accepted as options.');
        const copy = Object.create(null);
        for (const k of Object.keys(o)) copy[k] = o[k];
        return copy;
    }

    function asPathString(p) {
        if (typeof p === 'string') return p;
        if (Buffer.isBuffer(p) && !util.types.isProxy(p)) return Buffer.prototype.toString.call(p, 'utf8');
        throw refuse('js_eval file APIs take string or Buffer paths only (no file descriptors or URLs).');
    }

    function basenames(r) {
        return [path.basename(r.abs), path.basename(r.real)];
    }

    /** Returns the absolute path the real method receives, or throws a refusal. */
    function checkPath(p, kind, method) {
        const s = asPathString(p);
        if (s.includes('\0')) throw refuse('js_eval: paths may not contain NUL.');
        if (kind === 'wp') {
            // mkdtemp appends six characters to the prefix itself: check the directory it creates.
            const abs = path.resolve(workDir, s) + (/[\\/]$/.test(s) ? path.sep : '');
            checkPath(abs + 'XXXXXX', 'w', method);
            return abs;
        }
        if (kind !== 'w' && PROC_READ_ALLOW.has(path.resolve(workDir, s))) return path.resolve(workDir, s);
        const r = resolveInWorkspace(workDir, s);
        if (!r) throw refuse(`js_eval: ${s.slice(0, 120)} is outside the workspace.`);
        const bn = basenames(r);
        if (kind === 'rc' || kind === 'w') {
            const secret = bn.find((b) => SECRETS_ANYWHERE.has(b));
            if (secret) throw refuse(`Access to ${secret} is blocked for security.`);
            if (bn.includes(agentSettingsFile)) {
                throw refuse('Access to agent_settings.json via js_eval is blocked; use the read tool (secret values are masked).');
            }
        }
        if (kind === 'rc' && isProtectedRootName(workDir, r, ROOT_SECRET_NAMES)) {
            throw refuse(`Access to ${path.basename(r.abs)} is blocked for security.`);
        }
        if (kind === 'w') {
            if (r.rel === '' && !ROOT_WRITE_OK.has(method)) throw refuse('js_eval: the workspace folder itself cannot be removed, renamed or changed.');
            if (isProtectedRootName(workDir, r, WRITE_PROTECTED_ROOT)) {
                throw refuse(`Writing ${path.basename(r.abs)} is blocked: it is managed by the app.`);
            }
            const link = linkOnPath(workDir, r.abs);
            if (link) throw refuse(`js_eval: ${link} is a link; writes never go through links.`);
        }
        return r.abs;
    }

    /** Checks every (already copied) option object in [args] after the path arguments. */
    function checkOptions(args, from, readOnly) {
        for (let i = from; i < args.length; i++) {
            const o = args[i];
            if (!isOptionsObject(o)) continue;
            if (own(o, 'fd') || own(o, 'fs')) throw refuse('js_eval: the fd and fs options are not available.');
            for (const key of ['flag', 'flags']) {
                if (!own(o, key) || o[key] === undefined) continue;
                if (flagBits(o[key]) === null) throw refuse(`js_eval: unknown ${key} ${String(o[key]).slice(0, 20)}.`);
                if (readOnly && !isReadOnlyFlag(o[key])) throw refuse(`js_eval: a read API cannot take the write ${key} ${String(o[key]).slice(0, 20)}.`);
            }
        }
    }

    // Severs the function's constructor chain, as the sandbox does for its other host functions.
    function sever(fn) {
        const wrapped = (...args) => fn(...args);
        Object.defineProperty(wrapped, 'constructor', { value: undefined, writable: false, configurable: false });
        Object.setPrototypeOf(wrapped, null);
        return Object.freeze(wrapped);
    }

    function guardedMethod(real, kinds, name, promise) {
        const readOnly = kinds.every((k) => k === 'r' || k === 'rc');
        return sever((...args) => {
            let out;
            try {
                out = args.map((a, i) => (i >= kinds.length ? snapshot(a) : a));
                kinds.forEach((kind, i) => { out[i] = checkPath(args[i], kind, name); });
                checkOptions(out, kinds.length, readOnly);
            } catch (e) {
                if (!(e instanceof JsEvalRefusal)) throw e;
                // exists() answers "no" for a path it may not look at, like for a missing file.
                if (name === 'existsSync') return false;
                if (name === 'exists') {
                    const cb = args.find((a) => typeof a === 'function');
                    if (cb) process.nextTick(() => cb(false));
                    return undefined;
                }
                if (promise) return Promise.reject(e);
                throw e;
            }
            return real[name](...out);
        });
    }

    function refusedMethod(name, promise) {
        return sever(() => {
            const e = refuse(`js_eval: ${name} is not available (descriptor, open, copy-tree, link and process-wide settings are refused).`);
            if (promise) return Promise.reject(e);
            throw e;
        });
    }

    // ---- streams: façades with no fd, path, flags, open() or constructor
    function forwardLifecycle(real, facade) {
        real.on('open', () => facade.emit('open'));
        real.on('ready', () => facade.emit('ready'));
    }

    function readStreamFacade(real, options) {
        const out = new stream.PassThrough(options && options.highWaterMark ? { highWaterMark: options.highWaterMark } : undefined);
        if (options && typeof options.encoding === 'string') out.setEncoding(options.encoding);
        forwardLifecycle(real, out);
        real.on('error', (e) => out.destroy(e));
        out.on('close', () => { if (!real.destroyed) real.destroy(); });
        real.pipe(out);
        Object.defineProperty(out, 'constructor', { value: undefined });
        return out;
    }

    function writeStreamFacade(real) {
        const w = new stream.Writable({
            write(chunk, encoding, cb) { real.write(chunk, encoding, cb); },
            final(cb) { real.end(cb); },
            destroy(err, cb) { if (!real.destroyed) real.destroy(err || undefined); cb(err); },
        });
        forwardLifecycle(real, w);
        real.on('error', (e) => w.destroy(e));
        Object.defineProperty(w, 'constructor', { value: undefined });
        return w;
    }

    function streamOptions(options) {
        if (typeof options === 'string') return { encoding: options };
        return snapshot(options);
    }

    function createReadStream(p, options) {
        const abs = checkPath(p, 'rc', 'createReadStream');
        const o = streamOptions(options);
        checkOptions([o], 0, true);
        // The real stream reads bytes; the façade decodes (so a multi-byte character split
        // across chunks stays whole).
        const real = isOptionsObject(o) ? { ...o } : undefined;
        if (real) delete real.encoding;
        return readStreamFacade(fs.createReadStream(abs, real), o);
    }

    function createWriteStream(p, options) {
        const abs = checkPath(p, 'w', 'createWriteStream');
        const o = streamOptions(options);
        checkOptions([o], 0, false);
        return writeStreamFacade(fs.createWriteStream(abs, o));
    }

    // ---- fs façades
    function buildPromises() {
        const facade = Object.create(null);
        for (const [name, kinds] of Object.entries(FSP_SPEC)) {
            if (typeof fs.promises[name] === 'function') facade[name] = guardedMethod(fs.promises, kinds, name, true);
        }
        for (const name of FSP_REFUSED) facade[name] = refusedMethod('fs.promises.' + name, true);
        facade.constants = Object.freeze({ ...fs.constants });
        return Object.freeze(facade);
    }
    const promisesFacade = buildPromises();

    function buildFs() {
        const facade = Object.create(null);
        for (const [name, kinds] of Object.entries(FS_SPEC)) {
            if (typeof fs[name] === 'function') facade[name] = guardedMethod(fs, kinds, name, false);
        }
        for (const name of FS_REFUSED) facade[name] = refusedMethod('fs.' + name, false);
        facade.createReadStream = sever(createReadStream);
        facade.createWriteStream = sever(createWriteStream);
        facade.constants = Object.freeze({ ...fs.constants });
        facade.promises = promisesFacade;
        // Data-only flag constants some snippets use (fs.F_OK & co.).
        for (const k of ['F_OK', 'R_OK', 'W_OK', 'X_OK']) facade[k] = fs.constants[k];
        return Object.freeze(facade);
    }
    const fsFacade = buildFs();

    // ---- sockets: no descriptor wrapping, no Unix-socket paths
    // [pathKeys]: the option names that select a Unix socket (`path` for net; for http only
    // `socketPath`, since an http request's `path` is the URL path).
    function checkSocketOptions(o, what, pathKeys = ['path', 'socketPath']) {
        if (!isOptionsObject(o)) return o;
        const c = snapshot(o);
        if ((own(c, 'fd') && c.fd !== undefined) || (own(c, 'handle') && c.handle !== undefined)) {
            throw refuse(`js_eval: ${what} cannot wrap an existing descriptor or handle.`);
        }
        // Truthy, as Node decides (`pipe = !!options.path`; http checks `if (options.socketPath)`).
        if (pathKeys.some((k) => own(c, k) && !!c[k])) {
            throw refuse(`js_eval: ${what} cannot use a Unix socket path.`);
        }
        return c;
    }

    function buildNet() {
        const net = require('net');
        // A factory, not a subclass, so the module object does not lead to the real class.
        const Socket = function Socket(options) {
            return new net.Socket(checkSocketOptions(options, 'net.Socket'));
        };
        const connect = (...args) => {
            if (isOptionsObject(args[0])) {
                const o = checkSocketOptions(args[0], 'net.connect');
                // net.createConnection(options) also applies options.timeout before connecting.
                const s = new net.Socket(o);
                if (o.timeout) s.setTimeout(o.timeout);
                return s.connect(o, ...args.slice(1));
            }
            if (typeof args[0] === 'string' && !/^\d+$/.test(args[0])) throw refuse('js_eval: net.connect cannot use a Unix socket path.');
            return new net.Socket().connect(...args);
        };
        const facade = Object.create(null);
        for (const k of ['isIP', 'isIPv4', 'isIPv6', 'createServer', 'Server', 'BlockList', 'SocketAddress']) {
            if (net[k] !== undefined) facade[k] = net[k];
        }
        // Constructible (a snippet writes `new net.Socket()`), with the constructor chain severed.
        Object.defineProperty(Socket, 'constructor', { value: undefined, writable: false, configurable: false });
        Object.setPrototypeOf(Socket, null);
        facade.Socket = Object.freeze(Socket);
        facade.Stream = facade.Socket;
        facade.connect = sever(connect);
        facade.createConnection = facade.connect;
        return Object.freeze(facade);
    }

    /** http/https: request/get refuse descriptor and socket-path options; a private agent per run. */
    function buildHttp(name) {
        const mod = require(name);
        const agent = new mod.Agent();
        // Every request uses this run's own agent unless it names one, so a js_eval request can
        // never ride on a pooled socket the app opened (keep-alive agents on newer Node).
        const wrap = (fn) => sever((...args) => {
            const out = args.map((a) => (isOptionsObject(a) && !(a instanceof URL) ? checkSocketOptions(a, `${name}.${fn}`, ['socketPath']) : a));
            const optIndex = out.findIndex((a) => isOptionsObject(a) && !(a instanceof URL));
            if (optIndex >= 0) {
                if (out[optIndex].agent === undefined) out[optIndex].agent = agent;
            } else {
                const at = typeof out[0] === 'string' || out[0] instanceof URL ? 1 : 0;
                out.splice(at, 0, { agent });
            }
            return mod[fn](...out);
        });
        return readOnlyModule(name, mod, {
            request: wrap('request'),
            get: wrap('get'),
            globalAgent: agent,
        });
    }

    /** A read-only view of [mod]: members cannot be replaced; [overrides] and refusals win. */
    function readOnlyModule(name, mod, overrides = {}) {
        const refused = new Set(MODULE_REFUSED_MEMBERS[name] || []);
        const blocked = () => { throw refuse(`js_eval: the ${name} module cannot be modified.`); };
        return new Proxy(mod, {
            get(target, prop) {
                if (own(overrides, prop)) return overrides[prop];
                if (refused.has(prop)) return refusedMethod(`${name}.${String(prop)}`, false);
                if (name === 'dns' && prop === 'promises') return moduleFor('dns/promises');
                return target[prop];
            },
            set: blocked,
            defineProperty: blocked,
            deleteProperty: blocked,
            setPrototypeOf: blocked,
        });
    }

    const cache = new Map();
    function moduleFor(mod) {
        if (cache.has(mod)) return cache.get(mod);
        let m;
        if (mod === 'fs') m = fsFacade;
        else if (mod === 'fs/promises') m = promisesFacade;
        else if (mod === 'net') m = buildNet();
        else if (mod === 'http' || mod === 'https') m = buildHttp(mod);
        else m = readOnlyModule(mod, require(mod));
        cache.set(mod, m);
        return m;
    }

    /** The module for `require(name)` inside js_eval, or a refusal. [safeProcess] is the stub. */
    function requireModule(name, safeProcess) {
        if (typeof name !== 'string') throw refuse('Module identifier must be a string in js_eval.');
        const mod = name.startsWith('node:') ? name.slice(5) : name;
        if (!MODULE_ALLOWLIST.has(mod)) {
            throw refuse(`Module "${mod.slice(0, 60)}" is not available in js_eval (Node built-ins only: ${[...MODULE_ALLOWLIST].filter((m) => !m.includes('/')).join(', ')}).`);
        }
        if (mod === 'process') return safeProcess;
        return moduleFor(mod);
    }

    return { requireModule, fs: fsFacade, fsPromises: promisesFacade, checkPath };
}

module.exports = {
    createJsEvalGuards, MODULE_ALLOWLIST, MODULE_REFUSED_MEMBERS, PROC_READ_ALLOW, isReadOnlyFlag, flagBits,
    JsEvalRefusal, FS_SPEC, FSP_SPEC, FS_REFUSED, FSP_REFUSED,
};
