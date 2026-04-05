import java.net.HttpURLConnection
import java.net.URI
import java.util.Properties
import java.util.Date
import java.security.MessageDigest
import java.text.SimpleDateFormat
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

android {
    namespace = "com.seekerclaw.app"
    compileSdk = 35

    defaultConfig {
        applicationId = "com.seekerclaw.app"
        minSdk = 34
        targetSdk = 35
        versionCode = 16
        versionName = "1.8.0"

        // Keep these in sync when updating OpenClaw or nodejs-mobile
        buildConfigField("String", "OPENCLAW_VERSION", "\"2026.3.24\"")
        buildConfigField("String", "NODEJS_VERSION", "\"18 LTS\"")

        // Git commit SHA (short) — always available, every build knows its source
        val gitSha = providers.exec {
            commandLine("git", "rev-parse", "--short", "HEAD")
        }.standardOutput.asText.get().trim()
        buildConfigField("String", "GIT_SHA", "\"$gitSha\"")

        // Build timestamp (ISO date)
        val buildDate = SimpleDateFormat("yyyy-MM-dd").format(Date())
        buildConfigField("String", "BUILD_DATE", "\"$buildDate\"")

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
    implementation("com.solanamobile:mobile-wallet-adapter-clientlib-ktx:2.0.3")

    // Solana transaction building (pure Kotlin)
    implementation("org.sol4k:sol4k:0.4.2")

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
