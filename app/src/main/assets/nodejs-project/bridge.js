// SeekerClaw — bridge.js
// Android Bridge HTTP client. Calls the local Android bridge on port 8765.
// Depends on: config.js

const http = require('http');

const { BRIDGE_TOKEN, log } = require('./config');

// ============================================================================
// ANDROID BRIDGE HTTP CLIENT
// ============================================================================

// Helper for Android Bridge HTTP calls.
//
// Parameters:
//   endpoint  — e.g. '/config/runtime'
//   data      — POST body (defaults to {})
//   timeoutMs — default 10s for quick calls, use longer for interactive
//               flows (wallet approval). Pass 0 to disable timeout.
//   options   — optional behavior flags:
//                 silent: true  → don't log connection errors at ERROR.
//                                 Use for hot-path callers where
//                                 transient cold-boot / restart-window
//                                 failures are EXPECTED (the caller
//                                 falls back gracefully on `{error}`).
//                                 The error string is still returned in
//                                 the resolved value so the caller can
//                                 distinguish failure from success.
//                                 (Copilot R13: /config/runtime per
//                                 chat turn would log ERROR during cold
//                                 boot when bridge isn't up yet.)
async function androidBridgeCall(endpoint, data = {}, timeoutMs = 10000, options = {}) {
    const silent = options.silent === true;
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
            if (!silent) {
                log(`Android Bridge error: ${e.message}`, 'ERROR');
            }
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

// ============================================================================
// EXPORTS
// ============================================================================

module.exports = {
    androidBridgeCall,
};
