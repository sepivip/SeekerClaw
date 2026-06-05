// SeekerClaw — wallet/burner-signer.js
// BurnerSigner — async bridge wrapper. NO crypto. NO key material in Node.
//
// All signing happens inside Android KeyVault (BouncyCastle Ed25519).
// This module exists ONLY to translate Signer calls into bridge HTTP calls
// against /burner/sign-transaction and /burner/sign-and-send.
//
// Cap reservations are also Android-side; Node never writes cap state.
// signTransaction expects an already-reserved reservationId; signAndSend
// can either be passed a reservationId or let Android reserve atomically.
//
// BAT-1013 POLICY HOOK
// --------------------
// As of BAT-1013, BurnerSigner is the CHOKEPOINT for all autonomous
// burner signing. Every caller (`routeAndSign`, `signCancelViaBurner`,
// `signZeroCapTxViaBurner` in wallet/dispatch.js, plus `tools/agent_pay.js`'s
// direct call) reaches the bridge through one of THIS class's methods —
// either `signTransaction()` or `signAndSend()`. Codex amendment #2
// explicitly required that BOTH be policy-gated; this commit wires the
// policy hook at both call sites.
//
// Policy invocation contract:
//   - Caller passes `opts.expectedDelta` (per-tool shape from
//     wallet/burner-policy.js's DELTA_KINDS) AND optionally
//     `opts.simulator` (async (txB64) → simResult).
//   - If `expectedDelta` is present, the policy gate runs BEFORE any
//     bridge HTTP call. If policy rejects, this method returns
//     `{ error: <reject code>, reason, policyClass }` and the bridge is
//     never called.
//   - **TRANSITIONAL (Phase 2d → Phase 3):** if `expectedDelta` is
//     ABSENT, we WARN-log and pass through to the bridge unchanged.
//     This is a knowing security gap during the BAT-1013 caller
//     migration period — once Phase 3 lands and all callers pass
//     `expectedDelta`, the transitional pass-through is removed and
//     missing-expectedDelta becomes a fail-closed `expected_delta_required`
//     reject. The warn-log fires every transitional-mode call so we
//     can spot unmigrated callers in production logs.
//   - `burnerPubkey` is fetched lazily from `/burner/status` on first
//     policy invocation per Node lifetime. The cached value is verified
//     against the latest `/burner/status` pubkey on every fetch — if the
//     bridge reports a different pubkey (mid-process burner re-setup or
//     wipe + new generation), the cache is invalidated and the fresh
//     value is adopted before the policy gate runs.
//     The `_resetBurnerPubkeyCache()` test hook also exists for unit
//     tests. (Previously this comment claimed wipe destroys the Node
//     process via service restart — that is NOT true today: wipe is a
//     bridge endpoint and Node continues running. The cache-vs-bridge
//     compare on every call is what makes mid-life wipes safe; the
//     follow-up to push KeyVault.wipe → InternalControlServer →
//     `_resetBurnerPubkeyCache()` proactively is tracked separately.)

'use strict';

const { Signer } = require('./signer');
const { androidBridgeCall } = require('../bridge');
const { validateBurnerTx } = require('./burner-policy');
const { createPublicRpcShaper } = require('./public-rpc-shaper');

// Lazy-required to avoid circular dependency with solana.js (which is the
// canonical RPC producer). The require fires only when a caller invokes
// signTransaction/signAndSend WITHOUT passing their own simulator.
let _solanaRpc = null;
let _getSolanaRpcUrl = null;
let _isValidSolanaAddress = null;
function _lazySolanaInternals() {
    if (_solanaRpc === null) {
        // eslint-disable-next-line global-require
        const solana = require('../solana');
        // R-next-15 same-class sweep: every lazy-bound solana export now
        // uses an explicit typeof check + fail-closed fallback + ERROR log.
        // The previous `X || lax_default` shape silently masked
        // bundling-error / export-missing conditions — for _solanaRpc the
        // lax default returned `{ value: null }` which the simulateTransaction
        // path accepted as a successful sim with zero account changes
        // (silent acceptance), and for _getSolanaRpcUrl the lax default
        // returned the literal string `'public'` which then threw
        // synchronously in `new URL('public')` inside solanaRpcOnce's
        // Promise executor (Copilot R-next-15 finding).
        if (typeof solana.solanaRpc === 'function') {
            _solanaRpc = solana.solanaRpc;
        } else {
            _log('[BurnerSigner] solana.solanaRpc export missing — failing closed on all RPC calls (simulation/policy will reject as simulation_failed)', 'ERROR');
            _solanaRpc = async () => { throw new Error('solana_rpc_unavailable: solana.solanaRpc export missing'); };
        }
        if (typeof solana.getSolanaRpcUrl === 'function') {
            _getSolanaRpcUrl = solana.getSolanaRpcUrl;
        } else {
            // null override → solanaRpcOnce uses its canonical live URL
            // selection (see solana.js:57 `rpcUrlOverride || getSolanaRpcUrl()`).
            // The drift-check below short-circuits on null via its
            // `typeof === 'string'` guard, so this degrade avoids the prior
            // crash. Caveat: in the partial export-missing case (this export
            // gone, but solana.solanaRpc still present), the R-next-12
            // same-RPC pinning contract is degraded — solanaRpcOnce will
            // independently re-read live config on each call rather than
            // honoring the pinned URL we'd normally pass through.
            _log('[BurnerSigner] solana.getSolanaRpcUrl export missing — drift detection + backing hint degraded; _solanaRpc(..., null) will fall through to canonical live URL selection', 'ERROR');
            _getSolanaRpcUrl = () => null;
        }
        // R-next-13: use production isValidSolanaAddress contract (charset +
        // 32..44 length + base58Decode + 32-byte payload) for the bridge
        // pubkey check below. Lightweight 'string + length >= 32' was too
        // lax — a malformed pubkey from the bridge could poison the cache.
        //
        // R-next-14 hardening: if solana.isValidSolanaAddress is somehow
        // absent (asset bundling bug, future refactor, partial deploy), do
        // NOT silently fall back to the lax check — that would re-enable
        // the exact cache-poisoning vector R-next-13 closed. Fail closed:
        // reject every bridge pubkey, force fallback to the existing cache,
        // and log ERROR so production can detect the export-missing state.
        if (typeof solana.isValidSolanaAddress === 'function') {
            _isValidSolanaAddress = solana.isValidSolanaAddress;
        } else {
            _log('[BurnerSigner] solana.isValidSolanaAddress export missing — R-next-13 cache-poisoning guard inactive; failing closed on all bridge pubkeys (will return last-known cache)', 'ERROR');
            _isValidSolanaAddress = () => false;
        }
    }
}

// Shared shaper instance for the public-RPC path. Same instance across the
// Node lifetime so the ≤3 sim/10s window is enforced across all burner
// signs that fall on the public RPC.
let _publicShaper = null;
function _getPublicShaper() {
    if (_publicShaper === null) _publicShaper = createPublicRpcShaper();
    return _publicShaper;
}

// Test hook — resets the shared shaper between cases so independent unit
// tests don't bleed window state into one another. Production never calls
// this; the shaper is intentionally process-scoped.
function _resetPublicShaper() {
    _publicShaper = null;
}

/**
 * Default simulator factory. Returns the v8.1 `(txBase64, { addresses })
 *   → { sim, preSnapshot, slot, simulatorBacking }` function the policy
 * expects.
 *
 * Per Codex amendment #8.1 §3 (same-RPC consistency):
 *   - `solanaRpc()` re-reads `getSolanaRpcUrl()` per call (BAT-1000
 *     hot-reload). To enforce that `getMultipleAccounts` (pre-snapshot)
 *     and `simulateTransaction` BOTH hit the same backing, we sample the
 *     URL before the first call AND after the second; if the URL flipped
 *     mid-validation (the user toggled the Helius API key in Settings
 *     between the two reads), we throw a drift error which the policy's
 *     catch wraps as `simulation_failed` (availability-class). In normal
 *     operation the two reads happen within ~50ms in the same event-loop
 *     tick and the URL is stable. A URL-explicit RPC variant is a
 *     follow-up — for now drift detection is the contract guarantee.
 *   - On the public-RPC path, the rate shaper wraps `simulateTransaction`
 *     (NOT `getMultipleAccounts`). Pre-snapshot is a cheaper read and
 *     not the rate-limited bottleneck.
 */
function _lazyDefaultSimulator() {
    _lazySolanaInternals();
    const shaper = _getPublicShaper();

    return async (txBase64, opts) => {
        const addresses = (opts && Array.isArray(opts.addresses)) ? opts.addresses : [];
        // Determine the active backing for this call. Used for the UX-hint
        // logic in the caller (Codex amendment #8.1 §5) and surfaced to the
        // policy result for diagnostics. ALSO captured for the same-RPC
        // drift check below.
        let backing = 'public';
        let urlAtStart = null;
        try {
            urlAtStart = _getSolanaRpcUrl();
            if (typeof urlAtStart === 'string' && /helius/i.test(urlAtStart)) backing = 'helius';
        } catch (e) {
            // Q6: surface the failure in logs so production drift checks can
            // see when the accessor threw vs returned null. Drift detection
            // remains best-effort but is no longer silent.
            _log(`[BurnerSigner] _getSolanaRpcUrl threw before getMultipleAccounts: ${e && e.message ? e.message : String(e)} — BOTH drift check AND URL pinning degraded (R-next-12): both RPC calls will re-read live config, restoring the original race window. Operations should still succeed via the live config; this WARN exists so production can detect when getSolanaRpcUrl is unhealthy.`, 'WARN');
        }

        // 1. Pre-snapshot — same-RPC getMultipleAccounts.
        // R-next-12: pin urlAtStart as an explicit override on both RPC
        // calls so we are GUARANTEED that getMultipleAccounts and
        // simulateTransaction hit the same backing, even if the user
        // toggles the Helius key between line 122 and the first RPC call
        // here. Previously each solanaRpc internally re-read
        // getSolanaRpcUrl() per call, so a flip between sample + first call
        // would silently land both RPCs on the new URL without detection.
        // With urlAtStart pinned, the drift check at line ~223 becomes a
        // strict "user reconfigured during validation" warning rather than
        // a structural correctness guard — defense-in-depth.
        let preSnapshot = [];
        let preSlot = null;
        if (addresses.length > 0) {
            const gma = await _solanaRpc('getMultipleAccounts', [
                addresses,
                { commitment: 'processed', encoding: 'base64' },
            ], urlAtStart);
            // Copilot PR #398 R4: `solanaRpc()` returns `{ error: '...' }`
            // on RPC failure / timeout instead of throwing. The previous
            // fallback `addresses.map(() => null)` silently treated a
            // failed RPC as an all-null pre-snapshot, which let the policy
            // proceed with bogus pre-state. Translate to an exception so
            // the policy's catch wraps it as `simulation_failed`.
            if (gma && gma.error) {
                throw new Error(`getMultipleAccounts: ${gma.error}`);
            }
            // C9: tighten the response shape — `gma.value` must be present
            // and must be an array of the same length as the requested
            // addresses. Anything shorter or missing is treated as a
            // metadata gap so the policy wraps it as
            // `simulation_metadata_missing` rather than proceeding with a
            // bogus pre-state. Per-entry nulls inside the array are still
            // legitimate (e.g. an ATA not yet created) and are passed
            // through to the policy, which has its own `mustExistBefore`
            // gating per declared account.
            if (!gma || !Array.isArray(gma.value)) {
                throw new Error('simulation_metadata_missing: getMultipleAccounts returned no `value` array');
            }
            if (gma.value.length !== addresses.length) {
                throw new Error(`simulation_metadata_missing: getMultipleAccounts returned ${gma.value.length} entries for ${addresses.length} requested addresses`);
            }
            preSnapshot = gma.value;
            // Q4 slot-drift detection: capture the pre-snapshot slot so we
            // can compare against the simulation slot below.
            if (gma.context && typeof gma.context.slot === 'number') {
                preSlot = gma.context.slot;
            }
        }

        // 2. simulateTransaction — accounts-config returns the post-state
        //    for the same addresses in the same order.
        const simParams = [
            txBase64,
            {
                commitment: 'processed',
                sigVerify: false,
                replaceRecentBlockhash: true,
                encoding: 'base64',
                innerInstructions: true,
                accounts: addresses.length > 0
                    ? { addresses, encoding: 'base64' }
                    : undefined,
            },
        ];

        let sim;
        // Copilot PR #398 R4: wrap solanaRpc in a function that THROWS on
        // its `{ error }` return so `public-rpc-shaper` can correctly
        // detect 429s / failures and apply backoff/retry. Without this,
        // an HTTP 429 returned as `{ error: '... 429 ...' }` was treated
        // as a successful response carrying garbage payload.
        const callSim = async () => {
            // R-next-12: pin urlAtStart so simulateTransaction is guaranteed
            // to hit the same backing as the pre-snapshot getMultipleAccounts
            // above. See comment at line ~131.
            const r = await _solanaRpc('simulateTransaction', simParams, urlAtStart);
            if (r && r.error) {
                throw new Error(String(r.error));
            }
            return r;
        };
        if (backing === 'public') {
            const shaped = await shaper.tryRun(callSim);
            if (!shaped.ok) {
                // The shaper exhausted retries OR refused to enqueue. Translate
                // to an exception so the policy's catch wraps it as
                // `simulation_failed` (availability-class).
                throw new Error(`public-rpc shaper: ${shaped.error}: ${shaped.reason}`);
            }
            sim = shaped.value;
        } else {
            sim = await callSim();
        }

        // Same-RPC drift detection (Codex amendment #8.1 §3): if the active
        // RPC URL changed between the two reads (e.g. user toggled Helius
        // API key in Settings mid-validation), `getMultipleAccounts` and
        // `simulateTransaction` hit different backings — pre/post-state
        // come from different chain views. Fail closed so the caller does
        // not bridge-sign on inconsistent data. The policy wraps the throw
        // as `simulation_failed` (availability-class).
        let urlAtEnd = null;
        try {
            urlAtEnd = _getSolanaRpcUrl();
            if (typeof urlAtStart === 'string' && typeof urlAtEnd === 'string' && urlAtStart !== urlAtEnd) {
                throw new Error('rpc_url_drift: active RPC URL changed between getMultipleAccounts and simulateTransaction');
            }
        } catch (e) {
            if (e && typeof e.message === 'string' && e.message.startsWith('rpc_url_drift')) throw e;
            // Q6: _getSolanaRpcUrl() itself threw — log so we can see the
            // degraded-drift-check case in production, instead of silently
            // skipping.
            _log(`[BurnerSigner] _getSolanaRpcUrl threw after simulateTransaction: ${e && e.message ? e.message : String(e)} — drift check degraded`, 'WARN');
        }

        // solanaRpc returns the parsed JSON body; policy expects `{ value:
        // {...} }`. If the response is already shaped that way, pass
        // through. Otherwise wrap.
        const normalized = (sim && sim.value) ? sim : { value: sim };

        const simSlot = (normalized.context && typeof normalized.context.slot === 'number') ? normalized.context.slot : null;

        // Q4: same-URL slot drift detection. Even when the URL did not
        // change, a load-balanced public RPC may serve `getMultipleAccounts`
        // from one replica at slot N and `simulateTransaction` from
        // another replica at slot N - K. When K is large enough, pre-state
        // and post-state describe different chain views. Solana finality
        // lands new slots every ~400ms; 8 slots ≈ 3.2s is a generous bound
        // for two same-RPC reads in the same event-loop tick. Throw so the
        // policy wraps it as `simulation_failed` (availability-class —
        // caller may retry once RPC settles). Skip the check when either
        // slot is missing: preSlot is null when no addresses were requested
        // (GMA path skipped entirely) OR when the GMA response lacked a
        // numeric `context.slot` (older RPC); simSlot is null when the
        // simulateTransaction response lacked one for the same reason.
        if (preSlot !== null && simSlot !== null) {
            const drift = Math.abs(simSlot - preSlot);
            if (drift > 8) {
                throw new Error(`slot_drift: getMultipleAccounts slot ${preSlot} vs simulateTransaction slot ${simSlot} (delta ${drift} > 8) — same-RPC replicas inconsistent`);
            }
        }

        return {
            sim: normalized,
            preSnapshot,
            slot: simSlot || 0,
            preSlot,
            simulatorBacking: backing,
        };
    };
}

let _burnerPubkeyCache = null;
async function _getBurnerPubkey() {
    // C8 fix: always cross-check the cached value with /burner/status. The
    // bridge round-trip is ~milliseconds and avoids a long-lived stale
    // pubkey across a mid-process wipe + re-setup. If the bridge call fails
    // (network glitch, Android service paused), fall back to the cached
    // value — this preserves the prior behavior for the common case and
    // only hardens the wipe-then-re-setup edge.
    //
    // R-next-13: validate the bridge pubkey using the SAME production
    // contract as solana.isValidSolanaAddress (charset + length + 32-byte
    // decode), not just `string && length >= 32`. A malformed bridge
    // response (compromise, schema drift, accidental string corruption)
    // previously could poison the cache and deterministically break every
    // subsequent policy gate until process restart. Now we ignore an
    // invalid pubkey response and fall back to the last-known cached
    // value instead.
    _lazySolanaInternals();
    try {
        const s = await androidBridgeCall('/burner/status', {}, 5000);
        if (s && !s.error && s.configured && _isValidSolanaAddress(s.pubkey)) {
            if (_burnerPubkeyCache !== null && _burnerPubkeyCache !== s.pubkey) {
                _log(`[BurnerSigner] burner pubkey changed under cache (cached=${_burnerPubkeyCache.slice(0, 8)}… new=${s.pubkey.slice(0, 8)}…) — invalidating`, 'WARN');
            }
            _burnerPubkeyCache = s.pubkey;
            return s.pubkey;
        }
        // Bridge said configured but the pubkey didn't pass the contract.
        // Log so production can detect bridge-response corruption /
        // schema drift instead of silently falling back. R-next-14: fire
        // for ANY non-passing pubkey type (null/undefined/number/empty
        // string), not just strings — a `configured:true` response with
        // pubkey=null is exactly the schema-drift signal we want to surface.
        if (s && !s.error && s.configured && !_isValidSolanaAddress(s.pubkey)) {
            const t = typeof s.pubkey;
            const len = t === 'string' ? s.pubkey.length : 'n/a';
            const first8 = t === 'string' ? s.pubkey.slice(0, 8) : String(s.pubkey);
            _log(`[BurnerSigner] /burner/status returned a pubkey that failed isValidSolanaAddress (type=${t}, length=${len}, first8=${first8}…) — ignoring response, falling back to cache`, 'WARN');
        }
    } catch (_) {}
    return _burnerPubkeyCache;
}

function _resetBurnerPubkeyCache() {
    _burnerPubkeyCache = null;
}

// log() is also lazy-required — pulling config.js eagerly at module load
// triggers cross-process-store init which the smoke test scaffold doesn't
// provide. Lazy keeps burner-signer.js a pure no-IO module-load.
let _logFn = null;
function _log(msg, level) {
    if (_logFn === null) {
        try {
            // eslint-disable-next-line global-require
            _logFn = require('../config').log || (() => {});
        } catch (_) {
            _logFn = () => {};
        }
    }
    try { _logFn(msg, level); } catch (_) {}
}

/**
 * Run `validateBurnerTx` if `opts.expectedDelta` is present. Returns:
 *   - `null` if no policy was run (caller in transitional mode).
 *   - `{ error, reason, policyClass }` if policy rejected — caller MUST
 *     return this to its caller WITHOUT touching the bridge.
 *   - `{ ok: true }` if policy passed — caller continues to bridge call.
 *
 * Centralised so `signTransaction` and `signAndSend` share identical
 * gate semantics (Codex amendment #2: no bypass).
 */
async function _runPolicyGate(txBase64, opts, methodName) {
    if (!opts || typeof opts.expectedDelta === 'undefined') {
        // TRANSITIONAL Phase 2d → Phase 3: warn but pass through.
        _log(`[BurnerPolicy] ${methodName} called without expectedDelta — TRANSITIONAL pass-through. Migrate caller per BAT-1013 Phase 3.`, 'WARN');
        return null;
    }
    const burnerPubkey = await _getBurnerPubkey();
    if (!burnerPubkey) {
        return {
            error: 'payer_missing',
            reason: 'burner pubkey unavailable (burner not configured or /burner/status failed)',
            policyClass: 'contract_gap',
        };
    }
    const simulator = (typeof opts.simulator === 'function')
        ? opts.simulator
        : _lazyDefaultSimulator();
    const result = await validateBurnerTx(txBase64, opts.expectedDelta, {
        burnerPubkey,
        simulator,
    });
    if (!result.ok) {
        _log(`[BurnerPolicy] ${methodName} REJECT tool=${opts.expectedDelta.kind || 'unknown'} error=${result.error} reason="${result.reason}" class=${result.class}`, 'WARN');
        return {
            error: result.error,
            reason: result.reason,
            policyClass: result.class,
        };
    }
    _log(`[BurnerPolicy] ${methodName} ACCEPT tool=${opts.expectedDelta.kind || 'unknown'} simulated=${result.simulated ? 'true' : 'false'} programs=${(result.programs || []).length}`, 'DEBUG');
    return { ok: true };
}

class BurnerSigner extends Signer {
    /**
     * Sign a serialized transaction. Caller must pass a valid reservationId
     * (obtained from /burner/reserve). Bridge does NOT commit the reservation;
     * caller is responsible for /burner/commit on broadcast success or
     * /burner/release on failure.
     */
    async signTransaction(txBase64, opts = {}) {
        if (typeof txBase64 !== 'string' || !txBase64) {
            return { error: 'invalid_input', reason: 'txBase64 must be a non-empty string' };
        }
        if (!opts.reservationId) {
            return { error: 'missing_reservation', reason: 'reservationId required for sign-only flow' };
        }
        // BAT-1013: policy gate BEFORE any bridge call (Codex amendment #2).
        const policyResult = await _runPolicyGate(txBase64, opts, 'signTransaction');
        if (policyResult && policyResult.error) return policyResult;
        const body = {
            txBase64,
            reservationId: opts.reservationId,
        };
        // BAT-582 v1.6 Phase 5d: when the caller is signing a partially-
        // signed x402 v2 tx (facilitator co-signs server-side), set the
        // bridge flag so SolanaTxSigner skips its v1 "all other signers
        // must be cosigned" check. Default false preserves v1 behavior
        // for every existing caller (Jupiter Ultra swap, v1 x402, etc.).
        if (opts.allowPartiallySigned === true) {
            body.allowPartiallySigned = true;
        }
        const res = await androidBridgeCall('/burner/sign-transaction', body, 15000);
        return res;
    }

    /**
     * Sign + broadcast atomically. Bridge handles reserve+sign+broadcast+commit
     * (or release on error) in one round trip. broadcastVia: "rpc" | "jupiter".
     */
    async signAndSend(txBase64, opts = {}) {
        if (typeof txBase64 !== 'string' || !txBase64) {
            return { error: 'invalid_input', reason: 'txBase64 must be a non-empty string' };
        }
        const broadcastVia = opts.broadcastVia || 'rpc';
        if (broadcastVia !== 'rpc' && broadcastVia !== 'jupiter') {
            return { error: 'invalid_input', reason: 'broadcastVia must be "rpc" or "jupiter"' };
        }
        // BAT-1013: same policy gate as signTransaction (Codex amendment #2 —
        // signAndSend MUST NOT become a future bypass).
        const policyResult = await _runPolicyGate(txBase64, opts, 'signAndSend');
        if (policyResult && policyResult.error) return policyResult;
        const body = { txBase64, broadcastVia };
        if (opts.reservationId) body.reservationId = opts.reservationId;
        const res = await androidBridgeCall('/burner/sign-and-send', body, 30000);
        return res;
    }
}

module.exports = {
    BurnerSigner,
    // Test hooks
    _resetBurnerPubkeyCache,
    _resetPublicShaper,
    _lazyDefaultSimulator,
    _getBurnerPubkey,
};
