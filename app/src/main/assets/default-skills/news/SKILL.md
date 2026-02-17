---
name: news
description: "Get latest news headlines and current events"
version: "1.0.0"
emoji: "📰"
---

# News

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
