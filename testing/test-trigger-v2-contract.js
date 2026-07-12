#!/usr/bin/env node
// test-trigger-v2-contract.js — BAT-1148 (delivers BAT-1091).
//
// LIVE, opt-in Jupiter Trigger V2 contract probe. Catches Jupiter-SIDE drift
// that the mocked unit tests (jupiter-trigger-v2.test.js) can't: it hits the
// real `api.jup.ag/trigger/v2/auth/challenge` and runs the SAME validators the
// app uses (_validateChallengePayload + _validateAuthTransaction) against the
// challenge Jupiter returns TODAY. If Jupiter ever adds a program or bumps a
// ComputeBudget value beyond our auth-tx allowlist/caps, this probe fails here
// instead of on-device with a blind-sign guard rejection.
//
// No wallet / no signing needed — fetching the challenge only needs a public
// pubkey + a Jupiter API key. Creating/listing/cancelling orders needs a JWT
// (requires signing) and stays in the device checklist.
//
//   JUPITER_API_KEY=<key> node testing/test-trigger-v2-contract.js
//   [JUPITER_PROBE_PUBKEY=<base58>]   # optional; any valid pubkey works
//
// Exit 0 = challenge accepted by our allowlist (or SKIP: no key). Exit 1 = the
// live challenge would be REJECTED by our guard → investigate before shipping.

'use strict';

const https = require('https');
const path = require('path');

const KEY = process.env.JUPITER_API_KEY || '';
if (!KEY) {
    console.log('SKIP — set JUPITER_API_KEY to run the live Trigger V2 contract probe.');
    console.log('       (opt-in; not part of CI. Verifies Jupiter\'s live auth-challenge tx');
    console.log('        still passes our Memo+ComputeBudget auth-tx allowlist.)');
    process.exit(0);
}

// A valid base58 pubkey is all the challenge endpoint needs (it binds the
// challenge to this key; on-chain funding is irrelevant). USDC mint by default.
const PUBKEY = process.env.JUPITER_PROBE_PUBKEY || 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v';

const BUNDLE = path.resolve(__dirname, '..', 'app', 'src', 'main', 'assets', 'nodejs-project');

// Mock config.js (heavy load-time side effects) so we can require the adapter
// just for its exported validators. We hit the network with raw https below.
const configPath = require.resolve(path.join(BUNDLE, 'config.js'));
require.cache[configPath] = {
    id: configPath, filename: configPath, loaded: true,
    exports: { log: () => {}, config: { jupiterApiKey: KEY } },
};
const { _validateChallengePayload, _validateAuthTransaction } = require(path.join(BUNDLE, 'jupiter', 'trigger-v2'));

function postJson(pathname, body) {
    return new Promise((resolve, reject) => {
        const payload = JSON.stringify(body);
        const req = https.request({
            hostname: 'api.jup.ag', path: pathname, method: 'POST',
            headers: {
                'x-api-key': KEY,
                'Content-Type': 'application/json',
                'Accept': 'application/json',
                'Content-Length': Buffer.byteLength(payload),
            },
        }, (res) => {
            let data = '';
            res.on('data', (c) => { data += c; });
            res.on('end', () => {
                let json = null;
                try { json = JSON.parse(data); } catch { /* leave null */ }
                resolve({ status: res.statusCode, data: json, raw: data });
            });
        });
        req.on('error', reject);
        req.write(payload);
        req.end();
    });
}

(async () => {
    console.log(`Requesting a LIVE transaction challenge from api.jup.ag for ${PUBKEY.slice(0, 6)}…`);
    let res;
    try {
        res = await postJson('/trigger/v2/auth/challenge', { walletPubkey: PUBKEY, type: 'transaction' });
    } catch (e) {
        console.error(`✗ network error hitting /trigger/v2/auth/challenge: ${e.message}`);
        process.exit(1);
    }

    if (res.status !== 200) {
        console.error(`✗ challenge HTTP ${res.status} — expected 200. Body: ${(res.raw || '').slice(0, 240)}`);
        console.error('  (401 → bad/missing JUPITER_API_KEY; 4xx → the challenge contract may have changed.)');
        process.exit(1);
    }

    // Envelope shape — same check the adapter runs.
    const envelope = _validateChallengePayload(res.data, PUBKEY);
    if (!envelope.ok) {
        console.error(`✗ challenge envelope rejected: ${envelope.error} — ${envelope.reason}`);
        console.error('  Jupiter changed the challenge payload shape (nonce/expiry/type/etc.).');
        process.exit(1);
    }
    if (res.data.type !== 'transaction') {
        console.error(`✗ expected a transaction challenge, got type="${res.data.type}"`);
        process.exit(1);
    }

    // The load-bearing check: does OUR blind-sign guard + ComputeBudget cap
    // allowlist accept the tx Jupiter is sending right now?
    const tx = _validateAuthTransaction(res.data.transaction, PUBKEY);
    if (!tx.ok) {
        console.error(`✗ LIVE auth tx REJECTED by our allowlist: ${tx.error} — ${tx.reason}`);
        console.error('  Jupiter\'s auth challenge now contains a program/instruction (or a');
        console.error('  ComputeBudget value) outside our auth-tx allowlist/caps. On-device this');
        console.error('  would fail the blind-sign guard and block every V2 order. Update');
        console.error('  jupiter/trigger-v2.js _AUTH_ALLOWED_PROGRAMS / the CU caps to match.');
        process.exit(1);
    }

    console.log('✓ Live Jupiter Trigger V2 auth challenge PASSES our allowlist:');
    console.log('  • envelope shape valid (nonce/expiry/type)');
    console.log('  • auth tx contains only Memo + (optional) ComputeBudget within caps');
    console.log('  • blind-sign guard would accept it on-device');
    console.log('\n✓ Trigger V2 auth contract is in sync with jupiter/trigger-v2.js.');
    process.exit(0);
})();
