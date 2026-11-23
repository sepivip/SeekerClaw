package com.seekerclaw.app.config

/**
 * BAT-1157 (contract v2 §2, D9): how the agent will actually reach OpenAI, from the user's
 * SELECTED auth, whether a usable sign-in pair exists, and whether an API key is saved.
 *
 * The selection is never rewritten (prefs and runtime_state keep `oauth` after a sign-out or an
 * unreadable record). Node computes the same table in `config.js` from config.json (runtime_state's
 * selection first) — `ModelDispatchParityTest` and `model-dispatch-parity.test.js` pin the two to
 * the same rows, from one shared table (`tests/nodejs-project/fixtures/model-dispatch-parity.json`).
 * BAT-1661 uses it as the repair's transport scope (`ModelRepair.transportOf`):
 *
 * | selected | usable sign-in | API key | result     |
 * |----------|----------------|---------|------------|
 * | oauth    | yes            | any     | OAUTH      |
 * | oauth    | no             | yes     | API_KEY    |
 * | oauth    | no             | no      | RECONNECT  |
 * | api_key  | —              | —       | API_KEY    |
 *
 * RECONNECT is startable: the agent boots and answers "Reconnect OpenAI in Settings" instead of
 * exiting. "Signed in" in the UI is a separate question — a usable pair only.
 */
object OpenAIAuth {
    enum class Effective { OAUTH, API_KEY, RECONNECT }

    fun effective(selectedAuth: String, hasUsableToken: Boolean, hasApiKey: Boolean): Effective = when {
        selectedAuth != "oauth" -> Effective.API_KEY
        hasUsableToken -> Effective.OAUTH
        hasApiKey -> Effective.API_KEY
        else -> Effective.RECONNECT
    }

    /** Whether the agent can start: anything but an api_key transport with no key. */
    fun isStartable(selectedAuth: String, hasUsableToken: Boolean, hasApiKey: Boolean): Boolean =
        when (effective(selectedAuth, hasUsableToken, hasApiKey)) {
            Effective.OAUTH, Effective.RECONNECT -> true
            Effective.API_KEY -> hasApiKey
        }
}
