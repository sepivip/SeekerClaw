package com.seekerclaw.app.data.wallet

import com.seekerclaw.app.config.ConfigManager
import kotlinx.coroutines.runBlocking
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNotSame
import org.junit.Assert.assertSame
import org.junit.Assert.assertTrue
import org.junit.Test
import java.util.concurrent.atomic.AtomicInteger
import java.util.concurrent.atomic.AtomicReference

/**
 * BAT-1000 — Helius as Solana RPC primary path (Kotlin side).
 *
 * Pins the contract from the BAT-1000 v1.1 Codex sign-off:
 *
 *   • Codex #2 — `SolanaBalanceFetcher` must NOT constructor-freeze
 *     the RPC URL. The `rpcUrlProvider` lambda is read on every fetch
 *     so toggling the Helius API Key in Settings takes effect on the
 *     next call without recreating the fetcher (which
 *     `BurnerWalletScreen.remember { ... }` would have masked).
 *
 *   • URL builder matrix (set / unset / blank / whitespace-only /
 *     special chars) — proven via `ConfigManager.buildSolanaRpcUrl()`
 *     (the pure helper extracted so this test doesn't need a Context).
 *
 *   • Codex #4 (partial) — URL with Helius key embeds the secret in
 *     the query string. This test asserts the URL ENCODES the key (so
 *     a malformed key cannot break URL parsing), and pairs with the
 *     Node-side log-grep gate to ensure neither side leaks the URL.
 *
 * No real network: the URL-builder tests are pure functions, and the
 * provider-invocation tests use an unreachable port so `fetch()` fails
 * fast without making a real outbound call.
 */
class SolanaBalanceFetcherRpcUrlTest {

    // ────────────────────────────────────────────────────────────────
    // Layer 1 — ConfigManager.buildSolanaRpcUrl matrix (pure helper)
    // ────────────────────────────────────────────────────────────────

    @Test
    fun `null helius key falls back to public RPC`() {
        assertEquals(
            "https://api.mainnet-beta.solana.com",
            ConfigManager.buildSolanaRpcUrl(null),
        )
    }

    @Test
    fun `empty helius key falls back to public RPC`() {
        assertEquals(
            "https://api.mainnet-beta.solana.com",
            ConfigManager.buildSolanaRpcUrl(""),
        )
    }

    @Test
    fun `whitespace-only helius key falls back to public RPC`() {
        assertEquals(
            "https://api.mainnet-beta.solana.com",
            ConfigManager.buildSolanaRpcUrl("   \t \n  "),
        )
    }

    @Test
    fun `non-blank helius key produces Helius URL`() {
        assertEquals(
            "https://mainnet.helius-rpc.com/?api-key=abc123-def456",
            ConfigManager.buildSolanaRpcUrl("abc123-def456"),
        )
    }

    @Test
    fun `helius key is trimmed before URL building`() {
        assertEquals(
            "https://mainnet.helius-rpc.com/?api-key=real-key-here",
            ConfigManager.buildSolanaRpcUrl("   real-key-here   "),
        )
    }

    @Test
    fun `helius key special characters are URL-encoded`() {
        // Defense even though real Helius keys are alphanumeric: a future
        // key format change or a key with whitespace inside (impossible but
        // defensible) must not break URL parsing.
        // Java's URLEncoder.encode produces the form-encoded variant
        // (space → '+', '!' → '%21'). Accept either that or RFC 3986
        // percent-encoding so we're not coupled to one specific encoding
        // library — the contract is "everything sketchy is escaped."
        val url = ConfigManager.buildSolanaRpcUrl("key with spaces & symbols=!")
        assertTrue(
            "URL must URL-encode special chars (space, &, =, !); got: $url",
            url.contains("api-key=key+with+spaces+%26+symbols%3D%21") ||
                url.contains("api-key=key%20with%20spaces%20%26%20symbols%3D%21"),
        )
        // Defense check: NONE of the dangerous raw characters appear after
        // `api-key=` — that's the actual contract.
        val querySuffix = url.substringAfter("api-key=")
        assertTrue(
            "raw space must not appear in encoded query; got: $querySuffix",
            !querySuffix.contains(' '),
        )
        assertTrue(
            "raw & must not appear in encoded query; got: $querySuffix",
            !querySuffix.contains('&'),
        )
        assertTrue(
            "raw = must not appear in encoded query; got: $querySuffix",
            !querySuffix.contains('='),
        )
    }

    // ────────────────────────────────────────────────────────────────
    // Layer 2 — Codex #2: SolanaBalanceFetcher per-call provider read
    // (NO constructor freezing — proves hot-reload semantics)
    // ────────────────────────────────────────────────────────────────

    @Test
    fun `construction does NOT invoke the rpcUrlProvider`() {
        val counter = AtomicInteger(0)
        val provider: () -> String = {
            counter.incrementAndGet()
            // 127.0.0.1 port 1 is the conventional unreachable address for
            // test fast-fail — TCP connect dies in milliseconds.
            "http://127.0.0.1:1/fake-rpc"
        }
        SolanaBalanceFetcher(rpcUrlProvider = provider)
        assertEquals(
            "constructor MUST NOT read rpcUrlProvider (would re-introduce the v1 constructor-freeze bug Codex #2 caught)",
            0,
            counter.get(),
        )
    }

    @Test
    fun `fetch invokes the rpcUrlProvider at least once`() = runBlocking {
        val counter = AtomicInteger(0)
        val provider: () -> String = {
            counter.incrementAndGet()
            "http://127.0.0.1:1/fake-rpc"
        }
        val fetcher = SolanaBalanceFetcher(rpcUrlProvider = provider, timeoutMs = 200)

        // Pubkey doesn't matter — fetch() fails fast against the unreachable
        // address, then returns null. Cleaner than wiring a mock server for
        // a test that only cares about provider invocation.
        val result = fetcher.fetch("Burner1111111111111111111111111111111111111")

        assertNotNull(
            "AtomicInteger should be non-null obviously, sanity check",
            counter,
        )
        assertTrue(
            "fetch() MUST invoke rpcUrlProvider at least once (it ran ${counter.get()} times)",
            counter.get() > 0,
        )
        // Result is null because the RPC URL is unreachable — that's the
        // expected behavior (fail closed). The point of this test is the
        // provider invocation count above, not the return value.
        assertEquals("fetch against unreachable RPC must return null", null, result)
    }

    @Test
    fun `provider is re-read on each fetch — proves no caching, supports hot-reload`() = runBlocking {
        // Codex #2 core assertion: changing the Helius key in Settings
        // between two fetches must flip the URL on the SECOND fetch
        // WITHOUT recreating the fetcher instance.
        val currentUrl = AtomicReference("http://127.0.0.1:1/url-one")
        val counter = AtomicInteger(0)
        val provider: () -> String = {
            counter.incrementAndGet()
            currentUrl.get()
        }
        val fetcher = SolanaBalanceFetcher(rpcUrlProvider = provider, timeoutMs = 200)

        // First fetch reads provider → "url-one"
        fetcher.fetch("Burner1111111111111111111111111111111111111")
        val countAfterFirst = counter.get()
        assertTrue(
            "first fetch should have invoked provider",
            countAfterFirst > 0,
        )

        // Simulate the user updating their Helius key in Settings → the
        // provider now returns a different URL. The fetcher INSTANCE is
        // unchanged (this is the case `remember { ... }` produces in
        // BurnerWalletScreen).
        currentUrl.set("http://127.0.0.1:1/url-two")

        // Second fetch — provider must be re-read, returning the new URL.
        fetcher.fetch("Burner1111111111111111111111111111111111111")
        val countAfterSecond = counter.get()
        assertTrue(
            "second fetch must invoke provider AGAIN (was $countAfterFirst, now $countAfterSecond). " +
                "If counts match, the fetcher cached the URL at first call — re-introducing the " +
                "Codex #2 constructor-freeze bug at the instance level.",
            countAfterSecond > countAfterFirst,
        )
    }

    // ────────────────────────────────────────────────────────────────
    // Layer 3 — Backward-compat constructors
    // ────────────────────────────────────────────────────────────────

    @Test
    fun `default constructor (no args) still works — preserves prior API`() {
        // Compile-time check: constructing without args must still compile +
        // succeed. The default provider returns the public mainnet URL.
        val fetcher = SolanaBalanceFetcher()
        assertNotNull(fetcher)
    }

    @Test
    fun `fixed-URL secondary constructor still works — useful for tests`() {
        // The convenience overload for callers that hold a pre-resolved URL
        // (tests, future migration shims). Wraps the string as a constant
        // provider internally.
        val fetcher = SolanaBalanceFetcher("https://example.com/rpc")
        assertNotNull(fetcher)
    }

    // ────────────────────────────────────────────────────────────────
    // Layer 4 — Sanity check: distinct instances, not shared singletons
    // ────────────────────────────────────────────────────────────────

    @Test
    fun `each constructor call yields a distinct instance`() {
        // Mirrors the BurnerWalletScreen.remember { ... } shape: should be
        // independent state per composition.
        val one = SolanaBalanceFetcher()
        val two = SolanaBalanceFetcher()
        assertNotSame(one, two)
        // But two references to the same construction ARE the same.
        assertSame(one, one)
    }

    // ────────────────────────────────────────────────────────────────
    // Layer 5 — Copilot R2 #3348125032: api-key redaction in error logs
    // (security gate — exception messages can carry the URL)
    // ────────────────────────────────────────────────────────────────

    @Test
    fun `redactApiKeyFromMessage strips api-key query in MalformedURLException-style messages`() {
        // MalformedURLException's getMessage() in Android includes the
        // attempted URL: e.g. "Unknown protocol: htp" with a wrapped
        // URL string, OR "no protocol: https://mainnet.helius-rpc.com/?api-key=SECRET".
        // Either form must be redacted before logging.
        val fetcher = SolanaBalanceFetcher()
        val leaked = "no protocol: https://mainnet.helius-rpc.com/?api-key=SUPER-SECRET-KEY-12345"
        val redacted = fetcher.redactApiKeyFromMessage(leaked)
        assertTrue(
            "redacted output must not contain the raw key. Got: $redacted",
            !redacted.contains("SUPER-SECRET-KEY-12345"),
        )
        assertTrue(
            "redacted output should still mention <REDACTED> as the placeholder so log readers can tell what was scrubbed",
            redacted.contains("REDACTED"),
        )
        // Copilot R3 #3348177879: original `?` delimiter must be preserved
        // so the redacted message still reads as a valid URL fragment.
        assertEquals(
            "?-delimiter form should preserve `?` and produce a clean readable URL",
            "no protocol: https://mainnet.helius-rpc.com/?api-key=<REDACTED>",
            redacted,
        )
    }

    @Test
    fun `redactApiKeyFromMessage strips key in mid-query form (defense)`() {
        val fetcher = SolanaBalanceFetcher()
        val leaked = "connect timed out for https://mainnet.helius-rpc.com/path?foo=bar&api-key=ANOTHER-KEY&commitment=confirmed"
        val redacted = fetcher.redactApiKeyFromMessage(leaked)
        assertTrue(
            "mid-query api-key form must also be redacted. Got: $redacted",
            !redacted.contains("ANOTHER-KEY"),
        )
        // Copilot R3 #3348177879: the original `&` delimiter must survive
        // so the surrounding query string stays well-formed in logs.
        // Pre-fix the replacement string was the literal "[?&]" character
        // class, which produced "...?foo=bar[?&]api-key=<REDACTED>..." —
        // breaking query shape and confusing log readers.
        assertEquals(
            "&-delimiter form should preserve `&` between adjacent params",
            "connect timed out for https://mainnet.helius-rpc.com/path?foo=bar&api-key=<REDACTED>&commitment=confirmed",
            redacted,
        )
    }

    @Test
    fun `redactApiKeyFromMessage handles BOTH delimiters in one message (multiple URLs)`() {
        // Defense for the unlikely case an exception message embeds two URLs
        // (a chained-failure or wrapped-cause scenario): each occurrence is
        // redacted independently with its OWN delimiter preserved.
        val fetcher = SolanaBalanceFetcher()
        val leaked = "fallback from https://a/?api-key=KEY-ONE to https://b/path?x=1&api-key=KEY-TWO"
        val redacted = fetcher.redactApiKeyFromMessage(leaked)
        assertEquals(
            "fallback from https://a/?api-key=<REDACTED> to https://b/path?x=1&api-key=<REDACTED>",
            redacted,
        )
    }

    @Test
    fun `redactApiKeyFromMessage preserves non-secret content`() {
        val fetcher = SolanaBalanceFetcher()
        val msg = "Connection refused to api.mainnet-beta.solana.com:443"
        val redacted = fetcher.redactApiKeyFromMessage(msg)
        assertEquals(
            "messages without api-key should pass through unchanged",
            msg,
            redacted,
        )
    }

    @Test
    fun `redactApiKeyFromMessage handles null gracefully`() {
        val fetcher = SolanaBalanceFetcher()
        assertEquals(
            "null message should produce a sentinel, not crash",
            "<null>",
            fetcher.redactApiKeyFromMessage(null),
        )
    }
}
