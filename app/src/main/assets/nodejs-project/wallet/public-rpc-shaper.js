// SeekerClaw — wallet/public-rpc-shaper.js
//
// BAT-1013 v8.1 amendment #6: rate-shape `simulateTransaction` calls on the
// PUBLIC mainnet RPC path (`api.mainnet-beta.solana.com`) so the burner
// policy doesn't burn through the documented ~40 req/10s shared-quota
// ceiling on a single hot tool dispatch.
//
// Scope (per Codex amendment #6):
//   - Local to the burner-policy simulator path ONLY.
//   - MUST NOT delay or interfere with unrelated Solana reads (balance,
//     Jupiter quotes, NFT holdings, etc.). Those continue to use the
//     existing `solanaRpc` retry path with no shaping.
//   - Pure module with injected clock for unit testing.
//   - On backoff exhaustion → return `{ ok: false, error: 'rate_exhausted' }`
//     to the caller, which translates it into `simulation_failed`
//     (availability-class). NEVER silently downgrades to structural-only.
//
// Knobs (Codex amendment #6):
//   - max 3 attempts per 10s rolling window
//   - exponential backoff on 429: 1s → 2s → 4s, capped at 4s
//
// Codex amendment #4 (blockhash cache scope): we DO NOT cache blockhashes
// here. `simulateTransaction` with `replaceRecentBlockhash: true` doesn't
// need an external blockhash to be passed; the RPC fills it server-side.
// So the shaper has no `getLatestBlockhash` round-trip to add or save.
// If the simulator factory adds blockhash calls later, those should grow
// their own cache that doesn't shape unrelated Solana reads.

'use strict';

const DEFAULT_WINDOW_MS = 10_000;
const DEFAULT_MAX_PER_WINDOW = 3;
const DEFAULT_BACKOFF_MS = [1_000, 2_000, 4_000];

/**
 * Build a shaper instance. State is per-instance — one instance per
 * simulator factory per Node lifetime. The default clock is real
 * `Date.now()` and `setTimeout`; tests inject deterministic equivalents.
 *
 * @param {object} [opts]
 * @param {() => number}                                 [opts.now]   - returns ms epoch
 * @param {(ms: number) => Promise<void>}                [opts.sleep] - resolves after ms
 * @param {number}                                       [opts.windowMs]      - default 10000
 * @param {number}                                       [opts.maxPerWindow]  - default 3
 * @param {number[]}                                     [opts.backoffMs]     - default [1000,2000,4000]
 * @returns {{
 *   tryRun: <T>(fn: () => Promise<T>) => Promise<{ ok: true, value: T } | { ok: false, error: string, reason?: string }>,
 *   _attempts: number[],   // exported for tests
 * }}
 */
function createPublicRpcShaper(opts) {
    opts = opts || {};
    const now = typeof opts.now === 'function' ? opts.now : () => Date.now();
    const sleep = typeof opts.sleep === 'function'
        ? opts.sleep
        : (ms) => new Promise(r => setTimeout(r, ms));
    const windowMs = typeof opts.windowMs === 'number' ? opts.windowMs : DEFAULT_WINDOW_MS;
    const maxPerWindow = typeof opts.maxPerWindow === 'number' ? opts.maxPerWindow : DEFAULT_MAX_PER_WINDOW;
    const backoffMs = Array.isArray(opts.backoffMs) ? opts.backoffMs.slice() : DEFAULT_BACKOFF_MS.slice();

    // Sliding window of call timestamps. Grows monotonically; pruned on
    // each gate check so memory stays O(maxPerWindow).
    const attempts = [];

    function pruneWindow(t) {
        const cutoff = t - windowMs;
        while (attempts.length > 0 && attempts[0] < cutoff) attempts.shift();
    }

    /**
     * Run `fn` under the rate shaper. `fn` is the actual RPC call —
     * typically a `solanaRpc('simulateTransaction', ...)` wrapper. The
     * shaper assumes `fn` rejects (throws) on transport errors and
     * either resolves with a response object or rejects with an error
     * whose `.message` includes "429" / "rate" / "limit" for 429-class
     * errors so the shaper can back off.
     */
    async function tryRun(fn) {
        // Window-based gate FIRST: don't even attempt if we've hit cap.
        const t0 = now();
        pruneWindow(t0);
        if (attempts.length >= maxPerWindow) {
            return {
                ok: false,
                error: 'rate_exhausted',
                reason: `public-rpc shaper: ${attempts.length}/${maxPerWindow} attempts already in last ${windowMs}ms; refusing to enqueue more`,
            };
        }

        // Copilot PR #398 R3: the window cap is on requests-per-window
        // (distinct caller submissions), NOT total RPC attempts including
        // retries. Push a single timestamp at the start of the call and
        // do NOT count retry attempts against the same window — otherwise
        // a single burner-sign that retries 3 times consumes the budget
        // for 10s and blocks unrelated subsequent calls.
        attempts.push(now());

        // Try with backoff retries on 429.
        let attempt = 0;
        while (true) {
            let result;
            try {
                result = await fn();
            } catch (e) {
                const msg = (e && e.message) ? String(e.message) : String(e);
                if (is429(msg) && attempt < backoffMs.length) {
                    await sleep(backoffMs[attempt]);
                    attempt++;
                    // Re-check window after sleep — other concurrent
                    // callers may have filled the window during our sleep.
                    pruneWindow(now());
                    // Copilot PR #398 R4: must be `>=`, not `>`. At exactly
                    // maxPerWindow we are AT cap, no more attempts allowed.
                    if (attempts.length >= maxPerWindow) {
                        return {
                            ok: false,
                            error: 'rate_exhausted',
                            reason: `public-rpc shaper: window cap reached during backoff (attempt ${attempt})`,
                        };
                    }
                    continue;
                }
                return {
                    ok: false,
                    error: is429(msg) ? 'rate_exhausted' : 'rpc_error',
                    reason: msg,
                };
            }
            // Success path — return whatever the wrapper produced.
            return { ok: true, value: result };
        }
    }

    return {
        tryRun,
        _attempts: attempts, // exported for unit testing
    };
}

function is429(msg) {
    if (!msg || typeof msg !== 'string') return false;
    return /\b429\b/.test(msg) || /rate ?limit/i.test(msg) || /too many requests/i.test(msg);
}

module.exports = {
    createPublicRpcShaper,
    DEFAULT_WINDOW_MS,
    DEFAULT_MAX_PER_WINDOW,
    DEFAULT_BACKOFF_MS,
    _is429: is429,
};
