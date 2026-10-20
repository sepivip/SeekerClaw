package com.seekerclaw.app.bridge

import android.app.NotificationManager
import android.app.PendingIntent
import android.content.Context
import android.content.Intent
import android.content.pm.PackageManager
import android.net.Uri
import androidx.core.app.NotificationCompat
import com.seekerclaw.app.R
import com.seekerclaw.app.SeekerClawApplication
import java.security.SecureRandom
import java.util.Date
import java.util.Random

/**
 * BAT-1409 P1-H (contract v3.2, owner- and Codex-approved) — the agent's SMS and calls are
 * drafts: a notification the user taps to open their own SMS app or dialer, where they press
 * Send or Dial. Nothing is sent or dialled by the app itself, in either flavour.
 *
 * - Identity: a SecureRandom id in [DRAFT_ID_MIN, Int.MAX_VALUE), redrawn while it matches an
 *   active notification, is both the notification id and the PendingIntent request code, with
 *   FLAG_CANCEL_CURRENT | FLAG_ONE_SHOT | FLAG_IMMUTABLE — no draft can replace or reuse another,
 *   across `:node` restarts too.
 * - Privacy: no notification field carries the body or the number (Android ignores an app-set
 *   lock-screen visibility on the channel): a fixed label with the time only. Local only (no
 *   wearables). Expires after 15 minutes.
 * - Outcome: exactly one [Outcome]; nothing is posted unless it is [Outcome.POSTED].
 *
 * Every value the notification is built from comes from the pure [spec] ([DraftSpec]); what
 * Android reports and does goes through [DraftSystem], so both are testable on the JVM.
 */
class DraftNotifier internal constructor(
    private val system: DraftSystem,
    private val random: Random = SecureRandom(),
) {

    constructor(context: Context) : this(AndroidDraftSystem(context))

    enum class Kind { SMS, CALL }

    enum class Outcome(val code: String) {
        POSTED("posted"),
        NOTIFICATIONS_DISABLED("notifications_disabled"),
        NOTIFICATIONS_PAUSED("notifications_paused"),
        CHANNEL_BLOCKED("channel_blocked"),
        NO_HANDLER("no_handler"),
        INVALID_RECIPIENT("invalid_recipient"),
    }

    /** Posts a draft to [rawNumber] (for SMS with [body]). */
    fun post(kind: Kind, rawNumber: String?, body: String? = null): Outcome {
        val number = DraftRecipient.sanitize(rawNumber) ?: return Outcome.INVALID_RECIPIENT
        // Built only once every notification check passed (the active ids and the time are read
        // after them); the handler lookup and the notification use this same draft.
        val draft by lazy { spec(kind, number, body, system.timeText(), system.activeIds()) { drawId(random) } }
        firstRefusal(
            notificationsEnabled = system.areNotificationsEnabled(),
            notificationsPaused = system.areNotificationsPaused(),
            channelImportance = system.channelImportance(SeekerClawApplication.DRAFTS_CHANNEL_ID),
            hasHandler = { system.resolvesActivity(draft) },
        )?.let { return it }
        system.notify(draft.id, draft)
        return Outcome.POSTED
    }

    companion object {
        /** Above every fixed notification id the app uses (1, 2, 3, 9002). */
        const val DRAFT_ID_MIN = 100_000
        const val EXPIRY_MS = 15 * 60_000L

        /** One candidate draft id from [random], in [DRAFT_ID_MIN, Int.MAX_VALUE). */
        fun drawId(random: Random): Int = DRAFT_ID_MIN + random.nextInt(Int.MAX_VALUE - DRAFT_ID_MIN)

        /**
         * The draft for the sanitised [number]: the id is the first value from [draw] that is not
         * in [active] (the ids of the notifications showing now) and is also the PendingIntent
         * request code. The title is a fixed label with [timeText] only; the body travels in
         * `sms_body` (SMS only) and the number in the URI, never in a notification field.
         */
        fun spec(kind: Kind, number: String, body: String?, timeText: String, active: Set<Int>, draw: () -> Int): DraftSpec {
            val id = freshId(active, draw)
            return DraftSpec(
                kind = kind,
                id = id,
                requestCode = id,
                pendingIntentFlags = PendingIntent.FLAG_IMMUTABLE or PendingIntent.FLAG_ONE_SHOT or PendingIntent.FLAG_CANCEL_CURRENT,
                action = when (kind) {
                    Kind.SMS -> Intent.ACTION_SENDTO
                    Kind.CALL -> Intent.ACTION_DIAL
                },
                intentFlags = Intent.FLAG_ACTIVITY_NEW_TASK,
                uriScheme = when (kind) {
                    Kind.SMS -> "smsto"
                    Kind.CALL -> "tel"
                },
                number = number,
                extras = when (kind) {
                    Kind.SMS -> mapOf("sms_body" to body.orEmpty())
                    Kind.CALL -> emptyMap()
                },
                title = when (kind) {
                    Kind.SMS -> "Message draft · $timeText — tap to review"
                    Kind.CALL -> "Call draft · $timeText — tap to review"
                },
                channelId = SeekerClawApplication.DRAFTS_CHANNEL_ID,
                autoCancel = true,
                timeoutMs = EXPIRY_MS,
                localOnly = true,
                priority = NotificationCompat.PRIORITY_HIGH,
            )
        }

        private fun freshId(active: Set<Int>, draw: () -> Int): Int {
            while (true) {
                val id = draw()
                if (id !in active) return id
            }
        }

        /**
         * The bridge reply for [outcome]: 200 `{success: true, outcome: "posted"}`; otherwise
         * 400 (invalid_recipient) or 409 with `{error, outcome}` both set to the outcome code.
         * `tools/android.js` maps exactly this shape.
         */
        fun reply(outcome: Outcome): Pair<Int, Map<String, Any>> =
            if (outcome == Outcome.POSTED) {
                200 to mapOf("success" to true, "outcome" to outcome.code)
            } else {
                (if (outcome == Outcome.INVALID_RECIPIENT) 400 else 409) to mapOf("error" to outcome.code, "outcome" to outcome.code)
            }

        /**
         * After the recipient passed [DraftRecipient], the first reason a draft cannot be posted,
         * in the contract's order, or null to post it. Pure: the caller passes what Android
         * reports; a missing channel counts as blocked. [hasHandler] (an activity lookup) is only
         * asked when every notification check passed.
         */
        fun firstRefusal(
            notificationsEnabled: Boolean,
            notificationsPaused: Boolean,
            channelImportance: Int?,
            hasHandler: () -> Boolean,
        ): Outcome? = when {
            !notificationsEnabled -> Outcome.NOTIFICATIONS_DISABLED
            notificationsPaused -> Outcome.NOTIFICATIONS_PAUSED
            channelImportance == null || channelImportance == NotificationManager.IMPORTANCE_NONE -> Outcome.CHANNEL_BLOCKED
            !hasHandler() -> Outcome.NO_HANDLER
            else -> null
        }
    }
}

/** Every value a draft's intent, PendingIntent and notification are built from ([DraftNotifier.spec]). */
data class DraftSpec(
    val kind: DraftNotifier.Kind,
    /** The notification id. */
    val id: Int,
    /** The PendingIntent request code: always [id]. */
    val requestCode: Int,
    val pendingIntentFlags: Int,
    val action: String,
    val intentFlags: Int,
    val uriScheme: String,
    val number: String,
    val extras: Map<String, String>,
    val title: String,
    val channelId: String,
    val autoCancel: Boolean,
    val timeoutMs: Long,
    val localOnly: Boolean,
    val priority: Int,
) {
    /** Never prints the number or the body. */
    override fun toString(): String = "DraftSpec(kind=$kind, id=$id)"
}

/** What [DraftNotifier.post] needs from Android; [AndroidDraftSystem] is the real one. */
interface DraftSystem {
    fun areNotificationsEnabled(): Boolean
    fun areNotificationsPaused(): Boolean

    /** The channel's importance, or null when the channel does not exist. */
    fun channelImportance(channelId: String): Int?

    /** True when an activity (an SMS app or a dialer) handles the draft's intent. */
    fun resolvesActivity(spec: DraftSpec): Boolean

    /** The ids of this app's notifications showing now. */
    fun activeIds(): Set<Int>

    /** The time shown in the draft's label. */
    fun timeText(): String

    /** Posts notification [id], built only from [spec]. */
    fun notify(id: Int, spec: DraftSpec)
}

/** [DraftSystem] backed by NotificationManager and PackageManager. */
internal class AndroidDraftSystem(private val context: Context) : DraftSystem {

    private val nm: NotificationManager by lazy { context.getSystemService(NotificationManager::class.java) }

    override fun areNotificationsEnabled(): Boolean = nm.areNotificationsEnabled()

    override fun areNotificationsPaused(): Boolean = nm.areNotificationsPaused()

    override fun channelImportance(channelId: String): Int? = nm.getNotificationChannel(channelId)?.importance

    override fun resolvesActivity(spec: DraftSpec): Boolean =
        context.packageManager.resolveActivity(intentFor(spec), PackageManager.MATCH_DEFAULT_ONLY) != null

    override fun activeIds(): Set<Int> = nm.activeNotifications.map { it.id }.toSet()

    override fun timeText(): String = android.text.format.DateFormat.getTimeFormat(context).format(Date())

    override fun notify(id: Int, spec: DraftSpec) {
        val pending = PendingIntent.getActivity(context, spec.requestCode, intentFor(spec), spec.pendingIntentFlags)
        val notification = NotificationCompat.Builder(context, spec.channelId)
            .setSmallIcon(R.drawable.ic_notification)
            .setContentTitle(spec.title)
            .setContentIntent(pending)
            .setAutoCancel(spec.autoCancel)
            .setTimeoutAfter(spec.timeoutMs)
            .setLocalOnly(spec.localOnly)
            .setPriority(spec.priority)
            .build()
        nm.notify(id, notification)
    }

    /** SMS: SENDTO + `smsto:` + `sms_body`; call: DIAL + `tel:`; both with FLAG_ACTIVITY_NEW_TASK. */
    private fun intentFor(spec: DraftSpec): Intent =
        Intent(spec.action, Uri.fromParts(spec.uriScheme, spec.number, null))
            .apply { for ((key, value) in spec.extras) putExtra(key, value) }
            .addFlags(spec.intentFlags)
}
