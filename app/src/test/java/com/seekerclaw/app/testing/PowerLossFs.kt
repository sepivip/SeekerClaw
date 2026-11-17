package com.seekerclaw.app.testing

import com.seekerclaw.app.util.SafeFs
import java.io.IOException
import java.nio.file.Files
import java.nio.file.Path
import java.nio.file.StandardCopyOption

/**
 * BAT-1157 test fixture: a filesystem with Linux's fsync-error semantics.
 *
 * - A rename is not durable until a LATER directory fsync of its directory succeeds.
 * - When a directory fsync FAILS, the error is reported once and the dirty state behind it may be
 *   dropped: every rename then pending in that directory is POISONED — no later successful fsync
 *   makes it durable. Only a fresh rename of the same file (a rewrite), followed by a successful
 *   fsync, does. This is why "re-sync and read back" is no proof and the contract requires a
 *   confirmed rewrite.
 * - [powerLoss] rolls back every pending or poisoned rename to its bytes before the first
 *   un-durable rename (or removes a file that did not exist).
 *
 * Install with [install] (wraps [SafeFs.beforeMove] and [SafeFs.dirSyncChecked]); set [syncFails]
 * to make every checked directory fsync throw. [uninstall] restores the previous hooks.
 */
class PowerLossFs {
    /** When true, every checked directory fsync throws (and poisons what was pending). */
    @Volatile
    var syncFails: Boolean = false

    /** Not yet durable, still recoverable by a successful sync: target → bytes before (null = absent). */
    private val pending = linkedMapOf<Path, ByteArray?>()

    /** Not durable, and a later sync will NOT fix it (a failed sync dropped it): same mapping. */
    private val poisoned = linkedMapOf<Path, ByteArray?>()

    private var savedBeforeMove: ((Path, Path) -> Unit)? = null
    private var savedDirSyncChecked: ((Path) -> Unit)? = null

    fun install() {
        savedBeforeMove = SafeFs.beforeMove
        savedDirSyncChecked = SafeFs.dirSyncChecked
        SafeFs.beforeMove = { _, target ->
            val t = target.toAbsolutePath().normalize()
            synchronized(this) {
                when {
                    // A rewrite of a poisoned file: it is pending again (keeping its original "before"),
                    // so a successful sync after THIS rename makes it durable.
                    poisoned.containsKey(t) -> pending[t] = poisoned.remove(t)
                    !pending.containsKey(t) -> pending[t] = if (Files.exists(t)) Files.readAllBytes(t) else null
                }
            }
        }
        SafeFs.dirSyncChecked = { dir ->
            val d = dir.toAbsolutePath().normalize()
            synchronized(this) {
                val inDir = pending.keys.filter { it.parent == d }
                if (syncFails) {
                    inDir.forEach { poisoned[it] = pending.remove(it) }
                    throw IOException("injected directory fsync failure")
                }
                inDir.forEach { pending.remove(it) }
            }
        }
    }

    fun uninstall() {
        savedBeforeMove?.let { SafeFs.beforeMove = it }
        savedDirSyncChecked?.let { SafeFs.dirSyncChecked = it }
    }

    /** Rolls every pending or poisoned rename back to its previous bytes (or removes the file). */
    fun powerLoss() {
        synchronized(this) {
            for ((target, before) in pending + poisoned) {
                if (before == null) {
                    Files.deleteIfExists(target)
                } else {
                    val tmp = target.resolveSibling(target.fileName.toString() + ".restore")
                    Files.write(tmp, before)
                    Files.move(tmp, target, StandardCopyOption.REPLACE_EXISTING)
                }
            }
            pending.clear()
            poisoned.clear()
        }
    }

    /** True when a power cut would undo [file]'s current content. */
    fun isDurable(file: Path): Boolean {
        val f = file.toAbsolutePath().normalize()
        return synchronized(this) { !pending.containsKey(f) && !poisoned.containsKey(f) }
    }
}
