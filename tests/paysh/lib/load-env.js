// tests/paysh/lib/load-env.js
//
// Loads .env.test for the pay.sh Layer 3 live-pay tests. Checks
// tests/paysh/.env.test FIRST, then falls back to
// tests/jupiter-ultra/.env.test (so the existing funded test wallet
// works without copying files around).
//
// Required keys for Layer 3:
//   BURNER_PUBKEY      — base58 (32 bytes when decoded)
//   BURNER_SECRET_KEY  — JSON array of 64 ints [secret32 || pubkey32]
//   SOLANA_RPC         — mainnet RPC URL
//   MAX_USDC_ATOMIC    — spend cap, integer microunits

'use strict';

const fs = require('fs');
const path = require('path');

const PRIMARY  = path.join(__dirname, '..', '.env.test');
const FALLBACK = path.join(__dirname, '..', '..', 'jupiter-ultra', '.env.test');

function parseEnvFile(content) {
    const out = {};
    for (const line of content.split(/\r?\n/)) {
        const trimmed = line.trim();
        if (!trimmed || trimmed.startsWith('#')) continue;
        const eq = trimmed.indexOf('=');
        if (eq < 0) continue;
        const key = trimmed.slice(0, eq).trim();
        let value = trimmed.slice(eq + 1).trim();
        if ((value.startsWith('"') && value.endsWith('"')) ||
            (value.startsWith("'") && value.endsWith("'"))) {
            value = value.slice(1, -1);
        }
        out[key] = value;
    }
    return out;
}

function load() {
    let envFile = null;
    if (fs.existsSync(PRIMARY)) envFile = PRIMARY;
    else if (fs.existsSync(FALLBACK)) envFile = FALLBACK;

    if (!envFile) {
        console.error('');
        console.error('✗ Missing test env file. Checked:');
        console.error(`    ${PRIMARY}`);
        console.error(`    ${FALLBACK}`);
        console.error('');
        console.error('  Create one with the funded test wallet credentials.');
        console.error('  See tests/jupiter-ultra/.env.test.example for the format.');
        console.error('');
        process.exit(1);
    }

    const env = parseEnvFile(fs.readFileSync(envFile, 'utf8'));
    return { env, file: envFile };
}

const REQUIRED_LIVE = ['BURNER_PUBKEY', 'BURNER_SECRET_KEY', 'SOLANA_RPC', 'MAX_USDC_ATOMIC'];
const REQUIRED_DRYRUN = ['BURNER_PUBKEY', 'SOLANA_RPC'];

function requireKeys(env, mode) {
    const required = mode === 'live' ? REQUIRED_LIVE : REQUIRED_DRYRUN;
    const missing = required.filter(k => !env[k]);
    if (missing.length > 0) {
        console.error('');
        console.error(`✗ Missing required env vars for ${mode} mode: ${missing.join(', ')}`);
        console.error('');
        process.exit(1);
    }
    return env;
}

function parseSecretKey(str) {
    // Accepts the Solana convention: a JSON array of exactly 64 integers
    // [secret 32 bytes || public 32 bytes]. See tests/jupiter-ultra/lib/
    // load-env.js for the validation rationale (silent coercion in
    // Buffer.from on out-of-range values would produce wrong key material).
    str = str.trim();
    if (!str.startsWith('[')) {
        throw new Error('BURNER_SECRET_KEY must be a JSON array of 64 ints in [0,255]');
    }
    const arr = JSON.parse(str);
    if (!Array.isArray(arr) || arr.length !== 64) {
        throw new Error(`BURNER_SECRET_KEY: array must have exactly 64 numbers, got ${arr.length}`);
    }
    for (let i = 0; i < arr.length; i++) {
        const n = arr[i];
        if (!Number.isInteger(n) || n < 0 || n > 255) {
            throw new Error(`BURNER_SECRET_KEY: element ${i}=${n} is not an integer in [0,255]`);
        }
    }
    const buf = Buffer.from(arr);
    return { secret: buf.subarray(0, 32), pubkey: buf.subarray(32, 64) };
}

module.exports = { load, requireKeys, parseSecretKey };
