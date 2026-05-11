// tests/jupiter-ultra/lib/load-env.js
//
// Loads .env.test from this directory. No external deps — minimal parser
// (KEY=VALUE per line, # comments, blank lines). Validates required keys
// per layer and exits with a clear error if missing.

'use strict';

const fs = require('fs');
const path = require('path');

const ENV_FILE = path.join(__dirname, '..', '.env.test');

function parseEnvFile(content) {
    const out = {};
    for (const line of content.split(/\r?\n/)) {
        const trimmed = line.trim();
        if (!trimmed || trimmed.startsWith('#')) continue;
        const eq = trimmed.indexOf('=');
        if (eq < 0) continue;
        const key = trimmed.slice(0, eq).trim();
        let value = trimmed.slice(eq + 1).trim();
        // Strip surrounding quotes if present
        if ((value.startsWith('"') && value.endsWith('"')) ||
            (value.startsWith("'") && value.endsWith("'"))) {
            value = value.slice(1, -1);
        }
        out[key] = value;
    }
    return out;
}

function load() {
    if (!fs.existsSync(ENV_FILE)) {
        console.error('');
        console.error(`✗ Missing ${ENV_FILE}`);
        console.error('');
        console.error('  Copy env.test.example to .env.test and fill in your secrets:');
        console.error('  cp tests/jupiter-ultra/env.test.example tests/jupiter-ultra/.env.test');
        console.error('');
        process.exit(1);
    }
    const raw = fs.readFileSync(ENV_FILE, 'utf8');
    return parseEnvFile(raw);
}

const REQUIRED = {
    probe:        ['JUPITER_API_KEY', 'SOLANA_RPC', 'BURNER_PUBKEY'],
    threshold:    ['JUPITER_API_KEY', 'SOLANA_RPC', 'BURNER_PUBKEY'],
    signExecute:  ['JUPITER_API_KEY', 'SOLANA_RPC', 'BURNER_PUBKEY', 'BURNER_SECRET_KEY'],
    x402:         ['JUPITER_API_KEY', 'SOLANA_RPC', 'BURNER_PUBKEY', 'BURNER_SECRET_KEY', 'PAYSH_TEST_URL'],
};

function requireKeys(env, layer) {
    const required = REQUIRED[layer];
    if (!required) throw new Error(`unknown layer: ${layer}`);
    const missing = required.filter(k => !env[k]);
    if (missing.length > 0) {
        console.error('');
        console.error(`✗ Missing required env vars for layer "${layer}": ${missing.join(', ')}`);
        console.error(`  Edit ${ENV_FILE} and fill them in.`);
        console.error('');
        process.exit(1);
    }
    return env;
}

function parseSecretKey(str) {
    // Accepts the Solana convention: a JSON array of exactly 64 integers
    // [secret 32 bytes || public 32 bytes]. Base58 input is NOT supported
    // here — generate-wallet.js emits the JSON-array form, which is what
    // every Solana CLI and SDK round-trips natively.
    str = str.trim();
    if (str.startsWith('[')) {
        const arr = JSON.parse(str);
        if (!Array.isArray(arr) || arr.length !== 64) {
            throw new Error(`BURNER_SECRET_KEY: JSON array must have exactly 64 numbers, got ${arr.length}`);
        }
        // Buffer.from(arr) silently coerces out-of-range values (e.g. -1
        // becomes 255, 999 becomes 231 via mod 256), which would produce
        // the WRONG key material without any error — and an Ed25519
        // signature with a wrong key produces a perfectly valid-looking
        // signature against a different pubkey, so the failure surfaces
        // way downstream as "tx signed by unexpected wallet" or "Ultra
        // /execute rejected: signature invalid". Validate up front.
        for (let i = 0; i < arr.length; i++) {
            const n = arr[i];
            if (!Number.isInteger(n) || n < 0 || n > 255) {
                throw new Error(`BURNER_SECRET_KEY: element ${i} = ${n} is not an integer in [0,255]`);
            }
        }
        const buf = Buffer.from(arr);
        return { secret: buf.subarray(0, 32), pubkey: buf.subarray(32, 64) };
    }
    throw new Error('BURNER_SECRET_KEY must be a JSON array of 64 integers in [0,255], e.g. [1,2,3,...] — base58 is not supported here; run lib/generate-wallet.js for the correct format');
}

module.exports = { load, requireKeys, parseSecretKey };
