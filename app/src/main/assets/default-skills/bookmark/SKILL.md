---
name: bookmark
description: "Save and organize links for later reading. Use when: user wants to save a URL, manage bookmarks, find a saved link. Don't use when: user just wants to read/fetch a URL (use web_fetch) or research a topic (use research skill)."
version: "1.0.0"
emoji: "🔖"
---

# Bookmark

## Use when
- Save this link, bookmark this
- Find a previously saved link
- Organize or tag saved URLs

## Don't use when
- Just read a webpage (use web_fetch)
- Research a topic (use research)
- Summarize a URL (use summarize)

## Instructions
Link management using workspace/bookmarks.json file.

**Saving a bookmark:**
1. Extract URL from message
2. Optionally fetch title using web_fetch
3. Add to bookmarks.json:
   { "url": "...", "title": "...", "tags": [], "saved": ISO date }
4. Confirm: "🔖 Saved: [title]"

**Listing bookmarks:**
1. Read bookmarks.json
2. Format as:
   🔖 **Title**
   url.com/...
   Tags: #tag1 #tag2

**Finding bookmarks:**
1. Search by tag: "bookmarks tagged #tech"
2. Search by text: "find bookmark about React"
3. Return matching entries

**Deleting bookmarks:**
1. Find by URL or title
2. Remove from array
3. Save updated file

Use read/write tools on "bookmarks.json" for storage.
