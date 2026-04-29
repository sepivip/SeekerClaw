// SeekerClaw — bridge.js
// Android Bridge HTTP client. Calls the local Android bridge on port 8765.
// Depends on: config.js

const http = require('http');

const { BRIDGE_TOKEN, log } = require('./config');

// ============================================================================
// ANDROID BRIDGE HTTP CLIENT
// ============================================================================

// Helper for Android Bridge HTTP calls
// timeoutMs: default 10s for quick calls, use longer for interactive flows (wallet approval)
async function androidBridgeCall(endpoint, data = {}, timeoutMs = 10000) {
    return new Promise((resolve) => {
        const postData = JSON.stringify(data);

        const req = http.request({
            hostname: '127.0.0.1',
            port: 8765,
            path: endpoint,
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'Content-Length': Buffer.byteLength(postData),
                'X-Bridge-Token': BRIDGE_TOKEN
            },
            timeout: timeoutMs
        }, (res) => {
            res.setEncoding('utf8');
            let body = '';
            res.on('data', chunk => body += chunk);
            res.on('end', () => {
                try {
                    resolve(JSON.parse(body));
                } catch (e) {
                    resolve({ error: 'Invalid response from Android Bridge' });
                }
            });
        });

        req.on('error', (e) => {
            log(`Android Bridge error: ${e.message}`, 'ERROR');
            resolve({ error: `Android Bridge unavailable: ${e.message}` });
        });

        req.on('timeout', () => {
            req.destroy();
            resolve({ error: 'Android Bridge timeout' });
        });

        req.write(postData);
        req.end();
    });
}

// BAT-514: fetch the per-server MCP auth token via the Kotlin bridge,
// which reads it from the encrypted file at `filesDir/mcp_tokens/<id>`
// through `McpTokenStore`. Mirrors the bridge's other "config
// presence" endpoints, but returns the actual decrypted value —
// necessary because Node has to attach the bearer header to MCP
// requests itself. Returns the empty string on any failure (bridge
// down, unauthorized, unknown id, decrypt failure) so callers don't
// have to distinguish — the connect attempt will fail loudly if the
// token was actually required.
async function fetchMcpToken(id) {
    if (typeof id !== 'string' || !id) return '';
    const result = await androidBridgeCall('/config/mcp-token', { id }, 5000);
    if (result && typeof result.token === 'string') return result.token;
    return '';
}

// ============================================================================
// EXPORTS
// ============================================================================

module.exports = {
    androidBridgeCall,
    fetchMcpToken,
};
