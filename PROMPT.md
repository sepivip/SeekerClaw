# SeekerClaw â€” Coding Agent Prompt

> **Product spec:** See `MVP.md` | **Background research:** See `RESEARCH.md`

## For: Claude Code / Codex / Cursor

Copy-paste the prompt below into your coding agent.

---

## PROMPT

You are building an Android app called **"SeekerClaw"** that turns a Solana Seeker phone into a 24/7 personal AI agent. The app runs the OpenClaw gateway (a Node.js application) as a background service. Users interact with their AI agent through Telegram â€” the app itself is minimal.

### Supported Devices

- **Primary:** Solana Seeker (Android 14, Snapdragon 6 Gen 1, 8GB RAM)
- **Secondary:** Any Android 14+ with 4GB+ RAM
- **Note:** OEM-modified ROMs (Xiaomi MIUI, Samsung OneUI) may aggressively kill background services â€” Seeker's stock Android avoids this.

### Development Phases

- **Phase 1 (PoC):** Mock OpenClaw with a simple Node.js script that responds to a hardcoded Telegram message. Goal: prove Node.js runs on device, Telegram message round-trip works.
- **Phase 2 (App Shell):** Real OpenClaw gateway bundled and running inside the foreground service. Full setup flow, all screens, watchdog, boot receiver.

### Tech Stack
- **Language:** Kotlin
- **UI:** Jetpack Compose (Material 3, dark theme)
- **Min SDK:** 34 (Android 14)
- **Node.js Runtime:** nodejs-mobile community fork: https://github.com/niccolobocook/nodejs-mobile â€” pin to latest stable release at development start (Node 18 LTS, ARM64)
- **QR Scanning:** CameraX + ZXing/ML Kit
- **Encryption:** Android Keystore (AES-256-GCM, no user auth required)
- **Build:** Gradle (Kotlin DSL)

### Project Structure

```
seekerclaw/
â”œâ”€â”€ app/
â”‚   â”œâ”€â”€ src/main/
â”‚   â”‚   â”œâ”€â”€ java/com/seekerclaw/app/
â”‚   â”‚   â”‚   â”œâ”€â”€ MainActivity.kt              # Single activity, Compose navigation
â”‚   â”‚   â”‚   â”œâ”€â”€ SeekerClawApplication.kt     # App class
â”‚   â”‚   â”‚   â”‚
â”‚   â”‚   â”‚   â”œâ”€â”€ ui/
â”‚   â”‚   â”‚   â”‚   â”œâ”€â”€ theme/
â”‚   â”‚   â”‚   â”‚   â”‚   â””â”€â”€ Theme.kt             # Dark theme (Theme.SeekerClaw), Material 3
â”‚   â”‚   â”‚   â”‚   â”œâ”€â”€ navigation/
â”‚   â”‚   â”‚   â”‚   â”‚   â””â”€â”€ NavGraph.kt           # Navigation: Setup → Main (Dashboard/Logs/Settings)
â”‚   â”‚   â”‚   â”‚   â”œâ”€â”€ setup/
â”‚   â”‚   â”‚   â”‚   â”‚   â””â”€â”€ SetupScreen.kt        # QR scan + manual entry + notification permission
â”‚   â”‚   â”‚   â”‚   â”œâ”€â”€ dashboard/
â”‚   â”‚   â”‚   â”‚   â”‚   â””â”€â”€ DashboardScreen.kt    # Status, uptime, start/stop
â”‚   â”‚   â”‚   â”‚   â”œâ”€â”€ logs/
â”‚   â”‚   â”‚   â”‚   â”‚   â””â”€â”€ LogsScreen.kt         # Scrollable log viewer
â”‚   â”‚   â”‚   â”‚   â””â”€â”€ settings/
â”‚   â”‚   â”‚   â”‚       â””â”€â”€ SettingsScreen.kt      # Edit config, reset, about
â”‚   â”‚   â”‚   â”‚
â”‚   â”‚   â”‚   â”œâ”€â”€ service/
â”‚   â”‚   â”‚   â”‚   â”œâ”€â”€ OpenClawService.kt        # Foreground Service â€” starts/manages Node.js
â”‚   â”‚   â”‚   â”‚   â”œâ”€â”€ NodeBridge.kt             # IPC wrapper for nodejs-mobile
â”‚   â”‚   â”‚   â”‚   â””â”€â”€ Watchdog.kt               # Monitors Node.js health, auto-restarts
â”‚   â”‚   â”‚   â”‚
â”‚   â”‚   â”‚   â”œâ”€â”€ receiver/
â”‚   â”‚   â”‚   â”‚   â””â”€â”€ BootReceiver.kt           # BOOT_COMPLETED → start service
â”‚   â”‚   â”‚   â”‚
â”‚   â”‚   â”‚   â”œâ”€â”€ config/
â”‚   â”‚   â”‚   â”‚   â”œâ”€â”€ ConfigManager.kt          # Read/write config (encrypted + prefs)
â”‚   â”‚   â”‚   â”‚   â”œâ”€â”€ KeystoreHelper.kt         # Android Keystore encrypt/decrypt
â”‚   â”‚   â”‚   â”‚   â””â”€â”€ QrParser.kt               # Parse QR JSON payload
â”‚   â”‚   â”‚   â”‚
â”‚   â”‚   â”‚   â””â”€â”€ util/
â”‚   â”‚   â”‚       â”œâ”€â”€ LogCollector.kt           # Captures Node.js stdout/stderr
â”‚   â”‚   â”‚       â””â”€â”€ ServiceState.kt           # Shared state (StateFlow) for UI
â”‚   â”‚   â”‚
â”‚   â”‚   â”œâ”€â”€ assets/
â”‚   â”‚   â”‚   â””â”€â”€ openclaw/                     # Bundled OpenClaw JS (extracted on first launch)
â”‚   â”‚   â”‚       â”œâ”€â”€ node_modules/
â”‚   â”‚   â”‚       â”œâ”€â”€ package.json
â”‚   â”‚   â”‚       â””â”€â”€ index.js
â”‚   â”‚   â”‚
â”‚   â”‚   â”œâ”€â”€ res/
â”‚   â”‚   â”‚   â”œâ”€â”€ drawable/
â”‚   â”‚   â”‚   â”‚   â””â”€â”€ ic_notification.xml       # Notification icon
â”‚   â”‚   â”‚   â””â”€â”€ values/
â”‚   â”‚   â”‚       â””â”€â”€ strings.xml
â”‚   â”‚   â”‚
â”‚   â”‚   â””â”€â”€ AndroidManifest.xml
â”‚   â”‚
â”‚   â””â”€â”€ build.gradle.kts
â”‚
â”œâ”€â”€ build.gradle.kts                          # Root build file
â”œâ”€â”€ settings.gradle.kts
â””â”€â”€ README.md
```

### AndroidManifest.xml â€” Key Permissions & Components

```xml
<uses-permission android:name="android.permission.FOREGROUND_SERVICE" />
<uses-permission android:name="android.permission.FOREGROUND_SERVICE_SPECIAL_USE" />
<uses-permission android:name="android.permission.RECEIVE_BOOT_COMPLETED" />
<uses-permission android:name="android.permission.INTERNET" />
<uses-permission android:name="android.permission.WAKE_LOCK" />
<uses-permission android:name="android.permission.CAMERA" />
<uses-permission android:name="android.permission.REQUEST_IGNORE_BATTERY_OPTIMIZATIONS" />
<uses-permission android:name="android.permission.POST_NOTIFICATIONS" />

<application ...>
    <activity android:name=".MainActivity" 
              android:exported="true"
              android:theme="@style/Theme.SeekerClaw">
        <intent-filter>
            <action android:name="android.intent.action.MAIN" />
            <category android:name="android.intent.category.LAUNCHER" />
        </intent-filter>
    </activity>
    
    <service android:name=".service.OpenClawService"
             android:foregroundServiceType="specialUse"
             android:exported="false" />
    
    <!-- 
         directBootAware: Consider setting to true if you want the boot receiver 
         to fire before the user unlocks the device (Direct Boot mode). This requires
         using device-protected storage for any config the service needs at boot.
         For v1, leave false â€” service starts after first unlock.
    -->
    <receiver android:name=".receiver.BootReceiver"
              android:enabled="true"
              android:exported="false">
        <intent-filter>
            <action android:name="android.intent.action.BOOT_COMPLETED" />
        </intent-filter>
    </receiver>
</application>
```

**Android Permission Notes:**
- `POST_NOTIFICATIONS`: Required on API 33+. Request at runtime during Setup flow before starting the service. Without this, the foreground service notification won't show (and the service may not start properly).
- `FOREGROUND_SERVICE_SPECIAL_USE` with `specialUse` type: dApp Store friendly â€” no justification needed. For Google Play, you must provide a justification explaining the continuous AI agent use case. Consider `dataSync` as an alternative type for Play Store, but note it has a 6-hour time limit on Android 14+.

### Screen Specs

#### 1. Setup Screen (first launch only)
- SeekerClaw logo + "Turn this phone into your AI agent" tagline
- **Runtime permission request:** On API 33+, request `POST_NOTIFICATIONS` permission before proceeding. Explain why: "SeekerClaw needs notification permission to run reliably in the background."
- Big "Scan QR Code" button → opens camera, scans QR
- "Enter manually" link → shows form:
  - Anthropic API Key (text field, password style)
  - Telegram Bot Token (text field, password style)  
  - Telegram Owner ID (number field)
  - Model (dropdown â€” see Model List below)
  - Agent Name (text field, default "MyAgent")
- "Start Agent" button → validates → saves config → starts service → navigates to Dashboard
- QR payload format: Base64-encoded JSON:
```json
{
  "v": 1,
  "anthropic_api_key": "sk-ant-api03-...",
  "telegram_bot_token": "123456789:ABCdefGHI...",
  "telegram_owner_id": "987654321",
  "model": "claude-sonnet-4-20250514",
  "agent_name": "MyAgent"
}
```

#### 2. Dashboard Screen (main screen)
- Large status circle: ðŸŸ¢ Running / ðŸ”´ Stopped / ðŸŸ¡ Starting
- Uptime text: "Running for 3d 14h 22m" (updates every second)
- Start/Stop toggle button
- Stats row: Messages today â€” Total messages â€” Last activity time
- Agent name at top
- All metrics tracked locally on-device only. No analytics servers, no telemetry. Users can view stats in Dashboard screen.

#### 3. Logs Screen
- Monospace text, auto-scrolling to bottom
- Color coded: white=info, yellow=warn, red=error
- Clear button, Share/Export button
- Auto-scroll toggle

#### 4. Settings Screen
- Config fields (masked by default, tap to reveal): API Key, Bot Token, Owner ID
- Model dropdown
- Agent Name
- Toggle: Auto-start on boot (default ON)
- Button: Battery optimization settings (opens Android settings)
- Danger zone: Reset Configuration, Clear Memory
- About: App version, OpenClaw version, Node.js version

**Navigation:** Bottom bar with 3 tabs: Dashboard | Logs | Settings

### Model List

Available models for the dropdown:
- `claude-sonnet-4-20250514` â€” default, balanced (cost/quality)
- `claude-opus-4-5` â€” smartest, most expensive
- `claude-haiku-3-5` â€” fast, cheapest

Model list can be updated via app update or future remote config.

### OpenClaw Config Generation

When user completes setup, generate this `config.yaml` for OpenClaw:

```yaml
version: 1
providers:
  anthropic:
    apiKey: "{anthropic_api_key}"

agents:
  main:
    model: "{model}"
    channel: telegram

channels:
  telegram:
    botToken: "{telegram_bot_token}"
    ownerIds:
      - "{telegram_owner_id}"
    polling: true
```

Save to the workspace directory as `config.yaml`. OpenClaw reads this on boot.

### Workspace Seeding

On first launch, seed the workspace directory with:
- **`SOUL.md`** â€” a default personality template (basic, friendly agent personality)
- **`MEMORY.md`** â€” empty file

These are standard OpenClaw workspace files â€” the agent creates and manages them automatically after first launch. The defaults just ensure a clean starting experience.

### Foreground Service (OpenClawService.kt)

```kotlin
class OpenClawService : Service() {
    private var wakeLock: PowerManager.WakeLock? = null
    private val serviceState = ServiceState.instance
    
    override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
        // Build persistent notification
        val notification = createNotification("SeekerClaw is running")
        startForeground(1, notification)
        
        // Acquire partial wake lock (CPU stays on)
        val pm = getSystemService(POWER_SERVICE) as PowerManager
        wakeLock = pm.newWakeLock(PowerManager.PARTIAL_WAKE_LOCK, "SeekerClaw::Service")
        wakeLock?.acquire()
        
        // Extract OpenClaw bundle if first run
        extractBundleIfNeeded()
        
        // Write config.yaml from encrypted storage
        writeConfigFile()
        
        // Start Node.js runtime with OpenClaw
        NodeBridge.start(
            workDir = filesDir.resolve("workspace").absolutePath,
            openclawDir = filesDir.resolve("openclaw").absolutePath,
            onLog = { line -> LogCollector.append(line) },
            onStatusChange = { status -> serviceState.updateStatus(status) }
        )
        
        // Start watchdog (checks every 30s, expects response within 10s, dead after 60s)
        Watchdog.start(
            checkIntervalMs = 30_000,
            responseTimeoutMs = 10_000,
            deadAfterMs = 60_000,  // 2 missed checks = dead
            onDead = { 
                LogCollector.append("[WATCHDOG] Node.js unresponsive for 60s, restarting...")
                NodeBridge.restart() 
            }
        )
        
        serviceState.updateStatus(ServiceStatus.RUNNING)
        return START_STICKY // Auto-restart if killed by OS
    }
    
    override fun onDestroy() {
        Watchdog.stop()
        NodeBridge.stop()
        wakeLock?.release()
        serviceState.updateStatus(ServiceStatus.STOPPED)
        super.onDestroy()
    }
}
```

### Watchdog Timing

- **Check interval:** Every 30 seconds, send heartbeat ping to Node.js
- **Response timeout:** Expect pong within 10 seconds
- **Dead declaration:** After 60 seconds of no response (2 consecutive missed checks), declare Node.js dead and restart
- These values are constants in `Watchdog.kt` â€” easy to tune later

### NodeBridge.kt â€” nodejs-mobile Integration

This wraps the nodejs-mobile JNI bridge:
- `start(workDir, openclawDir, onLog, onStatusChange)` â€” starts Node.js with OpenClaw's entry point
- `stop()` â€” graceful shutdown
- `restart()` â€” stop + start
- `isAlive(): Boolean` â€” checks if Node.js thread is running
- `sendHeartbeat()` â€” pings Node.js, expects pong within 10s

The entry point script for Node.js should be:
```javascript
// bootstrap.js â€” loaded by nodejs-mobile
process.chdir(process.argv[2] || '.'); // workspace dir
require(process.argv[3] || './openclaw'); // openclaw entry
```

### ServiceState.kt â€” Shared State

```kotlin
object ServiceState {
    val instance = ServiceState
    
    private val _status = MutableStateFlow(ServiceStatus.STOPPED)
    val status: StateFlow<ServiceStatus> = _status
    
    private val _uptime = MutableStateFlow(0L)
    val uptime: StateFlow<Long> = _uptime // millis since start
    
    private val _messageCount = MutableStateFlow(0)
    val messageCount: StateFlow<Int> = _messageCount
    
    fun updateStatus(s: ServiceStatus) { _status.value = s }
}

enum class ServiceStatus { STOPPED, STARTING, RUNNING, ERROR }
```

### KeystoreHelper.kt â€” Encryption

```kotlin
object KeystoreHelper {
    private const val KEY_ALIAS = "seekerclaw_config_key"
    
    fun encrypt(data: String): ByteArray {
        // Use Android Keystore AES-256-GCM
        // userAuthenticationRequired = false (service needs access without user)
        // Return IV + ciphertext
    }
    
    fun decrypt(encrypted: ByteArray): String {
        // Decrypt using Keystore key
    }
}
```

### Design Theme

Dark theme only (v1). Theme name: `Theme.SeekerClaw`. Colors:
- Background: `#0D0D0D`
- Surface: `#1A1A1A`  
- Card: `#1A1A1A` with `#FFFFFF0F` border
- Primary: `#00C805` (green â€” "running" state)
- Error: `#FF4444`
- Warning: `#FBBF24`
- Text primary: `#FFFFFF` at 87% opacity
- Text secondary: `#FFFFFF` at 50% opacity
- Accent: `#A78BFA` (purple â€” OpenClaw brand)

### Key Implementation Notes

1. **nodejs-mobile integration:** Use the community fork at `https://github.com/niccolobocook/nodejs-mobile`. Pin to the latest stable release at development start. Add to gradle dependencies. Follow their React Native integration guide but adapt for pure Kotlin (no React Native).

2. **Phase 1 â€” Mock OpenClaw:** Create a minimal `assets/openclaw/` directory with a `package.json` and `index.js` that: starts a Telegram bot using `grammy` or `telegraf`, responds to a hardcoded message from the owner with a canned reply, sends heartbeat pings back to the Android bridge. This proves the full pipeline works before bundling real OpenClaw.

3. **Phase 2 â€” Real OpenClaw:** Replace the mock with the actual OpenClaw gateway bundle. The real `index.js` is OpenClaw's entry point. Config, workspace, and all features work as documented.

4. **Config file:** Write `config.yaml` to the workspace directory. OpenClaw reads this automatically on startup.

5. **Logs:** Capture Node.js stdout/stderr via nodejs-mobile's event bridge. Store last 1000 lines in memory (ring buffer) for the Logs screen. Also write to `logs/openclaw.log` with rotation at 10MB.

6. **Battery:** On first launch after setup, show a dialog explaining why battery optimization exemption is needed, then call `Settings.ACTION_REQUEST_IGNORE_BATTERY_OPTIMIZATIONS`.

7. **Metrics:** All metrics (message count, uptime, response times) are tracked locally on-device only. No analytics servers, no telemetry.

### Build & Run

```bash
# Clone and open in Android Studio
git clone <repo>
cd seekerclaw

# Build debug APK
./gradlew assembleDebug

# Install on connected Seeker
adb install app/build/outputs/apk/debug/app-debug.apk
```

### Priority Order

Build in this order:
1. Project setup (Gradle, dependencies, theme)
2. Navigation (4 screens with bottom bar)
3. Setup screen (QR scan + manual entry + notification permission request)
4. Config encryption (KeystoreHelper + ConfigManager)  
5. Dashboard screen (status UI with mock data)
6. Settings screen (config display/edit)
7. Foreground Service (basic, without Node.js first)
8. nodejs-mobile integration (get Node.js running)
9. **Phase 1 mock:** Simple Node.js Telegram bot responding to hardcoded message
10. **Phase 2:** Replace mock with real OpenClaw gateway bundle
11. Boot receiver + auto-start
12. Watchdog + crash recovery (30s check / 10s timeout / 60s dead)
13. Logs screen (connect to real Node.js output)
14. Polish & testing

### What NOT to Build
- No Solana/wallet integration
- No trading/DeFi features  
- No in-app chat (users use Telegram)
- No light theme
- No multi-agent support
- No OTA updates (v1 = update via app store)

