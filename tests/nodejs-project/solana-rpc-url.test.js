// BAT-1000 — Helius as Solana RPC primary path.
//
// Pins the contract from the BAT-1000 v1.1 Codex sign-off:
//
//   • Codex #1 — query string MUST be preserved when calling Helius. Tests
//     mock https.request and assert the captured options include
//     `hostname: mainnet.helius-rpc.com` AND `path: /?api-key=…` (encoded).
//     Reverting `solanaRpcOnce()`'s `path: (url.pathname || '/') + url.search`
//     back to `path: url.pathname` (the v1 bug) fails these tests.
//
//   • URL builder matrix: set / unset / blank-string / whitespace-only /
//     special-chars-in-key — all return the expected URL.
//
//   • Hot-reload — mutating config.heliusApiKey between calls flips the
//     URL on the next call (no startup freeze).
//
//   • Codex #5 — only `solanaRpcOnce()` is the URL-aware primitive. All
//     RPC-consuming tools (solana_balance, _send, _history, etc.) flow
//     through it; a regression check makes sure no caller hand-rolls its
//     own URL.

'use strict';

const assert = require('assert');
const path = require('path');

const BUNDLE = path.resolve(__dirname, '..', '..', 'app', 'src', 'main', 'assets', 'nodejs-project');

// ── Mock config so solana.js reads our values ─────────────────────────────
const configPath = require.resolve(path.join(BUNDLE, 'config.js'));
const fakeConfig = { heliusApiKey: '', jupiterApiKey: 'fake-jupiter-key' };
require.cache[configPath] = {
    id: configPath,
    filename: configPath,
    loaded: true,
    exports: {
        log: () => {},
        config: fakeConfig,
        workDir: '/tmp',
    },
};

// ── Mock bridge so the require chain loads (solana.js requires bridge.js) ─
const bridgePath = require.resolve(path.join(BUNDLE, 'bridge.js'));
require.cache[bridgePath] = {
    id: bridgePath,
    filename: bridgePath,
    loaded: true,
    exports: { androidBridgeCall: async () => ({ error: 'not mocked' }) },
};

// ── Mock http.js (used by other solana.js helpers; not under test here) ──
const httpPath = require.resolve(path.join(BUNDLE, 'http.js'));
require.cache[httpPath] = {
    id: httpPath,
    filename: httpPath,
    loaded: true,
    exports: { httpRequest: async () => ({ status: 0, data: null }) },
};

// ── Intercept https.request so we can assert the outbound options ────────
const https = require('https');
const capturedRequests = [];
const _origRequest = https.request;
function _installHttpsCapture() {
    https.request = function patched(opts, cb) {
        capturedRequests.push(JSON.parse(JSON.stringify({
            hostname: opts.hostname,
            port: opts.port,
            path: opts.path,
            method: opts.method,
            headers: { ...opts.headers }, // shallow clone
        })));
        // Fake response: empty body, ends immediately, so solanaRpcOnce's
        // `JSON.parse('')` throws → resolves with `{ error: 'Invalid RPC
        // response' }`. We don't care about the response here — we're only
        // verifying the outbound options.
        const req = {
            on() { return req; },
            write() {},
            end() {
                process.nextTick(() => {
                    const fakeRes = {
                        setEncoding() {},
                        on(evt, h) {
                            if (evt === 'end') process.nextTick(h);
                            return fakeRes;
                        },
                    };
                    cb(fakeRes);
                });
            },
            destroy() {},
        };
        return req;
    };
}
function _restoreHttps() { https.request = _origRequest; }

_installHttpsCapture();

// solana.js stores the `https` module via `const https = require('https')` and
// calls `https.request(...)` at use-site (not destructured) — so the patched
// `https.request` is picked up on each call. Require solana.js AFTER the
// capture is installed for clarity, though the patch would still take effect
// at call time even if required earlier.
const solana = require(path.join(BUNDLE, 'solana.js'));

let failures = 0;
async function check(label, fn) {
    try { await fn(); console.log(`  ✓ ${label}`); }
    catch (e) { failures++; console.error(`  ✗ ${label}\n    ${(e.stack || e.message).split('\n').slice(0, 4).join('\n    ')}`); }
}

function _reset() {
    capturedRequests.length = 0;
    fakeConfig.heliusApiKey = '';
}

(async () => {
    console.log('[BAT-1000] solana-rpc-url.test.js');
    console.log('');
    console.log('Layer 1 — getSolanaRpcUrl() builder matrix');

    const { getSolanaRpcUrl, solanaRpcOnce } = solana;

    await check('exports getSolanaRpcUrl + solanaRpcOnce', async () => {
        assert.strictEqual(typeof getSolanaRpcUrl, 'function');
        assert.strictEqual(typeof solanaRpcOnce, 'function');
    });

    await check('returns public RPC when heliusApiKey is undefined', async () => {
        _reset();
        delete fakeConfig.heliusApiKey;
        assert.strictEqual(getSolanaRpcUrl(), 'https://api.mainnet-beta.solana.com');
    });

    await check('returns public RPC when heliusApiKey is null', async () => {
        _reset();
        fakeConfig.heliusApiKey = null;
        assert.strictEqual(getSolanaRpcUrl(), 'https://api.mainnet-beta.solana.com');
    });

    await check('returns public RPC when heliusApiKey is empty string', async () => {
        _reset();
        fakeConfig.heliusApiKey = '';
        assert.strictEqual(getSolanaRpcUrl(), 'https://api.mainnet-beta.solana.com');
    });

    await check('returns public RPC when heliusApiKey is whitespace-only', async () => {
        _reset();
        fakeConfig.heliusApiKey = '   \t \n  ';
        assert.strictEqual(getSolanaRpcUrl(), 'https://api.mainnet-beta.solana.com');
    });

    await check('returns Helius URL when heliusApiKey is set', async () => {
        _reset();
        fakeConfig.heliusApiKey = 'abc123-def456';
        assert.strictEqual(getSolanaRpcUrl(), 'https://mainnet.helius-rpc.com/?api-key=abc123-def456');
    });

    await check('trims surrounding whitespace before building URL', async () => {
        _reset();
        fakeConfig.heliusApiKey = '   real-key-here   ';
        assert.strictEqual(getSolanaRpcUrl(), 'https://mainnet.helius-rpc.com/?api-key=real-key-here');
    });

    await check('URL-encodes special characters in the key (defense even though Helius keys are alphanumeric)', async () => {
        _reset();
        fakeConfig.heliusApiKey = 'key with spaces & symbols=!';
        const url = getSolanaRpcUrl();
        assert.ok(url.includes('api-key=key%20with%20spaces%20%26%20symbols%3D!'),
            `URL should URL-encode special chars; got: ${url}`);
    });

    console.log('');
    console.log('Layer 2 — hot-reload (per-call evaluation)');

    await check('returns FRESH URL on each call (no startup freeze)', async () => {
        _reset();
        fakeConfig.heliusApiKey = 'key-one';
        const url1 = getSolanaRpcUrl();
        fakeConfig.heliusApiKey = 'key-two';
        const url2 = getSolanaRpcUrl();
        assert.notStrictEqual(url1, url2);
        assert.ok(url1.includes('key-one'));
        assert.ok(url2.includes('key-two'));
    });

    await check('toggling unset → set → unset all flow per call', async () => {
        _reset();
        const u1 = getSolanaRpcUrl();
        fakeConfig.heliusApiKey = 'mid-key';
        const u2 = getSolanaRpcUrl();
        fakeConfig.heliusApiKey = '';
        const u3 = getSolanaRpcUrl();
        assert.strictEqual(u1, 'https://api.mainnet-beta.solana.com');
        assert.strictEqual(u2, 'https://mainnet.helius-rpc.com/?api-key=mid-key');
        assert.strictEqual(u3, 'https://api.mainnet-beta.solana.com');
    });

    console.log('');
    console.log('Layer 3 — Codex #1: outbound https.request preserves the query string');

    await check('CONTRACT — solanaRpcOnce with Helius key sends path "/?api-key=…" (NOT just "/")', async () => {
        _reset();
        fakeConfig.heliusApiKey = 'codex-test-key';
        await solanaRpcOnce('getBalance', ['SomePubkey']);
        assert.strictEqual(capturedRequests.length, 1, 'expected exactly one outbound request');
        const req = capturedRequests[0];
        assert.strictEqual(req.hostname, 'mainnet.helius-rpc.com',
            `hostname mismatch — got ${req.hostname}, expected mainnet.helius-rpc.com`);
        assert.match(req.path, /^\/\?api-key=codex-test-key$/,
            `path MUST preserve the query string. Got: "${req.path}". A path of just "/" means solanaRpcOnce reverted to the v1 bug (url.pathname-only) and silently dropped the API key — re-introducing the Codex #1 query-string trap.`);
        assert.strictEqual(req.method, 'POST');
    });

    await check('CONTRACT — solanaRpcOnce with NO Helius key still hits public RPC (path "/")', async () => {
        _reset();
        // Unset
        delete fakeConfig.heliusApiKey;
        await solanaRpcOnce('getBalance', ['SomePubkey']);
        assert.strictEqual(capturedRequests.length, 1);
        const req = capturedRequests[0];
        assert.strictEqual(req.hostname, 'api.mainnet-beta.solana.com');
        // Public RPC URL has no query string; pathname is '/' → path is '/'.
        assert.strictEqual(req.path, '/');
    });

    await check('CONTRACT — special chars in key survive URL-encoding in the outbound path', async () => {
        _reset();
        fakeConfig.heliusApiKey = 'a&b=c d';
        await solanaRpcOnce('getBalance', []);
        const req = capturedRequests[0];
        assert.match(req.path, /^\/\?api-key=a%26b%3Dc%20d$/);
    });

    console.log('');
    console.log('Layer 4 — hot-reload through solanaRpcOnce (not just through builder)');

    await check('two back-to-back solanaRpcOnce calls with key change in between use different hostnames', async () => {
        _reset();
        fakeConfig.heliusApiKey = 'first';
        await solanaRpcOnce('getBalance', []);
        fakeConfig.heliusApiKey = 'second';
        await solanaRpcOnce('getBalance', []);
        assert.strictEqual(capturedRequests.length, 2);
        assert.match(capturedRequests[0].path, /api-key=first/);
        assert.match(capturedRequests[1].path, /api-key=second/);
        // Both go to Helius hostname.
        assert.strictEqual(capturedRequests[0].hostname, 'mainnet.helius-rpc.com');
        assert.strictEqual(capturedRequests[1].hostname, 'mainnet.helius-rpc.com');
    });

    await check('switching from set to unset between calls flips hostname back to public', async () => {
        _reset();
        fakeConfig.heliusApiKey = 'about-to-clear';
        await solanaRpcOnce('getBalance', []);
        fakeConfig.heliusApiKey = '';
        await solanaRpcOnce('getBalance', []);
        assert.strictEqual(capturedRequests[0].hostname, 'mainnet.helius-rpc.com');
        assert.strictEqual(capturedRequests[1].hostname, 'api.mainnet-beta.solana.com');
    });

    console.log('');
    console.log('Layer 5 — Codex #5: only solanaRpcOnce builds the URL');

    await check('REGRESSION — solana.js source has no NEW hardcoded mainnet-beta or helius-rpc.com URLs', async () => {
        // Source-level grep baseline as of BAT-1000:
        //   • api.mainnet-beta.solana.com: 1 (PUBLIC_SOLANA_RPC_URL const)
        //     Plus 1 comment mention = 2 total.
        //   • mainnet.helius-rpc.com: 1 doc comment + 1 in getSolanaRpcUrl() +
        //     1 pre-existing BAT-319 NFT DAS helper (different code path,
        //     intentionally left alone per Codex #5 scope discipline) = 3.
        // If a future commit adds yet another hardcoded URL elsewhere
        // (sidestepping getSolanaRpcUrl()), the count climbs above these
        // baselines and this test fires.
        const fs = require('fs');
        const src = fs.readFileSync(path.join(BUNDLE, 'solana.js'), 'utf8');

        const mainnetMatches = (src.match(/api\.mainnet-beta\.solana\.com/g) || []).length;
        assert.ok(mainnetMatches <= 2,
            `expected ≤ 2 mentions of api.mainnet-beta.solana.com (PUBLIC_SOLANA_RPC_URL const + JSDoc/comment). Got ${mainnetMatches}. A new hardcoded URL would bypass the Helius override.`);

        const heliusMatches = (src.match(/mainnet\.helius-rpc\.com/g) || []).length;
        assert.ok(heliusMatches <= 3,
            `expected ≤ 3 mentions of mainnet.helius-rpc.com (getSolanaRpcUrl + doc comment + pre-existing BAT-319 NFT DAS helper). Got ${heliusMatches}. A new hardcoded URL would bypass getSolanaRpcUrl().`);
    });

    _restoreHttps();

    console.log('');
    if (failures > 0) {
        console.error(`FAILED: ${failures} test(s) failed`);
        process.exit(1);
    }
    console.log(`All BAT-1000 solana-rpc-url tests passed.`);
})().catch((e) => {
    _restoreHttps();
    console.error('Test runner crashed:', e);
    process.exit(1);
});
