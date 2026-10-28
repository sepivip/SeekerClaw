package com.seekerclaw.app.data.caps

import com.seekerclaw.app.data.caps.ReservationLedger.NoRaiseResult
import com.seekerclaw.app.util.CrossProcessStore
import kotlinx.coroutines.CompletableDeferred
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.async
import kotlinx.coroutines.awaitAll
import kotlinx.coroutines.joinAll
import kotlinx.coroutines.launch
import kotlinx.coroutines.runBlocking
import kotlinx.coroutines.withContext
import kotlinx.coroutines.yield
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Before
import org.junit.Test
import java.io.File
import java.nio.file.Files
import java.util.concurrent.ConcurrentHashMap
import java.util.concurrent.ConcurrentLinkedQueue

/**
 * BAT-1409 P1-I — the bridge (agent) can lower or keep burner caps but never raise them; raising
 * is Settings-only (`setCaps`). Drives the real ledger over a temp CrossProcessStore.
 */
class CapNoRaiseTest {

    private lateinit var dir: File
    private lateinit var store: CrossProcessStore<BurnerCapsState>
    private lateinit var enforcer: CapEnforcer

    @Before
    fun setUp() {
        dir = Files.createTempDirectory("cap-noraise").toFile()
        store = CrossProcessStore(
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

    // ── Same-process race: bridge writes against concurrent Settings writes ──
    //
    // Every request writes a recognisable tuple: field i holds (i + 1) * 10^8 + r for the
    // request's id r, so one state names the request that wrote it, and a state whose four
    // fields name different requests is a mix. Ids order the tuples field by field:
    // bridge lowers (10_000 + k) < Settings writes (20_000 + k) < bridge raises (90_000_000 + k).

    private val allFields = listOf("capPerTxSol", "capPerTxUsdc", "capDailySol", "capDailyUsdc")

    private fun tuple(r: Int) = List(4) { i -> ((i + 1) * 100_000_000L + r).toString() }

    private fun fieldsOf(s: BurnerCapsState) = listOf(s.capPerTxSol, s.capPerTxUsdc, s.capDailySol, s.capDailyUsdc)

    /** The request that wrote [caps], or null when its fields come from different requests. */
    private fun requestOf(caps: List<String>): Int? =
        caps.mapIndexed { i, v -> v.toLong() - (i + 1) * 100_000_000L }.toSet().singleOrNull()?.toInt()

    private suspend fun settingsWrite(r: Int): Boolean = tuple(r).let { enforcer.setCaps(it[0], it[1], it[2], it[3]) }

    private suspend fun bridgeWrite(r: Int): NoRaiseResult? = tuple(r).let { enforcer.setCapsNoRaise(it[0], it[1], it[2], it[3]) }

    @Test
    fun aBridgeRaiseNeverLandsAndRequestsNeverMixUnderConcurrentWrites() = runBlocking {
        assertTrue(settingsWrite(20_000))
        val settingsWritten = ConcurrentHashMap.newKeySet<Int>().apply { add(20_000) }
        val lowersApplied = ConcurrentHashMap.newKeySet<Int>()
        val raiseResults = ConcurrentLinkedQueue<NoRaiseResult?>()
        val lowerResults = ConcurrentLinkedQueue<NoRaiseResult?>()
        val seen = ConcurrentLinkedQueue<BurnerCapsState>()
        val workers = 4
        val perWorker = 40
        withContext(Dispatchers.Default) {
            val gate = CompletableDeferred<Unit>()
            val writers = (0 until workers).flatMap { w ->
                listOf(
                    launch {
                        gate.await()
                        repeat(perWorker) { i ->
                            val r = 20_001 + w * perWorker + i
                            assertTrue(settingsWrite(r))
                            settingsWritten += r
                        }
                    },
                    launch {
                        gate.await()
                        repeat(perWorker) { i ->
                            val r = 10_000 + w * perWorker + i
                            val res = bridgeWrite(r)
                            lowerResults += res
                            if (res == NoRaiseResult.Applied) lowersApplied += r
                        }
                    },
                    launch {
                        gate.await()
                        repeat(perWorker) { i -> raiseResults += bridgeWrite(90_000_000 + w * perWorker + i) }
                    },
                )
            }
            // Watch the published state while the writers run (in memory: no file reads mid-race).
            val watcher = launch {
                gate.await()
                var samples = 0
                while (writers.any { it.isActive } && samples < 100_000) {
                    seen += store.state.value
                    samples++
                    yield()
                }
            }
            gate.complete(Unit)
            writers.joinAll()
            watcher.join()
        }

        assertEquals(workers * perWorker, raiseResults.size)
        for (r in raiseResults) assertEquals("every bridge raise is refused, every field named", NoRaiseResult.Raised(allFields), r)
        for (r in lowerResults) assertTrue("a lower is applied or refused, never failed: $r", r == NoRaiseResult.Applied || r is NoRaiseResult.Raised)
        for (s in seen) {
            val r = requestOf(fieldsOf(s))
            assertTrue("a mixed state was published: ${fieldsOf(s)}", r != null)
            assertTrue("a bridge raise was published: ${fieldsOf(s)}", r!! < 90_000_000)
        }
        val final = requestOf(fieldsOf(store.read()))
        assertTrue("the final caps mix requests", final != null)
        assertTrue("the final caps ($final) were written by a Settings write or an applied bridge lower", final in settingsWritten || final in lowersApplied)
    }

    @Test
    fun aBridgeLowerCheckedBeforeASettingsWriteNeverLandsAboveIt() = runBlocking {
        // Each round: caps at P (Settings, 30_000); then, all at once, Settings writes S (round id,
        // below every lower) and eight bridge lowers write L (S < L < P). A lower that runs before
        // S is overwritten by S; one that runs after S is a raise over S and is refused. So the
        // round always ends at S — unless a lower's no-raise check ran on a state older than the
        // one it overwrote (the check must run inside store.update).
        repeat(60) { round ->
            assertTrue(settingsWrite(30_000))
            val s = 20_000 + round
            val results = withContext(Dispatchers.Default) {
                val gate = CompletableDeferred<Unit>()
                val lowers = (0 until 8).map { k -> async { gate.await(); bridgeWrite(25_000 + k) } }
                val settings = async { gate.await(); settingsWrite(s) }
                gate.complete(Unit)
                assertTrue(settings.await())
                lowers.awaitAll()
            }
            for (r in results) assertTrue("round $round: $r", r == NoRaiseResult.Applied || r is NoRaiseResult.Raised)
            assertEquals("round $round ends at the Settings write", tuple(s), fieldsOf(store.read()))
        }
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
