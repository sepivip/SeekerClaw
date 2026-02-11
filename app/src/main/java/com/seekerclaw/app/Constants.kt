package com.seekerclaw.app

/**
 * Application-wide constants
 *
 * Centralizes all magic numbers, default values, and configuration constants
 * to improve maintainability and prevent scattered hard-coded values.
 */
object Constants {

    // ==================== Service & Lifecycle ====================

    /** Notification ID for the foreground service */
    const val NOTIFICATION_ID = 1

    /** Wake lock tag for the service */
    const val WAKE_LOCK_TAG = "SeekerClaw::Service"

    /** Wake lock tag for server mode (keep screen on) */
    const val SCREEN_WAKE_LOCK_TAG = "SeekerClaw::ServerMode"

    // ==================== Crash Loop Protection ====================

    /** Time window for crash detection (30 seconds) */
    const val CRASH_WINDOW_MS = 30_000L

    /** Maximum number of crashes within CRASH_WINDOW_MS before giving up */
    const val MAX_CRASH_COUNT = 3

    // ==================== Android Bridge ====================

    /** Port for the Android Bridge HTTP server (localhost only) */
    const val BRIDGE_PORT = 8765

    /** HTTP header name for bridge authentication token */
    const val BRIDGE_AUTH_HEADER = "X-Bridge-Token"

    /** Maximum clipboard size (1 MB) */
    const val MAX_CLIPBOARD_SIZE_BYTES = 1_048_576

    /** Maximum TTS text length (characters) */
    const val MAX_TTS_TEXT_LENGTH = 4000

    /** Maximum SMS message length (characters) */
    const val MAX_SMS_LENGTH = 1600

    // ==================== Watchdog ====================

    /** Watchdog check interval (30 seconds) */
    const val WATCHDOG_CHECK_INTERVAL_MS = 30_000L

    /** Watchdog response timeout (10 seconds) */
    const val WATCHDOG_RESPONSE_TIMEOUT_MS = 10_000L

    /** Watchdog dead declaration timeout (60 seconds) */
    const val WATCHDOG_DEAD_TIMEOUT_MS = 60_000L

    /** Maximum consecutive missed watchdog checks before declaring dead */
    const val WATCHDOG_MAX_MISSED_CHECKS = 2

    // ==================== Logging ====================

    /** Maximum number of log lines to keep in memory */
    const val LOG_BUFFER_SIZE = 1000

    /** Maximum log file size before rotation (10 MB) */
    const val MAX_LOG_FILE_SIZE_BYTES = 10_485_760L

    /** Log file retention in days */
    const val LOG_RETENTION_DAYS = 7

    // ==================== Models ====================

    /** Default Claude model */
    const val DEFAULT_MODEL = "claude-opus-4-6"

    /** Available Claude models */
    val AVAILABLE_MODELS = listOf(
        "claude-opus-4-6",
        "claude-sonnet-4-20250514",
        "claude-haiku-3-5"
    )

    // ==================== Config ====================

    /** Time to wait before deleting ephemeral config.json (5 seconds) */
    const val CONFIG_DELETE_DELAY_MS = 5_000L

    /** Minimum setup token length */
    const val MIN_SETUP_TOKEN_LENGTH = 80

    /** Setup token prefix */
    const val SETUP_TOKEN_PREFIX = "sk-ant-oat01-"

    // ==================== Memory ====================

    /** Maximum daily memory files to keep (mobile limit) */
    const val MAX_DAILY_MEMORY_FILES = 30

    /** Memory export ZIP compression level (0-9) */
    const val MEMORY_EXPORT_COMPRESSION_LEVEL = 9

    // ==================== Node.js ====================

    /** Node.js debug log polling interval (2 seconds) */
    const val NODE_LOG_POLL_INTERVAL_MS = 2_000L

    /** Maximum context tokens for mobile (limit memory usage) */
    const val MAX_CONTEXT_TOKENS = 100_000

    /** Web fetch timeout for mobile networks (15 seconds) */
    const val WEB_FETCH_TIMEOUT_SECONDS = 15

    /** Heartbeat interval for mobile (5 minutes to save battery) */
    const val HEARTBEAT_INTERVAL_MINUTES = 5

    // ==================== Camera ====================

    /** Maximum image size for camera capture (5 MB) */
    const val MAX_CAMERA_IMAGE_SIZE_BYTES = 5_242_880L

    /** JPEG compression quality for camera images (0-100) */
    const val CAMERA_JPEG_QUALITY = 85

    // ==================== Solana ====================

    /** Solana RPC endpoint (mainnet-beta) */
    const val SOLANA_RPC_ENDPOINT = "https://api.mainnet-beta.solana.com"

    /** Solana transaction timeout (30 seconds) */
    const val SOLANA_TX_TIMEOUT_SECONDS = 30

    // ==================== Encryption ====================

    /** Android Keystore alias for config encryption */
    const val KEYSTORE_ALIAS = "seekerclaw_config_key"

    /** AES key size in bits */
    const val AES_KEY_SIZE_BITS = 256

    /** GCM authentication tag length in bits */
    const val GCM_TAG_LENGTH_BITS = 128

    /** GCM IV length in bytes */
    const val GCM_IV_LENGTH_BYTES = 12
}
