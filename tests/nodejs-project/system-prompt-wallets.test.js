#!/usr/bin/env node
// system-prompt-wallets.test.js — BAT-582 Phase 5.
//
// Verifies the "## Wallets" section emitted by buildSystemBlocks() in ai.js:
//   - When burner is configured: lists BOTH wallets with pubkey + cap values
//     (decimal display) + network=mainnet.
//   - When burner is not configured: lists Main only with a hint about
//     Settings → Burner Wallet.
//
// This is the SAB self-awareness gate: the agent's prompt must teach it
// that it has a burner + main wallet pair. Without this section, "what
// wallets do you have?" returns a generic answer instead of the contracted
// "Burner (pubkey, caps) + Main (MWA)" pair.
//
// We mock every ai.js dependency that buildSystemBlocks uses so the test
// stays focused on the wallets section's content. The test asserts on
// specific phrases that downstream code (SAB probes, agent self-awareness
// checks) and the contract spec rely on.

'use strict';

const assert = require('assert');
const path = require('path');
const Module = require('module');

const BUNDLE = path.resolve(__dirname, '..', '..', 'app', 'src', 'main', 'assets', 'nodejs-project');

// ── Mock every ai.js dependency we don't want to touch ──────────────────────

function _stub(modPath, exports) {
    const resolved = require.resolve(modPath);
    require.cache[resolved] = {
        id: resolved,
        filename: resolved,
        loaded: true,
        exports,
    };
}

// config.js — buildSystemBlocks reads many fields from here.
_stub(path.join(BUNDLE, 'config.js'), {
    workDir: '/tmp/fixture-wd',
    MODEL: 'claude-opus-4-7',
    resolveActiveModel: () => 'claude-opus-4-7',
    PROVIDER: 'claude',
    CHANNEL: 'telegram',
    ANTHROPIC_KEY: 'k', OPENAI_KEY: '', OPENROUTER_KEY: '', CUSTOM_KEY: '',
    CUSTOM_BASE_URL: '', CUSTOM_FORMAT: '', OPENROUTER_FALLBACK_MODEL: '',
    OPENROUTER_MODEL_CONTEXT: 0, OPENROUTER_FALLBACK_CONTEXT: 0,
    AUTH_TYPE: 'apiKey', OPENAI_AUTH_TYPE: 'apiKey',
    REACTION_GUIDANCE: 'on', REACTION_NOTIFICATIONS: 'on', MEMORY_DIR: '/tmp/fixture-wd/memory',
    TOOL_RATE_LIMITS: {}, TOOL_STATUS_MAP: {},
    API_TIMEOUT_RETRIES: 3, API_TIMEOUT_BACKOFF_MS: 100, API_TIMEOUT_MAX_BACKOFF_MS: 1000,
    truncateToolResult: (s) => s,
    localTimestamp: () => '2026-05-06T00:00:00Z',
    localDateStr: () => '2026-05-06',
    log: () => {},
    getOwnerId: () => 'OWNER',
    USER_ENV_KEYS: [],
    config: {
        jupiterApiKey: '',
        // BAT-525 — agentName and other live config the prompt references.
        agentName: 'TestAgent',
    },
    runtimeState: {},
});

_stub(path.join(BUNDLE, 'model-catalog.js'), {
    reasoningSupportFor: () => 'none',
    displayNameForProvider: () => 'Claude',
});
_stub(path.join(BUNDLE, 'reasoning-gating.js'), {
    logSuppression: () => {},
    SUPPRESSION_REASONS: {},
});
_stub(path.join(BUNDLE, 'security.js'), { redactSecrets: (s) => s });
_stub(path.join(BUNDLE, 'channel.js'), {
    sendMessage: async () => {},
    sendTyping: async () => {},
});
_stub(path.join(BUNDLE, 'telegram.js'), {
    sentMessageCache: new Map(),
    SENT_CACHE_TTL: 60_000,
    deferStatus: () => ({ cleanup: async () => {} }),
    deferThinkingStatus: () => ({ cleanup: async () => {} }),
});
_stub(path.join(BUNDLE, 'http.js'), {
    httpStreamingRequest: async () => ({}),
    httpOpenAIStreamingRequest: async () => ({}),
    httpChatCompletionsStreamingRequest: async () => ({}),
    httpRequest: async () => ({ status: 200 }),
});
_stub(path.join(BUNDLE, 'providers/index.js'), { getAdapter: () => null });
_stub(path.join(BUNDLE, 'bridge.js'), {
    androidBridgeCall: async (endpoint) => {
        // Returns an error envelope. Per BAT-582 R6, error envelopes are
        // treated as transient failures and DO NOT overwrite the cache —
        // so the snapshot we seed via _setWalletPromptSnapshotForTests
        // survives across the async refresh that buildSystemBlocks kicks off.
        // (Pre-R6 the error path overwrote with {configured: false}, which
        // races with the test seed — see catch-snapshot-overwrite test.)
        if (endpoint === '/burner/status') return { error: 'mocked-no-bridge' };
        return {};
    },
    fetchMcpToken: async () => '',
});
_stub(path.join(BUNDLE, 'silent-reply.js'), {
    stripSilentReply: (s) => s,
    TOKEN: '__SILENT_REPLY__',
});
_stub(path.join(BUNDLE, 'memory.js'), {
    loadSoul: () => '',
    loadBootstrap: () => '',
    loadIdentity: () => '',
    loadUser: () => '',
    loadMemory: () => '',
    loadDailyMemory: () => '',
});
_stub(path.join(BUNDLE, 'skills.js'), {
    findMatchingSkills: () => [],
    loadSkills: () => [],
});
_stub(path.join(BUNDLE, 'database.js'), {
    getDb: () => null,
    markDbDirty: () => {},
    markDbSummaryDirty: () => {},
    indexMemoryFiles: () => {},
    saveSession: () => {},
    getRecentSessions: () => [],
});
_stub(path.join(BUNDLE, 'task-store.js'), {
    saveCheckpoint: () => {},
    cleanupChatCheckpoints: () => {},
});
_stub(path.join(BUNDLE, 'loop-detector.js'), {
    detectToolLoop: () => null,
    reset: () => {},
});
_stub(path.join(BUNDLE, 'reasoning-recovery.js'), {
    handleReasoningError: () => null,
});
_stub(path.join(BUNDLE, 'reasoning-redact.js'), {
    fingerprint: () => '',
});
_stub(path.join(BUNDLE, 'confirmation/index.js'), {
    getConfirmationPolicy: () => 'none',
    normalizePolicy: (r) => (typeof r === 'string' ? { policy: r } : r),
});
_stub(path.join(BUNDLE, 'wallet/index.js'), {
    getWalletState: async () => ({ burnerConfigured: false }),
});

const ai = require(path.join(BUNDLE, 'ai.js'));
const { buildSystemBlocks, _setWalletPromptSnapshotForTests } = ai;

let failures = 0;
function check(label, fn) {
    try { fn(); console.log(`  ✓ ${label}`); }
    catch (e) { failures++; console.error(`  ✗ ${label}\n    ${e.stack || e.message}`); }
}

// ── Burner CONFIGURED → both wallets section ────────────────────────────────

check('burner configured: prompt lists both Burner and Main with caps + network', () => {
    _setWalletPromptSnapshotForTests({
        configured: true,
        pubkey: 'BURNER-FIXTURE-PUBKEY-1234567890',
        balanceSol: '0',
        balanceUsdc: '0',
        capPerTxSol: '50000000',     // 0.05 SOL
        capDailySol: '100000000',    // 0.10 SOL
        capPerTxUsdc: '5000000',     // 5 USDC
        capDailyUsdc: '20000000',    // 20 USDC
        spentTodaySol: '0',
        spentTodayUsdc: '0',
        network: 'mainnet',
    });

    const { stable } = buildSystemBlocks([], 'test-chat-1', 'claude-opus-4-7');

    assert.ok(stable.includes('## Wallets'), 'must include "## Wallets" section');
    assert.ok(stable.includes('You have two wallets'), 'must say "You have two wallets" when burner configured');
    assert.ok(stable.includes('Burner'), 'must mention Burner');
    assert.ok(stable.includes('BURNER-FIXTURE-PUBKEY-1234567890'), 'must include burner pubkey');
    assert.ok(stable.includes('0.05 SOL'), 'must include per-tx SOL cap as decimal (0.05)');
    assert.ok(stable.includes('0.10 SOL') || stable.includes('0.1 SOL'), 'must include daily SOL cap (0.10 or 0.1)');
    assert.ok(stable.includes('5 USDC'), 'must include per-tx USDC cap');
    assert.ok(stable.includes('20 USDC'), 'must include daily USDC cap');
    assert.ok(stable.includes('Main'), 'must mention Main wallet');
    assert.ok(stable.includes('MWA'), 'must mention MWA');
    assert.ok(stable.includes('mainnet'), 'must mention mainnet network');
    assert.ok(stable.includes('No popup'), 'must mention "No popup" for burner');
    assert.ok(stable.includes('approval popup'), 'must mention approval popup for main');
    // Anti-paraphrase rule from contract.
    assert.ok(stable.includes('never paraphrase as "your wallet"') || stable.includes('Always name them by role'),
        'must instruct agent to name wallets by role');
});

// ── Burner UNCONFIGURED → single-wallet section + Settings hint ─────────────

check('burner not configured: prompt shows single wallet + Settings hint', () => {
    _setWalletPromptSnapshotForTests({ configured: false });

    const { stable } = buildSystemBlocks([], 'test-chat-2', 'claude-opus-4-7');

    assert.ok(stable.includes('## Wallets'), 'must include "## Wallets" section even when burner unconfigured');
    assert.ok(stable.includes('You have one wallet'), 'must say "You have one wallet" when no burner');
    assert.ok(stable.includes('Main'), 'must list Main wallet');
    assert.ok(stable.includes('MWA'), 'must mention MWA');
    assert.ok(stable.includes('Settings'), 'must hint at Settings');
    assert.ok(stable.includes('Burner'), 'must mention burner as configurable option');
    assert.ok(stable.includes('mainnet'), 'must mention mainnet');
    // Anti-claim rule: must not assert burner exists when unconfigured.
    assert.ok(!stable.includes('You have two wallets'), 'must NOT claim two wallets when burner unconfigured');
});

// ── Snapshot null (first call before refresh) → unconfigured copy ───────────

check('burner snapshot null (first call): prompt falls back to single-wallet copy', () => {
    _setWalletPromptSnapshotForTests(null);

    const { stable } = buildSystemBlocks([], 'test-chat-3', 'claude-opus-4-7');

    assert.ok(stable.includes('## Wallets'));
    assert.ok(stable.includes('You have one wallet'),
        'null snapshot must produce single-wallet copy (matches v1.0 baseline before first refresh lands)');
});

// ── BAT-582 R6: bridge failure must NOT overwrite cached snapshot ───────────
//
// Pre-R6, the .catch() and the {error: ...} branch in
// _refreshWalletPromptSnapshot both wrote { configured: false } to the
// cache. That meant a transient bridge blip during a real conversation
// would silently replace a valid burner snapshot with the unconfigured
// copy, causing the agent to forget its burner mid-turn. It also meant
// tests that injected a snapshot then triggered buildSystemBlocks would
// have their seed erased by the next async tick.
//
// This is an async test because the overwrite happens INSIDE the
// promise chain — we have to give the microtask queue a tick to flush
// before asserting the cache is intact.

async function asyncCheck(label, fn) {
    try { await fn(); console.log(`  ✓ ${label}`); }
    catch (e) { failures++; console.error(`  ✗ ${label}\n    ${e.stack || e.message}`); }
}

async function flushMicrotasks() {
    // Two ticks: first lets the bridge promise resolve, second lets the
    // .then/.catch and .finally callbacks run in order.
    for (let i = 0; i < 5; i++) {
        await new Promise((r) => setImmediate(r));
        await Promise.resolve();
    }
}

(async () => {
    await asyncCheck('bridge failure does NOT overwrite a configured-burner snapshot', async () => {
        // Seed a fully-configured snapshot.
        const seeded = {
            configured: true,
            pubkey: 'PERSISTED-PUBKEY-9999',
            balanceSol: '0',
            balanceUsdc: '0',
            capPerTxSol: '50000000',
            capDailySol: '100000000',
            capPerTxUsdc: '5000000',
            capDailyUsdc: '20000000',
            spentTodaySol: '0',
            spentTodayUsdc: '0',
            network: 'mainnet',
        };
        _setWalletPromptSnapshotForTests(seeded);

        // First buildSystemBlocks: kicks off async refresh against our
        // bridge stub which returns {error: 'mocked-no-bridge'}.
        let { stable: first } = buildSystemBlocks([], 'test-chat-r6', 'claude-opus-4-7');
        assert.ok(first.includes('PERSISTED-PUBKEY-9999'),
            'first call: stable should include seeded burner pubkey');
        assert.ok(first.includes('You have two wallets'),
            'first call: must show two-wallet copy for configured burner');

        // Wait for the bridge promise + .then/.catch/.finally to settle.
        await flushMicrotasks();

        // Second buildSystemBlocks: the cache MUST still hold our seed.
        // Pre-fix, the {error: ...} branch wrote {configured: false} and
        // this assertion would fail (we'd see the single-wallet copy).
        const { stable: second } = buildSystemBlocks([], 'test-chat-r6', 'claude-opus-4-7');
        assert.ok(second.includes('PERSISTED-PUBKEY-9999'),
            'after bridge error: snapshot pubkey must be preserved (transient failure must not blank cache)');
        assert.ok(second.includes('You have two wallets'),
            'after bridge error: still must show two-wallet copy (cache survived)');
        assert.ok(!second.includes('You have one wallet'),
            'after bridge error: must NOT regress to single-wallet copy');
    });

    if (failures > 0) {
        console.error(`\n${failures} failure(s).`);
        process.exit(1);
    }
    console.log('\nPASS: system-prompt-wallets.test.js (4 wallet-section scenarios verified).');
})();
