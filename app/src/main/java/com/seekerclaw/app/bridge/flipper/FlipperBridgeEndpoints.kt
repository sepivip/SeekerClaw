package com.seekerclaw.app.bridge.flipper

import android.content.Context
import com.seekerclaw.app.flipper.FlipperEnrollmentStore
import com.seekerclaw.app.flipper.FlipperIrController
import com.seekerclaw.app.flipper.InvocationContext
import org.json.JSONObject

/**
 * The two `/flipper` endpoints the Node agent may call.
 *
 * **Read and execute only — there is deliberately no mutation endpoint.** The allowlist and the
 * kill switch are edited exclusively in the app's Settings UI. Contract §3 (blocker B3) requires
 * this: `tools/file.js`'s `write` handler has no secrets check on its write path, so any endpoint
 * that could change the allowlist would be one a prompt-injected agent could reach.
 *
 * Enforcement lives here and below, never in the prompt. A fully injected agent must be
 * *incapable* of exceeding the allowlist, not merely instructed not to.
 */
class FlipperBridgeEndpoints(context: Context) {

    private val store = FlipperEnrollmentStore(context)
    private val controller = FlipperIrController(context, store)

    /** `GET`-shaped: the remotes and buttons the user enabled. Never returns a filesystem path. */
    fun remotes(): Map<String, Any?> = controller.listRemotes()

    /**
     * Fires one allowlisted button.
     *
     * [invocation] is set by the caller from the message pipeline, **not** taken from [params].
     * Anything the request body carries is model-influenced: `shell_exec` can run curl and
     * `js_eval` has `require('http')`, so a field in the JSON would be a field the agent could set
     * itself. The trust boundary is the Kotlin side of the bridge (§4b).
     */
    suspend fun press(params: JSONObject, invocation: InvocationContext): Map<String, Any?> {
        val remote = params.optString("remote", "")
        val button = params.optString("button", "")
        if (remote.isBlank() || button.isBlank()) {
            return mapOf(
                "error" to "invalid_request",
                "reason" to "Both 'remote' and 'button' are required.",
            )
        }
        return controller.press(remote, button, invocation)
    }
}
