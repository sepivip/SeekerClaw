#!/usr/bin/env node
// tests/nodejs-project/solana-dca-routing.test.js
//
// BAT-1031 v1.2 §C4 nit #4 (Codex amendment) — DCA routing regression.
//
// CONTRACT
// --------
// The V2 DCA producer (tools/solana.js → jupiter_dca_create) MUST:
//   1. Hardcode dcaForceRouting = { routingDecision: 'main' } before
//      handing off to routeAndSign, so the burner cannot autonomously
//      sign a DCA deposit until vault discovery ships.
//   2. Pass expectedDelta: null to routeAndSign — DCA deposits skip the
//      burner-policy gate entirely (MWA-only path, no burner debit to
//      validate pre-sign).
//   3. NEVER declare signerMode: 'burner_only' inside the producer block.
//   4. NEVER emit a 'jupiter_dca_create_deposit' delta kind (that kind
//      belongs to jupiter_trigger_create_deposit per BAT-1031, not DCA).
//
// This test is a STATIC DRIFT ASSERTION against tools/solana.js. The
// producer block depends on config.js, caps/preflight, the Jupiter API,
// the Android bridge, the on-device wallet, and ten other modules — a
// runtime exercise of jupiter_dca_create would need to fake all of them
// and would couple the test to that mock surface rather than to the
// routing invariant we care about. Per BAT-1031 v1.2 sign-off, a
// routing-layer drift assertion is acceptable here: the invariant lives
// at the producer source level (hardcoded `{ routingDecision: 'main' }`
// + `expectedDelta: null` literal), so source-level inspection is the
// most direct check.
//
// If anyone tries to flip the DCA producer to burner-autonomous before
// the vault-discovery follow-up lands (the BAT-XXXX TODO Codex called
// out in v8.3 of the BAT-1013 contract), this test fails and the change
// cannot push past pre-push-check.sh.
//
// Pattern mirrors burner-policy.test.js (harness, header, footer).

'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');

const BUNDLE = path.resolve(__dirname, '..', '..', 'app', 'src', 'main', 'assets', 'nodejs-project');
const SOLANA_TOOLS_PATH = path.join(BUNDLE, 'tools', 'solana.js');

// ─── Test harness ─────────────────────────────────────────────────────────

// All invariants in this file are synchronous source-string regex
// assertions. The test does perform synchronous disk I/O (fs.readFileSync
// against tools/solana.js once at startup), but no network I/O, no
// Jupiter API roundtrip, no Android bridge, no async work of any kind.
// Keep check() strictly synchronous so a future maintainer can't
// accidentally introduce an async invariant whose failure is silently
// swallowed by an unawaited Promise. If a real async case becomes
// necessary, mirror the runAsync() pattern from burner-policy.test.js
// and explicitly await it from main().
let pass = 0, fail = 0;
function check(name, fn) {
    try {
        const r = fn();
        if (r && typeof r.then === 'function') {
            throw new Error(
                `${name}: this test harness is synchronous-only — async test ` +
                `bodies are not supported here. Move the test to a runAsync() ` +
                `pattern (see burner-policy.test.js) if you need async semantics.`,
            );
        }
        pass++;
        console.log(`  ✓ ${name}`);
    } catch (e) {
        fail++;
        console.error(`  ✗ ${name}: ${e.message}`);
        if (process.env.VERBOSE) console.error(e.stack);
    }
}

// ─── Source slicing ───────────────────────────────────────────────────────

// Slice the source between `async jupiter_dca_create(` and the next sibling
// method `async jupiter_dca_list(`. We assert on the slice rather than on
// the whole file so we don't accidentally match `dcaForceRouting` text in
// an unrelated tool (defense against future producers being added that
// legitimately mention DCA in passing).
function loadDcaProducerSlice() {
    if (!fs.existsSync(SOLANA_TOOLS_PATH)) {
        throw new Error(`tools/solana.js not found at ${SOLANA_TOOLS_PATH}`);
    }
    const src = fs.readFileSync(SOLANA_TOOLS_PATH, 'utf8');
    const startMarker = 'async jupiter_dca_create(';
    const endMarker = 'async jupiter_dca_list(';
    const startIdx = src.indexOf(startMarker);
    const endIdx = src.indexOf(endMarker, startIdx + startMarker.length);
    if (startIdx < 0) {
        throw new Error(
            `jupiter_dca_create producer not found in tools/solana.js — ` +
            `if the entry point was renamed, update solana-dca-routing.test.js to match.`
        );
    }
    if (endIdx < 0) {
        throw new Error(
            `jupiter_dca_list sibling marker not found — cannot bound the ` +
            `jupiter_dca_create slice. Refusing to assert on the whole file.`
        );
    }
    return { src, slice: src.slice(startIdx, endIdx), startIdx, endIdx };
}

(function main() {
    console.log('solana-dca-routing.test.js — V2 DCA producer routing contract (BAT-1031 v1.2 §C4)');
    console.log();

    let producer;
    check('jupiter_dca_create producer slice can be extracted', () => {
        producer = loadDcaProducerSlice();
        assert.ok(producer.slice.length > 0, 'slice should be non-empty');
        // Sanity: the slice must be much shorter than the whole file
        // (otherwise the end marker matched something far away).
        assert.ok(
            producer.slice.length < producer.src.length,
            'slice should be a strict subset of the source'
        );
        // And large enough to include the routing block (~300 lines of body).
        assert.ok(
            producer.slice.length > 2000,
            `slice unexpectedly small (${producer.slice.length} chars) — boundary markers likely matched the wrong span`
        );
    });

    console.log();
    console.log('Routing invariants (BAT-1031 v1.2 §C4 nit #4)');

    check('Invariant 1: dcaForceRouting hardcoded to { routingDecision: \'main\' }', () => {
        // The literal we ship today (tools/solana.js ~line 2769):
        //   const dcaForceRouting = { routingDecision: 'main' };
        // We allow benign whitespace variation but pin the keyword and value.
        const re = /const\s+dcaForceRouting\s*=\s*\{\s*routingDecision\s*:\s*['"]main['"]\s*\}\s*;/;
        assert.ok(
            re.test(producer.slice),
            `dcaForceRouting must be assigned literal { routingDecision: 'main' }. ` +
            `If routing was made dynamic, the burner-autonomous path is now possible ` +
            `for DCA deposits, which violates BAT-1013 Phase 3c (vault discovery has ` +
            `not shipped). Re-open BAT-XXXX before relaxing this invariant.`
        );
    });

    check('Invariant 2: dcaForceRouting is the value passed to routeAndSign forceRouting', () => {
        // The producer must wire its hardcoded routing decision into the
        // routeAndSign call. A regression where dcaForceRouting is computed
        // but forceRouting receives some other value (e.g., dcaRoutingHint)
        // would silently re-enable burner routing.
        const re = /forceRouting\s*:\s*dcaForceRouting\b/;
        assert.ok(
            re.test(producer.slice),
            `routeAndSign({ ..., forceRouting: dcaForceRouting, ... }) is required. ` +
            `Found a routeAndSign call but forceRouting was not wired to ` +
            `dcaForceRouting — the hardcoded 'main' decision is being discarded.`
        );
    });

    check('Invariant 3: expectedDelta is literal null on the routeAndSign call', () => {
        // DCA deposits have no policy gate (the destination DCA position
        // account is not known pre-sign), so expectedDelta MUST be null.
        // Any non-null expectedDelta in this block means a future maintainer
        // tried to fabricate a delta — fail closed.
        // BAT-1060 / CR #414: extract the routeAndSign({...}) call's argument object
        // by brace-matching (it contains a nested broadcast callback), then require
        // expectedDelta:null WITHIN it. A `[\s\S]*?` regex could cross the call's
        // closing }) and match a later expectedDelta:null elsewhere in the slice.
        const callIdx = producer.slice.indexOf('routeAndSign(');
        assert.notStrictEqual(callIdx, -1, 'routeAndSign(...) call must exist in the DCA producer');
        let depth = 0, end = -1;
        for (let i = producer.slice.indexOf('{', callIdx); i >= 0 && i < producer.slice.length; i++) {
            const ch = producer.slice[i];
            if (ch === '{') depth++;
            else if (ch === '}') { depth--; if (depth === 0) { end = i; break; } }
        }
        assert.notStrictEqual(end, -1, 'routeAndSign call object must be brace-balanced');
        const callArgs = producer.slice.slice(callIdx, end + 1);
        assert.ok(
            /expectedDelta\s*:\s*null\b/.test(callArgs),
            `expectedDelta: null is required INSIDE the routeAndSign({...}) call in jupiter_dca_create. ` +
            `A non-null (or missing) expectedDelta implies pre-sign policy validation of a deposit ` +
            `destination that cannot be verified — re-read BAT-1013 v8.3 Codex review.`
        );
    });

    check('Invariant 4: no signerMode: \'burner_only\' anywhere in the producer slice', () => {
        // The DCA producer must not declare burner_only signerMode — the
        // routing decision is fixed to 'main' so the burner never signs.
        // If this string appears, someone is staging a burner-autonomous
        // DCA path before the destination-assertion follow-up is done.
        const re = /signerMode\s*:\s*['"]burner_only['"]/;
        assert.ok(
            !re.test(producer.slice),
            `signerMode: 'burner_only' appeared inside jupiter_dca_create — ` +
            `the DCA producer must not declare burner_only until vault discovery ` +
            `ships and a destination assertion exists for the DCA position account.`
        );
    });

    check('Invariant 5: no \'jupiter_dca_create_deposit\' delta kind emitted from the DCA producer', () => {
        // jupiter_dca_create_deposit IS a registered delta kind in
        // wallet/burner-policy.js DELTA_KINDS (line ~256) — the policy
        // layer KNOWS this shape and has a validateExpectedDeltaShape case
        // for it. What this invariant pins is the orthogonal contract:
        // the DCA producer must NEVER actually emit that delta kind from
        // its expectedDelta construction site, because emission would imply
        // an attempt to run autonomous burner signing for DCA before vault
        // discovery ships. The kind exists for forward-compat with a future
        // BAT-XXXX that wires DCA-on-burner; today the producer must stay
        // on dcaForceRouting='main' + expectedDelta: null.
        const re = /['"]jupiter_dca_create_deposit['"]/;
        assert.ok(
            !re.test(producer.slice),
            `'jupiter_dca_create_deposit' literal appeared inside jupiter_dca_create. ` +
            `The kind IS registered in burner-policy.js DELTA_KINDS, but the DCA ` +
            `producer must not emit it until vault discovery and a destination ` +
            `assertion are in place. Either remove the literal or open a follow-up ` +
            `to enable DCA-on-burner with the proper safety guarantees.`
        );
    });

    check('Invariant 6: no burnerDebit field constructed inside the producer slice', () => {
        // A burnerDebit object is what jupiter_trigger_create_deposit emits.
        // DCA must not emit one — the deposit at DCA create time does not
        // route to a burner-controlled account. Catching this string defends
        // against the "copy-paste from trigger producer" failure mode.
        const re = /burnerDebit\s*:/;
        assert.ok(
            !re.test(producer.slice),
            `burnerDebit field appeared inside jupiter_dca_create — that field ` +
            `belongs to jupiter_trigger_create_deposit (BAT-1031), not the DCA producer. ` +
            `DCA flows through main wallet without a burner-side debit declaration.`
        );
    });

    check('Invariant 7: dcaRoutingHint is computed but does not feed forceRouting', () => {
        // The producer DOES still compute a routing hint (for telemetry /
        // future-proofing), but that hint must NEVER reach forceRouting.
        // We confirm both halves: hint is computed, forceRouting still uses
        // the hardcoded dcaForceRouting constant.
        const hintRe = /const\s+dcaRoutingHint\s*=\s*await\s+_routeForDca\(/;
        const forceRe = /forceRouting\s*:\s*dcaRoutingHint\b/;
        assert.ok(
            hintRe.test(producer.slice),
            `Expected 'const dcaRoutingHint = await _routeForDca(...' — if the hint was ` +
            `removed entirely, fine, but update this test to remove the assertion.`
        );
        assert.ok(
            !forceRe.test(producer.slice),
            `forceRouting must not be set to dcaRoutingHint — the hint is informational only. ` +
            `Use the hardcoded dcaForceRouting constant instead.`
        );
    });

    check('Invariant 8: producer slice does not contain a flag that flips routing back to burner', () => {
        // Defence against a future env/config switch like:
        //   if (config.dcaAllowBurner) dcaForceRouting = { routingDecision: 'burner' };
        // We grep for the literal { routingDecision: 'burner' } inside the DCA
        // producer slice — there must be no occurrence at all.
        const re = /routingDecision\s*:\s*['"]burner['"]/;
        assert.ok(
            !re.test(producer.slice),
            `{ routingDecision: 'burner' } literal appeared inside jupiter_dca_create. ` +
            `Any branch that sets DCA routing to 'burner' violates BAT-1013 Phase 3c. ` +
            `If vault discovery has shipped, remove this test along with the policy gate.`
        );
    });

    console.log();
    console.log(`Result: ${pass} passed, ${fail} failed`);
    if (fail > 0) process.exit(1);
    console.log('PASS: solana-dca-routing.test.js');
})();
