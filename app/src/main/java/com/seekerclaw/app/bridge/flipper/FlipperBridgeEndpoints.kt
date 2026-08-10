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

    private companion object {
        /** Generous next to any real `.ir` button name; the point is a bound, not a tight fit. */
        const val MAX_NAME_CHARS = 64
    }

    private val store = FlipperEnrollmentStore.get(context)
    private val controller = FlipperIrController(context, store)

    /** `GET`-shaped: the remotes and buttons the user enabled. Never returns a filesystem path. */
    fun remotes(): Map<String, Any?> = controller.listRemotes()

    /**
     * Fires one allowlisted button.
     *
     * [invocation] is a parameter rather than a field this reads out of [params], so that the one
     * place deciding it is visible. That is a code-organisation point, **not** a security one: its
     * only caller derives it from the request body, which is model-influenced. See
     * `AndroidBridge.handleFlipperPress` and [InvocationContext] for why §4b's trust boundary is
     * not implementable on this side, and which controls carry the weight instead.
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
        // Bounded before anything downstream sees them. Both are model-supplied, and a rejected
        // attempt is still written to the audit log — which is decoded and re-encoded on every
        // subsequent operation, so an unbounded string would be paid for repeatedly. Real names
        // come from a .ir file and are far shorter than this.
        if (remote.length > MAX_NAME_CHARS || button.length > MAX_NAME_CHARS) {
            return mapOf(
                "error" to "invalid_request",
                "reason" to "Remote and button names must be $MAX_NAME_CHARS characters or fewer.",
            )
        }
        return controller.press(remote, button, invocation)
    }
}
