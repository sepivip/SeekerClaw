// SeekerClaw — caps/preflight.js
// READ-ONLY cap routing. Node never writes cap state — Android is the
// canonical writer (per BAT-582 contract). This module only answers
// "would a reservation of <amount> on <name> succeed RIGHT NOW?" so
// tools can decide whether to route through burner or fall back to MWA.
//
// All cap math is BigInt against atomic-unit strings. No JS Number for
// money anywhere. If /burner/status fails or burner is unconfigured,
// preflight returns wouldAllow=false with a clear reason — the tool
// then falls back to MWA.

'use strict';

const { androidBridgeCall } = require('../bridge');

/**
 * Map a cap-name (like "burner.daily.sol") to the relevant fields in a
 * /burner/status response. Centralized so adding new caps later is one edit.
 */
const CAP_MAP = {
    'burner.pertx.sol':   { capField: 'capPerTxSol',   spentField: null },
    'burner.daily.sol':   { capField: 'capDailySol',   spentField: 'spentTodaySol' },
    'burner.pertx.usdc':  { capField: 'capPerTxUsdc',  spentField: null },
    'burner.daily.usdc':  { capField: 'capDailyUsdc',  spentField: 'spentTodayUsdc' },
};

/**
 * Would reserving `atomicAmount` on `name` succeed if attempted now?
 *
 * @param {string} name - cap name from CAP_MAP
 * @param {string|bigint} atomicAmount - amount in atomic units (lamports / USDC microunits)
 * @returns {Promise<{wouldAllow: boolean, reason?: string}>}
 *
 * NEVER writes cap state. NEVER reserves. Acceptable to be slightly stale —
 * Android is the final gate at /burner/reserve and /burner/sign-* time.
 */
async function wouldReserve(name, atomicAmount) {
    const cap = CAP_MAP[name];
    if (!cap) return { wouldAllow: false, reason: `unknown_cap:${name}` };

    let amt;
    try {
        amt = typeof atomicAmount === 'bigint' ? atomicAmount : BigInt(String(atomicAmount));
    } catch (_) {
        return { wouldAllow: false, reason: 'invalid_atomic_amount' };
    }
    if (amt <= 0n) return { wouldAllow: false, reason: 'non_positive_amount' };

    const status = await androidBridgeCall('/burner/status', {}, 5000);
    if (!status || status.error) {
        return { wouldAllow: false, reason: 'bridge_unreachable' };
    }
    if (!status.configured) {
        return { wouldAllow: false, reason: 'burner_not_configured' };
    }

    let capLimit;
    try {
        capLimit = BigInt(String(status[cap.capField] || '0'));
    } catch (_) {
        return { wouldAllow: false, reason: 'invalid_cap_value' };
    }

    if (amt > capLimit) {
        return { wouldAllow: false, reason: 'over_per_tx_or_window_cap' };
    }

    if (cap.spentField) {
        let spent;
        try {
            spent = BigInt(String(status[cap.spentField] || '0'));
        } catch (_) {
            return { wouldAllow: false, reason: 'invalid_spent_value' };
        }
        if (spent + amt > capLimit) {
            return { wouldAllow: false, reason: 'window_cap_would_be_exceeded' };
        }
    }

    return { wouldAllow: true };
}

module.exports = { wouldReserve, CAP_MAP };
