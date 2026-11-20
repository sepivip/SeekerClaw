package com.seekerclaw.app.config

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
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
        """putString\(KEY_(MODEL|PROVIDER|AUTH_TYPE)\b|""" +
            // BAT-1661 v2.12 (Q16): the checked runtime_state writes (writeVerified and the fold-2 patch).
            """RuntimeStateStore\.(write|writeVerified|writeSelectionVerified|rewriteVerified|update|updateExisting)\(|""" +
            """\bstore\??\.(write|writeVerified|update|updateExisting)\(|AgentSettingsFile\.write\(|RuntimeStateFile\.writeModel\(|""" +
            // v2.12: the reconcile retry record (written / deleted only inside the lock).
            """ReconcileRecord\.(write|clear|clearLogged|clearSuperseded|resolve)\(|""" +
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
            // CodeRabbit 4628273848: a model-key put split across lines (`putString(` then `KEY_MODEL`
            // on the next line), which the line-based pattern above cannot see. Comments stripped.
            val code = lines.map { if (isComment(it)) "" else it.substringBefore("//") }
            val text = code.joinToString("\n")
            val starts = IntArray(code.size).also { var o = 0; code.forEachIndexed { k, l -> it[k] = o; o += l.length + 1 } }
            Regex("""putString\(\s*\n\s*KEY_(MODEL|PROVIDER|AUTH_TYPE)\b""").findAll(text).forEach { m ->
                val i = starts.indexOfLast { it <= m.range.first }
                seen++
                val (sig, body) = enclosing(lines, i)
                val guarded = body.substringBefore("{").contains("ModelSelectionLock.Tx") || body.contains("ModelSelectionLock.transaction")
                if (!guarded) offenders += "$path:${i + 1}  in  $sig (multiline)"
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
    fun `writer guard reports an unlocked checked runtime_state write (v2_12)`() {
        // Negative control: an unlocked RuntimeStateStore.writeVerified call.
        val path = "com/seekerclaw/app/config/ConfigManager.kt"
        val lines = sources.getValue(path)
        val at = lines.indexOfFirst { it.contains("fun isSetupComplete(context: Context): Boolean =") }
        assertTrue(at >= 0)
        val mutated = lines.toMutableList().apply {
            add(at, "    fun leak(v: RuntimeState) { RuntimeStateStore.writeVerified(tx, v) }")
        }
        val (_, offenders) = writerOffenders(sources + (path to mutated))
        assertTrue("the unlocked writeVerified is reported: $offenders", offenders.any { it.startsWith("$path:${at + 1}") })
        // ...and the store form.
        val store = lines.toMutableList().apply { add(at, "    fun leak2(v: RuntimeState) { store?.writeVerified(v) }") }
        assertTrue(writerOffenders(sources + (path to store)).second.any { it.startsWith("$path:${at + 1}") })
        // CodeRabbit 4628273848: an unlocked model-key put split across lines is reported; the same
        // text inside a comment is not.
        val multi = lines.toMutableList().apply {
            add(at, "    fun leak3(p: SharedPreferences) { p.edit().putString(")
            add(at + 1, "        KEY_MODEL, \"x\").commit() }")
        }
        assertTrue(writerOffenders(sources + (path to multi)).second.any { it.startsWith("$path:${at + 1}") })
        val commented = lines.toMutableList().apply {
            add(at, "    // fun leak3(p: SharedPreferences) { p.edit().putString(")
            add(at + 1, "    //     KEY_MODEL, \"x\").commit() }")
        }
        assertEquals("the needle in a comment is not a writer", emptyList<String>(), writerOffenders(sources + (path to commented)).second)
    }

    // ------------------------------------------- v2.12 (Q16): who touches the reconcile retry record

    /**
     * `model_reconcile_record.json` is written or deleted only by [ReconcileRecord]'s own `write` /
     * `clear`: its path and file name appear nowhere else (LinkHygiene lists the name), and inside
     * ReconcileRecord.kt the SafeFs writes and deletes sit only in those two members.
     */
    private fun recordWriterOffenders(srcs: Map<String, List<String>>): List<String> {
        val out = mutableListOf<String>()
        val rr = "com/seekerclaw/app/config/ReconcileRecord.kt"
        for ((path, lines) in srcs) {
            lines.forEachIndexed { i, l ->
                if (isComment(l)) return@forEachIndexed
                if (path != rr && l.contains("ReconcileRecord.path(")) out += "$path:${i + 1} uses the record path"
                if (path != rr && !path.endsWith("util/LinkHygiene.kt") && l.contains("model_reconcile_record")) out += "$path:${i + 1} names the record file"
                if (path == rr && Regex("""SafeFs\.(writeAtomic\w*|deleteChecked|rewriteVerified|moveNoFollow)\(""").containsMatchIn(l)) {
                    val (sig, _) = enclosing(lines, i)
                    if (!sig.contains("fun write(") && !sig.contains("fun clear(")) out += "$path:${i + 1} writes the record in $sig"
                }
            }
        }
        return out
    }

    @Test
    fun `the reconcile retry record is written or deleted only by ReconcileRecord`() {
        assertEquals(emptyList<String>(), recordWriterOffenders(sources))
        // Negative control 1: a direct delete elsewhere.
        val cm = "com/seekerclaw/app/config/ConfigManager.kt"
        val lines = sources.getValue(cm)
        val at = lines.indexOfFirst { it.contains("fun isSetupComplete(context: Context): Boolean =") }
        val mutated = lines.toMutableList().apply { add(at, "    fun leak(d: java.nio.file.Path) = SafeFs.deleteChecked(d, ReconcileRecord.path(d))") }
        assertTrue(recordWriterOffenders(sources + (cm to mutated)).isNotEmpty())
        // Negative control 2: a write inside ReconcileRecord outside write/clear.
        val rr = "com/seekerclaw/app/config/ReconcileRecord.kt"
        val rl = sources.getValue(rr)
        val r = rl.indexOfFirst { it.contains("fun resolve(") }
        val m2 = rl.toMutableList().apply { add(r + 2, "        SafeFs.writeAtomicVerified(filesDir, path(filesDir), ByteArray(0))") }
        assertTrue(recordWriterOffenders(sources + (rr to m2)).isNotEmpty())
    }

    /** H4: `ModelRepair.boot` and `serviceStart` only READ the record (never resolve, write or delete it). */
    private fun bootRecordOffenders(lines: List<String>): List<String> {
        val out = mutableListOf<String>()
        for (name in listOf("boot", "serviceStart")) {
            val at = lines.indexOfFirst { !isComment(it) && Regex("""fun (<[^>]*> )?$name\(""").containsMatchIn(it) }
            if (at < 0) { out += "$name not found"; continue }
            val end = (at + 1 until lines.size).first { lines[it].startsWith("    }") }
            for (i in at..end) {
                val l = lines[i]
                if (isComment(l)) continue
                Regex("""ReconcileRecord\.(\w+)""").findAll(l).forEach { m ->
                    if (m.groupValues[1] !in setOf("read", "Read", "BOOT_HELD")) out += "ModelRepair.kt:${i + 1} $name uses ReconcileRecord.${m.groupValues[1]}"
                }
            }
        }
        // CodeRabbit 4628273824: the read must be in the uncommented boot body, not just anywhere.
        val boot = lines.indexOfFirst { !isComment(it) && Regex("""fun (<[^>]*> )?boot\(""").containsMatchIn(it) }
        val bootEnd = if (boot < 0) -1 else (boot + 1 until lines.size).first { lines[it].startsWith("    }") }
        val bootCode = if (boot < 0) emptyList() else lines.subList(boot, bootEnd + 1).filterNot { isComment(it) }.map { it.substringBefore("//") }
        if (bootCode.none { it.contains("when (ReconcileRecord.read(filesDir))") }) out += "boot does not read the record"
        return out
    }

    @Test
    fun `ModelRepair boot and serviceStart only read the reconcile retry record`() {
        val path = "com/seekerclaw/app/config/ModelRepair.kt"
        val lines = sources.getValue(path)
        assertEquals(emptyList<String>(), bootRecordOffenders(lines))
        val at = lines.indexOfFirst { it.contains("when (ReconcileRecord.read(filesDir))") }
        val mutated = lines.toMutableList().apply { add(at, "        ReconcileRecord.clear(tx, filesDir)") }
        assertTrue("negative control: a delete in the boot is reported", bootRecordOffenders(mutated).isNotEmpty())
        val noRead = lines.toMutableList().apply { this[at] = this[at].replace("ReconcileRecord.read(filesDir)", "ReconcileRecord.Read.Absent") }
        assertTrue("negative control: H4 removed is reported", bootRecordOffenders(noRead).isNotEmpty())
        // CodeRabbit 4628273824: H4 removed, but the needle kept in a comment, is still reported.
        val commented = noRead.toMutableList().apply { add(at, "        // when (ReconcileRecord.read(filesDir)) {") }
        assertTrue("negative control: the read only in a comment", bootRecordOffenders(commented).isNotEmpty())
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
        // v2.12 (Q16, D12.2): a model key put OR removed, or a whole-prefs clear(), then apply(); and
        // the KTX `edit { }` (which applies) in a member that touches a model key or clears.
        // CodeRabbit 4628273848: matched over the WHOLE member text (comments stripped), so a call
        // split across lines (`putString(` / `KEY_MODEL, …` / `).apply()`) is seen too.
        // CodeRabbit 4628273833: a bare `clear()` inside a KTX `edit { … }` block counts.
        val modelTouch = Regex("""(putString|remove)\(\s*KEY_(MODEL|PROVIDER|AUTH_TYPE)\b|edit\(\)\??\.[^;]*?\bclear\(\)""")
        val ktxEdit = Regex("""\.edit\s*(\(\s*commit\s*=\s*false\s*\))?\s*\{""")
        val ktxClear = Regex("""\.edit\s*(\(\s*commit\s*=\s*false\s*\))?\s*\{[^}]*\bclear\(\)""")
        val apply = Regex("""\.\s*apply\(\)""")
        for ((path, lines) in srcs) {
            var start = -1
            fun scan(end: Int) {
                if (start < 0) return
                // Member text, comments stripped, with each char's line kept for the report.
                val sb = StringBuilder()
                val lineOf = mutableListOf<Int>()
                for (i in start until end) {
                    val l = lines[i]
                    if (isComment(l)) continue
                    val code = l.substringBefore("//") + "\n"
                    sb.append(code)
                    repeat(code.length) { lineOf += i }
                }
                val text = sb.toString()
                val sig = lines[start].trim()
                val touch = modelTouch.find(text)
                if (touch != null) {
                    apply.findAll(text, touch.range.first).forEach { out += "$path:${lineOf[it.range.first] + 1}  in  $sig" }
                }
                val ktx = ktxEdit.find(text)
                if (ktx != null && (touch != null || ktxClear.containsMatchIn(text))) out += "$path:${lineOf[ktx.range.first] + 1}  in  $sig (KTX edit { })"
            }
            lines.forEachIndexed { i, line ->
                if (memberFun.containsMatchIn(line)) {
                    scan(i)
                    start = i
                }
            }
            scan(lines.size)
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
        // v2.12 negative controls: a model-key remove, a clear(), and a KTX edit { } — each with apply.
        val remove = lines.toMutableList().apply { this[at] = "            p.edit().remove(KEY_MODEL).apply()" }
        assertTrue("remove(KEY_…) then apply()", applyOffenders(mapOf(path to remove)).isNotEmpty())
        val clear = lines.toMutableList().apply { this[at] = "            p.edit().clear().apply()" }
        assertTrue("clear() then apply()", applyOffenders(mapOf(path to clear)).isNotEmpty())
        val ktx = lines.toMutableList().apply {
            this[at] = "            p.edit { putString(KEY_AUTH_TYPE, normalized) }"
        }
        assertTrue("KTX edit { } of a model key", applyOffenders(mapOf(path to ktx)).isNotEmpty())
        // CodeRabbit 4628273833: a whole-prefs clear inside a KTX edit.
        val ktxClear = lines.toMutableList().apply { this[at] = "            p.edit { clear() }" }
        assertTrue("KTX edit { clear() }", applyOffenders(mapOf(path to ktxClear)).isNotEmpty())
        // CodeRabbit 4628273848: a model-key write split across lines, then apply().
        val multi = lines.toMutableList().apply {
            this[at] = "            p.edit().putString("
            add(at + 1, "                KEY_MODEL, normalized,")
            add(at + 2, "            ).apply()")
        }
        assertTrue("multiline putString(\\n KEY_MODEL …).apply()", applyOffenders(mapOf(path to multi)).isNotEmpty())
        // ...and the needle only in a comment is NOT reported (comments are stripped).
        val inComment = lines.toMutableList().apply { this[at] = "            // p.edit().putString(KEY_MODEL, x).apply()" }
        assertEquals(emptyList<String>(), applyOffenders(mapOf(path to inComment)))
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

    /**
     * XaiOAuth.kt (CodeRabbit on ab6385bd): the sign-in/out callbacks (Settings' restart prompt) are
     * never invoked directly — only handed to `applyXaiOutcome`, whose behaviour
     * `XaiOAuthOutcomeTest` pins. Structural, so `if (x) onSignedIn() else onSignedIn()` or any
     * other direct call fails, whatever its condition.
     */
    private fun xaiPromptOffenders(ui: List<String>): List<String> {
        val out = mutableListOf<String>()
        ui.forEachIndexed { i, l ->
            if (!isComment(l) && Regex("""\bonSigned(In|Out)\s*\(""").containsMatchIn(l)) {
                out += "XaiOAuth.kt:${i + 1} invokes the restart-prompt callback directly"
            }
        }
        // CodeRabbit on aefe5f82: each dispatch is fed by its REAL outcome input — the result file's
        // restartNeeded for the sign-in, the sync result for the sign-out — never a constant.
        val signIn = ui.count { !isComment(it) && Regex("""applyXaiOutcome\(xaiSignInOutcome\(json\.optString\("restartNeeded"\)\),\s*onSignedIn\)""").containsMatchIn(it) }
        val signOut = ui.count { !isComment(it) && Regex("""applyXaiOutcome\(xaiSignOutOutcome\(sync\),\s*onSignedOut\)""").containsMatchIn(it) }
        if (signIn != 1) out += "the sign-in dispatch must use the result file's restartNeeded (saw $signIn)"
        if (signOut != 1) out += "the sign-out dispatch must use the sync result (saw $signOut)"
        return out
    }

    @Test
    fun `xAI restart prompt fires only through applyXaiOutcome`() {
        val path = "com/seekerclaw/app/ui/components/XaiOAuth.kt"
        val ui = sources.getValue(path)
        assertEquals(emptyList<String>(), xaiPromptOffenders(ui))
        val at = ui.indexOfFirst { it.contains("applyXaiOutcome(xaiSignInOutcome(") }
        assertTrue(at >= 0)
        // Negative control 1: the else-bypass.
        val bypass = ui.toMutableList().apply {
            this[at] = "                        val o = xaiSignInOutcome(json.optString(\"restartNeeded\")); if (o.notify) onSignedIn() else onSignedIn()"
        }
        assertTrue(xaiPromptOffenders(bypass).isNotEmpty())
        // Negative control 2: the ca06bb79 unconditional call.
        val direct = ui.toMutableList().apply { this[at] = "                        onSignedIn()" }
        assertTrue(xaiPromptOffenders(direct).isNotEmpty())
        // Negative control 3 (CodeRabbit on aefe5f82): a constant outcome — a busy sync would prompt.
        val constant = ui.toMutableList().apply {
            this[at] = "                        error = applyXaiOutcome(xaiSignInOutcome(\"\"), onSignedIn)"
        }
        assertTrue(xaiPromptOffenders(constant).isNotEmpty())
    }

    // --------------------------- RuntimeStateStore display projection (review of the Codex folds)

    private fun rssBody(name: String): String {
        val lines = sources.getValue("com/seekerclaw/app/state/RuntimeStateStore.kt")
        val at = lines.indexOfFirst { Regex("""fun $name\(""").containsMatchIn(it) && !isComment(it) }
        assertTrue("$name is in the source", at >= 0)
        val end = (at + 1 until lines.size).first { lines[it].startsWith("    }") }
        return lines.subList(at, end + 1).joinToString("\n")
    }

    @Test
    fun `display projection - publish and refresh assign under displayLock, refresh never overwrites a newer publish`() {
        val publish = rssBody("publish")
        val refresh = rssBody("refreshDisplay")
        // publish: stores only under the generation it projected with — the COMPLETE condition, so
        // an `|| attempt == …` bypass fails (CodeRabbit on aefe5f82 / 3240d3c9).
        assertEquals(emptyList<String>(), publishStoreOffenders(publish))
        val bypass = publish.replace("if (credentialGen.get() == gen) {", "if (credentialGen.get() == gen || attempt == MAX_PROJECTION_TRIES - 1) {")
        assertTrue("negative control: the final-attempt bypass", publishStoreOffenders(bypass).isNotEmpty())
        assertTrue(refresh, refresh.contains("synchronized(displayLock) { lastProjected }"))
        assertTrue(refresh, refresh.contains("if (lastProjected === s && credentialGen.get() == gen) _state.value = shown"))
        assertFalse("no projection under the lock", Regex("""synchronized\(displayLock\) \{[^}]*forDisplay""").containsMatchIn(publish + refresh))
    }

    private fun publishStoreOffenders(publish: String): List<String> {
        val out = mutableListOf<String>()
        val store = Regex("""synchronized\(displayLock\) \{\s*if \(([^)]*\)[^{]*)\{\s*lastProjected = s\s*_state\.value = shown""").find(publish)
        if (store == null) return listOf("no guarded store")
        val condition = store.groupValues[1].trim()
        if (condition != "credentialGen.get() == gen)") out += "store condition is `$condition`, not exactly the generation check"
        return out
    }

    @Test
    fun `display projection - init publishes without credential I-O, the first credential projection runs on IO`() {
        val init = rssBody("init")
        assertTrue(init, init.contains("seedFromPrefs(sp, gateXai = false)"))
        assertTrue(init, init.contains("publish(seeded, withCredentials = false)"))
        val launch = init.substringAfter("scope.launch {")
        assertTrue("refreshDisplay runs in the IO coroutine", launch.contains("refreshDisplay()"))
    }

    /**
     * saveConfigWith's `RuntimeStateStore.refreshDisplay()` calls outside the lock: after the
     * `ModelSelectionLock.transaction(...) { ... }` lambda's MATCHING closing brace, and none inside
     * it (CodeRabbit on aefe5f82: a call placed inside the lambda still "follows" `transaction(`).
     */
    private fun refreshUnderLockOffenders(cm: List<String>): List<String> {
        val out = mutableListOf<String>()
        val locked = cm.indexOfFirst { it.contains("private fun saveConfigLocked(") }
        val lockedEnd = (locked + 1 until cm.size).first { cm[it].startsWith("    }") }
        // Direct, or indirect through the key flag (noteOpenAIKeyUsable / rederiveOpenAIKeyUsable call
        // refreshDisplay): none may run under the lock (CodeRabbit on 3240d3c9).
        val refreshing = Regex("""refreshDisplay\(|noteOpenAIKeyUsable\(|rederiveOpenAIKeyUsable\(""")
        if (cm.subList(locked, lockedEnd).any { refreshing.containsMatchIn(it) && !isComment(it) }) {
            out += "inside saveConfigLocked"
        }
        val with = cm.indexOfFirst { it.contains("internal fun saveConfigWith(") }
        val withEnd = (with + 1 until cm.size).first { cm[it].startsWith("    }") }
        val body = cm.subList(with, withEnd).filterNot { isComment(it) }.joinToString("\n")
        val tx = body.indexOf("ModelSelectionLock.transaction(")
        val open = body.indexOf('{', tx)
        if (tx < 0 || open < 0) return out + "no transaction lambda"
        var depth = 0
        var close = -1
        for (i in open until body.length) {
            if (body[i] == '{') depth++
            if (body[i] == '}') { depth--; if (depth == 0) { close = i; break } }
        }
        val lambda = body.substring(open, close + 1)
        if (refreshing.containsMatchIn(lambda)) out += "a display refresh (direct or indirect) inside the transaction lambda"
        if (!body.substring(close + 1).contains("RuntimeStateStore.refreshDisplay()")) out += "no refreshDisplay after the lambda"
        return out
    }

    @Test
    fun `saveConfig re-projects the display only after the model lock is released`() {
        val path = "com/seekerclaw/app/config/ConfigManager.kt"
        val cm = sources.getValue(path)
        assertEquals(emptyList<String>(), refreshUnderLockOffenders(cm))
        // Negative control: the refresh moved into the lambda, after saveConfigLocked.
        val at = cm.indexOfFirst { it.contains("ModelSelectionLock.transaction(lockTimeoutMs) { tx -> saveConfigLocked(") }
        assertTrue(at >= 0)
        val moved = cm.toMutableList().apply {
            this[at] = "        val r = ModelSelectionLock.transaction(lockTimeoutMs) { tx -> saveConfigLocked(context, config, tx, sealer).also { RuntimeStateStore.refreshDisplay() } }"
        }
        assertTrue(refreshUnderLockOffenders(moved).isNotEmpty())
        // Negative control 2: the INDIRECT refresh (the key note) moved into the lambda.
        val indirect = cm.toMutableList().apply {
            this[at] = "        val r = ModelSelectionLock.transaction(lockTimeoutMs) { tx -> saveConfigLocked(context, config, tx, sealer).also { RuntimeStateStore.noteOpenAIKeyUsable(true) } }"
        }
        assertTrue(refreshUnderLockOffenders(indirect).isNotEmpty())
    }

    /**
     * CodeRabbit on 3240d3c9: saveConfig's store decision and emitConfigJson's emit decision for the
     * OpenAI secrets use the ONE predicate (`keepsSecret`) the display builds on (`nodeUsesSecret`).
     * (emitConfigJson builds org.json, a stub on the JVM, so this is a source pin; the behaviour of
     * the save → display path is pinned in ModelSelectionSaveTest.)
     */
    private fun secretRuleOffenders(cm: List<String>): List<String> {
        val out = mutableListOf<String>()
        val code = cm.filterNot { isComment(it) }
        if (code.none { it.contains("if (keepsSecret(config.openaiApiKey)) {") }) out += "saveConfig: the OpenAI key's store decision"
        if (code.none { it.contains("openAIConfigFields(config).forEach") }) out += "emitConfigJson: the OpenAI secrets via openAIConfigFields"
        if (code.none { it.contains("if (keepsSecret(config.openaiApiKey)) m[\"openaiApiKey\"]") }) out += "openAIConfigFields: openaiApiKey"
        if (code.none { it.contains("if (keepsSecret(config.openaiOAuthToken)) m[\"openaiOAuthToken\"]") }) out += "openAIConfigFields: openaiOAuthToken"
        if (code.any { Regex("""put\("openai(ApiKey|OAuthToken)"""").containsMatchIn(it) }) out += "a direct put of an OpenAI secret"
        if (code.any { Regex("""config\.openai(ApiKey|OAuthToken)\.isNotBlank\(\)\) (put|\{|m\[)""").containsMatchIn(it) }) out += "a separate isNotBlank rule"
        return out
    }

    @Test
    fun `save and emit decide the OpenAI secrets with the display's predicate`() {
        val path = "com/seekerclaw/app/config/ConfigManager.kt"
        val cm = sources.getValue(path)
        assertEquals(emptyList<String>(), secretRuleOffenders(cm))
        val at = cm.indexOfFirst { it.contains("if (keepsSecret(config.openaiApiKey)) m[\"openaiApiKey\"]") }
        val mutated = cm.toMutableList().apply { this[at] = this[at].replace("keepsSecret(config.openaiApiKey)", "config.openaiApiKey.isNotBlank()") }
        assertTrue(secretRuleOffenders(mutated).isNotEmpty())
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

    /** v2.12 review M2: `SeekerClawService.restart` starts the agent again only through the guarded start. */
    private fun restartStartOffenders(svc: List<String>): List<String> {
        val out = mutableListOf<String>()
        val code = svc.filterNot { isComment(it) }
        val restart = code.indexOfFirst { it.contains("fun restart(context: Context") }
        if (restart < 0) return listOf("restart not found")
        val body = code.subList(restart, code.size).takeWhile { !it.startsWith("        }") }.joinToString(" ")
        if (!body.contains("postDelayed({ startFromRestart(appCtx) }")) out += "restart's onStopped does not use the guarded start"
        if (Regex("""postDelayed\(\{ start\(""").containsMatchIn(body)) out += "restart posts an unguarded start()"
        val g = code.indexOfFirst { it.contains("private fun startFromRestart(appCtx: Context)") }
        if (g < 0) return out + "startFromRestart not found"
        val gBody = code.subList(g, minOf(code.size, g + 12)).joinToString(" ")
        if (!Regex("""try \{\s*start\(appCtx\)\s*\} catch \(e: Exception\)""").containsMatchIn(gBody)) out += "startFromRestart does not catch the start's failure"
        return out
    }

    @Test
    fun `v2_12 M2 - the restart's foreground-service start can never crash MAIN`() {
        val path = "com/seekerclaw/app/service/SeekerClawService.kt"
        val svc = sources.getValue(path)
        assertEquals(emptyList<String>(), restartStartOffenders(svc))
        val at = svc.indexOfFirst { it.contains("postDelayed({ startFromRestart(appCtx) }") }
        assertTrue(at >= 0)
        val unguarded = svc.toMutableList().apply { this[at] = this[at].replace("startFromRestart(appCtx)", "start(appCtx)") }
        assertTrue("negative control: the unguarded start is reported", restartStartOffenders(unguarded).isNotEmpty())
        val g = svc.indexOfFirst { it.contains("start(appCtx)") && !it.contains("startFromRestart") && !it.contains("fun ") }
        val noCatch = svc.toMutableList().apply { this[g] = "                start(appCtx); return" ; this[g + 1] = "            } finally {" }
        assertTrue("negative control: a guard without the catch is reported", restartStartOffenders(noCatch).isNotEmpty())
    }

    /**
     * Fold 5′ (Codex 90fed4d6): the reconcile retry's model-selection code never stops or starts the
     * agent — no reference to `SeekerClawService` in `config/` or `state/` (comments stripped). A
     * finished change only saves a restart notice; the user restarts.
     */
    private fun serviceCallOffenders(srcs: Map<String, List<String>>): List<String> {
        val out = mutableListOf<String>()
        for ((path, lines) in srcs) {
            if (!path.startsWith("com/seekerclaw/app/config/") && !path.startsWith("com/seekerclaw/app/state/")) continue
            lines.forEachIndexed { i, l ->
                if (!isComment(l) && Regex("""\bSeekerClawService\b""").containsMatchIn(l.substringBefore("//"))) out += "$path:${i + 1}"
            }
        }
        return out
    }

    @Test
    fun `v2_12 fold 5' - Recovered and Completed make zero service stop or start calls`() {
        assertEquals(emptyList<String>(), serviceCallOffenders(sources))
        val rr = "com/seekerclaw/app/config/ReconcileRecord.kt"
        val lines = sources.getValue(rr)
        val at = lines.indexOfFirst { it.contains("private fun noticeSaved(") }
        assertTrue(at >= 0)
        val restart = lines.toMutableList().apply { add(at, "    private fun kick(c: android.content.Context) = com.seekerclaw.app.service.SeekerClawService.restart(c)") }
        assertTrue("negative control: a restart call is reported", serviceCallOffenders(sources + (rr to restart)).isNotEmpty())
        val rss = "com/seekerclaw/app/state/RuntimeStateStore.kt"
        val stop = sources.getValue(rss).toMutableList().apply { add(1, "fun x(c: android.content.Context) = com.seekerclaw.app.service.SeekerClawService.stop(c)") }
        assertTrue("negative control: in state/ too", serviceCallOffenders(sources + (rss to stop)).isNotEmpty())
        val commented = lines.toMutableList().apply { add(at, "    // SeekerClawService.restart(c)") }
        assertEquals("a comment is not a call", emptyList<String>(), serviceCallOffenders(sources + (rr to commented)))
    }

    /** The body of [name] in [lines] (its `fun` line to the closing 4-space brace), comments stripped. */
    private fun memberBody(lines: List<String>, name: String): String? {
        val at = lines.indexOfFirst { !isComment(it) && Regex("""fun $name\(""").containsMatchIn(it) }
        if (at < 0) return null
        val end = (at + 1 until lines.size).firstOrNull { lines[it].isBlank() } ?: lines.size
        return lines.subList(at, end).filterNot { isComment(it) }.joinToString(" ") { it.substringBefore("//") }
    }

    /**
     * Codex 90fed4d6 review: ONE predicate decides whether a notice is current — `RestartNotice.isCurrent`
     * — used by `visible`, `invalidateIfOrphaned` and (through it) the MAIN load's self-heal. No copy of
     * the prefs/runtime comparison anywhere else in RestartNotice.
     */
    private fun predicateOffenders(rn: List<String>, cm: List<String>): List<String> {
        val out = mutableListOf<String>()
        if (memberBody(rn, "visible")?.contains("isCurrent(") != true) out += "visible does not call isCurrent"
        if (memberBody(rn, "invalidateIfOrphaned")?.contains("isCurrent(") != true) out += "invalidateIfOrphaned does not call isCurrent"
        val pred = memberBody(rn, "isCurrent") ?: return out + "isCurrent not found"
        if (!pred.contains("rawPrefsModelTuple(") || !pred.contains("ReconcileRecord.holdsTarget(")) out += "isCurrent is not the prefs-or-runtime rule"
        val copies = rn.withIndex().filter { (i, l) -> !isComment(l) && (l.contains("rawPrefsModelTuple(") || l.contains("holdsTarget(")) }
            .map { it.index }
        val predAt = rn.indexOfFirst { it.contains("internal fun isCurrent(") }
        val predEnd = (predAt + 1 until rn.size).firstOrNull { rn[it].isBlank() } ?: rn.size
        if (copies.any { it < predAt || it >= predEnd }) out += "a copy of the predicate outside isCurrent"
        if (cm.filterNot { isComment(it) }.none { it.contains("RestartNotice.invalidateIfOrphaned(tx!!, context.filesDir.toPath(), p)") }) out += "the MAIN load does not self-heal through invalidateIfOrphaned"
        return out
    }

    @Test
    fun `v2_12 fold 5' - one shared predicate for visible, the chokepoint and the load self-heal`() {
        val rnPath = "com/seekerclaw/app/config/RestartNotice.kt"
        val rn = sources.getValue(rnPath)
        val cm = sources.getValue("com/seekerclaw/app/config/ConfigManager.kt")
        assertEquals(emptyList<String>(), predicateOffenders(rn, cm))
        // Negative control 1: visible with its own copy of the rule.
        val v = rn.indexOfFirst { it.contains("notice != null && running && !healthStale && isCurrent(notice, prefs, filesDir)") }
        assertTrue(v >= 0)
        val copy = rn.toMutableList().apply { this[v] = "        notice != null && running && !healthStale && prefs != null && ConfigManager.rawPrefsModelTuple(prefs) == notice.selection" }
        assertTrue("negative control: a copied rule in visible", predicateOffenders(copy, cm).isNotEmpty())
        // Negative control 2: the chokepoint skipping the predicate.
        val c = rn.indexOfFirst { it.contains("if (isCurrent(n, prefs, filesDir)) return") }
        assertTrue(c >= 0)
        val skip = rn.toMutableList().apply { this[c] = "        if (false) return" }
        assertTrue("negative control: invalidateIfOrphaned without the predicate", predicateOffenders(skip, cm).isNotEmpty())
        // Negative control 3: the load's self-heal removed.
        val noHeal = cm.map { if (it.contains("RestartNotice.invalidateIfOrphaned(tx!!")) "" else it }
        assertTrue("negative control: no self-heal in the load", predicateOffenders(rn, noHeal).isNotEmpty())
    }

    /**
     * CR (fold 5′): `:node` deletes the notice at RUNNING with no message to MAIN. MAIN's ONE filesDir
     * FileObserver (LogCollector's — one observer per directory per process) must hand every event to
     * `RestartNotice.handleFilesDirEvent` with that directory, and nothing in RestartNotice may take
     * the model-selection lock on that path.
     */
    private fun noticeSignalOffenders(lc: List<String>, rn: List<String>): List<String> {
        val code = lc.map { if (isComment(it)) "" else it.substringBefore("//") }
        val ev = code.indexOfFirst { it.contains("override fun onEvent(event: Int, path: String?)") }
        if (ev < 0) return listOf("LogCollector has no FileObserver onEvent")
        val end = (ev + 1 until code.size).firstOrNull { code[it].contains(".also { it.startWatching() }") } ?: return listOf("onEvent end not found")
        val out = mutableListOf<String>()
        if ((ev until end).none { code[it].contains("RestartNotice.handleFilesDirEvent(parent.toPath(), fileName)") }) out += "the filesDir observer does not signal the restart notice"
        val h = memberBody(rn, "handleFilesDirEvent") ?: return out + "handleFilesDirEvent not found"
        if (!h.contains("refreshAsync(filesDir)")) out += "handleFilesDirEvent does not re-read the notice"
        if (h.contains("ModelSelectionLock") || h.contains("transaction")) out += "handleFilesDirEvent takes the model-selection lock"
        return out
    }

    @Test
    fun `CR fold 5' - MAIN's filesDir FileObserver signals the restart notice, lock-free`() {
        val lc = sources.getValue("com/seekerclaw/app/util/LogCollector.kt")
        val rn = sources.getValue("com/seekerclaw/app/config/RestartNotice.kt")
        assertEquals(emptyList<String>(), noticeSignalOffenders(lc, rn))
        assertEquals("one filesDir observer in MAIN", 1, lc.count { !isComment(it) && it.contains("object : FileObserver(") })
        // Negative control 1: the observer no longer signals the notice.
        val noSignal = lc.map { if (it.contains("RestartNotice.handleFilesDirEvent(")) "" else it }
        assertTrue("negative control: no signal", noticeSignalOffenders(noSignal, rn).isNotEmpty())
        // Negative control 2: the same call only in a comment.
        val commented = lc.map { if (it.contains("RestartNotice.handleFilesDirEvent(")) "// $it" else it }
        assertTrue("negative control: commented out", noticeSignalOffenders(commented, rn).isNotEmpty())
        // Negative control 3: the handler takes the lock.
        val at = rn.indexOfFirst { it.contains("fun handleFilesDirEvent(") }
        val locked = rn.toMutableList().apply { add(at + 1, "        ModelSelectionLock.transaction { }") }
        assertTrue("negative control: lock on the signal path", noticeSignalOffenders(lc, locked).isNotEmpty())
    }

    /**
     * CR 00a3a05a: the filesDir observer has dropped events on the Seeker (BAT-513), so the
     * dashboard's foreground catch-up loop — the one that already re-reads ServiceState every 1.5 s —
     * must also re-read the restart notice. Otherwise a missed DELETE for `:node`'s clear at RUNNING
     * leaves the notice on screen until another refresh.
     */
    private fun noticeCatchUpOffenders(dash: List<String>): List<String> {
        val code = dash.map { if (isComment(it)) "" else it.substringBefore("//") }
        val loop = code.indices.firstOrNull { i ->
            code[i].contains("while (true)") && (i until minOf(i + 3, code.size)).any { code[it].contains("ServiceState.refreshFromFile()") }
        } ?: return listOf("foreground catch-up loop not found")
        val delay = (loop until code.size).firstOrNull { code[it].contains("delay(") } ?: return listOf("catch-up loop has no delay")
        return if ((loop until delay).any { code[it].contains("RestartNotice.refreshAsync(") }) emptyList()
        else listOf("the foreground catch-up does not re-read the restart notice")
    }

    @Test
    fun `CR 00a3a05a - the dashboard's foreground catch-up re-reads the restart notice`() {
        val dash = sources.getValue("com/seekerclaw/app/ui/dashboard/DashboardScreen.kt")
        assertEquals(emptyList<String>(), noticeCatchUpOffenders(dash))
        // Negative control 1: the call removed from the loop.
        val removed = dash.map { if (it.contains("RestartNotice.refreshAsync(context.filesDir.toPath())") && !it.contains("LaunchedEffect")) "" else it }
        assertTrue("negative control: removed", noticeCatchUpOffenders(removed).isNotEmpty())
        // Negative control 2: the same call only in a comment.
        val commented = dash.map { if (it.contains("RestartNotice.refreshAsync(context.filesDir.toPath())") && !it.contains("LaunchedEffect")) "// $it" else it }
        assertTrue("negative control: commented out", noticeCatchUpOffenders(commented).isNotEmpty())
    }

    /**
     * Fold 5′: the notice is cleared only by a SUCCESSFUL start — `RestartNotice.clearIfStartedOn` is
     * called once, in `continueStart`, after `ServiceState.updateStatus(ServiceStatus.RUNNING)`, with
     * the selection captured from the config this boot emitted. A failed or aborted boot returns
     * before it; STARTING is not RUNNING.
     */
    private fun noticeClearOffenders(svc: List<String>): List<String> {
        val code = svc.map { if (isComment(it)) "" else it.substringBefore("//") }
        val calls = code.withIndex().filter { it.value.contains("RestartNotice.clearIfStartedOn(") }.map { it.index }
        if (calls.size != 1) return listOf("clearIfStartedOn called ${calls.size} times")
        val at = calls.single()
        val cs = code.indexOfFirst { it.contains("private fun continueStart(") }
        val running = (cs until at).firstOrNull { code[it].contains("ServiceState.updateStatus(ServiceStatus.RUNNING)") }
        val out = mutableListOf<String>()
        if (cs < 0 || cs > at) out += "not in continueStart"
        if (running == null) out += "not after the RUNNING transition"
        if (!code[at].contains("clearIfStartedOn(filesDir.toPath(), c)")) out += "not the consumed selection"
        val emit = code.indexOfFirst { it.contains("consumed = com.seekerclaw.app.config.ModelTuple(config.provider, config.authType, config.model)") }
        if (emit < 0 || emit > at) out += "the consumed selection is not the emitted config's"
        return out
    }

    @Test
    fun `v2_12 fold 5' - only a successful start on the consumed selection clears the notice`() {
        val path = "com/seekerclaw/app/service/SeekerClawService.kt"
        val svc = sources.getValue(path)
        assertEquals(emptyList<String>(), noticeClearOffenders(svc))
        val at = svc.indexOfFirst { it.contains("RestartNotice.clearIfStartedOn(") }
        val running = svc.indexOfFirst { it.contains("ServiceState.updateStatus(ServiceStatus.RUNNING)") && svc.indexOf(it) > svc.indexOfFirst { l -> l.contains("private fun continueStart(") } }
        // Negative control 1: the clear moved before the RUNNING transition (a start not yet proven).
        val early = svc.toMutableList().apply {
            val line = removeAt(at)
            add(svc.indexOfFirst { it.contains("NodeBridge.start(workDir") }, line)
        }
        assertTrue("negative control: a clear before RUNNING is reported", noticeClearOffenders(early).isNotEmpty())
        // Negative control 2: a clear with a selection other than the consumed one.
        val other = svc.toMutableList().apply { this[at] = this[at].replace("clearIfStartedOn(filesDir.toPath(), c)", "clearIfStartedOn(filesDir.toPath(), ModelTuple(\"x\", \"y\", \"z\"))") }
        assertTrue("negative control: another selection is reported", noticeClearOffenders(other).isNotEmpty())
        assertTrue(running >= 0)
    }

    /** No main source ASSIGNS the xAI ciphertext test seam (comments stripped; the declaration is `name: type = null`). */
    private fun xaiSeamOffenders(srcs: Map<String, List<String>>): List<String> {
        val out = mutableListOf<String>()
        val assign = Regex("""\bxaiCiphertextOpenerForTest\s*=(?!=)""")
        for ((path, lines) in srcs) {
            lines.forEachIndexed { i, l ->
                if (!isComment(l) && assign.containsMatchIn(l.substringBefore("//"))) out += "$path:${i + 1}"
            }
        }
        return out
    }

    @Test
    fun `v2_12 - production never assigns the xAI ciphertext test seam`() {
        assertEquals(emptyList<String>(), xaiSeamOffenders(sources))
        val cm = "com/seekerclaw/app/config/ConfigManager.kt"
        val lines = sources.getValue(cm)
        assertTrue("the seam is declared", lines.any { it.contains("internal var xaiCiphertextOpenerForTest: ((String) -> String)? = null") })
        val at = lines.indexOfFirst { it.contains("fun isSetupComplete(context: Context): Boolean =") }
        val assigned = lines.toMutableList().apply { add(at, "    init { xaiCiphertextOpenerForTest = { it } }") }
        assertTrue("negative control: an assignment is reported", xaiSeamOffenders(sources + (cm to assigned)).isNotEmpty())
        val elsewhere = "com/seekerclaw/app/SeekerClawApplication.kt"
        val app = sources.getValue(elsewhere).toMutableList().apply { add(1, "fun x() { ConfigManager.xaiCiphertextOpenerForTest = null }") }
        assertTrue("negative control: in another file", xaiSeamOffenders(sources + (elsewhere to app)).isNotEmpty())
        val commented = lines.toMutableList().apply { add(at, "    // xaiCiphertextOpenerForTest = { it }") }
        assertEquals("the needle in a comment is not reported", emptyList<String>(), xaiSeamOffenders(sources + (cm to commented)))
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
