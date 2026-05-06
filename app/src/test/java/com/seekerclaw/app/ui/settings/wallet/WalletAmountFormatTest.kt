package com.seekerclaw.app.ui.settings.wallet

import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
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
    }

    @Test fun `parseSolToLamports rejects locale comma`() {
        assertNull(WalletAmountFormat.parseSolToLamports("0,5"))
        assertNull(WalletAmountFormat.parseSolToLamports("1,000"))
    }

    @Test fun `parseSolToLamports rejects negative`() {
        assertNull(WalletAmountFormat.parseSolToLamports("-1"))
        assertNull(WalletAmountFormat.parseSolToLamports("-0.05"))
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
            assert(input.toBigDecimal().compareTo(out.toBigDecimal()) == 0) {
                "round-trip mismatch on $input -> $out"
            }
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
            assert(input.toBigDecimal().compareTo(out.toBigDecimal()) == 0) {
                "round-trip mismatch on $input -> $out"
            }
        }
    }

    @Test fun `tiny USDC value formats to display zero but atomic preserved`() {
        // Decimal "0.000001" parses to 1 microunit (preserved exactly),
        // but the display rounds DOWN to "0.00" at 2 digit precision.
        val atomic = WalletAmountFormat.parseUsdcToMicroUnits("0.000001")!!
        assertEquals(BigInteger("1"), atomic)
        assertEquals("0.00", WalletAmountFormat.formatMicroUnitsToUsdc(atomic))
    }
}
