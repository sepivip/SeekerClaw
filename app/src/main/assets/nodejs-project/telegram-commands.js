// ============================================================================
// Telegram command registry — single source of truth for slash command
// discoverability. Consumed by:
//   - main.js setMyCommands (the BotFather-backed `/` autocomplete menu)
//   - message-handler.js /help and /commands response body
//
// A new command needs ONE entry here + a `case '/<name>':` branch in
// message-handler.js's handleCommand. Drift-guard in the test file
// verifies every registered command has a matching handler.
//
// Discovered in PR #339 (BAT-504): adding /model and /provider handlers
// without touching main.js's hardcoded setMyCommands list meant Telegram's
// `/` autocomplete never surfaced them. Consolidating the metadata here
// closes that 3-way drift (handler + menu + fallback menu + help text)
// with one canonical list.
// ============================================================================

'use strict';

// Order determines display order in `/` autocomplete AND the /help body.
// Freshest / most-used first.
//
// `fallback: true` means the command is included in the
// BOT_COMMANDS_TOO_MUCH fallback payload (degraded-mode essentials).
// Keep the fallback list short — it's there for when BotFather rejects
// the full set, which shouldn't happen in practice but defends us
// against Telegram-side quota changes.
const COMMAND_REGISTRY = [
    { name: 'quick',    description: 'One-tap preset actions',         fallback: true },
    { name: 'status',   description: 'Bot status, uptime, model',      fallback: true },
    { name: 'model',    description: 'Show or switch AI model',        fallback: true },
    { name: 'provider', description: 'Show or switch AI provider',     fallback: true },
    { name: 'new',      description: 'Archive session & start fresh',  fallback: true },
    { name: 'reset',    description: 'Wipe conversation (no backup)' },
    { name: 'resume',   description: 'Resume an interrupted task' },
    { name: 'skill',    description: 'List skills or run one by name', fallback: true },
    { name: 'soul',     description: 'View SOUL.md' },
    { name: 'memory',   description: 'View MEMORY.md' },
    { name: 'logs',     description: 'Last 10 log entries' },
    { name: 'version',  description: 'App & runtime versions' },
    { name: 'approve',  description: 'Confirm pending action' },
    { name: 'deny',     description: 'Reject pending action' },
    { name: 'help',     description: 'List all commands',              fallback: true },
    // /commands is an alias for /help (they stack on the same case block
    // in message-handler.js). Kept in the registry so Telegram's `/`
    // autocomplete surfaces it — some users type /commands instinctively.
    // Filtered out of buildHelpLines to avoid listing the same help entry
    // twice in the body.
    { name: 'commands', description: 'List all commands' },
];

// Map shape Telegram's setMyCommands expects.
function telegramCommandMenu() {
    return COMMAND_REGISTRY.map((c) => ({ command: c.name, description: c.description }));
}

// Degraded-mode payload for BOT_COMMANDS_TOO_MUCH fallback.
function telegramFallbackMenu() {
    return COMMAND_REGISTRY
        .filter((c) => c.fallback)
        .map((c) => ({ command: c.name, description: c.description }));
}

// Body lines for /help and /commands. Excludes both 'help' and
// 'commands' (the latter is just an alias stacked on the same case
// block — listing it alongside /help would be redundant). Format
// matches the existing /help style ("/cmd — description").
const _HELP_EXCLUDE = new Set(['help', 'commands']);
function buildHelpLines() {
    return COMMAND_REGISTRY
        .filter((c) => !_HELP_EXCLUDE.has(c.name))
        .map((c) => `/${c.name} — ${c.description}`);
}

module.exports = {
    COMMAND_REGISTRY,
    telegramCommandMenu,
    telegramFallbackMenu,
    buildHelpLines,
};
