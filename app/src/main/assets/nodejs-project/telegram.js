// SeekerClaw — telegram.js
// Telegram Bot API: messaging, file uploads/downloads, HTML formatting.
// Depends on: config.js, http.js

const crypto = require('crypto');
const fs = require('fs');
const https = require('https');
const path = require('path');

const { BOT_TOKEN, log, workDir, getOwnerId } = require('./config');
const { redactSecrets } = require('./security');
const { httpRequest } = require('./http');

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

/**
 * Download a file from a direct URL (for non-Telegram channels like Discord).
 * Saves to the same media/inbound/ directory as Telegram downloads.
 * Uses streaming to handle binary files correctly and enforces size limits.
 */
async function downloadFileByUrl(url, fileName, maxSize) {
    const MAX_SIZE = maxSize || MAX_FILE_SIZE;
    const safeName = (fileName || `file_${Date.now()}`).replace(/[^a-zA-Z0-9._-]/g, '_').slice(0, 120);
    const uniqueName = `${Date.now()}_${crypto.randomBytes(4).toString('hex')}_${safeName}`;
    const mediaDir = path.join(workDir, 'media', 'inbound');
    if (!fs.existsSync(mediaDir)) fs.mkdirSync(mediaDir, { recursive: true });
    const localPath = path.join(mediaDir, uniqueName);

    const parsedUrl = new URL(url);

    // Protocol validation: HTTPS only (Discord CDN is always HTTPS)
    if (parsedUrl.protocol !== 'https:') {
        throw new Error('Unsupported URL protocol: ' + parsedUrl.protocol + ' (only https: allowed)');
    }

    // SSRF guard: block private/local/reserved addresses by hostname string.
    // Known limitation: DNS rebinding attacks are not prevented here because we check
    // the hostname string before DNS resolution. Full protection would require async DNS
    // lookup and IP validation, which adds latency and complexity.
    // Accepted trade-off: Discord CDN URLs come from cdn.discordapp.com (validated by
    // the Discord API) — this hostname check is a first-pass defense against obvious
    // SSRF attempts (localhost, RFC1918, link-local). Prompt-injection-sourced URLs
    // arriving through normal message flow are a lower risk given the owner-only gate.
    if (/^(127\.|10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.|169\.254\.|0\.|localhost|\[::1\]|\[fe80:)/i.test(parsedUrl.hostname)) {
        throw new Error('Blocked: private/local address');
    }

    return new Promise((resolve, reject) => {
        let settled = false;
        const done = (fn, val) => {
            if (settled) return;
            settled = true;
            fn(val);
        };

        const req = https.request({
            hostname: parsedUrl.hostname,
            port: parsedUrl.port || 443,
            path: parsedUrl.pathname + parsedUrl.search,
            method: 'GET',
            headers: { 'User-Agent': 'SeekerClaw/1.0' },
            timeout: 30000,
        }, (res) => {
            // Follow redirects (Discord CDN can 301/302)
            if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
                res.resume(); // drain
                downloadFileByUrl(res.headers.location, fileName, maxSize)
                    .then(r => done(resolve, r))
                    .catch(e => done(reject, e));
                return;
            }
            if (res.statusCode < 200 || res.statusCode >= 300) {
                res.resume(); // drain
                done(reject, new Error(`Download failed: HTTP ${res.statusCode}`));
                return;
            }

            const fileStream = fs.createWriteStream(localPath);
            let totalBytes = 0;

            res.on('data', (chunk) => {
                totalBytes += chunk.length;
                if (totalBytes > MAX_SIZE) {
                    res.destroy();
                    fileStream.destroy();
                    try { fs.unlinkSync(localPath); } catch (_) {}
                    done(reject, new Error(`File too large (>${Math.round(MAX_SIZE / 1024 / 1024)}MB)`));
                }
            });

            res.on('error', (err) => {
                fileStream.destroy();
                try { fs.unlinkSync(localPath); } catch (_) {}
                done(reject, err);
            });

            res.pipe(fileStream);

            fileStream.on('finish', () => {
                done(resolve, { localPath, localName: uniqueName, size: totalBytes });
            });

            fileStream.on('error', (err) => {
                try { fs.unlinkSync(localPath); } catch (_) {}
                done(reject, err);
            });
        });

        req.on('error', (err) => done(reject, err));
        req.on('timeout', () => {
            req.destroy();
            done(reject, new Error('Download timed out'));
        });
        req.end();
    });
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

    // Repetition detector — catch degenerate model output (reasoning loops)
    // If any line appears 3+ times, keep first 2 and replace rest with a count.
    // Matching is case-insensitive with leading/trailing whitespace trimmed.
    cleaned = deduplicateRepeatedLines(cleaned);

    return cleaned.trim();
}

/**
 * Detect and collapse repeated lines in model output.
 * Keeps first 2 occurrences of any repeated line, replaces the rest with
 * "(repeated N more times)" to prevent degenerate output from reaching the user.
 * Only triggers at 3+ repetitions — normal content passes through unchanged.
 */
function deduplicateRepeatedLines(text) {
    if (!text) return text;
    const lines = text.split('\n');
    if (lines.length < 6) return text; // too short to have meaningful repetition

    // Count occurrences of each normalized line
    const counts = new Map();
    for (const line of lines) {
        const key = line.trim().toLowerCase();
        if (!key) continue; // skip blank lines
        counts.set(key, (counts.get(key) || 0) + 1);
    }

    // Check if any line repeats 3+ times
    let hasRepetition = false;
    for (const count of counts.values()) {
        if (count >= 3) { hasRepetition = true; break; }
    }
    if (!hasRepetition) return text;

    // Rebuild with deduplication
    const seen = new Map(); // normalized → times included so far
    const result = [];
    for (const line of lines) {
        const key = line.trim().toLowerCase();
        if (!key) { result.push(line); continue; } // preserve blank lines

        const total = counts.get(key) || 0;
        const seenCount = seen.get(key) || 0;

        if (total < 3) {
            // Not a repeated line — pass through
            result.push(line);
        } else if (seenCount < 2) {
            // Keep first 2 occurrences
            result.push(line);
            seen.set(key, seenCount + 1);
        } else if (seenCount === 2) {
            // Replace 3rd+ with count, preserving leading whitespace/list markers
            const prefix = line.match(/^(\s*(?:[-*•]\s*)?)/)[1] || '';
            result.push(`${prefix}(repeated ${total - 2} more times)`);
            seen.set(key, seenCount + 1);
        }
        // seenCount > 2: skip (already added the count message)
    }

    return result.join('\n');
}

// markdown-it parser — proper AST-based markdown parsing (replaces fragile regex, BAT-291)
// Uses the same library as OpenClaw for parity.
const md = require('./markdown-it.min.js')({ html: false, linkify: true, breaks: false });
md.enable('strikethrough');
// Disable tables — renderTokens() doesn't handle table_*/tr_*/td_* tokens;
// leaving raw pipe-based markdown is better than garbled concatenated cells.
md.disable('table');

function escapeHtml(text) {
    return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function escapeHtmlAttr(text) {
    return escapeHtml(text).replace(/"/g, '&quot;');
}

// Convert markdown to Telegram HTML using markdown-it AST (BAT-291, replaces regex BAT-24/BAT-278)
function toTelegramHtml(text) {
    const tokens = md.parse(text || '', {});
    return renderTokens(tokens).replace(/\n{3,}/g, '\n\n').trimEnd();
}

function renderTokens(tokens) {
    let html = '';
    for (const token of tokens) {
        switch (token.type) {
            case 'paragraph_open': break;
            case 'paragraph_close':
                // markdown-it marks paragraph tokens as hidden for tight list items — skip to avoid extra blank lines
                if (!token.hidden) html += '\n\n';
                break;
            case 'heading_open': html += '<b>'; break;
            case 'heading_close': html += '</b>\n\n'; break;
            case 'inline':
                html += renderInline(token.children || []);
                break;
            case 'fence':
            case 'code_block':
                html += `<pre>${escapeHtml((token.content || '').trimEnd())}</pre>\n`;
                break;
            case 'blockquote_open': html += '<blockquote>'; break;
            case 'blockquote_close':
                html = html.replace(/\n+$/, '');
                html += '</blockquote>';
                break;
            case 'bullet_list_open':
            case 'bullet_list_close':
            case 'ordered_list_open':
            case 'ordered_list_close':
                break;
            case 'list_item_open': html += '• '; break;
            case 'list_item_close': html += '\n'; break;
            case 'hr': html += '—————\n'; break;
            default:
                if (token.children) {
                    html += renderTokens(token.children);
                }
                break;
        }
    }
    return html;
}

function renderInline(tokens) {
    let html = '';
    let linkOpen = false;
    for (const token of tokens) {
        switch (token.type) {
            case 'text': html += escapeHtml(token.content || ''); break;
            case 'strong_open': html += '<b>'; break;
            case 'strong_close': html += '</b>'; break;
            case 'em_open': html += '<i>'; break;
            case 'em_close': html += '</i>'; break;
            case 's_open': html += '<s>'; break;
            case 's_close': html += '</s>'; break;
            case 'code_inline': html += `<code>${escapeHtml(token.content || '')}</code>`; break;
            case 'link_open': {
                const hrefAttr = (token.attrs || []).find(a => a[0] === 'href');
                const href = hrefAttr ? hrefAttr[1] : '';
                // Only allow http(s) links — preserves prior safety behavior (BAT-291)
                if (/^https?:\/\//i.test(href)) {
                    html += `<a href="${escapeHtmlAttr(href)}">`;
                    linkOpen = true;
                } else {
                    linkOpen = false;
                }
                break;
            }
            case 'link_close':
                if (linkOpen) html += '</a>';
                linkOpen = false;
                break;
            case 'softbreak': html += '\n'; break;
            case 'hardbreak': html += '\n'; break;
            default:
                html += escapeHtml(token.content || '');
                break;
        }
    }
    return html;
}

// Strip markdown syntax for clean plain-text fallback (BAT-291)
function stripMarkdown(text) {
    return text
        .replace(/```\w*\n?([\s\S]*?)```/g, (_, code) => code.trim())
        .replace(/`([^`\n]+)`/g, '$1')
        .replace(/\*\*\*(.+?)\*\*\*/g, '$1')
        .replace(/\*\*(.+?)\*\*/g, '$1')
        .replace(/\*([^*\n]+)\*/g, '$1')
        .replace(/___(.+?)___/g, '$1')
        .replace(/__(.+?)__/g, '$1')
        .replace(/_([^_\n]+)_/g, '$1')
        .replace(/~~(.+?)~~/g, '$1')
        .replace(/^\s*>+\s?/gm, '')
        .replace(/\[([^\]]+)\]\([^)]+\)/g, '$1');
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

const CHUNK_MAX = 3500; // Conservative margin — HTML tags (<b>, <pre>, <code>) expand text beyond raw markdown length

/**
 * Split text into Telegram-safe chunks, preferring markdown-friendly break points.
 * Handles paragraph breaks, line breaks, word boundaries, and code fence continuity.
 */
function chunkMarkdown(text) {
    if (text.length <= CHUNK_MAX) return [text];

    const chunks = [];
    let remaining = text;

    while (remaining.length > CHUNK_MAX) {
        let breakAt = -1;

        // 1. Prefer paragraph boundary (double newline)
        const paraIdx = remaining.lastIndexOf('\n\n', CHUNK_MAX - 2);
        if (paraIdx > CHUNK_MAX * 0.3) {
            breakAt = paraIdx + 2; // always <= CHUNK_MAX
        }

        // 2. Fallback: single newline
        if (breakAt === -1) {
            const lineIdx = remaining.lastIndexOf('\n', CHUNK_MAX - 1);
            if (lineIdx > CHUNK_MAX * 0.3) {
                breakAt = lineIdx + 1; // always <= CHUNK_MAX
            }
        }

        // 3. Fallback: last whitespace (word boundary)
        if (breakAt === -1) {
            const wsIdx = remaining.lastIndexOf(' ', CHUNK_MAX - 1);
            if (wsIdx > CHUNK_MAX * 0.3) {
                breakAt = wsIdx + 1; // always <= CHUNK_MAX
            }
        }

        // 4. Hard fallback: slice at limit
        if (breakAt === -1) {
            breakAt = CHUNK_MAX;
        }

        let chunk = remaining.slice(0, breakAt);
        remaining = remaining.slice(breakAt);

        // Handle unclosed code fences: odd count of ``` means one is open
        const fences = chunk.match(/^ {0,3}```/gm);
        if (fences && fences.length % 2 !== 0) {
            // Don't add artificial fences if remaining already starts with the closing fence
            if (/^ {0,3}```/.test(remaining)) {
                // The natural closing fence is at the start of remaining — leave it alone
            } else {
                chunk += '\n```';
                remaining = '```\n' + remaining;
            }
        }

        chunks.push(chunk);
    }

    if (remaining.length > 0) {
        chunks.push(remaining);
    }

    return chunks;
}

async function sendMessage(chatId, text, replyTo = null, buttons = null) {
    // Clean AI artifacts before sending to user
    text = cleanResponse(text);
    if (!text) return; // Nothing left after cleaning
    // Redact any leaked secrets (API keys, tokens) from outgoing messages
    text = redactSecrets(text);

    // Telegram max message length is 4096 — use markdown-aware chunking
    const chunks = chunkMarkdown(text);
    let lastMessageId = null;

    for (let i = 0; i < chunks.length; i++) {
        const chunk = chunks[i];
        const isLastChunk = i === chunks.length - 1;
        // Only attach buttons to the last chunk (they belong at the bottom)
        const replyMarkup = (isLastChunk && buttons) ? { inline_keyboard: buttons } : undefined;
        let sent = false;

        // Try with HTML first (supports native blockquotes)
        const htmlText = toTelegramHtml(chunk);
        try {
            const payload = {
                chat_id: chatId,
                text: htmlText,
                reply_to_message_id: replyTo,
                parse_mode: 'HTML',
            };
            if (replyMarkup) payload.reply_markup = replyMarkup;
            const result = await telegram('sendMessage', payload);
            // Check if Telegram actually accepted the message
            if (result && result.ok) {
                sent = true;
                if (result.result && result.result.message_id) {
                    lastMessageId = result.result.message_id;
                    recordSentMessage(chatId, result.result.message_id, chunk);
                }
            } else if (result && !result.ok) {
                const desc = result.description || '';
                // HTML expansion exceeded Telegram's 4096 limit — re-chunk at half size
                if (desc.includes('too long')) {
                    const half = Math.floor(chunk.length / 2);
                    const subChunks = chunkMarkdown(chunk.slice(0, half));
                    subChunks.push(...chunkMarkdown(chunk.slice(half)));
                    // Insert sub-chunks after current position so they get sent in order
                    chunks.splice(i + 1, 0, ...subChunks);
                    sent = true; // skip plain-text fallback, sub-chunks will be sent next
                } else {
                    log(`HTML format rejected: ${desc}`, 'WARN');
                }
            }
        } catch (e) {
            log(`sendMessage HTML failed: ${e.message}`, 'WARN');
        }

        // Only retry as plain text if the HTML attempt failed
        if (!sent) {
            try {
                const payload = {
                    chat_id: chatId,
                    text: stripMarkdown(chunk),
                    reply_to_message_id: replyTo,
                };
                if (replyMarkup) payload.reply_markup = replyMarkup;
                const result = await telegram('sendMessage', payload);
                if (result && result.ok && result.result && result.result.message_id) {
                    lastMessageId = result.result.message_id;
                    recordSentMessage(chatId, result.result.message_id, chunk);
                }
            } catch (e) {
                log(`Failed to send message: ${e.message}`, 'ERROR');
            }
        }
    }

    // Return { messageId } of the last successfully sent chunk (channel interface contract)
    if (lastMessageId != null) return { messageId: lastMessageId };
}

// OpenClaw parity: backoff on 401/403 to avoid hammering Telegram with invalid token
let _chatActionBackoff = 0;

async function sendTyping(chatId) {
    if (_chatActionBackoff > Date.now()) return;
    try {
        const res = await telegram('sendChatAction', { chat_id: chatId, action: 'typing' });
        if (res && !res.ok && (res.error_code === 401 || res.error_code === 403)) {
            _chatActionBackoff = Date.now() + 10000;
            log(`sendChatAction ${res.error_code} — backing off 10s`, 'WARN');
        }
    } catch (e) { /* typing is non-critical */ }
}

async function sendStatusMessage(chatId, text) {
    try {
        text = redactSecrets(text);
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
    let holdTimer = null;
    let disposed = false;

    // Serialize reaction updates to avoid races between overlapping calls.
    let reactionChain = Promise.resolve();

    async function setReaction(emoji) {
        // No disposed check here — terminal methods (setDone/setError) set
        // disposed=true before calling this. Intermediate callers (debouncedSet,
        // stall timers) already guard with their own `if (!disposed)` checks.
        if (!emoji || !TELEGRAM_SUPPORTED_REACTIONS.has(emoji)) return;

        reactionChain = reactionChain.then(async () => {
            if (emoji === currentEmoji) return;
            try {
                await telegram('setMessageReaction', {
                    chat_id: chatId,
                    message_id: messageId,
                    reaction: [{ type: 'emoji', emoji }],
                });
                currentEmoji = emoji;
            } catch (e) {
                // Non-critical — reaction API can fail (old messages, permissions)
                log(`Status reaction failed: ${e.message}`, 'DEBUG');
            }
        });

        return reactionChain;
    }

    async function clearReaction() {
        reactionChain = reactionChain.then(async () => {
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
        });

        return reactionChain;
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
            if (holdTimer) clearTimeout(holdTimer);
            await setReaction(STATUS_EMOJIS.done);
            holdTimer = setTimeout(() => clearReaction(), STATUS_TIMING.doneHoldMs);
        },
        async setError() {
            disposed = true;
            if (debounceTimer) clearTimeout(debounceTimer);
            if (stallSoftTimer) clearTimeout(stallSoftTimer);
            if (stallHardTimer) clearTimeout(stallHardTimer);
            if (holdTimer) clearTimeout(holdTimer);
            await setReaction(STATUS_EMOJIS.error);
            holdTimer = setTimeout(() => clearReaction(), STATUS_TIMING.errorHoldMs);
        },
        async clear() {
            disposed = true;
            if (debounceTimer) clearTimeout(debounceTimer);
            if (stallSoftTimer) clearTimeout(stallSoftTimer);
            if (stallHardTimer) clearTimeout(stallHardTimer);
            if (holdTimer) clearTimeout(holdTimer);
            await clearReaction();
        },
    };
}

// ============================================================================
// CHANNEL INTERFACE — start, stop, sendFile, editMessage, deleteMessage,
//                     getOwnerChatId (BAT-483)
// ============================================================================

let _onMessage = null;
let _onReaction = null;
let _stopped = false;

/**
 * Store callbacks for the channel interface. The Telegram poll loop stays in
 * main.js — start() just stores the callbacks and returns.
 */
function start(onMessage, onReaction) {
    _onMessage = onMessage;
    _onReaction = onReaction;
    _stopped = false;
}

function stop() {
    _stopped = true;
}

/**
 * Send a file to a Telegram chat using the existing multipart upload helpers.
 * Returns { messageId } on success or { error } on failure.
 */
async function sendFile(chatId, filePath, caption) {
    if (!fs.existsSync(filePath)) return { error: 'File not found' };
    try {
        const ext = path.extname(filePath).toLowerCase();
        const fileName = path.basename(filePath);
        const stat = fs.statSync(filePath);
        const { method, field } = detectTelegramFileType(ext);
        const params = { chat_id: chatId };
        if (caption) params.caption = caption;
        const result = await telegramSendFile(method, params, field, filePath, fileName, stat.size);
        if (result && result.ok && result.result) {
            return { messageId: result.result.message_id };
        }
        return { error: result?.description || 'Send failed' };
    } catch (e) {
        log(`sendFile error: ${e.message}`, 'ERROR');
        return { error: e.message };
    }
}

/**
 * Edit a message in a Telegram chat (text or reply markup).
 */
async function editMessage(chatId, messageId, text, replyMarkup) {
    if (text !== undefined && text !== null) {
        return telegram('editMessageText', {
            chat_id: chatId,
            message_id: messageId,
            text,
            parse_mode: 'HTML',
        });
    }
    if (replyMarkup !== undefined) {
        return telegram('editMessageReplyMarkup', {
            chat_id: chatId,
            message_id: messageId,
            reply_markup: typeof replyMarkup === 'string' ? replyMarkup : JSON.stringify(replyMarkup),
        });
    }
}

/**
 * Delete a message in a Telegram chat.
 */
async function deleteMsg(chatId, messageId) {
    return telegram('deleteMessage', { chat_id: chatId, message_id: messageId });
}

/**
 * Get the owner's chat ID as a string.
 */
function getOwnerChatId() {
    const ownerId = getOwnerId();
    return ownerId ? String(ownerId) : null;
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
    downloadFileByUrl,
    cleanResponse,
    toTelegramHtml,
    stripMarkdown,
    sentMessageCache,
    SENT_CACHE_TTL,
    recordSentMessage,
    sendMessage,
    sendTyping,
    deferStatus,
    createStatusReactionController,
    STATUS_EMOJIS,
    // Channel interface (BAT-483)
    start,
    stop,
    sendFile,
    editMessage,
    deleteMessage: deleteMsg,
    getOwnerChatId,
};
