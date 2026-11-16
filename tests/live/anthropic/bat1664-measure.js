#!/usr/bin/env node
// bat1664-measure.js — BAT-1664 spec item 10: OLD vs NEW measurement before merge.
//
// Drives the REAL chat() of two bundles against the LIVE Anthropic API:
//   OLD = a `git archive 978d108d` (origin/main before BAT-1664) extract
//   NEW = this worktree's bundle
// Everything except the HTTP transport is stubbed (same approach as
// tests/nodejs-project/claude-stable-history.test.js); tools run locally and
// return deterministic payloads. Each bundle runs in its OWN child process so
// module caches and module-level state never mix.
//
// Scenarios × models (claude-fable-5-1 flagged, claude-opus-5 default/unflagged):
//   long    — ~8 sequential tool rounds (~4 KB results) in a chat seeded near
//             MAX_HISTORY (35), so OLD's per-round trim + aging are active
//   fanout  — one round of 6 parallel calls (~18 KB results), then the answer
//
// Records per request: wire bytes, usage tokens (input / output / cache read /
// cache write), latency, thinking blocks replayed, input_transformations drops,
// status. Per run: heals ([ThinkingBinding]) / gate ([ContextBudget]) log lines,
// final answer.
//
// API KEY ONLY. Credentials: ANTHROPIC_API_KEY from $BAT1664_MEASURE_ENV or
// $BAT1664_MEASURE_ENV, or the gitignored .env next to this file — never printed,
// error text scrubbed, a 401/403 stops everything. Hard cap on live requests
// (MEASURE_CAP, default 70) across the whole run.
//
// Each row gets a verdict: OK (final answer + the intended workload ran), FAILED
// (chat() threw) or INCONCLUSIVE (the model did not run the workload: long must be
// 8 rounds of exactly one read_doc, pages 1..8 in order; fanout must be one round
// of 6 fetch_report calls covering all six regions, then the answer). Exit code is
// non-zero on any INCONCLUSIVE row or any FAILED **NEW** row; a FAILED OLD row is
// reported but does not fail the run (OLD is the baseline, not the subject).
//
// Idle-summary timers (armed by real chat()) are cancelled before and after every
// measured call, and the transport BLOCKS any request made outside a measured
// chat() call (counted as "stray"), so a background summary can never land in a
// later scenario's numbers or spend live budget.
//
// Opt-in only (never in CI):
//   node tests/live/anthropic/bat1664-measure.js --old <path-to-old-nodejs-project>
//   node tests/live/anthropic/bat1664-measure.js --old <path> --dry    (no network,
//        scripted responses; MEASURE_DRY_BAD=1 → out-of-order pages → INCONCLUSIVE;
//        MEASURE_DRY_BAD_REGION=1 → a fan-out region outside the expected six → INCONCLUSIVE,
//        MEASURE_DRY_THROW=1 → a 400 mid-turn → FAILED)
// Env: MEASURE_MODELS=claude-fable-5-1,claude-opus-5  MEASURE_SCENARIOS=long,fanout

'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const NEW_BUNDLE = path.resolve(__dirname, '..', '..', '..', 'app', 'src', 'main', 'assets', 'nodejs-project');
const ENV_PATH = process.env.BAT1664_MEASURE_ENV || path.join(__dirname, '.env');
const CAP = parseInt(process.env.MEASURE_CAP || '70', 10);

function scrub(s) {
    return String(s || '').replace(/sk-ant-[A-Za-z0-9_\-]+/g, '[redacted]').replace(/Bearer\s+\S+/g, 'Bearer [redacted]').slice(0, 200);
}
function readKey() {
    if (!fs.existsSync(ENV_PATH)) return null;
    for (const line of fs.readFileSync(ENV_PATH, 'utf8').split(/\r?\n/)) {
        const t = line.trim();
        if (!t.startsWith('ANTHROPIC_API_KEY=')) continue;
        let v = t.slice('ANTHROPIC_API_KEY='.length).trim();
        if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) v = v.slice(1, -1);
        return v || null;
    }
    return null;
}

// ════════════════════════════════════════════════════════════════════════════
// CHILD: run one bundle
// ════════════════════════════════════════════════════════════════════════════
async function child() {
    const BUNDLE = process.env.M_BUNDLE;
    const VERSION = process.env.M_VERSION;
    const MODELS = process.env.M_MODELS.split(',');
    const SCENARIOS = process.env.M_SCENARIOS.split(',');
    let remaining = parseInt(process.env.M_REMAINING, 10);
    const DRY = process.env.M_DRY === '1';
    const KEY = DRY ? 'dry-run-not-a-key' : readKey();
    if (!KEY) { process.stdout.write(JSON.stringify({ fatal: 'credential missing' }) + '\n'); process.exit(2); }

    const TMP = fs.mkdtempSync(path.join(os.tmpdir(), `bat1664m-${VERSION}-`));
    const TASKS_DIR = path.join(TMP, 'tasks');
    fs.mkdirSync(TASKS_DIR, { recursive: true });
    fs.writeFileSync(path.join(TMP, 'agent_settings.json'), JSON.stringify({ maxStepsPerTurn: 10 }));
    const LOGS = [];
    const log = (msg, level) => { LOGS.push({ msg: String(msg), level: level || 'INFO' }); };
    const stub = (rel, exports) => {
        const resolved = require.resolve(path.join(BUNDLE, rel));
        require.cache[resolved] = { id: resolved, filename: resolved, loaded: true, exports };
    };
    let currentModel = MODELS[0];
    stub('config.js', {
        workDir: TMP, TASKS_DIR,
        MODEL: currentModel, resolveActiveModel: () => currentModel,
        PROVIDER: 'claude', CHANNEL: 'telegram',
        ANTHROPIC_KEY: KEY, OPENAI_KEY: '', XAI_KEY: '', OPENROUTER_KEY: '', CUSTOM_KEY: '',
        CUSTOM_BASE_URL: '', CUSTOM_FORMAT: '', OPENROUTER_FALLBACK_MODEL: '',
        OPENROUTER_MODEL_CONTEXT: 0, OPENROUTER_FALLBACK_CONTEXT: 0,
        AUTH_TYPE: 'api_key', OPENAI_AUTH_TYPE: 'api_key',
        REACTION_GUIDANCE: 'on', REACTION_NOTIFICATIONS: 'on', MEMORY_DIR: path.join(TMP, 'memory'),
        TOOL_RATE_LIMITS: {}, TOOL_STATUS_MAP: {}, RICH_MESSAGES_ENABLED: false,
        API_TIMEOUT_MS: 180000,
        API_TIMEOUT_RETRIES: 0, API_TIMEOUT_BACKOFF_MS: 10, API_TIMEOUT_MAX_BACKOFF_MS: 10,
        truncateToolResult: (s) => s,
        localTimestamp: () => '2026-11-16T12:00:00Z',
        localDateStr: () => '2026-11-16',
        log,
        getOwnerId: () => 'OWNER',
        USER_ENV_KEYS: [],
        config: { agentName: 'TestAgent', jupiterApiKey: '' },
        runtimeState: { read: () => ({ reasoningEnabled: true, reasoningDisplayInChat: false }) },
    });
    stub('security.js', { redactSecrets: (s) => s });
    stub('channel.js', { sendMessage: async () => {}, sendTyping: () => {}, getOwnerChatId: () => 'OWNER' });
    stub('telegram.js', {
        sentMessageCache: new Map(), SENT_CACHE_TTL: 60000,
        deferStatus: () => ({ cleanup: async () => {} }),
        deferThinkingStatus: () => ({ cleanup: async () => {} }),
    });
    stub('bridge.js', { androidBridgeCall: async () => ({ error: 'mocked' }), fetchMcpToken: async () => '' });
    stub('memory.js', {
        loadSoul: () => '', loadBootstrap: () => '', loadIdentity: () => '', loadUser: () => '',
        loadMemory: () => '', loadDailyMemory: () => '',
    });
    stub('skills.js', { findMatchingSkills: () => [], loadSkills: () => [] });
    stub('database.js', {
        getDb: () => null, markDbDirty: () => {}, markDbSummaryDirty: () => {}, indexMemoryFiles: () => {},
        saveSession: () => {}, getRecentSessions: () => [],
    });
    stub('confirmation/index.js', {
        getConfirmationPolicy: () => 'none',
        normalizePolicy: (r) => (typeof r === 'string' ? { policy: r } : r),
    });
    stub('wallet/index.js', { getWalletState: async () => ({ burnerConfigured: false }) });
    const claude = require(path.join(BUNDLE, 'providers', 'claude.js'));
    stub('providers/index.js', { getAdapter: () => claude });

    // ── live transport with metrics ──
    const realHttp = require(path.join(BUNDLE, 'http.js'));
    let REQ = [];
    class Stop extends Error {}
    // chat() wraps transport errors, so a stop is signalled through this flag and
    // re-raised by the scenario loop after chat() returns or throws.
    let STOP_REASON = null;
    let ACTIVE = false;     // true only while a measured chat() call runs
    let STRAY = 0;          // requests attempted outside a measured call (blocked)
    let dryScenario = null;
    const dryResponse = (parsedBody) => {
        const round = REQ.length + 1; // this request's 1-based index in the scenario
        const content = [{ type: 'thinking', thinking: '', signature: `SIG-dry-${round}-` + 'z'.repeat(16) }];
        let stop = 'tool_use';
        if (process.env.MEASURE_DRY_THROW === '1' && round === 2) {
            return { status: 400, data: { type: 'error', error: { type: 'invalid_request_error', message: 'dry-run injected error' } } };
        }
        if (dryScenario === 'long' && round <= 8) {
            const page = process.env.MEASURE_DRY_BAD === '1' && round === 3 ? 5 : round;
            content.push({ type: 'tool_use', id: `toolu_dry_${round}`, name: 'read_doc', input: { page } });
        } else if (dryScenario === 'fanout' && round === 1) {
            for (const r of ['north', 'south', 'east', 'west', 'central', process.env.MEASURE_DRY_BAD_REGION === '1' ? 'atlantis' : 'coastal']) content.push({ type: 'tool_use', id: `toolu_dry_${r}`, name: 'fetch_report', input: { region: r } });
        } else {
            content.push({ type: 'text', text: 'Dry-run final answer.' });
            stop = 'end_turn';
        }
        void parsedBody;
        return { status: 200, data: { id: `msg_dry_${round}`, type: 'message', role: 'assistant', model: currentModel, content, stop_reason: stop,
            usage: { input_tokens: 100, output_tokens: 10, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 } } };
    };
    const transport = async (opts, body) => {
        if (!ACTIVE) { STRAY++; throw new Error('stray request blocked (outside a measured chat call)'); }
        if (STOP_REASON) throw new Error('stopped');
        if (remaining <= 0) { STOP_REASON = 'request cap reached'; throw new Error(STOP_REASON); }
        remaining--;
        const raw = typeof body === 'string' ? body : JSON.stringify(body);
        let parsedBody = null; try { parsedBody = JSON.parse(raw); } catch (_) {}
        let replayed = 0;
        if (parsedBody) for (const m of parsedBody.messages || []) if (m.role === 'assistant' && Array.isArray(m.content)) replayed += m.content.filter((b) => b.type === 'thinking' || b.type === 'redacted_thinking').length;
        const t0 = Date.now();
        let res;
        try { res = DRY ? dryResponse(parsedBody) : await realHttp.httpStreamingRequest(opts, raw); } catch (e) {
            REQ.push({ status: 'net', bytes: raw.length, ms: Date.now() - t0, replayed, err: scrub(e && e.message) });
            process.stderr.write(`  [${VERSION}] request failed: ${scrub(e && e.message)}\n`);
            throw e;
        }
        const ms = Date.now() - t0;
        const u = (res && res.data && res.data.usage) || {};
        const it = res && res.data && Array.isArray(res.data.input_transformations) ? res.data.input_transformations : null;
        const rec = {
            status: res.status, bytes: raw.length, ms, replayed,
            bind: !!(parsedBody && parsedBody.thinking && parsedBody.thinking.block_binding),
            toolChoice: parsedBody && parsedBody.tool_choice ? parsedBody.tool_choice.type : null,
            tools: parsedBody && Array.isArray(parsedBody.tools) ? parsedBody.tools.length : 0,
            msgs: parsedBody && Array.isArray(parsedBody.messages) ? parsedBody.messages.length : 0,
            input: u.input_tokens || 0, output: u.output_tokens || 0,
            cacheRead: u.cache_read_input_tokens || 0, cacheWrite: u.cache_creation_input_tokens || 0,
            stop: res.status === 200 && res.data ? String(res.data.stop_reason || '') + (res.data.stop_details && res.data.stop_details.category ? ':' + res.data.stop_details.category : '') : '',
            drops: it ? it.filter((t) => t && t.type === 'thinking_dropped').length : null,
            thinkingOut: res.status === 200 && res.data && Array.isArray(res.data.content) ? res.data.content.filter((b) => b.type === 'thinking').length : 0,
            toolUses: res.status === 200 && res.data && Array.isArray(res.data.content) ? res.data.content.filter((b) => b.type === 'tool_use').length : 0,
            err: res.status !== 200 ? scrub((res.data && res.data.error && res.data.error.message) || (typeof res.data === 'string' ? res.data : '')) : '',
        };
        REQ.push(rec);
        process.stderr.write(`  [${VERSION} ${currentModel}] req ${REQ.length} status=${res.status} bytes=${raw.length} in=${rec.input} out=${rec.output} cr=${rec.cacheRead} cw=${rec.cacheWrite} replayed=${replayed} ${ms}ms (cap left ${remaining})\n`);
        if (res.status === 401 || res.status === 403) STOP_REASON = `${res.status}: ${rec.err}`;
        return res;
    };
    stub('http.js', Object.assign({}, realHttp, { httpStreamingRequest: transport }));
    const ai = require(path.join(BUNDLE, 'ai.js'));
    // chat() re-arms its idle-summary timer internally (not through the export), so cancelling
    // around a call cannot stop one armed mid-call from firing inside a long call. This child
    // only measures, so any timer at least as long as the idle timeout is dropped outright:
    // no idle summary can ever run here. Counted, so the suppression is visible.
    const IDLE_MS = Number(ai.IDLE_TIMEOUT_MS) || 10 * 60 * 1000;
    let SUPPRESSED_TIMERS = 0;
    const realSetTimeout = global.setTimeout;
    global.setTimeout = function (fn, delay, ...args) {
        if (Number(delay) >= IDLE_MS) {
            SUPPRESSED_TIMERS++;
            const h = realSetTimeout(() => {}, 0);
            return h;
        }
        return realSetTimeout(fn, delay, ...args);
    };

    // ── deterministic tools ──
    const filler = (seed, n) => {
        const words = ['latency', 'throughput', 'replica', 'quorum', 'shard', 'ledger', 'cache', 'index', 'backoff', 'checkpoint', 'snapshot', 'region'];
        const out = []; let i = seed * 7;
        while (out.join(' ').length < n) out.push(words[(i++ * 5) % words.length] + (i % 9));
        return out.join(' ').slice(0, n);
    };
    const TOOLS = [
        { name: 'read_doc', description: 'Read one page of the design document. Returns the page text and the next page number.',
            input_schema: { type: 'object', properties: { page: { type: 'integer', minimum: 1, maximum: 8 } }, required: ['page'] } },
        { name: 'fetch_report', description: 'Fetch the quarterly operations report for one region.',
            input_schema: { type: 'object', properties: { region: { type: 'string', enum: ['north', 'south', 'east', 'west', 'central', 'coastal'] } }, required: ['region'] } },
    ];
    let TOOL_LOG = [];      // { round, name, input } — round = request index that asked for it
    ai.setChatDeps({
        executeTool: async (name, input) => {
            TOOL_LOG.push({ round: REQ.length, name, input: input || {} });
            if (name === 'read_doc') {
                const p = Math.max(1, Math.min(8, parseInt(input && input.page, 10) || 1));
                return { page: p, of: 8, next: p < 8 ? `Call read_doc with page ${p + 1} next (one page per message).` : 'That was the last page.',
                    text: `Page ${p}: key figure ${p * 17} ms p99 latency; decision D${p}. ` + filler(p, 4000) };
            }
            if (name === 'fetch_report') {
                const r = String(input && input.region || 'north');
                const idx = ['north', 'south', 'east', 'west', 'central', 'coastal'].indexOf(r) + 1;
                return { region: r, revenue_musd: 10 + idx * 3, incidents: idx * 2, summary: `Region ${r}: uptime 99.${90 + idx}%. ` + filler(idx + 20, 18000) };
            }
            return { error: 'unknown tool' };
        },
        getTools: () => TOOLS,
        requestConfirmation: async () => true,
        lastToolUseTime: new Map(),
        lastIncomingMessages: new Map(),
        getMcpStatus: () => [],
    });

    function seedNearCap(chatId) {
        const conv = ai.getConversation(chatId);
        // 2 prior tool groups with large results (aging candidates) + text pairs:
        // 2×4 + 13×2 = 34 messages; the anchor makes 35 (= MAX_HISTORY).
        for (let g = 0; g < 2; g++) {
            conv.push({ role: 'user', content: `Earlier question ${g}: check page ${g + 1}.` });
            conv.push({ role: 'assistant', content: 'Checking.', toolCalls: [{ id: `toolu_seed_${g}`, name: 'read_doc', input: { page: g + 1 } }], reasoningBlocks: [] });
            conv.push({ role: 'tool', toolCallId: `toolu_seed_${g}`, content: JSON.stringify({ page: g + 1, text: filler(90 + g, 5000) }) });
            conv.push({ role: 'assistant', content: `Page ${g + 1} covers decision D${g + 1}.`, reasoningBlocks: [] });
        }
        // MEASURE_SEED=natural: varied everyday exchanges (claude-opus-5 returned
        // stop_reason "refusal" with zero output on the repetitive default seed).
        const NATURAL = [
            ['Can you remind me what time my standup is tomorrow?', 'Your standup is at 09:30, same as every weekday.'],
            ['What is a good name for a cat?', 'Miso, Pixel or Juniper are all popular choices.'],
            ['How many minutes are in 3.5 hours?', 'That is 210 minutes.'],
            ['Translate "good morning" to Georgian.', 'Dila mshvidobisa.'],
            ['Suggest a quick lunch idea.', 'A lentil salad with feta, tomatoes and lemon takes ten minutes.'],
            ['What is the capital of Portugal?', 'Lisbon.'],
            ['Is it going to be cold this weekend?', 'I do not have a live forecast right now, but late autumn weekends are usually cool.'],
            ['Remind me to buy coffee beans.', 'Noted — coffee beans are on your list.'],
            ['What does SLA stand for?', 'Service Level Agreement.'],
            ['Give me a synonym for "quick".', 'Swift.'],
            ['How do I pronounce "quinoa"?', 'KEEN-wah.'],
            ['What year did the first iPhone launch?', '2007.'],
            ['Thanks for the help today!', 'Any time — happy to help.'],
        ];
        for (let i = 0; i < 13; i++) {
            if (process.env.MEASURE_SEED === 'natural') {
                conv.push({ role: 'user', content: NATURAL[i][0] });
                conv.push({ role: 'assistant', content: NATURAL[i][1], reasoningBlocks: [] });
            } else {
                conv.push({ role: 'user', content: `Side question ${i}: what does term ${i} mean?` });
                conv.push({ role: 'assistant', content: `Term ${i} is a placeholder used in the design notes.`, reasoningBlocks: [] });
            }
        }
    }

    const PROMPTS = {
        long: 'Read the whole design document with read_doc: it has 8 pages. Read exactly ONE page per message, in order from page 1 to page 8 — do not request several pages at once. After page 8, give me a 5-bullet summary that cites each decision D1–D8.',
        fanout: 'Call fetch_report for all six regions (north, south, east, west, central, coastal) — all six calls in parallel in ONE message. Then give me a one-paragraph comparison naming the region with the most incidents.',
    };

    // Did the model run the intended workload? Returns null when it did, else a reason.
    function workloadProblem(sc, toolLog) {
        const rounds = new Map();
        for (const t of toolLog) { if (!rounds.has(t.round)) rounds.set(t.round, []); rounds.get(t.round).push(t); }
        const ordered = [...rounds.keys()].sort((a, b) => a - b).map((k) => rounds.get(k));
        if (sc === 'long') {
            if (ordered.length !== 8) return `expected 8 tool rounds, got ${ordered.length}`;
            for (let i = 0; i < 8; i++) {
                const r = ordered[i];
                if (r.length !== 1 || r[0].name !== 'read_doc') return `round ${i + 1}: expected exactly one read_doc, got ${r.map((t) => t.name).join('+') || 'none'}`;
                if (Number(r[0].input.page) !== i + 1) return `round ${i + 1}: expected page ${i + 1}, got page ${r[0].input.page}`;
            }
            return null;
        }
        if (sc === 'fanout') {
            if (ordered.length !== 1) return `expected 1 tool round, got ${ordered.length}`;
            const r = ordered[0];
            const EXPECTED_REGIONS = ['north', 'south', 'east', 'west', 'central', 'coastal'];
            const regions = new Set(r.filter((t) => t.name === 'fetch_report').map((t) => String(t.input.region)));
            const missing = EXPECTED_REGIONS.filter((x) => !regions.has(x));
            if (r.length !== 6 || r.some((t) => t.name !== 'fetch_report') || missing.length) return `expected 6 fetch_report calls covering ${EXPECTED_REGIONS.join('/')}, got ${r.length} call(s); missing: ${missing.join(',') || 'none'}`;
            return null;
        }
        return 'unknown scenario';
    }

    const results = [];
    try {
        for (const model of MODELS) {
            currentModel = model;
            for (const sc of SCENARIOS) {
                const chatId = `m-${VERSION}-${model}-${sc}`;
                if (sc === 'long') seedNearCap(chatId);
                REQ = [];
                TOOL_LOG = [];
                dryScenario = sc;
                const mark = LOGS.length;
                const t0 = Date.now();
                let reply = null; let threw = null;
                // Idle-summary timers from a previous call (or armed on entry/exit of
                // this one) must never fire into a measured window.
                try { ai.cancelAllIdleSummaries(); } catch (_) {}
                ACTIVE = true;
                try { reply = await ai.chat(chatId, PROMPTS[sc]); } catch (e) {
                    threw = scrub(e && e.message);
                } finally {
                    ACTIVE = false;
                    try { ai.cancelAllIdleSummaries(); } catch (_) {}
                }
                const logs = LOGS.slice(mark);
                const problem = workloadProblem(sc, TOOL_LOG);
                const verdict = threw ? 'FAILED' : (problem || !reply ? 'INCONCLUSIVE' : 'OK');
                results.push({
                    version: VERSION, model, scenario: sc, wallMs: Date.now() - t0, requests: REQ, reply: reply ? String(reply) : null, threw,
                    verdict, workload: problem || (reply ? 'ok' : 'no final answer'),
                    toolRounds: TOOL_LOG.reduce((m, t) => { m[t.round] = (m[t.round] || []).concat(`${t.name}(${t.input.page || t.input.region || ''})`); return m; }, {}),
                    heals: logs.filter((l) => /^\[ThinkingBinding\]/.test(l.msg) && l.level === 'WARN').map((l) => l.msg.slice(0, 120)),
                    gate: logs.filter((l) => /^\[ContextBudget\]/.test(l.msg)).map((l) => l.msg.slice(0, 120)),
                    dangerEstimate: logs.filter((l) => /^\[Context\] DANGER/.test(l.msg)).length,
                    trims: logs.filter((l) => /^\[History\]/.test(l.msg)).map((l) => (l.msg.match(/"site":"(\w+)"/) || [])[1]),
                    aging: logs.filter((l) => /^\[Aging\]/.test(l.msg)).length,
                    finalLen: ai.getConversation(chatId).length,
                });
                if (STOP_REASON) throw new Stop(STOP_REASON);
            }
        }
    } catch (e) {
        process.stdout.write(JSON.stringify({ results, stray: STRAY, suppressedTimers: SUPPRESSED_TIMERS, stop: scrub(e && e.message) }) + '\n');
        try { ai.cancelAllIdleSummaries(); } catch (_) {}
        process.exit(3);
    }
    try { ai.cancelAllIdleSummaries(); } catch (_) {}
    process.stdout.write(JSON.stringify({ results, stray: STRAY, suppressedTimers: SUPPRESSED_TIMERS }) + '\n');
    // Non-zero when the run is not a valid measurement: any INCONCLUSIVE row, or a
    // FAILED row on NEW (the version under test). OLD failures are reported only.
    const bad = results.some((x) => x.verdict === 'INCONCLUSIVE' || (x.verdict === 'FAILED' && VERSION === 'NEW'));
    process.exit(bad ? 4 : 0);
}

// ════════════════════════════════════════════════════════════════════════════
// PARENT
// ════════════════════════════════════════════════════════════════════════════
function sum(a, k) { return a.reduce((n, r) => n + (Number(r[k]) || 0), 0); }
function p50(a) { if (!a.length) return 0; const s = [...a].sort((x, y) => x - y); return s[Math.floor((s.length - 1) / 2)]; }

function parent() {
    const oldIdx = process.argv.indexOf('--old');
    const OLD = oldIdx > 0 ? path.resolve(process.argv[oldIdx + 1]) : null;
    if (!OLD || !fs.existsSync(path.join(OLD, 'ai.js'))) {
        console.log('usage: node tests/live/anthropic/bat1664-measure.js --old <path to OLD nodejs-project (git archive 978d108d)>');
        process.exit(2);
    }
    const DRY = process.argv.includes('--dry');
    if (DRY) {
        console.log('DRY RUN — scripted responses, no network, no credentials read');
    } else {
        const key = readKey();
        if (!key) { console.log('STOP: ANTHROPIC_API_KEY not found (path not printed).'); process.exit(2); }
        console.log(`credential: api_key present (len ${key.length}) | cap ${CAP} live requests`);
    }
    const MODELS = process.env.MEASURE_MODELS || 'claude-fable-5-1,claude-opus-5';
    const SCENARIOS = process.env.MEASURE_SCENARIOS || 'long,fanout';
    let remaining = CAP;
    const all = [];
    let stopped = null;
    let stray = 0; let suppressed = 0;
    const VERSIONS = (process.env.MEASURE_VERSIONS || 'OLD,NEW').split(',');
    for (const [version, bundle] of [['OLD', OLD], ['NEW', NEW_BUNDLE]].filter(([v]) => VERSIONS.includes(v))) {
        const r = spawnSync(process.execPath, [__filename, '--child'], {
            env: Object.assign({}, process.env, { M_BUNDLE: bundle, M_VERSION: version, M_MODELS: MODELS, M_SCENARIOS: SCENARIOS, M_REMAINING: String(Math.min(remaining, Math.floor(CAP / 2))), M_DRY: DRY ? '1' : '0' }), // equal share per version
            encoding: 'utf8', maxBuffer: 64 * 1024 * 1024, timeout: 40 * 60 * 1000,
        });
        process.stderr.write(r.stderr || '');
        const line = String(r.stdout || '').trim().split('\n').pop();
        let out = null; try { out = JSON.parse(line); } catch (_) {}
        if (!out) { stopped = `${version} child produced no result (exit ${r.status})`; break; }
        for (const x of out.results || []) { all.push(x); remaining -= x.requests.length; }
        stray += out.stray || 0;
        suppressed += out.suppressedTimers || 0;
        if (out.stop || out.fatal) { stopped = `${version}: ${out.stop || out.fatal}`; break; }
    }

    console.log('\n| scenario | model | ver | verdict | reqs | ok | wire KB | input | output | cache read | cache write | latency s (total / p50) | replayed (max) | bind | drops | heals | gate | trims | aging | final |');
    console.log('|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|');
    for (const x of all) {
        const q = x.requests;
        const okN = q.filter((r) => r.status === 200).length;
        const lat = q.map((r) => r.ms);
        const replayedMax = q.reduce((m, r) => Math.max(m, r.replayed || 0), 0);
        const binds = q.filter((r) => r.bind).length;
        const drops = q.reduce((n, r) => n + (r.drops || 0), 0);
        const trimSites = x.trims.reduce((m, s) => { m[s] = (m[s] || 0) + 1; return m; }, {});
        const final = x.reply ? `yes (${x.reply.length} ch)` : `NO${x.threw ? ' — ' + x.threw : ''}`;
        console.log(`| ${x.scenario} | ${x.model} | ${x.version} | ${x.verdict}${x.verdict === 'OK' ? '' : ' (' + (x.threw || x.workload) + ')'} | ${q.length} | ${okN} | ${(sum(q, 'bytes') / 1024).toFixed(0)} | ${sum(q, 'input')} | ${sum(q, 'output')} | ${sum(q, 'cacheRead')} | ${sum(q, 'cacheWrite')} | ${(sum(q, 'ms') / 1000).toFixed(1)} / ${(p50(lat) / 1000).toFixed(1)} | ${replayedMax} | ${binds} | ${drops} | ${x.heals.length} | ${x.gate.length} | ${JSON.stringify(trimSites)} | ${x.aging} | ${final} |`);
    }
    console.log('\nPer-request detail (status bytes in/out/cr/cw replayed tool_uses):');
    for (const x of all) {
        console.log(`  ${x.version} ${x.model} ${x.scenario}: ` + x.requests.map((r) => `${r.status}:${(r.bytes / 1024).toFixed(0)}K:${r.input}/${r.output}/${r.cacheRead}/${r.cacheWrite}:r${r.replayed}:t${r.toolUses}:${r.stop || '-'}${r.err ? ' ERR ' + r.err : ''}`).join('  '));
        if (x.heals.length) console.log(`     heals: ${x.heals.join(' || ')}`);
        if (x.gate.length) console.log(`     gate: ${x.gate.join(' || ')}`);
        if (x.reply) console.log(`     final: ${x.reply.replace(/\s+/g, ' ').slice(0, 160)}…`);
    }
    const total = all.reduce((n, x) => n + x.requests.length, 0);
    console.log(`\n${DRY ? 'dry' : 'live'} requests: ${total} / cap ${CAP} | stray requests blocked: ${stray} | idle-summary timers suppressed: ${suppressed}`);
    const inconclusive = all.filter((x) => x.verdict === 'INCONCLUSIVE');
    const newFailed = all.filter((x) => x.verdict === 'FAILED' && x.version === 'NEW');
    const oldFailed = all.filter((x) => x.verdict === 'FAILED' && x.version === 'OLD');
    if (oldFailed.length) console.log(`OLD failures (reported, not failing the run): ${oldFailed.map((x) => `${x.model}/${x.scenario}`).join(', ')}`);
    if (inconclusive.length || newFailed.length) {
        console.log(`NOT A VALID MEASUREMENT: ${inconclusive.length} inconclusive row(s), ${newFailed.length} failed NEW row(s)`);
        process.exitCode = 1;
    }
    if (stopped) { console.log(`STOPPED: ${stopped}`); process.exitCode = 3; }
}

if (process.argv.includes('--child')) child().catch((e) => { process.stdout.write(JSON.stringify({ fatal: scrub(e && e.stack ? e.stack : e) }) + '\n'); process.exit(1); });
else parent();
