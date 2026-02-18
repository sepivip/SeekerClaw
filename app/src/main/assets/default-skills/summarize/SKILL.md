---
name: summarize
description: "Summarize web pages, articles, or text content. Use when: user shares a URL to summarize, asks for TL;DR, or wants key points from content. Don't use when: user wants to save the link (use bookmark skill) or wants full multi-source research (use research skill)."
version: "1.0.0"
---

# Summarize

## Use when
- URL + "summarize this"/"TL;DR"/"key points"
- Pastes text and wants shorter version
- "what's this article about?"

## Don't use when
- Save link for later (use bookmark)
- Full multi-source research (use research)
- Fetch raw page content without summarizing (use web_fetch)

## Instructions
When summarizing:

1. If given a URL, use web_fetch to get the content

2. Create a summary with:
   - TL;DR: 1-2 sentence overview
   - Key Points: 3-5 bullet points
   - Details: Important specifics if relevant

3. Adjust length based on request:
   - "quick summary" = TL;DR only
   - "detailed summary" = all sections
   - Default = TL;DR + Key Points

4. For long content, focus on most important 20%

5. Offer to save summary to memory if important
