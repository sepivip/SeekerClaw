package com.seekerclaw.app.state

import java.io.File
import java.io.RandomAccessFile
import kotlin.system.exitProcess

/**
 * BAT-1155 Codex re-review — helper entry point for the TWO-PROCESS race harness
 * ([XaiTwoProcessRaceTest]). Launched as a SEPARATE JVM (via ProcessBuilder) so two real OS
 * processes contend on the same `xai_oauth.json` + `xai_oauth.lock` files through the REAL
 * [XaiOAuthTokenStore] sidecar-lock + expected-epoch CAS protocol — the genuine cross-process
 * guarantee that a single-JVM test (one `jvmLock`) can't prove.
 *
 * Contract: `args[0]` = shared filesDir, `args[1]` = op, remaining args = op params. Prints
 * exactly one machine-readable `RESULT ...` line to stdout and exits 0 (2 on bad usage).
 */
object XaiTwoProcessHelper {

    @JvmStatic
    fun main(args: Array<String>) {
        if (args.size < 2) {
            println("RESULT outcome=USAGE_ERROR")
            exitProcess(2)
        }
        val dir = File(args[0])
        val op = args[1]
        XaiOAuthTokenStore.initForTest(dir)

        // Ready+go barrier: announce READY (so the parent knows both children are initialized and
        // parked at the barrier), then spin-wait for the "go" file — so the competing operations
        // fire genuinely SIMULTANEOUSLY, not sequentially. Spin (not sleep) after go to minimize
        // the release-to-op latency, maximizing the real interleaving on the sidecar lock.
        val readyIdx = args.indexOf("--ready")
        if (readyIdx >= 0 && readyIdx + 1 < args.size) {
            File(args[readyIdx + 1]).writeText("ready")
        }
        val goIdx = args.indexOf("--go")
        if (goIdx >= 0 && goIdx + 1 < args.size) {
            val go = File(args[goIdx + 1])
            val deadline = System.nanoTime() + 15_000_000_000L
            while (!go.exists() && System.nanoTime() < deadline) { /* spin */ }
        }

        val line = when (op) {
            "signin" -> render("signin", XaiOAuthTokenStore.signIn(args[2], args[3], args[4], args[5]))
            "rotate" -> render("rotate", XaiOAuthTokenStore.rotate(args[2].toLong(), args[3], args[4], args[5]))
            "signout" -> render("signout", XaiOAuthTokenStore.signOut())
            "markreauth" -> render("markreauth", XaiOAuthTokenStore.markReauth(args[2].toLong()))
            "marknotified" -> render("marknotified", XaiOAuthTokenStore.markReauthNotified(args[2].toLong()))
            "migrate" -> render("migrate", XaiOAuthTokenStore.migrateIfEmpty(args[2], args[3], args[4], args[5]))
            "read" -> {
                val r = XaiOAuthTokenStore.read()
                "RESULT op=read outcome=OK epoch=${r.epoch} tomb=${r.tombstone} reauth=${r.reauthRequired} " +
                    "notified=${r.reauthNotifiedEpoch} acc=${r.accessTokenEnc}"
            }
            // Acquire the sidecar OS lock, announce it, then hold until a release-signal file
            // appears (or a hard cap elapses) — lets the sibling process deterministically
            // observe a bounded cross-process lock failure regardless of JVM-startup timing.
            // args: holdlock <maxHoldMs> <releaseSignalFile>
            "holdlock" -> {
                val raf = RandomAccessFile(File(dir, XaiOAuthTokenStore.LOCK_NAME), "rw")
                val lock = raf.channel.lock()
                println("RESULT op=holdlock outcome=LOCKED")
                System.out.flush()
                val maxHold = args[2].toLong()
                val release = if (args.size > 3) File(args[3]) else null
                val until = System.nanoTime() + maxHold * 1_000_000L
                while (System.nanoTime() < until && !(release?.exists() ?: false)) {
                    try { Thread.sleep(5) } catch (_: InterruptedException) { break }
                }
                lock.release(); raf.close()
                "RESULT op=holdlock outcome=RELEASED"
            }
            else -> "RESULT outcome=UNKNOWN_OP op=$op"
        }
        println(line)
        System.out.flush()
        exitProcess(0)
    }

    private fun render(op: String, r: XaiOAuthTokenStore.Result): String = when (r) {
        is XaiOAuthTokenStore.Result.Ok ->
            "RESULT op=$op outcome=OK epoch=${r.record.epoch} tomb=${r.record.tombstone} acc=${r.record.accessTokenEnc}"
        is XaiOAuthTokenStore.Result.Conflict ->
            "RESULT op=$op outcome=CONFLICT currentEpoch=${r.currentEpoch}"
        is XaiOAuthTokenStore.Result.Failed ->
            "RESULT op=$op outcome=FAILED reason=${r.reason.replace(' ', '_')}"
    }
}
