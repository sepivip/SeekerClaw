// SeekerClaw AI Agent
// Phase 2: Full Claude AI agent with tools, memory, and personality

const fs = require('fs');

// ============================================================================
// CONFIG (extracted to config.js — BAT-193)
// ============================================================================

const {
    ANTHROPIC_KEY, AUTH_TYPE, MODEL, AGENT_NAME, PROVIDER,
    MCP_SERVERS, REACTION_NOTIFICATIONS,
    MEMORY_DIR,
    localTimestamp, log, setRedactFn,
    getOwnerId, setOwnerId,
    workDir, config, debugLog,
} = require('./config');

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
    loadMemory, seedHeartbeatMd,
} = require('./memory');

// ============================================================================
// CRON (extracted to cron.js — BAT-200)
// ============================================================================

const {
    setSendMessage, setRunAgentTurn, cronService,
} = require('./cron');

// ============================================================================
// DATABASE (extracted to database.js — BAT-202)
// ============================================================================

const {
    setShutdownDeps,
    initDatabase, indexMemoryFiles, backfillSessionsFromFiles,
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
// QUICK ACTIONS (Telegram inline keyboard — #279)
// ============================================================================

const { handleQuickCommand, handleQuickCallback } = require('./quick-actions');

// ============================================================================
// WEB (extracted to web.js — BAT-196)
// ============================================================================

// web.js imports removed — httpRequest was only used by OAuth usage polling (now removed)

// ============================================================================
// TELEGRAM (extracted to telegram.js — BAT-197)
// ============================================================================

const {
    telegram,
    MAX_FILE_SIZE, MAX_IMAGE_SIZE,
    extractMedia, downloadTelegramFile,
    sendMessage, sendTyping,
    createStatusReactionController,
} = require('./telegram');

// Wire sendMessage into cron.js so reminders can be delivered via Telegram
setSendMessage(sendMessage);

// ============================================================================
// AI ENGINE (claude.js → ai.js — provider-agnostic rename)
// ============================================================================

const {
    chat,
    conversations, getConversation, addToConversation, clearConversation,
    sessionTracking,
    saveSessionSummary, MIN_MESSAGES_FOR_SUMMARY, IDLE_TIMEOUT_MS,
    writeAgentHealthFile,
    setChatDeps,
    getActiveTask, clearActiveTask,
} = require('./ai');

const { loadCheckpoint, listCheckpoints, saveCheckpoint, deleteCheckpoint, cleanupChatCheckpoints } = require('./task-store');

// ============================================================================
// TOOLS (extracted to tools.js — BAT-204)
// ============================================================================

const {
    TOOLS, executeTool,
    pendingConfirmations, lastToolUseTime,
    requestConfirmation,
    setMcpExecuteTool, setFullToolRegistry,
} = require('./tools');

// ============================================================================
// MESSAGE HANDLER (extracted to message-handler.js — #296)
// ============================================================================

const messageHandler = require('./message-handler');
const { handleCommand, handleMessage, handleReactionUpdate } = messageHandler;
const initMessageHandler = messageHandler.init;

// ============================================================================
// POLLING LOOP
// ============================================================================

let offset = 0;
let pollErrors = 0;
let dnsFailCount = 0;
let dnsWarnLogged = false;
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

// ============================================================================
// P2.4b: AUTO-RESUME — scan for fresh incomplete checkpoints on startup
// ============================================================================

const AUTO_RESUME_MAX_AGE_MS = 5 * 60 * 1000; // Only auto-resume checkpoints < 5 min old
const AUTO_RESUME_MAX_ATTEMPTS = 2;            // Give up after 2 auto-resume attempts

/**
 * Called once after poll() starts. Scans for incomplete checkpoints young enough
 * to auto-resume. Older checkpoints require manual /resume.
 */
async function autoResumeOnStartup() {
    try {
        const allCheckpoints = listCheckpoints();
        const incomplete = allCheckpoints.filter(cp => !cp.complete);
        if (incomplete.length === 0) {
            log(`[AutoResume] No incomplete checkpoints found`, 'DEBUG');
            return;
        }

        const now = Date.now();
        for (const cp of incomplete) {
            const age = now - (cp.updatedAt || cp.startedAt || 0);
            const ageStr = `${Math.floor(age / 1000)}s`;

            // Skip checkpoints that are too old
            if (age > AUTO_RESUME_MAX_AGE_MS) {
                log(`[AutoResume] SKIP taskId=${cp.taskId} age=${ageStr} (> ${AUTO_RESUME_MAX_AGE_MS / 1000}s, use /resume)`, 'DEBUG');
                continue;
            }

            // Load full checkpoint to check resumeAttempts
            const full = loadCheckpoint(cp.taskId);
            if (!full) {
                log(`[AutoResume] SKIP taskId=${cp.taskId} — corrupt checkpoint`, 'WARN');
                continue;
            }

            // Check resume attempt cap (prevent crash loops)
            const attempts = full.resumeAttempts || 0;
            if (attempts >= AUTO_RESUME_MAX_ATTEMPTS) {
                log(`[AutoResume] SKIP taskId=${cp.taskId} — ${attempts} prior attempts (max ${AUTO_RESUME_MAX_ATTEMPTS})`, 'WARN');
                // Notify user about the stuck task
                const chatId = full.chatId;
                if (chatId) {
                    sendMessage(chatId, `Task ${cp.taskId} failed after ${attempts} auto-resume attempts. Use /resume to try manually, or start the task again.`).catch(() => {});
                }
                continue;
            }

            const chatId = full.chatId;
            if (!chatId) {
                log(`[AutoResume] SKIP taskId=${cp.taskId} — no chatId in checkpoint`, 'WARN');
                continue;
            }

            // Increment resumeAttempts before attempting (survives crash during resume)
            // Placed after all skip checks so failed validations don't burn attempts.
            full.resumeAttempts = attempts + 1;
            saveCheckpoint(cp.taskId, full);

            const goalSnippet = full.originalGoal ? full.originalGoal.slice(0, 80) : null;
            log(`[AutoResume] RESUMING taskId=${cp.taskId} chatId=${chatId} age=${ageStr} attempt=${full.resumeAttempts}/${AUTO_RESUME_MAX_ATTEMPTS} goal=${goalSnippet ? '"' + goalSnippet + '"' : 'none'}`, 'INFO');

            // Restore conversation from checkpoint BEFORE notifying user
            // (prevents notification from interfering with conversation state)
            if (Array.isArray(full.conversationSlice) && full.conversationSlice.length > 0) {
                const conv = getConversation(chatId);
                let restored = full.conversationSlice;

                // Drop leading orphan tool_results
                while (restored.length > 0) {
                    const first = restored[0];
                    if (first.role === 'user' && Array.isArray(first.content)
                        && first.content.some(b => b.type === 'tool_result')) {
                        log(`[AutoResume] Dropped leading orphan tool_result`, 'DEBUG');
                        restored = restored.slice(1);
                    } else {
                        break;
                    }
                }

                // Ensure valid role alternation: last message must be assistant
                const lastRestored = restored[restored.length - 1];
                if (lastRestored && lastRestored.role === 'user') {
                    restored.push({ role: 'assistant', content: 'I was interrupted mid-task. Ready to continue.' });
                    log(`[AutoResume] Appended bridge assistant message`, 'DEBUG');
                }

                conv.splice(0, 0, ...restored);
                log(`[AutoResume] Restored ${restored.length} messages into conversation`, 'INFO');
            }

            // Notify user after conversation is restored
            const goalHint = goalSnippet ? `\n> ${goalSnippet}${full.originalGoal.length > 80 ? '...' : ''}` : '';
            await sendMessage(chatId, `Resuming interrupted task (${cp.taskId})...${goalHint}`);

            // Queue the resume through chatQueues to serialize with any incoming messages
            const prev = chatQueues.get(chatId) || Promise.resolve();
            const task = prev.then(async () => {
                try {
                    const response = await chat(chatId, 'continue', { isResume: true, originalGoal: full.originalGoal || null });
                    // Strip protocol tokens (BAT-279, OpenClaw parity 2026.3.1)
                    if (response && /\bSILENT_REPLY\b/i.test(response)) log('[Audit] AutoResume sent SILENT_REPLY', 'DEBUG');
                    const cleaned = response ? response.trim()
                        .replace(/(?:^|\s+|\*+)HEARTBEAT_OK\s*$/gi, '').replace(/\bHEARTBEAT_OK\b/gi, '')
                        .replace(/(?:^|\s+|\*+)SILENT_REPLY\s*$/gi, '').replace(/\bSILENT_REPLY\b/gi, '')
                        .trim() : '';
                    if (cleaned) {
                        await sendMessage(chatId, cleaned);
                    }
                } catch (e) {
                    log(`[AutoResume] chat() error: ${e.message}`, 'ERROR');
                    await sendMessage(chatId, `Auto-resume failed: ${redactSecrets(e.message)}`).catch(() => {});
                }
            });
            chatQueues.set(chatId, task);
            task.then(() => { if (chatQueues.get(chatId) === task) chatQueues.delete(chatId); });

            // Only resume one task per startup (conservative)
            break;
        }
    } catch (e) {
        log(`[AutoResume] Startup scan failed: ${e.message}`, 'ERROR');
    }
}

let _prolongedOutageLogged = false; // OpenClaw parity: log once per outage cycle

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
                            // Only explicit YES/NO or /approve//deny consume the confirmation.
                            // Other messages pass through to normal handling so random text
                            // doesn't accidentally reject a pending action (timeout handles ignore).
                            // Strip @botusername for group chat compatibility.
                            const normalized = msgText.toLowerCase().replace(/@\w+$/, '');
                            const upper = msgText.toUpperCase();
                            const isApprove = upper === 'YES' || normalized === '/approve';
                            const isDeny = upper === 'NO' || normalized === '/deny';
                            if (isApprove || isDeny) {
                                log(`[Confirm] User replied "${msgText}" for ${pending.toolName} → ${isApprove ? 'APPROVED' : 'REJECTED'}`, 'INFO');
                                pending.resolve(isApprove);
                                pendingConfirmations.delete(msgChatId);
                            } else {
                                // Don't enqueue other messages during pending confirmation
                                // to prevent overlapping tool calls from overwriting the entry
                                sendMessage(msgChatId, `⏳ Reply YES or NO (or /approve / /deny) to confirm ${pending.toolName} first.`).catch(() => {});
                            }
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
                        if (!getOwnerId() || cbSenderId !== getOwnerId()) {
                            log(`[Callback] Ignoring callback from ${cbSenderId} (not owner)`, 'WARN');
                        } else {
                            // Quick Actions: route quick:* callbacks through dedicated handler
                            const quickText = await handleQuickCallback(cb, telegram);
                            // Synthetic message base — include message_id so reactions
                            // target the original keyboard message (not undefined).
                            const cbChat = cb.message?.chat || { id: cb.from.id };
                            const cbMsgId = cb.message?.message_id;

                            if (quickText) {
                                const safeData = (cb.data || '').replace(/[\r\n\t"\\]/g, ' ').trim();
                                log(`[QuickAction] "${safeData}" → feeding mapped message`, 'DEBUG');
                                enqueueMessage({
                                    chat: cbChat, from: cb.from,
                                    message_id: cbMsgId,
                                    text: quickText,
                                });
                            } else {
                                // Generic callback: inject as synthetic user message
                                const buttonData = (cb.data || '').replace(/[\r\n\t"\\]/g, ' ').trim();
                                const originalText = (cb.message?.text || '').replace(/[\r\n]/g, ' ').slice(0, 200).trim();
                                log(`[Callback] Button tapped: "${buttonData}" on message: "${originalText.slice(0, 60)}"`, 'DEBUG');
                                enqueueMessage({
                                    chat: cbChat, from: cb.from,
                                    message_id: cbMsgId,
                                    text: `[Tapped button: "${buttonData}"] (on message: "${originalText}")`,
                                });
                            }
                        }
                    }
                    if (update.message_reaction && REACTION_NOTIFICATIONS !== 'off') {
                        handleReactionUpdate(update.message_reaction);
                    }
                }
            }
            // Only reset error counters on successful poll (OpenClaw parity:
            // non-OK responses like 401/409/5xx should NOT reset pollErrors)
            if (result && result.ok === true) {
                pollErrors = 0;
                _prolongedOutageLogged = false;
                if (dnsFailCount > 0) {
                    log(`[Network] Connection restored after ${dnsFailCount} DNS failure(s)`, 'INFO');
                    dnsFailCount = 0;
                    dnsWarnLogged = false;
                }
            } else if (result && result.ok === false) {
                pollErrors++;
                if (pollErrors >= 20 && !_prolongedOutageLogged) {
                    log('[Network] Prolonged outage — 20+ consecutive poll failures', 'ERROR');
                    _prolongedOutageLogged = true;
                }
                log(`[Telegram] getUpdates error: ${result.error_code} ${result.description || ''}`, 'WARN');
            }
        } catch (error) {
            // Check for timeout BEFORE incrementing pollErrors
            const isTimeout = /timeout|ETIMEDOUT|ESOCKETTIMEDOUT/i.test(error.message);
            const isDns = error.code === 'ENOTFOUND' || error.code === 'EAI_AGAIN';

            if (isTimeout && !isDns) {
                // Telegram long-polling timeouts are normal (~every 30s when idle)
                // Don't increment pollErrors, don't backoff, just reconnect
                log('Poll timeout — reconnecting', 'DEBUG');
                continue;
            }

            pollErrors++;
            if (pollErrors >= 20 && !_prolongedOutageLogged) {
                log('[Network] Prolonged outage — 20+ consecutive poll failures', 'ERROR');
                _prolongedOutageLogged = true;
            }

            if (isDns) {
                dnsFailCount++;
                // Single clear message after 3 consecutive DNS failures, then silence
                if (dnsFailCount === 3) {
                    log('[Network] DNS resolution failing — check internet connection', 'WARN');
                    dnsWarnLogged = true;
                }
                // Backoff: 2s, 4s, 8s, ... capped at 30s (skip the 1s first step for DNS)
                const delay = Math.min(2000 * Math.pow(2, Math.min(dnsFailCount, 5) - 1), 30000);
                await new Promise(r => setTimeout(r, delay));
            } else {
                if (dnsFailCount > 0) {
                    // Non-DNS error after DNS streak — network topology changed, log recovery
                    log(`[Network] DNS recovered after ${dnsFailCount} failures`, 'INFO');
                    dnsFailCount = 0;
                    dnsWarnLogged = false;
                }
                log(`Poll error (${pollErrors}): ${error.message}`, 'ERROR');
                const delay = Math.min(1000 * Math.pow(2, pollErrors - 1), 30000);
                await new Promise(r => setTimeout(r, delay));
            }
        }
    }
}

// ============================================================================
// CRON SERVICE STARTUP
// ============================================================================

// Wire cron agent turn runner BEFORE starting the service — a job due
// at startup could fire immediately, and needs the runner injected.
setRunAgentTurn(runCronAgentTurn);

// Start the cron service (loads persisted jobs, arms timers)
cronService.start();

// Refresh Jupiter program labels in background (non-blocking)
refreshJupiterProgramLabels();

// ============================================================================
// CLAUDE USAGE POLLING (OAuth users only)
// ============================================================================
// The /api/oauth/usage endpoint requires OAuth tokens — setup_token and api_key
// auth types don't have access, so polling is disabled for them. When/if OAuth
// support is added, re-enable by checking AUTH_TYPE === 'oauth'.

function startClaudeUsagePolling() {
    if (PROVIDER !== 'claude') return; // Only relevant for Anthropic API
    // OAuth usage endpoint not available for setup_token or api_key auth
    // API usage stats are tracked locally via SQL.js (session_status tool)
    log('[Usage] Skipped — OAuth usage polling not available for current auth type', 'DEBUG');
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
            log(`${AGENT_NAME} | ${PROVIDER}/${MODEL} | @${result.result.username} | ${_skillCount} skills | ${MCP_SERVERS.length} MCP | ${_cronCount} cron`, 'INFO');

            // Initialize SQL.js database before polling (non-fatal if WASM fails)
            await initDatabase();
            indexMemoryFiles();
            backfillSessionsFromFiles(); // BAT-322: one-time migration for existing users
            seedHeartbeatMd();

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

            // Wire message handler deps: inject all dependencies into message-handler.js
            initMessageHandler({
                AGENT_NAME, MODEL, MEMORY_DIR, REACTION_NOTIFICATIONS,
                log, debugLog,
                getOwnerId, setOwnerId,
                config,
                redactSecrets,
                telegram,
                sendMessage, sendTyping, downloadTelegramFile,
                extractMedia, createStatusReactionController,
                MAX_FILE_SIZE, MAX_IMAGE_SIZE,
                chat, getConversation, addToConversation, clearConversation,
                saveSessionSummary, MIN_MESSAGES_FOR_SUMMARY,
                getActiveTask, clearActiveTask,
                sessionTracking,
                executeTool, pendingConfirmations, lastToolUseTime,
                loadBootstrap, loadIdentity, loadSoul, loadMemory,
                loadSkills,
                loadCheckpoint, listCheckpoints,
                handleQuickCommand,
                androidBridgeCall,
                chatQueues, lastIncomingMessages,
            });

            // Wire MCP routing into tools.js
            setMcpExecuteTool((name, input) => mcpManager.executeTool(name, input));

            // DeerFlow P2: Wire full tool registry (static + MCP) for tool_search
            setFullToolRegistry(() => [...TOOLS, ...mcpManager.getAllTools()]);

            startDbSummaryInterval();
            startStatsServer();

            // Agent health heartbeat: write immediately on startup (prevents false "stale"
            // when Kotlin reads the old file before the first interval tick), then every 60s.
            writeAgentHealthFile();
            setInterval(() => writeAgentHealthFile(), 60000);

            // Flush old updates to avoid re-processing stale messages after restart,
            // and notify owner if any messages arrived while offline.
            try {
                const flush = await telegram('getUpdates', { offset: -1, timeout: 0 });
                if (flush.ok && flush.result.length > 0) {
                    offset = flush.result[flush.result.length - 1].update_id + 1;
                    log(`Flushed old update(s), offset now ${offset}`, 'DEBUG');
                    const ownerChat = parseInt(getOwnerId(), 10);
                    if (!isNaN(ownerChat)) {
                        telegram('sendMessage', {
                            chat_id: ownerChat,
                            text: 'Back online — resend anything important.',
                            disable_notification: true,
                        }).catch(e => log(`Back-online notify failed: ${e.message}`, 'WARN'));
                    }
                }
            } catch (e) {
                log(`Warning: Could not flush old updates: ${e.message}`, 'WARN');
            }
            // Register slash commands with BotFather for Telegram autocomplete menu (BAT-211)
            telegram('setMyCommands', {
                commands: [
                    { command: 'quick', description: 'One-tap preset actions' },
                    { command: 'status', description: 'Bot status, uptime, model' },
                    { command: 'new', description: 'Archive session & start fresh' },
                    { command: 'reset', description: 'Wipe conversation (no backup)' },
                    { command: 'skill', description: 'List skills or run one by name' },
                    { command: 'soul', description: 'View SOUL.md' },
                    { command: 'memory', description: 'View MEMORY.md' },
                    { command: 'logs', description: 'Last 10 log entries' },
                    { command: 'version', description: 'App & runtime versions' },
                    { command: 'resume', description: 'Resume an interrupted task' },
                    { command: 'approve', description: 'Confirm pending action' },
                    { command: 'deny', description: 'Reject pending action' },
                    { command: 'help', description: 'List all commands' },
                    { command: 'commands', description: 'List all commands' },
                ],
            }).then(r => {
                if (r.ok) log('Telegram command menu registered', 'DEBUG');
                else if (r.description && /too.?m(any|uch)|BOT_COMMANDS/i.test(r.description)) {
                    // OpenClaw parity: degrade on BOT_COMMANDS_TOO_MUCH
                    log('Too many bot commands, retrying with essentials only', 'WARN');
                    telegram('setMyCommands', { commands: [
                        { command: 'quick', description: 'Quick actions' },
                        { command: 'status', description: 'Bot status' },
                        { command: 'new', description: 'New session' },
                        { command: 'skill', description: 'Run a skill' },
                        { command: 'help', description: 'Help' },
                    ]}).catch(() => {});
                } else {
                    log(`setMyCommands failed: ${JSON.stringify(r)}`, 'WARN');
                }
            }).catch(e => log(`setMyCommands error: ${e.message}`, 'WARN'));

            poll();
            startClaudeUsagePolling();

            // P2.4b: Auto-resume fresh incomplete checkpoints after startup
            // Delayed 3s so poll() is active and can receive updates during resume
            setTimeout(() => autoResumeOnStartup(), 3000);

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

// Runtime status log (uptime/memory debug, every 5 min)
setInterval(() => {
    log(`[Runtime] uptime: ${Math.floor(process.uptime())}s, memory: ${Math.round(process.memoryUsage().rss / 1024 / 1024)}MB`, 'DEBUG');
}, 5 * 60 * 1000);

// ── Heartbeat Agent Timer ───────────────────────────────────────────────────
// On each tick, reads heartbeatIntervalMinutes from agent_settings.json (written
// by Android on every Settings save) so interval changes take effect without restart.
const path = require('path');

function getHeartbeatIntervalMs() {
    try {
        const settingsPath = path.join(workDir, 'agent_settings.json');
        if (fs.existsSync(settingsPath)) {
            const s = JSON.parse(fs.readFileSync(settingsPath, 'utf8'));
            const min = parseInt(s.heartbeatIntervalMinutes, 10);
            if (min >= 5 && min <= 120) return min * 60 * 1000;
        }
    } catch (_) {}
    return (config.heartbeatIntervalMinutes || 30) * 60 * 1000;
}

// ============================================================================
// CRON AGENT TURN (BAT-326)
// Runs a full AI turn for agentTurn cron jobs using an isolated session.
// Uses synthetic chatId ("cron:{jobId}") so it doesn't pollute user conversation
// and bypasses chatQueues (user messages are not queued behind cron turns).
// Note: cron turns still contend for the global apiCallInFlight mutex in claude.js,
// so they serialize at the API-call layer with user messages.
// ============================================================================

async function runCronAgentTurn(message, jobId) {
    const cronChatId = `cron:${jobId}`;

    // Clear any stale conversation from a prior run of the same job
    clearConversation(cronChatId);

    try {
        const prompt = `[cron:${jobId}] ${message}\n\nCurrent time: ${localTimestamp()}`;
        const response = await chat(cronChatId, prompt);

        // Strip protocol tokens (same pattern as heartbeat probe)
        const cleaned = response.trim()
            .replace(/(?:^|\s+|\*+)HEARTBEAT_OK\s*$/gi, '').replace(/\bHEARTBEAT_OK\b/gi, '')
            .replace(/(?:^|\s+|\*+)SILENT_REPLY\s*$/gi, '').replace(/\bSILENT_REPLY\b/gi, '')
            .trim();

        if (!cleaned) {
            log(`[Cron] Agent turn ${jobId} returned silent response`, 'DEBUG');
            return null;
        }

        return cleaned;
    } finally {
        // Always clean up the isolated session to prevent memory leaks.
        // conversations and sessionTracking are keyed by chatId — deleting
        // the synthetic key frees all state for this cron run.
        conversations.delete(cronChatId);
        sessionTracking.delete(cronChatId);
        clearActiveTask(cronChatId);
    }
}

// ============================================================================
// HEARTBEAT PROBE
// ============================================================================

// OpenClaw parity: short filler text alongside HEARTBEAT_OK is suppressed
// (e.g. "HEARTBEAT_OK. All systems normal." → treated as ack, not alert).
// Only text exceeding this threshold *when HEARTBEAT_OK is present* is treated
// as a real alert; non-empty messages without the token are always forwarded.
const HEARTBEAT_ACK_MAX_CHARS = 300;

const HEARTBEAT_PROMPT =
    'Read HEARTBEAT.md if it exists. Follow it strictly. ' +
    'Do not infer or repeat old tasks from prior chats. ' +
    'If nothing needs attention, reply ONLY the literal token HEARTBEAT_OK — ' +
    'no status summary, no explanation, just the token.';
const HEARTBEAT_CHAT_ID = '__heartbeat__';
let isHeartbeatInFlight = false;
// Initialize to Date.now() so the first probe waits the full configured interval
// rather than firing immediately on service start.
let lastHeartbeatAt = Date.now();

async function runHeartbeat() {
    const ownerIdStr = getOwnerId();
    if (!ownerIdStr) return; // agent not set up yet

    const ownerChatId = parseInt(ownerIdStr, 10);
    if (isNaN(ownerChatId)) return;

    // Prevent double-queuing if a heartbeat is already queued or running.
    if (isHeartbeatInFlight) {
        log('[Heartbeat] Skipping — heartbeat already queued or running', 'DEBUG');
        return;
    }

    isHeartbeatInFlight = true;
    log('[Heartbeat] Queueing probe...', 'DEBUG');

    // Queue through chatQueues on ownerChatId to serialize with user messages.
    // This prevents concurrent API calls if a user message arrives mid-heartbeat.
    // Uses a separate HEARTBEAT_CHAT_ID for conversation history so heartbeat
    // probe/response pairs don't pollute the user's conversation — fixing the
    // thread-breaking issue where heartbeats between a question and answer made
    // the agent lose context. Follows the same pattern as cron (cron:jobId).
    const prev = chatQueues.get(ownerChatId) || Promise.resolve();
    const task = prev.then(async () => {
        log('[Heartbeat] Running probe...', 'DEBUG');
        try {
            // Fresh conversation each probe — heartbeat is stateless by design
            // (reads HEARTBEAT.md for state, not conversation history)
            clearConversation(HEARTBEAT_CHAT_ID);

            const response = await chat(HEARTBEAT_CHAT_ID, HEARTBEAT_PROMPT);
            // Strip protocol tokens the agent may have mixed into content (OpenClaw parity 2026.3.1)
            if (/\bSILENT_REPLY\b/i.test(response)) log('[Audit] Heartbeat sent SILENT_REPLY', 'DEBUG');
            const hadToken = /\bHEARTBEAT_OK\b/i.test(response);
            const cleaned = response.trim()
                .replace(/(?:^|\s+|\*+)HEARTBEAT_OK\s*$/gi, '').replace(/\bHEARTBEAT_OK\b/gi, '')
                .replace(/(?:^|\s+|\*+)SILENT_REPLY\s*$/gi, '').replace(/\bSILENT_REPLY\b/gi, '')
                .trim();
            // OpenClaw parity: if the agent included HEARTBEAT_OK but also added
            // short filler text (≤HEARTBEAT_ACK_MAX_CHARS), treat it as an ack, not an alert.
            // This prevents verbose-but-harmless responses like
            // "HEARTBEAT_OK. All systems normal." from leaking to the user.
            const isAck = !cleaned || (hadToken && cleaned.length <= HEARTBEAT_ACK_MAX_CHARS);
            if (isAck) {
                log('[Heartbeat] All clear' + (cleaned ? ` (suppressed ${cleaned.length} chars of ack filler)` : ''), 'DEBUG');
            } else {
                log('[Heartbeat] Agent has alert: ' + cleaned.slice(0, 80), 'INFO');
                // Inject alert into user conversation so replies thread correctly.
                // The user sees this alert in Telegram and may reply to it — having
                // it in conversation history lets the agent connect the dots.
                addToConversation(ownerChatId, 'assistant', cleaned);
                await sendMessage(ownerChatId, cleaned);
            }
        } catch (e) {
            log(`[Heartbeat] Error: ${e.message}`, 'WARN');
        } finally {
            // Clean up heartbeat session state — prevent stale checkpoints from
            // triggering autoResumeOnStartup with a synthetic chatId (#298).
            clearConversation(HEARTBEAT_CHAT_ID);
            cleanupChatCheckpoints(HEARTBEAT_CHAT_ID);
            isHeartbeatInFlight = false;
            if (chatQueues.get(ownerChatId) === task) chatQueues.delete(ownerChatId);
        }
    });
    chatQueues.set(ownerChatId, task);
}

// Poll every 1 minute; fire when configured interval has elapsed.
// This allows interval changes in Settings to take effect on the next check cycle.
const _initIntervalMin = Math.round(getHeartbeatIntervalMs() / 60000);
log(`[Heartbeat] Interval set to ${_initIntervalMin}min (polled from agent_settings.json)`, 'INFO');
setInterval(async () => {
    const intervalMs = getHeartbeatIntervalMs();
    if (Date.now() - lastHeartbeatAt >= intervalMs) {
        lastHeartbeatAt = Date.now();
        await runHeartbeat();
    }
}, 60 * 1000);
