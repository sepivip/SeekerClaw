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
 * @param {object} [statusOverride] - optional pre-fetched /burner/status payload
 *   (BAT-582 R3). When provided, skips the bridge round-trip and uses this
 *   object directly. Caller is responsible for passing a fresh status — do
 *   NOT cache across event-loop ticks. Falls back to a live bridge fetch
 *   when omitted, preserving existing call sites (agent_pay.js etc.).
 * @returns {Promise<{wouldAllow: boolean, reason?: string}>}
 *
 * NEVER writes cap state. NEVER reserves. Acceptable to be slightly stale —
 * Android is the final gate at /burner/reserve and /burner/sign-* time.
 *
 * BAT-582 Phase 5: an atomicAmount of 0 is allowed and short-circuits to
 * wouldAllow=true after burner-configured check. Cancels (jupiter_*_cancel)
 * are ownership-gated, do NOT consume principal, and route through the
 * burner without reserving. Negative amounts are still rejected.
 */
async function wouldReserve(name, atomicAmount, statusOverride) {
    const cap = CAP_MAP[name];
    if (!cap) return { wouldAllow: false, reason: `unknown_cap:${name}` };

    let amt;
    try {
        amt = typeof atomicAmount === 'bigint' ? atomicAmount : BigInt(String(atomicAmount));
    } catch (_) {
        return { wouldAllow: false, reason: 'invalid_atomic_amount' };
    }
    if (amt < 0n) return { wouldAllow: false, reason: 'negative_amount' };

    // BAT-582 R3: hot-path optimization. getWalletState() reads /burner/status
    // ONCE per dispatch and threads the result down through routeFor → here.
    // When `statusOverride` is provided we skip the bridge call; otherwise
    // we fetch live (preserves direct callers like agent_pay.js).
    async function fetchStatus() {
        if (statusOverride !== undefined) return statusOverride;
        try {
            return await androidBridgeCall('/burner/status', {}, 5000);
        } catch (_) {
            return null;
        }
    }

    // BAT-582 Phase 5: zero-amount path for cancels. Still verifies burner is
    // configured (so the cancel can route to a real burner), but skips per-tx
    // and daily window math. The Android side similarly skips reserve for
    // amount=0 (handled in the cancel dispatch path — see wallet/dispatch.js).
    if (amt === 0n) {
        const status = await fetchStatus();
        if (!status || status.error) {
            return { wouldAllow: false, reason: 'bridge_unreachable' };
        }
        if (!status.configured) {
            return { wouldAllow: false, reason: 'burner_not_configured' };
        }
        return { wouldAllow: true };
    }

    const status = await fetchStatus();
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

// ── routeFor — wallet routing decision for write tools ───────────────────────

// Currency hint: which atomic-unit decimals + cap-name pair to use given a
// token and a tool. SOL and USDC are the only V1 cap dimensions.
const SOL_DECIMALS = 9;
const USDC_DECIMALS = 6;
const USDC_MINT = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v';

function _isSol(tokenSymbolOrMint) {
    if (!tokenSymbolOrMint) return false;
    const s = String(tokenSymbolOrMint).trim().toLowerCase();
    return s === 'sol' || s === 'so11111111111111111111111111111111111111112';
}

function _isUsdc(tokenSymbolOrMint) {
    if (!tokenSymbolOrMint) return false;
    const s = String(tokenSymbolOrMint).trim();
    return s.toLowerCase() === 'usdc' || s === USDC_MINT;
}

// BAT-582 R10: maximum total length for a decimal-string monetary input.
// V8's BigInt construction is O(n²) in digit count. SOL has 9 decimals
// and USDC has 6; even 1 trillion SOL is 22 lamport digits, so 40 chars
// total (int + '.' + frac) covers any realistic monetary value while
// rejecting a 10MB DoS payload. The regex pre-check has no length anchor
// of its own, so we MUST bound here BEFORE it runs to avoid
// catastrophic-backtracking-class behavior on degenerate inputs.
const _MAX_DECIMAL_INPUT_LEN = 40;

function _decimalToAtomic(decimal, decimals) {
    if (decimal == null) return null;
    const s = String(decimal).trim();
    // BAT-582 R10: cap input length BEFORE the regex + BigInt() pipeline.
    // Tool args are model-controlled — without this gate a pathological
    // string (e.g. "1" repeated 10^7 times) would burn CPU and heap.
    if (s.length === 0 || s.length > _MAX_DECIMAL_INPUT_LEN) return null;
    if (!/^[0-9]+(\.[0-9]+)?$/.test(s)) return null;
    const [intPart, fracPart = ''] = s.split('.');
    if (fracPart.length > decimals) return null;
    const padded = fracPart.padEnd(decimals, '0');
    const full = (intPart + padded).replace(/^0+/, '') || '0';
    try { return BigInt(full); } catch (_) { return null; }
}

/**
 * Map (toolName, args) → { capName, principalAtomic, dailyCapName }.
 *
 * Per BAT-582 v1.4 "Cap principal per tool" table:
 *   - solana_send (SOL):  lamports of args.amount
 *   - solana_send (SPL/USDC): microunits of args.amount (only USDC counts as a USDC cap)
 *   - solana_swap: input asset's atomic amount (SOL or USDC only)
 *   - jupiter_trigger_create: making/input amount locked at create time
 *   - jupiter_dca_create: total committed (conservative) — per cycle × total cycles
 *
 * Returns null when the tool is non-spending (e.g. cancel) or the principal
 * isn't denominated in SOL or USDC (e.g. swapping BONK→JUP doesn't hit any cap;
 * the V1 design is intentionally narrow).
 */
function _principalForTool(toolName, args) {
    const a = args || {};

    if (toolName === 'solana_send') {
        const amount = a.amount;
        // SOL is implicit when no token field (matches existing solana_send semantics)
        if (a.token == null || _isSol(a.token)) {
            const atomic = _decimalToAtomic(amount, SOL_DECIMALS);
            if (atomic == null) return null;
            return { capName: 'burner.pertx.sol', dailyCapName: 'burner.daily.sol', principalAtomic: atomic };
        }
        if (_isUsdc(a.token)) {
            const atomic = _decimalToAtomic(amount, USDC_DECIMALS);
            if (atomic == null) return null;
            return { capName: 'burner.pertx.usdc', dailyCapName: 'burner.daily.usdc', principalAtomic: atomic };
        }
        return null; // other SPL → uncapped (V1 boundary)
    }

    if (toolName === 'solana_swap') {
        const input = a.inputToken;
        const amount = a.amount;
        if (_isSol(input)) {
            const atomic = _decimalToAtomic(amount, SOL_DECIMALS);
            if (atomic == null) return null;
            return { capName: 'burner.pertx.sol', dailyCapName: 'burner.daily.sol', principalAtomic: atomic };
        }
        if (_isUsdc(input)) {
            const atomic = _decimalToAtomic(amount, USDC_DECIMALS);
            if (atomic == null) return null;
            return { capName: 'burner.pertx.usdc', dailyCapName: 'burner.daily.usdc', principalAtomic: atomic };
        }
        return null;
    }

    if (toolName === 'jupiter_trigger_create') {
        const input = a.inputToken;
        const amount = a.inputAmount;
        if (_isSol(input)) {
            const atomic = _decimalToAtomic(amount, SOL_DECIMALS);
            if (atomic == null) return null;
            return { capName: 'burner.pertx.sol', dailyCapName: 'burner.daily.sol', principalAtomic: atomic };
        }
        if (_isUsdc(input)) {
            const atomic = _decimalToAtomic(amount, USDC_DECIMALS);
            if (atomic == null) return null;
            return { capName: 'burner.pertx.usdc', dailyCapName: 'burner.daily.usdc', principalAtomic: atomic };
        }
        return null;
    }

    if (toolName === 'jupiter_dca_create') {
        // Conservative: total commitment = amountPerCycle × totalCycles (default 30 per existing tool default)
        const input = a.inputToken;
        const perCycle = a.amountPerCycle;
        // BAT-582 R3: accept numeric strings ("10") in addition to numbers.
        // The agent — especially via prompt-injected JSON — frequently emits
        // numeric fields as strings. Without this normalization the cap math
        // silently used the 30-cycle default, under-reporting the actual
        // committed principal (e.g. agent says totalCycles="10", we'd compute
        // for 30 cycles and reject borderline-fitting orders, OR worse, the
        // confirmation message would show "Cycles: 10, Total deposit: <30×>"
        // and the user approves a number that doesn't match what they see).
        // BAT-582 R7: store cycles as BigInt to preserve precision for very
        // large digit strings. `parseInt(s, 10)` truncates to a Number first,
        // losing precision past 2^53-1 — a corrupted `cycles` here gives wrong
        // cap-math (perCycle × cycles) and either over- or under-charges the
        // burner's daily/per-tx caps. Number path is config/internal-only and
        // assumed within Number.MAX_SAFE_INTEGER; string path is agent-controlled
        // and must round-trip arbitrarily large digit strings safely.
        let cyclesBig = 30n;
        if (typeof a.totalCycles === 'number' && a.totalCycles > 0 && Number.isFinite(a.totalCycles) && Number.isInteger(a.totalCycles)) {
            cyclesBig = BigInt(a.totalCycles);
        } else if (typeof a.totalCycles === 'string' && /^[0-9]{1,20}$/.test(a.totalCycles)) {
            // BAT-582 R10: bound the digit string to ≤20 chars BEFORE BigInt()
            // runs. Tool args are model-controlled; a 10MB digit payload would
            // burn O(n²) CPU + heap in the BigInt parser before any cap-math
            // executes. 20 digits comfortably covers the R7 BigInt-precision
            // regression case (16 digits past Number.MAX_SAFE_INTEGER) and
            // exceeds any realistic DCA cycle count by ~11 orders of magnitude.
            // The try/catch is defense in depth — the regex already guarantees
            // BigInt() succeeds, but a future refactor that weakens the regex
            // must not crash routing math.
            try {
                const n = BigInt(a.totalCycles);
                if (n > 0n) cyclesBig = n;
            } catch (_) { /* fall through to 30-cycle default */ }
        }
        const decimals = _isSol(input) ? SOL_DECIMALS : (_isUsdc(input) ? USDC_DECIMALS : null);
        if (decimals == null) return null;
        const perCycleAtomic = _decimalToAtomic(perCycle, decimals);
        if (perCycleAtomic == null) return null;
        const total = perCycleAtomic * cyclesBig;
        return _isSol(input)
            ? { capName: 'burner.pertx.sol',  dailyCapName: 'burner.daily.sol',  principalAtomic: total }
            : { capName: 'burner.pertx.usdc', dailyCapName: 'burner.daily.usdc', principalAtomic: total };
    }

    return null;
}

/**
 * Decide which wallet should service `toolName` with `args`.
 *
 * Algorithm:
 *   1. Compute principal via _principalForTool. If null (non-spending or
 *      uncapped asset), fall back conservatively to the MAIN wallet.
 *   2. Read /burner/status. If burner is NOT configured → routing="main",
 *      underCap=true (caller goes through MWA + confirmation).
 *   3. Run wouldReserve against per-tx + daily caps. If both pass →
 *      routing="burner", underCap=true.
 *   4. Otherwise routing="burner", underCap=false. Caller (or the
 *      confirmation hook) decides whether to block or fall back to main.
 *
 * @param {string} toolName
 * @param {object} args
 * @param {object} [statusOverride] - optional pre-fetched /burner/status
 *   payload (BAT-582 R3). Threaded through to wouldReserve so getWalletState
 *   can fetch /burner/status ONCE and avoid 2 redundant bridge round-trips
 *   on every Solana write tool dispatch (per-tx + daily). Omitting it
 *   preserves existing call sites (solana.js routing hints, dispatch.js).
 * @returns {Promise<{
 *     routingDecision: "burner" | "main",
 *     underCap: boolean,
 *     principalAtomic: string | null,  // BigInt-as-string; null when non-spending
 *     capName: string | null,
 *     reason?: string,
 * }>}
 */
async function routeFor(toolName, args, statusOverride) {
    const principal = _principalForTool(toolName, args);

    // Non-spending tools or uncapped assets → main path; let MWA handle.
    if (!principal) {
        return {
            routingDecision: 'main',
            underCap: true,
            principalAtomic: null,
            capName: null,
            reason: 'no_capped_principal',
        };
    }

    // Per-tx check.
    const perTx = await wouldReserve(principal.capName, principal.principalAtomic, statusOverride);
    if (!perTx.wouldAllow) {
        // burner_not_configured → main path (no popup needed for main user; MWA handles confirmation).
        if (perTx.reason === 'burner_not_configured') {
            return {
                routingDecision: 'main',
                underCap: true,
                principalAtomic: principal.principalAtomic.toString(),
                capName: principal.capName,
                reason: 'burner_not_configured',
            };
        }
        // Other failures (over cap, bridge unreachable, etc.) → routing=burner, underCap=false.
        // The confirmation hook turns this into a block (or main fallback if _allowMainFallback set).
        return {
            routingDecision: 'burner',
            underCap: false,
            principalAtomic: principal.principalAtomic.toString(),
            capName: principal.capName,
            reason: perTx.reason,
        };
    }

    // Daily-cap check (already encodes spent + amt > limit logic).
    if (principal.dailyCapName) {
        const daily = await wouldReserve(principal.dailyCapName, principal.principalAtomic, statusOverride);
        if (!daily.wouldAllow) {
            if (daily.reason === 'burner_not_configured') {
                return {
                    routingDecision: 'main',
                    underCap: true,
                    principalAtomic: principal.principalAtomic.toString(),
                    capName: principal.dailyCapName,
                    reason: 'burner_not_configured',
                };
            }
            return {
                routingDecision: 'burner',
                underCap: false,
                principalAtomic: principal.principalAtomic.toString(),
                capName: principal.dailyCapName,
                reason: daily.reason,
            };
        }
    }

    return {
        routingDecision: 'burner',
        underCap: true,
        principalAtomic: principal.principalAtomic.toString(),
        capName: principal.capName,
    };
}

module.exports = {
    wouldReserve,
    routeFor,
    CAP_MAP,
    // exposed for tests
    _principalForTool,
    _decimalToAtomic,
};
