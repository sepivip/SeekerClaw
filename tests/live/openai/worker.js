// tests/live/openai/worker.js
// ─────────────────────────────────────────────────────────────────────────────
// CHILD worker (one process per auth mode). Its process.argv[2] is the fixture
// workDir, so require('<bundle>/config') finds workDir/config.json and boots the
// REAL agent stack for THIS auth mode.
//
// WHY ONE PROCESS PER MODE: providers/openai.js freezes `isOAuth` (and the
// `endpoint` object) at module-load time from OPENAI_AUTH_TYPE. A single process
// can therefore only ever be api_key OR oauth — never both. The parent forks one
// worker per mode.
//
// The worker imports the REAL modules and builds the wire body the EXACT way the
// agent does (ai.js chat() seam), then either:
//   • --self-check : validates the body's wire shape offline — no OpenAI/external
//                    network (a fire-and-forget localhost bridge probe during prompt
//                    assembly fails silently), OR
//   • live         : POSTs each model's body via the REAL httpOpenAIStreamingRequest.
//
// It reports back via IPC (process.send) when forked, else prints JSON to stdout.
'use strict';

const path = require('path');

// ── Resolve the real nodejs-project bundle (…/app/src/main/assets/nodejs-project)
const BUNDLE = path.resolve(__dirname, '..', '..', '..', 'app', 'src', 'main', 'assets', 'nodejs-project');
const req = (m) => require(path.join(BUNDLE, m));

const { redact, redactIn } = require('../_shared/env');

// ── Control inputs (from the parent via env; argv[2] is reserved for workDir) ──
const MODE = (process.env.SC_MODE || 'apikey').toLowerCase();           // 'apikey' | 'oauth'
const SELF_CHECK = process.env.SC_SELF_CHECK === '1';
const DIAGNOSE = process.env.SC_DIAGNOSE === '1';
const LIVE = process.env.SC_LIVE === '1';
const BASE_URL = (process.env.SC_BASE_URL || '').trim();
const MODELS = (process.env.SC_MODELS || '').split(',').map((s) => s.trim()).filter(Boolean);
const PROMPT = process.env.SC_PROMPT || 'Reply with the single word: pong';

// Reasoning-ladder for --diagnose. Clearly BEYOND agent parity: the agent only
// ever sends medium/auto (or suppresses via reasoningMode:'off'). gpt-5.6
// reportedly adds 'max'. 'none' is a probe of the omit-vs-none boundary.
const REASONING_LADDER = ['none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'];

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
let cfg, adapter, TOOLS, ai, reasoningSupportFor, httpOpenAIStreamingRequest;
try {
    cfg = req('config');                                   // reads workDir/config.json (argv[2])
    ({ reasoningSupportFor } = req('model-catalog'));
    const providers = req('providers');
    adapter = providers.getAdapter('openai');
    ({ TOOLS } = req(path.join('tools', 'index')));        // REAL 64-tool telegram registry
    ai = req('ai');
    ({ httpOpenAIStreamingRequest } = req('http'));
} catch (e) {
    fail('boot', e);
}

// Sanity: the fixture must actually have booted OpenAI in the expected mode.
if (!cfg || cfg.PROVIDER !== 'openai') fail('boot', new Error(`fixture provider is "${cfg && cfg.PROVIDER}", expected "openai"`));
if (!adapter || adapter.id !== 'openai') fail('boot', new Error('openai adapter did not resolve'));

const expectedAuth = MODE === 'oauth' ? 'oauth' : 'api_key';
if (cfg.OPENAI_AUTH_TYPE !== expectedAuth) {
    fail('boot', new Error(`OPENAI_AUTH_TYPE is "${cfg.OPENAI_AUTH_TYPE}", expected "${expectedAuth}" (fixture/mode mismatch)`));
}

// Populate the redaction set now that config is loaded (declared above so fail() can
// use it even during boot). Defense-in-depth; the built body itself carries none.
SECRETS = [cfg.OPENAI_KEY, cfg.OPENAI_OAUTH_TOKEN, cfg.OPENAI_OAUTH_REFRESH, cfg.BOT_TOKEN].filter(Boolean);

// ── The seam: build the body the EXACT way ai.js chat() does ──────────────────
// Mirrors ai.js:
//   2455  const { stable, dynamic } = buildSystemBlocks(matchedSkills, chatId, activeModel)
//   2487  formatSystemPrompt(stablePrompt, dynamicPrompt + resumeBlock, AUTH_TYPE)
//   2566  rawTools = _deps.getTools()   (== TOOLS here; no MCP in the harness)
//   2567  formatTools(rawTools)
//   2663  requestOptions = { reasoningEnabled, reasoningSupport, customEchoOverride, reasoningMode, synthetic }
//   2745  toApiMessages(messages, activeModel, requestOptions)
//   2746  formatRequest(activeModel, 4096, systemBlocks, apiMessages, formattedTools, requestOptions)
function buildRequestOptions(model, { heartbeat = false } = {}) {
    // Live runtime-state read, exactly like ai.js (reasoningEnabled / customEchoReasoning).
    const rt = (() => {
        try { return cfg.runtimeState ? cfg.runtimeState.read() : null; } catch (_) { return null; }
    })();
    return {
        reasoningEnabled: !!(rt && rt.reasoningEnabled),
        reasoningSupport: reasoningSupportFor('openai', model, cfg.OPENAI_AUTH_TYPE),
        customEchoOverride: !!(rt && rt.customEchoReasoning),
        // A normal turn is 'normal'; a heartbeat/synthetic turn is 'off' (suppresses
        // the OPTIONAL user-toggle reasoning only — the OAuth/Codex transport-required
        // reasoning stays regardless, per the adapter).
        reasoningMode: heartbeat ? 'off' : 'normal',
        synthetic: heartbeat ? 'heartbeat' : null,
    };
}

function buildBody(model, { heartbeat = false, reasoningEffortOverride = null } = {}) {
    // Deterministic wallet block: seed a "no burner configured" snapshot so the
    // Wallets section is STABLE. Note (Copilot): buildSystemBlocks() still fires a
    // fire-and-forget /burner/status probe at the localhost bridge — but there is no
    // bridge server here, so it fails silently and does NOT overwrite this seeded
    // snapshot (the probe is why the self-check is "no EXTERNAL network", not literally
    // "no sockets").
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
        instructions: systemBlocks,
        toolCount: formattedTools.length,
        requestOptions,
    };
}

// BEYOND-PARITY mutation for --diagnose. Post-mutates reasoning.effort on the
// already-built (real) body. If the agent didn't include a `reasoning` block
// (api_key non-codex), we synthesize one so the ladder can be explored.
function applyReasoningEffort(bodyObj, effort) {
    const clone = JSON.parse(JSON.stringify(bodyObj));
    const base = clone.reasoning && typeof clone.reasoning === 'object' ? clone.reasoning : { summary: 'auto' };
    clone.reasoning = { ...base, effort };
    return clone;
}

// A compact, readable render of a (large) Responses body: abbreviate the 50KB+
// `instructions` and the 64-entry `tools`, keep the wire-critical fields verbatim.
function renderBody(bodyObj, instructions, toolCount) {
    const instr = String(instructions || bodyObj.instructions || '');
    const head = instr.slice(0, 600);
    const tail = instr.length > 900 ? instr.slice(-260) : '';
    const abbrevInstr = tail
        ? `${head}\n        … [${instr.length} chars total; middle elided] …\n${tail}`
        : instr;
    const toolNames = Array.isArray(bodyObj.tools) ? bodyObj.tools.slice(0, 8).map((t) => t.name) : [];
    const view = {
        model: bodyObj.model,
        stream: bodyObj.stream,
        max_output_tokens: ('max_output_tokens' in bodyObj) ? bodyObj.max_output_tokens : '‹absent›',
        store: ('store' in bodyObj) ? bodyObj.store : '‹absent›',
        reasoning: ('reasoning' in bodyObj) ? bodyObj.reasoning : '‹absent›',
        include: ('include' in bodyObj) ? bodyObj.include : '‹absent›',
        instructions: `‹string len=${instr.length}›`,
        input: bodyObj.input,
        tools: `‹array len=${toolCount != null ? toolCount : (bodyObj.tools || []).length}; first8=${JSON.stringify(toolNames)}›`,
    };
    return {
        keys: Object.keys(bodyObj),
        critical: view,
        instructionsAbbrev: redactIn(abbrevInstr, SECRETS),
    };
}

// ── Offline self-check ────────────────────────────────────────────────────────
function selfCheck() {
    const asserts = [];
    const A = (name, ok, detail) => asserts.push({ name, ok: !!ok, detail: detail == null ? '' : String(detail) });

    const built = buildBody(cfg.MODEL, { heartbeat: false });
    const b = built.bodyObj;
    const ep = adapter.endpoint; // module-level object {hostname, path}
    const instr = built.instructions;

    // ── Common wire-shape assertions (both modes) ─────────────────────────────
    A('stream === true', b.stream === true, `stream=${b.stream}`);
    A('instructions is a non-empty string', typeof b.instructions === 'string' && b.instructions.length > 0, `len=${(b.instructions || '').length}`);
    A('input is a non-empty array', Array.isArray(b.input) && b.input.length > 0, `input.length=${(b.input || []).length}`);
    A('tools length === real TOOLS length', Array.isArray(b.tools) && b.tools.length === TOOLS.length && b.tools.length > 0, `body.tools=${(b.tools || []).length} TOOLS=${TOOLS.length}`);
    const allFn = Array.isArray(b.tools) && b.tools.every((t) => t && t.type === 'function' && typeof t.name === 'string' && t.name.length > 0);
    A('every tool is {type:"function", name:string}', allFn, allFn ? 'all ok' : 'a tool is malformed');

    // ── System prompt reflects the SEEDED MOCK WORKSPACE (the whole point) ────
    A('prompt has real Identity section marker', instr.includes('You are a personal AI agent running inside SeekerClaw'), 'identity line present');
    A('prompt has a Tooling/Architecture marker', instr.includes('## Architecture') || instr.includes('Tooling'), 'structural section present');
    A('prompt embeds seeded IDENTITY.md (TestBot)', instr.includes('IDENTITY.md') && instr.includes('TestBot'), 'IDENTITY.md + TestBot present');
    A('prompt embeds seeded USER.md (Test User)', instr.includes('USER.md') && instr.includes('Test User'), 'USER.md + Test User present');
    A('prompt embeds seeded MEMORY.md line', instr.includes('BAT-1144 OpenAI live-model harness') || instr.includes('synthetic preference'), 'MEMORY.md content present');

    // ── Mode-specific assertions ──────────────────────────────────────────────
    if (MODE === 'oauth') {
        A('endpoint === chatgpt.com/backend-api/codex/responses', ep.hostname === 'chatgpt.com' && ep.path === '/backend-api/codex/responses', `${ep.hostname}${ep.path}`);
        A('store === false', b.store === false, `store=${JSON.stringify(b.store)}`);
        A('NO max_output_tokens', !('max_output_tokens' in b), `present=${'max_output_tokens' in b}`);
        const r = b.reasoning;
        A('reasoning === {effort:"medium", summary:"auto"}', r && r.effort === 'medium' && r.summary === 'auto', JSON.stringify(r));
        A("include === ['reasoning.encrypted_content']", Array.isArray(b.include) && b.include.length === 1 && b.include[0] === 'reasoning.encrypted_content', JSON.stringify(b.include));
    } else {
        A('endpoint === api.openai.com/v1/responses', ep.hostname === 'api.openai.com' && ep.path === '/v1/responses', `${ep.hostname}${ep.path}`);
        A('has max_output_tokens (=== 4096)', b.max_output_tokens === 4096, `max_output_tokens=${b.max_output_tokens}`);
        A('NO store', !('store' in b), `present=${'store' in b}`);
        // Reasoning on the api_key transport is model-dependent (Copilot): a `*-codex`
        // model is transport-required to send `reasoning` even on api.openai.com, while
        // a non-codex model with reasoningEnabled:false sends none. Mirror the real
        // adapter's `wantReasoning = isOAuth || model.includes('codex') || userToggle`.
        const isCodex = String(cfg.MODEL || '').includes('codex');
        if (isCodex) {
            A('reasoning present (api_key + codex → transport-required)',
                b.reasoning && b.reasoning.effort === 'medium' && b.reasoning.summary === 'auto', JSON.stringify(b.reasoning));
            A("include === ['reasoning.encrypted_content'] (codex)",
                Array.isArray(b.include) && b.include[0] === 'reasoning.encrypted_content', JSON.stringify(b.include));
        } else {
            A('NO reasoning (api_key non-codex, reasoning toggle off)', !('reasoning' in b), `present=${'reasoning' in b}`);
        }
    }

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
    const ep = adapter.endpoint;
    if (!BASE_URL) return { protocol: ep.protocol, hostname: ep.hostname, port: ep.port, path: ep.path };
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
        return { protocol: ep.protocol, hostname: ep.hostname, port: ep.port, path: ep.path };
    }
}

async function liveOne(model, bodyStr) {
    const ep = resolveEndpoint();
    const apiKey = cfg.OPENAI_KEY; // ignored by buildHeaders on the oauth path
    const headers = adapter.buildHeaders(apiKey, cfg.AUTH_TYPE);
    const options = {
        protocol: ep.protocol, hostname: ep.hostname, port: ep.port, path: ep.path,
        method: 'POST', headers, timeout: 60000,
    };
    const started = Date.now();
    try {
        const res = await httpOpenAIStreamingRequest(options, bodyStr);
        const latencyMs = Date.now() - started;
        let text = '', toolCalls = 0;
        try {
            const parsed = adapter.fromApiResponse(res.data);
            text = (parsed.text || '').slice(0, 80);
            toolCalls = (parsed.toolCalls || []).length;
        } catch (_) { /* non-200 data may not parse to Responses shape */ }
        const errBody = res.status === 200 ? '' : redactIn(typeof res.data === 'string' ? res.data.slice(0, 300) : JSON.stringify(res.data).slice(0, 300), SECRETS);
        return { model, status: res.status, ok: res.status === 200 && (!!text || toolCalls > 0), text, toolCalls, latencyMs, errBody };
    } catch (e) {
        return { model, status: -1, ok: false, text: '', toolCalls: 0, latencyMs: Date.now() - started, errBody: redactIn(e.message, SECRETS) };
    }
}

async function liveSweep() {
    // Default the model set from the mode's registry list if none supplied.
    const models = MODELS.length ? MODELS : defaultModelsForMode();
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
    // Optionally list what THIS credential can actually see (/v1/models) for the
    // registry show/hide comparison the parent assembles.
    const listed = await listModels();
    send({ mode: MODE, live: { endpoint: { hostname: endpoint.hostname, path: endpoint.path }, results, listedModels: listed } });
    process.exit(0);
}

function defaultModelsForMode() {
    // Kept in sync with model-registry.json (the parent passes SC_MODELS in
    // practice; this is the fallback if it doesn't).
    return MODE === 'oauth'
        ? ['gpt-5.5', 'gpt-5.4', 'gpt-5.4-mini', 'gpt-5.3-codex']
        : ['gpt-5.5', 'gpt-5.4', 'gpt-5.3-codex'];
}

// GET /v1/models via the adapter's testEndpoint (api.openai.com/v1/models) — used
// only in live mode. On the OAuth path this may 403 on first touch even when chat
// works; we surface that rather than treat it as authoritative.
function listModels() {
    return new Promise((resolve) => {
        const https = require('https');
        const apiKey = cfg.OPENAI_KEY;
        const headers = adapter.buildHeaders(apiKey, cfg.AUTH_TYPE);
        const te = adapter.testEndpoint; // { hostname:'api.openai.com', path:'/v1/models', method:'GET' }
        const request = https.request({ hostname: te.hostname, path: te.path, method: 'GET', headers, timeout: 30000 }, (res) => {
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
