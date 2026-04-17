package com.seekerclaw.app.config

data class EnvVar(
    val name: String,
    val value: String,
) {
    companion object {
        /** Shared charset rule — also referenced by EnvVarParser so the two stay in sync. */
        internal val NAME_REGEX = Regex("^[A-Z_][A-Z0-9_]*$")
        const val MAX_VALUE_BYTES = 8192
        const val MAX_KEYS = 256

        /** Exact reserved names. Canary count enforced by test. */
        val RESERVED_EXACT: Set<String> = setOf(
            "PATH", "HOME", "TMPDIR", "USER", "SHELL", "LANG", "TERM",
            "AGENT_VERSION",
            "API_TIMEOUT_MS", "API_TIMEOUT_RETRIES",
            "API_TIMEOUT_BACKOFF_MS", "API_TIMEOUT_MAX_BACKOFF_MS",
            "WS_NO_UTF_8_VALIDATE", "WS_NO_BUFFER_UTIL",
        )

        /** Reserved name prefixes. Canary count enforced by test.
         *  All entries are UPPERCASE — [validateName] uppercases input before the
         *  prefix check, so mixed-case reservations would be dead code. */
        val RESERVED_PREFIXES: List<String> = listOf(
            "NODE_", "NPM_", "ANDROID_", "LC_", "JAVA_",
        )

        fun isReserved(name: String): Boolean =
            RESERVED_EXACT.contains(name) || RESERVED_PREFIXES.any { name.startsWith(it) }

        /** Returns null if valid, or a human-readable error string. */
        fun validateName(name: String): String? {
            if (name.isEmpty()) return "Name cannot be empty"
            if (!NAME_REGEX.matches(name)) {
                return "Name must be UPPERCASE letters, digits, underscore; cannot start with a digit"
            }
            if (isReserved(name)) return "`$name` is reserved"
            return null
        }

        /**
         * Returns null if valid, or a human-readable error string.
         * - UTF-8 byte length is checked (not character count).
         * - Newlines (`\r`, `\n`) are rejected: env vars are line-oriented in
         *   `.env` files, the Raw editor, and shell_exec contexts, so embedding
         *   a newline would corrupt the `\n`-delimited `KEY=VALUE` serialization.
         */
        fun validateValue(value: String): String? {
            if (value.contains('\n') || value.contains('\r')) {
                return "Value cannot contain newline characters"
            }
            if (value.toByteArray(Charsets.UTF_8).size > MAX_VALUE_BYTES) {
                return "Value exceeds ${MAX_VALUE_BYTES / 1024} KB limit"
            }
            return null
        }
    }
}
