// SeekerClaw — runtime-state.js (BAT-513)
//
// Node-side helper around cross-process-store.js for the BAT-513
// runtime state (provider / authType / model). The Kotlin singleton
// `RuntimeStateStore` (com.seekerclaw.app.state) and this module both
// read/write the SAME absolute file at `<filesDir>/runtime_state.json`.
//
// File layout (NOT under workDir):
//   /data/data/com.seekerclaw.app/files/runtime_state.json
//
// Why not under workDir? `CrossProcessStore.kt` rejects path
// separators in its `fileName` parameter (basename-only validation,
// see CrossProcessStore.isValidFileName). Both sides therefore agree
// on a flat filesDir-relative basename. Node derives the absolute
// path from `workDir` — which Kotlin sets to `filesDir/workspace`
// when starting Node — by taking `path.dirname(workDir)`.
//
// ## Contract (mirrors RuntimeStateStore.kt)
//
//  - `read()` — synchronous, returns the current `RuntimeState` value
//    or the seeded defaults on missing file / decode failure.
//  - `write(value)` — atomic temp+rename via cross-process-store.
//    Returns `true` on persisted, `false` on caught FS failure
//    (logged at ERROR; never throws).
//  - `update(transform)` — read-modify-write, no built-in mutex on
//    the Node side because Node is single-threaded for our purposes
//    (no worker threads touch this file). Same shape as Kotlin's
//    suspend `update` so call sites are symmetric.
//  - `validateMatrix(provider, authType)` — same provider/authType
//    matrix the Kotlin side enforces. Calling code in
//    message-handler.js should validate BEFORE calling write so an
//    invalid combo is rejected with a user-visible error message
//    instead of being persisted and then dropped by the Kotlin
//    collector (which would silently revert prefs to last-good and
//    confuse the user).
//
// Defaults match `RuntimeStateStore.kt`'s `RuntimeState()`. Keep them
// in lock-step.

'use strict';

const path = require('path');
const { createStore } = require('./cross-process-store');

const DEFAULTS = Object.freeze({
    provider: 'claude',
    authType: 'api_key',
    model: 'claude-opus-4-7',
});

// Provider / authType matrix — must mirror
// RuntimeStateStore.isValidPair (Kotlin). Tests in
// tests/nodejs-project keep the two in sync.
const VALID_AUTH_TYPES = Object.freeze({
    claude: new Set(['api_key', 'setup_token']),
    openai: new Set(['api_key', 'oauth']),
    openrouter: new Set(['api_key']),
    custom: new Set(['api_key']),
});

function validateMatrix(provider, authType) {
    const allowed = VALID_AUTH_TYPES[provider];
    return allowed != null && allowed.has(authType);
}

/**
 * Resolve the absolute path of `runtime_state.json` from `workDir`.
 *
 * Kotlin starts Node with `argv[2] = filesDir/workspace`, so the
 * file lives at `path.dirname(workDir) + /runtime_state.json` —
 * which is `filesDir/runtime_state.json`. The basename matches the
 * Kotlin side's `CrossProcessStore.kt` fileName parameter (basename-
 * only, no path separators allowed).
 */
function resolveFilePath(workDir) {
    if (typeof workDir !== 'string' || !workDir) {
        throw new TypeError('runtime-state: workDir must be a non-empty string');
    }
    return path.join(path.dirname(workDir), 'runtime_state.json');
}

/**
 * Build a runtime-state handle for the file under [workDir]'s parent.
 * Returns an object with `read()`, `write(value)`, `update(transform)`,
 * `validateMatrix(provider, authType)`, and `filePath`.
 *
 * The returned `read` value is a freshly-cloned plain object (the
 * cross-process-store helper deep-clones defaults). Callers may safely
 * destructure / mutate without poisoning subsequent reads.
 */
function open(workDir) {
    const filePath = resolveFilePath(workDir);
    const store = createStore(filePath, DEFAULTS);

    function read() {
        return store.read();
    }

    function write(value) {
        // Defense-in-depth: validate at the Node write boundary too.
        // The Kotlin collector will drop an invalid emission, but we
        // prefer to never persist one in the first place — that way
        // a Telegram /provider command surfaces a clear error to the
        // user instead of silently no-op'ing through the mirror.
        if (!validateMatrix(value.provider, value.authType)) {
            throw new Error(
                `runtime-state: invalid (provider=${value.provider}, ` +
                `authType=${value.authType}) — refusing to persist`,
            );
        }
        return store.write(value);
    }

    function update(transform) {
        const current = read();
        const next = transform(current);
        return write(next);
    }

    return {
        read,
        write,
        update,
        validateMatrix,
        filePath,
    };
}

module.exports = {
    open,
    resolveFilePath,
    validateMatrix,
    DEFAULTS,
};
