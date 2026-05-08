// SeekerClaw — confirmation/policy.js
// Dynamic confirmation hook (BAT-582 Phase 4). Replaces the static
// CONFIRM_REQUIRED constant in config.js. Called from ai.js BEFORE every
// tool dispatch.
//
// Returns a string OR an object:
//   "none"                                 → dispatch the tool directly
//   { policy: "confirm", message? }        → run the existing confirmation flow
//   { policy: "block",   reason, message } → do NOT dispatch; return tool error
//
// For backward-compat with the existing ai.js gate (which only knew "is in
// CONFIRM_REQUIRED → confirm, else direct dispatch"), the gate code in ai.js
// branches on a normalized result. The simple string "confirm" / "none" /
// "block" forms are also accepted for terseness.
//
// REGRESSION SAFETY (NON-NEGOTIABLE)
// ----------------------------------
// When walletState.burnerConfigured === false, the hook MUST return the same
// policy as the v1.0 static set for every existing tool. The Phase 1 snapshot
// V1_STATIC_CONFIRM is the canonical record of the v1.0 set. The regression
// test (tests/nodejs-project/confirmation-policy.test.js) verifies this.
//
// CONTRACT MATRIX (BAT-582 v1.4 — "Confirmation policy")
// ------------------------------------------------------
// | tool                         | burner | routing | underCap | policy      |
// | solana_send/swap/Jup-create  | false  | n/a     | n/a      | confirm     |
// | solana_send/swap/Jup-create  | true   | burner  | true     | none        |
// | solana_send/swap/Jup-create  | true   | burner  | false    | block (raise cap or use main) |
// | solana_send/swap/Jup-create  | true   | main    | n/a      | confirm     |
// | jupiter_*_cancel             | any    | per creator-role                | |
// |   creatorRole=burner         |        |                                  | none |
// |   creatorRole=main|unknown   |        |                                  | confirm |
// | wallet_set_caps              | any    | n/a     | n/a      | confirm (with old→new diff) |
// | agent_pay (with max_usdc)    | any    | n/a     | n/a      | none (real demand check happens inside the tool, Phase 6) |
// | wallet_status                | any    | n/a     | n/a      | none        |
// | (any other tool in v1.0 set) | n/a    | n/a     | n/a      | confirm     |

'use strict';

// Mirror of the v1.0 static CONFIRM_REQUIRED set in config.js (line 681 at the
// time of the Phase 1 snapshot). Phase 4 REMOVES the constant from config.js,
// and this set becomes the regression-test source of truth. The pinned
// regression test (tests/nodejs-project/confirmation-policy.test.js) asserts
// that this set still matches the documented v1.0 contract.
//
// IF YOU ADD a tool that should always require confirmation regardless of
// burner state, append it here AND wire the burner-specific override below
// (or accept the v1.0 default of "always confirm").
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

// Tools that participate in burner routing for write actions.
const SOLANA_WRITE_TOOLS = new Set([
    'solana_send',
    'solana_swap',
    'jupiter_trigger_create',
    'jupiter_dca_create',
]);

// Jupiter cancel tools route by creator-role (ownership-gated).
const JUPITER_CANCEL_TOOLS = new Set([
    'jupiter_trigger_cancel',
    'jupiter_dca_cancel',
]);

// ── Helpers for diff messages ────────────────────────────────────────────────

function _atomicToDecimal(atomic, decimals) {
    if (atomic == null) return null;
    let s;
    try { s = BigInt(String(atomic)).toString(); } catch (_) { return String(atomic); }
    if (s === '0') return '0';
    const pad = s.padStart(decimals + 1, '0');
    const head = pad.slice(0, pad.length - decimals);
    const tail = pad.slice(pad.length - decimals).replace(/0+$/, '');
    return tail.length ? `${head}.${tail}` : head;
}

// BAT-582 R10: bound model-controlled input length for parity with the
// other `_decimalToAtomic` clones (caps/preflight.js, tools/agent_pay.js,
// tools/wallet.js). This copy doesn't itself construct a BigInt — it
// returns the digit string for downstream display — but the regex still
// has no length anchor, so a pathological input would burn CPU on the
// regex test alone. 40 chars covers any realistic SOL/USDC value.
const _MAX_DECIMAL_INPUT_LEN = 40;

function _decimalToAtomic(decimal, decimals) {
    if (decimal == null) return null;
    const s = String(decimal).trim();
    if (s.length === 0 || s.length > _MAX_DECIMAL_INPUT_LEN) return null;
    if (!/^[0-9]+(\.[0-9]+)?$/.test(s)) return null;
    const [intPart, fracPart = ''] = s.split('.');
    if (fracPart.length > decimals) return null;
    const padded = fracPart.padEnd(decimals, '0');
    const full = (intPart + padded).replace(/^0+/, '') || '0';
    return full;
}

function _capDiffMessage(args, walletState) {
    // wallet_set_caps args are decimal strings; current caps in walletState are atomic strings.
    const current = (walletState && walletState.burnerCaps) || {};
    const changes = [];
    const ROWS = [
        ['per_tx_sol',  'capPerTxSol',  9, 'per-tx SOL'],
        ['daily_sol',   'capDailySol',  9, 'daily SOL'],
        ['per_tx_usdc', 'capPerTxUsdc', 6, 'per-tx USDC'],
        ['daily_usdc',  'capDailyUsdc', 6, 'daily USDC'],
    ];
    for (const [argKey, capKey, decimals, label] of ROWS) {
        if (args && args[argKey] != null) {
            const newDec = String(args[argKey]);
            const oldAtomic = current[capKey];
            const oldDec = oldAtomic != null ? _atomicToDecimal(oldAtomic, decimals) : '?';
            changes.push(`${label}: ${oldDec} → ${newDec}`);
        }
    }
    if (!changes.length) return 'Update burner wallet caps (no changes provided)';
    return `Update burner caps — ${changes.join('; ')}`;
}

// ── Main hook ────────────────────────────────────────────────────────────────

/**
 * @param {string} toolName
 * @param {object} args - tool input arguments
 * @param {object} walletState - {
 *     burnerConfigured: boolean,
 *     routingDecision?: "burner" | "main",
 *     underCap?: boolean,
 *     creatorRole?: "burner" | "main" | "unknown",
 *     burnerCaps?: object,
 *     burnerSpentToday?: object,
 * }
 * @returns {"none" | {policy: "confirm", message?: string} | {policy: "block", reason: string, message: string}}
 *
 * IMPORTANT: when walletState fields are missing, behave conservatively —
 * fall back to the v1.0 static behavior. This preserves regression safety.
 */
// eslint-disable-next-line no-unused-vars
function getConfirmationPolicy(toolName, args, walletState) {
    const ws = walletState || {};
    const a = args || {};
    const burnerConfigured = ws.burnerConfigured === true;

    // ── Burner-specific overrides (always apply, regardless of v1.0 set) ─────

    // wallet_status is purely informational — never confirm.
    if (toolName === 'wallet_status') {
        return 'none';
    }

    // wallet_set_caps always confirms (raise OR lower) and surfaces a diff.
    if (toolName === 'wallet_set_caps') {
        return {
            policy: 'confirm',
            message: _capDiffMessage(a, ws),
        };
    }

    // agent_pay — Phase 4 authorizes the call when max_usdc is provided.
    // Phase 6 does the real demand-vs-max_usdc check inside the tool itself
    // (Node has no way to know the demand pre-fetch). When max_usdc is
    // missing, block at the gate to fail fast.
    if (toolName === 'agent_pay') {
        if (typeof a.max_usdc !== 'string' && typeof a.max_usdc !== 'number') {
            return {
                policy: 'block',
                reason: 'agent_pay_missing_max_usdc',
                message: 'agent_pay requires a max_usdc cap (decimal string).',
            };
        }
        return 'none';
    }

    // Jupiter cancel tools route by creator-role.
    if (JUPITER_CANCEL_TOOLS.has(toolName)) {
        const role = ws.creatorRole;
        if (role === 'burner') return 'none';
        // main OR unknown OR undefined → confirm (per contract: unknown defaults to main + confirm + diagnostic)
        return { policy: 'confirm' };
    }

    // Solana write tools — burner routing + cap-aware policy.
    if (SOLANA_WRITE_TOOLS.has(toolName)) {
        // Burner not configured → fall through to v1.0 static behavior (always confirm).
        if (!burnerConfigured) {
            return { policy: 'confirm' };
        }
        const routing = ws.routingDecision;

        // Defensive: routing decision missing → conservative confirm.
        if (routing !== 'burner' && routing !== 'main') {
            return { policy: 'confirm' };
        }

        if (routing === 'main') {
            // User-explicit fallback or principal exceeded burner cap and the
            // tool requested main fallback → MWA popup.
            return { policy: 'confirm' };
        }

        // routing === 'burner'
        if (ws.underCap === true) {
            return 'none';
        }
        // Over cap — agent must EITHER raise the cap OR opt into main wallet
        // fallback by passing _allowMainFallback: true (then this branch
        // re-enters with routing='main' and returns confirm).
        if (a._allowMainFallback === true) {
            return { policy: 'confirm' };
        }
        return {
            policy: 'block',
            reason: 'burner_cap_exceeded',
            message:
                'Burner cap exceeded. Raise the cap with wallet_set_caps, ' +
                'or retry with _allowMainFallback: true to use the main wallet (popup required).',
        };
    }

    // ── v1.0 static fallback ────────────────────────────────────────────────
    if (V1_STATIC_CONFIRM.has(toolName)) {
        return { policy: 'confirm' };
    }
    return 'none';
}

/**
 * Normalize the policy result into a uniform { policy, ... } object.
 * Useful for consumers that don't want to branch on string-vs-object.
 */
function normalizePolicy(result) {
    if (typeof result === 'string') return { policy: result };
    return result;
}

module.exports = {
    getConfirmationPolicy,
    normalizePolicy,
    V1_STATIC_CONFIRM,
    SOLANA_WRITE_TOOLS,
    JUPITER_CANCEL_TOOLS,
};
