// message-handler.js — extracted from main.js (#296)
// Handles Telegram commands, messages, and reaction updates.
// Uses init() dependency injection — all external dependencies received via init(deps).

const fs = require('fs');
const { CHANNEL } = require('./config');
const { stripSilentReply, containsSilentReply } = require('./silent-reply');

let deps = {};
let initialized = false;

function init(d) {
    deps = d;
    initialized = true;
}

function assertInit() {
    if (!initialized) throw new Error('message-handler.js: init() must be called before use');
}

// ============================================================================
// COMMAND HANDLERS
// ============================================================================

async function handleCommand(chatId, command, args) {
    assertInit();
    switch (command) {
        case '/start': {
            // Templates defined in TEMPLATES.md — update there first, then sync here
            const bootstrap = deps.loadBootstrap();
            const identity = deps.loadIdentity();

            // Option B: If BOOTSTRAP.md exists, pass through to agent (ritual mode)
            if (bootstrap) {
                return null; // Falls through to agent call with ritual instructions in system prompt
            }

            // Post-ritual or fallback
            if (identity) {
                // Returning user (IDENTITY.md exists)
                return `Hey, I'm back! ✨

Quick commands if you need them:
/quick · /status · /new · /reset · /skill · /logs · /help

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
            const skillCount = deps.loadSkills().length;
            return `**Commands**

/quick — one-tap preset actions
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

        case '/quick': {
            if (CHANNEL === 'discord') {
                // Discord does not support Telegram inline keyboards — return a plain text menu
                return `**Quick Actions**\n\nType any of these to run:\n• Status check — battery, storage, uptime\n• Check my Solana portfolio\n• What's the current SOL price?\n• Today's top crypto/tech news\n• List my scheduled tasks\n• What do you remember about me?`;
            }
            await deps.handleQuickCommand(chatId, deps.telegram);
            return { __handled: true }; // Keyboard sent — stop processing
        }

        case '/status': {
            const uptime = Math.floor(process.uptime());
            const uptimeFormatted = `${Math.floor(uptime / 3600)}h ${Math.floor((uptime % 3600) / 60)}m ${uptime % 60}s`;

            // Get today's message count
            const today = new Date().toISOString().split('T')[0];
            const todayCount = deps.sessionTracking.has(chatId) && deps.sessionTracking.get(chatId).date === today
                ? deps.sessionTracking.get(chatId).messageCount
                : 0;
            const totalCount = deps.getConversation(chatId).length;

            // Get memory file count
            const memoryDir = deps.MEMORY_DIR;
            let memoryFileCount = 0;
            try {
                if (fs.existsSync(memoryDir)) {
                    memoryFileCount = fs.readdirSync(memoryDir).filter(f => f.endsWith('.md')).length;
                }
            } catch (e) { /* ignore */ }

            const skillCount = deps.loadSkills().length;
            const mem = process.memoryUsage();
            const heapMB = (mem.heapUsed / 1024 / 1024).toFixed(1);
            const rssMB = (mem.rss / 1024 / 1024).toFixed(1);

            return `🟢 **Alive and kicking**

⏱️ Uptime: ${uptimeFormatted}
💬 Messages: ${todayCount} today (${totalCount} in conversation)
🧠 Memory: ${memoryFileCount} files
📊 Model: \`${deps.MODEL}\`
🧩 Skills: ${skillCount}
💾 RAM: ${heapMB} MB heap / ${rssMB} MB RSS`;
        }

        case '/reset':
            deps.clearConversation(chatId);
            deps.sessionTracking.delete(chatId);
            return 'Conversation wiped. No backup saved.';

        case '/new': {
            // Save summary of current session before clearing (BAT-57)
            const conv = deps.getConversation(chatId);
            const hadEnough = conv.length >= deps.MIN_MESSAGES_FOR_SUMMARY;
            if (hadEnough) {
                await deps.saveSessionSummary(chatId, 'manual', { force: true });
            }
            deps.clearConversation(chatId);
            deps.sessionTracking.delete(chatId);
            return 'Session archived. Conversation reset.';
        }

        case '/soul': {
            const soul = deps.loadSoul();
            return `*SOUL.md*\n\n${soul.slice(0, 3000)}${soul.length > 3000 ? '\n\n...(truncated)' : ''}`;
        }

        case '/memory': {
            const memory = deps.loadMemory();
            if (!memory) {
                return 'Long-term memory is empty.';
            }
            return `*MEMORY.md*\n\n${memory.slice(0, 3000)}${memory.length > 3000 ? '\n\n...(truncated)' : ''}`;
        }

        case '/skill':
        case '/skills': {
            const skills = deps.loadSkills();

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
                // findMatchingSkills() in ai.js picks up the skill correctly.
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
            if (deps.config && deps.config.version) {
                pkgVersion = deps.config.version;
            } else if (process.env.AGENT_VERSION) {
                pkgVersion = process.env.AGENT_VERSION;
            } else {
                try {
                    const pkg = JSON.parse(fs.readFileSync(require('path').join(__dirname, 'package.json'), 'utf8'));
                    if (pkg.version) pkgVersion = pkg.version;
                } catch (_) {}
            }
            return `**SeekerClaw**
Agent: \`${deps.AGENT_NAME}\`
Package: \`${pkgVersion}\`
Model: \`${deps.MODEL}\`
Node.js: \`${nodeVer}\`
Platform: \`${platform}\``;
        }

        case '/logs': {
            // Read last 10 log entries from the debug log file (tail-read to avoid blocking)
            try {
                if (!fs.existsSync(deps.debugLog)) {
                    return 'No log file found.';
                }
                const TAIL_BYTES = 8192;
                const stats = fs.statSync(deps.debugLog);
                const start = Math.max(0, stats.size - TAIL_BYTES);
                let fd;
                let content;
                try {
                    fd = fs.openSync(deps.debugLog, 'r');
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
                    const msg = deps.redactSecrets(line.slice(sep + 1)).substring(0, 120);
                    const icon = level === 'ERROR' ? '🔴' : level === 'WARN' ? '🟡' : '⚪';
                    return `${icon} ${msg}`;
                }).join('\n');
                // Re-apply redaction in case early startup logs predate setRedactFn()
                return `**Last ${last10.length} log entries**\n\n\`\`\`\n${deps.redactSecrets(formatted)}\n\`\`\``;
            } catch (e) {
                return `Failed to read logs: ${e.message}`;
            }
        }

        case '/approve': {
            const pending = deps.pendingConfirmations.get(chatId);
            if (!pending) {
                return 'No pending confirmation to approve.';
            }
            deps.log(`[Confirm] /approve command for ${pending.toolName} → APPROVED`, 'INFO');
            pending.resolve(true);
            deps.pendingConfirmations.delete(chatId);
            return '✅ Approved.';
        }

        case '/deny': {
            const pending = deps.pendingConfirmations.get(chatId);
            if (!pending) {
                return 'No pending confirmation to deny.';
            }
            deps.log(`[Confirm] /deny command for ${pending.toolName} → REJECTED`, 'INFO');
            pending.resolve(false);
            deps.pendingConfirmations.delete(chatId);
            return '❌ Denied.';
        }

        case '/resume': {
            // P2.4 + P2.2: Resume an interrupted task (in-memory or disk checkpoint)
            // IMPORTANT: Never delete the checkpoint here — let chat() clean up on
            // successful completion via cleanupChatCheckpoints(chatId).
            deps.log(`[Resume] /resume invoked for chat ${chatId}`, 'INFO');

            // Path A: in-memory active task (same session, no crash)
            const task = deps.getActiveTask(chatId);
            if (task) {
                deps.log(`[Resume] PATH=memory taskId=${task.taskId} age=${Math.floor((Date.now() - task.startedAt) / 1000)}s reason=${task.reason}`, 'INFO');
                deps.clearActiveTask(chatId);
                return { __resumeFallthrough: true };
            }
            deps.log(`[Resume] No in-memory task, checking disk checkpoints...`, 'DEBUG');

            // Path B: disk checkpoint (post-restart recovery)
            const allCheckpoints = deps.listCheckpoints();
            const checkpoints = allCheckpoints.filter(cp => String(cp.chatId) === String(chatId) && !cp.complete);
            deps.log(`[Resume] Disk scan: ${allCheckpoints.length} total, ${checkpoints.length} matching chat ${chatId}`, 'INFO');

            if (checkpoints.length === 0) {
                deps.log(`[Resume] PATH=none — no checkpoint found for chat ${chatId}`, 'INFO');
                return `No interrupted task to resume.\n\nThis can happen if:\n• The task completed normally\n• The checkpoint expired (>7 days old)`;
            }

            const cp = checkpoints[0]; // Most recent
            deps.log(`[Resume] PATH=disk taskId=${cp.taskId} age=${Math.floor((Date.now() - (cp.updatedAt || cp.startedAt)) / 1000)}s reason=${cp.reason}`, 'INFO');

            const full = deps.loadCheckpoint(cp.taskId);
            if (!full) {
                deps.log(`[Resume] FAIL: loadCheckpoint returned null for taskId=${cp.taskId}`, 'ERROR');
                return `Found checkpoint for task ${cp.taskId} but it was corrupt. Please start the task again.`;
            }
            deps.log(`[Resume] Loaded taskId=${cp.taskId}: conversationSlice=${Array.isArray(full.conversationSlice) ? full.conversationSlice.length : 'missing'} msgs, goal=${full.originalGoal ? '"' + full.originalGoal.slice(0, 60) + '"' : 'none'}`, 'INFO');

            // Restore conversation from checkpoint
            if (Array.isArray(full.conversationSlice) && full.conversationSlice.length > 0) {
                const conv = deps.getConversation(chatId);
                let restored = full.conversationSlice;

                // Safety net: drop leading orphan tool_results that have no preceding
                // tool_use. These cause sanitizeConversation to strip them later,
                // destroying context. (saveCheckpoint should already clean these,
                // but older checkpoints may not have been cleaned.)
                while (restored.length > 0) {
                    const first = restored[0];
                    if (first.role === 'user' && Array.isArray(first.content)
                        && first.content.some(b => b.type === 'tool_result')) {
                        deps.log(`[Resume] Dropped leading orphan tool_result from restored slice`, 'DEBUG');
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
                    deps.log(`[Resume] Appended bridge assistant message (last restored was user role)`, 'DEBUG');
                }

                // Splice into conversation (prepend for priority over any post-restart chat)
                conv.splice(0, 0, ...restored);
                deps.log(`[Resume] OK: restored ${restored.length} messages into conversation (total: ${conv.length})`, 'INFO');
            } else {
                deps.log(`[Resume] WARN: checkpoint ${cp.taskId} had empty conversation slice`, 'WARN');
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

async function handleMessage(normalized) {
    assertInit();
    const { chatId, senderId, text: rawText, caption, messageId, media, replyTo, quoteText } = normalized;
    const combinedText = (rawText || caption || '').trim();
    if (!combinedText && !media) return;

    // Build text with reply context (channel-agnostic)
    let text = combinedText;
    if (quoteText) {
        const quotedFrom = replyTo?.authorName || 'Someone';
        text = `[Replying to ${quotedFrom}: "${quoteText}"]\n\n${combinedText}`;
    } else if (replyTo?.text) {
        const quotedFrom = replyTo.authorName || 'Someone';
        text = `[Replying to ${quotedFrom}: "${replyTo.text}"]\n\n${combinedText}`;
    }

    // Owner auto-detect: first person to message claims ownership
    if (!deps.getOwnerId()) {
        deps.setOwnerId(senderId);
        deps.log(`Owner claimed by ${senderId} (auto-detect)`, 'INFO');

        // Persist to Android encrypted storage via bridge (await so write completes before confirming)
        const { CHANNEL } = require('./config');
        const saveResult = await deps.androidBridgeCall('/config/save-owner', { ownerId: senderId, channel: CHANNEL });
        if (saveResult.error) {
            deps.log(`Bridge save-owner failed: ${saveResult.error}`, 'WARN');
            await deps.sendMessage(chatId, `Owner set to your account (${senderId}), but persistence failed — may reset on restart.`);
        } else {
            await deps.sendMessage(chatId, `Owner set to your account (${senderId}). Only you can use this bot.`);
        }
    }

    // Only respond to owner
    if (senderId !== deps.getOwnerId()) {
        deps.log(`Ignoring message from ${senderId} (not owner)`, 'WARN');
        return;
    }

    // Note: confirmation YES/NO interception is in enqueueMessage() (main.js),
    // not here — must happen BEFORE queuing to prevent deadlock.

    deps.log(`Message: ${combinedText ? combinedText.slice(0, 100) + (combinedText.length > 100 ? '...' : '') : '(no text)'}${media ? ` [${media.type}]` : ''}${replyTo ? ' [reply]' : ''}`, 'DEBUG');

    // Status reactions — lifecycle emoji on the user's message (OpenClaw parity)
    const statusReaction = deps.createStatusReactionController(chatId, messageId);
    statusReaction.setQueued();

    try {
        // P2.4: resume flag — set by /resume handler, passed to chat() as option
        let isResume = false;
        let resumeGoal = null;

        // Check for commands (use combinedText so /commands work even in replies)
        if (combinedText.startsWith('/')) {
            const [commandToken, ...argParts] = combinedText.split(' ');
            const args = argParts.join(' ');
            // Strip @botusername suffix for group chat compatibility (e.g. /status@MyBot → /status)
            const command = commandToken.toLowerCase().replace(/@\w+$/, '');
            const response = await handleCommand(chatId, command, args);
            if (response?.__handled) {
                // Command fully handled (e.g. /quick sent inline keyboard) — stop processing
                await statusReaction.clear();
                return;
            } else if (response?.__skillFallthrough) {
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
                await deps.sendMessage(chatId, response, messageId);
                await statusReaction.clear();
                return;
            }
        }

        // Regular message - send to AI (text includes quoted context if replying)
        statusReaction.setThinking();
        await deps.sendTyping(chatId);
        deps.lastIncomingMessages.set(String(chatId), { messageId, chatId });

        // Process media attachment if present
        let userContent = text || '';
        if (media) {
            // Sanitize user-controlled metadata before embedding in prompts
            const safeFileName = (media.file_name || 'file').replace(/[\r\n\0\u2028\u2029\[\]]/g, '_').slice(0, 120);
            const safeMimeType = (media.mime_type || 'application/octet-stream').replace(/[\r\n\0\u2028\u2029\[\]]/g, '_').slice(0, 60);
            try {
                if (!media.file_size) {
                    deps.log(`Media file_size unknown (0) — size will be enforced during download`, 'DEBUG');
                }
                if (media.file_size && media.file_size > deps.MAX_FILE_SIZE) {
                    const sizeMb = (media.file_size / 1024 / 1024).toFixed(1);
                    const maxMb = (deps.MAX_FILE_SIZE / 1024 / 1024).toFixed(1);
                    await deps.sendMessage(chatId, `📦 That file's too big (${sizeMb}MB, max ${maxMb}MB). Can you send a smaller one?`, messageId);
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
                    // Both downloadFileByUrl (telegram.js) and downloadTelegramFile (telegram.js)
                    // return the same shape: { localPath, localName, size }.
                    // downloadFileByUrl is used for Discord attachments (media.downloadMethod === 'url');
                    // downloadTelegramFile is used for Telegram file_id-based downloads.
                    const downloadFn = media.downloadMethod === 'url' && deps.downloadFileByUrl
                        ? () => deps.downloadFileByUrl(media.url, media.file_name)
                        : () => deps.downloadTelegramFile(media.file_id, media.file_name);
                    try {
                        saved = await downloadFn();
                    } catch (firstErr) {
                        if (TRANSIENT_ERRORS.test(firstErr.message)) {
                            deps.log(`Media download failed (transient: ${firstErr.message}), retrying in 2s...`, 'WARN');
                            await new Promise(r => setTimeout(r, 2000));
                            saved = await downloadFn();
                        } else {
                            throw firstErr;
                        }
                    }
                    const relativePath = `media/inbound/${saved.localName}`;
                    const isImage = media.type === 'photo' || (media.mime_type && media.mime_type.startsWith('image/'));

                    // Vision-supported image formats
                    const VISION_MIMES = new Set(['image/jpeg', 'image/png', 'image/gif', 'image/webp']);

                    // Detect actual MIME type from file magic bytes (Discord often misreports content_type)
                    let actualMime = media.mime_type;
                    if (isImage && saved.localPath) {
                        try {
                            const header = Buffer.alloc(8);
                            const fd = fs.openSync(saved.localPath, 'r');
                            fs.readSync(fd, header, 0, 8, 0);
                            fs.closeSync(fd);
                            if (header[0] === 0x89 && header[1] === 0x50 && header[2] === 0x4E && header[3] === 0x47) actualMime = 'image/png';
                            else if (header[0] === 0xFF && header[1] === 0xD8) actualMime = 'image/jpeg';
                            else if (header[0] === 0x47 && header[1] === 0x49 && header[2] === 0x46) actualMime = 'image/gif';
                            else if (header[0] === 0x52 && header[1] === 0x49 && header[2] === 0x46 && header[3] === 0x46) actualMime = 'image/webp';
                        } catch (_) { /* keep reported mime */ }
                    }

                    if (isImage && VISION_MIMES.has(actualMime) && saved.size <= deps.MAX_IMAGE_SIZE) {
                        // Supported image within vision size limit: send as Claude vision content block (base64)
                        const imageData = await fs.promises.readFile(saved.localPath);
                        const base64 = imageData.toString('base64');
                        const caption = text || '';
                        userContent = [
                            { type: 'text', text: caption
                                ? `${caption}\n\n[Image saved to ${relativePath} (${saved.size} bytes)]`
                                : `[User sent an image — saved to ${relativePath} (${saved.size} bytes)]`
                            },
                            { type: 'image', source: { type: 'base64', media_type: actualMime, data: base64 } }
                        ];
                    } else if (isImage && VISION_MIMES.has(actualMime) && media.url) {
                        // Image too large for base64 but has a URL (Discord) — use URL source
                        const caption = text || '';
                        userContent = [
                            { type: 'text', text: caption
                                ? `${caption}\n\n[Image saved to ${relativePath} (${saved.size} bytes)]`
                                : `[User sent an image — saved to ${relativePath} (${saved.size} bytes)]`
                            },
                            { type: 'image', source: { type: 'url', url: media.url } }
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
                                    const installResult = await deps.executeTool('skill_install', { content: mdContent }, chatId);
                                    if (installResult && installResult.result) {
                                        deps.log(`Skill auto-installed from attachment: ${installResult.result}`, 'INFO');
                                        // Set flag BEFORE sendMessage so a Telegram error can't cause a fall-through to chat()
                                        skillAutoInstalled = true;
                                        await deps.sendMessage(chatId, installResult.result, messageId);
                                    } else if (installResult && installResult.error) {
                                        // Validation failed — tell user why (e.g. missing name, injection blocked)
                                        await deps.sendMessage(chatId, `Skill install failed: ${deps.redactSecrets(installResult.error)}`, messageId);
                                        // Fall through to normal file note so the file is still accessible
                                    }
                                    // Non-skill or failed — fall through to normal file note
                                }
                            } catch (e) {
                                // sendMessage() logs internally and does not throw — only readFileSync / executeTool can throw here
                                deps.log(`Skill auto-detect error: ${e.message}`, 'WARN');
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
                    deps.log(`Media processed: ${media.type} → ${relativePath}`, 'DEBUG');
                }
            } catch (e) {
                deps.log(`Media download failed: ${e.message}`, 'ERROR');
                const reason = e.message || 'unknown error';
                const errorNote = `[File attachment could not be downloaded: ${reason}]`;
                userContent = text ? `${text}\n\n${errorNote}` : errorNote;
            }
        }

        let response = await deps.chat(chatId, userContent, { isResume, originalGoal: resumeGoal, statusReaction });

        // Strip protocol tokens the agent may have mixed into content (BAT-279)
        // Uses centralized silent-reply.js helper (BAT-488) that also handles
        // leading-attached cases like "SILENT_REPLYhello" + JSON envelope form.
        if (containsSilentReply(response)) deps.log('[Audit] Agent sent SILENT_REPLY', 'DEBUG');
        response = stripSilentReply(
            response.trim()
                .replace(/(?:^|\s+|\*+)HEARTBEAT_OK\s*$/gi, '').replace(/\bHEARTBEAT_OK\b/gi, '')
        );
        if (!response) {
            deps.log('Agent returned protocol-token-only response, discarding', 'DEBUG');
            await statusReaction.clear();
            return;
        }

        // [[reply_to_current]] - quote reply to the current message
        let replyToId = null;
        if (response.startsWith('[[reply_to_current]]')) {
            response = response.replace('[[reply_to_current]]', '').trim();
            replyToId = messageId;
        }

        await deps.sendMessage(chatId, response, replyToId || messageId);
        await statusReaction.setDone();

        // Report message to Android for stats tracking
        deps.androidBridgeCall('/stats/message').catch(() => {});

    } catch (error) {
        deps.log(`Error: ${error.message}`, 'ERROR');
        await statusReaction.setError();
        await deps.sendMessage(chatId, `Error: ${deps.redactSecrets(error.message)}`, messageId);
    }
}

// ============================================================================
// REACTION HANDLING
// ============================================================================

function handleReactionUpdate(reaction) {
    assertInit();
    const chatId = reaction.chat?.id;
    if (!chatId) return; // Malformed update — no chat info

    const userId = String(reaction.user?.id || '');
    const msgId = reaction.message_id;
    // Sanitize untrusted userName to prevent prompt injection (strip control chars, markers)
    const rawName = reaction.user?.first_name || 'Someone';
    const userName = rawName.replace(/[\[\]\n\r\u2028\u2029]/g, '').slice(0, 50);

    // Filter by notification mode (skip all in "own" mode if owner not yet detected)
    if (deps.REACTION_NOTIFICATIONS === 'own' && (!deps.getOwnerId() || userId !== deps.getOwnerId())) return;

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
    deps.log(`Reaction: ${eventText}`, 'DEBUG');

    // Queue through chatQueues to avoid race conditions with concurrent message handling.
    // Use numeric chatId as key (same as enqueueMessage) so reactions serialize with messages.
    const prev = deps.chatQueues.get(chatId) || Promise.resolve();
    const task = prev.then(() => {
        deps.addToConversation(chatId, 'user', `[system event] ${eventText}`);
    }).catch(e => deps.log(`Reaction queue error: ${e.message}`, 'ERROR'));
    deps.chatQueues.set(chatId, task);
    task.then(() => { if (deps.chatQueues.get(chatId) === task) deps.chatQueues.delete(chatId); });
}

module.exports = { init, handleCommand, handleMessage, handleReactionUpdate };
