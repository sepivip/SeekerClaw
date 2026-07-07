#!/usr/bin/env node
// system-prompt-recent-sessions.test.js — BAT-1130 F5 + F3.
//
// F5 (caching): the "Recent Sessions" block must be emitted in the DYNAMIC
//   block, NOT the cached stable block. It rotates every session, so keeping it
//   in the stable prefix busted the ~60 KB prompt cache on every rotation.
//
// F3 (self-heal): buildSystemBlocks({ leanMemory: true }) must omit the volatile
//   agent-authored memory (Recent Sessions + MEMORY.md + today's daily memory)
//   so the tool-loop self-heal can retry a request that Anthropic rejected
//   because of a poisoned memory phrase. Also unit-tests _isUsageFilter400.
//
// Mocks every ai.js dependency (same approach as system-prompt-wallets.test.js).
'use strict';

const assert = require('assert');
const path = require('path');

const BUNDLE = path.resolve(__dirname, '..', '..', 'app', 'src', 'main', 'assets', 'nodejs-project');

function _stub(modPath, exports) {
    const resolved = require.resolve(modPath);
    require.cache[resolved] = { id: resolved, filename: resolved, loaded: true, exports };
}

_stub(path.join(BUNDLE, 'config.js'), {
    workDir: '/tmp/fixture-wd',
    MODEL: 'claude-opus-4-8',
    resolveActiveModel: () => 'claude-opus-4-8',
    PROVIDER: 'claude',
    CHANNEL: 'telegram',
    ANTHROPIC_KEY: 'k', OPENAI_KEY: '', OPENROUTER_KEY: '', CUSTOM_KEY: '',
    CUSTOM_BASE_URL: '', CUSTOM_FORMAT: '', OPENROUTER_FALLBACK_MODEL: '',
    OPENROUTER_MODEL_CONTEXT: 0, OPENROUTER_FALLBACK_CONTEXT: 0,
    AUTH_TYPE: 'setup_token', OPENAI_AUTH_TYPE: 'apiKey',
    REACTION_GUIDANCE: 'on', REACTION_NOTIFICATIONS: 'on', MEMORY_DIR: '/tmp/fixture-wd/memory',
    TOOL_RATE_LIMITS: {}, TOOL_STATUS_MAP: {},
    API_TIMEOUT_RETRIES: 3, API_TIMEOUT_BACKOFF_MS: 100, API_TIMEOUT_MAX_BACKOFF_MS: 1000,
    truncateToolResult: (s) => s,
    localTimestamp: () => '2026-07-07T00:00:00Z',
    localDateStr: () => '2026-07-07',
    log: () => {},
    getOwnerId: () => 'OWNER',
    USER_ENV_KEYS: [],
    config: { jupiterApiKey: '', agentName: 'TestAgent' },
    runtimeState: {},
});
_stub(path.join(BUNDLE, 'model-catalog.js'), { reasoningSupportFor: () => 'none', displayNameForProvider: () => 'Claude' });
_stub(path.join(BUNDLE, 'reasoning-gating.js'), { logSuppression: () => {}, SUPPRESSION_REASONS: {} });
_stub(path.join(BUNDLE, 'security.js'), { redactSecrets: (s) => s });
_stub(path.join(BUNDLE, 'channel.js'), { sendMessage: async () => {}, sendTyping: async () => {} });
_stub(path.join(BUNDLE, 'telegram.js'), {
    sentMessageCache: new Map(), SENT_CACHE_TTL: 60_000,
    deferStatus: () => ({ cleanup: async () => {} }), deferThinkingStatus: () => ({ cleanup: async () => {} }),
});
_stub(path.join(BUNDLE, 'http.js'), {
    httpStreamingRequest: async () => ({}), httpOpenAIStreamingRequest: async () => ({}),
    httpChatCompletionsStreamingRequest: async () => ({}), httpRequest: async () => ({ status: 200 }),
});
_stub(path.join(BUNDLE, 'providers/index.js'), { getAdapter: () => null });
_stub(path.join(BUNDLE, 'bridge.js'), {
    androidBridgeCall: async (endpoint) => (endpoint === '/burner/status' ? { error: 'mocked-no-bridge' } : {}),
    fetchMcpToken: async () => '',
});
_stub(path.join(BUNDLE, 'silent-reply.js'), { stripSilentReply: (s) => s, TOKEN: '__SILENT_REPLY__' });
// Memory markers — MEMORY.md + today's daily memory must land in stable normally,
// and must vanish under leanMemory.
// Call counters pin BAT-1130's read-skip: leanMemory must not even READ memory from disk.
let _memReads = 0, _dailyReads = 0;
_stub(path.join(BUNDLE, 'memory.js'), {
    loadSoul: () => '', loadBootstrap: () => '', loadIdentity: () => '', loadUser: () => '',
    loadMemory: () => { _memReads++; return 'MEMORY_MARKER_XYZ'; },
    loadDailyMemory: () => { _dailyReads++; return 'DAILY_MARKER_XYZ'; },
});
_stub(path.join(BUNDLE, 'skills.js'), { findMatchingSkills: () => [], loadSkills: () => [] });
// Fixture recent session — its marker text is what we assert on for placement.
_stub(path.join(BUNDLE, 'database.js'), {
    getDb: () => null, markDbDirty: () => {}, markDbSummaryDirty: () => {}, indexMemoryFiles: () => {},
    saveSession: () => {},
    getRecentSessions: () => [{ relativeTime: '2 hours ago', durationMin: 10, messageCount: 2, summaryText: 'RECENT_SESSION_MARKER' }],
});
_stub(path.join(BUNDLE, 'task-store.js'), { saveCheckpoint: () => {}, cleanupChatCheckpoints: () => {} });
_stub(path.join(BUNDLE, 'loop-detector.js'), { detectToolLoop: () => null, reset: () => {} });
_stub(path.join(BUNDLE, 'reasoning-recovery.js'), { handleReasoningError: () => null });
_stub(path.join(BUNDLE, 'reasoning-redact.js'), { fingerprint: () => '' });
_stub(path.join(BUNDLE, 'confirmation/index.js'), { getConfirmationPolicy: () => 'none', normalizePolicy: (r) => (typeof r === 'string' ? { policy: r } : r) });
_stub(path.join(BUNDLE, 'wallet/index.js'), { getWalletState: async () => ({ burnerConfigured: false }) });

const ai = require(path.join(BUNDLE, 'ai.js'));
const { buildSystemBlocks, _setWalletPromptSnapshotForTests, _isUsageFilter400 } = ai;
_setWalletPromptSnapshotForTests({ configured: false }); // deterministic, no async wallet noise

let failures = 0;
function check(label, fn) {
    try { fn(); console.log(`  ✓ ${label}`); }
    catch (e) { failures++; console.error(`  ✗ ${label}\n    ${e.stack || e.message}`); }
}

// ── F5: Recent Sessions lives in the DYNAMIC block, not the cached stable ────
check('F5: Recent Sessions is emitted in the DYNAMIC block', () => {
    const { stable, dynamic } = buildSystemBlocks([], 'chat-1', 'claude-opus-4-8');
    assert.ok(dynamic.includes('## Recent Sessions'), 'dynamic block must contain the Recent Sessions header');
    assert.ok(dynamic.includes('RECENT_SESSION_MARKER'), 'dynamic block must contain the session summary text');
    assert.ok(!stable.includes('## Recent Sessions'), 'stable (cached) block must NOT contain Recent Sessions');
    assert.ok(!stable.includes('RECENT_SESSION_MARKER'), 'stable (cached) block must NOT contain the session summary text');
});

check('F5: MEMORY.md and daily memory still live in the stable block', () => {
    const { stable } = buildSystemBlocks([], 'chat-2', 'claude-opus-4-8');
    assert.ok(stable.includes('MEMORY_MARKER_XYZ'), 'MEMORY.md stays in stable (changes rarely)');
    assert.ok(stable.includes('DAILY_MARKER_XYZ'), 'daily memory stays in stable');
});

// ── F3: leanMemory omits ALL volatile agent-authored memory ──────────────────
check('F3: leanMemory omits Recent Sessions + MEMORY.md + daily memory', () => {
    const { stable, dynamic } = buildSystemBlocks([], 'chat-3', 'claude-opus-4-8', { leanMemory: true });
    const all = stable + '\n' + dynamic;
    assert.ok(!all.includes('RECENT_SESSION_MARKER'), 'lean: Recent Sessions must be gone');
    assert.ok(!all.includes('MEMORY_MARKER_XYZ'), 'lean: MEMORY.md must be gone');
    assert.ok(!all.includes('DAILY_MARKER_XYZ'), 'lean: daily memory must be gone');
    // Core prompt still intact (self-heal must keep a usable agent).
    assert.ok(stable.includes('## Wallets'), 'lean: core sections (Wallets) still present');
    assert.ok(stable.includes('## Wallet Key Policy'), 'lean: security policy still present');
});

check('F3: leanMemory does NOT read MEMORY.md / daily memory from disk', () => {
    _memReads = 0; _dailyReads = 0;
    buildSystemBlocks([], 'chat-lean-io', 'claude-opus-4-8', { leanMemory: true });
    assert.strictEqual(_memReads, 0, 'loadMemory must not be called on the lean retry');
    assert.strictEqual(_dailyReads, 0, 'loadDailyMemory must not be called on the lean retry');
});

check('F3: default (non-lean) build DOES read memory from disk', () => {
    _memReads = 0; _dailyReads = 0;
    buildSystemBlocks([], 'chat-nonlean-io', 'claude-opus-4-8');
    assert.ok(_memReads >= 1 && _dailyReads >= 1, 'non-lean build must read memory + daily memory');
});

check('F3: default (non-lean) keeps the volatile memory', () => {
    const { stable, dynamic } = buildSystemBlocks([], 'chat-4', 'claude-opus-4-8');
    const all = stable + '\n' + dynamic;
    assert.ok(all.includes('RECENT_SESSION_MARKER') && all.includes('MEMORY_MARKER_XYZ') && all.includes('DAILY_MARKER_XYZ'),
        'non-lean build must still include all memory sections');
});

// ── F3: _isUsageFilter400 detector ───────────────────────────────────────────
check('_isUsageFilter400: matches the 400 "out of extra usage" shape', () => {
    assert.strictEqual(_isUsageFilter400(400, { error: { message: "You're out of extra usage. Add more at claude.ai/settings/usage and keep going." } }), true);
    assert.strictEqual(_isUsageFilter400(400, 'You are out of extra usage'), true, 'raw-string bodies also match');
});
check('_isUsageFilter400: does NOT match unrelated 400s or other statuses', () => {
    assert.strictEqual(_isUsageFilter400(400, { error: { message: 'messages.0.content: invalid' } }), false, 'other 400 must not match');
    assert.strictEqual(_isUsageFilter400(429, { error: { message: 'extra usage' } }), false, 'only status 400 qualifies');
    assert.strictEqual(_isUsageFilter400(400, null), false, 'null body is safe');
    assert.strictEqual(_isUsageFilter400(200, { error: { message: 'extra usage' } }), false, '200 never qualifies');
});

if (failures > 0) { console.error(`\n${failures} failure(s).`); process.exit(1); }
console.log('\nPASS: system-prompt-recent-sessions.test.js (F5 placement + F3 leanMemory + _isUsageFilter400).');
