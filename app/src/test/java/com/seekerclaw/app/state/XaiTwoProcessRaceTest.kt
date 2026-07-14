package com.seekerclaw.app.state

import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Assert.fail
import org.junit.Before
import org.junit.Test
import java.io.File
import java.util.concurrent.TimeUnit

/**
 * BAT-1155 Codex re-review major-3 — the DETERMINISTIC two-process race harness Codex required
 * before the device soak. Each helper runs in a SEPARATE JVM (via ProcessBuilder), so two real
 * OS processes contend on the same `xai_oauth.json` + `xai_oauth.lock` through the production
 * [XaiOAuthTokenStore] sidecar-lock + expected-epoch CAS — the genuine cross-process guarantee a
 * single-JVM test (one shared `jvmLock`) cannot prove. This is the OS-level protocol proof; the
 * §6.9 device soak remains the Android integration/acceptance layer.
 */
class XaiTwoProcessRaceTest {

    private lateinit var dir: File

    @Before
    fun setUp() {
        dir = File.createTempFile("bat1155-2p", "").apply { delete(); mkdirs() }
    }

    @After
    fun tearDown() {
        dir.deleteRecursively()
    }

    private fun javaBin(): String {
        val home = System.getProperty("java.home")
        for (name in listOf("java", "java.exe")) {
            val f = File(home, "bin" + File.separator + name)
            if (f.exists()) return f.absolutePath
        }
        return "java"
    }

    // Android test classpaths are thousands of jars — far past the Windows command-line length
    // limit — so pass -cp via a Java @argfile (JDK 9+) instead of on the command line.
    private var argFileCounter = 0
    private fun spawn(vararg args: String): Process {
        val cp = System.getProperty("java.class.path")
        val argFile = File(dir, "cp-argfile-${argFileCounter++}.txt")
        argFile.writeText("-cp \"${cp.replace("\\", "\\\\")}\"\n")
        val cmd = mutableListOf(
            javaBin(), "@${argFile.absolutePath}",
            "com.seekerclaw.app.state.XaiTwoProcessHelper", dir.absolutePath,
        )
        cmd.addAll(args)
        return ProcessBuilder(cmd).redirectErrorStream(true).start()
    }

    /**
     * Collect a child's RESULT lines HANG-SAFELY (Codex re-review major-3): drain stdout on a
     * background thread so [Process.waitFor] with a timeout runs INDEPENDENTLY — a hung child is
     * force-killed and FAILS the test rather than blocking the runner forever on `readText()`.
     */
    private fun collect(p: Process, label: String): List<String> {
        val out = StringBuilder()
        val drain = Thread {
            runCatching { p.inputStream.bufferedReader().forEachLine { synchronized(out) { out.append(it).append('\n') } } }
        }.apply { isDaemon = true; start() }
        if (!p.waitFor(30, TimeUnit.SECONDS)) {
            p.destroyForcibly()
            fail("$label helper JVM hung (>30s) — force-killed")
        }
        drain.join(3000)
        val text = synchronized(out) { out.toString() }
        val results = text.lineSequence().filter { it.startsWith("RESULT ") }.toList()
        assertTrue("$label helper must print a RESULT line (got:\n$text)", results.isNotEmpty())
        return results
    }

    /** Run a helper op to completion; return its RESULT lines (hang-safe). */
    private fun run(vararg args: String): List<String> = collect(spawn(*args), args.joinToString(" "))

    /**
     * Run two competing ops GENUINELY SIMULTANEOUSLY (Codex re-review major-3): both children
     * initialize + park at a `--go` barrier and announce `--ready`; the parent waits for BOTH
     * ready, then releases them at once so they race the sidecar lock. Returns (aResults, bResults).
     */
    private fun race(aArgs: List<String>, bArgs: List<String>): Pair<List<String>, List<String>> {
        val readyA = File(dir, "readyA"); val readyB = File(dir, "readyB"); val go = File(dir, "go")
        val pa = spawn(*(aArgs + listOf("--ready", readyA.absolutePath, "--go", go.absolutePath)).toTypedArray())
        val pb = spawn(*(bArgs + listOf("--ready", readyB.absolutePath, "--go", go.absolutePath)).toTypedArray())
        // Monotonic deadline (CodeRabbit) — wall-clock can jump on an NTP correction and break the bound.
        val deadlineNs = System.nanoTime() + TimeUnit.SECONDS.toNanos(30)
        while ((!readyA.exists() || !readyB.exists()) && System.nanoTime() < deadlineNs) Thread.sleep(10)
        assertTrue("both children must reach the barrier", readyA.exists() && readyB.exists())
        go.writeText("go") // release both at once
        return collect(pa, "A:${aArgs.firstOrNull()}") to collect(pb, "B:${bArgs.firstOrNull()}")
    }

    private fun field(line: String, key: String): String? =
        Regex("\\b$key=([^\\s]+)").find(line)?.groupValues?.get(1)

    private fun read(): String = run("read").first()

    // ---- sanity: a spawned JVM can init the REAL store + write ----------------

    @Test
    fun `spawned JVM initializes the real store and signs in`() {
        val r = run("signin", "acc", "ref", "email", "exp").first()
        assertEquals("OK", field(r, "outcome"))
        assertEquals("1", field(r, "epoch"))
        assertEquals("acc", field(r, "acc"))
    }

    // ---- cross-process CAS / tombstone / migration — GENUINELY CONCURRENT via ready+go
    //      barriers (Codex's required scenarios); invariants hold regardless of lock ordering ----

    @Test
    fun `concurrent MAIN signIn vs stale-epoch rotate — rotate never wins, signIn family survives`() {
        // Fresh store (epoch 0). Both fire at once; whichever wins the lock, the epoch-0 rotate
        // must lose: either it hits the epoch-0 FAIL_CLOSED tombstone (reject) or a now-epoch-1
        // signIn (CAS mismatch). signIn always establishes accA.
        val (a, b) = race(listOf("signin", "accA", "refA", "em", "e"), listOf("rotate", "0", "accStale", "refStale", "e"))
        assertEquals("signIn must succeed", "OK", field(a.first(), "outcome"))
        assertEquals("stale-epoch rotate must be rejected regardless of ordering", "CONFLICT", field(b.first(), "outcome"))
        assertEquals("winning family is the signIn's", "accA", field(read(), "acc"))
    }

    @Test
    fun `concurrent MAIN signOut vs rotate — account ends signed out, never resurrected`() {
        run("signin", "accA", "refA", "em", "e") // live family, epoch 1
        // signOut (unconditional) always eventually tombstones; a concurrent rotate either lands
        // BEFORE it (then signOut kills it) or CONFLICTs — the account can never end alive/resurrected.
        val (a, _) = race(listOf("signout"), listOf("rotate", "1", "accZombie", "refZombie", "e"))
        assertEquals("OK", field(a.first(), "outcome"))
        assertEquals("account ends signed out", "true", field(read(), "tomb"))
    }

    @Test
    fun `sequential adopt-tombstone-epoch then rotate again is still rejected`() {
        // Codex's explicit "adopt-tombstone-epoch then rotate again": after Node adopts the
        // tombstone's epoch from a conflict, a rotate CARRYING that epoch must STILL be rejected.
        run("signin", "accA", "refA", "em", "e")
        val so = run("signout").first()
        val tombEpoch = field(so, "epoch")!!
        val rot = run("rotate", tombEpoch, "accZombie", "refZombie", "e").first()
        assertEquals("rotate carrying the tombstone's own epoch is still rejected", "CONFLICT", field(rot, "outcome"))
        assertEquals("true", field(read(), "tomb"))
    }

    @Test
    fun `concurrent stale markReauth vs fresh signIn — fresh family never poisoned`() {
        run("signin", "accA", "refA", "em", "e") // epoch 1
        // A stale mark (epoch 1) races a fresh signIn. Whatever the order, the FINAL fresh family
        // must be clean: either the mark CONFLICTs, or it lands on epoch 1 and the fresh signIn
        // (epoch 2) supersedes + clears it.
        val (a, _) = race(listOf("signin", "accB", "refB", "em", "e"), listOf("markreauth", "1"))
        assertEquals("OK", field(a.first(), "outcome"))
        val fin = read()
        assertEquals("fresh family present", "accB", field(fin, "acc"))
        assertEquals("fresh family NOT left reauth-required by a stale mark", "false", field(fin, "reauth"))
    }

    @Test
    fun `concurrent stale markReauthNotified vs fresh signIn — notify latch never poisoned`() {
        run("signin", "accA", "refA", "em", "e") // epoch 1, reauthNotifiedEpoch -1
        // A stale notify-latch (epoch 1) races a fresh signIn. The fresh family must end with the
        // latch reset (-1): the mark either CONFLICTs, or lands then the signIn resets it.
        val (a, _) = race(listOf("signin", "accB", "refB", "em", "e"), listOf("marknotified", "1"))
        assertEquals("OK", field(a.first(), "outcome"))
        val fin = read()
        assertEquals("accB", field(fin, "acc"))
        // The fresh signIn resets the notify latch to -1; a stale mark must never leave it set.
        assertEquals("fresh family's notify latch is reset, not poisoned by the stale mark", "-1", field(fin, "notified"))
    }

    @Test
    fun `concurrent migrateIfEmpty vs rotation on an empty store — migrate fills, rotate rejected`() {
        // Empty store (epoch-0 FAIL_CLOSED). migrate is fill-only; a concurrent epoch-0 rotate hits
        // either the tombstone (reject) or the just-filled epoch-1 record (CAS mismatch) — it never wins.
        val (a, b) = race(listOf("migrate", "accLegacy", "refLegacy", "em", "e"), listOf("rotate", "0", "accRot", "refRot", "e"))
        assertEquals("migrate fills the empty store", "OK", field(a.first(), "outcome"))
        assertEquals("concurrent rotate never wins on an empty store", "CONFLICT", field(b.first(), "outcome"))
        val fin = read()
        assertEquals("accLegacy", field(fin, "acc"))
        assertEquals("1", field(fin, "epoch"))
    }

    @Test
    fun `simultaneous cross-process signIns serialize under the OS lock (no lost write)`() {
        // signIn has no CAS, so both succeed — but the OS lock SERIALIZES them: the second reads
        // the first's epoch and advances to 2. A lost/torn write would leave epoch 1.
        val (a, b) = race(listOf("signin", "accA", "refA", "em", "e"), listOf("signin", "accB", "refB", "em", "e"))
        assertEquals("OK", field(a.first(), "outcome")); assertEquals("OK", field(b.first(), "outcome"))
        val fin = read()
        assertEquals("both writes serialized → final epoch 2 (no lost update)", "2", field(fin, "epoch"))
        val acc = field(fin, "acc")
        assertTrue("final value is exactly one writer's (not a blend): $acc", acc == "accA" || acc == "accB")
    }

    @Test
    fun `a process holding the OS lock forces the sibling to a bounded failure`() {
        // P1 holds the sidecar lock until we touch the release file (cap 20s), and signals
        // readiness via a FILE — so the parent polls with its OWN timeout (Codex re-review
        // major-2) rather than a blocking readLine() that could hang if P1 never prints.
        val release = File(dir, "release.marker")
        val locked = File(dir, "locked.marker")
        val p1 = spawn("holdlock", "20000", release.absolutePath, locked.absolutePath)
        // Drain P1's stdout on a background thread so it never blocks; poll the readiness file.
        Thread { runCatching { p1.inputStream.bufferedReader().forEachLine { } } }.apply { isDaemon = true; start() }
        val deadlineNs = System.nanoTime() + TimeUnit.SECONDS.toNanos(20) // monotonic (CodeRabbit)
        while (!locked.exists() && System.nanoTime() < deadlineNs) Thread.sleep(10)
        if (!locked.exists()) { p1.destroyForcibly(); fail("lock-holder P1 never acquired the sidecar lock (>20s) — force-killed") }
        // P2 (separate process) cannot acquire the lock → bounded FAILED, never a hang or clobber.
        val r2 = run("markreauth", "0").first()
        assertEquals("sibling mutation fails under a real cross-process lock", "FAILED", field(r2, "outcome"))
        release.writeText("go") // let P1 release + exit
        if (!p1.waitFor(30, TimeUnit.SECONDS)) { p1.destroyForcibly(); fail("lock-holder P1 hung (>30s)") }
    }
}
