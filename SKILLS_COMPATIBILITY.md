# OpenClaw Skills → Android Compatibility

> **Analysis of all 54 OpenClaw skills for SeekerClaw Android compatibility**

---

## Executive Summary

| Category | Count | Notes |
|----------|-------|-------|
| **Works As-Is** | 5 | API-based, no external deps |
| **Works With Mods** | 18 | Need Node.js rewrites |
| **Cannot Work** | 31 | macOS/desktop only |
| **Total OpenClaw Skills** | 54 | |

**SeekerClaw can support ~42% of OpenClaw skills** with appropriate adaptations.

---

## ✅ Skills That Work As-Is (5)

These can be ported directly with minimal changes:

| Skill | Description | Notes |
|-------|-------------|-------|
| **weather** | Weather forecasts | No API key, curl-based |
| **clawhub** | NPM package management | Node-based CLI |
| **healthcheck** | Security auditing | Read-only checks |
| **session-logs** | Search conversation history | Requires jq + rg |
| **coding-agent** | Run coding CLIs | Bash with PTY |

---

## 🟡 Skills That Need Adaptation (18)

These require Node.js rewrites or API changes:

### Low Effort (Can implement quickly)

| Skill | Current | Android Adaptation | Effort |
|-------|---------|-------------------|--------|
| **notion** | REST API | Works with axios | LOW |
| **github** | `gh` CLI | Use GitHub API directly | LOW |
| **trello** | curl + jq | Node.js HTTP client | LOW |
| **gemini** | `gemini` CLI | Gemini API via axios | LOW |
| **gifgrep** | Binary | Tenor/Giphy API | LOW |
| **blogwatcher** | Go CLI | `feed-reader` npm | LOW |
| **goglaces** | `goplaces` CLI | Google Places API | LOW |
| **local-places** | Python uvicorn | Express + API | LOW |
| **openai-image-gen** | Python | OpenAI API via Node | LOW |
| **openai-whisper-api** | Bash script | OpenAI API via Node | LOW |
| **sag** | ElevenLabs CLI | ElevenLabs API | LOW |
| **nano-banana-pro** | Python | Gemini API | LOW |

### Medium Effort (More complex)

| Skill | Current | Android Adaptation | Effort |
|-------|---------|-------------------|--------|
| **himalaya** | Email CLI | imap + nodemailer npm | MEDIUM |
| **summarize** | CLI | Web scraping + LLM | MEDIUM |
| **discord** | Channel plugin | Gateway relay | MEDIUM |
| **slack** | Channel plugin | Gateway relay | MEDIUM |

### High Effort (Complex but possible)

| Skill | Current | Android Adaptation | Effort |
|-------|---------|-------------------|--------|
| **bird** | Twitter CLI | GraphQL API wrapper | HIGH |
| **spotify-player** | Binary | Spotify API + OAuth | HIGH |

---

## ❌ Skills That Cannot Work (31)

### macOS App Integration (9)

These require macOS-specific automation:

| Skill | Blocker |
|-------|---------|
| **1password** | macOS app + desktop CLI |
| **apple-notes** | Notes.app Automation |
| **apple-reminders** | Reminders.app Automation |
| **bear-notes** | Bear app (macOS only) |
| **imsg** | Messages.app + Full Disk Access |
| **peekaboo** | macOS accessibility APIs |
| **things-mac** | Things 3 database |
| **model-usage** | CodexBar app (macOS) |
| **obsidian** | Local vault + app integration |

### Audio/Video Processing (6)

| Skill | Blocker |
|-------|---------|
| **openai-whisper** | Python + 100GB model files |
| **sherpa-onnx-tts** | ONNX runtime + models |
| **songsee** | Compiled binary (no ARM64) |
| **camsnap** | ffmpeg binary (partial) |
| **video-frames** | ffmpeg binary (partial) |

### Hardware/IoT (5)

| Skill | Blocker | Possible? |
|-------|---------|-----------|
| **blucli** | Bluesound network API | PARTIAL |
| **eightctl** | Eight Sleep proprietary API | NO |
| **openhue** | Hue Bridge discovery | PARTIAL |
| **sonoscli** | Sonos network API | PARTIAL |
| **wacli** | WhatsApp Web + browser | NO |

### Terminal/System (4)

| Skill | Blocker |
|-------|---------|
| **tmux** | No tmux on Android |
| **mcporter** | MCP servers (desktop) |
| **oracle** | CLI binary + bundling |
| **skill-creator** | Local file scaffolding |

### Service-Specific (7)

| Skill | Blocker |
|-------|---------|
| **bluebubbles** | BlueBubbles server (macOS) |
| **food-order** | ordercli + Cloudflare bypass |
| **ordercli** | Browser automation for captchas |
| **canvas** | WebView + desktop nodes |
| **nano-pdf** | PDF manipulation libraries |

---

## Implementation Plan for SeekerClaw

### Phase 1: Core Skills (Priority: HIGH)

Already bundled or easy to add:

| Skill | Status | Action |
|-------|--------|--------|
| weather | ✅ Bundled | Done |
| research | ✅ Bundled | Done |
| summarize | ✅ Bundled | Done |
| news | ✅ Bundled | Done |
| reminders | ✅ Bundled | Done |
| todo | ✅ Bundled | Done |
| bookmark | ✅ Bundled | Done |
| translate | ✅ Bundled | Done |
| calculator | ✅ Bundled | Done |

### Phase 2: API-Based Skills (Priority: MEDIUM)

New skills to implement:

| Skill | Effort | Dependencies |
|-------|--------|--------------|
| **github** | LOW | GitHub token |
| **notion** | LOW | Notion API key |
| **trello** | LOW | Trello API key |
| **gemini** | LOW | Gemini API key |
| **gifgrep** | LOW | Tenor/Giphy API |
| **blogwatcher** | LOW | None (RSS) |

### Phase 3: Extended Skills (Priority: LOW)

Future enhancements:

| Skill | Effort | Notes |
|-------|--------|-------|
| **himalaya** (email) | MEDIUM | IMAP/SMTP setup |
| **openai-image-gen** | LOW | OpenAI key |
| **sag** (TTS) | LOW | ElevenLabs key |
| **discord** relay | MEDIUM | Gateway config |
| **slack** relay | MEDIUM | Gateway config |

---

## Skills NOT Supported (Document for Users)

Users should know these OpenClaw skills won't work on SeekerClaw:

### Apple/macOS Features
- Apple Notes, Reminders, iMessage
- Bear Notes, Things 3, Obsidian (local)
- 1Password CLI integration
- Peekaboo (screen automation)

### Desktop Hardware
- Sonos/Bluesound/Hue (complex setup)
- Local Whisper/TTS models

### Browser Automation
- WhatsApp Web CLI
- Food ordering (Cloudflare bypass)

### Terminal Tools
- tmux integration
- MCP server management

---

## Comparison: SeekerClaw vs OpenClaw

| Feature | OpenClaw | SeekerClaw |
|---------|----------|------------|
| Total Skills | 54 | 15 bundled + 6 planned |
| macOS Integration | ✅ Full | ❌ None |
| API-Based Skills | ✅ Full | ✅ Full |
| Hardware Control | ✅ Full | 🟡 Limited |
| Audio/Video | ✅ Full | 🟡 Limited |
| Multi-Channel | ✅ Full | ❌ Telegram only |
| Memory System | ✅ SQLite + FTS | 🟡 File-based |
| Runs 24/7 | 🟡 Desktop | ✅ Mobile |
| Portable | ❌ No | ✅ Yes |

---

## Adding New Skills

Users can add custom skills to `workspace/skills/`:

```markdown
---
name: my-skill
description: "What this skill does"
emoji: "🔧"
---

# My Skill

## Instructions
...
```

Skills that only need web APIs (no binaries) will work on SeekerClaw.

---

## Key Constraints

1. **No external binaries** — Must use Node.js or web APIs
2. **No macOS automation** — Apple ecosystem not accessible
3. **No browser automation** — No Puppeteer/Playwright
4. **No large models** — Storage limited on mobile
5. **Telegram only** — Single channel by design
6. **Node 18** — No `node:sqlite` (Node 22 feature)

---

*Last updated: 2026-02-04*
