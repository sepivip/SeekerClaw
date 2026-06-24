#!/usr/bin/env node
// tests/nodejs-project/ata-derivation.test.js
//
// BAT-1038: the token program ID is one of the three ATA seeds, so a Token-2022
// mint's ATA derives to a DIFFERENT address than the classic derivation. The
// Jupiter swap handler used the classic 2-arg derivation for a Token-2022 output
// (PYUSD) → a phantom address that's null post-state → false
// simulation_delta_mismatch. This pins the parameterized 3-arg deriveAtaBase58
// against known on-chain values (Phase-0 mainnet probe) + the 4 program combos,
// and proves the classic (2-arg) path is byte-identical (back-compat).

'use strict';

const assert = require('assert');
const path = require('path');

const BUNDLE = path.resolve(__dirname, '..', '..', 'app', 'src', 'main', 'assets', 'nodejs-project');
const { deriveAtaBase58 } = require(path.join(BUNDLE, 'wallet', 'ata'));
const { TOKEN_PROGRAM_ID, TOKEN_2022_PROGRAM_ID } = require(path.join(BUNDLE, 'payment', 'x402'));

// Phase-0 mainnet probe fixtures (BAT-1038 Linear, comment [7]).
const BURNER = '8r1sTpLdm11b4AqCuQWS9vbTaRwsDTWmRwYxzgG3C8MJ'; // test wallet
const PYUSD = '2b1kV6DkPAnxd5ixfnxCpjxmKwqjjaYmCZfHsFu24GXo';  // Token-2022 mint
const USDC = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v';   // classic SPL mint
const PYUSD_CLASSIC_ATA = 'Gh6pnkP1BwUF5Yac8zggiA1QdHueeVoxCGjJgTRD2LgX'; // wrong / phantom
const PYUSD_T2022_ATA = 'B28qxiqX6Z2UoJdbbUf6HxSVcRShsNjVUsoKri59NDHH';   // correct

let pass = 0, fail = 0;
function check(name, fn) {
    try { fn(); pass++; console.log(`  ✓ ${name}`); }
    catch (e) { fail++; console.error(`  ✗ ${name}: ${e.message}`); if (process.env.VERBOSE) console.error(e.stack); }
}

console.log('ata-derivation.test.js — BAT-1038 token-program-aware ATA derivation');
console.log();

check('Token-2022 ATA != classic ATA — the exact root-cause divergence', () => {
    const classic = deriveAtaBase58(BURNER, PYUSD);                          // 2-arg
    const t22 = deriveAtaBase58(BURNER, PYUSD, TOKEN_2022_PROGRAM_ID);       // 3-arg T2022
    assert.notStrictEqual(classic, t22, 'classic and Token-2022 ATAs must differ');
    assert.strictEqual(classic, PYUSD_CLASSIC_ATA, 'classic 2-arg = the phantom address that caused the false reject');
    assert.strictEqual(t22, PYUSD_T2022_ATA, '3-arg Token-2022 = the real ATA Jupiter credits');
});

check('back-compat: 2-arg === explicit-classic 3-arg (every existing caller safe)', () => {
    assert.strictEqual(deriveAtaBase58(BURNER, PYUSD), deriveAtaBase58(BURNER, PYUSD, TOKEN_PROGRAM_ID));
    assert.strictEqual(deriveAtaBase58(BURNER, USDC), deriveAtaBase58(BURNER, USDC, TOKEN_PROGRAM_ID));
});

check('4-combo: each (mint, program) pair yields a distinct, deterministic ATA', () => {
    const a = deriveAtaBase58(BURNER, USDC, TOKEN_PROGRAM_ID);
    const b = deriveAtaBase58(BURNER, USDC, TOKEN_2022_PROGRAM_ID);
    const c = deriveAtaBase58(BURNER, PYUSD, TOKEN_PROGRAM_ID);
    const d = deriveAtaBase58(BURNER, PYUSD, TOKEN_2022_PROGRAM_ID);
    assert.strictEqual(new Set([a, b, c, d]).size, 4, 'all four combos must be distinct addresses');
    assert.strictEqual(deriveAtaBase58(BURNER, PYUSD, TOKEN_2022_PROGRAM_ID), d, 'deterministic');
});

check('invalid token program id throws — never a silent classic fallback', () => {
    assert.throws(() => deriveAtaBase58(BURNER, PYUSD, 'not-base58!!'), /token program/i);
});

check('invalid owner / mint still throw (unchanged)', () => {
    assert.throws(() => deriveAtaBase58('bad!!', PYUSD, TOKEN_2022_PROGRAM_ID), /owner/i);
    assert.throws(() => deriveAtaBase58(BURNER, 'bad!!', TOKEN_2022_PROGRAM_ID), /mint/i);
});

console.log();
console.log(`Result: ${pass} passed, ${fail} failed`);
if (fail > 0) { console.error('FAIL: ata-derivation.test.js'); process.exit(1); }
console.log('PASS: ata-derivation.test.js');
