package com.seekerclaw.app.state

/**
 * BAT-1157: how a Reset Config tombstone ended, for either OAuth token store.
 * - [CONFIRMED]: written and proven durable.
 * - [UNCONFIRMED]: the tombstone was written (it may be visible) but its durability, or the
 *   marker that follows it, is not confirmed. The reset keeps the Keystore key and prefs.
 * - [NOT_WRITTEN]: nothing changed for this store.
 */
enum class TombstoneOutcome { CONFIRMED, UNCONFIRMED, NOT_WRITTEN }
