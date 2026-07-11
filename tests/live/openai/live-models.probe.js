#!/usr/bin/env node
// tests/live/openai/live-models.probe.js
// ─────────────────────────────────────────────────────────────────────────────
// LIVE OpenAI model-matrix probe — "EXACT AGENT COPY" edition (BAT-1144, Part 2).
//
// Unlike a black-box live harness that fakes the system prompt + tools, THIS probe
// imports the REAL agent modules and builds the Responses API request the EXACT way
// ai.js chat() does:
//   • ai.buildSystemBlocks()  → the real ~54KB system prompt (seeded workspace)
//   • tools/index TOOLS        → the real 64-tool telegram registry
//   • providers/openai adapter → formatSystemPrompt / formatTools / toApiMessages /
//                                formatRequest (the real wire body)
//   • http.js httpOpenAIStreamingRequest → the real streaming transport (live path)
//
// providers/openai.js freezes `isOAuth` + `endpoint` at module load from
// OPENAI_AUTH_TYPE, so ONE process = ONE auth mode. The parent forks one worker
// per mode (api_key → api.openai.com/v1/responses, oauth → chatgpt.com Codex).
//
// SECURITY: credentials come ONLY from tests/live/openai/.env.test (gitignored).
// Tokens are NEVER printed — only present(len=N). Node builtins only; no deps.
//
// USAGE
//   node tests/live/openai/live-models.probe.js --self-check      # offline, no creds, no EXTERNAL network*
//   node tests/live/openai/live-models.probe.js                   # live sweep (needs .env.test)
//   node tests/live/openai/live-models.probe.js --mode oauth --diagnose
//   node tests/live/openai/live-models.probe.js --models gpt-5.4,gpt-5.5
//   node tests/live/openai/live-models.probe.js --base-url http://127.0.0.1:8080
//
//   * "no EXTERNAL network": --self-check makes no OpenAI/internet call, but the real
//     buildSystemBlocks() fires a fire-and-forget /burner/status probe at the localhost
//     bridge; with no bridge server it fails silently and doesn't affect the result.
//
// Exit: 0 whenever the sweep/self-check ran; 1 only on setup/credential/assert error.
'use strict';

const path = require('path');
const fs = require('fs');
const { fork } = require('child_process');

const { loadEnvTest, redact } = require('./_shared/env');
const { seedFixture } = require('./_shared/fixture');

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
OpenAI live model-matrix probe — EXACT AGENT COPY (BAT-1144)

  node tests/live/openai/live-models.probe.js [flags]

Flags:
  --self-check        Offline acceptance test. No secrets, NO network. Seeds both
                      fixtures with placeholders, builds the REAL body per mode via
                      the agent seam, and asserts the wire shape. Exit 0 all-pass.
  --mode <m>          apikey | oauth | both. Default: whichever creds exist.
  --models <csv|all|newest>
                      Models to sweep. 'all' = the registry set for the mode
                      (ignores TEST_MODELS). 'newest' currently sweeps the registry
                      set too, but the worker prints a live /v1/models-vs-registry
                      DIFF so newly-listed ids surface for show/hide review
                      (auto-sweeping only the new ids is a follow-up).
                      Default: TEST_MODELS if set, else the registry set.
  --diagnose          Also sweep the reasoning-effort ladder
                      (none/minimal/low/medium/high/xhigh/max) — clearly BEYOND
                      agent parity (the agent only sends medium/auto). Live only.
  --base-url <url>    Gateway override for the live POST (host[:port]); the
                      adapter's real path is preserved.
  --help              This help.

Credentials (tests/live/openai/.env.test, gitignored):
  OPENAI_API_KEY=...          api_key path (api.openai.com/v1/responses)
  OPENAI_OAUTH_TOKEN=...      oauth path (chatgpt.com Codex)
  OPENAI_OAUTH_REFRESH=...    optional
  TEST_MODELS=a,b,c           optional default model set

"Exact copy": the probe does NOT re-implement the prompt or tools. It require()s
the same ai.js / tools/index / providers/openai the device runs, so the body is
byte-for-byte what the agent sends (minus MCP tools, which the harness omits).
`);
}

// ── registry helpers (single source of truth: model-registry.json) ────────────
function loadRegistryOpenAI() {
    const j = JSON.parse(fs.readFileSync(REGISTRY, 'utf8'));
    const openai = (j.providers || []).find((p) => p.id === 'openai') || {};
    const apikey = (openai.models || []).map((m) => m.id);
    const oauth = ((openai.modelsByAuth && openai.modelsByAuth.oauth) || openai.models || []).map((m) => m.id);
    return { apikey, oauth, defaultModel: openai.defaultModel || 'gpt-5.4' };
}

function modelsForMode(mode, modelsFlag, regModels, testModelsEnv) {
    const registrySet = () => (mode === 'oauth' ? regModels.oauth : regModels.apikey);
    // Explicit CSV always wins.
    if (modelsFlag && modelsFlag !== 'all' && modelsFlag !== 'newest') {
        return modelsFlag.split(',').map((s) => s.trim()).filter(Boolean);
    }
    // `--models all` → the registry set for the mode, IGNORING TEST_MODELS. An
    // explicit `all` must not be silently narrowed by the env default (CodeRabbit).
    if (modelsFlag === 'all') return registrySet();
    // `--models newest` currently maps to the registry set too; the worker still
    // fetches /v1/models live and prints a registry-vs-listed DIFF for the show/hide
    // decision, so newly-listed ids surface there. (Auto-sweeping only the newest
    // ids from /v1/models is a documented follow-up — see README.)
    if (modelsFlag === 'newest') return registrySet();
    // No flag → the TEST_MODELS default if set, else the registry set.
    if (testModelsEnv) {
        const list = testModelsEnv.split(',').map((s) => s.trim()).filter(Boolean);
        if (list.length) return list;
    }
    return registrySet();
}

// ── fork a worker for one mode ────────────────────────────────────────────────
function runWorker(mode, { selfCheck, diagnose, live, baseUrl, models, creds }) {
    return new Promise((resolve) => {
        const fixtureDir = path.join(FIXTURES, mode);
        try {
            seedFixture(fixtureDir, {
                mode,
                model: (models && models[0]) || 'gpt-5.4',
                apiKey: mode === 'apikey' ? (creds.apiKey || undefined) : undefined,
                oauthToken: mode === 'oauth' ? (creds.oauth || undefined) : undefined,
                oauthRefresh: mode === 'oauth' ? (creds.refresh || undefined) : undefined,
            });
        } catch (e) {
            return resolve({ mode, error: `[seed] ${e.message}` });
        }

        const env = {
            ...process.env,
            SC_MODE: mode,
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
    line(`\n  ── Built body (token-redacted; instructions/tools abbreviated) ──`);
    line('  keys: ' + JSON.stringify(sc.render.keys));
    line('  ' + JSON.stringify(sc.render.critical, null, 2).split('\n').join('\n  '));
    line('\n  ── instructions (head + tail; full length above) ──');
    line(sc.render.instructionsAbbrev.split('\n').map((l) => '  | ' + l).join('\n'));
    line(`\n  → mode ${result.mode}: ${sc.pass ? 'PASS' : 'FAIL'}`);
}

function printLive(result, reg) {
    const lv = result.live;
    line(`\n${BAR}`);
    line(`LIVE SWEEP · mode=${result.mode}  endpoint=${lv.endpoint.hostname}${lv.endpoint.path}`);
    line(BAR);
    line('  model'.padEnd(22) + 'variant'.padEnd(34) + 'status  ok   lat     detail');
    for (const r of lv.results) {
        const detail = r.ok ? `"${r.text}"${r.toolCalls ? ` +${r.toolCalls} toolCalls` : ''}` : r.errBody;
        line('  ' + String(r.model).padEnd(20) + String(r.variant).padEnd(34)
            + String(r.status).padStart(5) + '  ' + (r.ok ? 'Y' : 'n') + '   '
            + (String(r.latencyMs) + 'ms').padStart(7) + '  ' + (detail || '').slice(0, 60));
    }
    // registry show/hide comparison
    const regList = result.mode === 'oauth' ? reg.oauth : reg.apikey;
    const listed = lv.listedModels || { status: -1, ids: [] };
    line(`\n  ── registry vs live (/v1/models status=${listed.status}) ──`);
    for (const m of regList) {
        const seen = listed.ids.includes(m);
        const parity = lv.results.find((r) => r.model === m && r.variant.startsWith('agent-parity'));
        const responds = parity ? (parity.ok ? 'responds' : `HTTP ${parity.status}`) : 'not-swept';
        line(`    ${m.padEnd(20)} inModels=${seen ? 'YES' : 'no '}  ${responds}`);
    }
    const extra = (listed.ids || []).filter((id) => !regList.includes(id) && /^(gpt|o[0-9]|chatgpt|codex)/i.test(id));
    if (extra.length) line(`    (in /v1/models but NOT in registry: ${extra.join(', ')})`);
}

// ── main ──────────────────────────────────────────────────────────────────────
(async function main() {
    const args = parseArgs(process.argv);
    if (args.help) { usage(); process.exit(0); }

    const { loaded } = loadEnvTest(ENV_TEST);
    const creds = {
        apiKey: (process.env.OPENAI_API_KEY || '').trim(),
        oauth: (process.env.OPENAI_OAUTH_TOKEN || '').trim(),
        refresh: (process.env.OPENAI_OAUTH_REFRESH || '').trim(),
    };
    const testModelsEnv = (process.env.TEST_MODELS || '').trim();
    const reg = loadRegistryOpenAI();

    line(`${BAR}`);
    line('OpenAI live model probe — EXACT AGENT COPY (BAT-1144)');
    line(`.env.test: ${loaded ? 'loaded' : 'not found'}   OPENAI_API_KEY=${redact(creds.apiKey)}   OPENAI_OAUTH_TOKEN=${redact(creds.oauth)}`);
    line(BAR);

    // Resolve modes.
    let modes;
    if (args.mode === 'apikey' || args.mode === 'oauth') modes = [args.mode];
    else if (args.mode === 'both') modes = ['apikey', 'oauth'];
    else if (args.selfCheck) modes = ['apikey', 'oauth'];
    else {
        modes = [];
        if (creds.apiKey) modes.push('apikey');
        if (creds.oauth) modes.push('oauth');
    }

    // ── SELF-CHECK (offline) ──────────────────────────────────────────────────
    if (args.selfCheck) {
        line('\nMODE: --self-check (offline, no external network). Seeding both fixtures with placeholders.');
        const results = [];
        for (const mode of modes) {
            const models = modelsForMode(mode, args.models, reg, testModelsEnv);
            results.push(await runWorker(mode, { selfCheck: true, diagnose: false, live: false, baseUrl: null, models, creds: {} }));
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
        line('\nNo credential found and no --self-check. Put ONE of these in tests/live/openai/.env.test:');
        line('  OPENAI_API_KEY=...        (api_key path)');
        line('  OPENAI_OAUTH_TOKEN=...    (oauth / Codex path)');
        line('…or run with --self-check to validate the body offline (no creds, no external network).');
        process.exit(1);
    }
    // A mode was requested/selected but its credential is missing → setup error.
    for (const mode of modes) {
        if (mode === 'apikey' && !creds.apiKey) { line(`\n[SETUP ERROR] mode=apikey selected but OPENAI_API_KEY is missing.`); process.exit(1); }
        if (mode === 'oauth' && !creds.oauth) { line(`\n[SETUP ERROR] mode=oauth selected but OPENAI_OAUTH_TOKEN is missing.`); process.exit(1); }
    }

    const results = [];
    for (const mode of modes) {
        const models = modelsForMode(mode, args.models, reg, testModelsEnv);
        results.push(await runWorker(mode, { selfCheck: false, diagnose: args.diagnose, live: true, baseUrl: args.baseUrl, models, creds }));
    }
    let setupError = false;
    for (const r of results) {
        if (r.error) { setupError = true; line(`\n[ERROR] mode=${r.mode}: ${r.error}`); continue; }
        printLive(r, reg);
    }
    line(`\n${BAR}`);
    line(`LIVE SWEEP COMPLETE (modes: ${modes.join(', ')}).`);
    line(BAR);
    // Report-only: exit 0 whenever the sweep ran; 1 only on setup error.
    process.exit(setupError ? 1 : 0);
})();
