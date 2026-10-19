package com.seekerclaw.app.bridge

import com.seekerclaw.app.bridge.OwnerClaimPolicy.Decision
import org.junit.Assert.assertEquals
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
