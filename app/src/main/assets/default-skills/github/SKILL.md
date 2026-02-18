---
name: github
description: "Search repositories, view issues, check PRs on GitHub. Use when: user asks about GitHub repos, issues, PRs, or wants to search GitHub. Don't use when: user wants general web search (use research skill) or asks about git concepts without GitHub context."
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

## Use when
- Repositories ("Find Kotlin repos", "My repos")
- Issues ("Open issues on X")
- Pull requests

## Don't use when
- General web search (use research)
- Git concepts without GitHub context
- Non-GitHub code hosting

## Authentication

For private repos, check memory for GITHUB_TOKEN.
Public repos work without token (lower rate limit).

## API Endpoints

### Search repos (no auth)
```javascript
web_fetch({
  url: "https://api.github.com/search/repositories?q=language:kotlin+stars:>1000"
})
```

### With auth
```javascript
web_fetch({
  url: "https://api.github.com/user/repos",
  headers: {
    "Authorization": "Bearer {TOKEN}",
    "Accept": "application/vnd.github+json"
  }
})
```

## Rate Limits

- Unauthenticated: 60 req/hour
- Authenticated: 5,000 req/hour
