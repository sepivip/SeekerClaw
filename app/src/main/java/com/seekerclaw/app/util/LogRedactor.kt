package com.seekerclaw.app.util

/**
 * BAT-1161 P1A gate 6 — defense-in-depth redaction for anything reaching the log mirror
 * (service_logs), the on-screen console, or Share.
 *
 * Mirrors the STATIC token shapes in the Node redactor (security.js `redactSecrets`). The
 * Node-runtime DYNAMIC covers — the bridge token, registered env-var values, and rotated
 * OAuth access/refresh tokens — are applied Node-side before a line is ever written to
 * node_debug.log; this Kotlin pass is the backstop for Kotlin-native log lines (e.g. an
 * exception message that captured a token) that never went through the Node redactor.
 *
 * Pure and cheap (a handful of anchored regexes over a short string). Order matters:
 * specific prefixes (sk-ant-/sk-or-/sk-proj-) run BEFORE the generic sk- so the prefix
 * isn't eaten first.
 */
object LogRedactor {
    private val patterns: List<Pair<Regex, String>> = listOf(
        Regex("sk-ant-[A-Za-z0-9_-]{10,}") to "sk-ant-***",          // Anthropic
        Regex("""\d{8,}:[A-Za-z0-9_-]{20,}""") to "***:***",         // Telegram bot token
        Regex("BSA[A-Za-z0-9_-]{10,}") to "BSA***",                  // Brave
        Regex("pplx-[A-Za-z0-9_-]{10,}") to "pplx-***",              // Perplexity
        Regex("sk-or-[A-Za-z0-9_-]{10,}") to "sk-or-***",            // OpenRouter
        Regex("sk-proj-[A-Za-z0-9_-]{20,}") to "sk-proj-***",        // OpenAI project key
        Regex("sk-[A-Za-z0-9_-]{20,}") to "sk-***",                  // OpenAI / generic sk-
        Regex("xai-[A-Za-z0-9_-]{16,}") to "xai-***",                // xAI API key
        // JWT: three base64url segments; `eyJ` is base64url of `{"`, so it's unmistakably a
        // token header (covers OAuth bearer/refresh JWTs — auth.x.ai, ChatGPT/Codex, etc.).
        Regex("eyJ[A-Za-z0-9_-]{5,}\\.[A-Za-z0-9_-]{5,}\\.[A-Za-z0-9_-]{5,}") to "eyJ***",
    )

    /** Mask known secret shapes. Pure; callers wrap this fail-open (see LogCollector.append). */
    fun redact(msg: String): String {
        var out = msg
        for ((rx, repl) in patterns) out = rx.replace(out, repl)
        return out
    }
}
