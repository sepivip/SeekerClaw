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
        """putString\(KEY_(MODEL|PROVIDER|AUTH_TYPE)\b|RuntimeStateStore\.(write|update|updateExisting)\(|""" +
            """\bstore\??\.(write|update|updateExisting)\(|AgentSettingsFile\.write\(|RuntimeStateFile\.writeModel\(|""" +
            // BAT-1661 v2.8 §2: the checked tuple write (the repair's handoff, MAIN's seed).
            """RuntimeStateFile\.writeTupleVerified\(|""" +
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

    // ------------------------------- CodeRabbit on 444ba220: the Settings save boundary (v2.4 §0)

    /**
     * The model picker's Save in ProviderConfigScreen: every `saveField("model", …)` in the picker
     * dialog saves the value [pickerSaveValue] returned, and no Settings code passes a value
     * derived from `displayModel` into a save.
     */
    private fun displayWritebackOffenders(srcs: Map<String, List<String>>): List<String> {
        val out = mutableListOf<String>()
        val save = Regex("""saveField\(|saveConfig\(|updateConfigField\(|copy\(model\s*=""")
        for ((path, lines) in srcs) {
            if (!path.startsWith("com/seekerclaw/app/ui/")) continue
            lines.forEachIndexed { i, l ->
                if (!isComment(l) && l.contains("displayModel") && save.containsMatchIn(l)) out += "$path:${i + 1}"
            }
        }
        val pcs = "com/seekerclaw/app/ui/settings/ProviderConfigScreen.kt"
        val lines = srcs.getValue(pcs)
        val picker = lines.indexOfFirst { it.contains("\"Select Model\"") }
        val pickerEnd = lines.indexOfFirst { it.contains("// Auth type picker") }
        if (picker < 0 || pickerEnd < picker) {
            out += "$pcs: model picker not found"
        } else {
            for (i in picker until pickerEnd) {
                val l = lines[i]
                if (isComment(l) || !l.contains("saveField(\"model\"")) continue
                val window = lines.subList(maxOf(picker, i - 10), i).joinToString("\n")
                if (!l.contains("toSave") || !window.contains("pickerSaveValue(")) out += "$pcs:${i + 1} picker Save bypasses pickerSaveValue"
            }
        }
        return out
    }

    @Test
    fun `the model picker's Save never writes displayModel back`() {
        assertEquals(emptyList<String>(), displayWritebackOffenders(sources))
        val pcs = "com/seekerclaw/app/ui/settings/ProviderConfigScreen.kt"
        val lines = sources.getValue(pcs)
        val at = lines.indexOfFirst { it.contains("saveField(\"model\", toSave") }
        assertTrue("the picker Save is in the source", at >= 0)
        // Negative control 1: the pre-fix Save of the preselected value (444ba220).
        val preFix = lines.toMutableList().apply { this[at] = "                                saveField(\"model\", trimmedModel, needsRestart = false)" }
        assertTrue(displayWritebackOffenders(sources + (pcs to preFix)).isNotEmpty())
        // Negative control 2: a writeback of displayModel at the Settings boundary.
        val writeback = lines.toMutableList().apply { this[at] = "                                saveField(\"model\", config?.displayModel.orEmpty())" }
        assertTrue(displayWritebackOffenders(sources + (pcs to writeback)).isNotEmpty())
    }

    /**
     * The picker's choice signals (v2.4 §0): each of the row tap, the row radio, the custom row
     * tap, the custom radio and the custom-ID edit sets `touched = true`. A missing one would let
     * that choice be dropped as an "untouched display substitute".
     */
    private fun touchedOffenders(lines: List<String>): List<String> {
        val out = mutableListOf<String>()
        val picker = lines.indexOfFirst { it.contains("\"Select Model\"") }
        val start = lines.subList(0, maxOf(picker, 0)).indexOfLast { it.contains("var touched by remember") }
        val end = lines.indexOfFirst { it.contains("confirmButton = {") }
        if (picker < 0 || start < 0 || end < picker) return listOf("picker not found")
        var choices = 0
        for (i in picker until end) {
            val l = lines[i]
            if (isComment(l)) continue
            if (Regex("""(\.clickable \{|onClick = \{) selectedModel = """).containsMatchIn(l)) {
                choices++
                if (!l.contains("touched = true")) out += "line ${i + 1}: a choice without touched = true"
            }
            if (l.contains("onValueChange = {")) {
                choices++
                val block = lines.subList(i, minOf(end, i + 4)).joinToString("\n")
                if (!block.contains("touched = true")) out += "line ${i + 1}: custom-ID edit without touched = true"
            }
        }
        if (choices != 5) out += "expected 5 choice sites, saw $choices"
        return out
    }

    @Test
    fun `every model picker choice sets touched`() {
        val pcs = "com/seekerclaw/app/ui/settings/ProviderConfigScreen.kt"
        val lines = sources.getValue(pcs)
        assertEquals(emptyList<String>(), touchedOffenders(lines))
        // Negative controls: drop the flag from the row tap, then from the custom-ID edit.
        val tap = lines.indexOfFirst { it.contains(".clickable { selectedModel = model.id; touched = true }") }
        assertTrue(tap >= 0)
        val noTap = lines.toMutableList().apply { this[tap] = this[tap].replace("; touched = true", "") }
        assertTrue(touchedOffenders(noTap).isNotEmpty())
        val edit = lines.indexOfFirst { it.trim() == "touched = true" }
        assertTrue(edit >= 0)
        val noEdit = lines.toMutableList().apply { removeAt(edit) }
        assertTrue(touchedOffenders(noEdit).isNotEmpty())
    }

    /** XaiOAuth.kt: the sign-in/out callbacks (Settings' restart prompt) fire only through the outcome. */
    private fun xaiPromptOffenders(ui: List<String>): List<String> {
        val out = mutableListOf<String>()
        var calls = 0
        ui.forEachIndexed { i, l ->
            if (isComment(l) || !Regex("""\bonSigned(In|Out)\(\)""").containsMatchIn(l)) return@forEachIndexed
            calls++
            if (!l.contains("if (outcome.notify) onSigned")) out += "XaiOAuth.kt:${i + 1} fires the restart prompt without the outcome"
        }
        if (calls != 2) out += "expected 2 callback calls, saw $calls"
        return out
    }

    @Test
    fun `xAI restart prompt fires only when the agent's settings were synced`() {
        val path = "com/seekerclaw/app/ui/components/XaiOAuth.kt"
        val ui = sources.getValue(path)
        assertEquals(emptyList<String>(), xaiPromptOffenders(ui))
        // Negative control: the ca06bb79 sign-in path (prompt first, warning after).
        val at = ui.indexOfFirst { it.contains("if (outcome.notify) onSignedIn()") }
        assertTrue(at >= 0)
        val mutated = ui.toMutableList().apply { this[at] = "                        onSignedIn()" }
        assertTrue(xaiPromptOffenders(mutated).isNotEmpty())
    }

    // ------------------------ CodeRabbit on 444ba220 (T4): restart only after the xAI auth sync

    private fun xaiRestartOffenders(activity: List<String>, ui: List<String>): List<String> {
        val out = mutableListOf<String>()
        if (activity.none { it.contains("= ConfigManager.syncXaiRuntimeAuthType(") }) out += "sign-in ignores the sync result"
        if (activity.none { it.contains("val synced = sync == ConfigManager.XaiAuthSync.SYNCED") }) out += "sign-in gate is not on SYNCED"
        activity.forEachIndexed { i, l ->
            if (isComment(l) || !l.contains("SeekerClawService.restart(")) return@forEachIndexed
            val window = activity.subList(maxOf(0, i - 4), i).joinToString("\n")
            if (!window.contains("if (synced)")) out += "XaiOAuthActivity:${i + 1} restarts without a successful sync"
        }
        if (ui.none { it.contains("sync = ConfigManager.syncXaiRuntimeAuthType(") }) out += "sign-out ignores the sync result"
        return out
    }

    @Test
    fun `xAI sign-in restarts the agent only after the runtime auth sync succeeded`() {
        val activityPath = "com/seekerclaw/app/oauth/XaiOAuthActivity.kt"
        val uiPath = "com/seekerclaw/app/ui/components/XaiOAuth.kt"
        val activity = sources.getValue(activityPath)
        val ui = sources.getValue(uiPath)
        assertEquals(emptyList<String>(), xaiRestartOffenders(activity, ui))
        // Negative control: the pre-fix unconditional restart.
        val at = activity.indexOfFirst { it.contains("if (synced) {") }
        assertTrue("the gate is in the source", at >= 0)
        val mutated = activity.toMutableList().apply { this[at] = "                                if (true) {" }
        assertTrue(xaiRestartOffenders(mutated, ui).isNotEmpty())
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
