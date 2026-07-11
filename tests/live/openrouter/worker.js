// tests/live/openrouter/worker.js
// ─────────────────────────────────────────────────────────────────────────────
// CHILD worker (single auth mode: api_key). Its process.argv[2] is the fixture
// workDir, so require('<bundle>/config') finds workDir/config.json and boots the
// REAL agent stack for OpenRouter.
//
// OpenRouter has ONE auth mode (api_key) — there is no OAuth/Codex fork like
// OpenAI. The parent forks exactly one worker.
//
// The worker imports the REAL modules and builds the wire body the EXACT way the
// agent does (ai.js chat() seam), then either:
//   • --self-check : validates the Chat Completions body's wire shape offline — no
//                    OpenRouter/external network (a fire-and-forget localhost
//                    bridge probe during prompt assembly fails silently), OR
//   • live         : POSTs each model's body via the REAL
//                    httpChatCompletionsStreamingRequest.
//
// It reports back via IPC (process.send) when forked, else prints JSON to stdout.
'use strict';

const path = require('path');

// ── Resolve the real nodejs-project bundle (…/app/src/main/assets/nodejs-project)
const BUNDLE = path.resolve(__dirname, '..', '..', '..', 'app', 'src', 'main', 'assets', 'nodejs-project');
const req = (m) => require(path.join(BUNDLE, m));

const { redact, redactIn } = require('../_shared/env');

// ── Control inputs (from the parent via env; argv[2] is reserved for workDir) ──
const MODE = 'apikey'; // OpenRouter is single-mode; kept for symmetry with the OpenAI harness.
const SELF_CHECK = process.env.SC_SELF_CHECK === '1';
const DIAGNOSE = process.env.SC_DIAGNOSE === '1';
const LIVE = process.env.SC_LIVE === '1';
const BASE_URL = (process.env.SC_BASE_URL || '').trim();
const MODELS = (process.env.SC_MODELS || '').split(',').map((s) => s.trim()).filter(Boolean);
const PROMPT = process.env.SC_PROMPT || 'Reply with the single word: pong';

// Reasoning-ladder for --diagnose. Clearly BEYOND agent parity: on OpenRouter the
// agent only ever sends reasoning:{effort:'none'} (synthetic/heartbeat turns) or
// omits the field entirely (reasoningSupport resolves to 'unknown' for every
// OR-prefixed model id, so the user toggle is a no-op). The ladder explores the
// documented OpenRouter reasoning.effort values.
const REASONING_LADDER = ['none', 'low', 'medium', 'high'];

// Secrets to scrub from ANY printed/IPC'd text (CodeRabbit). Declared with `let`
// BEFORE the boot block so fail() can reference it without a TDZ (empty pre-boot —
// boot errors are config-load failures that don't echo a token); populated once the
// fixture config is loaded (below).
let SECRETS = [];

function send(result) {
    if (typeof process.send === 'function') process.send(result);
    else process.stdout.write(JSON.stringify(result, null, 2) + '\n');
}

function fail(stage, err) {
    const raw = err && err.stack ? err.stack.split('\n').slice(0, 4).join(' | ') : String(err);
    // Redact in case a runtime error (e.g. an auth failure) echoes a credential —
    // upholds the harness's "tokens are NEVER printed" guarantee.
    send({ mode: MODE, error: `[${stage}] ${redactIn(raw, SECRETS)}` });
    process.exit(3);
}

// ── Boot the real stack ───────────────────────────────────────────────────────
let cfg, adapter, TOOLS, ai, reasoningSupportFor, httpChatCompletionsStreamingRequest;
try {
    cfg = req('config');                                   // reads workDir/config.json (argv[2])
    ({ reasoningSupportFor } = req('model-catalog'));
    const providers = req('providers');
    adapter = providers.getAdapter('openrouter');
    ({ TOOLS } = req(path.join('tools', 'index')));        // REAL 64-tool telegram registry
    ai = req('ai');
    ({ httpChatCompletionsStreamingRequest } = req('http'));
} catch (e) {
    fail('boot', e);
}

// Sanity: the fixture must actually have booted OpenRouter in api_key mode.
if (!cfg || cfg.PROVIDER !== 'openrouter') fail('boot', new Error(`fixture provider is "${cfg && cfg.PROVIDER}", expected "openrouter"`));
if (!adapter || adapter.id !== 'openrouter') fail('boot', new Error('openrouter adapter did not resolve'));
if (cfg.AUTH_TYPE !== 'api_key') fail('boot', new Error(`AUTH_TYPE is "${cfg.AUTH_TYPE}", expected "api_key" (fixture/mode mismatch)`));

// Populate the redaction set now that config is loaded (declared above so fail() can
// use it even during boot). Defense-in-depth; the built body itself carries none.
SECRETS = [cfg.OPENROUTER_KEY, cfg.BOT_TOKEN].filter(Boolean);

// ── The seam: build the body the EXACT way ai.js chat() does ──────────────────
// Mirrors ai.js:
//   buildSystemBlocks(matchedSkills, chatId, activeModel)
//   formatSystemPrompt(stablePrompt, dynamicPrompt + resumeBlock, AUTH_TYPE)
//   formatTools(rawTools)   (rawTools == TOOLS here; no MCP in the harness)
//   requestOptions = { reasoningEnabled, reasoningSupport, customEchoOverride, reasoningMode, synthetic }
//   toApiMessages(messages, activeModel, requestOptions)
//   formatRequest(activeModel, 4096, systemBlocks, apiMessages, formattedTools, requestOptions)
function buildRequestOptions(model, { heartbeat = false } = {}) {
    // Live runtime-state read, exactly like ai.js (reasoningEnabled / customEchoReasoning).
    const rt = (() => {
        try { return cfg.runtimeState ? cfg.runtimeState.read() : null; } catch (_) { return null; }
    })();
    return {
        reasoningEnabled: !!(rt && rt.reasoningEnabled),
        reasoningSupport: reasoningSupportFor('openrouter', model, cfg.AUTH_TYPE),
        customEchoOverride: !!(rt && rt.customEchoReasoning),
        // A normal turn is 'normal'; a heartbeat/synthetic turn is 'off' (on
        // OpenRouter that emits reasoning:{effort:'none'} as an explicit disable).
        reasoningMode: heartbeat ? 'off' : 'normal',
        synthetic: heartbeat ? 'heartbeat' : null,
    };
}

function buildBody(model, { heartbeat = false, reasoningEffortOverride = null } = {}) {
    // Deterministic wallet block: seed a "no burner configured" snapshot so the
    // Wallets section is STABLE. buildSystemBlocks() still fires a fire-and-forget
    // /burner/status probe at the localhost bridge — but there is no bridge server
    // here, so it fails silently and does NOT overwrite this seeded snapshot (the
    // probe is why the self-check is "no EXTERNAL network", not literally "no sockets").
    ai._setWalletPromptSnapshotForTests({ configured: false });

    const { stable, dynamic } = ai.buildSystemBlocks([], null, model);
    const resumeBlock = ''; // normal (non-resume) turn
    const systemBlocks = adapter.formatSystemPrompt(stable, dynamic + resumeBlock, cfg.AUTH_TYPE);

    const formattedTools = adapter.formatTools(TOOLS);
    const requestOptions = buildRequestOptions(model, { heartbeat });
    const apiMessages = adapter.toApiMessages([{ role: 'user', content: PROMPT }], model, requestOptions);
    const bodyStr = adapter.formatRequest(model, 4096, systemBlocks, apiMessages, formattedTools, requestOptions);

    let bodyObj = JSON.parse(bodyStr);
    if (reasoningEffortOverride) bodyObj = applyReasoningEffort(bodyObj, reasoningEffortOverride);

    return {
        model,
        bodyObj,
        bodyStr: reasoningEffortOverride ? JSON.stringify(bodyObj) : bodyStr,
        systemPrompt: systemBlocks,
        toolCount: formattedTools.length,
        requestOptions,
    };
}

// BEYOND-PARITY mutation for --diagnose. Post-mutates reasoning.effort on the
// already-built (real) body per OpenRouter's reasoning-tokens contract.
function applyReasoningEffort(bodyObj, effort) {
    const clone = JSON.parse(JSON.stringify(bodyObj));
    clone.reasoning = { effort };
    return clone;
}

// A compact, readable render of a (large) Chat Completions body: abbreviate the
// 50KB+ system message + the 64-entry tools, keep the wire-critical fields verbatim.
function renderBody(bodyObj, systemPrompt, toolCount) {
    const instr = String(systemPrompt || '');
    const head = instr.slice(0, 600);
    const tail = instr.length > 900 ? instr.slice(-260) : '';
    const abbrevInstr = tail
        ? `${head}\n        … [${instr.length} chars total; middle elided] …\n${tail}`
        : instr;
    const toolNames = Array.isArray(bodyObj.tools)
        ? bodyObj.tools.slice(0, 8).map((t) => t && t.function && t.function.name)
        : [];
    const msgs = Array.isArray(bodyObj.messages) ? bodyObj.messages : [];
    const msgView = msgs.map((m) => ({
        role: m.role,
        content: typeof m.content === 'string' ? `‹string len=${m.content.length}›` : m.content,
    }));
    const view = {
        model: ('model' in bodyObj) ? bodyObj.model : '‹absent›',
        models: ('models' in bodyObj) ? bodyObj.models : '‹absent›',
        stream: bodyObj.stream,
        max_tokens: ('max_tokens' in bodyObj) ? bodyObj.max_tokens : '‹absent›',
        cache_control: ('cache_control' in bodyObj) ? bodyObj.cache_control : '‹absent›',
        reasoning: ('reasoning' in bodyObj) ? bodyObj.reasoning : '‹absent›',
        messages: msgView,
        tools: `‹array len=${toolCount != null ? toolCount : (bodyObj.tools || []).length}; first8=${JSON.stringify(toolNames)}›`,
    };
    return {
        keys: Object.keys(bodyObj),
        critical: view,
        systemPromptAbbrev: redactIn(abbrevInstr, SECRETS),
    };
}

// ── Offline self-check ────────────────────────────────────────────────────────
function selfCheck() {
    const asserts = [];
    const A = (name, ok, detail) => asserts.push({ name, ok: !!ok, detail: detail == null ? '' : String(detail) });

    const built = buildBody(cfg.MODEL, { heartbeat: false });
    const b = built.bodyObj;
    const ep = adapter.endpoint; // module-level object { hostname, path }
    const instr = built.systemPrompt;
    const msgs = Array.isArray(b.messages) ? b.messages : [];
    const sysMsg = msgs[0] || {};

    // ── Common Chat Completions wire-shape assertions ─────────────────────────
    A('stream === true', b.stream === true, `stream=${b.stream}`);
    A('max_tokens === 4096', b.max_tokens === 4096, `max_tokens=${b.max_tokens}`);
    A('model === fixture model', b.model === cfg.MODEL, `model=${b.model}`);
    A('cache_control === {type:"ephemeral"}', b.cache_control && b.cache_control.type === 'ephemeral', JSON.stringify(b.cache_control));
    A('messages is a non-empty array', Array.isArray(b.messages) && b.messages.length > 0, `messages.length=${msgs.length}`);
    A('messages[0] is the system message', sysMsg.role === 'system' && typeof sysMsg.content === 'string' && sysMsg.content.length > 0, `role=${sysMsg.role} len=${(sysMsg.content || '').length}`);
    A('messages[1] is the user turn (PROMPT)', msgs[1] && msgs[1].role === 'user' && msgs[1].content === PROMPT, `role=${msgs[1] && msgs[1].role}`);

    // ── Tools: count + OpenRouter's Chat Completions function shape ────────────
    A('tools length === real TOOLS length', Array.isArray(b.tools) && b.tools.length === TOOLS.length && b.tools.length > 0, `body.tools=${(b.tools || []).length} TOOLS=${TOOLS.length}`);
    const allFn = Array.isArray(b.tools) && b.tools.every((t) =>
        t && t.type === 'function' && t.function && typeof t.function.name === 'string' && t.function.name.length > 0
        && typeof t.function.parameters === 'object' && t.function.parameters !== null);
    A('every tool is {type:"function", function:{name, parameters}}', allFn, allFn ? 'all ok' : 'a tool is malformed');

    // ── No reasoning on a NORMAL turn (OR reasoningSupport is "unknown") ───────
    A('NO reasoning on normal turn', !('reasoning' in b), `present=${'reasoning' in b}`);

    // ── System prompt reflects the SEEDED MOCK WORKSPACE (the whole point) ─────
    A('prompt has real Identity section marker', instr.includes('You are a personal AI agent running inside SeekerClaw'), 'identity line present');
    A('prompt embeds seeded IDENTITY.md (TestBot)', instr.includes('IDENTITY.md') && instr.includes('TestBot'), 'IDENTITY.md + TestBot present');
    A('prompt embeds seeded USER.md (Test User)', instr.includes('USER.md') && instr.includes('Test User'), 'USER.md + Test User present');
    A('prompt embeds seeded MEMORY.md line', instr.includes('BAT-1144 OpenAI live-model harness') || instr.includes('synthetic preference'), 'MEMORY.md content present');

    // ── Endpoint is the REAL OpenRouter endpoint ──────────────────────────────
    A('endpoint === openrouter.ai/api/v1/chat/completions', ep.hostname === 'openrouter.ai' && ep.path === '/api/v1/chat/completions', `${ep.hostname}${ep.path}`);

    // ── HTTP request headers are part of the wire request the device sends ─────
    // Build them from the REAL adapter with the SAME credential the worker uses
    // for this (api_key) mode. buildHeaders(apiKey) ignores AUTH_TYPE for
    // OpenRouter (single-mode), but we pass it for symmetry/intent. Never print
    // the raw key — assert on the "Bearer " scheme prefix, not equality.
    const headers = adapter.buildHeaders(cfg.OPENROUTER_KEY, cfg.AUTH_TYPE);
    const authVal = String(headers.Authorization || '');
    A('header Authorization starts with "Bearer "', authVal.startsWith('Bearer ') && authVal.length > 'Bearer '.length, `scheme=${authVal.slice(0, 7)} len=${authVal.length}`);
    A('header Content-Type === application/json', headers['Content-Type'] === 'application/json', headers['Content-Type']);
    A('header HTTP-Referer === https://seekerclaw.com', headers['HTTP-Referer'] === 'https://seekerclaw.com', headers['HTTP-Referer']);
    A('header X-Title === SeekerClaw', headers['X-Title'] === 'SeekerClaw', headers['X-Title']);

    const pass = asserts.every((a) => a.ok);
    send({
        mode: MODE,
        selfCheck: {
            pass,
            model: cfg.MODEL,
            endpoint: { hostname: ep.hostname, path: ep.path },
            toolCount: built.toolCount,
            asserts,
            render: renderBody(b, instr, built.toolCount),
        },
    });
    process.exit(pass ? 0 : 1);
}

// ── Live sweep ────────────────────────────────────────────────────────────────
function resolveEndpoint() {
    const ep = adapter.endpoint; // { hostname, path } — no protocol/port on OR
    const base = { protocol: ep.protocol || 'https:', hostname: ep.hostname, port: ep.port, path: ep.path };
    if (!BASE_URL) return base;
    try {
        const u = new URL(BASE_URL.includes('://') ? BASE_URL : `https://${BASE_URL}`);
        return {
            protocol: u.protocol || 'https:',
            hostname: u.hostname,
            port: u.port ? parseInt(u.port, 10) : undefined,
            // Keep the adapter's real path (the gateway is expected to proxy it).
            path: ep.path,
        };
    } catch (_) {
        return base;
    }
}

async function liveOne(model, bodyStr) {
    const ep = resolveEndpoint();
    const headers = adapter.buildHeaders(cfg.OPENROUTER_KEY);
    const options = {
        protocol: ep.protocol, hostname: ep.hostname, port: ep.port, path: ep.path,
        method: 'POST', headers, timeout: 60000,
    };
    const started = Date.now();
    try {
        const res = await httpChatCompletionsStreamingRequest(options, bodyStr);
        const latencyMs = Date.now() - started;
        let text = '', toolCalls = 0;
        try {
            const parsed = adapter.fromApiResponse(res.data);
            text = (parsed.text || '').slice(0, 80);
            toolCalls = (parsed.toolCalls || []).length;
        } catch (_) { /* non-200 data may not parse to Chat Completions shape */ }
        const errBody = res.status === 200 ? '' : redactIn(typeof res.data === 'string' ? res.data.slice(0, 300) : JSON.stringify(res.data).slice(0, 300), SECRETS);
        return { model, status: res.status, ok: res.status === 200 && (!!text || toolCalls > 0), text, toolCalls, latencyMs, errBody };
    } catch (e) {
        return { model, status: -1, ok: false, text: '', toolCalls: 0, latencyMs: Date.now() - started, errBody: redactIn(e.message, SECRETS) };
    }
}

async function liveSweep() {
    const models = MODELS.length ? MODELS : [cfg.MODEL];
    const endpoint = resolveEndpoint();
    const results = [];
    for (const model of models) {
        if (DIAGNOSE) {
            // Baseline (exact agent parity) first…
            const base = buildBody(model, { heartbeat: false });
            const baseRes = await liveOne(model, base.bodyStr);
            results.push({ ...baseRes, variant: 'agent-parity (as-sent)' });
            // …then the reasoning ladder (BEYOND parity — param exploration).
            for (const effort of REASONING_LADDER) {
                const v = buildBody(model, { heartbeat: false, reasoningEffortOverride: effort });
                const r = await liveOne(model, v.bodyStr);
                results.push({ ...r, variant: `beyond-parity reasoning.effort=${effort}` });
            }
        } else {
            const built = buildBody(model, { heartbeat: false });
            const r = await liveOne(model, built.bodyStr);
            results.push({ ...r, variant: 'agent-parity (as-sent)' });
        }
    }
    // Optionally list what THIS credential can actually see (/api/v1/models).
    const listed = await listModels();
    send({ mode: MODE, live: { endpoint: { hostname: endpoint.hostname, path: endpoint.path }, results, listedModels: listed } });
    process.exit(0);
}

// GET /api/v1/models via OpenRouter (public list; 200 for any key). Used only in
// live mode for the registry-vs-live comparison.
function listModels() {
    return new Promise((resolve) => {
        const https = require('https');
        const headers = adapter.buildHeaders(cfg.OPENROUTER_KEY);
        const request = https.request({ hostname: 'openrouter.ai', path: '/api/v1/models', method: 'GET', headers, timeout: 30000 }, (res) => {
            let buf = '';
            res.on('data', (c) => (buf += c));
            res.on('end', () => {
                let ids = [];
                try {
                    const j = JSON.parse(buf);
                    if (Array.isArray(j.data)) ids = j.data.map((m) => m.id).sort();
                } catch (_) {}
                resolve({ status: res.statusCode, ids });
            });
        });
        request.on('error', () => resolve({ status: -1, ids: [] }));
        request.setTimeout(30000, () => { request.destroy(); resolve({ status: -2, ids: [] }); });
        request.end();
    });
}

// ── Dispatch ──────────────────────────────────────────────────────────────────
(async function main() {
    try {
        if (SELF_CHECK) return selfCheck();
        if (LIVE) return await liveSweep();
        // No mode selected — nothing to do.
        send({ mode: MODE, error: 'worker invoked without --self-check or SC_LIVE=1' });
        process.exit(3);
    } catch (e) {
        fail('run', e);
    }
})();

// silence unused-var lints for redact (kept in the shared API surface)
void redact;
