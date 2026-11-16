package com.seekerclaw.app.state

import android.content.Context
import com.seekerclaw.app.config.SecretCodec
import com.seekerclaw.app.util.CrossProcessStore
import com.seekerclaw.app.util.SafeFs
import com.seekerclaw.app.util.SidecarFileLock
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.cancel
import kotlinx.serialization.Serializable
import java.io.File
import java.security.MessageDigest
import java.util.UUID
import java.util.concurrent.atomic.AtomicBoolean

/**
 * BAT-1157: the OpenAI ChatGPT sign-in token pair, in its own file (contracts v1–v4, Codex
 * sign-off `0fc1ead6`).
 *
 * ## Why it is not in `seekerclaw_prefs` any more
 * Both processes cache that file, and `commit()/apply()` writes the calling process's WHOLE cached
 * map. A token rotation in `:node` used to write back every setting as `:node` last saw it, and a
 * later MAIN save wrote back the old pair. Here the record lives in `files/openai_oauth.json`,
 * read from disk on every read and changed only under [LOCK_NAME].
 *
 * ## The record
 * Secrets are Keystore ciphertext ([SecretCodec]); `expiresAt`, `epoch`, `familyId`, `tombstone`
 * and `lastRotationId` are plaintext control fields. Every persisted record has `epoch >= 1`. Every
 * sign-in starts a new random `familyId`, so a rotation from an older session is rejected even if
 * the epoch numbers happen to match.
 *
 * ## Writes are checked
 * Every write is [CrossProcessStore.writeVerified]. [Result.Unconfirmed] means the rename happened
 * but its durability is unknown: the new bytes may be visible, yet a power cut could undo them.
 * A later step that depends on the write must not run, and a re-sync is no proof — only a fresh
 * confirmed rewrite is ([CrossProcessStore.rewriteVerified]).
 */
object OpenAIOAuthTokenStore {
    const val FILE_NAME = "openai_oauth.json"
    const val LOCK_NAME = "openai_oauth.lock"
    const val MARKER_NAME = "openai_oauth.migrated"

    private val initialized = AtomicBoolean(false)
    @Volatile private var ownedScope: CoroutineScope? = null
    @Volatile private var store: CrossProcessStore<OpenAIOAuthTokens>? = null
    @Volatile private var dir: File? = null
    @Volatile private var codec: SecretCodec = SecretCodec.Keystore

    private val sidecar = SidecarFileLock({ dir }, LOCK_NAME)

    val isInitialized: Boolean get() = store != null

    /** Idempotent. Call from `SeekerClawApplication.onCreate` in both processes. */
    fun init(context: Context) {
        if (!initialized.compareAndSet(false, true)) return
        val app = context.applicationContext
        dir = app.filesDir
        val scope = CoroutineScope(SupervisorJob() + Dispatchers.IO)
        ownedScope = scope
        store = CrossProcessStore(
            context = app,
            fileName = FILE_NAME,
            serializer = OpenAIOAuthTokens.serializer(),
            initial = OpenAIOAuthTokens(),
            parentScope = scope,
        )
    }

    // ------------------------------------------------------------------------------- reading

    sealed class State {
        /** No record file. */
        object Absent : State()

        /** A record file that does not decode, or decodes at epoch 0. Never a token source. */
        data class Unreadable(val reason: String) : State()

        data class Present(val record: OpenAIOAuthTokens) : State()
    }

    /**
     * The record as it is on disk now. One file read: the file is only ever replaced by an atomic
     * rename, so the pair, expiry, family and epoch always come from the same write.
     */
    fun snapshot(): State {
        val cps = store ?: return State.Unreadable("not initialized")
        return stateOf(cps)
    }

    private fun stateOf(cps: CrossProcessStore<OpenAIOAuthTokens>): State = when (val s = cps.readState()) {
        CrossProcessStore.ReadState.Absent -> State.Absent
        is CrossProcessStore.ReadState.Unreadable -> State.Unreadable(s.reason)
        is CrossProcessStore.ReadState.Present ->
            // Every persisted record has 1 <= epoch < Long.MAX_VALUE, so `epoch + 1` never overflows;
            // anything else is a corrupt record (contract: guard every field from persisted JSON).
            if (s.value.epoch < 1L || s.value.epoch == Long.MAX_VALUE) State.Unreadable("epoch ${s.value.epoch}")
            else State.Present(s.value)
    }

    fun markerExists(): Boolean = dir?.let { SafeFs.existsNoFollow(File(it, MARKER_NAME).toPath()) } ?: false

    /** Decrypts [enc]: `""` for a blank field, `null` when a non-blank field does not decrypt. */
    fun open(enc: String): String? {
        if (enc.isBlank()) return ""
        return try {
            codec.open(enc)
        } catch (_: Exception) {
            null
        }
    }

    /** The decrypted pair of a live record, or null (absent, unreadable, tombstone, undecryptable). */
    data class LivePair(val access: String, val refresh: String, val email: String, val record: OpenAIOAuthTokens)

    fun livePair(state: State): LivePair? {
        val r = (state as? State.Present)?.record ?: return null
        if (r.tombstone) return null
        val access = open(r.accessTokenEnc)?.takeIf { it.isNotBlank() } ?: return null
        val refresh = open(r.refreshTokenEnc) ?: return null
        return LivePair(access, refresh, open(r.emailEnc).orEmpty(), r)
    }

    /**
     * A live record whose access token decrypts. Equivalent to a non-blank `AppConfig.openaiOAuthToken`
     * once migrated (the config load decrypts the same single read); the config value additionally
     * covers the legacy pair before its migration is confirmed. Used by BAT-1661's repair scope.
     */
    fun hasUsableToken(): Boolean = livePair(snapshot()) != null

    // ------------------------------------------------------------------------------- writing

    sealed class Result {
        data class Ok(val record: OpenAIOAuthTokens) : Result()

        /** The CAS failed: a tombstone, another family, or another epoch. Nothing was written. */
        data class Conflict(val currentEpoch: Long) : Result()

        /** The rename happened, durability unknown. The dependent step must not run. */
        data class Unconfirmed(val reason: String) : Result()

        /** Nothing was written (lock timeout, encryption or filesystem failure). */
        data class Failed(val reason: String) : Result()
    }

    private fun <R> locked(onNotAcquired: (String) -> R, action: (CrossProcessStore<OpenAIOAuthTokens>) -> R): R {
        val cps = store ?: return onNotAcquired("not initialized")
        return when (val o = sidecar.withLock { action(cps) }) {
            is SidecarFileLock.Outcome.Ran -> o.value
            is SidecarFileLock.Outcome.NotAcquired -> onNotAcquired(o.reason)
        }
    }

    private fun persist(cps: CrossProcessStore<OpenAIOAuthTokens>, next: OpenAIOAuthTokens): Result = try {
        cps.writeVerified(next)
        Result.Ok(next)
    } catch (e: SafeFs.WriteUnconfirmed) {
        Result.Unconfirmed(e.message ?: "unconfirmed")
    } catch (e: Exception) {
        Result.Failed(e.message ?: e.javaClass.simpleName)
    }

    /** Writes the migration marker if it is missing. Throws a [SafeFs.VerifiedWriteException]. */
    private fun ensureMarker() {
        val d = dir ?: throw SafeFs.WriteNotApplied("not initialized")
        val marker = File(d, MARKER_NAME).toPath()
        if (!SafeFs.existsNoFollow(marker)) SafeFs.writeAtomicVerified(d.toPath(), marker, "1".toByteArray())
    }

    private fun currentEpoch(state: State): Long = (state as? State.Present)?.record?.epoch ?: 0L

    /**
     * MAIN sign-in: a new family. Encrypts INSIDE the lock, inherits nothing from the previous
     * record (a blank refresh token or email stays blank), and completes the migration (marker).
     * The caller runs it inside `ResetGate`'s commit section.
     */
    fun signIn(accessToken: String, refreshToken: String, email: String, expiresAt: String): Result =
        locked({ Result.Failed(it) }) { cps ->
            val cur = stateOf(cps)
            val next = try {
                OpenAIOAuthTokens(
                    accessTokenEnc = codec.seal(accessToken),
                    refreshTokenEnc = if (refreshToken.isBlank()) "" else codec.seal(refreshToken),
                    emailEnc = if (email.isBlank()) "" else codec.seal(email),
                    expiresAt = expiresAt,
                    epoch = currentEpoch(cur) + 1L,
                    familyId = UUID.randomUUID().toString(),
                )
            } catch (e: Exception) {
                return@locked Result.Failed("encrypt: ${e.javaClass.simpleName}")
            }
            when (val r = persist(cps, next)) {
                // The record is written (visible) either way: a marker failure is Unconfirmed, never
                // Failed ("nothing changed").
                is Result.Ok -> try {
                    ensureMarker(); r
                } catch (e: Exception) {
                    Result.Unconfirmed("marker: ${e.javaClass.simpleName}")
                }
                else -> r
            }
        }

    /** MAIN sign-out: a checked tombstone (epoch advanced), and the marker if it is missing. */
    fun signOut(): Result = locked({ Result.Failed(it) }) { cps -> signOutIn(cps) }

    private fun signOutIn(cps: CrossProcessStore<OpenAIOAuthTokens>): Result {
        val next = OpenAIOAuthTokens(tombstone = true, epoch = currentEpoch(stateOf(cps)) + 1L)
        return when (val r = persist(cps, next)) {
            // The tombstone is written (visible) either way: a marker failure is Unconfirmed, so a
            // reset reports it as such and never as "nothing changed".
            is Result.Ok -> try {
                ensureMarker(); r
            } catch (e: Exception) {
                Result.Unconfirmed("marker: ${e.javaClass.simpleName}")
            }
            else -> r
        }
    }

    /**
     * `:node` token rotation (`/openai/oauth/save-tokens`). Under the lock:
     * - a tombstone, another family or another epoch → [Result.Conflict];
     * - the record already at `expectedEpoch + 1` with the same [rotationId] (a re-send whose first
     *   reply was lost, or whose first write was unconfirmed) → the identical bytes are REWRITTEN
     *   with a fresh checked write and the record returned; never a second epoch bump;
     * - otherwise the new pair, epoch + 1. A blank [refreshToken] keeps the stored ciphertext.
     */
    fun rotate(
        familyId: String,
        expectedEpoch: Long,
        rotationId: String,
        accessToken: String,
        refreshToken: String,
        expiresAt: String,
    ): Result = locked({ Result.Failed(it) }) { cps ->
        // Absent or Unreadable is a storage fault, not a newer sign-in: a 503 keeps Node's (only
        // valid) pair and re-sends; a 409 would latch and drop it. A sign-out is always a tombstone.
        val cur = (stateOf(cps) as? State.Present)?.record ?: return@locked Result.Failed("record not readable")
        if (cur.tombstone || cur.familyId != familyId) return@locked Result.Conflict(cur.epoch)
        if (cur.epoch == expectedEpoch + 1L && rotationId.isNotEmpty() && cur.lastRotationId == rotationId) {
            return@locked try {
                cps.rewriteVerified()
                Result.Ok(cur)
            } catch (e: SafeFs.WriteUnconfirmed) {
                Result.Unconfirmed(e.message ?: "unconfirmed")
            } catch (e: Exception) {
                Result.Failed(e.message ?: e.javaClass.simpleName)
            }
        }
        if (cur.epoch != expectedEpoch) return@locked Result.Conflict(cur.epoch)
        val next = try {
            cur.copy(
                accessTokenEnc = codec.seal(accessToken),
                refreshTokenEnc = if (refreshToken.isBlank()) cur.refreshTokenEnc else codec.seal(refreshToken),
                expiresAt = expiresAt,
                epoch = cur.epoch + 1L,
                lastRotationId = rotationId,
            )
        } catch (e: Exception) {
            return@locked Result.Failed("encrypt: ${e.javaClass.simpleName}")
        }
        persist(cps, next)
    }

    // ------------------------------------------------------------------------------ migration

    /** The legacy prefs values, copied as ciphertext. [plainEmail] is the pre-encryption key. */
    data class LegacyPair(
        val accessEnc: String,
        val refreshEnc: String,
        val emailEnc: String,
        val expiresAt: String,
        val plainEmail: String,
    )

    enum class MigrateOutcome {
        /** The marker exists (now or already): the store is the only source from here on. */
        DONE,

        /** A write failed or was unconfirmed: no marker, the legacy pair stays the source. */
        NOT_CONFIRMED,

        /** The record is unreadable: no import, no marker. Signed out until a new sign-in. */
        UNREADABLE,

        NOT_INITIALIZED,
    }

    /**
     * Fill-only migration, in either process (contract v2 §1). Under the lock: a marker means
     * done; an Absent store is filled from [legacy] (checked), then the marker (checked); a Present
     * record (live or tombstone) gets only the marker; an Unreadable one gets neither. [legacy] is
     * read from prefs through `PrefsReader` and never decrypted; it is only invoked when needed.
     */
    fun migrateIfNeeded(legacy: () -> LegacyPair?): MigrateOutcome {
        if (store == null) return MigrateOutcome.NOT_INITIALIZED
        if (markerExists()) return MigrateOutcome.DONE
        return locked({ MigrateOutcome.NOT_CONFIRMED }) { cps -> migrateIn(cps, legacy) }
    }

    private fun migrateIn(cps: CrossProcessStore<OpenAIOAuthTokens>, legacy: () -> LegacyPair?): MigrateOutcome {
        if (markerExists()) return MigrateOutcome.DONE
        when (stateOf(cps)) {
            is State.Unreadable -> return MigrateOutcome.UNREADABLE
            is State.Present -> Unit
            State.Absent -> {
                val l = legacy()
                if (l != null && l.accessEnc.isNotBlank()) {
                    val emailEnc = when {
                        l.emailEnc.isNotBlank() -> l.emailEnc
                        l.plainEmail.isNotBlank() -> try {
                            codec.seal(l.plainEmail)
                        } catch (_: Exception) {
                            ""
                        }
                        else -> ""
                    }
                    val filled = OpenAIOAuthTokens(
                        accessTokenEnc = l.accessEnc,
                        refreshTokenEnc = l.refreshEnc,
                        emailEnc = emailEnc,
                        expiresAt = l.expiresAt,
                        epoch = 1L,
                        familyId = UUID.randomUUID().toString(),
                    )
                    if (persist(cps, filled) !is Result.Ok) return MigrateOutcome.NOT_CONFIRMED
                }
            }
        }
        return try {
            ensureMarker()
            MigrateOutcome.DONE
        } catch (_: Exception) {
            MigrateOutcome.NOT_CONFIRMED
        }
    }

    /**
     * Before MAIN sweeps the legacy keys: in THIS process, the record must read Present and be
     * confirmed durable by a fresh checked rewrite, and the marker likewise. A marker left behind by
     * a failed sync is visible but proves nothing, so it is rewritten too.
     */
    fun confirmedForSweep(): Boolean = locked({ false }) { cps ->
        if (!markerExists()) return@locked false
        val state = stateOf(cps)
        // Absent + marker: the migration found no legacy token, so only inert keys (expiry, a
        // plaintext email) can remain; the marker alone must be proven durable.
        if (state is State.Unreadable) return@locked false
        try {
            if (state is State.Present) cps.rewriteVerified()
            val d = dir ?: return@locked false
            SafeFs.rewriteVerified(d.toPath(), File(d, MARKER_NAME).toPath())
            true
        } catch (_: Exception) {
            false
        }
    }

    // ---------------------------------------------------------------------- confirm-family

    sealed class ConfirmOutcome {
        data class Confirmed(val familyId: String, val epoch: Long) : ConfirmOutcome()

        /** Signed out or unusable (absent, unreadable, tombstone, refresh token undecryptable). */
        object Reconnect : ConfirmOutcome()

        /** Another sign-in, another refresh token, or another epoch. */
        object FamilyChanged : ConfirmOutcome()

        /** A migration or confirmation write failed or was unconfirmed: no refresh. */
        data class NotConfirmed(val reason: String) : ConfirmOutcome()
    }

    /**
     * `/openai/oauth/confirm-family` (contract v4 + Codex C1). Node may refresh only after this
     * returns [ConfirmOutcome.Confirmed] in its own process. Under the lock, in order:
     * 1. `familyId == null` (legacy boot), store Absent, no marker → the fill-only migration first;
     * 2. unusable → [ConfirmOutcome.Reconnect];
     * 3. mismatch → [ConfirmOutcome.FamilyChanged]. For a non-null family: another family, another
     *    refresh token, or an epoch different from [epoch]. For a null family (C1): only the
     *    fingerprint is compared; [epoch] must be 0 and is never compared with the stored epoch;
     * 4. otherwise the record and the marker are REWRITTEN byte-identical with checked writes (no
     *    epoch change, `lastRotationId` kept) and the real family and epoch are returned.
     */
    fun confirmFamily(
        familyId: String?,
        epoch: Long,
        refreshFingerprint: String,
        legacy: () -> LegacyPair?,
    ): ConfirmOutcome = locked({ ConfirmOutcome.NotConfirmed(it) }) { cps ->
        if (familyId == null && stateOf(cps) == State.Absent && !markerExists()) {
            if (migrateIn(cps, legacy) != MigrateOutcome.DONE) return@locked ConfirmOutcome.NotConfirmed("migration")
        }
        val record = (stateOf(cps) as? State.Present)?.record ?: return@locked ConfirmOutcome.Reconnect
        if (record.tombstone) return@locked ConfirmOutcome.Reconnect
        val refresh = open(record.refreshTokenEnc)?.takeIf { it.isNotBlank() } ?: return@locked ConfirmOutcome.Reconnect
        if (familyId == null && epoch != 0L) return@locked ConfirmOutcome.FamilyChanged // legacy requests carry 0
        if (familyId != null && (record.familyId != familyId || record.epoch != epoch)) {
            return@locked ConfirmOutcome.FamilyChanged
        }
        if (!fingerprintMatches(refresh, refreshFingerprint)) return@locked ConfirmOutcome.FamilyChanged
        try {
            cps.rewriteVerified()
            ensureMarker()
            val d = dir ?: return@locked ConfirmOutcome.NotConfirmed("not initialized")
            SafeFs.rewriteVerified(d.toPath(), File(d, MARKER_NAME).toPath())
        } catch (e: Exception) {
            return@locked ConfirmOutcome.NotConfirmed(e.javaClass.simpleName)
        }
        ConfirmOutcome.Confirmed(record.familyId, record.epoch)
    }

    /** The canonical form Node's `normalizeSecret` produces: line breaks removed, then trimmed. */
    internal fun canonicalSecret(s: String): String = s.replace(LINE_BREAKS, "").trim()

    private val LINE_BREAKS = Regex("[\r\n  ]+")

    /** Lowercase hex SHA-256 of the canonical form of [secret]. Never logged. */
    internal fun fingerprint(secret: String): String =
        MessageDigest.getInstance("SHA-256").digest(canonicalSecret(secret).toByteArray(Charsets.UTF_8))
            .joinToString("") { "%02x".format(it) }

    /**
     * Whether [requestHex], the fingerprint Node sent, belongs to [storedRefresh], the decrypted
     * refresh token in the record.
     */
    internal fun fingerprintMatches(storedRefresh: String, requestHex: String): Boolean {
        // Untrusted input: anything but 64 hex digits fails closed (no throw). Case-insensitive,
        // since hex case carries no meaning; compared as raw digest bytes in constant time.
        val req = requestHex.trim().lowercase()
        if (req.length != 64 || req.any { it !in '0'..'9' && it !in 'a'..'f' }) return false
        if (canonicalSecret(storedRefresh).isEmpty()) return false
        val expected = MessageDigest.getInstance("SHA-256").digest(canonicalSecret(storedRefresh).toByteArray(Charsets.UTF_8))
        val given = ByteArray(32) { i -> req.substring(i * 2, i * 2 + 2).toInt(16).toByte() }
        return MessageDigest.isEqual(expected, given)
    }

    // ------------------------------------------------------------------- Reset Config hooks

    /** Runs [action] holding this store's lock; for `ConfigManager.resetConfig` only (this lock first, then xAI's). */
    internal fun <R> withLockForReset(action: () -> R): SidecarFileLock.Outcome<R> = sidecar.withLock(action = action)

    /** The reset's tombstone under an already-held [withLockForReset]. */
    internal fun signOutLocked(): TombstoneOutcome {
        check(sidecar.isHeldByCurrentThread) { "signOutLocked requires withLockForReset" }
        val cps = store ?: return TombstoneOutcome.NOT_WRITTEN
        return when (signOutIn(cps)) {
            is Result.Ok -> TombstoneOutcome.CONFIRMED
            is Result.Unconfirmed -> TombstoneOutcome.UNCONFIRMED
            else -> TombstoneOutcome.NOT_WRITTEN
        }
    }

    // ------------------------------------------------------------------------- test seams

    internal fun initForTest(filesDir: File, testCodec: SecretCodec) {
        resetForTest()
        initialized.set(true)
        dir = filesDir
        codec = testCodec
        store = CrossProcessStore(
            filesDir = filesDir,
            fileName = FILE_NAME,
            serializer = OpenAIOAuthTokens.serializer(),
            initial = OpenAIOAuthTokens(),
        )
    }

    internal fun resetForTest() {
        ownedScope?.cancel()
        ownedScope = null
        store?.close()
        store = null
        dir = null
        codec = SecretCodec.Keystore
        initialized.set(false)
    }
}

/** BAT-1157: the persisted OpenAI sign-in record. See [OpenAIOAuthTokenStore]. */
@Serializable
data class OpenAIOAuthTokens(
    val accessTokenEnc: String = "",
    val refreshTokenEnc: String = "",
    val emailEnc: String = "",
    val expiresAt: String = "",
    /** Monotonic revision; every persisted record is >= 1. */
    val epoch: Long = 0L,
    /** Random id of the sign-in this pair belongs to; blank on a tombstone. */
    val familyId: String = "",
    /** A sign-out: no token material. */
    val tombstone: Boolean = false,
    /** The rotation id of the last applied save, so a re-sent save is recognised. */
    val lastRotationId: String = "",
)
