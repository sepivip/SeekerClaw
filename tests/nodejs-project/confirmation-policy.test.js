#!/usr/bin/env node
// confirmation-policy.test.js — BAT-582 regression-snapshot test.
//
// PURPOSE
// -------
// The Phase 4 confirmation hook MUST preserve v1.0 behavior for every
// existing tool when the burner wallet is unconfigured. This test pins
// that contract.
//
// HISTORY
//   - Phase 1: snapshot was anchored against the live CONFIRM_REQUIRED set
//     in config.js (string-parsing the source).
//   - Phase 4: CONFIRM_REQUIRED was REMOVED from config.js in favor of the
//     dynamic policy hook. The snapshot in confirmation/policy.js
//     (V1_STATIC_CONFIRM) is now the source of truth.
//
// WHAT THIS ASSERTS
// -----------------
//   1. V1_STATIC_CONFIRM matches the documented v1.0 contract — exactly
//      the EXPECTED_V1 tools (no more, no less). Drift here means we either added
//      a v1.0-style "always confirm" tool without updating the snapshot,
//      or removed one without auditing the regression case.
//
//   2. getConfirmationPolicy(toolName, {}, { burnerConfigured: false })
//      returns "confirm" for every tool in V1_STATIC_CONFIRM. This is the
//      v1.0 behavior — Phase 4 replaced the static check in ai.js with this
//      hook and any divergence here would silently change which tools
//      require confirmation.
//
//   3. Hook returns "none" for sample non-confirm tools (wallet_status,
//      memory_save, etc.) when burner is unconfigured.
//
//   4. config.js no longer exports CONFIRM_REQUIRED — guards against
//      accidental re-introduction.
//
//   5. android_sms / android_call are not chat-confirmed (BAT-1409 P1-H).
//
//   6/7. js_eval stays unprompted (BAT-1409 S6, owner decision 2026-10-08):
//      policy "none" in every wallet state, still registered in TOOLS, and
//      its handler runs in scheduled tasks and heartbeat probes. Section 7
//      boots the real config.js against a scratch workDir.
//
// HOW TO RUN
//   node tests/nodejs-project/confirmation-policy.test.js
//
// Exit code 0 = pass, non-zero = fail. Pre-push gate.

'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const BUNDLE = path.resolve(__dirname, '..', '..', 'app', 'src', 'main', 'assets', 'nodejs-project');

// Section 7 loads tools/index.js, which boots the real config.js: give it a scratch workDir first.
const workDir = fs.mkdtempSync(path.join(os.tmpdir(), 'confirm-policy-'));
fs.writeFileSync(path.join(workDir, 'config.json'), JSON.stringify({
    botToken: 'placeholder-not-a-real-bot-token',
    anthropicApiKey: 'placeholder-not-a-real-api-key',
    ownerId: '111',
    channel: 'telegram',
}));
process.argv[2] = workDir;
process.on('exit', () => { try { fs.rmSync(workDir, { recursive: true, force: true }); } catch (_) {} });

const { getConfirmationPolicy, normalizePolicy, V1_STATIC_CONFIRM } = require(
    path.join(BUNDLE, 'confirmation', 'policy')
);

let failures = 0;
function fail(msg) {
    console.error(`FAIL: ${msg}`);
    failures++;
}

// ── 1. Snapshot matches the documented v1.0 contract ────────────────────────
//
// The tools below ARE the v1.0 contract. If you change either side, you
// must update the contract docs (BAT-582 Phase 4 spec — Confirmation policy)
// AND walk through the regression case in your PR description.
//
// BAT-1409 P1-H (owner- and Codex-approved, contract v3.2) removed android_sms and
// android_call ON PURPOSE: they now only put a draft in the phone's notifications, and
// the user taps it and presses Send or Dial in their own app. See section 5 below.
const EXPECTED_V1 = [
    'android_camera_capture',
    'android_location',
    'jupiter_dca_create',
    'jupiter_trigger_create',
    'solana_send',
    'solana_send_token',
    'solana_swap',
];
const snapSorted = Array.from(V1_STATIC_CONFIRM).sort();
if (JSON.stringify(snapSorted) !== JSON.stringify(EXPECTED_V1)) {
    fail(
        'V1_STATIC_CONFIRM does not match the documented v1.0 contract.\n' +
            `  expected: ${JSON.stringify(EXPECTED_V1)}\n` +
            `  actual:   ${JSON.stringify(snapSorted)}\n` +
            '  Fix: update either confirmation/policy.js V1_STATIC_CONFIRM or\n' +
            '  the EXPECTED_V1 list in this test (and the contract docs).'
    );
}

// ── 2. Hook returns "confirm" for every v1.0 tool when burner is unconfigured ─
for (const tool of V1_STATIC_CONFIRM) {
    const result = normalizePolicy(getConfirmationPolicy(tool, {}, { burnerConfigured: false }));
    if (result.policy !== 'confirm') {
        fail(`getConfirmationPolicy("${tool}") returned "${result.policy}", expected "confirm" (no-burner regression case)`);
    }
}

// ── 3. Hook returns "none" for sample non-confirm tools ─────────────────────
const sampleNone = ['memory_save', 'web_search', 'skill_read', 'session_status'];
for (const tool of sampleNone) {
    if (V1_STATIC_CONFIRM.has(tool)) continue;
    const result = normalizePolicy(getConfirmationPolicy(tool, {}, { burnerConfigured: false }));
    if (result.policy !== 'none') {
        fail(`getConfirmationPolicy("${tool}") returned "${result.policy}", expected "none"`);
    }
}

// wallet_status is its own special case (always "none" regardless of state).
{
    const r = normalizePolicy(getConfirmationPolicy('wallet_status', {}, { burnerConfigured: true }));
    assert.strictEqual(r.policy, 'none', 'wallet_status must always be "none"');
}

// ── 5. Drafts are not chat-confirmed: the user already confirms twice on the phone ─
// Decision record (BAT-1409 P1-H): a draft sends nothing by itself — the user must tap the
// notification, then press Send or Dial in their own app — so a chat YES would be a third
// confirmation. Their rate limit is kept separately (tool-rate-limit.js RATE_LIMITED_WITHOUT_CONFIRM,
// pinned by draft-outcomes.test.js), and so is the refusal in unattended turns (tools/android.js). Re-adding them here needs a new owner decision, not a test edit.
for (const tool of ['android_sms', 'android_call']) {
    for (const walletState of [{ burnerConfigured: false }, { burnerConfigured: true }]) {
        const r = normalizePolicy(getConfirmationPolicy(tool, { phone: '+15551234567', message: 'hi' }, walletState));
        if (r.policy !== 'none') {
            fail(`drafts_are_not_chat_confirmed_because_the_user_taps_send_or_dial: getConfirmationPolicy("${tool}") returned "${r.policy}" (burnerConfigured=${walletState.burnerConfigured}), expected "none"`);
        }
    }
}

// ── 4. config.js no longer exports CONFIRM_REQUIRED (guard against regress) ─
const configSrc = fs.readFileSync(path.join(BUNDLE, 'config.js'), 'utf8');
// Match a literal `const CONFIRM_REQUIRED = new Set([...])` block.
// Any active definition (uncommented) would re-introduce static behavior.
// Comments mentioning CONFIRM_REQUIRED are fine.
if (/^\s*const\s+CONFIRM_REQUIRED\s*=\s*new\s+Set/m.test(configSrc)) {
    fail(
        'config.js re-introduced `const CONFIRM_REQUIRED = new Set(...)`.\n' +
            '  BAT-582 Phase 4 removed this in favor of confirmation/policy.js\'s\n' +
            '  dynamic hook. If you need a new "always-confirm" tool, add it to\n' +
            '  V1_STATIC_CONFIRM in confirmation/policy.js instead.'
    );
}

// ── 6. js_eval is never chat-confirmed, in any wallet state ────────────────
// Decision record (BAT-1409 S6, owner decision 2026-10-08, accepted by Codex the same day): js_eval
// stays WITHOUT per-run approval (P1-N was dropped), behind P1-F (workspace-only fs, built-in
// modules, no links) and P1-L (no bridge ports). The owner accepted the residual vm-escape risk
// (S6′) until Phase 2. Prompting for js_eval here needs a new owner decision, not a test edit.
const JS_EVAL_DECISION = 'js_eval_stays_unprompted_owner_decision_2026_10_08';
const JS_EVAL_WALLET_STATES = [
    ['{}', {}],
    ['burnerConfigured:true', { burnerConfigured: true }],
    ['burnerConfigured:false', { burnerConfigured: false }],
    ['burner over cap', {
        burnerConfigured: true,
        routingDecision: 'burner',
        underCap: false,
        burnerCaps: { capPerTxSol: '100000000', capDailySol: '100000000', capPerTxUsdc: '1000000', capDailyUsdc: '1000000' },
        burnerSpentToday: { sol: '100000000', usdc: '1000000' },
    }],
];
for (const [label, walletState] of JS_EVAL_WALLET_STATES) {
    const r = normalizePolicy(getConfirmationPolicy('js_eval', { code: '1' }, walletState));
    if (r.policy !== 'none') {
        fail(`${JS_EVAL_DECISION}: getConfirmationPolicy("js_eval") returned "${r.policy}" for wallet state ${label}, expected "none"`);
    }
}
// The over-cap fixture really is an over-cap state: a burner write tool is blocked in it.
if (normalizePolicy(getConfirmationPolicy('solana_send', { amount: 1 }, JS_EVAL_WALLET_STATES[3][1])).policy !== 'block') {
    fail(`${JS_EVAL_DECISION}: fixture: the "burner over cap" state does not block solana_send, so it is not over cap`);
}

(async () => {
    // ── 7. js_eval stays registered and runs in scheduled tasks and heartbeat probes ─
    const { TOOLS } = require(path.join(BUNDLE, 'tools', 'index.js'));
    if (!TOOLS.some((t) => t.name === 'js_eval')) {
        fail(`${JS_EVAL_DECISION}: tools/index.js TOOLS no longer contains js_eval`);
    }
    const sys = require(path.join(BUNDLE, 'tools', 'system.js'));
    for (const chatId of ['cron:job-1', '__heartbeat__']) {
        const r = await sys.handlers.js_eval({ code: 'return 1+1' }, chatId);
        if (!r || r.success !== true || r.result !== '2') {
            fail(`${JS_EVAL_DECISION}: js_eval in ${chatId} returned ${JSON.stringify(r)}, expected { success: true, result: "2" }`);
        }
    }
    // Negative control: the same chat ids are unattended turns to the app — a draft tool refuses
    // them (tools/android.js) — so js_eval running there is the decision, not an untested path.
    const android = require(path.join(BUNDLE, 'tools', 'android.js'));
    for (const chatId of ['cron:x', '__heartbeat__']) {
        const r = await android.handlers.android_sms({ phone: '+15551234567', message: 'hi' }, chatId);
        if (!r || r.outcome !== 'unattended') {
            fail(`${JS_EVAL_DECISION}: negative control: android_sms in ${chatId} returned ${JSON.stringify(r)}, expected outcome "unattended"`);
        }
    }

    if (failures > 0) {
        console.error(`\n${failures} failure(s).`);
        process.exit(1);
    }
    console.log(`PASS: confirmation policy regression snapshot (${V1_STATIC_CONFIRM.size} tools, no-burner branch verified, config.js clean, js_eval unprompted in ${JS_EVAL_WALLET_STATES.length} wallet states and in cron/heartbeat turns).`);
})().catch((e) => {
    console.error('FAIL: ' + (e && e.stack ? e.stack : e));
    process.exit(1);
});
