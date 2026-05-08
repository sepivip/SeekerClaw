#!/usr/bin/env node
// confirmation-policy-burner.test.js — BAT-582 Phase 4.
//
// Tests the burner-aware branches of confirmation/policy.js's
// getConfirmationPolicy. Companion to confirmation-policy.test.js, which
// pins the no-burner regression case.

'use strict';

const assert = require('assert');
const path = require('path');

const BUNDLE = path.resolve(__dirname, '..', '..', 'app', 'src', 'main', 'assets', 'nodejs-project');

const {
    getConfirmationPolicy,
    normalizePolicy,
} = require(path.join(BUNDLE, 'confirmation', 'policy'));

let failures = 0;
function fail(msg) {
    console.error(`FAIL: ${msg}`);
    failures++;
}
function expect(toolName, args, walletState, expectedPolicy, label) {
    const r = normalizePolicy(getConfirmationPolicy(toolName, args, walletState));
    if (r.policy !== expectedPolicy) {
        fail(`[${label}] ${toolName} → "${r.policy}" (expected "${expectedPolicy}"). full: ${JSON.stringify(r)}`);
    }
    return r;
}

// ── wallet_status — always "none" ──────────────────────────────────────────
expect('wallet_status', {}, {}, 'none', 'wallet_status, no state');
expect('wallet_status', {}, { burnerConfigured: true }, 'none', 'wallet_status, burner configured');
expect('wallet_status', {}, { burnerConfigured: false }, 'none', 'wallet_status, burner unconfigured');

// ── wallet_set_caps — always "confirm" with diff message ────────────────────
{
    const r = expect(
        'wallet_set_caps',
        { per_tx_sol: '0.10' },
        { burnerConfigured: true, burnerCaps: { capPerTxSol: '50000000' } },
        'confirm',
        'wallet_set_caps, raise per_tx_sol'
    );
    if (!r.message || !r.message.includes('per-tx SOL')) {
        fail(`wallet_set_caps confirm message missing 'per-tx SOL' label: ${r.message}`);
    }
    if (!r.message.includes('0.05') || !r.message.includes('0.10')) {
        fail(`wallet_set_caps confirm message missing 0.05 → 0.10 diff: ${r.message}`);
    }
}
// Lower also confirms.
expect(
    'wallet_set_caps',
    { daily_usdc: '5' },
    { burnerConfigured: true, burnerCaps: { capDailyUsdc: '20000000' } },
    'confirm',
    'wallet_set_caps, lower daily_usdc'
);

// ── solana_send routing matrix ─────────────────────────────────────────────

// burner not configured → confirm (regression to v1.0)
expect(
    'solana_send',
    { to: 'X', amount: '0.001' },
    { burnerConfigured: false },
    'confirm',
    'solana_send, burner unconfigured'
);

// burner + under cap → none
expect(
    'solana_send',
    { to: 'X', amount: '0.001' },
    { burnerConfigured: true, routingDecision: 'burner', underCap: true },
    'none',
    'solana_send, burner under cap'
);

// burner + over cap, no fallback flag → block
{
    const r = expect(
        'solana_send',
        { to: 'X', amount: '10' },
        { burnerConfigured: true, routingDecision: 'burner', underCap: false },
        'block',
        'solana_send, burner over cap, no fallback'
    );
    assert.ok(r.reason && r.reason.length > 0, 'block result must include reason');
    assert.ok(r.message && r.message.length > 0, 'block result must include message');
}

// burner + over cap + _allowMainFallback → confirm (main path)
expect(
    'solana_send',
    { to: 'X', amount: '10', _allowMainFallback: true },
    { burnerConfigured: true, routingDecision: 'burner', underCap: false },
    'confirm',
    'solana_send, burner over cap + _allowMainFallback'
);

// routing=main → confirm
expect(
    'solana_send',
    { to: 'X', amount: '10' },
    { burnerConfigured: true, routingDecision: 'main', underCap: true },
    'confirm',
    'solana_send, routing=main'
);

// ── solana_swap, jupiter_trigger_create, jupiter_dca_create — same matrix ──
for (const tool of ['solana_swap', 'jupiter_trigger_create', 'jupiter_dca_create']) {
    expect(tool, {}, { burnerConfigured: true, routingDecision: 'burner', underCap: true }, 'none', `${tool}, burner under cap`);
    expect(tool, {}, { burnerConfigured: true, routingDecision: 'burner', underCap: false }, 'block', `${tool}, burner over cap`);
    expect(tool, {}, { burnerConfigured: true, routingDecision: 'main',   underCap: true }, 'confirm', `${tool}, main routing`);
    expect(tool, {}, { burnerConfigured: false }, 'confirm', `${tool}, no burner`);
}

// ── agent_pay ──────────────────────────────────────────────────────────────

// max_usdc provided → none (Phase 4 just authorizes; demand check is Phase 6)
expect(
    'agent_pay',
    { url: 'https://pay.sh/x', max_usdc: '0.10' },
    { burnerConfigured: true },
    'none',
    'agent_pay, max_usdc provided'
);
// max_usdc missing → block
{
    const r = expect(
        'agent_pay',
        { url: 'https://pay.sh/x' },
        { burnerConfigured: true },
        'block',
        'agent_pay, max_usdc missing'
    );
    assert.ok(/max_usdc/.test(r.message), `agent_pay block message should mention max_usdc: ${r.message}`);
}

// ── Jupiter cancel — routes by creator role ────────────────────────────────
expect('jupiter_trigger_cancel', { orderId: 'X' }, { creatorRole: 'burner' }, 'none', 'jupiter_trigger_cancel, burner-created');
expect('jupiter_trigger_cancel', { orderId: 'X' }, { creatorRole: 'main' }, 'confirm', 'jupiter_trigger_cancel, main-created');
expect('jupiter_trigger_cancel', { orderId: 'X' }, { creatorRole: 'unknown' }, 'confirm', 'jupiter_trigger_cancel, unknown');
expect('jupiter_trigger_cancel', { orderId: 'X' }, {}, 'confirm', 'jupiter_trigger_cancel, missing creatorRole');

expect('jupiter_dca_cancel', { orderId: 'Y' }, { creatorRole: 'burner' }, 'none', 'jupiter_dca_cancel, burner-created');
expect('jupiter_dca_cancel', { orderId: 'Y' }, { creatorRole: 'main' }, 'confirm', 'jupiter_dca_cancel, main-created');

// ── Defensive: missing fields fall back conservatively ─────────────────────
expect(
    'solana_send',
    { to: 'X', amount: '0.001' },
    { burnerConfigured: true /* no routingDecision */ },
    'confirm',
    'solana_send, burner configured but no routing decision (defensive)'
);

if (failures > 0) {
    console.error(`\n${failures} failure(s).`);
    process.exit(1);
}
console.log('PASS: confirmation-policy-burner.test.js (all burner-aware branches verified).');
