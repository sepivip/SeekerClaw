// SeekerClaw — agent-preferences.js (BAT-515)
//
// Node-side helper around cross-process-store.js for the BAT-515
// agent-preferences state (searchProvider / agentName). The Kotlin
// singleton `AgentPreferencesStore` (com.seekerclaw.app.state) and
// this module both read/write the SAME absolute file at
// `<filesDir>/agent_preferences.json`. Pattern mirrors
// runtime-state.js (BAT-513) almost verbatim — same flat filesDir-
// relative basename, same DEFAULTS-merge via read().
//
// ## Contract (mirrors AgentPreferencesStore.kt + BAT-515 v3 §5)
//
//  - `read()` — synchronous; returns DEFAULTS-merged value for direct
//    callers who want a usable value regardless of file state.
//    Mirrors runtime-state.read(): partial-shape file values get
//    merged over defaults, so missing-fields-from-old-build files
//    still return usable values.
//
//  - `readLiveOrNull()` — synchronous; returns the parsed object
//    when the file exists AND parses cleanly AND has valid types,
//    otherwise `null`. Used by `config.js`'s precedence-chain
//    getters (`getAgentName` / `getSearchProvider`) to fall through
//    to `config.json` cold-start fallback when the live file is
//    unavailable. NEVER returns DEFAULTS — that's read()'s job.
//
//  - `write(value)` — atomic temp+rename via cross-process-store.
//    Validates the allowlist for searchProvider and non-blank for
//    agentName at the new-edit boundary. THROWS `Error` synchronously
//    on validation failure; returns `true` on persisted, `false` on
//    caught FS failure. Partial-update merge so callers with
//    legacy 1-field shape don't drop new fields. Sanitize-on-merge
//    heals corrupt persisted values.
//
//  - `update(transform)` — read-modify-write. Same throw/Boolean
//    shape as write since it ends in a write call.
//
// ## DEFAULTS lock-step rule
//
// Defaults MUST match `AgentPreferences.kt` (data class field
// defaults + companion constants). If either side drifts, the
// dual-side fixture exchange test catches it.

'use strict';

const fs = require('fs');
const path = require('path');
const { createStore } = require('./cross-process-store');

const DEFAULTS = Object.freeze({
    searchProvider: 'brave',
    agentName: 'MyAgent',
});

// Allowlist of known search providers — must match
// AgentPreferences.KNOWN_SEARCH_PROVIDERS (Kotlin). The Kotlin Settings
// picker constrains user input to this set, but a manually-edited
// agent_preferences.json or a future-build value rolled back to the
// current build needs runtime defense too.
const KNOWN_SEARCH_PROVIDERS = Object.freeze(new Set([
    'brave', 'perplexity', 'exa', 'tavily', 'firecrawl',
]));

// agentName cap matches Kotlin's AgentPreferences.AGENT_NAME_MAX. v3 §1
// + Codex final guard: cap applies to NEW writes; existing migrated
// over-cap names are preserved verbatim by Kotlin's seedFromPrefs and
// observed-on-Node-side via the file's actual content (the wire shape
// has no cap encoded — it's a string).
const AGENT_NAME_MAX = 64;

/**
 * Resolve the absolute path of `agent_preferences.json` from `workDir`.
 * Same derivation as runtime-state.js — Kotlin sets argv[2] =
 * `filesDir/workspace`, so the file lives at `path.dirname(workDir) +
 * '/agent_preferences.json'` which is `filesDir/agent_preferences.json`.
 */
function resolveFilePath(workDir) {
    if (typeof workDir !== 'string' || !workDir) {
        throw new TypeError('agent-preferences: workDir must be a non-empty string');
    }
    return path.join(path.dirname(workDir), 'agent_preferences.json');
}

/**
 * Validate searchProvider against the allowlist. Throws on unknown.
 * Used by `write` and `update`; not used by `readLiveOrNull` (which
 * returns null for invalid shape — see §5 of v3 contract).
 */
function _validateSearchProvider(value) {
    if (typeof value !== 'string') {
        throw new Error(`agent-preferences: searchProvider must be string, got ${typeof value}`);
    }
    if (!KNOWN_SEARCH_PROVIDERS.has(value)) {
        throw new Error(
            `agent-preferences: invalid searchProvider=${JSON.stringify(value)} ` +
            `— must be one of ${JSON.stringify(Array.from(KNOWN_SEARCH_PROVIDERS))}`
        );
    }
}

/**
 * Validate agentName: non-blank string, ≤ cap. Throws on violation.
 * Skipped at write() time when the value matches current — see §1 + Codex
 * final guard re: existing migrated over-cap names. The Kotlin side
 * does the same context-sensitive skip.
 */
function _validateAgentName(value) {
    if (typeof value !== 'string') {
        throw new Error(`agent-preferences: agentName must be string, got ${typeof value}`);
    }
    if (value.trim().length === 0) {
        throw new Error('agent-preferences: agentName must not be blank');
    }
    if (value.length > AGENT_NAME_MAX) {
        throw new Error(
            `agent-preferences: agentName length ${value.length} exceeds max ${AGENT_NAME_MAX}`
        );
    }
}

/**
 * Build a Node-side handle for the file under [workDir]'s parent.
 *
 * Returns an object with `read()`, `readLiveOrNull()`, `write(value)`,
 * `update(transform)`, and `filePath`.
 */
function open(workDir) {
    const filePath = resolveFilePath(workDir);
    const store = createStore(filePath, DEFAULTS);

    /**
     * Defaults-merged read for direct callers. Behaviour:
     *  - File absent / parse fail / empty / non-object → DEFAULTS
     *  - File present with partial shape (e.g., only one of the two
     *    fields) → DEFAULTS for the missing field
     *  - File present with both fields valid → those values
     *
     * Never throws.
     */
    function read() {
        const raw = store.read();
        if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return { ...DEFAULTS };
        const merged = { ...DEFAULTS };
        for (const key of Object.keys(DEFAULTS)) {
            if (Object.prototype.hasOwnProperty.call(raw, key) && raw[key] !== undefined) {
                merged[key] = raw[key];
            }
        }
        return merged;
    }

    /**
     * Live-or-null read for precedence-chain callers (BAT-515 v3 §5).
     * Returns null when the file is genuinely unusable so the caller
     * can fall through to the next source (config.json cold-start →
     * hardcoded defaults).
     *
     * Treats the file as live-valid only if:
     *  - file exists at filePath
     *  - parses as JSON
     *  - is a plain object (not null / array / primitive)
     *  - both fields present AND of correct type
     *  - `searchProvider` is in the known-providers allowlist
     *  - `agentName` is a non-blank string
     *
     * NB: this does NOT enforce the 64-char cap on agentName because
     * migration paths legitimately carry over-cap values (see v3 §1).
     * The cap only applies at the NEW-edit boundary in `write()`.
     *
     * Goes through `fs.readFileSync` directly rather than via the
     * cross-process-store helper so we can distinguish "file genuinely
     * absent" (null fallback) from "file corrupt" (also null fallback)
     * from "file valid" (return parsed). The store helper conflates
     * absent + corrupt by returning defaults; this read MUST distinguish
     * so the caller's precedence chain works correctly.
     */
    function readLiveOrNull() {
        let text;
        try {
            text = fs.readFileSync(filePath, 'utf8');
        } catch (e) {
            // ENOENT / permission / etc. — treat as live-absent.
            return null;
        }
        if (typeof text !== 'string' || text.trim().length === 0) return null;
        let parsed;
        try {
            parsed = JSON.parse(text);
        } catch (_) {
            return null;
        }
        if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null;
        const sp = parsed.searchProvider;
        const an = parsed.agentName;
        if (typeof sp !== 'string' || !KNOWN_SEARCH_PROVIDERS.has(sp)) return null;
        if (typeof an !== 'string' || an.trim().length === 0) return null;
        return { searchProvider: sp, agentName: an };
    }

    /**
     * Persist `value` atomically. Validates ALL incoming fields that
     * ACTUALLY DIFFER from the currently-persisted value — mirrors
     * Kotlin's [AgentPreferencesStore.validateForWrite] context-
     * sensitive contract (BAT-515 v3 §1 + Codex final guard).
     *
     * Why context-sensitive: an existing migrated over-cap `agentName`
     * is preserved verbatim by Kotlin's seedFromPrefs and lands in the
     * persisted file. A future Node-side caller doing
     * `update(c => ({...c, searchProvider: 'exa'}))` would have its
     * transform return both fields (the over-cap name copied from
     * `current` AND the new searchProvider). Validating every present
     * field unconditionally would throw on the unchanged over-cap
     * name even though the cap only applies to genuinely-new edits.
     * R2 Copilot caught this as the Node ↔ Kotlin asymmetry.
     *
     * Returns true on persisted, false on FS failure (logged by
     * cross-process-store). Throws on validation failure.
     *
     * Allowlist-merge with sanitize-on-merge mirrors runtime-state.js's
     * legacy-3-field-write protection: only fields named in DEFAULTS
     * survive; corrupt persisted values heal back to defaults on
     * legacy partial writes.
     */
    function write(value) {
        if (!value || typeof value !== 'object' || Array.isArray(value)) {
            throw new Error('agent-preferences: write expects a plain object');
        }
        // R2 Copilot: read the persisted state FIRST so validation
        // can be context-sensitive. The same `persisted` value drives
        // the partial-merge below — single read, two uses.
        const persisted = read();
        if (Object.prototype.hasOwnProperty.call(value, 'searchProvider')
            && value.searchProvider !== persisted.searchProvider) {
            _validateSearchProvider(value.searchProvider);
        }
        if (Object.prototype.hasOwnProperty.call(value, 'agentName')
            && value.agentName !== persisted.agentName) {
            _validateAgentName(value.agentName);
        }
        // Partial-update merge (mirrors runtime-state.js R2 fix). Legacy
        // callers writing only one field don't drop the other.
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
        // Sanitize-on-merge (mirrors runtime-state.js R5 fix). If
        // `persisted` carried a wrong-type value forward, drop to
        // default. The merged object hits the wire in correct shape.
        if (typeof merged.searchProvider !== 'string'
            || !KNOWN_SEARCH_PROVIDERS.has(merged.searchProvider)) {
            merged.searchProvider = DEFAULTS.searchProvider;
        }
        if (typeof merged.agentName !== 'string' || merged.agentName.trim().length === 0) {
            merged.agentName = DEFAULTS.agentName;
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
        readLiveOrNull,
        write,
        update,
        filePath,
    };
}

module.exports = {
    open,
    resolveFilePath,
    DEFAULTS,
    KNOWN_SEARCH_PROVIDERS,
    AGENT_NAME_MAX,
};
