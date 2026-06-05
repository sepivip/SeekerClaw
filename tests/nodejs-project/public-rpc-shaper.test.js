// tests/nodejs-project/public-rpc-shaper.test.js
//
// BAT-1013 v8.1 amendment #6: public-RPC rate shaper.
// Pure module with injected clock + sleep — fully deterministic.

'use strict';

const assert = require('assert');
const path = require('path');

const BUNDLE = path.resolve(__dirname, '..', '..', 'app', 'src', 'main', 'assets', 'nodejs-project');
const { createPublicRpcShaper, _is429 } = require(path.join(BUNDLE, 'wallet', 'public-rpc-shaper.js'));

let pass = 0, fail = 0;
async function runAsync(name, fn) {
    try {
        await fn();
        pass++;
        console.log(`  ✓ ${name}`);
    } catch (e) {
        fail++;
        console.error(`  ✗ ${name}: ${e.message}`);
        if (process.env.VERBOSE) console.error(e.stack);
    }
}
function check(name, fn) {
    try {
        fn();
        pass++;
        console.log(`  ✓ ${name}`);
    } catch (e) {
        fail++;
        console.error(`  ✗ ${name}: ${e.message}`);
    }
}

(async function main() {
    console.log('public-rpc-shaper.test.js — wallet/public-rpc-shaper.js');
    console.log();

    console.log('_is429');
    check('matches "429"', () => assert.strictEqual(_is429('HTTP 429: too many'), true));
    check('matches "rate limit"', () => assert.strictEqual(_is429('rate limit exceeded'), true));
    check('matches "Too Many Requests"', () => assert.strictEqual(_is429('Too Many Requests'), true));
    check('does NOT match unrelated errors', () => assert.strictEqual(_is429('ECONNRESET'), false));
    check('handles null safely', () => assert.strictEqual(_is429(null), false));

    console.log();
    console.log('window cap (≤3 per 10s)');
    await runAsync('allows 3 calls in window', async () => {
        let t = 1000;
        const s = createPublicRpcShaper({ now: () => t, sleep: async () => {} });
        const r1 = await s.tryRun(async () => 'A'); t += 100;
        const r2 = await s.tryRun(async () => 'B'); t += 100;
        const r3 = await s.tryRun(async () => 'C');
        assert.strictEqual(r1.ok, true);
        assert.strictEqual(r2.ok, true);
        assert.strictEqual(r3.ok, true);
    });
    await runAsync('refuses 4th call within window', async () => {
        let t = 1000;
        const s = createPublicRpcShaper({ now: () => t, sleep: async () => {} });
        await s.tryRun(async () => 'A'); t += 100;
        await s.tryRun(async () => 'B'); t += 100;
        await s.tryRun(async () => 'C'); t += 100;
        const r4 = await s.tryRun(async () => 'D');
        assert.strictEqual(r4.ok, false);
        assert.strictEqual(r4.error, 'rate_exhausted');
        assert.match(r4.reason, /attempts already in last/);
    });
    await runAsync('allows new call after window slides past', async () => {
        let t = 1000;
        const s = createPublicRpcShaper({ now: () => t, sleep: async () => {} });
        await s.tryRun(async () => 'A'); t += 100;
        await s.tryRun(async () => 'B'); t += 100;
        await s.tryRun(async () => 'C');
        // Advance past the window
        t += 15_000;
        const r4 = await s.tryRun(async () => 'D');
        assert.strictEqual(r4.ok, true);
        assert.strictEqual(r4.value, 'D');
    });

    console.log();
    console.log('429 backoff');
    await runAsync('backs off on 429 then retries successfully', async () => {
        let t = 1000;
        const slept = [];
        const s = createPublicRpcShaper({
            now: () => t,
            sleep: async (ms) => { slept.push(ms); t += ms; },
        });
        let attempts = 0;
        const fn = async () => {
            attempts++;
            if (attempts === 1) throw new Error('HTTP 429: too many');
            return 'OK';
        };
        const r = await s.tryRun(fn);
        assert.strictEqual(r.ok, true);
        assert.strictEqual(r.value, 'OK');
        assert.strictEqual(attempts, 2);
        assert.deepStrictEqual(slept, [1000]); // first backoff = 1s
    });
    await runAsync('exhausts 3 backoffs then returns rate_exhausted', async () => {
        let t = 1000;
        const slept = [];
        const s = createPublicRpcShaper({
            now: () => t,
            sleep: async (ms) => { slept.push(ms); t += ms; },
        });
        const fn = async () => { throw new Error('429'); };
        const r = await s.tryRun(fn);
        assert.strictEqual(r.ok, false);
        // backoffs: 1s, 2s, 4s (=7s total) — all 3 attempts hit 429 then window
        // still has capacity but no more backoffs left so the final throw
        // propagates as rate_exhausted (since msg matches 429).
        assert.strictEqual(r.error, 'rate_exhausted');
        assert.deepStrictEqual(slept, [1000, 2000, 4000]);
    });
    await runAsync('non-429 error returns rpc_error without retry', async () => {
        let t = 1000;
        const slept = [];
        const s = createPublicRpcShaper({
            now: () => t,
            sleep: async (ms) => { slept.push(ms); t += ms; },
        });
        const fn = async () => { throw new Error('ECONNRESET'); };
        const r = await s.tryRun(fn);
        assert.strictEqual(r.ok, false);
        assert.strictEqual(r.error, 'rpc_error');
        assert.deepStrictEqual(slept, []); // no backoff for non-429
    });

    // C13: Concurrency invariant. Two distinct properties matter under
    // overlapping caller submissions:
    //   (a) Four concurrent submissions to the SAME shaper instance must
    //       share the per-window cap — only 3 succeed, the 4th hits
    //       rate_exhausted up front. The window slot is claimed BEFORE
    //       the inner fn runs.
    //   (b) A single submission whose inner fn retries internally must
    //       NOT push a second window slot for the retry (the cap is on
    //       caller submissions, not RPC attempts).
    console.log();
    console.log('C13 concurrency');

    await runAsync('4 concurrent tryRun submissions share the window cap (only 3 succeed)', async () => {
        let t = 1000;
        // Inner fn resolves after a Promise barrier so all four are mid-flight
        // when the shaper makes its admission decision.
        let release;
        const barrier = new Promise(r => { release = r; });
        const s = createPublicRpcShaper({
            now: () => t,
            sleep: async () => {},
        });

        const fn = async () => {
            await barrier;
            return 'OK';
        };

        // Fire all four submissions at once, BEFORE awaiting any.
        const promises = [s.tryRun(fn), s.tryRun(fn), s.tryRun(fn), s.tryRun(fn)];
        // Let the gate decisions land (push timestamps into `attempts`) before
        // we release the inner fns. Two microtask ticks is enough — the
        // window gate is sync, only the `await fn()` is async.
        await Promise.resolve();
        await Promise.resolve();
        // Release the barrier so the 3 admitted fns can resolve.
        release();

        const results = await Promise.all(promises);
        const ok = results.filter(r => r.ok);
        const rejected = results.filter(r => !r.ok);
        assert.strictEqual(ok.length, 3, `expected 3 ok results, got ${ok.length}: ${JSON.stringify(results)}`);
        assert.strictEqual(rejected.length, 1, `expected 1 rejection, got ${rejected.length}`);
        assert.strictEqual(rejected[0].error, 'rate_exhausted');
        assert.match(rejected[0].reason, /attempts already in last/);
    });

    await runAsync('retry inside a single submission does NOT consume a second window slot', async () => {
        let t = 1000;
        const slept = [];
        const s = createPublicRpcShaper({
            now: () => t,
            sleep: async (ms) => { slept.push(ms); t += ms; },
        });

        let calls = 0;
        const fn = async () => {
            calls++;
            if (calls < 3) throw new Error('HTTP 429');
            return 'OK';
        };
        const r = await s.tryRun(fn);
        assert.strictEqual(r.ok, true);
        assert.strictEqual(r.value, 'OK');
        assert.strictEqual(calls, 3);
        // Internal attempts log must show ONE slot for the single caller
        // submission, NOT three (one per RPC attempt).
        assert.strictEqual(s._attempts.length, 1, `expected 1 slot for 1 caller submission; got ${s._attempts.length}`);
        // Backoffs follow the 1s, 2s, 4s schedule for the two retries.
        assert.deepStrictEqual(slept, [1000, 2000]);
    });

    await runAsync('three sequential successful calls each push exactly one slot', async () => {
        let t = 1000;
        const s = createPublicRpcShaper({ now: () => t, sleep: async () => {} });
        await s.tryRun(async () => 'A'); t += 1;
        await s.tryRun(async () => 'B'); t += 1;
        await s.tryRun(async () => 'C');
        assert.strictEqual(s._attempts.length, 3,
            `expected 3 slots after 3 successful submissions, got ${s._attempts.length}`);
        const r4 = await s.tryRun(async () => 'D');
        assert.strictEqual(r4.ok, false);
        assert.strictEqual(r4.error, 'rate_exhausted');
    });

    // ── R11/R12 regression (Copilot PR #398, lines 115 + 120) ──────────────
    // A submission that has already consumed its window slot must NOT be
    // aborted by a post-backoff window re-check that counts the submission's
    // own slot. The buggy code re-pruned the window after each 429 backoff
    // and rejected when attempts.length >= maxPerWindow — which is true by
    // definition if (a) the submission is alone in the window OR (b) two
    // other submissions filled the remaining slots during the sleep.
    // The R12 fix removes the post-backoff re-check entirely.
    console.log();
    console.log('R11/R12 regression — submission owns its slot through all retries');

    await runAsync('R11: single submission with maxPerWindow=1 exhausts full backoff before giving up', async () => {
        let t = 1000;
        const slept = [];
        const s = createPublicRpcShaper({
            now: () => t,
            sleep: async (ms) => { slept.push(ms); t += ms; },
            maxPerWindow: 1,
        });
        const fn = async () => { throw new Error('429'); };
        const r = await s.tryRun(fn);
        assert.strictEqual(r.ok, false);
        assert.strictEqual(r.error, 'rate_exhausted');
        // Buggy code: slept == [1000] (aborted after 1st backoff re-check).
        // Fixed code: slept == [1000, 2000, 4000] (all 3 backoffs exhausted).
        assert.deepStrictEqual(slept, [1000, 2000, 4000],
            `R11/R12 bug: post-backoff re-check aborted submission after ${slept.length} backoff(s) instead of 3`);
    });

    await runAsync('R11: single submission with maxPerWindow=1 succeeds on 2nd attempt', async () => {
        let t = 1000;
        const slept = [];
        const s = createPublicRpcShaper({
            now: () => t,
            sleep: async (ms) => { slept.push(ms); t += ms; },
            maxPerWindow: 1,
        });
        let calls = 0;
        const fn = async () => {
            calls++;
            if (calls === 1) throw new Error('429');
            return 'resolved';
        };
        const r = await s.tryRun(fn);
        assert.strictEqual(r.ok, true,
            `R11/R12 bug: submission aborted during backoff even though retry was available; error=${r.error}`);
        assert.strictEqual(r.value, 'resolved');
        assert.strictEqual(calls, 2);
        assert.deepStrictEqual(slept, [1000]);
    });

    await runAsync('R12: submission keeps slot even when 2 concurrent slots arrive during backoff sleep', async () => {
        let t = 1000;
        const slept = [];
        let sRef = null;
        const s = createPublicRpcShaper({
            now: () => t,
            sleep: async (ms) => {
                slept.push(ms);
                t += ms;
                // Simulate B and C being admitted during A's sleep by
                // pushing their timestamps directly into the shared
                // attempts array.
                sRef._attempts.push(t - 300);
                sRef._attempts.push(t - 100);
            },
            maxPerWindow: 3,
        });
        sRef = s;
        let calls = 0;
        const fn = async () => {
            calls++;
            if (calls === 1) throw new Error('HTTP 429');
            return 'after_concurrent_fill';
        };
        const r = await s.tryRun(fn);
        assert.strictEqual(r.ok, true,
            `R12 bug: submission evicted mid-retry because concurrent slots filled window; error=${r.error}`);
        assert.strictEqual(r.value, 'after_concurrent_fill');
        assert.strictEqual(calls, 2, 'fn should have been called exactly twice (initial + 1 retry)');
        assert.deepStrictEqual(slept, [1000]);
    });

    console.log();
    console.log(`Result: ${pass} passed, ${fail} failed`);
    if (fail > 0) process.exit(1);
    console.log('PASS: public-rpc-shaper.test.js');
})();
