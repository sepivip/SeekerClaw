#!/usr/bin/env node
// refusal.probe.js — BAT-1705 opt-in live probe (contract v2 "Wire evidence and live gate").
//
// Reproduces a real Claude `stop_reason: "refusal"` and proves the fix on the wire:
// drives the REAL chat() (this worktree's bundle) with the BAT-1664 repro scenario
// (the long 8-page read in a chat seeded near MAX_HISTORY with the repetitive seed,
// on which claude-opus-5 refused 3 of 4 runs on 2026-11-16) against the LIVE
// Anthropic API, on both auth paths (API key and Pro/Max setup token), one child
// process per path (config freezes the auth path at load time).
//
// It taps the raw streamed bytes of every response. On the first refusal it:
//   - checks chat() returned the user notice (not silence) and reported the
//     refusal through onTurnOutcome, and that no tool call from the refused
//     response ran;
//   - writes the SANITIZED raw SSE bytes to
//     tests/nodejs-project/fixtures/claude-refusal-live-<mode>.sse (message ids
//     replaced; no credentials or request headers are ever recorded), so the
//     offline transport test can replay real bytes.
// If no refusal happens within the cap it says so plainly ("not reproduced") —
// that is an honest outcome, not a pass of the refusal path.
//
// Opt-in only (never in CI). Credentials from 1Password, never printed:
//   op run --env-file=tests/live/anthropic/.env.op -- node tests/live/anthropic/refusal.probe.js
// Env: PROBE_MODES=apikey,setup_token  PROBE_MODEL=claude-opus-5  PROBE_ATTEMPTS=3  PROBE_CAP=12 (live requests per mode)

'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const BUNDLE = path.resolve(__dirname, '..', '..', '..', 'app', 'src', 'main', 'assets', 'nodejs-project');
const FIXTURES = path.resolve(__dirname, '..', '..', 'nodejs-project', 'fixtures');

function scrub(s) {
    return String(s || '').replace(/sk-ant-[A-Za-z0-9_\-]+/g, '[redacted]').replace(/Bearer\s+\S+/g, 'Bearer [redacted]').slice(0, 200);
}

// ════════════════════════════════════════════════════════════════════════════
// CHILD: one auth path
// ════════════════════════════════════════════════════════════════════════════
async function child() {
    const MODE = process.env.P_MODE;
    const MODEL = process.env.PROBE_MODEL || 'claude-opus-5';
    const ATTEMPTS = parseInt(process.env.PROBE_ATTEMPTS || '3', 10);
    let remaining = parseInt(process.env.PROBE_CAP || '12', 10);
    const KEY = (MODE === 'setup_token'
        ? (process.env.SETUP_TOKEN || process.env.ANTHROPIC_SETUP_TOKEN || '')
        : (process.env.ANTHROPIC_API_KEY || '')).trim();
    const out = (o) => process.stdout.write(JSON.stringify(o) + '\n');
    if (!KEY) { out({ mode: MODE, outcome: 'skipped', reason: 'credential missing' }); return; }

    const TMP = fs.mkdtempSync(path.join(os.tmpdir(), `bat1705-probe-${MODE}-`));
    const TASKS_DIR = path.join(TMP, 'tasks');
    fs.mkdirSync(TASKS_DIR, { recursive: true });
    fs.writeFileSync(path.join(TMP, 'agent_settings.json'), JSON.stringify({ maxStepsPerTurn: 10 }));
    const LOGS = [];
    const log = (msg, level) => { LOGS.push({ msg: String(msg), level: level || 'INFO' }); };
    const stub = (rel, exports) => {
        const resolved = require.resolve(path.join(BUNDLE, rel));
        require.cache[resolved] = { id: resolved, filename: resolved, loaded: true, exports };
    };
    stub('config.js', {
        workDir: TMP, TASKS_DIR, MODEL, resolveActiveModel: () => MODEL,
        PROVIDER: 'claude', CHANNEL: 'telegram',
        ANTHROPIC_KEY: KEY, OPENAI_KEY: '', XAI_KEY: '', OPENROUTER_KEY: '', CUSTOM_KEY: '',
        CUSTOM_BASE_URL: '', CUSTOM_FORMAT: '', OPENROUTER_FALLBACK_MODEL: '',
        OPENROUTER_MODEL_CONTEXT: 0, OPENROUTER_FALLBACK_CONTEXT: 0,
        AUTH_TYPE: MODE === 'setup_token' ? 'setup_token' : 'api_key', OPENAI_AUTH_TYPE: 'api_key',
        REACTION_GUIDANCE: 'on', REACTION_NOTIFICATIONS: 'on', MEMORY_DIR: path.join(TMP, 'memory'),
        TOOL_RATE_LIMITS: {}, TOOL_STATUS_MAP: {}, RICH_MESSAGES_ENABLED: false,
        API_TIMEOUT_MS: 180000, API_TIMEOUT_RETRIES: 0, API_TIMEOUT_BACKOFF_MS: 10, API_TIMEOUT_MAX_BACKOFF_MS: 10,
        truncateToolResult: (s) => s,
        localTimestamp: () => '2026-11-23T12:00:00Z', localDateStr: () => '2026-11-23',
        log, getOwnerId: () => 'OWNER', USER_ENV_KEYS: [],
        config: { agentName: 'TestAgent', jupiterApiKey: '' },
        runtimeState: { read: () => ({ reasoningEnabled: true, reasoningDisplayInChat: false }) },
    });
    stub('security.js', { redactSecrets: (s) => s });
    stub('channel.js', { sendMessage: async () => {}, sendTyping: () => {}, getOwnerChatId: () => 'OWNER' });
    stub('telegram.js', {
        sentMessageCache: new Map(), SENT_CACHE_TTL: 60000,
        deferStatus: () => ({ cleanup: async () => {} }), deferThinkingStatus: () => ({ cleanup: async () => {} }),
    });
    stub('bridge.js', { androidBridgeCall: async () => ({ error: 'mocked' }), fetchMcpToken: async () => '' });
    stub('memory.js', { loadSoul: () => '', loadBootstrap: () => '', loadIdentity: () => '', loadUser: () => '', loadMemory: () => '', loadDailyMemory: () => '' });
    stub('skills.js', { findMatchingSkills: () => [], loadSkills: () => [] });
    stub('database.js', { getDb: () => null, markDbDirty: () => {}, markDbSummaryDirty: () => {}, indexMemoryFiles: () => {}, saveSession: () => {}, getRecentSessions: () => [] });
    stub('confirmation/index.js', { getConfirmationPolicy: () => 'none', normalizePolicy: (r) => (typeof r === 'string' ? { policy: r } : r) });
    stub('wallet/index.js', { getWalletState: async () => ({ burnerConfigured: false }) });
    const claude = require(path.join(BUNDLE, 'providers', 'claude.js'));
    stub('providers/index.js', { getAdapter: () => claude });

    // ── raw byte tap on the Anthropic response stream (response bodies only) ──
    const https = require('https');
    const realRequest = https.request;
    let RAW = [];
    https.request = function (...args) {
        const req = realRequest.apply(this, args);
        req.on('response', (res) => { res.on('data', (c) => RAW.push(String(c))); });
        return req;
    };

    const realHttp = require(path.join(BUNDLE, 'http.js'));
    let ACTIVE = false;
    let lastStop = '';
    const transport = async (opts, body) => {
        if (!ACTIVE) throw new Error('stray request blocked');
        if (remaining <= 0) throw new Error('request cap reached');
        remaining--;
        RAW = [];
        const res = await realHttp.httpStreamingRequest(opts, body);
        lastStop = res && res.data ? String(res.data.stop_reason || '') : '';
        if (res && res.status === 200 && lastStop === 'refusal') {
            transport.refusalBytes = RAW.join('');
            // Tools from EARLIER rounds may have run; none may run from the refused response.
            transport.execAtRefusal = EXEC;
        }
        process.stderr.write(`  [${MODE}] status=${res.status} stop=${lastStop}${res.data && res.data.stop_details && res.data.stop_details.category ? ':' + res.data.stop_details.category : ''} (cap left ${remaining})\n`);
        if (res.status === 401 || res.status === 403) remaining = 0;
        return res;
    };
    stub('http.js', Object.assign({}, realHttp, { httpStreamingRequest: transport }));
    const ai = require(path.join(BUNDLE, 'ai.js'));
    const N = require(path.join(BUNDLE, 'refusal-notice.js'));

    const filler = (seed, n) => {
        const words = ['latency', 'throughput', 'replica', 'quorum', 'shard', 'ledger', 'cache', 'index', 'backoff', 'checkpoint', 'snapshot', 'region'];
        const o = []; let i = seed * 7;
        while (o.join(' ').length < n) o.push(words[(i++ * 5) % words.length] + (i % 9));
        return o.join(' ').slice(0, n);
    };
    let EXEC = 0;
    ai.setChatDeps({
        executeTool: async (name, input) => {
            EXEC++;
            const p = Math.max(1, Math.min(8, parseInt(input && input.page, 10) || 1));
            return { page: p, of: 8, text: `Page ${p}: key figure ${p * 17} ms p99 latency; decision D${p}. ` + filler(p, 4000) };
        },
        getTools: () => [{ name: 'read_doc', description: 'Read one page of the design document.',
            input_schema: { type: 'object', properties: { page: { type: 'integer', minimum: 1, maximum: 8 } }, required: ['page'] } }],
        requestConfirmation: async () => true, lastToolUseTime: new Map(), lastIncomingMessages: new Map(), getMcpStatus: () => [],
    });
    function seed(chatId) {
        const conv = ai.getConversation(chatId);
        for (let g = 0; g < 2; g++) {
            conv.push({ role: 'user', content: `Earlier question ${g}: check page ${g + 1}.` });
            conv.push({ role: 'assistant', content: 'Checking.', toolCalls: [{ id: `toolu_seed_${g}`, name: 'read_doc', input: { page: g + 1 } }], reasoningBlocks: [] });
            conv.push({ role: 'tool', toolCallId: `toolu_seed_${g}`, content: JSON.stringify({ page: g + 1, text: filler(90 + g, 5000) }) });
            conv.push({ role: 'assistant', content: `Page ${g + 1} covers decision D${g + 1}.`, reasoningBlocks: [] });
        }
        for (let i = 0; i < 13; i++) {
            conv.push({ role: 'user', content: `Side question ${i}: what does term ${i} mean?` });
            conv.push({ role: 'assistant', content: `Term ${i} is a placeholder used in the design notes.`, reasoningBlocks: [] });
        }
    }
    const PROMPT = 'Read the whole design document with read_doc: it has 8 pages. Read exactly ONE page per message, in order from page 1 to page 8 — do not request several pages at once. After page 8, give me a 5-bullet summary that cites each decision D1–D8.';

    for (let a = 1; a <= ATTEMPTS && remaining > 0; a++) {
        const chatId = `probe-${MODE}-${a}`;
        seed(chatId);
        transport.refusalBytes = null; transport.execAtRefusal = null; EXEC = 0;
        let reply = null, threw = null, outcome = null;
        ACTIVE = true;
        try {
            reply = await ai.chat(chatId, PROMPT, { onTurnOutcome: (o) => { outcome = o; } });
        } catch (e) { threw = scrub(e && e.message); } finally {
            ACTIVE = false;
            try { ai.cancelAllIdleSummaries(); } catch (_) {}
        }
        if (!transport.refusalBytes) {
            process.stderr.write(`  [${MODE}] attempt ${a}: no refusal (${threw ? 'threw: ' + threw : 'completed'})\n`);
            continue;
        }
        const r = outcome && outcome.refusal;
        const expected = r ? N.buildRefusalNotice({ kind: r.kind, modelMessage: r.modelMessage }, r.dispatchedTools) : null;
        const checks = {
            replyIsNotice: !!reply && reply === expected,
            notSilent: !!reply && !/\[\[SILENT_REPLY\]\]/.test(reply),
            outcomeReported: !!r && r.kind === 'model_refusal',
            warnTrace: LOGS.some((l) => l.level === 'WARN' && /"reason":"model_refusal"/.test(l.msg)),
            noToolAfterRefusal: EXEC === transport.execAtRefusal,
        };
        // Sanitize: response body only; replace message ids. No headers, no credentials.
        const sanitized = transport.refusalBytes.replace(/"id":"msg_[A-Za-z0-9_]+"/g, '"id":"msg_fixture"');
        if (/sk-ant-|Bearer /.test(sanitized)) throw new Error('refusing to write a fixture that looks like it holds a credential');
        fs.mkdirSync(FIXTURES, { recursive: true });
        const file = path.join(FIXTURES, `claude-refusal-live-${MODE}.sse`);
        fs.writeFileSync(file, sanitized);
        out({ mode: MODE, outcome: 'reproduced', attempt: a, model: MODEL, category: r && r.category, dispatchedTools: r && r.dispatchedTools,
            toolsExecutedThisTurn: EXEC, checks, fixture: path.relative(process.cwd(), file), bytes: sanitized.length });
        try { fs.rmSync(TMP, { recursive: true, force: true }); } catch (_) {}
        process.exit(Object.values(checks).every(Boolean) ? 0 : 4);
    }
    out({ mode: MODE, outcome: 'not reproduced', attempts: ATTEMPTS, lastStop, capLeft: remaining });
    try { fs.rmSync(TMP, { recursive: true, force: true }); } catch (_) {}
}

// ════════════════════════════════════════════════════════════════════════════
// PARENT
// ════════════════════════════════════════════════════════════════════════════
function parent() {
    const modes = (process.env.PROBE_MODES || 'apikey,setup_token').split(',').map((s) => s.trim()).filter(Boolean);
    let bad = false;
    for (const mode of modes) {
        const r = spawnSync(process.execPath, [__filename], { env: Object.assign({}, process.env, { P_CHILD: '1', P_MODE: mode }), encoding: 'utf8', stdio: ['ignore', 'pipe', 'inherit'], timeout: 20 * 60 * 1000 });
        const line = (r.stdout || '').trim().split('\n').pop() || '';
        console.log(line ? line : JSON.stringify({ mode, outcome: 'error', exit: r.status }));
        if (r.status !== 0) bad = true;
    }
    process.exit(bad ? 1 : 0);
}

if (process.env.P_CHILD === '1') child().catch((e) => { process.stdout.write(JSON.stringify({ outcome: 'error', error: scrub(e && e.message) }) + '\n'); process.exit(2); });
else parent();
