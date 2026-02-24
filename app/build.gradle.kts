import java.net.HttpURLConnection
import java.net.URI
import java.util.Properties
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

// Load signing config from local.properties (not in version control)
val localProps = Properties().apply {
    val f = rootProject.file("local.properties")
    if (f.exists()) f.inputStream().use { load(it) }
}

android {
    namespace = "com.seekerclaw.app"
    compileSdk = 35

    defaultConfig {
        applicationId = "com.seekerclaw.app"
        minSdk = 34
        targetSdk = 35
        versionCode = 6
        versionName = "1.4.1"

        // Keep these in sync when updating OpenClaw or nodejs-mobile
        buildConfigField("String", "OPENCLAW_VERSION", "\"2026.2.23\"")
        buildConfigField("String", "NODEJS_VERSION", "\"18 LTS\"")

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
        create("release") {
            val ksPath = localProps.getProperty("SEEKERCLAW_KEYSTORE_PATH")
            if (ksPath != null) {
                storeFile = file(ksPath)
                storePassword = localProps.getProperty("SEEKERCLAW_STORE_PASSWORD")
                keyAlias = localProps.getProperty("SEEKERCLAW_KEY_ALIAS")
                keyPassword = localProps.getProperty("SEEKERCLAW_KEY_PASSWORD")
            }
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
            val ksPath = localProps.getProperty("SEEKERCLAW_KEYSTORE_PATH")
            if (ksPath != null) {
                signingConfig = signingConfigs.getByName("release")
            }
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

            println("Extracting Node.js to: $extractDir")
            extractDir.mkdirs()
            ZipInputStream(zipFile.inputStream()).use { zis ->
                var entry = zis.nextEntry
                while (entry != null) {
                    val targetFile = File(extractDir, entry.name)
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

    // Solana Mobile Wallet Adapter
    implementation("com.solanamobile:mobile-wallet-adapter-clientlib-ktx:2.0.3")

    // Solana transaction building (pure Kotlin)
    implementation("org.sol4k:sol4k:0.4.2")

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
