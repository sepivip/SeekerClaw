// SeekerClaw — wallet/index.js
// Wallet registry. Tools never construct signers/wallets directly — they go
// through getWallet(role). This is the seam that lets V2 plug in a hardware
// wallet or Seed Vault signer without touching tool code.
//
// Phase 4: registry + getWalletState() helper. The state helper bundles
// /burner/status reads + the routing-decision math so ai.js can invoke
// the confirmation hook with a single await.

'use strict';

const { BurnerWallet } = require('./burner-wallet');
const { MainWallet } = require('./main-wallet');
const { androidBridgeCall } = require('../bridge');
const { routeFor } = require('../caps/preflight');
const { V1_STATIC_CONFIRM, SOLANA_WRITE_TOOLS, JUPITER_CANCEL_TOOLS } = require('../confirmation/policy');

// BAT-582 R1: tools whose confirmation policy reads burner-status state.
// For any tool NOT in this set the policy hook returns 'none' or a
// v1.0-static answer that doesn't depend on /burner/status — so we can
// short-circuit the bridge round-trip on the hot path (every tool dispatch
// in ai.js).
//
// Membership rule: a tool belongs here iff `getConfirmationPolicy()` reads
// any field of walletState that's populated by /burner/status —
// burnerConfigured / burnerCaps / burnerSpentToday — OR it's in the v1.0
// static set (kept for safety: even though policy.js doesn't currently read
// state for those, the regression contract requires the gate to behave
// identically when burnerConfigured=true, so future changes to any v1-static
// tool's policy can rely on state being populated).
//
// BAT-582 R5: JUPITER_CANCEL_TOOLS deliberately NOT included here. Their
// confirmation policy is ownership-based (`ws.creatorRole`), populated via
// /jupiter/order-owner/get — a separate, cheaper lookup. Including cancels
// here previously triggered an unconditional /burner/status round-trip on
// every cancel even though policy.js never reads burner-status for cancels.
// We branch on JUPITER_CANCEL_TOOLS below to handle them via ownership-only.
//
// BAT-582 R9: wallet_status NOT included.
//   - wallet_status: policy hook returns the literal 'none' regardless of
//     state. The handler does its own /burner/status fetch internally to
//     populate the response — gating here was a wasted bridge round-trip.
//
// BAT-664 (device-test fix 2026-05-12): agent_pay IS included.
// Pre-fix, agent_pay was excluded under the R9 rationale "policy hook only
// inspects args.max_usdc (block-or-none) and never reads burner state."
// That was true for v1.4 (GET-only). BAT-664 added a POST-specific branch
// to policy.js that DOES read `walletState.burnerConfigured` (see
// confirmation/policy.js:367 — fail-fast block before the user is shown a
// confirm prompt for an action that can't succeed). With agent_pay
// excluded from the gate, ai.js would pass the empty short-circuit state
// (burnerConfigured=false) — so EVERY agent_pay POST got blocked as
// burner_not_configured even when the burner was configured. Same-session
// GET worked fine (no POST branch), making this look like a config bug
// to the agent.
//
// Trade-off: agent_pay now incurs one /burner/status bridge call per
// dispatch (~5-30ms). The R9 optimization is reversed. Correctness > tail
// latency for a tool that moves user funds. The handler still does its
// OWN /burner/status fetch for the cap-preflight + reserve steps — that
// could be deduped via a request-scope cache as a future BAT-XXX
// (low priority, not user-facing).
const _BURNER_STATUS_GATE_TOOLS = new Set([
    ...V1_STATIC_CONFIRM,
    ...SOLANA_WRITE_TOOLS,
    'wallet_set_caps',
    'agent_pay',
]);

// Combined gate: tools that need ANY state hydration (burner-status OR
// ownership lookup). Used for the early short-circuit return when the
// tool needs no state at all.
const _GATE_TOOLS = new Set([
    ..._BURNER_STATUS_GATE_TOOLS,
    ...JUPITER_CANCEL_TOOLS,
]);

let _burner = null;
let _main = null;

/**
 * Get a wallet by role. Returns null if the role doesn't exist.
 * Caller-side null-check pattern: `if (!w) { ... no burner configured ... }`
 *
 * Wallet instances are singletons within a Node lifetime — they hold no
 * mutable state beyond their signer reference, so reuse is safe.
 */
function getWallet(role) {
    if (role === 'burner') {
        if (!_burner) _burner = new BurnerWallet();
        return _burner;
    }
    if (role === 'main') {
        if (!_main) _main = new MainWallet();
        return _main;
    }
    return null;
}

/**
 * Read /burner/status once and decorate it with the routing decision +
 * Jupiter ownership lookup so getConfirmationPolicy can answer with a
 * single arg. Used by ai.js BEFORE every tool dispatch.
 *
 * Shape — every field optional except burnerConfigured:
 *   {
 *     burnerConfigured: bool,
 *     routingDecision?: "burner" | "main",
 *     underCap?: bool,
 *     creatorRole?: "burner" | "main" | "unknown",
 *     burnerCaps?: { capPerTxSol, capDailySol, capPerTxUsdc, capDailyUsdc },
 *     burnerSpentToday?: { spentTodaySol, spentTodayUsdc },
 *   }
 *
 * Defensive: every bridge call is guarded — failures degrade to
 * burnerConfigured=false (the v1.0 baseline). NEVER throws.
 */
async function getWalletState(toolName, args) {
    const state = { burnerConfigured: false };

    // BAT-582 R1: hot-path optimization. ai.js calls getWalletState before
    // EVERY tool dispatch — but for tools whose confirmation policy doesn't
    // read burner state (memory_save, web_fetch, file_*, etc.), state
    // hydration is wasted. Short-circuit here. Solana write tools and
    // Jupiter cancels still flow into the appropriate branches below.
    if (!_GATE_TOOLS.has(toolName)) {
        return state;
    }

    // BAT-582 R5: Jupiter cancel tools are ownership-gated only —
    // policy.js reads ws.creatorRole and ignores burnerConfigured /
    // burnerCaps / burnerSpentToday. Pre-fix, this branch ALSO fetched
    // /burner/status (a real ~5-30ms bridge round-trip) before falling
    // through to the order-owner lookup, even though the result was
    // discarded by the policy hook. Cancels now run the ownership
    // lookup in isolation and return — no /burner/status round-trip.
    if (JUPITER_CANCEL_TOOLS.has(toolName)) {
        const orderId = (args && (args.orderId || args.order_id)) || null;
        if (!orderId) {
            state.creatorRole = 'unknown';
            return state;
        }
        try {
            const lookup = await androidBridgeCall(
                '/jupiter/order-owner/get',
                { orderId },
                5000
            );
            if (lookup && !lookup.error && typeof lookup.creatorWalletRole === 'string') {
                const role = lookup.creatorWalletRole;
                state.creatorRole = (role === 'burner' || role === 'main') ? role : 'unknown';
            } else {
                state.creatorRole = 'unknown';
            }
        } catch (_) {
            state.creatorRole = 'unknown';
        }
        return state;
    }

    // 1) Status read (cap state + pubkey). Required for everything that
    // remains in _BURNER_STATUS_GATE_TOOLS.
    let status;
    try {
        status = await androidBridgeCall('/burner/status', {}, 5000);
    } catch (_) { status = null; }

    if (status && !status.error && status.configured) {
        state.burnerConfigured = true;
        state.burnerCaps = {
            capPerTxSol:  String(status.capPerTxSol  || '0'),
            capDailySol:  String(status.capDailySol  || '0'),
            capPerTxUsdc: String(status.capPerTxUsdc || '0'),
            capDailyUsdc: String(status.capDailyUsdc || '0'),
        };
        state.burnerSpentToday = {
            spentTodaySol:  String(status.spentTodaySol  || '0'),
            spentTodayUsdc: String(status.spentTodayUsdc || '0'),
        };
    }

    // 2) For Solana write tools, compute routing decision + cap fitness.
    //
    // BAT-582 R3: thread the `status` we already fetched above into routeFor
    // (and transitively wouldReserve) so the routing branch reuses the same
    // bridge response instead of issuing 2 more /burner/status round-trips
    // (one per-tx + one daily). Saves 2 HTTP calls on every Solana write
    // tool dispatch, which is hot-path territory in ai.js. We pass `status`
    // even when null/error — wouldReserve interprets that as bridge_unreachable
    // and fails closed, which matches the live-fetch failure path exactly.
    if (SOLANA_WRITE_TOOLS.has(toolName)) {
        // BAT-1036: solana_send_token honors an explicit source='main' AT the gate
        // so an over-cap source='main' USDC send confirms via MWA instead of being
        // mis-classified burner/over-cap and BLOCKED before the handler can force
        // main. Scoped to this tool — solana_send/solana_swap keep their existing
        // cap-based gate (their own handlers already force main for source='main').
        if (toolName === 'solana_send_token' && args && args.source === 'main') {
            state.routingDecision = 'main';
            state.underCap = true;
        } else {
            try {
                const route = await routeFor(toolName, args || {}, status);
                state.routingDecision = route.routingDecision;
                state.underCap = route.underCap;
            } catch (_) {
                // Defensive: routing failure → conservative confirm path
                state.routingDecision = 'main';
                state.underCap = true;
            }
        }
    }

    return state;
}

/**
 * Test-only reset. Production code never calls this. Tests use it to
 * inject mock signers for behavioral tests.
 */
function _resetForTests() {
    _burner = null;
    _main = null;
}

module.exports = { getWallet, getWalletState, _resetForTests };
