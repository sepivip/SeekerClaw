package com.seekerclaw.app.config

import org.junit.Assert.assertEquals
import org.junit.Test

/**
 * BAT-1728: PLATFORM.md's `Auth:` line must name the transport the agent actually runs on, not only
 * the saved choice. Before the fix, an OpenAI "oauth" selection with no usable sign-in but a saved
 * API key ran on the key while PLATFORM.md said "OAuth", so the agent told the user the wrong thing.
 *
 * The OpenAI rows walk the whole [OpenAIAuth] table; the xAI rows walk [ConfigManager.emittedAuthType]
 * (the value config.json gives Node). The common cases keep their old labels.
 */
class PlatformAuthLabelTest {

    private fun cfg(
        provider: String,
        authType: String,
        openaiKey: String = "",
        openaiToken: String = "",
        xaiToken: String = "",
        xaiReauth: Boolean = false,
    ) = AppConfig(
        anthropicApiKey = "",
        telegramBotToken = "",
        telegramOwnerId = "",
        model = "m",
        agentName = "",
        provider = provider,
        authType = authType,
        openaiApiKey = openaiKey,
        openaiOAuthToken = openaiToken,
        xaiOAuthToken = xaiToken,
        xaiOAuthReauthRequired = xaiReauth,
    )

    private fun label(c: AppConfig?) = ConfigManager.platformAuthLabel(c)

    @Test fun `claude labels follow the selection`() {
        assertEquals("Pro/Max Setup Token", label(cfg("claude", "setup_token")))
        assertEquals("API key", label(cfg("claude", "api_key")))
        assertEquals("API key", label(null))
    }

    @Test fun `openai signed in is OAuth, with or without a key`() {
        assertEquals("OAuth", label(cfg("openai", "oauth", openaiToken = "tok")))
        assertEquals("OAuth", label(cfg("openai", "oauth", openaiKey = "sk-x", openaiToken = "tok")))
    }

    @Test fun `openai oauth with no sign-in but a saved key says the key fallback, not OAuth`() {
        // The reported bug: Node runs on the key here (OpenAIAuth API_KEY).
        val c = cfg("openai", "oauth", openaiKey = "sk-x")
        assertEquals(OpenAIAuth.Effective.API_KEY, OpenAIAuth.effective("oauth", false, true))
        assertEquals(ConfigManager.PLATFORM_AUTH_FALLBACK, label(c))
    }

    @Test fun `openai oauth with neither says reconnect`() {
        assertEquals(ConfigManager.PLATFORM_AUTH_RECONNECT, label(cfg("openai", "oauth")))
    }

    @Test fun `openai api_key selection stays API key, even with a stale token`() {
        assertEquals("API key", label(cfg("openai", "api_key", openaiKey = "sk-x")))
        assertEquals("API key", label(cfg("openai", "api_key", openaiKey = "sk-x", openaiToken = "tok")))
    }

    @Test fun `xai labels follow the emitted auth type`() {
        assertEquals("OAuth", label(cfg("xai", "oauth", xaiToken = "tok")))
        // A fresh oauth selection with no token: emittedAuthType downgrades it to the key.
        val fresh = cfg("xai", "oauth")
        assertEquals("api_key", ConfigManager.emittedAuthType(fresh))
        assertEquals(ConfigManager.PLATFORM_AUTH_FALLBACK, label(fresh))
        // A dead sign-in stays oauth so the agent boots into "reconnect".
        val dead = cfg("xai", "oauth", xaiReauth = true)
        assertEquals("oauth", ConfigManager.emittedAuthType(dead))
        assertEquals(ConfigManager.PLATFORM_AUTH_RECONNECT, label(dead))
        assertEquals("API key", label(cfg("xai", "api_key")))
    }

    @Test fun `other providers are API key`() {
        assertEquals("API key", label(cfg("openrouter", "api_key")))
        assertEquals("API key", label(cfg("custom", "api_key")))
    }
}
