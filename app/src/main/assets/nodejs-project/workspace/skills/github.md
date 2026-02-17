---
name: github
version: "1.0.0"
description: "Search repositories, view issues, check PRs, manage GitHub projects"
version: "1.0.0"
metadata:
  openclaw:
    emoji: "🐙"
    requires:
      bins: []
      env: ["GITHUB_TOKEN"]
---

# GitHub

Interact with GitHub using the REST API.

## When to Use

User asks about:
- Repositories ("Find Kotlin repos", "My repos")
- Issues ("Open issues on X", "Create issue")
- Pull requests ("PRs waiting for review")
- User/org info ("Who is torvalds?")

## Authentication

For private repos or higher rate limits, user needs a GitHub Personal Access Token.

Check if stored:
```javascript
memory_search({ query: "GITHUB_TOKEN" })
```

If not found, ask user to:
1. Go to GitHub → Settings → Developer Settings → Personal Access Tokens
2. Create token with appropriate scopes
3. Tell you the token (you'll save it securely)

Save token:
```javascript
memory_save({ content: "GITHUB_TOKEN: ghp_xxxxxxxxxxxx", section: "credentials" })
```

## API Endpoints

Base URL: `https://api.github.com`

### Public (no auth needed, but lower rate limit)

#### Search repositories
```javascript
web_fetch({
  url: "https://api.github.com/search/repositories?q=language:kotlin+stars:>1000&sort=stars"
})
```

#### Get repo info
```javascript
web_fetch({
  url: "https://api.github.com/repos/anthropics/claude-code"
})
```

#### List repo issues
```javascript
web_fetch({
  url: "https://api.github.com/repos/owner/repo/issues?state=open"
})
```

### Authenticated (needs token)

#### User's repositories
```javascript
web_fetch({
  url: "https://api.github.com/user/repos?sort=updated",
  headers: {
    "Authorization": "Bearer {GITHUB_TOKEN}",
    "Accept": "application/vnd.github+json"
  }
})
```

#### Create issue
```javascript
web_fetch({
  url: "https://api.github.com/repos/owner/repo/issues",
  method: "POST",
  headers: {
    "Authorization": "Bearer {GITHUB_TOKEN}",
    "Accept": "application/vnd.github+json",
    "Content-Type": "application/json"
  },
  body: JSON.stringify({
    title: "Bug: Something broke",
    body: "Description of the issue..."
  })
})
```

#### List user's PRs
```javascript
web_fetch({
  url: "https://api.github.com/search/issues?q=is:pr+author:USERNAME+is:open",
  headers: {
    "Authorization": "Bearer {GITHUB_TOKEN}"
  }
})
```

#### Star a repo
```javascript
web_fetch({
  url: "https://api.github.com/user/starred/owner/repo",
  method: "PUT",
  headers: {
    "Authorization": "Bearer {GITHUB_TOKEN}"
  }
})
```

## Search Query Syntax

GitHub search supports qualifiers:
- `language:python` - Filter by language
- `stars:>1000` - Minimum stars
- `pushed:>2024-01-01` - Recently updated
- `user:torvalds` - By user
- `org:microsoft` - By organization
- `topic:machine-learning` - By topic

Example: "TypeScript repos with 500+ stars updated this year"
```
language:typescript stars:>500 pushed:>2024-01-01
```

## Response Format

Present GitHub info clearly:

```
📦 anthropics/claude-code
⭐ 12,345 stars | 🍴 567 forks
Language: TypeScript
Description: Claude's official coding assistant

Last updated: 2 hours ago
Open issues: 42
```

## Rate Limits

- **Unauthenticated:** 60 requests/hour
- **Authenticated:** 5,000 requests/hour

If rate limited, response includes `X-RateLimit-Reset` timestamp.

## Examples

**User:** "Find popular Rust projects"
**Action:** Search repos with language:rust, sort by stars

**User:** "What issues are open on my project?"
**Action:** Get user's token, list issues for their repo

**User:** "Create an issue for the bug we discussed"
**Action:** POST to issues endpoint with title/body from conversation

**User:** "Show my recent PRs"
**Action:** Search user's open PRs across repos
