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

All version numbers are **defined** in one place, `app/build.gradle.kts`, and
**read at runtime** — never from `BuildConfig`.

| Version | Defined in `app/build.gradle.kts` | Read at runtime via |
|---------|-----------------------------------|---------------------|
| **App version** | `appVersionName` / `appVersionCode` | `BuildProvenance.installed(context)` (PackageManager) |
| **OpenClaw version** | `openclawVersion` | `BuildProvenance.get(context).openclawVersion` |
| **Node.js version** | `nodejsVersion` | `BuildProvenance.get(context).nodejsVersion` |

> **Do not add a `buildConfigField` for any of these, and do not read them off
> `BuildConfig`.** Those are compile-time constants, which Java and Kotlin inline
> at every call site. When the value changes, AGP regenerates `BuildConfig` but
> incremental compilation does not recompile the readers, so they keep the
> **previous** literal. A clean build hides it, so it only bites the incremental
> path used all day — which is how a wrong commit SHA once reached a device-test
> record (BAT-1293).
>
> `versionName` / `versionCode` come from `PackageManager` rather than the
> packaged `build-metadata.json`, because that asset is a build-time *copy* and a
> copy can drift. `PackageManager` reports the merged manifest of the APK Android
> actually installed, so it is the installed identity rather than a record of it.
>
> `tests/nodejs-project/build-identity-invariant.test.js` enforces all of this in
> CI and will fail the build if a constant comes back or a value is written twice.

## Shipping a new AI model

The model dropdown carries **the latest plus one previous per model line**. When
Opus 6 ships, Opus 4.8 leaves. Anthropic and OpenAI keep old generations
available indefinitely, so without a rule the list only ever grows and users
scroll past six Opus versions to reach the one they want.

To add a generation:

1. Add the new id to `app/src/main/assets/nodejs-project/model-registry.json`,
   and remove the now-third-oldest entry in that line.
2. **Keep the removed model's `MODEL_CONTEXT_LIMITS` entry in `ai.js`.** Do not
   delete it. Existing users can still be running it, and without the entry they
   silently drop from a 200000 context budget to the 128000 fallback — trimming
   and summarising ~37% earlier than before an update they never asked for.
3. Set `reasoningSupport` from an **observed live call**, not from the provider's
   docs. For xAI in particular the docs do not state it, and the live harness has
   already caught a `reasoning_effort` bug that unit tests missed.
4. Update the pinned list in `ModelRegistryDefaultsTest` — it exists to make this
   a conscious edit rather than a drive-by one.

Removing a model does **not** strand anyone who has it selected. Reconcile's
equality gate passes an off-list selection through unchanged (see
`ConfigManagerModelReconcileTest`: *"dropped-from-registry model survives for
existing users"*), and the Custom-model field lets anyone type a dropped id back.

**Changing a `defaultModel` is a user-visible behaviour change** — it decides what
a fresh install runs. It is pinned in tests on purpose; if an assertion carries a
rationale in its name (`"reasoning fix device-verified 2026-07-09"`), that
rationale is evidence, and a provider's documentation does not outrank it.

## Questions?

- Open a [Discussion](https://github.com/sepivip/SeekerClaw/discussions) for general questions
- Check [CLAUDE.md](CLAUDE.md) for architecture details
- Check [SKILL-FORMAT.md](SKILL-FORMAT.md) for writing custom skills
