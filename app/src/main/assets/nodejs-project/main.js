// SeekerClaw Node.js entry point
// Phase 1: Telegram bot PoC using built-in https (no npm dependencies)

const fs = require('fs');
const path = require('path');
const https = require('https');

// Paths
const workDir = process.argv[2] || __dirname;
const debugLog = path.join(workDir, 'node_debug.log');

function log(msg) {
    const line = new Date().toISOString() + ' ' + msg + '\n';
    try { fs.appendFileSync(debugLog, line); } catch (_) {}
    console.log('[SeekerClaw] ' + msg);
}

// Error handlers
process.on('uncaughtException', (err) => log('UNCAUGHT: ' + err.stack));
process.on('unhandledRejection', (reason) => log('UNHANDLED REJECTION: ' + reason));

log('Node.js started! Platform: ' + process.platform + ' ' + process.arch + ' v' + process.version);

// Load config
const configPath = path.join(workDir, 'config.json');
if (!fs.existsSync(configPath)) {
    log('ERROR: config.json not found at ' + configPath);
    process.exit(1);
}

const config = JSON.parse(fs.readFileSync(configPath, 'utf8'));
const BOT_TOKEN = config.botToken;
const OWNER_ID = config.ownerId;
const AGENT_NAME = config.agentName || 'SeekerClaw';

if (!BOT_TOKEN || !OWNER_ID) {
    log('ERROR: botToken or ownerId missing in config.json');
    process.exit(1);
}

log('Bot token: ...' + BOT_TOKEN.slice(-6));
log('Owner ID: ' + OWNER_ID);
log('Agent name: ' + AGENT_NAME);

// --- Telegram Bot API helpers ---

function telegramApi(method, body) {
    return new Promise((resolve, reject) => {
        const data = body ? JSON.stringify(body) : '';
        const options = {
            hostname: 'api.telegram.org',
            path: '/bot' + BOT_TOKEN + '/' + method,
            method: body ? 'POST' : 'GET',
            headers: body ? {
                'Content-Type': 'application/json',
                'Content-Length': Buffer.byteLength(data),
            } : {},
        };

        const req = https.request(options, (res) => {
            let responseData = '';
            res.on('data', (chunk) => responseData += chunk);
            res.on('end', () => {
                try {
                    resolve(JSON.parse(responseData));
                } catch (e) {
                    reject(new Error('Failed to parse response: ' + responseData.substring(0, 200)));
                }
            });
        });

        req.on('error', reject);
        req.setTimeout(35000, () => { req.destroy(); reject(new Error('Request timeout')); });
        if (data) req.write(data);
        req.end();
    });
}

// --- Message handler ---

function handleMessage(msg) {
    const chatId = msg.chat.id;
    const senderId = String(msg.from.id);
    const text = msg.text || '';

    // Only respond to owner
    if (senderId !== String(OWNER_ID)) {
        log('Ignoring message from non-owner: ' + senderId);
        return;
    }

    log('Message from owner: ' + text);

    // Simple responses for Phase 1 PoC
    let reply;
    if (text === '/start') {
        reply = 'Hello! I am ' + AGENT_NAME + ', your SeekerClaw AI agent running on Android.\n\n'
            + 'Node.js ' + process.version + ' on ' + process.platform + ' ' + process.arch + '\n\n'
            + 'Send me any message and I will echo it back.';
    } else if (text === '/status') {
        const uptime = Math.floor(process.uptime());
        const hours = Math.floor(uptime / 3600);
        const mins = Math.floor((uptime % 3600) / 60);
        const secs = uptime % 60;
        reply = 'Status: Running\n'
            + 'Uptime: ' + hours + 'h ' + mins + 'm ' + secs + 's\n'
            + 'Memory: ' + Math.round(process.memoryUsage().rss / 1024 / 1024) + ' MB\n'
            + 'Platform: ' + process.platform + ' ' + process.arch + '\n'
            + 'Node: ' + process.version;
    } else {
        reply = 'Echo: ' + text;
    }

    telegramApi('sendMessage', { chat_id: chatId, text: reply })
        .then(() => log('Reply sent'))
        .catch((err) => log('Failed to send reply: ' + err.message));
}

// --- Long polling loop ---

let offset = 0;
let pollErrors = 0;

async function poll() {
    while (true) {
        try {
            const result = await telegramApi('getUpdates', {
                offset: offset,
                timeout: 30,
                allowed_updates: ['message'],
            });

            if (result.ok && result.result.length > 0) {
                for (const update of result.result) {
                    offset = update.update_id + 1;
                    if (update.message) {
                        try {
                            handleMessage(update.message);
                        } catch (e) {
                            log('Error handling message: ' + e.message);
                        }
                    }
                }
            }
            pollErrors = 0;
        } catch (err) {
            pollErrors++;
            log('Poll error (' + pollErrors + '): ' + err.message);
            // Exponential backoff: 1s, 2s, 4s, 8s, max 30s
            const delay = Math.min(1000 * Math.pow(2, pollErrors - 1), 30000);
            await new Promise(r => setTimeout(r, delay));
        }
    }
}

// --- Start ---

log('Connecting to Telegram...');
telegramApi('getMe')
    .then((result) => {
        if (result.ok) {
            log('Bot connected: @' + result.result.username + ' (' + result.result.first_name + ')');
            log('Starting long poll...');
            poll();
        } else {
            log('ERROR: getMe failed: ' + JSON.stringify(result));
        }
    })
    .catch((err) => {
        log('ERROR: Failed to connect to Telegram: ' + err.message);
    });

// Heartbeat
setInterval(() => {
    log('Heartbeat - uptime: ' + Math.floor(process.uptime()) + 's, memory: ' + Math.round(process.memoryUsage().rss / 1024 / 1024) + 'MB');
}, 300000); // Every 5 minutes
