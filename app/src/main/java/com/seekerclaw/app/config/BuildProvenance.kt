package com.seekerclaw.app.config

import android.content.Context
import com.seekerclaw.app.util.LogCollector
import com.seekerclaw.app.util.LogLevel
import org.json.JSONObject

/**
 * Build identity, read at RUNTIME from a packaged asset.
 *
 * BAT-1293. This exists because `BuildConfig.GIT_SHA` was a `public static final
 * String` — a compile-time constant — and Java/Kotlin INLINE those at every call
 * site. When the value changed, AGP regenerated `BuildConfig.java` but incremental
 * compilation did not recompile the readers, so `ConfigManager`, `SystemScreen` and
 * `SettingsScreen` kept the PREVIOUS literal in their bytecode. Confirmed by dex
 * inspection: `classes4.dex` held the new sha while `classes3/11/13.dex` held the old
 * one and were byte-identical to the previously installed APK. A clean build hides
 * it, so it only ever bit the incremental path everyone uses all day.
 *
 * A value read from a file at runtime cannot be inlined, so it cannot drift.
 *
 * THE INVARIANT: no build-identity value may be a compile-time constant — not
 * `static final`, not `const val`, not a `buildConfigField`. A generated Kotlin file
 * would be just as unsafe if it used `const`.
 *
 * ## Why lazy rather than eagerly initialised
 *
 * `SeekerClawService` declares `android:process=":node"`, so the app runs in TWO
 * processes. A Kotlin `object` memo is per-process, so a single eager init would
 * populate one and leave the other empty — `ConfigManager.writeConfigJson` (which
 * feeds the Node session banner) runs in `:node`, while the UI reads run in the main
 * process. Taking a `Context` per call sidesteps process-locality entirely, and both
 * Composable call sites already hold `LocalContext.current`.
 *
 * ## Failure behaviour
 *
 * Missing or malformed asset yields `provenance = "unreadable"` with a null commit.
 * It never throws, and never reports a plausible-looking wrong value — a wrong
 * identity is worse than an absent one, because it can be recorded as an attestation.
 */
object BuildProvenance {

    const val ASSET_PATH = "build-metadata.json"

    data class Info(
        val commit: String?,
        val commitShort: String?,
        val dirty: Boolean?,
        val branch: String?,
        val buildTimestampUtc: String?,
        val versionName: String?,
        val versionCode: Int?,
        val openclawVersion: String?,
        val nodejsVersion: String?,
        val bundleDigest: String?,
        val provenance: String,
    ) {
        /** True only for a build whose identity is fully established and clean. */
        val isVerifiedClean: Boolean get() = provenance == "verified" && dirty == false

        /** What a human should see next to a version string. Empty when nothing to flag. */
        val marker: String get() = when {
            provenance == "unreadable" -> " · UNREADABLE BUILD"
            provenance == "unverified" -> " · UNVERIFIED BUILD"
            dirty == true -> " · dirty"
            else -> ""
        }
    }

    private val UNREADABLE = Info(
        commit = null, commitShort = null, dirty = null, branch = null,
        buildTimestampUtc = null, versionName = null, versionCode = null,
        openclawVersion = null, nodejsVersion = null, bundleDigest = null,
        provenance = "unreadable",
    )

    @Volatile
    private var cached: Info? = null

    /**
     * Parse step, kept PURE so it is unit-testable without a Context or an
     * AssetManager — the repo has 33 JVM tests under app/src/test that can cover it.
     */
    fun parse(json: String?): Info {
        if (json.isNullOrBlank()) return UNREADABLE
        return try {
            val o = JSONObject(json)
            Info(
                commit = o.optStringOrNull("commit"),
                commitShort = o.optStringOrNull("commitShort"),
                dirty = if (o.isNull("dirty")) null else o.optBoolean("dirty"),
                branch = o.optStringOrNull("branch"),
                buildTimestampUtc = o.optStringOrNull("buildTimestampUtc"),
                versionName = o.optStringOrNull("versionName"),
                versionCode = if (o.isNull("versionCode")) null else o.optInt("versionCode"),
                openclawVersion = o.optStringOrNull("openclawVersion"),
                nodejsVersion = o.optStringOrNull("nodejsVersion"),
                bundleDigest = o.optStringOrNull("bundleDigest"),
                provenance = o.optString("provenance", "unreadable").ifBlank { "unreadable" },
            )
        } catch (e: Exception) {
            UNREADABLE
        }
    }

    private fun JSONObject.optStringOrNull(key: String): String? =
        if (isNull(key)) null else optString(key, "").ifBlank { null }

    fun get(context: Context): Info {
        cached?.let { return it }
        val loaded = try {
            context.applicationContext.assets.open(ASSET_PATH).use {
                parse(it.readBytes().toString(Charsets.UTF_8))
            }
        } catch (e: Exception) {
            LogCollector.append("[BuildProvenance] asset unreadable: ${e.message}", LogLevel.WARN)
            UNREADABLE
        }
        cached = loaded
        return loaded
    }

    /**
     * versionName/versionCode of the INSTALLED package.
     *
     * Strictly better than either alternative for these two values:
     *   - BuildConfig.VERSION_NAME/VERSION_CODE are compile-time constants, so
     *     they inline into every reader and go stale on an incremental build.
     *     That is the exact defect this ticket exists to remove.
     *   - build-metadata.json is a COPY produced at build time, and a copy can
     *     drift from what was actually packaged (it already did once: the
     *     generator was fed hand-typed literals -- see part 4b).
     *
     * PackageManager reports the merged manifest of the APK Android actually
     * installed. It cannot be inlined and it is not a copy: it IS the installed
     * identity, so there is no third thing for it to disagree with.
     *
     * Memoised per process, like get(). The two caches are separate because the
     * sources and their failure modes are unrelated.
     */
    data class Installed(val versionName: String?, val versionCode: Long?) {
        /** "2.2.0 (23)" -- degrades honestly rather than inventing a version. */
        val display: String
            get() = (versionName ?: "unknown") + " (" + (versionCode?.toString() ?: "?") + ")"
    }

    @Volatile
    private var installedCache: Installed? = null

    fun installed(context: Context): Installed {
        installedCache?.let { return it }
        val value = try {
            val app = context.applicationContext
            // longVersionCode is API 28+; minSdk is 34.
            val pi = app.packageManager.getPackageInfo(app.packageName, 0)
            Installed(pi.versionName, pi.longVersionCode)
        } catch (e: Exception) {
            LogCollector.append("[BuildProvenance] package info unreadable: ${e.message}", LogLevel.WARN)
            Installed(null, null)
        }
        installedCache = value
        return value
    }

    /** Test seam only. */
    fun resetForTest() {
        cached = null
        installedCache = null
    }
}
