package com.seekerclaw.app.ui.settings.wallet

import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test
import java.math.BigInteger

/**
 * Pure JVM tests for the decimal <-> atomic boundary used by the Burner
 * Wallet Settings UI (BAT-582).
 *
 * **Why these tests exist:** the cap-bypass attack surface is direct here.
 * If `parseSolToLamports("0.5")` returned 5 instead of 500_000_000, every
 * cap value the user types into the UI would become microscopic, the
 * Android-side CapEnforcer would still happily reserve+sign, and the
 * burner would drain. These are NOT throwaway tests — they pin the
 * decimal/atomic contract per the round-trip-parser AC.
 */
class WalletAmountFormatTest {

    // --- SOL parsing ---

    @Test fun `parseSolToLamports happy path`() {
        assertEquals(BigInteger("500000000"), WalletAmountFormat.parseSolToLamports("0.5"))
        assertEquals(BigInteger("50000000"), WalletAmountFormat.parseSolToLamports("0.05"))
        assertEquals(BigInteger("1000000000"), WalletAmountFormat.parseSolToLamports("1"))
        assertEquals(BigInteger("1500000000"), WalletAmountFormat.parseSolToLamports("1.5"))
    }

    @Test fun `parseSolToLamports max precision (1 lamport)`() {
        assertEquals(BigInteger("1"), WalletAmountFormat.parseSolToLamports("0.000000001"))
    }

    @Test fun `parseSolToLamports trims whitespace`() {
        assertEquals(BigInteger("500000000"), WalletAmountFormat.parseSolToLamports("  0.5  "))
        assertEquals(BigInteger("500000000"), WalletAmountFormat.parseSolToLamports("\t0.5\n"))
    }

    @Test fun `parseSolToLamports zero`() {
        assertEquals(BigInteger.ZERO, WalletAmountFormat.parseSolToLamports("0"))
        assertEquals(BigInteger.ZERO, WalletAmountFormat.parseSolToLamports("0.0"))
        assertEquals(BigInteger.ZERO, WalletAmountFormat.parseSolToLamports("0.00000000"))
    }

    @Test fun `parseSolToLamports rejects sub-atomic precision`() {
        // 0.0000000005 SOL = 0.5 lamport — would silently round to 0 or 1.
        // We reject so the user sees a clear "invalid amount" error.
        assertNull(WalletAmountFormat.parseSolToLamports("0.0000000005"))
    }

    @Test fun `parseSolToLamports rejects scientific notation`() {
        assertNull(WalletAmountFormat.parseSolToLamports("1e-9"))
        assertNull(WalletAmountFormat.parseSolToLamports("1E-9"))
        assertNull(WalletAmountFormat.parseSolToLamports("1.5e9"))
        // BAT-582 R4: also reject mixed forms with both a fractional
        // part and an exponent — Node regex `^\d+(\.\d+)?$` rejects.
        assertNull(WalletAmountFormat.parseSolToLamports("0.5e2"))
        assertNull(WalletAmountFormat.parseSolToLamports("1e9"))
    }

    @Test fun `parseSolToLamports rejects leading dot (parity with Node regex)`() {
        // BAT-582 R4 (CRITICAL): BigDecimal accepts ".5" (= 0.5), but
        // Node's `^\d+(\.\d+)?$` requires at least one leading digit.
        // Without this rejection, the Kotlin parser would store a cap
        // for ".5 SOL" that Node-side routing would reject — UI claims
        // success while routing silently degrades to 'main'.
        assertNull(WalletAmountFormat.parseSolToLamports(".5"))
        assertNull(WalletAmountFormat.parseSolToLamports(".05"))
        assertNull(WalletAmountFormat.parseSolToLamports("."))
    }

    @Test fun `parseSolToLamports rejects trailing dot (parity with Node regex)`() {
        // BAT-582 R4: BigDecimal accepts "5." (= 5.0), but Node's
        // `^\d+(\.\d+)?$` requires `\.\d+` — a dot must be followed by
        // at least one digit. Reject for parity.
        assertNull(WalletAmountFormat.parseSolToLamports("5."))
        assertNull(WalletAmountFormat.parseSolToLamports("0."))
        assertNull(WalletAmountFormat.parseSolToLamports("100."))
    }

    @Test fun `parseSolToLamports rejects unicode digits (parity with Node regex)`() {
        // BAT-582 R4 / R10: \d in JavaScript regex (without /u flag)
        // matches ONLY ASCII 0-9. Kotlin Regex `\d` is ALSO ASCII-only
        // by default (Pattern.UNICODE_CHARACTER_CLASS is OFF unless set),
        // but R10 made the regex use the literal `[0-9]` class instead
        // of `\d` so the ASCII-strict intent is self-evident from the
        // pattern. These tests pin the contract independent of which
        // regex engine flags happen to be on.
        //
        // Pre-R10 demonstration: the equivalent BigDecimal("٥٠٠")
        // succeeds and parses to 500 — without the regex gate the cap
        // UI would accept Arabic-Indic 500 and Node-side routing would
        // then reject it, producing the silent-degrade-to-main bug.
        assertNull(WalletAmountFormat.parseSolToLamports("٠١"))         // Arabic-Indic 01
        assertNull(WalletAmountFormat.parseSolToLamports("１"))         // Fullwidth 1
        // R10 spec cases — three different scripts, each tests a
        // different Unicode block (Arabic-Indic U+0660-0669, Devanagari
        // U+0966-096F, Halfwidth/Fullwidth Forms U+FF10-FF19).
        assertNull(WalletAmountFormat.parseSolToLamports("٥٠٠"))         // Arabic-Indic 500
        assertNull(WalletAmountFormat.parseSolToLamports("५००"))         // Devanagari 500
        assertNull(WalletAmountFormat.parseSolToLamports("５００"))      // Fullwidth 500
        // Bengali (U+09E6-09EF) and Tamil (U+0BE6-0BEF) — paranoia coverage
        assertNull(WalletAmountFormat.parseSolToLamports("০"))           // Bengali 0
        assertNull(WalletAmountFormat.parseSolToLamports("௫"))           // Tamil 5
    }

    @Test fun `parseSolToLamports rejects locale comma`() {
        assertNull(WalletAmountFormat.parseSolToLamports("0,5"))
        assertNull(WalletAmountFormat.parseSolToLamports("1,000"))
    }

    @Test fun `parseSolToLamports rejects negative`() {
        assertNull(WalletAmountFormat.parseSolToLamports("-1"))
        assertNull(WalletAmountFormat.parseSolToLamports("-0.05"))
    }

    @Test fun `parseSolToLamports rejects leading plus (parity with Node-side _decimalToAtomic)`() {
        // BigDecimal accepts "+0.5" but Node's caps/preflight.js
        // _decimalToAtomic rejects via `^\d+(\.\d+)?$`. Reject in Kotlin
        // too so cap-config UX is symmetric with Node-side routing math.
        assertNull(WalletAmountFormat.parseSolToLamports("+1"))
        assertNull(WalletAmountFormat.parseSolToLamports("+0.05"))
    }

    @Test fun `parseSolToLamports rejects empty and garbage`() {
        assertNull(WalletAmountFormat.parseSolToLamports(""))
        assertNull(WalletAmountFormat.parseSolToLamports("   "))
        assertNull(WalletAmountFormat.parseSolToLamports("abc"))
        assertNull(WalletAmountFormat.parseSolToLamports("0.5x"))
    }

    // --- USDC parsing ---

    @Test fun `parseUsdcToMicroUnits happy path`() {
        assertEquals(BigInteger("5000000"), WalletAmountFormat.parseUsdcToMicroUnits("5"))
        assertEquals(BigInteger("100000"), WalletAmountFormat.parseUsdcToMicroUnits("0.10"))
        assertEquals(BigInteger("50000000"), WalletAmountFormat.parseUsdcToMicroUnits("50"))
    }

    @Test fun `parseUsdcToMicroUnits max precision (1 microunit)`() {
        assertEquals(BigInteger("1"), WalletAmountFormat.parseUsdcToMicroUnits("0.000001"))
    }

    @Test fun `parseUsdcToMicroUnits rejects sub-atomic precision`() {
        assertNull(WalletAmountFormat.parseUsdcToMicroUnits("0.0000001"))
        assertNull(WalletAmountFormat.parseUsdcToMicroUnits("0.0000005"))
    }

    @Test fun `parseUsdcToMicroUnits rejects locale comma`() {
        assertNull(WalletAmountFormat.parseUsdcToMicroUnits("5,00"))
    }

    @Test fun `parseUsdcToMicroUnits rejects scientific notation`() {
        assertNull(WalletAmountFormat.parseUsdcToMicroUnits("1e-6"))
    }

    @Test fun `parseUsdcToMicroUnits rejects negative`() {
        assertNull(WalletAmountFormat.parseUsdcToMicroUnits("-5"))
    }

    @Test fun `parseUsdcToMicroUnits rejects leading plus (parity with Node)`() {
        assertNull(WalletAmountFormat.parseUsdcToMicroUnits("+5"))
        assertNull(WalletAmountFormat.parseUsdcToMicroUnits("+0.10"))
    }

    @Test fun `parseUsdcToMicroUnits rejects leading and trailing dot (R4)`() {
        // BAT-582 R4: parity with Node regex `^\d+(\.\d+)?$`.
        assertNull(WalletAmountFormat.parseUsdcToMicroUnits(".5"))
        assertNull(WalletAmountFormat.parseUsdcToMicroUnits("5."))
        assertNull(WalletAmountFormat.parseUsdcToMicroUnits("."))
    }

    // --- SOL formatting ---

    @Test fun `formatLamportsToSol trims trailing zeros but keeps minimum 2`() {
        assertEquals("0.05", WalletAmountFormat.formatLamportsToSol(BigInteger("50000000")))
        assertEquals("0.50", WalletAmountFormat.formatLamportsToSol(BigInteger("500000000")))
        assertEquals("1.00", WalletAmountFormat.formatLamportsToSol(BigInteger("1000000000")))
        assertEquals("1.234", WalletAmountFormat.formatLamportsToSol(BigInteger("1234000000")))
    }

    @Test fun `formatLamportsToSol handles zero and null`() {
        assertEquals("0.00", WalletAmountFormat.formatLamportsToSol(BigInteger.ZERO))
        assertEquals("0.00", WalletAmountFormat.formatLamportsToSol(null as BigInteger?))
    }

    @Test fun `formatLamportsToSol truncates beyond display precision`() {
        // 4 display digits → 1.0000 → "1.00"
        assertEquals("1.00", WalletAmountFormat.formatLamportsToSol(BigInteger("1000000001")))
    }

    @Test fun `formatLamportsToSol from atomic string`() {
        assertEquals("0.05", WalletAmountFormat.formatLamportsToSol("50000000"))
        assertEquals("0.00", WalletAmountFormat.formatLamportsToSol(null as String?))
        assertEquals("0.00", WalletAmountFormat.formatLamportsToSol(""))
        // Defensive: corrupt value should never crash.
        assertEquals("0.00", WalletAmountFormat.formatLamportsToSol("not a number"))
    }

    @Test fun `formatLamportsToSol negative atomic returns 0_00`() {
        // Defensive: a corrupt persisted value should never produce a
        // "-0.05" string in the UI; render as "0.00" so caps look unset.
        assertEquals("0.00", WalletAmountFormat.formatLamportsToSol(BigInteger("-50000000")))
    }

    // --- USDC formatting ---

    @Test fun `formatMicroUnitsToUsdc trims trailing zeros`() {
        assertEquals("5.00", WalletAmountFormat.formatMicroUnitsToUsdc(BigInteger("5000000")))
        assertEquals("0.10", WalletAmountFormat.formatMicroUnitsToUsdc(BigInteger("100000")))
        assertEquals("50.00", WalletAmountFormat.formatMicroUnitsToUsdc(BigInteger("50000000")))
    }

    @Test fun `formatMicroUnitsToUsdc handles zero and null`() {
        assertEquals("0.00", WalletAmountFormat.formatMicroUnitsToUsdc(BigInteger.ZERO))
        assertEquals("0.00", WalletAmountFormat.formatMicroUnitsToUsdc(null as BigInteger?))
    }

    @Test fun `formatMicroUnitsToUsdc from atomic string`() {
        assertEquals("5.00", WalletAmountFormat.formatMicroUnitsToUsdc("5000000"))
        assertEquals("0.00", WalletAmountFormat.formatMicroUnitsToUsdc(null as String?))
    }

    // --- Round-trip ---

    @Test fun `round-trip SOL caps`() {
        val inputs = listOf("0.05", "0.50", "1.00", "1.234")
        for (input in inputs) {
            val atomic = WalletAmountFormat.parseSolToLamports(input)!!
            val out = WalletAmountFormat.formatLamportsToSol(atomic)
            // BigDecimal.equals compares scale too; compareTo compares value.
            // The format may pad zeros (1 -> 1.00), so we want value equality.
            // Use JUnit assertTrue (not Kotlin's `assert`, which is disabled
            // without `-ea` and would silently pass on regression).
            assertTrue(
                "round-trip mismatch on $input -> $out",
                input.toBigDecimal().compareTo(out.toBigDecimal()) == 0,
            )
        }
    }

    @Test fun `round-trip USDC caps at display precision`() {
        // Note: USDC display rounds DOWN to 2 fractional digits, so
        // "0.000001" is stored as 1 microunit but DISPLAYED as "0.00".
        // That's intentional — the cap value is preserved in atomic
        // units, the display is just a hint. We round-trip caps that
        // fit display precision.
        val inputs = listOf("5", "0.10", "50")
        for (input in inputs) {
            val atomic = WalletAmountFormat.parseUsdcToMicroUnits(input)!!
            val out = WalletAmountFormat.formatMicroUnitsToUsdc(atomic)
            assertTrue(
                "round-trip mismatch on $input -> $out",
                input.toBigDecimal().compareTo(out.toBigDecimal()) == 0,
            )
        }
    }

    @Test fun `tiny USDC value formats to display zero but atomic preserved`() {
        // Decimal "0.000001" parses to 1 microunit (preserved exactly),
        // but the display rounds DOWN to "0.00" at 2 digit precision.
        val atomic = WalletAmountFormat.parseUsdcToMicroUnits("0.000001")!!
        assertEquals(BigInteger("1"), atomic)
        assertEquals("0.00", WalletAmountFormat.formatMicroUnitsToUsdc(atomic))
    }

    // --- BAT-582 R11: paste-DoS defense (input-length cap) ---

    @Test fun `parseSolToLamports rejects oversize paste without allocating BigDecimal`() {
        // BAT-582 R11: Settings UI inputs that bypass the regex+BigDecimal
        // path via huge paste must short-circuit early. Pre-fix, a 10K-char
        // paste would run the regex AND allocate BigDecimal, blocking the
        // UI thread for many ms.
        val huge = "1".repeat(10_000)
        val start = System.nanoTime()
        val result = WalletAmountFormat.parseSolToLamports(huge)
        val elapsedMs = (System.nanoTime() - start) / 1_000_000.0
        assertNull("oversize input must be rejected", result)
        // Wall-clock budget: must complete in well under 100ms even on a
        // slow CI runner. Pre-fix this would have spent O(n²) time in
        // BigDecimal parsing — easily 10ms+ on 10KB input.
        assertTrue(
            "DoS cap must short-circuit fast (< 100ms); took ${elapsedMs}ms",
            elapsedMs < 100,
        )
    }

    @Test fun `parseUsdcToMicroUnits rejects oversize paste`() {
        val huge = "9".repeat(50_000) + ".000001"
        assertNull(WalletAmountFormat.parseUsdcToMicroUnits(huge))
    }

    @Test fun `parseDecimalToAtomic accepts inputs at the boundary`() {
        // 40 chars of digits — at the cap exactly, should still pass the
        // length gate (will then be rejected by sub-atomic precision /
        // exact-decimal logic, returning null — the IMPORTANT check is
        // that we don't bail early on length).
        // 30 digits + "." + 9 fractional = 40 chars. SOL has 9 decimals
        // and rejects sub-atomic precision, so this parses to a valid
        // atomic value.
        val boundary = "1".repeat(30) + ".000000000"
        assertEquals(40, boundary.length)
        // Should parse successfully — 30-digit integer with 9 fractional
        // zero digits is a valid SOL atomic-amount input.
        val parsed = WalletAmountFormat.parseSolToLamports(boundary)
        assertTrue("$boundary should parse at the 40-char boundary", parsed != null)
    }

    @Test fun `parseDecimalToAtomic rejects one char over the boundary`() {
        // 41 chars of digits — over cap, must reject without examining content.
        val overCap = "1".repeat(31) + ".000000000"
        assertEquals(41, overCap.length)
        assertNull(WalletAmountFormat.parseSolToLamports(overCap))
    }

    @Test fun `parseSolToLamports rejects 1MB-of-spaces paste fast`() {
        // Adversarial: a paste of pure whitespace would trigger
        // `decimal.trim()` to allocate a giant copy before the empty-check
        // catches it. The R11 guard checks `decimal.length` BEFORE
        // trimming so this also short-circuits.
        val whitespace = " ".repeat(1_000_000)
        val start = System.nanoTime()
        val result = WalletAmountFormat.parseSolToLamports(whitespace)
        val elapsedMs = (System.nanoTime() - start) / 1_000_000.0
        assertNull(result)
        assertTrue(
            "1MB-whitespace paste must short-circuit fast (< 100ms); took ${elapsedMs}ms",
            elapsedMs < 100,
        )
    }
}
