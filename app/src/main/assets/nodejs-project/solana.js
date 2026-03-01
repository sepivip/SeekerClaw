// SeekerClaw — solana.js
// Solana RPC, base58 encoding, transaction building, Jupiter DEX (tokens, quotes, swaps, prices), wallet management.
// Depends on: config.js, web.js, bridge.js

const https = require('https');
const fs = require('fs');
const path = require('path');

const { config, log, workDir } = require('./config');
const { httpRequest } = require('./web');
const { androidBridgeCall } = require('./bridge');

// ============================================================================
// SOLANA RPC
// ============================================================================

const SOLANA_RPC_URL = 'https://api.mainnet-beta.solana.com';

// Single-shot RPC call (no retry)
async function solanaRpcOnce(method, params = []) {
    return new Promise((resolve) => {
        const postData = JSON.stringify({
            jsonrpc: '2.0',
            id: 1,
            method: method,
            params: params,
        });

        const url = new URL(SOLANA_RPC_URL);
        const options = {
            hostname: url.hostname,
            port: 443,
            path: url.pathname,
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

async function solanaRpc(method, params = []) {
    const MAX_ATTEMPTS = 2;
    const BASE_DELAY_MS = 1500;

    for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
        const result = await solanaRpcOnce(method, params);

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
    const hex = value.toString(16);
    const hexPadded = hex.length % 2 ? '0' + hex : hex;
    const decoded = Buffer.from(hexPadded, 'hex');
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

// Known program names for swap transaction verification.
// Maps program ID → human-readable label. Used for:
//   1. TRUSTED_PROGRAMS whitelist (derived from map keys)
//   2. Labeling unknown programs in error messages
// Initialized with hardcoded fallback, updated dynamically from Jupiter API on startup.
const KNOWN_PROGRAM_NAMES = new Map([
    // === System Programs ===
    ['11111111111111111111111111111111',           'System Program'],
    ['TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA',  'Token Program'],
    ['TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb',  'Token-2022'],
    ['ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL',  'Associated Token'],
    ['ComputeBudget111111111111111111111111111111', 'Compute Budget'],
    // === Jupiter Programs ===
    ['JUP6LkbZbjS1jKKwapdHNy74zcZ3tLUZoi5QNyVTaV4',  'Jupiter v6'],
    ['JUP4Fb2cqiRUcaTHdrPC8h2gNsA2ETXiPDD33WcGuJB',  'Jupiter v4'],
    ['JUP3jqKShLQUCEDeLBpihUwbcTiY7Gg3V1GAbRhhr82',  'Jupiter v3'],
    ['jup6SoC2JQ3FWcz6aKdR6FMWbN4mk2VmC3S7sREqLhw',  'Jupiter Limit Order'],
    ['jupoNjAxXgZ4rjzxzPMP4oxduvQsQtZzyknqvzYNrNu',  'Jupiter DCA'],
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

// Derive trusted programs set from the map (single source of truth)
let TRUSTED_PROGRAMS = new Set(KNOWN_PROGRAM_NAMES.keys());

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
        // Rebuild TRUSTED_PROGRAMS from updated map
        TRUSTED_PROGRAMS = new Set(KNOWN_PROGRAM_NAMES.keys());
        log(`[Jupiter] Program labels refreshed: ${KNOWN_PROGRAM_NAMES.size} total (${added} new from API)`, 'INFO');
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

// Validate Solana wallet address (base58-encoded 32-byte Ed25519 pubkey = 43-44 chars)
function isValidSolanaAddress(address) {
    if (!address || typeof address !== 'string') return false;
    const base58Regex = /^[1-9A-HJ-NP-Za-km-z]{43,44}$/;
    return base58Regex.test(address.trim());
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

// Verify a Jupiter swap transaction before sending to wallet
// Decodes the versioned transaction and checks:
// 1. Fee payer matches user's public key (unless skipPayerCheck is set)
// 2. Only known/trusted programs are referenced
// Options: { skipPayerCheck: true } for Jupiter Ultra (Jupiter pays fees)
function verifySwapTransaction(txBase64, expectedPayerBase58, options = {}) {
    const { skipPayerCheck = false } = options;
    const txBuf = Buffer.from(txBase64, 'base64');

    // TRUSTED_PROGRAMS is module-level (KNOWN_PROGRAM_NAMES-derived, refreshed from Jupiter API)

    // Full serialized transaction: [sig_count] [signatures...] [message]
    // Skip signature section to reach the message
    let offset = 0;
    const numSigs = readCompactU16(txBuf, offset);
    offset = numSigs.offset;
    offset += numSigs.value * 64; // skip signature slots

    // Message starts here — check for v0 prefix (0x80)
    const prefix = txBuf[offset];
    const isV0 = prefix === 0x80;

    if (!isV0) {
        // Legacy transaction — Ultra always uses v0, so reject legacy in gasless mode
        if (skipPayerCheck) {
            return { valid: false, error: 'Expected v0 transaction for Ultra gasless flow, got legacy format' };
        }

        // Legacy message: header (3 bytes) + account keys + blockhash + instructions
        const numRequired = txBuf[offset]; offset++;
        const numReadonlySigned = txBuf[offset]; offset++;
        const numReadonlyUnsigned = txBuf[offset]; offset++;
        const numAccounts = readCompactU16(txBuf, offset);
        offset = numAccounts.offset;

        // Read all account keys
        const legacyAccountKeys = [];
        for (let i = 0; i < numAccounts.value; i++) {
            legacyAccountKeys.push(base58Encode(txBuf.slice(offset, offset + 32)));
            offset += 32;
        }

        // First account is fee payer
        if (legacyAccountKeys.length > 0 && legacyAccountKeys[0] !== expectedPayerBase58) {
            return { valid: false, error: `Fee payer mismatch: expected ${expectedPayerBase58}, got ${legacyAccountKeys[0]}` };
        }

        // BAT-255: Skip blockhash (32 bytes) and verify program whitelist (matches v0 path)
        offset += 32;

        const legacyNumInstructions = readCompactU16(txBuf, offset);
        offset = legacyNumInstructions.offset;

        const legacyUntrusted = [];
        for (let i = 0; i < legacyNumInstructions.value; i++) {
            const programIdIdx = txBuf[offset]; offset++;
            if (programIdIdx >= legacyAccountKeys.length) {
                return { valid: false, error: `Instruction ${i} references invalid account index ${programIdIdx} (only ${legacyAccountKeys.length} accounts). Transaction rejected for safety.` };
            }
            const programId = legacyAccountKeys[programIdIdx];
            if (!TRUSTED_PROGRAMS.has(programId)) {
                legacyUntrusted.push(programId);
            }
            // Skip accounts
            const numAcctIdx = readCompactU16(txBuf, offset);
            offset = numAcctIdx.offset;
            offset += numAcctIdx.value;
            // Skip data
            const dataLen = readCompactU16(txBuf, offset);
            offset = dataLen.offset;
            offset += dataLen.value;
        }

        if (legacyUntrusted.length > 0) {
            const unique = [...new Set(legacyUntrusted)];
            const labeled = unique.map(id => {
                const name = KNOWN_PROGRAM_NAMES.get(id);
                return name ? `${id} (${name})` : id;
            });
            return {
                valid: false,
                error: `Transaction contains unwhitelisted program(s): ${labeled.join(', ')}. ` +
                       `This may be a new routing program not yet in the trusted list.`
            };
        }

        return { valid: true }; // Legacy tx passed payer + program whitelist check
    }

    // V0 transaction format — skip prefix byte
    offset++;

    // Message header: num_required_signatures (1), num_readonly_signed (1), num_readonly_unsigned (1)
    const numRequired = txBuf[offset]; offset++;
    const numReadonlySigned = txBuf[offset]; offset++;
    const numReadonlyUnsigned = txBuf[offset]; offset++;

    // Static account keys
    const numStaticAccounts = readCompactU16(txBuf, offset);
    offset = numStaticAccounts.offset;

    const accountKeys = [];
    for (let i = 0; i < numStaticAccounts.value; i++) {
        accountKeys.push(base58Encode(txBuf.slice(offset, offset + 32)));
        offset += 32;
    }

    if (accountKeys.length > 0) {
        if (!skipPayerCheck) {
            // Standard mode: ensure connected wallet is the fee payer
            if (accountKeys[0] !== expectedPayerBase58) {
                return { valid: false, error: `Fee payer mismatch: expected ${expectedPayerBase58}, got ${accountKeys[0]}` };
            }
        } else {
            // Ultra gasless mode: Jupiter pays fees, but wallet must still be a required signer
            const requiredSignerCount = Math.min(numRequired, accountKeys.length);
            const requiredSigners = accountKeys.slice(0, requiredSignerCount);
            if (!requiredSigners.includes(expectedPayerBase58)) {
                return { valid: false, error: `Signer mismatch: expected ${expectedPayerBase58} to be among required signers` };
            }
        }
    }

    // Check that program IDs in instructions are trusted
    // Recent blockhash (32 bytes)
    offset += 32;

    // Instructions
    const numInstructions = readCompactU16(txBuf, offset);
    offset = numInstructions.offset;

    const untrustedPrograms = [];
    for (let i = 0; i < numInstructions.value; i++) {
        const programIdIdx = txBuf[offset]; offset++;
        if (programIdIdx >= accountKeys.length) {
            // Program referenced via Address Lookup Table — cannot verify identity.
            // Reject for safety (Jupiter Ultra uses static keys anyway).
            return {
                valid: false,
                error: `Instruction ${i} references program via Address Lookup Table (index ${programIdIdx}, ` +
                       `only ${accountKeys.length} static keys). Cannot verify program identity. Transaction rejected for safety.`
            };
        }
        const programId = accountKeys[programIdIdx];
        if (!TRUSTED_PROGRAMS.has(programId)) {
            untrustedPrograms.push(programId);
        }
        // Skip accounts
        const numAcctIdx = readCompactU16(txBuf, offset);
        offset = numAcctIdx.offset;
        offset += numAcctIdx.value;
        // Skip data
        const dataLen = readCompactU16(txBuf, offset);
        offset = dataLen.offset;
        offset += dataLen.value;
    }

    if (untrustedPrograms.length > 0) {
        const unique = [...new Set(untrustedPrograms)];
        const labeled = unique.map(id => {
            const name = KNOWN_PROGRAM_NAMES.get(id);
            return name ? `${id} (${name})` : id;
        });
        return {
            valid: false,
            error: `Transaction contains unwhitelisted program(s): ${labeled.join(', ')}. ` +
                   `This may be a new Jupiter routing program not yet in the trusted list.`
        };
    }

    return { valid: true };
}

// Read Solana compact-u16 encoding
function readCompactU16(buf, offset) {
    let value = 0;
    let shift = 0;
    let pos = offset;
    while (pos < buf.length) {
        const byte = buf[pos]; pos++;
        value |= (byte & 0x7F) << shift;
        if ((byte & 0x80) === 0) break;
        shift += 7;
    }
    return { value, offset: pos };
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

module.exports = {
    solanaRpc,
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
};
