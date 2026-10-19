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
 */
class DraftNotifier(private val context: Context) {

    enum class Kind { SMS, CALL }

    enum class Outcome(val code: String) {
        POSTED("posted"),
        NOTIFICATIONS_DISABLED("notifications_disabled"),
        NOTIFICATIONS_PAUSED("notifications_paused"),
        CHANNEL_BLOCKED("channel_blocked"),
        NO_HANDLER("no_handler"),
        INVALID_RECIPIENT("invalid_recipient"),
    }

    private val random = SecureRandom()

    /** Posts a draft to [rawNumber] (for SMS with [body]). */
    fun post(kind: Kind, rawNumber: String?, body: String? = null): Outcome {
        val number = DraftRecipient.sanitize(rawNumber) ?: return Outcome.INVALID_RECIPIENT
        val nm = context.getSystemService(NotificationManager::class.java)
        val intent = when (kind) {
            Kind.SMS -> Intent(Intent.ACTION_SENDTO, Uri.fromParts("smsto", number, null)).putExtra("sms_body", body.orEmpty())
            Kind.CALL -> Intent(Intent.ACTION_DIAL, Uri.fromParts("tel", number, null))
        }.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
        firstRefusal(
            notificationsEnabled = nm.areNotificationsEnabled(),
            notificationsPaused = nm.areNotificationsPaused(),
            channelImportance = nm.getNotificationChannel(SeekerClawApplication.DRAFTS_CHANNEL_ID)?.importance,
            hasHandler = { context.packageManager.resolveActivity(intent, PackageManager.MATCH_DEFAULT_ONLY) != null },
        )?.let { return it }

        val id = freshId(nm)
        val pending = PendingIntent.getActivity(
            context, id, intent,
            PendingIntent.FLAG_IMMUTABLE or PendingIntent.FLAG_ONE_SHOT or PendingIntent.FLAG_CANCEL_CURRENT,
        )
        val time = android.text.format.DateFormat.getTimeFormat(context).format(Date())
        val label = when (kind) {
            Kind.SMS -> "Message draft · $time — tap to review"
            Kind.CALL -> "Call draft · $time — tap to review"
        }
        val notification = NotificationCompat.Builder(context, SeekerClawApplication.DRAFTS_CHANNEL_ID)
            .setSmallIcon(R.drawable.ic_notification)
            .setContentTitle(label)
            .setContentIntent(pending)
            .setAutoCancel(true)
            .setTimeoutAfter(EXPIRY_MS)
            .setLocalOnly(true)
            .setPriority(NotificationCompat.PRIORITY_HIGH)
            .build()
        nm.notify(id, notification)
        return Outcome.POSTED
    }

    private fun freshId(nm: NotificationManager): Int {
        val active = nm.activeNotifications.map { it.id }.toSet()
        while (true) {
            val id = DRAFT_ID_MIN + random.nextInt(Int.MAX_VALUE - DRAFT_ID_MIN)
            if (id !in active) return id
        }
    }

    companion object {
        /** Above every fixed notification id the app uses (1, 2, 3, 9002). */
        const val DRAFT_ID_MIN = 100_000
        const val EXPIRY_MS = 15 * 60_000L

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
