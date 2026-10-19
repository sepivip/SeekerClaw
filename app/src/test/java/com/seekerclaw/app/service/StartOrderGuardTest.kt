package com.seekerclaw.app.service

import com.seekerclaw.app.SourceText
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNotEquals
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * BAT-1409 P1-A / P1-C (amendment v3.3 M1/M2, correction v3.4) — start-order guards on the
 * Android entry points, which cannot run on the JVM. Each guard lexes the real source (comments
 * and string literals do not count), matches on statement order inside the function bodies, and
 * is run against a mutated copy that breaks the order it protects: that negative control must be
 * rejected, so a guard can never pass vacuously.
 *
 * What the chain pins, end to end:
 * - the bridge token and `config.json` are written only in `continueStart`;
 * - `continueStart` runs only from `startEffects.proceed`, which [StartCoordinator] calls only on
 *   `Verification.Ok` with the fence held (StartCoordinatorTest);
 * - `verifyBeforeStart` maps every failed link hygiene or bundle outcome to `Verification.Failed`;
 * - the `Failed` path removes `workspace/config.json` (StartCleanupTest);
 * - in `:node`, link hygiene step 1 runs before any store or SafeFs set-up, and an unsafe result
 *   returns before any store is initialised; `onStartCommand` and `onDestroy` take their unsafe
 *   branch before any store, status or token write.
 */
class StartOrderGuardTest {

    private val servicePath = "com/seekerclaw/app/service/SeekerClawService.kt"
    private val appPath = "com/seekerclaw/app/SeekerClawApplication.kt"
    private val service = SourceText.main(servicePath)
    private val app = SourceText.main(appPath)

    /** A store, status, token, prefs or config touch. Nothing of this may precede an unsafe branch. */
    private val storeTouch = Regex(
        """\b(ServiceState|LogCollector|ConfigManager|StopToken|XaiOAuthTokenStore|RuntimeStateStore|McpServersStore|""" +
            """AgentPreferencesStore|NodeBridge|SafeFs|Analytics|starter)\.|\b(getSharedPreferences|initAnalytics|deleteEphemeralConfig)\(""",
    )

    /** [src] with [old] replaced by [new]; fails if [old] is absent, so a negative control is never a no-op. */
    private fun mutate(src: String, old: String, new: String): String {
        assertTrue("the mutation target is in the source: $old", src.contains(old))
        return src.replace(old, new)
    }

    // ------------------------------------------------------------- secrets written only on proceed

    /** Violations of "writeBridgeToken/writeConfigJson only in continueStart; continueStart only via proceed". */
    private fun secretWriteViolations(sources: List<Pair<String, String>>): List<String> {
        val out = mutableListOf<String>()
        for ((path, src) in sources) {
            val code = SourceText.codeOnly(src)
            val isService = path.endsWith(servicePath)
            val continueBody = if (isService) SourceText.functionBody(code, "continueStart") else IntRange.EMPTY
            for (name in listOf("writeBridgeToken", "writeConfigJson")) {
                for (m in Regex("""\b$name\b""").findAll(code)) {
                    val at = m.range.first
                    if (Regex("""\bfun\s+$""").containsMatchIn(code.substring(maxOf(0, at - 16), at))) continue
                    if (at !in continueBody) out += "$path:${SourceText.lineOf(code, at)}: $name outside continueStart"
                }
            }
            val refs = Regex("""\bcontinueStart\b""").findAll(code).map { it.range.first }
                .filterNot { Regex("""\bfun\s+$""").containsMatchIn(code.substring(maxOf(0, it - 16), it)) }
                .toList()
            if (!isService) {
                refs.forEach { out += "$path:${SourceText.lineOf(code, it)}: continueStart referenced outside the service" }
                continue
            }
            val effectsAt = Regex("""\bval\s+startEffects\s*=\s*object\s*:\s*StartCoordinator\.Effects\b""").find(code)
            if (effectsAt == null) {
                out += "startEffects is not a StartCoordinator.Effects object"
                continue
            }
            val effects = SourceText.braceBlockAfter(code, effectsAt.range.last + 1)
            val proceed = Regex("""override\s+fun\s+proceed\s*\(\s*fence\s*:\s*StartCoordinator\.Fence\s*\)\s*=\s*continueStart\s*\(\s*fence\s*\)""")
                .findAll(code).filter { it.range.first in effects }.toList()
            if (proceed.size != 1) out += "startEffects.proceed must be exactly `= continueStart(fence)`"
            val allowed = proceed.map { it.range.first + it.value.lastIndexOf("continueStart") }.toSet()
            refs.filter { it !in allowed }.forEach {
                out += "$path:${SourceText.lineOf(code, it)}: continueStart referenced outside startEffects.proceed"
            }
            if (refs.isEmpty()) out += "continueStart is never referenced"
        }
        return out
    }

    @Test
    fun secretsAreWrittenOnlyInContinueStartWhichOnlyProceedRuns() {
        val all = SourceText.allMain()
        assertTrue(all.any { it.first.endsWith(servicePath) })
        assertEquals(emptyList<String>(), secretWriteViolations(all))
    }

    @Test
    fun secretWriteGuardRejectsAWriteOrAReferenceAnywhereElse() {
        fun withService(src: String) = listOf(servicePath to src)
        assertEquals(emptyList<String>(), secretWriteViolations(withService(service)))
        // A comment or a log message naming the call is not a call.
        val commented = mutate(
            service, "        ServiceState.init(applicationContext)\n",
            "        // ServiceState.writeBridgeToken(x) and ConfigManager.writeConfigJson(this, x)\n" +
                "        LogCollector.append(\"continueStart(fence) writeBridgeToken(\")\n" +
                "        ServiceState.init(applicationContext)\n",
        )
        assertEquals(emptyList<String>(), secretWriteViolations(withService(commented)))
        // Negative controls: each must be rejected.
        val early = mutate(
            service, "        ServiceState.init(applicationContext)\n",
            "        ServiceState.init(applicationContext)\n        ServiceState.writeBridgeToken(\"x\")\n",
        )
        assertNotEquals(emptyList<String>(), secretWriteViolations(withService(early)))
        val config = mutate(
            service, "        ServiceState.init(applicationContext)\n",
            "        ServiceState.init(applicationContext)\n        ConfigManager.writeConfigJson(this, \"x\")\n",
        )
        assertNotEquals(emptyList<String>(), secretWriteViolations(withService(config)))
        val secondRef = mutate(
            service, "        override fun abort(fence: StartCoordinator.Fence) = abortStart()",
            "        override fun abort(fence: StartCoordinator.Fence) = continueStart(fence)",
        )
        assertNotEquals(emptyList<String>(), secretWriteViolations(withService(secondRef)))
        val elsewhere = listOf(servicePath to service, "x/Other.kt" to "fun f() { ServiceState.writeBridgeToken(\"t\") }")
        assertNotEquals(emptyList<String>(), secretWriteViolations(elsewhere))
    }

    // ------------------------------------------------------------- verification and the Failed path

    private fun verificationViolations(src: String): List<String> {
        val out = mutableListOf<String>()
        val code = SourceText.codeOnly(src)
        val verify = SourceText.flat(code.substring(SourceText.functionBody(code, "verifyBeforeStart")))
        val hygiene = verify.indexOf("if (hygiene.unsafe.isNotEmpty()) return StartCoordinator.Verification.Failed(")
        val bundle = verify.indexOf("when (val bundle = NodeBridge.verifyBundle(applicationContext)) {")
        if (hygiene < 0 || bundle < 0 || hygiene > bundle) out += "an unsafe hygiene result must fail before the bundle check"
        val branches = verify.substring(maxOf(bundle, 0))
        if (!Regex("""^when \(val bundle = NodeBridge\.verifyBundle\(applicationContext\)\) \{ is BundleIntegrity\.Outcome\.Failed -> StartCoordinator\.Verification\.Failed\([^{}]*\) else -> StartCoordinator\.Verification\.Ok \}""")
                .containsMatchIn(branches)
        ) out += "a failed bundle outcome must map to Verification.Failed, everything else to Ok"
        val fail = SourceText.flat(code.substring(SourceText.functionBody(code, "failBeforeNode")))
        val cleanup = fail.indexOf("deleteEphemeralConfig()")
        val stop = fail.indexOf("stopSelf()")
        if (cleanup < 0 || stop < 0 || cleanup > stop) out += "failBeforeNode must remove config.json before stopSelf"
        val delete = SourceText.flat(
            code.substring(
                SourceText.functionBody(code, "deleteEphemeralConfig", Regex("""\bprivate\s+fun\s+deleteEphemeralConfig\b(?=\s*\(\s*\))""")),
            ),
        )
        if (!delete.startsWith("StartCleanup.deleteEphemeralConfig(filesDir.toPath())")) {
            out += "the service's deleteEphemeralConfig must be StartCleanup's, on filesDir"
        }
        return out
    }

    @Test
    fun failedVerificationNeverProceedsAndTheFailedPathRemovesConfig() {
        assertEquals(emptyList<String>(), verificationViolations(service))
    }

    @Test
    fun verificationGuardRejectsAFailedOutcomeThatProceedsOrAMissingCleanup() {
        val okOnFailure = mutate(
            service,
            "is BundleIntegrity.Outcome.Failed ->\n                StartCoordinator.Verification.Failed(",
            "is BundleIntegrity.Outcome.Failed -> StartCoordinator.Verification.Ok\n            is Unit -> StartCoordinator.Verification.Failed(",
        )
        assertNotEquals(emptyList<String>(), verificationViolations(okOnFailure))
        val hygieneIgnored = mutate(
            service, "if (hygiene.unsafe.isNotEmpty()) return StartCoordinator.Verification.Failed(\"LINK_HYGIENE\")", "",
        )
        assertNotEquals(emptyList<String>(), verificationViolations(hygieneIgnored))
        val noCleanup = mutate(
            service, "        ServiceState.updateStatus(ServiceStatus.ERROR)\n        deleteEphemeralConfig()\n        stopSelf()",
            "        ServiceState.updateStatus(ServiceStatus.ERROR)\n        stopSelf()",
        )
        assertNotEquals(emptyList<String>(), verificationViolations(noCleanup))
    }

    // ------------------------------------------------------------- :node boot (Application.onCreate)

    private fun applicationViolations(src: String): List<String> {
        val out = mutableListOf<String>()
        val code = SourceText.codeOnly(src)
        val body = SourceText.functionBody(code, "onCreate")
        val flat = SourceText.flat(code.substring(body))
        // String literals are blanked in `code`; the process check is read from the comment-free text.
        val withStrings = SourceText.flat(SourceText.withoutComments(src).substring(body))
        if (!withStrings.contains("val isNodeProcess = getProcessName().endsWith(\":node\")")) {
            out += "isNodeProcess must be the `:node` process check"
        }
        val step1First = "super.onCreate() val isNodeProcess = getProcessName().endsWith( ) if (isNodeProcess) BootHygiene.runStep1(dataDir) "
        if (!flat.startsWith(step1First)) out += "step 1 must be the first statement in :node, before SafeFs and every store"
        val guard = Regex("""if \(isNodeProcess && BootHygiene\.unsafe\.isNotEmpty\(\)\) \{ Log\.e\( , \) return \}""").find(flat)
        if (guard == null) {
            out += "the unsafe early return must hold only a logcat line and the return"
            return out
        }
        for (m in storeTouch.findAll(flat)) {
            // SafeFs's root and directory fsync are configuration, set before the return on purpose.
            if (m.value == "SafeFs." && m.range.first < guard.range.first) continue
            if (m.range.first < guard.range.first) out += "${m.value} runs before the unsafe early return"
        }
        for (required in listOf("XaiOAuthTokenStore.init(this)", "initAnalytics(this)")) {
            val at = flat.indexOf(required)
            if (at < guard.range.last) out += "$required must come after the unsafe early return"
        }
        val safeFs = flat.indexOf("SafeFs.filesRoot =")
        val step1 = flat.indexOf("BootHygiene.runStep1(")
        if (safeFs < 0 || safeFs < step1) out += "SafeFs.filesRoot must be set after step 1"
        return out
    }

    @Test
    fun nodeBootRunsStep1FirstAndReturnsBeforeAnyStoreWhenUnsafe() {
        assertEquals(emptyList<String>(), applicationViolations(app))
    }

    @Test
    fun nodeBootGuardRejectsAStoreBeforeStep1OrBeforeTheUnsafeReturn() {
        val step1Line = "        if (isNodeProcess) BootHygiene.runStep1(dataDir)\n"
        val filesRootLine = "        SafeFs.filesRoot = filesDir.toPath()\n"
        val late = mutate(mutate(app, step1Line, ""), filesRootLine, filesRootLine + step1Line)
        assertNotEquals(emptyList<String>(), applicationViolations(late))
        val unsafeBlock = Regex("""        if \(isNodeProcess && BootHygiene\.unsafe\.isNotEmpty\(\)\) \{\n[^}]*\n        \}\n""").find(app)
        assertTrue("the unsafe block is in the source", unsafeBlock != null)
        val storeInit = "        XaiOAuthTokenStore.init(this)\n"
        val storeFirst = mutate(mutate(app, unsafeBlock!!.value, ""), storeInit, storeInit + unsafeBlock.value)
        assertNotEquals(emptyList<String>(), applicationViolations(storeFirst))
        val analyticsFirst = mutate(app, unsafeBlock.value, "        initAnalytics(this)\n" + unsafeBlock.value)
        assertNotEquals(emptyList<String>(), applicationViolations(analyticsFirst))
        val writesInGuard = mutate(app, "            return\n        }\n", "            ServiceState.init(this)\n            return\n        }\n")
        assertNotEquals(emptyList<String>(), applicationViolations(writesInGuard))
    }

    // ------------------------------------------------------------- the service's unsafe branches

    private fun serviceUnsafeBranchViolations(src: String): List<String> {
        val out = mutableListOf<String>()
        val code = SourceText.codeOnly(src)
        val start = SourceText.flat(code.substring(SourceText.functionBody(code, "onStartCommand")))
        if (!start.startsWith("if (BootHygiene.unsafe.isNotEmpty()) return failLinkHygiene() ")) {
            out += "onStartCommand's first statement must be the unsafe branch"
        }
        val fail = SourceText.flat(code.substring(SourceText.functionBody(code, "failLinkHygiene")))
        storeTouch.findAll(fail).forEach { out += "failLinkHygiene touches ${it.value}" }
        if (!fail.endsWith("stopSelf() return START_NOT_STICKY")) out += "failLinkHygiene must stop, not sticky"
        val destroy = SourceText.flat(code.substring(SourceText.functionBody(code, "onDestroy")))
        val branch = Regex("""^destroyed = true if \(BootHygiene\.unsafe\.isNotEmpty\(\)\) \{ ([^{}]*) return \}""").find(destroy)
        if (branch == null) {
            out += "onDestroy must take the unsafe branch right after the in-process fence"
        } else {
            storeTouch.findAll(branch.groupValues[1]).forEach { out += "onDestroy's unsafe branch touches ${it.value}" }
        }
        return out
    }

    @Test
    fun serviceUnsafeBranchesPrecedeEveryStoreStatusOrTokenWrite() {
        assertEquals(emptyList<String>(), serviceUnsafeBranchViolations(service))
    }

    @Test
    fun serviceUnsafeGuardRejectsAWriteBeforeOrInsideTheBranch() {
        val unsafeLine = "        if (BootHygiene.unsafe.isNotEmpty()) return failLinkHygiene()\n"
        val initLine = "        ServiceState.init(applicationContext)\n"
        val storeFirst = mutate(mutate(service, unsafeLine, ""), initLine, initLine + unsafeLine)
        assertNotEquals(emptyList<String>(), serviceUnsafeBranchViolations(storeFirst))
        val statusInFail = mutate(
            service, "        val still = BootHygiene.retryUnsafe(dataDir)\n",
            "        val still = BootHygiene.retryUnsafe(dataDir)\n        ServiceState.updateStatus(ServiceStatus.ERROR)\n",
        )
        assertNotEquals(emptyList<String>(), serviceUnsafeBranchViolations(statusInFail))
        val logBeforeDestroyBranch = mutate(
            service, "        destroyed = true\n        if (BootHygiene.unsafe.isNotEmpty()) {",
            "        destroyed = true\n        LogCollector.append(\"x\")\n        if (BootHygiene.unsafe.isNotEmpty()) {",
        )
        assertNotEquals(emptyList<String>(), serviceUnsafeBranchViolations(logBeforeDestroyBranch))
        val tokenInDestroyBranch = mutate(
            service, "            scopeJob.cancel()\n            super.onDestroy()",
            "            ServiceState.clearBridgeToken()\n            scopeJob.cancel()\n            super.onDestroy()",
        )
        assertNotEquals(emptyList<String>(), serviceUnsafeBranchViolations(tokenInDestroyBranch))
    }
}
