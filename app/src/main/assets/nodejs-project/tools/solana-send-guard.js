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

// Fiat denomination set — a broad sweep of circulating ISO-4217 codes across
// major economies, kept LOCAL (dependency-free, no currency-data package) per
// Codex. This set picks the fiat-specific guidance message; it does NOT need to
// be exhaustive. An unlisted code falls through to the 'other' branch, which is
// still a CORRECT "solana_send is native-SOL-only" rejection — just worded for
// SPL tokens rather than fiat. Both outcomes refuse the send; only the guidance
// text differs, so the fall-through is harmless, never unsafe.
const SOL_FIAT_SET = new Set([
    // Majors
    'usd', 'eur', 'gbp', 'jpy', 'cny', 'cad', 'aud', 'chf', 'nzd',
    // Europe / CIS
    'nok', 'sek', 'dkk', 'pln', 'czk', 'huf', 'ron', 'bgn', 'isk', 'try', 'rub', 'uah',
    // Middle East
    'aed', 'sar', 'qar', 'kwd', 'bhd', 'omr', 'jod', 'ils', 'egp',
    // Asia-Pacific
    'inr', 'krw', 'sgd', 'hkd', 'twd', 'thb', 'idr', 'myr', 'php', 'vnd', 'pkr', 'bdt', 'lkr', 'npr',
    // Africa
    'zar', 'ngn', 'kes', 'ghs', 'mad', 'tnd', 'dzd',
    // Americas
    'mxn', 'brl', 'clp', 'cop', 'ars', 'pen', 'uyu',
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
                reason: 'solana_send only sends native SOL. To send an SPL token (USDC, BONK, …), '
                    + 'use the solana_send_token tool instead — pass the token `mint` + `amount`. '
                    + '(If solana_send_token cannot route it — e.g. a Token-2022 mint — send it from '
                    + 'your wallet app / main wallet manually.)',
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
