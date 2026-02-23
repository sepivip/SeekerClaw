# Open Source Preparation Plan

> **Goal:** Prepare SeekerClaw for public release on GitHub.
> **Status:** Ready to execute
> **Date:** 2026-02-23 (reviewed & updated)

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

## ~~Phase 2: Remove Tracked Build Artifacts~~ DONE

> **Completed in `12b8d0d`.** Untracked `build_output.txt`, `compile_out.txt`, `.mcp.json` and added to `.gitignore`.

---

## Phase 3: Move Internal Docs → `docs/internal/`

These 18 files are audit reports, strategy docs, and internal plans that clutter the root. Move them to `docs/internal/` to keep the root clean for contributors.

**Move these:**
- [ ] `HEARTBEAT-AUDIT.md`
- [ ] `IDEAS-VAULT.md`
- [ ] `JUPITER-AUDIT.md`
- [ ] `JUPITER-TEST-CHECKLIST.md`
- [ ] `LOG-AUDIT.md`
- [ ] `OPEN-SOURCE-PLAN.md`
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

## ~~Phase 4: Make Firebase Analytics Build-Optional (BAT-258)~~ DONE

> **Already implemented.** The `google-services` Gradle plugin is conditional in `app/build.gradle.kts` (lines 14-18) — only applied when `google-services.json` exists. Firebase deps remain in `libs.versions.toml` (compile fine without the plugin). `google-services.json` is gitignored.
>
> **Still need to verify** (on a machine with JDK 17):
> - [ ] Remove `google-services.json` temporarily → build succeeds, analytics are no-ops
> - [ ] Restore `google-services.json` → build succeeds with Firebase active

---

## Phase 5: Trim CLAUDE.md (Mostly Done)

> **Already trimmed** from 627 → 214 lines in commit `fdc72aa`. A few internal sections remain (PROJECT.md rules, UX principle, Version Tracking, Model List, OpenClaw Compatibility) — final cut needed before go-public.

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

### ~~6A: `LICENSE`~~ DONE

> Created in `12b8d0d`. MIT, `Copyright (c) 2025-2026 SeekerClaw Contributors`.

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

### ~~6D: `CODE_OF_CONDUCT.md`~~ DONE

> Created in `12b8d0d`. Links to Contributor Covenant v2.1 + reporting email.

### ~~6E: `SECURITY.md`~~ DONE

> Created in `12b8d0d`. Disclosure process (security@seekerclaw.dev) + security model overview.

### ~~6F: `NOTICES`~~ DONE

> Created in `12b8d0d`. Third-party attributions for all dependencies.

### ~~6G: `.github/` Templates~~ DONE

> Created in `12b8d0d`. Bug report, feature request, and PR templates.

### ~~6H: GitHub Actions Workflows~~ DONE

> Created in `12b8d0d`.
> - `build.yml` — CI on push/PR to main (assembleDebug, JDK 17, Gradle cache, uploads debug APK artifact)
> - `release.yml` — Triggered on `v*` tags. Builds release APK, creates GitHub Release, uploads artifact. Supports optional signing via repository secrets (`KEYSTORE_BASE64`, `KEYSTORE_PASSWORD`, `KEY_ALIAS`, `KEY_PASSWORD`).
>
> **Release workflow:** `git tag v1.5.0 && git push origin v1.5.0` → auto-build → auto-release

---

## ~~Phase 7: Branch Cleanup~~ DONE

> **Already clean.** No merged remote feature branches remain — only `main` exists on origin.
>
> Re-run before going public to catch any new branches:
> ```bash
> git branch -r --merged origin/main | grep -v 'main'
> ```

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
- [ ] **Create Release v1.4.0** — either via `git tag v1.4.0 && git push origin v1.4.0` (triggers release workflow) or manually with APK artifact + release notes from CHANGELOG.md

---

## Verification Checklist

Run these before flipping the repo to public:

- [ ] `git clone <repo> && ./gradlew assembleDebug` builds cleanly
- [x] `git log --all -p | grep -iE "lin_api|sk-ant-api03-[A-Za-z0-9]|jupiter_api"` returns nothing real
- [x] `LICENSE` exists at root (MIT)
- [ ] `README.md` exists at root
- [ ] `CONTRIBUTING.md` exists at root
- [x] `CODE_OF_CONDUCT.md` exists at root
- [x] `SECURITY.md` exists at root
- [ ] Internal audit docs are in `docs/internal/`, not root
- [x] `build_output.txt` / `compile_out.txt` / `.mcp.json` are not tracked
- [ ] CLAUDE.md has no Linear IDs, BAT- references, or internal process details
- [x] `google-services` plugin is conditional (only applies when `google-services.json` exists)
- [ ] Build succeeds without `google-services.json` (analytics become no-ops)
- [x] No merged feature branches on remote (only `main`)
- [ ] GitHub Actions `build.yml` passes on main (assembleDebug succeeds)
- [ ] GitHub Actions `release.yml` triggers correctly on tag push

---

## Files Summary

| Action | Files | Status |
|--------|-------|--------|
| **Create** | `README.md`, `CONTRIBUTING.md` | TODO |
| **Edit** | `CLAUDE.md` (final trim — remove ~5 internal sections) | TODO |
| **Move** | 18 audit/internal `.md` files → `docs/internal/` | TODO |
| **Done** | `LICENSE`, `CODE_OF_CONDUCT.md`, `SECURITY.md`, `NOTICES`, `.github/` templates, `.github/workflows/`, `.gitignore` updates, untrack artifacts, Firebase conditional, branch cleanup | `12b8d0d` |
