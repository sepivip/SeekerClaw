package com.seekerclaw.app

import android.app.Application
import android.app.NotificationChannel
import android.app.NotificationManager
import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import android.content.IntentFilter
import androidx.core.content.ContextCompat
import com.seekerclaw.app.config.ConfigManager
import com.seekerclaw.app.state.AgentPreferencesStore
import com.seekerclaw.app.state.McpServersStore
import com.seekerclaw.app.state.RuntimeStateStore
import com.seekerclaw.app.util.Analytics
import com.seekerclaw.app.util.LogCollector
import com.seekerclaw.app.util.ServiceState

class SeekerClawApplication : Application() {

    override fun onCreate() {
        super.onCreate()
        createNotificationChannel()

        // BAT-517: load the shared provider+model registry FIRST,
        // before anything else that might touch ConfigManager /
        // provider helpers. Runs in EVERY Android process (NOT
        // gated on isMainProcess) — the `:node` service process
        // also calls ConfigManager paths that depend on the
        // registry. `init` is idempotent so a second call from
        // a future code path (or a test) is a no-op. Failed parse
        // throws and leaves the registry uninitialized so a retry
        // can re-attempt the load.
        com.seekerclaw.app.config.ModelRegistry.init(this)

        // Firebase Analytics
        Analytics.init(this)
        ConfigManager.loadConfig(this)?.let { config ->
            Analytics.setUserProperty("model", config.model)
            Analytics.setUserProperty("auth_type", config.authType)
        }
        Analytics.setUserProperty("has_wallet", (!ConfigManager.getWalletAddress(this).isNullOrBlank()).toString())

        // Start cross-process file watching so UI picks up state/logs from :node.
        // Guard: only the main UI process should attach observers. The :node
        // process writes state files — if it also watched, both processes would
        // detect health transitions and write duplicate log entries to the shared
        // service_logs file (BAT-217).
        //
        // BAT-518: switched from 1s coroutine polling to kernel-level FileObserver.
        // Same external contract (StateFlow updates on file change), event-driven
        // with a large reduction in idle work. Not literally zero idle cost: a
        // 30s staleness ticker re-reads agent_health_state to keep the time-based
        // stale predicate live (see ServiceState.startStalenessTicker), and Doze
        // mode can batch FileObserver delivery.
        // Order matters: LogCollector's FileObserver also dispatches
        // ServiceState reads for filesDir state files (BAT-518 device-fix
        // consolidation). LogCollector activates its FileObserver
        // synchronously inside startWatching() — but its log-drain dispatch
        // is gated on `initialReadComplete` until the dispatched
        // readAllFromFile finishes. Cross-process state events
        // (service_state, bridge_token) ARE dispatched immediately,
        // independent of that gate, so attaching LogCollector first
        // guarantees its observer is live before ServiceState's initial
        // async read runs — a bridge_token CREATE landing during the
        // catch-up window is delivered to ServiceState without delay.
        val isMainProcess = getProcessName() == packageName
        if (isMainProcess) {
            LogCollector.startWatching(this)
            ServiceState.startWatching(this)
            // BAT-513: take ownership of the runtime config (provider /
            // authType / model) BEFORE the first UI screen reads it, so
            // RuntimeStateStore.state is hydrated on first composition
            // and the prefs↔file mirror is live. Init reads prefs first
            // and seeds runtime_state.json on first launch (one-shot
            // migration from the pre-BAT-513 SharedPreferences-only
            // path). Main process only — `:node` runs in its own
            // process and reads the same file directly via
            // runtime-state.js.
            RuntimeStateStore.init(this)
            // BAT-514: own the MCP server config (`mcp_servers.json`)
            // before any UI screen reads it. Mirrors RuntimeStateStore.init
            // — main process only (`:node` reads the same file directly
            // via mcp-servers.js). On first launch, splits legacy
            // `KEY_MCP_SERVERS_ENC` tokens into per-id encrypted files
            // and seeds the file. Sweeps orphan tokens after.
            McpServersStore.init(this)
            // BAT-515: own searchProvider + agentName prefs cross-process
            // (`agent_preferences.json`). Main process only — `:node`
            // reads the same file directly via agent-preferences.js.
            // Seed from existing `KEY_SEARCH_PROVIDER` / `KEY_AGENT_NAME`
            // SharedPrefs values so existing-user upgrades are seamless
            // (BAT-515 v3 §2). Migration preserves over-cap agentName
            // verbatim with WARN — never truncates (BAT-515 v3 §1).
            AgentPreferencesStore.init(this)
            registerConfigChangedReceiver()
        }
    }

    /**
     * Listen for cross-process config changes so the UI's configVersion
     * counter (per-process Compose state) bumps when ANY process writes
     * SharedPreferences via ConfigManager.saveConfig or
     * reconcileWithAgentSettings. Without this, after a /provider Telegram
     * switch (which runs in :node and triggers a service-start reconcile
     * that writes prefs), the main-process UI screens hold the stale
     * pre-switch values until the user manually navigates away and back —
     * remounting the screen forces a fresh loadConfig() read.
     *
     * The broadcast is package-scoped (setPackage(packageName) in
     * ConfigManager.broadcastConfigChanged) and the receiver is
     * NOT_EXPORTED, so this is internal-only — no external app can
     * trigger spurious recompositions or read our intent.
     *
     * Registered for the lifetime of the Application. No matching
     * unregister: the Application instance lives as long as the process,
     * so leaving the receiver registered is fine and avoids a missed-
     * unregister hazard.
     */
    private fun registerConfigChangedReceiver() {
        val receiver = object : BroadcastReceiver() {
            override fun onReceive(context: Context, intent: Intent) {
                if (intent.action == ConfigManager.ACTION_CONFIG_CHANGED) {
                    // BAT-513 round-15: route through the helper so
                    // configVersion mutation stays main-thread-safe
                    // and the "single chokepoint" claim in the helper
                    // KDoc holds. Direct `.intValue++` here would
                    // silently bypass the centralization.
                    // BroadcastReceiver.onReceive runs on the main
                    // thread, so the helper's Looper check hits the
                    // fast path with no Handler dispatch.
                    ConfigManager.bumpConfigVersionOnMain()
                }
            }
        }
        ContextCompat.registerReceiver(
            this,
            receiver,
            IntentFilter(ConfigManager.ACTION_CONFIG_CHANGED),
            ContextCompat.RECEIVER_NOT_EXPORTED,
        )
    }

    private fun createNotificationChannel() {
        val manager = getSystemService(NotificationManager::class.java)

        // Silent low-priority channel for the always-on foreground service notification.
        val serviceChannel = NotificationChannel(
            CHANNEL_ID,
            "SeekerClaw Service",
            NotificationManager.IMPORTANCE_LOW
        ).apply {
            description = "Keeps the AI agent running in the background"
            setShowBadge(false)
        }
        manager.createNotificationChannel(serviceChannel)

        // High-importance channel for actionable errors (e.g., setup required).
        // Uses default sound so the user is clearly alerted to an issue.
        val errorChannel = NotificationChannel(
            ERROR_CHANNEL_ID,
            "SeekerClaw Alerts",
            NotificationManager.IMPORTANCE_HIGH
        ).apply {
            description = "Important alerts that require user action"
            setShowBadge(true)
        }
        manager.createNotificationChannel(errorChannel)
    }

    companion object {
        const val CHANNEL_ID = "seekerclaw_service"
        const val ERROR_CHANNEL_ID = "seekerclaw_errors"
    }
}
