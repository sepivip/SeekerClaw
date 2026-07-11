// tests/live/anthropic/worker.js
// ─────────────────────────────────────────────────────────────────────────────
// CHILD worker (one process per auth mode). Its process.argv[2] is the fixture
// workDir, so require('<bundle>/config') finds workDir/config.json and boots the
// REAL agent stack for THIS auth mode.
//
// WHY ONE PROCESS PER MODE: config.js freezes AUTH_TYPE (and therefore which
// Claude credential/billing lane is live) at module-load time from the fixture's
// config.json. A single process can only ever be api_key OR setup_token — never
// both. The parent forks one worker per mode.
//
// The worker imports the REAL modules and builds the wire body the EXACT way the
// agent does (ai.js chat() seam), then either:
//   • --self-check : validates the body's wire shape offline — no Anthropic/external
//                    network (a fire-and-forget localhost bridge probe during prompt
//                    assembly fails silently), OR
//   • live         : POSTs each model's body via the REAL httpStreamingRequest.
//
// It reports back via IPC (process.send) when forked, else prints JSON to stdout.
'use strict';

const path = require('path');

// ── Resolve the real nodejs-project bundle (…/app/src/main/assets/nodejs-project)
const BUNDLE = path.resolve(__dirname, '..', '..', '..', 'app', 'src', 'main', 'assets', 'nodejs-project');
const req = (m) => require(path.join(BUNDLE, m));

const { redact, redactIn } = require('../_shared/env');

// ── Control inputs (from the parent via env; argv[2] is reserved for workDir) ──
const MODE = (process.env.SC_MODE || 'apikey').toLowerCase();           // 'apikey' | 'setup_token'
const SELF_CHECK = process.env.SC_SELF_CHECK === '1';
const LIVE = process.env.SC_LIVE === '1';
const BASE_URL = (process.env.SC_BASE_URL || '').trim();
const MODELS = (process.env.SC_MODELS || '').split(',').map((s) => s.trim()).filter(Boolean);
const PROMPT = process.env.SC_PROMPT || 'Reply with the single word: pong';

// The auth-mode label config.js will have frozen for this fixture.
const EXPECTED_AUTH = MODE === 'setup_token' ? 'setup_token' : 'api_key';

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
let cfg, adapter, TOOLS, ai, reasoningSupportFor, httpStreamingRequest;
try {
    cfg = req('config');                                   // reads workDir/config.json (argv[2])
    ({ reasoningSupportFor } = req('model-catalog'));
    const providers = req('providers');
    adapter = providers.getAdapter('claude');
    ({ TOOLS } = req(path.join('tools', 'index')));        // REAL 64-tool telegram registry
    ai = req('ai');
    ({ httpStreamingRequest } = req('http'));
} catch (e) {
    fail('boot', e);
}

// Sanity: the fixture must actually have booted Claude in the expected mode.
if (!cfg || cfg.PROVIDER !== 'claude') fail('boot', new Error(`fixture provider is "${cfg && cfg.PROVIDER}", expected "claude"`));
if (!adapter || adapter.id !== 'claude') fail('boot', new Error('claude adapter did not resolve'));
if (cfg.AUTH_TYPE !== EXPECTED_AUTH) {
    fail('boot', new Error(`AUTH_TYPE is "${cfg.AUTH_TYPE}", expected "${EXPECTED_AUTH}" (fixture/mode mismatch)`));
}

// Populate the redaction set now that config is loaded (declared above so fail() can
// use it even during boot). Defense-in-depth; the built body itself carries no key.
SECRETS = [cfg.ANTHROPIC_KEY, cfg.BOT_TOKEN].filter(Boolean);

// ── Helpers ─────────────────────────────────────────────────────────────────
// Claude's `system` field is an ARRAY of {type:'text', text, cache_control?} blocks
// (formatSystemPrompt output), not a bare string. Flatten to text so the seeded-
// workspace assertions can search it.
function systemText(system) {
    if (typeof system === 'string') return system;
    if (Array.isArray(system)) return system.map((b) => (b && typeof b.text === 'string' ? b.text : '')).join('\n');
    return '';
}

// ── The seam: build the body the EXACT way ai.js chat() does ──────────────────
// Mirrors ai.js chat():
//   const { stable, dynamic } = buildSystemBlocks([], chatId, activeModel)
//   systemBlocks   = adapter.formatSystemPrompt(stable, dynamic + resumeBlock, AUTH_TYPE)
//   formattedTools = adapter.formatTools(getTools())      (== TOOLS here; no MCP)
//   requestOptions = { reasoningEnabled, reasoningSupport, customEchoOverride, reasoningMode, synthetic }
//   apiMessages    = adapter.toApiMessages(messages, activeModel, requestOptions)
//   bodyStr        = adapter.formatRequest(activeModel, 4096, systemBlocks, apiMessages, formattedTools, requestOptions)
function buildRequestOptions(model, { heartbeat = false } = {}) {
    // Live runtime-state read, exactly like ai.js (reasoningEnabled / customEchoReasoning).
    const rt = (() => {
        try { return cfg.runtimeState ? cfg.runtimeState.read() : null; } catch (_) { return null; }
    })();
    return {
        reasoningEnabled: !!(rt && rt.reasoningEnabled),
        reasoningSupport: reasoningSupportFor('claude', model, cfg.AUTH_TYPE),
        customEchoOverride: !!(rt && rt.customEchoReasoning),
        // A normal turn is 'normal'; a heartbeat/synthetic turn is 'off' (suppresses
        // the thinking block regardless of user-toggle / registry-support state).
        reasoningMode: heartbeat ? 'off' : 'normal',
        synthetic: heartbeat ? 'heartbeat' : null,
    };
}

function buildBody(model, { heartbeat = false } = {}) {
    // Deterministic wallet block: seed a "no burner configured" snapshot so the
    // Wallets section is STABLE. Note: buildSystemBlocks() still fires a
    // fire-and-forget /burner/status probe at the localhost bridge — but there is
    // no bridge server here, so it fails silently and does NOT overwrite this seeded
    // snapshot (the probe is why the self-check is "no EXTERNAL network", not
    // literally "no sockets").
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
        systemBlocks,
        toolCount: formattedTools.length,
        requestOptions,
    };
}

// A compact, readable render of a (large) Claude Messages body: abbreviate the
// 50KB+ system prompt and the 64-entry `tools`, keep wire-critical fields verbatim.
function renderBody(bodyObj, toolCount) {
    const instr = systemText(bodyObj.system);
    const head = instr.slice(0, 600);
    const tail = instr.length > 900 ? instr.slice(-260) : '';
    const abbrevInstr = tail
        ? `${head}\n        … [${instr.length} chars total; middle elided] …\n${tail}`
        : instr;
    const toolNames = Array.isArray(bodyObj.tools) ? bodyObj.tools.slice(0, 8).map((t) => t.name) : [];
    const sysBlockKinds = Array.isArray(bodyObj.system)
        ? bodyObj.system.map((b) => ({ type: b && b.type, len: b && typeof b.text === 'string' ? b.text.length : 0, cache: !!(b && b.cache_control) }))
        : `‹string len=${instr.length}›`;
    const view = {
        model: bodyObj.model,
        max_tokens: bodyObj.max_tokens,
        stream: bodyObj.stream,
        thinking: ('thinking' in bodyObj) ? bodyObj.thinking : '‹absent›',
        system: sysBlockKinds,
        messages: bodyObj.messages,
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
    const instr = systemText(b.system);

    // ── Common wire-shape assertions (both modes) ─────────────────────────────
    A('endpoint === api.anthropic.com/v1/messages', ep.hostname === 'api.anthropic.com' && ep.path === '/v1/messages', `${ep.hostname}${ep.path}`);
    A('model is a non-empty string', typeof b.model === 'string' && b.model.length > 0, `model=${b.model}`);
    A('stream === true', b.stream === true, `stream=${b.stream}`);
    A('max_tokens === 4096', b.max_tokens === 4096, `max_tokens=${b.max_tokens}`);
    A('system is a non-empty array of text blocks', Array.isArray(b.system) && b.system.length > 0
        && b.system.every((blk) => blk && blk.type === 'text' && typeof blk.text === 'string'),
        `system.length=${Array.isArray(b.system) ? b.system.length : '‹not-array›'}`);
    A('messages is a non-empty array', Array.isArray(b.messages) && b.messages.length > 0, `messages.length=${(b.messages || []).length}`);
    A('first message is the user PROMPT', b.messages && b.messages[0] && b.messages[0].role === 'user', JSON.stringify(b.messages && b.messages[0] && b.messages[0].role));

    // Tools: length === the real TOOLS registry, and every tool matches Claude's
    // native shape {name, description, input_schema} — NOT the OpenAI
    // {type:'function', ...} shape (proves we ran THIS adapter's formatTools).
    A('tools length === real TOOLS length', Array.isArray(b.tools) && b.tools.length === TOOLS.length && b.tools.length > 0, `body.tools=${(b.tools || []).length} TOOLS=${TOOLS.length}`);
    const claudeShape = Array.isArray(b.tools) && b.tools.every((t) => t
        && typeof t.name === 'string' && t.name.length > 0
        && typeof t.description === 'string'
        && t.input_schema && typeof t.input_schema === 'object' && !Array.isArray(t.input_schema)
        && !('type' in t)); // Claude tools have NO top-level `type` (that's the OpenAI shape)
    A('every tool is {name, description, input_schema} (Claude shape)', claudeShape, claudeShape ? 'all ok' : 'a tool is malformed / wrong shape');
    // formatTools stamps cache_control on the LAST tool for prompt caching.
    const last = Array.isArray(b.tools) ? b.tools[b.tools.length - 1] : null;
    A('last tool carries cache_control:{type:"ephemeral"}', last && last.cache_control && last.cache_control.type === 'ephemeral', JSON.stringify(last && last.cache_control));

    // ── System prompt reflects the SEEDED MOCK WORKSPACE (the whole point) ────
    A('prompt has real Identity section marker', instr.includes('You are a personal AI agent running inside SeekerClaw'), 'identity line present');
    A('prompt has a Tooling/Architecture marker', instr.includes('## Architecture') || instr.includes('Tooling'), 'structural section present');
    A('prompt embeds seeded IDENTITY.md (TestBot)', instr.includes('IDENTITY.md') && instr.includes('TestBot'), 'IDENTITY.md + TestBot present');
    A('prompt embeds seeded USER.md (Test User)', instr.includes('USER.md') && instr.includes('Test User'), 'USER.md + Test User present');
    A('prompt embeds seeded MEMORY.md line', instr.includes('BAT-1144 OpenAI live-model harness') || instr.includes('synthetic preference'), 'MEMORY.md content present');

    // ── Mode-specific assertions ──────────────────────────────────────────────
    // The stable system prompt block always carries cache_control:{ephemeral}.
    const CC_BILLING_PREFIX = 'x-anthropic-billing-header: cc_version=';
    if (MODE === 'setup_token') {
        // formatSystemPrompt prepends a separate billing-attribution text block
        // (NO cache_control) so an OAuth/Pro token can reach non-Haiku models.
        A('setup_token: first system block is the cc_version billing header',
            b.system[0] && typeof b.system[0].text === 'string' && b.system[0].text.startsWith(CC_BILLING_PREFIX), JSON.stringify(b.system[0] && b.system[0].text ? b.system[0].text.slice(0, 40) : null));
        A('setup_token: billing header block has NO cache_control',
            b.system[0] && !b.system[0].cache_control, `hasCache=${!!(b.system[0] && b.system[0].cache_control)}`);
        A('setup_token: a stable block carries cache_control:{ephemeral}',
            b.system.some((blk) => blk && blk.cache_control && blk.cache_control.type === 'ephemeral'), 'ephemeral cache block present');
    } else {
        // api_key path: NO billing header — the first block IS the cache-controlled
        // stable prompt.
        A('api_key: NO cc_version billing header block',
            !b.system.some((blk) => blk && typeof blk.text === 'string' && blk.text.startsWith(CC_BILLING_PREFIX)), 'no billing block');
        A('api_key: first system block carries cache_control:{ephemeral}',
            b.system[0] && b.system[0].cache_control && b.system[0].cache_control.type === 'ephemeral', JSON.stringify(b.system[0] && b.system[0].cache_control));
    }

    // Reasoning: the fixture has no runtime_state (reasoningEnabled=false), so a
    // normal turn emits NO `thinking` block (adaptive thinking is gated on the
    // user toggle). This proves the real formatRequest gate ran.
    A('NO thinking block (reasoning toggle off in fixture)', !('thinking' in b), `present=${'thinking' in b}`);

    // ── HTTP header assertions (the OTHER half of the wire request) ───────────
    // The body above is only half of what the device POSTs — the HTTP headers are
    // the rest, and for Claude they DIFFER by auth mode (that's the whole reason
    // the harness forks one worker per mode: the auth lane is a header-level fork).
    // Build them from the REAL adapter with the SAME credential the live path uses
    // (worker's liveOne()/listModels() both call buildHeaders(cfg.ANTHROPIC_KEY,
    // cfg.AUTH_TYPE)). SECURITY: never print the raw key/token — assert on shape
    // (present / startsWith / includes), and details carry "(value redacted)".
    const headers = adapter.buildHeaders(cfg.ANTHROPIC_KEY, cfg.AUTH_TYPE);
    const beta = typeof headers['anthropic-beta'] === 'string' ? headers['anthropic-beta'] : '';

    // Both modes — fixed/pinned headers buildHeaders always emits.
    A('header Content-Type === application/json',
        headers['Content-Type'] === 'application/json', `Content-Type=${headers['Content-Type']}`);
    A('header anthropic-version === 2023-06-01',
        headers['anthropic-version'] === '2023-06-01', `anthropic-version=${headers['anthropic-version']}`);
    A('header anthropic-beta includes prompt-caching-2024-07-31',
        beta.includes('prompt-caching-2024-07-31'), `anthropic-beta=${beta}`);
    A('header anthropic-beta includes interleaved-thinking-2025-05-14',
        beta.includes('interleaved-thinking-2025-05-14'), `anthropic-beta=${beta}`);

    if (MODE === 'setup_token') {
        // OAuth / Pro-Max lane: Bearer auth + the oauth beta tag; NO x-api-key.
        A('setup_token: Authorization header starts with "Bearer "',
            typeof headers['Authorization'] === 'string' && headers['Authorization'].startsWith('Bearer '),
            `Authorization present=${typeof headers['Authorization'] === 'string'} (value redacted)`);
        A('setup_token: NO x-api-key header',
            !('x-api-key' in headers), `has_x_api_key=${'x-api-key' in headers}`);
        A('setup_token: anthropic-beta includes oauth-2025-04-20',
            beta.includes('oauth-2025-04-20'), `anthropic-beta=${beta}`);
    } else {
        // Raw API-key lane: x-api-key auth; NO Authorization Bearer; NO oauth tag.
        A('api_key: x-api-key header present (non-empty)',
            typeof headers['x-api-key'] === 'string' && headers['x-api-key'].length > 0,
            `has_x_api_key=${'x-api-key' in headers} (value redacted)`);
        A('api_key: NO Authorization header',
            !('Authorization' in headers), `has_authorization=${'Authorization' in headers}`);
        A('api_key: anthropic-beta does NOT include oauth-2025-04-20',
            !beta.includes('oauth-2025-04-20'), `anthropic-beta=${beta}`);
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
            render: renderBody(b, built.toolCount),
        },
    });
    process.exit(pass ? 0 : 1);
}

// ── Live sweep ────────────────────────────────────────────────────────────────
function resolveEndpoint() {
    const ep = adapter.endpoint;
    const base = { protocol: 'https:', hostname: ep.hostname, port: undefined, path: ep.path };
    if (!BASE_URL) return base;
    try {
        const u = new URL(BASE_URL.includes('://') ? BASE_URL : `https://${BASE_URL}`);
        return {
            protocol: u.protocol || 'https:',
            hostname: u.hostname,
            port: u.port ? parseInt(u.port, 10) : undefined,
            path: ep.path, // keep the adapter's real path (gateway proxies it)
        };
    } catch (_) {
        return base;
    }
}

async function liveOne(model, bodyStr) {
    const ep = resolveEndpoint();
    const headers = adapter.buildHeaders(cfg.ANTHROPIC_KEY, cfg.AUTH_TYPE);
    const options = {
        protocol: ep.protocol, hostname: ep.hostname, port: ep.port, path: ep.path,
        method: 'POST', headers, timeout: 60000,
    };
    const started = Date.now();
    try {
        const res = await httpStreamingRequest(options, bodyStr);
        const latencyMs = Date.now() - started;
        let text = '', toolCalls = 0;
        try {
            const parsed = adapter.fromApiResponse(res.data);
            text = (parsed.text || '').slice(0, 80);
            toolCalls = (parsed.toolCalls || []).length;
        } catch (_) { /* non-200 data may not parse to Messages shape */ }
        const errBody = res.status === 200 ? '' : redactIn(typeof res.data === 'string' ? res.data.slice(0, 300) : JSON.stringify(res.data).slice(0, 300), SECRETS);
        return { model, status: res.status, ok: res.status === 200 && (!!text || toolCalls > 0), text, toolCalls, latencyMs, errBody };
    } catch (e) {
        return { model, status: -1, ok: false, text: '', toolCalls: 0, latencyMs: Date.now() - started, errBody: redactIn(e.message, SECRETS) };
    }
}

async function liveSweep() {
    const models = MODELS.length ? MODELS : defaultModelsForMode();
    const endpoint = resolveEndpoint();
    const results = [];
    for (const model of models) {
        const built = buildBody(model, { heartbeat: false });
        const r = await liveOne(model, built.bodyStr);
        results.push({ ...r, variant: 'agent-parity (as-sent)' });
    }
    const listed = await listModels();
    send({ mode: MODE, live: { endpoint: { hostname: endpoint.hostname, path: endpoint.path }, results, listedModels: listed } });
    process.exit(0);
}

function defaultModelsForMode() {
    // Fallback if the parent doesn't pass SC_MODELS. Both auth modes share the
    // registry list (claude has no modelsByAuth split).
    return ['claude-opus-4-8', 'claude-sonnet-4-6', 'claude-haiku-4-5'];
}

// GET /v1/models via the adapter's testEndpoint (api.anthropic.com/v1/models) —
// used only in live mode, for the registry show/hide comparison.
function listModels() {
    return new Promise((resolve) => {
        const https = require('https');
        const headers = adapter.buildHeaders(cfg.ANTHROPIC_KEY, cfg.AUTH_TYPE);
        const te = adapter.testEndpoint; // { hostname:'api.anthropic.com', path:'/v1/models', method:'GET' }
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
        send({ mode: MODE, error: 'worker invoked without --self-check or SC_LIVE=1' });
        process.exit(3);
    } catch (e) {
        fail('run', e);
    }
})();

// silence unused-var lints for redact (kept in the shared API surface)
void redact;
