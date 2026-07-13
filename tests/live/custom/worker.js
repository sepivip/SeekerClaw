// tests/live/custom/worker.js
// ─────────────────────────────────────────────────────────────────────────────
// CHILD worker for the "custom" provider (a user-configured OpenAI-compatible
// gateway). Its process.argv[2] is the fixture workDir, so require('<bundle>/config')
// finds workDir/config.json and boots the REAL agent stack for THIS gateway config.
//
// WHY A CHILD PROCESS: config.js freezes CUSTOM_ENDPOINT / CUSTOM_FORMAT / CUSTOM_KEY
// at module-load time from config.json (customBaseUrl / customFormat / customApiKey).
// A fresh process per run is the clean way to boot the adapter against a specific
// gateway config. `custom` has a SINGLE auth mode (api_key) — no fork per mode.
//
// The worker imports the REAL modules and builds the wire body the EXACT way the
// agent does (ai.js chat() seam), then either:
//   • --self-check : validates the body's wire shape offline — no external network
//                    (a fire-and-forget localhost bridge probe during prompt
//                    assembly fails silently), OR
//   • live         : POSTs each model's body via the REAL
//                    httpChatCompletionsStreamingRequest transport.
//
// It reports back via IPC (process.send) when forked, else prints JSON to stdout.
'use strict';

const path = require('path');

// ── Resolve the real nodejs-project bundle (…/app/src/main/assets/nodejs-project)
const BUNDLE = path.resolve(__dirname, '..', '..', '..', 'app', 'src', 'main', 'assets', 'nodejs-project');
const req = (m) => require(path.join(BUNDLE, m));

const { redact, redactIn } = require('../_shared/env');

// ── Control inputs (from the parent via env; argv[2] is reserved for workDir) ──
const MODE = 'apikey'; // custom is single-auth (api_key)
const SELF_CHECK = process.env.SC_SELF_CHECK === '1';
const DIAGNOSE = process.env.SC_DIAGNOSE === '1';
const LIVE = process.env.SC_LIVE === '1';
const BASE_URL = (process.env.SC_BASE_URL || '').trim();
const MODELS = (process.env.SC_MODELS || '').split(',').map((s) => s.trim()).filter(Boolean);
const PROMPT = process.env.SC_PROMPT || 'Reply with the single word: pong';

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
    adapter = providers.getAdapter('custom');
    ({ TOOLS } = req(path.join('tools', 'index')));        // REAL 64-tool telegram registry
    ai = req('ai');
    ({ httpChatCompletionsStreamingRequest } = req('http'));
} catch (e) {
    fail('boot', e);
}

// Sanity: the fixture must actually have booted the custom provider.
if (!cfg || cfg.PROVIDER !== 'custom') fail('boot', new Error(`fixture provider is "${cfg && cfg.PROVIDER}", expected "custom"`));
if (!adapter || adapter.id !== 'custom') fail('boot', new Error('custom adapter did not resolve'));
if (cfg.AUTH_TYPE !== 'api_key') fail('boot', new Error(`AUTH_TYPE is "${cfg.AUTH_TYPE}", expected "api_key" (custom is single-auth)`));
// Custom's chat_completions body shape is the one this worker asserts. A gateway
// configured for the Responses API delegates to openai.js and produces a DIFFERENT
// body — out of scope here (that's the openai harness). Fail loudly instead of
// silently asserting the wrong shape.
if (cfg.CUSTOM_FORMAT && cfg.CUSTOM_FORMAT !== 'chat_completions') {
    fail('boot', new Error(`CUSTOM_FORMAT is "${cfg.CUSTOM_FORMAT}", this worker asserts the chat_completions shape only`));
}

// Populate the redaction set now that config is loaded (declared above so fail() can
// use it even during boot). Defense-in-depth; the built body itself carries none.
SECRETS = [cfg.CUSTOM_KEY, cfg.BOT_TOKEN].filter(Boolean);

// ── The seam: build the body the EXACT way ai.js chat() does ──────────────────
// Mirrors ai.js:
//   buildSystemBlocks(matchedSkills, chatId, activeModel)  → { stable, dynamic }
//   formatSystemPrompt(stable, dynamic + resumeBlock, AUTH_TYPE)
//   rawTools = getTools() (== TOOLS here; no MCP in the harness) → formatTools()
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
        reasoningSupport: reasoningSupportFor('custom', model, cfg.AUTH_TYPE),
        // Per-Custom echo override (BAT-549) — read live like ai.js does.
        customEchoOverride: !!(rt && rt.customEchoReasoning),
        // A normal turn is 'normal'; a heartbeat/synthetic turn is 'off'.
        reasoningMode: heartbeat ? 'off' : 'normal',
        synthetic: heartbeat ? 'heartbeat' : null,
    };
}

function buildBody(model, { heartbeat = false } = {}) {
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

    const bodyObj = JSON.parse(bodyStr);

    return {
        model,
        bodyObj,
        bodyStr,
        instructions: systemBlocks,
        toolCount: formattedTools.length,
        requestOptions,
    };
}

// A compact, readable render of a (large) Chat Completions body: abbreviate the
// 50KB+ system message and the 64-entry `tools`, keep the wire-critical fields.
function renderBody(bodyObj, instructions, toolCount) {
    const instr = String(instructions || '');
    const head = instr.slice(0, 600);
    const tail = instr.length > 900 ? instr.slice(-260) : '';
    const abbrevInstr = tail
        ? `${head}\n        … [${instr.length} chars total; middle elided] …\n${tail}`
        : instr;
    const msgs = Array.isArray(bodyObj.messages) ? bodyObj.messages : [];
    const toolNames = Array.isArray(bodyObj.tools)
        ? bodyObj.tools.slice(0, 8).map((t) => (t && t.function && t.function.name) || t.name)
        : [];
    const msgSummary = msgs.map((m) => ({
        role: m.role,
        content: typeof m.content === 'string' ? `‹string len=${m.content.length}›` : m.content,
    }));
    const view = {
        model: bodyObj.model,
        stream: bodyObj.stream,
        max_tokens: ('max_tokens' in bodyObj) ? bodyObj.max_tokens : '‹absent›',
        messages: msgSummary,
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
    const ep = adapter.endpoint; // getter → CUSTOM_ENDPOINT { protocol, hostname, port, path }
    const instr = built.instructions;

    // ── Chat Completions wire-shape assertions ────────────────────────────────
    A('stream === true', b.stream === true, `stream=${b.stream}`);
    A('model === configured model', b.model === cfg.MODEL, `model=${b.model} cfg.MODEL=${cfg.MODEL}`);
    A('max_tokens === 4096', b.max_tokens === 4096, `max_tokens=${b.max_tokens}`);
    A('messages is a non-empty array', Array.isArray(b.messages) && b.messages.length >= 2, `messages.length=${(b.messages || []).length}`);

    const sys = Array.isArray(b.messages) ? b.messages[0] : null;
    A('messages[0] is the system message', sys && sys.role === 'system' && typeof sys.content === 'string' && sys.content.length > 0, `role=${sys && sys.role} len=${sys && typeof sys.content === 'string' ? sys.content.length : 'n/a'}`);
    const hasUser = Array.isArray(b.messages) && b.messages.some((m) => m && m.role === 'user');
    A('messages contains the user turn', hasUser, hasUser ? 'user present' : 'no user message');

    // Tools: length === real TOOLS.length AND every tool matches the chat_completions
    // shape {type:'function', function:{name, description, parameters}}.
    A('tools length === real TOOLS length', Array.isArray(b.tools) && b.tools.length === TOOLS.length && b.tools.length > 0, `body.tools=${(b.tools || []).length} TOOLS=${TOOLS.length}`);
    const allFn = Array.isArray(b.tools) && b.tools.every((t) =>
        t && t.type === 'function' && t.function && typeof t.function.name === 'string' && t.function.name.length > 0
        && t.function.parameters && typeof t.function.parameters === 'object' && !Array.isArray(t.function.parameters));
    A('every tool is {type:"function", function:{name, parameters:{…}}}', allFn, allFn ? 'all ok' : 'a tool is malformed (missing name or parameters object)');

    // ── System prompt reflects the SEEDED MOCK WORKSPACE (the whole point) ────
    const sysContent = sys && typeof sys.content === 'string' ? sys.content : '';
    A('prompt has real Identity section marker', sysContent.includes('You are a personal AI agent running inside SeekerClaw'), 'identity line present');
    A('prompt has an Architecture marker', sysContent.includes('## Architecture'), 'structural section present');
    A('prompt embeds seeded IDENTITY.md (TestBot)', sysContent.includes('IDENTITY.md') && sysContent.includes('TestBot'), 'IDENTITY.md + TestBot present');
    A('prompt embeds seeded USER.md (Test User)', sysContent.includes('USER.md') && sysContent.includes('Test User'), 'USER.md + Test User present');
    A('prompt embeds seeded MEMORY.md line', sysContent.includes('BAT-1144') || sysContent.includes('synthetic preference'), 'MEMORY.md content present');

    // ── Endpoint reflects the seeded customBaseUrl ────────────────────────────
    A('endpoint hostname reflects configured customBaseUrl', ep && typeof ep.hostname === 'string' && ep.hostname.length > 0, `${ep && ep.hostname}${ep && ep.path}`);
    A('endpoint host === cfg.CUSTOM_BASE_URL host', (() => {
        try { return ep.hostname === new URL(cfg.CUSTOM_BASE_URL).hostname; } catch (_) { return false; }
    })(), `endpoint=${ep && ep.hostname} base=${cfg.CUSTOM_BASE_URL}`);
    A('streamProtocol === chat-completions', adapter.streamProtocol === 'chat-completions', `streamProtocol=${adapter.streamProtocol}`);

    // ── HTTP header assertions (the REAL wire headers the device sends) ───────
    // Headers are part of the real request but were never asserted (adversarial
    // gap). Build them from the REAL adapter with the SAME credential the worker
    // POSTs with (cfg.CUSTOM_KEY, api_key mode). custom.buildHeaders(apiKey) ignores
    // authType (single auth mode) and returns:
    //   { 'Content-Type':'application/json', ...customHeaders,
    //     Authorization:`Bearer <key>` }
    // where Authorization is added ONLY when a key is present AND customHeaders
    // carries no auth header. This fixture seeds a key and NO customHeaders, so the
    // exact shape is { 'Content-Type', 'Authorization' }. Secrets never printed —
    // assert on prefix/shape, redact the token to its length.
    const headers = adapter.buildHeaders(cfg.CUSTOM_KEY, cfg.AUTH_TYPE);
    A('headers is a plain object', !!headers && typeof headers === 'object' && !Array.isArray(headers), `type=${Array.isArray(headers) ? 'array' : typeof headers}`);
    A('header Content-Type === application/json', !!headers && headers['Content-Type'] === 'application/json', `Content-Type=${headers && headers['Content-Type']}`);
    const authHdr = headers && headers.Authorization;
    A('header Authorization is "Bearer <token>"',
        typeof authHdr === 'string' && authHdr.startsWith('Bearer ') && authHdr.length > 'Bearer '.length,
        `Authorization=Bearer <redacted len=${typeof authHdr === 'string' ? authHdr.length : 'n/a'}>`);
    A('no header value carries a raw newline/control char', !!headers && Object.values(headers).every((v) => !/[\r\n]/.test(String(v))), `keys=${headers ? JSON.stringify(Object.keys(headers)) : 'n/a'}`);

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
    const apiKey = cfg.CUSTOM_KEY;
    const headers = adapter.buildHeaders(apiKey, cfg.AUTH_TYPE);
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
    // Default to the single configured model if none supplied.
    const models = MODELS.length ? MODELS : [cfg.MODEL];
    const endpoint = resolveEndpoint();
    const results = [];
    for (const model of models) {
        const built = buildBody(model, { heartbeat: false });
        const r = await liveOne(model, built.bodyStr);
        // --diagnose is a documented no-op for chat_completions custom: the body
        // carries NO `reasoning` field (custom emits a clean chat/completions body),
        // so there is no reasoning-effort ladder to sweep. Label stays agent-parity.
        results.push({ ...r, variant: 'agent-parity (as-sent)' });
    }
    // NOTE: custom has no /v1/models listing endpoint (no adapter.testEndpoint), so
    // there is no registry-vs-live model diff — the registry ships an empty model
    // list for custom (freeform, user-typed model ids).
    send({ mode: MODE, live: { endpoint: { hostname: endpoint.hostname, path: endpoint.path }, results } });
    process.exit(0);
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
void DIAGNOSE;
