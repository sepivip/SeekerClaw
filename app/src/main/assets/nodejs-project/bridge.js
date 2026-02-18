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
            log(`Android Bridge error: ${e.message}`);
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
