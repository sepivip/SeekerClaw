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
