---
name: news
description: "Get latest news headlines and current events. Use when: user asks about news, current events, 'what's happening', headlines for a topic. Don't use when: user wants a full daily briefing (use briefing skill) or deep research on a topic (use research skill)."
version: "1.0.0"
emoji: "📰"
---

# News

## Use when
- "what's the news?", "latest headlines", "what's happening"
- Topic-specific ("tech news", "crypto news")
- Location-specific ("news in Tokyo")

## Don't use when
- Combined daily briefing with weather + reminders (use briefing)
- Deep analysis of a topic (use research)
- Historical events (use research)

## Instructions
When the user asks about news:

1. Determine the topic:
   - General news: "what's happening", "news today"
   - Topic-specific: "tech news", "sports news", "crypto news"
   - Location-specific: "news in Tokyo", "local news"

2. Use web_search with relevant queries:
   - "latest news [topic] today"
   - Include date for freshness

3. Format as scannable list:
   📰 **Headline 1**
   Brief description (1 line)

   📰 **Headline 2**
   ...

4. Provide 3-5 headlines unless asked for more

5. Note the time/date of news for context

6. Offer to get more details on any story
