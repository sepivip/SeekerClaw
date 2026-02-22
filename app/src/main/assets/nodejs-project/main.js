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
    workDir, config, debugLog,
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
    loadMemory, seedHeartbeatMd,
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
    createStatusReactionController,
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
    getActiveTask, clearActiveTask,
} = require('./claude');

const { loadCheckpoint, listCheckpoints, saveCheckpoint, deleteCheckpoint } = require('./task-store');

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
/status · /new · /reset · /skill · /logs · /help

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
        case '/commands': {
            const skillCount = loadSkills().length;
            return `**Commands**

/status — bot status, uptime, model
/new — archive session & start fresh
/reset — wipe conversation (no backup)
/resume — continue an interrupted task
/skill — list skills (or \`/skill name\` to run one)
/soul — view SOUL.md
/memory — view MEMORY.md
/logs — last 10 log entries
/version — app & runtime versions
/approve — confirm pending action
/deny — reject pending action

*${skillCount} skill${skillCount !== 1 ? 's' : ''} installed · /help to see this again*`;
        }

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

            const skillCount = loadSkills().length;
            const mem = process.memoryUsage();
            const heapMB = (mem.heapUsed / 1024 / 1024).toFixed(1);
            const rssMB = (mem.rss / 1024 / 1024).toFixed(1);

            return `🟢 **Alive and kicking**

⏱️ Uptime: ${uptimeFormatted}
💬 Messages: ${todayCount} today (${totalCount} in conversation)
🧠 Memory: ${memoryFileCount} files
📊 Model: \`${MODEL}\`
🧩 Skills: ${skillCount}
💾 RAM: ${heapMB} MB heap / ${rssMB} MB RSS`;
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

        case '/skill':
        case '/skills': {
            const skills = loadSkills();

            // /skill <name> — run a specific skill by injecting it into conversation
            if (args.trim()) {
                const query = args.trim().toLowerCase();
                const match = skills.find(s =>
                    s.name.toLowerCase() === query ||
                    s.name.toLowerCase().replace(/[^a-z0-9]/g, '') === query.replace(/[^a-z0-9]/g, '') ||
                    s.triggers.some(t => t.toLowerCase() === query)
                );
                if (!match) {
                    return `No skill matching \`${args.trim()}\`.\n\nUse /skill to list all installed skills.`;
                }
                if (match.triggers.length === 0) {
                    return `Skill **${match.name}** has no triggers defined and can't be run via /skill.\n\nAdd \`triggers:\` to its YAML frontmatter.`;
                }
                // Signal handleMessage to rewrite the text to a trigger word so
                // findMatchingSkills() in claude.js picks up the skill correctly.
                // (findMatchingSkills uses word-boundary regex on triggers, not skill names.)
                return { __skillFallthrough: true, trigger: match.triggers[0] };
            }

            // /skill or /skills with no args — list all
            if (skills.length === 0) {
                return `**No skills installed**

Skills are specialized capabilities you can add to your agent.

Create a Markdown file in the \`skills/\` directory:
• \`skills/your-skill-name/SKILL.md\`
• \`skills/your-skill-name.md\`

Use YAML frontmatter with \`name\`, \`description\`, and \`triggers\` fields.`;
            }

            let response = `**Installed Skills (${skills.length})**\n\n`;
            for (const skill of skills) {
                const emoji = skill.emoji || '🔧';
                response += `${emoji} **${skill.name}**`;
                if (skill.triggers.length > 0) {
                    response += ` — *${skill.triggers.slice(0, 3).join(', ')}*`;
                }
                response += '\n';
                if (skill.description) {
                    response += `${skill.description.split('\n')[0]}\n`;
                }
            }
            response += `\nRun a skill: \`/skill name\``;
            return response;
        }

        case '/version': {
            const nodeVer = process.version;
            const platform = `${process.platform}/${process.arch}`;
            // Determine agent version from config, env, or package.json (in priority order)
            let pkgVersion = 'unknown';
            if (config && config.version) {
                pkgVersion = config.version;
            } else if (process.env.AGENT_VERSION) {
                pkgVersion = process.env.AGENT_VERSION;
            } else {
                try {
                    const pkg = JSON.parse(fs.readFileSync(require('path').join(__dirname, 'package.json'), 'utf8'));
                    if (pkg.version) pkgVersion = pkg.version;
                } catch (_) {}
            }
            return `**SeekerClaw**
Agent: \`${AGENT_NAME}\`
Package: \`${pkgVersion}\`
Model: \`${MODEL}\`
Node.js: \`${nodeVer}\`
Platform: \`${platform}\``;
        }

        case '/logs': {
            // Read last 10 log entries from the debug log file (tail-read to avoid blocking)
            try {
                if (!fs.existsSync(debugLog)) {
                    return 'No log file found.';
                }
                const TAIL_BYTES = 8192;
                const stats = fs.statSync(debugLog);
                const start = Math.max(0, stats.size - TAIL_BYTES);
                let fd;
                let content;
                try {
                    fd = fs.openSync(debugLog, 'r');
                    const buf = Buffer.alloc(Math.min(stats.size, TAIL_BYTES));
                    fs.readSync(fd, buf, 0, buf.length, start);
                    content = buf.toString('utf8');
                } finally {
                    if (fd !== undefined) fs.closeSync(fd);
                }
                const lines = content.trim().split('\n').filter(l => l.trim());
                const last10 = lines.slice(-10);
                if (last10.length === 0) return 'Log file is empty.';
                const formatted = last10.map(line => {
                    // Lines are: LEVEL|message
                    const sep = line.indexOf('|');
                    if (sep === -1) return line;
                    const level = line.slice(0, sep);
                    const msg = redactSecrets(line.slice(sep + 1)).substring(0, 120);
                    const icon = level === 'ERROR' ? '🔴' : level === 'WARN' ? '🟡' : '⚪';
                    return `${icon} ${msg}`;
                }).join('\n');
                // Re-apply redaction in case early startup logs predate setRedactFn()
                return `**Last ${last10.length} log entries**\n\n\`\`\`\n${redactSecrets(formatted)}\n\`\`\``;
            } catch (e) {
                return `Failed to read logs: ${e.message}`;
            }
        }

        case '/approve': {
            const pending = pendingConfirmations.get(chatId);
            if (!pending) {
                return 'No pending confirmation to approve.';
            }
            log(`[Confirm] /approve command for ${pending.toolName} → APPROVED`, 'INFO');
            pending.resolve(true);
            pendingConfirmations.delete(chatId);
            return '✅ Approved.';
        }

        case '/deny': {
            const pending = pendingConfirmations.get(chatId);
            if (!pending) {
                return 'No pending confirmation to deny.';
            }
            log(`[Confirm] /deny command for ${pending.toolName} → REJECTED`, 'INFO');
            pending.resolve(false);
            pendingConfirmations.delete(chatId);
            return '❌ Denied.';
        }

        case '/resume': {
            // P2.4 + P2.2: Resume an interrupted task (in-memory or disk checkpoint)
            // IMPORTANT: Never delete the checkpoint here — let chat() clean up on
            // successful completion via cleanupChatCheckpoints(chatId).
            log(`[Resume] /resume invoked for chat ${chatId}`, 'INFO');

            // Path A: in-memory active task (same session, no crash)
            const task = getActiveTask(chatId);
            if (task) {
                log(`[Resume] PATH=memory taskId=${task.taskId} age=${Math.floor((Date.now() - task.startedAt) / 1000)}s reason=${task.reason}`, 'INFO');
                clearActiveTask(chatId);
                return { __resumeFallthrough: true };
            }
            log(`[Resume] No in-memory task, checking disk checkpoints...`, 'DEBUG');

            // Path B: disk checkpoint (post-restart recovery)
            const allCheckpoints = listCheckpoints();
            const checkpoints = allCheckpoints.filter(cp => String(cp.chatId) === String(chatId) && !cp.complete);
            log(`[Resume] Disk scan: ${allCheckpoints.length} total, ${checkpoints.length} matching chat ${chatId}`, 'INFO');

            if (checkpoints.length === 0) {
                log(`[Resume] PATH=none — no checkpoint found for chat ${chatId}`, 'INFO');
                return `No interrupted task to resume.\n\nThis can happen if:\n• The task completed normally\n• The checkpoint expired (>7 days old)`;
            }

            const cp = checkpoints[0]; // Most recent
            log(`[Resume] PATH=disk taskId=${cp.taskId} age=${Math.floor((Date.now() - (cp.updatedAt || cp.startedAt)) / 1000)}s reason=${cp.reason}`, 'INFO');

            const full = loadCheckpoint(cp.taskId);
            if (!full) {
                log(`[Resume] FAIL: loadCheckpoint returned null for taskId=${cp.taskId}`, 'ERROR');
                return `Found checkpoint for task ${cp.taskId} but it was corrupt. Please start the task again.`;
            }
            log(`[Resume] Loaded taskId=${cp.taskId}: conversationSlice=${Array.isArray(full.conversationSlice) ? full.conversationSlice.length : 'missing'} msgs, goal=${full.originalGoal ? '"' + full.originalGoal.slice(0, 60) + '"' : 'none'}`, 'INFO');

            // Restore conversation from checkpoint
            if (Array.isArray(full.conversationSlice) && full.conversationSlice.length > 0) {
                const conv = getConversation(chatId);
                let restored = full.conversationSlice;

                // Safety net: drop leading orphan tool_results that have no preceding
                // tool_use. These cause sanitizeConversation to strip them later,
                // destroying context. (saveCheckpoint should already clean these,
                // but older checkpoints may not have been cleaned.)
                while (restored.length > 0) {
                    const first = restored[0];
                    if (first.role === 'user' && Array.isArray(first.content)
                        && first.content.some(b => b.type === 'tool_result')) {
                        log(`[Resume] Dropped leading orphan tool_result from restored slice`, 'DEBUG');
                        restored = restored.slice(1);
                    } else {
                        break;
                    }
                }

                // Ensure the restored slice ends with an assistant message so that
                // chat() adding the resume instruction maintains valid role alternation.
                // If it ends with a user message (mid-loop crash), append a synthetic
                // assistant bridge message.
                const lastRestored = restored[restored.length - 1];
                if (lastRestored && lastRestored.role === 'user') {
                    restored.push({ role: 'assistant', content: 'I was interrupted mid-task. Ready to continue.' });
                    log(`[Resume] Appended bridge assistant message (last restored was user role)`, 'DEBUG');
                }

                // Splice into conversation (prepend for priority over any post-restart chat)
                conv.splice(0, 0, ...restored);
                log(`[Resume] OK: restored ${restored.length} messages into conversation (total: ${conv.length})`, 'INFO');
            } else {
                log(`[Resume] WARN: checkpoint ${cp.taskId} had empty conversation slice`, 'WARN');
            }

            // Checkpoint stays on disk — chat() will call cleanupChatCheckpoints()
            // on successful completion.
            return { __resumeFallthrough: true, originalGoal: full.originalGoal || null };
        }

        default:
            return null; // Not a command — falls through to agent
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

    // Status reactions — lifecycle emoji on the user's message (OpenClaw parity)
    const statusReaction = createStatusReactionController(chatId, msg.message_id);
    statusReaction.setQueued();

    try {
        // P2.4: resume flag — set by /resume handler, passed to chat() as option
        let isResume = false;
        let resumeGoal = null;

        // Check for commands (use rawText so /commands work even in replies)
        if (rawText.startsWith('/')) {
            const [commandToken, ...argParts] = rawText.split(' ');
            const args = argParts.join(' ');
            // Strip @botusername suffix for group chat compatibility (e.g. /status@MyBot → /status)
            const command = commandToken.toLowerCase().replace(/@\w+$/, '');
            const response = await handleCommand(chatId, command, args);
            if (response?.__skillFallthrough) {
                // /skill <name> matched — rewrite text to trigger word so
                // findMatchingSkills() picks up the skill via word-boundary match
                text = response.trigger;
            } else if (response?.__resumeFallthrough) {
                // P2.4: /resume matched — fall through to chat() with isResume flag.
                // The resume directive is injected into the system prompt by chat(),
                // not as a user message (system directives are authoritative).
                isResume = true;
                resumeGoal = response.originalGoal || null;
                text = 'continue';
            } else if (response) {
                await sendMessage(chatId, response, msg.message_id);
                await statusReaction.clear();
                return;
            }
        }

        // Regular message - send to Claude (text includes quoted context if replying)
        statusReaction.setThinking();
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
                        await statusReaction.clear();
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
                        // Auto-detect .md skill files: if it has YAML frontmatter, try to install directly
                        // Use original filename (before 120-char truncation) so long names like
                        // "my-very-long-skill-name.md" aren't missed when truncated to "...skill-name.m"
                        const isMdFile = (media.file_name || '').toLowerCase().endsWith('.md') || media.mime_type === 'text/markdown';
                        let skillAutoInstalled = false;
                        if (isMdFile) {
                            try {
                                const mdContent = fs.readFileSync(saved.localPath, 'utf8');
                                if (mdContent.startsWith('---')) {
                                    const installResult = await executeTool('skill_install', { content: mdContent }, chatId);
                                    if (installResult && installResult.result) {
                                        log(`Skill auto-installed from attachment: ${installResult.result}`, 'INFO');
                                        // Set flag BEFORE sendMessage so a Telegram error can't cause a fall-through to chat()
                                        skillAutoInstalled = true;
                                        await sendMessage(chatId, installResult.result, msg.message_id);
                                    } else if (installResult && installResult.error) {
                                        // Validation failed — tell user why (e.g. missing name, injection blocked)
                                        await sendMessage(chatId, `Skill install failed: ${installResult.error}`, msg.message_id);
                                        // Fall through to normal file note so the file is still accessible
                                    }
                                    // Non-skill or failed — fall through to normal file note
                                }
                            } catch (e) {
                                // sendMessage() logs internally and does not throw — only readFileSync / executeTool can throw here
                                log(`Skill auto-detect error: ${e.message}`, 'WARN');
                            }
                        }
                        // Routing is OUTSIDE the try so it always runs regardless of install errors
                        if (skillAutoInstalled) {
                            if (!text) {
                                await statusReaction.clear();
                                return; // No caption — nothing more to do
                            }
                            // Caption present — forward to Claude via normal chat flow
                            userContent = `[Skill just installed. User's message accompanying the file: ${text}]`;
                        } else {
                            // Non-image file: tell the agent where it's saved
                            const fileNote = `[File received: ${safeFileName} (${saved.size} bytes, ${safeMimeType}) — saved to ${relativePath}. Use the read tool to access it.]`;
                            userContent = text ? `${text}\n\n${fileNote}` : fileNote;
                        }
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

        let response = await chat(chatId, userContent, { isResume, originalGoal: resumeGoal, statusReaction });

        // Handle special tokens (OpenClaw-style)
        // SILENT_REPLY - discard the message
        if (response.trim() === 'SILENT_REPLY') {
            log('Agent returned SILENT_REPLY, not sending to Telegram', 'DEBUG');
            await statusReaction.clear();
            return;
        }

        // HEARTBEAT_OK - discard heartbeat acks (handled by watchdog)
        if (response.trim() === 'HEARTBEAT_OK' || response.trim().startsWith('HEARTBEAT_OK')) {
            log('Agent returned HEARTBEAT_OK', 'DEBUG');
            await statusReaction.clear();
            return;
        }

        // [[reply_to_current]] - quote reply to the current message
        let replyToId = null;
        if (response.startsWith('[[reply_to_current]]')) {
            response = response.replace('[[reply_to_current]]', '').trim();
            replyToId = msg.message_id;
        }

        await sendMessage(chatId, response, replyToId || msg.message_id);
        await statusReaction.setDone();

        // Report message to Android for stats tracking
        androidBridgeCall('/stats/message').catch(() => {});

    } catch (error) {
        log(`Error: ${error.message}`, 'ERROR');
        await statusReaction.setError();
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
                    if (response && response.trim() !== 'SILENT_REPLY'
                        && !response.trim().startsWith('HEARTBEAT_OK')) {
                        await sendMessage(chatId, response);
                    }
                } catch (e) {
                    log(`[AutoResume] chat() error: ${e.message}`, 'ERROR');
                    await sendMessage(chatId, `Auto-resume failed: ${e.message}`).catch(() => {});
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
            if (dnsFailCount > 0) {
                log(`[Network] Connection restored after ${dnsFailCount} DNS failure(s)`, 'INFO');
                dnsFailCount = 0;
                dnsWarnLogged = false;
            }
        } catch (error) {
            const isDns = error.code === 'ENOTFOUND' || error.code === 'EAI_AGAIN';
            if (isDns) {
                dnsFailCount++;
                pollErrors++;
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
                pollErrors++;
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

            // Wire MCP routing into tools.js
            setMcpExecuteTool((name, input) => mcpManager.executeTool(name, input));

            startDbSummaryInterval();
            startStatsServer();

            // Agent health heartbeat: write immediately on startup (prevents false "stale"
            // when Kotlin reads the old file before the first interval tick), then every 60s.
            writeAgentHealthFile();
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
            // Register slash commands with BotFather for Telegram autocomplete menu (BAT-211)
            telegram('setMyCommands', {
                commands: [
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
                else log(`setMyCommands failed: ${JSON.stringify(r)}`, 'WARN');
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

const HEARTBEAT_PROMPT =
    'Read HEARTBEAT.md if it exists. Follow it strictly. ' +
    'Do not infer or repeat old tasks from prior chats. ' +
    'If nothing needs attention, reply HEARTBEAT_OK.';
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

    // Queue through chatQueues to serialize with user messages.
    // This prevents concurrent conversation access if a user message
    // arrives while the probe is in flight (and vice versa).
    // Note: heartbeat probes add to conversation history by design —
    // the agent uses that context to avoid repeating prior actions.
    const prev = chatQueues.get(ownerChatId) || Promise.resolve();
    const task = prev.then(async () => {
        log('[Heartbeat] Running probe...', 'DEBUG');
        try {
            const response = await chat(ownerChatId, HEARTBEAT_PROMPT);
            const trimmed = response.trim();
            if (trimmed === 'HEARTBEAT_OK' || trimmed.startsWith('HEARTBEAT_OK')) {
                log('[Heartbeat] Agent returned HEARTBEAT_OK — all clear', 'DEBUG');
            } else if (trimmed !== 'SILENT_REPLY') {
                log('[Heartbeat] Agent has alert: ' + trimmed.slice(0, 80), 'INFO');
                await sendMessage(ownerChatId, trimmed);
            }
        } catch (e) {
            log(`[Heartbeat] Error: ${e.message}`, 'WARN');
        } finally {
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
