#!/usr/bin/env node
// tests/live/xai/live-models.probe.js
// ─────────────────────────────────────────────────────────────────────────────
// LIVE xAI model-matrix probe (BAT-1124). Hits api.x.ai directly with YOUR
// credential and reports, per Grok model:
//   • EXISTS?      — is it in GET /v1/models for this credential
//   • RESPONDS?    — POST /v1/chat/completions, both NON-streaming AND STREAMING
//                    (streaming = the exact path the on-device agent uses)
//   • PARAMS       — which request parameters a failing model actually needs
// …so "grok-4.5 doesn't respond on device" becomes a data question, and we can
// compare this output directly against on-device behaviour.
//
// SECURITY
//   • Credentials are read ONLY from tests/live/xai/.env.test (gitignored via
//     `.env.*`). Never commit it. Tokens are NEVER printed — only presence+length.
//   • Node builtins only (https/http/fs/crypto/url) — no npm install, no deps.
//
// USAGE
//   1) cp tests/live/xai/.env.example tests/live/xai/.env.test
//      …and fill in AT LEAST ONE credential:
//        XAI_API_KEY=...          (console.x.ai key — api_key path; easiest to get)
//        XAI_OAUTH_TOKEN=...      (SuperGrok access token — the DEVICE path)
//   2) node tests/live/xai/live-models.probe.js
//
//   OR test the real OAuth path with NO token on disk (in-memory only):
//      node tests/live/xai/live-models.probe.js --login
//   …which does the loopback+PKCE "Sign in with Grok" flow in a browser, exactly
//   like the device, then runs the sweep with the freshly-issued OAuth token.
//
// Exit: 0 if the sweep ran (per-model verdicts printed); 1 on setup/credential error.
'use strict';

const fs = require('fs');
const path = require('path');
const https = require('https');
const http = require('http');
const crypto = require('crypto');
const { spawn } = require('child_process');

// ── app-parity constants — MUST match providers/xai.js + XaiOAuthActivity.kt ──
// A SeekerClaw-style UA (api.x.ai + the CF-gated auth.x.ai see this). Defaults to
// a current app version but is OVERRIDABLE via XAI_UA for exact device parity —
// the app's real UA is `SeekerClaw/<BuildConfig.VERSION_NAME>`, which bumps each
// release, so don't treat this constant as a hard "must match".
const UA = process.env.XAI_UA || 'SeekerClaw/2.1.1';
const OAUTH_CLIENT_ID = 'b1a00492-073a-47ea-816f-4c329264a828';
const AUTH_ORIGIN = 'https://auth.x.ai';
const AUTHORIZE_URL = `${AUTH_ORIGIN}/oauth2/authorize`;
const TOKEN_URL = `${AUTH_ORIGIN}/oauth2/token`;
const REDIRECT_HOST = '127.0.0.1';
const REDIRECT_PORT = 56121;
const REDIRECT_PATH = '/callback';
const REDIRECT_URI = `http://${REDIRECT_HOST}:${REDIRECT_PORT}${REDIRECT_PATH}`;
const SCOPE = 'openid profile email offline_access grok-cli:access api:access';
const HTTP_TIMEOUT_MS = 30000;
const LOGIN_WAIT_MS = 5 * 60 * 1000;

// Inference base (mirror providers/xai.js XAI_BASE_URL override, incl. protocol+port).
function resolveBase() {
  const raw = (process.env.XAI_BASE_URL || '').trim();
  if (!raw) return { protocol: 'https:', hostname: 'api.x.ai', port: 443 };
  try {
    const u = new URL(raw.includes('://') ? raw : `https://${raw}`);
    return {
      protocol: u.protocol || 'https:',
      hostname: u.hostname || 'api.x.ai',
      port: u.port ? parseInt(u.port, 10) : (u.protocol === 'http:' ? 80 : 443),
    };
  } catch (_) {
    return { protocol: 'https:', hostname: 'api.x.ai', port: 443 };
  }
}
const BASE = resolveBase();

// Models we care about: the shipped registry set + grok-4.5 (the one under scrutiny).
// /v1/models results are merged in at runtime so we also cover anything new.
const REGISTRY_MODELS = [
  'grok-4.3',
  'grok-4.20-0309-reasoning',
  'grok-4.20-0309-non-reasoning',
  'grok-4.20-multi-agent-0309',
  'grok-build-0.1',
];
// BAT-1316: grok-4.6 joins the scrutiny set. /v1/models already merges in
// anything the credential can see, so [A]/[B]/[C] would cover it either way --
// but SCRUTINY_MODELS is what drives phase [D] PARAMETER PROBING, and [D] is the
// only phase that answers the question the registry actually needs: does this
// model accept reasoning_effort? Without it, a model that merely WORKS is never
// param-probed, and we would be guessing reasoningSupport again.
const SCRUTINY_MODELS = ['grok-4.6', 'grok-4.5'];

// ── .env.test loader (manual KEY=VALUE; no dotenv dependency) ─────────────────
function loadEnvTest() {
  const p = path.join(__dirname, '.env.test');
  if (!fs.existsSync(p)) return false;
  for (const line of fs.readFileSync(p, 'utf8').split(/\r?\n/)) {
    const t = line.trim();
    if (!t || t.startsWith('#')) continue;
    const eq = t.indexOf('=');
    if (eq < 0) continue;
    const k = t.slice(0, eq).trim();
    let v = t.slice(eq + 1).trim();
    if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) v = v.slice(1, -1);
    if (!(k in process.env)) process.env[k] = v;
  }
  return true;
}

function redact(tok) { return tok ? `present(len=${String(tok).length})` : '(none)'; }

function verdict(status) {
  switch (status) {
    case 200: return 'WORKS';
    case 400: return 'BAD-REQUEST (params/model shape rejected)';
    case 401: return 'UNAUTHORIZED (bad/expired credential)';
    case 403: return 'FORBIDDEN (tier/entitlement gate)';
    case 404: return 'NOT-FOUND (model id unknown to this account)';
    case 429: return 'RATE-LIMITED';
    default: return `HTTP ${status}`;
  }
}

// ── raw HTTPS JSON request ────────────────────────────────────────────────────
function request(method, pathname, { token, body } = {}) {
  return new Promise((resolve) => {
    const mod = BASE.protocol === 'http:' ? http : https;
    const data = body ? JSON.stringify(body) : null;
    const req = mod.request({
      protocol: BASE.protocol, hostname: BASE.hostname, port: BASE.port, path: pathname, method,
      headers: {
        Authorization: `Bearer ${token}`,
        'User-Agent': UA,
        Accept: 'application/json',
        ...(data ? { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data) } : {}),
      },
    }, (res) => {
      let buf = '';
      res.on('data', (c) => (buf += c));
      res.on('end', () => {
        let json = null;
        try { json = JSON.parse(buf); } catch (_) {}
        resolve({ status: res.statusCode, headers: res.headers, body: buf, json });
      });
    });
    req.on('error', (e) => resolve({ status: -1, body: e.message, json: null }));
    req.setTimeout(HTTP_TIMEOUT_MS, () => { req.destroy(); resolve({ status: -2, body: 'timeout', json: null }); });
    if (data) req.write(data);
    req.end();
  });
}

async function listModels(token) {
  const r = await request('GET', '/v1/models', { token });
  const ids = (r.status === 200 && Array.isArray(r.json?.data)) ? r.json.data.map((m) => m.id).sort() : [];
  return { status: r.status, ids, raw: (r.body || '').slice(0, 200) };
}

async function chatOnce(token, model, { maxTokens = 64, prompt = 'Reply with the single word: pong', extra = {} } = {}) {
  const started = Date.now();
  const body = { model, messages: [{ role: 'user', content: prompt }], ...extra };
  if (maxTokens != null) body.max_tokens = maxTokens;
  const r = await request('POST', '/v1/chat/completions', { token, body });
  const reply = r.json?.choices?.[0]?.message?.content || '';
  return {
    status: r.status, ok: r.status === 200 && !!reply, reply: reply.slice(0, 80),
    usage: r.json?.usage || null, errBody: r.status === 200 ? '' : (r.body || '').slice(0, 300),
    latencyMs: Date.now() - started,
  };
}

// STREAMING chat — mirrors the on-device path (httpChatCompletionsStreamingRequest, stream:true).
function chatStream(token, model, { maxTokens = 64, prompt = 'ping', extra = {} } = {}) {
  return new Promise((resolve) => {
    const started = Date.now();
    const mod = BASE.protocol === 'http:' ? http : https;
    const body = JSON.stringify({ model, stream: true, max_tokens: maxTokens, messages: [{ role: 'user', content: prompt }], ...extra });
    let status = 0, chunks = 0, text = '', errBody = '';
    const req = mod.request({
      protocol: BASE.protocol, hostname: BASE.hostname, port: BASE.port, path: '/v1/chat/completions', method: 'POST',
      headers: {
        Authorization: `Bearer ${token}`, 'User-Agent': UA, 'Content-Type': 'application/json',
        Accept: 'text/event-stream', 'Content-Length': Buffer.byteLength(body),
      },
    }, (res) => {
      status = res.statusCode;
      let sseBuf = ''; // preserve a partial data: line across TCP chunk boundaries
      res.on('data', (c) => {
        const s = c.toString();
        if (status !== 200) { errBody += s; return; }
        sseBuf += s;
        let nl;
        while ((nl = sseBuf.indexOf('\n')) >= 0) {
          const l = sseBuf.slice(0, nl).trim(); sseBuf = sseBuf.slice(nl + 1);
          if (!l.startsWith('data:')) continue;
          const payload = l.slice(5).trim();
          if (!payload || payload === '[DONE]') continue;
          try {
            const delta = JSON.parse(payload).choices?.[0]?.delta?.content;
            if (delta) { chunks++; text += delta; }
          } catch (_) {}
        }
      });
      res.on('end', () => resolve({
        status, ok: status === 200 && chunks > 0, chunks, text: text.slice(0, 80),
        errBody: errBody.slice(0, 300), latencyMs: Date.now() - started,
      }));
    });
    req.on('error', (e) => resolve({ status: -1, ok: false, chunks: 0, text: '', errBody: e.message, latencyMs: Date.now() - started }));
    req.setTimeout(HTTP_TIMEOUT_MS, () => { req.destroy(); resolve({ status: -2, ok: false, chunks, text, errBody: 'timeout', latencyMs: Date.now() - started }); });
    req.write(body); req.end();
  });
}

// ── grok-4.5 reasoning/timeout DIAGNOSIS (reproduces the device: tools + stream) ─
// The device sends the full agent request (~64 tools + system prompt), which makes
// grok-4.5 reason silently >60s → the app's 60s socket-idle timeout fires. This
// probe reproduces that with tools + a system prompt, across reasoning-param
// variants, measuring time-to-first-BYTE (does it stream anything during reasoning?)
// vs time-to-first-CONTENT vs total — the levers for the app-side fix.
function fakeTools(n) {
  return Array.from({ length: n }, (_, i) => ({
    type: 'function',
    function: {
      name: `tool_${i}_operation`,
      description: `Performs operation ${i}. Consider carefully whether this tool applies to the user's request before invoking it; weigh it against the other available tools.`,
      parameters: { type: 'object', properties: { arg: { type: 'string', description: 'the argument for the operation' } }, required: ['arg'] },
    },
  }));
}
const SYS_PROMPT = ('You are SeekerClaw, an autonomous agent running on a Solana Seeker phone. '
  + 'You have many tools. Think carefully about which tool (if any) applies before acting. Be concise. ').repeat(18);

function chatStreamTimed(token, model, { variant = {}, tools = 0, timeoutMs = 200000, prompt = 'Hey' } = {}) {
  return new Promise((resolve) => {
    const t0 = Date.now();
    let firstByte = 0, firstContent = 0, chunks = 0, reasoningSeen = false, status = 0, text = '', errBody = '';
    const payload = {
      model, stream: true, max_tokens: 512,
      messages: [{ role: 'system', content: SYS_PROMPT }, { role: 'user', content: prompt }],
      ...(tools ? { tools: fakeTools(tools) } : {}),
      ...variant,
    };
    const body = JSON.stringify(payload);
    const mod = BASE.protocol === 'http:' ? http : https; // honor an http:// XAI_BASE_URL gateway
    const req = mod.request({
      protocol: BASE.protocol, hostname: BASE.hostname, port: BASE.port, path: '/v1/chat/completions', method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'User-Agent': UA, 'Content-Type': 'application/json', Accept: 'text/event-stream', 'Content-Length': Buffer.byteLength(body) },
    }, (res) => {
      status = res.statusCode;
      let sseBuf = ''; // preserve a partial data: line across TCP chunk boundaries
      res.on('data', (c) => {
        if (!firstByte) firstByte = Date.now() - t0;
        const s = c.toString();
        if (status !== 200) { errBody += s; return; }
        sseBuf += s;
        let nl;
        while ((nl = sseBuf.indexOf('\n')) >= 0) {
          const l = sseBuf.slice(0, nl).trim(); sseBuf = sseBuf.slice(nl + 1);
          if (!l.startsWith('data:')) continue;
          const p = l.slice(5).trim(); if (!p || p === '[DONE]') continue;
          try {
            const d = JSON.parse(p).choices?.[0]?.delta;
            if (d && (d.reasoning_content || d.reasoning)) reasoningSeen = true;
            if (d && d.content) { if (!firstContent) firstContent = Date.now() - t0; chunks++; text += d.content; }
          } catch (_) {}
        }
      });
      res.on('end', () => resolve({ status, firstByteMs: firstByte, firstContentMs: firstContent, totalMs: Date.now() - t0, chunks, reasoningSeen, text: text.slice(0, 50), errBody: errBody.slice(0, 160) }));
    });
    req.on('error', (e) => resolve({ status: -1, firstByteMs: firstByte, totalMs: Date.now() - t0, chunks, reasoningSeen, errBody: e.message }));
    req.setTimeout(timeoutMs, () => { req.destroy(); resolve({ status: -2, firstByteMs: firstByte, firstContentMs: firstContent, totalMs: Date.now() - t0, chunks, reasoningSeen, errBody: `client-timeout ${timeoutMs}ms` }); });
    req.write(body); req.end();
  });
}

async function diagnose45(token) {
  console.log(`\n${'═'.repeat(78)}`);
  console.log('grok-4.5 REASONING/TIMEOUT DIAGNOSIS  (agent-like: system prompt + tools + stream, 200s cap)');
  console.log('The app times out at 60s of socket IDLE. firstByte>60000ms ⇒ silent reasoning kills it.');
  console.log('═'.repeat(78));
  const variants = [
    ['default + 24 tools           [device repro]', { tools: 24, variant: {} }],
    ['reasoning:{effort:none}+24t  [OR heartbeat shape]', { tools: 24, variant: { reasoning: { effort: 'none' } } }],
    ['reasoning:{effort:low} + 24t [OR low]', { tools: 24, variant: { reasoning: { effort: 'low' } } }],
    ['reasoning_effort:low + 24t   [o-series str]', { tools: 24, variant: { reasoning_effort: 'low' } }],
    ['reasoning_effort:minimal+24t [o-series min]', { tools: 24, variant: { reasoning_effort: 'minimal' } }],
    ['no tools, no reasoning       [control]', { tools: 0, variant: {} }],
  ];
  for (const model of ['grok-4.5', 'grok-4.3']) {
    console.log(`\n── ${model} ──`);
    for (const [label, opts] of variants) {
      const r = await chatStreamTimed(token, model, { ...opts, timeoutMs: 150000 });
      const v = r.status === 200 ? (r.chunks > 0 ? 'OK' : 'EMPTY-200') : (r.status === -2 ? 'CLIENT-TIMEOUT' : verdict(r.status));
      console.log(`  ${label.padEnd(46)} status=${String(r.status).padStart(4)} firstByte=${String(r.firstByteMs || 0).padStart(6)}ms firstContent=${String(r.firstContentMs || 0).padStart(6)}ms total=${String(r.totalMs).padStart(6)}ms chunks=${String(r.chunks || 0).padStart(3)} reasoningStreamed=${r.reasoningSeen ? 'Y' : 'n'}  ${v} ${r.errBody || ('"' + (r.text || '') + '"')}`);
    }
  }
  console.log('\n── FIX LEVER: a variant whose grok-4.5 firstByte<60000ms (streams early) OR total<~55s is the app-side fix (send that param / consume the early stream). If none, grok-4.5 needs a model-aware idle timeout > its total.');
}

// ── the sweep ────────────────────────────────────────────────────────────────
async function runSweep(label, token) {
  console.log(`\n${'═'.repeat(78)}`);
  console.log(`SWEEP: ${label}   UA=${UA}   base=${BASE.protocol}//${BASE.hostname}:${BASE.port}`);
  console.log(`credential: ${redact(token)}`);
  console.log('═'.repeat(78));

  // Phase A — existence via /v1/models
  console.log('\n── [A] GET /v1/models (what THIS credential can actually see) ──');
  const lm = await listModels(token);
  if (lm.status === 200) {
    console.log(`  ${lm.ids.length} models: ${lm.ids.join(', ')}`);
  } else {
    console.log(`  HTTP ${lm.status} — ${lm.raw}  (note: /v1/models 403s on first OAuth touch even when chat works)`);
  }
  for (const m of SCRUTINY_MODELS) {
    console.log(`  → "${m}" present in /v1/models: ${lm.ids.includes(m) ? 'YES ✅' : 'NO ❌'}`);
  }

  const models = [...new Set([...REGISTRY_MODELS, ...SCRUTINY_MODELS, ...lm.ids])];

  // Phase B — non-streaming chat
  console.log('\n── [B] POST /v1/chat/completions — NON-streaming ──');
  const once = {};
  for (const m of models) {
    const r = await chatOnce(token, m);
    once[m] = r;
    console.log(`  ${m.padEnd(30)} ${String(r.status).padStart(4)}  ${verdict(r.status).padEnd(38)} ${(r.latencyMs + 'ms').padStart(7)}  ${r.reply ? '"' + r.reply + '"' : r.errBody}`);
  }

  // Phase C — STREAMING chat (device path)
  console.log('\n── [C] POST /v1/chat/completions — STREAMING (stream:true = the DEVICE path) ──');
  const stream = {};
  for (const m of models) {
    const r = await chatStream(token, m);
    stream[m] = r;
    console.log(`  ${m.padEnd(30)} ${String(r.status).padStart(4)}  chunks=${String(r.chunks).padStart(3)}  ${(r.latencyMs + 'ms').padStart(7)}  ${r.ok ? '"' + r.text + '"' : verdict(r.status) + ' ' + r.errBody}`);
  }

  // Phase D — parameter probing on grok-4.5 + any model that failed either mode
  const failing = models.filter((m) => !once[m]?.ok || !stream[m]?.ok);
  const probeTargets = [...new Set([...SCRUTINY_MODELS.filter((m) => models.includes(m)), ...failing])];
  if (probeTargets.length) {
    console.log('\n── [D] Parameter probing (isolate what a failing model needs) ──');
    const variants = [
      ['baseline max_tokens=64', {}],
      ['no max_tokens', { maxTokens: null }],
      ['max_completion_tokens=64', { maxTokens: null, extra: { max_completion_tokens: 64 } }],
      ['reasoning_effort=low', { extra: { reasoning_effort: 'low' } }],
      ['temperature=0', { extra: { temperature: 0 } }],
      ['max_tokens=256', { maxTokens: 256 }],
    ];
    for (const m of probeTargets) {
      console.log(`  · ${m}`);
      for (const [name, opts] of variants) {
        const r = await chatOnce(token, m, opts);
        console.log(`      ${name.padEnd(28)} ${String(r.status).padStart(4)} ${verdict(r.status)} ${r.errBody || (r.reply ? '"' + r.reply + '"' : '')}`);
      }
    }
  }

  // Diagnosis — grok-4.3 (known-good baseline) vs grok-4.5 (under scrutiny)
  console.log('\n── DIAGNOSIS ──');
  const g43o = once['grok-4.3'], g43s = stream['grok-4.3'];
  const g45o = once['grok-4.5'], g45s = stream['grok-4.5'];
  if (g43o) console.log(`  grok-4.3 : once=${verdict(g43o.status)} stream=${g43s ? verdict(g43s.status) + (g43s.ok ? '/gotText' : '/noText') : 'n/a'}`);
  if (g45o) console.log(`  grok-4.5 : once=${verdict(g45o.status)} stream=${g45s ? verdict(g45s.status) + (g45s.ok ? '/gotText' : '/noText') : 'n/a'}`);
  if (g43o?.ok && g45o) {
    if (g45o.status === 404) console.log('  ⇒ grok-4.5 does NOT exist for this credential → REMOVE it from the registry.');
    else if (g45o.status === 403) console.log('  ⇒ grok-4.5 exists but this credential/tier is NOT entitled → for OAuth use modelsByAuth to keep grok-4.3 the oauth default (or drop 4.5).');
    else if (g45o.status === 400) console.log('  ⇒ grok-4.5 rejects the request shape → see [D] for the parameter it needs.');
    else if (g45o.ok && g45s && !g45s.ok) console.log('  ⇒ grok-4.5 works NON-streaming but STREAMING returns no text → this is the "agent not responding" cause (device streams).');
    else if (g45o.ok && g45s?.ok) console.log('  ⇒ grok-4.5 WORKS here (once+stream). If it fails on device, the device uses OAuth — re-run with --login to test that path.');
  }
  console.log('');
}

// ── OAuth loopback + PKCE (for --login: in-memory token, nothing on disk) ─────
function b64url(buf) { return Buffer.from(buf).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, ''); }
function makePkce() { const verifier = b64url(crypto.randomBytes(32)); return { verifier, challenge: b64url(crypto.createHash('sha256').update(verifier).digest()) }; }

function openBrowser(url) {
  try {
    // win32: `start` is a cmd builtin and cmd.exe treats `&` as a command separator, so
    // the OAuth URL (full of `&` query params) MUST be quoted or auto-open fails (and a
    // trailing `&...` could run as a separate command). windowsVerbatimArguments keeps
    // Node from re-escaping the quotes we add.
    const [cmd, args] = process.platform === 'win32' ? ['cmd', ['/c', 'start', '', `"${url}"`]]
      : process.platform === 'darwin' ? ['open', [url]] : ['xdg-open', [url]];
    const c = spawn(cmd, args, { stdio: 'ignore', detached: true, windowsVerbatimArguments: process.platform === 'win32' }); c.on('error', () => {}); c.unref();
  } catch (_) {}
}

function awaitCallback(expectedState) {
  return new Promise((resolve, reject) => {
    const server = http.createServer((req, res) => {
      const u = new URL(req.url, `http://${REDIRECT_HOST}:${REDIRECT_PORT}`);
      if (u.pathname !== REDIRECT_PATH) { res.writeHead(404); res.end('Not found'); return; }
      const err = u.searchParams.get('error'), code = u.searchParams.get('code'), state = u.searchParams.get('state');
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end(`<!doctype html><body style="font-family:system-ui;padding:2rem"><h2>xAI model probe — ${code && state === expectedState ? 'signed in' : 'error'}</h2><p>Return to the terminal.</p></body>`);
      server.close();
      if (err) return reject(new Error(`authorize error: ${err}`));
      if (state !== expectedState) return reject(new Error('state mismatch (CSRF)'));
      if (!code) return reject(new Error('no code in callback'));
      resolve(code);
    });
    server.on('error', (e) => reject(e.code === 'EADDRINUSE' ? new Error(`port ${REDIRECT_PORT} in use — close whatever holds it`) : e));
    server.listen(REDIRECT_PORT, REDIRECT_HOST);
    setTimeout(() => { try { server.close(); } catch (_) {} reject(new Error('login timeout (5 min)')); }, LOGIN_WAIT_MS);
  });
}

function tokenPost(form) {
  return new Promise((resolve, reject) => {
    const data = new URLSearchParams(form).toString();
    const u = new URL(TOKEN_URL);
    const req = https.request({
      hostname: u.hostname, path: u.pathname, method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'User-Agent': UA, 'Content-Length': Buffer.byteLength(data), Accept: 'application/json' },
    }, (res) => { let b = ''; res.on('data', (c) => (b += c)); res.on('end', () => { try { resolve({ status: res.statusCode, json: JSON.parse(b) }); } catch (_) { resolve({ status: res.statusCode, json: null, raw: b }); } }); });
    req.on('error', reject); req.setTimeout(HTTP_TIMEOUT_MS, () => req.destroy(new Error('token timeout')));
    req.write(data); req.end();
  });
}

async function loginForToken() {
  const { verifier, challenge } = makePkce();
  const state = b64url(crypto.randomBytes(16));
  const nonce = b64url(crypto.randomBytes(16));
  const authUrl = `${AUTHORIZE_URL}?${new URLSearchParams({
    response_type: 'code', client_id: OAUTH_CLIENT_ID, redirect_uri: REDIRECT_URI,
    scope: SCOPE, code_challenge: challenge, code_challenge_method: 'S256', state, nonce,
  })}`;
  console.log('\n[--login] Opening the "Sign in with Grok" consent page (loopback+PKCE, same as the device)…');
  console.log('  If it does not open, paste this URL into a browser signed into SuperGrok / X Premium+:\n  ' + authUrl + '\n');
  openBrowser(authUrl);
  const code = await awaitCallback(state);
  const tok = await tokenPost({ grant_type: 'authorization_code', code, redirect_uri: REDIRECT_URI, client_id: OAUTH_CLIENT_ID, code_verifier: verifier });
  if (tok.status !== 200 || !tok.json?.access_token) throw new Error(`token exchange failed: HTTP ${tok.status} ${tok.raw || JSON.stringify(tok.json)}`);
  console.log(`  ✓ access_token acquired (in-memory only, ${redact(tok.json.access_token)}); expires_in=${tok.json.expires_in}`);
  return tok.json.access_token;
}

// ── main ─────────────────────────────────────────────────────────────────────
(async function main() {
  loadEnvTest();
  const useLogin = process.argv.includes('--login');
  const useDiagnose = process.argv.includes('--diagnose'); // grok-4.5 reasoning/timeout probe (implies a login)
  const apiKey = (process.env.XAI_API_KEY || '').trim();
  const oauthTok = (process.env.XAI_OAUTH_TOKEN || '').trim();

  if (useDiagnose) {
    try {
      const t = oauthTok || (await loginForToken());
      await diagnose45(t);
    } catch (e) { console.error('\n[FATAL] ' + (e && e.stack || e)); process.exit(1); }
    process.exit(0);
  }

  if (!useLogin && !apiKey && !oauthTok) {
    console.error('No credential found. Put ONE of these in tests/live/xai/.env.test:');
    console.error('  XAI_API_KEY=...       (console.x.ai key — api_key path)');
    console.error('  XAI_OAUTH_TOKEN=...   (SuperGrok access token — the device path)');
    console.error('…or run with --login to do the OAuth flow in-browser (no token on disk).');
    process.exit(1);
  }

  try {
    if (oauthTok) await runSweep('OAuth token from .env.test (device path)', oauthTok);
    if (apiKey) await runSweep('API key from .env.test (console.x.ai path)', apiKey);
    if (useLogin) { const t = await loginForToken(); await runSweep('OAuth via --login (fresh, in-memory — EXACT device path)', t); }
  } catch (e) {
    console.error('\n[FATAL] ' + (e && e.stack || e));
    process.exit(1);
  }
  process.exit(0);
})();
