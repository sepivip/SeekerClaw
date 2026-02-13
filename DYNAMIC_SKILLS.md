# Plan: Dynamic Skill Management System (FUTURE)

> **Status:** Planned — will implement after Web Tools Upgrade is complete.
> **Depends on:** Web Tools Upgrade (WEB_TOOLS_UPGRADE.md) being done first.

## Context

SeekerClaw's current skill system is static — skills are bundled as SKILL.md files in `workspace/skills/` and loaded at runtime. Users can't discover, install, or configure new skills without manually creating files. We want a **skill store** experience: browse a public registry, enable skills with one tap (providing API keys where needed), and have the agent immediately gain new capabilities.

## Architecture

```
GITHUB REPO (seekerclaw-skills)          ANDROID APP                    NODE.JS AGENT
┌─────────────────────────┐       ┌──────────────────────┐      ┌──────────────────────┐
│ skill-registry.json     │──────>│ SkillRegistry.kt     │      │ loadSkills()          │
│ registry/               │       │   fetchRegistry()    │      │   reads workspace/    │
│   openrouter-models/    │       │   fetchSkillMd()     │      │   skills/<id>/        │
│     manifest.json       │       ├──────────────────────┤      │   reads SKILL.md      │
│     SKILL.md            │       │ SkillManager.kt      │      │   reads .credentials  │
│   github-api/           │       │   enableSkill()      │─────>│   {{key}} → value     │
│     manifest.json       │       │   disableSkill()     │      │   → <available_skills>│
│     SKILL.md            │       ├──────────────────────┤      └──────────────────────┘
└─────────────────────────┘       │ SkillCredentialStore │
                                  │   encrypt per-skill  │
                                  ├──────────────────────┤
                                  │ SkillsScreen.kt      │
                                  │   4th bottom nav tab  │
                                  │   browse/filter/enable│
                                  └──────────────────────┘
```

**Credential flow:** User enables skill → Android encrypts creds (KeystoreHelper) → writes SKILL.md + `.credentials.json` to `workspace/skills/<id>/` → Node.js `loadSkills()` reads them → replaces `{{paramKey}}` templates in instructions → agent sees resolved skill.

## Files to create/modify

### New GitHub repo: `seekerclaw-skills`
- `skill-registry.json` — master list of all available skills
- `registry/<skill-id>/manifest.json` — per-skill metadata + config params
- `registry/<skill-id>/SKILL.md` — per-skill agent instructions

### New Android files (SeekerClaw repo)
- `app/src/main/java/com/seekerclaw/app/skills/SkillRegistry.kt` — data models + GitHub fetch
- `app/src/main/java/com/seekerclaw/app/skills/SkillCredentialStore.kt` — per-skill encrypted storage
- `app/src/main/java/com/seekerclaw/app/skills/SkillManager.kt` — enable/disable orchestrator
- `app/src/main/java/com/seekerclaw/app/ui/skills/SkillsScreen.kt` — Skills tab UI
- `app/src/main/res/drawable/ic_lucide_puzzle.xml` — bottom nav icon

### Modified files
- `NavGraph.kt` — add SkillsRoute + 4th bottom nav tab
- `ConfigManager.kt` — add `.credentials.json` to export exclusion
- `main.js` — loadSkills() reads .credentials.json, template replacement, `/skills` command

## Existing code to reuse
- `KeystoreHelper.kt` (AES-256-GCM encryption) — reused by SkillCredentialStore
- `ConfigManager.saveConfig()` pattern — encrypt/decrypt via SharedPreferences
- `loadSkills()` in main.js (line ~1097) — already scans workspace/skills/ for SKILL.md
- `parseSkillFile()` in main.js (line ~994) — already parses YAML frontmatter + markdown
- `skill_read` tool in main.js (line ~1434) — agent on-demand skill reading
- `buildSystemBlocks()` — already injects skills into stable/dynamic prompt blocks
- SettingsScreen.kt UI patterns — SectionLabel, ConfigField, AlertDialog, OutlinedTextField

---

## Changes (5 PRs)

### PR 1: GitHub Repo — `seekerclaw-skills` Setup

Create public repo at `github.com/sepivip/seekerclaw-skills`.

**skill-registry.json:**
```json
{
  "version": 1,
  "lastUpdated": "2026-02-13",
  "skills": [
    {
      "id": "openrouter-models",
      "name": "OpenRouter Models",
      "description": "Access GPT-4o, Gemini, Llama and other models via OpenRouter API",
      "tags": ["ai", "models", "multi-model"],
      "path": "registry/openrouter-models",
      "icon": "🤖",
      "author": "SeekerClaw Team"
    },
    {
      "id": "github-api",
      "name": "GitHub API",
      "description": "Create issues, PRs, search repos, manage GitHub projects",
      "tags": ["dev", "github", "code"],
      "path": "registry/github-api",
      "icon": "🐙",
      "author": "SeekerClaw Team"
    }
  ]
}
```

**manifest.json** (per skill):
```json
{
  "id": "openrouter-models",
  "name": "OpenRouter Models",
  "version": "1.0.0",
  "description": "Access GPT-4o, Gemini, Llama and other models via OpenRouter API",
  "author": "SeekerClaw Team",
  "tags": ["ai", "models", "multi-model"],
  "icon": "🤖",
  "configParams": [
    {
      "key": "openrouterApiKey",
      "label": "OpenRouter API Key",
      "type": "secret",
      "required": true,
      "hint": "Get your key at openrouter.ai/keys",
      "placeholder": "sk-or-..."
    }
  ],
  "requires": { "minAppVersion": "1.2.0" }
}
```

**SKILL.md** uses `{{paramKey}}` template variables:
```markdown
---
name: openrouter-models
description: "Access multiple AI models via OpenRouter"
emoji: "🤖"
---
# OpenRouter Models
## Instructions
When the user asks to use a specific model (GPT-4o, Gemini, Llama, etc.),
call the OpenRouter API with key: {{openrouterApiKey}}
...
```

Start with 3 example skills: openrouter-models, crypto-tracker, github-api.

> **Note:** Perplexity API key lives in Settings (like Brave) as a core web_search provider — not in the Skill Store. May move to Skills later if it makes sense.

---

### PR 2: Android Data Layer — SkillRegistry, SkillCredentialStore, SkillManager

**SkillRegistry.kt** — Data models (`@Serializable` with kotlinx.serialization) + GitHub fetch via `HttpURLConnection`:
- `fetchRegistry()` → `SkillRegistryResponse` (from `raw.githubusercontent.com`)
- `fetchManifest(skillPath)` → `SkillManifest`
- `fetchSkillMd(skillPath)` → `String`
- Data classes: `SkillEntry`, `SkillManifest`, `ConfigParam`, `SkillRequirements`

**SkillCredentialStore.kt** — Per-skill encrypted storage:
- Separate SharedPreferences file: `seekerclaw_skill_creds`
- Key format: `skill_{skillId}_{paramKey}` → `Base64(KeystoreHelper.encrypt(value))`
- `saveCredentials(context, skillId, Map<key, value>)`
- `loadCredentials(context, skillId, paramKeys)` → `Map<key, value>`
- `hasRequiredCredentials(context, skillId, params)` → `Boolean`
- `clearCredentials(context, skillId, paramKeys)`

**SkillManager.kt** — Enable/disable orchestrator:
- `enableSkill(context, entry, manifest, credentials)` → suspend fun (IO dispatcher):
  1. Save encrypted credentials to SkillCredentialStore
  2. Fetch SKILL.md from GitHub
  3. Write to `workspace/skills/<id>/SKILL.md`
  4. Write `.credentials.json` (plaintext, app-sandboxed) for Node.js
  5. Write `manifest.json` locally
  6. Add to enabled set in SharedPreferences
- `disableSkill(context, skillId, paramKeys)`:
  1. Delete `workspace/skills/<id>/` directory
  2. Clear encrypted credentials
  3. Remove from enabled set
- `getEnabledSkillIds(context)` → `Set<String>`
- Registry cache: 5-minute TTL in SharedPreferences

---

### PR 3: Android UI — Skills Tab + Navigation

**SkillsScreen.kt** — New bottom nav tab:

```
┌──────────────────────────┐
│ Skills                    │
│ [🔍 Search...           ]│
│ [search] [ai] [crypto]   │  ← tag filter chips
│                           │
│ ┌───────────────────────┐ │
│ │ 🔍 Perplexity Search  │ │  ← SkillCard
│ │ AI-powered web search │●│  ← green dot = enabled
│ │ [search] [ai] [web]   │ │
│ └───────────────────────┘ │
│ ┌───────────────────────┐ │
│ │ 🤖 OpenRouter Models  │ │
│ │ Access GPT-4o, Gemini │ │
│ │ [ai] [models]         │ │
│ └───────────────────────┘ │
│                           │
│ [Home][Console][Skills][⚙]│  ← 4th tab
└──────────────────────────┘
```

**Skill Detail** — ModalBottomSheet on card tap:
- Header: icon + name + author + version
- Full description
- Tags as chips
- Dynamic config form (rendered from `manifest.configParams`):
  - `type: "secret"` → password input
  - `type: "text"` → regular input
  - Pre-populated if skill already enabled
- Enable/Disable button
- Loading states for network operations

**NavGraph.kt changes:**
- Add `@Serializable object SkillsRoute`
- Add to `bottomNavItems` at position 3 (before Settings)
- Add `composable<SkillsRoute> { SkillsScreen() }`
- Add `ic_lucide_puzzle.xml` drawable

---

### PR 4: Node.js — Credential Loading + Template Replacement

**`main.js` changes:**

1. **loadSkills() enhancement** (line ~1097) — after parsing SKILL.md, also read `.credentials.json`:
```javascript
const credsPath = path.join(SKILLS_DIR, entry.name, '.credentials.json');
if (fs.existsSync(credsPath)) {
    skill.credentials = JSON.parse(fs.readFileSync(credsPath, 'utf8'));
}
```

2. **New function: `applySkillCredentials(instructions, credentials)`** — replaces `{{key}}` with values:
```javascript
function applySkillCredentials(instructions, credentials) {
    if (!credentials || Object.keys(credentials).length === 0) return instructions;
    let result = instructions;
    for (const [key, value] of Object.entries(credentials)) {
        result = result.replace(new RegExp(`\\{\\{${key}\\}\\}`, 'g'), value);
    }
    return result;
}
```

3. **Apply in dynamic prompt block** — when matched skills are injected with full instructions, template-replace credentials before injection. The STABLE `<available_skills>` block stays clean (only name + description, no credentials).

4. **Apply in `skill_read` tool** (line ~1936) — when agent reads skill on-demand, return resolved instructions.

5. **Agent self-awareness** — add to `buildSystemBlocks()`:
```
"Skills Management: Users can browse and enable skills from the Skills tab.
Enabled skills appear in your <available_skills> list with credentials auto-injected."
```

6. **`/skills` Telegram command** — list installed skills with credential status indicator.

---

### PR 5: Integration + Polish

- Add `.credentials.json` to `EXPORT_EXCLUDE` in ConfigManager.kt (prevent credential leakage in memory exports)
- Offline graceful degradation (show cached registry, enabled skills still work locally)
- Verify bundled skills and dynamic skills coexist (different directory names, no collisions)
- End-to-end test: enable skill in UI → send Telegram message → agent uses the skill with real API key
- Theme compatibility across all 5 themes

---

## Implementation Order

| PR | Content | Depends On |
|----|---------|------------|
| #1 | GitHub repo + formats + 3 example skills | — |
| #2 | Android data layer (Registry, CredentialStore, Manager) | PR #1 |
| #3 | Android UI (SkillsScreen + 4th nav tab) | PR #2 |
| #4 | Node.js credential loading + template replacement | PR #1 |
| #5 | Integration testing + polish | PR #3 + PR #4 |

PR #3 and PR #4 can be done in parallel (Android UI vs Node.js are independent).

## What we are NOT changing

- Existing skill format (SKILL.md with YAML frontmatter) — fully backward compatible
- Bundled skills in `workspace/skills/` — coexist with dynamic skills
- `parseSkillFile()` — already handles all needed formats
- `findMatchingSkills()` — trigger matching works on all skills equally
- `buildSystemBlocks()` stable/dynamic split — same caching strategy

## Verification

1. **Enable flow**: Skills tab → tap skill → enter API key → Enable → check `workspace/skills/<id>/` has SKILL.md + .credentials.json
2. **Agent integration**: Send message to agent after enabling → verify skill appears in `<available_skills>` → verify `{{key}}` replaced with real value
3. **Disable flow**: Disable skill → verify directory deleted, credentials cleared, agent no longer lists it
4. **Offline**: Turn off WiFi → cached registry shows → enabled skills still work
5. **Export safety**: Export memory → verify `.credentials.json` NOT in ZIP
6. **Backward compat**: Bundled skills (no credentials) still work identically
