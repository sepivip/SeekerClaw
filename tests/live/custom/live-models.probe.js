#!/usr/bin/env node
// tests/live/custom/live-models.probe.js
// ─────────────────────────────────────────────────────────────────────────────
// LIVE Custom-provider model probe — "EXACT AGENT COPY" edition (BAT-1144, Part 2).
//
// The "custom" provider is a user-configured OpenAI-compatible gateway (a middleman
// / self-hosted endpoint). Its default wire format is chat_completions, so the body
// is a clean Chat Completions request (system message + tools + stream:true) sent to
// whatever customBaseUrl the user configured.
//
// Unlike a black-box live harness that fakes the system prompt + tools, THIS probe
// imports the REAL agent modules and builds the request the EXACT way ai.js chat()
// does:
//   • ai.buildSystemBlocks()   → the real ~54KB system prompt (seeded workspace)
//   • tools/index TOOLS         → the real 64-tool telegram registry
//   • providers/custom adapter  → formatSystemPrompt / formatTools / toApiMessages /
//                                 formatRequest (the real wire body; delegates the
//                                 chat_completions shaping to openrouter.js)
//   • http.js httpChatCompletionsStreamingRequest → the real streaming transport
//
// config.js freezes CUSTOM_ENDPOINT / CUSTOM_FORMAT / CUSTOM_KEY at module load from
// config.json (customBaseUrl / customFormat / customApiKey). Custom has a SINGLE auth
// mode (api_key) — NO fork per mode. The parent forks ONE worker with a seeded
// fixture workDir.
//
// SECURITY: credentials come ONLY from tests/live/custom/.env.test (gitignored).
// Tokens are NEVER printed — only present(len=N). Node builtins only; no deps.
//
// USAGE
//   node tests/live/custom/live-models.probe.js --self-check   # offline, no creds, no EXTERNAL network*
//   node tests/live/custom/live-models.probe.js                # live sweep (needs .env.test)
//   node tests/live/custom/live-models.probe.js --models gpt-4o-mini,llama-3.3-70b
//   node tests/live/custom/live-models.probe.js --base-url http://127.0.0.1:8080
//
//   * "no EXTERNAL network": --self-check makes no gateway/internet call, but the real
//     buildSystemBlocks() fires a fire-and-forget /burner/status probe at the localhost
//     bridge; with no bridge server it fails silently and doesn't affect the result.
//
// Exit: 0 whenever the sweep/self-check ran; 1 only on setup/credential/assert error.
'use strict';

const path = require('path');
const { fork } = require('child_process');

const { loadEnvTest, redact } = require('../_shared/env');
const { seedFixture } = require('../_shared/fixture');

const HERE = __dirname;
const WORKER = path.join(HERE, 'worker.js');
const ENV_TEST = path.join(HERE, '.env.test');
const FIXTURES = path.join(HERE, 'fixtures');

// Placeholder base URL + model for the OFFLINE self-check (the adapter REQUIRES a
// customBaseUrl + model to boot). The live sweep uses the real CUSTOM_BASE_URL /
// CUSTOM_MODEL from .env.test.
const PLACEHOLDER_BASE_URL = 'https://api.example.com/v1';
const PLACEHOLDER_MODEL = 'gpt-4o-mini';

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
Custom-provider live model probe — EXACT AGENT COPY (BAT-1144)

  node tests/live/custom/live-models.probe.js [flags]

Flags:
  --self-check        Offline acceptance test. No secrets, NO network. Seeds a
                      fixture with a PLACEHOLDER base URL + model, builds the REAL
                      chat_completions body via the agent seam, and asserts the wire
                      shape. Exit 0 all-pass.
  --models <csv>      Models to sweep. Default: CUSTOM_MODEL from .env.test. Custom
                      is freeform — model ids are whatever the gateway accepts, so
                      there is no registry model list.
  --mode apikey       Accepted for symmetry only — custom has a single auth mode.
  --diagnose          Accepted for symmetry — documented NO-OP for chat_completions
                      custom (the body carries no reasoning field to sweep).
  --base-url <url>    Gateway override for the live POST (host[:port]); the
                      adapter's real path is preserved.
  --help              This help.

Credentials (tests/live/custom/.env.test, gitignored):
  CUSTOM_API_KEY=...          bearer token for the gateway
  CUSTOM_BASE_URL=...         full gateway URL (e.g. https://my-gw.example/v1/chat/completions)
  CUSTOM_MODEL=...            the model id to send

"Exact copy": the probe does NOT re-implement the prompt or tools. It require()s
the same ai.js / tools/index / providers/custom the device runs, so the body is
byte-for-byte what the agent sends (minus MCP tools, which the harness omits).
`);
}

// ── fork the worker ────────────────────────────────────────────────────────────
function runWorker({ selfCheck, diagnose, live, baseUrl, models, creds }) {
    return new Promise((resolve) => {
        const fixtureDir = path.join(FIXTURES, 'apikey');
        const isLive = !!live;
        try {
            seedFixture(fixtureDir, {
                provider: 'custom',
                model: isLive ? ((models && models[0]) || creds.model || PLACEHOLDER_MODEL) : PLACEHOLDER_MODEL,
                authConfig: {
                    authType: 'api_key',
                    customApiKey: isLive ? (creds.apiKey || 'sk-test-PLACEHOLDER') : 'sk-test-PLACEHOLDER',
                    customBaseUrl: isLive ? (creds.baseUrl || PLACEHOLDER_BASE_URL) : PLACEHOLDER_BASE_URL,
                    customFormat: 'chat_completions',
                },
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
    line(`SELF-CHECK · provider=custom  endpoint=${sc.endpoint.hostname}${sc.endpoint.path}  model=${sc.model}  tools=${sc.toolCount}`);
    line(BAR);
    for (const a of sc.asserts) {
        line(`  ${a.ok ? 'PASS' : 'FAIL'}  ${a.name}${a.detail ? `   (${a.detail})` : ''}`);
    }
    line(`\n  ── Built body (token-redacted; system/tools abbreviated) ──`);
    line('  keys: ' + JSON.stringify(sc.render.keys));
    line('  ' + JSON.stringify(sc.render.critical, null, 2).split('\n').join('\n  '));
    line('\n  ── system message (head + tail; full length above) ──');
    line(sc.render.instructionsAbbrev.split('\n').map((l) => '  | ' + l).join('\n'));
    line(`\n  → custom: ${sc.pass ? 'PASS' : 'FAIL'}`);
}

function printLive(result) {
    const lv = result.live;
    line(`\n${BAR}`);
    line(`LIVE SWEEP · provider=custom  endpoint=${lv.endpoint.hostname}${lv.endpoint.path}`);
    line(BAR);
    line('  model'.padEnd(28) + 'variant'.padEnd(30) + 'status  ok   lat     detail');
    for (const r of lv.results) {
        const detail = r.ok ? `"${r.text}"${r.toolCalls ? ` +${r.toolCalls} toolCalls` : ''}` : r.errBody;
        line('  ' + String(r.model).padEnd(26) + String(r.variant).padEnd(30)
            + String(r.status).padStart(5) + '  ' + (r.ok ? 'Y' : 'n') + '   '
            + (String(r.latencyMs) + 'ms').padStart(7) + '  ' + (detail || '').slice(0, 60));
    }
}

// ── main ──────────────────────────────────────────────────────────────────────
(async function main() {
    const args = parseArgs(process.argv);
    if (args.help) { usage(); process.exit(0); }

    const { loaded } = loadEnvTest(ENV_TEST);
    const creds = {
        apiKey: (process.env.CUSTOM_API_KEY || '').trim(),
        baseUrl: (process.env.CUSTOM_BASE_URL || '').trim(),
        model: (process.env.CUSTOM_MODEL || '').trim(),
    };

    line(`${BAR}`);
    line('Custom-provider live model probe — EXACT AGENT COPY (BAT-1144)');
    line(`.env.test: ${loaded ? 'loaded' : 'not found'}   CUSTOM_API_KEY=${redact(creds.apiKey)}   CUSTOM_BASE_URL=${creds.baseUrl ? 'set' : '(none)'}   CUSTOM_MODEL=${creds.model || '(none)'}`);
    line(BAR);

    // ── SELF-CHECK (offline) ──────────────────────────────────────────────────
    if (args.selfCheck) {
        line('\nMODE: --self-check (offline, no external network). Seeding fixture with placeholder base URL + model.');
        const models = args.models ? args.models.split(',').map((s) => s.trim()).filter(Boolean) : [];
        const result = await runWorker({ selfCheck: true, diagnose: false, live: false, baseUrl: null, models, creds: {} });
        line(`\n${BAR}`);
        if (result.error) { line(`\n[SETUP ERROR] ${result.error}`); line(BAR); process.exit(1); }
        printSelfCheck(result);
        line(`\n${BAR}`);
        line(`SELF-CHECK RESULT: ${result.selfCheck.pass ? 'PASS' : 'FAIL'}`);
        line(BAR);
        process.exit(result.selfCheck.pass ? 0 : 1);
    }

    // ── LIVE sweep ────────────────────────────────────────────────────────────
    if (!creds.apiKey || !creds.baseUrl || !creds.model) {
        line('\nCustom provider needs ALL of the following in tests/live/custom/.env.test:');
        line('  CUSTOM_API_KEY=...     (bearer token)');
        line('  CUSTOM_BASE_URL=...    (full gateway URL)');
        line('  CUSTOM_MODEL=...       (model id to send)');
        line('…or run with --self-check to validate the body offline (no creds, no external network).');
        process.exit(1);
    }

    const models = args.models ? args.models.split(',').map((s) => s.trim()).filter(Boolean) : [creds.model];
    const result = await runWorker({ selfCheck: false, diagnose: args.diagnose, live: true, baseUrl: args.baseUrl, models, creds });
    if (result.error) {
        line(`\n[ERROR] ${result.error}`);
        line(`\n${BAR}`);
        line('LIVE SWEEP: SETUP ERROR (see above).');
        line(BAR);
        process.exit(1);
    }
    printLive(result);
    line(`\n${BAR}`);
    line('LIVE SWEEP COMPLETE (provider: custom).');
    line(BAR);
    // Report-only: exit 0 whenever the sweep ran; 1 only on setup error.
    process.exit(0);
})();
