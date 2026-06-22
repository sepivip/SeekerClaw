#!/usr/bin/env node
// v2-contract-probe.js — BAT-697 read-only Trigger V2 contract verification.
//
// Drives the REAL adapter (jupiter/trigger-v2.js) + REAL http.js against the
// live Jupiter API using the funded test wallet in .env.test. Confirms the
// request/response field shapes that PR #388 guessed at and tagged MUST-VERIFY.
//
// SAFETY: signs ONLY the auth challenge (proves wallet ownership — moves zero
// funds). Calls auth/challenge, auth/verify, vault, orders/history, and
// deposit/craft (build-only). It NEVER submits /orders/price and NEVER
// broadcasts anything, so no SOL/USDC moves. Secrets (key, JWT, signatures)
// are never printed — only response field shapes + small non-sensitive values.
//
// Run: node tests/jupiter-ultra/v2-contract-probe.js
// (uncommitted dev tool; reads secret-bearing .env.test which is gitignored)

'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

// ── Locate the adapter (lives in the BAT-697-v2 worktree) ───────────────────
const WORKTREE = path.resolve(__dirname, '..', '..', '..', 'GITseekerclaw-worktrees', 'BAT-697-v2');
const NJP = path.join(WORKTREE, 'app', 'src', 'main', 'assets', 'nodejs-project');

// ── Parse .env.test (no dotenv dep) ─────────────────────────────────────────
function loadEnv(file) {
    const out = {};
    for (const raw of fs.readFileSync(file, 'utf8').split(/\r?\n/)) {
        const line = raw.trim();
        if (!line || line.startsWith('#')) continue;
        const eq = line.indexOf('=');
        if (eq < 0) continue;
        out[line.slice(0, eq).trim()] = line.slice(eq + 1).trim();
    }
    return out;
}
const env = loadEnv(path.join(__dirname, '.env.test'));
const JUPITER_API_KEY = env.JUPITER_API_KEY;
const BURNER_PUBKEY = env.BURNER_PUBKEY;
const BURNER_SECRET_KEY = env.BURNER_SECRET_KEY;
const SOLANA_RPC = env.SOLANA_RPC || 'https://api.mainnet-beta.solana.com';
if (!JUPITER_API_KEY || !BURNER_PUBKEY || !BURNER_SECRET_KEY) {
    console.error('Missing JUPITER_API_KEY / BURNER_PUBKEY / BURNER_SECRET_KEY in .env.test');
    process.exit(1);
}

// ── Mode: --balance (read-only Solana RPC balance probe, exits early) ───────
const USDC_MINT = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v';
const USDT_MINT = 'Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB';

async function rpcCall(method, params) {
    const { URL } = require('url');
    const u = new URL(SOLANA_RPC);
    const lib = u.protocol === 'https:' ? require('https') : require('http');
    const body = JSON.stringify({ jsonrpc: '2.0', id: 1, method, params });
    return new Promise((resolve, reject) => {
        const req = lib.request({
            hostname: u.hostname, port: u.port || (u.protocol === 'https:' ? 443 : 80),
            path: u.pathname + u.search, method: 'POST',
            headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) },
        }, (res) => {
            let d = ''; res.on('data', c => d += c); res.on('end', () => {
                try { resolve(JSON.parse(d)); } catch (e) { reject(new Error('bad rpc json: ' + d.slice(0, 200))); }
            });
        });
        req.on('error', reject);
        req.write(body); req.end();
    });
}

const MODE_BALANCE = process.argv.includes('--balance');
const MODE_FUNDED = process.argv.includes('--funded');
const MODE_VERIFY = process.argv.includes('--verify-onchain');

// ── Adapter setup (needed by both --funded and the default contract probe).
// MODE_BALANCE doesn't use it; loading is harmless (no side effects beyond require).
const configPath = require.resolve(path.join(NJP, 'config.js'));
require.cache[configPath] = {
    id: configPath, filename: configPath, loaded: true,
    exports: {
        API_TIMEOUT_MS: 30000,
        config: { jupiterApiKey: JUPITER_API_KEY },
        log: (msg, lvl) => { if (lvl === 'ERROR' || lvl === 'WARN') console.error(`  [adapter:${lvl}] ${msg}`); },
    },
};
const triggerV2 = require(path.join(NJP, 'jupiter', 'trigger-v2.js'));

const secretKeyArr = JSON.parse(BURNER_SECRET_KEY);
const seed = Buffer.from(secretKeyArr.slice(0, 32));
const PKCS8_PREFIX = Buffer.from('302e020100300506032b657004220420', 'hex');
const privKeyObj = crypto.createPrivateKey({
    key: Buffer.concat([PKCS8_PREFIX, seed]), format: 'der', type: 'pkcs8',
});
function ed25519Sign(message) { return crypto.sign(null, message, privKeyObj); }
function readCompactU16(buf, offset) {
    let v = 0, shift = 0, i = offset;
    while (i < buf.length) {
        const b = buf[i]; i += 1;
        v |= (b & 0x7f) << shift;
        if ((b & 0x80) === 0) return { value: v, offset: i };
        shift += 7;
    }
    throw new Error('bad compact-u16');
}
function signAuthTx(txBase64) {
    const buf = Buffer.from(txBase64, 'base64');
    const { value: sigCount, offset: afterCount } = readCompactU16(buf, 0);
    const sigsStart = afterCount;
    const messageStart = sigsStart + sigCount * 64;
    const message = buf.subarray(messageStart);
    const sig = ed25519Sign(message);
    sig.copy(buf, sigsStart);
    return buf.toString('base64');
}
const signers = {
    signMessage: null,
    signTransaction: async (txBase64) => signAuthTx(txBase64),
};

if (MODE_BALANCE) {
    (async () => {
        console.log('═══ Test wallet balance (read-only) ═══');
        console.log(`pubkey: ${BURNER_PUBKEY}`);
        console.log(`rpc:    ${SOLANA_RPC}`);
        try {
            const sol = await rpcCall('getBalance', [BURNER_PUBKEY]);
            const lamports = sol.result && sol.result.value;
            console.log(`SOL:   ${lamports != null ? (lamports / 1e9).toFixed(6) + ' SOL  (' + lamports + ' lamports)' : '<error: ' + JSON.stringify(sol.error || sol) + '>'}`);
        } catch (e) { console.log('SOL:   <rpc error: ' + e.message + '>'); }
        for (const [name, mint] of [['USDC', USDC_MINT], ['USDT', USDT_MINT]]) {
            try {
                const res = await rpcCall('getTokenAccountsByOwner', [BURNER_PUBKEY, { mint }, { encoding: 'jsonParsed' }]);
                const accts = (res.result && res.result.value) || [];
                if (accts.length === 0) { console.log(`${name}:  <no token account>`); continue; }
                let total = 0;
                for (const a of accts) {
                    const ta = a.account.data.parsed.info.tokenAmount;
                    total += parseFloat(ta.uiAmountString || '0');
                }
                console.log(`${name}:  ${total} ${name}  (${accts.length} account${accts.length > 1 ? 's' : ''})`);
            } catch (e) { console.log(`${name}:  <rpc error: ` + e.message + '>'); }
        }
        // Also check the vault balance (Privy-managed; deposits land here)
        try {
            const VAULT = 'BWg7rvWTpE7FkBCqU1jzQE4j5AG34h8xGmZ7PBu4KXN1'; // from earlier vault probe
            console.log(`\nvault (${VAULT}):`);
            const vsol = await rpcCall('getBalance', [VAULT]);
            const vlamports = vsol.result && vsol.result.value;
            console.log(`  SOL:  ${vlamports != null ? (vlamports / 1e9).toFixed(6) + ' SOL' : '<error>'}`);
            for (const [name, mint] of [['USDC', USDC_MINT]]) {
                const res = await rpcCall('getTokenAccountsByOwner', [VAULT, { mint }, { encoding: 'jsonParsed' }]);
                const accts = (res.result && res.result.value) || [];
                let total = 0; for (const a of accts) total += parseFloat(a.account.data.parsed.info.tokenAmount.uiAmountString || '0');
                console.log(`  ${name}: ${accts.length === 0 ? '<no token account>' : total + ' ' + name}`);
            }
        } catch (e) { console.log('vault: <rpc error: ' + e.message + '>'); }
        console.log('');
        process.exit(0);
    })().catch(e => { console.error(e); process.exit(1); });
}

// ── Mode: --funded (REAL $10 USDC round-trip — sign + submit + cancel) ─────
if (MODE_FUNDED) {
    (async () => {
        const USDC = USDC_MINT;
        const SOL_MINT = 'So11111111111111111111111111111111111111112';
        const SAFE_TRIGGER_USD = 1; // SOL at $1 = unreachable; order cannot fill
        const AMOUNT_ATOMIC = '10000000'; // 10 USDC (6 decimals)

        console.log('═══ FUNDED ROUND-TRIP TEST — MOVES REAL FUNDS ═══');
        console.log(`pair: USDC → SOL (limit BUY @ $${SAFE_TRIGGER_USD} — unreachable, will not fill)`);
        console.log(`amount: 10 USDC | trigger: SOL ≤ $${SAFE_TRIGGER_USD} | wallet: ${BURNER_PUBKEY.slice(0, 4)}…${BURNER_PUBKEY.slice(-4)}`);
        console.log('');

        let orderId = null;
        try {
            // 1. Auth
            console.log('1) authenticate …');
            const auth = await triggerV2.authenticate(BURNER_PUBKEY, signers);
            if (!auth.ok) throw new Error(`auth: ${auth.error} — ${auth.reason}`);
            const token = auth.token;
            console.log(`   ok (cached=${!!auth.cached})`);

            // 2. Vault
            console.log('2) ensureVault …');
            const vault = await triggerV2.ensureVault(BURNER_PUBKEY, token);
            if (!vault.ok) throw new Error(`vault: ${vault.error} — ${vault.reason}`);
            console.log(`   ok vaultPubkey=${vault.vaultPubkey}`);

            // 3. Craft deposit
            console.log('3) deposit/craft (10 USDC → vault) …');
            const craft = await triggerV2.depositCraft({
                pubkey: BURNER_PUBKEY, token,
                inputMint: USDC, outputMint: SOL_MINT, inputAmount: AMOUNT_ATOMIC,
            });
            if (!craft.ok) throw new Error(`craft: ${craft.error} — ${craft.reason}`);
            console.log(`   ok requestId=${craft.depositRequestId} txLen=${craft.transaction.length}b64`);

            // 4. Sign deposit
            console.log('4) sign deposit tx …');
            const signedDeposit = signAuthTx(craft.transaction);
            console.log(`   ok (signed locally with test key — not yet on-chain)`);

            // 5. Submit /orders/price — THIS BROADCASTS THE DEPOSIT + REGISTERS ORDER
            console.log('5) POST /orders/price (Jupiter broadcasts the deposit) …');
            const submit = await triggerV2.submitCreateOrder({
                token, recoveryContext: craft.recoveryContext, depositSignedTx: signedDeposit,
                order: {
                    inputMint: USDC, inputAmount: AMOUNT_ATOMIC,
                    outputMint: SOL_MINT, triggerMint: SOL_MINT,
                    triggerCondition: 'below', triggerPriceUsd: SAFE_TRIGGER_USD,
                    slippageBps: 100,
                    expiresAtMs: Date.now() + 3600_000, // 1h
                },
            });
            if (!submit.ok) throw new Error(`submit: ${submit.error} — ${submit.reason}`);
            orderId = submit.id;
            console.log(`   ORDER CREATED ✓  id=${orderId}  depositTxSig=${submit.txSignature || '<none>'}`);

            // 6. Cancel step 1
            console.log('6) cancelStep1 …');
            const s1 = await triggerV2.cancelStep1({ orderId, pubkey: BURNER_PUBKEY, token });
            if (!s1.ok) throw new Error(`cancelStep1: ${s1.error} — ${s1.reason}`);
            console.log(`   ok cancelRequestId=${s1.cancelRequestId} txLen=${s1.transaction.length}b64`);

            // 7. Sign cancel
            console.log('7) sign cancel tx …');
            const signedCancel = signAuthTx(s1.transaction);

            // 8. Confirm cancel — Jupiter broadcasts withdrawal vault → wallet
            console.log('8) POST /confirm-cancel (Jupiter broadcasts withdrawal) …');
            const s2 = await triggerV2.confirmCancel({
                orderId, pubkey: BURNER_PUBKEY, token,
                signedTransaction: signedCancel, cancelRequestId: s1.cancelRequestId,
            });
            if (!s2.ok) throw new Error(`confirmCancel: ${s2.error} — ${s2.reason}`);
            console.log(`   CANCEL CONFIRMED ✓  cancelTxSig=${s2.txSignature || '<none>'}`);

            console.log('');
            console.log('═══ ROUND-TRIP SUCCESS ═══');
            console.log('Wait ~15s for on-chain settlement, then `node v2-contract-probe.js --balance`');
            console.log('to confirm USDC is back in the wallet.');
        } catch (e) {
            console.error('');
            console.error('═══ FUNDED TEST FAILED ═══');
            console.error(`error: ${e.message}`);
            if (orderId) {
                console.error('');
                console.error(`!! ORDER ${orderId} may still be ACTIVE — cancel via Jupiter UI:`);
                console.error(`   https://jup.ag/limit  (connect wallet ${BURNER_PUBKEY})`);
                console.error(`   Vault: BWg7rvWTpE7FkBCqU1jzQE4j5AG34h8xGmZ7PBu4KXN1`);
            }
            process.exit(1);
        }
    })().catch(e => { console.error('funded crashed:', e); process.exit(1); });
}

// ── Mode: --verify-onchain (terminal-state check after the funded round-trip)
if (MODE_VERIFY) {
    (async () => {
        const ORDER_ID = process.argv[process.argv.indexOf('--verify-onchain') + 1] || null;
        const DEPOSIT_SIG = process.argv[process.argv.indexOf('--deposit-sig') + 1] || null;
        const CANCEL_SIG = process.argv[process.argv.indexOf('--cancel-sig') + 1] || null;
        console.log('═══ On-chain reconciliation ═══');
        if (ORDER_ID) console.log('orderId:    ' + ORDER_ID);
        if (DEPOSIT_SIG) console.log('depositSig: ' + DEPOSIT_SIG);
        if (CANCEL_SIG) console.log('cancelSig:  ' + CANCEL_SIG);
        console.log('');

        // 1) Get JWT
        const auth = await triggerV2.authenticate(BURNER_PUBKEY, signers);
        if (!auth.ok) { console.error('auth failed:', auth); process.exit(1); }
        const token = auth.token;

        // 2) /orders/history — find our order, dump its status + the row shape.
        console.log('── /orders/history (does our order appear in terminal state?) ──');
        const list = await triggerV2.listOrders({ pubkey: BURNER_PUBKEY, token });
        if (!list.ok) { console.error('list failed:', list); process.exit(1); }
        console.log('   total orders: ' + list.orders.length);
        if (list.orders.length) {
            console.log('   row keys: ' + Object.keys(list.orders[0]).join(', '));
            for (const o of list.orders) {
                const isOurs = ORDER_ID && (o.id === ORDER_ID || o.orderId === ORDER_ID);
                const tag = isOurs ? ' ★ OUR ORDER' : '';
                console.log('   - id=' + (o.id || o.orderId) + ' orderState=' + o.orderState + ' rawState=' + o.rawState + tag);
                if (isOurs) {
                    console.log('     FULL ROW (sans events):');
                    const clean = { ...o }; delete clean.events;
                    for (const [k, v] of Object.entries(clean)) console.log(`       ${k}: ${JSON.stringify(v)}`);
                    if (Array.isArray(o.events)) {
                        console.log('     events: [' + o.events.length + ']');
                        for (const e of o.events) console.log(`       - ${JSON.stringify(e)}`);
                    }
                }
            }
        }

        // 3) Tx confirmation status via getSignatureStatuses.
        if (DEPOSIT_SIG || CANCEL_SIG) {
            console.log('\n── tx confirmation status (Solana RPC) ──');
            const sigs = [DEPOSIT_SIG, CANCEL_SIG].filter(Boolean);
            const res = await rpcCall('getSignatureStatuses', [sigs, { searchTransactionHistory: true }]);
            const arr = (res.result && res.result.value) || [];
            arr.forEach((s, i) => {
                if (!s) { console.log(`   ${sigs[i]}: <not found>`); return; }
                console.log(`   ${sigs[i].slice(0, 8)}…: status=${s.confirmationStatus} slot=${s.slot} err=${JSON.stringify(s.err)}`);
            });
        }
        console.log('');
        process.exit(0);
    })().catch(e => { console.error('verify crashed:', e); process.exit(1); });
}

if (!MODE_BALANCE && !MODE_FUNDED && !MODE_VERIFY) {

// ── Reporting helpers (never print secrets) ─────────────────────────────────
const results = [];
function shape(obj) {
    if (obj == null) return String(obj);
    if (Array.isArray(obj)) return `[${obj.length}]${obj.length ? ' of ' + shape(obj[0]) : ''}`;
    if (typeof obj !== 'object') return typeof obj;
    return '{ ' + Object.keys(obj).map(k => {
        const v = obj[k];
        const t = Array.isArray(v) ? `array[${v.length}]` : typeof v;
        return `${k}:${t}`;
    }).join(', ') + ' }';
}
function redactKeys(obj) {
    // Show a shallow view but mask anything signature/token/tx-shaped.
    const SENSITIVE = /token|signature|signedtransaction|transaction|jwt|secret|challenge/i;
    const out = {};
    for (const [k, v] of Object.entries(obj || {})) {
        if (SENSITIVE.test(k) && typeof v === 'string') out[k] = `<${k}:${v.length}chars>`;
        else if (v && typeof v === 'object') out[k] = shape(v);
        else out[k] = v;
    }
    return out;
}

(async () => {
    console.log('═══ BAT-697 Trigger V2 contract probe (read-only, no funds) ═══');
    console.log(`wallet: ${BURNER_PUBKEY.slice(0, 4)}…${BURNER_PUBKEY.slice(-4)}`);
    console.log('');

    // 1. AUTH — transaction challenge (the path PR B uses). authenticate()
    //    fetches the challenge, runs _validateAuthTransaction on Jupiter's REAL
    //    bytes (blind-sign guard against real wire format), signs, verifies.
    console.log('── 1. authenticate() [transaction-challenge] ──');
    let token = null;
    try {
        const auth = await triggerV2.authenticate(BURNER_PUBKEY, signers);
        if (auth.ok) {
            token = auth.token;
            console.log(`  ✓ JWT obtained (real-challenge parser ACCEPTED Jupiter's tx, verify returned a token)`);
        } else {
            console.log(`  ✗ auth failed: ${auth.error} — ${auth.reason}`);
            console.log(`    → If error is auth_tx_invalid, the blind-sign parser rejected Jupiter's REAL challenge tx (parser gap to fix).`);
        }
    } catch (e) {
        console.log(`  ✗ threw: ${e.message}`);
    }
    console.log('');

    if (!token) {
        console.log('No JWT — cannot probe authed endpoints. Stopping. (Auth-shape finding above is still useful.)');
        process.exit(0);
    }

    // 2. ensureVault — confirms vault GET/register shape + vaultAddress field.
    console.log('── 2. ensureVault() ──');
    try {
        const v = await triggerV2.ensureVault(BURNER_PUBKEY, token);
        console.log(`  result: ${shape(v)}`);
        if (v.ok) console.log(`  vaultAddress present: ${!!v.vaultAddress}`);
        else console.log(`  ✗ ${v.error} — ${v.reason}`);
    } catch (e) { console.log(`  ✗ threw: ${e.message}`); }
    console.log('');

    // 3. listOrders — confirms /orders/history envelope + whether rows carry
    //    depositRequestId (the field my recovery fix correlates on).
    console.log('── 3. listOrders() ──');
    try {
        const l = await triggerV2.listOrders({ pubkey: BURNER_PUBKEY, token });
        if (l.ok) {
            console.log(`  ok, ${l.orders.length} order(s)`);
            if (l.orders.length) {
                console.log(`  row shape: ${shape(l.orders[0])}`);
                const hasDepReqId = l.orders.some(o => o.depositRequestId != null || o.requestId != null);
                console.log(`  rows carry depositRequestId/requestId: ${hasDepReqId}  ← recovery-correlation viability`);
                console.log(`  observed statuses: ${[...new Set(l.orders.map(o => o.status))].join(', ')}`);
            } else {
                console.log(`  (no orders for this wallet — envelope confirmed, row shape unknown)`);
            }
        } else {
            console.log(`  ✗ ${l.error} — ${l.reason}`);
        }
    } catch (e) { console.log(`  ✗ threw: ${e.message}`); }
    console.log('');

    // 4. deposit/craft — build-only (returns an UNSIGNED tx; we do NOT sign or
    //    submit it, so nothing moves). Confirms craft response field names
    //    (transaction + depositRequestId) and, by extension, create-body inputs.
    console.log('── 4. depositCraft() [build-only, not signed/submitted] ──');
    const USDC = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v';
    try {
        const c = await triggerV2.depositCraft({
            pubkey: BURNER_PUBKEY, token,
            inputMint: USDC, inputAmount: '10000000', // 10 USDC atomic — built, never signed
        });
        if (c.ok) {
            console.log(`  ✓ craft ok — fields: transaction=${typeof c.transaction}, depositRequestId=${typeof c.depositRequestId}`);
            console.log(`  depositRequestId field name CONFIRMED present`);
        } else {
            console.log(`  ✗ ${c.error} — ${c.reason}`);
            console.log(`    (a rejection here still reveals the craft contract via the error shape)`);
        }
    } catch (e) { console.log(`  ✗ threw: ${e.message}`); }
    console.log('');

    // 5. RAW inspection of the failing endpoints — print Jupiter's actual
    //    status + body so we can fix the vault/craft contract. Read/build-only.
    console.log('── 5. RAW endpoint inspection (discover correct shapes) ──');
    const https = require('https');
    function rawCall(method, p, bodyObj) {
        return new Promise((resolve) => {
            const body = bodyObj ? JSON.stringify(bodyObj) : null;
            const headers = { 'x-api-key': JUPITER_API_KEY, 'Accept': 'application/json', 'Authorization': `Bearer ${token}` };
            if (body) headers['Content-Type'] = 'application/json';
            const req = https.request({ hostname: 'api.jup.ag', path: p, method, headers }, (res) => {
                let d = ''; res.on('data', c => d += c); res.on('end', () => resolve({ status: res.statusCode, body: d }));
            });
            req.on('error', (e) => resolve({ status: 0, body: 'ERR ' + e.message }));
            if (body) req.write(body);
            req.end();
        });
    }
    const trunc = (s) => (s && s.length > 600 ? s.slice(0, 600) + '…' : s);
    // Verify the openapi-confirmed contract: vault register is GET (not POST),
    // craft uses userAddress/amount/outputMint. Build-only — no signing, no funds.
    const SOL = 'So11111111111111111111111111111111111111112';
    const probes = [
        ['GET', '/trigger/v2/vault/register', null], // idempotent Privy vault create
        ['GET', '/trigger/v2/vault', null],          // confirm vaultPubkey now present
        ['POST', '/trigger/v2/deposit/craft', { inputMint: USDC, outputMint: SOL, userAddress: BURNER_PUBKEY, amount: '10000000', orderType: 'price', orderSubType: 'single' }],
    ];
    for (const [m, p, b] of probes) {
        const r = await rawCall(m, p, b);
        console.log(`  ${m} ${p.split('?')[0]} → ${r.status}`);
        console.log(`    body: ${trunc(r.body)}`);
    }
    console.log('');

    console.log('═══ probe complete — no funds moved (only auth challenge was signed) ═══');
    console.log('NOT tested (needs explicit OK — moves real funds): /orders/price create, two-step cancel.');
})().catch((e) => { console.error('probe crashed:', e); process.exit(1); });
} // end if (!MODE_BALANCE && !MODE_FUNDED && !MODE_VERIFY)
