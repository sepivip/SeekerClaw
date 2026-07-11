#!/usr/bin/env node
/*
 * test-content-filter-trigger.js — regression probe for the 2026-07-07 outage
 * (see tests/live/anthropic/FINDINGS.md). Anthropic's setup_token path rejects a request whose
 * content contains the co-occurrence of `heartbeat` + `acknowledgment` +
 * `HEARTBEAT_OK`, and MISLABELS it as `400 "You're out of extra usage"`. This
 * poison entered the agent's "Recent Sessions" system-prompt block via an
 * auto-generated heartbeat session summary and deadlocked every turn.
 *
 * This probe confirms, on the setup_token path:
 *   - the known trigger phrase still 400s (so we notice if Anthropic changes it)
 *   - the neutralized phrasing 200s (so our sanitizer's target stays valid)
 *
 * Deliberately tiny (~40-char system) so a 400 can ONLY be the content filter,
 * never usage. LIVE — needs SETUP_TOKEN in tests/live/anthropic/.env. Run: node tests/live/anthropic/test-content-filter-trigger.js
 */
'use strict';
const path = require('path');
const https = require('https');
const configPath = path.resolve(__dirname, '../../../app/src/main/assets/nodejs-project/config.js');
require.cache[configPath] = { id: configPath, filename: configPath, loaded: true,
    exports: { log: () => {}, CHANNEL: 'telegram', config: {}, API_TIMEOUT_MS: 60000 } };
const claude = require('../../../app/src/main/assets/nodejs-project/providers/claude');
const { loadEnv, CC_BILLING_HEADER } = require('./lib');
loadEnv();

const MODEL = process.env.TEST_MODEL || 'claude-opus-4-8';
const BILL = CC_BILLING_HEADER; // shared with providers/claude.js — no drift on cc_version bumps
const TOKEN = process.env.SETUP_TOKEN || process.env.ANTHROPIC_SETUP_TOKEN;

// [phrase, expected] — the minimal trigger + the safe variants (drop any one word).
const CASES = [
    ['heartbeat acknowledgment (HEARTBEAT_OK)', 400], // THE trigger
    ['heartbeat acknowledgment token (HEARTBEAT_OK)', 400],
    ['acknowledgment token (HEARTBEAT_OK)', 200], // no "heartbeat"
    ['heartbeat token (HEARTBEAT_OK)', 200], // no "acknowledgment"
    ['heartbeat acknowledgment (HEARTBEAT)', 200], // no "_OK" token
    ['responded with the heartbeat ack signal', 200], // neutralized form (sanitizer target)
];

function probe(text) {
    const body = JSON.stringify({ model: MODEL, max_tokens: 16, stream: false,
        system: [{ type: 'text', text: BILL }, { type: 'text', text }],
        messages: [{ role: 'user', content: 'Hey' }] });
    const headers = claude.buildHeaders(TOKEN, 'setup_token');
    return new Promise((res) => {
        const r = https.request({ hostname: 'api.anthropic.com', path: '/v1/messages', method: 'POST', headers },
            (rp) => { rp.on('data', () => {}); rp.on('end', () => res(rp.statusCode)); });
        r.on('error', () => res(0)); r.setTimeout(30000, () => r.destroy());
        r.write(body); r.end();
    });
}

(async () => {
    if (!TOKEN) { console.error('❌ SETUP_TOKEN (or ANTHROPIC_SETUP_TOKEN) required in tests/live/anthropic/.env'); process.exit(1); }
    console.log(`🧪 content-filter regression probe (setup_token, ${MODEL})\n`);
    let fails = 0;
    for (const [text, expect] of CASES) {
        const got = await probe(text);
        const ok = got === expect;
        if (!ok) fails++;
        console.log(`  ${ok ? '✅' : '❌'} expect ${expect}, got ${got}  "${text}"`);
        await new Promise((r) => setTimeout(r, 800));
    }
    console.log(fails === 0
        ? '\n✅ Behavior unchanged — trigger still 400s, safe variants 200. Sanitizer contract holds.'
        : `\n⚠️ ${fails} case(s) changed — Anthropic altered the filter. Re-derive the trigger + update the sanitizer.`);
    process.exit(fails === 0 ? 0 : 1);
})();
