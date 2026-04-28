// SeekerClaw — cross-process-store.js (BAT-512, BAT-511 family)
//
// Node-side counterpart to CrossProcessStore.kt. Thin wrapper around
// fs read/write with the same atomicity contract: temp file +
// rename so a Kotlin-side reader can never observe a half-written
// file, and same JSON format so a single source-of-truth file works
// from both runtimes.
//
// ## What this module does NOT do
//
//  - Does not migrate any existing field. New code only — sibling
//    tickets (BAT-513 onward) do migrations one field at a time.
//  - Does not provide encryption. Sensitive fields stay in their
//    current Keystore-backed SharedPreferences storage; BAT-516 will
//    revisit.
//  - Does not emit cross-process notifications from Node. The Kotlin
//    side observes the file via FileObserver (BAT-518 pattern), so a
//    Node-side `write()` is automatically picked up by main-process
//    StateFlow consumers without any explicit signalling. If a future
//    consumer ever needs same-process Node-to-Node reactivity, layer
//    it on top — out of scope here.

'use strict';

const fs = require('fs');
const path = require('path');

let _logger = (msg, level) => { /* set via setLogger */ };

/**
 * Inject the project log function so warnings flow through the same
 * sink as the rest of the agent. Optional — defaults to a no-op so
 * unit tests don't need to wire it.
 *
 * @param {(msg: string, level: string) => void} log
 */
function setLogger(log) {
    if (typeof log === 'function') _logger = log;
}

/**
 * Create a cross-process store handle for `filePath`.
 *
 * @param {string} filePath absolute path to the JSON file (typically
 *        under workDir or filesDir so both Kotlin and Node can reach
 *        it).
 * @param {*} defaults value returned by `read()` when the file doesn't
 *        exist or fails to parse.
 * @returns {{read: () => any, write: (value: any) => boolean,
 *           filePath: string}} store handle. `write` returns true on
 *        success, false on failure (logged at ERROR; never throws so
 *        a hot path can't be killed by a transient FS error).
 */
function createStore(filePath, defaults) {
    if (typeof filePath !== 'string' || !filePath) {
        throw new TypeError('createStore: filePath must be a non-empty string');
    }
    const tmpPath = filePath + '.tmp';

    // BAT-512 (Copilot review fix round-5): snapshot defaults at
    // construction time so a caller mutating their `defaults`
    // object AFTER createStore() can't change what subsequent
    // missing/malformed reads return. Without this, the closure
    // captures `defaults` by reference and `_clone(defaults)` at
    // read-time would reflect post-construction mutations — a
    // silent contract drift.
    const defaultsSnapshot = _clone(defaults);

    function read() {
        try {
            if (!fs.existsSync(filePath)) return _clone(defaultsSnapshot);
            const text = fs.readFileSync(filePath, 'utf8');
            return JSON.parse(text);
        } catch (e) {
            _logger(`[CrossProcessStore:${path.basename(filePath)}] decode failed, returning defaults: ${e.message}`, 'WARN');
            return _clone(defaultsSnapshot);
        }
    }

    function write(value) {
        try {
            const text = JSON.stringify(value);
            // Atomic write: temp file then rename. The rename is
            // atomic on the filesystems Android uses (ext4, F2FS), so
            // a Kotlin-side reader can never observe a half-written
            // file. Same contract CrossProcessStore.kt provides.
            fs.writeFileSync(tmpPath, text);
            fs.renameSync(tmpPath, filePath);
            return true;
        } catch (e) {
            _logger(`[CrossProcessStore:${path.basename(filePath)}] write failed: ${e.message}`, 'ERROR');
            // Defensive cleanup: if the temp write succeeded but the
            // rename failed, leaving .tmp around is just clutter.
            try { if (fs.existsSync(tmpPath)) fs.unlinkSync(tmpPath); } catch (_) {}
            return false;
        }
    }

    return { read, write, filePath };
}

// Defensive clone so a caller mutating their copy of `defaults` doesn't
// silently mutate the singleton default we hand out on every read.
// JSON round-trip is the simplest correct deep clone for the JSON-
// serializable values this store deals with — same constraint
// JSON.stringify imposes on `write`.
function _clone(value) {
    if (value === null || typeof value !== 'object') return value;
    return JSON.parse(JSON.stringify(value));
}

module.exports = { createStore, setLogger };
