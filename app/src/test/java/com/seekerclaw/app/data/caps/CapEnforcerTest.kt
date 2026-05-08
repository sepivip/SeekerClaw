package com.seekerclaw.app.data.caps

import com.seekerclaw.app.util.CrossProcessStore
import kotlinx.coroutines.async
import kotlinx.coroutines.awaitAll
import kotlinx.coroutines.runBlocking
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotEquals
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertTrue
import org.junit.Before
import org.junit.Test
import java.io.File
import java.math.BigInteger

/**
 * Pure JVM tests for CapEnforcer + ReservationLedger (BAT-582).
 *
 * Uses the test-only [CrossProcessStore] constructor (no Context) so we
 * can drive the production reserve/commit/release/sweep state machine
 * against a real tmp directory. Cross-process notification paths are
 * NOT exercised here — those are device tests.
 */
class CapEnforcerTest {

    private lateinit var workDir: File

    @Before
    fun setUp() {
        workDir = File.createTempFile("bat582-caps", "").apply {
            delete()
            mkdirs()
        }
    }

    @After
    fun tearDown() {
        workDir.deleteRecursively()
    }

    private fun makeEnforcer(
        clock: () -> Long = { 1_700_000_000_000L },
    ): Pair<CapEnforcer, ReservationLedger> {
        val store = CrossProcessStore(
            filesDir = workDir,
            fileName = BurnerCapsState.FILE_NAME,
            serializer = BurnerCapsState.serializer(),
            initial = BurnerCapsState(),
        )
        val ledger = ReservationLedger(store)
        val enforcer = CapEnforcer(ledger = ledger, clock = clock)
        return Pair(enforcer, ledger)
    }

    private suspend fun seedCaps(
        enforcer: CapEnforcer,
        perTxSol: String = "0",
        perTxUsdc: String = "0",
        dailySol: String = "0",
        dailyUsdc: String = "0",
    ) {
        enforcer.setCaps(perTxSol, perTxUsdc, dailySol, dailyUsdc)
    }

    // --- reserve / commit / release happy paths ---

    @Test
    fun `reserve under cap returns Ok with reservationId`() = runBlocking {
        val (enforcer, _) = makeEnforcer()
        seedCaps(enforcer, perTxSol = "100000000", dailySol = "1000000000")  // 0.1 / 1.0 SOL
        val r = enforcer.reserve("burner.daily.sol", BigInteger("50000000"))
        assertTrue("expected Ok, got $r", r is CapEnforcer.ReserveResult.Ok)
    }

    @Test
    fun `reserve over per-tx cap is rejected`() = runBlocking {
        val (enforcer, _) = makeEnforcer()
        seedCaps(enforcer, perTxSol = "10000000", dailySol = "1000000000")
        val r = enforcer.reserve("burner.daily.sol", BigInteger("50000000"))
        assertTrue(r is CapEnforcer.ReserveResult.Rejected)
        assertEquals("over_per_tx_cap", (r as CapEnforcer.ReserveResult.Rejected).reason)
    }

    @Test
    fun `reserve over daily cap is rejected`() = runBlocking {
        val (enforcer, _) = makeEnforcer()
        seedCaps(enforcer, perTxSol = "100000000", dailySol = "100000000")  // 0.1 SOL daily
        val r1 = enforcer.reserve("burner.daily.sol", BigInteger("60000000"))
        assertTrue(r1 is CapEnforcer.ReserveResult.Ok)
        // Second reservation pushes over daily cap
        val r2 = enforcer.reserve("burner.daily.sol", BigInteger("60000000"))
        assertTrue(r2 is CapEnforcer.ReserveResult.Rejected)
        assertEquals("over_daily_cap", (r2 as CapEnforcer.ReserveResult.Rejected).reason)
    }

    @Test
    fun `reserve when caps are zero returns burner_not_configured`() = runBlocking {
        val (enforcer, _) = makeEnforcer()
        // No caps set — caps default to "0"
        val r = enforcer.reserve("burner.daily.sol", BigInteger("1000"))
        assertTrue(r is CapEnforcer.ReserveResult.Rejected)
        assertEquals("burner_not_configured", (r as CapEnforcer.ReserveResult.Rejected).reason)
    }

    @Test
    fun `commit promotes reservation into spent total`() = runBlocking {
        val (enforcer, ledger) = makeEnforcer()
        seedCaps(enforcer, perTxSol = "100000000", dailySol = "200000000")
        val r = enforcer.reserve("burner.daily.sol", BigInteger("60000000"))
        assertTrue(r is CapEnforcer.ReserveResult.Ok)
        val resId = (r as CapEnforcer.ReserveResult.Ok).reservationId
        enforcer.commit(resId)

        val state = ledger.snapshot()
        assertEquals("60000000", state.spentSol)
        assertTrue("pending should be empty post-commit", state.pending.isEmpty())
    }

    @Test
    fun `release drops pending without spending`() = runBlocking {
        val (enforcer, ledger) = makeEnforcer()
        seedCaps(enforcer, perTxSol = "100000000", dailySol = "200000000")
        val r = enforcer.reserve("burner.daily.sol", BigInteger("60000000"))
        val resId = (r as CapEnforcer.ReserveResult.Ok).reservationId
        enforcer.release(resId, "user-cancelled")

        val state = ledger.snapshot()
        assertEquals("0", state.spentSol)
        assertTrue(state.pending.isEmpty())
    }

    @Test
    fun `double commit is idempotent (no-op on second call)`() = runBlocking {
        val (enforcer, ledger) = makeEnforcer()
        seedCaps(enforcer, perTxSol = "100000000", dailySol = "200000000")
        val r = enforcer.reserve("burner.daily.sol", BigInteger("50000000"))
        val resId = (r as CapEnforcer.ReserveResult.Ok).reservationId
        enforcer.commit(resId)
        enforcer.commit(resId)  // second commit should not double-count
        assertEquals("50000000", ledger.snapshot().spentSol)
    }

    @Test
    fun `double release is safe`() = runBlocking {
        val (enforcer, ledger) = makeEnforcer()
        seedCaps(enforcer, perTxSol = "100000000", dailySol = "200000000")
        val r = enforcer.reserve("burner.daily.sol", BigInteger("50000000"))
        val resId = (r as CapEnforcer.ReserveResult.Ok).reservationId
        enforcer.release(resId, "first")
        enforcer.release(resId, "second")
        // No spend, no pending — idempotent
        assertEquals("0", ledger.snapshot().spentSol)
        assertTrue(ledger.snapshot().pending.isEmpty())
    }

    // --- sweep ---

    @Test
    fun `sweepStale releases reservations past TTL`() = runBlocking {
        var now = 1_700_000_000_000L
        val clock = { now }
        val (enforcer, ledger) = makeEnforcer(clock)
        seedCaps(enforcer, perTxSol = "100000000", dailySol = "200000000")
        val r1 = enforcer.reserve("burner.daily.sol", BigInteger("10000000"), ttlMs = 60_000)
        val r2 = enforcer.reserve("burner.daily.sol", BigInteger("10000000"), ttlMs = 60_000)
        assertEquals(2, ledger.snapshot().pending.size)

        // Advance clock past TTL
        now += 70_000
        val released = enforcer.sweepStale()
        assertEquals(2, released)
        assertTrue(ledger.snapshot().pending.isEmpty())
        // Spent unchanged — sweep doesn't promote to spend
        assertEquals("0", ledger.snapshot().spentSol)
    }

    @Test
    fun `sweep leaves fresh reservations alone`() = runBlocking {
        var now = 1_700_000_000_000L
        val clock = { now }
        val (enforcer, ledger) = makeEnforcer(clock)
        seedCaps(enforcer, perTxSol = "100000000", dailySol = "200000000")
        enforcer.reserve("burner.daily.sol", BigInteger("10000000"), ttlMs = 60_000)
        now += 30_000  // halfway through TTL
        assertEquals(0, enforcer.sweepStale())
        assertEquals(1, ledger.snapshot().pending.size)
    }

    // --- mutex / concurrency ---

    @Test
    fun `concurrent reserves only let under-cap subset succeed`() = runBlocking {
        val (enforcer, _) = makeEnforcer()
        seedCaps(enforcer, perTxSol = "100000000", dailySol = "200000000")
        // Daily cap = 200000000 = 0.2 SOL. Each reserve is 50000000 = 0.05.
        // Up to 4 reservations fit under cap; 5th and beyond must be rejected.
        val results = (1..5).map {
            async {
                enforcer.reserve("burner.daily.sol", BigInteger("50000000"))
            }
        }.awaitAll()
        val oks = results.count { it is CapEnforcer.ReserveResult.Ok }
        val rejected = results.count { it is CapEnforcer.ReserveResult.Rejected }
        assertEquals("expected exactly 4 successful reservations under cap", 4, oks)
        assertEquals("expected exactly 1 rejection", 1, rejected)
    }

    // --- daily window rollover ---

    @Test
    fun `daily window rolls over after UTC midnight`() = runBlocking {
        var now = 1_700_000_000_000L  // arbitrary epoch ms
        val clock = { now }
        val (enforcer, ledger) = makeEnforcer(clock)
        seedCaps(enforcer, perTxSol = "100000000", dailySol = "100000000")  // 0.1 SOL daily
        val r1 = enforcer.reserve("burner.daily.sol", BigInteger("60000000"))
        assertTrue(r1 is CapEnforcer.ReserveResult.Ok)
        enforcer.commit((r1 as CapEnforcer.ReserveResult.Ok).reservationId)
        // Now at the limit. Next reserve in same window fails.
        val r2 = enforcer.reserve("burner.daily.sol", BigInteger("60000000"))
        assertTrue(r2 is CapEnforcer.ReserveResult.Rejected)
        // Roll forward 25 hours — past the next UTC midnight from this epoch.
        now += 25L * 60 * 60 * 1000
        val r3 = enforcer.reserve("burner.daily.sol", BigInteger("60000000"))
        assertTrue("after rollover, reserve should succeed: $r3", r3 is CapEnforcer.ReserveResult.Ok)
    }

    @Test
    fun `setCaps rejects malformed atomic strings`() = runBlocking {
        val (enforcer, _) = makeEnforcer()
        assertFalse(enforcer.setCaps(capPerTxSol = "not-a-number"))
        assertFalse(enforcer.setCaps(capPerTxSol = "-100"))
        assertTrue(enforcer.setCaps(capPerTxSol = "1000"))
    }

    // --- BAT-582 R2: lookupReservation ---

    @Test
    fun `lookupReservation returns NotFound for unknown id`() = runBlocking {
        val (enforcer, _) = makeEnforcer()
        val result = enforcer.lookupReservation("never-existed")
        assertTrue("expected NotFound, got $result", result is CapEnforcer.LookupResult.NotFound)
    }

    @Test
    fun `lookupReservation returns Pending for live reservation`() = runBlocking {
        val (enforcer, _) = makeEnforcer()
        seedCaps(enforcer, perTxSol = "100000000", dailySol = "200000000")
        val r = enforcer.reserve("burner.daily.sol", BigInteger("50000000"))
        val resId = (r as CapEnforcer.ReserveResult.Ok).reservationId

        val result = enforcer.lookupReservation(resId)
        assertTrue("expected Pending, got $result", result is CapEnforcer.LookupResult.Pending)
        val pending = result as CapEnforcer.LookupResult.Pending
        assertEquals("burner.daily.sol", pending.name)
        assertEquals(BigInteger("50000000"), pending.atomicAmount)
    }

    @Test
    fun `lookupReservation returns Expired for past-TTL reservation`() = runBlocking {
        var now = 1_700_000_000_000L
        val clock = { now }
        val (enforcer, _) = makeEnforcer(clock)
        seedCaps(enforcer, perTxSol = "100000000", dailySol = "200000000")
        val r = enforcer.reserve("burner.daily.sol", BigInteger("50000000"), ttlMs = 60_000)
        val resId = (r as CapEnforcer.ReserveResult.Ok).reservationId

        // Advance past TTL — reservation still in pending (sweep hasn't run)
        // but the lookup must classify it as Expired anyway.
        now += 70_000

        val result = enforcer.lookupReservation(resId)
        assertTrue("expected Expired, got $result", result is CapEnforcer.LookupResult.Expired)
    }

    @Test
    fun `lookupReservation returns NotPending for committed id`() = runBlocking {
        val (enforcer, _) = makeEnforcer()
        seedCaps(enforcer, perTxSol = "100000000", dailySol = "200000000")
        val r = enforcer.reserve("burner.daily.sol", BigInteger("50000000"))
        val resId = (r as CapEnforcer.ReserveResult.Ok).reservationId
        enforcer.commit(resId)

        val result = enforcer.lookupReservation(resId)
        assertTrue(
            "expected NotPending after commit, got $result",
            result is CapEnforcer.LookupResult.NotPending,
        )
    }

    @Test
    fun `lookupReservation returns NotPending for released id`() = runBlocking {
        val (enforcer, _) = makeEnforcer()
        seedCaps(enforcer, perTxSol = "100000000", dailySol = "200000000")
        val r = enforcer.reserve("burner.daily.sol", BigInteger("50000000"))
        val resId = (r as CapEnforcer.ReserveResult.Ok).reservationId
        enforcer.release(resId, "test")

        val result = enforcer.lookupReservation(resId)
        assertTrue(
            "expected NotPending after release, got $result",
            result is CapEnforcer.LookupResult.NotPending,
        )
    }

    @Test
    fun `lookupReservation does not mutate state`() = runBlocking {
        val (enforcer, ledger) = makeEnforcer()
        seedCaps(enforcer, perTxSol = "100000000", dailySol = "200000000")
        val r = enforcer.reserve("burner.daily.sol", BigInteger("50000000"))
        val resId = (r as CapEnforcer.ReserveResult.Ok).reservationId
        val sizeBefore = ledger.snapshot().pending.size

        enforcer.lookupReservation(resId)
        enforcer.lookupReservation("another-not-real-id")

        assertEquals(
            "lookupReservation must NOT mutate the pending ledger",
            sizeBefore,
            ledger.snapshot().pending.size,
        )
    }

    // --- ReservationLedger directly ---

    @Test
    fun `ledger sweep on stale reservations recovers cleanly`() = runBlocking {
        var now = 1_700_000_000_000L
        val store = CrossProcessStore(
            filesDir = workDir,
            fileName = BurnerCapsState.FILE_NAME,
            serializer = BurnerCapsState.serializer(),
            initial = BurnerCapsState(),
        )
        val ledger = ReservationLedger(store)
        ledger.add(
            ReservationLedger.Reservation(
                id = "stale-1",
                name = "burner.daily.sol",
                atomicAmount = BigInteger("1000"),
                createdAtMs = now,
                expiresAtMs = now + 100,
            )
        )
        now += 200
        assertEquals(1, ledger.sweepStale(now))
        assertTrue(ledger.snapshot().pending.isEmpty())
    }
}
