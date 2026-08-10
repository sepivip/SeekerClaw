package com.seekerclaw.app.flipper

import android.content.Context
import android.util.Log
import kotlinx.coroutines.sync.Mutex
import java.io.Closeable
import java.io.File
import java.io.RandomAccessFile
import java.nio.channels.FileLock
import java.nio.channels.OverlappingFileLockException

/**
 * Guards the single GATT link to the enrolled Flipper, across both processes.
 *
 * The firmware holds exactly one pending-command slot, so two concurrent RPC sequences corrupt each
 * other's correlation: replies land against the wrong command id and an `App.Exit` from one session
 * can close an Infrared app the other just started.
 *
 * ### Why one lock is not enough
 *
 * Settings runs in the main process and the bridge press path in `:node`
 * (`SeekerClawService` declares `android:process=":node"`), so [mutex] — an ordinary in-process
 * `Mutex` — cannot see across them. An earlier version of this file argued the gap was unreachable
 * because enrollment is a foreground, user-driven action. That assumption does not hold: the agent
 * is driven from Telegram, so a message can arrive and fire a press while the user has Settings
 * open and is scanning. Both processes then open their own `BluetoothGatt` to the same peripheral,
 * which Android permits — they are separate GATT clients — and the Flipper is left interleaving two
 * RPC streams.
 *
 * So callers take **both**: [mutex] to serialise within a process, then [tryAcquire] for an
 * OS-level exclusive [FileLock] that spans them. The file lock is held by the *process*, which is
 * why the in-process mutex must be taken first — a second thread in the same process would
 * otherwise hit [OverlappingFileLockException] rather than a clean "busy".
 *
 * Both are `try`-shaped, never blocking: telling an agent to wait trains it to retry immediately
 * against a 6-10 second sequence, and a Settings scan that silently stalls reads as a hang.
 */
internal object FlipperLinkLock {

    private const val TAG = "FlipperIr"
    private const val LOCK_FILE = "flipper_link.lock"

    /** Serialises callers **within** one process. Take this before [tryAcquire]. */
    val mutex = Mutex()

    /**
     * An exclusive claim on the Flipper link, held until [close].
     *
     * Closing releases the lock before the file handle, and swallows failures on both: a lease that
     * cannot be cleanly released is already being torn down, and throwing here would mask whatever
     * error caused the teardown.
     */
    class Lease internal constructor(
        private val file: RandomAccessFile,
        private val lock: FileLock,
    ) : Closeable {
        override fun close() {
            try {
                lock.release()
            } catch (e: Exception) {
                Log.w(TAG, "[Flipper] releasing link lease failed: ${e.message}")
            }
            try {
                file.close()
            } catch (e: Exception) {
                Log.w(TAG, "[Flipper] closing link lease file failed: ${e.message}")
            }
        }
    }

    /**
     * Claims the link for this process, or returns null if the other one holds it.
     *
     * Null on any I/O failure as well as on genuine contention. That is the fail-closed direction:
     * if we cannot establish that we hold the link exclusively, we must not drive the radio.
     */
    fun tryAcquire(context: Context): Lease? {
        val target = File(context.applicationContext.filesDir, LOCK_FILE)
        val handle = try {
            RandomAccessFile(target, "rw")
        } catch (e: Exception) {
            Log.w(TAG, "[Flipper] could not open link lock file: ${e.message}")
            return null
        }
        val lock = try {
            handle.channel.tryLock()
        } catch (e: OverlappingFileLockException) {
            // Another thread in THIS process already holds it — a caller skipped `mutex`.
            Log.w(TAG, "[Flipper] link lock already held in-process; caller did not take the mutex")
            null
        } catch (e: Exception) {
            Log.w(TAG, "[Flipper] link lock failed: ${e.message}")
            null
        }
        if (lock == null) {
            try {
                handle.close()
            } catch (e: Exception) {
                Log.w(TAG, "[Flipper] closing unlocked link file failed: ${e.message}")
            }
            return null
        }
        return Lease(handle, lock)
    }
}
