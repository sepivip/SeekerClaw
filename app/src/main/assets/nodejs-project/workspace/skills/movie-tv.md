---
name: movie-tv
version: "1.0.0"
description: "Search movies and TV shows, get ratings, recommendations using TMDB (free API)"
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

## When to Use

User asks about:
- Movie info ("Tell me about Dune")
- TV shows ("What's Severance about?")
- Recommendations ("Movies like Inception")
- What's popular/trending
- Ratings and reviews

## API Key

TMDB requires a free API key. Check if user has one stored in memory:
```javascript
memory_search({ query: "TMDB_API_KEY" })
```

If not found, user can get a free key at: https://www.themoviedb.org/settings/api

Note: A valid TMDB API key is required — there is no demo key. Get a free key at the link above.

## API Endpoints

Base URL: `https://api.themoviedb.org/3`

### Search movies

```javascript
web_fetch({
  url: "https://api.themoviedb.org/3/search/movie?api_key={API_KEY}&query=Dune"
})
```

### Search TV shows

```javascript
web_fetch({
  url: "https://api.themoviedb.org/3/search/tv?api_key={API_KEY}&query=Severance"
})
```

### Get movie details

```javascript
web_fetch({
  url: "https://api.themoviedb.org/3/movie/438631?api_key={API_KEY}"
})
```

### Get TV show details

```javascript
web_fetch({
  url: "https://api.themoviedb.org/3/tv/95396?api_key={API_KEY}"
})
```

### Trending today

```javascript
web_fetch({
  url: "https://api.themoviedb.org/3/trending/all/day?api_key={API_KEY}"
})
```

### Movie recommendations

```javascript
web_fetch({
  url: "https://api.themoviedb.org/3/movie/438631/recommendations?api_key={API_KEY}"
})
```

## Response Format

Present movie/TV info clearly:

```
🎬 Dune: Part Two (2024)
Rating: 8.3/10
Runtime: 166 min
Genre: Science Fiction, Adventure

Synopsis: Follow the mythic journey of Paul Atreides as he unites with Chani and the Fremen...

Director: Denis Villeneuve
Cast: Timothée Chalamet, Zendaya, Rebecca Ferguson
```

## Image URLs

TMDB returns poster paths like `/8b8R8l88Qje9dn9OE8PY05Nxl1X.jpg`

Full image URL: `https://image.tmdb.org/t/p/w500{poster_path}`

Sizes: w92, w154, w185, w342, w500, w780, original

## Examples

**User:** "What's the new Dune movie about?"
**Action:** Search for "Dune", get latest result, show details

**User:** "What's trending on Netflix?"
**Action:** Get trending TV, filter popular streaming shows

**User:** "Movies similar to Interstellar"
**Action:** Get Interstellar ID, then fetch recommendations

**User:** "Rate of Oppenheimer"
**Action:** Search movie, return vote_average
