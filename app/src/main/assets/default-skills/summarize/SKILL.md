---
name: summarize
description: "Summarize web pages, articles, or text content"
version: "1.0.0"
---

# Summarize

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
