package com.seekerclaw.app.config

import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test
import java.io.File

/**
 * BAT-1661 drift guards (contract v2.4 §0 and §4). Behaviour is pinned by [ModelRepairTest] and
 * [ModelSelectionLockTest]; these catch a NEW writer added outside the lock, which no behaviour
 * test can see.
 *
 *  1. Every Kotlin writer of a model store runs inside a function that holds the transaction
 *     (`tx: ModelSelectionLock.Tx` parameter) or opens one (`ModelSelectionLock.transaction`).
 *  2. `displayModel` is never written back: it appears in no persisting code.
 */
class ModelSelectionSourceGuardTest {

    private val mainRoot = listOf("src/main/java", "app/src/main/java")
        .map { File(it) }
        .first { it.isDirectory }

    private val sources: Map<String, List<String>> by lazy {
        mainRoot.walkTopDown()
            .filter { it.isFile && it.extension == "kt" }
            .associate { it.relativeTo(mainRoot).invariantSeparatorsPath to it.readLines() }
    }

    /** Store writes: prefs model keys, runtime_state, the overlay. */
    private val writer = Regex(
        """putString\(KEY_(MODEL|PROVIDER|AUTH_TYPE)\b|RuntimeStateStore\.(write|update)\(|""" +
            """\bstore\??\.(write|update)\(|AgentSettingsFile\.write\(|RuntimeStateFile\.writeModel\(|""" +
            """writeAgentSettingsJson\(""",
    )

    /** In RuntimeStateStore only: its CrossProcessStore under the local name `cps` (the first-launch seed). */
    private val runtimeCpsWriter = Regex("""\bcps\.(write|update)\(""")

    private fun isWriter(path: String, line: String) =
        writer.containsMatchIn(line) || (path.endsWith("state/RuntimeStateStore.kt") && runtimeCpsWriter.containsMatchIn(line))

    private fun isComment(line: String) = line.trimStart().let { it.startsWith("//") || it.startsWith("*") || it.startsWith("/*") }

    /**
     * The MEMBER function enclosing [index] (4-space indent: every file here is an `object`),
     * from its `fun` line to [index]. Local helper funs are skipped on purpose: what holds the
     * lock is the member that owns them.
     */
    private fun enclosing(lines: List<String>, index: Int): Pair<String, String> {
        var i = index
        while (i >= 0 && !Regex("""^ {4}(?:(?:private|internal|public|override|suspend|inline)\s+)*fun\s""").containsMatchIn(lines[i])) i--
        if (i < 0) return "<top>" to ""
        return lines[i].trim() to lines.subList(i, index + 1).joinToString("\n")
    }

    /** Writers outside the lock in [srcs], and how many writers were seen. */
    private fun writerOffenders(srcs: Map<String, List<String>>): Pair<Int, List<String>> {
        val offenders = mutableListOf<String>()
        var seen = 0
        for ((path, lines) in srcs) {
            lines.forEachIndexed { i, line ->
                if (isComment(line) || !isWriter(path, line)) return@forEachIndexed
                if (line.contains("fun writeAgentSettingsJson(")) return@forEachIndexed // the declaration
                seen++
                val (sig, body) = enclosing(lines, i)
                // The signature may wrap; look at the parameter block too.
                val header = body.substringBefore("{")
                val guarded = header.contains("ModelSelectionLock.Tx") ||
                    body.contains("ModelSelectionLock.transaction") ||
                    // Helpers whose every caller is checked in the next test.
                    (path.endsWith("RuntimeStateStore.kt") && lockedHelpers.any { sig.contains("fun $it(") }) ||
                    // The seed's write, handed to seedIfMissing, which runs it inside its transaction.
                    (path.endsWith("RuntimeStateStore.kt") && line.contains("seedIfMissing("))
                if (!guarded) offenders += "$path:${i + 1}  in  $sig"
            }
        }
        return seen to offenders
    }

    @Test
    fun `every model-store writer holds or opens the model selection lock`() {
        val (seen, offenders) = writerOffenders(sources)
        assertTrue("guard found no writers — the pattern drifted", seen >= 10)
        assertEquals("writers outside the lock:\n" + offenders.joinToString("\n"), emptyList<String>(), offenders)
    }

    @Test
    fun `writer guard rejects the pre-fix first-launch seed outside the lock`() {
        // 09e0614c: `if (!file.exists() && !cps.write(seeded))` straight in init's coroutine.
        val path = "com/seekerclaw/app/state/RuntimeStateStore.kt"
        val lines = sources.getValue(path)
        val at = lines.indexOfFirst { it.contains("seedIfMissing(app.filesDir, sp)") }
        assertTrue("the seed call is in the source", at >= 0)
        val mutated = lines.toMutableList().apply { this[at] = "            if (!File(app.filesDir, FILE_NAME).exists() && !cps.write(seeded)) {" }
        val (_, offenders) = writerOffenders(sources + (path to mutated))
        assertTrue("the unlocked seed is reported: $offenders", offenders.any { it.startsWith("$path:${at + 1}") })
    }

    /** RuntimeStateStore helpers that write prefs and take no tx; their callers must hold it. */
    private val lockedHelpers = listOf("onObserved", "mirrorIfChanged")

    /**
     * A member function that puts a model key and then calls `apply()`: the disk write is queued
     * and can land after the lock is released (Codex diff review #4). Model-key writes commit().
     */
    private fun applyOffenders(srcs: Map<String, List<String>>): List<String> {
        val out = mutableListOf<String>()
        val memberFun = Regex("""^ {4}(?:(?:private|internal|public|override|suspend|inline)\s+)*fun\s""")
        for ((path, lines) in srcs) {
            var sig = "<top>"
            var putsModelKey = false
            lines.forEachIndexed { i, line ->
                if (memberFun.containsMatchIn(line)) {
                    sig = line.trim()
                    putsModelKey = false
                }
                if (isComment(line)) return@forEachIndexed
                if (Regex("""putString\(KEY_(MODEL|PROVIDER|AUTH_TYPE)\b""").containsMatchIn(line)) putsModelKey = true
                if (putsModelKey && line.contains(".apply()")) out += "$path:${i + 1}  in  $sig"
            }
        }
        return out
    }

    @Test
    fun `model-key prefs writes are committed, never apply()`() {
        assertEquals(emptyList<String>(), applyOffenders(sources))
        // Negative control: the pre-fix auth normalizer (09e0614c).
        val path = "com/seekerclaw/app/config/ConfigManager.kt"
        val lines = sources.getValue(path)
        val at = lines.indexOfFirst { it.contains("putString(KEY_AUTH_TYPE, normalized).commit()") }
        assertTrue("the normalizer is in the source", at >= 0)
        val mutated = lines.toMutableList().apply { this[at] = "            p.edit().putString(KEY_AUTH_TYPE, normalized).apply()" }
        assertTrue(applyOffenders(mapOf(path to mutated)).isNotEmpty())
    }

    @Test
    fun `the prefs-mirror helpers are called only with the lock held`() {
        val lines = sources.getValue("com/seekerclaw/app/state/RuntimeStateStore.kt")
        var calls = 0
        for (helper in lockedHelpers) {
            lines.forEachIndexed { i, l ->
                if (isComment(l) || !l.contains("$helper(") || l.contains("fun $helper(")) return@forEachIndexed
                calls++
                val (sig, body) = enclosing(lines, i)
                val window = lines.subList(maxOf(0, i - 3), i + 1).joinToString("\n")
                val ok = window.contains("ModelSelectionLock.transaction") ||
                    body.substringBefore("{").contains("ModelSelectionLock.Tx") ||
                    lockedHelpers.any { sig.contains("fun $it(") }
                assertTrue("$helper call at line ${i + 1} (in $sig) does not hold the lock", ok)
            }
        }
        // onObserved → mirrorIfChanged, and observeFromCollector → onObserved (syncPrefsFromFile
        // writes the model itself since the Codex diff review #3).
        assertTrue("guard found no helper calls — the pattern drifted", calls >= 2)
    }

    @Test
    fun `displayModel is display-only - never persisted`() {
        val persisting = listOf("config/ConfigManager.kt", "config/ModelRepair.kt", "state/RuntimeStateStore.kt")
            .map { "com/seekerclaw/app/$it" }
        for (p in persisting) {
            val uses = sources.getValue(p).withIndex()
                .filter { (_, l) -> !isComment(l) && l.contains("displayModel") && !l.contains("val displayModel") }
            assertEquals("$p reads displayModel: ${uses.map { it.index + 1 }}", 0, uses.size)
        }
        // And the screens that show the model use it.
        listOf("ui/settings/SettingsScreen.kt", "ui/dashboard/DashboardScreen.kt", "ui/system/SystemScreen.kt", "ui/settings/ProviderConfigScreen.kt")
            .forEach { assertTrue(it, sources.getValue("com/seekerclaw/app/$it").any { l -> l.contains("displayModel") }) }
    }
}
