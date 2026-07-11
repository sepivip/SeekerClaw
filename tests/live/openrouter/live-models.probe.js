#!/usr/bin/env node
// tests/live/openrouter/live-models.probe.js
// ─────────────────────────────────────────────────────────────────────────────
// LIVE OpenRouter model-matrix probe — "EXACT AGENT COPY" edition (BAT-1144).
//
// Unlike a black-box live harness that fakes the system prompt + tools, THIS probe
// imports the REAL agent modules and builds the Chat Completions request the EXACT
// way ai.js chat() does:
//   • ai.buildSystemBlocks()      → the real ~54KB system prompt (seeded workspace)
//   • tools/index TOOLS           → the real 64-tool telegram registry
//   • providers/openrouter adapter → formatSystemPrompt / formatTools /
//                                    toApiMessages / formatRequest (the real wire body)
//   • http.js httpChatCompletionsStreamingRequest → the real streaming transport
//
// OpenRouter has a SINGLE auth mode (api_key) — no OAuth/Codex fork like OpenAI.
// The parent forks exactly one worker (mode=apikey).
//
// SECURITY: credentials come ONLY from tests/live/openrouter/.env.test (gitignored).
// Tokens are NEVER printed — only present(len=N). Node builtins only; no deps.
//
// USAGE
//   node tests/live/openrouter/live-models.probe.js --self-check     # offline, no creds, no EXTERNAL network*
//   node tests/live/openrouter/live-models.probe.js                  # live sweep (needs .env.test)
//   node tests/live/openrouter/live-models.probe.js --diagnose
//   node tests/live/openrouter/live-models.probe.js --models anthropic/claude-sonnet-4-6,openai/gpt-5.4
//   node tests/live/openrouter/live-models.probe.js --base-url http://127.0.0.1:8080
//
//   * "no EXTERNAL network": --self-check makes no OpenRouter/internet call, but the
//     real buildSystemBlocks() fires a fire-and-forget /burner/status probe at the
//     localhost bridge; with no bridge server it fails silently and doesn't affect
//     the result.
//
// Exit: 0 whenever the sweep/self-check ran; 1 only on setup/credential/assert error.
'use strict';

const path = require('path');
const fs = require('fs');
const { fork } = require('child_process');

const { loadEnvTest, redact } = require('../_shared/env');
const { seedFixture } = require('../_shared/fixture');

const HERE = __dirname;
const WORKER = path.join(HERE, 'worker.js');
const ENV_TEST = path.join(HERE, '.env.test');
const FIXTURES = path.join(HERE, 'fixtures');
const REGISTRY = path.resolve(HERE, '..', '..', '..', 'app', 'src', 'main', 'assets', 'nodejs-project', 'model-registry.json');

// ── args ──────────────────────────────────────────────────────────────────────
function parseArgs(argv) {
    const out = { diagnose: false, selfCheck: false, mode: null, models: null, baseUrl: null, help: false };
    for (let i = 2; i < argv.length; i++) {
        const a = argv[i];
        if (a === '--help' || a === '-h') out.help = true;
        else if (a === '--diagnose') out.diagnose = true;
        else if (a === '--self-check') out.selfCheck = true;
        else if (a === '--mode') out.mode = (argv[++i] || '').toLowerCase();
        else if (a === '--models') out.models = argv[++i] || '';
        else if (a === '--base-url') out.baseUrl = argv[++i] || '';
        else if (a.startsWith('--mode=')) out.mode = a.slice(7).toLowerCase();
        else if (a.startsWith('--models=')) out.models = a.slice(9);
        else if (a.startsWith('--base-url=')) out.baseUrl = a.slice(11);
    }
    return out;
}

function usage() {
    console.log(`
OpenRouter live model-matrix probe — EXACT AGENT COPY (BAT-1144)

  node tests/live/openrouter/live-models.probe.js [flags]

Flags:
  --self-check        Offline acceptance test. No secrets, NO network. Seeds the
                      fixture with a placeholder key, builds the REAL Chat
                      Completions body via the agent seam, and asserts the wire
                      shape. Exit 0 all-pass.
  --mode <m>          apikey (the only mode; OpenRouter has no OAuth). Default: apikey.
  --models <csv|all>  Models to sweep. 'all' / default = the registry default model
                      (OpenRouter is freeform: models[] is empty in the registry, so
                      the default model 'anthropic/claude-sonnet-4-6' is used unless
                      you pass an explicit CSV). Pass real OpenRouter model ids
                      (e.g. 'openai/gpt-5.4', 'anthropic/claude-sonnet-4-6').
  --diagnose          Also sweep the reasoning-effort ladder (none/low/medium/high)
                      — clearly BEYOND agent parity (the agent omits reasoning on OR
                      normal turns; only synthetic turns send effort:'none'). Live only.
  --base-url <url>    Gateway override for the live POST (host[:port]); the adapter's
                      real path is preserved.
  --help              This help.

Credentials (tests/live/openrouter/.env.test, gitignored):
  OPENROUTER_API_KEY=sk-or-v1-...   api_key path (openrouter.ai/api/v1/chat/completions)
  TEST_MODELS=a,b,c                 optional default model set

"Exact copy": the probe does NOT re-implement the prompt or tools. It require()s
the same ai.js / tools/index / providers/openrouter the device runs, so the body is
byte-for-byte what the agent sends (minus MCP tools, which the harness omits).
`);
}

// ── registry helpers (single source of truth: model-registry.json) ────────────
function loadRegistryOpenRouter() {
    const j = JSON.parse(fs.readFileSync(REGISTRY, 'utf8'));
    const or = (j.providers || []).find((p) => p.id === 'openrouter') || {};
    const models = (or.models || []).map((m) => m.id);
    return { models, defaultModel: or.defaultModel || 'anthropic/claude-sonnet-4-6' };
}

function resolveModels(modelsFlag, reg, testModelsEnv) {
    // Explicit CSV always wins.
    if (modelsFlag && modelsFlag !== 'all') {
        return modelsFlag.split(',').map((s) => s.trim()).filter(Boolean);
    }
    // OpenRouter's registry model list is empty (freeform:true). Fall back to the
    // TEST_MODELS default if set, else the single registry default model.
    if (modelsFlag !== 'all' && testModelsEnv) {
        const list = testModelsEnv.split(',').map((s) => s.trim()).filter(Boolean);
        if (list.length) return list;
    }
    return reg.models.length ? reg.models : [reg.defaultModel];
}

// ── fork the worker (single mode) ─────────────────────────────────────────────
function runWorker({ selfCheck, diagnose, live, baseUrl, models, apiKey }) {
    return new Promise((resolve) => {
        const fixtureDir = path.join(FIXTURES, 'apikey');
        try {
            seedFixture(fixtureDir, {
                provider: 'openrouter',
                model: (models && models[0]) || 'anthropic/claude-sonnet-4-6',
                authConfig: { authType: 'api_key', openrouterApiKey: apiKey || 'sk-or-v1-test-PLACEHOLDER' },
            });
        } catch (e) {
            return resolve({ mode: 'apikey', error: `[seed] ${e.message}` });
        }

        const env = {
            ...process.env,
            SC_SELF_CHECK: selfCheck ? '1' : '',
            SC_DIAGNOSE: diagnose ? '1' : '',
            SC_LIVE: live ? '1' : '',
            SC_BASE_URL: baseUrl || '',
            SC_MODELS: (models || []).join(','),
        };
        // argv[2] = fixtureDir → config.js picks it up as workDir.
        const child = fork(WORKER, [fixtureDir], { env, stdio: ['inherit', 'inherit', 'inherit', 'ipc'] });
        let message = null;
        child.on('message', (m) => { message = m; });
        child.on('error', (e) => resolve({ mode: 'apikey', error: `[fork] ${e.message}` }));
        child.on('exit', (code) => {
            if (message) resolve({ ...message, _exit: code });
            else resolve({ mode: 'apikey', error: `worker exited (code ${code}) without a result`, _exit: code });
        });
    });
}

// ── printing ──────────────────────────────────────────────────────────────────
const BAR = '═'.repeat(78);
const line = (s = '') => console.log(s);

function printSelfCheck(result) {
    const sc = result.selfCheck;
    line(`\n${BAR}`);
    line(`SELF-CHECK · mode=${result.mode}  endpoint=${sc.endpoint.hostname}${sc.endpoint.path}  model=${sc.model}  tools=${sc.toolCount}`);
    line(BAR);
    for (const a of sc.asserts) {
        line(`  ${a.ok ? 'PASS' : 'FAIL'}  ${a.name}${a.detail ? `   (${a.detail})` : ''}`);
    }
    line(`\n  ── Built body (token-redacted; system message/tools abbreviated) ──`);
    line('  keys: ' + JSON.stringify(sc.render.keys));
    line('  ' + JSON.stringify(sc.render.critical, null, 2).split('\n').join('\n  '));
    line('\n  ── system prompt (head + tail; full length above) ──');
    line(sc.render.systemPromptAbbrev.split('\n').map((l) => '  | ' + l).join('\n'));
    line(`\n  → mode ${result.mode}: ${sc.pass ? 'PASS' : 'FAIL'}`);
}

function printLive(result, reg) {
    const lv = result.live;
    line(`\n${BAR}`);
    line(`LIVE SWEEP · mode=${result.mode}  endpoint=${lv.endpoint.hostname}${lv.endpoint.path}`);
    line(BAR);
    line('  model'.padEnd(38) + 'variant'.padEnd(34) + 'status  ok   lat     detail');
    for (const r of lv.results) {
        const detail = r.ok ? `"${r.text}"${r.toolCalls ? ` +${r.toolCalls} toolCalls` : ''}` : r.errBody;
        line('  ' + String(r.model).padEnd(36) + String(r.variant).padEnd(34)
            + String(r.status).padStart(5) + '  ' + (r.ok ? 'Y' : 'n') + '   '
            + (String(r.latencyMs) + 'ms').padStart(7) + '  ' + (detail || '').slice(0, 60));
    }
    const listed = lv.listedModels || { status: -1, ids: [] };
    line(`\n  ── /api/v1/models (status=${listed.status}; ${(listed.ids || []).length} ids visible to this key) ──`);
    for (const r of lv.results) {
        if (!String(r.variant).startsWith('agent-parity')) continue;
        const seen = (listed.ids || []).includes(r.model);
        line(`    ${String(r.model).padEnd(36)} inModels=${seen ? 'YES' : 'no '}  ${r.ok ? 'responds' : `HTTP ${r.status}`}`);
    }
}

// ── main ──────────────────────────────────────────────────────────────────────
(async function main() {
    const args = parseArgs(process.argv);
    if (args.help) { usage(); process.exit(0); }

    // OpenRouter only supports apikey; reject any other explicit --mode.
    if (args.mode && args.mode !== 'apikey') {
        line(`\n[SETUP ERROR] OpenRouter only supports --mode apikey (got "${args.mode}").`);
        process.exit(1);
    }

    const { loaded } = loadEnvTest(ENV_TEST);
    const apiKey = (process.env.OPENROUTER_API_KEY || '').trim();
    const testModelsEnv = (process.env.TEST_MODELS || '').trim();
    const reg = loadRegistryOpenRouter();
    const models = resolveModels(args.models, reg, testModelsEnv);

    line(`${BAR}`);
    line('OpenRouter live model probe — EXACT AGENT COPY (BAT-1144)');
    line(`.env.test: ${loaded ? 'loaded' : 'not found'}   OPENROUTER_API_KEY=${redact(apiKey)}`);
    line(BAR);

    // ── SELF-CHECK (offline) ──────────────────────────────────────────────────
    if (args.selfCheck) {
        line('\nMODE: --self-check (offline, no external network). Seeding the fixture with a placeholder key.');
        const r = await runWorker({ selfCheck: true, diagnose: false, live: false, baseUrl: null, models, apiKey: '' });
        line(`\n${BAR}`);
        if (r.error) { line(`[SETUP ERROR] mode=${r.mode}: ${r.error}`); line(BAR); process.exit(1); }
        printSelfCheck(r);
        line(`\n${BAR}`);
        line(`SELF-CHECK RESULT: ${r.selfCheck.pass ? 'PASS' : 'FAIL'}  (mode: apikey)`);
        line(BAR);
        process.exit(r.selfCheck.pass ? 0 : 1);
    }

    // ── LIVE sweep ────────────────────────────────────────────────────────────
    if (!apiKey) {
        line('\nNo credential found and no --self-check. Put this in tests/live/openrouter/.env.test:');
        line('  OPENROUTER_API_KEY=sk-or-v1-...    (api_key path)');
        line('…or run with --self-check to validate the body offline (no creds, no external network).');
        process.exit(1);
    }

    const r = await runWorker({ selfCheck: false, diagnose: args.diagnose, live: true, baseUrl: args.baseUrl, models, apiKey });
    if (r.error) { line(`\n[ERROR] mode=${r.mode}: ${r.error}`); line(`\n${BAR}`); line('LIVE SWEEP: SETUP ERROR (see above).'); line(BAR); process.exit(1); }
    printLive(r, reg);
    line(`\n${BAR}`);
    line('LIVE SWEEP COMPLETE (mode: apikey).');
    line(BAR);
    // Report-only: exit 0 whenever the sweep ran.
    process.exit(0);
})();
