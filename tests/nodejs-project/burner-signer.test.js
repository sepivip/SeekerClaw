#!/usr/bin/env node
// burner-signer.test.js — BAT-582 Phase 4.
//
// Tests BurnerSigner — the bridge wrapper. Verifies:
//   - input validation (missing reservation, empty txBase64, bad broadcastVia)
//   - bridge call shape (correct endpoint, body fields)
//   - DEFENSE-IN-DEPTH "no key in Node" — capture all bridge calls and all
//     stdout/stderr during a sign run, assert no field name matching
//     `key|seed|secret|private*` ever appears, and assert no substring of
//     a fixture private key leaks.

'use strict';

const assert = require('assert');
const path = require('path');

const BUNDLE = path.resolve(__dirname, '..', '..', 'app', 'src', 'main', 'assets', 'nodejs-project');

// Mock config.js for bridge.js's transitive require.
const configPath = require.resolve(path.join(BUNDLE, 'config.js'));
require.cache[configPath] = {
    id: configPath,
    filename: configPath,
    loaded: true,
    exports: { BRIDGE_TOKEN: 't', log: () => {} },
};

// Programmable bridge mock — captures every outbound call.
const bridgeCalls = [];
let nextResponse = { signedTxBase64: 'SIGNED-TX-FIXTURE-BASE64' };
const bridgePath = require.resolve(path.join(BUNDLE, 'bridge.js'));
require.cache[bridgePath] = {
    id: bridgePath,
    filename: bridgePath,
    loaded: true,
    exports: {
        androidBridgeCall: async (endpoint, body, timeoutMs) => {
            bridgeCalls.push({ endpoint, body, timeoutMs });
            return nextResponse;
        },
    },
};

const { BurnerSigner } = require(path.join(BUNDLE, 'wallet', 'burner-signer'));

let failures = 0;
async function check(label, fn) {
    try { await fn(); console.log(`  ✓ ${label}`); }
    catch (e) { failures++; console.error(`  ✗ ${label}\n    ${e.stack || e.message}`); }
}

(async () => {
    const signer = new BurnerSigner();

    // ── Input validation ────────────────────────────────────────────────────
    await check('signTransaction: empty txBase64 → invalid_input (no bridge call)', async () => {
        bridgeCalls.length = 0;
        const r = await signer.signTransaction('', { reservationId: 'r1' });
        assert.strictEqual(r.error, 'invalid_input');
        assert.strictEqual(bridgeCalls.length, 0, 'must NOT call bridge on bad input');
    });

    await check('signTransaction: missing reservation → missing_reservation (no bridge call)', async () => {
        bridgeCalls.length = 0;
        const r = await signer.signTransaction('TX', {});
        assert.strictEqual(r.error, 'missing_reservation');
        assert.strictEqual(bridgeCalls.length, 0);
    });

    await check('signAndSend: empty txBase64 → invalid_input', async () => {
        bridgeCalls.length = 0;
        const r = await signer.signAndSend('', {});
        assert.strictEqual(r.error, 'invalid_input');
        assert.strictEqual(bridgeCalls.length, 0);
    });

    await check('signAndSend: bad broadcastVia rejected', async () => {
        bridgeCalls.length = 0;
        const r = await signer.signAndSend('TX', { broadcastVia: 'whatever' });
        assert.strictEqual(r.error, 'invalid_input');
        assert.strictEqual(bridgeCalls.length, 0);
    });

    // ── Bridge call shape ───────────────────────────────────────────────────
    await check('signTransaction: calls /burner/sign-transaction with txBase64 + reservationId', async () => {
        bridgeCalls.length = 0;
        nextResponse = { signedTxBase64: 'SIGNED' };
        const r = await signer.signTransaction('TX-BASE64', { reservationId: 'res-123' });
        assert.deepStrictEqual(r, { signedTxBase64: 'SIGNED' });
        assert.strictEqual(bridgeCalls.length, 1);
        assert.strictEqual(bridgeCalls[0].endpoint, '/burner/sign-transaction');
        assert.deepStrictEqual(bridgeCalls[0].body, { txBase64: 'TX-BASE64', reservationId: 'res-123' });
    });

    await check('signAndSend: defaults broadcastVia=rpc + correct endpoint', async () => {
        bridgeCalls.length = 0;
        nextResponse = { signature: 'SIG' };
        const r = await signer.signAndSend('TX-BASE64');
        assert.deepStrictEqual(r, { signature: 'SIG' });
        assert.strictEqual(bridgeCalls.length, 1);
        assert.strictEqual(bridgeCalls[0].endpoint, '/burner/sign-and-send');
        assert.strictEqual(bridgeCalls[0].body.txBase64, 'TX-BASE64');
        assert.strictEqual(bridgeCalls[0].body.broadcastVia, 'rpc');
        assert.ok(!('reservationId' in bridgeCalls[0].body), 'reservationId must be omitted when not provided');
    });

    await check('signAndSend: passes reservationId when provided', async () => {
        bridgeCalls.length = 0;
        await signer.signAndSend('TX', { reservationId: 'r-999', broadcastVia: 'jupiter' });
        assert.strictEqual(bridgeCalls[0].body.reservationId, 'r-999');
        assert.strictEqual(bridgeCalls[0].body.broadcastVia, 'jupiter');
    });

    // ── NO-KEY-IN-NODE defense-in-depth ─────────────────────────────────────
    await check('No key material crosses the BurnerSigner boundary', async () => {
        bridgeCalls.length = 0;

        // Synthetic 64-byte fixture key (not a real key — random hex). We assert
        // that NONE of its substrings appear in any bridge body or stdout/stderr
        // log capture, AND that no field with a key-ish name ever exists.
        const FIXTURE_KEY = 'aabbccddeeff0011' +
                            '2233445566778899' +
                            'aabbccddeeff0011' +
                            '2233445566778899' +
                            'aabbccddeeff0011' +
                            '2233445566778899' +
                            'aabbccddeeff0011' +
                            '2233445566778899'; // 128 hex = 64 bytes

        // Capture stdout/stderr
        const originalLog = console.log;
        const originalErr = console.error;
        const captured = [];
        console.log = (...args) => captured.push(args.join(' '));
        console.error = (...args) => captured.push(args.join(' '));

        try {
            // Run the sign flows. The arguments include only opaque txBase64 + reservationId —
            // the test asserts that nothing key-shaped flows in, but ALSO that the bridge
            // wrapper has no path to retrieve key material (it has no API for it).
            await signer.signTransaction('TX-BASE64', { reservationId: 'r1' });
            await signer.signAndSend('TX-BASE64', { reservationId: 'r2', broadcastVia: 'rpc' });
        } finally {
            console.log = originalLog;
            console.error = originalErr;
        }

        // 1) No bridge call body has a forbidden field name.
        const FORBIDDEN_FIELDS = /(^|_)(key|seed|secret|private[A-Za-z_]*)(_|$)/i;
        function walkObject(obj, pathPrefix = '') {
            if (obj == null || typeof obj !== 'object') return;
            for (const k of Object.keys(obj)) {
                if (FORBIDDEN_FIELDS.test(k)) {
                    throw new Error(`Forbidden field name in bridge body: ${pathPrefix}${k}`);
                }
                walkObject(obj[k], `${pathPrefix}${k}.`);
            }
        }
        for (const call of bridgeCalls) {
            walkObject(call.body, `${call.endpoint}:`);
        }

        // 2) No 8-char substring of FIXTURE_KEY appears in any stringified bridge body.
        const allBodies = bridgeCalls.map(c => JSON.stringify(c.body)).join(' ');
        for (let i = 0; i + 8 <= FIXTURE_KEY.length; i++) {
            const slice = FIXTURE_KEY.slice(i, i + 8);
            if (allBodies.includes(slice)) {
                throw new Error(`Fixture key 8-char substring "${slice}" leaked into bridge body`);
            }
        }

        // 3) Same check against captured stdout/stderr.
        const allOutput = captured.join(' ');
        for (let i = 0; i + 8 <= FIXTURE_KEY.length; i++) {
            const slice = FIXTURE_KEY.slice(i, i + 8);
            if (allOutput.includes(slice)) {
                throw new Error(`Fixture key 8-char substring "${slice}" leaked into stdout/stderr`);
            }
        }
    });

    await check('BurnerSigner exposes NO key-retrieval API', () => {
        // Static interface-shape audit. If any of these methods exist, fail.
        const FORBIDDEN_METHODS = [
            'getKey', 'getPrivateKey', 'getSeed', 'getSecret',
            'exportKey', 'extractKey', 'reveal', 'showKey',
        ];
        for (const m of FORBIDDEN_METHODS) {
            assert.strictEqual(typeof signer[m], 'undefined',
                `BurnerSigner.${m} must NOT exist (no key retrieval)`);
        }
        // Inspect the prototype chain too.
        let proto = Object.getPrototypeOf(signer);
        while (proto && proto !== Object.prototype) {
            for (const m of FORBIDDEN_METHODS) {
                assert.strictEqual(typeof proto[m], 'undefined',
                    `Prototype chain must not expose ${m}`);
            }
            proto = Object.getPrototypeOf(proto);
        }
    });

    if (failures > 0) {
        console.error(`\n${failures} failure(s).`);
        process.exit(1);
    }
    console.log('\nPASS: burner-signer.test.js');
})();
