package com.seekerclaw.app.bridge

import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test
import java.io.File

/**
 * BAT-1409 P1-H (contract v3.2, owner- and Codex-approved): the agent's SMS and calls are
 * notification drafts in both flavours, and a bridge route that opens a screen first checks
 * that SeekerClaw is in front. The merged-manifest half (neither flavour requests SEND_SMS /
 * CALL_PHONE) is the `verifyDraftPermissions<Variant>` Gradle gate in app/build.gradle.kts.
 */
class SmsCallDraftsTest {

    // ── DraftRecipient ──────────────────────────────────────────────────────

    @Test
    fun `a typed number keeps its digits and leading plus, formatting removed`() {
        assertEquals("+15551234567", DraftRecipient.sanitize("+1 (555) 123-4567"))
        assertEquals("5551234567", DraftRecipient.sanitize("555.123.4567"))
        assertEquals("+995599123456", DraftRecipient.sanitize("+995 599 12 34 56"))
        assertEquals("0322123456", DraftRecipient.sanitize("032/212-34-56"))
        assertEquals("112", DraftRecipient.sanitize("112"))
        assertEquals("123456789012345", DraftRecipient.sanitize("123456789012345"))
        // Unicode spaces (no-break, figure, narrow no-break) and dashes (en, em, hyphen).
        assertEquals("+15551234567", DraftRecipient.sanitize("+1 555 123 4567"))
        assertEquals("5551234567", DraftRecipient.sanitize("555–123—4567"))
        assertEquals("5551234567", DraftRecipient.sanitize("555‐123‑4567"))
        assertEquals("5551234", DraftRecipient.sanitize("  5551234\n"))
    }

    @Test
    fun `anything but one plain number is refused (USSD, pauses, letters, several recipients)`() {
        val refused = listOf(
            null, "", "   ", "12", "1234567890123456", "+", "++15551234",
            "1+5551234", "*#06#", "*100#", "#31#5551234", "5551234*", "5551234#",
            "5551234p1", "5551234w1", "5551234P1", "5551234,5556789", "5551234;5556789",
            "1-800-FLOWERS", "tel:5551234", "smsto:5551234", "5551234\n5556789", "5551234\t5556789",
            "５５５１２３４", // fullwidth digits
            "٥٥٥١٢٣٤", // Arabic-Indic digits
            "5551234?body=x", "5551234&x", "5551234%2C5556789", "５５５1234",
        )
        for (raw in refused) assertNull("must refuse ${raw?.let { "\"$it\"" }}", DraftRecipient.sanitize(raw))
    }

    // ── DraftNotifier.firstRefusal (the contract's order; nothing is posted on a refusal) ──

    private val none = 0 // NotificationManager.IMPORTANCE_NONE
    private val high = 4 // NotificationManager.IMPORTANCE_HIGH

    @Test
    fun `refusals come in the contract's order`() {
        val yes = { true }
        assertEquals(DraftNotifier.Outcome.NOTIFICATIONS_DISABLED, DraftNotifier.firstRefusal(false, true, none, { false }))
        assertEquals(DraftNotifier.Outcome.NOTIFICATIONS_PAUSED, DraftNotifier.firstRefusal(true, true, none, { false }))
        assertEquals(DraftNotifier.Outcome.CHANNEL_BLOCKED, DraftNotifier.firstRefusal(true, false, none, yes))
        assertEquals(DraftNotifier.Outcome.CHANNEL_BLOCKED, DraftNotifier.firstRefusal(true, false, null, yes))
        assertEquals(DraftNotifier.Outcome.NO_HANDLER, DraftNotifier.firstRefusal(true, false, high, { false }))
        assertNull(DraftNotifier.firstRefusal(true, false, high, yes))
        assertNull(DraftNotifier.firstRefusal(true, false, 1, yes)) // IMPORTANCE_MIN still shows the draft
    }

    @Test
    fun `the handler lookup only runs once every notification check passed`() {
        var asked = 0
        DraftNotifier.firstRefusal(false, false, high) { asked++; true }
        DraftNotifier.firstRefusal(true, true, high) { asked++; true }
        DraftNotifier.firstRefusal(true, false, none) { asked++; true }
        assertEquals(0, asked)
    }

    @Test
    fun `outcome codes are the ones the Node tools map`() {
        assertEquals(
            listOf("posted", "notifications_disabled", "notifications_paused", "channel_blocked", "no_handler", "invalid_recipient"),
            DraftNotifier.Outcome.values().map { it.code },
        )
        assertTrue(DraftNotifier.DRAFT_ID_MIN > 9002) // above every fixed notification id
        assertEquals(15 * 60_000L, DraftNotifier.EXPIRY_MS)
    }

    @Test
    fun `the bridge reply is the shape tools-android-js maps`() {
        assertEquals(200 to mapOf("success" to true, "outcome" to "posted"), DraftNotifier.reply(DraftNotifier.Outcome.POSTED))
        assertEquals(
            400 to mapOf("error" to "invalid_recipient", "outcome" to "invalid_recipient"),
            DraftNotifier.reply(DraftNotifier.Outcome.INVALID_RECIPIENT),
        )
        for (o in DraftNotifier.Outcome.values().filter { it != DraftNotifier.Outcome.POSTED && it != DraftNotifier.Outcome.INVALID_RECIPIENT }) {
            assertEquals(409 to mapOf("error" to o.code, "outcome" to o.code), DraftNotifier.reply(o))
        }
    }

    // ── UiForeground: only the MAIN process at FOREGROUND (100) or VISIBLE (200) counts ──

    private val pkg = "com.seekerclaw.app"
    private fun procs(vararg p: Pair<String, Int>) = p.map { UiForeground.Proc(it.first, it.second) }

    @Test
    fun `the main process on screen allows a screen to open`() {
        assertTrue(UiForeground.isVisible(procs(pkg to 100, "$pkg:node" to 125), pkg))
        assertTrue(UiForeground.isVisible(procs("$pkg:node" to 125, pkg to 200), pkg))
    }

    @Test
    fun `node's own foreground-service importance never counts as foreground`() {
        // `:node` runs the foreground service (125); the main process is cached or gone.
        assertTrue(!UiForeground.isVisible(procs("$pkg:node" to 125), pkg))
        assertTrue(!UiForeground.isVisible(procs("$pkg:node" to 100, pkg to 400), pkg))
        // 125 sits below VISIBLE (200), so a `<= VISIBLE` test would wrongly pass it.
        assertTrue(!UiForeground.isVisible(procs(pkg to 125), pkg))
    }

    @Test
    fun `a background, perceptible or missing main process does not count`() {
        for (importance in listOf(130, 230, 300, 325, 350, 400, 1000)) {
            assertTrue("importance $importance", !UiForeground.isVisible(procs(pkg to importance), pkg))
        }
        assertTrue(!UiForeground.isVisible(emptyList(), pkg))
        assertTrue(!UiForeground.isVisible(null, pkg))
    }

    // ── Source guards ───────────────────────────────────────────────────────

    private val src = File("src/main/java")
    private fun kotlinSources() = src.walkTopDown().filter { it.isFile && it.extension == "kt" }

    @Test
    fun `no Kotlin source sends an SMS or places a call by itself`() {
        val banned = Regex("""\bSmsManager\b|sendTextMessage|sendMultipartTextMessage|divideMessage|\bACTION_CALL\b""")
        val hits = kotlinSources().filter { banned.containsMatchIn(it.readText()) }.map { it.name }.toList()
        assertEquals(emptyList<String>(), hits)
    }

    @Test
    fun `every bridge function that opens a screen checks the foreground first`() {
        val bridge = File(src, "com/seekerclaw/app/bridge/AndroidBridge.kt").readText()
        val guard = "requireForegroundUi()?.let { return it }"
        val functions = Regex("""\n    (?:private |internal )?fun (\w+)\(""").findAll(bridge).toList()
        val openers = mutableListOf<String>()
        functions.forEachIndexed { i, m ->
            val body = bridge.substring(m.range.first, functions.getOrNull(i + 1)?.range?.first ?: bridge.length)
            val start = body.indexOf("startActivity(")
            if (start < 0) return@forEachIndexed
            val name = m.groupValues[1]
            openers += name
            val g = body.indexOf(guard)
            assertTrue("$name calls startActivity without the foreground check first", g in 0 until start)
        }
        assertEquals(
            listOf("handleContactsAdd", "handleCameraCapture", "handleAppsLaunch", "handleSolanaAuthorize", "handleSolanaSign", "handleSolanaSignOnly"),
            openers,
        )
    }

    @Test
    fun `drafts never put the body or the number in the notification`() {
        val notifier = File(src, "com/seekerclaw/app/bridge/DraftNotifier.kt").readText()
        for (call in listOf("setContentText", "setStyle", "setTicker", "setPublicVersion", "setSubText", "setLargeIcon")) {
            assertTrue("DraftNotifier must not call $call", !notifier.contains(".$call("))
        }
        assertTrue(notifier.contains(".setContentTitle(label)"))
        assertTrue(notifier.contains(".setLocalOnly(true)"))
        assertTrue(notifier.contains("PendingIntent.FLAG_IMMUTABLE or PendingIntent.FLAG_ONE_SHOT or PendingIntent.FLAG_CANCEL_CURRENT"))
    }

    @Test
    fun `Settings has a Notifications row and no SMS or Phone Calls row`() {
        val settings = File(src, "com/seekerclaw/app/ui/settings/SettingsScreen.kt").readText()
        assertTrue(settings.contains("label = \"Notifications\""))
        for (gone in listOf("SEND_SMS", "CALL_PHONE", "label = \"SMS\"", "label = \"Phone Calls\"")) {
            assertTrue("SettingsScreen still has $gone", !settings.contains(gone))
        }
        val platform = File(src, "com/seekerclaw/app/config/ConfigManager.kt").readText()
        assertTrue("PLATFORM.md lists no SMS / Phone permission", !platform.contains("SEND_SMS") && !platform.contains("CALL_PHONE"))
    }
}
