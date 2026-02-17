---
name: dictionary
version: "1.0.0"
description: "Look up word definitions, pronunciation, and etymology using Free Dictionary API"
version: "1.0.0"
metadata:
  openclaw:
    emoji: "📚"
    requires:
      bins: []
      env: []
---

# Dictionary

Look up word definitions using the Free Dictionary API.

## When to Use

User asks about:
- Word definitions ("What does 'ephemeral' mean?")
- Pronunciation ("How do you pronounce 'quinoa'?")
- Word usage ("Use 'ubiquitous' in a sentence")
- Synonyms/antonyms
- Etymology ("Where does 'algorithm' come from?")

## API Endpoint

```javascript
web_fetch({
  url: "https://api.dictionaryapi.dev/api/v2/entries/en/ephemeral"
})
```

Replace `ephemeral` with the word to look up.

## Response Structure

The API returns:
```json
[{
  "word": "ephemeral",
  "phonetic": "/ɪˈfɛm(ə)rəl/",
  "phonetics": [{ "text": "/ɪˈfɛm(ə)rəl/", "audio": "..." }],
  "meanings": [{
    "partOfSpeech": "adjective",
    "definitions": [{
      "definition": "Lasting for a very short time.",
      "example": "Fashions are ephemeral.",
      "synonyms": ["transitory", "fleeting"],
      "antonyms": ["permanent", "lasting"]
    }]
  }],
  "origin": "Late 16th century: from Greek ephēmeros..."
}]
```

## Response Format

Present definitions clearly:

```
📚 **ephemeral** /ɪˈfɛm(ə)rəl/

**adjective**
1. Lasting for a very short time.
   _"Fashions are ephemeral."_

**Synonyms:** transitory, fleeting, momentary
**Antonyms:** permanent, lasting

**Origin:** Late 16th century, from Greek ephēmeros 'lasting only a day'
```

## Multiple Meanings

Some words have multiple parts of speech:

```
📚 **run**

**verb**
1. Move at a speed faster than a walk
2. Manage or be in charge of

**noun**
1. An act of running
2. A continuous period of something
```

## Error Handling

If word not found, API returns 404:
```json
{
  "title": "No Definitions Found",
  "message": "Sorry, we couldn't find definitions..."
}
```

In this case:
- Suggest checking spelling
- Offer to search for similar words
- Use your knowledge as fallback

## Examples

**User:** "Define serendipity"
**Action:** Fetch definition, format nicely

**User:** "How do you say 'charcuterie'?"
**Action:** Get phonetic, include pronunciation guide

**User:** "What's the origin of 'sandwich'?"
**Action:** Fetch word, show origin/etymology

**User:** "Synonyms for 'happy'"
**Action:** Fetch definition, list synonyms
