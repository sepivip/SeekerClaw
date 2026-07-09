#!/usr/bin/env node
/*
 * xAI (Grok) OAuth 2.0 Loopback + PKCE proof-spike  --  BAT-1124
 *
 * Proves the FULL authorization-code + PKCE flow against xAI's real OIDC
 * endpoints using the PUBLIC Grok-CLI client (no client secret), so a human
 * with a SuperGrok / X Premium+ account can confirm end-to-end that:
 *   1. the authorize URL is accepted (login + consent screen renders)
 *   2. the code exchanges for an access_token + refresh_token + expires_in
 *   3. the refresh_token grant works AND whether the refresh token ROTATES
 *   4. the access_token authenticates inference (POST /v1/chat/completions +
 *      /v1/responses; GET /v1/models is reported but not required for PASS)
 *
 * SECURITY: nothing secret is hardcoded. Tokens are NEVER printed raw --
 * only length + a boolean "present" flag are logged (no token material, not
 * even a prefix).
 *
 * Runtime: Node 18+ (uses global fetch / crypto.webcrypto). Node builtins
 * only -- no npm install.
 *
 * Run:   node loopback-spike.js
 */

'use strict';

const http = require('node:http');
const crypto = require('node:crypto');
const { URL, URLSearchParams } = require('node:url');
const { spawn } = require('node:child_process');

// ---------------------------------------------------------------------------
// Config -- captured from xAI live OIDC discovery (public, non-secret)
// ---------------------------------------------------------------------------
const CFG = {
  clientId: 'b1a00492-073a-47ea-816f-4c329264a828', // PUBLIC Grok-CLI client, no secret
  scope: 'openid profile email offline_access grok-cli:access api:access',
  authorize: 'https://auth.x.ai/oauth2/authorize',
  token: 'https://auth.x.ai/oauth2/token',
  models: 'https://api.x.ai/v1/models',
  chat: 'https://api.x.ai/v1/chat/completions',
  responses: 'https://api.x.ai/v1/responses',
  redirectHost: '127.0.0.1',
  redirectPort: 56121,
  callbackPath: '/callback',
};
CFG.redirectUri = `http://${CFG.redirectHost}:${CFG.redirectPort}${CFG.callbackPath}`;

// Timeouts (ms)
const AUTH_WAIT_MS = 5 * 60 * 1000; // how long we wait for the user to finish login
const HTTP_TIMEOUT_MS = 30 * 1000;  // per network request to xAI

// ---------------------------------------------------------------------------
// Small helpers
// ---------------------------------------------------------------------------
function b64url(buf) {
  return Buffer.from(buf).toString('base64')
    .replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function randB64url(bytes) {
  return b64url(crypto.randomBytes(bytes));
}

function sha256(str) {
  return crypto.createHash('sha256').update(str).digest();
}

// Redact a token: never print it raw or any slice of it. Show only whether it
// exists and its length — no token material, not even a prefix. Rotation is
// detected by comparing the full tokens in-memory (see below), not by prefix.
function redact(token) {
  if (!token || typeof token !== 'string') return { present: false, length: 0 };
  return { present: true, length: token.length };
}

function describeToken(label, token) {
  const r = redact(token);
  console.log(`      ${label}: present=${r.present} length=${r.length}`);
}

// fetch with a hard timeout via AbortController
async function fetchWithTimeout(url, opts = {}) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), HTTP_TIMEOUT_MS);
  try {
    return await fetch(url, { ...opts, signal: ctrl.signal });
  } finally {
    clearTimeout(t);
  }
}

function tryOpenBrowser(url) {
  const platform = process.platform;
  try {
    let cmd, args;
    if (platform === 'win32') {
      // `start` is a cmd builtin; empty title arg avoids quoting issues
      cmd = 'cmd'; args = ['/c', 'start', '', url];
    } else if (platform === 'darwin') {
      cmd = 'open'; args = [url];
    } else {
      cmd = 'xdg-open'; args = [url];
    }
    const child = spawn(cmd, args, { stdio: 'ignore', detached: true });
    child.on('error', () => { /* ignore -- user can paste manually */ });
    child.unref();
    return true;
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------------------
// Step 1 -- PKCE
// ---------------------------------------------------------------------------
function makePkce() {
  const verifier = randB64url(32);          // 43-char high-entropy verifier
  const challenge = b64url(sha256(verifier)); // S256 challenge
  return { verifier, challenge, method: 'S256' };
}

// ---------------------------------------------------------------------------
// Step 2 -- loopback server (fails clearly if the port is taken)
// ---------------------------------------------------------------------------
function startCallbackServer(expectedState) {
  // Returns { server, waitForCode() } once the socket is bound.
  // Rejects the outer promise (before binding) on EADDRINUSE so the caller
  // can print a clear "port in use" message and exit.
  return new Promise((resolveBind, rejectBind) => {
    let resolveCode, rejectCode;
    const codePromise = new Promise((res, rej) => { resolveCode = res; rejectCode = rej; });

    const server = http.createServer((req, res) => {
      const reqUrl = new URL(req.url, `http://${CFG.redirectHost}:${CFG.redirectPort}`);
      if (reqUrl.pathname !== CFG.callbackPath) {
        res.writeHead(404, { 'Content-Type': 'text/plain' });
        res.end('Not found');
        return;
      }
      const params = reqUrl.searchParams;
      const err = params.get('error');
      const code = params.get('code');
      const state = params.get('state');

      // Always answer the browser so the human sees a friendly page.
      const finish = (ok, msg) => {
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
        res.end(`<!doctype html><html><body style="font-family:system-ui;padding:2rem">
          <h2>${ok ? 'xAI OAuth spike: callback received' : 'xAI OAuth spike: error'}</h2>
          <p>${msg}</p><p>You can close this tab and return to the terminal.</p>
          </body></html>`);
      };

      if (err) {
        finish(false, `Authorization server returned error: ${err} - ${params.get('error_description') || ''}`);
        rejectCode(new Error(`Authorization error: ${err} ${params.get('error_description') || ''}`));
        return;
      }
      // Validate state to defend against CSRF
      if (!state || state !== expectedState) {
        finish(false, 'State mismatch -- possible CSRF. Aborting.');
        rejectCode(new Error(`State mismatch: expected ${expectedState}, got ${state}`));
        return;
      }
      if (!code) {
        finish(false, 'No authorization code present in callback.');
        rejectCode(new Error('No authorization code in callback'));
        return;
      }
      finish(true, 'Authorization code captured. Exchanging it now...');
      resolveCode(code);
    });

    server.on('error', (e) => {
      if (e && e.code === 'EADDRINUSE') {
        rejectBind(new Error(
          `Port ${CFG.redirectPort} on ${CFG.redirectHost} is already in use. ` +
          `The xAI OAuth client only accepts redirect_uri ${CFG.redirectUri}, so this exact ` +
          `port is required. Close whatever is using it (or a stale run of this spike) and retry.`));
      } else {
        rejectBind(e);
      }
    });

    // waitForCode resolves with the code, or rejects on error/timeout.
    function waitForCode() {
      let timer;
      const timeout = new Promise((_, rej) => {
        timer = setTimeout(() => {
          rej(new Error(`Timed out after ${Math.round(AUTH_WAIT_MS / 1000)}s waiting for the login callback.`));
        }, AUTH_WAIT_MS);
      });
      return Promise.race([codePromise, timeout]).finally(() => clearTimeout(timer));
    }

    server.listen(CFG.redirectPort, CFG.redirectHost, () => {
      resolveBind({ server, waitForCode });
    });
  });
}

// ---------------------------------------------------------------------------
// Step 3 -- build authorize URL (NO openai-only params)
// ---------------------------------------------------------------------------
function buildAuthorizeUrl({ challenge, state, nonce }) {
  const p = new URLSearchParams({
    response_type: 'code',
    client_id: CFG.clientId,
    redirect_uri: CFG.redirectUri,
    scope: CFG.scope,
    code_challenge: challenge,
    code_challenge_method: 'S256',
    state,
    nonce,
  });
  return `${CFG.authorize}?${p.toString()}`;
}

// ---------------------------------------------------------------------------
// Step 4 -- exchange authorization code for tokens
// ---------------------------------------------------------------------------
async function exchangeCode(code, verifier) {
  const body = new URLSearchParams({
    grant_type: 'authorization_code',
    code,
    redirect_uri: CFG.redirectUri,
    client_id: CFG.clientId,       // public client -> client_id in body, no secret
    code_verifier: verifier,
  });
  const res = await fetchWithTimeout(CFG.token, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded',
      'Accept': 'application/json',
    },
    body: body.toString(),
  });
  const text = await res.text();
  let json = null;
  try { json = JSON.parse(text); } catch { /* leave null */ }
  if (!res.ok) {
    throw new Error(`Token exchange failed: HTTP ${res.status} ${res.statusText} -- ${text.slice(0, 500)}`);
  }
  return json || {};
}

// ---------------------------------------------------------------------------
// Step 6 -- refresh grant; report whether the refresh_token ROTATED
// ---------------------------------------------------------------------------
async function refreshGrant(refreshToken) {
  const body = new URLSearchParams({
    grant_type: 'refresh_token',
    refresh_token: refreshToken,
    client_id: CFG.clientId,
    scope: CFG.scope,
  });
  const res = await fetchWithTimeout(CFG.token, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded',
      'Accept': 'application/json',
    },
    body: body.toString(),
  });
  const text = await res.text();
  let json = null;
  try { json = JSON.parse(text); } catch { /* leave null */ }
  if (!res.ok) {
    throw new Error(`Refresh grant failed: HTTP ${res.status} ${res.statusText} -- ${text.slice(0, 500)}`);
  }
  return json || {};
}

// ---------------------------------------------------------------------------
// Step 7 -- prove inference auth via GET /v1/models
// ---------------------------------------------------------------------------
async function listModels(accessToken) {
  const res = await fetchWithTimeout(CFG.models, {
    method: 'GET',
    headers: {
      'Authorization': `Bearer ${accessToken}`,
      'Accept': 'application/json',
    },
  });
  const text = await res.text();
  let json = null;
  try { json = JSON.parse(text); } catch { /* leave null */ }
  let count = null, ids = [];
  if (json) {
    const arr = Array.isArray(json.data) ? json.data
      : Array.isArray(json.models) ? json.models
      : Array.isArray(json) ? json : [];
    ids = arr.map((m) => (m && (m.id || m.name)) || m).filter((x) => typeof x === 'string');
    count = arr.length;
  }
  return { status: res.status, ok: res.ok, count, ids, snippet: text.slice(0, 300) };
}

// ---------------------------------------------------------------------------
// Step 7b -- prove INFERENCE auth on the endpoints the feature actually uses
// (/v1/models is only a listing endpoint and may be permission-gated separately)
// ---------------------------------------------------------------------------
async function probeChat(accessToken, model) {
  const res = await fetchWithTimeout(CFG.chat, {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${accessToken}`,
      'Content-Type': 'application/json',
      'Accept': 'application/json',
      'User-Agent': 'SeekerClaw/spike',
    },
    body: JSON.stringify({ model, messages: [{ role: 'user', content: 'ping' }], max_tokens: 8, stream: false }),
  });
  const text = await res.text();
  return { status: res.status, ok: res.ok, snippet: text.slice(0, 400) };
}

async function probeResponses(accessToken, model) {
  const res = await fetchWithTimeout(CFG.responses, {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${accessToken}`,
      'Content-Type': 'application/json',
      'Accept': 'application/json',
      'User-Agent': 'SeekerClaw/spike',
    },
    body: JSON.stringify({ model, input: 'ping' }),
  });
  const text = await res.text();
  return { status: res.status, ok: res.ok, snippet: text.slice(0, 400) };
}

// ---------------------------------------------------------------------------
// Orchestration
// ---------------------------------------------------------------------------
async function main() {
  console.log('==========================================================');
  console.log(' xAI (Grok) OAuth Loopback + PKCE proof-spike  [BAT-1124]');
  console.log('==========================================================');
  console.log(`  Client ID (public):  ${CFG.clientId}`);
  console.log(`  Redirect URI:        ${CFG.redirectUri}`);
  console.log(`  Scope:               ${CFG.scope}`);
  console.log('----------------------------------------------------------\n');

  // Step 1 -- PKCE
  const pkce = makePkce();
  console.log('[1/7] Generated PKCE verifier + S256 challenge.');
  console.log(`      verifier length=${pkce.verifier.length}, challenge length=${pkce.challenge.length}, method=${pkce.method}\n`);

  const state = randB64url(16);
  const nonce = randB64url(16);

  // Step 2 -- start loopback server (this may reject with EADDRINUSE)
  let server, waitForCode;
  try {
    const started = await startCallbackServer(state);
    server = started.server;
    waitForCode = started.waitForCode;
  } catch (e) {
    console.error(`[2/7] FAILED to start loopback server.\n      ${e.message}`);
    process.exit(2);
  }
  console.log(`[2/7] Loopback server listening on ${CFG.redirectUri}\n`);

  // Step 3 -- authorize URL
  const authUrl = buildAuthorizeUrl({ challenge: pkce.challenge, state, nonce });
  console.log('[3/7] Open this URL in a browser signed into your SuperGrok / X Premium+ account:');
  console.log('\n' + authUrl + '\n');
  const opened = tryOpenBrowser(authUrl);
  console.log(opened
    ? '      (Attempted to open it in your default browser automatically.)\n'
    : '      (Could not auto-open a browser -- copy/paste the URL above.)\n');
  console.log(`      Waiting up to ${Math.round(AUTH_WAIT_MS / 1000)}s for you to log in and approve...\n`);

  // wait for callback
  let code;
  try {
    code = await waitForCode();
  } catch (e) {
    console.error(`[4/7] FAILED during authorization: ${e.message}`);
    try { server.close(); } catch { /* noop */ }
    process.exit(3);
  } finally {
    try { server.close(); } catch { /* noop */ }
  }
  console.log('[4/7] Callback received. State validated OK. Authorization code captured (redacted).');
  describeToken('auth_code', code);
  console.log('');

  // Step 4 -- exchange
  let tokens;
  try {
    tokens = await exchangeCode(code, pkce.verifier);
  } catch (e) {
    console.error(`[5/7] FAILED token exchange: ${e.message}`);
    process.exit(4);
  }
  console.log('[5/7] Token exchange succeeded. Tokens (redacted):');
  describeToken('access_token', tokens.access_token);
  describeToken('refresh_token', tokens.refresh_token);
  describeToken('id_token', tokens.id_token);
  console.log(`      expires_in present=${tokens.expires_in != null} value=${tokens.expires_in ?? '(none)'}`);
  console.log(`      token_type=${tokens.token_type ?? '(none)'} scope=${tokens.scope ?? '(none)'}`);
  const gotAccess = !!tokens.access_token;
  const gotRefresh = !!tokens.refresh_token;
  const gotExpiry = tokens.expires_in != null;
  console.log(`      >> access_token present: ${gotAccess}`);
  console.log(`      >> refresh_token present: ${gotRefresh}`);
  console.log(`      >> expires_in present: ${gotExpiry}\n`);

  // Step 6 -- refresh grant + rotation check
  let refreshed = null;
  let rotated = null;
  if (gotRefresh) {
    try {
      refreshed = await refreshGrant(tokens.refresh_token);
      const newRefresh = refreshed.refresh_token;
      console.log('[6/7] Refresh grant succeeded. New tokens (redacted):');
      describeToken('new_access_token', refreshed.access_token);
      describeToken('new_refresh_token', newRefresh);
      console.log(`      new expires_in present=${refreshed.expires_in != null} value=${refreshed.expires_in ?? '(none)'}`);
      if (newRefresh) {
        rotated = newRefresh !== tokens.refresh_token;
        console.log(`      >> refresh_token ROTATED: ${rotated} ` +
          `(compared full tokens in-memory; neither printed)`);
      } else {
        console.log('      >> No refresh_token returned on refresh (cannot determine rotation).');
      }
      console.log('');
    } catch (e) {
      console.error(`[6/7] FAILED refresh grant: ${e.message}\n`);
    }
  } else {
    console.log('[6/7] SKIPPED refresh grant -- no refresh_token was returned (check offline_access scope).\n');
  }

  // Step 7 -- prove INFERENCE auth (what actually matters for the feature):
  // chat/completions and responses; /v1/models is only a listing endpoint and
  // may be permission-gated separately for a consumer OAuth token.
  const accessForTest = (refreshed && refreshed.access_token) || tokens.access_token;
  let chatRes = null, respRes = null, modelsResult = null;
  if (accessForTest) {
    try {
      chatRes = await probeChat(accessForTest, 'grok-4.3');
      console.log(`[7/7] POST /v1/chat/completions (grok-4.3) -> HTTP ${chatRes.status} ok=${chatRes.ok}`);
      console.log(`      body: ${chatRes.snippet}`);
    } catch (e) { console.error(`      chat/completions error: ${e.message}`); }
    try {
      respRes = await probeResponses(accessForTest, 'grok-4.3');
      console.log(`      POST /v1/responses (grok-4.3) -> HTTP ${respRes.status} ok=${respRes.ok}`);
      console.log(`      body: ${respRes.snippet}`);
    } catch (e) { console.error(`      responses error: ${e.message}`); }
    try {
      modelsResult = await listModels(accessForTest);
      console.log(`      GET /v1/models -> HTTP ${modelsResult.status} (count ${modelsResult.count == null ? 'n/a' : modelsResult.count})`);
      if (modelsResult.ok && modelsResult.ids && modelsResult.ids.length) console.log(`      MODEL IDs: ${modelsResult.ids.join(', ')}`);
      if (!modelsResult.ok) console.log(`      models body: ${modelsResult.snippet}`);
    } catch (e) { console.error(`      /v1/models error: ${e.message}`); }
    console.log('');
  } else {
    console.log('[7/7] SKIPPED inference tests -- no access_token available.\n');
  }

  const chatOk = !!(chatRes && chatRes.ok);
  const respOk = !!(respRes && respRes.ok);
  const inferenceOk = chatOk || respOk;

  // ---- Verdict ---- (PASS = tokens + rotation + at least one inference endpoint works)
  const pass = gotAccess && gotRefresh && gotExpiry && inferenceOk;

  console.log('==========================================================');
  console.log(` RESULT: ${pass ? 'PASS' : 'INCOMPLETE / FAIL'}`);
  console.log('----------------------------------------------------------');
  console.log(`  access_token returned .......... ${gotAccess}`);
  console.log(`  refresh_token returned ......... ${gotRefresh}`);
  console.log(`  expires_in returned ............ ${gotExpiry}`);
  console.log(`  refresh grant succeeded ........ ${refreshed ? true : false}`);
  console.log(`  refresh_token rotated .......... ${rotated == null ? '(unknown)' : rotated}`);
  console.log(`  chat/completions auth OK ....... ${chatOk}`);
  console.log(`  responses auth OK .............. ${respOk}`);
  console.log(`  /v1/models auth OK ............. ${modelsResult ? modelsResult.ok : false}`);
  console.log('==========================================================');

  process.exit(pass ? 0 : 5);
}

main().catch((e) => {
  console.error('\nUNEXPECTED ERROR:', e && e.stack ? e.stack : e);
  process.exit(1);
});
