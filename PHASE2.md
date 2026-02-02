# SeekerClaw — Phase 2: Real Node.js Integration

> **Context:** Phase 1 scaffold is complete (all 4 screens, foreground service, mock NodeBridge). Now replace the mock with real nodejs-mobile to run actual Node.js on-device.

## Reference Implementation

Based on https://github.com/nini22P/nodejs-mobile-example-android — a working Compose + nodejs-mobile project. This is our blueprint.

## How nodejs-mobile Actually Works (NOT an AAR!)

nodejs-mobile is **NOT a Maven dependency or AAR**. It's:
1. A **prebuilt `libnode.so`** (native shared library) for each ABI (arm64-v8a, armeabi-v7a, x86_64)
2. A **C++ JNI bridge** (`native-lib.cpp`) that you write yourself
3. Connected via **CMake** in the Gradle build

The zip from GitHub releases contains the `libnode.so` binaries + Node.js headers. You link against them using CMake/NDK.

## Step-by-Step Implementation

### Step 1: Download nodejs-mobile binaries

Create a Gradle task that auto-downloads the nodejs-mobile release zip:

In **`app/build.gradle.kts`**, add this task (runs before build):

```kotlin
import java.security.MessageDigest
import java.nio.file.Files
import java.net.URI
import java.util.zip.ZipInputStream

// ... existing plugins and android blocks ...

abstract class DownloadNodejsTask : DefaultTask() {
    @TaskAction
    fun run() {
        val url = "https://github.com/nodejs-mobile/nodejs-mobile/releases/download/v18.20.4/nodejs-mobile-v18.20.4-android.zip"
        val expectedMD5 = "4fe60de25381937b03642404513ec26b"
        val zipFile = project.file("./libnode/nodejs-mobile-v18.20.4-android.zip")
        val extractDir = project.file("./libnode")

        if (zipFile.exists()) {
            val calculatedMD5 = MessageDigest.getInstance("MD5")
                .digest(Files.readAllBytes(zipFile.toPath()))
                .joinToString("") { "%02x".format(it) }
            if (calculatedMD5 != expectedMD5) {
                zipFile.delete()
                println("MD5 mismatch. File deleted: $zipFile")
            }
        }

        if (!zipFile.exists()) {
            zipFile.parentFile.mkdirs()
            println("Downloading Node.js from: $url")
            zipFile.outputStream().use { os ->
                URI.create(url).toURL().openStream().use { input ->
                    input.copyTo(os)
                }
            }
            val calculatedMD5 = MessageDigest.getInstance("MD5")
                .digest(Files.readAllBytes(zipFile.toPath()))
                .joinToString("") { "%02x".format(it) }
            if (calculatedMD5 != expectedMD5) {
                throw GradleException("MD5 verification failed for $zipFile")
            }

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
```

### Step 2: Configure CMake + NDK

Add to `android` block in **`app/build.gradle.kts`**:

```kotlin
android {
    // ... existing config ...

    defaultConfig {
        // ... existing config ...
        externalNativeBuild {
            cmake {
                cppFlags("")
                arguments("-DANDROID_STL=c++_shared")
            }
        }
        ndk {
            abiFilters.addAll(listOf("arm64-v8a", "x86_64")) // arm64 for Seeker, x86_64 for emulator
        }
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
```

### Step 3: Create CMakeLists.txt

**`app/src/main/cpp/CMakeLists.txt`**:

```cmake
cmake_minimum_required(VERSION 3.22.1)
project("native-lib")

add_library(${CMAKE_PROJECT_NAME} SHARED
        native-lib.cpp)

# Include node headers
include_directories(${CMAKE_SOURCE_DIR}/../../../libnode/include/node/)

# Import prebuilt libnode
add_library(libnode SHARED IMPORTED)
set_target_properties(libnode
        PROPERTIES IMPORTED_LOCATION
        ${CMAKE_SOURCE_DIR}/../../../libnode/bin/${ANDROID_ABI}/libnode.so)

target_link_libraries(${CMAKE_PROJECT_NAME}
        libnode
        android
        log)
```

### Step 4: Create the JNI bridge (C++)

**`app/src/main/cpp/native-lib.cpp`**:

```cpp
#include <jni.h>
#include <string>
#include <cstdlib>
#include "node.h"
#include <pthread.h>
#include <unistd.h>
#include <android/log.h>

// Redirect stdout/stderr to logcat
int pipe_stdout[2];
int pipe_stderr[2];
pthread_t thread_stdout;
pthread_t thread_stderr;
const char *ADBTAG = "SEEKERCLAW-NODE";

void *thread_stderr_func(void*) {
    ssize_t redirect_size;
    char buf[2048];
    while((redirect_size = read(pipe_stderr[0], buf, sizeof buf - 1)) > 0) {
        if(buf[redirect_size - 1] == '\n') --redirect_size;
        buf[redirect_size] = 0;
        __android_log_write(ANDROID_LOG_ERROR, ADBTAG, buf);
    }
    return 0;
}

void *thread_stdout_func(void*) {
    ssize_t redirect_size;
    char buf[2048];
    while((redirect_size = read(pipe_stdout[0], buf, sizeof buf - 1)) > 0) {
        if(buf[redirect_size - 1] == '\n') --redirect_size;
        buf[redirect_size] = 0;
        __android_log_write(ANDROID_LOG_INFO, ADBTAG, buf);
    }
    return 0;
}

int start_redirecting_stdout_stderr() {
    setvbuf(stdout, 0, _IONBF, 0);
    pipe(pipe_stdout);
    dup2(pipe_stdout[1], STDOUT_FILENO);

    setvbuf(stderr, 0, _IONBF, 0);
    pipe(pipe_stderr);
    dup2(pipe_stderr[1], STDERR_FILENO);

    if(pthread_create(&thread_stdout, 0, thread_stdout_func, 0) == -1) return -1;
    pthread_detach(thread_stdout);
    if(pthread_create(&thread_stderr, 0, thread_stderr_func, 0) == -1) return -1;
    pthread_detach(thread_stderr);
    return 0;
}

// JNI function — called from Kotlin
// IMPORTANT: The JNI name must match the Kotlin class that declares the external function
extern "C" jint JNICALL
Java_com_seekerclaw_app_service_NodeBridge_startNodeWithArguments(
        JNIEnv *env,
        jobject /* this */,
        jobjectArray arguments) {

    jsize argument_count = env->GetArrayLength(arguments);

    int c_arguments_size = 0;
    for (int i = 0; i < argument_count; i++) {
        c_arguments_size += strlen(env->GetStringUTFChars((jstring)env->GetObjectArrayElement(arguments, i), 0));
        c_arguments_size++;
    }

    char* args_buffer = (char*)calloc(c_arguments_size, sizeof(char));
    char* argv[argument_count];
    char* current_args_position = args_buffer;

    for (int i = 0; i < argument_count; i++) {
        const char* current_argument = env->GetStringUTFChars((jstring)env->GetObjectArrayElement(arguments, i), 0);
        strncpy(current_args_position, current_argument, strlen(current_argument));
        argv[i] = current_args_position;
        current_args_position += strlen(current_args_position) + 1;
    }

    if (start_redirecting_stdout_stderr() == -1) {
        __android_log_write(ANDROID_LOG_ERROR, ADBTAG, "Couldn't start redirecting stdout and stderr to logcat.");
    }

    return jint(node::Start(argument_count, argv));
}
```

**CRITICAL:** The JNI function name `Java_com_seekerclaw_app_service_NodeBridge_startNodeWithArguments` must exactly match the package path of the Kotlin class that declares the `external fun`. If NodeBridge is in `com.seekerclaw.app.service`, this is correct.

### Step 5: Rewrite NodeBridge.kt

Replace `app/src/main/java/com/seekerclaw/app/service/NodeBridge.kt` with:

```kotlin
package com.seekerclaw.app.service

import android.content.Context
import android.content.pm.PackageManager
import android.content.res.AssetManager
import com.seekerclaw.app.util.LogCollector
import com.seekerclaw.app.util.LogLevel
import com.seekerclaw.app.util.ServiceState
import com.seekerclaw.app.util.ServiceStatus
import java.io.File
import java.io.FileOutputStream
import java.io.IOException
import java.io.InputStream
import java.io.OutputStream
import java.util.concurrent.Executors
import java.util.concurrent.atomic.AtomicBoolean

/**
 * Real nodejs-mobile bridge via JNI.
 *
 * Node.js can only be started ONCE per process. To restart Node.js,
 * the entire service process must be killed and restarted.
 */
object NodeBridge {
    private val running = AtomicBoolean(false)
    private var _startedNodeAlready = false
    private val executor = Executors.newSingleThreadExecutor()

    private val NODE_DIR_NAME = "nodejs-project"

    @Volatile
    var lastHeartbeatResponse: Long = 0L
        private set

    init {
        System.loadLibrary("native-lib")
        System.loadLibrary("node")
    }

    // JNI function — implemented in native-lib.cpp
    private external fun startNodeWithArguments(arguments: Array<String>): Int

    /**
     * Copy bundled Node.js project from APK assets to internal storage.
     * Only re-copies when APK is updated (new install or app update).
     */
    fun extractBundle(context: Context) {
        LogCollector.append("[Service] Extracting OpenClaw bundle...")

        val nodeDir = context.filesDir.absolutePath + "/" + NODE_DIR_NAME
        if (wasAPKUpdated(context)) {
            val nodeDirRef = File(nodeDir)
            if (nodeDirRef.exists()) {
                deleteFolderRecursively(nodeDirRef)
            }
            copyAssetFolder(context.assets, NODE_DIR_NAME, nodeDir)
            saveLastUpdateTime(context)

            val fileCount = File(nodeDir).walk().count { it.isFile }
            LogCollector.append("[Service] OpenClaw bundle extracted ($fileCount files)")
        } else {
            LogCollector.append("[Service] Bundle up to date, skipping extraction")
        }
    }

    /**
     * Start Node.js with the entry script.
     * Can only be called ONCE per app process.
     */
    fun start(workDir: String, openclawDir: String) {
        if (_startedNodeAlready) {
            LogCollector.append("[NodeBridge] Node.js already started (single-start limitation)", LogLevel.WARN)
            return
        }
        if (running.getAndSet(true)) return

        _startedNodeAlready = true
        lastHeartbeatResponse = System.currentTimeMillis()
        ServiceState.updateStatus(ServiceStatus.STARTING)

        LogCollector.append("[NodeBridge] Starting Node.js runtime...")
        LogCollector.append("[NodeBridge] workDir=$workDir")
        LogCollector.append("[NodeBridge] openclawDir=$openclawDir")

        executor.submit {
            try {
                // The entry point is the main.js (or index.js) in the nodejs-project dir
                val entryPoint = "$openclawDir/main.js"
                LogCollector.append("[NodeBridge] Entry: $entryPoint")

                ServiceState.updateStatus(ServiceStatus.RUNNING)

                // This call BLOCKS the thread until Node.js exits
                val exitCode = startNodeWithArguments(
                    arrayOf("node", entryPoint, workDir)
                )

                LogCollector.append("[NodeBridge] Node.js exited with code $exitCode")
                running.set(false)
                ServiceState.updateStatus(ServiceStatus.STOPPED)
            } catch (e: Exception) {
                LogCollector.append("[NodeBridge] Failed to start: ${e.message}", LogLevel.ERROR)
                running.set(false)
                ServiceState.updateStatus(ServiceStatus.ERROR)
            }
        }
    }

    fun stop() {
        if (!running.getAndSet(false)) return
        LogCollector.append("[NodeBridge] Stop requested (Node.js can only be killed by process restart)", LogLevel.WARN)
        // Node.js can't be gracefully stopped via JNI — need process kill
        ServiceState.updateStatus(ServiceStatus.STOPPED)
    }

    fun restart() {
        LogCollector.append("[NodeBridge] Restart requested — requires service process restart", LogLevel.WARN)
        // Signal that a process-level restart is needed
        // The Watchdog/Service should kill and restart the android:process
    }

    fun isAlive(): Boolean = running.get()

    fun checkHeartbeat(timeoutMs: Long): Boolean {
        // For now, just check if running. Real heartbeat needs IPC (Phase 2b).
        // stdout/stderr are captured via logcat redirect, not direct IPC.
        return running.get()
    }

    // --- Asset extraction helpers ---

    private fun wasAPKUpdated(context: Context): Boolean {
        val prefs = context.getSharedPreferences("NODEJS_MOBILE_PREFS", Context.MODE_PRIVATE)
        val previousLastUpdateTime = prefs.getLong("NODEJS_MOBILE_APK_LastUpdateTime", 0)
        var lastUpdateTime: Long = 1
        try {
            val packageInfo = context.packageManager.getPackageInfo(context.packageName, 0)
            lastUpdateTime = packageInfo.lastUpdateTime
        } catch (e: PackageManager.NameNotFoundException) {
            e.printStackTrace()
        }
        return lastUpdateTime != previousLastUpdateTime
    }

    private fun saveLastUpdateTime(context: Context) {
        val prefs = context.getSharedPreferences("NODEJS_MOBILE_PREFS", Context.MODE_PRIVATE)
        var lastUpdateTime: Long = 1
        try {
            val packageInfo = context.packageManager.getPackageInfo(context.packageName, 0)
            lastUpdateTime = packageInfo.lastUpdateTime
        } catch (e: PackageManager.NameNotFoundException) {
            e.printStackTrace()
        }
        prefs.edit().putLong("NODEJS_MOBILE_APK_LastUpdateTime", lastUpdateTime).apply()
    }

    private fun deleteFolderRecursively(file: File): Boolean {
        return try {
            var res = true
            val childFiles = file.listFiles() ?: return file.delete()
            for (childFile in childFiles) {
                res = if (childFile.isDirectory) {
                    res and deleteFolderRecursively(childFile)
                } else {
                    res and childFile.delete()
                }
            }
            res and file.delete()
        } catch (e: Exception) {
            e.printStackTrace()
            false
        }
    }

    private fun copyAssetFolder(assetManager: AssetManager, fromAssetPath: String, toPath: String): Boolean {
        return try {
            val files = assetManager.list(fromAssetPath) ?: return false
            val toDir = File(toPath)
            val success = toDir.mkdirs() || toDir.isDirectory

            if (files.isEmpty()) {
                // It's a file
                copyAsset(assetManager, fromAssetPath, toPath)
            } else {
                // It's a directory
                for (file in files) {
                    copyAssetFolder(assetManager, "$fromAssetPath/$file", "$toPath/$file")
                }
                success
            }
        } catch (e: Exception) {
            e.printStackTrace()
            false
        }
    }

    private fun copyAsset(assetManager: AssetManager, fromAssetPath: String, toPath: String): Boolean {
        var inputStream: InputStream? = null
        var outputStream: OutputStream? = null
        return try {
            inputStream = assetManager.open(fromAssetPath)
            File(toPath).parentFile?.mkdirs()
            outputStream = FileOutputStream(toPath)
            val buffer = ByteArray(8192)
            var read: Int
            while (inputStream.read(buffer).also { read = it } != -1) {
                outputStream.write(buffer, 0, read)
            }
            true
        } catch (e: IOException) {
            e.printStackTrace()
            false
        } finally {
            inputStream?.close()
            outputStream?.close()
        }
    }
}
```

### Step 6: Create the Node.js project in assets

**`app/src/main/assets/nodejs-project/main.js`**:

```javascript
// SeekerClaw Node.js entry point
// Phase 2a: Simple test script to prove Node.js runs on device
// Phase 2b: Replace with real OpenClaw gateway

console.log('[SeekerClaw] Node.js started!');
console.log('[SeekerClaw] Platform:', process.platform, process.arch);
console.log('[SeekerClaw] Node version:', process.version);
console.log('[SeekerClaw] Working directory:', process.cwd());
console.log('[SeekerClaw] Args:', process.argv);

// Keep the process alive
setInterval(() => {
    console.log('[SeekerClaw] Heartbeat:', new Date().toISOString());
}, 30000);

// Handle uncaught errors
process.on('uncaughtException', (err) => {
    console.error('[SeekerClaw] Uncaught exception:', err.message);
});

console.log('[SeekerClaw] Ready and running!');
```

### Step 7: Update OpenClawService.kt

Update the service to use real NodeBridge:

```kotlin
// In onStartCommand:

// 1. Extract bundle
NodeBridge.extractBundle(applicationContext)

// 2. Setup workspace
val workDir = File(filesDir, "workspace").apply { mkdirs() }
val nodeProjectDir = filesDir.absolutePath + "/nodejs-project"

// 3. Write config.yaml
writeConfigFile(workDir)

// 4. Start Node.js (runs on background thread, blocks until exit)
NodeBridge.start(workDir.absolutePath, nodeProjectDir)
```

### Step 8: Update Watchdog

Since there's no direct IPC in Phase 2a (stdout goes to logcat, not back to Kotlin), the Watchdog should just check if the thread is alive:

```kotlin
// In Watchdog check():
if (!NodeBridge.isAlive()) {
    missedChecks++
    if (missedChecks >= 2) {
        onDead() // Service should restart the process
        missedChecks = 0
    }
} else {
    missedChecks = 0
}
```

### Step 9: Handle the single-start limitation

Since Node.js can only start once per process, add `android:process=":node"` to the service in AndroidManifest.xml:

```xml
<service android:name=".service.OpenClawService"
         android:foregroundServiceType="specialUse"
         android:process=":node"
         android:exported="false" />
```

This runs the service in a separate process. To restart Node.js, kill this process — Android will recreate it (START_STICKY).

**Note:** This means the service can't directly share memory with the UI. Communication must happen via Binder/IPC or SharedPreferences/files.

## .gitignore

Add to `.gitignore`:
```
app/libnode/
```

The `libnode/` directory is auto-downloaded by the Gradle task. Don't commit the 100MB+ binaries.

## Build Order

1. ✅ Add Gradle download task + CMake config + NDK settings
2. ✅ Create `native-lib.cpp` + `CMakeLists.txt`
3. ✅ Rewrite `NodeBridge.kt` with JNI bridge + asset extraction
4. ✅ Create `assets/nodejs-project/main.js` (simple test)
5. ✅ Update service + watchdog
6. Build and test — Node.js should start and print to logcat
7. Later (Phase 2b): Replace `main.js` with real OpenClaw entry point

## Testing

After building, check logcat for:
```
SEEKERCLAW-NODE: [SeekerClaw] Node.js started!
SEEKERCLAW-NODE: [SeekerClaw] Platform: android arm64
SEEKERCLAW-NODE: [SeekerClaw] Node version: v18.20.4
SEEKERCLAW-NODE: [SeekerClaw] Ready and running!
```

If you see that, Phase 2a is done — real Node.js running on device! 🎉
