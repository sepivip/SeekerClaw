package com.seekerclaw.app.util

/**
 * Result - Type-safe error handling
 *
 * Replaces nullable returns with explicit success/failure states.
 * Forces callers to handle errors explicitly.
 *
 * Usage:
 * ```kotlin
 * fun loadConfig(): Result<AppConfig> {
 *     return try {
 *         val config = // ... load config
 *         Result.Success(config)
 *     } catch (e: Exception) {
 *         Result.Failure("Failed to load config: ${e.message}")
 *     }
 * }
 *
 * // Caller must handle both cases:
 * when (val result = loadConfig()) {
 *     is Result.Success -> useConfig(result.data)
 *     is Result.Failure -> showError(result.error)
 * }
 * ```
 */
sealed class Result<out T> {
    data class Success<T>(val data: T) : Result<T>()
    data class Failure(val error: String, val exception: Throwable? = null) : Result<Nothing>()

    /**
     * Returns data if Success, null if Failure
     */
    fun getOrNull(): T? = when (this) {
        is Success -> data
        is Failure -> null
    }

    /**
     * Returns data if Success, throws if Failure
     */
    fun getOrThrow(): T = when (this) {
        is Success -> data
        is Failure -> throw exception ?: Exception(error)
    }

    /**
     * Returns data if Success, default value if Failure
     */
    fun getOrDefault(default: T): T = when (this) {
        is Success -> data
        is Failure -> default
    }

    /**
     * Transform Success value, preserve Failure
     */
    fun <R> map(transform: (T) -> R): Result<R> = when (this) {
        is Success -> Success(transform(data))
        is Failure -> Failure(error, exception)
    }

    /**
     * Execute action if Success
     */
    fun onSuccess(action: (T) -> Unit): Result<T> {
        if (this is Success) action(data)
        return this
    }

    /**
     * Execute action if Failure
     */
    fun onFailure(action: (String) -> Unit): Result<T> {
        if (this is Failure) action(error)
        return this
    }
}
