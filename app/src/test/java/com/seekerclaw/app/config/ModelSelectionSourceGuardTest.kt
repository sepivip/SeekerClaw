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
        if (lines.none { it.contains("when (ReconcileRecord.read(filesDir))") }) out += "boot does not read the record"
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
        // v2.12 (Q16, D12.2): a model key put OR removed, or a whole-prefs clear(), then apply();
        // and the KTX `edit { }` (which applies) in a member that touches a model key or clears.
        val modelTouch = Regex("""(putString|remove)\(KEY_(MODEL|PROVIDER|AUTH_TYPE)\b|edit\(\)\??\..*\bclear\(\)""")
        val ktxEdit = Regex("""\.edit\s*(\(\s*commit\s*=\s*false\s*\))?\s*\{""")
        for ((path, lines) in srcs) {
            var sig = "<top>"
            var putsModelKey = false
            var ktxAt = -1
            fun endMember() {
                if (ktxAt >= 0 && putsModelKey) out += "$path:${ktxAt + 1}  in  $sig (KTX edit { })"
                ktxAt = -1
            }
            lines.forEachIndexed { i, line ->
                if (memberFun.containsMatchIn(line)) {
                    endMember()
                    sig = line.trim()
                    putsModelKey = false
                }
                if (isComment(line)) return@forEachIndexed
                if (modelTouch.containsMatchIn(line)) putsModelKey = true
                if (ktxEdit.containsMatchIn(line) && ktxAt < 0) ktxAt = i
                if (putsModelKey && line.contains(".apply()")) out += "$path:${i + 1}  in  $sig"
            }
            endMember()
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

    /** The `android:process` of [service] in AndroidManifest.xml (parsed as text), or null. */
    private fun manifestProcess(manifest: String, service: String): String? {
        val tag = Regex("""<service\b[^>]*>""").findAll(manifest).map { it.value }
            .firstOrNull { Regex("""android:name="[^"]*\Q$service\E"""").containsMatchIn(it) } ?: return null
        return Regex("""android:process="([^"]*)"""").find(tag)?.groupValues?.get(1)
    }

    /** The process suffix ReconcileRecord's liveness check looks for (`context.packageName + "<suffix>"`). */
    private fun livenessSuffix(rr: List<String>): String? =
        rr.filterNot { isComment(it) }.firstNotNullOfOrNull { Regex("""context\.packageName \+ "([^"]+)"""").find(it)?.groupValues?.get(1) }

    private fun processOffenders(manifest: String, rr: List<String>): List<String> {
        val declared = manifestProcess(manifest, ".service.SeekerClawService") ?: return listOf("SeekerClawService has no android:process")
        val looked = livenessSuffix(rr) ?: return listOf("ReconcileRecord's liveness check names no process")
        return if (declared == looked) emptyList() else listOf("manifest $declared != liveness check $looked")
    }

    @Test
    fun `v2_12 M1 - the liveness check looks for the process the manifest gives SeekerClawService`() {
        val manifest = listOf("src/main/AndroidManifest.xml", "app/src/main/AndroidManifest.xml").map { File(it) }.first { it.isFile }.readText()
        val rr = sources.getValue("com/seekerclaw/app/config/ReconcileRecord.kt")
        assertEquals(":node", manifestProcess(manifest, ".service.SeekerClawService"))
        assertEquals(emptyList<String>(), processOffenders(manifest, rr))
        // Negative controls: the service moved to another process; the check renamed.
        val moved = manifest.replace("android:process=\":node\"", "android:process=\":agent\"")
        assertTrue(processOffenders(moved, rr).isNotEmpty())
        val renamed = rr.map { it.replace("context.packageName + \":node\"", "context.packageName + \":worker\"") }
        assertTrue(processOffenders(manifest, renamed).isNotEmpty())
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
