package com.seekerclaw.app.bridge.burner

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * Pure-JVM tests for the response allowlist + scrubber on
 * BurnerBridgeEndpoints (BAT-582).
 *
 * The endpoint dispatch handlers themselves require a Context to wire
 * KeyVault + CapEnforcer + JupiterOwnership; those are covered by
 * device tests (instrumented). The scrubber path is the ONE thing we
 * MUST exercise in pure JVM — it's the defense-in-depth gate that
 * stops accidental key bytes from leaving Android in any response.
 */
class BurnerBridgeEndpointsTest {

    private fun newEndpoints(): BurnerBridgeEndpoints {
        // Build via reflection-bypass: use a no-op fake KeyVault +
        // ledger-less CapEnforcer + ownership, since scrubResponse is
        // a pure function and doesn't touch any of them. We just need
        // an instance to call .scrubResponse on.
        // We achieve this with a minimal construction by passing null
        // through unchecked casts — but we don't actually invoke any
        // dispatch handler in this test, only the pure scrubResponse.
        // To avoid Context, we lift scrubResponse to a static-equivalent
        // by constructing through the test seam below.
        return TestEndpointBuilder.build()
    }

    @Test
    fun `allowlist drops field named key`() {
        val ep = newEndpoints()
        val scrubbed = ep.scrubResponse(mapOf("ok" to true, "key" to "leaky-secret"))
        assertEquals(true, scrubbed["ok"])
        assertNull(scrubbed["key"])
    }

    @Test
    fun `allowlist drops field named seed`() {
        val ep = newEndpoints()
        val scrubbed = ep.scrubResponse(mapOf("ok" to true, "seed" to "leaky"))
        assertNull(scrubbed["seed"])
    }

    @Test
    fun `allowlist drops field named secret`() {
        val ep = newEndpoints()
        val scrubbed = ep.scrubResponse(mapOf("ok" to true, "secret" to "leaky"))
        assertNull(scrubbed["secret"])
    }

    @Test
    fun `allowlist drops fields starting with private`() {
        val ep = newEndpoints()
        val scrubbed = ep.scrubResponse(
            mapOf(
                "ok" to true,
                "privateKey" to "leaky",
                "privateSeed" to "leaky",
                "private_key" to "leaky",
            )
        )
        assertEquals(true, scrubbed["ok"])
        assertNull(scrubbed["privateKey"])
        assertNull(scrubbed["privateSeed"])
        assertNull(scrubbed["private_key"])
    }

    @Test
    fun `allowlist drops fields not in allowlist even if otherwise innocuous`() {
        val ep = newEndpoints()
        val scrubbed = ep.scrubResponse(mapOf("ok" to true, "debugTrace" to "stuff"))
        assertEquals(true, scrubbed["ok"])
        assertNull(scrubbed["debugTrace"])
    }

    @Test
    fun `allowlist preserves all expected response fields`() {
        val ep = newEndpoints()
        val full = mapOf(
            "ok" to true,
            "error" to "some_code",
            "reason" to "explanation",
            "configured" to false,
            "pubkey" to "abc123",
            "balanceSol" to "0",
            "balanceUsdc" to "0",
            "capPerTxSol" to "100",
            "capPerTxUsdc" to "100",
            "capDailySol" to "1000",
            "capDailyUsdc" to "1000",
            "spentTodaySol" to "0",
            "spentTodayUsdc" to "0",
            "network" to "mainnet",
            "reservationId" to "uuid",
            "signedTxBase64" to "AAA=",
            "signature" to "SIG",
            // BAT-582 Phase 5: /jupiter/order-owner/get response field.
            "creatorWalletRole" to "burner",
        )
        val scrubbed = ep.scrubResponse(full)
        // Every field survives
        assertEquals(full.size, scrubbed.size)
        for ((k, v) in full) {
            assertEquals("field $k preserved", v, scrubbed[k])
        }
    }

    @Test
    fun `case insensitive key forbidden check rejects KEY SEED SECRET`() {
        val ep = newEndpoints()
        val scrubbed = ep.scrubResponse(
            mapOf(
                "ok" to true,
                "KEY" to "leaky",
                "Seed" to "leaky",
                "SECRET" to "leaky",
                "PrivateKey" to "leaky",
            )
        )
        assertEquals(true, scrubbed["ok"])
        assertEquals("only ok survives", 1, scrubbed.size)
    }

    @Test
    fun `error responses also go through scrubber`() {
        // Simulate an error response that accidentally contains a key field
        // due to a bug — assert it's stripped.
        val ep = newEndpoints()
        val errorBody = mapOf(
            "error" to "burner_not_configured",
            "reason" to "no key set",
            "key" to "OOPS_LEAKED_KEY",
        )
        val scrubbed = ep.scrubResponse(errorBody)
        assertNull(scrubbed["key"])
        assertEquals("burner_not_configured", scrubbed["error"])
    }

    @Test
    fun `nested-looking field names are dropped if not in allowlist`() {
        val ep = newEndpoints()
        val scrubbed = ep.scrubResponse(
            mapOf(
                "ok" to true,
                "kSeedRoot" to "fine name but not allowlisted",
                "wallet.key" to "weird name",
            )
        )
        assertEquals(1, scrubbed.size)
        assertEquals(true, scrubbed["ok"])
    }
}

/**
 * Test seam: build a BurnerBridgeEndpoints instance whose dispatch
 * handlers are inert (we never call them in scrubResponse tests). We
 * use null-bypass casts since the scrubber doesn't reach into any
 * dependency. If a future change makes scrubResponse touch the
 * dependencies, replace this with a Robolectric-backed instance.
 */
private object TestEndpointBuilder {
    fun build(): BurnerBridgeEndpoints {
        // Use the internal test-only constructor that bypasses the
        // Context-resolving production wiring. NoopKeyVault provides
        // a dependency-free signing surface; the cap enforcer + owner
        // each get a tmp-dir-backed CrossProcessStore. None of these
        // are actually invoked by scrubResponse, but constructor
        // arguments must be non-null so the type system stays sound.
        return BurnerBridgeEndpoints(
            keyVault = NoopKeyVault,
            capEnforcer = noopCapEnforcer(),
            jupiterOwnership = noopOwnership(),
        )
    }

    private object NoopKeyVault : com.seekerclaw.app.data.wallet.KeyVault {
        override suspend fun store(id: String, expanded64: ByteArray) = Unit
        override suspend fun signTransaction(id: String, txBytes: ByteArray): ByteArray =
            throw NotImplementedError()
        override suspend fun getPubkey(id: String): String? = null
        override suspend fun wipe(id: String) = Unit
    }

    private fun noopCapEnforcer(): com.seekerclaw.app.data.caps.CapEnforcer {
        // CapEnforcer requires a ReservationLedger which requires a
        // CrossProcessStore. We use the test-only constructor with a
        // tmp dir.
        val tmp = java.io.File.createTempFile("scrub-test-caps", "").apply {
            delete()
            mkdirs()
        }
        val store = com.seekerclaw.app.util.CrossProcessStore(
            filesDir = tmp,
            fileName = com.seekerclaw.app.data.caps.BurnerCapsState.FILE_NAME,
            serializer = com.seekerclaw.app.data.caps.BurnerCapsState.serializer(),
            initial = com.seekerclaw.app.data.caps.BurnerCapsState(),
        )
        return com.seekerclaw.app.data.caps.CapEnforcer(
            ledger = com.seekerclaw.app.data.caps.ReservationLedger(store),
        )
    }

    private fun noopOwnership(): JupiterOwnershipEndpoint {
        val tmp = java.io.File.createTempFile("scrub-test-own", "").apply {
            delete()
            mkdirs()
        }
        val store = com.seekerclaw.app.util.CrossProcessStore(
            filesDir = tmp,
            fileName = JupiterOwnershipState.FILE_NAME,
            serializer = JupiterOwnershipState.serializer(),
            initial = JupiterOwnershipState(),
        )
        return JupiterOwnershipEndpoint(store)
    }
}
