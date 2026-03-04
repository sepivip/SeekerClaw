// SeekerClaw — providers/index.js
// Provider registry: register adapters, resolve by ID.
// Adding a new provider = 1 new file + register() call here.

const { log } = require('../config');

const adapters = new Map();

function register(adapter) {
    if (!adapter || !adapter.id) {
        log('[Provider] Attempted to register adapter without id', 'WARN');
        return;
    }
    adapters.set(adapter.id, adapter);
}

/**
 * Get adapter by provider ID. Falls back to 'claude' if unknown.
 * @param {string} id - Provider ID ('claude', 'openai', etc.)
 * @returns {object} Provider adapter
 */
function getAdapter(id) {
    const adapter = adapters.get(id);
    if (adapter) return adapter;
    log(`[Provider] Unknown provider "${id}" — falling back to claude`, 'WARN');
    return adapters.get('claude');
}

function listProviders() {
    return [...adapters.keys()];
}

// ── Register built-in providers ─────────────────────────────────────────────
register(require('./claude'));
register(require('./openai'));

module.exports = { getAdapter, listProviders, register };
