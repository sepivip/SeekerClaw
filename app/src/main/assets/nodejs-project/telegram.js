// SeekerClaw — telegram.js
// Telegram Bot API: messaging, file uploads/downloads, HTML formatting.
// Depends on: config.js, web.js

const fs = require('fs');
const https = require('https');
const path = require('path');

const { BOT_TOKEN, log, workDir } = require('./config');
const { httpRequest } = require('./web');

// ============================================================================
// TELEGRAM API
// ============================================================================

async function telegram(method, body = null) {
    const res = await httpRequest({
        hostname: 'api.telegram.org',
        path: `/bot${BOT_TOKEN}/${method}`,
        method: body ? 'POST' : 'GET',
        headers: body ? { 'Content-Type': 'application/json' } : {},
    }, body);
    return res.data;
}

/**
 * Send a file to Telegram using multipart/form-data with streaming upload.
 * @param {string} method - Telegram API method (sendDocument, sendPhoto, etc.)
 * @param {Object} params - Non-file form fields (chat_id, caption, etc.)
 * @param {string} fieldName - Form field name for the file (document, photo, audio, etc.)
 * @param {string} filePath - Absolute path to file on disk
 * @param {string} fileName - Filename for Content-Disposition
 * @param {number} fileSize - File size in bytes (from stat)
 * @returns {Promise<Object>} Telegram API response
 */
async function telegramSendFile(method, params, fieldName, filePath, fileName, fileSize) {
    const crypto = require('crypto');
    const boundary = '----TgFile' + crypto.randomBytes(16).toString('hex');

    // Sanitize header values: strip CR/LF/null/Unicode line separators and escape quotes
    const sanitize = (s) => String(s).replace(/[\r\n\0\u2028\u2029]/g, '').replace(/"/g, "'");
    const safeFileName = sanitize(fileName);

    // Build non-file form parts
    const headerParts = [];
    for (const [key, value] of Object.entries(params)) {
        headerParts.push(Buffer.from(
            `--${boundary}\r\nContent-Disposition: form-data; name="${sanitize(key)}"\r\n\r\n${String(value).replace(/[\r\n\0\u2028\u2029]/g, ' ')}\r\n`
        ));
    }
    const fileHeader = Buffer.from(
        `--${boundary}\r\nContent-Disposition: form-data; name="${sanitize(fieldName)}"; filename="${safeFileName}"\r\nContent-Type: application/octet-stream\r\n\r\n`
    );
    const footer = Buffer.from(`\r\n--${boundary}--\r\n`);

    // Compute total Content-Length for streaming (no full-file buffer needed)
    const preambleSize = headerParts.reduce((sum, b) => sum + b.length, 0) + fileHeader.length;
    const totalSize = preambleSize + fileSize + footer.length;

    return new Promise((resolve, reject) => {
        let rs = null;
        const req = https.request({
            hostname: 'api.telegram.org',
            path: `/bot${BOT_TOKEN}/${method}`,
            method: 'POST',
            headers: {
                'Content-Type': `multipart/form-data; boundary=${boundary}`,
                'Content-Length': totalSize,
            },
        }, (res) => {
            let data = '';
            res.setEncoding('utf8');
            res.on('data', chunk => data += chunk);
            res.on('end', () => {
                try { resolve(JSON.parse(data)); }
                catch { resolve({ ok: false, description: data }); }
            });
        });
        req.on('error', err => { if (rs) rs.destroy(); reject(err); });
        req.setTimeout(120000, () => { if (rs) rs.destroy(); req.destroy(); reject(new Error('Upload timed out')); });

        // Write form preamble
        for (const part of headerParts) req.write(part);
        req.write(fileHeader);

        // Stream file content to avoid loading entire file into memory
        rs = fs.createReadStream(filePath);
        rs.on('data', chunk => { if (!req.write(chunk)) rs.pause(); });
        req.on('drain', () => rs.resume());
        rs.on('end', () => { req.write(footer); req.end(); });
        rs.on('error', err => { req.destroy(); reject(err); });
    });
}

/** Map file extension to Telegram send method + field name */
function detectTelegramFileType(ext) {
    const PHOTO_EXTS = new Set(['.jpg', '.jpeg', '.png', '.gif', '.webp']);
    const VIDEO_EXTS = new Set(['.mp4', '.mov', '.avi', '.mkv', '.webm']);
    const AUDIO_EXTS = new Set(['.mp3', '.m4a', '.aac', '.wav', '.flac']);
    const VOICE_EXTS = new Set(['.ogg', '.oga']);
    if (PHOTO_EXTS.has(ext)) return { method: 'sendPhoto', field: 'photo' };
    if (VIDEO_EXTS.has(ext)) return { method: 'sendVideo', field: 'video' };
    if (AUDIO_EXTS.has(ext)) return { method: 'sendAudio', field: 'audio' };
    if (VOICE_EXTS.has(ext)) return { method: 'sendVoice', field: 'voice' };
    return { method: 'sendDocument', field: 'document' };
}

// ============================================================================
// TELEGRAM FILE DOWNLOADS
// ============================================================================

const MEDIA_DIR = path.join(workDir, 'media', 'inbound');
const MAX_FILE_SIZE = 10 * 1024 * 1024; // 10MB limit for mobile
const MAX_IMAGE_BASE64 = 5 * 1024 * 1024;  // 5MB limit for base64-encoded vision payload
const MAX_IMAGE_SIZE = Math.floor(MAX_IMAGE_BASE64 * 3 / 4); // raw bytes so base64 stays <= 5MB

// Extract media info from a Telegram message (returns null if no media)
function extractMedia(msg) {
    if (msg.document) {
        return {
            type: 'document',
            file_id: msg.document.file_id,
            file_size: msg.document.file_size || 0,
            mime_type: msg.document.mime_type || 'application/octet-stream',
            file_name: msg.document.file_name || 'document'
        };
    }
    if (msg.photo && msg.photo.length > 0) {
        // Pick largest photo (last in array)
        const photo = msg.photo[msg.photo.length - 1];
        return {
            type: 'photo',
            file_id: photo.file_id,
            file_size: photo.file_size || 0,
            mime_type: 'image/jpeg',
            file_name: `photo_${Date.now()}.jpg`
        };
    }
    if (msg.video) {
        return {
            type: 'video',
            file_id: msg.video.file_id,
            file_size: msg.video.file_size || 0,
            mime_type: msg.video.mime_type || 'video/mp4',
            file_name: msg.video.file_name || `video_${Date.now()}.mp4`
        };
    }
    if (msg.audio) {
        return {
            type: 'audio',
            file_id: msg.audio.file_id,
            file_size: msg.audio.file_size || 0,
            mime_type: msg.audio.mime_type || 'audio/mpeg',
            file_name: msg.audio.file_name || `audio_${Date.now()}.mp3`
        };
    }
    if (msg.voice) {
        return {
            type: 'voice',
            file_id: msg.voice.file_id,
            file_size: msg.voice.file_size || 0,
            mime_type: msg.voice.mime_type || 'audio/ogg',
            file_name: `voice_${Date.now()}.ogg`
        };
    }
    if (msg.video_note) {
        return {
            type: 'video_note',
            file_id: msg.video_note.file_id,
            file_size: msg.video_note.file_size || 0,
            mime_type: 'video/mp4',
            file_name: `videonote_${Date.now()}.mp4`
        };
    }
    return null;
}

// Download a file from Telegram by file_id → save to workspace/media/inbound/
async function downloadTelegramFile(fileId, fileName) {
    // Step 1: Get file path from Telegram
    const fileInfo = await telegram('getFile', { file_id: fileId });
    if (!fileInfo.ok || !fileInfo.result?.file_path) {
        throw new Error('Telegram getFile failed: ' + (fileInfo.description || 'unknown error'));
    }
    const remotePath = fileInfo.result.file_path;

    // Validate remotePath: only safe chars, no path traversal
    if (!/^[a-zA-Z0-9\/_.\-]+$/.test(remotePath)) {
        throw new Error('Invalid file path from Telegram');
    }
    if (remotePath.startsWith('/') || remotePath.includes('\\') || remotePath.includes('//')) {
        throw new Error('Invalid file path from Telegram');
    }
    if (remotePath.split('/').some(seg => seg === '.' || seg === '..')) {
        throw new Error('Invalid file path from Telegram');
    }

    // Ensure media directory exists
    if (!fs.existsSync(MEDIA_DIR)) {
        await fs.promises.mkdir(MEDIA_DIR, { recursive: true });
    }

    // Build unique filename with random nonce to prevent collisions
    const safeName = (fileName || 'file').replace(/[^a-zA-Z0-9._-]/g, '_').slice(0, 100);
    const nonce = Math.random().toString(36).slice(2, 8);
    const localName = `${Date.now()}_${nonce}_${safeName}`;
    const localPath = path.join(MEDIA_DIR, localName);

    // Step 2: Stream download directly to file (no memory buffering)
    const fileUrl = `/file/bot${BOT_TOKEN}/${remotePath}`;
    const DOWNLOAD_TIMEOUT = 60000; // 60s timeout
    let totalBytes = 0;

    try {
        totalBytes = await new Promise((resolve, reject) => {
            let activeRes = null;
            let activeStream = null;
            let done = false;
            let endReceived = false; // Track if all data was received

            const cleanupAll = (err) => {
                if (done) return;
                done = true;
                if (activeStream) activeStream.destroy();
                if (activeRes) activeRes.destroy();
                reject(err);
            };

            const request = https.get({
                hostname: 'api.telegram.org',
                path: fileUrl,
                timeout: DOWNLOAD_TIMEOUT,
            }, (res) => {
                activeRes = res;
                if (res.statusCode === 301 || res.statusCode === 302) {
                    cleanupAll(new Error('Download failed: unexpected redirect'));
                    return;
                }
                if (res.statusCode !== 200) {
                    cleanupAll(new Error(`Download failed: HTTP ${res.statusCode}`));
                    return;
                }

                const fileStream = fs.createWriteStream(localPath);
                activeStream = fileStream;
                let bytes = 0;

                res.on('data', (chunk) => {
                    bytes += chunk.length;
                    if (bytes > MAX_FILE_SIZE) {
                        cleanupAll(new Error(`File exceeds ${MAX_FILE_SIZE / 1024 / 1024}MB limit`));
                        return;
                    }
                    if (!fileStream.write(chunk)) res.pause();
                });

                fileStream.on('drain', () => res.resume());
                res.on('end', () => {
                    endReceived = true; // All data received from network
                    fileStream.end();
                });
                fileStream.on('finish', () => {
                    if (done) return;
                    done = true;
                    resolve(bytes);
                });
                res.on('error', (err) => cleanupAll(err));
                res.on('aborted', () => {
                    if (!endReceived) cleanupAll(new Error('Download aborted'));
                });
                // Only treat 'close' as error if we haven't received all data yet.
                // On mobile networks, TCP close often races ahead of fileStream finish
                // even when all data was successfully received.
                res.on('close', () => {
                    if (!done && !endReceived) cleanupAll(new Error('Connection closed'));
                });
                fileStream.on('error', (err) => cleanupAll(err));
            });

            request.on('timeout', () => {
                request.destroy();
                cleanupAll(new Error('Download timed out'));
            });
            request.on('error', (err) => cleanupAll(err));
        });
    } catch (err) {
        // Clean up partial file on failure
        try { await fs.promises.unlink(localPath); } catch { /* ignore */ }
        throw err;
    }

    log(`File saved: ${localName} (${totalBytes} bytes)`, 'DEBUG');
    return { localPath, localName, size: totalBytes };
}

// ============================================================================
// MESSAGE FORMATTING & SENDING
// ============================================================================

// Strip reasoning tags (<think>, <thinking>, etc.) and internal markers from AI responses.
// Ported from OpenClaw shared/text/reasoning-tags.ts and pi-embedded-utils.ts
function cleanResponse(text) {
    if (!text) return text;

    let cleaned = text;

    // Strip <think>...</think> and variants (think, thinking, thought, antthinking)
    // Quick check first to avoid regex work on clean text
    if (/<\s*\/?\s*(?:think(?:ing)?|thought|antthinking)\b/i.test(cleaned)) {
        // Remove matched pairs: <think>...</think> (including multiline content)
        cleaned = cleaned.replace(/<\s*(?:think(?:ing)?|thought|antthinking)\b[^>]*>[\s\S]*?<\s*\/\s*(?:think(?:ing)?|thought|antthinking)\s*>/gi, '');
        // Remove any orphaned opening tags (unclosed thinking block — strip to end)
        cleaned = cleaned.replace(/<\s*(?:think(?:ing)?|thought|antthinking)\b[^>]*>[\s\S]*/gi, '');
    }

    // Strip [Historical context: ...] markers
    cleaned = cleaned.replace(/\[Historical context:[^\]]*\]\n?/gi, '');

    return cleaned.trim();
}

// Convert markdown to Telegram HTML with native blockquote support (BAT-24)
function toTelegramHtml(text) {
    // Escape HTML entities first
    let html = text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
    // Code blocks (``` ... ```)
    html = html.replace(/```(\w*)\n?([\s\S]*?)```/g, (_, lang, code) => `<pre>${code.trim()}</pre>`);
    // Inline code
    html = html.replace(/`([^`\n]+)`/g, '<code>$1</code>');
    // Bold (**text** or __text__)
    html = html.replace(/\*\*(.+?)\*\*/g, '<b>$1</b>');
    html = html.replace(/__(.+?)__/g, '<b>$1</b>');
    // Italic (*text* or _text_) — avoid matching inside words
    html = html.replace(/(?<!\w)\*([^*\n]+)\*(?!\w)/g, '<i>$1</i>');
    html = html.replace(/(?<!\w)_([^_\n]+)_(?!\w)/g, '<i>$1</i>');
    // Blockquotes: consecutive > lines become <blockquote>
    html = html.replace(/(^|\n)(&gt; .+(?:\n&gt; .+)*)/g, (_, pre, block) => {
        const content = block.replace(/&gt; /g, '').trim();
        return `${pre}<blockquote>${content}</blockquote>`;
    });
    return html;
}

// ============================================================================
// SENT MESSAGE CACHE (for message deletion/editing tools)
// ============================================================================

const sentMessageCache = new Map(); // chatId -> Map<messageId, { timestamp, preview }>
const SENT_CACHE_MAX = 20;
const SENT_CACHE_TTL = 24 * 60 * 60 * 1000; // 24h (Telegram forbids deleting >48h old messages)

function recordSentMessage(chatId, messageId, text) {
    const key = String(chatId);
    if (!sentMessageCache.has(key)) {
        sentMessageCache.set(key, new Map());
    }
    const cache = sentMessageCache.get(key);
    // Evict expired entries
    const now = Date.now();
    for (const [id, entry] of cache) {
        if (now - entry.timestamp > SENT_CACHE_TTL) cache.delete(id);
    }
    // Evict oldest if over cap (O(n) linear scan — Map is always ≤ 20 entries)
    if (cache.size >= SENT_CACHE_MAX) {
        let oldestId;
        let oldestTimestamp = Infinity;
        for (const [id, entry] of cache) {
            if (entry.timestamp < oldestTimestamp) {
                oldestTimestamp = entry.timestamp;
                oldestId = id;
            }
        }
        if (oldestId !== undefined) cache.delete(oldestId);
    }
    cache.set(messageId, {
        timestamp: now,
        preview: String(text || '').slice(0, 60).replace(/\n/g, ' '),
    });
}

async function sendMessage(chatId, text, replyTo = null, buttons = null) {
    // Clean AI artifacts before sending to user
    text = cleanResponse(text);
    if (!text) return; // Nothing left after cleaning

    // Telegram max message length is 4096
    const chunks = [];
    let remaining = text;
    while (remaining.length > 0) {
        chunks.push(remaining.slice(0, 4000));
        remaining = remaining.slice(4000);
    }

    for (let i = 0; i < chunks.length; i++) {
        const chunk = chunks[i];
        const isLastChunk = i === chunks.length - 1;
        // Only attach buttons to the last chunk (they belong at the bottom)
        const replyMarkup = (isLastChunk && buttons) ? { inline_keyboard: buttons } : undefined;
        let sent = false;

        // Try with HTML first (supports native blockquotes)
        try {
            const payload = {
                chat_id: chatId,
                text: toTelegramHtml(chunk),
                reply_to_message_id: replyTo,
                parse_mode: 'HTML',
            };
            if (replyMarkup) payload.reply_markup = replyMarkup;
            const result = await telegram('sendMessage', payload);
            // Check if Telegram actually accepted the message
            if (result && result.ok) {
                sent = true;
                if (result.result && result.result.message_id) {
                    recordSentMessage(chatId, result.result.message_id, chunk);
                }
            }
        } catch (e) {
            // Formatting error or network error - will retry as plain text
        }

        // Only retry as plain text if the HTML attempt failed
        if (!sent) {
            try {
                const payload = {
                    chat_id: chatId,
                    text: chunk,
                    reply_to_message_id: replyTo,
                };
                if (replyMarkup) payload.reply_markup = replyMarkup;
                const result = await telegram('sendMessage', payload);
                if (result && result.ok && result.result && result.result.message_id) {
                    recordSentMessage(chatId, result.result.message_id, chunk);
                }
            } catch (e) {
                log(`Failed to send message: ${e.message}`, 'ERROR');
            }
        }
    }
}

async function sendTyping(chatId) {
    await telegram('sendChatAction', { chat_id: chatId, action: 'typing' }).catch(() => {});
}

async function sendStatusMessage(chatId, text) {
    try {
        const result = await telegram('sendMessage', {
            chat_id: chatId,
            text,
            disable_notification: true,
        });
        return result?.result?.message_id ?? null;
    } catch (e) {
        return null;
    }
}

async function deleteStatusMessage(chatId, msgId) {
    if (!msgId) return;
    await telegram('deleteMessage', { chat_id: chatId, message_id: msgId }).catch(() => {});
}

// Deferred status: delays sending by 500ms so fast tools never flash a status.
// If shown, keeps it visible for at least 1.5s so users can read it.
function deferStatus(chatId, statusText) {
    if (!statusText) return { cleanup: async () => {} };
    let msgId = null, sentAt = 0, pending = null;
    const timer = setTimeout(() => {
        pending = sendStatusMessage(chatId, statusText).then(id => {
            msgId = id; sentAt = Date.now(); pending = null;
        });
    }, 500);
    return {
        cleanup: async () => {
            clearTimeout(timer);
            if (pending) await pending;
            if (msgId) {
                const elapsed = Date.now() - sentAt;
                if (elapsed < 1500) await new Promise(r => setTimeout(r, 1500 - elapsed));
                await deleteStatusMessage(chatId, msgId);
            }
        }
    };
}

// ============================================================================
// STATUS REACTIONS — lifecycle emoji on user messages (OpenClaw parity)
// ============================================================================

// Telegram only supports a fixed set of reaction emojis.
// Subset of the full list — just the ones we use for status.
const TELEGRAM_SUPPORTED_REACTIONS = new Set([
    '👍', '👀', '🔥', '🤔', '😱', '🥱', '😨', '⚡', '👨‍💻',
]);

const STATUS_EMOJIS = {
    queued:    '👀',
    thinking:  '🤔',
    tool:      '🔥',
    coding:    '👨‍💻',
    web:       '⚡',
    done:      '👍',
    error:     '😱',
    stallSoft: '🥱',
    stallHard: '😨',
};

const STATUS_TIMING = {
    debounceMs:  700,
    stallSoftMs: 10000,
    stallHardMs: 30000,
    doneHoldMs:  1500,
    errorHoldMs: 2500,
};

const CODING_TOOL_TOKENS = ['exec', 'process', 'read', 'write', 'edit', 'session_status', 'bash'];
const WEB_TOOL_TOKENS = ['web_search', 'web_fetch', 'browser'];

/**
 * Create a status reaction controller for a single message.
 * Mirrors OpenClaw's channel-agnostic status-reactions.ts adapted for Telegram.
 */
function createStatusReactionController(chatId, messageId) {
    let currentEmoji = null;
    let debounceTimer = null;
    let stallSoftTimer = null;
    let stallHardTimer = null;
    let disposed = false;

    async function setReaction(emoji) {
        // No disposed check here — terminal methods (setDone/setError) set
        // disposed=true before calling this. Intermediate callers (debouncedSet,
        // stall timers) already guard with their own `if (!disposed)` checks.
        if (!emoji || !TELEGRAM_SUPPORTED_REACTIONS.has(emoji)) return;
        if (emoji === currentEmoji) return;
        currentEmoji = emoji;
        try {
            await telegram('setMessageReaction', {
                chat_id: chatId,
                message_id: messageId,
                reaction: [{ type: 'emoji', emoji }],
            });
        } catch (e) {
            // Non-critical — reaction API can fail (old messages, permissions)
            log(`Status reaction failed: ${e.message}`, 'DEBUG');
        }
    }

    async function clearReaction() {
        currentEmoji = null;
        try {
            await telegram('setMessageReaction', {
                chat_id: chatId,
                message_id: messageId,
                reaction: [],
            });
        } catch {
            // Ignore — clearing a non-existent reaction is fine
        }
    }

    function resetStallTimers() {
        if (stallSoftTimer) { clearTimeout(stallSoftTimer); stallSoftTimer = null; }
        if (stallHardTimer) { clearTimeout(stallHardTimer); stallHardTimer = null; }
        stallSoftTimer = setTimeout(() => {
            if (!disposed) setReaction(STATUS_EMOJIS.stallSoft);
        }, STATUS_TIMING.stallSoftMs);
        stallHardTimer = setTimeout(() => {
            if (!disposed) setReaction(STATUS_EMOJIS.stallHard);
        }, STATUS_TIMING.stallHardMs);
    }

    function debouncedSet(emoji) {
        if (debounceTimer) clearTimeout(debounceTimer);
        resetStallTimers();
        debounceTimer = setTimeout(() => {
            if (!disposed) setReaction(emoji);
        }, STATUS_TIMING.debounceMs);
    }

    return {
        setQueued() {
            resetStallTimers();
            // Queued is immediate (no debounce) — first signal to user
            setReaction(STATUS_EMOJIS.queued);
        },
        setThinking() { debouncedSet(STATUS_EMOJIS.thinking); },
        setTool(toolName) {
            const name = (toolName || '').toLowerCase();
            if (CODING_TOOL_TOKENS.some(t => name.includes(t))) {
                debouncedSet(STATUS_EMOJIS.coding);
            } else if (WEB_TOOL_TOKENS.some(t => name.includes(t))) {
                debouncedSet(STATUS_EMOJIS.web);
            } else {
                debouncedSet(STATUS_EMOJIS.tool);
            }
        },
        async setDone() {
            disposed = true;
            if (debounceTimer) clearTimeout(debounceTimer);
            if (stallSoftTimer) clearTimeout(stallSoftTimer);
            if (stallHardTimer) clearTimeout(stallHardTimer);
            await setReaction(STATUS_EMOJIS.done);
            setTimeout(() => clearReaction(), STATUS_TIMING.doneHoldMs);
        },
        async setError() {
            disposed = true;
            if (debounceTimer) clearTimeout(debounceTimer);
            if (stallSoftTimer) clearTimeout(stallSoftTimer);
            if (stallHardTimer) clearTimeout(stallHardTimer);
            await setReaction(STATUS_EMOJIS.error);
            setTimeout(() => clearReaction(), STATUS_TIMING.errorHoldMs);
        },
        async clear() {
            disposed = true;
            if (debounceTimer) clearTimeout(debounceTimer);
            if (stallSoftTimer) clearTimeout(stallSoftTimer);
            if (stallHardTimer) clearTimeout(stallHardTimer);
            await clearReaction();
        },
    };
}

// ============================================================================
// EXPORTS
// ============================================================================

module.exports = {
    telegram,
    telegramSendFile,
    detectTelegramFileType,
    MAX_FILE_SIZE,
    MAX_IMAGE_SIZE,
    extractMedia,
    downloadTelegramFile,
    cleanResponse,
    toTelegramHtml,
    sentMessageCache,
    SENT_CACHE_TTL,
    recordSentMessage,
    sendMessage,
    sendTyping,
    deferStatus,
    createStatusReactionController,
    STATUS_EMOJIS,
};
