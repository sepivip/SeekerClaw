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
 *   - Negative values ("-1") and leading-plus ("+1")
 *   - Scientific notation ("1e-9", "0.5e2") — explicit decimal-only policy
 *   - Locale-style "0,5"
 *   - Leading dot (".5") and trailing dot ("5.") — Node parity
 *   - Sub-atomic precision (e.g. 0.000_000_000_5 SOL — beyond lamport
 *     resolution; truncating is a footgun, rounding is silent loss)
 *   - Non-numeric input
 *
 * The accepted shape is exactly `^\d+(\.\d+)?$` — strict parity with the
 * Node-side `_decimalToAtomic` regex used in caps/preflight.js and
 * tools/wallet.js, so a UI-stored cap is guaranteed to match what the
 * Node-side routing math sees.
 *
 * The formatters always trim trailing zeros so cap displays don't fill
 * with noise; minimum-displayed precision is 2 fractional digits for
 * readability ("0.00" rather than "0").
 */
object WalletAmountFormat {

    // Decimal-place counts for the two assets the burner can spend. SOL
    // has 9 decimals (1 SOL = 10^9 lamports); USDC has 6 (1 USDC = 10^6
    // microunits). Conversion uses BigDecimal.movePointRight/Left rather
    // than a precomputed `10^decimals` constant — the JDK fast path for
    // movePoint avoids materializing the BigInteger multiplier.
    private const val SOL_DECIMALS = 9
    private const val USDC_DECIMALS = 6

    /**
     * BAT-582 R4 / R10: strict decimal regex — exact mirror of the
     * Node-side `^\d+(\.\d+)?$` used in `caps/preflight.js#_decimalToAtomic`
     * and `tools/wallet.js#_decimalToAtomic`. Rejects:
     *   - `.5`     (no leading digit)
     *   - `5.`     (trailing dot, no fractional digits)
     *   - `+1`     (leading sign)
     *   - `-1`     (negative — also caught by the dedicated negative check)
     *   - `1e9`    (scientific notation)
     *   - `0.5e2`  (mixed)
     *   - `5,5`    (locale comma)
     *   - any non-digit character
     *   - any non-ASCII digit (Arabic-Indic `٥`, Devanagari `५`, full-width `５`, etc.)
     *
     * BigDecimal accepts `.5`, `5.`, `+1`, scientific notation, AND
     * Unicode digit characters (e.g. Arabic-Indic `٥٠٠` parses as 500) —
     * all inputs the Node side rejects. Without this regex the Kotlin
     * parser would be strictly more permissive than Node, producing a
     * stored cap value on Android that Node-side routing math then
     * rejects, leaving the cap UI claiming success while routing silently
     * degrades to main.
     *
     * **Why `[0-9]` and not `\d` (R10):** in Java/Kotlin regex `\d` is
     * ASCII-only by default (unlike Python or JavaScript-with-`/u`-flag),
     * but the spec is subtle and easy to misread. Spelling the character
     * class out as `[0-9]` makes the ASCII-strict intent self-evident
     * from the regex itself — no "trust me, I read the Pattern javadoc"
     * required. Node's default `\d` semantics are the same (ASCII-only
     * without the `u` flag), so `[0-9]` is byte-for-byte parity with
     * Node's `^\d+(\.\d+)?$`.
     */
    private val DECIMAL_RE = Regex("""^[0-9]+(\.[0-9]+)?$""")

    /**
     * BAT-582 R11: input-length cap on the parser to prevent paste-DoS
     * via the Settings UI. R10 hardened the seven Node-side BigInt-of-
     * untrusted-string sites with explicit digit-length caps; the same
     * defense applies here. Without a cap, pasting a multi-MB string
     * into a SOL/USDC cap field would block the UI thread on the regex
     * match + BigDecimal allocation (BigDecimal parses are roughly
     * O(n²) on input length for large strings).
     *
     * **Why 40:** the largest realistic atomic-amount input is ~30
     * characters wide (1 trillion SOL = `1` followed by 12 digits and
     * 9 fractional digits = 22 chars; we leave headroom). 40 is
     * generous enough that no user could reasonably hit it and tight
     * enough that worst-case parser cost is single-digit microseconds.
     * The Node-side equivalent is `_MAX_ATOMIC_DIGITS_X402 = 30` in
     * payment/x402.js — we set Kotlin slightly higher because the
     * Kotlin regex accepts the decimal-point character (the Node-side
     * `_parseAmountAtomic` rejects fractional input, so its 30-char
     * cap is digits-only).
     */
    private const val MAX_DECIMAL_INPUT_LEN = 40

    /**
     * Decimal SOL string -> lamports BigInteger, or null on parse failure.
     * Accepts forms: "0.5", "0", "1.234567890". Rejects: ".5" (no leading
     * digit), "5." (trailing dot), "1e-9", "0,5", "-1", "+1", "", "abc".
     * See [DECIMAL_RE] for the full reject list and Node-side parity.
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
        // BAT-582 R11: paste-DoS defense. Bail BEFORE the regex — Java's
        // regex engine is well-behaved on a simple pattern like ours, but
        // the BigDecimal allocation downstream is O(n²) on input length.
        // We check `decimal.length` (not `trimmed.length`) so a paste of
        // 10MB-of-spaces also gets rejected up-front instead of allocating
        // a giant trim copy first. See [MAX_DECIMAL_INPUT_LEN] for rationale.
        if (decimal.length > MAX_DECIMAL_INPUT_LEN) return null
        // Trim to match Node's `String(decimal).trim()` behavior in
        // caps/preflight.js#_decimalToAtomic. (Node side does trim, so
        // trimming here is parity, not divergence — verified 2026-05-06.)
        val trimmed = decimal.trim()
        if (trimmed.isEmpty()) return null
        // BAT-582 R4 / R10: single regex pre-check that mirrors the
        // Node-side `^\d+(\.\d+)?$` exactly. This is the contract
        // boundary: any input that fails this regex MUST be rejected so
        // the Kotlin parser is byte-for-byte identical to Node's. The
        // regex (using ASCII-strict `[0-9]` rather than Java's `\d`)
        // rejects scientific notation, locale comma, negative, leading
        // '+', leading '.', trailing '.', unicode digits (Arabic-Indic,
        // Devanagari, full-width, etc.), and any non-numeric character —
        // so the individual `contains`/`startsWith` checks from R1/R2
        // are subsumed by this single gate. See [DECIMAL_RE] for the
        // rationale.
        if (!DECIMAL_RE.matches(trimmed)) return null

        val bd = try {
            BigDecimal(trimmed)
        } catch (_: NumberFormatException) {
            // Defense-in-depth — the regex already guarantees BigDecimal
            // parses, but a surprise from the JDK should still degrade
            // gracefully rather than crash.
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
