# CLAUDE.md — SeekerClaw Project Guide

> **Background research:** See `docs/internal/RESEARCH.md` | **Source of truth:** See `PROJECT.md` | **Architecture:** See `docs/internal/ARCHITECTURE.md` | **All reference docs:** *Reference Docs* below

## PROJECT.md — Source of Truth

- Read `PROJECT.md` before any feature work
- After shipping any feature: update **Shipped** section + **Changelog**
- After starting any feature: move it to **In Progress**
- Keep **Limitations** section honest — if it doesn't work, list it
- **One-Liner** and **Elevator Pitch** should always reflect current state
- Update **Stats** periodically (tool count, skill count, lines of code)

## Design Principle: UX First

**Always think about user experience.** This is the top priority when building SeekerClaw. Every UI decision, feature implementation, and config flow should be designed from the user's perspective. Ask: "Is this intuitive? Will the user lose data? Is switching between options seamless?" When in doubt, prioritize ease of use over technical elegance.

## What Is This Project

**SeekerClaw** (package: `com.seekerclaw.app`) is an Android app that turns a Solana Seeker phone into a 24/7 personal AI agent. It embeds a Node.js runtime via `nodejs-mobile` and runs an agent ported from the OpenClaw gateway as a foreground service. Users interact with their agent through Telegram or Discord — the app itself is minimal (setup, status, logs, skills, settings).

### Supported Devices

- **Primary:** Solana Seeker (Android 14, Snapdragon 6 Gen 1, 8GB RAM)
- **Secondary:** Any Android 14+ with 4GB+ RAM
- **Note:** OEM-modified ROMs (Xiaomi MIUI, Samsung OneUI) may aggressively kill background services — Seeker's stock Android avoids this.

## Version Tracking (KEEP UPDATED)

> **When updating OpenClaw or nodejs-mobile, update these version strings in ONE place:**
> **`app/build.gradle.kts`** → the `openclawVersion` / `nodejsVersion` vals at the top of the file.
>
> The app version (`versionName` / `versionCode`) is also in `app/build.gradle.kts`, as
> `appVersionName` / `appVersionCode`. All four are declared once and referenced from
> everywhere else — never retype a value a second time, or the copies drift.
>
> **Identity is read at RUNTIME — never off `BuildConfig` (BAT-1293).**
> UI and diagnostics get `versionName` / `versionCode` from
> `BuildProvenance.installed(context)`, which asks `PackageManager` about the
> **installed** package, and `commit` / `dirty` / `openclawVersion` / `nodejsVersion`
> from `BuildProvenance.get(context)`, which reads the packaged
> `assets/build-metadata.json` (`app/src/main/java/com/seekerclaw/app/config/BuildProvenance.kt`).
>
> A `buildConfigField` for any identity value is FORBIDDEN: it compiles to a
> `static final`, which is INLINED into every reader, so when the value changes
> incremental compilation does not recompile those readers and they keep the OLD
> literal — that is how a build reported a SHA it did not contain. And
> `build-metadata.json` is a build-time COPY, so it is the source for the engine and
> commit fields only, never for `versionName` / `versionCode`.
> `tests/nodejs-project/build-identity-invariant.test.js` enforces both halves in CI.

| Version | Current | Location |
|---------|---------|----------|
| **App** | `2.3.1` (code 25) | `app/build.gradle.kts` → `appVersionName` / `appVersionCode` vals |
| **OpenClaw** | `2026.4.10` | `app/build.gradle.kts` → `openclawVersion` val |
| **Node.js** | `18 LTS` | `app/build.gradle.kts` → `nodejsVersion` val |

## Tech Stack

- **Language:** Kotlin
- **UI:** Jetpack Compose (Material 3, dark theme only)
- **Theme:** `Theme.SeekerClaw`
- **Min SDK:** 34 (Android 14)
- **Node.js Runtime:** nodejs-mobile (https://github.com/nodejs-mobile/nodejs-mobile) — Node 18 LTS, ARM64
- **QR Scanning:** CameraX + ZXing/ML Kit
- **Encryption:** Android Keystore (AES-256-GCM, `userAuthenticationRequired = false`)
- **Background Service:** Foreground Service with `specialUse` type
- **IPC:** nodejs-mobile JNI bridge + localhost HTTP
- **Database:** SQL.js (WASM-compiled SQLite) — no native bindings needed
- **Build:** Gradle (Kotlin DSL)
- **Distribution:** Solana dApp Store APK (primary), Google Play AAB (secondary), direct APK sideload (fallback)

## Reference Docs

This file holds the rules. The detail lives in these docs; read the one that matches your change.

| Doc | What's in it |
|-----|--------------|
| `PROJECT.md` | Source of truth: shipped, in progress, limitations, changelog, stats |
| `docs/internal/ARCHITECTURE.md` | Project tree, runtime diagram, screens, theme tokens, permissions, Android Bridge endpoints, MCP servers, QR payload, config generation, workspace seeding, on-device file layout, watchdog, mobile config, Jupiter safety layers, CI/CD |
| `app/src/main/assets/nodejs-project/ARCHITECTURE.md` | Node.js agent module map and dependency wiring |
| `docs/internal/PITFALLS.md` | Full incident write-ups behind *Coding Patterns & Pitfalls* (BAT-1033 thinking signatures, adaptive thinking, live probes, context7) |
| `docs/internal/OPENCLAW_TRACKING.md` | **Critical:** OpenClaw version tracking, update process, parity checklist, SOUL.md template, Node 18 limits |
| `SKILL-FORMAT.md` | SKILL.md spec — use it as the reference when creating skills |
| `CONTRIBUTING.md` | Contributor setup, PR process, shipping a new AI model |
| `docs/internal/RESEARCH.md` | Feasibility research: Node.js on Android, background services, Solana Mobile, competitive landscape |

## Model List

The model picker is driven by `app/src/main/assets/nodejs-project/model-registry.json` — the single source of truth read by both Kotlin (`ModelRegistry` in `Providers.kt`) and Node (`model-catalog.js`). Each provider's default model is that file's `defaultModel` field. Model ids quoted elsewhere in the docs are examples; the registry is the authority.

A custom model ID typed in the picker is also supported on Anthropic/OpenAI and survives reconcile (BAT-1032). To add or retire a model, follow *Shipping a new AI model* in `CONTRIBUTING.md`.

## Memory Preservation (CRITICAL)

> **RULE: App updates and code changes MUST NEVER affect user memory.**

The agent's memory is sacred. These files live in the workspace directory and must survive all updates:

| File | Purpose | MUST Preserve |
|------|---------|---------------|
| `SOUL.md` | Agent personality | YES |
| `IDENTITY.md` | Agent name/nature | YES |
| `USER.md` | Owner info | YES |
| `MEMORY.md` | Long-term memory | YES |
| `memory/*.md` | Daily memory files | YES |
| `HEARTBEAT.md` | Last heartbeat | YES |
| `config.json` | Config (regenerated) | Regenerated from encrypted store |
| `skills/*.md` | Custom user skills | YES |

### Rules for Developers

1. **Never delete workspace/** during app updates
2. **Never overwrite** existing SOUL.md, MEMORY.md, IDENTITY.md, USER.md
3. **Seed files only if they don't exist** (`if (!file.exists())`)
4. **BOOTSTRAP.md** is the only file the agent itself deletes (after first-run ritual)
5. **config.json** is regenerated from encrypted storage on each service start — this is fine
6. **Use `adb install -r`** (replace) to preserve app data during development
7. **Export/Import** feature exists in Settings for backup/restore

### What Gets Lost and When

| Action | Memory Lost? |
|--------|-------------|
| App update (store) | NO |
| `adb install -r` | NO |
| Uninstall + reinstall | YES (use export first!) |
| "WIPE MEMORY" in Settings | YES (intentional) |
| "RESET CONFIG" in Settings | Config only, memory preserved |
| Factory reset | YES (use export first!) |

---

## Agent Self-Awareness (NEVER SKIP)

> **RULE: When adding or changing features that affect what the agent can do, you MUST update the agent's system prompt and tool descriptions so the agent knows about its own capabilities.**

The agent only knows what we tell it. If we add a new tool, database table, bridge endpoint, or capability but don't update the system prompt or tool descriptions, the agent will tell users "I can't do that" — even though it can.

### What to Update

| Change | Update Required |
|--------|----------------|
| New tool added to TOOLS array | Tool `description` must explain what it does and what data it accesses |
| New bridge endpoint | Add to `buildSystemBlocks()` Android Bridge section |
| New database table or query | Mention in relevant tool descriptions + `buildSystemBlocks()` Data & Analytics section |
| Changed tool behavior | Update tool `description` to reflect new behavior |
| New system capability | Add to `buildSystemBlocks()` in the appropriate section |

### Where to Update (in `main.js`)

1. **Tool descriptions** — `TOOLS` array (each tool has a `description` field). Be specific: say "SQL.js database" not "search files", say "API usage analytics" not "stats".
2. **System prompt** — `buildSystemBlocks()` function. Sections include: Identity, Tooling, Skills, Memory Recall, Data & Analytics, Android Bridge, Runtime info, etc.

### Example

Bad: Adding `memory_search` tool with description "Search memory files"
Good: Adding `memory_search` tool with description "Search your SQL.js database (seekerclaw.db) for memory content. All memory files are indexed into searchable chunks — this performs ranked keyword search with recency weighting, returning top matches with file paths and line numbers."

### SAB Audit BEFORE Merge (NEVER SKIP)

> **RULE: If a PR touches `buildSystemBlocks()` in `ai.js`, modifies `DIAGNOSTICS.md`, adds new error log sites in JS, or ships any user-visible AI capability — run an SAB audit BEFORE merging, not after.**

The Self-Awareness Benchmark (SAB) catches drift between what the agent can do and what the agent knows it can do. SAB v3's behavioral probes are particularly good at catching gaps invisible to a human reviewer ("the auth flow is implementation detail, the agent doesn't need to know" → wrong, the user will ask).

**When to run SAB before merge:**
- New feature shipped (any provider, channel, tool, skill type, auth flow, etc.)
- New error log sites added in JS (`log(...'ERROR'...)` or `log(...'WARN'...)`)
- `buildSystemBlocks()` itself touched
- `DIAGNOSTICS.md` touched
- Any new user-facing capability

**How:**
1. Run the `sab-audit` skill (or invoke `/sab-audit`)
2. Score honestly — pre-fix score below 95% means drift
3. Apply the gap fixes IN THE SAME PR (don't ship the feature with a follow-up "audit fix" PR — that means the feature shipped broken)
4. Verify post-fix score is 100%
5. Reference the SAB audit version in the PR description

**Discovered the hard way in PR #316 (BAT-485, OAuth):** the feature shipped functionally correct but with zero self-knowledge coverage. SAB-AUDIT-v19 caught 5 gaps after merge — they should have been caught before. Don't repeat.

**Repeated in PR #304 (BAT-500, Activity Heatmap):** SAB-AUDIT-v23 caught 3 failed behavioral probes post-merge; pre-fix 93.6%, lowest since v19.

**Enforcement:** `.github/PULL_REQUEST_TEMPLATE.md` has a **Self-Awareness Checklist** — check exactly one of "N/A" or "SAB-audited" on every PR. Unchecked = unreviewable. This is the honor-system gate version (BAT-503); if drift keeps happening, graduate to a CI trailer check.

---

## Telegram Slash Command Registration (NEVER SKIP)

> **RULE: When you add a new Telegram slash command, add an entry to `telegram-commands.js` AND a `case '/foo':` branch in `message-handler.js`. The drift-guard test fails the build if either half is missing.**

Handling a command is half the work. The other half is making it discoverable. The single-source-of-truth registry in [telegram-commands.js](app/src/main/assets/nodejs-project/telegram-commands.js) drives both the BotFather `/` autocomplete menu AND the `/help` response, so one edit serves both surfaces.

### What to do

1. **Registry entry** — add one line to `COMMAND_REGISTRY` in [telegram-commands.js](app/src/main/assets/nodejs-project/telegram-commands.js). Order in the array determines display order in both `/` autocomplete and `/help`.
   ```js
   { name: 'foo', description: 'Short imperative description', fallback: true },
   ```
   Set `fallback: true` if the command should survive a Telegram `BOT_COMMANDS_TOO_MUCH` degradation (i.e., it's a must-have). Keep the fallback list short.

2. **Handler** — new `case '/foo':` branch in `handleCommand` in [message-handler.js](app/src/main/assets/nodejs-project/message-handler.js).

Description should be short (fits in Telegram's one-line UI), imperative ("Show bot status", not "Shows bot status"), and mention the affected thing so users can distinguish similar commands.

### Budget

Telegram caps at ~100 total commands per bot but we cap OURSELVES at ~30 for usability. If adding a new one would push past that, merge two existing ones or prune before adding. A command menu that scrolls forever is no better than no menu.

**If BotFather rejects with `BOT_COMMANDS_TOO_MUCH`:** the fallback payload kicks in automatically (only commands flagged `fallback: true`). Keep the full payload trimmed so we never rely on the fallback in production.

### Enforcement

[tests/nodejs-project/telegram-commands.test.js](tests/nodejs-project/telegram-commands.test.js) runs a **drift-guard** that fails the build if:
- a command in `COMMAND_REGISTRY` has no matching `case '/<name>':` in message-handler.js, OR
- a `case '/<name>':` in message-handler.js has no matching registry entry (internal aliases like `/commands` → `/help` handler stack on the same case block — fine).

Run locally with `node tests/nodejs-project/telegram-commands.test.js` before pushing.

### Discovered the hard way in PR #339 (BAT-504, /model + /provider)

The `/model` and `/provider` commands shipped functional but invisible — device testing found that typing `/` in Telegram didn't surface them in the autocomplete menu, so a user who didn't already know the command existed wouldn't find it. PR #339 also refactored the old hardcoded setMyCommands + inline /help text into the registry pattern + drift-guard so a human can't make the same mistake again.

---

## Key Implementation Details

- **nodejs-mobile:** https://github.com/nodejs-mobile/nodejs-mobile — Node 18 LTS, ARM64. Adapted from React Native integration guide for pure Kotlin.
- **nodejs-mobile JNI architecture (IMPORTANT):** Node.js runs as `libnode.so` loaded via `System.loadLibrary("node")` through JNI — there is **NO standalone `node` binary** on the device. Key implications:
  - `process.execPath` typically points to Android's app process launcher (e.g., `/system/bin/app_process` or `/system/bin/app_process64`), **not** a Node.js binary path
  - `process.env.PATH` primarily contains Android system directories (e.g., `/system/bin`, `/vendor/bin`)
  - `node`, `npm`, `npx` commands **cannot** be found or executed via `shell_exec` / `child_process`
  - `shell_exec` uses Android's `/system/bin/sh` (toybox) — completely separate from the Node.js process
  - To run JavaScript code, tools must use `eval()`/`require()` inside the existing Node.js process (`js_eval` tool)
  - All existing tools (read, write, web_fetch, etc.) already work within the Node.js process — they don't shell out
- **Logs:** Node writes `node_debug.log` (workspace/) via `log()` in `LEVEL|epochMs|message` format, continuously rotated at ~5MB (previous kept as `.old`, no carryover). A Kotlin FileObserver forwarder (SeekerClawService) mirrors new lines into `service_logs` (filesDir) — a 300-line in-memory ring surfaced in the Logs screen, plus a 1MB→512KB compacted file. `service_logs` is a bounded diagnostic mirror, NOT an authoritative replica; `node_debug.log` is the full Node transcript.
- **Battery:** On first launch after setup, show dialog explaining battery optimization exemption, then call `Settings.ACTION_REQUEST_IGNORE_BATTERY_OPTIMIZATIONS`.
- **ServiceState:** Singleton with `StateFlow<ServiceStatus>` (STOPPED, STARTING, RUNNING, ERROR), uptime, and message count. UI observes these flows.
- **Metrics:** Message count, uptime, and response times tracked locally on-device. Usage analytics (Firebase) tracks feature usage, service health, and model selection — no personal data, no messages, no wallet keys. Fully optional — users can disable in Settings.

## What NOT to Build (v1)

- No in-app chat (users use Telegram or Discord)
- No light theme
- No multi-agent support
- No OTA updates (update via app store)

## Product Flavors (Distribution)

Two product flavors under the `distribution` dimension, defined in `app/build.gradle.kts`:

| Flavor | Output | Signing Config | Use |
|--------|--------|---------------|-----|
| `dappStore` | APK | `dappStore` (SEEKERCLAW_* keys) | Solana dApp Store + sideload |
| `googlePlay` | AAB | `googlePlay` (PLAY_* keys) | Google Play Store |

**BuildConfig fields** available in Kotlin code:
- `BuildConfig.DISTRIBUTION` — `"dappStore"` or `"googlePlay"`
- `BuildConfig.STORE_NAME` — `"Solana dApp Store"` or `"Google Play"`

These two are flavor selectors, fixed per variant. **No build-identity value belongs
here** — no version, SHA, or build time; a constant inlines into its readers and goes
stale on an incremental build. See *Version Tracking* above.

**Signing config resolution:** `signingProp(localKey, envKey)` helper checks `local.properties` first (Android Studio), then `System.getenv()` (GitHub Actions CI).

**Build variants** (flavor + buildType):
- `dappStoreDebug`, `dappStoreRelease`
- `googlePlayDebug`, `googlePlayRelease`

**Android Studio:** Select build variant in Build Variants panel (default: `dappStoreDebug`).

**Future:** Flavors enable feature stripping per store (e.g., removing Solana wallet from Google Play version).

## Build & Run

```bash
# dApp Store debug (default for development)
./gradlew assembleDappStoreDebug
adb install app/build/outputs/apk/dappStore/debug/app-dappStore-debug.apk

# Google Play debug
./gradlew assembleGooglePlayDebug

# Release builds (require signing keys)
./gradlew assembleDappStoreRelease    # → APK
./gradlew bundleGooglePlayRelease     # → AAB
```

### Pre-push check (BAT-502)

Before every `git push`, run:

```bash
scripts/pre-push-check.sh
```

Does in ~5–10 seconds (incremental):
1. Node.js smoke test (`tests/nodejs-project/smoke.js`) — syntax + module load
2. Kotlin compile (`compileDappStoreDebugKotlin`) — catches missing imports,
   type errors, unresolved references BEFORE CI

The script auto-detects JDK 17+ (prefers Android Studio's bundled JBR at
`jbr/`) and Android SDK (from main-repo `local.properties` or standard
locations).

Exit codes:
- `0` — all checks passed
- `1` — Node smoke failed
- `2` — Kotlin compile failed
- `3` — JDK 17+ not found
- `4` — Android SDK not found
- `5` — couldn't cd to repo root (broken path / permissions)

Catches the bug class from PR #334 (missing `aspectRatio` import passed
Node smoke, failed CI after 4 minutes).

## OpenClaw Version Tracking

> SeekerClaw started as a port of OpenClaw and now treats it as a loose reference (SeekerClaw is its own line: mobile, Node 18, Solana). The update check, critical-file list, parity checklist and compatibility notes are in `docs/internal/OPENCLAW_TRACKING.md`. The reference clone lives at `openclaw-reference/`.

### Current Versions
- **OpenClaw Reference:** 2026.4.10 (parity baseline; upstream has since diverged ~34K commits — now a loose reference)
- **Last Sync Review:** 2026-07-06 (reviewed HEAD 538d4eeb77; nothing portable — see `docs/internal/OPENCLAW_TRACKING.md`)

---

## Coding Patterns & Pitfalls

Hard-won lessons from code review. Follow these patterns to avoid recurring bugs.

### ProGuard / R8 and @Serializable

All `@Serializable` classes in `com.seekerclaw.app.**` are protected by wildcard rules in `proguard-rules.pro`. Adding new `@Serializable` objects (routes, data classes) requires no extra steps. If you move serializable classes outside this package, add a matching keep rule.

### Timer Cleanup

**Always track setTimeout IDs and clear them.** Dangling timers cause stale callbacks, memory leaks, and ghost state changes.

```javascript
// BAD — fire-and-forget timer, no way to cancel
setTimeout(() => clearReaction(), 1500);

// GOOD — track and clean up
holdTimer = setTimeout(() => clearReaction(), 1500);
// In dispose/cleanup:
if (holdTimer) clearTimeout(holdTimer);
```

Applies to: `Promise.race` timeouts, hold/delay timers, debounce timers, stall timers.

### Early Return Cleanup

**Every early `return` in an async handler must clean up state.** If a handler creates stateful resources (reactions, locks, pending operations), every exit path must release them.

```javascript
// BAD — statusReaction left as 👀 forever
if (skillAutoInstalled && !text) {
    return;
}

// GOOD — clean up before early return
if (skillAutoInstalled && !text) {
    await statusReaction.clear();
    return;
}
```

When adding a new early return to `handleMessage()` in `main.js`, always check: "Is there a `statusReaction` that needs clearing?"

### Serialize Async State Updates

**When multiple async calls update the same state, serialize them.** Fire-and-forget async calls can complete out of order, causing later states to be overwritten by earlier slow responses.

```javascript
// BAD — overlapping API calls can resolve out of order
async function setReaction(emoji) {
    currentEmoji = emoji;
    await telegram('setMessageReaction', { reaction: [{ type: 'emoji', emoji }] });
}

// GOOD — promise chain ensures sequential execution
let chain = Promise.resolve();
async function setReaction(emoji) {
    chain = chain.then(async () => {
        await telegram('setMessageReaction', { reaction: [{ type: 'emoji', emoji }] });
        currentEmoji = emoji; // Only update after success
    });
    return chain;
}
```

### Defensive Field Validation

**Guard every field from persisted JSON.** Cron jobs, configs, and any data loaded from files can be corrupt (NaN, null, wrong type). Validate before arithmetic.

```javascript
// BAD — trusts persisted data
const anchor = schedule.anchorMs || 0;

// GOOD — validates type and finiteness
const anchor = (typeof schedule.anchorMs === 'number' && isFinite(schedule.anchorMs))
    ? schedule.anchorMs : 0;
```

### Consistent JSON Output

**Use `?? null` for optional fields in tool results.** `undefined` is silently dropped by `JSON.stringify`, making output shape inconsistent. Tools should return stable schemas.

```javascript
// BAD — field disappears from JSON when undefined
lastDelivered: j.state.lastDelivered,

// GOOD — explicit null keeps field in output
lastDelivered: j.state.lastDelivered ?? null,
```

### Bootstrap / Multi-Step Ritual Guards

**For multi-step rituals, gate on the trigger file only.** The trigger file (BOOTSTRAP.md) is the source of truth for "ritual in progress." The agent deletes it when done. If the result file (IDENTITY.md) already exists alongside the trigger, treat it as crash recovery — inject resume context, don't skip.

```javascript
// BAD — kills multi-step ritual if agent writes partial results mid-way
if (bootstrap && !identity) { runRitual(); }

// GOOD — trigger file is sole source of truth; add resume note if identity exists
if (bootstrap) { runRitual(/* resume: !!identity */); }
```

### Provider Wire Contracts (BAT-1033)

Full write-ups, with the misleading error text and the probe evidence, are in `docs/internal/PITFALLS.md`. The rules:

- **Handle every SSE `*_delta` type.** `applyClaudeStreamEvent` in `http.js` must accumulate `text_delta`, `input_json_delta`, `thinking_delta` **and** `signature_delta`. A dropped `signature_delta` leaves the thinking block with an empty signature, and replaying it on the next tool-use turn fails with `400 … each thinking block must contain thinking` — the trigger is the empty **signature**, not empty text. The replay guard in `providers/claude.js:_collectClaudeWireBlocks` skips blocks whose signature is empty; key on the signature, never the text.
- **Thinking is `{type:'adaptive'}`.** Current Anthropic models reject `thinking:{type:'enabled', budget_tokens}`. Verify any provider-shape claim on **both** auth paths (raw API key and setup_token) — the setup_token path tolerated the old shape and hid the bug.
- **Wire-contract bugs need live probes, not just mocks.** Offline, feed the exact streamed bytes to the exported reducer (`tests/nodejs-project/claude-thinking-signature.test.js`) and confirm the test fails if the fix is reverted. Before any release that touches provider request/response shaping, run the opt-in live probes in `tests/live/anthropic/`.
- **Check the current API contract via the context7 MCP, not training memory**, before changing provider request/response shaping or any hardcoded external identifier (API params, model ids, header/beta tags, endpoint paths). Pair it with a live probe.
