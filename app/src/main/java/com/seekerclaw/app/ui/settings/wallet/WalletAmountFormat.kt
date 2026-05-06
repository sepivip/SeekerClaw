package com.seekerclaw.app.ui.settings.wallet

import java.math.BigDecimal
import java.math.BigInteger
import java.math.RoundingMode

/**
 * WalletAmountFormat — pure decimal <-> atomic-unit converters for the
 * Burner Wallet Settings UI (BAT-582).
 *
 * **Money math contract (BAT-582 §Money math):** all storage and on-the-wire
 * values are atomic-unit decimal strings (BigInteger-compatible). The UI
 * accepts decimal user input and renders atomic stored values, but every
 * call to the bridge / KeyVault / CapEnforcer goes through atomic units.
 * This file is the single decimal/atomic boundary for the Burner UI — no
 * Float/Double touches a monetary value anywhere.
 *
 * **Locale policy (V1):** only `.` decimal separator is supported. `,` is
 * rejected — locale-style "0,5" produces null. This is consistent with
 * the underlying [BigDecimal] contract and avoids the device-locale trap
 * where the same input produces different cap values on different phones.
 *
 * **Edge cases the parsers reject (return null):**
 *   - Empty / blank input
 *   - Negative values
 *   - Scientific notation ("1e-9") — explicit decimal-only policy
 *   - Locale-style "0,5"
 *   - Sub-atomic precision (e.g. 0.000_000_000_5 SOL — beyond lamport
 *     resolution; truncating is a footgun, rounding is silent loss)
 *   - Non-numeric input
 *
 * The formatters always trim trailing zeros so cap displays don't fill
 * with noise; minimum-displayed precision is 2 fractional digits for
 * readability ("0.00" rather than "0").
 */
object WalletAmountFormat {

    private const val SOL_DECIMALS = 9
    private const val USDC_DECIMALS = 6

    private val LAMPORTS_PER_SOL: BigInteger = BigInteger.TEN.pow(SOL_DECIMALS)
    private val MICRO_PER_USDC: BigInteger = BigInteger.TEN.pow(USDC_DECIMALS)

    /**
     * Decimal SOL string -> lamports BigInteger, or null on parse failure.
     * Accepts forms: "0.5", "0", ".5", "1.234567890". Rejects: "1e-9",
     * "0,5", "-1", "", "abc".
     */
    fun parseSolToLamports(decimal: String): BigInteger? =
        parseDecimalToAtomic(decimal, SOL_DECIMALS)

    /**
     * Decimal USDC string -> microunits BigInteger, or null on parse
     * failure. Accepts forms: "5", "0.10", "1.234567". Same rejection
     * rules as [parseSolToLamports].
     */
    fun parseUsdcToMicroUnits(decimal: String): BigInteger? =
        parseDecimalToAtomic(decimal, USDC_DECIMALS)

    /**
     * lamports BigInteger -> decimal SOL string (4 fractional digits,
     * trimmed). Returns "0.00" for zero/null inputs so the UI never
     * shows an empty cap.
     */
    fun formatLamportsToSol(atomic: BigInteger?): String =
        formatAtomicToDecimal(atomic, SOL_DECIMALS, displayDigits = 4)

    /**
     * USDC microunits BigInteger -> decimal USDC string (2 fractional
     * digits, trimmed). Returns "0.00" for zero/null inputs.
     */
    fun formatMicroUnitsToUsdc(atomic: BigInteger?): String =
        formatAtomicToDecimal(atomic, USDC_DECIMALS, displayDigits = 2)

    /** Convenience overload — atomic-unit decimal string. */
    fun formatLamportsToSol(atomicStr: String?): String =
        formatLamportsToSol(safeBigInt(atomicStr))

    /** Convenience overload — atomic-unit decimal string. */
    fun formatMicroUnitsToUsdc(atomicStr: String?): String =
        formatMicroUnitsToUsdc(safeBigInt(atomicStr))

    /**
     * Strict decimal -> atomic conversion.
     *
     * Trims whitespace; rejects empty, scientific notation, locale-comma,
     * negative, and sub-atomic precision. Returns null on any rejection
     * so callers can show a stable error to the user.
     */
    private fun parseDecimalToAtomic(decimal: String, decimals: Int): BigInteger? {
        val trimmed = decimal.trim()
        if (trimmed.isEmpty()) return null
        // Reject scientific notation explicitly — BigDecimal accepts "1e-9"
        // which would silently produce 1 lamport for 1 SOL etc.
        if (trimmed.contains('e', ignoreCase = true)) return null
        // Reject locale comma. BigDecimal would reject this anyway, but
        // we want a deterministic answer regardless of JDK behavior.
        if (trimmed.contains(',')) return null
        // Reject negatives — caps are non-negative quantities.
        if (trimmed.startsWith('-')) return null

        val bd = try {
            BigDecimal(trimmed)
        } catch (_: NumberFormatException) {
            return null
        }
        // Detect precision overflow. setScale with UNNECESSARY throws
        // ArithmeticException if any non-zero digits would be discarded;
        // exactly the contract we want — we'd rather reject than round.
        return try {
            bd.setScale(decimals, RoundingMode.UNNECESSARY).movePointRight(decimals).toBigIntegerExact()
        } catch (_: ArithmeticException) {
            null
        }
    }

    /**
     * Format atomic units into a decimal string with [displayDigits]
     * fractional digits, trailing zeros trimmed but always keeping at
     * least 2 to avoid bare integers.
     */
    private fun formatAtomicToDecimal(
        atomic: BigInteger?,
        decimals: Int,
        displayDigits: Int,
    ): String {
        val a = atomic ?: BigInteger.ZERO
        if (a.signum() < 0) return "0.00" // defensive — corrupt persisted value
        val full = BigDecimal(a).movePointLeft(decimals)
        val rounded = full.setScale(displayDigits, RoundingMode.DOWN)
        // Strip trailing zeros but keep at least 2 fractional digits
        // (e.g. "0.00" not "0", "0.05" not "0.0500", "1.234" not "1.2340").
        return trimTrailingZeros(rounded.toPlainString(), minFractional = 2)
    }

    private fun trimTrailingZeros(s: String, minFractional: Int): String {
        val dot = s.indexOf('.')
        if (dot < 0) return "$s." + "0".repeat(minFractional)
        var end = s.length
        // Trim trailing zeros, but stop at minFractional digits past the
        // decimal point.
        val minLen = dot + 1 + minFractional
        while (end > minLen && s[end - 1] == '0') end--
        return s.substring(0, end)
    }

    /** Defensive BigInteger parse. Returns null on any malformed input. */
    private fun safeBigInt(s: String?): BigInteger? {
        if (s.isNullOrBlank()) return null
        return try { BigInteger(s) } catch (_: Exception) { null }
    }
}
