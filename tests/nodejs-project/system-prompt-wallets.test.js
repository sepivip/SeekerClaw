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

    // SAB-AUDIT-v27 / payment-safety phrases — locked here so a future prompt
    // edit can't silently drop them. These are high-risk: dropping them
    // re-opens the "agent paid $0.02 but reported $0.01" UX (multi-call
    // transparency) and the post-Test-2 USDC-burn loop (auto-retry on 4xx
    // catalog body-shape failures, which was the bug PR #382 fixed).
    assert.ok(stable.includes('Multi-call composition'),
        'must include "Multi-call composition" transparency hint (SAB-AUDIT-v27 A1)');
    assert.ok(stable.includes('do NOT auto-retry') || stable.includes('DO NOT auto-retry'),
        'must instruct agent NOT to auto-retry on HTTP 4xx after settle (SAB-AUDIT-v27 A1)');
    // Assert on the paid-APIs-specific door to DIAGNOSTICS, not a generic
    // DIAGNOSTICS reference — the prompt has a separate generic "see
    // DIAGNOSTICS.md" line in the Diagnostics section which would let this
    // pass even if the paid-API guidance dropped its DIAGNOSTICS pointer.
    // Lock the verbatim phrase "DIAGNOSTICS.md → \"paysh-catalog\"" so the
    // paid-call failure path stays explicitly wired to that section.
    assert.ok(stable.includes('DIAGNOSTICS.md → "paysh-catalog"'),
        'must reference DIAGNOSTICS.md → "paysh-catalog" specifically as the door for post-paid-call-failure self-troubleshooting');

    // BAT-936 Wallet Key Policy — security-critical refusal block. Pinned in
    // ALL THREE wallet-state paths (configured/unconfigured/null) because the
    // block fires UNCONDITIONALLY (ai.js:664-677 comment: "fires regardless
    // of burner config state"). Dropping any of these phrases silently
    // re-opens the "talk the agent into generating a key" attack surface.
    assert.ok(stable.includes('## Wallet Key Policy'),
        'must include "## Wallet Key Policy" section header (BAT-936)');
    assert.ok(stable.includes('You NEVER produce wallet key material'),
        'must include the unconditional refusal sentence (BAT-936)');
    assert.ok(stable.includes('Settings → Burner Wallet'),
        'must redirect to Settings → Burner Wallet (BAT-936)');
    assert.ok(stable.includes('there is no in-app "rotate" or "generate" path'),
        'must explicitly state the app has no rotate/generate path (BAT-936)');
    assert.ok(stable.includes('No exceptions'),
        'must include the "No exceptions" push-back response (BAT-936)');

    // BAT-1002 PR-C: V2 error-code playbook phrase-lock.
    // Each code identifier MUST appear verbatim because the agent sees
    // them as `error: '<code>'` in tool envelopes — a missing code re-
    // opens the BAT-995 device-test confabulation class. Locked here
    // so any future prompt edit that drops a code fails the build with
    // a specific message naming the missing code (vs a generic
    // substring miss).
    //
    // 21 codes total: 15 verified-emitted from v1.1 + 4 input-validation
    // (input_usd_value_invalid, min_order_size_below_10_usd,
    // expires_at_too_soon, slippage_out_of_range) added in v1.1 +
    // auth_failed restored after 2026-06-04 re-grep found it at
    // jupiter/trigger-v2.js:522 (msgResult.error || 'auth_failed' fallback) +
    // trigger_price_required added in Copilot R2 (jupiter/trigger-v2.js:729,
    // validateOrderArgs — fires when triggerPriceUsd is present but
    // NaN/<=0, semantically distinct from trigger_price_usd_required
    // which fires when the field is missing entirely at tools/solana.js:597).
    //
    // The 4 BAT-1000 roadmap codes (insufficient_sol_for_rent etc.) are
    // NOT locked — they have zero emissions today per Codex OQ-5 Option B;
    // lock them when the V2 handler starts emitting.
    //
    // Codes intentionally deferred per Codex OQ-3 ("defer 6 pre-flow
    // auth-family codes unless they surface through trigger-create"):
    // auth_challenge_failed, auth_challenge_invalid, auth_required,
    // auth_sign_failed, auth_tx_invalid, auth_verify_failed.
    // Cancel/list/bootstrap flows also deferred (cancel_step1_failed,
    // confirm_cancel_failed, list_failed, jupiter_api_key_required,
    // bridge_threw, broadcast_failed, no_burner_wallet, reserve_failed,
    // rpc_send_failed, execute_failed, invalid_input, unsupported_capability) —
    // they're emitted but on separate user-facing surfaces (cancel,
    // list, MCP, provider setup) that PR-C deliberately scopes out.
    assert.ok(stable.includes('### Trigger V2 error-code playbook'),
        'must include "### Trigger V2 error-code playbook" sub-section header (BAT-1002)');
    const V2_CODES = [
        'burner_over_cap',
        'trigger_price_usd_required',
        'trigger_price_required',
        'expires_at_required',
        'trigger_condition_required',
        'trigger_mint_required',
        'trigger_mint_invalid',
        'price_unavailable',
        'price_lookup_failed',
        'input_usd_value_invalid',
        'min_order_size_below_10_usd',
        'expires_at_too_soon',
        'slippage_out_of_range',
        'deposit_craft_failed',
        'create_failed',
        'create_ambiguous_no_recovery',
        'auth_failed',
        'auth_expired',
        'vault_unavailable',
        'wallet_not_authorized',
        'sign_failed',
    ];
    // Drift guard: lock the EXACT count. If someone adds a code to the
    // array, this fails until they update both the count and the
    // documentation breakdown above. Prevents the off-by-one Copilot R1
    // caught (comment said 19, array had 20) AND the missing code
    // class Copilot R2 caught (trigger_price_required emitted but not
    // locked).
    assert.strictEqual(V2_CODES.length, 21,
        'V2_CODES must contain exactly 21 codes; if you add/remove, update the comment breakdown above');
    for (const code of V2_CODES) {
        assert.ok(stable.includes(code),
            `V2 error-code playbook must mention \`${code}\` verbatim (BAT-1002 phrase-lock)`);
    }
    // Catch-all guard — load-bearing defense against unknown future
    // codes per Codex v1.1 OQ-3.
    assert.ok(stable.includes('surface the `reason` field VERBATIM'),
        'must include catch-all guard for unrecognized error codes (BAT-1002 — confabulation defense)');
    // solana_balance three-state distinguisher guidance.
    assert.ok(stable.includes('solana_balance') && stable.includes('tokens: null') && stable.includes('tokensError'),
        'must include solana_balance RPC-fail distinguisher guidance with tokens: null + tokensError (BAT-1002)');
    assert.ok(stable.includes('SPL token balance temporarily unavailable'),
        'must teach agent the verbatim "SPL token balance temporarily unavailable" copy instead of "0 tokens" on RPC fail (BAT-1002)');
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

    // BAT-936 Wallet Key Policy must ALSO fire here (unconfigured users are
    // the highest-risk audience — they're the ones likely to ask "generate
    // me a wallet"). This is the load-bearing assertion for the "fires
    // regardless of burner config state" invariant.
    assert.ok(stable.includes('## Wallet Key Policy'),
        'Wallet Key Policy MUST fire when burner is unconfigured (BAT-936)');
    assert.ok(stable.includes('You NEVER produce wallet key material'),
        'unconfigured path: refusal sentence must be present (BAT-936)');
    assert.ok(stable.includes('Settings → Burner Wallet'),
        'unconfigured path: must redirect to Settings → Burner Wallet (BAT-936)');
});

// ── Snapshot null (first call before refresh) → unconfigured copy ───────────

check('burner snapshot null (first call): prompt falls back to single-wallet copy', () => {
    _setWalletPromptSnapshotForTests(null);

    const { stable } = buildSystemBlocks([], 'test-chat-3', 'claude-opus-4-7');

    assert.ok(stable.includes('## Wallets'));
    assert.ok(stable.includes('You have one wallet'),
        'null snapshot must produce single-wallet copy (matches v1.0 baseline before first refresh lands)');

    // BAT-936: Policy fires before any wallet snapshot is even read. The
    // null-snapshot path is the most defensive — if the security guard
    // works here, it works everywhere. Pin the full phrase set (not just
    // the header) so the surrounding comment in the configured-path test
    // (which claims all 3 paths cover the same phrases) stays accurate.
    assert.ok(stable.includes('## Wallet Key Policy'),
        'Wallet Key Policy MUST fire even before the wallet snapshot resolves (BAT-936)');
    assert.ok(stable.includes('You NEVER produce wallet key material'),
        'null-snapshot path: refusal sentence must be present (BAT-936)');
    assert.ok(stable.includes('Settings → Burner Wallet'),
        'null-snapshot path: must redirect to Settings → Burner Wallet (BAT-936)');
    assert.ok(stable.includes('there is no in-app "rotate" or "generate" path'),
        'null-snapshot path: must explicitly state the app has no rotate/generate path (BAT-936)');
    assert.ok(stable.includes('No exceptions'),
        'null-snapshot path: must include the "No exceptions" push-back response (BAT-936)');
    // PR #387 R2 fix — hardware wallets must NOT be suggested as a key source
    // (they don't expose private keys by design).
    assert.ok(!/\*\*a hardware wallet\*\*|hardware wallet export/.test(stable),
        'must NOT suggest hardware wallets as a key-export source (PR #387 R2 fix)');
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
