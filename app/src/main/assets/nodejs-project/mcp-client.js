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
            current.data += (current.data ? '\n' : '') + line.slice(5).trim();
        } else if (line.startsWith('id:')) {
            current.id = line.slice(3).trim();
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

// ── MCP Client ─────────────────────────────────────────────────────

class MCPClient {
    constructor(serverConfig, logFn) {
        this.id = serverConfig.id || serverConfig.name;
        this.name = serverConfig.name;
        this.url = serverConfig.url;
        this.authToken = serverConfig.authToken || '';
        this.rateLimit = new RateLimiter(serverConfig.rateLimit || DEFAULT_RATE_LIMIT);
        this.log = logFn || console.log;
        this.sessionId = null;
        this.tools = [];
        this.toolHashes = new Map(); // originalName → SHA-256 hash
        this.connected = false;
        this.requestId = 0;
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

        return JSON.parse(res.body);
    }

    /** Send a JSON-RPC notification (no id, no response expected). */
    async _sendNotification(method, params) {
        const body = JSON.stringify({
            jsonrpc: '2.0',
            method,
            ...(params ? { params } : {}),
        });

        await httpRequest(this.url, {
            method: 'POST',
            headers: this._headers(true),
        }, body, CONNECT_TIMEOUT_MS);
        // Expects 202 Accepted — no body to parse
    }

    /** Three-step handshake: initialize → receive result → send initialized notification. */
    async connect() {
        this.log(`[MCP] Connecting to ${this.name} at ${this.url}`);

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
        this.log(`[MCP] Connected to ${serverInfo.name || this.name} v${serverInfo.version || '?'}`);

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
        const newHashes = new Map();

        for (const tool of rawTools) {
            const sanitizedDesc = sanitizeMcpDescription(tool.description || '');

            // Build prefixed name: mcp__<server>__<tool>
            const safeName = this.id.replace(/[^a-zA-Z0-9_-]/g, '_');
            const safeToolName = tool.name.replace(/[^a-zA-Z0-9_-]/g, '_');
            const prefixedName = `mcp__${safeName}__${safeToolName}`;

            if (prefixedName.length > TOOL_NAME_MAX_LENGTH) {
                this.log(`[MCP] Tool name too long (${prefixedName.length}): ${prefixedName} — skipping`);
                continue;
            }

            // Rug-pull detection: hash comparison
            const hash = hashToolDef({ name: tool.name, description: sanitizedDesc, inputSchema: tool.inputSchema });
            const prevHash = this.toolHashes.get(tool.name);

            if (prevHash && prevHash !== hash) {
                this.log(`[MCP] WARNING: Tool definition changed for ${tool.name} on ${this.name} — blocking (rug pull protection)`);
                continue;
            }

            newHashes.set(tool.name, hash);

            this.tools.push({
                name: prefixedName,
                originalName: tool.name,
                serverId: this.id,
                description: sanitizedDesc,
                input_schema: tool.inputSchema || { type: 'object', properties: {} },
            });
        }

        this.toolHashes = newHashes;
        this.log(`[MCP] ${this.name}: ${this.tools.length} tools discovered`);
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
        this.log(`[MCP] Disconnected from ${this.name}`);
    }
}

// ── MCP Manager ────────────────────────────────────────────────────

class MCPManager {
    constructor(logFn, wrapExternalContentFn) {
        this.servers = new Map(); // id → MCPClient
        this.log = logFn || console.log;
        this.wrapExternalContent = wrapExternalContentFn;
        this.globalRateLimit = new RateLimiter(GLOBAL_RATE_LIMIT);
    }

    /** Connect to all enabled servers. Non-fatal: logs errors and continues. */
    async initializeAll(configs) {
        if (!configs || configs.length === 0) {
            this.log('[MCP] No MCP servers configured');
            return [];
        }

        const results = [];
        for (const cfg of configs) {
            if (cfg.enabled === false) {
                this.log(`[MCP] Skipping disabled server: ${cfg.name}`);
                continue;
            }

            try {
                const client = new MCPClient(cfg, this.log);
                const effectiveId = client.id;
                if (!effectiveId || (typeof effectiveId === 'string' && effectiveId.trim().length === 0)) {
                    this.log(`[MCP] Skipping server with missing id: ${cfg.name || '<unnamed>'}`);
                    results.push({ id: null, name: cfg.name, tools: 0, status: 'failed', error: 'Missing server id' });
                    continue;
                }
                const info = await client.connect();
                this.servers.set(effectiveId, client);
                results.push({ id: effectiveId, name: cfg.name, tools: info.toolCount, status: 'connected' });
            } catch (e) {
                this.log(`[MCP] Failed to connect to ${cfg.name}: ${e.message}`);
                results.push({ id: cfg.id, name: cfg.name, tools: 0, status: 'failed', error: e.message });
            }
        }

        const total = this.getAllTools().length;
        this.log(`[MCP] Initialization complete: ${this.servers.size} servers, ${total} tools`);
        return results;
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

    /** Route a prefixed tool call to the correct server. Wraps result as untrusted. */
    async executeTool(prefixedName, args) {
        const parts = prefixedName.split('__');
        if (parts.length < 3 || parts[0] !== 'mcp') {
            return { error: `Invalid MCP tool name: ${prefixedName}` };
        }

        const serverId = parts[1];
        const originalName = parts.slice(2).join('__');

        const client = this.servers.get(serverId);
        if (!client) {
            return { error: `MCP server "${serverId}" not found or not connected` };
        }

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
                this.log(`[MCP] Session expired for ${client.name}, reconnecting...`);
                try {
                    await client.connect();
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
        this.log('[MCP] All servers disconnected');
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
