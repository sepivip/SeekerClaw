package com.seekerclaw.app.bridge.burner

import com.seekerclaw.app.util.CrossProcessStore
import kotlinx.coroutines.runBlocking
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Before
import org.junit.Test
import java.io.File

/**
 * Pure JVM tests for JupiterOwnershipEndpoint (BAT-582).
 *
 * Uses the test-only [CrossProcessStore] constructor so we can drive
 * the production set/get path against a real tmp dir without a Context.
 */
class JupiterOwnershipEndpointTest {

    private lateinit var workDir: File

    @Before
    fun setUp() {
        workDir = File.createTempFile("bat582-jup", "").apply {
            delete()
            mkdirs()
        }
    }

    @After
    fun tearDown() {
        workDir.deleteRecursively()
    }

    private fun newEndpoint(): Pair<JupiterOwnershipEndpoint, CrossProcessStore<JupiterOwnershipState>> {
        val store = CrossProcessStore(
            filesDir = workDir,
            fileName = JupiterOwnershipState.FILE_NAME,
            serializer = JupiterOwnershipState.serializer(),
            initial = JupiterOwnershipState(),
        )
        return Pair(JupiterOwnershipEndpoint(store), store)
    }

    @Test
    fun `set then get round-trips`() = runBlocking {
        val (endpoint, _) = newEndpoint()
        assertTrue(endpoint.set("order-1", "burner"))
        assertEquals("burner", endpoint.get("order-1"))
    }

    @Test
    fun `get returns null for unknown order`() = runBlocking {
        val (endpoint, _) = newEndpoint()
        assertNull(endpoint.get("never-set"))
    }

    @Test
    fun `set rejects invalid roles`() = runBlocking {
        val (endpoint, _) = newEndpoint()
        assertFalse(endpoint.set("order-1", "external"))
        assertFalse(endpoint.set("order-1", ""))
        assertNull(endpoint.get("order-1"))
    }

    @Test
    fun `set rejects empty orderId`() = runBlocking {
        val (endpoint, _) = newEndpoint()
        assertFalse(endpoint.set("", "burner"))
    }

    @Test
    fun `idempotent re-set with same role is a no-op`() = runBlocking {
        val (endpoint, _) = newEndpoint()
        assertTrue(endpoint.set("order-1", "burner"))
        assertTrue(endpoint.set("order-1", "burner"))  // re-set same role
        assertEquals("burner", endpoint.get("order-1"))
    }

    /**
     * R3 review (Copilot): the same-role fast-path must NOT call
     * CrossProcessStore.update — that always rewrites the file and
     * broadcasts cross-process. We assert this by injecting a sentinel
     * into the on-disk file between writes; if `set()` short-circuits
     * before `update()`, the sentinel survives. If it doesn't, the
     * `update()` round-trip re-encodes from the schema and drops the
     * sentinel.
     *
     * This is a behavioral test of the contract "same-role re-set
     * does not touch disk", not an implementation test — it would
     * still pass if a future refactor short-circuited via a different
     * mechanism, as long as the no-write contract holds.
     */
    @Test
    fun `same-role re-set does not rewrite the persisted file`() = runBlocking {
        val (endpoint, _) = newEndpoint()
        assertTrue(endpoint.set("order-1", "burner"))

        // Sentinel: append a non-schema field to the persisted JSON.
        // CrossProcessStore.read() honors `ignoreUnknownKeys = true`,
        // so it parses without complaint. If `set()` falls through
        // to `store.update {}`, the read+transform+encode pipeline
        // re-emits ONLY the schema fields and the sentinel disappears.
        // If `set()` correctly short-circuits, the sentinel survives.
        val file = File(workDir, JupiterOwnershipState.FILE_NAME)
        val original = file.readText()
        assertTrue("expected file to exist after first set", file.exists())
        // Inject sentinel by inserting a new key before the closing brace.
        val sentinelMark = "\"_sentinel_r3\":\"survived\""
        val sentinelText = original.replaceFirst("\"orders\"", "$sentinelMark,\"orders\"")
        assertTrue("sentinel injection failed", sentinelText.contains("_sentinel_r3"))
        file.writeText(sentinelText)

        // Same-role re-set — must NOT rewrite file (must NOT call update()).
        assertTrue(endpoint.set("order-1", "burner"))

        // If short-circuit fires, sentinel survives. If update() is called,
        // it re-encodes from the schema and drops the sentinel.
        val afterReSet = file.readText()
        assertTrue(
            "expected sentinel to survive same-role re-set, got: $afterReSet",
            afterReSet.contains("_sentinel_r3"),
        )

        // Logical state still correct (read tolerates the unknown key).
        assertEquals("burner", endpoint.get("order-1"))
    }

    /**
     * R3 review: the conflict path (different role on same orderId)
     * must still call update() and overwrite. Sentinel is dropped.
     */
    @Test
    fun `conflicting role re-set does call update and overwrites`() = runBlocking {
        val (endpoint, _) = newEndpoint()
        assertTrue(endpoint.set("order-1", "burner"))

        val file = File(workDir, JupiterOwnershipState.FILE_NAME)
        val original = file.readText()
        val sentinelMark = "\"_sentinel_r3\":\"survived\""
        file.writeText(original.replaceFirst("\"orders\"", "$sentinelMark,\"orders\""))

        // Different role — fast-path must NOT fire; update() runs.
        assertTrue(endpoint.set("order-1", "main"))

        val afterReSet = file.readText()
        assertFalse(
            "expected sentinel to be dropped by update() round-trip, got: $afterReSet",
            afterReSet.contains("_sentinel_r3"),
        )
        assertEquals("main", endpoint.get("order-1"))
    }

    @Test
    fun `re-set with different role overwrites`() = runBlocking {
        val (endpoint, _) = newEndpoint()
        endpoint.set("order-1", "burner")
        endpoint.set("order-1", "main")
        assertEquals("main", endpoint.get("order-1"))
    }

    @Test
    fun `multiple orders persist independently`() = runBlocking {
        val (endpoint, _) = newEndpoint()
        endpoint.set("order-a", "burner")
        endpoint.set("order-b", "main")
        endpoint.set("order-c", "burner")
        assertEquals("burner", endpoint.get("order-a"))
        assertEquals("main", endpoint.get("order-b"))
        assertEquals("burner", endpoint.get("order-c"))
    }

    @Test
    fun `state persists across endpoint instance restart`() = runBlocking {
        // Write via one endpoint instance
        val (endpoint1, _) = newEndpoint()
        endpoint1.set("order-1", "burner")
        endpoint1.set("order-2", "main")

        // Re-instantiate against the same workDir — simulates a process
        // restart. The store re-reads the persisted file.
        val (endpoint2, _) = newEndpoint()
        assertEquals("burner", endpoint2.get("order-1"))
        assertEquals("main", endpoint2.get("order-2"))
    }
}
