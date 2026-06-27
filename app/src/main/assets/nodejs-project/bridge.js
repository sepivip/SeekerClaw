// SeekerClaw — bridge.js
// Android Bridge HTTP client. Calls the local Android bridge on port 8765.
// Depends on: config.js

const http = require('http');

// BAT-1001 PR-B: per-call getBridgeToken (not the startup-frozen
// BRIDGE_TOKEN constant) so a Kotlin-side token rotation
// (SeekerClawService writes a fresh UUID on every service start)
// is picked up on the very next request without a Node restart.
// Pre-fix, a long-lived `:node` process that survived a service
// toggle held the stale token forever and every bridge call 403'd.
const { getBridgeToken, log } = require('./config');

// ============================================================================
// ANDROID BRIDGE HTTP CLIENT
// ============================================================================

// Helper for Android Bridge HTTP calls.
// timeoutMs: default 10s for quick calls, use longer for interactive flows
// (wallet approval).
//
// BAT-1001: implements a single-shot retry on HTTP 403. AndroidBridge.kt
// returns 403 (NOT 401 — verified at AndroidBridge.kt:163) when the
// bridge-token mismatches. On 403 we re-read the token from disk
// (covers the race where Kotlin rotated mid-request) and retry once.
// Cap at exactly one retry (per Codex BAT-1001 v1.1 sign-off #3) — a
// second 403 surfaces cleanly so persistent auth failures aren't
// masked as latency. No exponential backoff: this is auth refresh,
// not transport-failure backoff.
async function androidBridgeCall(endpoint, data = {}, timeoutMs = 10000) {
    const postData = JSON.stringify(data);
    return _sendOnce(endpoint, postData, timeoutMs, /* allowRetry */ true);
}

function _sendOnce(endpoint, postData, timeoutMs, allowRetry) {
    return new Promise((resolve) => {
        // Read the token at request-build time, not at module-load
        // time. The file read is cheap (36-byte UUID, hot OS cache)
        // and the auth-refresh semantics REQUIRE the live value.
        const token = getBridgeToken();
        const req = http.request({
            hostname: '127.0.0.1',
            port: 8765,
            path: endpoint,
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'Content-Length': Buffer.byteLength(postData),
                'X-Bridge-Token': token,
            },
            timeout: timeoutMs,
        }, (res) => {
            // BAT-1001: capture status BEFORE consuming body so the
            // 403-retry path can short-circuit without parsing.
            const status = res.statusCode;
            res.setEncoding('utf8');
            let body = '';
            res.on('data', chunk => body += chunk);
            res.on('end', () => {
                if (status === 403 && allowRetry) {
                    // Single-shot retry: the next call to
                    // getBridgeToken() re-reads the disk file, so the
                    // retry uses whatever value Kotlin currently has.
                    // Persistent 403 (e.g. AndroidBridge genuinely
                    // rejected this caller, or the bridge process is
                    // gone) falls through to the second attempt
                    // returning its body — which the caller surfaces
                    // as a hard error.
                    _sendOnce(endpoint, postData, timeoutMs, /* allowRetry */ false).then(resolve);
                    return;
                }
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
