// SeekerClaw MCP Client — Remote MCP server support via Streamable HTTP
// Protocol: MCP 2025-06-18 (JSON-RPC 2.0 over HTTP, no SDK)
// BAT-168

'use strict';

const https = require('https');
const http = require('http');
const crypto = require('crypto');

// ── Constants ──────────────────────────────────────────────────────

const MCP_PROTOCOL_VERSION = '2025-06-18';
const DEFAULT_RATE_LIMIT = 10;   // per server, per minute
const GLOBAL_RATE_LIMIT = 50;    // across all servers, per minute
const DESCRIPTION_MAX_LENGTH = 2000;
const TOOL_NAME_MAX_LENGTH = 64;
const CONNECT_TIMEOUT_MS = 15000;
const CALL_TIMEOUT_MS = 30000;
const MAX_RESPONSE_BYTES = 5 * 1024 * 1024; // 5 MB hard cap on response body

// ── Security ───────────────────────────────────────────────────────

/** Strip invisible Unicode, directional overrides, and HTML from MCP descriptions. */
function sanitizeMcpDescription(desc) {
    if (typeof desc !== 'string') return '';
    let s = desc;
    // Unicode Tag block (U+E0000–U+E007F) — invisible to humans, readable by LLMs
    s = s.replace(/[\u{E0000}-\u{E007F}]/gu, '');
    // Directional overrides (U+202A–U+202E, U+2066–U+2069)
    s = s.replace(/[\u202A-\u202E\u2066-\u2069]/g, '');
    // Zero-width characters
    s = s.replace(/[\u200B-\u200F\u2060\uFEFF]/g, '');
    // HTML tags
    s = s.replace(/<[^>]*>/g, '');
    // Truncate
    if (s.length > DESCRIPTION_MAX_LENGTH) {
        s = s.slice(0, DESCRIPTION_MAX_LENGTH) + '...';
    }
    return s.trim();
}

/** Recursively sort object keys for canonical JSON serialization. */
function canonicalize(obj) {
    if (obj === null || typeof obj !== 'object') return obj;
    if (Array.isArray(obj)) return obj.map(canonicalize);
    const sorted = {};
    for (const key of Object.keys(obj).sort()) {
        sorted[key] = canonicalize(obj[key]);
    }
    return sorted;
}

/** SHA-256 hash of tool definition for rug-pull detection (canonical key order). */
function hashToolDef(tool) {
    const data = JSON.stringify(canonicalize({
        name: tool.name,
        description: tool.description || '',
        inputSchema: tool.inputSchema || {},
    }));
    return crypto.createHash('sha256').update(data).digest('hex');
}

// ── Rate Limiter (sliding window) ──────────────────────────────────

class RateLimiter {
    constructor(maxPerMinute) {
        this.maxPerMinute = maxPerMinute;
        this.timestamps = [];
    }

    canProceed() {
        const now = Date.now();
        this.timestamps = this.timestamps.filter(t => now - t < 60000);
        return this.timestamps.length < this.maxPerMinute;
    }

    record() {
        this.timestamps.push(Date.now());
    }
}

// ── SSE Parser ─────────────────────────────────────────────────────

/** Parse SSE text into events. Returns array of { type, data, id }. */
function parseSSEEvents(text) {
    const events = [];
    const lines = text.replace(/\r\n/g, '\n').replace(/\r/g, '\n').split('\n');
    let current = { type: 'message', data: '' };

    for (const line of lines) {
        if (line === '') {
            if (current.data) events.push({ ...current });
            current = { type: 'message', data: '' };
        } else if (line.startsWith('event:')) {
            current.type = line.slice(6).trim();
        } else if (line.startsWith('data:')) {
            // SSE spec: strip only the single space after "data:", not all whitespace
            const rawData = line.slice(5);
            const fieldData = rawData.startsWith(' ') ? rawData.slice(1) : rawData;
            current.data += (current.data ? '\n' : '') + fieldData;
        } else if (line.startsWith('id:')) {
            current.id = line.slice(3).trim();
        } else if (line.startsWith(':')) {
            // SSE comment — ignore per spec
        }
    }
    // Flush last event if stream didn't end with blank line
    if (current.data) events.push({ ...current });

    return events;
}

// ── HTTP Helper ────────────────────────────────────────────────────

function httpRequest(url, options, body, timeoutMs) {
    return new Promise((resolve, reject) => {
        const urlObj = new URL(url);
        const mod = urlObj.protocol === 'https:' ? https : http;

        const reqOptions = {
            hostname: urlObj.hostname,
            port: urlObj.port || (urlObj.protocol === 'https:' ? 443 : 80),
            path: urlObj.pathname + urlObj.search,
            method: options.method || 'POST',
            headers: options.headers || {},
            timeout: timeoutMs,
        };

        // TLS enforcement for HTTPS
        if (urlObj.protocol === 'https:') {
            reqOptions.minVersion = 'TLSv1.2';
            reqOptions.rejectUnauthorized = true;
        }

        const req = mod.request(reqOptions, (res) => {
            let data = '';
            let byteLen = 0;
            res.on('data', chunk => {
                byteLen += Buffer.byteLength(chunk);
                if (byteLen > MAX_RESPONSE_BYTES) {
                    req.destroy();
                    reject(new Error(`Response exceeded ${MAX_RESPONSE_BYTES} bytes limit`));
                    return;
                }
                data += chunk;
            });
            res.on('end', () => {
                resolve({
                    status: res.statusCode,
                    headers: res.headers,
                    body: data,
                });
            });
        });

        req.on('error', reject);
        req.on('timeout', () => {
            req.destroy();
            reject(new Error(`Request timed out after ${timeoutMs}ms`));
        });

        if (body) req.write(body);
        req.end();
    });
}

// ── safeId normalization ───────────────────────────────────────────
// Single source of truth for the id->safeId fold used by both
// MCPClient (constructor: `this.safeId`) and MCPManager (reconcile +
// reconcileServer key normalization). Pinned to the same regex on the
// Kotlin side via McpServersStore.normalizeId — drift here would
// silently disconnect/reconnect-loop servers whose ids differ between
// raw and folded forms.
function _safeId(id) {
    return (id || '').replace(/[^a-zA-Z0-9_-]/g, '_');
}

// ── MCP Client ─────────────────────────────────────────────────────

class MCPClient {
    constructor(serverConfig, logFn, options = {}) {
        this.id = serverConfig.id || serverConfig.name;
        // Sanitized ID used in tool name prefixes and as map key.
        // Routes through the module-level helper so MCPManager's
        // reconcile path (which keys `desiredById` and looks up
        // `this.servers` by the same fold) cannot drift.
        this.safeId = _safeId(this.id);
        this.name = serverConfig.name;
        this.url = serverConfig.url;
        // BAT-514: tokens are no longer inline on `serverConfig` for
        // file-sourced (`mcp_servers.json`) entries — they come from
        // `tokenFetcher`, which fetches per-id encrypted token files
        // (`filesDir/mcp_tokens/<id>`) via the
        // AndroidBridge. The legacy inline `authToken` field still
        // works when `tokenFetcher` isn't provided (cold-start fallback
        // through `config.json`'s `mcpServers`).
        this._initialAuthToken = serverConfig.authToken || '';
        this.tokenFetcher = typeof options.tokenFetcher === 'function' ? options.tokenFetcher : null;
        this.registerSecret = typeof options.registerSecret === 'function' ? options.registerSecret : null;
        // Set in connect() after token resolution; bearer header lookup
        // in `_headers()` reads this.
        this.authToken = '';
        this.rateLimit = new RateLimiter(serverConfig.rateLimit || DEFAULT_RATE_LIMIT);
        this.log = logFn || console.log;
        this.sessionId = null;
        this.tools = [];
        this.toolHashes = new Map(); // originalName → SHA-256 hash
        this.connected = false;
        this.requestId = 0;
        // URL safety check (refuse bearer-token over plain non-loopback
        // HTTP) is deferred to connect() — see `_checkUrlSafety`. We
        // can't run it here because the token isn't known yet when
        // tokenFetcher is in play.
    }

    /**
     * Resolve the auth token for this server. Prefers `tokenFetcher`
     * (BAT-514 path: encrypted prefs via AndroidBridge); falls back
     * to inline `serverConfig.authToken` for cold-start config.json
     * entries OR when the bridge fetch returns empty (bridge down,
     * unknown id, decryption failed — `fetchMcpToken` collapses all
     * those to `""`). Treating `""` as authoritative would silently
     * drop the inline token during a config.json-fed cold start
     * (Copilot R3 PR #352 finding).
     */
    async _resolveAuthToken() {
        if (this.tokenFetcher) {
            try {
                const t = await this.tokenFetcher(this.id);
                if (typeof t === 'string' && t.length > 0) return t;
            } catch (err) {
                this.log(`[MCP] tokenFetcher(${this.id}) failed: ${err.message}`, 'WARN');
            }
        }
        return this._initialAuthToken;
    }

    /**
     * Refuse to send auth tokens over plain (non-loopback) HTTP. Run
     * after token resolution, before any request that would attach the
     * bearer header. Throws `Error` (caller — connect — surfaces as a
     * failed connect; rest of the agent keeps running).
     */
    _checkUrlSafety(token) {
        if (!token) return;
        const urlObj = new URL(this.url);
        if (urlObj.protocol === 'https:') return;
        const h = urlObj.hostname; // URL() strips brackets from IPv6
        const isLocalhost = h === 'localhost' || h === '127.0.0.1' || h === '::1';
        if (!isLocalhost) {
            throw new Error(`Refusing to send auth token over plain HTTP to ${this.url}. Use HTTPS or localhost.`);
        }
    }

    _nextId() {
        return ++this.requestId;
    }

    _headers(includeSession = true) {
        const h = {
            'Content-Type': 'application/json',
            'Accept': 'application/json, text/event-stream',
        };
        if (includeSession && this.sessionId) {
            h['Mcp-Session-Id'] = this.sessionId;
            h['MCP-Protocol-Version'] = MCP_PROTOCOL_VERSION;
        }
        if (this.authToken) {
            h['Authorization'] = `Bearer ${this.authToken}`;
        }
        return h;
    }

    /** Send a JSON-RPC request (has id, expects response). */
    async _sendRequest(method, params, timeoutMs = CALL_TIMEOUT_MS) {
        const id = this._nextId();
        const body = JSON.stringify({
            jsonrpc: '2.0',
            id,
            method,
            params: params || {},
        });

        const isInit = method === 'initialize';
        const res = await httpRequest(this.url, {
            method: 'POST',
            headers: this._headers(!isInit),
        }, body, timeoutMs);

        // Session expired → need re-init
        if (res.status === 404 && this.sessionId) {
            this.sessionId = null;
            this.connected = false;
            throw new Error('Session expired (404)');
        }

        if (res.status !== 200) {
            throw new Error(`HTTP ${res.status}: ${res.body.slice(0, 200)}`);
        }

        // Capture session ID from response
        const sid = res.headers['mcp-session-id'];
        if (sid) this.sessionId = sid;

        // Dual-mode response: check Content-Type
        const ct = res.headers['content-type'] || '';

        if (ct.includes('text/event-stream')) {
            const events = parseSSEEvents(res.body);
            for (const event of events) {
                if (event.type === 'message' && event.data) {
                    try {
                        const msg = JSON.parse(event.data);
                        if (msg.id === id) return msg;
                    } catch (_) { /* skip non-JSON events */ }
                }
            }
            throw new Error('No matching response in SSE stream');
        }

        try {
            return JSON.parse(res.body);
        } catch (err) {
            throw new Error(`Invalid JSON from MCP server: ${res.body.slice(0, 200)}`);
        }
    }

    /** Send a JSON-RPC notification (no id, no response expected). */
    async _sendNotification(method, params) {
        const body = JSON.stringify({
            jsonrpc: '2.0',
            method,
            ...(params ? { params } : {}),
        });

        const res = await httpRequest(this.url, {
            method: 'POST',
            headers: this._headers(true),
        }, body, CONNECT_TIMEOUT_MS);
        // Validate response — surface handshake failures early
        if (res.status >= 400) {
            throw new Error(`Notification ${method} rejected: HTTP ${res.status}`);
        }
    }

    /** Three-step handshake: initialize → receive result → send initialized notification. */
    async connect() {
        // BAT-514: resolve auth token + register redaction BEFORE any
        // logging that could include the bearer header. The
        // registerSecret callback (security.registerRedactedSecret)
        // skips values shorter than its min-len threshold so empty
        // tokens are silently a no-op.
        const token = await this._resolveAuthToken();
        if (token && this.registerSecret) {
            try { this.registerSecret(token); } catch (_) { /* best-effort */ }
        }
        this._checkUrlSafety(token);
        this.authToken = token;

        this.log(`[MCP] Connecting to ${this.name} at ${this.url}`, 'DEBUG');

        // Step 1: Initialize
        const initResult = await this._sendRequest('initialize', {
            protocolVersion: MCP_PROTOCOL_VERSION,
            capabilities: {},
            clientInfo: { name: 'SeekerClaw', version: '1.2.0' },
        }, CONNECT_TIMEOUT_MS);

        if (initResult.error) {
            throw new Error(`Initialize failed: ${initResult.error.message || JSON.stringify(initResult.error)}`);
        }

        const serverInfo = initResult.result?.serverInfo || {};
        this.log(`[MCP] Connected to ${serverInfo.name || this.name} v${serverInfo.version || '?'}`, 'INFO');

        // Step 2: Send initialized notification
        await this._sendNotification('notifications/initialized');

        this.connected = true;

        // Step 3: Discover tools
        await this.refreshTools();

        return { serverInfo, toolCount: this.tools.length };
    }

    /** Fetch tools from server, sanitize descriptions, compute hashes, detect rug pulls. */
    async refreshTools() {
        const result = await this._sendRequest('tools/list', {});

        if (result.error) {
            throw new Error(`tools/list failed: ${result.error.message || JSON.stringify(result.error)}`);
        }

        const rawTools = result.result?.tools || [];
        this.tools = [];
        // Preserve previous hashes so blocked tools stay blocked across refreshes
        const newHashes = new Map(this.toolHashes);
        const seenPrefixes = new Set(); // detect sanitized name collisions

        for (const tool of rawTools) {
            // Validate tool metadata from untrusted remote server
            if (!tool || typeof tool.name !== 'string' || !tool.name) {
                this.log(`[MCP] Skipping tool with invalid/missing name on ${this.name}`, 'WARN');
                continue;
            }

            const sanitizedDesc = sanitizeMcpDescription(tool.description || '');

            // Build prefixed name: mcp__<safeId>__<safeTool>
            const safeToolName = tool.name.replace(/[^a-zA-Z0-9_-]/g, '_');
            const prefixedName = `mcp__${this.safeId}__${safeToolName}`;

            if (prefixedName.length > TOOL_NAME_MAX_LENGTH) {
                this.log(`[MCP] Tool name too long (${prefixedName.length}): ${prefixedName} — skipping`, 'WARN');
                continue;
            }

            // Detect sanitized name collisions (e.g. "foo bar" vs "foo_bar")
            if (seenPrefixes.has(prefixedName)) {
                this.log(`[MCP] Duplicate sanitized tool name "${prefixedName}" on ${this.name} — skipping`, 'WARN');
                continue;
            }
            seenPrefixes.add(prefixedName);

            // Rug-pull detection: hash comparison
            const hash = hashToolDef({ name: tool.name, description: sanitizedDesc, inputSchema: tool.inputSchema });
            const prevHash = this.toolHashes.get(tool.name);

            if (prevHash && prevHash !== hash) {
                this.log(`[MCP] WARNING: Tool definition changed for ${tool.name} on ${this.name} — blocking (rug pull protection)`, 'ERROR');
                // Keep the old hash so the block persists across future refreshes
                continue;
            }

            newHashes.set(tool.name, hash);

            this.tools.push({
                name: prefixedName,
                originalName: tool.name,
                serverId: this.safeId,
                description: sanitizedDesc,
                input_schema: tool.inputSchema || { type: 'object', properties: {} },
            });
        }

        this.toolHashes = newHashes;
        this.log(`[MCP] ${this.name}: ${this.tools.length} tools discovered`, 'DEBUG');
    }

    /** Execute a tool on this server. Returns { content, server, tool } or { error }. */
    async callTool(originalName, args) {
        if (!this.connected) {
            return { error: `MCP server ${this.name} is not connected` };
        }

        if (!this.rateLimit.canProceed()) {
            return { error: `Rate limit exceeded for MCP server ${this.name} (${this.rateLimit.maxPerMinute}/min)` };
        }
        this.rateLimit.record();

        const result = await this._sendRequest('tools/call', {
            name: originalName,
            arguments: args || {},
        });

        if (result.error) {
            return { error: `MCP error: ${result.error.message || JSON.stringify(result.error)}` };
        }

        // Extract text from MCP content array
        const content = result.result?.content || [];
        const isError = result.result?.isError === true;

        const textParts = [];
        for (const part of content) {
            if (part.type === 'text') {
                textParts.push(part.text);
            } else if (part.type === 'image') {
                textParts.push(`[Image: ${part.mimeType}]`);
            } else {
                textParts.push(JSON.stringify(part));
            }
        }

        const output = textParts.join('\n');

        if (isError) {
            return { error: output || 'MCP tool execution failed' };
        }

        return { content: output, server: this.name, tool: originalName };
    }

    /** Send DELETE to terminate session (fire-and-forget). */
    disconnect() {
        if (this.connected && this.sessionId) {
            httpRequest(this.url, {
                method: 'DELETE',
                headers: this._headers(true),
            }, null, 5000).catch(() => {});
        }
        this.connected = false;
        this.sessionId = null;
        this.tools = [];
        this.log(`[MCP] Disconnected from ${this.name}`, 'INFO');
    }
}

// ── MCP Manager ────────────────────────────────────────────────────

class MCPManager {
    constructor(logFn, wrapExternalContentFn, options = {}) {
        this.servers = new Map(); // safeId → MCPClient
        this.toolMap = new Map(); // prefixedName → { client, originalName }
        this.log = logFn || console.log;
        this.wrapExternalContent = wrapExternalContentFn;
        this.globalRateLimit = new RateLimiter(GLOBAL_RATE_LIMIT);
        // BAT-514: per-server bearer-token resolution + log-redaction
        // registration. Both come from main.js — tokenFetcher hits
        // `POST /config/mcp-token` on the AndroidBridge; registerSecret
        // calls security.registerRedactedSecret. Either may be null
        // (cold-start fallback path), in which case MCPClient falls
        // back to its inline `serverConfig.authToken`.
        this.tokenFetcher = typeof options.tokenFetcher === 'function' ? options.tokenFetcher : null;
        this.registerSecret = typeof options.registerSecret === 'function' ? options.registerSecret : null;
        // BAT-514 reconcile path: when we get a /mcp/reconcile signal
        // from Kotlin, we re-read the latest config snapshot via this
        // provider. Without it, requestReconcile() is a no-op (the
        // pre-BAT-514 cold-start path doesn't need it).
        this.configsProvider = typeof options.configsProvider === 'function' ? options.configsProvider : null;
        // Coalesce reconcile requests so a burst (Settings save + token
        // edit + fs.watch all firing within 50ms) collapses to a
        // single drain pass. `pendingFull` always wins over individual
        // ids — full reconcile already covers everything.
        this._reconcileQueue = { pendingFull: false, pendingIds: new Set() };
        this._reconcileRunning = false;
    }

    /** Connect to all enabled servers. Non-fatal: logs errors and continues. */
    async initializeAll(configs) {
        if (!configs || configs.length === 0) {
            this.log('[MCP] No MCP servers configured', 'INFO');
            return [];
        }

        const results = [];
        for (const cfg of configs) {
            if (cfg.enabled === false) {
                this.log(`[MCP] Skipping disabled server: ${cfg.name}`, 'DEBUG');
                continue;
            }

            try {
                const client = this._buildClient(cfg);
                if (!client.safeId) {
                    this.log(`[MCP] Skipping server with missing id: ${cfg.name || '<unnamed>'}`, 'WARN');
                    results.push({ id: null, name: cfg.name, tools: 0, status: 'failed', error: 'Missing server id' });
                    continue;
                }
                // Detect duplicate safeId (e.g. "server-1" vs "server_1" both sanitize to "server_1")
                if (this.servers.has(client.safeId)) {
                    this.log(`[MCP] Duplicate server id "${client.safeId}" from ${cfg.name} — skipping`, 'WARN');
                    results.push({ id: client.safeId, name: cfg.name, tools: 0, status: 'failed', error: 'Duplicate server id' });
                    continue;
                }
                const info = await client.connect();
                this.servers.set(client.safeId, client);
                // Build tool routing map: prefixedName → { client, originalName }
                for (const tool of client.tools) {
                    this.toolMap.set(tool.name, { client, originalName: tool.originalName });
                }
                results.push({ id: client.safeId, name: cfg.name, tools: info.toolCount, status: 'connected' });
            } catch (e) {
                this.log(`[MCP] Failed to connect to ${cfg.name}: ${e.message}`, 'ERROR');
                results.push({ id: cfg.id, name: cfg.name, tools: 0, status: 'failed', error: e.message });
            }
        }

        const total = this.getAllTools().length;
        this.log(`[MCP] Initialization complete: ${this.servers.size} servers, ${total} tools`, 'INFO');
        return results;
    }

    /**
     * Construct an MCPClient with the manager's tokenFetcher /
     * registerSecret options threaded through. Centralized so
     * initializeAll, reconcile, and reconcileServer share one
     * construction path (changes to options shape stay here).
     */
    _buildClient(cfg) {
        return new MCPClient(cfg, this.log, {
            tokenFetcher: this.tokenFetcher,
            registerSecret: this.registerSecret,
        });
    }

    /**
     * Public coalesced reconcile entry point. Called from:
     *   - control-server's `POST /mcp/reconcile` handler
     *   - fs.watch on `mcp_servers.json` (full reconcile)
     *
     * `id === null` (or omitted) requests a full reconcile against
     * the configsProvider. `id` as a string requests a force-reconnect
     * of just that server (used after a token edit, when the file
     * didn't change). The drain runs serially — bursts collapse.
     */
    requestReconcile(id) {
        if (id === null || id === undefined) {
            this._reconcileQueue.pendingFull = true;
            this._reconcileQueue.pendingIds.clear();
        } else if (typeof id === 'string' && id.length > 0) {
            // If a full reconcile is already pending, the per-id
            // request is moot — it'll be covered by the full pass.
            if (!this._reconcileQueue.pendingFull) this._reconcileQueue.pendingIds.add(id);
        } else {
            return;
        }
        this._drainReconcile();
    }

    /**
     * Serial drain. Returns immediately if a drain is already running
     * — that drain's loop will pick up newly-pending work before
     * exiting. The `_reconcileRunning` flag is set/cleared inside this
     * function only, so there's no race.
     */
    async _drainReconcile() {
        if (this._reconcileRunning) return;
        this._reconcileRunning = true;
        try {
            while (this._reconcileQueue.pendingFull || this._reconcileQueue.pendingIds.size > 0) {
                if (this._reconcileQueue.pendingFull) {
                    this._reconcileQueue.pendingFull = false;
                    this._reconcileQueue.pendingIds.clear();
                    await this.reconcile();
                } else {
                    // Snapshot + clear so concurrent requestReconcile
                    // calls during this iteration land in the next loop.
                    const ids = Array.from(this._reconcileQueue.pendingIds);
                    this._reconcileQueue.pendingIds.clear();
                    for (const id of ids) {
                        await this.reconcileServer(id);
                    }
                }
            }
        } catch (err) {
            this.log(`[MCP] reconcile drain error: ${err.message}`, 'ERROR');
        } finally {
            this._reconcileRunning = false;
        }
    }

    /**
     * Diff current connected servers against the latest configs and
     * reconcile: connect new, disconnect removed/disabled, reconnect
     * URL-changed. Token-only edits aren't covered here (file didn't
     * change → URLs equal → no reconnect); reconcileServer handles
     * those.
     */
    async reconcile() {
        if (!this.configsProvider) {
            this.log('[MCP] reconcile() skipped: no configsProvider', 'DEBUG');
            return;
        }
        let configs;
        try {
            configs = await Promise.resolve(this.configsProvider());
        } catch (err) {
            this.log(`[MCP] configsProvider threw during reconcile: ${err.message}`, 'ERROR');
            return;
        }
        // `this.servers` is keyed by `safeId` (set in _connectServer
        // via `client.safeId`), but configs carry RAW user-facing
        // ids. For canonical BAT-514 ids these are identical (the
        // regex's allowed alphabet survives `safeId` unchanged), but
        // legacy config.json entries with shell-meta chars (".",
        // ";", spaces, etc.) get folded by safeId. Keying
        // `desiredById` by raw id then would mismatch the servers
        // map and produce a disconnect/reconnect churn loop. Key by
        // safeId here to align both sides. (Copilot R4 PR #352 finding.)
        const desiredById = new Map(); // safeId -> raw config object
        for (const c of (configs || [])) {
            if (c && typeof c.id === 'string' && c.enabled !== false) {
                desiredById.set(_safeId(c.id), c);
            }
        }
        // Disconnect gone-or-now-disabled OR url-changed servers.
        const currentIds = Array.from(this.servers.keys());
        for (const id of currentIds) {
            const client = this.servers.get(id);
            const desired = desiredById.get(id);
            if (!desired) {
                this._disconnectAndRemove(id);
                continue;
            }
            if (desired.url !== client.url) {
                this._disconnectAndRemove(id);
            }
        }
        // Connect everything in desired that isn't currently connected.
        for (const [safeId, cfg] of desiredById) {
            if (!this.servers.has(safeId)) {
                await this._connectServer(cfg);
            }
        }
        const total = this.getAllTools().length;
        this.log(`[MCP] reconcile complete: ${this.servers.size} servers, ${total} tools`, 'INFO');
    }

    /**
     * Force-reconnect a single server. Used after a token edit (file
     * unchanged but bearer differs). Disconnects first so the next
     * connect's `_resolveAuthToken` fetches fresh from the bridge.
     *
     * Behaviour for IDs not in current configs (e.g. a stale signal
     * arrived after the server was deleted): the disconnect runs
     * unconditionally — it's a no-op against `this.servers` if the
     * id was never connected, and a clean teardown if the server was
     * just removed by an earlier full reconcile. The reconnect step
     * is gated on `desired && desired.enabled !== false`.
     */
    async reconcileServer(id) {
        if (!this.configsProvider) return;
        let configs;
        try {
            configs = await Promise.resolve(this.configsProvider());
        } catch (err) {
            this.log(`[MCP] configsProvider threw during reconcileServer(${id}): ${err.message}`, 'ERROR');
            return;
        }
        // Caller (control-server / fs.watch) hands us a RAW id.
        // The configs list also carries raw ids — so the find-by-id
        // below is a raw match. The disconnect, on the other hand,
        // looks up `this.servers` which is keyed by safeId — so
        // normalize the input before disconnecting (Copilot R4 PR
        // #352 same-bug-class sweep).
        const desired = (configs || []).find((c) => c && c.id === id);
        this._disconnectAndRemove(_safeId(id));
        if (desired && desired.enabled !== false) {
            await this._connectServer(desired);
        }
        const total = this.getAllTools().length;
        this.log(`[MCP] reconcileServer(${id}) complete: ${this.servers.size} servers, ${total} tools`, 'INFO');
    }

    _disconnectAndRemove(id) {
        const client = this.servers.get(id);
        if (!client) return;
        try { client.disconnect(); } catch (_) { /* fire-and-forget */ }
        for (const [key, val] of this.toolMap) {
            if (val.client === client) this.toolMap.delete(key);
        }
        this.servers.delete(id);
    }

    async _connectServer(cfg) {
        try {
            const client = this._buildClient(cfg);
            if (!client.safeId) {
                this.log(`[MCP] Skipping server with missing id: ${cfg.name || '<unnamed>'}`, 'WARN');
                return;
            }
            if (this.servers.has(client.safeId)) {
                this.log(`[MCP] Duplicate server id "${client.safeId}" from ${cfg.name} — skipping`, 'WARN');
                return;
            }
            await client.connect();
            this.servers.set(client.safeId, client);
            for (const tool of client.tools) {
                this.toolMap.set(tool.name, { client, originalName: tool.originalName });
            }
        } catch (err) {
            this.log(`[MCP] Failed to (re)connect ${cfg.name}: ${err.message}`, 'ERROR');
        }
    }

    /** Get all tools from all connected servers (Claude API format). */
    getAllTools() {
        const tools = [];
        for (const client of this.servers.values()) {
            for (const tool of client.tools) {
                tools.push({
                    name: tool.name,
                    description: `[MCP: ${tool.serverId}] ${tool.description}`,
                    input_schema: tool.input_schema,
                });
            }
        }
        return tools;
    }

    /** Route a prefixed tool call to the correct server. Uses toolMap for exact routing. */
    async executeTool(prefixedName, args) {
        // Look up via toolMap for correct original name resolution
        const entry = this.toolMap.get(prefixedName);
        if (!entry) {
            return { error: `MCP tool "${prefixedName}" not found or server not connected` };
        }

        const { client, originalName } = entry;

        if (!this.globalRateLimit.canProceed()) {
            return { error: 'Global MCP rate limit exceeded (50/min)' };
        }
        this.globalRateLimit.record();

        try {
            const result = await client.callTool(originalName, args);

            // Wrap content as untrusted external data
            if (result.content && this.wrapExternalContent) {
                result.content = this.wrapExternalContent(
                    result.content,
                    `mcp: ${client.name}/${originalName}`,
                );
            }

            return result;
        } catch (e) {
            // Session expired → try reconnect once
            if (e.message.includes('Session expired') || e.message.includes('404')) {
                this.log(`[MCP] Session expired for ${client.name}, reconnecting...`, 'WARN');
                try {
                    // Clear stale toolMap entries for this client before reconnect
                    for (const [key, val] of this.toolMap) {
                        if (val.client === client) this.toolMap.delete(key);
                    }
                    await client.connect();
                    // Rebuild toolMap entries for this client after reconnect
                    for (const tool of client.tools) {
                        this.toolMap.set(tool.name, { client, originalName: tool.originalName });
                    }
                    const result = await client.callTool(originalName, args);
                    if (result.content && this.wrapExternalContent) {
                        result.content = this.wrapExternalContent(
                            result.content,
                            `mcp: ${client.name}/${originalName}`,
                        );
                    }
                    return result;
                } catch (retryErr) {
                    return { error: `MCP reconnect failed: ${retryErr.message}` };
                }
            }
            return { error: `MCP tool error: ${e.message}` };
        }
    }

    /** Disconnect all servers. */
    shutdown() {
        for (const client of this.servers.values()) {
            client.disconnect();
        }
        this.servers.clear();
        this.toolMap.clear();
        this.log('[MCP] All servers disconnected', 'INFO');
    }

    /** Get status of all servers (for system prompt / diagnostics). */
    getStatus() {
        const status = [];
        for (const [id, client] of this.servers) {
            status.push({
                id,
                name: client.name,
                connected: client.connected,
                tools: client.tools.length,
                url: client.url,
            });
        }
        return status;
    }
}

module.exports = { MCPClient, MCPManager };
