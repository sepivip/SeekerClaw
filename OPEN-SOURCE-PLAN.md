# Open Source Preparation Plan

> **Goal:** Prepare SeekerClaw for public release on GitHub.
> **Status:** Planning
> **Date:** 2026-02-22

---

## Pre-Flight: What's Already Safe

| Check | Result |
|-------|--------|
| `.env` in git history | Never committed |
| `.claude/` in git history | Never committed |
| Hardcoded API keys in source | None (only placeholder examples) |
| Signing keystores committed | No (gitignored) |
| `google-services.json` committed | No (gitignored) |
| Dependency licenses | All permissive (MIT, Apache 2.0, BSD) |

**No git history rewriting needed.**

---

## Phase 1: Rotate Secrets (Manual)

> Do this before making the repo public. These keys are in local files only (`.env`, Claude memory), not in git — but rotate as a precaution.

- [ ] **Linear API key** — regenerate at [Linear Settings > API](https://linear.app/settings/api)
- [ ] **Jupiter API key** — regenerate at [portal.jup.ag](https://portal.jup.ag)
- [ ] Update local `.env` with new keys

---

## Phase 2: Remove Tracked Build Artifacts

These files are tracked in git but shouldn't be public:

| File | Reason |
|------|--------|
| `build_output.txt` | Build debug artifact |
| `compile_out.txt` | Build debug artifact |
| `.mcp.json` | Developer-specific MCP config |

**Actions:**
- [ ] `git rm --cached build_output.txt compile_out.txt .mcp.json`
- [ ] Add to `.gitignore`:
  ```
  build_output.txt
  compile_out.txt
  .mcp.json
  ```

---

## Phase 3: Move Internal Docs → `docs/internal/`

These 17 files are audit reports, strategy docs, and internal plans that clutter the root. Move them to `docs/internal/` to keep the root clean for contributors.

**Move these:**
- [ ] `HEARTBEAT-AUDIT.md`
- [ ] `IDEAS-VAULT.md`
- [ ] `JUPITER-AUDIT.md`
- [ ] `JUPITER-TEST-CHECKLIST.md`
- [ ] `LOG-AUDIT.md`
- [ ] `OWNER-GATE-AUDIT.md`
- [ ] `P1-VALIDATION.md`
- [ ] `P2-PLAN.md`
- [ ] `PARITY-AUDIT.md`
- [ ] `REFACTOR-REPORT.md`
- [ ] `SAB-AUDIT-v1.md`
- [ ] `SAB-AUDIT-v2.md`
- [ ] `SAB-AUDIT-v3.md`
- [ ] `SETTINGS_INFO.md`
- [ ] `SPLIT-PROPOSAL.md`
- [ ] `TIMEOUT-AUDIT.md`
- [ ] `WEBSITE.md`

**Keep at root** (useful for contributors):

| File | Purpose |
|------|---------|
| `CLAUDE.md` | AI development & architecture guide |
| `PROJECT.md` | Project source of truth |
| `RESEARCH.md` | Technical feasibility research |
| `CHANGELOG.md` | Release history |
| `OPENCLAW_TRACKING.md` | Upstream sync reference |
| `SKILL-FORMAT.md` | Skill authoring guide |
| `TEMPLATES.md` | Message template reference |

---

## Phase 4: Make Firebase Analytics Build-Optional (BAT-258)

> **Assigned to other instance.** See [BAT-258](https://linear.app/batcave/issue/BAT-258/make-firebase-analytics-build-optional-for-open-source).

Firebase Analytics is a hard dependency — without `google-services.json`, fresh clones **won't build**. Make it conditional so your published builds get analytics while open-source clones build fine.

**Approach:**
- [ ] Make `com.google.gms.google-services` Gradle plugin conditional (only apply when `google-services.json` exists)
- [ ] Verify `Analytics.kt` null-safety (already uses `fb?` — ensure init handles missing Firebase)
- [ ] Guard `Analytics.init()` in `SeekerClawApplication.kt` with try-catch
- [ ] Keep Firebase deps in `gradle/libs.versions.toml` (they compile fine without the plugin)
- [ ] Keep `google-services.json` in `.gitignore` (already there)

**Verification:**
- [ ] Remove `google-services.json` temporarily → build succeeds, analytics are no-ops
- [ ] Restore `google-services.json` → build succeeds with Firebase active

---

## Phase 5: Trim CLAUDE.md

Transform from internal team guide → public contributor guide. (~625 lines → ~300 lines)

### Keep (essential for contributors)

| Section | Why |
|---------|-----|
| What Is This Project | Project description + supported devices |
| Tech Stack | Full stack overview |
| Project Structure | Directory tree |
| Architecture | ASCII diagram + component explanation |
| Screens (4 total) | UI overview |
| Design Theme (Dark Only) | Color tokens for UI work |
| Key Permissions | Manifest permissions reference |
| MCP Servers | Remote tools overview |
| Memory Preservation (CRITICAL) | Rules for protecting user data |
| Agent Self-Awareness | Rules for updating system prompt |
| Key Implementation Details | Node.js JNI architecture (critical) |
| Android Bridge | Endpoints table + usage example |
| Build & Run | Build commands |

### Remove (internal process / historical / duplicated in code)

| Section | Why Remove |
|---------|-----------|
| PROJECT.md — Source of Truth | Internal process rules |
| Design Principle: UX First | Internal team principle |
| Development Phases | Historical, already completed |
| Version Tracking table | Move to CONTRIBUTING.md |
| Model List | Defined in `Models.kt` |
| QR Config Payload | Implementation detail, in code |
| OpenClaw Config Generation | Implementation detail, in code |
| Workspace Seeding | Implementation detail, in code |
| Watchdog Timing | Constants in `Watchdog.kt` |
| Build Priority Order | Historical, already built |
| File System Layout | Too detailed for contributor guide |
| Mobile-Specific Config | Too detailed for contributor guide |
| What NOT to Build | Internal scope decision |
| Reference Documents | Links move to README |
| OpenClaw Version Tracking | Internal sync process |
| OpenClaw Compatibility (entire section) | Internal parity tracking |
| Theme (end section) | Duplicate of Design Theme |
| `BAT-59` reference | Internal task tracker reference |

---

## Phase 6: Create New Files

### 6A: `LICENSE`

- **Type:** MIT
- **Copyright:** `Copyright (c) 2025-2026 SeekerClaw Contributors`

### 6B: `README.md`

Structure:
```
# SeekerClaw
Turn your Solana Seeker into a 24/7 personal AI agent.

## What is SeekerClaw?        (2-3 paragraphs)
## Features                    (bullet list)
## Requirements                (Android 14+, 4GB RAM, API keys)
## Quick Start                 (APK install + setup wizard)
## Building from Source        (prerequisites + ./gradlew assembleDebug)
## Architecture                (ASCII diagram)
## Documentation               (links to CLAUDE.md, PROJECT.md, etc.)
## Contributing                (link to CONTRIBUTING.md)
## License                     (MIT)
## Acknowledgments             (OpenClaw, nodejs-mobile, grammy, SQL.js)
## Disclaimer                  ("Not affiliated with Solana Mobile, Inc.")
```

### 6C: `CONTRIBUTING.md`

- Bug reports / feature requests (link to issue templates)
- Dev setup (Android Studio, SDK 35, JDK 17)
- Code style (Kotlin conventions, Compose patterns)
- PR process (branch from main, descriptive commits)
- Version tracking table (moved from CLAUDE.md)
- CLAUDE.md as the architecture reference

### 6D: `CODE_OF_CONDUCT.md`

Contributor Covenant v2.1 (industry standard).

### 6E: `SECURITY.md`

- Responsible disclosure process (email, not public issue)
- Security model overview (Keystore encryption, HTTPS-only, no telemetry)

### 6F: `NOTICES`

Third-party attributions:

| Library | License |
|---------|---------|
| Rethink Sans font | SIL Open Font License 1.1 |
| nodejs-mobile | MIT |
| SQL.js | MIT |
| NanoHTTPD | BSD 3-Clause |
| sol4k | MIT |
| AndroidX / Jetpack | Apache 2.0 |
| ML Kit Barcode | Apache 2.0 |

### 6G: `.github/` Templates

```
.github/
├── ISSUE_TEMPLATE/
│   ├── bug_report.md
│   └── feature_request.md
└── PULL_REQUEST_TEMPLATE.md
```

---

## Phase 7: Branch Cleanup

- [ ] Delete ~50 merged `feature/BAT-*` remote branches
- [ ] Keep `main` branch only

```bash
# Preview what would be deleted
git branch -r --merged origin/main | grep -v 'main' | sed 's/origin\///'

# Delete them
git branch -r --merged origin/main | grep -v 'main' | sed 's/origin\///' | xargs -I{} git push origin --delete {}
```

---

## Phase 8: GitHub Repository Settings (Manual)

- [ ] **Visibility:** Private → Public
- [ ] **Description:** "Turn your Solana Seeker into a 24/7 personal AI agent"
- [ ] **Topics:** `android`, `ai-agent`, `solana`, `telegram-bot`, `kotlin`, `jetpack-compose`, `nodejs`, `claude`, `anthropic`
- [ ] **Website:** `seekerclaw.dev`
- [ ] **Branch protection on `main`:**
  - Require PR reviews (1 reviewer)
  - Require status checks to pass
  - No force push
- [ ] **Enable GitHub Discussions**
- [ ] **Disable wiki** (docs live in repo)
- [ ] **Create Release v1.4.0** with APK artifact + release notes from CHANGELOG.md

---

## Verification Checklist

Run these before flipping the repo to public:

- [ ] `git clone <repo> && ./gradlew assembleDebug` builds cleanly
- [ ] `git log --all -p | grep -iE "lin_api|sk-ant-api03-[A-Za-z0-9]|jupiter_api"` returns nothing real (only placeholder examples)
- [ ] `LICENSE` exists at root (MIT)
- [ ] `README.md` exists at root
- [ ] `CONTRIBUTING.md` exists at root
- [ ] `CODE_OF_CONDUCT.md` exists at root
- [ ] `SECURITY.md` exists at root
- [ ] Internal audit docs are in `docs/internal/`, not root
- [ ] `build_output.txt` / `compile_out.txt` / `.mcp.json` are not tracked
- [ ] CLAUDE.md has no Linear IDs, BAT- references, or internal process details
- [ ] Firebase deps fully removed from build files
- [ ] No `google-services` plugin in build files

---

## Files Summary

| Action | Files |
|--------|-------|
| **Create** | `LICENSE`, `README.md`, `CONTRIBUTING.md`, `CODE_OF_CONDUCT.md`, `SECURITY.md`, `NOTICES`, `.github/ISSUE_TEMPLATE/bug_report.md`, `.github/ISSUE_TEMPLATE/feature_request.md`, `.github/PULL_REQUEST_TEMPLATE.md` |
| **Edit** | `CLAUDE.md` (trim), `.gitignore` (add entries), `app/build.gradle.kts` (remove Firebase), `gradle/libs.versions.toml` (remove Firebase) |
| **Move** | 17 audit/internal `.md` files → `docs/internal/` |
| **Untrack** | `build_output.txt`, `compile_out.txt`, `.mcp.json` |
| **Delete remote** | ~50 merged `feature/BAT-*` branches |
