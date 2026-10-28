package com.seekerclaw.app.bridge

import com.seekerclaw.app.bridge.OwnerClaimPolicy.Decision
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertTrue
import org.junit.Test
import java.io.File

/** BAT-1409 P1-D — the bridge may only claim an unset owner, on the channel `:node` booted with. */
class OwnerClaimPolicyTest {

    private val file = """{"telegram":"111","discord":""}"""

    @Test
    fun sameIdIsIdempotent() {
        assertEquals(Decision.AlreadyOwner, OwnerClaimPolicy.decide(file, "111", "telegram", "telegram"))
    }

    @Test
    fun differentIdWhileSetIsRefused() {
        assertEquals(Decision.DifferentOwner, OwnerClaimPolicy.decide(file, "999", "telegram", "telegram"))
    }

    @Test
    fun unsetOwnerIsSaved() {
        assertEquals(Decision.Save, OwnerClaimPolicy.decide(file, "222", "discord", "discord")) // blank entry
        assertEquals(Decision.Save, OwnerClaimPolicy.decide(null, "222", "telegram", "telegram")) // no file
        assertEquals(Decision.Save, OwnerClaimPolicy.decide("""{"discord":"5"}""", "222", "telegram", "telegram"))
        assertEquals(Decision.Save, OwnerClaimPolicy.decide("""{"telegram":"   "}""", "222", "telegram", "telegram"))
    }

    @Test
    fun inactiveChannelIsRefused() {
        assertEquals(Decision.InactiveChannel("discord", "telegram"), OwnerClaimPolicy.decide(file, "222", "discord", "telegram"))
        assertEquals(Decision.InactiveChannel("telegram", ""), OwnerClaimPolicy.decide(null, "1", "telegram", ""))
    }

    @Test
    fun unknownChannelIsBadRequest() {
        for (c in listOf("", "slack", "Telegram", "telegram ")) {
            assertEquals(Decision.BadChannel(c), OwnerClaimPolicy.decide(file, "1", c, "telegram"))
        }
    }

    @Test
    fun entriesReadAsTheLoaderReadsThem() {
        assertEquals("123", OwnerClaimPolicy.currentOwner("""{"telegram":123}""", "telegram"))
        assertEquals("", OwnerClaimPolicy.currentOwner("""{"telegram":null}""", "telegram"))
        assertEquals("111", OwnerClaimPolicy.currentOwner(file, "telegram"))
    }

    @Test
    fun anUnparseableRecordRefusesTheClaimInsteadOfReadingAsUnset() {
        assertEquals(Decision.Unreadable, OwnerClaimPolicy.decide("not json", "1", "telegram", "telegram"))
        assertEquals(Decision.Unreadable, OwnerClaimPolicy.decide("[1,2]", "1", "telegram", "telegram"))
        assertEquals(Decision.Unreadable, OwnerClaimPolicy.decide("""{"telegram":{"x":1}}""", "1", "telegram", "telegram"))
    }

    @Test
    fun theBootChannelIsComparedNormalised() {
        assertEquals(Decision.Save, OwnerClaimPolicy.decide(null, "1", "telegram", " Telegram "))
    }

    // ── The bridge reply for each decision (status + JSON body, as /config/save-owner returns it) ──

    @Test
    fun eachDecisionMapsToItsExactStatusAndBody() {
        assertEquals(400 to mapOf("error" to "unknown channel", "code" to "bad_channel"), OwnerClaimPolicy.response(Decision.BadChannel("slack")))
        assertEquals(
            409 to mapOf("error" to "channel changed; restart required", "code" to "inactive_channel"),
            OwnerClaimPolicy.response(Decision.InactiveChannel("discord", "telegram")),
        )
        assertEquals(409 to mapOf("error" to "owner already set", "code" to "owner_already_set"), OwnerClaimPolicy.response(Decision.DifferentOwner))
        assertEquals(500 to mapOf("error" to "Owner record unreadable", "code" to "owner_unreadable"), OwnerClaimPolicy.response(Decision.Unreadable))
        assertEquals(200 to mapOf("success" to true), OwnerClaimPolicy.response(Decision.AlreadyOwner))
        assertEquals(200 to mapOf("success" to true), OwnerClaimPolicy.response(Decision.Save, saved = true))
        assertEquals(500 to mapOf("error" to "Failed to persist owner ID"), OwnerClaimPolicy.response(Decision.Save, saved = false))
    }

    @Test
    fun theSaveOutcomeOnlyMattersForASave() {
        for (d in listOf(Decision.BadChannel("x"), Decision.InactiveChannel("discord", "telegram"), Decision.DifferentOwner, Decision.Unreadable, Decision.AlreadyOwner)) {
            assertEquals(d.toString(), OwnerClaimPolicy.response(d, saved = true), OwnerClaimPolicy.response(d, saved = false))
        }
    }

    @Test
    fun aSettingsOwnerMismatchIsFlaggedOnlyWhenSetAndDifferent() {
        assertTrue(OwnerClaimPolicy.prefsMismatch("111", "222"))
        assertTrue(OwnerClaimPolicy.prefsMismatch("111", ""))
        assertFalse(OwnerClaimPolicy.prefsMismatch("111", "111"))
        assertFalse(OwnerClaimPolicy.prefsMismatch("", "222"))
        assertFalse(OwnerClaimPolicy.prefsMismatch("   ", "222"))
        assertFalse(OwnerClaimPolicy.prefsMismatch("\t\n", "222"))
    }

    /** Every decision the policy can return, one of each. */
    private val allDecisions = listOf(
        Decision.Save, Decision.AlreadyOwner, Decision.BadChannel("slack"),
        Decision.InactiveChannel("discord", "telegram"), Decision.DifferentOwner, Decision.Unreadable,
    )

    @Test
    fun nodeReadsExactlyTheRefusalCodesTheBridgeSends() {
        val js = File("src/main/assets/nodejs-project/message-handler.js").readText()
        val m = Regex("""const OWNER_CLAIM_REFUSED = new Set\(\[([^\]]*)]\)""").find(js)
        assertNotNull("message-handler.js must declare OWNER_CLAIM_REFUSED", m)
        val nodeCodes = Regex("""'([a-z_]+)'""").findAll(m!!.groupValues[1]).map { it.groupValues[1] }.toSet()

        // The list above covers every Decision subtype, so a new refusal cannot skip this guard.
        assertEquals(Decision::class.java.declaredClasses.map { it.simpleName }.toSet(), allDecisions.map { it.javaClass.simpleName }.toSet())
        val refusals = allDecisions.filter { it != Decision.Save && it != Decision.AlreadyOwner }
        val kotlinCodes = refusals.map { OwnerClaimPolicy.response(it).second["code"] as String }.toSet()
        assertEquals("every refusal code is read by Node, and Node reads no other", kotlinCodes, nodeCodes)
        assertEquals(refusals.size, kotlinCodes.size)

        // A success or a failed save carries no code, so Node keeps the claim for this run.
        for (r in listOf(OwnerClaimPolicy.response(Decision.Save, true), OwnerClaimPolicy.response(Decision.Save, false), OwnerClaimPolicy.response(Decision.AlreadyOwner))) {
            assertFalse(r.toString(), r.second.containsKey("code"))
        }
        // Node's one restart reply keys on the inactive-channel code the bridge sends.
        val inactive = OwnerClaimPolicy.response(Decision.InactiveChannel("discord", "telegram")).second["code"]
        assertTrue(js.contains("saveResult.code === '$inactive'"))
        assertTrue(js.contains("OWNER_CLAIM_REFUSED.has(saveResult.code)"))
    }

    @Test
    fun theBridgeRouteRepliesThroughThePolicy() {
        val bridge = File("src/main/java/com/seekerclaw/app/bridge/AndroidBridge.kt").readText()
        val start = bridge.indexOf("private fun handleConfigSaveOwner(")
        val handler = bridge.substring(start, bridge.indexOf("\n    private fun ", start + 1))
        assertTrue(handler.contains("OwnerClaimPolicy.response(d, saved)"))
        assertTrue(handler.contains("OwnerClaimPolicy.response(OwnerClaimPolicy.Decision.Unreadable)"))
        assertTrue(handler.contains("OwnerClaimPolicy.prefsMismatch(ConfigManager.prefsOwnerId(context, channel), ownerId)"))
        assertTrue(handler.contains("saved = ConfigManager.saveOwnerIdForChannel(context, ownerId, channel)"))
        // No hand-written reply besides the blank-ownerId check before the policy runs.
        assertEquals(1, Regex("""jsonResponse\(\d{3}""").findAll(handler).count())
    }

    @Test
    fun onlyTheBridgeRouteUsesThePolicyAndSettingsSavesDirectly() {
        val src = File("src/main/java")
        val users = src.walkTopDown()
            .filter { it.isFile && it.name.endsWith(".kt") && it.name != "OwnerClaimPolicy.kt" }
            .filter { it.readText().contains("OwnerClaimPolicy") }
            .map { it.name }
            .toList()
        assertEquals(listOf("AndroidBridge.kt"), users)
        val bridge = File(src, "com/seekerclaw/app/bridge/AndroidBridge.kt").readText()
        assertTrue("the save-owner route goes through the policy", bridge.contains("OwnerClaimPolicy.decide(ownerJson, ownerId, channel, bootChannel)"))
        val config = File(src, "com/seekerclaw/app/config/ConfigManager.kt").readText()
        assertTrue("Settings keeps the direct file save", config.contains("fun saveOwnerIdToFile("))
        // Only the bridge route saves an owner on :node's behalf.
        val bridgeSavers = src.walkTopDown().filter { it.isFile && it.name.endsWith(".kt") && it.name != "ConfigManager.kt" }
            .filter { Regex("""saveOwnerIdForChannel\(|saveOwnerId\(""").containsMatchIn(it.readText()) }.map { it.name }.toList()
        assertEquals(listOf("AndroidBridge.kt"), bridgeSavers)
    }
}
