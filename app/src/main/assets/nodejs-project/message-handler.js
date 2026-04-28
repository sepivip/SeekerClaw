// message-handler.js — extracted from main.js (#296)
// Handles Telegram commands, messages, and reaction updates.
// Uses init() dependency injection — all external dependencies received via init(deps).

const fs = require('fs');
const path = require('path');
const { CHANNEL, workDir, PROVIDER, AUTH_TYPE, OPENAI_AUTH_TYPE, resolveActiveModel, runtimeState: _runtimeState, config: _config } = require('./config');
const { stripSilentReply, containsSilentReply } = require('./silent-reply');
const modelCatalog = require('./model-catalog');
const { buildHelpLines } = require('./telegram-commands');

let deps = {};
let initialized = false;

// Set when /provider triggers a service restart. Stays true for the ~2.5s
// window between bridge call and process death — during that window any
// interaction with /model or /provider would be unsafe:
//   - resolveActiveProviderState shows the overlay's NEW provider while the
//     running adapter is still the OLD one, so /model display is misleading
//     (Copilot round 12 concern #1).
//   - /model <id> writes overlay.model that'll be applied post-restart with
//     the NEW provider; user could accept a model valid for the OLD provider
//     but not the new one, corrupting post-restart state.
// Naturally reset on process death (new process, fresh flag).
let _restartPending = false;

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

async function handleCommand(chatId, command, args, messageId = null) {
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
            // Body lines come from the central registry in telegram-commands.js
            // so the same list drives setMyCommands + /help + drift-guard tests.
            const skillCount = deps.loadSkills().length;
            const body = buildHelpLines().join('\n');
            return `**Commands**\n\n${body}\n\n*${skillCount} skill${skillCount !== 1 ? 's' : ''} installed · /help to see this again*`;
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
📊 Model: \`${resolveActiveModel()}\`
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
Model: \`${resolveActiveModel()}\`
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

        case '/model': {
            return await handleModelCommand(chatId, args);
        }

        case '/provider': {
            return await handleProviderCommand(chatId, args, messageId);
        }

        default:
            return null; // Not a command — falls through to agent
    }
}

// ============================================================================
// AGENT_SETTINGS PATCHING — used by /model and /provider to persist
// TG-initiated changes. Node reads `model` live from this file on every
// chat() call (see ai.js activeModel resolver). On service restart,
// Kotlin's ConfigManager.loadConfig() reconciles these fields into
// SharedPreferences so they survive battery death / app kill.
// ============================================================================

function writeAgentSettingsPatch(patch) {
    const settingsPath = path.join(workDir, 'agent_settings.json');
    let current = {};
    try {
        if (fs.existsSync(settingsPath)) {
            const raw = fs.readFileSync(settingsPath, 'utf8');
            const parsed = JSON.parse(raw);
            if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
                current = parsed;
            }
        }
    } catch (e) {
        deps.log(`[AgentSettings] existing file unreadable (${e.message}) — starting from {}`, 'WARN');
        current = {};
    }
    // `undefined` means "remove this key" (for revert paths). Any other
    // value (including null, 0, '', false) is written as-is.
    const merged = { ...current };
    for (const [k, v] of Object.entries(patch)) {
        if (v === undefined) delete merged[k];
        else merged[k] = v;
    }
    const tmp = settingsPath + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(merged, null, 2), 'utf8');
    fs.renameSync(tmp, settingsPath);
}

// Fetch current credential presence from Kotlin via the bridge. Used by
// /provider credential gating so switching decisions reflect runtime
// SharedPreferences (updated on Settings saves + OAuth token saves)
// rather than the workspace/config.json snapshot Node loaded at startup.
// Without this, /provider openai oauth would reject immediately after a
// user completed OAuth sign-in (token in SharedPrefs but not yet in
// config.json — writeConfigJson only runs at service start).
// Kotlin returns placeholder strings for set fields and "" for unset, so
// modelCatalog.hasCredentialsFor's nonBlank() checks work unchanged.
// On bridge failure, falls back to the startup _config snapshot — degraded
// (same stale behavior as before) but keeps /provider functional.
async function fetchRuntimeCredentials() {
    try {
        const res = await deps.androidBridgeCall('/config/credentials', {}, 3000);
        if (res && res.ok && res.credentials && typeof res.credentials === 'object') {
            return res.credentials;
        }
        deps.log(`[/provider] bridge /config/credentials returned unexpected shape; using startup config`, 'WARN');
    } catch (e) {
        deps.log(`[/provider] bridge /config/credentials failed (${e && e.message}); using startup config`, 'WARN');
    }
    return _config;
}

// Resolve the currently-active provider/authType/model as seen by Node.
// Prefers agent_settings.json overrides (which reflect in-session TG
// changes) over the startup-loaded module consts from config.js. Model
// resolution delegates to config.resolveActiveModel() so this surface
// and ai.js / tools/session.js / /status / /version all agree.
function resolveActiveProviderState() {
    let overlay = {};
    try {
        const settingsPath = path.join(workDir, 'agent_settings.json');
        if (fs.existsSync(settingsPath)) {
            const parsed = JSON.parse(fs.readFileSync(settingsPath, 'utf8'));
            if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
                overlay = parsed;
            }
        }
    } catch (_) { overlay = {}; }

    const nonBlank = (v) => typeof v === 'string' && v.trim().length > 0;

    // Validate overlay values before adopting them. A partial/tampered
    // agent_settings.json could carry, say, (provider='openai',
    // authType='bogus') — without this guard, modelsForProvider() would
    // return [] and /model would treat OpenAI as "freeform" in its
    // no-args display, which is misleading. Fall through to the startup
    // consts when the overlay is invalid.
    const rawOverlayProvider = nonBlank(overlay.provider) ? overlay.provider.trim() : null;
    const overlayProviderValid = rawOverlayProvider && modelCatalog.KNOWN_PROVIDERS.includes(rawOverlayProvider);

    // Provider-scoping (mirrors resolveActiveModel in config.js): during
    // the /provider restart window, overlay carries the NEW provider but
    // the running adapter is still the OLD one. Returning the new
    // provider from here would make /model display/validate against a
    // provider we can't talk to yet. In practice /model and /provider
    // short-circuit on _restartPending so this path is rarely reached,
    // but keep the same-provider scoping for symmetry and defense in
    // depth (e.g. a stale overlay left behind by a crashed pre-restart
    // write).
    const provider = (overlayProviderValid && rawOverlayProvider === PROVIDER)
        ? rawOverlayProvider
        : PROVIDER;

    // authType is NOT live-pickup — OPENAI_AUTH_TYPE / AUTH_TYPE are
    // module-level consts in config.js, set once from config.json at
    // Node startup. The overlay in agent_settings.json carries the
    // user's INTENDED authType (what Kotlin's Settings UI saved), but
    // Kotlin's writeConfigJson can DOWNGRADE it before Node boots:
    // e.g. "oauth selected with a blank token" gets written to
    // config.json as authType=api_key so Node's strict validation
    // doesn't crash on startup. If we honored overlay.authType here,
    // /model would display + validate against the oauth allowlist
    // (includes gpt-5.4-mini) while Node is actually running api_key
    // mode (doesn't) — users could /model gpt-5.4-mini, see it
    // accepted, and then every chat request would 422.
    //
    // Return the runtime startupAuth instead. Matches what Node
    // actually sends to the provider API.
    const startupAuth = provider === 'openai' ? OPENAI_AUTH_TYPE : AUTH_TYPE;
    const authType = startupAuth;

    return { provider, authType, model: resolveActiveModel() };
}

// ============================================================================
// /model HANDLER
// Shows current model + options (no args), or switches to a new model
// within the current provider (with arg). Model is live-picked up on
// the next chat() call — no service restart.
// ============================================================================

async function handleModelCommand(chatId, args) {
    if (_restartPending) {
        return `⏳ Restart in progress — try again in a moment.`;
    }
    const state = resolveActiveProviderState();
    const trimmed = (args || '').trim();
    const models = modelCatalog.modelsForProvider(state.provider, state.authType);
    const isFreeform = models.length === 0;

    if (!trimmed) {
        // No args — show current + options
        const lines = [`**Current model:** \`${state.model}\``];
        lines.push(`Provider: \`${state.provider}\`${state.authType ? ` (${state.authType})` : ''}`);
        lines.push('');
        if (isFreeform) {
            lines.push(`\`${state.provider}\` accepts any model ID.`);
            lines.push(`Usage: \`/model <model-id>\``);
        } else {
            lines.push('**Options:**');
            models.forEach((m) => {
                const marker = m.id === state.model ? '  ← current' : '';
                lines.push(`• \`${m.id}\` — ${m.displayName}${marker}`);
            });
            lines.push('');
            lines.push('Usage: `/model <model-id>`');
        }
        return lines.join('\n');
    }

    const v = modelCatalog.validateModelForProvider(state.provider, state.authType, trimmed);
    if (!v.ok) {
        const optLine = (v.options && v.options.length)
            ? `\n\nOptions: ${v.options.map((o) => '`' + o + '`').join(', ')}`
            : '';
        return `❌ ${v.reason}${optLine}`;
    }

    try {
        writeAgentSettingsPatch({ model: v.model });
    } catch (e) {
        deps.log(`[/model] Failed to write agent_settings.json: ${e.message}`, 'ERROR');
        return `❌ Couldn't save — ${e.message}`;
    }
    // BAT-513: also persist to runtime_state.json so the main UI process
    // picks up the change via FileObserver and the prefs shadow stays
    // in sync for rollback. Write the full state (provider+authType+model)
    // because the BAT-513 file is a single object — leaving model out
    // of a /model write would mean the file's other fields could go
    // stale relative to the overlay. False return is logged but doesn't
    // block the success reply: the overlay write above is the primary
    // live-update mechanism (the per-turn ai.js resolver reads it),
    // so the UI/cross-process sync degrading to next-restart isn't a
    // correctness regression — just a UX one we surface as a warning.
    let runtimeOk = true;
    try {
        runtimeOk = _runtimeState.write({
            provider: state.provider,
            authType: state.authType,
            model: v.model,
        });
    } catch (e) {
        runtimeOk = false;
        deps.log(`[/model] runtime_state.json write threw: ${e.message}`, 'ERROR');
    }
    if (!runtimeOk) {
        deps.log(`[/model] runtime_state.json write returned false — UI may show stale model until a later write succeeds`, 'WARN');
    }
    deps.log(`[/model] Switched to ${v.model} (provider=${state.provider}, auth=${state.authType}, runtime_state_ok=${runtimeOk})`, 'INFO');
    // The agent_settings.json overlay was written successfully — the
    // model takes effect on the next message regardless of the
    // runtime_state.json failure (Node's per-turn resolveActiveModel
    // reads the overlay, not runtime_state.json). The UI is the
    // surface that observes runtime_state.json (via Kotlin's
    // FileObserver → RuntimeStateStore.state → Settings screen);
    // when our write to it fails, the UI keeps showing the previous
    // value. A service restart doesn't fix it — Node's
    // resolveActiveModel pulls from the overlay regardless, and
    // re-running this command WOULD fix it (retry the FS write).
    // Recovery is to retry /model later (or free up storage if the
    // FS write was rejected).
    const warningSuffix = runtimeOk
        ? ''
        : '\n⚠ App settings UI may show stale model until you /model again or free up storage.';
    return `✓ Switched to \`${v.model}\`. Takes effect on your next message.${warningSuffix}`;
}

// ============================================================================
// /provider HANDLER
// Shows current provider + options (no args), or switches to a new
// provider+auth (with args). Requires a service restart — provider
// adapter, endpoint, and auth headers are set at Node startup from
// module-level consts. Rejects if credentials aren't configured.
// ============================================================================

async function handleProviderCommand(chatId, args, messageId = null) {
    if (_restartPending) {
        return `⏳ Restart in progress — try again in a moment.`;
    }
    const state = resolveActiveProviderState();
    const parts = (args || '').trim().split(/\s+/).filter(Boolean);

    if (parts.length === 0) {
        const lines = [
            `**Current:** \`${state.provider}\`${state.authType ? ` (${state.authType})` : ''}`,
            `Model: \`${state.model}\``,
            '',
            '**Providers:**',
        ];
        modelCatalog.KNOWN_PROVIDERS.forEach((p) => {
            const auths = modelCatalog.authTypesForProvider(p);
            const authHint = auths.length > 1 ? ` (${auths.join(' | ')})` : '';
            const marker = p === state.provider ? '  ← current' : '';
            lines.push(`• \`${p}\`${authHint}${marker}`);
        });
        lines.push('');
        lines.push('Switch: `/provider <id>` or `/provider openai <api_key|oauth>`');
        lines.push('');
        lines.push('_Changing provider restarts the agent (~10s)._');
        return lines.join('\n');
    }

    const newProvider = parts[0].toLowerCase();
    if (!modelCatalog.KNOWN_PROVIDERS.includes(newProvider)) {
        return `❌ Unknown provider: \`${newProvider}\`\n\nOptions: ${modelCatalog.KNOWN_PROVIDERS.map((p) => '`' + p + '`').join(', ')}`;
    }

    // Fetch runtime credential state from Kotlin BEFORE gating decisions.
    // _config is the startup snapshot and misses anything saved since
    // (e.g. OAuth tokens completed mid-session). Fall back to _config on
    // bridge failure — degraded but /provider still works.
    const runtimeConfig = await fetchRuntimeCredentials();

    const authTypes = modelCatalog.authTypesForProvider(newProvider);
    let newAuthType;
    if (parts[1]) {
        newAuthType = parts[1].toLowerCase();
        if (!authTypes.includes(newAuthType)) {
            return `❌ Invalid auth type for ${newProvider}: \`${newAuthType}\`\n\nOptions: ${authTypes.map((a) => '`' + a + '`').join(', ')}`;
        }
    } else if (newProvider === state.provider && authTypes.includes(state.authType)) {
        // Same-provider re-select — keep current auth
        newAuthType = state.authType;
    } else {
        // Switching providers without explicit auth — pick the first authType
        // that actually has credentials configured. authTypes[0] alone would
        // wrongly reject users who only have the non-first option configured
        // (e.g. /provider openai for an OAuth-only user, or /provider claude
        // for a setup-token-only user — both get rejected by credential
        // gating below because the default api_key isn't set). If NONE of
        // the provider's auth modes have credentials, fall back to
        // authTypes[0] so the gating below rejects with a clear "no API key"
        // message rather than us picking silently.
        const credentialedAuth = authTypes.find((at) =>
            modelCatalog.hasCredentialsFor(runtimeConfig, newProvider, at).ok
        );
        newAuthType = credentialedAuth || authTypes[0];
    }

    // Credential gating: reject if the user hasn't configured this provider/auth yet.
    const cred = modelCatalog.hasCredentialsFor(runtimeConfig, newProvider, newAuthType);
    if (!cred.ok) {
        return `❌ ${cred.reason}`;
    }

    const newModel = modelCatalog.defaultModelForProvider(newProvider, newAuthType);

    // Write `model` only when the new provider has a concrete default
    // (claude/openai/openrouter). For freeform providers (custom) where
    // defaultModelForProvider returns '' there's no sensible default, so
    // we intentionally DON'T touch overlay.model — Kotlin's reconcile
    // validates the effective model (overlay or prefs) against the new
    // provider's allowlist and substitutes defaultModelForProvider if
    // invalid. This aligns with Kotlin's preserve-then-validate
    // semantics rather than diverging: clearing here would just leave
    // overlay blank while prefs still holds the old model, and Node
    // startup hard-exits on PROVIDER=custom + blank MODEL — so the
    // clear-path would crash the service if Kotlin's fallback ever
    // failed to write a non-blank model to prefs.
    // Guard: if switching to a provider whose default is blank (custom)
    // AND there's no currently-effective model to carry forward, the
    // post-restart Node would hard-exit at startup (config.js rejects
    // PROVIDER=custom + blank MODEL) — trapping the user with no
    // working agent to even run /model against. In any healthy setup
    // state.model is non-blank (Node's own startup rejected blank so
    // it must have had one), so this fires only for truly degenerate
    // configurations. Belt-and-suspenders, since the cost of hitting
    // it is a service crash-loop.
    if (newProvider === 'custom' && !newModel && !state.model) {
        return `❌ Cannot switch to \`custom\` — no model configured. Run \`/model <id>\` first, or set a model in Settings > AI Provider > Custom.`;
    }

    const settingsPatch = {
        provider: newProvider,
        authType: newAuthType,
    };
    if (newModel) {
        settingsPatch.model = newModel;
    }

    // Snapshot pre-patch values of the fields we're about to mutate, so if
    // the restart bridge call fails we can restore the overlay to what it
    // was — otherwise the process keeps running on the OLD adapter but with
    // overlay metadata suggesting the NEW one, leaving the app in a
    // confusing half-switched state. `undefined` in the revert patch
    // signals "this key was absent before — delete it" (see
    // writeAgentSettingsPatch).
    const prevOverlay = (() => {
        try {
            const settingsPath = path.join(workDir, 'agent_settings.json');
            if (fs.existsSync(settingsPath)) {
                const parsed = JSON.parse(fs.readFileSync(settingsPath, 'utf8'));
                if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
                    return parsed;
                }
            }
        } catch (_) {}
        return {};
    })();
    const revertPatch = {};
    for (const k of Object.keys(settingsPatch)) {
        revertPatch[k] = Object.prototype.hasOwnProperty.call(prevOverlay, k)
            ? prevOverlay[k]
            : undefined;
    }

    try {
        writeAgentSettingsPatch(settingsPatch);
    } catch (e) {
        deps.log(`[/provider] Failed to write agent_settings.json: ${e.message}`, 'ERROR');
        return `❌ Couldn't save — ${e.message}`;
    }

    // BAT-513: snapshot runtime_state.json BEFORE the write so a failed
    // restart later (bridge fail / sendMessage fail) can revert it
    // alongside the overlay revert. Without this, the overlay reverts
    // but runtime_state.json keeps the new (provider, authType, model)
    // — the main UI Settings screen would then show the NEW provider
    // while the running Node process is still on the OLD one, a
    // half-switched state worse than today's overlay-only revert.
    //
    // IMPORTANT: parse the file directly here instead of using
    // `_runtimeState.read()`. The store helper returns the seeded
    // DEFAULTS on missing/decode failure (correct for hot-read
    // paths) — but if we treat that as "the prior state" and then
    // write it back on revert, we'd be persisting DEFAULTS as if
    // they were the user's previous setting, masking a missing or
    // corrupt file with a fake history. By parsing raw, missing /
    // decode failure → `null` → revert path skips the runtime_state
    // write entirely (the file stays as it was before the /provider
    // attempt, which is the correct revert).
    //
    // ALSO validate the parsed object's shape and matrix BEFORE
    // accepting it as prevRuntimeState. A parseable-but-invalid
    // object (missing fields, or a (provider, authType) combo
    // outside the matrix) would otherwise become a truthy
    // `prevRuntimeState`; the revert path's `_runtimeState.write`
    // call would then throw on the matrix gate, the `.catch` would
    // log WARN, and runtime_state.json would stay STUCK on the new
    // (provider, authType, model) — exactly the half-switched
    // state this snapshot is supposed to prevent. Treat invalid
    // parsed content as "no valid prior file" → null → revert path
    // skips the write.
    // BAT-513 round-7: also track whether the file EXISTED before our
    // write. If the file didn't exist (e.g. first install where the
    // main UI process's RuntimeStateStore.init migration hasn't run
    // yet — the `:node` process has no way to gate on that), our own
    // `_runtimeState.write(...)` below CREATES the file. On a
    // restart-failure revert with `prevRuntimeState == null`, the
    // current code path skips the runtime-state write — but that
    // would leave the FILE WE JUST CREATED on disk advertising the
    // NEW provider, while the overlay reverts to the OLD one and
    // the running adapter stays on OLD. Same half-switched state
    // the snapshot is supposed to prevent.
    //
    // Fix: track `prevFileExisted` here, then on revert delete the
    // file we created when there was no valid prior state.
    const prevFileExisted = fs.existsSync(_runtimeState.filePath);
    const prevRuntimeState = (() => {
        try {
            if (!prevFileExisted) return null;
            const parsed = JSON.parse(fs.readFileSync(_runtimeState.filePath, 'utf8'));
            if (!parsed || typeof parsed !== 'object') return null;
            if (typeof parsed.provider !== 'string' || typeof parsed.authType !== 'string'
                || typeof parsed.model !== 'string') {
                return null;
            }
            if (!_runtimeState.validateMatrix(parsed.provider, parsed.authType)) {
                return null;
            }
            return parsed;
        } catch (_) {
            return null;
        }
    })();
    const runtimeStateModelToWrite = newModel || state.model;
    try {
        const ok = _runtimeState.write({
            provider: newProvider,
            authType: newAuthType,
            model: runtimeStateModelToWrite,
        });
        if (!ok) {
            try { writeAgentSettingsPatch(revertPatch); } catch (_) {}
            deps.log(`[/provider] runtime_state.json write returned false — reverting overlay, no restart`, 'ERROR');
            return `❌ Couldn't save provider/model. State unchanged.`;
        }
    } catch (e) {
        try { writeAgentSettingsPatch(revertPatch); } catch (_) {}
        deps.log(`[/provider] runtime_state.json write threw (${e.message}) — reverting overlay, no restart`, 'ERROR');
        return `❌ Couldn't save — ${e.message}. State unchanged.`;
    }

    deps.log(`[/provider] Switching to ${newProvider}/${newAuthType} (model=${newModel}); restart pending`, 'INFO');

    const displayProv = modelCatalog.displayNameForProvider(newProvider);
    const authSuffix = authTypes.length > 1 ? ` (${newAuthType})` : '';
    const modelLine = newModel ? `\nModel: \`${newModel}\`` : '';
    // When defaultModelForProvider returns '' (currently just custom),
    // we don't write overlay.model in the settingsPatch — Kotlin's
    // reconcile then preserves prefs.model (non-blank is "valid" for
    // freeform providers), so Node's post-restart MODEL is typically
    // a carry-over from the previous provider. That carry-over is
    // often WRONG for a custom endpoint (e.g. user was on OpenAI
    // gpt-5.5, switching to a local Ollama instance). Surface the
    // effective pre-switch model in the reply so the user can catch
    // mismatches before the first request fails. Only fall back to
    // the strong "After restart, set a model" hint in the rare case
    // where there's no model at all (unreachable in normal Setup flow,
    // but defensive).
    const modelHint = newModel
        ? ''
        : state.model
            ? `\nCurrent model: \`${state.model}\` — run \`/model <id>\` after restart if it's not valid for your custom endpoint.`
            : '\nAfter restart, set a model with `/model <id>`.';
    const reply = `✓ Switching to **${displayProv}**${authSuffix}.${modelLine}${modelHint}\n\nRestarting agent, back in ~10s…`;

    // Flip the restart-pending flag synchronously BEFORE the async cascade
    // so any /model or /provider command arriving after this point is
    // denied cleanly (see flag declaration for why).
    _restartPending = true;

    // Send the TG reply first, THEN trigger the Kotlin service to kill
    // itself (which Android will respawn with the new config). Doing this
    // after sendMessage resolves avoids losing the reply if the process
    // gets killed before Telegram acks. messageId threads the reply to
    // the originating /provider message for consistent UX with other
    // command responses (which get replyTo via deps.sendMessage(_, _, messageId)
    // in the handleMessage dispatcher).
    deps.sendMessage(chatId, reply, messageId).then(() => {
        deps.androidBridgeCall('/service/restart', {}, 5000).catch((err) => {
            _restartPending = false;
            deps.log(`[/provider] /service/restart bridge call failed: ${err && err.message}`, 'ERROR');
            // Revert BOTH the overlay AND runtime_state.json so the
            // process doesn't keep running with the OLD adapter while
            // either file's metadata advertises the NEW one. Without
            // this, `resolveActiveProviderState` (overlay) and the
            // main UI Settings screen (runtime_state.json) would each
            // diverge from the actually-active adapter and from each
            // other.
            try {
                writeAgentSettingsPatch(revertPatch);
            } catch (e) {
                deps.log(`[/provider] overlay revert failed (${e && e.message}); agent_settings.json may be half-switched`, 'WARN');
            }
            // BAT-513: also revert runtime_state.json so the UI shows
            // the OLD provider, matching the still-running adapter.
            // Three branches:
            //   - Valid prior state present → write it back
            //   - File didn't exist pre-write but we created it →
            //     unlink so the UI returns to "no file → fall back
            //     to config.json" (matches pre-/provider behaviour)
            //   - File existed but parsed as invalid → leave it; we
            //     can't restore content we never had. Logged so the
            //     half-switched state is visible.
            revertRuntimeStateFile();
            // Restart didn't fire — tell the user so they don't wait
            // forever for a restart that never happens.
            deps.sendMessage(
                chatId,
                `⚠️ Couldn't trigger the restart automatically. Please restart the SeekerClaw app manually and run \`/provider ${newProvider}\` again to finish switching.`,
                messageId,
            ).catch((e) => deps.log(`[/provider] restart-fallback sendMessage failed: ${e && e.message}`, 'WARN'));
        });
    }).catch((err) => {
        _restartPending = false;
        deps.log(`[/provider] sendMessage failed; skipping restart: ${err && err.message}`, 'ERROR');
        try {
            writeAgentSettingsPatch(revertPatch);
        } catch (e) {
            deps.log(`[/provider] overlay revert failed (${e && e.message})`, 'WARN');
        }
        revertRuntimeStateFile();
    });

    // BAT-513 round-7: shared revert helper for both restart-failure
    // callbacks above. Handles the three cases (valid prior state,
    // file-didnt-exist-pre-write, file-existed-but-invalid) so neither
    // callback leaves runtime_state.json advertising the NEW provider
    // when the running adapter has reverted to OLD.
    function revertRuntimeStateFile() {
        if (prevRuntimeState) {
            try { _runtimeState.write(prevRuntimeState); } catch (e) {
                deps.log(`[/provider] runtime_state revert failed (${e && e.message}); UI may show stale provider`, 'WARN');
            }
            return;
        }
        if (!prevFileExisted) {
            // We created the file in this /provider attempt. Delete
            // it so the UI's RuntimeStateStore re-emits the
            // last-valid value (the seed or whatever survived in
            // its StateFlow), and Node startup falls back to
            // config.json on next service start.
            try {
                if (fs.existsSync(_runtimeState.filePath)) {
                    fs.unlinkSync(_runtimeState.filePath);
                }
            } catch (e) {
                deps.log(`[/provider] runtime_state unlink failed (${e && e.message}); UI may show NEW provider while running on OLD`, 'WARN');
            }
            return;
        }
        // File existed pre-write but its content was invalid (parsed
        // as not-an-object, missing fields, or matrix violation). We
        // overwrote it with the new (valid) state; can't restore
        // invalid content. Log so the divergence is visible.
        deps.log(`[/provider] no valid prior runtime_state to restore — file kept as NEW; UI may show stale until next save`, 'WARN');
    }

    // We've handled the reply ourselves — tell the dispatcher not to send it again.
    return { __handled: true };
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

    // A service restart is imminent (/provider committed, AlarmManager
    // armed, process death in ~2s). Don't start a chat() turn we can't
    // finish — tool calls + API requests would get interrupted mid-
    // flight, potentially leaving the user with a half-written reply
    // or orphaned tool state. handleCommand paths already gate on
    // this via the per-command checks; this guard covers all the
    // non-command chat-triggering paths. Placed AFTER the owner gate
    // so non-owner users still get silently ignored during the
    // restart window (consistent with the rest of handleMessage).
    if (_restartPending) {
        await deps.sendMessage(chatId,
            `⏳ Restart in progress — try again in a moment.`,
            messageId,
        ).catch((e) => deps.log(`[restart] sendMessage during restart-pending failed: ${e && e.message}`, 'DEBUG'));
        return;
    }

    // Note: confirmation YES/NO interception is in enqueueMessage() (main.js),
    // not here — must happen BEFORE queuing to prevent deadlock.

    deps.log(`Message: ${combinedText ? combinedText.slice(0, 100) + (combinedText.length > 100 ? '...' : '') : '(no text)'}${media ? ` [${media.type}]` : ''}${replyTo ? ' [reply]' : ''}`, 'INFO');

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
            const response = await handleCommand(chatId, command, args, messageId);
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
