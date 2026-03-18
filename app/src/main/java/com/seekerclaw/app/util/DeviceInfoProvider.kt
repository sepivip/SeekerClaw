package com.seekerclaw.app.util

import android.app.ActivityManager
import android.content.Context
import android.content.Intent
import android.content.IntentFilter
import android.os.BatteryManager
import android.os.StatFs
import java.io.File

data class DeviceInfo(
    val batteryLevel: Int,
    val isCharging: Boolean,
    val memoryUsedMb: Long,
    val memoryTotalMb: Long,
    val storageUsedGb: Float,
    val storageTotalGb: Float,
)

data class AppStorageInfo(
    val workspaceMb: Float,
    val databaseMb: Float,
    val logsMb: Float,
    val runtimeMb: Float,
    val totalMb: Float,
)

object DeviceInfoProvider {

    fun getDeviceInfo(context: Context): DeviceInfo {
        val battery = getBattery(context)
        val memory = getMemory(context)
        val storage = getStorage(context)
        return DeviceInfo(
            batteryLevel = battery.first,
            isCharging = battery.second,
            memoryUsedMb = memory.first,
            memoryTotalMb = memory.second,
            storageUsedGb = storage.first,
            storageTotalGb = storage.second,
        )
    }

    private fun getBattery(context: Context): Pair<Int, Boolean> {
        val intent = context.registerReceiver(null, IntentFilter(Intent.ACTION_BATTERY_CHANGED))
        val level = intent?.getIntExtra(BatteryManager.EXTRA_LEVEL, -1) ?: -1
        val scale = intent?.getIntExtra(BatteryManager.EXTRA_SCALE, 100) ?: 100
        val plugged = intent?.getIntExtra(BatteryManager.EXTRA_PLUGGED, 0) ?: 0
        val percent = if (scale > 0) (level * 100) / scale else 0
        return Pair(percent, plugged != 0)
    }

    private fun getMemory(context: Context): Pair<Long, Long> {
        val am = context.getSystemService(Context.ACTIVITY_SERVICE) as ActivityManager
        val memInfo = ActivityManager.MemoryInfo()
        am.getMemoryInfo(memInfo)
        val totalMb = memInfo.totalMem / (1024 * 1024)
        val availMb = memInfo.availMem / (1024 * 1024)
        val usedMb = totalMb - availMb
        return Pair(usedMb, totalMb)
    }

    fun getAppStorageInfo(context: Context): AppStorageInfo {
        val filesDir = context.filesDir
        val workspaceDir = File(filesDir, "workspace")
        val databaseMb = fileSizeMb(File(workspaceDir, "seekerclaw.db"))
        val nodeDebugLogMb = fileSizeMb(File(workspaceDir, "node_debug.log"))
        val workspaceMb = dirSizeMb(workspaceDir) - databaseMb - nodeDebugLogMb
        val logsMb = fileSizeMb(File(filesDir, "service_logs")) + nodeDebugLogMb
        val runtimeMb = dirSizeMb(File(filesDir, "nodejs-project"))
        val totalMb = workspaceMb.coerceAtLeast(0f) + databaseMb + logsMb + runtimeMb
        return AppStorageInfo(
            workspaceMb = workspaceMb.coerceAtLeast(0f),
            databaseMb = databaseMb,
            logsMb = logsMb,
            runtimeMb = runtimeMb,
            totalMb = totalMb,
        )
    }

    private fun dirSizeMb(dir: File): Float {
        if (!dir.exists()) return 0f
        return try {
            var size = 0L
            dir.walkTopDown().filter { it.isFile }.forEach { size += it.length() }
            size / (1024f * 1024f)
        } catch (_: Exception) {
            0f
        }
    }

    private fun fileSizeMb(file: File): Float {
        if (!file.exists()) return 0f
        return try {
            file.length() / (1024f * 1024f)
        } catch (_: Exception) {
            0f
        }
    }

    private fun getStorage(context: Context): Pair<Float, Float> {
        val stat = StatFs(context.filesDir.path)
        val totalBytes = stat.totalBytes
        val availBytes = stat.availableBytes
        val usedBytes = totalBytes - availBytes
        val totalGb = totalBytes / (1024f * 1024f * 1024f)
        val usedGb = usedBytes / (1024f * 1024f * 1024f)
        return Pair(usedGb, totalGb)
    }
}
