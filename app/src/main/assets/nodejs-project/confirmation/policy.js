// SeekerClaw — confirmation/policy.js
// Dynamic confirmation hook (BAT-582). Replaces the static CONFIRM_REQUIRED
// constant in config.js. Called from ai.js BEFORE tool dispatch.
//
// Returns one of: "none" | "confirm" | "block"
//
// Regression safety: when walletState.burnerConfigured === false, this hook
// MUST return the exact same policy as the v1.0 static set for every existing
// tool. Phase 4 wires the hook + adds a regression snapshot test that
// compares hook output against the original CONFIRM_REQUIRED set entry-by-entry.

'use strict';

// Mirror of the v1.0 static CONFIRM_REQUIRED set in config.js (line 681 at
// the time of this snapshot). Kept here as the regression source-of-truth —
// Phase 4 will REMOVE the constant from config.js, and this set becomes the
// regression-test snapshot. The pinned regression test
// (tests/nodejs-project/confirmation-policy.test.js) compares this set to
// the live config.js set and fails if drift; updates to either MUST be
// reflected in both.
const V1_STATIC_CONFIRM = new Set([
    'android_sms',
    'android_call',
    'android_camera_capture',
    'android_location',
    'solana_send',
    'solana_swap',
    'jupiter_trigger_create',
    'jupiter_dca_create',
]);

/**
 * @param {string} toolName
 * @param {object} args - tool arguments (used for amount + role decisions)
 * @param {object} walletState - { burnerConfigured: bool, burnerCaps?: object, burnerSpentToday?: object }
 * @returns {"none" | "confirm" | "block"}
 *
 * Phase 1: returns the v1.0 static behavior unconditionally — burner-aware
 * branches land in Phase 4. This keeps Phase 1 a pure structural change
 * with zero behavior delta.
 */
// eslint-disable-next-line no-unused-vars
function getConfirmationPolicy(toolName, args, walletState) {
    // Phase 1 stub: equivalent to v1.0 static set. Phase 4 adds:
    //   - burner under cap → "none"
    //   - burner over cap → "block" with reason
    //   - main wallet → "confirm" (preserves current behavior even when burner exists)
    //   - wallet_set_caps → "confirm" with diff
    //   - agent_pay (under max_usdc) → "none"
    if (V1_STATIC_CONFIRM.has(toolName)) return 'confirm';
    return 'none';
}

module.exports = { getConfirmationPolicy, V1_STATIC_CONFIRM };
