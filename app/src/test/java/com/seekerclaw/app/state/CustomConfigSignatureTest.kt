package com.seekerclaw.app.state

import org.junit.Assert.assertEquals
import org.junit.Assert.assertNotEquals
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Test

/**
 * BAT-549 Commit 3d — pin Kotlin-side [CustomConfigSignature] invariants
 * AND dual-side equivalence with the Node implementation in
 * `app/src/main/assets/nodejs-project/custom-config-signature.js`.
 *
 * The "golden hash" test (see [dualSide_goldenHash_matches_node]) is the
 * load-bearing assertion: if you change the algorithm (separator chars,
 * normalization, hash function), update BOTH sides AND the golden in
 * BOTH tests simultaneously.
 */
class CustomConfigSignatureTest {

    @Test
    fun nullSentinel_allBlank_returnsNull() {
        assertNull(CustomConfigSignature.compute("", "", "", ""))
    }

    @Test
    fun nullSentinel_whitespaceOnly_returnsNull() {
        assertNull(CustomConfigSignature.compute("   ", "\t\n", " ", "  "))
    }

    @Test
    fun validSignature_isLowercase64HexChars() {
        val sig = CustomConfigSignature.compute(
            customModel = "deepseek-v4-pro",
            customBaseUrl = "https://api.deepseek.com/v1",
            customFormat = "chat_completions",
            customHeaders = """{"X-API-Key":"sk-secret"}""",
        )
        assertNotNull(sig)
        assertTrue("Expected 64-char lowercase hex, got: $sig",
            sig!!.matches(Regex("^[0-9a-f]{64}$")))
    }

    @Test
    fun stability_sameInputsProduceSameHash() {
        val a = CustomConfigSignature.compute("m", "u", "f", """{"K":"v"}""")
        val b = CustomConfigSignature.compute("m", "u", "f", """{"K":"v"}""")
        assertEquals(a, b)
    }

    @Test
    fun changes_eachFieldIsSensitive() {
        val base = CustomConfigSignature.compute(
            "deepseek-v4-pro",
            "https://api.deepseek.com/v1",
            "chat_completions",
            """{"X-API-Key":"sk-secret"}""",
        )
        val modelChanged = CustomConfigSignature.compute(
            "deepseek-r1",
            "https://api.deepseek.com/v1",
            "chat_completions",
            """{"X-API-Key":"sk-secret"}""",
        )
        val baseUrlChanged = CustomConfigSignature.compute(
            "deepseek-v4-pro",
            "https://api.deepseek.com/v2",
            "chat_completions",
            """{"X-API-Key":"sk-secret"}""",
        )
        val formatChanged = CustomConfigSignature.compute(
            "deepseek-v4-pro",
            "https://api.deepseek.com/v1",
            "responses",
            """{"X-API-Key":"sk-secret"}""",
        )
        val headerKeyAdded = CustomConfigSignature.compute(
            "deepseek-v4-pro",
            "https://api.deepseek.com/v1",
            "chat_completions",
            """{"X-API-Key":"sk-secret","X-Org-Id":"org-1"}""",
        )
        assertNotEquals(base, modelChanged)
        assertNotEquals(base, baseUrlChanged)
        assertNotEquals(base, formatChanged)
        assertNotEquals(base, headerKeyAdded)
    }

    @Test
    fun headerValueChange_doesNotAffectSignature_secretSafety() {
        // CRITICAL contract: header VALUES carry secrets (auth tokens,
        // bearer keys); hashing them would persist a leakable digest.
        val a = CustomConfigSignature.compute("m", "u", "f", """{"X-API-Key":"sk-A"}""")
        val b = CustomConfigSignature.compute("m", "u", "f", """{"X-API-Key":"sk-B-DIFFERENT"}""")
        assertEquals(a, b)
    }

    @Test
    fun headerKeyOrder_doesNotAffectSignature() {
        val a = CustomConfigSignature.compute("m", "u", "f", """{"A":"v","B":"v","C":"v"}""")
        val b = CustomConfigSignature.compute("m", "u", "f", """{"C":"v","A":"v","B":"v"}""")
        assertEquals(a, b)
    }

    @Test
    fun headerKeyCase_doesNotAffectSignature_httpCaseInsensitive() {
        val a = CustomConfigSignature.compute("m", "u", "f",
            """{"X-API-Key":"v","Authorization":"v"}""")
        val b = CustomConfigSignature.compute("m", "u", "f",
            """{"x-api-key":"v","authorization":"v"}""")
        assertEquals(a, b)
    }

    @Test
    fun headerParser_malformedJson_treatedAsNoHeaders() {
        // No throw; empty list. The signature is a best-effort change-
        // detector, not a config validator.
        assertEquals(emptyList<String>(),
            CustomConfigSignature.sortedHeaderKeys("{not valid json}"))
    }

    @Test
    fun headerParser_jsonArray_returnsEmpty() {
        // Array isn't a header map; treat as no headers. kotlinx-serialization
        // parses the array fine but `parsed.jsonObject` throws an exception
        // — the signature must catch it and resolve to empty.
        assertEquals(emptyList<String>(),
            CustomConfigSignature.sortedHeaderKeys("""["a","b"]"""))
    }

    @Test
    fun headerParser_jsonNull_returnsEmpty() {
        // Top-level JSON `null`: parses fine as JsonNull, but
        // .jsonObject throws — must resolve to empty (R10 R1 Copilot).
        assertEquals(emptyList<String>(),
            CustomConfigSignature.sortedHeaderKeys("null"))
    }

    @Test
    fun headerParser_jsonPrimitive_returnsEmpty() {
        // Top-level JSON number / string / boolean — parses fine but
        // .jsonObject throws (R10 R1 Copilot regression).
        assertEquals(emptyList<String>(),
            CustomConfigSignature.sortedHeaderKeys("42"))
        assertEquals(emptyList<String>(),
            CustomConfigSignature.sortedHeaderKeys("true"))
        assertEquals(emptyList<String>(),
            CustomConfigSignature.sortedHeaderKeys(""""a-string""""))
    }

    @Test
    fun headerParser_emptyAndWhitespace() {
        assertEquals(emptyList<String>(), CustomConfigSignature.sortedHeaderKeys(""))
        assertEquals(emptyList<String>(), CustomConfigSignature.sortedHeaderKeys("   "))
    }

    @Test
    fun headerParser_keys_lowercasedSortedDeduped() {
        // "Z","A","M","a" → ["a","m","z"]: lowercase + sort + dedupe
        assertEquals(listOf("a", "m", "z"),
            CustomConfigSignature.sortedHeaderKeys("""{"Z":"v","A":"v","M":"v","a":"v"}"""))
    }

    @Test
    fun headerParser_whitespaceKeys_filtered() {
        assertEquals(listOf("x"),
            CustomConfigSignature.sortedHeaderKeys("""{"":"v","   ":"v","X":"v"}"""))
    }

    @Test
    fun headerParser_prototypePoisoningKeys_rejected() {
        // Mirrors Node's parseCustomHeaders + computeCustomConfigSignature
        // defense (prototype keys never reach the signature input).
        assertEquals(listOf("x"),
            CustomConfigSignature.sortedHeaderKeys(
                """{"__proto__":"v","constructor":"v","prototype":"v","X":"v"}"""))
    }

    @Test
    fun malformedHeaders_sameAsNoHeaders_inSignature() {
        val malformed = CustomConfigSignature.compute("m", "u", "f", "{not valid")
        val none = CustomConfigSignature.compute("m", "u", "f", "")
        assertEquals(malformed, none)
    }

    /**
     * THE GOLDEN HASH. This MUST equal the value the Node side produces
     * for the same inputs (see custom-config-signature.test.js Golden
     * block). If this test fails, the Node and Kotlin algorithms have
     * drifted — fix BOTH sides AND update both goldens together.
     *
     * Inputs:
     *   model:   "deepseek-v4-pro"
     *   baseUrl: "https://api.deepseek.com/v1"
     *   format:  "chat_completions"
     *   headers: {"X-API-Key":"sk-secret","X-Org-Id":"org-1"}
     *
     * Canonical input string:
     *   deepseek-v4-pro|https://api.deepseek.com/v1|chat_completions|x-api-key,x-org-id
     */
    @Test
    fun dualSide_goldenHash_matches_node() {
        val sig = CustomConfigSignature.compute(
            customModel = "deepseek-v4-pro",
            customBaseUrl = "https://api.deepseek.com/v1",
            customFormat = "chat_completions",
            customHeaders = """{"X-API-Key":"sk-secret","X-Org-Id":"org-1"}""",
        )
        assertEquals(
            "01ca3655946cbff9c5b7ed6dfd5318ed8912c893ead1127fd09aef53d099f34a",
            sig,
        )
    }

    private fun assertTrue(message: String, cond: Boolean) {
        if (!cond) throw AssertionError(message)
    }
}
