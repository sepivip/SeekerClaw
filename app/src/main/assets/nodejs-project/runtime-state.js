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
//    THROWS `Error` synchronously when (provider, authType) violates
//    the matrix — caller bug, surface to the user. Returns `true` on
//    persisted, `false` on caught FS failure (logged at ERROR by the
//    underlying cross-process-store, never re-thrown). Callers must
//    handle BOTH the throw (matrix violation) AND the false return
//    (transient FS error) — see `message-handler.js:/provider` for
//    the canonical try/catch + Boolean-check pattern.
//  - `update(transform)` — read-modify-write, no built-in mutex on
//    the Node side because Node is single-threaded for our purposes
//    (no worker threads touch this file). Same throw/Boolean shape
//    as `write` since it ends in a `write` call.
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

// BAT-549 Commit 3b: dual-side defaults must mirror Kotlin's
// RuntimeState data class defaults. New fields default to false / null
// so updating from a pre-BAT-549 build does NOT silently flip on
// reasoning capability (cost / behavior change). The DEFAULTS-merge
// happens in this module's `read()` (see below) — `cross-process-store`
// itself returns the raw `JSON.parse(text)` when the file exists and
// only falls back to the supplied default when the file is absent or
// corrupt. So old `runtime_state.json` files that lack the new fields
// load cleanly via the merge layered in `read()` here. The Kotlin side
// gets the same coverage automatically via `@Serializable` data class
// defaults during decode.
const DEFAULTS = Object.freeze({
    provider: 'claude',
    authType: 'api_key',
    model: 'claude-opus-4-8',
    reasoningEnabled: false,
    reasoningDisplayInChat: false,
    customEchoReasoning: false,
    customConfigSignature: null,
});

// Provider / authType matrix — must mirror
// RuntimeStateStore.isValidPair (Kotlin). Tests in
// tests/nodejs-project keep the two in sync.
//
// Object.create(null) gives a null prototype so a property lookup
// like `VALID_AUTH_TYPES['constructor']` or `['__proto__']` returns
// undefined (instead of falling back to Object.prototype's actual
// `constructor` function or `Object.prototype` itself, which would
// then crash `.has(...)` with a TypeError). Plain object literals
// inherit from Object.prototype; `validateMatrix('constructor', ...)`
// would otherwise throw before the matrix gate ran, taking out the
// caller (e.g. /provider, /model write paths) instead of returning
// false and surfacing a clean "invalid combo" message.
const _VALID_AUTH_TYPES = Object.create(null);
_VALID_AUTH_TYPES.claude = new Set(['api_key', 'setup_token']);
_VALID_AUTH_TYPES.openai = new Set(['api_key', 'oauth']);
_VALID_AUTH_TYPES.openrouter = new Set(['api_key']);
_VALID_AUTH_TYPES.custom = new Set(['api_key']);
const VALID_AUTH_TYPES = Object.freeze(_VALID_AUTH_TYPES);

function validateMatrix(provider, authType) {
    const allowed = VALID_AUTH_TYPES[provider];
    // Defense-in-depth: even with the null-prototype map above, an
    // `instanceof Set` check guards future maintainers who replace
    // the structure (e.g. switching to a Map<string, string[]>) —
    // the gate stays correct without a coordinated rewrite.
    return allowed instanceof Set && allowed.has(authType);
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
        // BAT-549 Commit 3b: layer DEFAULTS-merge over the cross-process-
        // store's raw JSON.parse so old `runtime_state.json` files (pre-
        // BAT-549, with only provider/authType/model) load cleanly with
        // the new fields filled from DEFAULTS. The Kotlin side handles
        // this automatically via @Serializable data class defaults; the
        // Node side needs explicit merge because cross-process-store
        // returns the parsed object as-is when the file exists.
        const raw = store.read();
        if (!raw || typeof raw !== 'object') return { ...DEFAULTS };
        const merged = { ...DEFAULTS };
        for (const key of Object.keys(DEFAULTS)) {
            if (Object.prototype.hasOwnProperty.call(raw, key) && raw[key] !== undefined) {
                merged[key] = raw[key];
            }
        }
        return merged;
    }

    function write(value) {
        // Defense-in-depth: validate at the Node write boundary too.
        // The Kotlin collector will drop an invalid emission, but we
        // prefer to never persist one in the first place — that way
        // a Telegram /provider command surfaces a clear error to the
        // user instead of silently no-op'ing through the mirror.
        //
        // Shape check FIRST: cross-process-store.write persists any
        // JSON-serializable value, so without this check a caller bug
        // could write a non-string `model` (or missing fields). The
        // Kotlin side's @Serializable decode would then fail and fall
        // back to defaults — the user-visible symptom would be "I
        // saved a model but it didn't take" with no clear error
        // upstream. The validateMatrix call below would also crash
        // with TypeError on non-string provider/authType (e.g. on
        // `'foo'.toLowerCase` if the value were null). Refuse the
        // write loudly so the bug surfaces at the source.
        if (!value || typeof value !== 'object'
            || typeof value.provider !== 'string'
            || typeof value.authType !== 'string'
            || typeof value.model !== 'string') {
            throw new Error(
                `runtime-state: invalid shape (provider=${value && typeof value.provider}, ` +
                `authType=${value && typeof value.authType}, ` +
                `model=${value && typeof value.model}) — refusing to persist`,
            );
        }
        if (!validateMatrix(value.provider, value.authType)) {
            throw new Error(
                `runtime-state: invalid (provider=${value.provider}, ` +
                `authType=${value.authType}) — refusing to persist`,
            );
        }
        // BAT-549 Commit 3b: type-check the new optional fields IF
        // present. Absent → MERGE preserves the persisted value (see
        // below); that's fine. Wrong type → caller bug, surface loudly
        // so the symptom shows up at the source instead of "saved but
        // didn't take".
        if (value.reasoningEnabled !== undefined && typeof value.reasoningEnabled !== 'boolean') {
            throw new Error(`runtime-state: reasoningEnabled must be boolean, got ${typeof value.reasoningEnabled}`);
        }
        if (value.reasoningDisplayInChat !== undefined && typeof value.reasoningDisplayInChat !== 'boolean') {
            throw new Error(`runtime-state: reasoningDisplayInChat must be boolean, got ${typeof value.reasoningDisplayInChat}`);
        }
        if (value.customEchoReasoning !== undefined && typeof value.customEchoReasoning !== 'boolean') {
            throw new Error(`runtime-state: customEchoReasoning must be boolean, got ${typeof value.customEchoReasoning}`);
        }
        if (value.customConfigSignature !== undefined
            && value.customConfigSignature !== null
            && typeof value.customConfigSignature !== 'string') {
            throw new Error(`runtime-state: customConfigSignature must be string or null, got ${typeof value.customConfigSignature}`);
        }
        // BAT-549 Commit 3b R2 Copilot: merge incoming with persisted
        // state so legacy 3-field callers (Telegram /model, /provider —
        // see message-handler.js:573, :814) don't silently drop the
        // BAT-549 fields when they update provider/authType/model. The
        // semantic becomes: write() is a partial-update — fields not in
        // the incoming value are preserved from disk. Full-replace is
        // still possible by passing all 7 fields explicitly.
        //
        // Allowlist merge to avoid prototype-pollution / unknown-field
        // leakage: only fields named in DEFAULTS get carried forward.
        // Anything else in the incoming object is dropped (won't reach
        // disk), and anything else in the persisted object is dropped
        // too (post-rollback cleanup of stale fields from a future
        // build that downgraded to this one).
        const persisted = read();
        const merged = {};
        for (const key of Object.keys(DEFAULTS)) {
            if (Object.prototype.hasOwnProperty.call(value, key) && value[key] !== undefined) {
                merged[key] = value[key];
            } else if (Object.prototype.hasOwnProperty.call(persisted, key)) {
                merged[key] = persisted[key];
            } else {
                merged[key] = DEFAULTS[key];
            }
        }
        // 3e R5 Copilot: re-validate the BAT-549 fields after merge.
        // The type-checks above only run on `value`. If a corrupted
        // runtime_state.json (manual edit, future schema rolled back,
        // etc.) had a wrong-type value for one of the BAT-549 fields,
        // the merge above would carry it forward and we'd silently
        // re-persist the bad value. Defensive sanitize-on-merge: if
        // the persisted value has the wrong type, fall back to the
        // DEFAULT for that field instead of refusing the write
        // (refusing would break legacy 3-field callers entirely; the
        // sanitize-and-write path heals corrupt files on the next
        // user-driven write). Only the optional BAT-549 fields need
        // this — the required fields (provider/authType/model) are
        // already shape-checked above and won't reach here in a bad
        // state.
        if (typeof merged.reasoningEnabled !== 'boolean') merged.reasoningEnabled = DEFAULTS.reasoningEnabled;
        if (typeof merged.reasoningDisplayInChat !== 'boolean') merged.reasoningDisplayInChat = DEFAULTS.reasoningDisplayInChat;
        if (typeof merged.customEchoReasoning !== 'boolean') merged.customEchoReasoning = DEFAULTS.customEchoReasoning;
        if (merged.customConfigSignature !== null && typeof merged.customConfigSignature !== 'string') {
            merged.customConfigSignature = DEFAULTS.customConfigSignature;
        }
        return store.write(merged);
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
