package com.seekerclaw.app.data.wallet

import android.util.Log
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext
import org.json.JSONObject
import java.math.BigInteger
import java.net.HttpURLConnection
import java.net.URL

/**
 * SolanaBalanceFetcher — minimal mainnet RPC reader for the Burner
 * Wallet UI. Fetches SOL balance + USDC ATA balance (summed across
 * all matching token accounts, BigInt-safe) for a burner pubkey via
 * JSON-RPC. Wired into [BurnerWalletScreen]'s status card auto-fetch
 * on screen open + refresh button.
 *
 * Originally scoped as a BAT-582 follow-up in the v1.4 contract;
 * folded into PR #364 along with the v1.6 x402 v2 addendum to ship a
 * complete burner UX (R27 fixed the null-on-failure contract so the
 * UI distinguishes transient outages from real zero balances).
 *
 * **Why a dedicated client (not the Node bridge):** the burner-wallet
 * Settings screen runs in the UI process and needs balances on demand
 * (open + refresh button). Routing through the Node bridge would require
 * Node to be running — and the Settings screen has to work even when the
 * service is stopped. A direct Kotlin RPC call keeps the UI independent.
 *
 * **Errors are not exceptions:** the UI shows "balance unavailable" when
 * the network or the RPC is flaky. Internal failures log + return null
 * rather than throwing — the caller is a coroutine inside a compose
 * screen, and a thrown error there yields a visible crash for what is
 * fundamentally a transient network condition.
 *
 * Match [AndroidBridge]'s style — `HttpURLConnection`, no OkHttp dep.
 *
 * BAT-1000: `rpcUrl` is no longer a constructor-frozen `val`. The fetcher
 * now reads the URL via [rpcUrlProvider] on each call so toggling the
 * Helius API Key in Settings takes effect immediately without recreating
 * the fetcher instance (which `BurnerWalletScreen.remember { ... }` would
 * have masked). The default provider preserves prior behavior (public
 * mainnet-beta). Production sites should pass a provider that delegates
 * to `ConfigManager.getSolanaRpcUrl(context)` so user-configured Helius
 * keys are picked up live. Per Codex BAT-1000 v1.1 #2.
 */
class SolanaBalanceFetcher(
    private val rpcUrlProvider: () -> String = { DEFAULT_RPC_URL },
    private val timeoutMs: Int = 8_000,
) {
    /**
     * Backward-compatible secondary constructor accepting a fixed URL string.
     * Useful for tests with a deterministic URL or any caller that holds
     * its own resolution. Production should prefer the primary
     * [rpcUrlProvider]-taking constructor for live hot-reload.
     */
    constructor(rpcUrl: String, timeoutMs: Int = 8_000) :
        this(rpcUrlProvider = { rpcUrl }, timeoutMs = timeoutMs)

    data class Balances(
        /** SOL balance in lamports (10^-9 SOL). */
        val solLamports: BigInteger,
        /** USDC ATA balance in microunits (10^-6 USDC). Zero if no ATA exists. */
        val usdcMicrounits: BigInteger,
    )

    /**
     * Fetch SOL + USDC balances for [pubkey]. Returns null on any error
     * (network failure, RPC error, malformed response) — UI treats null as
     * "balance unavailable".
     */
    suspend fun fetch(pubkey: String): Balances? = withContext(Dispatchers.IO) {
        // BAT-582 R21: enforce IO dispatcher INTERNALLY rather than relying
        // on every caller to wrap with withContext(Dispatchers.IO) before
        // invoking. Pre-fix the suspend signature implied "safe to await
        // from any context" but the underlying jsonRpc() does blocking
        // HttpURLConnection I/O — a Main-dispatcher caller would block
        // the UI thread. The current single caller (BurnerWalletScreen)
        // DID wrap correctly, but reusable class APIs shouldn't depend
        // on callers getting this right.
        val sol = getSolBalance(pubkey) ?: return@withContext null
        // getUsdcBalance() already differentiates two cases internally:
        //   - returns ZERO when getTokenAccountsByOwner returned 200 with
        //     an empty value array (wallet has never held USDC — no ATA
        //     exists yet — that IS a valid zero balance, not an error).
        //   - returns null on RPC failure, JSON-RPC error, or parse error
        //     (real failure — we don't know the actual balance).
        // Propagate the null upward instead of masking it with ZERO.
        // Pre-fix the UI showed "0 USDC" on a transient RPC blip even when
        // the wallet held real USDC, which read like funds vanished —
        // misleading the user is the worst possible failure mode here.
        val usdc = getUsdcBalance(pubkey) ?: return@withContext null
        Balances(sol, usdc)
    }

    /** SOL balance via getBalance RPC. */
    private suspend fun getSolBalance(pubkey: String): BigInteger? {
        val params = """[${JSONObject.quote(pubkey)}]"""
        val res = jsonRpc("getBalance", params) ?: return null
        return try {
            // SOL balances are u64 lamports per the Solana spec. JSONObject.getLong
            // would limit us to signed 64-bit (Long.MAX_VALUE ≈ 9.2B SOL) and throw
            // on values outside that range. Total SOL supply (~580M) means real
            // wallets won't hit this, but the JSON-RPC value field is documented
            // as u64 — parsing via toString() → BigInteger preserves the full
            // unsigned range so this code stays correct against a spec-compliant
            // node. Applies to any Solana RPC `lamports` field elsewhere too.
            BigInteger(res.getJSONObject("result").get("value").toString())
        } catch (e: Exception) {
            Log.w(TAG, "getBalance result parse failed: ${e.message}")
            null
        }
    }

    /** USDC token-account balance for the burner's USDC ATA, in microunits. */
    private suspend fun getUsdcBalance(pubkey: String): BigInteger? {
        // getTokenAccountsByOwner returns all USDC token accounts; we sum
        // them (typically there's exactly one ATA, but this is robust if
        // the user manually created auxiliary token accounts).
        val params = """[${JSONObject.quote(pubkey)},{"mint":${JSONObject.quote(USDC_MINT)}},{"encoding":"jsonParsed"}]"""
        val res = jsonRpc("getTokenAccountsByOwner", params) ?: return null
        return try {
            val accounts = res.getJSONObject("result").getJSONArray("value")
            var total = BigInteger.ZERO
            for (i in 0 until accounts.length()) {
                val info = accounts.getJSONObject(i)
                    .getJSONObject("account")
                    .getJSONObject("data")
                    .getJSONObject("parsed")
                    .getJSONObject("info")
                    .getJSONObject("tokenAmount")
                val raw = info.getString("amount")
                total = total.add(BigInteger(raw))
            }
            total
        } catch (e: Exception) {
            Log.w(TAG, "getTokenAccountsByOwner parse failed: ${e.message}")
            null
        }
    }

    private fun jsonRpc(method: String, paramsJson: String): JSONObject? {
        val body = """{"jsonrpc":"2.0","id":1,"method":${JSONObject.quote(method)},"params":$paramsJson}"""
        var conn: HttpURLConnection? = null
        return try {
            // BAT-1000: read RPC URL per call so a Helius API Key edit in
            // Settings takes effect on the very next fetch — no need to
            // recreate the fetcher instance (which `remember { ... }` in
            // BurnerWalletScreen would otherwise prevent).
            //
            // URL may contain `?api-key=…` — DO NOT log the URL string.
            // Inner methods that log RPC failures (lines below) deliberately
            // reference only `method` and `e.message`, not the URL, to keep
            // the Helius key out of logcat (Codex BAT-1000 v1.1 #4 security
            // gate).
            val url = URL(rpcUrlProvider())
            conn = (url.openConnection() as HttpURLConnection).apply {
                requestMethod = "POST"
                connectTimeout = timeoutMs
                readTimeout = timeoutMs
                // Explicit UTF-8 charset on both header + body. The platform-default
                // charset that `String.toByteArray()` uses can vary by device/locale
                // (rare on Android but technically possible) and would silently
                // produce wrong wire bytes for any non-ASCII content. JSON-RPC is
                // strictly UTF-8 per the spec — pin both ends.
                setRequestProperty("Content-Type", "application/json; charset=utf-8")
                setRequestProperty("Accept", "application/json")
                doOutput = true
            }
            conn.outputStream.use { it.write(body.toByteArray(Charsets.UTF_8)) }
            val code = conn.responseCode
            if (code !in 200..299) {
                Log.w(TAG, "RPC $method HTTP $code")
                return null
            }
            // BAT-582 R20: explicit UTF-8 on read side too. JSON-RPC is
            // UTF-8 per spec; matching the explicit charset=utf-8 we set
            // on the request keeps wire decoding deterministic across
            // devices/locales (some Android devices have non-UTF-8
            // default charset, rare but technically possible).
            val raw = conn.inputStream.bufferedReader(Charsets.UTF_8).use { it.readText() }
            val obj = JSONObject(raw)
            if (obj.has("error")) {
                Log.w(TAG, "RPC $method returned error: ${obj.getJSONObject("error").optString("message")}")
                return null
            }
            obj
        } catch (e: Exception) {
            // BAT-1000 Copilot R2 #3348125032: any exception bubbling up
            // here can carry the URL in its message — `URL(rpcUrlProvider())`
            // throws MalformedURLException with the full URL embedded
            // (which contains `?api-key=…`), and other I/O exceptions
            // sometimes include the requested URL too. Redact before
            // logging so a corrupt-prefs / bad-provider scenario does NOT
            // leak the Helius key into logcat. Pairs with the Node-side
            // log-grep gate from the Codex #4 security contract.
            Log.w(TAG, "RPC $method failed: ${redactApiKeyFromMessage(e.message)}")
            null
        } finally {
            conn?.disconnect()
        }
    }

    /**
     * Redact any `?api-key=…` (or `&api-key=…`) substring from an exception
     * message before logging. Catches the MalformedURLException + general
     * I/O exception leak paths flagged by Copilot R2 #3348125032. Returns
     * `"<null>"` for null inputs so the log line stays informative.
     *
     * Internal (not private) so unit tests in the same module can verify
     * the redaction directly — that's important because the bug class
     * (silent key leak in logcat) is exactly the kind that hides if not
     * tested explicitly.
     */
    internal fun redactApiKeyFromMessage(msg: String?): String {
        if (msg == null) return "<null>"
        // Greedy until next & or whitespace or end-of-string — matches both
        // the start-of-query (?api-key=…) and any later position (&api-key=…)
        // even though the URL builder only uses the leading form.
        return msg.replace(Regex("""[?&]api-key=[^&\s"']*"""), "[?&]api-key=<REDACTED>")
    }

    companion object {
        private const val TAG = "SolanaBalanceFetcher"
        private const val DEFAULT_RPC_URL = "https://api.mainnet-beta.solana.com"
        private const val USDC_MINT = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v"
    }
}
