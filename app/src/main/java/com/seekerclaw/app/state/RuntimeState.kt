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
)
