// SeekerClaw — solana.js
// Solana RPC, base58 encoding, transaction building, Jupiter DEX (tokens, quotes, swaps, prices), wallet management.
// Depends on: config.js, http.js, bridge.js

const https = require('https');
const fs = require('fs');
const path = require('path');

const { config, log, workDir } = require('./config');
const { httpRequest } = require('./http');
const { androidBridgeCall } = require('./bridge');

// ============================================================================
// SOLANA RPC
// ============================================================================

// BAT-1000: Solana RPC URL is per-call now (was module-scoped const). When the
// user sets a Helius API Key in Settings (Settings → Solana Wallet → Helius
// API Key), all Solana RPC reads route through Helius's mainnet endpoint
// (https://mainnet.helius-rpc.com/?api-key=…). Falls back to the public
// mainnet-beta RPC when unset — preserves existing behavior. Per-call
// evaluation mirrors the BAT-515 hot-reload pattern so a Settings UI edit
// takes effect on the next RPC call without a service restart. Helius is the
// same key BAT-319 added for NFT holdings (single source of truth).
const PUBLIC_SOLANA_RPC_URL = 'https://api.mainnet-beta.solana.com';

function getSolanaRpcUrl() {
    const raw = config.heliusApiKey;
    if (typeof raw === 'string') {
        const trimmed = raw.trim();
        if (trimmed.length > 0) {
            return `https://mainnet.helius-rpc.com/?api-key=${encodeURIComponent(trimmed)}`;
        }
    }
    return PUBLIC_SOLANA_RPC_URL;
}

// Single-shot RPC call (no retry)
async function solanaRpcOnce(method, params = [], rpcUrlOverride = null) {
    return new Promise((resolve) => {
        const postData = JSON.stringify({
            jsonrpc: '2.0',
            id: 1,
            method: method,
            params: params,
        });

        // BAT-1000 (Codex #1): preserve the query string. `url.pathname` alone
        // drops `?api-key=…` and would silently call Helius unauthenticated.
        // Pin via unit test in tests/nodejs-project/solana-rpc-url.test.js.
        //
        // R-next-12: optional rpcUrlOverride lets callers pin a specific URL
        // for the duration of a multi-call sequence (e.g. burner-signer
        // simulator's pre-snapshot + simulateTransaction must hit the SAME
        // RPC backing). Falls back to live config read when not supplied
        // (preserves all existing call sites).
        const url = new URL(rpcUrlOverride || getSolanaRpcUrl());
        const options = {
            hostname: url.hostname,
            port: 443,
            path: (url.pathname || '/') + (url.search || ''),
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'Content-Length': Buffer.byteLength(postData),
            },
            timeout: 15000,
        };

        const req = https.request(options, (res) => {
            res.setEncoding('utf8');
            let body = '';
            res.on('data', chunk => body += chunk);
            res.on('end', () => {
                try {
                    const json = JSON.parse(body);
                    if (json.error) {
                        resolve({ error: json.error.message });
                    } else {
                        resolve(json.result);
                    }
                } catch (e) {
                    resolve({ error: 'Invalid RPC response' });
                }
            });
        });

        req.on('error', (e) => resolve({ error: e.message }));
        req.on('timeout', () => { req.destroy(); resolve({ error: 'Solana RPC timeout' }); });
        req.write(postData);
        req.end();
    });
}

// BAT-255: Retry wrapper for transient RPC failures (timeout, network error).
// 2 attempts total, 1.5s backoff with jitter. Non-retriable errors (RPC-level
// application errors like "account not found") fast-fail immediately.
const RPC_TRANSIENT_PATTERNS = ['timeout', 'econnreset', 'econnrefused', 'etimedout', 'socket hang up', 'fetch failed', 'eai_again'];

async function solanaRpc(method, params = [], rpcUrlOverride = null) {
    const MAX_ATTEMPTS = 2;
    const BASE_DELAY_MS = 1500;

    for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
        const result = await solanaRpcOnce(method, params, rpcUrlOverride);

        // Success or non-retriable RPC application error → return immediately
        if (!result.error) return result;

        const errMsg = String(result.error).toLowerCase();
        const isTransient = RPC_TRANSIENT_PATTERNS.some(p => errMsg.includes(p));
        if (!isTransient || attempt === MAX_ATTEMPTS) {
            if (attempt > 1) log(`[Solana RPC] ${method} failed after ${attempt} attempts: ${errMsg}`, 'WARN');
            return result;
        }

        // Transient failure — retry with jitter
        const delay = BASE_DELAY_MS + Math.random() * 500;
        log(`[Solana RPC] ${method} transient failure (attempt ${attempt}/${MAX_ATTEMPTS}): ${errMsg} — retrying in ${Math.round(delay)}ms`, 'WARN');
        await new Promise(r => setTimeout(r, delay));
    }
}

// Base58 decode for Solana public keys and blockhashes
function base58Decode(str) {
    const ALPHABET = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';
    let zeros = 0;
    for (let i = 0; i < str.length && str[i] === '1'; i++) zeros++;
    let value = 0n;
    for (let i = 0; i < str.length; i++) {
        const idx = ALPHABET.indexOf(str[i]);
        if (idx < 0) throw new Error('Invalid base58 character: ' + str[i]);
        value = value * 58n + BigInt(idx);
    }
    // BAT-582 R5 fix: when value === 0n, value.toString(16) returns "0",
    // which pads to "00" and produces a 1-byte Buffer([0]) — adding a
    // spurious trailing zero byte. The correct payload for a zero-value
    // bigint is an empty buffer; the leading-zero count alone populates
    // the result. Same fix mirrored in payment/x402.js's identical helper.
    const hex = value.toString(16);
    const hexPadded = hex.length % 2 ? '0' + hex : hex;
    const decoded = value === 0n ? Buffer.alloc(0) : Buffer.from(hexPadded, 'hex');
    const result = Buffer.alloc(zeros + decoded.length);
    decoded.copy(result, zeros);
    return result;
}

// Base58 encode for Solana transaction signatures
function base58Encode(buf) {
    const ALPHABET = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';
    let zeros = 0;
    for (let i = 0; i < buf.length && buf[i] === 0; i++) zeros++;
    let value = 0n;
    for (let i = 0; i < buf.length; i++) {
        value = value * 256n + BigInt(buf[i]);
    }
    let result = '';
    while (value > 0n) {
        result = ALPHABET[Number(value % 58n)] + result;
        value = value / 58n;
    }
    return '1'.repeat(zeros) + result;
}

// Build an unsigned SOL transfer transaction (legacy format)
function buildSolTransferTx(fromBase58, toBase58, lamports, recentBlockhashBase58) {
    const from = base58Decode(fromBase58);
    const to = base58Decode(toBase58);
    const blockhash = base58Decode(recentBlockhashBase58);
    const systemProgram = Buffer.alloc(32); // 11111111111111111111111111111111

    // SystemProgram.Transfer instruction data: u32 LE index(2) + u64 LE lamports
    const instructionData = Buffer.alloc(12);
    instructionData.writeUInt32LE(2, 0);
    instructionData.writeBigUInt64LE(BigInt(lamports), 4);

    // Message: header + account keys + blockhash + instructions
    const message = Buffer.concat([
        Buffer.from([1, 0, 1]),          // num_required_sigs=1, readonly_signed=0, readonly_unsigned=1
        Buffer.from([3]),                // compact-u16: 3 account keys
        from,                            // index 0: from (signer, writable)
        to,                              // index 1: to (writable)
        systemProgram,                   // index 2: System Program (readonly)
        blockhash,                       // recent blockhash
        Buffer.from([1]),                // compact-u16: 1 instruction
        Buffer.from([2]),                // program_id_index = 2 (System Program)
        Buffer.from([2, 0, 1]),          // compact-u16 num_accounts=2, indices [0, 1]
        Buffer.from([12]),               // compact-u16 data_length=12
        instructionData,
    ]);

    // Full transaction: signature count + empty signature + message
    return Buffer.concat([
        Buffer.from([1]),                // compact-u16: 1 signature
        Buffer.alloc(64),               // empty signature placeholder
        message,
    ]);
}

// ============================================================================
// JUPITER DEX (Token resolution, quotes, swaps, prices)
// ============================================================================

// Token list cache — refreshed every 30 minutes
const jupiterTokenCache = {
    tokens: [],
    bySymbol: new Map(),   // lowercase symbol → token[] (all matches, sorted by relevance)
    byMint: new Map(),     // mint address → token
    lastFetch: 0,
    CACHE_TTL: 30 * 60 * 1000,  // 30 min
};

// Well-known fallbacks (in case API is down)
const WELL_KNOWN_TOKENS = {
    'sol':  { address: 'So11111111111111111111111111111111111111112', decimals: 9, symbol: 'SOL', name: 'Wrapped SOL' },
    'usdc': { address: 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v', decimals: 6, symbol: 'USDC', name: 'USD Coin' },
    'usdt': { address: 'Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB', decimals: 6, symbol: 'USDT', name: 'USDT' },
};

// Known program names for swap transaction logging.
// Maps program ID → human-readable label. BAT-1013: used for log readability
// ONLY — the prior program-ID allowlist enforcement was removed because
// (1) it DoS'd legitimate swaps when Jupiter routed through programs we
// hadn't labeled yet, and (2) industry consensus (Phantom/Backpack/Solflare/
// MWA spec) is blocklist+simulation, not integrator-side allowlist. See
// verifySwapTransaction() + wallet/burner-policy.js for the new primitives.
// Initialized with hardcoded fallback, refreshed from Jupiter API on startup.
const KNOWN_PROGRAM_NAMES = new Map([
    // === System Programs ===
    ['11111111111111111111111111111111',           'System Program'],
    ['TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA',  'Token Program'],
    ['TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb',  'Token-2022'],
    ['ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL',  'Associated Token'],
    ['ComputeBudget111111111111111111111111111111', 'Compute Budget'],
    // === Jupiter Programs ===
    // BAT-1013: program IDs cross-verified against jup-ag/platform-list,
    // jup-ag/docs openapi-spec, @jup-ag/* npm SDKs, and Solscan labels.
    // Prior `jup6SoC2JQ3...` entry removed — it appeared nowhere outside
    // SeekerClaw and was a typo/fabricated value. Prior `jupoNjAx...`
    // was mislabeled as 'Jupiter DCA' — it is actually Limit Order V1;
    // real DCA is `DCA265...`.
    ['JUP6LkbZbjS1jKKwapdHNy74zcZ3tLUZoi5QNyVTaV4',  'Jupiter v6'],
    ['JUP4Fb2cqiRUcaTHdrPC8h2gNsA2ETXiPDD33WcGuJB',  'Jupiter v4'],
    ['JUP3jqKShLQUCEDeLBpihUwbcTiY7Gg3V1GAbRhhr82',  'Jupiter v3'],
    ['jupoNjAxXgZ4rjzxzPMP4oxduvQsQtZzyknqvzYNrNu',  'Jupiter Limit Order V1'],
    ['j1o2qRpjcyUwEvwtcfhEQefh773ZgjxcVRry7LDqg5X',  'Jupiter Limit Order V2 / Trigger V2'],
    ['DCA265Vj8a9CEuX1eb1LWRnDT7uK6q1xMipnNyatn23M', 'Jupiter DCA'],
    ['jup3YeL8QhtSx1e253b2FDvsMNC87fDrgQZivbrndc9',  'Jupiter Lend Earn'],
    // === Third-Party Aggregators (Jupiter meta-aggregation) ===
    ['DF1ow4tspfHX9JwWJsAb9epbkA8hmpSEAtxXy1V27QBH', 'DFlow Aggregator v4'],
    // === DEXes / AMMs (from Jupiter program-id-to-label, Feb 2026) ===
    ['whirLbMiicVdio4qvUfM5KAg6Ct8VwpYzGff3uctyCc',  'Orca Whirlpool'],
    ['9W959DqEETiGZocYWCQPaJ6sBmUzgfxXfqGeTEdp3aQP', 'Orca V2'],
    ['DjVE6JNiYqPL2QXyCUUh8rNjHrbz9hXHNYt99MQ59qw1', 'Orca V1'],
    ['675kPX9MHTjS2zt1qfr1NYHuzeLXfQM9H24wFSUt1Mp8', 'Raydium AMM'],
    ['CAMMCzo5YL8w4VFF8KVHrK22GGUsp5VTaW7grrKgrWqK', 'Raydium CLMM'],
    ['CPMMoo8L3F4NbTegBCKVNunggL7H1ZpdTHKxQB5qKP1C', 'Raydium CP'],
    ['LanMV9sAd7wArD4vJFi2qDdfnVhFxYSUg6eADduJ3uj', 'Raydium Launchlab'],
    ['SSwpkEEcbUqx4vtoEByFjSkhKdCT862DNVb52nZg1UZ',  'Saber Swap'],
    ['DecZY86MU5Gj7kppfUCEmd4LbXXuyZH1yHaP2NTqdiZB', 'Saber Decimals'],
    ['MERLuDFBMmsHnsBPZw2sDQZHvXFMwp8EdjudcU2HKky',  'Mercurial'],
    ['srmqPvymJeFKQ4zGQed1GFppgkRHL9kaELCbyksJtPX',  'Serum / OpenBook V1'],
    ['opnb2LAfJYbRMAHHvqjCwQxanZn7ReEHp1k81EohpZb',  'OpenBook V2'],
    ['PhoeNiXZ8ByJGLkxNfZRnkUfjvmuYqLR89jjFHGqdXY',  'Phoenix'],
    ['LBUZKhRxPF3XUpBCjp4YzTKgLccjZhTSDM9YuVaPwxo',  'Meteora DLMM'],
    ['Eo7WjKq67rjJQSZxS6z3YkapzY3eMj6Xy8X5EQVn5UaB', 'Meteora Pools'],
    ['cpamdpZCGKUy5JxQXB4dcpGPiikHawvSWAd6mEn1sGG',  'Meteora DAMM v2'],
    ['2wT8Yq49kHgDzXuPxZSaeLaH1qbmGXtEyPy64bL7aD3c', 'Lifinity Swap V2'],
    ['AMM55ShdkoGRB5jVYPjWziwk8m5MpwyDgsMWHaMSQWH6', 'Aldrin'],
    ['CURVGoZn8zycx6FXwwevgBTB2gVvdbGTEpvMJDbgs2t4', 'Aldrin V2'],
    ['CLMM9tUoggJu2wagPkkqs9eFG4BWhVBZWkP1qv3Sp7tR', 'Crema'],
    ['H8W3ctz92svYg6mkn1UtGfu2aQr2fnUFHM1RhScEtQDt', 'Cropper'],
    ['HyaB3W9q6XdA5xwpU4XnSZV94htfmbmqJXZcEbRaJutt', 'Invariant'],
    ['Dooar9JkhdZ7J3LHN3A7YCuoGRUggXhQaG4kijfLGU2j', 'StepN'],
    ['stkitrT1Uoy18Dk1fTrgPw8W6MVzoCfYoAFT4MLsmhq',  'Sanctum'],
    ['5ocnV1qiCgaQR8Jb8xWnVbApfaygJ8tNoZfgPwsgx9kx', 'Sanctum Infinity'],
    ['SSwapUtytfBdBn1b9NUGG6foMVPtcWgpRU32HToDUZr',  'Saros'],
    ['1qbkdrr3z4ryLA7pZykqxvxWPoeifcVKo6ZG9CfkvVE',  'Saros DLMM'],
    ['obriQD1zbpyLz95G5n7nJe6a4DPjpFwa5XYPoNm113y',  'Obric V2'],
    ['FLUXubRmkEi2q6K3Y9kBPg9248ggaZVsoSFhtJHSrm1X', 'FluxBeam'],
    ['PSwapMdSai8tjrEXcxFeQth87xC4rRsa4VA5mhGhXkP',  'Penguin'],
    ['BSwp6bEBihVLdqJRKGgzjcGLHkcTuzmSo1TQkHepzH8p', 'Bonkswap'],
    ['Gswppe6ERWKpUTXvRPfXdzHhiCyJvLadVvXGfdpBqcE1', 'Guacswap'],
    ['treaf4wWBBty3fHdyBpo35Mz84M8k3heKXmjmi9vFt5',  'Helium Network'],
    ['SwaPpA9LAaLfeLi3a68M4DjnLqgtticKg6CnyNwgAC8',  'Token Swap (SPL)'],
    ['HpNfyc2Saw7RKkQd8nEL4khUcuPhQ7WwY1B2qjx8jxFq', 'PancakeSwap'],
    ['GAMMA7meSFWaBXF25oSUgmGRwaW6sCMFLmBNiMSdbHVT', 'GooseFX GAMMA'],
    ['swapNyd8XiQwJ6ianp9snpu4brUqFxadzvHebnAXjJZ',  'Stabble Stable Swap'],
    ['swapFpHZwjELNnjvThjajtiVmkz3yPQEHjLtka2fwHW',  'Stabble Weighted Swap'],
    ['6dMXqGZ3ga2dikrYS9ovDXgHGh5RUsb2RTUj6hrQXhk6', 'Stabble CLMM'],
    ['MNFSTqtC93rEfYHB6hF82sKdZpUDFWkViLByLd1k1Ms',  'Manifest'],
    ['WooFif76YGRNjk1pA8wCsN67aQsD9f9iLsz4NcJ1AVb',  'Woofi'],
    ['fUSioN9YKKSa3CUC2YUc4tPkHJ5Y6XW1yz8y6F7qWz9', 'DefiTuna'],
    ['srAMMzfVHVAtgSJc8iH6CfKzuWuUTzLHVCE81QU1rgi',  'Gavel'],
    ['pAMMBay6oceH9fJKBRHGP5D4bD4sWpmSwMn52FMfXEA',  'Pump.fun AMM'],
    ['6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P',  'Pump.fun'],
    ['dbcij3LWUppWqq96dh6gJWwBifmcGfLSB5D4DuSMaqN',  'Dynamic Bonding Curve'],
    ['PERPHjGBqRHArX4DySjwM6UJHiR3sWAatqfdBS2qQJu',  'Perps'],
    ['SoLFiHG9TfgtdUXUjWAxi3LtvYuFyDLVhBWxdMZxyCe',  'SolFi'],
    ['SV2EYYJyRz2YhfXwXnhNAevDEui5Q6yrfyo13WtupPF',  'SolFi V2'],
    ['BiSoNHVpsVZW2F7rx2eQ59yQwKxzU5NvBcmKshCSUypi', 'BisonFi'],
    ['5U3EU2ubXtK84QcRjWVmYt9RaDyA8gKxdUrPFXmZyaki', 'Virtuals'],
    ['ZERor4xhbUycZ6gb9ntrhqscUcZmAbQDjEAtCf4hbZY',  'ZeroFi'],
    ['HEAVENoP2qxoeuF8Dj2oT1GHEnu49U5mJYkdeC8BAX2o', 'Heaven'],
    ['CarrotwivhMpDnm27EHmRLeQ683Z1PufuqEmBZvD282s', 'Carrot'],
    ['boop8hVGQGqehUK2iVEMEnMrL5RbjywRzHKBmBE7ry4',  'Boop.fun'],
    ['QuaNtZsgYRe5Z9Bk4LZ4cTD9tbkVoyCNf1R2BN9bBDv', 'Quantum'],
    ['goonuddtQRrWqqn5nFyczVKaie28f3kDkHWkHtURSLE',  'GoonFi V2'],
    ['goonERTdGsjnkZqWuVjs73BZ3Pb9qoCUdBUL17BnS5j',  'GoonFi'],
    ['HBVw6bZtcCaezhcBrmfyXBSBRWCdv72271xQ4GPvms2z', 'Obsidian'],
    ['MoonCVVNZFSYkqNXP6bxHLPL6QQJiMagDL3qcqUQTrG',  'Moonit'],
    ['save8RQVPMWNTzU18t3GBvBkN9hT7jsGjiCQ28FpD9H',  'Perena Star'],
    ['NUMERUNsFCP3kuNmWZuXtm1AaQCPj9uw6Guv2Ekoi5P', 'Perena'],
    ['DEXYosS6oEGvk8uCDayvwEZz4qEyDJRf9nFgYCaqPMTm', '1DEX'],
    ['ojh19ojaKduoJZuaJADhcVGp4xt1TcdAvZmpVsCorch',  'Scorch'],
    ['9H6tua7jkLhdm3w8BvgpTn5LZNU7g4ZynDmCiNN3q6Rp', 'HumidiFi'],
    ['2rU1oCHtQ7WJUvy15tKtFvxdYNNSc3id7AzUcjeFSddo', 'VaultLiquidUnstake'],
    ['DSwpgjMvXhtGn6BsbqmacdBZyfLj6jSWf3HJpdJtmg6N', 'DexLab'],
    ['TessVdML9pBGgG9yGks7o4HewRaXVAMuoVj4x83GLQH',  'TesseraV'],
    ['REALQqNEomY6cQGZJUGwywTBD2UmDT32rZcNnfxQ5N2',  'Byreal'],
    ['AQU1FRd7papthgdrwPTTq5JacJh8YtwEXaBfKU3bTz45', 'Aquifer'],
    ['FUTARELBfJfQ8RDGhg1wdhddq1odMAJUePHFuBYfUxKq', 'MetaDAO'],
    ['FW6zUqn4iKRaeopwwhwsquTY6ABWLLgjxtrC3VPnaWBf', 'WhaleStreet'],
    ['StaKE6XNKVVhG8Qu9hDJBqCW3eRe7MDGLz17nJZetLT',  'XOrca'],
    ['endoLNCKTqDn8gSVnN2hDdpgACUPWHZTwoYnnMybpAT',  'Solayer'],
    ['ALPHAQmeA7bjrVuccPsYPiCvsi428SNwte66Srvs4pHA', 'AlphaQ'],
]);

// KNOWN_PROGRAM_NAMES is used for log readability only (BAT-1013).
// Program-ID allowlist enforcement was removed because (1) Jupiter ships new
// routing programs faster than they label them in their public API, which
// silently DoS'd legitimate swaps (2026-06-03 device incident), and
// (2) Phantom/Backpack/Solflare all use simulation+blocklist patterns rather
// than integrator-side program allowlists — Solana Cookbook + audit firm
// consensus (workflow `wx2c95307`). Structural fee-payer/signer check stays
// in verifySwapTransaction(); drainer-opcode blocklist + simulate-vs-quote
// lives in wallet/burner-policy.js for autonomous burner signing.

// Fetch latest program labels from Jupiter API on startup, merge into KNOWN_PROGRAM_NAMES.
// Falls back to the hardcoded list above if the fetch fails.
async function refreshJupiterProgramLabels() {
    try {
        const res = await httpRequest({
            hostname: 'public.jupiterapi.com',
            path: '/program-id-to-label',
            method: 'GET',
            headers: { 'Accept': 'application/json' },
        });
        if (res.status !== 200 || !res.data || typeof res.data !== 'object') {
            log(`[Jupiter] Program label fetch failed: HTTP ${res.status}`, 'WARN');
            return;
        }
        let added = 0;
        for (const [programId, label] of Object.entries(res.data)) {
            if (!KNOWN_PROGRAM_NAMES.has(programId)) {
                KNOWN_PROGRAM_NAMES.set(programId, String(label));
                added++;
            }
        }
        log(`[Jupiter] Program labels refreshed: ${KNOWN_PROGRAM_NAMES.size} total (${added} new from API, log labels only — no policy effect)`, 'INFO');
    } catch (err) {
        log(`[Jupiter] Program label fetch error (using hardcoded fallback): ${err.message}`, 'WARN');
    }
}

// Jupiter API request wrapper with 429 rate limit handling + exponential backoff
// Per Jupiter docs: on HTTP 429, use exponential backoff with jitter, wait for 10s window refresh
async function jupiterRequest(options, body = null, maxRetries = 3) {
    const BASE_DELAY = 2000;  // 2s initial delay
    const MAX_DELAY = 15000;  // 15s max delay (covers 10s window)
    const JITTER_MAX = 1000;  // up to 1s random jitter

    for (let attempt = 0; attempt <= maxRetries; attempt++) {
        const res = await httpRequest(options, body);

        if (res.status !== 429) return res;

        // Rate limited — retry with exponential backoff + jitter
        if (attempt < maxRetries) {
            const delay = Math.min(BASE_DELAY * Math.pow(2, attempt) + Math.random() * JITTER_MAX, MAX_DELAY);
            log(`[Jupiter] Rate limited (429), retrying in ${Math.round(delay)}ms (attempt ${attempt + 1}/${maxRetries})...`, 'WARN');
            await new Promise(r => setTimeout(r, delay));
        }
    }

    // All retries exhausted — return the 429 response so callers can handle it
    return { status: 429, data: { error: 'Rate limited after retries', code: 'RATE_LIMITED', retryable: true } };
}

async function fetchJupiterTokenList() {
    const now = Date.now();
    if (jupiterTokenCache.tokens.length > 0 && (now - jupiterTokenCache.lastFetch) < jupiterTokenCache.CACHE_TTL) {
        return; // Cache still fresh
    }

    try {
        log('[Jupiter] Fetching verified token list (tokens/v2)...', 'DEBUG');
        const headers = { 'Accept': 'application/json' };
        if (config.jupiterApiKey) headers['x-api-key'] = config.jupiterApiKey;

        const res = await jupiterRequest({
            hostname: 'api.jup.ag',
            path: '/tokens/v2/tag?query=verified',
            method: 'GET',
            headers,
        });

        if (res.status === 200 && Array.isArray(res.data)) {
            // Jupiter Tokens v2 uses 'id' for mint address — normalize to 'address' for our code
            const normalized = res.data.map(t => ({
                ...t,
                address: t.id || t.address,  // v2 uses 'id', fallback to 'address'
                verified: t.isVerified ?? t.verified ?? false,
                price: t.usdPrice ?? t.price ?? null,
                marketCap: t.mcap ?? t.marketCap ?? null,
            }));
            jupiterTokenCache.tokens = normalized;
            jupiterTokenCache.bySymbol.clear();
            jupiterTokenCache.byMint.clear();

            for (const token of normalized) {
                jupiterTokenCache.byMint.set(token.address, token);
                const sym = token.symbol.toLowerCase();
                if (!jupiterTokenCache.bySymbol.has(sym)) {
                    jupiterTokenCache.bySymbol.set(sym, []);
                }
                jupiterTokenCache.bySymbol.get(sym).push(token);
            }

            jupiterTokenCache.lastFetch = now;
            log(`[Jupiter] Loaded ${normalized.length} verified tokens`, 'INFO');
        } else {
            log(`[Jupiter] Token list fetch failed: ${res.status}`, 'WARN');
        }
    } catch (e) {
        log(`[Jupiter] Token list error: ${e.message}`, 'ERROR');
    }
}

// Validate Solana wallet address — base58 decode must yield exactly 32 bytes (Ed25519 key)
function isValidSolanaAddress(address) {
    if (!address || typeof address !== 'string') return false;
    const trimmed = address.trim();
    if (!/^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(trimmed)) return false;
    try { return base58Decode(trimmed).length === 32; } catch { return false; }
}

// Parse input amount to lamports using BigInt for precision safety
function parseInputAmountToLamports(amount, decimals) {
    if (decimals == null) {
        throw new Error('Token is missing decimal metadata; cannot calculate input amount in base units.');
    }
    if (!Number.isInteger(decimals) || decimals < 0) {
        throw new Error('decimals must be a non-negative integer');
    }
    const amountStr = String(amount).trim();
    if (amountStr.length === 0) {
        throw new Error('Input amount must not be empty.');
    }
    // Allow only simple decimal numbers: digits, optional single dot, no signs or exponents
    if (!/^\d+(\.\d+)?$/.test(amountStr)) {
        throw new Error(`Input amount "${amountStr}" must be a positive decimal number without signs or scientific/exponential notation (e.g., "1e6" or "1.5e-3" are not supported).`);
    }
    const parts = amountStr.split('.');
    const integerPart = parts[0];
    const fractionPart = parts[1] || '';
    if (fractionPart.length > decimals) {
        throw new Error(`Input amount has more fractional digits than supported (${decimals}).`);
    }
    // Pad the fractional part to the token's decimals
    const paddedFraction = fractionPart.padEnd(decimals, '0');
    const fullDigits = integerPart + paddedFraction;
    // Remove leading zeros, but keep at least one digit
    const normalizedDigits = fullDigits.replace(/^0+/, '') || '0';
    const lamports = BigInt(normalizedDigits);
    if (lamports <= 0n) {
        throw new Error('Input amount must be greater than 0.');
    }
    return lamports.toString(); // Return as string for JSON serialization
}

// Wallet pre-authorization — ensures wallet app is warm before signing.
// On Seeker (and some MWA wallets), signTransactions() may fail with misleading
// errors when the wallet is cold (not recently unlocked). Pre-authorizing wakes
// the wallet and prompts for PIN if needed.
let lastWalletAuthTime = 0;
const WALLET_AUTH_CACHE_MS = 5 * 60 * 1000; // 5 minutes

async function ensureWalletAuthorized() {
    if (Date.now() - lastWalletAuthTime < WALLET_AUTH_CACHE_MS) {
        return; // wallet is warm
    }
    log('[Wallet] Pre-authorizing wallet (cold start protection)...', 'DEBUG');
    const result = await androidBridgeCall('/solana/authorize', {}, 60000);
    if (result.error) {
        throw new Error(`Wallet authorization failed: ${result.error}`);
    }
    lastWalletAuthTime = Date.now();
    log('[Wallet] Wallet authorized and ready', 'INFO');
}

// Get connected wallet address from solana_wallet.json
function getConnectedWalletAddress() {
    const walletConfigPath = path.join(workDir, 'solana_wallet.json');
    if (!fs.existsSync(walletConfigPath)) {
        throw new Error('No wallet connected. Connect a wallet in SeekerClaw Settings > Solana Wallet.');
    }

    let walletConfig;
    try {
        const fileContent = fs.readFileSync(walletConfigPath, 'utf8');
        walletConfig = JSON.parse(fileContent);
    } catch (e) {
        throw new Error('Malformed solana_wallet.json: invalid JSON. Please reconnect your wallet.');
    }

    if (!walletConfig || typeof walletConfig.publicKey !== 'string') {
        throw new Error('Malformed solana_wallet.json: missing publicKey. Please reconnect your wallet.');
    }

    const publicKey = walletConfig.publicKey.trim();
    if (!isValidSolanaAddress(publicKey)) {
        throw new Error('Invalid Solana wallet address in solana_wallet.json. Please reconnect your wallet.');
    }

    return publicKey;
}

// Resolve token symbol or mint address → token object, or { ambiguous, candidates } if multiple matches
async function resolveToken(input) {
    if (!input || typeof input !== 'string') return null;
    const trimmed = input.trim();

    // If it looks like a base58 mint address (32+ chars), use directly
    if (trimmed.length >= 32 && /^[1-9A-HJ-NP-Za-km-z]+$/.test(trimmed)) {
        await fetchJupiterTokenList();
        const cached = jupiterTokenCache.byMint.get(trimmed);
        if (cached) return cached;
        // Unknown mint — NOT on Jupiter's verified list. Flag as unverified.
        return {
            address: trimmed,
            decimals: null,
            symbol: '???',
            name: 'Unknown token',
            warning: 'This token is NOT on Jupiter\'s verified token list. It may be a scam, rug pull, or fake token. ALWAYS warn the user and ask them to double-check the contract address before proceeding.',
        };
    }

    // Resolve by symbol
    const sym = trimmed.toLowerCase();

    await fetchJupiterTokenList();
    const matches = jupiterTokenCache.bySymbol.get(sym);

    if (matches && matches.length === 1) {
        return matches[0]; // Unambiguous
    }

    if (matches && matches.length > 1) {
        // Multiple tokens with same symbol — return top 5 candidates for agent to present
        return {
            ambiguous: true,
            symbol: trimmed.toUpperCase(),
            candidates: matches.slice(0, 5).map(t => ({
                address: t.address,
                name: t.name,
                symbol: t.symbol,
                decimals: t.decimals,
            })),
        };
    }

    // Fallback to well-known
    if (WELL_KNOWN_TOKENS[sym]) return WELL_KNOWN_TOKENS[sym];

    return null;
}

// Jupiter Swap API v6 - Quote endpoint (Metis routing)
async function jupiterQuote(inputMint, outputMint, amountRaw, slippageBps = 100) {
    if (!config.jupiterApiKey) {
        throw new Error('Jupiter API key required. Get a free key at portal.jup.ag and add it in Settings > Configuration > Jupiter API Key');
    }

    const params = new URLSearchParams({
        inputMint,
        outputMint,
        amount: String(amountRaw),
        slippageBps: String(slippageBps),
    });

    const headers = {
        'Accept': 'application/json',
        'x-api-key': config.jupiterApiKey
    };

    const res = await jupiterRequest({
        hostname: 'api.jup.ag',
        path: `/swap/v1/quote?${params.toString()}`,
        method: 'GET',
        headers
    });

    if (res.status !== 200) {
        throw new Error(`Jupiter quote failed: ${res.status} - ${JSON.stringify(res.data)}`);
    }
    return res.data;
}

// Verify a Jupiter swap transaction before sending to wallet.
//
// Structural + signer check ONLY (BAT-1013, replaces program-ID allowlist):
//   1. Fee payer matches user's pubkey (default) OR user is among required
//      signers (Ultra gasless mode via `skipPayerCheck: true`).
//   2. Walks instructions to collect a labeled `programs` list FOR LOG
//      READABILITY ONLY — an unlabeled or new program NEVER fails verification.
//
// What this function intentionally does NOT do anymore:
//   - No program-ID allowlist (`TRUSTED_PROGRAMS` removed; Jupiter ships
//     routing programs faster than they label them, and Phantom/Backpack
//     /Solflare all use simulation+blocklist instead of integrator allowlists).
//   - No Address Lookup Table rejection (ALT-resolved programs are part of
//     Jupiter's normal routing for V2 trigger and Ultra flows).
//
// Drainer-opcode blocking + simulate-vs-quote enforcement lives in
// `wallet/burner-policy.js` for autonomous (burner) signing flows. MWA
// flows still get the final user click-through inside the wallet UI.
//
// Options: { skipPayerCheck: true } for Jupiter Ultra (Jupiter pays fees).
// Returns: { valid: boolean, error?: string, programs: string[] }
function verifySwapTransaction(txBase64, expectedPayerBase58, options = {}) {
    const { skipPayerCheck = false } = options;
    // Strict base64 validation (Copilot PR #397 R4 mirrored): Buffer.from
    // silently strips invalid chars and decodes partial input.
    if (typeof txBase64 !== 'string' || txBase64.length === 0) {
        return { valid: false, error: 'tx_unparseable: empty or non-string input', programs: [] };
    }
    if (!/^[A-Za-z0-9+/]+={0,2}$/.test(txBase64) || txBase64.length % 4 !== 0) {
        return { valid: false, error: 'tx_unparseable: invalid base64 characters or length', programs: [] };
    }
    // R-next-10: pre-decode size guard (DoS mitigation). 1232 bytes encode
    // to at most ceil(1232/3)*4 = 1644 chars in base64; anything longer is
    // guaranteed oversized and we should reject BEFORE allocating a buffer.
    // Mirrors wallet/tx-parser.js + jupiter/trigger-v2.js + tools/solana.js.
    if (txBase64.length > 1644) {
        return { valid: false, error: `tx_oversize: ~${Math.floor(txBase64.length * 3 / 4)} bytes exceeds Solana's 1232-byte packet cap.`, programs: [] };
    }
    let txBuf;
    try {
        txBuf = Buffer.from(txBase64, 'base64');
    } catch (e) {
        return { valid: false, error: `tx_unparseable: ${e.message}`, programs: [] };
    }
    if (txBuf.length === 0) {
        return { valid: false, error: 'tx_unparseable: decoded buffer is empty', programs: [] };
    }
    // C1 (BAT-1013-followup): exact post-decode 1232-byte packet cap check
    // — catches padded base64 strings under 1644 chars that decode just
    // over 1232 bytes (padding edge case).
    if (txBuf.length > 1232) {
        return { valid: false, error: `tx_oversize: ${txBuf.length} bytes exceeds Solana's 1232-byte packet cap.`, programs: [] };
    }

    const programs = [];
    const labelProgram = (id) => {
        const name = KNOWN_PROGRAM_NAMES.get(id);
        if (name) {
            // Snake-case for log greppability ("jupiter_aggregator_v6" not
            // "Jupiter Aggregator v6"). Lowercase + replace whitespace.
            programs.push(name.toLowerCase().replace(/\s+/g, '_'));
        } else {
            // Truncated base58 + (unlabeled) suffix so forensics can still
            // find the program ID without dumping the full 44-char string.
            programs.push(`${id.slice(0, 4)}…${id.slice(-4)}(unlabeled)`);
        }
    };

    // Skip signature section to reach the message.
    let offset = 0;
    const numSigs = readCompactU16(txBuf, offset);
    offset = numSigs.offset;
    // R-next-10: readCompactU16 returns sentinels (value=0xFFFFFFFF) on
    // truncation/overflow. Without an explicit check here, the bounds
    // guard below would compute `0xFFFFFFFF * 64` and surface a noisy
    // error message with the sentinel value. Fail-closed cleanly with
    // a specific error instead. Mirrors the per-call-site checks already
    // in place for numInstructions / numAlts (lines ~907, ~953).
    if (!numSigs.terminated || numSigs.overflowed) {
        return { valid: false, error: 'tx_unparseable: signature count varint truncated or overflowed.', programs };
    }
    // Buffer-bounds guard (Copilot PR #397 R4 mirrored): claimed sig count
    // must fit in the remaining buffer.
    if (offset + numSigs.value * 64 > txBuf.length) {
        return { valid: false, error: `Signature bytes truncated: declared ${numSigs.value} sigs needs ${numSigs.value * 64} bytes, only ${txBuf.length - offset} remain.`, programs };
    }
    offset += numSigs.value * 64;

    // Detect versioned vs legacy. Solana versioned-message prefix has the
    // high bit set: (prefix & 0x80) !== 0; the lower 7 bits encode the
    // version number. Today only v0 exists; future versions (v1, v2, ...)
    // would set prefix = 0x81, 0x82, etc. Copilot PR #397 R12: do NOT
    // strict-equal 0x80 — a future v1 (0x81) would silently fall into the
    // legacy parsing path and produce misleading errors. Fail closed on
    // any non-zero version we don't yet understand.
    // Bounds-check first (Copilot PR #397 R7 mirrored): a tx truncated
    // immediately after the signature section makes txBuf[offset] return
    // undefined, falling into the legacy parsing path with misleading errors.
    if (offset >= txBuf.length) {
        return { valid: false, error: 'Message section truncated (no bytes after signatures).', programs };
    }
    const prefix = txBuf[offset];
    const isVersioned = (prefix & 0x80) !== 0;
    if (isVersioned) {
        const version = prefix & 0x7F;
        if (version !== 0) {
            return { valid: false, error: `unsupported_tx_version: v${version} (only v0 is supported)`, programs };
        }
    }
    const isV0 = isVersioned; // version is guaranteed 0 if we got here

    if (!isV0) {
        // Legacy transaction. Ultra always uses v0, so reject legacy under
        // Ultra mode — that's a structural mismatch, not a program check.
        if (skipPayerCheck) {
            return { valid: false, error: 'Expected v0 transaction for Ultra gasless flow, got legacy format', programs };
        }

        // Legacy message: header (3 bytes) + account keys + blockhash + instructions
        if (offset + 3 > txBuf.length) {
            return { valid: false, error: 'Legacy: 3-byte message header truncated.', programs };
        }
        // C10 + Q2 (BAT-1013-followup) + R9: enforce header invariants. The
        // Solana protocol does NOT cap signers at a fixed numeric limit —
        // the practical bound is packet-size-driven. Enforce the protocol
        // invariants that DO hold:
        //   - numRequiredSignatures >= 1 (fee payer is always a signer)
        //   - numRequiredSignatures === sig section count (header matches
        //     signature section)
        //   - numReadonlySigned must not exceed numRequiredSignatures
        //   - readonly-signed + readonly-unsigned sum must fit inside the
        //     static account key count.
        // Previously the v0 path silently truncated numRequired via
        // Math.min(numRequired, accountKeys.length) — letting a tx claiming
        // numRequired > accounts slip past with no signer check.
        const legacyNumRequired = txBuf[offset]; offset++;
        const legacyNumReadonlySigned = txBuf[offset]; offset++;
        const legacyNumReadonlyUnsigned = txBuf[offset]; offset++;
        // Copilot R9: drop arbitrary 16-cap (Solana's actual limit is
        // packet-size-based). Use protocol invariants instead.
        if (legacyNumRequired < 1) {
            return { valid: false, error: `invalid_header: numRequiredSignatures=0 (fee payer must be a signer).`, programs };
        }
        if (legacyNumRequired !== numSigs.value) {
            return { valid: false, error: `invalid_header: numRequiredSignatures=${legacyNumRequired} does not match signature-section count=${numSigs.value}.`, programs };
        }
        if (legacyNumReadonlySigned > legacyNumRequired) {
            return { valid: false, error: `invalid_header: numReadonlySigned=${legacyNumReadonlySigned} exceeds numRequired=${legacyNumRequired}.`, programs };
        }
        const numAccounts = readCompactU16(txBuf, offset);
        offset = numAccounts.offset;
        // R-next-10 same-class sweep: explicit terminated/overflowed check
        // produces a clean error message instead of letting the sentinel
        // value (0xFFFFFFFF) leak into downstream invariant or bounds
        // checks. Mirrors numSigs + numInstructions + numAlts patterns.
        if (!numAccounts.terminated || numAccounts.overflowed) {
            return { valid: false, error: 'tx_unparseable: legacy account count varint truncated or overflowed.', programs };
        }
        if (legacyNumRequired > numAccounts.value) {
            return { valid: false, error: `invalid_header: numRequiredSignatures=${legacyNumRequired} exceeds account key count=${numAccounts.value}.`, programs };
        }
        if (legacyNumReadonlySigned + legacyNumReadonlyUnsigned > numAccounts.value) {
            return { valid: false, error: `invalid_header: readonly sum (${legacyNumReadonlySigned}+${legacyNumReadonlyUnsigned}) exceeds account key count=${numAccounts.value}.`, programs };
        }

        // Buffer-bounds guard (Copilot PR #397 R3 same-class fix mirrored here):
        // a malformed tx claiming a huge numAccounts walks past end-of-buffer
        // producing bogus base58 keys. Fail closed before the loop.
        if (offset + numAccounts.value * 32 > txBuf.length) {
            return { valid: false, error: `Legacy: declared ${numAccounts.value} account keys exceeds remaining buffer.`, programs };
        }

        const legacyAccountKeys = [];
        for (let i = 0; i < numAccounts.value; i++) {
            legacyAccountKeys.push(base58Encode(txBuf.slice(offset, offset + 32)));
            offset += 32;
        }

        // Reject zero-account tx — see v0 path comment.
        if (legacyAccountKeys.length === 0) {
            return { valid: false, error: 'Transaction has no account keys (cannot verify fee payer)', programs };
        }
        // First account is fee payer.
        if (legacyAccountKeys[0] !== expectedPayerBase58) {
            return { valid: false, error: `Fee payer mismatch: expected ${expectedPayerBase58}, got ${legacyAccountKeys[0]}`, programs };
        }

        // Skip recent blockhash (32 bytes). Bounds-check first.
        if (offset + 32 > txBuf.length) {
            return { valid: false, error: `Legacy: blockhash truncated.`, programs };
        }
        offset += 32;

        // Walk instructions to collect programs[] labels (no gating).
        // readCompactU16 returns {value:0, offset} silently past end-of-buffer
        // (R3 case), and partial value with `terminated:false` mid-varint
        // (R4 case — e.g. `[0x80]` byte at end). BOTH must fail closed.
        const legacyInstOffsetBefore = offset;
        const legacyNumInstructions = readCompactU16(txBuf, offset);
        if (legacyNumInstructions.offset === legacyInstOffsetBefore) {
            return { valid: false, error: 'Legacy: instruction count truncated.', programs };
        }
        if (!legacyNumInstructions.terminated) {
            return { valid: false, error: 'Legacy: instruction count truncated mid-varint.', programs };
        }
        offset = legacyNumInstructions.offset;
        for (let i = 0; i < legacyNumInstructions.value; i++) {
            // Truncated-buffer guard (PR #397 R2): txBuf[offset] past end is
            // undefined, which compares as NaN and slips past any bounds check.
            if (offset >= txBuf.length) {
                return { valid: false, error: `Instruction ${i}: truncated tx.`, programs };
            }
            const programIdIdx = txBuf[offset]; offset++;
            if (programIdIdx >= legacyAccountKeys.length) {
                return { valid: false, error: `Instruction ${i} references invalid account index ${programIdIdx} (only ${legacyAccountKeys.length} accounts).`, programs };
            }
            labelProgram(legacyAccountKeys[programIdIdx]);
            const numAcctIdx = readCompactU16(txBuf, offset);
            offset = numAcctIdx.offset;
            if (offset + numAcctIdx.value > txBuf.length) {
                return { valid: false, error: `Instruction ${i}: account indexes truncated.`, programs };
            }
            offset += numAcctIdx.value;
            const dataLen = readCompactU16(txBuf, offset);
            offset = dataLen.offset;
            if (offset + dataLen.value > txBuf.length) {
                return { valid: false, error: `Instruction ${i}: data bytes truncated.`, programs };
            }
            offset += dataLen.value;
        }

        return { valid: true, programs };
    }

    // V0 transaction — skip prefix byte.
    offset++;

    // Message header: numRequired, numReadonlySigned, numReadonlyUnsigned.
    if (offset + 3 > txBuf.length) {
        return { valid: false, error: 'v0: 3-byte message header truncated.', programs };
    }
    // C10 + Q2 (BAT-1013-followup): enforce header invariants up-front. The
    // Math.min(numRequired, accountKeys.length) clamp further down used to
    // silently truncate a tx whose numRequired exceeded its accounts — letting
    // structurally invalid messages slip through signer-set verification.
    // We enforce protocol invariants (count match + numRequired<=accounts)
    // rather than an arbitrary numeric cap.
    const numRequired = txBuf[offset]; offset++;
    const numReadonlySigned = txBuf[offset]; offset++;
    const numReadonlyUnsigned = txBuf[offset]; offset++;
    if (numRequired < 1) {
        return { valid: false, error: `invalid_header: numRequiredSignatures=0 (fee payer must be a signer).`, programs };
    }
    if (numRequired !== numSigs.value) {
        return { valid: false, error: `invalid_header: numRequiredSignatures=${numRequired} does not match signature-section count=${numSigs.value}.`, programs };
    }
    if (numReadonlySigned > numRequired) {
        return { valid: false, error: `invalid_header: numReadonlySigned=${numReadonlySigned} exceeds numRequired=${numRequired}.`, programs };
    }

    // Static account keys.
    const numStaticAccounts = readCompactU16(txBuf, offset);
    offset = numStaticAccounts.offset;
    // R-next-10 same-class sweep: explicit terminated/overflowed check.
    if (!numStaticAccounts.terminated || numStaticAccounts.overflowed) {
        return { valid: false, error: 'tx_unparseable: v0 static account count varint truncated or overflowed.', programs };
    }
    if (numRequired > numStaticAccounts.value) {
        return { valid: false, error: `invalid_header: numRequiredSignatures=${numRequired} exceeds static account key count=${numStaticAccounts.value}.`, programs };
    }
    if (numReadonlySigned + numReadonlyUnsigned > numStaticAccounts.value) {
        return { valid: false, error: `invalid_header: readonly sum (${numReadonlySigned}+${numReadonlyUnsigned}) exceeds static account key count=${numStaticAccounts.value}.`, programs };
    }
    // Buffer-bounds guard (Copilot PR #397 R3): fail closed if declared
    // count exceeds remaining buffer.
    if (offset + numStaticAccounts.value * 32 > txBuf.length) {
        return { valid: false, error: `v0: declared ${numStaticAccounts.value} static account keys exceeds remaining buffer.`, programs };
    }
    const accountKeys = [];
    for (let i = 0; i < numStaticAccounts.value; i++) {
        accountKeys.push(base58Encode(txBuf.slice(offset, offset + 32)));
        offset += 32;
    }

    // Reject zero-account tx (PR #397 R3).
    if (accountKeys.length === 0) {
        return { valid: false, error: 'Transaction has no account keys (cannot verify fee payer)', programs };
    }
    if (!skipPayerCheck) {
        // Default mode: connected wallet is fee payer.
        if (accountKeys[0] !== expectedPayerBase58) {
            return { valid: false, error: `Fee payer mismatch: expected ${expectedPayerBase58}, got ${accountKeys[0]}`, programs };
        }
    } else {
        // Ultra gasless mode: Jupiter pays fees, wallet must still be a required signer.
        // C10 (BAT-1013-followup): the prior Math.min(numRequired, accountKeys.length)
        // clamp silently truncated a malformed tx claiming more signers than it
        // had accounts. The invariant check above (numRequired ≤
        // numStaticAccounts.value) now rejects that shape upfront, so the
        // slice here is structurally safe — no clamp needed.
        const requiredSigners = accountKeys.slice(0, numRequired);
        if (!requiredSigners.includes(expectedPayerBase58)) {
            return { valid: false, error: `Signer mismatch: expected ${expectedPayerBase58} to be among required signers`, programs };
        }
    }

    // Skip recent blockhash (32 bytes). Bounds-check first (PR #397 R3).
    if (offset + 32 > txBuf.length) {
        return { valid: false, error: `v0: blockhash truncated.`, programs };
    }
    offset += 32;

    // Walk instructions to collect programs[] labels. ALT-resolved programs
    // (programIdIdx >= numStaticAccounts) are part of Jupiter's normal v0
    // routing and are NOT rejected as program-id mismatches here — strict
    // ALT program-id resolution lives in wallet/burner-policy.js where we
    // have access to simulation metadata. BUT we still verify that any ALT
    // index actually CAN be satisfied: the message's ALT section (after the
    // instructions) must contribute enough lookup keys to cover the index.
    // Without this, a structurally malformed tx with no ALTs declared but
    // `programIdIdx >> accountKeys.length` was silently accepted (Copilot
    // PR #397 finding).
    // PR #397 R3 + R4: verify varint actually consumed bytes AND was
    // properly terminated (last byte high bit clear).
    const v0InstOffsetBefore = offset;
    const numInstructions = readCompactU16(txBuf, offset);
    if (numInstructions.offset === v0InstOffsetBefore) {
        return { valid: false, error: 'v0: instruction count truncated.', programs };
    }
    if (!numInstructions.terminated) {
        return { valid: false, error: 'v0: instruction count truncated mid-varint.', programs };
    }
    offset = numInstructions.offset;
    const altProgramIndexes = [];
    for (let i = 0; i < numInstructions.value; i++) {
        if (offset >= txBuf.length) {
            return { valid: false, error: `v0 instruction ${i}: truncated tx.`, programs };
        }
        const programIdIdx = txBuf[offset]; offset++;
        if (programIdIdx < accountKeys.length) {
            labelProgram(accountKeys[programIdIdx]);
        } else {
            altProgramIndexes.push(programIdIdx);
            programs.push('alt_resolved(unlabeled)');
        }
        const numAcctIdx = readCompactU16(txBuf, offset);
        offset = numAcctIdx.offset;
        if (offset + numAcctIdx.value > txBuf.length) {
            return { valid: false, error: `v0 instruction ${i}: account indexes truncated.`, programs };
        }
        offset += numAcctIdx.value;
        const dataLen = readCompactU16(txBuf, offset);
        offset = dataLen.offset;
        if (offset + dataLen.value > txBuf.length) {
            return { valid: false, error: `v0 instruction ${i}: data bytes truncated.`, programs };
        }
        offset += dataLen.value;
    }

    // Parse Address Lookup Table section to compute total available keys.
    // Format: compactU16 numAlts, then per ALT:
    //   tableAddress(32) + compactU16 numWritable + writable[] + compactU16 numReadonly + readonly[]
    //
    // Buffer-bounds guards (PR #397 R2/R3): malformed tx claiming huge
    // numWritable/numReadonly without index bytes would silently inflate
    // altKeyCount and let out-of-range programIdIdx slip past.
    // v0 messages REQUIRE the ALT section (Copilot PR #397 R5): even with
    // zero tables, the numAlts compactU16 byte (`0x00`) must exist. A v0
    // tx truncated after the last instruction is malformed.
    if (offset >= txBuf.length) {
        return { valid: false, error: 'v0: ALT section truncated (numAlts byte missing).', programs };
    }
    let altKeyCount = 0;
    {
        const numAlts = readCompactU16(txBuf, offset);
        if (!numAlts.terminated || numAlts.overflowed) {
            return { valid: false, error: 'v0: numAlts varint truncated or overflowed.', programs };
        }
        offset = numAlts.offset;
        for (let a = 0; a < numAlts.value; a++) {
            if (offset + 32 > txBuf.length) {
                return { valid: false, error: `ALT ${a}: table address truncated.`, programs };
            }
            offset += 32; // table address
            const numWritable = readCompactU16(txBuf, offset);
            offset = numWritable.offset;
            if (offset + numWritable.value > txBuf.length) {
                return { valid: false, error: `ALT ${a}: writable indexes exceeds remaining buffer.`, programs };
            }
            offset += numWritable.value;
            altKeyCount += numWritable.value;
            const numReadonly = readCompactU16(txBuf, offset);
            offset = numReadonly.offset;
            if (offset + numReadonly.value > txBuf.length) {
                return { valid: false, error: `ALT ${a}: readonly indexes exceeds remaining buffer.`, programs };
            }
            offset += numReadonly.value;
            altKeyCount += numReadonly.value;
        }
    }

    const totalKeys = accountKeys.length + altKeyCount;
    for (const idx of altProgramIndexes) {
        if (idx >= totalKeys) {
            return {
                valid: false,
                error: `Instruction program index ${idx} exceeds static+ALT key count (${accountKeys.length} static + ${altKeyCount} ALT = ${totalKeys}).`,
                programs,
            };
        }
    }

    return { valid: true, programs };
}

// Read Solana compact-u16 encoding.
// Returns { value, offset, terminated } — `terminated: false` indicates
// buffer ran out mid-varint (last byte read had high bit set). Callers
// MUST check `terminated` for fail-closed parsing (Copilot PR #397 R4).
// Returns { value, offset, terminated, overflowed }. On `!terminated || overflowed`,
// `value` is set to a 0xFFFFFFFF sentinel so downstream bounds checks of the
// shape `offset + value * N > buf.length` reject vacuously, and for-loops
// `for (let i=0; i<value; i++)` hit the per-iter bounds guard immediately.
// (Copilot PR #397 R6: per-call-site checks of overflowed/terminated were
// repeatedly missed; fail-closed at function level is the durable fix.)
function readCompactU16(buf, offset) {
    let value = 0;
    let shift = 0;
    let pos = offset;
    let terminated = false;
    let overflowed = false;
    while (pos < buf.length) {
        const byte = buf[pos]; pos++;
        value = (value | ((byte & 0x7F) << shift)) >>> 0;
        if ((byte & 0x80) === 0) { terminated = true; break; }
        shift += 7;
        if (shift > 14) { overflowed = true; break; }
    }
    if (value > 0xFFFF) overflowed = true;
    if (!terminated || overflowed) {
        return { value: 0xFFFFFFFF, offset: pos, terminated, overflowed };
    }
    return { value, offset: pos, terminated, overflowed };
}

// Jupiter Ultra API — get order (quote + unsigned tx in one call, gasless)
async function jupiterUltraOrder(inputMint, outputMint, amount, taker) {
    if (!config.jupiterApiKey) {
        throw new Error('Jupiter API key required. Get a free key at portal.jup.ag and add it in Settings > Configuration > Jupiter API Key');
    }

    const params = new URLSearchParams({
        inputMint,
        outputMint,
        amount: String(amount),
        taker,
    });

    const headers = {
        'Accept': 'application/json',
        'x-api-key': config.jupiterApiKey
    };

    const res = await jupiterRequest({
        hostname: 'api.jup.ag',
        path: `/ultra/v1/order?${params.toString()}`,
        method: 'GET',
        headers
    });

    if (res.status !== 200) {
        throw new Error(`Jupiter Ultra order failed: ${res.status} - ${JSON.stringify(res.data)}`);
    }
    return res.data;
}

// Jupiter Ultra API — execute signed transaction (Jupiter broadcasts)
async function jupiterUltraExecute(signedTransaction, requestId) {
    if (!config.jupiterApiKey) {
        throw new Error('Jupiter API key required. Get a free key at portal.jup.ag and add it in Settings > Configuration > Jupiter API Key');
    }

    const headers = {
        'Content-Type': 'application/json',
        'Accept': 'application/json',
        'x-api-key': config.jupiterApiKey
    };

    // Execute calls should NOT retry on 429 — the signed tx is time-sensitive
    const res = await httpRequest({
        hostname: 'api.jup.ag',
        path: '/ultra/v1/execute',
        method: 'POST',
        headers
    }, JSON.stringify({
        signedTransaction,
        requestId,
    }));

    if (res.status !== 200) {
        throw new Error(`Jupiter Ultra execute failed: ${res.status} - ${JSON.stringify(res.data)}`);
    }
    return res.data;
}

// Jupiter Trigger API — execute signed transaction
async function jupiterTriggerExecute(signedTransaction, requestId) {
    if (!config.jupiterApiKey) {
        throw new Error('Jupiter API key required. Get a free key at portal.jup.ag and add it in Settings > Configuration > Jupiter API Key');
    }

    const res = await httpRequest({
        hostname: 'api.jup.ag',
        path: '/trigger/v1/execute',
        method: 'POST',
        headers: {
            'Content-Type': 'application/json',
            'Accept': 'application/json',
            'x-api-key': config.jupiterApiKey
        }
    }, JSON.stringify({ signedTransaction, requestId }));

    if (res.status !== 200) {
        throw new Error(`Jupiter Trigger execute failed: ${res.status} - ${JSON.stringify(res.data)}`);
    }
    return res.data;
}

// Jupiter Recurring API — execute signed transaction
async function jupiterRecurringExecute(signedTransaction, requestId) {
    if (!config.jupiterApiKey) {
        throw new Error('Jupiter API key required. Get a free key at portal.jup.ag and add it in Settings > Configuration > Jupiter API Key');
    }

    const res = await httpRequest({
        hostname: 'api.jup.ag',
        path: '/recurring/v1/execute',
        method: 'POST',
        headers: {
            'Content-Type': 'application/json',
            'Accept': 'application/json',
            'x-api-key': config.jupiterApiKey
        }
    }, JSON.stringify({ signedTransaction, requestId }));

    if (res.status !== 200) {
        throw new Error(`Jupiter Recurring execute failed: ${res.status} - ${JSON.stringify(res.data)}`);
    }
    return res.data;
}

// Jupiter Price API v3
async function jupiterPrice(mintAddresses) {
    if (!config.jupiterApiKey) {
        throw new Error('Jupiter API key required. Get a free key at portal.jup.ag and add it in Settings > Configuration > Jupiter API Key');
    }

    const ids = mintAddresses.join(',');
    const headers = {
        'Accept': 'application/json',
        'x-api-key': config.jupiterApiKey
    };

    const res = await jupiterRequest({
        hostname: 'api.jup.ag',
        path: `/price/v3?ids=${encodeURIComponent(ids)}`,
        method: 'GET',
        headers
    });

    if (res.status !== 200) {
        throw new Error(`Jupiter price failed: ${res.status}`);
    }
    return res.data;
}

// ============================================================================
// HELIUS DAS (Digital Asset Standard) API — NFT holdings (BAT-319)
// ============================================================================

async function heliusDasRequest(method, params) {
    if (!config.heliusApiKey) {
        return { error: 'Helius API key not configured' };
    }

    const MAX_ATTEMPTS = 2;
    const BASE_DELAY_MS = 1500;

    const body = JSON.stringify({
        jsonrpc: '2.0',
        id: 1,
        method,
        params,
    });

    for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
        try {
            const res = await httpRequest({
                hostname: 'mainnet.helius-rpc.com',
                path: `/?api-key=${encodeURIComponent(config.heliusApiKey)}`,
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    'Accept': 'application/json',
                },
            }, body);

            if (res.status === 401) {
                return { error: 'Invalid Helius API key — check your key at helius.dev' };
            }

            if (res.status !== 200) {
                let detail = '';
                try {
                    const d = typeof res.data === 'string' ? JSON.parse(res.data) : res.data;
                    detail = d?.error?.message || d?.message || JSON.stringify(d).slice(0, 200);
                } catch (_) { detail = String(res.data || '').slice(0, 200); }
                const errMsg = `Helius DAS HTTP ${res.status}${detail ? ': ' + detail : ''}`;
                const isTransient = res.status >= 500 || res.status === 429;
                if (!isTransient || attempt === MAX_ATTEMPTS) {
                    return { error: errMsg };
                }
                // Fall through to retry
            } else {
                const data = typeof res.data === 'string' ? JSON.parse(res.data) : res.data;
                if (data.error) {
                    return { error: `DAS error: ${data.error.message || JSON.stringify(data.error)}` };
                }
                return data.result;
            }
        } catch (e) {
            const errMsg = String(e.message || e).toLowerCase();
            const isTransient = ['timeout', 'econnreset', 'econnrefused', 'etimedout', 'socket hang up'].some(p => errMsg.includes(p));
            if (!isTransient || attempt === MAX_ATTEMPTS) {
                if (attempt > 1) log(`[Helius DAS] ${method} failed after ${attempt} attempts: ${e.message}`, 'WARN');
                return { error: e.message };
            }
        }

        // Transient failure — retry with jitter
        const delay = BASE_DELAY_MS + Math.random() * 500;
        log(`[Helius DAS] ${method} transient failure (attempt ${attempt}/${MAX_ATTEMPTS}) — retrying in ${Math.round(delay)}ms`, 'WARN');
        await new Promise(r => setTimeout(r, delay));
    }
}

module.exports = {
    solanaRpc,
    solanaRpcOnce,    // BAT-1000: exported for tests/nodejs-project/solana-rpc-url.test.js
    getSolanaRpcUrl,  // BAT-1000: exported for tests + future inspection
    base58Encode,
    buildSolTransferTx,
    refreshJupiterProgramLabels,
    jupiterRequest,
    isValidSolanaAddress,
    parseInputAmountToLamports,
    ensureWalletAuthorized,
    getConnectedWalletAddress,
    resolveToken,
    jupiterQuote,
    verifySwapTransaction,
    jupiterUltraOrder,
    jupiterUltraExecute,
    jupiterTriggerExecute,
    jupiterRecurringExecute,
    jupiterPrice,
    heliusDasRequest,
};
