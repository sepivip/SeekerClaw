package com.seekerclaw.app.bridge.burner

import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test
import java.io.File

/** BAT-1409 P1-K — a bridge reservation lives at most 120 s; the default stays 60 s. */
class ReservationTtlTest {

    @Test
    fun longerRequestsAreClampedTo120Seconds() {
        assertEquals(120_000L, BurnerBridgeEndpoints.reservationTtlMs(120_001L))
        assertEquals(120_000L, BurnerBridgeEndpoints.reservationTtlMs(10 * 60_000L))
        assertEquals(120_000L, BurnerBridgeEndpoints.MAX_RESERVATION_TTL_MS)
    }

    @Test
    fun shorterRequestsAndTheDefaultAreUnchanged() {
        assertEquals(60_000L, BurnerBridgeEndpoints.reservationTtlMs(60_000L))
        assertEquals(1L, BurnerBridgeEndpoints.reservationTtlMs(1L))
        assertEquals(120_000L, BurnerBridgeEndpoints.reservationTtlMs(120_000L))
    }

    @Test
    fun invalidValuesStayInvalid() {
        assertNull(BurnerBridgeEndpoints.reservationTtlMs(0L))
        assertNull(BurnerBridgeEndpoints.reservationTtlMs(-5L))
        assertNull(BurnerBridgeEndpoints.reservationTtlMs(10 * 60_000L + 1))
    }

    @Test
    fun theReserveHandlerUsesTheClampAndNodeAsksFor60Seconds() {
        val src = File("src/main/java/com/seekerclaw/app/bridge/burner/BurnerBridgeEndpoints.kt").readText()
        assertTrue("handleReserve must go through reservationTtlMs", src.contains("reservationTtlMs(requestedTtlMs)"))
        // No Node caller asks for more than the default (contract: confirm at implementation).
        // Every file that reserves (`/burner/reserve`) is scanned; each `ttlMs:` value must be a
        // number we can evaluate — a literal (`60000`, `600_000`, `10 * 60_000`) or a `const` of one
        // in the same file. Anything else fails, so a too-long TTL cannot hide in an expression.
        val bundle = File("src/main/assets/nodejs-project")
        val reservers = bundle.walkTopDown()
            .filter { it.isFile && it.name.endsWith(".js") && !it.path.contains("node_modules") }
            .filter { it.readText().contains("'/burner/reserve'") }
            .toList()
        assertEquals(setOf("agent_pay.js", "dispatch.js"), reservers.map { it.name }.toSet())
        val reserveCalls = reservers.sumOf { Regex("""'/burner/reserve'""").findAll(it.readText()).count() }
        val asks = reservers.flatMap { f ->
            val text = f.readText()
            Regex("""ttlMs:\s*([^,}\n]+)""").findAll(text).map { nodeTtl(text, it.groupValues[1].trim(), f.name) }.toList()
        }
        assertEquals("exactly one TTL per reserve call: $asks", reserveCalls, asks.size)
        assertTrue("every Node caller asks for <= 120 s: $asks", asks.all { it <= 120_000L })
    }

    @Test
    fun theNodeTtlScanReadsSeparatorsExpressionsAndConstants() {
        // The scan itself must be able to fail (CodeRabbit on #459): these all evaluate in full.
        assertEquals(600_000L, nodeTtl("", "600_000", "t.js"))
        assertEquals(600_000L, nodeTtl("", "10 * 60_000", "t.js"))
        assertEquals(60_000L, nodeTtl("const RESERVE_TTL_MS = 60 * 1000;   // 60 s", "RESERVE_TTL_MS", "t.js"))
        assertEquals(61_000L, nodeTtl("", "60000 + 1_000", "t.js"))
        for (bad in listOf("someFunction()", "UNKNOWN_CONST", "x.ttl", "60e3")) {
            val err = runCatching { nodeTtl("", bad, "t.js") }.exceptionOrNull()
            assertTrue("a non-literal TTL fails the scan: $bad", err is IllegalStateException)
        }
    }

    /** A Node `ttlMs:` value: digits with `_`, `*`, `+`, or a same-file `const` of one. */
    private fun nodeTtl(fileText: String, expr: String, file: String): Long {
        val value = if (Regex("""^[A-Za-z_$][\w$]*$""").matches(expr)) {
            Regex("""const\s+${Regex.escape(expr)}\s*=\s*([^;\n]+);""").find(fileText)?.groupValues?.get(1)?.trim()
                ?: error("Node reservation TTL in $file is a name with no const literal: $expr")
        } else {
            expr
        }
        val clean = value.substringBefore("//").trim()
        if (!Regex("""^[\d_]+(\s*[*+]\s*[\d_]+)*$""").matches(clean)) {
            error("non-literal Node reservation TTL in $file: $expr")
        }
        return clean.split("+").sumOf { term -> term.split("*").fold(1L) { acc, n -> acc * n.trim().replace("_", "").toLong() } }
    }
}
