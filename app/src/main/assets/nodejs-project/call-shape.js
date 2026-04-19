// call-shape.js — structural classifier per tool for tool_call_log.
// Pure functions. Never stores sensitive data. Max 64 chars per shape.
//
// Each builder receives the tool's args and returns a short string that
// captures the *class* of the call (e.g. "web_fetch:api.anthropic.com:POST")
// without any user-specific values.

const KNOWN_MINTS = {
    'So11111111111111111111111111111111111111112': 'SOL',
    'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v': 'USDC',
    'Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB': 'USDT',
    'DezXAZ8z7PnrnRJjz3wXBoRgixCa6xjnB7YaB1pPB263': 'BONK',
};
function mintLabel(mint) {
    if (!mint) return 'unknown';
    return KNOWN_MINTS[mint] || 'other';
}

function hostOf(url) {
    if (!url || typeof url !== 'string') return 'unknown';
    try {
        const u = new URL(url);
        return u.hostname;
    } catch (_) {
        return 'malformed';
    }
}

function pathPattern(p) {
    if (!p || typeof p !== 'string') return 'unknown';
    // Normalize: strip leading './', collapse repeated slashes.
    p = p.replace(/^\.\//, '').replace(/\/+/g, '/');
    // Known workspace buckets.
    if (/^memory\/\d{4}-\d{2}-\d{2}\.md$/.test(p)) return 'memory/*.md';
    if (/^memory\//.test(p)) return 'memory/*';
    if (/^skills\/[^/]+\.md$/.test(p)) return 'skills/*.md';
    if (/^skills\//.test(p)) return 'skills/*';
    if (/^workspace\/school\//.test(p)) return 'workspace/school/*';
    // Root-level workspace identity/memory files — known allowlist only, exposed as-is.
    if (/^(SOUL|MEMORY|IDENTITY|USER|HEARTBEAT)\.md$/.test(p)) return p;
    // Everything else — collapse to a generic bucket with depth hint, never exposing segments.
    const depth = p.split('/').length;
    return `other:depth${depth}`;
}

const builders = {
    web_fetch: (args) => `web_fetch:${hostOf(args.url)}:${(args.method || 'GET').toUpperCase()}`,
    web_search: (args) => `web_search:${args.provider || 'default'}`,
    solana_swap: (args) => `solana_swap:${mintLabel(args.inputMint)}:${mintLabel(args.outputMint)}`,
    solana_balance: (args) => args && args.address ? 'solana_balance:other' : 'solana_balance:self',
    solana_send: (args) => `solana_send:${mintLabel(args && args.mint)}`,
    solana_price: (args) => `solana_price:${mintLabel(args && args.mint)}`,
    file_read: (args) => `file_read:${pathPattern(args && args.path)}`,
    file_write: (args) => `file_write:${pathPattern(args && args.path)}`,
    file_edit: (args) => `file_edit:${pathPattern(args && args.path)}`,
    file_delete: (args) => `file_delete:${pathPattern(args && args.path)}`,
    shell_exec: (args) => {
        const cmd = (args && args.cmd) || '';
        const first = cmd.trim().split(/\s+/)[0] || 'empty';
        // If the first token is a path (./foo, /usr/bin/foo, ../foo) or contains
        // any filesystem separators, collapse to 'other' to avoid leaking filenames.
        // Only bare command names (ls, cat, curl, etc.) are exposed.
        if (first === 'empty') return 'shell_exec:empty';
        if (/[\/\\]/.test(first) || first.startsWith('.')) return 'shell_exec:other';
        return `shell_exec:${first}`;
    },
    android_sms: () => 'android_sms',
    android_call: () => 'android_call',
    telegram_send: () => 'telegram_send',
};

function getShape(toolName, args) {
    const b = builders[toolName];
    const raw = b ? b(args || {}) : toolName;
    // Cap to 64 chars with trailing … if truncated
    if (raw.length <= 64) return raw;
    return raw.slice(0, 63) + '…';
}

module.exports = { getShape };
