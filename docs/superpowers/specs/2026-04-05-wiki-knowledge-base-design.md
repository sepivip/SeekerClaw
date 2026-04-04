# Wiki Knowledge Base Layer — Design Spec

**Date:** 2026-04-05
**Status:** Approved
**Inspiration:** [Karpathy's LLM Wiki pattern](https://gist.github.com/karpathy/442a6bf555914893e9891c11519de94f)
**Risk:** LOW — purely additive layer, zero changes to existing memory system

---

## Goal

Add a structured knowledge base (`wiki/` directory) that the agent automatically maintains. Named entities, concepts, and durable facts get their own pages with metadata. The existing memory system (MEMORY.md, daily notes) stays untouched.

## Constraints

- Zero migration for 5,300+ existing users
- Purely additive — existing memory tools unchanged
- No new dependencies
- Works on Node 18 (SQL.js, no native bindings)
- Agent proactively creates/updates pages — no user prompt needed
- Wiki pages are human-readable markdown (user can browse workspace/)

## Architecture

### Filesystem

```
workspace/
├── MEMORY.md              (unchanged — general preferences, quick facts)
├── memory/                (unchanged — daily notes)
│   ├── 2026-04-01.md
│   └── 2026-04-05.md
├── wiki/                  (NEW — structured knowledge pages)
│   ├── people/
│   │   ├── mom.md
│   │   └── alex.md
│   ├── projects/
│   │   └── seekerclaw.md
│   ├── crypto/
│   │   ├── solana.md
│   │   └── jupiter.md
│   └── topics/
│       └── cooking.md
├── SOUL.md                (unchanged)
├── IDENTITY.md            (unchanged)
├── USER.md                (unchanged)
└── HEARTBEAT.md           (unchanged)
```

Subdirectories are created by the agent based on category. The agent decides the directory structure organically — no fixed schema.

### Page Format

Every wiki page has YAML frontmatter (same pattern as SKILL.md):

```yaml
---
title: Mom
category: people
tags: [family, contacts]
created: 2026-04-05
updated: 2026-04-05
---

# Mom

- Name: Sarah
- Prefers morning calls (before 10am)
- Birthday: March 15
- Lives in Tbilisi

## Notes
- Loves gardening, especially roses
- Allergic to cats
```

**Required fields:** title, category, created, updated
**Optional fields:** tags (array), related (array of other page paths)

### Knowledge Routing Rules

The agent follows these rules (injected via system prompt):

| Knowledge type | Destination | Example |
|---------------|-------------|---------|
| Named entities (people, places, projects, tokens, tools) | `wiki/` page | "Mom prefers morning calls" → `wiki/people/mom.md` |
| General preferences, opinions | `MEMORY.md` | "User likes dark mode" |
| Temporal events, conversations | `memory/*.md` daily notes | "Had a meeting about X today" |
| Quick reminders, todos | `MEMORY.md` or cron | "Remember to call dentist" |

**Key rule:** If the agent learns something about a named entity that already has a wiki page, it updates the existing page rather than creating a duplicate.

## Tools (4 new)

### wiki_save

Create or update a wiki page. If the page exists, the agent merges new information into the existing content (doesn't overwrite).

```javascript
{
    name: 'wiki_save',
    description: 'Create or update a wiki knowledge page. Use for named entities (people, projects, tokens, places) and durable concepts. If the page exists, merge new information — do not overwrite. Always include YAML frontmatter with title, category, tags, created, updated.',
    input_schema: {
        type: 'object',
        properties: {
            path: { type: 'string', description: 'Relative path in wiki/ (e.g., "people/mom.md", "crypto/solana.md")' },
            content: { type: 'string', description: 'Full markdown content including YAML frontmatter' },
        },
        required: ['path', 'content'],
    },
}
```

**Behavior:**
- If file doesn't exist: create it (and parent directories)
- If file exists: agent reads current content first (via wiki_read), merges, then saves
- Updates `updated` field in frontmatter automatically
- File indexed into SQL.js chunks table with `source: "wiki"`

### wiki_read

Read a specific wiki page.

```javascript
{
    name: 'wiki_read',
    description: 'Read a wiki knowledge page. Returns the full content including frontmatter.',
    input_schema: {
        type: 'object',
        properties: {
            path: { type: 'string', description: 'Relative path in wiki/ (e.g., "people/mom.md")' },
        },
        required: ['path'],
    },
}
```

### wiki_search

Search wiki pages by keyword or tag.

```javascript
{
    name: 'wiki_search',
    description: 'Search wiki knowledge pages by keyword or tag. Returns matching page titles, paths, and content snippets. Use before wiki_read to find the right page.',
    input_schema: {
        type: 'object',
        properties: {
            query: { type: 'string', description: 'Search keywords or tag name' },
            max_results: { type: 'number', description: 'Maximum results to return (default 10)' },
        },
        required: ['query'],
    },
}
```

**Behavior:**
- Searches SQL.js chunks table where `source = "wiki"`
- Same TF + recency ranking as existing memory_search
- Also matches tags from frontmatter (if query matches a tag, boost those results)
- Returns: path, title, tags, snippet (500 chars), last updated

### wiki_delete

Remove a wiki page.

```javascript
{
    name: 'wiki_delete',
    description: 'Delete a wiki page. Use when information is confirmed wrong or no longer relevant. Logs the deletion reason.',
    input_schema: {
        type: 'object',
        properties: {
            path: { type: 'string', description: 'Relative path in wiki/ (e.g., "people/old-contact.md")' },
            reason: { type: 'string', description: 'Why this page is being deleted' },
        },
        required: ['path', 'reason'],
    },
}
```

**Behavior:**
- Deletes the file from workspace/wiki/
- Removes chunks from SQL.js index
- Logs deletion reason to daily note

## Indexing

Wiki pages are indexed into the existing SQL.js `chunks` table with `source: "wiki"`. This means:

- `memory_search` finds results from wiki pages too (no tool change needed)
- `wiki_search` filters to `source = "wiki"` only
- Indexing runs on startup and when files change (same pipeline as memory files)
- Chunks split on `##`/`###` headers or double-newlines (same logic)

**Tag indexing:** YAML frontmatter tags are extracted and stored as a searchable chunk with the format: `[tags: family, contacts]`. This allows tag-based search without a separate tags table.

## System Prompt Changes

Add to `buildSystemBlocks()` in ai.js:

### Wiki Knowledge Base section

```
## Wiki Knowledge Base

You maintain a structured knowledge base in wiki/. Use it for durable, entity-specific knowledge.

**When to create a wiki page:**
- You learn about a named entity (person, project, token, place, tool)
- You discover a concept the user cares about deeply
- Information is durable (relevant beyond today)

**When NOT to create a wiki page:**
- Temporary events → daily_note
- General preferences → memory_save
- Quick todos/reminders → memory_save or cron

**How to use:**
1. Before saving: wiki_search to check if a page exists
2. If exists: wiki_read → merge new info → wiki_save
3. If new: wiki_save with frontmatter (title, category, tags, created, updated)
4. Keep pages focused — one entity per page
5. Cross-reference: mention related pages in content ("See also: wiki/crypto/solana.md")

**Categories:** people, projects, crypto, topics, places, tools (agent creates as needed)
```

### Extend Memory Recall section

Add to existing Memory Recall instructions:

```
5. For entity-specific questions ("what do I know about Mom?"), check wiki_search first.
```

## What Does NOT Change

- MEMORY.md — unchanged, still used for general preferences
- memory/*.md — unchanged, still used for daily notes
- SOUL.md, IDENTITY.md, USER.md, HEARTBEAT.md — unchanged
- memory_save, memory_read, memory_search, daily_note, memory_get, memory_stats — unchanged
- Existing indexing pipeline — extended, not replaced
- Existing users — wiki/ directory simply doesn't exist until the agent creates it

## Edge Cases

- **First message after update:** Agent has no wiki pages. System prompt tells it about the wiki but there's nothing to search. Agent starts creating pages naturally as it learns.
- **Large wiki (100+ pages):** SQL.js search handles this fine. Directory listing via `ls wiki/` if agent needs to browse.
- **Duplicate pages:** Agent should search before creating. System prompt emphasizes "check if a page exists first." If duplicates happen, agent can merge and delete.
- **Page conflicts (multiple conversations):** Not an issue — single-threaded message processing via chatQueues. Only one conversation writes at a time.

## Future Enhancements (NOT in v1)

- **Wiki lint in heartbeat** — "Check wiki for stale pages (not updated in 60+ days)"
- **Ingest workflow** — User shares a document, agent extracts entities and creates wiki pages
- **Wiki summary** — `/wiki` command shows table of contents with page count per category
- **FTS5 search** — Full-text search for phrase matching (when SQL.js FTS is implemented)
- **Cross-references** — Parse `See also:` links and build a relationship graph

## Acceptance Criteria

- [ ] `wiki/` directory created by agent on first wiki_save
- [ ] 4 tools: wiki_save, wiki_read, wiki_search, wiki_delete
- [ ] YAML frontmatter on every page (title, category, tags, created, updated)
- [ ] Wiki pages indexed into SQL.js chunks table (source: "wiki")
- [ ] memory_search returns results from wiki pages too
- [ ] System prompt includes wiki knowledge base instructions
- [ ] Agent proactively creates pages for named entities
- [ ] Existing memory system completely untouched
- [ ] Zero migration for existing users
- [ ] Device test: agent creates wiki page, searches it, updates it
