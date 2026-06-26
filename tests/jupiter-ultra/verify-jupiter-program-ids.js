// tests/jupiter-ultra/verify-jupiter-program-ids.js
//
// BAT-1013 follow-up: empirical on-chain verification of the Jupiter
// V1/V2/DCA program IDs we hardcode as `expectedOwner` trust anchors
// in burner-policy. Per the `official-docs-over-memory` feedback rule
// (2026-06-04), trust-anchor identifiers must be cross-verified against
// official upstream sources AND empirically confirmed on-chain before
// shipping.
//
// What this test does:
//   1. Calls Solana RPC `getAccountInfo` on each of the 3 program IDs.
//   2. Asserts each account exists, is executable, and is owned by
//      `BPFLoaderUpgradeab1e11111111111111111111111` (the standard
//      Solana upgradeable BPF loader).
//   3. Reports PASS/FAIL per ID with the actual on-chain owner.
//
// What this test does NOT do:
//   - Sign / spend / mutate anything (read-only RPC).
//   - Require BURNER_SECRET_KEY (purely public on-chain lookup).
//
// Run with: `cd tests/jupiter-ultra && node verify-jupiter-program-ids.js`

'use strict';

require('dotenv').config({ path: __dirname + '/.env.test' });

const https = require('https');
const http = require('http');

const SOLANA_RPC = process.env.SOLANA_RPC || 'https://api.mainnet-beta.solana.com';
const LOADER = 'BPFLoaderUpgradeab1e11111111111111111111111';

const PROGRAMS = [
    { id: 'jupoNjAxXgZ4rjzxzPMP4oxduvQsQtZzyknqvzYNrNu', label: 'Jupiter Limit Order V1' },
    { id: 'j1o2qRpjcyUwEvwtcfhEQefh773ZgjxcVRry7LDqg5X', label: 'Jupiter Limit Order V2 / Trigger V2' },
    { id: 'DCA265Vj8a9CEuX1eb1LWRnDT7uK6q1xMipnNyatn23M', label: 'Jupiter DCA' },
];

// BAT-1060: PROVENANCE pin. On-chain "is BPF-owned" only proves deployment — a
// wrong-but-deployed ID would still pass. Anchor each ID to the PRODUCTION trust
// list in solana.js (the single source the burner-policy actually enforces as
// expectedOwner), NOT to constants copied into this file. A drift between this
// probe's IDs and production fails fast. (Official-upstream cross-verification of
// production itself remains the documented manual step — see file header.)
(function assertProvenanceAgainstProduction() {
    const fs = require('fs');
    const path = require('path');
    const prodPath = path.resolve(__dirname, '..', '..', 'app', 'src', 'main', 'assets', 'nodejs-project', 'solana.js');
    const prodSrc = fs.readFileSync(prodPath, 'utf8');
    // CodeRabbit #414: scope to the AUTHORITATIVE trust-anchor map (KNOWN_PROGRAM_NAMES)
    // and require the ID to be an entry KEY (`['<id>',`), so a bare mention in a
    // comment / log string / stale constant elsewhere in solana.js can't satisfy it.
    const mapStart = prodSrc.indexOf('const KNOWN_PROGRAM_NAMES = new Map([');
    if (mapStart === -1) throw new Error('provenance: could not locate the KNOWN_PROGRAM_NAMES map in production solana.js');
    const mapEnd = prodSrc.indexOf('])', mapStart);
    // CR #414: fail closed if the map terminator is missing — never slice to EOF
    // (that would broaden the search past the map and let later mentions satisfy it).
    if (mapEnd === -1) throw new Error('provenance: could not locate the KNOWN_PROGRAM_NAMES map terminator "])" — refusing to scan beyond the map');
    const mapBlock = prodSrc.slice(mapStart, mapEnd);
    const esc = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    for (const p of PROGRAMS) {
        const keyRe = new RegExp("\\[\\s*'" + esc(p.id) + "'\\s*,");
        if (!keyRe.test(mapBlock)) {
            throw new Error(`provenance drift: ${p.label} ID ${p.id} is NOT an entry key in production KNOWN_PROGRAM_NAMES — this probe and production's active trust anchors disagree`);
        }
    }
})();

function jsonRpcRequest(rpcUrl, body, timeoutMs = 15_000) {
    return new Promise((resolve, reject) => {
        const url = new URL(rpcUrl);
        // Copilot R-next-3: pick transport based on url.protocol so SOLANA_RPC
        // works for both hosted https endpoints AND local dev RPCs like
        // http://127.0.0.1:8899. Previously hardcoded https.request silently
        // failed for any non-443 / non-https endpoint despite the env-var
        // advertising configurability.
        const transport = url.protocol === 'http:' ? http : https;
        const payload = JSON.stringify(body);
        const req = transport.request({
            hostname: url.hostname,
            port: url.port || (url.protocol === 'http:' ? 80 : 443),
            path: url.pathname + (url.search || ''),
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'Content-Length': Buffer.byteLength(payload),
            },
            timeout: timeoutMs,
        }, (res) => {
            let data = '';
            res.on('data', (c) => data += c);
            res.on('end', () => {
                try { resolve(JSON.parse(data)); }
                catch (e) { reject(new Error('parse: ' + data.slice(0, 200))); }
            });
        });
        req.on('error', reject);
        req.on('timeout', () => { req.destroy(); reject(new Error(`RPC timeout after ${timeoutMs}ms`)); });
        req.write(payload);
        req.end();
    });
}

async function getAccountInfo(rpcUrl, pubkey) {
    const res = await jsonRpcRequest(rpcUrl, {
        jsonrpc: '2.0', id: 1, method: 'getAccountInfo',
        params: [pubkey, { encoding: 'base64' }],
    });
    if (res.error) throw new Error(`RPC: ${JSON.stringify(res.error)}`);
    return res.result && res.result.value;
}

async function main() {
    console.log(`[verify] Using RPC: ${new URL(SOLANA_RPC).hostname}`);
    console.log(`[verify] Required loader (owner): ${LOADER}`);
    console.log();

    const results = [];
    for (const p of PROGRAMS) {
        process.stdout.write(`[verify] ${p.label.padEnd(40)} ${p.id} ... `);
        try {
            const acct = await getAccountInfo(SOLANA_RPC, p.id);
            if (!acct) {
                console.log('FAIL (account does not exist on chain)');
                results.push({ ...p, ok: false, reason: 'no_account' });
                continue;
            }
            const ownerOk = acct.owner === LOADER;
            const execOk = acct.executable === true;
            if (ownerOk && execOk) {
                console.log(`PASS (executable, owner=${LOADER.slice(0, 8)}...)`);
                results.push({ ...p, ok: true, owner: acct.owner, executable: acct.executable });
            } else {
                console.log(`FAIL (executable=${acct.executable}, owner=${acct.owner})`);
                results.push({ ...p, ok: false, owner: acct.owner, executable: acct.executable });
            }
        } catch (err) {
            console.log(`ERROR (${err.message})`);
            results.push({ ...p, ok: false, reason: err.message });
        }
    }

    console.log();
    const passed = results.filter(r => r.ok).length;
    const failed = results.filter(r => !r.ok).length;
    console.log(`[verify] ${passed}/${PROGRAMS.length} PASS, ${failed}/${PROGRAMS.length} FAIL`);

    if (failed > 0) {
        console.error('[verify] One or more program IDs failed verification.');
        console.error('[verify] Do NOT hardcode these as expectedOwner in burner-policy until resolved.');
        process.exit(1);
    }
    console.log('[verify] All program IDs verified on-chain. Safe to hardcode in expectedOwner.');
}

main().catch(err => {
    console.error(`[fatal] ${err.message}`);
    process.exit(2);
});
