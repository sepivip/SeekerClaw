// net-guard.js — BAT-1409: process-wide socket guards, installed once at boot (main.js).
//
// P1-F (amendment v3.3 M3): no code in this process may wrap a descriptor it did not open through
// these APIs, or listen on a Unix-socket path. js_eval's own `net`/`http`/`https` views refuse
// these options (js-eval-guard.js), but servers and the default HTTP agents are reachable from
// any `http`/`https`/`net` object, so their entry points are guarded here for every caller. The
// app itself never passes a descriptor, a handle or a socket path to either.
//
// Guardrail-level: it holds for code that stays inside the js_eval vm (S6′ is the accepted residual).

'use strict';

const net = require('net');
const http = require('http');

let installed = false;
let logFn = null;

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
        if (first !== null && typeof first === 'object' && first.path !== undefined) throw refusal('Listening on a Unix socket path');
        return realListen.apply(this, args);
    };

    // http.Agent#createConnection is net.createConnection, which builds a Socket from the options
    // (an `fd` there wraps a descriptor). https.Agent's is tls.connect, which takes no descriptor.
    const realCreateConnection = http.Agent.prototype.createConnection;
    http.Agent.prototype.createConnection = function guardedCreateConnection(options, ...rest) {
        if (hasDescriptor(options)) throw refusal('Wrapping an existing descriptor or handle');
        return realCreateConnection.call(this, options, ...rest);
    };
}

module.exports = { install, _hasDescriptor: hasDescriptor };
