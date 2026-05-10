package com.seekerclaw.app.ui.settings.wallet

import android.content.ClipData
import android.content.ClipboardManager
import android.content.Context
import android.view.WindowManager
import android.widget.Toast
import androidx.activity.ComponentActivity
import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.DisposableEffect
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.setValue
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.platform.LocalView
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.sp
import com.seekerclaw.app.data.caps.CapEnforcer
import com.seekerclaw.app.data.wallet.EncryptedPrefsKeyVault
import com.seekerclaw.app.data.wallet.KeyImporter
import com.seekerclaw.app.data.wallet.SolanaBalanceFetcher
import com.seekerclaw.app.ui.components.ActionResult
import com.seekerclaw.app.ui.components.CardSurface
import com.seekerclaw.app.ui.components.MorphActionButton
import com.seekerclaw.app.ui.components.PrimaryButton
import com.seekerclaw.app.ui.components.SecondaryButton
import com.seekerclaw.app.ui.components.SeekerClawScaffold
import com.seekerclaw.app.ui.components.SectionLabel
import com.seekerclaw.app.ui.settings.wallet.components.BurnerCaps
import com.seekerclaw.app.ui.settings.wallet.components.CapsConfigSection
import com.seekerclaw.app.ui.settings.wallet.components.DangerZoneSection
import com.seekerclaw.app.ui.settings.wallet.components.KeyInputField
import com.seekerclaw.app.ui.settings.wallet.components.WalletStatusCard
import com.seekerclaw.app.ui.settings.wallet.components.copyToClipboard
import androidx.compose.foundation.clickable
import androidx.compose.ui.hapticfeedback.HapticFeedbackType
import androidx.compose.ui.platform.LocalHapticFeedback
import com.seekerclaw.app.ui.theme.RethinkSans
import com.seekerclaw.app.ui.theme.SeekerClawColors
import com.seekerclaw.app.ui.theme.Spacing
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext
import java.math.BigInteger

private const val BURNER_ID = "burner"

/**
 * BurnerWalletScreen — Settings UI for the autonomous Burner Wallet
 * (BAT-582 Phase 3). One screen, three modes:
 *
 *   1. **Empty** — no burner configured. Hero warning + masked paste field
 *      + Test/Save flow. Once Save lands, transitions to Configured mode.
 *   2. **Configured** — burner exists. Status card + caps editor +
 *      danger zone (wipe/rotate). Transitions to Empty after wipe.
 *   3. **Rotating** — wipe completed but a new key hasn't been pasted
 *      yet. Identical to Empty but with a "rotating" status hint.
 *
 * **Security contract:**
 *   - `FLAG_SECURE` is set on the host Activity's window for the
 *     lifetime of this composable. Screenshots and screen recordings
 *     are blocked. Cleared on dispose so the rest of the app can be
 *     captured normally.
 *   - The masked input uses [PasswordVisualTransformation] (in
 *     [KeyInputField]); the raw key never appears on screen.
 *   - Per-process direct calls to [EncryptedPrefsKeyVault] and
 *     [CapEnforcer] — the burner UI does NOT round-trip through the
 *     localhost bridge. The key import path runs entirely inside the
 *     UI process; bridge endpoints exist for Node-side callers
 *     (Phase 4+).
 *   - Save button is gated on a successful Test, so we never persist
 *     a key that didn't pass the [KeyImporter] validator. After save,
 *     the input field is cleared and the raw value is no longer held
 *     in any state object.
 *
 * **No QR yet** — the BAT-582 contract calls for a QR alongside the
 * copyable address post-save. zxing-core is declared in libs.versions.toml
 * but NOT wired into app/build.gradle.kts as an active dependency, and
 * Phase 3 hard rules forbid adding new deps. Address shows as copyable
 * text only; QR generator deferred to a follow-up phase that can ship
 * the dep change with explicit user approval.
 */
@Composable
fun BurnerWalletScreen(onBack: () -> Unit) {
    SecureWindow()

    val context = LocalContext.current
    val scope = rememberCoroutineScope()
    val keyVault = remember { EncryptedPrefsKeyVault(context.applicationContext) }
    val capEnforcer = remember { CapEnforcer.get(context.applicationContext) }
    val balanceFetcher = remember { SolanaBalanceFetcher() }

    // Loaded state (refreshes when caps file changes via CrossProcessStore
    // or after an explicit save).
    var pubkey by remember { mutableStateOf<String?>(null) }
    var status by remember { mutableStateOf<CapEnforcer.CapStatus?>(null) }
    var loaded by remember { mutableStateOf(false) }
    // Bumped on save/wipe so the LaunchedEffect re-runs and reloads state.
    var refreshKey by remember { mutableStateOf(0) }

    // Balance state — fetched from Solana RPC on screen open + refresh tap.
    // null = not yet fetched / fetch failed → UI shows "balance unavailable".
    var balances by remember { mutableStateOf<SolanaBalanceFetcher.Balances?>(null) }
    var balancesLoading by remember { mutableStateOf(false) }
    // Auto-fetch when pubkey first becomes known.
    var lastFetchedPubkey by remember { mutableStateOf<String?>(null) }

    LaunchedEffect(refreshKey) {
        val pk = withContext(Dispatchers.IO) {
            try {
                keyVault.getPubkey(BURNER_ID)
            } catch (_: Exception) {
                null
            }
        }
        val s = withContext(Dispatchers.IO) {
            try {
                capEnforcer.status()
            } catch (_: Exception) {
                null
            }
        }
        pubkey = pk
        status = s
        loaded = true
    }

    // Fetch balances once per pubkey-change. Bumping `refreshKey` doesn't
    // refetch on its own — explicit refresh tap goes through `refreshBalances`
    // below. Wiped pubkey clears the cached balance so the next
    // configured-state load shows "—" until the fetch completes.
    LaunchedEffect(pubkey) {
        val pk = pubkey
        if (pk == null) {
            balances = null
            lastFetchedPubkey = null
            return@LaunchedEffect
        }
        if (lastFetchedPubkey == pk && balances != null) return@LaunchedEffect
        balancesLoading = true
        val fetched = withContext(Dispatchers.IO) { balanceFetcher.fetch(pk) }
        balances = fetched
        balancesLoading = false
        lastFetchedPubkey = pk
    }

    val refreshBalances: () -> Unit = {
        val pk = pubkey
        if (pk != null && !balancesLoading) {
            scope.launch {
                balancesLoading = true
                val fetched = withContext(Dispatchers.IO) { balanceFetcher.fetch(pk) }
                balances = fetched
                balancesLoading = false
            }
        }
    }

    SeekerClawScaffold(title = "Burner wallet", onBack = onBack) { padding ->
        Column(
            modifier = Modifier
                .fillMaxSize()
                .background(SeekerClawColors.Background)
                .padding(padding)
                .verticalScroll(rememberScrollState())
                .padding(horizontal = Spacing.lg, vertical = Spacing.lg),
            verticalArrangement = Arrangement.spacedBy(Spacing.lg),
        ) {
            HeroBanner()

            if (!loaded) {
                Text(
                    text = "Loading…",
                    fontFamily = RethinkSans,
                    fontSize = 13.sp,
                    color = SeekerClawColors.TextDim,
                )
            } else if (pubkey == null) {
                EmptyStateSection(
                    keyVault = keyVault,
                    onSaved = {
                        refreshKey += 1
                    },
                )
            } else {
                ConfiguredStateSection(
                    pubkey = pubkey!!,
                    status = status,
                    balances = balances,
                    balancesLoading = balancesLoading,
                    onRefreshBalances = refreshBalances,
                    onCapsChanged = { caps ->
                        scope.launch {
                            saveCaps(context, capEnforcer, caps)
                            refreshKey += 1
                        }
                    },
                    onWipe = {
                        scope.launch {
                            wipeBurner(context, keyVault, capEnforcer)
                            refreshKey += 1
                        }
                    },
                    onRotate = {
                        scope.launch {
                            wipeBurner(context, keyVault, capEnforcer)
                            refreshKey += 1
                        }
                    },
                )
            }

            Spacer(Modifier.height(Spacing.xl))
        }
    }
}

/**
 * SecureWindow — sets [WindowManager.LayoutParams.FLAG_SECURE] on the
 * host Activity's window for the lifetime of the composable, then
 * clears it on dispose.
 *
 * **Why this matters:** without FLAG_SECURE, Android's screen recording
 * and (on rooted/test devices) screenshot APIs would capture the masked
 * input field's raw value out of the View hierarchy. The mask is a
 * visual layer only — the underlying TextField holds plaintext.
 *
 * The flag is set on the host [ComponentActivity] window. If the
 * composable is hosted outside an Activity (e.g. `@Preview`), the
 * effect is a no-op.
 */
@Composable
private fun SecureWindow() {
    val view = LocalView.current
    DisposableEffect(view) {
        val window = (view.context as? ComponentActivity)?.window
        window?.setFlags(
            WindowManager.LayoutParams.FLAG_SECURE,
            WindowManager.LayoutParams.FLAG_SECURE,
        )
        onDispose {
            window?.clearFlags(WindowManager.LayoutParams.FLAG_SECURE)
        }
    }
}

@Composable
private fun HeroBanner() {
    val shape = RoundedCornerShape(SeekerClawColors.CornerRadius)
    Column(
        modifier = Modifier
            .fillMaxWidth()
            .background(SeekerClawColors.Error.copy(alpha = 0.10f), shape)
            .padding(Spacing.lg),
        verticalArrangement = Arrangement.spacedBy(Spacing.sm),
    ) {
        Text(
            text = "EXPERIMENTAL",
            fontFamily = RethinkSans,
            fontSize = 11.sp,
            fontWeight = FontWeight.ExtraBold,
            color = SeekerClawColors.Error,
        )
        Text(
            text = "Burner uses Solana mainnet. Funds can be lost. Treat as disposable. SeekerClaw cannot recover this key.",
            fontFamily = RethinkSans,
            fontSize = 13.sp,
            color = SeekerClawColors.TextPrimary,
            lineHeight = 18.sp,
        )
    }
}

/* -------------------------------------------------------------------- */
/* Empty state                                                          */
/* -------------------------------------------------------------------- */

@Composable
private fun EmptyStateSection(
    keyVault: EncryptedPrefsKeyVault,
    onSaved: () -> Unit,
) {
    val context = LocalContext.current
    val scope = rememberCoroutineScope()

    var keyInput by remember { mutableStateOf("") }
    var testState by remember { mutableStateOf<ActionResult>(ActionResult.Idle) }
    // The 64-byte expanded form survives between Test and Save so we
    // don't re-import. Cleared aggressively on input change / save / wipe.
    var stagedExpanded by remember { mutableStateOf<ByteArray?>(null) }
    var stagedPubkey by remember { mutableStateOf<String?>(null) }
    var showClipboardAdvisory by remember { mutableStateOf(false) }

    // Reset stale test state if user edits the field.
    LaunchedEffect(keyInput) {
        if (testState !is ActionResult.Idle) testState = ActionResult.Idle
        // Editing always invalidates the staged-key snapshot.
        stagedExpanded?.let { java.util.Arrays.fill(it, 0.toByte()) }
        stagedExpanded = null
        stagedPubkey = null
    }

    CardSurface {
        Text(
            text = "Set up burner",
            fontFamily = RethinkSans,
            fontSize = 14.sp,
            fontWeight = FontWeight.ExtraBold,
            color = SeekerClawColors.TextPrimary,
        )
        Spacer(Modifier.height(Spacing.sm))
        Text(
            text = "Paste a base58 private key or a Solana CLI JSON byte array. The key is encrypted on this device — Node never sees it.",
            fontFamily = RethinkSans,
            fontSize = 12.sp,
            color = SeekerClawColors.TextDim,
            lineHeight = 17.sp,
        )
        Spacer(Modifier.height(Spacing.lg))

        KeyInputField(
            value = keyInput,
            onValueChange = { keyInput = it },
            onPaste = { showClipboardAdvisory = true },
            isError = testState is ActionResult.Error,
        )

        if (showClipboardAdvisory) {
            Spacer(Modifier.height(Spacing.sm))
            ClipboardAdvisoryRow(
                onClear = {
                    val cm = context.getSystemService(Context.CLIPBOARD_SERVICE) as ClipboardManager
                    cm.setPrimaryClip(ClipData.newPlainText("", ""))
                    Toast.makeText(context, "Clipboard cleared", Toast.LENGTH_SHORT).show()
                    showClipboardAdvisory = false
                },
            )
        }

        Spacer(Modifier.height(Spacing.lg))

        MorphActionButton(
            state = testState,
            idleLabel = "Test",
            enabled = keyInput.isNotBlank() && testState !is ActionResult.Loading,
            onClick = {
                testState = ActionResult.Loading
                scope.launch {
                    val outcome = withContext(Dispatchers.Default) {
                        KeyImporter.import(keyInput)
                    }
                    when (outcome) {
                        is KeyImporter.Result.Ok -> {
                            // Stage the canonical bytes for Save. We
                            // deliberately do NOT re-emit the import
                            // result text — it would echo derivation
                            // info that's just noise.
                            stagedExpanded?.let { java.util.Arrays.fill(it, 0.toByte()) }
                            stagedExpanded = outcome.expanded64.copyOf()
                            stagedPubkey = base58OrFallback(outcome.pubkey)
                            // Round-trip clear the temp KeyImporter
                            // result bytes.
                            java.util.Arrays.fill(outcome.expanded64, 0.toByte())
                            testState = ActionResult.Success("Will sign as ${truncatePubkey(stagedPubkey!!)}")
                        }
                        is KeyImporter.Result.Err -> {
                            testState = ActionResult.Error(humanizeError(outcome.code))
                        }
                    }
                }
            },
        )

        Spacer(Modifier.height(Spacing.md))

        PrimaryButton(
            onClick = {
                val expanded = stagedExpanded ?: return@PrimaryButton
                scope.launch {
                    try {
                        withContext(Dispatchers.IO) {
                            // KeyVault.store wipes the input array; pass
                            // a copy so the caller-side reference can
                            // also be zeroed.
                            keyVault.store(BURNER_ID, expanded.copyOf())
                        }
                        Toast.makeText(context, "Burner saved", Toast.LENGTH_SHORT).show()
                        // Clear local copies aggressively post-save.
                        java.util.Arrays.fill(expanded, 0.toByte())
                        stagedExpanded = null
                        stagedPubkey = null
                        keyInput = ""
                        testState = ActionResult.Idle
                        onSaved()
                    } catch (e: Exception) {
                        testState = ActionResult.Error("Save failed: ${e.message ?: e.javaClass.simpleName}")
                    }
                }
            },
            label = "Save burner",
            modifier = Modifier.fillMaxWidth(),
            enabled = stagedExpanded != null,
        )
    }
}

@Composable
private fun ClipboardAdvisoryRow(onClear: () -> Unit) {
    val shape = RoundedCornerShape(SeekerClawColors.CornerRadius)
    Column(
        modifier = Modifier
            .fillMaxWidth()
            .background(SeekerClawColors.Warning.copy(alpha = 0.10f), shape)
            .padding(Spacing.md),
        verticalArrangement = Arrangement.spacedBy(Spacing.sm),
    ) {
        Text(
            text = "Your clipboard may still contain the key you pasted. Clear it before continuing.",
            fontFamily = RethinkSans,
            fontSize = 12.sp,
            color = SeekerClawColors.TextPrimary,
            lineHeight = 17.sp,
        )
        SecondaryButton(
            onClick = onClear,
            label = "Clear clipboard",
            modifier = Modifier.fillMaxWidth(),
        )
    }
}

/* -------------------------------------------------------------------- */
/* Configured state                                                     */
/* -------------------------------------------------------------------- */

@Composable
private fun ConfiguredStateSection(
    pubkey: String,
    status: CapEnforcer.CapStatus?,
    balances: SolanaBalanceFetcher.Balances?,
    balancesLoading: Boolean,
    onRefreshBalances: () -> Unit,
    onCapsChanged: (BurnerCaps) -> Unit,
    onWipe: () -> Unit,
    onRotate: () -> Unit,
) {
    // Balances render as decimal strings when fetched, "balance unavailable"
    // when null (fetch never ran OR fetch failed). Loading state is hoisted
    // to the WalletStatusCard's refresh affordance — we don't replace the
    // values here so the previously-fetched balance remains visible during
    // refresh (avoids a UI flicker that reads as "balance went to zero").
    val balanceSol = balances
        ?.let { WalletAmountFormat.formatLamportsToSol(it.solLamports.toString()) }
        ?: "balance unavailable"
    val balanceUsdc = balances
        ?.let { WalletAmountFormat.formatMicroUnitsToUsdc(it.usdcMicrounits.toString()) }
        ?: "balance unavailable"

    val s = status
    val spentSol = s?.let { WalletAmountFormat.formatLamportsToSol(it.spentTodaySol) } ?: "0.00"
    val spentUsdc = s?.let { WalletAmountFormat.formatMicroUnitsToUsdc(it.spentTodayUsdc) } ?: "0.00"

    val remainingSol = s?.let { remaining(it.capDailySol, it.spentTodaySol, isSol = true) } ?: "0.00"
    val remainingUsdc = s?.let { remaining(it.capDailyUsdc, it.spentTodayUsdc, isSol = false) } ?: "0.00"

    WalletStatusCard(
        role = "Burner wallet",
        fullAddress = pubkey,
        balanceSol = balanceSol,
        balanceUsdc = balanceUsdc,
        spentTodaySol = spentSol,
        spentTodayUsdc = spentUsdc,
        remainingDailySol = remainingSol,
        remainingDailyUsdc = remainingUsdc,
        onRefresh = onRefreshBalances,
        isRefreshing = balancesLoading,
    )

    val initialCaps = remember(s) {
        BurnerCaps(
            perTxSol = s?.let { WalletAmountFormat.formatLamportsToSol(it.capPerTxSol) }?.takeIf { it != "0.00" } ?: "",
            dailySol = s?.let { WalletAmountFormat.formatLamportsToSol(it.capDailySol) }?.takeIf { it != "0.00" } ?: "",
            perTxUsdc = s?.let { WalletAmountFormat.formatMicroUnitsToUsdc(it.capPerTxUsdc) }?.takeIf { it != "0.00" } ?: "",
            dailyUsdc = s?.let { WalletAmountFormat.formatMicroUnitsToUsdc(it.capDailyUsdc) }?.takeIf { it != "0.00" } ?: "",
        )
    }

    CardSurface {
        CapsConfigSection(
            initial = initialCaps,
            onSave = onCapsChanged,
        )
    }

    val fundingContext = LocalContext.current
    val fundingHaptic = LocalHapticFeedback.current
    CardSurface {
        SectionLabel("Funding")
        Spacer(Modifier.height(Spacing.sm))
        Text(
            text = "Send SOL or USDC from your main wallet to the address below. Tap to copy.",
            fontFamily = RethinkSans,
            fontSize = 12.sp,
            color = SeekerClawColors.TextDim,
            lineHeight = 17.sp,
        )
        Spacer(Modifier.height(Spacing.sm))
        // Full pubkey, tap-to-copy. Reuses the WalletStatusCard helper so
        // the Toast wording + clipboard label are consistent across both
        // copy surfaces (truncated form in the status card header, full
        // form here in the funding card).
        Text(
            text = pubkey,
            fontFamily = FontFamily.Monospace,
            fontSize = 12.sp,
            color = SeekerClawColors.TextPrimary,
            modifier = Modifier
                .fillMaxWidth()
                .clickable {
                    copyToClipboard(fundingContext, pubkey, "Burner wallet")
                    fundingHaptic.performHapticFeedback(HapticFeedbackType.LongPress)
                },
        )
        // TODO(BAT-582-followup): render a QR code for [pubkey] once a
        //   QR generator is wired in via build.gradle.kts. zxing-core is
        //   declared in libs.versions.toml but not yet an active app
        //   dependency, and Phase 3 ships under a no-new-deps rule.
    }

    CardSurface {
        DangerZoneSection(
            burnerAddress = pubkey,
            onWipeClick = onWipe,
            onRotateClick = onRotate,
        )
    }
}

/* -------------------------------------------------------------------- */
/* Helpers                                                              */
/* -------------------------------------------------------------------- */

private fun remaining(capAtomic: String, spentAtomic: String, isSol: Boolean): String {
    val cap = parseBigIntOrNull(capAtomic) ?: return "0.00"
    val spent = parseBigIntOrNull(spentAtomic) ?: BigInteger.ZERO
    val raw = cap - spent
    val rem = if (raw < BigInteger.ZERO) BigInteger.ZERO else raw
    return if (isSol) WalletAmountFormat.formatLamportsToSol(rem)
    else WalletAmountFormat.formatMicroUnitsToUsdc(rem)
}

private fun parseBigIntOrNull(s: String?): BigInteger? {
    if (s.isNullOrBlank()) return null
    return try { BigInteger(s) } catch (_: Exception) { null }
}

private fun base58OrFallback(pubkey: ByteArray): String {
    return try {
        org.sol4k.Base58.encode(pubkey)
    } catch (_: Exception) {
        pubkey.joinToString("") { "%02x".format(it) }
    }
}

private fun truncatePubkey(pubkey: String): String {
    if (pubkey.length <= 12) return pubkey
    return "${pubkey.take(4)}…${pubkey.takeLast(4)}"
}

private fun humanizeError(code: String): String = when (code) {
    "invalid_key_length" -> "Wrong key length (need 32 or 64 bytes)"
    "invalid_key_format" -> "Couldn't parse — paste base58 or [1,2,3,…] JSON"
    "invalid_keypair_pubkey_mismatch" -> "Key/pubkey mismatch (corrupt export?)"
    else -> "Test failed ($code)"
}

/**
 * Persist new caps via [CapEnforcer.setCaps]. Decimal user input is
 * converted to atomic units here (the boundary). Parse failures surface
 * via Toast — caller still bumps the refresh key so the UI re-reads
 * whatever did persist.
 */
private suspend fun saveCaps(
    context: Context,
    capEnforcer: CapEnforcer,
    caps: BurnerCaps,
) {
    val perTxSolAtomic = parseOrToast(context, caps.perTxSol, "per-tx SOL", isSol = true) ?: return
    val dailySolAtomic = parseOrToast(context, caps.dailySol, "daily SOL", isSol = true) ?: return
    val perTxUsdcAtomic = parseOrToast(context, caps.perTxUsdc, "per-tx USDC", isSol = false) ?: return
    val dailyUsdcAtomic = parseOrToast(context, caps.dailyUsdc, "daily USDC", isSol = false) ?: return

    val ok = withContext(Dispatchers.IO) {
        capEnforcer.setCaps(
            capPerTxSol = perTxSolAtomic.toString(),
            capPerTxUsdc = perTxUsdcAtomic.toString(),
            capDailySol = dailySolAtomic.toString(),
            capDailyUsdc = dailyUsdcAtomic.toString(),
        )
    }
    val msg = if (ok) "Caps saved" else "Caps could not be saved"
    Toast.makeText(context, msg, Toast.LENGTH_SHORT).show()
}

private fun parseOrToast(
    context: Context,
    decimal: String,
    label: String,
    isSol: Boolean,
): BigInteger? {
    if (decimal.isBlank()) return BigInteger.ZERO
    val atomic = if (isSol) WalletAmountFormat.parseSolToLamports(decimal)
    else WalletAmountFormat.parseUsdcToMicroUnits(decimal)
    if (atomic == null) {
        Toast.makeText(
            context,
            "Invalid $label: $decimal — use a decimal like 0.05 (no commas, no scientific notation)",
            Toast.LENGTH_LONG,
        ).show()
        return null
    }
    return atomic
}

/**
 * Wipe the burner wallet. Per BAT-582 R1 (PR #364 review), this is a
 * FULL RESET — after wipe, the device state is indistinguishable from
 * "burner never configured":
 *   1. Encrypted key file at `filesDir/burner_keys/burner` is overwritten
 *      and deleted (KeyVault.wipe).
 *   2. Cap configuration is zeroed (defense-in-depth: setCaps to "0"
 *      so any in-process CapEnforcer references see a wiped state
 *      immediately, before the file delete in step 3 lands).
 *   3. `burner_caps.json` itself is deleted. This is the gate-correctness
 *      step: SeekerClawService's periodic sweep used to gate on
 *      `burner_caps.json.exists()` as a proxy for "configured" — that
 *      proxy was wrong because zeroed-caps left the file present. The
 *      service now gates on the burner KEY file (the real ground truth),
 *      but we delete the caps file too so a future re-import starts from
 *      true defaults (0.05 / 0.5 SOL, 5 / 50 USDC) instead of zeros.
 *
 * Persisting state intentionally NOT cleared by wipe:
 *   - Jupiter ownership map (`jupiter_owner_<orderId>`): orders the
 *     burner created on-chain still exist after wipe; the cancel-tool
 *     needs the ownership map to route those cancels to the right
 *     wallet authority. Wiping it would orphan those orders. (The keys
 *     to actually authorize a cancel are gone, so this is purely
 *     informational at that point — but the metadata helps the agent
 *     give the user an honest "you can't cancel that, the burner that
 *     created it has been wiped" instead of silently routing to main.)
 */
private suspend fun wipeBurner(
    context: Context,
    keyVault: EncryptedPrefsKeyVault,
    capEnforcer: CapEnforcer,
) {
    withContext(Dispatchers.IO) {
        try {
            keyVault.wipe(BURNER_ID)
        } catch (_: Exception) {
            // Best-effort — even if wipe surface-fails, the file is
            // overwritten by KeyVault.wipe().
        }
        // Zero cap configuration so any in-process CapEnforcer reference
        // sees a wiped state immediately. The file delete below replaces
        // this from a future re-import's perspective, but the in-memory
        // CrossProcessStore still has the zeroed values until the next
        // file change is observed.
        try {
            capEnforcer.setCaps(
                capPerTxSol = "0",
                capPerTxUsdc = "0",
                capDailySol = "0",
                capDailyUsdc = "0",
            )
        } catch (_: Exception) {
            // Same — best-effort cleanup.
        }
        // Delete the caps file itself so post-wipe state is
        // indistinguishable from "burner never configured". This is the
        // cleanup step that lets a future re-import seed defaults from
        // BurnerCapsState() instead of inheriting the zeroed values.
        try {
            val capsFile = java.io.File(
                context.applicationContext.filesDir,
                com.seekerclaw.app.data.caps.BurnerCapsState.FILE_NAME,
            )
            if (capsFile.exists()) capsFile.delete()
            // Also wipe any leftover .tmp from an interrupted store —
            // matches the defensive cleanup in EncryptedPrefsKeyVault.wipe.
            val tmp = java.io.File(capsFile.parentFile, "${capsFile.name}.tmp")
            if (tmp.exists()) tmp.delete()
        } catch (_: Exception) {
            // Best-effort. If the file delete fails (e.g., locked by
            // another reader), the next setCaps call will rewrite it
            // from the zeroed in-memory state — degraded but safe.
        }
    }
    Toast.makeText(context, "Burner wiped", Toast.LENGTH_SHORT).show()
}
