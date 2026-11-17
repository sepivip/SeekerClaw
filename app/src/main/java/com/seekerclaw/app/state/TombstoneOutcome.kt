package com.seekerclaw.app.state

/**
 * BAT-1157: how a Reset Config tombstone ended, for either OAuth token store.
 * - [CONFIRMED]: written and proven durable.
 * - [UNCONFIRMED]: the tombstone was written (it may be visible) but its durability, or the
 *   marker that follows it, is not confirmed. The reset keeps the Keystore key and prefs.
 * - [NOT_WRITTEN]: nothing changed for this store.
 */
enum class TombstoneOutcome { CONFIRMED, UNCONFIRMED, NOT_WRITTEN }

/**
 * BAT-1157 (Codex diff review #1): may MAIN drop the legacy prefs keys of an OAuth store?
 * - [CONFIRMED]: the marker, and the record when present, were proven durable in this process.
 * - [NOT_CONFIRMED]: not proven now (unreadable, a failed rewrite, no marker); retry later.
 * - [KEEP_LEGACY]: the store is Absent with a marker while prefs still hold a legacy access
 *   token. That token may be the only surviving copy (a record lost to a power cut after its
 *   marker), so it is never swept, and the store is never refilled from it either: the install
 *   is adopted, and only a new sign-in writes the store. The caller logs it once and stops trying.
 */
enum class SweepGate { CONFIRMED, NOT_CONFIRMED, KEEP_LEGACY }
