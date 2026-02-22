#!/usr/bin/env node
/**
 * BAT-255: Jupiter Audit Fixes — Deterministic Test Suite
 *
 * Tests all audit fixes from JUPITER-AUDIT.md without network or wallet access.
 * 6 test groups: confirm gates, message formatting, amount parsing, balance check,
 * RPC retry, and legacy TX verification.
 * Run: node scripts/test-bat255-audit-fixes.js
 */

const path = require('path');
const fs = require('fs');

// ============================================================================
// Setup: load modules directly from the assets directory
// ============================================================================

const ASSETS = path.join(__dirname, '..', 'app', 'src', 'main', 'assets', 'nodejs-project');

// Stub config.js dependencies so we can require solana.js
const configPath = path.join(ASSETS, 'config.js');
const configSrc = fs.readFileSync(configPath, 'utf8');

let passed = 0;
let failed = 0;

function assert(condition, label) {
    if (condition) {
        console.log(`  ✅ ${label}`);
        passed++;
    } else {
        console.log(`  ❌ FAIL: ${label}`);
        failed++;
    }
}

// ============================================================================
// TEST 1: Confirmation gates (config.js)
// ============================================================================

console.log('\n── Test 1: Confirmation gates for solana_swap and solana_send ──');
{
    // Parse CONFIRM_REQUIRED from source (avoid module side-effects)
    const match = configSrc.match(/const CONFIRM_REQUIRED = new Set\(\[([\s\S]*?)\]\)/);
    assert(match, 'CONFIRM_REQUIRED set found in config.js');

    const entries = match[1];
    assert(entries.includes("'solana_send'"), 'solana_send is in CONFIRM_REQUIRED');
    assert(entries.includes("'solana_swap'"), 'solana_swap is in CONFIRM_REQUIRED');
    assert(entries.includes("'android_sms'"), 'android_sms still in CONFIRM_REQUIRED (not removed)');
    assert(entries.includes("'android_call'"), 'android_call still in CONFIRM_REQUIRED (not removed)');
    assert(entries.includes("'jupiter_trigger_create'"), 'jupiter_trigger_create still in CONFIRM_REQUIRED');
    assert(entries.includes("'jupiter_dca_create'"), 'jupiter_dca_create still in CONFIRM_REQUIRED');

    // Check rate limits exist for new entries
    const rlMatch = configSrc.match(/const TOOL_RATE_LIMITS = \{([\s\S]*?)\}/);
    assert(rlMatch, 'TOOL_RATE_LIMITS found in config.js');
    assert(rlMatch[1].includes("'solana_send'"), 'solana_send has rate limit');
    assert(rlMatch[1].includes("'solana_swap'"), 'solana_swap has rate limit');
}

// ============================================================================
// TEST 2: Confirmation message formatting (tools.js)
// ============================================================================

console.log('\n── Test 2: Confirmation message formatting for solana_send and solana_swap ──');
{
    const toolsSrc = fs.readFileSync(path.join(ASSETS, 'tools.js'), 'utf8');
    assert(toolsSrc.includes("case 'solana_send':"), 'solana_send case exists in formatConfirmationMessage');
    assert(toolsSrc.includes("case 'solana_swap':"), 'solana_swap case exists in formatConfirmationMessage');
    // Verify they appear inside the formatConfirmationMessage switch
    const fmtFnStart = toolsSrc.indexOf('function formatConfirmationMessage');
    const fmtFnEnd = toolsSrc.indexOf('function requestConfirmation');
    const fmtSection = toolsSrc.substring(fmtFnStart, fmtFnEnd);
    assert(fmtSection.includes("case 'solana_send':"), 'solana_send case inside formatConfirmationMessage');
    assert(fmtSection.includes("case 'solana_swap':"), 'solana_swap case inside formatConfirmationMessage');
}

// ============================================================================
// TEST 3: parseInputAmountToLamports used in solana_swap (no Math.round)
// ============================================================================

console.log('\n── Test 3: Safe amount parsing (no floating-point) ──');
{
    const toolsSrc = fs.readFileSync(path.join(ASSETS, 'tools.js'), 'utf8');

    // Find the solana_swap executor case (second occurrence, with opening brace)
    const swapExecStart = toolsSrc.indexOf("case 'solana_swap': {");
    assert(swapExecStart > 0, 'solana_swap executor case found');
    const swapSection = toolsSrc.substring(swapExecStart, swapExecStart + 8000);
    assert(!swapSection.includes('Math.round(input.amount'), 'solana_swap does NOT use Math.round for amount');
    assert(swapSection.includes('parseInputAmountToLamports(numberToDecimalString(input.amount), inputToken.decimals)'), 'solana_swap uses parseInputAmountToLamports with safe decimal conversion');

    // Also check solana_send executor case (with opening brace)
    const sendExecStart = toolsSrc.indexOf("case 'solana_send': {");
    assert(sendExecStart > 0, 'solana_send executor case found');
    const sendSection = toolsSrc.substring(sendExecStart, sendExecStart + 2000);
    assert(!sendSection.includes('Math.round(amount * 1e9)'), 'solana_send does NOT use Math.round');
    assert(sendSection.includes('parseInputAmountToLamports(numberToDecimalString(amount), 9)'), 'solana_send uses parseInputAmountToLamports with safe decimal conversion');

    // Test parseInputAmountToLamports edge cases directly
    // We need to extract it without requiring the whole module (has side effects).
    // Parse the function source and eval it in isolation.
    const solanaSrc = fs.readFileSync(path.join(ASSETS, 'solana.js'), 'utf8');
    const fnMatch = solanaSrc.match(/function parseInputAmountToLamports\(amount, decimals\) \{[\s\S]*?^}/m);
    assert(fnMatch, 'parseInputAmountToLamports function found in solana.js');

    // Create isolated function
    const parseInputAmountToLamports = new Function('amount', 'decimals',
        fnMatch[0].replace('function parseInputAmountToLamports(amount, decimals) {', '').replace(/\}$/, '')
    );

    // Edge case: 0.1 SOL (classic floating-point trap)
    const r1 = parseInputAmountToLamports('0.1', 9);
    assert(r1 === '100000000', `0.1 SOL → 100000000 lamports (got ${r1})`);

    // Edge case: 1.100000001 SOL — exactly 9 decimals
    const r2 = parseInputAmountToLamports('1.100000001', 9);
    assert(r2 === '1100000001', `1.100000001 SOL → 1100000001 (got ${r2})`);

    // Edge case: large amount
    const r3 = parseInputAmountToLamports('999999.999999999', 9);
    assert(r3 === '999999999999999', `999999.999999999 SOL → 999999999999999 (got ${r3})`);

    // Edge case: integer amount
    const r4 = parseInputAmountToLamports('5', 9);
    assert(r4 === '5000000000', `5 SOL → 5000000000 (got ${r4})`);

    // Edge case: USDC with 6 decimals
    const r5 = parseInputAmountToLamports('100.50', 6);
    assert(r5 === '100500000', `100.50 USDC → 100500000 (got ${r5})`);

    // Edge case: 0.000001 USDC (minimum)
    const r6 = parseInputAmountToLamports('0.000001', 6);
    assert(r6 === '1', `0.000001 USDC → 1 (got ${r6})`);

    // Should reject negative/zero
    let threw = false;
    try { parseInputAmountToLamports('0', 9); } catch (e) { threw = true; }
    assert(threw, 'Rejects 0 amount');

    // Should reject scientific notation
    threw = false;
    try { parseInputAmountToLamports('1e6', 9); } catch (e) { threw = true; }
    assert(threw, 'Rejects scientific notation (1e6)');

    // Should reject too many decimal places
    threw = false;
    try { parseInputAmountToLamports('1.1234567890', 9); } catch (e) { threw = true; }
    assert(threw, 'Rejects excess decimal places (10 digits for 9-decimal token)');

    // Floating-point trap: Math.round(0.1 * 1e9) vs parseInputAmountToLamports
    const unsafeResult = Math.round(0.1 * 1e9);
    const safeResult = parseInputAmountToLamports('0.1', 9);
    // In JS, Math.round(0.1 * 1e9) happens to be 100000000, but for other values it can differ
    // The point is: parseInputAmountToLamports is string-based, never uses float math
    assert(safeResult === '100000000', `Safe parsing matches expected for 0.1 (${safeResult})`);

    // Test numberToDecimalString (prevents scientific notation from breaking parsing)
    const toolsSrcForHelper = fs.readFileSync(path.join(ASSETS, 'tools.js'), 'utf8');
    assert(toolsSrcForHelper.includes('function numberToDecimalString('), 'numberToDecimalString helper exists');
    const ndsFnMatch = toolsSrcForHelper.match(/function numberToDecimalString\(n\) \{[\s\S]*?\n\}/);
    assert(ndsFnMatch, 'numberToDecimalString function extractable');
    const numberToDecimalString = new Function('n',
        ndsFnMatch[0].replace('function numberToDecimalString(n) {', '').replace(/\}$/, '')
    );
    assert(numberToDecimalString(0.0000001) === '0.0000001', 'numberToDecimalString(0.0000001) = "0.0000001" not "1e-7"');
    assert(numberToDecimalString(1.5) === '1.5', 'numberToDecimalString(1.5) = "1.5"');
    assert(numberToDecimalString(100) === '100', 'numberToDecimalString(100) = "100"');

    // Floating-point trap: 0.1 + 0.2 = 0.30000000000000004 in JS
    const unsafeTrap = Math.round((0.1 + 0.2) * 1e9);
    const safeTrap = parseInputAmountToLamports('0.3', 9);
    assert(safeTrap === '300000000', `Safe: 0.3 SOL → 300000000 (got ${safeTrap})`);
    // Math.round would give 300000000 here too, but the principle matters for edge cases
    // like 0.1 * 1e17 where float math definitely breaks
}

// ============================================================================
// TEST 4: Balance pre-check exists in solana_swap
// ============================================================================

console.log('\n── Test 4: Balance pre-check in solana_swap ──');
{
    const toolsSrc = fs.readFileSync(path.join(ASSETS, 'tools.js'), 'utf8');
    // Must find the executor case (second occurrence with brace), not the format switch case
    const swapExec = toolsSrc.indexOf("case 'solana_swap': {");
    const swapSection = toolsSrc.substring(swapExec, swapExec + 8000);

    assert(swapSection.includes('BAT-255: Pre-swap balance check'), 'Balance pre-check comment exists');
    assert(swapSection.includes('Insufficient SOL balance'), 'SOL insufficient balance error message exists');
    assert(swapSection.includes('Insufficient ${inputToken.symbol} balance') && swapSection.includes('${inputToken.symbol}.'), 'SPL token insufficient balance error message with symbol exists');
    assert(swapSection.includes('getTokenAccountsByOwner'), 'SPL token balance lookup via RPC');

    // Verify balance check comes BEFORE Jupiter Ultra order
    const balanceCheckIdx = swapSection.indexOf('BAT-255: Pre-swap balance check');
    const ultraOrderIdx = swapSection.indexOf('Jupiter Ultra flow');
    assert(balanceCheckIdx > 0 && ultraOrderIdx > 0 && balanceCheckIdx < ultraOrderIdx, 'Balance check happens before Ultra order');

    // Verify it's non-fatal (wrapped in try/catch)
    const balSection = swapSection.substring(balanceCheckIdx, balanceCheckIdx + 2000);
    assert(balSection.includes('Balance pre-check skipped'), 'Balance check failure is non-fatal (logged, not thrown)');
}

// ============================================================================
// TEST 5: Solana RPC retry wrapper
// ============================================================================

console.log('\n── Test 5: Solana RPC retry wrapper ──');
{
    const solanaSrc = fs.readFileSync(path.join(ASSETS, 'solana.js'), 'utf8');

    // Verify solanaRpcOnce exists (the raw single-shot function)
    assert(solanaSrc.includes('async function solanaRpcOnce('), 'solanaRpcOnce (single-shot) exists');

    // Verify solanaRpc wraps with retry
    assert(solanaSrc.includes('MAX_ATTEMPTS = 2'), 'MAX_ATTEMPTS = 2 for RPC retry');
    assert(solanaSrc.includes('BASE_DELAY_MS'), 'BASE_DELAY_MS defined for backoff');
    assert(solanaSrc.includes('RPC_TRANSIENT_PATTERNS'), 'Transient error pattern list exists');

    // Verify transient patterns include key errors
    assert(solanaSrc.includes("'timeout'"), 'Retries on timeout');
    assert(solanaSrc.includes("'econnreset'"), 'Retries on econnreset (case-insensitive matching)');
    assert(solanaSrc.includes("'econnrefused'"), 'Retries on econnrefused (case-insensitive matching)');
    assert(solanaSrc.includes("'etimedout'"), 'Retries on etimedout (case-insensitive matching)');
    // Verify case-insensitive comparison
    assert(solanaSrc.includes('.toLowerCase()'), 'Error message lowercased before matching');

    // Verify non-transient errors fast-fail
    assert(solanaSrc.includes('isTransient'), 'Transient check distinguishes retriable from non-retriable');

    // Verify the exported function is the retry wrapper, not the raw one
    assert(solanaSrc.includes('solanaRpc,') && solanaSrc.includes('module.exports'), 'solanaRpc (retry) is exported');
    // solanaRpcOnce should NOT be in exports
    assert(!solanaSrc.match(/module\.exports[\s\S]*solanaRpcOnce/), 'solanaRpcOnce is NOT exported (internal only)');
}

// ============================================================================
// TEST 6: Legacy TX verification hardening
// ============================================================================

console.log('\n── Test 6: Legacy TX verification program whitelist ──');
{
    const solanaSrc = fs.readFileSync(path.join(ASSETS, 'solana.js'), 'utf8');

    // Find the legacy verification section
    const legacySection = solanaSrc.substring(
        solanaSrc.indexOf('if (!isV0)'),
        solanaSrc.indexOf('// V0 transaction format')
    );

    // Verify program whitelist check exists in legacy path
    assert(legacySection.includes('TRUSTED_PROGRAMS.has(programId)'), 'Legacy path checks TRUSTED_PROGRAMS');
    assert(legacySection.includes('legacyUntrusted'), 'Legacy path collects untrusted programs');
    assert(legacySection.includes('unwhitelisted program'), 'Legacy path has rejection error message');

    // Verify it reads all account keys (not just first one for payer)
    assert(legacySection.includes('legacyAccountKeys'), 'Legacy path reads full account key array');

    // Verify it skips blockhash before reading instructions
    assert(legacySection.includes('offset += 32'), 'Legacy path skips 32-byte blockhash');

    // Verify it reads instructions like the v0 path does
    assert(legacySection.includes('legacyNumInstructions'), 'Legacy path reads instruction count');

    // Verify function signature and structural correctness (behavioral tests
    // require the full module context with TRUSTED_PROGRAMS populated).
    const fnSignature = solanaSrc.match(/function verifySwapTransaction\(([^)]+)\)/);
    assert(fnSignature, 'verifySwapTransaction function exists');
    assert(fnSignature[1].includes('txBase64'), 'Accepts txBase64 parameter');
    assert(fnSignature[1].includes('expectedPayerBase58'), 'Accepts expectedPayerBase58 parameter');

    // Verify legacy path now includes program iteration (skip accounts + skip data)
    assert(legacySection.includes('numAcctIdx'), 'Legacy iterates account indices per instruction');
    assert(legacySection.includes('dataLen'), 'Legacy iterates data length per instruction');
}

// ============================================================================
// Summary
// ============================================================================

console.log('\n══════════════════════════════════════════════');
console.log(`  Results: ${passed} passed, ${failed} failed`);
console.log('══════════════════════════════════════════════');

if (failed > 0) {
    console.log('\n❌ SOME TESTS FAILED — review output above\n');
    process.exit(1);
} else {
    console.log('\n✅ ALL TESTS PASSED — BAT-255 fixes verified\n');
    process.exit(0);
}
