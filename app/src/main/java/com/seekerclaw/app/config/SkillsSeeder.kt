package com.seekerclaw.app.config

import java.io.File

/**
 * SkillsSeeder - Generates example skill files for the Skills system
 *
 * Seeds the workspace/skills/ directory with example skills demonstrating:
 * - Weather forecasts
 * - Web research
 * - Daily briefings
 * - Reminders & timers
 * - Quick notes
 * - Translation
 * - Calculator & unit conversion
 * - Text summarization
 * - Define words
 * - News headlines
 * - Todo lists
 * - Bookmarks
 * - Jokes & quotes
 * - Crypto prices (CoinGecko API)
 * - Movies & TV (TMDB API)
 * - GitHub repos (REST API)
 */
object SkillsSeeder {
/**
 * Seed workspace with example skills demonstrating the Skills system.
 */
fun seedSkills(workspaceDir: File) {
    val skillsDir = File(workspaceDir, "skills").apply { mkdirs() }

    // Weather skill
    val weatherDir = File(skillsDir, "weather").apply { mkdirs() }
    val weatherSkill = File(weatherDir, "SKILL.md")
    if (!weatherSkill.exists()) {
        weatherSkill.writeText(
            """
            |# Weather
            |
            |Trigger: weather, forecast, temperature, rain, snow, sunny, cloudy, humidity
            |
            |## Description
            |Get current weather information and forecasts for any location.
            |
            |## Instructions
            |When the user asks about weather:
            |
            |1. Identify the location they're asking about
            |   - If no location specified, ask which city they want
            |   - Remember their home location if they've told you before
            |
            |2. Use web_search to find current weather
            |   - Search: "[city] weather today"
            |   - Include temperature, conditions, and any alerts
            |
            |3. Format your response concisely:
            |   - Current temperature and conditions
            |   - High/low for the day
            |   - Any notable weather alerts
            |   - Brief forecast if they asked
            |
            |Keep responses short - this is for mobile viewing.
            """.trimMargin()
        )
    }

    // Web Research skill
    val researchDir = File(skillsDir, "research").apply { mkdirs() }
    val researchSkill = File(researchDir, "SKILL.md")
    if (!researchSkill.exists()) {
        researchSkill.writeText(
            """
            |# Web Research
            |
            |Trigger: research, find out, look up, search for, what is, who is, tell me about
            |
            |## Description
            |Deep research on topics using web search and page fetching.
            |
            |## Instructions
            |When researching a topic:
            |
            |1. Start with a broad web_search to understand the topic
            |
            |2. For detailed info, use web_fetch on promising URLs
            |   - Prefer authoritative sources (Wikipedia, official sites, reputable news)
            |   - Avoid clickbait or low-quality sources
            |
            |3. Synthesize information from multiple sources
            |   - Cross-reference facts when possible
            |   - Note if sources conflict
            |
            |4. Format findings clearly:
            |   - Lead with the key answer
            |   - Add supporting details
            |   - Cite sources when relevant
            |
            |5. Save important findings to memory if the user might need them later
            """.trimMargin()
        )
    }

    // Daily Briefing skill
    val briefingDir = File(skillsDir, "briefing").apply { mkdirs() }
    val briefingSkill = File(briefingDir, "SKILL.md")
    if (!briefingSkill.exists()) {
        briefingSkill.writeText(
            """
            |# Daily Briefing
            |
            |Trigger: briefing, morning, daily update, what's happening, news today, catch me up
            |
            |## Description
            |Provide a personalized daily briefing with news, weather, and reminders.
            |
            |## Instructions
            |When asked for a briefing:
            |
            |1. Check memory for user's preferences:
            |   - Their location for weather
            |   - Topics they care about
            |   - Any scheduled reminders
            |
            |2. Gather information:
            |   - Local weather using web_search
            |   - Top news in their interest areas
            |   - Any notes from yesterday's daily memory
            |
            |3. Format as a concise briefing:
            |   - Start with weather (1-2 lines)
            |   - Key news headlines (3-5 items)
            |   - Any reminders or follow-ups from memory
            |
            |4. Keep it scannable - use bullet points
            |
            |5. Add today's briefing to daily_note for reference
            """.trimMargin()
        )
    }

    // Reminders skill
    val remindersDir = File(skillsDir, "reminders").apply { mkdirs() }
    val remindersSkill = File(remindersDir, "SKILL.md")
    if (!remindersSkill.exists()) {
        remindersSkill.writeText(
            """
            |---
            |name: reminders
            |description: "Set reminders that will notify you at the specified time"
            |emoji: "⏰"
            |---
            |
            |# Reminders
            |
            |## Instructions
            |Use the reminder tools to manage reminders:
            |
            |**Setting a reminder:**
            |1. Extract what to remind about
            |2. Parse when (natural language supported):
            |   - "in 30 minutes", "in 2 hours"
            |   - "tomorrow at 9am", "at 5pm"
            |   - "2024-01-15 14:30" (ISO format)
            |3. Call reminder_set with message and time
            |4. Confirm with the scheduled time
            |
            |**Listing reminders:**
            |- Use reminder_list to show pending reminders
            |- Show ID, message, and when it's due
            |
            |**Canceling reminders:**
            |- Use reminder_cancel with the reminder ID
            |- Confirm cancellation
            |
            |Examples:
            |- "Remind me to call mom in 30 minutes"
            |  → reminder_set("Call mom", "in 30 minutes")
            |- "What reminders do I have?"
            |  → reminder_list()
            |- "Cancel reminder rem_abc123"
            |  → reminder_cancel("rem_abc123")
            """.trimMargin()
        )
    }

    // Quick Notes skill
    val notesDir = File(skillsDir, "notes").apply { mkdirs() }
    val notesSkill = File(notesDir, "SKILL.md")
    if (!notesSkill.exists()) {
        notesSkill.writeText(
            """
            |# Quick Notes
            |
            |Trigger: note, jot down, write down, save this, remember this, take note
            |
            |## Description
            |Quickly capture and organize notes for later reference.
            |
            |## Instructions
            |When the user wants to save a note:
            |
            |1. Identify the content to save
            |
            |2. Determine if it should go to:
            |   - daily_note: Temporary, day-specific info
            |   - memory_save: Long-term, important info
            |
            |3. Add appropriate tags if mentioned (#idea, #todo, #link)
            |
            |4. Format notes clearly with topic and content
            |
            |5. Confirm the note was saved
            |
            |When retrieving notes:
            |- Check both MEMORY.md and today's daily file
            |- Search for relevant tags or keywords
            """.trimMargin()
        )
    }

    // Translate skill
    val translateDir = File(skillsDir, "translate").apply { mkdirs() }
    val translateSkill = File(translateDir, "SKILL.md")
    if (!translateSkill.exists()) {
        translateSkill.writeText(
            """
            |# Translate
            |
            |Trigger: translate, translation, in english, in spanish, how do you say, what does mean
            |
            |## Description
            |Translate text between languages.
            |
            |## Instructions
            |When translating:
            |
            |1. Identify source and target languages
            |   - If not specified, translate TO user's preferred language
            |   - Check memory for language preferences
            |
            |2. Provide the translation directly
            |   - Include pronunciation hints for non-Latin scripts
            |   - Note any nuances or alternative meanings
            |
            |3. For longer texts, translate paragraph by paragraph
            |
            |4. If source language is unclear, detect it first
            |
            |Supported: All major languages including English, Spanish,
            |French, German, Chinese, Japanese, Korean, Arabic, Russian, etc.
            """.trimMargin()
        )
    }

    // Calculator skill
    val calcDir = File(skillsDir, "calculator").apply { mkdirs() }
    val calcSkill = File(calcDir, "SKILL.md")
    if (!calcSkill.exists()) {
        calcSkill.writeText(
            """
            |# Calculator
            |
            |Trigger: calculate, math, convert, how much is, percentage, divide, multiply, plus, minus
            |
            |## Description
            |Perform calculations, unit conversions, and math operations.
            |
            |## Instructions
            |For calculations:
            |
            |1. Parse the mathematical expression
            |
            |2. Show work for complex calculations (step by step)
            |   Just the answer for simple arithmetic
            |
            |3. Unit conversions supported:
            |   - Temperature: C/F/K
            |   - Length: m/ft/in/cm/km/mi
            |   - Weight: kg/lb/g/oz
            |   - Volume: L/gal/ml
            |   - Currency: Use web_search for current rates
            |
            |4. Percentages: X% of Y, tip calculations
            |
            |5. Date math: days between dates, X days from now
            |
            |Format results clearly with units.
            """.trimMargin()
        )
    }

    // Summarize skill
    val summarizeDir = File(skillsDir, "summarize").apply { mkdirs() }
    val summarizeSkill = File(summarizeDir, "SKILL.md")
    if (!summarizeSkill.exists()) {
        summarizeSkill.writeText(
            """
            |# Summarize
            |
            |Trigger: summarize, summary, tldr, sum up, key points, main ideas, recap
            |
            |## Description
            |Summarize web pages, articles, or text content.
            |
            |## Instructions
            |When summarizing:
            |
            |1. If given a URL, use web_fetch to get the content
            |
            |2. Create a summary with:
            |   - TL;DR: 1-2 sentence overview
            |   - Key Points: 3-5 bullet points
            |   - Details: Important specifics if relevant
            |
            |3. Adjust length based on request:
            |   - "quick summary" = TL;DR only
            |   - "detailed summary" = all sections
            |   - Default = TL;DR + Key Points
            |
            |4. For long content, focus on most important 20%
            |
            |5. Offer to save summary to memory if important
            """.trimMargin()
        )
    }

    // Timer skill
    val timerDir = File(skillsDir, "timer").apply { mkdirs() }
    val timerSkill = File(timerDir, "SKILL.md")
    if (!timerSkill.exists()) {
        timerSkill.writeText(
            """
            |---
            |name: timer
            |description: "Set countdown timers for cooking, workouts, or any timed activity"
            |emoji: "⏱️"
            |---
            |
            |# Timer
            |
            |## Instructions
            |When the user wants a timer:
            |
            |1. Parse the duration:
            |   - "5 minutes", "30 seconds", "1 hour"
            |   - "5 min timer", "timer for 10 minutes"
            |
            |2. Use reminder_set with the duration:
            |   - Message: "⏱️ Timer complete! [original request]"
            |   - Time: "in X minutes"
            |
            |3. Confirm the timer is set with the end time
            |
            |4. For very short timers (<1 min), note that there may be a slight delay
            |
            |Examples:
            |- "Set a 5 minute timer" → reminder_set("⏱️ Timer done!", "in 5 minutes")
            |- "Timer for 30 minutes for pasta" → reminder_set("⏱️ Pasta timer done!", "in 30 minutes")
            """.trimMargin()
        )
    }

    // Define skill
    val defineDir = File(skillsDir, "define").apply { mkdirs() }
    val defineSkill = File(defineDir, "SKILL.md")
    if (!defineSkill.exists()) {
        defineSkill.writeText(
            """
            |---
            |name: define
            |description: "Look up definitions, word meanings, and etymology"
            |emoji: "📖"
            |---
            |
            |# Define
            |
            |## Instructions
            |When the user asks for a definition:
            |
            |1. Use your knowledge for common words
            |   - Provide clear, concise definition
            |   - Include part of speech
            |   - Give 1-2 example sentences
            |
            |2. For technical/specialized terms:
            |   - Use web_search if unsure
            |   - Include context (field/domain)
            |
            |3. Format:
            |   **word** (part of speech)
            |   Definition: ...
            |   Example: "..."
            |
            |4. If asked about etymology, include word origin
            |
            |5. For multiple meanings, list top 2-3 most common
            """.trimMargin()
        )
    }

    // News skill
    val newsDir = File(skillsDir, "news").apply { mkdirs() }
    val newsSkill = File(newsDir, "SKILL.md")
    if (!newsSkill.exists()) {
        newsSkill.writeText(
            """
            |---
            |name: news
            |description: "Get latest news headlines and current events"
            |emoji: "📰"
            |---
            |
            |# News
            |
            |## Instructions
            |When the user asks about news:
            |
            |1. Determine the topic:
            |   - General news: "what's happening", "news today"
            |   - Topic-specific: "tech news", "sports news", "crypto news"
            |   - Location-specific: "news in Tokyo", "local news"
            |
            |2. Use web_search with relevant queries:
            |   - "latest news [topic] today"
            |   - Include date for freshness
            |
            |3. Format as scannable list:
            |   📰 **Headline 1**
            |   Brief description (1 line)
            |
            |   📰 **Headline 2**
            |   ...
            |
            |4. Provide 3-5 headlines unless asked for more
            |
            |5. Note the time/date of news for context
            |
            |6. Offer to get more details on any story
            """.trimMargin()
        )
    }

    // Todo skill
    val todoDir = File(skillsDir, "todo").apply { mkdirs() }
    val todoSkill = File(todoDir, "SKILL.md")
    if (!todoSkill.exists()) {
        todoSkill.writeText(
            """
            |---
            |name: todo
            |description: "Manage tasks and to-do lists with add, complete, and list operations"
            |emoji: "✅"
            |---
            |
            |# Todo
            |
            |## Instructions
            |Task management using workspace/todo.json file.
            |
            |**Adding tasks:**
            |1. Read current todo.json (or create empty array if missing)
            |2. Add new task: { "id": timestamp, "task": "text", "done": false, "created": ISO date }
            |3. Write updated JSON back
            |4. Confirm: "Added: [task]"
            |
            |**Listing tasks:**
            |1. Read todo.json
            |2. Format as:
            |   ☐ Task 1
            |   ☐ Task 2
            |   ☑ Completed task
            |3. Show count: "3 tasks (1 done)"
            |
            |**Completing tasks:**
            |1. Find task by text match or number
            |2. Set "done": true, add "completed": ISO date
            |3. Confirm: "✅ Completed: [task]"
            |
            |**Clearing completed:**
            |1. Filter out done tasks
            |2. Save cleaned list
            |
            |Use read/write tools on "todo.json" for storage.
            """.trimMargin()
        )
    }

    // Bookmark skill
    val bookmarkDir = File(skillsDir, "bookmark").apply { mkdirs() }
    val bookmarkSkill = File(bookmarkDir, "SKILL.md")
    if (!bookmarkSkill.exists()) {
        bookmarkSkill.writeText(
            """
            |---
            |name: bookmark
            |description: "Save and organize links for later reading"
            |emoji: "🔖"
            |---
            |
            |# Bookmark
            |
            |## Instructions
            |Link management using workspace/bookmarks.json file.
            |
            |**Saving a bookmark:**
            |1. Extract URL from message
            |2. Optionally fetch title using web_fetch
            |3. Add to bookmarks.json:
            |   { "url": "...", "title": "...", "tags": [], "saved": ISO date }
            |4. Confirm: "🔖 Saved: [title]"
            |
            |**Listing bookmarks:**
            |1. Read bookmarks.json
            |2. Format as:
            |   🔖 **Title**
            |   url.com/...
            |   Tags: #tag1 #tag2
            |
            |**Finding bookmarks:**
            |1. Search by tag: "bookmarks tagged #tech"
            |2. Search by text: "find bookmark about React"
            |3. Return matching entries
            |
            |**Deleting bookmarks:**
            |1. Find by URL or title
            |2. Remove from array
            |3. Save updated file
            |
            |Use read/write tools on "bookmarks.json" for storage.
            """.trimMargin()
        )
    }

    // Joke skill
    val jokeDir = File(skillsDir, "joke").apply { mkdirs() }
    val jokeSkill = File(jokeDir, "SKILL.md")
    if (!jokeSkill.exists()) {
        jokeSkill.writeText(
            """
            |---
            |name: joke
            |description: "Tell jokes and make the user laugh"
            |emoji: "😄"
            |---
            |
            |# Joke
            |
            |## Instructions
            |When the user wants humor:
            |
            |1. Tell a joke appropriate to context
            |   - Clean, family-friendly by default
            |   - Adapt to user's humor preferences if known
            |
            |2. Joke types available:
            |   - Puns and wordplay
            |   - One-liners
            |   - Programmer/tech jokes
            |   - Dad jokes
            |   - Knock-knock jokes
            |
            |3. Format:
            |   Just tell the joke naturally
            |   No need to explain unless asked
            |
            |4. If they want more, offer another
            |
            |5. Remember jokes they liked in memory
            """.trimMargin()
        )
    }

    // Quote skill
    val quoteDir = File(skillsDir, "quote").apply { mkdirs() }
    val quoteSkill = File(quoteDir, "SKILL.md")
    if (!quoteSkill.exists()) {
        quoteSkill.writeText(
            """
            |---
            |name: quote
            |description: "Share inspirational quotes and wisdom"
            |emoji: "💭"
            |---
            |
            |# Quote
            |
            |## Instructions
            |When the user wants inspiration:
            |
            |1. Select an appropriate quote:
            |   - Match their mood if apparent
            |   - Consider topics they care about
            |   - Vary sources (philosophers, leaders, authors)
            |
            |2. Format:
            |   "[Quote text]"
            |   — Author Name
            |
            |3. Quote categories:
            |   - Motivation & success
            |   - Life & wisdom
            |   - Creativity & innovation
            |   - Perseverance & resilience
            |   - Humor & lightness
            |
            |4. If they want a specific type, honor that
            |
            |5. Offer to save favorites to memory
            """.trimMargin()
        )
    }

    // ============================================
    // Phase 4: API-Based Skills (using web_fetch)
    // ============================================

    // Crypto Prices skill (CoinGecko - free, no API key)
    val cryptoDir = File(skillsDir, "crypto-prices").apply { mkdirs() }
    val cryptoSkill = File(cryptoDir, "SKILL.md")
    if (!cryptoSkill.exists()) {
        cryptoSkill.writeText(
            """
            |---
            |name: crypto-prices
            |description: "Get real-time cryptocurrency prices and market data from CoinGecko (free, no API key)"
            |metadata:
            |  openclaw:
            |    emoji: "💰"
            |    requires:
            |      bins: []
            |      env: []
            |---
            |
            |# Crypto Prices
            |
            |Get cryptocurrency prices using the free CoinGecko API.
            |
            |## When to Use
            |
            |User asks about:
            |- Crypto prices ("What's Bitcoin at?", "SOL price")
            |- Market data ("Is ETH up or down?")
            |- Multiple coins ("Price of BTC, ETH, and SOL")
            |
            |## API Endpoints
            |
            |### Get single coin price
            |```javascript
            |web_fetch({
            |  url: "https://api.coingecko.com/api/v3/simple/price?ids=bitcoin&vs_currencies=usd"
            |})
            |```
            |
            |### Get multiple coins with 24h change
            |```javascript
            |web_fetch({
            |  url: "https://api.coingecko.com/api/v3/simple/price?ids=bitcoin,ethereum,solana&vs_currencies=usd&include_24hr_change=true"
            |})
            |```
            |
            |## Coin ID Mapping
            |
            || Symbol | CoinGecko ID |
            ||--------|--------------|
            || BTC | bitcoin |
            || ETH | ethereum |
            || SOL | solana |
            || USDC | usd-coin |
            || DOGE | dogecoin |
            || ADA | cardano |
            || XRP | ripple |
            |
            |## Response Format
            |
            |Present prices clearly:
            |```
            |Bitcoin (BTC): ${'$'}45,123.45 (+2.3% 24h)
            |Ethereum (ETH): ${'$'}2,456.78 (-1.2% 24h)
            |```
            |
            |## Rate Limits
            |
            |CoinGecko free tier: 10-30 requests/minute.
            """.trimMargin()
        )
    }

    // Movie & TV skill (TMDB - free with key)
    val movieDir = File(skillsDir, "movie-tv").apply { mkdirs() }
    val movieSkill = File(movieDir, "SKILL.md")
    if (!movieSkill.exists()) {
        movieSkill.writeText(
            """
            |---
            |name: movie-tv
            |description: "Search movies and TV shows, get ratings, recommendations using TMDB"
            |metadata:
            |  openclaw:
            |    emoji: "🎬"
            |    requires:
            |      bins: []
            |      env: []
            |---
            |
            |# Movie & TV
            |
            |Search for movies and TV shows using The Movie Database (TMDB) API.
            |
            |## When to Use
            |
            |User asks about:
            |- Movie info ("Tell me about Dune")
            |- TV shows ("What's Severance about?")
            |- Recommendations ("Movies like Inception")
            |- What's trending
            |
            |## API Key
            |
            |TMDB requires a free API key. Check memory for TMDB_API_KEY.
            |User can get free key at: https://www.themoviedb.org/settings/api
            |
            |## API Endpoints
            |
            |### Search movies
            |```javascript
            |web_fetch({
            |  url: "https://api.themoviedb.org/3/search/movie?api_key={KEY}&query=Dune"
            |})
            |```
            |
            |### Get trending
            |```javascript
            |web_fetch({
            |  url: "https://api.themoviedb.org/3/trending/all/day?api_key={KEY}"
            |})
            |```
            |
            |## Response Format
            |
            |🎬 **Dune: Part Two** (2024)
            |Rating: 8.3/10
            |Genre: Science Fiction, Adventure
            |Synopsis: Follow the mythic journey...
            """.trimMargin()
        )
    }

    // GitHub skill (REST API - optional token)
    val githubDir = File(skillsDir, "github").apply { mkdirs() }
    val githubSkill = File(githubDir, "SKILL.md")
    if (!githubSkill.exists()) {
        githubSkill.writeText(
            """
            |---
            |name: github
            |description: "Search repositories, view issues, check PRs on GitHub"
            |metadata:
            |  openclaw:
            |    emoji: "🐙"
            |    requires:
            |      bins: []
            |      env: ["GITHUB_TOKEN"]
            |---
            |
            |# GitHub
            |
            |Interact with GitHub using the REST API.
            |
            |## When to Use
            |
            |User asks about:
            |- Repositories ("Find Kotlin repos", "My repos")
            |- Issues ("Open issues on X")
            |- Pull requests
            |
            |## Authentication
            |
            |For private repos, check memory for GITHUB_TOKEN.
            |Public repos work without token (lower rate limit).
            |
            |## API Endpoints
            |
            |### Search repos (no auth)
            |```javascript
            |web_fetch({
            |  url: "https://api.github.com/search/repositories?q=language:kotlin+stars:>1000"
            |})
            |```
            |
            |### With auth
            |```javascript
            |web_fetch({
            |  url: "https://api.github.com/user/repos",
            |  headers: {
            |    "Authorization": "Bearer {TOKEN}",
            |    "Accept": "application/vnd.github+json"
            |  }
            |})
            |```
            |
            |## Rate Limits
            |
            |- Unauthenticated: 60 req/hour
            |- Authenticated: 5,000 req/hour
            """.trimMargin()
        )
    }
}
}
