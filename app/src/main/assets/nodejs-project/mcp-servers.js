// SeekerClaw — mcp-servers.js
// Cross-process file-IPC for MCP server config (BAT-514).
//
// Sibling of runtime-state.js — same shape, same conventions:
//
//   const { open } = require('./mcp-servers');
//   const store = open(workDir);
//   store.read();          // → array of validated server configs
//   store.write({...});    // throws on caller-bug invalid input
//   store.filePath;        // → absolute path of mcp_servers.json
//   store.validateShape(s);// per-server validity check
//
// File layout (NOT under workDir — mirrors BAT-513 runtime-state.js):
//   /data/data/com.seekerclaw.app/files/mcp_servers.json
//
// Why not under workDir? `CrossProcessStore.kt` rejects path separators
// in its `fileName` parameter (basename-only validation), so the file
// MUST sit directly under `filesDir`. SeekerClawService starts Node
// with `workDir = filesDir/workspace`, so the matching path is
// `path.dirname(workDir) + /mcp_servers.json`. Without this dirname
// climb, Node would watch `workspace/mcp_servers.json` (which never
// exists) while Kotlin writes to `filesDir/mcp_servers.json` — the
// two sides would never converge. (Caught at device test on the first
// MCP-add — the Kotlin write succeeded and persisted, but Node's
// fs.watch + read pointed at the wrong directory.)
//
// The schema:
//   { servers: [ { id, name, url, enabled, rateLimit } ] }
//
// `authToken` is intentionally NOT in the file. Tokens live in
// per-id encrypted files on the Kotlin side under
// `filesDir/mcp_tokens/<id>` and are fetched on every connect via
// the AndroidBridge `POST /config/mcp-token` endpoint through
// `McpTokenStore`.
//
// Read drops invalid entries (defensive — manual edits / future-build
// values shouldn't break the agent for valid entries). Write throws
// on invalid (caller bug — Settings UI should reject before writing).

'use strict';

const fs = require('fs');
const path = require('path');

const FILE_NAME = 'mcp_servers.json';

// Mirror of the Kotlin McpServersStore.ID_REGEX. The Kotlin write
// boundary already rejects anything outside this set, so by the time
// data lands in the file it should already match. We re-validate
// here as defense-in-depth.
const ID_REGEX = /^[A-Za-z0-9_-]+$/;

function _isObj(x) { return x != null && typeof x === 'object' && !Array.isArray(x); }

/**
 * Per-server validity. Returns null if valid, else a short reason
 * string suitable for logging. Mirrors McpServersStore.isValid /
 * reasonFor on the Kotlin side.
 */
function validateShape(s) {
    if (!_isObj(s)) return 'not an object';
    if (typeof s.id !== 'string' || !ID_REGEX.test(s.id)) return `id ${JSON.stringify(s.id)} fails ${ID_REGEX}`;
    if (typeof s.name !== 'string' || !s.name.trim()) return 'name blank or non-string';
    if (typeof s.url !== 'string' || !s.url) return 'url blank or non-string';
    let u;
    try { u = new URL(s.url); } catch (_) { return `url ${JSON.stringify(s.url)} unparseable`; }
    const scheme = (u.protocol || '').toLowerCase();
    if (scheme !== 'http:' && scheme !== 'https:') return `url scheme ${scheme} not http(s)`;
    if (!u.hostname) return 'url missing host';
    // Cross-language schema parity: Kotlin's McpServer.rateLimit is
    // Int, so a fractional value (e.g. 1.5) here would fail
    // kotlinx-serialization decode of the whole file and CrossProcessStore.read
    // would fall back to its `initial` (effectively dropping every
    // server until the next valid write). Require an integer to keep
    // both sides of the contract aligned. (Copilot R19 PR #352 finding.)
    if (typeof s.rateLimit !== 'number' || !Number.isInteger(s.rateLimit) || s.rateLimit <= 0) {
        return `rateLimit ${JSON.stringify(s.rateLimit)} not a positive integer`;
    }
    if (s.enabled !== undefined && typeof s.enabled !== 'boolean') {
        return `enabled ${JSON.stringify(s.enabled)} not boolean`;
    }
    return null;
}

function open(workDir) {
    if (typeof workDir !== 'string' || !workDir) {
        throw new TypeError('mcp-servers: workDir must be a non-empty string');
    }
    // Resolve to filesDir/mcp_servers.json — see file-layout comment
    // at the top of this module. `path.dirname(workDir)` climbs out of
    // `workspace/` so we end up with `filesDir/<FILE_NAME>` which
    // matches Kotlin's CrossProcessStore writes.
    const filePath = path.join(path.dirname(workDir), FILE_NAME);

    /**
     * Read + validate. Returns an array (possibly empty) of valid
     * server objects. Invalid entries are dropped with a warning sent
     * to stderr (Node's main log goes through `log()` from config.js,
     * but this helper deliberately doesn't require config.js — caller
     * can re-log if needed via `validateShape`). Missing file →
     * empty array. Malformed JSON → empty array (logged via
     * console.warn so a corrupt file is still diagnosable).
     */
    function read() {
        if (!fs.existsSync(filePath)) return [];
        let parsed;
        try {
            parsed = JSON.parse(fs.readFileSync(filePath, 'utf8'));
        } catch (err) {
            console.warn(`[mcp-servers] ${FILE_NAME} JSON parse failed: ${err.message}`);
            return [];
        }
        if (!_isObj(parsed) || !Array.isArray(parsed.servers)) return [];
        const seenIds = new Set();
        const cleaned = [];
        for (const s of parsed.servers) {
            const reason = validateShape(s);
            if (reason !== null) {
                console.warn(`[mcp-servers] dropping invalid entry id=${s && s.id} reason=${reason}`);
                continue;
            }
            // Drop duplicates by raw id (Kotlin's normalized-id check
            // is stricter; Node's safeId in mcp-client.js handles
            // collisions further downstream)
            if (seenIds.has(s.id)) {
                console.warn(`[mcp-servers] dropping duplicate id=${s.id}`);
                continue;
            }
            seenIds.add(s.id);
            cleaned.push({
                id: s.id,
                name: s.name.trim(),
                url: s.url.trim(),
                enabled: s.enabled !== false,
                rateLimit: s.rateLimit,
            });
        }
        return cleaned;
    }

    /**
     * Write + validate. Throws TypeError on invalid input (caller
     * bug — UI should reject before invoking this). On valid input,
     * persists the file atomically (tmp + rename) so a reader
     * never sees a half-written file.
     */
    function write(value) {
        const file = _isObj(value) ? value : null;
        if (!file || !Array.isArray(file.servers)) {
            throw new TypeError('mcp-servers.write: expected { servers: [...] }');
        }
        for (const s of file.servers) {
            const reason = validateShape(s);
            if (reason !== null) {
                throw new TypeError(`mcp-servers.write: invalid entry id=${s && s.id} reason=${reason}`);
            }
        }
        const tmp = filePath + '.tmp';
        fs.writeFileSync(tmp, JSON.stringify(file, null, 2));
        fs.renameSync(tmp, filePath);
    }

    return {
        read,
        write,
        filePath,
        validateShape,
    };
}

module.exports = { open, validateShape, ID_REGEX, FILE_NAME };
