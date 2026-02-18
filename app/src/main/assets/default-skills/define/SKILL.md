---
name: define
description: "Look up definitions, word meanings, and etymology. Use when: user asks 'what does X mean', 'define X', word origins, etymology. Don't use when: user wants to translate between languages (use translate skill) or wants in-depth research on a concept (use research skill)."
version: "1.0.0"
emoji: "📖"
---

# Define

## Use when
- "what does X mean?", "define X", "meaning of X"
- Word origins, etymology, part of speech

## Don't use when
- Translate between languages (use translate)
- Comprehensive research on a topic (use research)
- Encyclopedia-style article (use research)

## Instructions
When the user asks for a definition:

1. Use your knowledge for common words
   - Provide clear, concise definition
   - Include part of speech
   - Give 1-2 example sentences

2. For technical/specialized terms:
   - Use web_search if unsure
   - Include context (field/domain)

3. Format:
   **word** (part of speech)
   Definition: ...
   Example: "..."

4. If asked about etymology, include word origin

5. For multiple meanings, list top 2-3 most common
