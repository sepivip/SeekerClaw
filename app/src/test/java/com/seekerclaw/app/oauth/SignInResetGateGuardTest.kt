package com.seekerclaw.app.oauth

import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test
import java.io.File

/**
 * BAT-1157 (contract v3 §3, D14 + CodeRabbit PR #466): both OAuth sign-in activities are
 * Android-bound, so their ResetGate wiring is pinned at the source level:
 * - the commit runs inside `ResetGate.commit` with the generation captured when THIS flow
 *   (requestId) started — never another flow's;
 * - the flow start calls `ResetGate.beginFlow()` and, when refused, answers only its own requestId
 *   without touching the shared write-claim state.
 */
class SignInResetGateGuardTest {

    private fun violations(src: String): List<String> {
        val out = mutableListOf<String>()
        if (!src.contains("ResetGate.commit(flowGen)")) out += "the sign-in commit must run inside ResetGate.commit"
        if (!src.contains("if (activeFlowId == requestId) activeFlowResetGen else null")) {
            out += "the commit must read only this flow's reset generation"
        }
        val begin = src.indexOf("ResetGate.beginFlow()")
        if (begin < 0) {
            out += "the flow must capture its generation with ResetGate.beginFlow()"
        } else {
            val refusal = src.substring(begin, src.indexOf("synchronized(FLOW_LOCK)", begin).takeIf { it > 0 } ?: src.length)
            if (refusal.contains("claimWrite()") || refusal.contains("markWriteCompleted()")) {
                out += "the reset refusal must not touch the shared write claim"
            }
        }
        return out
    }

    private fun source(name: String) =
        File("src/main/java/com/seekerclaw/app/oauth/$name.kt").readText().replace("\r\n", "\n")

    @Test
    fun bothActivitiesBindTheResetGenerationToTheirOwnFlow() {
        for (a in listOf("OpenAIOAuthActivity", "XaiOAuthActivity")) {
            assertEquals("$a: ", emptyList<String>(), violations(source(a)))
        }
    }

    @Test
    fun guardCatchesAnUnboundGenerationAndARefusalThatClaimsTheWrite() {
        val src = source("OpenAIOAuthActivity")
        val unbound = src.replace("if (activeFlowId == requestId) activeFlowResetGen else null", "activeFlowResetGen")
        assertTrue(violations(unbound).isNotEmpty())
        val claims = src.replace(
            "Log.w(TAG, \"Sign-in refused: Reset Config in progress\")",
            "Log.w(TAG, \"Sign-in refused: Reset Config in progress\")\n            claimWrite()",
        )
        assertTrue(violations(claims).isNotEmpty())
    }
}
