package com.seekerclaw.app.state

import kotlinx.serialization.Serializable

/**
 * Runtime configuration that crosses the UI ↔ `:node` process boundary
 * (BAT-513, BAT-511 family).
 *
 * Three fields move out of `SharedPreferences` (which is process-local
 * and read-cached, so the `:node` side never sees UI-side writes
 * without a service restart) into a [com.seekerclaw.app.util.CrossProcessStore]-
 * backed file. The fields BAT-513 covers:
 *
 *  - [provider] — the AI gateway adapter to use. Persisted IDs are the
 *    same strings `config.js:_SUPPORTED_PROVIDERS` accepts; "anthropic"
 *    is display text only and must NEVER be persisted (the Node side
 *    rejects it and falls back to the `"claude"` default).
 *  - [authType] — credential mode for the active [provider]. Valid
 *    values depend on [provider] — see the provider/authType matrix
 *    below; [com.seekerclaw.app.state.RuntimeStateStore] enforces the
 *    matrix at the write boundary so an invalid combo never reaches
 *    disk or the Node side.
 *  - [model] — model ID. Live-updateable: a model change takes effect
 *    on the next AI turn without a service restart, because Node's
 *    `resolveActiveModel` (config.js) resolves the active model per
 *    turn from the `agent_settings.json` overlay. `runtime_state.json`
 *    is the cross-process source of truth that the main UI process
 *    observes — Node reads it at startup as the fallback chain
 *    after `agent_settings.json`. Telegram `/model` and Settings UI
 *    writes update BOTH so both surfaces stay consistent.
 *    Provider/authType changes still require a service restart — the
 *    active adapter, base URL, and auth headers are wired at Node
 *    startup.
 *
 * ## Provider / authType matrix
 *
 * | provider     | valid authType values     |
 * |--------------|---------------------------|
 * | `claude`     | `api_key`, `setup_token`  |
 * | `openai`     | `api_key`, `oauth`        |
 * | `openrouter` | `api_key`                 |
 * | `custom`     | `api_key`                 |
 *
 * Validation lives in [RuntimeStateStore.isValidPair]; both
 * [RuntimeStateStore.write] and the observe-and-mirror collector gate
 * on it so neither caller-bug nor a corrupt file can poison prefs or
 * reach the UI.
 *
 * ## Forward compatibility
 *
 * Decoded with `ignoreUnknownKeys = true` (configured in
 * [com.seekerclaw.app.util.CrossProcessStore]) so a future build that
 * adds a new field can roll back to a current build without crashing
 * its own data.
 */
@Serializable
data class RuntimeState(
    val provider: String = "claude",
    val authType: String = "api_key",
    val model: String = "claude-opus-4-7",
    /**
     * BAT-549 Commit 3b: user-facing toggle for "Extended Thinking".
     * When `true` AND the active model's `reasoningSupport === "yes"`
     * in the registry, adapters send the provider-appropriate request
     * param (Anthropic `thinking:{type:"enabled", budget_tokens:16000}`,
     * OpenAI `reasoning:{effort:"medium", summary:"auto"}` plus
     * `include:["reasoning.encrypted_content"]`, OpenRouter
     * `reasoning:{effort:"medium"}`). The exact body shapes live in the
     * Node adapters (`providers/claude.js`, `providers/openai.js`,
     * `providers/openrouter.js`) — keep this comment aligned with the
     * code if either side changes (Commit 3c R-1 drift fix).
     * For models with `reasoningSupport === "no"` (Haiku) the toggle is
     * a true no-op — no request param sent; for `"unknown"` (freeform
     * providers) the param is also NOT sent unless the user enables
     * the per-Custom advanced override (see [customEchoReasoning]).
     *
     * Default `false` so updating from a pre-BAT-549 build does NOT
     * silently flip on reasoning (token costs, behavior change).
     */
    val reasoningEnabled: Boolean = false,
    /**
     * BAT-549 Commit 3b: when `true`, reasoning summaries are surfaced
     * to the Telegram chat as expandable blockquotes (collapsed by
     * default, tap-to-expand). When `false` (default), reasoning is
     * captured into checkpoint state but never shown to the user.
     *
     * Independent of [reasoningEnabled] — a power user could enable
     * thinking without surfacing it (e.g. for tool-loop quality
     * without UI clutter), or vice versa (display already-captured
     * reasoning from past turns even with the toggle off).
     */
    val reasoningDisplayInChat: Boolean = false,
    /**
     * BAT-549 Commit 3b: per-Custom-config advanced override. When
     * `true`, the Custom adapter forces echo-on-tool-loop for any
     * model id (overrides the conservative default of stripping
     * unknown gateways' reasoning content to avoid spurious 400s).
     *
     * Used when a user knows their custom gateway requires echoing
     * reasoning_content but the model id doesn't match the known
     * DeepSeek-V4 regex. R5 thread 5 of Commit 1 says this should be
     * provider-config-scoped, NOT global — the [customConfigSignature]
     * companion field tracks (model | baseUrl | format | sortedHeaderKeys)
     * and resets this override to `false` when the signature changes
     * (i.e., the user switched to a different gateway).
     */
    val customEchoReasoning: Boolean = false,
    /**
     * BAT-549 Commit 3b: SHA-256 of the Custom config tuple
     * `(customModel | normalize(customBaseUrl) | customFormat |
     * sortedHeaderKeys(customHeaders))`. ApiKey changes are NOT part
     * of the signature (key rotation common); header VALUES are NOT
     * hashed (would persist secret material on disk). When the
     * signature mismatches the live config, [customEchoReasoning] is
     * reset to `false` and the user is prompted to re-enable it.
     *
     * Default `null` for fresh installs and pre-BAT-549 upgrades —
     * the signature is computed and persisted on the next Settings
     * write to the Custom provider config (after Commit 3e wires the
     * UI). Until then, [customEchoReasoning] simply stays at its
     * persisted value.
     */
    val customConfigSignature: String? = null,
)
