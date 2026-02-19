// SeekerClaw AI Agent
// Phase 2: Full Claude AI agent with tools, memory, and personality

const fs = require('fs');

// ============================================================================
// CONFIG (extracted to config.js — BAT-193)
// ============================================================================

const {
    ANTHROPIC_KEY, AUTH_TYPE, MODEL, AGENT_NAME,
    MCP_SERVERS, REACTION_NOTIFICATIONS,
    MEMORY_DIR,
    localTimestamp, log, setRedactFn,
    getOwnerId, setOwnerId,
} = require('./config');

// OWNER_ID is mutable (auto-detect from first message). Keep a local let
// for all existing code; the one write-site also calls setOwnerId() to keep
// config.js in sync for future modules that import it.
let OWNER_ID = getOwnerId();

process.on('uncaughtException', (err) => log('UNCAUGHT: ' + (err.stack || err), 'ERROR'));
process.on('unhandledRejection', (reason) => log('UNHANDLED: ' + reason, 'ERROR'));

// ============================================================================
// SECURITY (extracted to security.js — BAT-194)
// ============================================================================

const {
    redactSecrets,
    wrapExternalContent,
} = require('./security');

// Wire redactSecrets into config.js log() so early log lines before this point
// are unredacted (acceptable — they only contain non-secret startup info) and
// all subsequent log lines go through redaction.
setRedactFn(redactSecrets);

// ============================================================================
// BRIDGE (extracted to bridge.js — BAT-195)
// ============================================================================

const { androidBridgeCall } = require('./bridge');

// ── MCP (Model Context Protocol) — Remote tool servers (BAT-168) ───
const { MCPManager } = require('./mcp-client');
const mcpManager = new MCPManager(log, wrapExternalContent);


// ============================================================================
// MEMORY (extracted to memory.js — BAT-198)
// ============================================================================

const {
    loadSoul, loadBootstrap, loadIdentity,
    loadMemory,
} = require('./memory');

// ============================================================================
// CRON (extracted to cron.js — BAT-200)
// ============================================================================

const {
    setSendMessage, cronService,
} = require('./cron');

// ============================================================================
// DATABASE (extracted to database.js — BAT-202)
// ============================================================================

const {
    setShutdownDeps,
    initDatabase, indexMemoryFiles,
    startDbSummaryInterval, startStatsServer,
} = require('./database');

// ============================================================================
// SOLANA (extracted to solana.js — BAT-201)
// ============================================================================

const {
    refreshJupiterProgramLabels,
} = require('./solana');

// ============================================================================
// SKILLS (extracted to skills.js — BAT-199)
// ============================================================================

const {
    loadSkills,
} = require('./skills');

// ============================================================================
// WEB (extracted to web.js — BAT-196)
// ============================================================================

const {
    httpRequest,
} = require('./web');

// ============================================================================
// TELEGRAM (extracted to telegram.js — BAT-197)
// ============================================================================

const {
    telegram,
    MAX_FILE_SIZE, MAX_IMAGE_SIZE,
    extractMedia, downloadTelegramFile,
    sendMessage, sendTyping,
} = require('./telegram');

// Wire sendMessage into cron.js so reminders can be delivered via Telegram
setSendMessage(sendMessage);

// ============================================================================
// CLAUDE (extracted to claude.js — BAT-203)
// ============================================================================

const {
    chat,
    conversations, getConversation, addToConversation, clearConversation,
    sessionTracking,
    saveSessionSummary, MIN_MESSAGES_FOR_SUMMARY, IDLE_TIMEOUT_MS,
    writeAgentHealthFile, writeClaudeUsageState,
    setChatDeps,
} = require('./claude');

// ============================================================================
// TOOLS (extracted to tools.js — BAT-204)
// ============================================================================

const {
    TOOLS, executeTool,
    pendingConfirmations, lastToolUseTime,
    requestConfirmation,
    setMcpExecuteTool,
} = require('./tools');

// ============================================================================
// COMMAND HANDLERS
// ============================================================================

async function handleCommand(chatId, command, args) {
    switch (command) {
        case '/start': {
            // Templates defined in TEMPLATES.md — update there first, then sync here
            const bootstrap = loadBootstrap();
            const identity = loadIdentity();

            // Option B: If BOOTSTRAP.md exists, pass through to agent (ritual mode)
            if (bootstrap) {
                return null; // Falls through to agent call with ritual instructions in system prompt
            }

            // Post-ritual or fallback
            if (identity) {
                // Returning user (IDENTITY.md exists)
                const agentName = identity.split('\n')[0].replace(/^#\s*/, '').trim() || AGENT_NAME;
                return `Hey, I'm back! ✨

Quick commands if you need them:
/status · /new · /reset · /soul · /memory · /skills

Or just talk to me — that works too.`;
            } else {
                // First-time (no BOOTSTRAP.md, no IDENTITY.md — rare edge case)
                return `Hey there! 👋

I'm your new AI companion, fresh out of the box and running right here on your phone.

Before we get going, I'd love to figure out who I am — my name, my vibe, how I should talk to you. It only takes a minute.

Send me anything to get started!`;
            }
        }

        case '/help':
            return handleCommand(chatId, '/start', '');

        case '/status': {
            const uptime = Math.floor(process.uptime());
            const uptimeFormatted = `${Math.floor(uptime / 3600)}h ${Math.floor((uptime % 3600) / 60)}m ${uptime % 60}s`;

            // Get today's message count
            const today = new Date().toISOString().split('T')[0];
            const todayCount = sessionTracking.has(chatId) && sessionTracking.get(chatId).date === today
                ? sessionTracking.get(chatId).messageCount
                : 0;
            const totalCount = getConversation(chatId).length;

            // Get memory file count
            const memoryDir = MEMORY_DIR;
            let memoryFileCount = 0;
            try {
                if (fs.existsSync(memoryDir)) {
                    memoryFileCount = fs.readdirSync(memoryDir).filter(f => f.endsWith('.md')).length;
                }
            } catch (e) { /* ignore */ }

            return `🟢 Alive and kicking

⏱️ Uptime: ${uptimeFormatted}
💬 Messages: ${todayCount} today (${totalCount} total)
🧠 Memory: ${memoryFileCount} files
📊 Model: ${MODEL}

Last active: just now`;
        }

        case '/reset':
            clearConversation(chatId);
            sessionTracking.delete(chatId);
            return 'Conversation wiped. No backup saved.';

        case '/new': {
            // Save summary of current session before clearing (BAT-57)
            const conv = getConversation(chatId);
            const hadEnough = conv.length >= MIN_MESSAGES_FOR_SUMMARY;
            if (hadEnough) {
                await saveSessionSummary(chatId, 'manual', { force: true });
            }
            clearConversation(chatId);
            sessionTracking.delete(chatId);
            return 'Session archived. Conversation reset.';
        }

        case '/soul': {
            const soul = loadSoul();
            return `*SOUL.md*\n\n${soul.slice(0, 3000)}${soul.length > 3000 ? '\n\n...(truncated)' : ''}`;
        }

        case '/memory': {
            const memory = loadMemory();
            if (!memory) {
                return 'Long-term memory is empty.';
            }
            return `*MEMORY.md*\n\n${memory.slice(0, 3000)}${memory.length > 3000 ? '\n\n...(truncated)' : ''}`;
        }

        case '/skills': {
            const skills = loadSkills();
            if (skills.length === 0) {
                return `*No skills installed*

Skills are specialized capabilities you can add to your agent.

To add a skill, create a folder in:
\`workspace/skills/your-skill-name/SKILL.md\`

SKILL.md format:
\`\`\`
# Skill Name

Trigger: keyword1, keyword2

## Description
What this skill does

## Instructions
How to handle matching requests
\`\`\``;
            }

            let response = `*Installed Skills (${skills.length})*\n\n`;
            for (const skill of skills) {
                response += `**${skill.name}**\n`;
                response += `Triggers: ${skill.triggers.join(', ')}\n`;
                if (skill.description) {
                    response += `${skill.description.split('\n')[0]}\n`;
                }
                response += '\n';
            }
            return response;
        }

        default:
            return null; // Not a command
    }
}

// ============================================================================
// MESSAGE HANDLER
// ============================================================================

async function handleMessage(msg) {
    const chatId = msg.chat.id;
    const senderId = String(msg.from?.id);
    const rawText = (msg.text || msg.caption || '').trim();
    const media = extractMedia(msg);

    // Skip messages with no text AND no media
    if (!rawText && !media) return;

    // Extract quoted/replied message context (ported from OpenClaw)
    // Handles: direct replies, inline quotes, external replies (forwards/cross-group)
    let text = rawText;
    const reply = msg.reply_to_message;
    const externalReply = msg.external_reply;
    const quoteText = (msg.quote?.text ?? externalReply?.quote?.text ?? '').trim();
    const replyLike = reply ?? externalReply;

    if (quoteText) {
        // Inline quote or external reply quote
        const quotedFrom = reply?.from?.first_name || 'Someone';
        text = `[Replying to ${quotedFrom}: "${quoteText}"]\n\n${rawText}`;
    } else if (replyLike) {
        // Standard reply — extract body from reply/external_reply
        const replyBody = (replyLike.text ?? replyLike.caption ?? '').trim();
        if (replyBody) {
            const quotedFrom = reply?.from?.first_name || 'Someone';
            text = `[Replying to ${quotedFrom}: "${replyBody}"]\n\n${rawText}`;
        }
    }

    // Owner auto-detect: first person to message claims ownership
    if (!OWNER_ID) {
        OWNER_ID = senderId;
        setOwnerId(senderId); // sync to config.js for cross-module access
        log(`Owner claimed by ${senderId} (auto-detect)`, 'INFO');

        // Persist to Android encrypted storage via bridge
        androidBridgeCall('/config/save-owner', { ownerId: senderId }).catch(() => {});

        await sendMessage(chatId, `Owner set to your account (${senderId}). Only you can use this bot.`);
    }

    // Only respond to owner
    if (senderId !== OWNER_ID) {
        log(`Ignoring message from ${senderId} (not owner)`, 'WARN');
        return;
    }

    log(`Message: ${rawText ? rawText.slice(0, 100) + (rawText.length > 100 ? '...' : '') : '(no text)'}${media ? ` [${media.type}]` : ''}${msg.reply_to_message ? ' [reply]' : ''}`, 'DEBUG');

    try {
        // Check for commands (use rawText so /commands work even in replies)
        if (rawText.startsWith('/')) {
            const [command, ...argParts] = rawText.split(' ');
            const args = argParts.join(' ');
            const response = await handleCommand(chatId, command.toLowerCase(), args);
            if (response) {
                await sendMessage(chatId, response, msg.message_id);
                return;
            }
        }

        // Regular message - send to Claude (text includes quoted context if replying)
        await sendTyping(chatId);
        lastIncomingMessages.set(String(chatId), { messageId: msg.message_id, chatId });

        // Process media attachment if present
        let userContent = text || '';
        if (media) {
            // Sanitize user-controlled metadata before embedding in prompts
            const safeFileName = (media.file_name || 'file').replace(/[\r\n\0\u2028\u2029\[\]]/g, '_').slice(0, 120);
            const safeMimeType = (media.mime_type || 'application/octet-stream').replace(/[\r\n\0\u2028\u2029\[\]]/g, '_').slice(0, 60);
            try {
                if (!media.file_size) {
                    log(`Media file_size unknown (0) — size will be enforced during download`, 'DEBUG');
                }
                if (media.file_size && media.file_size > MAX_FILE_SIZE) {
                    const sizeMb = (media.file_size / 1024 / 1024).toFixed(1);
                    const maxMb = (MAX_FILE_SIZE / 1024 / 1024).toFixed(1);
                    await sendMessage(chatId, `📦 That file's too big (${sizeMb}MB, max ${maxMb}MB). Can you send a smaller one?`, msg.message_id);
                    const tooLargeNote = `[File attachment was rejected: too large (${sizeMb}MB).]`;
                    if (text) {
                        userContent = `${text}\n\n${tooLargeNote}`;
                    } else {
                        return;
                    }
                } else {
                    // Retry once for transient network errors
                    let saved;
                    const TRANSIENT_ERRORS = /timeout|timed out|aborted|ECONNRESET|ETIMEDOUT|Connection closed/i;
                    try {
                        saved = await downloadTelegramFile(media.file_id, media.file_name);
                    } catch (firstErr) {
                        if (TRANSIENT_ERRORS.test(firstErr.message)) {
                            log(`Media download failed (transient: ${firstErr.message}), retrying in 2s...`, 'WARN');
                            await new Promise(r => setTimeout(r, 2000));
                            saved = await downloadTelegramFile(media.file_id, media.file_name);
                        } else {
                            throw firstErr;
                        }
                    }
                    const relativePath = `media/inbound/${saved.localName}`;
                    const isImage = media.type === 'photo' || (media.mime_type && media.mime_type.startsWith('image/'));

                    // Claude vision-supported image formats
                    const VISION_MIMES = new Set(['image/jpeg', 'image/png', 'image/gif', 'image/webp']);

                    if (isImage && VISION_MIMES.has(media.mime_type) && saved.size <= MAX_IMAGE_SIZE) {
                        // Supported image within vision size limit: send as Claude vision content block
                        const imageData = await fs.promises.readFile(saved.localPath);
                        const base64 = imageData.toString('base64');
                        const caption = text || '';
                        // Align content block ordering with visionAnalyzeImage: [text, image]
                        userContent = [
                            { type: 'text', text: caption
                                ? `${caption}\n\n[Image saved to ${relativePath} (${saved.size} bytes)]`
                                : `[User sent an image — saved to ${relativePath} (${saved.size} bytes)]`
                            },
                            { type: 'image', source: { type: 'base64', media_type: media.mime_type, data: base64 } }
                        ];
                    } else if (isImage) {
                        // Image not usable for inline vision — save but don't base64-encode
                        const visionReason = !VISION_MIMES.has(media.mime_type)
                            ? 'unsupported format for inline vision'
                            : 'too large for inline vision';
                        const fileNote = `[Image received: ${safeFileName} (${saved.size} bytes, ${visionReason}) — saved to ${relativePath}. Use the read tool to access it.]`;
                        userContent = text ? `${text}\n\n${fileNote}` : fileNote;
                    } else {
                        // Non-image file: tell the agent where it's saved
                        const fileNote = `[File received: ${safeFileName} (${saved.size} bytes, ${safeMimeType}) — saved to ${relativePath}. Use the read tool to access it.]`;
                        userContent = text ? `${text}\n\n${fileNote}` : fileNote;
                    }
                    log(`Media processed: ${media.type} → ${relativePath}`, 'DEBUG');
                }
            } catch (e) {
                log(`Media download failed: ${e.message}`, 'ERROR');
                const reason = e.message || 'unknown error';
                const errorNote = `[File attachment could not be downloaded: ${reason}]`;
                userContent = text ? `${text}\n\n${errorNote}` : errorNote;
            }
        }

        let response = await chat(chatId, userContent);

        // Handle special tokens (OpenClaw-style)
        // SILENT_REPLY - discard the message
        if (response.trim() === 'SILENT_REPLY') {
            log('Agent returned SILENT_REPLY, not sending to Telegram', 'DEBUG');
            return;
        }

        // HEARTBEAT_OK - discard heartbeat acks (handled by watchdog)
        if (response.trim() === 'HEARTBEAT_OK' || response.trim().startsWith('HEARTBEAT_OK')) {
            log('Agent returned HEARTBEAT_OK', 'DEBUG');
            return;
        }

        // [[reply_to_current]] - quote reply to the current message
        let replyToId = null;
        if (response.startsWith('[[reply_to_current]]')) {
            response = response.replace('[[reply_to_current]]', '').trim();
            replyToId = msg.message_id;
        }

        await sendMessage(chatId, response, replyToId || msg.message_id);

        // Report message to Android for stats tracking
        androidBridgeCall('/stats/message').catch(() => {});

    } catch (error) {
        log(`Error: ${error.message}`, 'ERROR');
        await sendMessage(chatId, `Error: ${error.message}`, msg.message_id);
    }
}

// ============================================================================
// REACTION HANDLING
// ============================================================================

function handleReactionUpdate(reaction) {
    const chatId = reaction.chat?.id;
    if (!chatId) return; // Malformed update — no chat info

    const userId = String(reaction.user?.id || '');
    const msgId = reaction.message_id;
    // Sanitize untrusted userName to prevent prompt injection (strip control chars, markers)
    const rawName = reaction.user?.first_name || 'Someone';
    const userName = rawName.replace(/[\[\]\n\r\u2028\u2029]/g, '').slice(0, 50);

    // Filter by notification mode (skip all in "own" mode if owner not yet detected)
    if (REACTION_NOTIFICATIONS === 'own' && (!OWNER_ID || userId !== OWNER_ID)) return;

    // Extract the new emoji(s) — Telegram sends the full new reaction list
    const newEmojis = (reaction.new_reaction || [])
        .filter(r => r.type === 'emoji')
        .map(r => r.emoji);
    const oldEmojis = (reaction.old_reaction || [])
        .filter(r => r.type === 'emoji')
        .map(r => r.emoji);

    // Determine what was added vs removed
    const added = newEmojis.filter(e => !oldEmojis.includes(e));
    const removed = oldEmojis.filter(e => !newEmojis.includes(e));

    if (added.length === 0 && removed.length === 0) return;

    // Build event description
    const parts = [];
    if (added.length > 0) parts.push(`added ${added.join('')}`);
    if (removed.length > 0) parts.push(`removed ${removed.join('')}`);
    const eventText = `Telegram reaction ${parts.join(', ')} by ${userName} on message ${msgId}`;
    log(`Reaction: ${eventText}`, 'DEBUG');

    // Queue through chatQueues to avoid race conditions with concurrent message handling.
    // Use numeric chatId as key (same as enqueueMessage) so reactions serialize with messages.
    const prev = chatQueues.get(chatId) || Promise.resolve();
    const task = prev.then(() => {
        addToConversation(chatId, 'user', `[system event] ${eventText}`);
    }).catch(e => log(`Reaction queue error: ${e.message}`, 'ERROR'));
    chatQueues.set(chatId, task);
    task.then(() => { if (chatQueues.get(chatId) === task) chatQueues.delete(chatId); });
}

// ============================================================================
// POLLING LOOP
// ============================================================================

let offset = 0;
let pollErrors = 0;
// Track the last incoming user message per chat so the dynamic system prompt can
// provide the correct message_id/chat_id for the telegram_react tool.
const lastIncomingMessages = new Map(); // chatId -> { messageId, chatId }

// Ring buffer of messages sent by the bot (last 20 per chat, 24h TTL).
// Mirrors OpenClaw's sent-message-cache pattern — used so Claude can delete its own messages.
// sentMessageCache + recordSentMessage() extracted to telegram.js — BAT-197

// Per-chat message queue: prevents concurrent handleMessage() for the same chat
const chatQueues = new Map(); // chatId -> Promise chain

function enqueueMessage(msg) {
    const chatId = msg.chat.id;
    const prev = chatQueues.get(chatId) || Promise.resolve();
    const next = prev.then(() => handleMessage(msg)).catch(e =>
        log(`Message handler error: ${e.message}`, 'ERROR')
    );
    chatQueues.set(chatId, next);
    // Cleanup finished queues to prevent memory leak
    next.then(() => {
        if (chatQueues.get(chatId) === next) chatQueues.delete(chatId);
    });
}

async function poll() {
    while (true) {
        try {
            const result = await telegram('getUpdates', {
                offset: offset,
                timeout: 30,
                allowed_updates: REACTION_NOTIFICATIONS !== 'off'
                    ? ['message', 'message_reaction', 'callback_query'] : ['message', 'callback_query']
            });

            // Handle Telegram rate limiting (429)
            if (result && result.ok === false && result.parameters?.retry_after) {
                const retryAfter = result.parameters.retry_after;
                log(`Telegram rate limited — waiting ${retryAfter}s`, 'WARN');
                await new Promise(r => setTimeout(r, retryAfter * 1000));
                continue;
            }

            if (result.ok && result.result.length > 0) {
                for (const update of result.result) {
                    offset = update.update_id + 1;
                    if (update.message) {
                        // Intercept confirmation replies before normal message handling
                        const msgChatId = update.message.chat.id;
                        const pending = pendingConfirmations.get(msgChatId);
                        const msgText = (update.message.text || '').trim();
                        const isPlainText = msgText && !update.message.photo && !update.message.video
                            && !update.message.document && !update.message.sticker && !update.message.voice;
                        if (pending && isPlainText) {
                            // Only consume pure text messages as confirmation replies
                            // (photos with captions, stickers, etc. are enqueued normally)
                            const confirmed = msgText.toUpperCase() === 'YES';
                            log(`[Confirm] User replied "${msgText}" for ${pending.toolName} → ${confirmed ? 'APPROVED' : 'REJECTED'}`, 'INFO');
                            pending.resolve(confirmed);
                            pendingConfirmations.delete(msgChatId);
                        } else {
                            enqueueMessage(update.message);
                        }
                    }
                    if (update.callback_query) {
                        const cb = update.callback_query;
                        // Answer immediately to dismiss the loading spinner on the button
                        telegram('answerCallbackQuery', { callback_query_id: cb.id }).catch(e => {
                            log(`[Callback] answerCallbackQuery failed: ${e.message}`, 'WARN');
                        });
                        // Security: only process callbacks from owner (block if no owner set yet)
                        const cbSenderId = String(cb.from?.id);
                        if (!OWNER_ID || cbSenderId !== OWNER_ID) {
                            log(`[Callback] Ignoring callback from ${cbSenderId} (not owner)`, 'WARN');
                        } else {
                            // Sanitize callback data and original text (strip control chars, quotes)
                            const buttonData = (cb.data || '').replace(/[\r\n\t"\\]/g, ' ').trim();
                            const originalText = (cb.message?.text || '').replace(/[\r\n]/g, ' ').slice(0, 200).trim();
                            log(`[Callback] Button tapped: "${buttonData}" on message: "${originalText.slice(0, 60)}"`, 'DEBUG');
                            // Inject as a synthetic user message so the agent sees the button tap
                            const syntheticMsg = {
                                chat: cb.message?.chat || { id: cb.from.id },
                                from: cb.from,
                                text: `[Tapped button: "${buttonData}"] (on message: "${originalText}")`,
                            };
                            enqueueMessage(syntheticMsg);
                        }
                    }
                    if (update.message_reaction && REACTION_NOTIFICATIONS !== 'off') {
                        handleReactionUpdate(update.message_reaction);
                    }
                }
            }
            pollErrors = 0;
        } catch (error) {
            pollErrors++;
            log(`Poll error (${pollErrors}): ${error.message}`, 'ERROR');
            const delay = Math.min(1000 * Math.pow(2, pollErrors - 1), 30000);
            await new Promise(r => setTimeout(r, delay));
        }
    }
}

// ============================================================================
// CRON SERVICE STARTUP
// ============================================================================

// Start the cron service (loads persisted jobs, arms timers)
cronService.start();

// Refresh Jupiter program labels in background (non-blocking)
refreshJupiterProgramLabels();

// ============================================================================
// CLAUDE USAGE POLLING (setup_token users)
// ============================================================================

let _usagePollTimer = null;
let _usagePollFailCount = 0;
const USAGE_POLL_MAX_FAILURES = 3;

function startClaudeUsagePolling() {
    if (AUTH_TYPE !== 'setup_token') return;
    log('Starting Claude usage polling (60s interval)', 'DEBUG');
    pollClaudeUsage();
    _usagePollTimer = setInterval(pollClaudeUsage, 60000);
}

async function pollClaudeUsage() {
    try {
        const res = await httpRequest({
            hostname: 'api.anthropic.com',
            path: '/api/oauth/usage',
            method: 'GET',
            headers: {
                'Authorization': `Bearer ${ANTHROPIC_KEY}`,
                'anthropic-beta': 'oauth-2025-04-20',
            },
        });

        if (res.status === 200 && res.data) {
            _usagePollFailCount = 0;
            writeClaudeUsageState({
                type: 'oauth',
                five_hour: {
                    utilization: res.data.five_hour?.utilization || 0,
                    resets_at: res.data.five_hour?.resets_at || '',
                },
                seven_day: {
                    utilization: res.data.seven_day?.utilization || 0,
                    resets_at: res.data.seven_day?.resets_at || '',
                },
                updated_at: localTimestamp(),
            });
        } else {
            const isAuthError = res.status === 401 || res.status === 403;
            if (isAuthError) {
                _usagePollFailCount++;
            } else {
                _usagePollFailCount = 0;
            }
            if (isAuthError && _usagePollFailCount >= USAGE_POLL_MAX_FAILURES && _usagePollTimer) {
                clearInterval(_usagePollTimer);
                _usagePollTimer = null;
                log(`[Usage] Disabled — API returned ${res.status} (expected for setup tokens without usage scope)`, 'DEBUG');
            } else {
                log(`Claude usage poll: HTTP ${res.status}`, 'DEBUG');
            }
            writeClaudeUsageState({
                type: 'oauth',
                error: `HTTP ${res.status}`,
                updated_at: localTimestamp(),
            });
        }
    } catch (e) {
        log(`Claude usage poll error: ${e.message}`, 'ERROR');
    }
}

// Database functions (initDatabase, saveDatabase, indexMemoryFiles, gracefulShutdown,
// getDbSummary, writeDbSummaryFile, markDbSummaryDirty, startStatsServer, etc.)
// are now in database.js (BAT-202)

// ============================================================================
// STARTUP
// ============================================================================

log('Connecting to Telegram...', 'INFO');
telegram('getMe')
    .then(async result => {
        if (result.ok) {
            log(`Bot connected: @${result.result.username}`, 'DEBUG');

            // Condensed startup banner (Phase 4 — single INFO line replaces 10+ verbose startup lines)
            const _skillCount = loadSkills().length;
            const _cronCount = cronService.store?.jobs?.length || 0;
            log(`${AGENT_NAME} | ${MODEL} | @${result.result.username} | ${_skillCount} skills | ${MCP_SERVERS.length} MCP | ${_cronCount} cron`, 'INFO');

            // Initialize SQL.js database before polling (non-fatal if WASM fails)
            await initDatabase();
            indexMemoryFiles();

            // Wire shutdown deps now that conversations + saveSessionSummary exist
            setShutdownDeps({ conversations, saveSessionSummary, MIN_MESSAGES_FOR_SUMMARY });

            // Wire chat deps: inject main.js state into claude.js
            setChatDeps({
                executeTool,
                getTools: () => [...TOOLS, ...mcpManager.getAllTools()],
                getMcpStatus: () => mcpManager.getStatus(),
                requestConfirmation,
                lastToolUseTime,
                lastIncomingMessages,
            });

            // Wire MCP routing into tools.js
            setMcpExecuteTool((name, input) => mcpManager.executeTool(name, input));

            startDbSummaryInterval();
            startStatsServer();

            // Agent health heartbeat: write every 60s for staleness detection (BAT-134)
            setInterval(() => writeAgentHealthFile(), 60000);

            // Flush old updates to avoid re-processing messages after restart
            try {
                const flush = await telegram('getUpdates', { offset: -1, timeout: 0 });
                if (flush.ok && flush.result.length > 0) {
                    offset = flush.result[flush.result.length - 1].update_id + 1;
                    log(`Flushed ${flush.result.length} old update(s), offset now ${offset}`, 'DEBUG');
                }
            } catch (e) {
                log(`Warning: Could not flush old updates: ${e.message}`, 'WARN');
            }
            poll();
            startClaudeUsagePolling();

            // Initialize MCP servers in background (non-blocking, won't delay Telegram)
            if (MCP_SERVERS.length > 0) {
                mcpManager.initializeAll(MCP_SERVERS).then((mcpResults) => {
                    const ok = mcpResults.filter(r => r.status === 'connected');
                    const fail = mcpResults.filter(r => r.status === 'failed');
                    if (ok.length > 0) log(`[MCP] ${ok.length} server(s) connected, ${ok.reduce((s, r) => s + r.tools, 0)} tools available`, 'INFO');
                    if (fail.length > 0) log(`[MCP] ${fail.length} server(s) failed to connect`, 'WARN');
                }).catch((e) => {
                    log(`[MCP] Initialization error: ${e.message}`, 'ERROR');
                });
            }

            // Idle session summary timer (BAT-57) — check every 60s per-chatId
            setInterval(() => {
                const now = Date.now();
                sessionTracking.forEach((track, chatId) => {
                    if (track.lastMessageTime > 0 && now - track.lastMessageTime > IDLE_TIMEOUT_MS) {
                        track.lastMessageTime = 0; // Reset FIRST to prevent re-trigger on next tick
                        const conv = conversations.get(chatId);
                        if (conv && conv.length >= MIN_MESSAGES_FOR_SUMMARY) {
                            saveSessionSummary(chatId, 'idle').catch(e => log(`[SessionSummary] ${e.message}`, 'DEBUG'));
                        }
                    }
                });
            }, 60000);
        } else {
            log(`ERROR: ${JSON.stringify(result)}`, 'ERROR');
            process.exit(1);
        }
    })
    .catch(err => {
        log(`ERROR: ${err.message}`, 'ERROR');
        process.exit(1);
    });

// Heartbeat log
setInterval(() => {
    log(`Heartbeat - uptime: ${Math.floor(process.uptime())}s, memory: ${Math.round(process.memoryUsage().rss / 1024 / 1024)}MB`, 'DEBUG');
}, 5 * 60 * 1000);
