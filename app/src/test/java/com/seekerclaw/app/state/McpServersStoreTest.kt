package com.seekerclaw.app.state

import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Before
import org.junit.Test

/**
 * Pure JVM tests for McpServersStore's validity gate, normalization,
 * and collector path (BAT-514).
 *
 * Same convention as RuntimeStateStoreTest / CrossProcessStoreTest: the
 * Android-specific surfaces (FileObserver, BroadcastReceiver,
 * Keystore-backed token I/O, NodeControlClient HTTP) are validated by
 * device test or by separate integration tests, not here.
 *
 * The collector path is exercised via the internal
 * [McpServersStore.onObserved] entry point — driving the singleton
 * directly without spinning up a real CrossProcessStore.
 */
class McpServersStoreTest {

    @Before
    fun setUp() {
        McpServersStore.resetForTest()
    }

    @After
    fun tearDown() {
        McpServersStore.resetForTest()
    }

    // ---------- isValid predicate ----------

    @Test
    fun `isValid accepts canonical id name url rateLimit`() {
        val s = McpServer(id = "context7", name = "Context7", url = "https://api.example.com/mcp", rateLimit = 10)
        assertTrue(McpServersStore.isValid(s))
    }

    @Test
    fun `isValid rejects empty id`() {
        val s = McpServer(id = "", name = "x", url = "https://x", rateLimit = 1)
        assertFalse(McpServersStore.isValid(s))
    }

    @Test
    fun `isValid rejects id with whitespace`() {
        val s = McpServer(id = "context 7", name = "x", url = "https://x", rateLimit = 1)
        assertFalse(McpServersStore.isValid(s))
    }

    @Test
    fun `isValid rejects id with shell-meta chars`() {
        // The Node side normalizes these to "_" via safeId, but the
        // Kotlin write boundary rejects them outright so the file
        // never carries an id that needs normalization on read.
        for (bad in listOf("a/b", "a;b", "a b", "a\$b", "a.b", "🦄", "a/../b")) {
            val s = McpServer(id = bad, name = "x", url = "https://x", rateLimit = 1)
            assertFalse("expected reject: id='$bad'", McpServersStore.isValid(s))
        }
    }

    @Test
    fun `isValid rejects blank name`() {
        val s = McpServer(id = "ctx", name = "  ", url = "https://x", rateLimit = 1)
        assertFalse(McpServersStore.isValid(s))
    }

    @Test
    fun `isValid rejects rateLimit zero or negative`() {
        val zero = McpServer(id = "ctx", name = "n", url = "https://x", rateLimit = 0)
        val neg = McpServer(id = "ctx", name = "n", url = "https://x", rateLimit = -1)
        assertFalse(McpServersStore.isValid(zero))
        assertFalse(McpServersStore.isValid(neg))
    }

    @Test
    fun `isValid rejects bad URL schemes`() {
        for (bad in listOf("ftp://x", "file:///etc/passwd", "javascript:alert(1)", "data:text/plain,foo", "")) {
            val s = McpServer(id = "ctx", name = "n", url = bad, rateLimit = 1)
            assertFalse("expected reject: url='$bad'", McpServersStore.isValid(s))
        }
    }

    @Test
    fun `isValid accepts http and https`() {
        // http alone is valid at the matrix level — the bearer-over-
        // insecure-HTTP rule is enforced separately at write boundary
        // (when a token is also present).
        val httpsS = McpServer(id = "ctx", name = "n", url = "https://example.com/mcp", rateLimit = 1)
        val httpS = McpServer(id = "ctx", name = "n", url = "http://localhost:8080/mcp", rateLimit = 1)
        assertTrue(McpServersStore.isValid(httpsS))
        assertTrue(McpServersStore.isValid(httpS))
    }

    @Test
    fun `isValid rejects URL without host`() {
        val s = McpServer(id = "ctx", name = "n", url = "https:///path", rateLimit = 1)
        assertFalse(McpServersStore.isValid(s))
    }

    // ---------- collector path (onObserved) ----------

    @Test
    fun `onObserved drops corrupt entries and keeps the rest`() {
        val good = McpServer(id = "ok1", name = "OK1", url = "https://a", rateLimit = 5)
        val bad = McpServer(id = "bad id", name = "x", url = "https://b", rateLimit = 1)
        val good2 = McpServer(id = "ok2", name = "OK2", url = "https://c", rateLimit = 3)
        val cleaned = McpServersStore.onObserved(McpServersFile(servers = listOf(good, bad, good2)))
        assertEquals(listOf(good, good2), cleaned)
        assertEquals(listOf(good, good2), McpServersStore.state.value)
    }

    @Test
    fun `onObserved drops duplicate ids keeping the first`() {
        // Both Kotlin's normalizeId and Node's safeId preserve the
        // ID_REGEX-allowed alphabet (alpha + digit + `_` + `-`)
        // unchanged, so any two entries that normalize to the same
        // bucket must already share an exact id. The collision check
        // is identity for in-spec ids, but kept as defense-in-depth
        // for a future ID_REGEX loosening.
        val first = McpServer(id = "ctx", name = "First", url = "https://a", rateLimit = 1)
        val collide = McpServer(id = "ctx", name = "Collide", url = "https://b", rateLimit = 1)
        val third = McpServer(id = "different", name = "Third", url = "https://c", rateLimit = 1)
        val cleaned = McpServersStore.onObserved(
            McpServersFile(servers = listOf(first, collide, third)),
        )
        assertEquals(listOf(first, third), cleaned)
    }

    @Test
    fun `onObserved on empty file publishes empty list`() {
        val cleaned = McpServersStore.onObserved(McpServersFile(servers = emptyList()))
        assertTrue(cleaned.isEmpty())
        assertTrue(McpServersStore.state.value.isEmpty())
    }

    @Test
    fun `onObserved with all-corrupt input publishes empty list`() {
        val corrupt = listOf(
            McpServer(id = "", name = "x", url = "https://a", rateLimit = 1),
            McpServer(id = "ok", name = "x", url = "ftp://b", rateLimit = 1),
            McpServer(id = "ok2", name = "", url = "https://c", rateLimit = 1),
        )
        val cleaned = McpServersStore.onObserved(McpServersFile(servers = corrupt))
        assertTrue("all entries corrupt → cleaned is empty", cleaned.isEmpty())
    }

    // ---------- drift guards ----------

    @Test
    fun `ID_REGEX is exactly the documented set`() {
        // Drift guard: the contract pins this to ^[A-Za-z0-9_-]+$.
        // Node's safeId normalization in mcp-client.js uses
        // `replace(/[^a-zA-Z0-9_-]/g, '_')` and PRESERVES "-" — the
        // alphabet here matches that exactly so canonical mcp ids
        // like "server-1" pass through both sides unchanged. The
        // post-normalization uniqueness check is identity for any
        // in-spec id; kept as defense-in-depth in case the regex
        // is ever loosened to allow characters Node would fold
        // (e.g. "." -> "_" via safeId).
        val good = listOf("a", "A", "0", "_", "-", "abc", "a-b_c", "Z9_-")
        val bad = listOf("", " ", "a b", "a/b", "a.b", "a;b", "🦄", "a/../b")
        for (g in good) {
            assertTrue("'$g' should match", McpServersStore.isValid(
                McpServer(id = g, name = "n", url = "https://x", rateLimit = 1),
            ))
        }
        for (b in bad) {
            assertFalse("'$b' should not match", McpServersStore.isValid(
                McpServer(id = b, name = "n", url = "https://x", rateLimit = 1),
            ))
        }
    }

    @Test
    fun `reasonFor distinguishes failure modes`() {
        val badId = McpServer(id = "x y", name = "n", url = "https://h", rateLimit = 1)
        val badName = McpServer(id = "x", name = "  ", url = "https://h", rateLimit = 1)
        val badUrl = McpServer(id = "x", name = "n", url = "ftp://h", rateLimit = 1)
        val badRate = McpServer(id = "x", name = "n", url = "https://h", rateLimit = 0)
        val ok = McpServer(id = "x", name = "n", url = "https://h", rateLimit = 1)
        assertTrue(McpServersStore.reasonFor(badId).contains("id"))
        assertTrue(McpServersStore.reasonFor(badName).contains("name"))
        assertTrue(McpServersStore.reasonFor(badUrl).contains("url"))
        assertTrue(McpServersStore.reasonFor(badRate).contains("rateLimit"))
        assertEquals("ok", McpServersStore.reasonFor(ok))
    }
}
