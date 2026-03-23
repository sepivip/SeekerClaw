package com.seekerclaw.app.config

data class SearchProviderInfo(
    val id: String,
    val displayName: String,
    val keyHint: String,
    val consoleUrl: String,
    val configField: String,
)

val availableSearchProviders = listOf(
    SearchProviderInfo(
        id = "brave",
        displayName = "Brave Search",
        keyHint = "BSA...",
        consoleUrl = "https://brave.com/search/api",
        configField = "braveApiKey",
    ),
    SearchProviderInfo(
        id = "perplexity",
        displayName = "Perplexity",
        keyHint = "pplx-...",
        consoleUrl = "https://www.perplexity.ai/settings/api",
        configField = "perplexityApiKey",
    ),
    SearchProviderInfo(
        id = "exa",
        displayName = "Exa",
        keyHint = "exa-...",
        consoleUrl = "https://dashboard.exa.ai",
        configField = "exaApiKey",
    ),
    SearchProviderInfo(
        id = "tavily",
        displayName = "Tavily",
        keyHint = "tvly-...",
        consoleUrl = "https://app.tavily.com",
        configField = "tavilyApiKey",
    ),
    SearchProviderInfo(
        id = "firecrawl",
        displayName = "Firecrawl",
        keyHint = "fc-...",
        consoleUrl = "https://firecrawl.dev",
        configField = "firecrawlApiKey",
    ),
)

fun searchProviderById(id: String): SearchProviderInfo =
    availableSearchProviders.find { it.id == id } ?: availableSearchProviders[0]
