#!/usr/bin/env node
/**
 * BAT-1124 — xAI OAuth Device-Code Flow proof-spike (fallback path).
 *
 * Proves the RFC 8628 OAuth 2.0 Device Authorization Grant against xAI's
 * live OIDC endpoints, using the PUBLIC Grok-CLI client (no client secret).
 * This is the fallback used when a loopback redirect (127.0.0.1) is not
 * available — e.g. a headless / on-device (Seeker) context.
 *
 * Node builtins ONLY (https, url, readline). No dependencies. No secrets on disk.
 *
 * Flow:
 *   1. POST {device}         -> device_code, user_code, verification_uri_complete
 *   2. Human opens the URL and approves in a browser.
 *   3. Poll {token} with grant_type=urn:ietf:params:oauth:grant-type:device_code
 *        - authorization_pending -> keep polling at `interval`
 *        - slow_down             -> widen interval (+5s per RFC 8628)
 *        - expired_token         -> device_code expired, abort
 *        - access_denied         -> user rejected, abort
 *        - success               -> access_token (+ refresh_token if offline_access)
 *   4. Prove refresh_token rotation via grant_type=refresh_token.
 *   5. GET {models} with the access token to prove inference-plane auth.
 *
 * Tokens are NEVER printed. Presence is shown REDACTED with lengths only.
 */

'use strict';

const https = require('https');
const { URL, URLSearchParams } = require('url');
const readline = require('readline');

// ---------------------------------------------------------------------------
// Captured xAI OAuth params (BAT-1124). Public client — no secret.
// ---------------------------------------------------------------------------
const CFG = {
  clientId: 'b1a00492-073a-47ea-816f-4c329264a828',
  scope: 'openid profile email offline_access grok-cli:access api:access',
  deviceUrl: 'https://auth.x.ai/oauth2/device/code',
  tokenUrl: 'https://auth.x.ai/oauth2/token',
  modelsUrl: 'https://api.x.ai/v1/models',
};

// Safety caps so the spike can never hang forever.
const OVERALL_DEADLINE_MS = 10 * 60 * 1000; // 10 min hard stop for whole run
const HTTP_TIMEOUT_MS = 20 * 1000; // per-request socket timeout
const DEFAULT_POLL_INTERVAL_S = 5; // fallback if server omits `interval`
const MAX_POLL_INTERVAL_S = 60; // never poll slower than this

// ---------------------------------------------------------------------------
// Small helpers
// ---------------------------------------------------------------------------
function log(...a) {
  console.log(`[${new Date().toISOString()}]`, ...a);
}
function redact(token) {
  if (!token || typeof token !== 'string') return '(absent)';
  // Never print any token material — not even a prefix (partial tokens still leak).
  return `PRESENT [REDACTED] (len=${token.length})`;
}
function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

/**
 * Minimal HTTPS request returning { status, headers, body, json }.
 * Rejects on socket timeout / network error.
 */
function request(urlStr, { method = 'GET', headers = {}, body = null } = {}) {
  return new Promise((resolve, reject) => {
    let u;
    try {
      u = new URL(urlStr);
    } catch (e) {
      return reject(new Error(`Bad URL: ${urlStr}`));
    }
    const opts = {
      method,
      hostname: u.hostname,
      port: u.port || 443,
      path: u.pathname + u.search,
      headers: { Accept: 'application/json', ...headers },
    };
    const req = https.request(opts, (res) => {
      let data = '';
      res.setEncoding('utf8');
      res.on('data', (c) => (data += c));
      res.on('end', () => {
        let json = null;
        try {
          json = data ? JSON.parse(data) : null;
        } catch (_) {
          /* non-JSON body left as raw */
        }
        resolve({ status: res.statusCode, headers: res.headers, body: data, json });
      });
    });
    req.on('error', reject);
    req.setTimeout(HTTP_TIMEOUT_MS, () => {
      req.destroy(new Error(`HTTP timeout after ${HTTP_TIMEOUT_MS}ms: ${method} ${urlStr}`));
    });
    if (body != null) req.write(body);
    req.end();
  });
}

function form(obj) {
  return new URLSearchParams(obj).toString();
}

function waitForEnter(prompt) {
  return new Promise((resolve) => {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    rl.question(prompt, () => {
      rl.close();
      resolve();
    });
  });
}

// ---------------------------------------------------------------------------
// Step 1 — device authorization request
// ---------------------------------------------------------------------------
async function requestDeviceCode() {
  log('STEP 1 — POST device endpoint:', CFG.deviceUrl);
  const res = await request(CFG.deviceUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: form({ client_id: CFG.clientId, scope: CFG.scope }),
  });
  if (res.status !== 200 || !res.json) {
    throw new Error(`Device request failed: HTTP ${res.status} — ${res.body}`);
  }
  const d = res.json;
  if (!d.device_code || !d.user_code) {
    throw new Error(`Malformed device response: ${res.body}`);
  }
  const verifyComplete =
    d.verification_uri_complete ||
    (d.verification_uri
      ? `${d.verification_uri}?user_code=${encodeURIComponent(d.user_code)}`
      : '(none provided)');

  console.log('\n==================== ACTION REQUIRED ====================');
  console.log('  1. Open this URL in a browser:');
  console.log('       ', verifyComplete);
  console.log('  2. If prompted, confirm the user code:');
  console.log('        USER CODE ->', d.user_code);
  console.log('  3. Approve the "Grok CLI" access request.');
  console.log('========================================================\n');

  log('device_code   :', redact(d.device_code));
  log('expires_in    :', d.expires_in, 'seconds');
  log('poll interval :', d.interval || DEFAULT_POLL_INTERVAL_S, 'seconds');
  return {
    deviceCode: d.device_code,
    interval: Number(d.interval) || DEFAULT_POLL_INTERVAL_S,
    expiresIn: Number(d.expires_in) || 600,
  };
}

// ---------------------------------------------------------------------------
// Step 2/3 — poll the token endpoint
// ---------------------------------------------------------------------------
async function pollForToken({ deviceCode, interval, expiresIn }) {
  log('STEP 2 — polling token endpoint for approval…');
  let intervalS = interval;
  const startedAt = Date.now();
  const deviceDeadline = startedAt + expiresIn * 1000;

  for (;;) {
    if (Date.now() > deviceDeadline) {
      throw new Error('Device code expired locally (deadline reached) — restart the spike.');
    }
    if (Date.now() - startedAt > OVERALL_DEADLINE_MS) {
      throw new Error('Overall run deadline reached — aborting.');
    }

    await sleep(intervalS * 1000);

    const res = await request(CFG.tokenUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: form({
        grant_type: 'urn:ietf:params:oauth:grant-type:device_code',
        device_code: deviceCode,
        client_id: CFG.clientId,
      }),
    });

    // Success path
    if (res.status === 200 && res.json && res.json.access_token) {
      log('Approval received — token grant succeeded.');
      return res.json;
    }

    const err = res.json && res.json.error;
    switch (err) {
      case 'authorization_pending':
        log(`… pending (user has not approved yet); re-poll in ${intervalS}s`);
        break;
      case 'slow_down':
        intervalS = Math.min(intervalS + 5, MAX_POLL_INTERVAL_S);
        log(`… slow_down received; widening interval to ${intervalS}s`);
        break;
      case 'expired_token':
        throw new Error('Server returned expired_token — device code expired. Restart the spike.');
      case 'access_denied':
        throw new Error('Server returned access_denied — user rejected the request.');
      default:
        throw new Error(
          `Unexpected token response: HTTP ${res.status} error=${err || '(none)'} body=${res.body}`
        );
    }
  }
}

// ---------------------------------------------------------------------------
// Step 3b — refresh_token rotation
// ---------------------------------------------------------------------------
async function refreshGrant(refreshToken) {
  log('STEP 3 — exercising refresh_token grant (rotation check)…');
  const res = await request(CFG.tokenUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: form({
      grant_type: 'refresh_token',
      refresh_token: refreshToken,
      client_id: CFG.clientId,
    }),
  });
  if (res.status !== 200 || !res.json || !res.json.access_token) {
    throw new Error(`Refresh failed: HTTP ${res.status} — ${res.body}`);
  }
  return res.json;
}

// ---------------------------------------------------------------------------
// Step 4 — inference-plane auth check
// ---------------------------------------------------------------------------
async function listModels(accessToken) {
  log('STEP 4 — GET', CFG.modelsUrl, '(proving inference auth)…');
  const res = await request(CFG.modelsUrl, {
    method: 'GET',
    headers: { Authorization: `Bearer ${accessToken}` },
  });
  if (res.status !== 200) {
    throw new Error(`Models request failed: HTTP ${res.status} — ${res.body}`);
  }
  const models = (res.json && (res.json.data || res.json.models)) || [];
  const ids = Array.isArray(models) ? models.map((m) => m.id || m).filter(Boolean) : [];
  log(`Inference auth OK — ${ids.length} model(s) visible:`, ids.slice(0, 12).join(', ') || '(none listed)');
  return ids;
}

// ---------------------------------------------------------------------------
// Orchestration
// ---------------------------------------------------------------------------
async function main() {
  console.log('\n=== xAI OAuth Device-Code Fallback Spike (BAT-1124) ===');
  console.log('Public client:', CFG.clientId);
  console.log('Scope        :', CFG.scope);
  console.log('Hard deadline:', OVERALL_DEADLINE_MS / 1000, 'seconds\n');

  // 1. device authorization
  const device = await requestDeviceCode();

  // Give the human a beat to open the URL before polling starts. Non-blocking
  // if stdin is not a TTY (CI) — we just proceed straight to polling.
  if (process.stdin.isTTY) {
    await waitForEnter('Press <Enter> AFTER you have opened the URL (polling then begins)… ');
  } else {
    log('Non-TTY stdin — skipping the interactive pause, polling immediately.');
  }

  // 2/3. poll for the token
  const tok = await pollForToken(device);
  console.log('\n---- TOKEN GRANT RESULT ----');
  log('access_token :', redact(tok.access_token));
  log('refresh_token:', redact(tok.refresh_token));
  log('id_token     :', redact(tok.id_token));
  log('token_type   :', tok.token_type || '(none)');
  log('expires_in   :', tok.expires_in, 'seconds');
  log('scope        :', tok.scope || '(none)');

  // 3b. refresh rotation
  if (tok.refresh_token) {
    const refreshed = await refreshGrant(tok.refresh_token);
    console.log('\n---- REFRESH GRANT RESULT ----');
    log('new access_token :', redact(refreshed.access_token));
    log('new refresh_token:', redact(refreshed.refresh_token));
    const rotated =
      refreshed.refresh_token && refreshed.refresh_token !== tok.refresh_token;
    log(
      'refresh_token rotation:',
      refreshed.refresh_token
        ? rotated
          ? 'ROTATED (new refresh_token differs — good)'
          : 'REUSED (server returned the same refresh_token)'
        : 'NONE returned on refresh'
    );
    // Prove the freshly-refreshed access token also works on the inference plane.
    await listModels(refreshed.access_token);
  } else {
    log('No refresh_token returned (is offline_access in scope?) — skipping rotation check.');
    await listModels(tok.access_token);
  }

  console.log('\n=== SPIKE COMPLETE — device-code fallback path proven ===\n');
}

main().catch((err) => {
  console.error('\n[SPIKE FAILED]', err && err.message ? err.message : err);
  process.exit(1);
});
