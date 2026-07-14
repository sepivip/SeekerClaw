package com.seekerclaw.app.state

import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
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

    /** Run a helper op to completion; return its RESULT lines. */
    private fun run(vararg args: String): List<String> {
        val p = spawn(*args)
        val out = p.inputStream.bufferedReader().readText()
        assertTrue("helper JVM must exit in time", p.waitFor(30, TimeUnit.SECONDS))
        val results = out.lineSequence().filter { it.startsWith("RESULT ") }.toList()
        assertTrue("helper must print a RESULT line (got:\n$out)", results.isNotEmpty())
        return results
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

    // ---- cross-process CAS / tombstone / migration (Codex's required scenarios) ----

    @Test
    fun `MAIN signIn wins vs a stale-epoch Node rotate`() {
        assertEquals("1", field(run("signin", "accA", "refA", "em", "e").first(), "epoch"))
        // A Node rotation still carrying the pre-sign-in epoch 0 must be CAS-rejected.
        val rot = run("rotate", "0", "accStale", "refStale", "e").first()
        assertEquals("CONFLICT", field(rot, "outcome"))
        assertEquals("1", field(rot, "currentEpoch"))
        val fin = read()
        assertEquals("winning family intact", "accA", field(fin, "acc"))
        assertEquals("1", field(fin, "epoch"))
    }

    @Test
    fun `MAIN signOut tombstone rejects an in-flight rotate cross-process`() {
        run("signin", "accA", "refA", "em", "e")
        val so = run("signout").first()
        assertEquals("2", field(so, "epoch"))
        // Even carrying the CORRECT current epoch, a rotate onto a tombstone must conflict
        // (blocker-3, cross-process) — the signed-out account cannot be resurrected.
        val rot = run("rotate", "2", "accZombie", "refZombie", "e").first()
        assertEquals("CONFLICT", field(rot, "outcome"))
        assertEquals("account stays signed out", "true", field(read(), "tomb"))
    }

    @Test
    fun `stale markReauth cannot poison a freshly signed-in family cross-process`() {
        run("signin", "accA", "refA", "em", "e")            // epoch 1
        run("signin", "accB", "refB", "em", "e")            // epoch 2 (fresh family)
        val mark = run("markreauth", "1").first()            // stale mark
        assertEquals("CONFLICT", field(mark, "outcome"))
        val fin = read()
        assertEquals("fresh family NOT marked reauth", "false", field(fin, "reauth"))
        assertEquals("accB", field(fin, "acc"))
    }

    @Test
    fun `migrateIfEmpty is fill-only vs an existing rotated record cross-process`() {
        run("signin", "accA", "refA", "em", "e")            // token present, epoch 1
        val mig = run("migrate", "accLegacy", "refLegacy", "em", "e").first()
        assertEquals("OK", field(mig, "outcome"))
        val fin = read()
        assertEquals("migration must NOT clobber the existing token", "accA", field(fin, "acc"))
        assertEquals("no-op does not advance epoch", "1", field(fin, "epoch"))
    }

    @Test
    fun `simultaneous cross-process signIns serialize under the OS lock (no lost write)`() {
        val go = File(dir, "go.marker")
        val p1 = spawn("signin", "accA", "refA", "em", "e", "--go", go.absolutePath)
        val p2 = spawn("signin", "accB", "refB", "em", "e", "--go", go.absolutePath)
        Thread.sleep(400) // let both reach the barrier
        go.writeText("go")
        // Drain + await both.
        p1.inputStream.bufferedReader().readText()
        p2.inputStream.bufferedReader().readText()
        assertTrue(p1.waitFor(30, TimeUnit.SECONDS)); assertTrue(p2.waitFor(30, TimeUnit.SECONDS))
        // signIn has no CAS, so both succeed — but the OS lock SERIALIZES them: the second reads
        // the first's epoch and advances to 2. A lost/torn write would leave epoch 1.
        val fin = read()
        assertEquals("both writes serialized → final epoch 2 (no lost update)", "2", field(fin, "epoch"))
        val acc = field(fin, "acc")
        assertTrue("final value is exactly one writer's (not a blend): $acc", acc == "accA" || acc == "accB")
    }

    @Test
    fun `a process holding the OS lock forces the sibling to a bounded failure`() {
        // P1 holds the sidecar lock until we touch the release file (cap 20s) — so it is
        // GUARANTEED still held while P2 attempts, regardless of P2's JVM-startup time.
        val release = File(dir, "release.marker")
        val p1 = spawn("holdlock", "20000", release.absolutePath)
        val reader = p1.inputStream.bufferedReader()
        var locked = false
        val deadline = System.currentTimeMillis() + 20_000
        while (System.currentTimeMillis() < deadline) {
            val line = reader.readLine() ?: break
            if (line.contains("outcome=LOCKED")) { locked = true; break }
        }
        assertTrue("P1 must acquire the sidecar OS lock", locked)
        // P2 (separate process) cannot acquire the lock → bounded FAILED, never a hang or clobber.
        val r2 = run("markreauth", "0").first()
        assertEquals("sibling mutation fails under a real cross-process lock", "FAILED", field(r2, "outcome"))
        release.writeText("go") // let P1 release + exit
        reader.readText(); p1.waitFor(30, TimeUnit.SECONDS)
    }
}
