#!/usr/bin/env node
// agent-pay-no-burner.test.js — BAT-582 Phase 6.
//
// Verifies that agent_pay refuses cleanly when no burner is configured AND
// makes no outbound HTTP request to the user-supplied URL. This is the
// "fail closed" property that prevents agent_pay from accidentally leaking
// fetches to attacker-supplied URLs when the agent can't actually pay.

'use strict';

const assert = require('assert');
const path = require('path');

const BUNDLE = path.resolve(__dirname, '..', '..', 'app', 'src', 'main', 'assets', 'nodejs-project');

// ── Mock config.js for transitive requires ──────────────────────────────────
const configPath = require.resolve(path.join(BUNDLE, 'config.js'));
require.cache[configPath] = {
    id: configPath,
    filename: configPath,
    loaded: true,
    exports: { BRIDGE_TOKEN: 't', log: () => {} },
};

// ── Mock bridge.js — /burner/status returns configured: false ───────────────
const bridgeCalls = [];
const bridgePath = require.resolve(path.join(BUNDLE, 'bridge.js'));
require.cache[bridgePath] = {
    id: bridgePath,
    filename: bridgePath,
    loaded: true,
    exports: {
        androidBridgeCall: async (endpoint, body) => {
            bridgeCalls.push({ endpoint, body });
            if (endpoint === '/burner/status') return { configured: false };
            return {};
        },
    },
};

// ── Stub solana.js so wallet/main-wallet.js's lazy require doesn't pull in the
// real one (which would transitively require config.js → which is stubbed).
const solanaPath = require.resolve(path.join(BUNDLE, 'solana.js'));
require.cache[solanaPath] = {
    id: solanaPath,
    filename: solanaPath,
    loaded: true,
    exports: {
        getConnectedWalletAddress: () => { throw new Error('not connected'); },
        solanaRpc: async () => ({ error: 'mocked' }),
    },
};

// ── Override agent_pay's DNS lookup so even if the test bug let through to
// the fetch path, it would fail fast rather than hitting real DNS. We assert
// AFTER the test that this hook was NOT invoked.
const agentPay = require(path.join(BUNDLE, 'tools', 'agent_pay'));
let dnsLookupCalled = 0;
agentPay._setDnsLookup(async () => {
    dnsLookupCalled++;
    throw new Error('dns lookup should not have been called');
});

// ── Override the fetch helper to detect any HTTP attempt. We can't override
// `_fetchWithLimits` itself directly (it's a closure), but the only call site
// in the no-burner branch is gated BEFORE the burner check. We assert no
// /burner/reserve, /burner/sign-transaction, /burner/commit, /burner/release
// calls happened either.

let failures = 0;
async function check(label, fn) {
    try { await fn(); console.log(`  ✓ ${label}`); }
    catch (e) { failures++; console.error(`  ✗ ${label}\n    ${e.stack || e.message}`); }
}

(async () => {
    const handle = agentPay.handlers.agent_pay;

    // ── burner not configured → burner_not_configured + no HTTP fetch ───────
    await check('agent_pay refuses with burner_not_configured + no DNS lookup', async () => {
        bridgeCalls.length = 0;
        dnsLookupCalled = 0;
        const r = await handle({ url: 'https://pay.sh/sandbox/echo', max_usdc: '0.10' });
        assert.strictEqual(r.error, 'burner_not_configured', `expected burner_not_configured, got ${JSON.stringify(r)}`);
        assert.ok(typeof r.message === 'string' && r.message.includes('Settings'),
            `error message should mention Settings → Burner Wallet, got: ${r.message}`);

        // Bridge call sequence: must have called /burner/status exactly once,
        // and ZERO of /burner/reserve, /burner/sign-transaction, /burner/commit,
        // /burner/release.
        const statusCalls = bridgeCalls.filter(c => c.endpoint === '/burner/status');
        assert.strictEqual(statusCalls.length, 1, 'should call /burner/status exactly once');

        const forbidden = ['/burner/reserve', '/burner/sign-transaction', '/burner/commit', '/burner/release'];
        for (const ep of forbidden) {
            const found = bridgeCalls.find(c => c.endpoint === ep);
            assert.strictEqual(found, undefined, `must NOT call ${ep} when burner is unconfigured`);
        }

        // CRITICAL: DNS lookup MUST NOT have been called when burner is
        // unconfigured. The pre-flight order is: cheap URL/scheme/method
        // sync check → /burner/status → DNS. So a misconfigured agent never
        // touches DNS for an attacker-supplied hostname.
        assert.strictEqual(dnsLookupCalled, 0,
            `DNS lookup must NOT be called when burner is unconfigured (was called ${dnsLookupCalled} times)`);
    });

    // ── invalid input rejected pre-flight (no bridge call at all) ────────────
    await check('agent_pay rejects missing url with invalid_input + zero bridge calls', async () => {
        bridgeCalls.length = 0;
        const r = await handle({ max_usdc: '0.10' });
        assert.strictEqual(r.error, 'invalid_input');
        assert.strictEqual(bridgeCalls.length, 0, 'must not call bridge for missing url');
    });

    await check('agent_pay rejects missing max_usdc with invalid_input + zero bridge calls', async () => {
        bridgeCalls.length = 0;
        const r = await handle({ url: 'https://example.com' });
        assert.strictEqual(r.error, 'invalid_input');
        assert.strictEqual(bridgeCalls.length, 0);
    });

    await check('agent_pay rejects malformed max_usdc with invalid_input + zero bridge calls', async () => {
        bridgeCalls.length = 0;
        const r = await handle({ url: 'https://example.com', max_usdc: 'not-a-decimal' });
        assert.strictEqual(r.error, 'invalid_input');
        assert.strictEqual(bridgeCalls.length, 0);
    });

    await check('agent_pay rejects http:// (non-debug) before bridge call', async () => {
        bridgeCalls.length = 0;
        // Ensure we're not in debug mode
        const oldEnv = process.env.NODE_ENV;
        delete process.env.NODE_ENV;
        try {
            const r = await handle({ url: 'http://example.com', max_usdc: '0.10' });
            assert.strictEqual(r.error, 'non_https');
            assert.strictEqual(bridgeCalls.length, 0, 'pre-flight rejection must skip bridge');
        } finally {
            if (oldEnv) process.env.NODE_ENV = oldEnv;
        }
    });

    await check('agent_pay rejects unparseable URL with invalid_url + zero bridge calls', async () => {
        bridgeCalls.length = 0;
        const r = await handle({ url: 'not a url at all', max_usdc: '0.10' });
        assert.strictEqual(r.error, 'invalid_url');
        assert.strictEqual(bridgeCalls.length, 0);
    });

    if (failures === 0) {
        console.log('\n✓ All agent-pay-no-burner.test.js cases passed');
        process.exit(0);
    } else {
        console.error(`\n✗ ${failures} case(s) failed`);
        process.exit(1);
    }
})();
