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
        val bundle = File("src/main/assets/nodejs-project")
        val asks = bundle.walkTopDown()
            .filter { it.isFile && it.name.endsWith(".js") && !it.path.contains("node_modules") }
            .flatMap { f -> Regex("""ttlMs:\s*(\d+)""").findAll(f.readText()).map { it.groupValues[1].toLong() } }
            .toList()
        assertTrue("found Node reservation TTLs", asks.isNotEmpty())
        assertTrue("every Node caller asks for <= 120 s: $asks", asks.all { it <= 120_000L })
    }
}
