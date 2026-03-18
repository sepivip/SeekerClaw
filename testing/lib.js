// Shared helpers for test scripts

const fs = require('fs');
const path = require('path');

const ALL_MODELS = [
    'claude-opus-4-6',
    'claude-sonnet-4-6',
    'claude-sonnet-4-5',
    'claude-haiku-4-5',
];

const CC_BILLING_HEADER = 'x-anthropic-billing-header: cc_version=2.1.78; cc_entrypoint=cli; cch=00000;';

function loadEnv() {
    const envPath = path.join(__dirname, '.env');
    if (!fs.existsSync(envPath)) {
        console.error('❌ .env file not found. Copy .env.example to .env and fill in credentials.');
        process.exit(1);
    }
    const lines = fs.readFileSync(envPath, 'utf8').split('\n');
    for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed || trimmed.startsWith('#')) continue;
        const eq = trimmed.indexOf('=');
        if (eq === -1) continue;
        const key = trimmed.slice(0, eq).trim();
        const val = trimmed.slice(eq + 1).trim();
        if (val) process.env[key] = val;
    }
}

function getModels() {
    const val = (process.env.TEST_MODELS || 'all').trim();
    if (val === 'all') return ALL_MODELS;
    return val.split(',').map(m => m.trim()).filter(Boolean);
}

module.exports = { loadEnv, getModels, ALL_MODELS, CC_BILLING_HEADER };
