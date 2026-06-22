// tools/solana-send-guard.js
//
// BAT-1037: solana_send native-SOL-only denomination guard.
//
// solana_send sends NATIVE SOL only. This guard rejects any args that
// denominate the transfer in an SPL token or a fiat currency BEFORE any
// routing / tx build, so a wrong-asset request fails fast with actionable
// guidance and zero downstream side effects.
//
// It inspects EVERY denomination hint — a SOL-valued earlier key must NOT
// suppress a contradictory later key (the v3 break-bypass) — then decides by
// deterministic precedence: other > fiat > sol.
//
// Pure + dependency-free (no config / bridge / RPC), so it loads in a bare-node
// unit test. The supplied value is NEVER returned for logging — only the field
// name — so an attacker-/typo-supplied token string can't leak into logs.

'use strict';

const SOL_DENOM_KEYS = ['token', 'mint', 'asset', 'symbol', 'currency', 'coin', 'denom'];

// Local fiat set (kept local to this PR per Codex). ISO-4217 codes the agent is
// most likely to emit when a user phrases an amount in money.
const SOL_FIAT_SET = new Set([
    'usd', 'eur', 'gbp', 'jpy', 'cny', 'cad', 'aud', 'chf', 'inr', 'krw',
    'mxn', 'brl', 'sgd', 'hkd', 'nok', 'sek', 'dkk', 'nzd', 'zar', 'aed',
]);

// Native-SOL forms ONLY: plain 'sol' + the internal 'native_sol' marker. The
// wrapped-SOL mint So111…112 is an SPL token (solana_send moves native
// lamports), so it correctly classifies as 'other' → solana_send_sol_only.
function solDenomClass(v) {
    const s = String(v).trim().toLowerCase();
    if (s === 'sol' || s === 'native_sol') return 'sol';
    if (SOL_FIAT_SET.has(s)) return 'fiat';
    return 'other';
}

// Returns { field, error, reason } to reject, or null to proceed. `field` is for
// forensic logging only; the supplied value is never included.
function classifySolSendDenomination(input) {
    if (!input || typeof input !== 'object') return null;
    let sawFiat = false;
    let fiatField = null;
    for (const key of SOL_DENOM_KEYS) {
        const v = input[key];
        if (v == null || String(v).trim() === '') continue;
        const cls = solDenomClass(v);
        if (cls === 'other') {
            // 'other' (a concrete SPL / wSOL-mint / wrong-symbol token) dominates
            // fiat and sol regardless of key order, so the outcome is order-invariant.
            return {
                field: key,
                error: 'solana_send_sol_only',
                reason: 'solana_send only sends native SOL. SeekerClaw cannot send SPL tokens directly yet — '
                    + 'send the token from your wallet app / main wallet manually. '
                    + '(When solana_send_token ships it will handle this.)',
            };
        }
        if (cls === 'fiat' && !sawFiat) { sawFiat = true; fiatField = key; }
        // 'sol' → continue (never suppresses a later contradictory key)
    }
    if (sawFiat) {
        return {
            field: fiatField,
            error: 'solana_send_fiat_denomination',
            reason: 'solana_send takes a SOL amount. For USD, use solana_price to get the SOL/USD price and '
                + 'compute the SOL amount. For non-USD currencies, convert to USD (or supply SOL) first — '
                + 'solana_price does not perform currency conversion.',
        };
    }
    return null;
}

module.exports = {
    SOL_DENOM_KEYS,
    SOL_FIAT_SET,
    solDenomClass,
    classifySolSendDenomination,
};
