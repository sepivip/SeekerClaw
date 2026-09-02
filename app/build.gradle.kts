import java.net.HttpURLConnection
import java.net.URI
import java.util.Properties
import java.util.Date
import java.io.ByteArrayOutputStream
import java.nio.file.Files
import java.security.MessageDigest
import java.time.Instant
import java.text.SimpleDateFormat
import java.util.zip.ZipFile
import java.util.zip.ZipInputStream

plugins {
    alias(libs.plugins.android.application)
    alias(libs.plugins.kotlin.android)
    alias(libs.plugins.kotlin.compose)
    alias(libs.plugins.kotlin.serialization)
    alias(libs.plugins.google.services) apply false
}

// Firebase: only apply google-services when the config file is present.
// Published builds ship with google-services.json (gitignored);
// open-source clones without it build fine — analytics become no-ops.
if (file("google-services.json").exists()) {
    apply(plugin = "com.google.gms.google-services")
}

// Load signing config from local.properties (Android Studio) with env var fallback (GitHub Actions CI)
val localProps = Properties().apply {
    val f = rootProject.file("local.properties")
    if (f.exists()) f.inputStream().use { load(it) }
}

fun signingProp(localKey: String, envKey: String): String? =
    localProps.getProperty(localKey) ?: System.getenv(envKey)

// ── BAT-1293: the ONE definition of build identity ──────────────────────────
//
// Both consumers derive from these: `defaultConfig` below (which AGP stamps
// into the merged manifest, and thus into what PackageManager reports at
// runtime) and GenerateBuildProvenanceTask (which writes
// assets/build-metadata.json, the file every runtime reader consults).
//
// They used to be typed out TWICE, 560 lines apart, with nothing asserting
// they agreed. That is the same stale-identity failure this ticket exists to
// remove, merely relocated from bytecode inlining into script-level
// duplication — and strictly worse, because unlike the inlining bug it never
// self-heals on a clean build. A bump that edited one site and not the other
// stamped the OLD version into build-metadata.json, and Part 2 already put
// that value on the xAI Cloudflare-gated auth path.
//
// No product flavor or build type overrides versionName/versionCode (only
// DISTRIBUTION/STORE_NAME and signing configs differ), so defaultConfig is the
// sole definition and these four lines are the only place any of them appear.
val appVersionName = "2.2.0"
val appVersionCode = 23
val openclawVersion = "2026.4.10"
val nodejsVersion = "18 LTS"

android {
    namespace = "com.seekerclaw.app"
    compileSdk = 36

    // BAT-1187: pin the NDK explicitly. Previously unpinned, so the build rode
    // whatever NDK the installed AGP happened to default to — a silent
    // reproducibility hazard (the toolchain could change under us on any
    // machine or CI image). r27 does NOT emit 16 KB-aligned ELF segments by
    // default (r28+ does), which is why the 16 KB link flags in
    // src/main/cpp/CMakeLists.txt (target_link_options) are explicit rather
    // than implied by the toolchain.
    // FOLLOW-UP (autumn 16 KB ticket): re-evaluate this pin when libnode.so is
    // rebuilt/replaced — moving to r28+ would make the flags redundant.
    ndkVersion = "27.0.12077973"

    defaultConfig {
        applicationId = "com.seekerclaw.app"
        minSdk = 34
        targetSdk = 36
        versionCode = appVersionCode
        versionName = appVersionName

        // BAT-1293: OPENCLAW_VERSION and NODEJS_VERSION are NO LONGER buildConfigFields.
        // Like GIT_SHA before them they were compile-time constants, and every reader
        // now takes them from the packaged provenance asset at runtime instead. Leaving
        // the fields behind would re-arm the bug: the next BuildConfig.OPENCLAW_VERSION
        // anyone writes reintroduces it silently. The values live in openclawVersion /
        // nodejsVersion above.

        // BAT-1293: GIT_SHA and BUILD_DATE are GONE from BuildConfig.
        //
        // They were `public static final String`, i.e. compile-time constants,
        // and Java/Kotlin INLINE those at every call site. When the value
        // changed, AGP regenerated BuildConfig.java but incremental compilation
        // did not recompile the readers, so ConfigManager / SystemScreen /
        // SettingsScreen kept the PREVIOUS literal in their bytecode. Verified
        // by dex inspection: classes4.dex held the new sha while classes3/11/13
        // held the old one and were byte-identical to the previously installed
        // APK. A clean build hides it, so it only bit the incremental path.
        //
        // Build identity now lives in assets/build-metadata.json, written by an
        // execution-time task and read at RUNTIME (BuildProvenance). A runtime
        // read cannot be inlined, so it cannot drift.
        //
        // The invariant, so this never comes back: NO build-identity value may
        // be a compile-time constant — not `static final`, not `const val`, not
        // a buildConfigField. A generated Kotlin file would be just as unsafe
        // if it used `const`.

        externalNativeBuild {
            cmake {
                cppFlags("")
                arguments("-DANDROID_STL=c++_shared")
            }
        }
        ndk {
            abiFilters.addAll(listOf("arm64-v8a"))
        }
    }

    signingConfigs {
        create("dappStore") {
            val ksPath = signingProp("SEEKERCLAW_KEYSTORE_PATH", "SEEKERCLAW_KEYSTORE_PATH")
            if (ksPath != null) {
                storeFile = file(ksPath)
                storePassword = signingProp("SEEKERCLAW_STORE_PASSWORD", "SEEKERCLAW_STORE_PASSWORD")
                keyAlias = signingProp("SEEKERCLAW_KEY_ALIAS", "SEEKERCLAW_KEY_ALIAS")
                keyPassword = signingProp("SEEKERCLAW_KEY_PASSWORD", "SEEKERCLAW_KEY_PASSWORD")
            }
        }
        create("googlePlay") {
            val ksPath = signingProp("PLAY_KEYSTORE_PATH", "PLAY_KEYSTORE_PATH")
            if (ksPath != null) {
                storeFile = file(ksPath)
                storePassword = signingProp("PLAY_STORE_PASSWORD", "PLAY_STORE_PASSWORD")
                keyAlias = signingProp("PLAY_KEY_ALIAS", "PLAY_KEY_ALIAS")
                keyPassword = signingProp("PLAY_KEY_PASSWORD", "PLAY_KEY_PASSWORD")
            }
        }
    }

    flavorDimensions += "distribution"

    productFlavors {
        create("dappStore") {
            dimension = "distribution"
            buildConfigField("String", "DISTRIBUTION", "\"dappStore\"")
            buildConfigField("String", "STORE_NAME", "\"Solana dApp Store\"")
            signingConfig = signingConfigs.getByName("dappStore")
        }
        create("googlePlay") {
            dimension = "distribution"
            buildConfigField("String", "DISTRIBUTION", "\"googlePlay\"")
            buildConfigField("String", "STORE_NAME", "\"Google Play\"")
            signingConfig = signingConfigs.getByName("googlePlay")
        }
    }

    buildTypes {
        release {
            isMinifyEnabled = true
            isShrinkResources = true
            proguardFiles(
                getDefaultProguardFile("proguard-android-optimize.txt"),
                "proguard-rules.pro"
            )
        }
    }

    compileOptions {
        sourceCompatibility = JavaVersion.VERSION_17
        targetCompatibility = JavaVersion.VERSION_17
    }

    kotlinOptions {
        jvmTarget = "17"
    }

    buildFeatures {
        compose = true
        buildConfig = true
    }

    testOptions {
        // BAT-513: pure-JVM unit tests need android.util.Log calls to
        // resolve to no-op default returns instead of the stub's
        // "Method not mocked" RuntimeException. Existing tests don't
        // hit any android API where the default return shape would
        // surprise them; new RuntimeStateStoreTest assertions on the
        // collector's invalid-emission path require this setting to
        // exercise the WARN-then-skip branch.
        unitTests.isReturnDefaultValues = true
    }

    externalNativeBuild {
        cmake {
            path = file("src/main/cpp/CMakeLists.txt")
            version = "3.22.1"
        }
    }

    sourceSets {
        getByName("main") {
            jniLibs.srcDirs("libnode/bin/")
        }
    }
}

// --- Download nodejs-mobile binaries ---

abstract class DownloadNodejsTask : DefaultTask() {
    @TaskAction
    fun run() {
        val url = "https://github.com/nodejs-mobile/nodejs-mobile/releases/download/v18.20.4/nodejs-mobile-v18.20.4-android.zip"
        val expectedSha256 = "bd7321eaa1a7602fbe0bb87302df2d79d87835cf4363fbdd17c350dbb485c2af"
        val zipFile = project.file("./libnode/nodejs-mobile-v18.20.4-android.zip")
        val extractDir = project.file("./libnode")

        if (!zipFile.exists()) {
            zipFile.parentFile.mkdirs()
            println("Downloading Node.js from: $url")
            // Use HttpURLConnection to follow GitHub redirects
            var connection = URI.create(url).toURL().openConnection() as HttpURLConnection
            connection.instanceFollowRedirects = true
            // Java doesn't follow redirects across protocols; handle manually
            var redirects = 0
            while (connection.responseCode in 301..302 && redirects < 5) {
                val location = connection.getHeaderField("Location")
                connection.disconnect()
                connection = URI.create(location).toURL().openConnection() as HttpURLConnection
                connection.instanceFollowRedirects = true
                redirects++
            }
            zipFile.outputStream().use { os ->
                connection.inputStream.use { input ->
                    input.copyTo(os)
                }
            }
            connection.disconnect()
        }

        // H-05: Always verify SHA-256 — catches tampered cached files too (#204)
        val digest = MessageDigest.getInstance("SHA-256")
        val actualSha256 = zipFile.inputStream().use { input ->
            val buf = ByteArray(8192)
            var n: Int
            while (input.read(buf).also { n = it } != -1) { digest.update(buf, 0, n) }
            digest.digest().joinToString("") { "%02x".format(it) }
        }
        if (actualSha256 != expectedSha256) {
            zipFile.delete()
            throw GradleException(
                "SHA-256 mismatch for nodejs-mobile ZIP!\n" +
                "  Expected: $expectedSha256\n" +
                "  Actual:   $actualSha256\n" +
                "File may be corrupted or tampered with."
            )
        }
        println("SHA-256 verified: $actualSha256")

        // Extract if not already extracted (check for a known output directory)
        val binDir = File(extractDir, "bin")
        if (!binDir.exists()) {
            println("Extracting Node.js to: $extractDir")
            extractDir.mkdirs()
            val canonicalPrefix = extractDir.canonicalPath + File.separator
            ZipInputStream(zipFile.inputStream()).use { zis ->
                var entry = zis.nextEntry
                while (entry != null) {
                    val targetFile = File(extractDir, entry.name)
                    // H-06: Zip Slip guard — reject entries that escape extractDir (#204)
                    if (!targetFile.canonicalPath.startsWith(canonicalPrefix) &&
                        targetFile.canonicalPath != extractDir.canonicalPath) {
                        throw GradleException("Zip Slip detected: ${entry.name} escapes $extractDir")
                    }
                    if (entry.isDirectory) {
                        targetFile.mkdirs()
                    } else {
                        targetFile.parentFile.mkdirs()
                        targetFile.outputStream().use { fos -> zis.copyTo(fos) }
                    }
                    entry = zis.nextEntry
                }
            }
        }
    }
}

tasks.register<DownloadNodejsTask>("downloadNodejs")
tasks.named("preBuild") { dependsOn("downloadNodejs") }

// ═══════════════════════════════════════════════════════════════════════════
// BAT-1293 — build provenance (see the invariant note in defaultConfig)
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Canonical digest over the packaged Node bundle.
 *
 * SHARED CONTRACT with BAT-1298, which must reproduce this byte-for-byte or the
 * cross-check the two exist to enable is meaningless. One record per file,
 * concatenated in ascending path order, then SHA-256 over the whole stream:
 *
 *     <relative-path> NUL <byteLength> NUL <sha256-hex-of-file> LF
 *
 * Paths are UTF-8, relative, '/'-separated (normalised on Windows) and
 * CASE-SENSITIVE, sorted by the bytes of their UTF-8 encoding. Length and
 * separators are explicit precisely so `a/b` + `c` cannot collide with
 * `a` + `b/c`. Symlinks are rejected — the bundle must be plain files. The
 * empty tree hashes the empty stream.
 *
 * Byte lengths are decimal with no leading zeros; hex is lowercase.
 */
/**
 * Minimal JSON string literal, built character by character.
 *
 * Deliberately avoids nested string-literal escaping: getting `\\` and `\"`
 * right inside a Kotlin string inside a Gradle script is a reliable source of
 * silent breakage, and this file is the one place a mistake would be stamped
 * into every artifact.
 */


// NOTE: this task lives in the script rather than buildSrc, matching the existing
// DownloadNodejsTask precedent. That constrains it: Gradle cannot generate a
// managed subclass for a class nested in a .gradle.kts, so ABSTRACT properties
// (`abstract val x: Property<T>`) fail with "non-static inner class". Properties
// are therefore created eagerly from `project.objects`. outputDir must stay a
// DirectoryProperty because addGeneratedSourceDirectory wires it.
open class GenerateBuildProvenanceTask : DefaultTask() {
    @get:OutputDirectory
    val outputDir: DirectoryProperty = project.objects.directoryProperty()

    @get:Input var versionNameIn: String = ""
    @get:Input var versionCodeIn: Int = 0
    @get:Input var openclawVersionIn: String = ""
    @get:Input var nodejsVersionIn: String = ""
    @get:Input var isReleaseIn: Boolean = false
    @get:Input var allowUnverifiedIn: Boolean = false
    @get:Internal var repoRootIn: File = File(".")
    @get:Internal var bundleDirIn: File = File(".")

    // These helpers live INSIDE the task class deliberately. Declared at script
    // scope they were captured by the class, which makes Kotlin emit it as an
    // INNER class — and Gradle then refuses with "non-static inner class".
    // DownloadNodejsTask avoids this only by referencing nothing outside itself.
    fun jsonStr(v: String?): String {
        if (v == null) return "null"
        val sb = StringBuilder()
        sb.append('"')
        for (c in v) {
            when (c) {
                '"' -> { sb.append('\\'); sb.append('"') }
                '\\' -> { sb.append('\\'); sb.append('\\') }
                else -> sb.append(c)
            }
        }
        sb.append('"')
        return sb.toString()
    }

    fun jsonObj(pairs: List<Pair<String, String>>): String =
        pairs.joinToString(",", "{", "}") { p -> jsonStr(p.first) + ":" + p.second }

    fun bundleTreeDigest(root: File): String {
        val stream = ByteArrayOutputStream()
        if (root.isDirectory) {
            val files = root.walkTopDown()
                .onEnter { !Files.isSymbolicLink(it.toPath()) }
                .filter { it.isFile }
                .toList()
            for (f in files) {
                if (Files.isSymbolicLink(f.toPath())) {
                    throw GradleException("Bundle contains a symlink, which the digest contract forbids: $f")
                }
            }
            val records = files.map { f ->
                val rel = root.toPath().relativize(f.toPath()).joinToString("/") { it.toString() }
                val bytes = f.readBytes()
                val sha = MessageDigest.getInstance("SHA-256").digest(bytes)
                    .joinToString("") { "%02x".format(it) }
                Triple(rel, bytes.size, sha)
            }.sortedBy { it.first.toByteArray(Charsets.UTF_8).toList().joinToString(",") { b -> b.toString().padStart(4, '0') } }
            for ((rel, len, sha) in records) {
                stream.write(rel.toByteArray(Charsets.UTF_8)); stream.write(0)
                stream.write(len.toString().toByteArray(Charsets.UTF_8)); stream.write(0)
                stream.write(sha.toByteArray(Charsets.UTF_8)); stream.write('\n'.code)
            }
        }
        return MessageDigest.getInstance("SHA-256").digest(stream.toByteArray())
            .joinToString("") { "%02x".format(it) }
    }


    /**
     * D2: git is invoked at EXECUTION time, from the repo root.
     *
     * ProcessBuilder rather than an injected ExecOperations because Gradle
     * cannot inject services into a class declared inside a .gradle.kts
     * script. `git -C <root>` lets git resolve a pointer-file .git, packed
     * refs and detached HEAD itself — never read .git internals by hand.
     */
    private fun git(vararg args: String): Pair<Int, String> {
        val cmd = listOf("git", "-C", repoRootIn.absolutePath) + args.toList()
        return try {
            val p = ProcessBuilder(cmd).start()
            val stdout = p.inputStream.bufferedReader().readText().trim()
            p.errorStream.bufferedReader().readText()
            p.waitFor() to stdout
        } catch (e: Exception) {
            logger.warn("[BuildProvenance] git failed: " + e.message)
            -1 to ""
        }
    }

    @TaskAction
    fun generate() {
        val dir = outputDir.get().asFile
        dir.mkdirs()
        val target = File(dir, "build-metadata.json")

        val (shaCode, commit) = git("rev-parse", "HEAD")
        val ok = shaCode == 0 && Regex("^[0-9a-f]{40}$").matches(commit)

        if (!ok) {
            // D5: fail closed. Never emit a plausible-looking wrong identity.
            if (!allowUnverifiedIn || isReleaseIn) {
                throw GradleException(
                    "Build provenance unavailable (git exit=$shaCode). Release builds always fail; " +
                    "for a debug build pass -PallowUnverifiedBuildProvenance=true on the COMMAND LINE."
                )
            }
            target.writeText(jsonObj(listOf(
                "schema" to "1",
                "commit" to "null",
                "commitShort" to "null",
                "dirty" to "null",
                "branch" to "null",
                "buildTimestampUtc" to jsonStr(Instant.now().toString()),
                "versionName" to jsonStr(versionNameIn),
                "versionCode" to versionCodeIn.toString(),
                "openclawVersion" to jsonStr(openclawVersionIn),
                "nodejsVersion" to jsonStr(nodejsVersionIn),
                "bundleDigest" to "null",
                "provenance" to jsonStr("unverified"),
            )))
            logger.warn("[BuildProvenance] UNVERIFIED build — no usable git state")
            return
        }

        // D3: dirty is part of identity. Untracked files are INCLUDED: an
        // untracked .kt or asset can be compiled and packaged, so ignoring them
        // would stamp a clean commit over bits that commit does not contain.
        // core.fileMode=false so a chmod (as CI does to gradlew) is not "dirty".
        val (_, status) = git("-c", "core.fileMode=false", "status", "--porcelain")
        val dirty = status.isNotEmpty()
        if (dirty && isReleaseIn) {
            throw GradleException("Refusing to build a RELEASE artifact from a dirty tree:\n$status")
        }

        val (_, branch) = git("rev-parse", "--abbrev-ref", "HEAD")
        val digest = bundleTreeDigest(bundleDirIn)

        target.writeText(jsonObj(listOf(
            "schema" to "1",
            "commit" to jsonStr(commit),
            "commitShort" to jsonStr(commit.take(12)),
            "dirty" to dirty.toString(),
            "branch" to jsonStr(branch),
            "buildTimestampUtc" to jsonStr(Instant.now().toString()),
            "versionName" to jsonStr(versionNameIn),
            "versionCode" to versionCodeIn.toString(),
            "openclawVersion" to jsonStr(openclawVersionIn),
            "nodejsVersion" to jsonStr(nodejsVersionIn),
            "bundleDigest" to jsonStr(digest),
            "provenance" to jsonStr("verified"),
        )))
        logger.lifecycle("[BuildProvenance] " + commit.take(12) + " dirty=" + dirty + " bundle=" + digest.take(12))
    }
}

// D2: ONE TASK PER VARIANT, registered as a GENERATED source directory.
//
// `variant.sources.assets.addGeneratedSourceDirectory` is the only AGP 8 API
// that makes the task's output a declared, content-hashed input of
// merge<Variant>Assets. AGP's own KDoc says: "Do not use addStaticSourceDirectory
// to add sources that are generated by a task, instead use
// addGeneratedSourceDirectory."
//
// EXPLICITLY FORBIDDEN here: `sourceSets["main"].assets.srcDir(...)` plus a
// dependsOn. That registers a STATIC directory with no producer relationship —
// at best Gradle reports an implicit-dependency problem, at worst mergeAssets
// snapshots the directory before the generator writes and the APK ships the
// previous build's metadata. That is this bug again with a file swapped for a
// constant. The repo's only local precedent (jniLibs.srcDirs, and
// DownloadNodejsTask ordered by dependsOn with no declared output) is the
// unsafe shape — do not copy it.
//
// upToDateWhen{false} only guarantees the PRODUCER re-runs; repackaging follows
// because the merged asset input's CONTENT hash changes. Different claims.

/**
 * BAT-1293 D6 — verify build identity FROM THE PACKAGED ARTIFACT.
 *
 * Reads assets/build-metadata.json out of the APK itself, never an intermediate,
 * and compares it against execution-time git state. This is the manual check that
 * originally caught the stale-SHA bug, made automatic.
 *
 * PM B3: a PRE-CONSUMPTION gate, not cleanup. `install<Variant>` dependsOn this, so
 * a rejected artifact never reaches the device — including via Android Studio Run,
 * which is the path every device test uses. A verifier that merely ran after
 * packaging could let installDappStoreDebug consume a bad APK and only fail the
 * build afterwards.
 *
 * On mismatch the artifact is DELETED before the failure is raised, so a rejected
 * APK cannot be installed by hand later. It is a regenerable build output.
 *
 * Self-contained on purpose: referencing a script-level helper would make this an
 * inner class, which Gradle refuses to instantiate.
 */
open class VerifyBuildProvenanceTask : DefaultTask() {
    @get:InputFiles
    val apkDir: DirectoryProperty = project.objects.directoryProperty()

    @get:Input var isReleaseIn: Boolean = false
    @get:Input var skipIn: Boolean = false
    @get:Internal var repoRootIn: File = File(".")

    /**
     * BAT-1293 part 4. The MERGED MANIFEST is what AGP actually stamps into the
     * APK, and therefore what PackageManager reports on device. Cross-checking
     * build-metadata.json against it is the gate that was missing: Part 1
     * verified `commit` and `dirty` but never the version fields, which is
     * precisely why the generator could be fed hand-typed version literals that
     * silently diverged from defaultConfig.
     */
    @get:InputFile
    val mergedManifestIn: RegularFileProperty = project.objects.fileProperty()

    /**
     * Scanned by hand rather than with a Regex, matching `field()` below: nested
     * string escaping inside a Gradle script is a reliable source of silent
     * breakage and has already cost this file two debugging cycles.
     */
    private fun attr(xml: String, name: String): String? {
        val marker = name + "=" + '"'
        val i = xml.indexOf(marker)
        if (i < 0) return null
        val start = i + marker.length
        val end = xml.indexOf('"', start)
        return if (end < 0) null else xml.substring(start, end)
    }

    private fun git(vararg args: String): Pair<Int, String> = try {
        val p = ProcessBuilder(listOf("git", "-C", repoRootIn.absolutePath) + args.toList()).start()
        val out = p.inputStream.bufferedReader().readText().trim()
        p.errorStream.bufferedReader().readText()
        p.waitFor() to out
    } catch (e: Exception) {
        -1 to ""
    }

    private fun sha256(bytes: ByteArray): String =
        MessageDigest.getInstance("SHA-256").digest(bytes).joinToString("") { "%02x".format(it) }

    /**
     * Scalar lookup by hand rather than a regex — the metadata is machine-written
     * and flat, and nested string escaping inside a Gradle script is a reliable
     * source of silent breakage (it already cost this file two debugging cycles).
     */
    private fun field(json: String, key: String): String? {
        val marker = "\"" + key + "\":"
        val i = json.indexOf(marker)
        if (i < 0) return null
        var p = i + marker.length
        if (p >= json.length) return null
        return if (json[p] == '"') {
            val end = json.indexOf('"', p + 1)
            if (end < 0) null else json.substring(p + 1, end)
        } else {
            val end = json.indexOfFirst(p) { c -> c == ',' || c == '}' }
            val raw = json.substring(p, if (end < 0) json.length else end).trim()
            if (raw == "null") null else raw
        }
    }

    private fun String.indexOfFirst(from: Int, pred: (Char) -> Boolean): Int {
        for (k in from until length) if (pred(this[k])) return k
        return -1
    }

    @TaskAction
    fun verify() {
        if (skipIn) {
            if (isReleaseIn) {
                throw GradleException("-PskipProvenanceVerify is rejected for release variants.")
            }
            logger.warn("[VerifyProvenance] SKIPPED via -PskipProvenanceVerify — this build must NOT be used for any device-test attestation")
            return
        }

        val dir = apkDir.get().asFile
        val apks = dir.listFiles { f: File -> f.name.endsWith(".apk") }?.toList().orEmpty()
        if (apks.isEmpty()) {
            logger.lifecycle("[VerifyProvenance] no APK found in " + dir.path)
            return
        }

        val (code, headSha) = git("rev-parse", "HEAD")
        if (code != 0 || headSha.length != 40) {
            throw GradleException("[VerifyProvenance] cannot resolve git HEAD (exit " + code + ")")
        }

        for (apk in apks) {
            var meta: String? = null
            ZipFile(apk).use { zf ->
                val entry = zf.getEntry("assets/build-metadata.json")
                if (entry != null) {
                    meta = zf.getInputStream(entry).readBytes().toString(Charsets.UTF_8)
                }
            }
            val m = meta
            if (m == null) {
                apk.delete()
                throw GradleException("Artifact has no assets/build-metadata.json: " + apk.name + " (deleted)")
            }

            val packagedCommit = field(m, "commit")
            val packagedDirty = field(m, "dirty")

            if (packagedCommit != headSha) {
                apk.delete()
                throw GradleException(
                    "BUILD IDENTITY MISMATCH — artifact deleted.\n" +
                    "  packaged commit : " + packagedCommit + "\n" +
                    "  actual HEAD     : " + headSha + "\n" +
                    "This is the BAT-1293 failure class: the artifact does not carry the identity\n" +
                    "of the tree it was built from. Do NOT record a device test against this build."
                )
            }
            if (isReleaseIn && packagedDirty == "true") {
                apk.delete()
                throw GradleException("Release artifact was built from a dirty tree — deleted.")
            }

            // Version identity must agree with what Android will actually install.
            // defaultConfig and the generator now derive from ONE pair of vals so
            // they cannot diverge today; this gate exists so that a future refactor
            // re-splitting them FAILS THE BUILD instead of shipping a wrong version
            // silently — which is exactly how the duplication survived unnoticed.
            val manifestFile = mergedManifestIn.get().asFile
            val manifestXml = manifestFile.readText()
            val mfName = attr(manifestXml, "android:versionName")
            val mfCode = attr(manifestXml, "android:versionCode")
            if (mfName == null || mfCode == null) {
                apk.delete()
                throw GradleException(
                    "[VerifyProvenance] could not read versionName/versionCode from the merged\n" +
                    "manifest at " + manifestFile.path + " — refusing to attest an artifact whose\n" +
                    "identity cannot be cross-checked. Artifact deleted."
                )
            }
            val packagedName = field(m, "versionName")
            val packagedCode = field(m, "versionCode")
            if (packagedName != mfName || packagedCode != mfCode) {
                apk.delete()
                throw GradleException(
                    "BUILD VERSION MISMATCH — artifact deleted.\n" +
                    "  build-metadata.json : versionName=" + packagedName + " versionCode=" + packagedCode + "\n" +
                    "  merged manifest     : versionName=" + mfName + " versionCode=" + mfCode + "\n" +
                    "What the app REPORTS would differ from what Android INSTALLED. Both must\n" +
                    "derive from appVersionName/appVersionCode in app/build.gradle.kts."
                )
            }

            // The sidecar binds the metadata to the ARTIFACT'S BYTES, so a device-test
            // record can cite a content hash instead of a label. PM B2: it must travel
            // with the artifact through any rename or upload.
            val artifactSha = sha256(apk.readBytes())
            File(apk.parentFile, apk.name + ".provenance.json").writeText(
                "{\"artifactSha256\":\"" + artifactSha + "\"," +
                "\"artifactName\":\"" + apk.name + "\"," +
                "\"metadata\":" + m + "}"
            )
            logger.lifecycle(
                "[VerifyProvenance] " + apk.name + " OK  commit=" + headSha.take(12) +
                "  sha256=" + artifactSha.take(12)
            )
        }
    }
}

androidComponents {
    onVariants { variant ->
        val isRelease = variant.buildType == "release"
        val t = tasks.register<GenerateBuildProvenanceTask>(
            "generateBuildProvenance" + variant.name.replaceFirstChar { it.uppercase() }
        ) {
            // Derived, never re-typed — see "the ONE definition" above.
            versionNameIn = appVersionName
            versionCodeIn = appVersionCode
            openclawVersionIn = openclawVersion
            nodejsVersionIn = nodejsVersion
            isReleaseIn = isRelease
            allowUnverifiedIn = (
                // CLI-only: a value in gradle.properties must NOT make this
                // permanent and invisible.
                gradle.startParameter.projectProperties["allowUnverifiedBuildProvenance"] == "true"
            )
            repoRootIn = rootProject.layout.projectDirectory.asFile
            bundleDirIn = layout.projectDirectory.dir("src/main/assets/nodejs-project").asFile
            outputs.upToDateWhen { false }
        }
        variant.sources.assets?.addGeneratedSourceDirectory(t, GenerateBuildProvenanceTask::outputDir)

        // D6 / PM B3: a PRE-CONSUMPTION gate. install<Variant> dependsOn the verifier,
        // so Android Studio Run cannot deploy a rejected artifact. assemble is
        // finalizedBy it so a plain assemble is checked too.
        val verify = tasks.register<VerifyBuildProvenanceTask>(
            "verifyBuildProvenance" + variant.name.replaceFirstChar { it.uppercase() }
        ) {
            apkDir.set(variant.artifacts.get(com.android.build.api.artifact.SingleArtifact.APK))
            mergedManifestIn.set(
                variant.artifacts.get(com.android.build.api.artifact.SingleArtifact.MERGED_MANIFEST)
            )
            isReleaseIn = isRelease
            repoRootIn = rootProject.layout.projectDirectory.asFile
            // CLI-only, per-invocation: a value in gradle.properties must not make
            // this permanent and invisible. Rejected for release inside the task.
            skipIn = gradle.startParameter.projectProperties["skipProvenanceVerify"] == "true"
        }
        val cap = variant.name.replaceFirstChar { it.uppercase() }
        tasks.matching { it.name == "install" + cap }.configureEach { dependsOn(verify) }
        tasks.matching { it.name == "assemble" + cap }.configureEach { finalizedBy(verify) }
    }
}

// --- Dependencies ---

dependencies {
    implementation(libs.androidx.core.ktx)
    implementation(libs.androidx.lifecycle.runtime.ktx)
    implementation(libs.androidx.lifecycle.runtime.compose)
    implementation(libs.androidx.lifecycle.viewmodel.compose)
    implementation(libs.androidx.activity.compose)

    implementation(platform(libs.androidx.compose.bom))
    implementation(libs.androidx.ui)
    implementation(libs.androidx.ui.graphics)
    implementation(libs.androidx.ui.tooling.preview)
    implementation(libs.androidx.material3)
    implementation(libs.androidx.material.icons.extended)

    implementation(libs.androidx.navigation.compose)
    implementation(libs.kotlinx.serialization.json)

    // NanoHTTPD for Android Bridge (Node.js <-> Kotlin IPC)
    implementation("org.nanohttpd:nanohttpd:2.3.1")

    // Custom Tabs for OAuth browser flows
    implementation("androidx.browser:browser:1.8.0")

    // Solana Mobile Wallet Adapter
    // Bumped 2.0.3 → 2.0.4 (BAT-697 commit 1). 2.0.4 ships the security fix
    // ("Address Security Alerts 58, 63-66" — solana-mobile/mobile-wallet-adapter#791)
    // without bumping androidx.core transitively past 1.16.x.
    //
    // BAT-1187 CORRECTION: an earlier version of this comment claimed that
    // bumping compileSdk "cascades to AGP / target-SDK migration work", and that
    // claim deferred the Android 16 migration for months. It had the dependency
    // arrow BACKWARDS. androidx.core 1.17.0 *requires* compileSdk 36 — compileSdk
    // 36 does NOT require androidx.core 1.17.0. Verified by experiment: this
    // project compiles green at compileSdk/targetSdk 36 with the dependency set
    // completely unchanged, MWA still pinned at 2.0.4.
    //
    // What remains true: moving MWA to 2.0.5+/2.1.0 pulls androidx.core 1.17.0,
    // and any MWA bump must device-regression-test solana_send / solana_swap as
    // its own commit (Codex round-2 on BAT-697). That is a separate decision from
    // the target-SDK level and is NOT required by it.
    implementation("com.solanamobile:mobile-wallet-adapter-clientlib-ktx:2.0.4")

    // Solana transaction building (pure Kotlin)
    implementation("org.sol4k:sol4k:0.4.2")

    // BouncyCastle — Ed25519 signing for the burner wallet (BAT-582).
    // Not transitively available from Android Keystore (which uses platform
    // crypto for AES-GCM); must be declared explicitly. R8/ProGuard strips
    // unused BC classes, so APK impact is bounded to the Ed25519 surface.
    implementation("org.bouncycastle:bcprov-jdk18on:1.78.1")

    // Coil — image loading for skill avatars
    implementation(libs.coil.compose)

    // CameraX (Seeker Camera / vision capture)
    implementation("androidx.camera:camera-core:1.4.1")
    implementation("androidx.camera:camera-camera2:1.4.1")
    implementation("androidx.camera:camera-lifecycle:1.4.1")
    implementation("androidx.camera:camera-view:1.4.1")
    implementation("com.google.mlkit:barcode-scanning:17.3.0")

    // Firebase Analytics
    implementation(platform(libs.firebase.bom))
    implementation(libs.firebase.analytics)

    // Testing
    testImplementation("junit:junit:4.13.2")
    testImplementation("org.jetbrains.kotlinx:kotlinx-coroutines-test:1.9.0")

    debugImplementation(libs.androidx.ui.tooling)
}
