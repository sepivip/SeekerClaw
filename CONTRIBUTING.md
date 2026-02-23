# Contributing to SeekerClaw

Thanks for your interest in contributing! This guide will help you get started.

## Reporting Bugs & Requesting Features

- **Bugs:** Open an issue using the [Bug Report template](https://github.com/sepivip/SeekerClaw/issues/new?template=bug_report.md)
- **Features:** Open an issue using the [Feature Request template](https://github.com/sepivip/SeekerClaw/issues/new?template=feature_request.md)
- **Security:** See [SECURITY.md](SECURITY.md) for responsible disclosure

## Development Setup

### Prerequisites

- **Android Studio** Ladybug (2024.2+) or newer
- **JDK 17** (bundled with Android Studio)
- **Android SDK 35** (install via SDK Manager)
- **Git**

### Clone & Build

```bash
git clone https://github.com/sepivip/SeekerClaw.git
cd SeekerClaw
./gradlew assembleDebug
```

The debug APK will be at `app/build/outputs/apk/debug/app-debug.apk`.

> **Note:** Firebase Analytics is optional. The build works without `google-services.json` — analytics calls become no-ops.

### Run on Device

```bash
adb install -r app/build/outputs/apk/debug/app-debug.apk
```

Use `-r` to preserve existing app data (config, memory, skills).

## Architecture Reference

See [CLAUDE.md](CLAUDE.md) for the full architecture guide, including:
- Project structure and directory tree
- Node.js agent module breakdown (14 modules)
- Android Bridge endpoints
- Theme system
- Memory preservation rules

## Code Style

### Kotlin / Android

- Follow standard [Kotlin coding conventions](https://kotlinlang.org/docs/coding-conventions.html)
- Use Jetpack Compose for all UI (no XML layouts)
- Material 3 with the DarkOps theme only
- Prefer `StateFlow` for reactive state

### Node.js Agent

- CommonJS modules (`require` / `module.exports`)
- Node 18 LTS APIs only (no Node 22+ features)
- SQL.js for database (not `node:sqlite`)
- All tools defined in `tools.js` TOOLS array

## Pull Request Process

1. **Branch from `main`** — use descriptive branch names (e.g., `feature/add-export`, `fix/watchdog-restart`)
2. **Keep PRs focused** — one feature or fix per PR
3. **Write descriptive commits** — explain the "why", not just the "what"
4. **Test on device** — verify your changes work on Android 14+ (ideally on a Solana Seeker)
5. **Open PR** — fill out the PR template, link related issues
6. **CI must pass** — the build workflow runs automatically on every PR

## Version Tracking

All version numbers live in one place: `app/build.gradle.kts`. The UI reads from `BuildConfig`.

| Version | Location |
|---------|----------|
| **App version** | `versionName` / `versionCode` |
| **OpenClaw version** | `OPENCLAW_VERSION` buildConfigField |
| **Node.js version** | `NODEJS_VERSION` buildConfigField |

## Questions?

- Open a [Discussion](https://github.com/sepivip/SeekerClaw/discussions) for general questions
- Check [CLAUDE.md](CLAUDE.md) for architecture details
- Check [SKILL-FORMAT.md](SKILL-FORMAT.md) for writing custom skills
