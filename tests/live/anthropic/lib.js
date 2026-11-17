// Shared helpers for test scripts

const fs = require('fs');
const path = require('path');

const ALL_MODELS = [
    'claude-fable-5',
    'claude-opus-4-8',
    'claude-opus-4-7',
    'claude-opus-4-6',
    'claude-sonnet-4-6',
    'claude-haiku-4-5',
];

// BAT-1123: mirror of providers/claude.js CC_BILLING_HEADER (cc_version 2.1.195).
const CC_BILLING_HEADER = 'x-anthropic-billing-header: cc_version=2.1.195; cc_entrypoint=cli; cch=00000;';

// Credentials normally come from 1Password through `op run --env-file=tests/live/anthropic/.env.op`
// (BAT-1714), which puts them in the environment. A local .env is still read as a fallback, but it
// never overrides a variable that is already set.
function loadEnv() {
    const envPath = path.join(__dirname, '.env');
    if (!fs.existsSync(envPath)) {
        // Some scripts here (test-provider-cache.js) exercise other providers too.
        const known = ['ANTHROPIC_API_KEY', 'SETUP_TOKEN', 'ANTHROPIC_SETUP_TOKEN', 'OPENAI_API_KEY', 'OPENROUTER_API_KEY', 'CUSTOM_API_KEY'];
        if (known.some((k) => process.env[k])) return;
        console.error('❌ No Anthropic credentials. Run through 1Password:\n'
            + '   op run --env-file=tests/live/anthropic/.env.op -- node <script>\n'
            + '   (or copy .env.example to .env and fill it in).');
        process.exit(1);
    }
    const lines = fs.readFileSync(envPath, 'utf8').split('\n');
    for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed || trimmed.startsWith('#')) continue;
        const eq = trimmed.indexOf('=');
        if (eq === -1) continue;
        const key = trimmed.slice(0, eq).trim();
        let val = trimmed.slice(eq + 1).trim();
        // Strip surrounding quotes (single or double)
        if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) {
            val = val.slice(1, -1);
        }
        if (val && !process.env[key]) process.env[key] = val;
    }
}

function getModels() {
    const val = (process.env.TEST_MODELS || 'all').trim();
    if (val === 'all') return ALL_MODELS;
    return val.split(',').map(m => m.trim()).filter(Boolean);
}

module.exports = { loadEnv, getModels, ALL_MODELS, CC_BILLING_HEADER };
