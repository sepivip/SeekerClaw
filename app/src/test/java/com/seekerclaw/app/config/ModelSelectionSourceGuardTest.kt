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

    @Test
    fun `every model-store writer holds or opens the model selection lock`() {
        val offenders = mutableListOf<String>()
        var seen = 0
        for ((path, lines) in sources) {
            lines.forEachIndexed { i, line ->
                if (isComment(line) || !writer.containsMatchIn(line)) return@forEachIndexed
                if (line.contains("fun writeAgentSettingsJson(")) return@forEachIndexed // the declaration
                seen++
                val (sig, body) = enclosing(lines, i)
                // The signature may wrap; look at the parameter block too.
                val header = body.substringBefore("{")
                val guarded = header.contains("ModelSelectionLock.Tx") ||
                    body.contains("ModelSelectionLock.transaction") ||
                    // Helpers whose every caller is checked in the next test.
                    (path.endsWith("RuntimeStateStore.kt") && lockedHelpers.any { sig.contains("fun $it(") })
                if (!guarded) offenders += "$path:${i + 1}  in  $sig"
            }
        }
        assertTrue("guard found no writers — the pattern drifted", seen >= 10)
        assertEquals("writers outside the lock:\n" + offenders.joinToString("\n"), emptyList<String>(), offenders)
    }

    /** RuntimeStateStore helpers that write prefs and take no tx; their callers must hold it. */
    private val lockedHelpers = listOf("onObserved", "mirrorIfChanged")

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
        assertTrue("guard found no helper calls — the pattern drifted", calls >= 3)
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
