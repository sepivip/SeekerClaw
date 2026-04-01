// SeekerClaw — discord.js
// Discord Gateway v10 client + REST message sending.
// Channel interface: start(callback), stop(), sendMessage(chatId, text, replyTo?), sendTyping(chatId)
// Depends on: config.js, http.js, bridge.js

const { DISCORD_TOKEN, DISCORD_OWNER_ID, log, getOwnerId, setOwnerId } = require('./config');
const { httpRequest } = require('./http');
const { androidBridgeCall } = require('./bridge');
const { redactSecrets } = require('./security');

let WebSocket;
try {
    WebSocket = require('ws');
} catch (_) {
    log('[Discord] ws package not found — Discord channel unavailable. Vendor ws into node_modules/', 'ERROR');
}

// ── Gateway Constants ───────────────────────────────────────────────────────

const GATEWAY_URL = 'wss://gateway.discord.gg/?v=10&encoding=json';
// DIRECT_MESSAGES (1<<12) | DIRECT_MESSAGE_REACTIONS (1<<13) | MESSAGE_CONTENT (1<<15)
const INTENTS = (1 << 12) | (1 << 13) | (1 << 15);

// ── Gateway State ───────────────────────────────────────────────────────────

let ws = null;
let heartbeatInterval = null;
let heartbeatAck = true;
let seq = null;
let sessionId = null;
let resumeGatewayUrl = null;
let onMessageCallback = null;
let reconnectAttempts = 0;
let stopped = false; // True after stop() — prevents reconnect
const MAX_RECONNECT_DELAY = 30000;

// ── Gateway Connection ──────────────────────────────────────────────────────

function connect() {
    if (!WebSocket) {
        log('[Discord] Cannot connect — ws package not available', 'ERROR');
        return;
    }
    if (stopped) return;

    const url = resumeGatewayUrl || GATEWAY_URL;
    log('[Discord] Connecting to gateway...', 'INFO');

    try {
        ws = new WebSocket(url);
    } catch (e) {
        log(`[Discord] WebSocket constructor failed: ${e.message}`, 'ERROR');
        scheduleReconnect();
        return;
    }

    ws.on('open', () => {
        log('[Discord] WebSocket connected', 'DEBUG');
        reconnectAttempts = 0;
    });

    ws.on('message', (data) => {
        try {
            const payload = JSON.parse(data.toString());
            handleGatewayEvent(payload);
        } catch (e) {
            log(`[Discord] Failed to parse gateway message: ${e.message}`, 'WARN');
        }
    });

    ws.on('close', (code, reason) => {
        log(`[Discord] WebSocket closed: ${code} ${reason || ''}`, 'WARN');
        stopHeartbeat();
        if (stopped) return;
        // 4004 = invalid token, 4014 = disallowed intents — don't reconnect
        if (code === 4004 || code === 4014) {
            const msg = code === 4004 ? 'Invalid bot token' : 'Disallowed intents (enable MESSAGE_CONTENT in Bot settings)';
            log(`[Discord] ${msg} — not reconnecting`, 'ERROR');
            return;
        }
        // 4007 = invalid seq, 4009 = session timed out — clear session before reconnect
        if (code === 4007 || code === 4009) {
            sessionId = null;
            seq = null;
        }
        scheduleReconnect();
    });

    ws.on('error', (err) => {
        log(`[Discord] WebSocket error: ${err.message}`, 'ERROR');
    });
}

function handleGatewayEvent(payload) {
    const { op, t, s, d } = payload;
    if (s != null) seq = s;

    switch (op) {
        case 10: // Hello
            startHeartbeat(d.heartbeat_interval);
            if (sessionId && seq != null) {
                // Resume existing session
                send({ op: 6, d: { token: DISCORD_TOKEN, session_id: sessionId, seq } });
                log('[Discord] Sent Resume', 'DEBUG');
            } else {
                // Identify
                send({
                    op: 2,
                    d: {
                        token: DISCORD_TOKEN,
                        intents: INTENTS,
                        properties: { os: 'android', browser: 'seekerclaw', device: 'seekerclaw' },
                    },
                });
                log('[Discord] Sent Identify', 'DEBUG');
            }
            break;

        case 11: // Heartbeat ACK
            heartbeatAck = true;
            break;

        case 7: // Reconnect request
            log('[Discord] Server requested reconnect', 'INFO');
            ws.close(4000, 'Reconnect requested');
            break;

        case 9: // Invalid Session
            log(`[Discord] Invalid session (resumable: ${d})`, 'WARN');
            if (!d) { sessionId = null; seq = null; }
            stopHeartbeat();
            // Close the current WebSocket before reconnecting to avoid ghost connections
            if (ws) { ws.removeAllListeners(); ws.close(); ws = null; }
            // Wait 1-5s before re-identifying (Discord recommendation)
            setTimeout(() => connect(), 1000 + Math.random() * 4000);
            break;

        case 0: // Dispatch
            handleDispatch(t, d);
            break;
    }
}

function handleDispatch(event, data) {
    switch (event) {
        case 'READY':
            sessionId = data.session_id;
            resumeGatewayUrl = data.resume_gateway_url;
            log(`[Discord] Ready — session ${sessionId}, user ${data.user?.username}`, 'INFO');
            break;

        case 'RESUMED':
            log('[Discord] Session resumed successfully', 'INFO');
            break;

        case 'MESSAGE_CREATE':
            handleMessageCreate(data);
            break;
    }
}

// ── Message Handling ────────────────────────────────────────────────────────

function handleMessageCreate(msg) {
    // Ignore bot messages (including our own)
    if (msg.author?.bot) return;

    // DMs only — guild_id is absent for DMs
    if (msg.guild_id) return;

    const senderId = msg.author?.id;
    if (!senderId) return;

    // Owner gate: auto-detect or check
    const ownerId = getOwnerId() || DISCORD_OWNER_ID;
    if (!ownerId) {
        // First DM claims ownership (same pattern as Telegram auto-detect)
        setOwnerId(senderId);
        log(`[Discord] Owner claimed by ${senderId} (auto-detect)`, 'INFO');
        androidBridgeCall('/config/save-owner', { ownerId: senderId }).catch(() => {});
    } else if (senderId !== ownerId) {
        log(`[Discord] Ignoring message from non-owner ${senderId}`, 'DEBUG');
        return;
    }

    // Normalize to channel-agnostic shape (PR 1 contract)
    const attachment = msg.attachments?.[0];
    let media = null;
    if (attachment) {
        media = {
            type: detectMediaType(attachment.content_type),
            file_id: null,
            url: attachment.url,
            downloadMethod: 'url',
            file_size: attachment.size || 0,
            mime_type: attachment.content_type || 'application/octet-stream',
            file_name: attachment.filename || `file_${Date.now()}`,
        };
    }

    let replyTo = null;
    if (msg.message_reference?.message_id && msg.referenced_message) {
        replyTo = {
            text: (msg.referenced_message.content || '').trim(),
            authorName: msg.referenced_message.author?.username || 'Someone',
        };
    }

    const normalized = {
        chatId: msg.channel_id,
        senderId,
        text: (msg.content || '').trim(),
        caption: '',
        messageId: msg.id,
        media,
        replyTo,
        quoteText: null,
        raw: msg,
    };

    if (onMessageCallback) {
        onMessageCallback(normalized);
    }
}

function detectMediaType(contentType) {
    if (!contentType) return 'document';
    if (contentType.startsWith('image/')) return 'photo';
    if (contentType.startsWith('video/')) return 'video';
    if (contentType.startsWith('audio/')) return 'audio';
    return 'document';
}

// ── Heartbeat ───────────────────────────────────────────────────────────────

function startHeartbeat(intervalMs) {
    stopHeartbeat();
    heartbeatAck = true;
    heartbeatInterval = setInterval(() => {
        if (!heartbeatAck) {
            log('[Discord] Heartbeat ACK missed — reconnecting', 'WARN');
            ws?.close(4000, 'Heartbeat timeout');
            return;
        }
        heartbeatAck = false;
        send({ op: 1, d: seq });
    }, intervalMs);
    // First heartbeat with jitter per Discord spec
    setTimeout(() => send({ op: 1, d: seq }), Math.random() * intervalMs);
}

function stopHeartbeat() {
    if (heartbeatInterval) {
        clearInterval(heartbeatInterval);
        heartbeatInterval = null;
    }
}

// ── Reconnect ───────────────────────────────────────────────────────────────

function scheduleReconnect() {
    if (stopped) return;
    reconnectAttempts++;
    const delay = Math.min(1000 * Math.pow(2, reconnectAttempts - 1), MAX_RECONNECT_DELAY);
    log(`[Discord] Reconnecting in ${Math.round(delay / 1000)}s (attempt ${reconnectAttempts})`, 'INFO');
    setTimeout(() => connect(), delay);
}

// ── Gateway Send ────────────────────────────────────────────────────────────

function send(payload) {
    if (ws?.readyState === 1) { // WebSocket.OPEN = 1
        ws.send(JSON.stringify(payload));
    }
}

// ── REST API (sending messages) ─────────────────────────────────────────────

const DISCORD_API_HOST = 'discord.com';
const API_BASE = '/api/v10';

/**
 * Send a message to a Discord channel. Signature matches Telegram sendMessage(chatId, text, replyTo).
 * Discord max message length is 2000 chars — automatically chunks longer text.
 * The optional `buttons` parameter is accepted for interface parity but currently ignored.
 */
async function sendMessage(channelId, text, replyToId = null, _buttons = null) {
    if (!text) return;
    // Redact secrets before sending (same as Telegram path)
    text = redactSecrets(text);
    if (!text) return;

    // Discord max message length is 2000 chars
    const chunks = [];
    let remaining = text;
    while (remaining.length > 0) {
        if (remaining.length <= 2000) {
            chunks.push(remaining);
            break;
        }
        // Try to break at a newline boundary within the limit
        let cutoff = remaining.lastIndexOf('\n', 2000);
        if (cutoff < 200) cutoff = 2000; // No good break point — hard cut
        chunks.push(remaining.slice(0, cutoff));
        remaining = remaining.slice(cutoff);
    }

    for (let i = 0; i < chunks.length; i++) {
        const body = { content: chunks[i] };
        if (replyToId && i === 0) {
            body.message_reference = { message_id: String(replyToId) };
        }
        try {
            const res = await httpRequest({
                hostname: DISCORD_API_HOST,
                path: `${API_BASE}/channels/${channelId}/messages`,
                method: 'POST',
                headers: {
                    'Authorization': `Bot ${DISCORD_TOKEN}`,
                    'Content-Type': 'application/json',
                    'User-Agent': 'SeekerClaw (https://seekerclaw.xyz, 1.0)',
                },
                timeout: 15000,
            }, JSON.stringify(body));

            if (res.status === 429) {
                // Rate limited — wait and retry once
                const retryAfter = (typeof res.data?.retry_after === 'number' ? res.data.retry_after : 1);
                log(`[Discord] Rate limited — waiting ${retryAfter}s`, 'WARN');
                await new Promise(r => setTimeout(r, retryAfter * 1000));
                const retryRes = await httpRequest({
                    hostname: DISCORD_API_HOST,
                    path: `${API_BASE}/channels/${channelId}/messages`,
                    method: 'POST',
                    headers: {
                        'Authorization': `Bot ${DISCORD_TOKEN}`,
                        'Content-Type': 'application/json',
                        'User-Agent': 'SeekerClaw (https://seekerclaw.xyz, 1.0)',
                    },
                    timeout: 15000,
                }, JSON.stringify(body));
                if (retryRes.status >= 400) {
                    log(`[Discord] Send retry failed: ${retryRes.status}`, 'ERROR');
                }
            } else if (res.status >= 400) {
                log(`[Discord] Send failed: ${res.status} ${JSON.stringify(res.data).slice(0, 200)}`, 'ERROR');
            }
        } catch (e) {
            log(`[Discord] Send error: ${e.message}`, 'ERROR');
        }
    }
}

/**
 * Trigger typing indicator in a Discord channel.
 * Discord typing indicator lasts ~10s — the caller is expected to call this periodically.
 */
async function sendTyping(channelId) {
    try {
        await httpRequest({
            hostname: DISCORD_API_HOST,
            path: `${API_BASE}/channels/${channelId}/typing`,
            method: 'POST',
            headers: {
                'Authorization': `Bot ${DISCORD_TOKEN}`,
                'Content-Type': 'application/json',
                'User-Agent': 'SeekerClaw (https://seekerclaw.xyz, 1.0)',
            },
            timeout: 5000,
        });
    } catch (_) {
        // Non-fatal — typing indicator is cosmetic
    }
}

// ── Public Interface ────────────────────────────────────────────────────────

function start(callback) {
    if (!DISCORD_TOKEN) {
        log('[Discord] No bot token configured — Discord disabled', 'WARN');
        return;
    }
    if (!WebSocket) {
        log('[Discord] Cannot start — ws package not installed', 'ERROR');
        return;
    }
    stopped = false;
    onMessageCallback = callback;
    connect();
    log('[Discord] Channel started', 'INFO');
}

function stop() {
    stopped = true;
    stopHeartbeat();
    if (ws) {
        ws.close(1000, 'Shutdown');
        ws = null;
    }
    log('[Discord] Channel stopped', 'INFO');
}

module.exports = {
    start,
    stop,
    sendMessage,
    sendTyping,
};
