#!/usr/bin/env node
// tests/live/anthropic/live-models.probe.js
// ─────────────────────────────────────────────────────────────────────────────
// LIVE Anthropic (Claude) model-matrix probe — "EXACT AGENT COPY" edition
// (BAT-1144, Part 3).
//
// Unlike a black-box live harness that fakes the system prompt + tools, THIS probe
// imports the REAL agent modules and builds the Claude Messages API request the
// EXACT way ai.js chat() does:
//   • ai.buildSystemBlocks()   → the real ~54KB system prompt (seeded workspace)
//   • tools/index TOOLS         → the real 64-tool telegram registry
//   • providers/claude adapter  → formatSystemPrompt / formatTools / toApiMessages /
//                                 formatRequest (the real wire body)
//   • http.js httpStreamingRequest → the real Claude SSE transport (live path)
//
// config.js freezes AUTH_TYPE (and therefore the credential/billing lane) at module
// load from the fixture's config.json, so ONE process = ONE auth mode. The parent
// forks one worker per mode (api_key → x-api-key header, setup_token → Bearer +
// cc_version billing block).
//
// SECURITY: credentials come ONLY from tests/live/anthropic/.env.test (gitignored).
// Tokens are NEVER printed — only present(len=N). Node builtins only; no deps.
//
// USAGE
//   node tests/live/anthropic/live-models.probe.js --self-check      # offline, no creds, no EXTERNAL network*
//   node tests/live/anthropic/live-models.probe.js                   # live sweep (needs .env.test)
//   node tests/live/anthropic/live-models.probe.js --mode setup_token
//   node tests/live/anthropic/live-models.probe.js --models claude-opus-4-8,claude-sonnet-5
//   node tests/live/anthropic/live-models.probe.js --base-url http://127.0.0.1:8080
//
//   * "no EXTERNAL network": --self-check makes no Anthropic/internet call, but the
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

const MODES = ['apikey', 'setup_token'];
const AUTH_FIELD = { apikey: 'anthropicApiKey', setup_token: 'setupToken' };
const AUTH_TYPE = { apikey: 'api_key', setup_token: 'setup_token' };
const PLACEHOLDER = { apikey: 'sk-ant-api03-test-PLACEHOLDER', setup_token: 'sk-ant-oat01-test-PLACEHOLDER' };

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
Anthropic (Claude) live model-matrix probe — EXACT AGENT COPY (BAT-1144)

  node tests/live/anthropic/live-models.probe.js [flags]

Flags:
  --self-check        Offline acceptance test. No secrets, NO network. Seeds both
                      fixtures with placeholders, builds the REAL body per mode via
                      the agent seam, and asserts the wire shape. Exit 0 all-pass.
  --mode <m>          apikey | setup_token | both. Default: whichever creds exist.
  --models <csv|all>  Models to sweep. 'all' = the registry set for the provider.
                      Default: TEST_MODELS if set, else the registry set.
  --diagnose          Accepted for parity with the sibling probes; the Claude path
                      has no beyond-parity ladder, so this is currently a no-op.
  --base-url <url>    Gateway override for the live POST (host[:port]); the
                      adapter's real path (/v1/messages) is preserved.
  --help              This help.

Credentials (tests/live/anthropic/.env.test, gitignored):
  ANTHROPIC_API_KEY=...   api_key path (x-api-key header)
  SETUP_TOKEN=...         setup_token path (Bearer + cc_version billing block)
  TEST_MODELS=a,b,c       optional default model set

"Exact copy": the probe does NOT re-implement the prompt or tools. It require()s
the same ai.js / tools/index / providers/claude the device runs, so the body is
byte-for-byte what the agent sends (minus MCP tools, which the harness omits).
`);
}

// ── registry helpers (single source of truth: model-registry.json) ────────────
function loadRegistryClaude() {
    const j = JSON.parse(fs.readFileSync(REGISTRY, 'utf8'));
    const claude = (j.providers || []).find((p) => p.id === 'claude') || {};
    const models = (claude.models || []).map((m) => m.id);
    return { models, defaultModel: claude.defaultModel || 'claude-opus-4-8' };
}

function modelsForMode(modelsFlag, regModels, testModelsEnv) {
    // Explicit CSV always wins.
    if (modelsFlag && modelsFlag !== 'all') {
        return modelsFlag.split(',').map((s) => s.trim()).filter(Boolean);
    }
    // `--models all` → the registry set, IGNORING TEST_MODELS.
    if (modelsFlag === 'all') return regModels.models;
    // No flag → the TEST_MODELS default if set, else the registry set.
    if (testModelsEnv) {
        const list = testModelsEnv.split(',').map((s) => s.trim()).filter(Boolean);
        if (list.length) return list;
    }
    return regModels.models;
}

// ── fork a worker for one mode ────────────────────────────────────────────────
function runWorker(mode, { selfCheck, live, baseUrl, models, creds, defaultModel }) {
    return new Promise((resolve) => {
        const fixtureDir = path.join(FIXTURES, mode);
        try {
            // Provider-generic seed: pass the provider's own auth config.json fields.
            // A placeholder credential keeps config.js's "missing key" gate happy in
            // the offline self-check (config.js exits if the active key is empty).
            const credValue = (mode === 'apikey' ? creds.apiKey : creds.token) || PLACEHOLDER[mode];
            seedFixture(fixtureDir, {
                provider: 'claude',
                model: (models && models[0]) || defaultModel,
                authConfig: { authType: AUTH_TYPE[mode], [AUTH_FIELD[mode]]: credValue },
            });
        } catch (e) {
            return resolve({ mode, error: `[seed] ${e.message}` });
        }

        const env = {
            ...process.env,
            SC_MODE: mode,
            SC_SELF_CHECK: selfCheck ? '1' : '',
            SC_LIVE: live ? '1' : '',
            SC_BASE_URL: baseUrl || '',
            SC_MODELS: (models || []).join(','),
        };
        // argv[2] = fixtureDir → config.js picks it up as workDir.
        const child = fork(WORKER, [fixtureDir], { env, stdio: ['inherit', 'inherit', 'inherit', 'ipc'] });
        let message = null;
        child.on('message', (m) => { message = m; });
        child.on('error', (e) => resolve({ mode, error: `[fork] ${e.message}` }));
        child.on('exit', (code) => {
            if (message) resolve({ ...message, _exit: code });
            else resolve({ mode, error: `worker exited (code ${code}) without a result`, _exit: code });
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
    line(`\n  ── Built body (token-redacted; system/tools abbreviated) ──`);
    line('  keys: ' + JSON.stringify(sc.render.keys));
    line('  ' + JSON.stringify(sc.render.critical, null, 2).split('\n').join('\n  '));
    line('\n  ── system prompt text (head + tail; full length above) ──');
    line(sc.render.instructionsAbbrev.split('\n').map((l) => '  | ' + l).join('\n'));
    line(`\n  → mode ${result.mode}: ${sc.pass ? 'PASS' : 'FAIL'}`);
}

function printLive(result, reg) {
    const lv = result.live;
    line(`\n${BAR}`);
    line(`LIVE SWEEP · mode=${result.mode}  endpoint=${lv.endpoint.hostname}${lv.endpoint.path}`);
    line(BAR);
    line('  model'.padEnd(24) + 'variant'.padEnd(28) + 'status  ok   lat     detail');
    for (const r of lv.results) {
        const detail = r.ok ? `"${r.text}"${r.toolCalls ? ` +${r.toolCalls} toolCalls` : ''}` : r.errBody;
        line('  ' + String(r.model).padEnd(22) + String(r.variant).padEnd(28)
            + String(r.status).padStart(5) + '  ' + (r.ok ? 'Y' : 'n') + '   '
            + (String(r.latencyMs) + 'ms').padStart(7) + '  ' + (detail || '').slice(0, 60));
    }
    const listed = lv.listedModels || { status: -1, ids: [] };
    line(`\n  ── registry vs live (/v1/models status=${listed.status}) ──`);
    for (const m of reg.models) {
        const seen = listed.ids.includes(m);
        const parity = lv.results.find((r) => r.model === m);
        const responds = parity ? (parity.ok ? 'responds' : `HTTP ${parity.status}`) : 'not-swept';
        line(`    ${m.padEnd(22)} inModels=${seen ? 'YES' : 'no '}  ${responds}`);
    }
    const extra = (listed.ids || []).filter((id) => !reg.models.includes(id) && /^claude/i.test(id));
    if (extra.length) line(`    (in /v1/models but NOT in registry: ${extra.join(', ')})`);
}

// ── main ──────────────────────────────────────────────────────────────────────
(async function main() {
    const args = parseArgs(process.argv);
    if (args.help) { usage(); process.exit(0); }

    const { loaded } = loadEnvTest(ENV_TEST);
    const creds = {
        apiKey: (process.env.ANTHROPIC_API_KEY || '').trim(),
        token: (process.env.SETUP_TOKEN || '').trim(),
    };
    const testModelsEnv = (process.env.TEST_MODELS || '').trim();
    const reg = loadRegistryClaude();

    line(`${BAR}`);
    line('Anthropic (Claude) live model probe — EXACT AGENT COPY (BAT-1144)');
    line(`.env.test: ${loaded ? 'loaded' : 'not found'}   ANTHROPIC_API_KEY=${redact(creds.apiKey)}   SETUP_TOKEN=${redact(creds.token)}`);
    line(BAR);

    // Resolve modes.
    let modes;
    if (args.mode === 'apikey' || args.mode === 'setup_token') modes = [args.mode];
    else if (args.mode === 'both') modes = MODES.slice();
    else if (args.selfCheck) modes = MODES.slice();
    else {
        modes = [];
        if (creds.apiKey) modes.push('apikey');
        if (creds.token) modes.push('setup_token');
    }

    // ── SELF-CHECK (offline) ──────────────────────────────────────────────────
    if (args.selfCheck) {
        line('\nMODE: --self-check (offline, no external network). Seeding both fixtures with placeholders.');
        const results = [];
        for (const mode of modes) {
            const models = modelsForMode(args.models, reg, testModelsEnv);
            results.push(await runWorker(mode, { selfCheck: true, live: false, baseUrl: null, models, creds: {}, defaultModel: reg.defaultModel }));
        }
        let anyFail = false;
        let setupError = false;
        for (const r of results) {
            if (r.error) { setupError = true; line(`\n[SETUP ERROR] mode=${r.mode}: ${r.error}`); continue; }
            printSelfCheck(r);
            if (!r.selfCheck.pass) anyFail = true;
        }
        line(`\n${BAR}`);
        if (setupError) { line('SELF-CHECK: SETUP ERROR (see above).'); line(BAR); process.exit(1); }
        line(`SELF-CHECK RESULT: ${anyFail ? 'FAIL' : 'PASS'}  (modes: ${modes.join(', ')})`);
        line(BAR);
        process.exit(anyFail ? 1 : 0);
    }

    // ── LIVE sweep ────────────────────────────────────────────────────────────
    if (!modes.length) {
        line('\nNo credential found and no --self-check. Put ONE of these in tests/live/anthropic/.env.test:');
        line('  ANTHROPIC_API_KEY=...     (api_key path)');
        line('  SETUP_TOKEN=...           (setup_token / Pro-Max path)');
        line('…or run with --self-check to validate the body offline (no creds, no external network).');
        process.exit(1);
    }
    for (const mode of modes) {
        if (mode === 'apikey' && !creds.apiKey) { line(`\n[SETUP ERROR] mode=apikey selected but ANTHROPIC_API_KEY is missing.`); process.exit(1); }
        if (mode === 'setup_token' && !creds.token) { line(`\n[SETUP ERROR] mode=setup_token selected but SETUP_TOKEN is missing.`); process.exit(1); }
    }

    const results = [];
    for (const mode of modes) {
        const models = modelsForMode(args.models, reg, testModelsEnv);
        results.push(await runWorker(mode, { selfCheck: false, live: true, baseUrl: args.baseUrl, models, creds, defaultModel: reg.defaultModel }));
    }
    let setupError = false;
    for (const r of results) {
        if (r.error) { setupError = true; line(`\n[ERROR] mode=${r.mode}: ${r.error}`); continue; }
        printLive(r, reg);
    }
    line(`\n${BAR}`);
    line(`LIVE SWEEP COMPLETE (modes: ${modes.join(', ')}).`);
    line(BAR);
    process.exit(setupError ? 1 : 0);
})();
