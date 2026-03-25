// tools/telegram.js — telegram_react, telegram_delete, telegram_send, telegram_send_file handlers

const fs = require('fs');
const path = require('path');

const {
    log,
} = require('../config');

const {
    safePath,
} = require('../security');

const {
    telegram, telegramSendFile, detectTelegramFileType,
    cleanResponse, toTelegramHtml, stripMarkdown,
    recordSentMessage,
} = require('../telegram');

const tools = [
    {
        name: 'telegram_react',
        description: 'Send a reaction emoji to a Telegram message via the setMessageReaction API. Use sparingly — at most 1 reaction per 5-10 exchanges. Pass the message_id and chat_id from the current conversation context and a single standard emoji.',
        input_schema: {
            type: 'object',
            properties: {
                message_id: { type: 'number', description: 'The Telegram message_id to react to' },
                chat_id: { type: 'number', description: 'The Telegram chat_id where the message is' },
                emoji: { type: 'string', description: 'A single emoji to react with (e.g., "\uD83D\uDC4D", "\u2764\uFE0F", "\uD83D\uDD25", "\uD83D\uDE02", "\uD83E\uDD14"). Required when adding a reaction; not needed when remove is true.' },
                remove: { type: 'boolean', description: 'Set to true to remove your reaction instead of adding one (default: false)' }
            },
            required: ['message_id', 'chat_id']
        }
    },
    {
        name: 'telegram_delete',
        description: 'Delete a message from a Telegram chat. The bot can always delete its own messages. In groups, the bot can delete user messages only if it has admin permissions. Messages older than 48 hours cannot be deleted by non-admin bots. Check the "Recent Sent Messages" section in the system prompt for your own recent message IDs — never guess a message_id.',
        input_schema: {
            type: 'object',
            properties: {
                message_id: { type: 'number', description: 'The message_id to delete. Use IDs from Recent Sent Messages in system prompt, or from a prior telegram_send call.' },
                chat_id: { type: 'number', description: 'The chat_id where the message is located' }
            },
            required: ['message_id', 'chat_id']
        }
    },
    {
        name: 'telegram_send',
        description: 'Send a Telegram message and get back the message_id. Use this instead of responding directly when you need the message_id — for example, to delete or edit it later in the same turn. Supports optional inline keyboard buttons — when the user taps a button, the callback data is injected back into the conversation as a message. Returns { ok, message_id, chat_id }.',
        input_schema: {
            type: 'object',
            properties: {
                text: { type: 'string', description: 'Message text to send (Markdown formatting supported; converted to Telegram HTML). Max 4096 characters — for long responses use the default sendMessage().' },
                buttons: {
                    type: 'array',
                    description: 'Optional inline keyboard rows. Each row is an array of button objects with "text" (display label), "callback_data" (value sent back when tapped, max 64 bytes), and optional "style" ("destructive" for red, "primary" for blue). Example: [[{"text": "\u2705 Confirm", "callback_data": "yes", "style": "primary"}, {"text": "\u274C Cancel", "callback_data": "no"}]]',
                    items: {
                        type: 'array',
                        items: {
                            type: 'object',
                            properties: {
                                text: { type: 'string' },
                                callback_data: { type: 'string' },
                                style: { type: 'string', enum: ['destructive', 'primary'], description: 'Button color: "destructive" (red) or "primary" (blue). Omit for default gray.' }
                            },
                            required: ['text', 'callback_data']
                        }
                    }
                }
            },
            required: ['text']
        }
    },
    {
        name: 'telegram_send_file',
        description: 'Send a file from the workspace to the current Telegram chat. Auto-detects type from extension (photo, video, audio, voice, document). Use for sharing reports, images, exported files, camera captures, or any workspace file with the user. Telegram bot limit: 50MB. Photos up to 10MB are sent as photos; larger images are automatically sent as documents.',
        input_schema: {
            type: 'object',
            properties: {
                path: { type: 'string', description: 'File path relative to workspace (e.g., "media/inbound/photo.jpg", "report.csv")' },
                chat_id: { type: 'number', description: 'The Telegram chat_id to send to (from conversation context)' },
                caption: { type: 'string', description: 'Optional caption/message to send with the file' },
                type: { type: 'string', enum: ['document', 'photo', 'audio', 'voice', 'video'], description: 'Override auto-detected file type. Usually not needed.' }
            },
            required: ['path', 'chat_id']
        }
    },
];

const handlers = {
    async telegram_react(input, chatId) {
        const msgId = input.message_id;
        const chatIdParam = input.chat_id;
        const emoji = String(input.emoji ?? '').trim();
        const remove = input.remove === true;
        if (!msgId) return { error: 'message_id is required' };
        if (!chatIdParam) return { error: 'chat_id is required' };
        if (!emoji && !remove) return { error: 'emoji is required (or set remove: true)' };
        try {
            // When removing: empty array clears all reactions; when setting: pass the emoji
            const reactions = remove ? [] : (emoji ? [{ type: 'emoji', emoji }] : []);
            const result = await telegram('setMessageReaction', {
                chat_id: chatIdParam,
                message_id: msgId,
                reaction: reactions,
            });
            if (result.ok) {
                const logAction = remove ? `removed${emoji ? ': ' + emoji : ' (all)'}` : 'set: ' + emoji;
                log(`Reaction ${logAction} on msg ${msgId} in chat ${chatIdParam}`, 'DEBUG');
                return { ok: true, action: remove ? 'removed' : 'reacted', emoji, message_id: msgId, chat_id: chatIdParam };
            } else {
                // Check for invalid reaction emoji in Telegram error response
                const desc = result.description || '';
                if (desc.includes('REACTION_INVALID')) {
                    return { ok: false, warning: `Invalid reaction emoji "${emoji}" — Telegram may not support it` };
                }
                return { ok: false, warning: desc || 'Reaction failed' };
            }
        } catch (e) {
            return { error: e.message };
        }
    },

    async telegram_delete(input, chatId) {
        const msgId = input.message_id;
        const chatIdParam = input.chat_id;
        if (!msgId) return { error: 'message_id is required' };
        if (!chatIdParam) return { error: 'chat_id is required' };
        try {
            const result = await telegram('deleteMessage', {
                chat_id: chatIdParam,
                message_id: msgId,
            });
            if (result.ok) {
                log(`Deleted message ${msgId} in chat ${chatIdParam}`, 'DEBUG');
                return { ok: true, action: 'deleted', message_id: msgId, chat_id: chatIdParam };
            } else {
                const desc = result.description || '';
                // Telegram error messages for common failures
                if (desc.includes('MESSAGE_ID_INVALID') || desc.includes('message not found')) {
                    return { ok: false, warning: 'Message not found or already deleted' };
                }
                if (desc.includes('MESSAGE_DELETE_FORBIDDEN') || desc.includes('not enough rights')) {
                    return { ok: false, warning: 'Cannot delete message (no permission or message too old)' };
                }
                if (desc.includes('message can\'t be deleted')) {
                    return { ok: false, warning: 'Message cannot be deleted (older than 48h or no admin rights)' };
                }
                return { ok: false, warning: desc || 'Delete failed' };
            }
        } catch (e) {
            return { error: e.message };
        }
    },

    async telegram_send(input, chatId) {
        const text = input.text;
        if (!text) return { error: 'text is required' };
        if (text.length > 4096) return { error: 'text exceeds Telegram 4096 character limit' };
        if (!chatId) return { error: 'No active chat' };
        // #298: Heartbeat/cron use synthetic string chatIds (e.g. "__heartbeat__",
        // "cron:abc") — not valid Telegram targets. Heartbeat alerts are sent via
        // sendMessage(ownerChatId) in main.js, not through this tool.
        if (typeof chatId === 'string' && isNaN(Number(chatId))) return { error: 'telegram_send not available in this context (non-Telegram session)' };
        // Validate buttons structure if provided
        if (input.buttons) {
            if (!Array.isArray(input.buttons)) return { error: 'buttons must be an array of rows' };
            for (const row of input.buttons) {
                if (!Array.isArray(row)) return { error: 'Each button row must be an array' };
                for (const btn of row) {
                    if (!btn.text || !btn.callback_data) return { error: 'Each button must have "text" and "callback_data"' };
                    if (Buffer.byteLength(btn.callback_data, 'utf8') > 64) return { error: `callback_data "${btn.callback_data.slice(0, 20)}..." exceeds Telegram 64-byte limit` };
                    if (btn.style && btn.style !== 'destructive' && btn.style !== 'primary') {
                        delete btn.style; // Strip invalid style rather than failing
                    }
                }
            }
        }
        try {
            const cleaned = cleanResponse(text);
            const replyMarkup = input.buttons ? { inline_keyboard: input.buttons } : undefined;
            // Try HTML first, fall back to plain text
            let result, htmlFailed = false;
            try {
                const payload = {
                    chat_id: chatId,
                    text: toTelegramHtml(cleaned),
                    parse_mode: 'HTML',
                };
                if (replyMarkup) payload.reply_markup = replyMarkup;
                result = await telegram('sendMessage', payload);
            } catch (e) {
                htmlFailed = true;
            }
            if (htmlFailed || !result || !result.ok) {
                const payload = {
                    chat_id: chatId,
                    text: stripMarkdown(cleaned),
                };
                if (replyMarkup) payload.reply_markup = replyMarkup;
                result = await telegram('sendMessage', payload);
            }
            if (result && result.ok && result.result && result.result.message_id) {
                const messageId = result.result.message_id;
                recordSentMessage(chatId, messageId, cleaned);
                log(`telegram_send: sent message ${messageId}`, 'DEBUG');
                return { ok: true, message_id: messageId, chat_id: chatId };
            }
            if (result) {
                if (result.ok) return { ok: false, warning: 'Message sent but message_id not returned' };
                return { ok: false, warning: result.description || 'Send failed' };
            }
            return { ok: false, warning: 'No response from Telegram API' };
        } catch (e) {
            return { error: e.message };
        }
    },

    async telegram_send_file(input, chatId) {
        if (!input.path) return { error: 'path is required' };
        if (!input.chat_id) return { error: 'chat_id is required' };

        const filePath = safePath(input.path);
        if (!filePath) return { error: 'Access denied: path outside workspace' };
        if (!fs.existsSync(filePath)) return { error: `File not found: ${input.path}` };

        let stat;
        try { stat = fs.statSync(filePath); } catch (e) { return { error: `Cannot stat file: ${e.message}` }; }
        if (stat.isDirectory()) return { error: 'Cannot send a directory. Specify a file path.' };
        if (stat.size === 0) return { error: 'Cannot send empty file (0 bytes)' };

        const MAX_SEND_SIZE = 50 * 1024 * 1024; // 50MB Telegram bot limit
        const MAX_PHOTO_SIZE = 10 * 1024 * 1024; // 10MB for sendPhoto
        if (stat.size > MAX_SEND_SIZE) {
            return { error: `\uD83D\uDCE6 That file's too big (${(stat.size / 1024 / 1024).toFixed(1)}MB, max 50MB). Can you send a smaller one?` };
        }

        const ext = path.extname(filePath).toLowerCase();
        const fileName = path.basename(filePath);
        let detected = detectTelegramFileType(ext);

        // Manual type override
        if (input.type) {
            const TYPE_MAP = {
                document: { method: 'sendDocument', field: 'document' },
                photo: { method: 'sendPhoto', field: 'photo' },
                audio: { method: 'sendAudio', field: 'audio' },
                voice: { method: 'sendVoice', field: 'voice' },
                video: { method: 'sendVideo', field: 'video' },
            };
            detected = TYPE_MAP[input.type] || detected;
        }

        // Photos > 10MB must be sent as document (applies to both auto-detected and overridden)
        if (detected.method === 'sendPhoto' && stat.size > MAX_PHOTO_SIZE) {
            const safLogName = fileName.replace(/[\r\n\0\u2028\u2029]/g, '_');
            log(`[TgSendFile] Photo ${safLogName} is ${(stat.size / 1024 / 1024).toFixed(1)}MB — downgrading to document`, 'DEBUG');
            detected = { method: 'sendDocument', field: 'document' };
        }

        try {
            const params = { chat_id: String(input.chat_id) };
            if (input.caption) params.caption = String(input.caption).slice(0, 1024);

            const safLogName = fileName.replace(/[\r\n\0\u2028\u2029]/g, '_');
            log(`[TgSendFile] ${detected.method}: ${safLogName} (${(stat.size / 1024).toFixed(1)}KB) → chat ${input.chat_id}`, 'DEBUG');
            const result = await telegramSendFile(detected.method, params, detected.field, filePath, fileName, stat.size);

            if (result && result.ok === true) {
                log(`[TgSendFile] Sent successfully`, 'DEBUG');
                return { success: true, method: detected.method, file: input.path, size: stat.size };
            } else {
                const desc = (result && result.description) || 'Unknown error';
                log(`[TgSendFile] Failed: ${desc}`, 'WARN');
                return { error: `Telegram API error: ${desc}` };
            }
        } catch (e) {
            log(`[TgSendFile] Error: ${e && e.message ? e.message : String(e)}`, 'ERROR');
            return { error: e && e.message ? e.message : String(e) };
        }
    },
};

module.exports = { tools, handlers };
