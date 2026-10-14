// net-guard.js — BAT-1409: process-wide socket guards, installed once at boot (main.js).
//
// P1-F (amendment v3.3 M3): no code in this process may wrap a descriptor it did not open through
// these APIs, or listen on a Unix-socket path. js_eval's own `net`/`http`/`https` views refuse
// these options (js-eval-guard.js), but servers and the default HTTP agents are reachable from
// any `http`/`https`/`net` object, so their entry points are guarded here for every caller. The
// app itself never passes a descriptor, a handle or a socket path to either.
//
// P1-L: no code in this process connects to a loopback address on the app's internal ports (8765,
// the Android bridge; 8766, the control server Kotlin calls into) except bridge.js, which marks its
// request options with APP_BRIDGE_CONNECT. The check sits in net.Socket#connect, which every TCP
// client path goes through (net, http, https, tls, agents), and looks at the resolved address.
//
// Guardrail-level: it holds for code that stays inside the js_eval vm (S6′ is the accepted residual).

'use strict';

const dns = require('dns');
const net = require('net');
const http = require('http');

let installed = false;
let logFn = null;

const BRIDGE_PORTS = new Set([8765, 8766]);
// Private: only modules that import it (bridge.js) can mark a connection as the app's own.
const APP_BRIDGE_CONNECT = Symbol('seekerclaw.appBridgeConnect');

function stripAddress(a) {
    let s = String(a).trim().toLowerCase();
    if (s.startsWith('[') && s.endsWith(']')) s = s.slice(1, -1);
    const zone = s.indexOf('%');
    return zone >= 0 ? s.slice(0, zone) : s;
}

/**
 * True for an address that reaches this device's loopback listeners: 127.0.0.0/8, 0.0.0.0/8
 * (Linux connects "any" to the local host), ::1, ::, and their IPv4-mapped/compatible forms.
 */
function isLoopbackAddress(addr) {
    if (typeof addr !== 'string') return false;
    const a = stripAddress(addr);
    const v = net.isIP(a);
    if (v === 4) {
        const first = Number(a.split('.')[0]);
        return first === 127 || first === 0;
    }
    if (v === 6) {
        let canon;
        try {
            canon = new URL('http://[' + a + ']/').hostname.slice(1, -1);
        } catch (_) {
            return true; // unparsable: fail closed
        }
        if (canon === '::1' || canon === '::') return true;
        const m = canon.match(/^::(?:ffff:)?([0-9a-f]{1,4}):([0-9a-f]{1,4})$/);
        if (m) {
            const first = parseInt(m[1], 16) >> 8;
            return first === 127 || first === 0;
        }
    }
    return false;
}

/** The options a Socket#connect call carries: `{ options, positional }`, or null for a pipe path. */
function connectOptions(args) {
    const first = args[0];
    if (Array.isArray(first)) return { options: first[0], positional: false }; // net's normalized [options, cb]
    if (first !== null && typeof first === 'object') return { options: first, positional: false };
    if (typeof first === 'number' || (typeof first === 'string' && /^\d+$/.test(first))) {
        return { options: { port: first, host: typeof args[1] === 'string' ? args[1] : undefined }, positional: true };
    }
    return null;
}

function hasDescriptor(o) {
    if (o === null || typeof o !== 'object') return false;
    return (('fd' in o) && o.fd !== undefined) || (('handle' in o) && o.handle !== undefined) || ('_handle' in o);
}

function refusal(what) {
    const e = new Error(`${what} is not allowed.`);
    e.code = 'ERR_SEEKERCLAW_SOCKET_REFUSED';
    if (logFn) {
        try { logFn(`[Security] socket refused: ${what}`, 'WARN'); } catch (_) { /* never changes the outcome */ }
    }
    return e;
}

/** Installs the guards; idempotent. [log] receives (message, level) for each refusal. */
function install({ log } = {}) {
    if (log) logFn = log;
    if (installed) return;
    installed = true;

    // server.listen(handle), listen({ fd }), listen({ handle }), listen(path), listen({ path }).
    const realListen = net.Server.prototype.listen;
    net.Server.prototype.listen = function guardedListen(...args) {
        const first = args[0];
        if (hasDescriptor(first)) throw refusal('Listening on an existing descriptor or handle');
        if (typeof first === 'string' && !/^\d+$/.test(first)) throw refusal('Listening on a Unix socket path');
        if (first !== null && typeof first === 'object' && !!first.path) throw refusal('Listening on a Unix socket path');
        return realListen.apply(this, args);
    };

    // http.Agent#createConnection is net.createConnection, which builds a Socket from the options
    // (an `fd` there wraps a descriptor). https.Agent's is tls.connect, which takes no descriptor.
    const realCreateConnection = http.Agent.prototype.createConnection;
    http.Agent.prototype.createConnection = function guardedCreateConnection(options, ...rest) {
        if (hasDescriptor(options)) throw refusal('Wrapping an existing descriptor or handle');
        return realCreateConnection.call(this, options, ...rest);
    };

    // P1-L: loopback connections to the bridge ports, checked on the resolved address. A refusal
    // surfaces as the socket's 'error' event (like a refused connection), never as a throw.
    const realConnect = net.Socket.prototype.connect;
    net.Socket.prototype.connect = function guardedConnect(...args) {
        const c = connectOptions(args);
        if (!c || !c.options || typeof c.options !== 'object') return realConnect.apply(this, args);
        // One snapshot of the caller's options (getters run once, symbols kept): every check below
        // and the real connect see the same values, and the caller's object is never changed.
        const o = Object.assign(Object.create(null), c.options);
        const cb = c.positional
            ? args.find((a) => typeof a === 'function')
            : (Array.isArray(args[0]) ? args[0][1] : args.find((a) => typeof a === 'function'));
        const port = Number(o.port);
        // A Unix-socket connect is exactly what net treats as one (`pipe = !!options.path`); http
        // passes `path: null` on every TCP request.
        if (!BRIDGE_PORTS.has(port) || o[APP_BRIDGE_CONNECT] === true || !!o.path) {
            return cb ? realConnect.call(this, o, cb) : realConnect.call(this, o);
        }
        const host = o.host || 'localhost';
        if (net.isIP(stripAddress(host))) {
            if (isLoopbackAddress(host)) {
                const err = refusal(`Connecting to port ${port} on this device (an internal app port)`);
                process.nextTick(() => this.destroy(err));
                return this;
            }
            return cb ? realConnect.call(this, o, cb) : realConnect.call(this, o);
        }
        // A host name: check what it resolves to before net connects.
        const lookup = typeof o.lookup === 'function' ? o.lookup : dns.lookup;
        const guardedLookup = (hostname, opts, cb) => {
            const done = typeof opts === 'function' ? opts : cb;
            const lookupOpts = typeof opts === 'function' ? {} : opts;
            lookup(hostname, lookupOpts, (err, address, family) => {
                if (err) return done(err);
                const all = Array.isArray(address) ? address.map((a) => a.address) : [address];
                if (all.some(isLoopbackAddress)) {
                    return done(refusal(`Connecting to port ${port} on this device (an internal app port)`));
                }
                return done(null, address, family);
            });
        };
        o.host = host;
        o.lookup = guardedLookup;
        return cb ? realConnect.call(this, o, cb) : realConnect.call(this, o);
    };
}

module.exports = { install, APP_BRIDGE_CONNECT, BRIDGE_PORTS, isLoopbackAddress, _hasDescriptor: hasDescriptor };
