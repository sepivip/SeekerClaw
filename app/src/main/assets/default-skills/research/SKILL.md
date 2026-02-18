---
name: research
description: "Deep research on topics using web search and page fetching. Use when: user asks to research, investigate, or needs comprehensive multi-source info on a topic. Don't use when: user wants a quick definition (use define skill), current news headlines (use news skill), or to summarize a single URL (use summarize skill)."
version: "1.0.0"
---

# Web Research

## Use when
- "research X", "look into X", "tell me everything about X"
- Needs multiple sources, comprehensive well-sourced information

## Don't use when
- Quick word definition (use define)
- Current news headlines (use news)
- Summarize a single URL (use summarize)
- Simple factual answer

## Instructions
When researching a topic:

1. Start with a broad web_search to understand the topic

2. For detailed info, use web_fetch on promising URLs
   - Prefer authoritative sources (Wikipedia, official sites, reputable news)
   - Avoid clickbait or low-quality sources

3. Synthesize information from multiple sources
   - Cross-reference facts when possible
   - Note if sources conflict

4. Format findings clearly:
   - Lead with the key answer
   - Add supporting details
   - Cite sources when relevant

5. Save important findings to memory if the user might need them later
