---
name: movie-tv
description: "Search movies and TV shows, get ratings, recommendations using TMDB. Use when: user asks about movies, TV shows, ratings, 'what should I watch', trending shows. Don't use when: user asks about YouTube videos, music, or live TV schedules."
version: "1.0.0"
metadata:
  openclaw:
    emoji: "🎬"
    requires:
      bins: []
      env: []
---

# Movie & TV

Search for movies and TV shows using The Movie Database (TMDB) API.

## Use when
- Movie info ("Tell me about Dune")
- TV shows ("What's Severance about?")
- Recommendations ("Movies like Inception")
- What's trending

## Don't use when
- YouTube videos or online content
- Music/podcasts/audiobooks
- Live TV schedules or streaming availability

## API Key

TMDB requires a free API key. Check memory for TMDB_API_KEY.
User can get free key at: https://www.themoviedb.org/settings/api

## API Endpoints

### Search movies
```javascript
web_fetch({
  url: "https://api.themoviedb.org/3/search/movie?api_key={KEY}&query=Dune"
})
```

### Get trending
```javascript
web_fetch({
  url: "https://api.themoviedb.org/3/trending/all/day?api_key={KEY}"
})
```

## Response Format

🎬 **Dune: Part Two** (2024)
Rating: 8.3/10
Genre: Science Fiction, Adventure
Synopsis: Follow the mythic journey...
