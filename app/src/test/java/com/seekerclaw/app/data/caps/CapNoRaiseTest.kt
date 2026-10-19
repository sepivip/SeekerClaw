package com.seekerclaw.app.data.caps

import com.seekerclaw.app.data.caps.ReservationLedger.NoRaiseResult
import com.seekerclaw.app.util.CrossProcessStore
import kotlinx.coroutines.runBlocking
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Before
import org.junit.Test
import java.io.File
import java.nio.file.Files

/**
 * BAT-1409 P1-I — the bridge (agent) can lower or keep burner caps but never raise them; raising
 * is Settings-only (`setCaps`). Drives the real ledger over a temp CrossProcessStore.
 */
class CapNoRaiseTest {

    private lateinit var dir: File
    private lateinit var enforcer: CapEnforcer

    @Before
    fun setUp() {
        dir = Files.createTempDirectory("cap-noraise").toFile()
        val store = CrossProcessStore(
            filesDir = dir,
            fileName = BurnerCapsState.FILE_NAME,
            serializer = BurnerCapsState.serializer(),
            initial = BurnerCapsState(),
        )
        enforcer = CapEnforcer(ledger = ReservationLedger(store), clock = { 1_700_000_000_000L })
    }

    @After
    fun tearDown() {
        dir.deleteRecursively()
    }

    private fun settings(perTxSol: String, dailySol: String, perTxUsdc: String = "0", dailyUsdc: String = "0") = runBlocking {
        assertTrue(enforcer.setCaps(capPerTxSol = perTxSol, capPerTxUsdc = perTxUsdc, capDailySol = dailySol, capDailyUsdc = dailyUsdc))
    }

    private fun status() = runBlocking { enforcer.status() }

    @Test
    fun loweringAndKeepingApply() = runBlocking {
        settings(perTxSol = "100", dailySol = "1000")
        assertEquals(NoRaiseResult.Applied, enforcer.setCapsNoRaise(capPerTxSol = "50", capDailySol = "1000"))
        assertEquals("50", status().capPerTxSol)
        assertEquals("1000", status().capDailySol)
    }

    @Test
    fun anyRaisingFieldRejectsTheWholeRequest() = runBlocking {
        settings(perTxSol = "100", dailySol = "1000")
        val r = enforcer.setCapsNoRaise(capPerTxSol = "50", capDailySol = "1001")
        assertEquals(NoRaiseResult.Raised(listOf("capDailySol")), r)
        assertEquals("nothing applied, not even the lowered field", "100", status().capPerTxSol)
        assertEquals("1000", status().capDailySol)
    }

    @Test
    fun anyPositiveValueOverAZeroOrBlankCapIsARaise() = runBlocking {
        // A fresh store holds blank caps; Settings-set zero means "disabled".
        assertEquals(NoRaiseResult.Raised(listOf("capPerTxSol")), enforcer.setCapsNoRaise(capPerTxSol = "1"))
        settings(perTxSol = "0", dailySol = "0")
        assertEquals(NoRaiseResult.Raised(listOf("capPerTxSol", "capDailySol")), enforcer.setCapsNoRaise(capPerTxSol = "1", capDailySol = "5"))
        assertEquals(NoRaiseResult.Applied, enforcer.setCapsNoRaise(capPerTxSol = "0"))
    }

    @Test
    fun comparisonIsInAtomicIntegerUnitsNotText() = runBlocking {
        settings(perTxSol = "9", dailySol = "100")
        // "10" sorts before "9" as text; as an integer it is a raise.
        assertEquals(NoRaiseResult.Raised(listOf("capPerTxSol")), enforcer.setCapsNoRaise(capPerTxSol = "10"))
        assertEquals(NoRaiseResult.Applied, enforcer.setCapsNoRaise(capDailySol = "099"))
    }

    @Test
    fun invalidValuesAreRefusedBeforeAnyWrite() = runBlocking {
        settings(perTxSol = "100", dailySol = "1000")
        assertNull(enforcer.setCapsNoRaise(capPerTxSol = "-1"))
        assertNull(enforcer.setCapsNoRaise(capPerTxSol = "1.5"))
        assertEquals("100", status().capPerTxSol)
    }

    @Test
    fun settingsCanStillRaise() = runBlocking {
        settings(perTxSol = "100", dailySol = "1000")
        settings(perTxSol = "500", dailySol = "5000")
        assertEquals("500", status().capPerTxSol)
    }

    @Test
    fun theBridgeRouteUsesTheNoRaiseSetterAndSettingsKeepsSetCaps() {
        val src = File("src/main/java/com/seekerclaw/app")
        val bridge = File(src, "bridge/burner/BurnerBridgeEndpoints.kt").readText()
        assertTrue(bridge.contains("capEnforcer.setCapsNoRaise("))
        assertTrue("the bridge never calls the raising setter", !Regex("""capEnforcer\.setCaps\(""").containsMatchIn(bridge))
        assertTrue(bridge.contains("CAP_RAISE_SETTINGS_ONLY = \"cap_raise_settings_only\""))
        val callers = src.walkTopDown().filter { it.isFile && it.name.endsWith(".kt") }
            .filter { Regex("""\.setCaps\(""").containsMatchIn(it.readText()) }.map { it.name }.toSet()
        assertEquals(setOf("BurnerWalletScreen.kt"), callers)
    }
}
