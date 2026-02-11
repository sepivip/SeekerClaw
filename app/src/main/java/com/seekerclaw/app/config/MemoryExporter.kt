package com.seekerclaw.app.config

import android.content.Context
import android.net.Uri
import com.seekerclaw.app.util.LogCollector
import com.seekerclaw.app.util.LogLevel
import java.io.File
import java.util.zip.ZipEntry
import java.util.zip.ZipInputStream
import java.util.zip.ZipOutputStream

/**
 * MemoryExporter - Handles workspace memory export/import via ZIP files
 *
 * Exports:
 * - SOUL.md, MEMORY.md, IDENTITY.md, USER.md, HEARTBEAT.md
 * - memory/ directory (daily memory files)
 * - skills/ directory (custom skills)
 * - BOOTSTRAP.md
 *
 * Excludes:
 * - config.yaml, config.json (regenerated from encrypted storage)
 * - node_debug.log (transient)
 */
object MemoryExporter {
    private const val TAG = "MemoryExporter"

    // Files to exclude from export (regenerated or transient)
    private val EXPORT_EXCLUDE = setOf(
        "config.yaml", "config.json", "node_debug.log"
    )

    /**
     * Export workspace memory to a ZIP file at the given URI.
     * Includes: SOUL.md, MEMORY.md, IDENTITY.md, USER.md, HEARTBEAT.md,
     *           memory dir, skills dir, BOOTSTRAP.md
     * Excludes: config.yaml, config.json, node_debug.log
     */
    fun exportMemory(context: Context, uri: Uri): Boolean {
        val workspaceDir = File(context.filesDir, "workspace")
        if (!workspaceDir.exists()) {
            LogCollector.append("[$TAG] Cannot export: workspace directory does not exist", LogLevel.ERROR)
            return false
        }

        return try {
            context.contentResolver.openOutputStream(uri)?.use { outputStream ->
                ZipOutputStream(outputStream).use { zip ->
                    addDirectoryToZip(zip, workspaceDir, workspaceDir)
                }
            }
            LogCollector.append("[$TAG] Memory exported successfully")
            true
        } catch (e: Exception) {
            LogCollector.append("[$TAG] Failed to export memory: ${e.message}", LogLevel.ERROR)
            false
        }
    }

    private fun addDirectoryToZip(zip: ZipOutputStream, dir: File, baseDir: File) {
        val files = dir.listFiles() ?: return
        for (file in files) {
            val relativePath = file.relativeTo(baseDir).path.replace("\\", "/")

            // Skip excluded files
            if (file.name in EXPORT_EXCLUDE) continue

            if (file.isDirectory) {
                addDirectoryToZip(zip, file, baseDir)
            } else {
                zip.putNextEntry(ZipEntry(relativePath))
                file.inputStream().use { it.copyTo(zip) }
                zip.closeEntry()
            }
        }
    }

    /**
     * Import workspace memory from a ZIP file at the given URI.
     * Extracts into workspace directory, overwriting existing files.
     * Does NOT overwrite config.yaml/config.json (those are regenerated).
     */
    fun importMemory(context: Context, uri: Uri): Boolean {
        val workspaceDir = File(context.filesDir, "workspace").apply { mkdirs() }

        return try {
            context.contentResolver.openInputStream(uri)?.use { inputStream ->
                ZipInputStream(inputStream).use { zip ->
                    var entry = zip.nextEntry
                    while (entry != null) {
                        val entryName = entry.name

                        // Skip config files (regenerated from encrypted store)
                        if (entryName in EXPORT_EXCLUDE) {
                            zip.closeEntry()
                            entry = zip.nextEntry
                            continue
                        }

                        val destFile = File(workspaceDir, entryName)

                        // Security: prevent path traversal (check with separator to avoid "/workspace2" bypass)
                        val workspacePath = workspaceDir.canonicalFile.path + File.separator
                        val destPath = destFile.canonicalFile.path
                        if (!destPath.startsWith(workspacePath)) {
                            LogCollector.append("[$TAG] Skipping suspicious import entry: $entryName", LogLevel.WARN)
                            zip.closeEntry()
                            entry = zip.nextEntry
                            continue
                        }

                        if (entry.isDirectory) {
                            destFile.mkdirs()
                        } else {
                            destFile.parentFile?.mkdirs()
                            destFile.outputStream().use { zip.copyTo(it) }
                        }

                        zip.closeEntry()
                        entry = zip.nextEntry
                    }
                }
            }
            LogCollector.append("[$TAG] Memory imported successfully")
            true
        } catch (e: Exception) {
            LogCollector.append("[$TAG] Failed to import memory: ${e.message}", LogLevel.ERROR)
            false
        }
    }
}
