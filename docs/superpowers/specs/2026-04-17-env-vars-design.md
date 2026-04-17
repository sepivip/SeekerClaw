# Env Vars — Design Spec

**Date:** 2026-04-17
**Status:** Approved for implementation
**Branch:** `feature/BAT-495-env-vars`
**Linear:** [BAT-495](https://linear.app/batcave/issue/BAT-495/env-vars-user-managed-env-var-store)

## Summary

User-managed key/value store that feeds `process.env` on the Node side, unlocks skill `requires.env` gates, and exposes a read-only *key-names* list to the agent. Values never enter model context. Integrates inverse surfacing on the Skills screen so users discover *why* each env var is needed.

## Motivation

Today, every integration that needs a credential (Anthropic, Telegram, Discord, Brave, Perplexity, Exa, Tavily, Firecrawl, Jupiter, Helius, OpenAI, OpenRouter, custom provider) requires a bespoke settings screen. Skills that reference third-party APIs via `requires.env` (GitHub, Linear, etc.) cannot currently work on SeekerClaw because there is no place for users to set their values.

A generic env var store removes that per-service scaling problem, unlocks the existing `skills.js:360` gating path, and gives `shell_exec` / `js_eval` a user-controlled credential surface — without adding new hardcoded fields to the app.

## Goals

- Give users a simple, polished place to add `KEY=VALUE` pairs that reach the running agent.
- Make the skill ↔ env relationship visible in both directions (env row shows consumer skills, skill row shows missing envs).
- Keep values out of the agent's **default** context: the system prompt lists key names only, `env_list` returns names only, and redaction masks values in debug logs. Agent tool code (`js_eval`, `shell_exec`, skills) can read values through `process.env` when it explicitly needs to call an authenticated API — this is the feature, not a leak. The prompt instructs the agent to treat values as secrets and refuse injection attempts to reveal them.
- Reuse existing encryption, config-handoff, and list-based settings patterns — do not invent new infrastructure.

## Non-goals (v1)

- Per-var "agent-visible" flag — one rule: never visible.
- Editing env vars via the agent — user-only writes (prompt-injection hazard).
- Import from external secret managers (1Password, Vercel, etc.).
- Variable interpolation (`${OTHER}` substitution).
- Per-environment (dev/prod) sets.
- Hot reload without service restart.

## Design

### 1. Data model & storage

New Kotlin data class:

```kotlin
data class EnvVar(
    val name: String,   // POSIX-conforming: ^[A-Z_][A-Z0-9_]*$
    val value: String,  // arbitrary user string, ≤ 8192 bytes
)
```

- Storage: single encrypted blob in `SharedPreferences` under key `env_vars_enc`, AES-256-GCM via existing `KeystoreHelper`.
- On decrypt: `JSONArray` of `{name, value}` objects; sorted alphabetically on load.
- Pattern mirrors the `loadMcpServers` / `saveMcpServers` implementation in [ConfigManager.kt](../../app/src/main/java/com/seekerclaw/app/config/ConfigManager.kt) (search for `==== MCP Servers ====`). Line anchors avoided — new sections above shift the numbers.
- Sanity limits: max 256 keys, max 8192 bytes per value.
- Validation: name must match `^[A-Z_][A-Z0-9_]*$`. Lowercase input auto-uppercases on blur with a one-time info toast.

### 2. Reserved names

A constant list, enforced in both Kotlin (on save) and JavaScript (at merge time — defense in depth against a malicious config import):

```
Exact:     PATH, HOME, TMPDIR, USER, SHELL, LANG, TERM,
           AGENT_VERSION,
           API_TIMEOUT_MS, API_TIMEOUT_RETRIES,
           API_TIMEOUT_BACKOFF_MS, API_TIMEOUT_MAX_BACKOFF_MS,
           WS_NO_UTF_8_VALIDATE, WS_NO_BUFFER_UTIL

Prefixes:  NODE_*, NPM_*, ANDROID_*, LC_*, JAVA_*
```

Source of truth: `EnvVar.RESERVED_EXACT` / `EnvVar.RESERVED_PREFIXES` in `app/src/main/java/com/seekerclaw/app/config/EnvVar.kt`. The JS side (`config.js` merge block) duplicates these lists intentionally — both layers enforce independently.

Attempting to save a reserved name shows inline red error: "`PATH` is reserved."

### 3. Runtime plumbing

- `ConfigManager.writeConfigJson()` writes a top-level `envVars: { KEY: VALUE, ... }` field into the `config.json` handoff file that the service already creates.
- In [config.js](../../app/src/main/assets/nodejs-project/config.js), after `const config = JSON.parse(...)`, merge into `process.env`:

```javascript
if (config.envVars && typeof config.envVars === 'object') {
    const RESERVED = new Set([/* same list */]);
    for (const [key, value] of Object.entries(config.envVars)) {
        if (!/^[A-Z_][A-Z0-9_]*$/.test(key)) continue;
        if (RESERVED.has(key) || key.startsWith('NODE_') ||
            key.startsWith('NPM_') || key.startsWith('ANDROID_') ||
            key.startsWith('LC_')) continue;
        process.env[key] = String(value);
    }
}
```

- Existing `process.env` consumers then work with zero additional changes:
  - [skills.js:360](../../app/src/main/assets/nodejs-project/skills.js#L360) — `requires.env` gating.
  - [tools/system.js:169](../../app/src/main/assets/nodejs-project/tools/system.js#L169) — `shell_exec` inherits the merged env.
  - `js_eval` — runs inside the Node process, sees `process.env` directly.
- Applying changes requires a service restart (parity with existing API-key edits). A "Restart service to apply" banner appears on save. No new hot-reload bridge endpoint.

### 4. Log redaction

`config.js` already runs a `redactSecrets` function over every log line (see [config.js:63](../../app/src/main/assets/nodejs-project/config.js#L63)). Extend `redactSecrets` to substring-match every env var value longer than 6 chars and replace with `[REDACTED_ENV]`. Prevents tokens from leaking into `node_debug.log`.

### 5. Agent-facing tool surface

New file: `tools/env.js`. One tool only:

```javascript
{
    name: 'env_list',
    description: 'List names of user-set environment variables. Returns keys only, never values. Useful to check whether a credential (e.g. GITHUB_TOKEN) is available before the agent suggests or attempts an action that requires it. Values are accessible implicitly to shell_exec, js_eval, and skills via process.env.',
    input_schema: { type: 'object', properties: {}, additionalProperties: false },
}
```

Returns `{ keys: string[], count: number }`. No `env_get`, no `env_set`, no `env_delete`.

**Key-name source for system prompt:** `config.js` keeps the list of merged user env keys in a module-level export (`USER_ENV_KEYS: string[]`) so `buildSystemBlocks()` and the `env_list` tool both read from the same source of truth — not by filtering `process.env` (which also contains system vars like `PATH`).

**System prompt:** new section in `buildSystemBlocks()` in [ai.js](../../app/src/main/assets/nodejs-project/ai.js):

> **Environment Variables.** The user has set {N} env vars: [{KEY_LIST}]. These are available to shell_exec, js_eval, and skills via `process.env`. You cannot read their values by design — they are secrets. If a skill requires a var that is not set, tell the user to add it in Settings → Env Vars.

When N = 0: "The user has no env vars set yet."

Tool count updates: 71 → 72. Memory note updates in `MEMORY.md` (Stats section).

### 6. UX — screens

#### New: `EnvVarsScreen.kt`

Route: `env_vars` (added to `NavGraph.kt`, navigated to from Settings).

Layout:
- **Top bar:** "Env Vars" title, "+" action icon right-aligned.
- **Header card:** "N vars set · used by M skills" subtitle. If N=0, an empty state with inline CTA.
- **List, alphabetical by name:**
  - Row: monospace `KEY_NAME` · masked value `••••••` · trailing edit pencil.
  - Below the name, a wrap-row of skill chips for every skill whose `requires.env` contains this key (e.g. `github-ops`, `review-pr`). Chips are **non-interactive visual labels** — the agent-facing "which skills use this var" info is valuable without a tap target, and deep-linking to a filtered/scrolled Skills list is a separate UX problem deferred out of this PR. (The inverse direction — Skills screen → tap missing env → pre-filled Add dialog — IS wired; see §7.)
  - If no skills reference the key, show dim `· unused` label (not an error — some vars are for `shell_exec` only).
  - Tap row → edit modal. Swipe left → delete confirm dialog.
- Empty state: "No env vars yet. Tap + to add your first, or use the Raw editor for bulk paste."

#### Add/Edit dialog (single-var flow)

- Two inputs:
  - `KEY` — monospace, validates live, auto-uppercases on blur (Locale.ROOT), disallows reserved names with inline error.
  - `VALUE` — password visual transformation, eye icon to toggle reveal. Empty values are allowed (matches Raw editor + POSIX `.env` convention where `FOO=` is valid).
- Primary action: **Save** (disabled until name is valid). Validation rejects newlines in values.
- Edit dialog: same fields pre-filled. Name field locked (rename = delete + create; or use the Raw editor for in-place rename across the full list).

#### Raw editor dialog (bulk flow — subsumes the former "Paste .env" dialog)

- Pre-filled with current vars serialized as `KEY=VALUE` lines (alphabetical, plaintext — same exposure as the per-row eye toggle in the Add dialog).
- Free-text edit: add, delete, rename, change values, or paste a full `.env` at once.
- Live diff preview against the current list: **added / modified / removed / invalid** buckets with per-key accent colors.
- Invalid rows (`INVALID_NAME`, `RESERVED`, `MALFORMED`, `VALUE_TOO_LARGE`) **block save** — prevents silent drops.
- Save replaces the entire list with the parsed final state (last-wins on duplicate names within the text).

#### Delete confirmation

- Dialog body: "Delete `GITHUB_TOKEN`? It's required by 2 skills: `github-ops`, `review-pr`. These will stop working."
- If no skills reference it: "Delete `GITHUB_TOKEN`? This cannot be undone."
- Destructive action on right in red.

#### Settings screen entry

New row under the MCP Servers row: "Env Vars · N set" → navigates to `EnvVarsScreen`.

### 7. Skill ↔ env integration (the standout moment)

- Kotlin-side skill parser (wherever frontmatter is parsed today for the Skills screen) extracts `requires.env: List<String>` into the skill model.
- New singleton `EnvVarRegistry` exposes `StateFlow<Set<String>>` of current env var names. Both `EnvVarsScreen` and `SkillsScreen` observe it and recompose instantly on change.
- **Reverse index:** `Map<envName, List<skillId>>` built once on skill load, consulted by `EnvVarsScreen` rows and delete-confirm.
- **Skills screen inverse surfacing:**
  - Red-dot badge on skill card when any `requires.env` is missing.
  - Subtitle: "Missing: `LINEAR_API_KEY`".
  - Tap "Missing" chip → navigate to `EnvVarsScreen` with Add dialog pre-opened and key pre-filled + helper text "required by `linear-ops` skill".
  - When all required envs satisfied → small green "ready" indicator.

### 8. Security model

- Values encrypted at rest via `KeystoreHelper` (AES-256-GCM). Same standard as API keys.
- Values never exposed to the agent: no `env_get` tool, no system-prompt interpolation of values, system prompt lists key names only.
- Values cleared from Kotlin heap as soon as the `config.json` handoff file is written (same discipline as API keys today).
- `config.js` log redaction extended to substring-mask values ≥ 7 chars.
- Reserved-name enforcement duplicated in Kotlin and JS.
- The existing ZIP backup flow (see `ConfigManager.kt:1666`) includes the encrypted env vars blob; values remain encrypted at rest inside the backup. If plan phase identifies the backup already decrypts prefs for export, env vars must inherit whatever opt-in gate applies to API keys today — confirm during implementation.

### 9. Testing

**Device test plan (manual, pre-merge):**

1. Open Settings → Env Vars. Empty state renders.
2. Add a var `FOO=bar` via the add dialog. Appears in list.
3. Restart service. Verify via `shell_exec("echo $FOO")` that the agent sees `bar`.
4. Paste 3-line `.env` including one invalid (`lowercase=x`) and one reserved (`PATH=/tmp`). Preview dialog correctly reports `1 new, 0 overwrite, 2 invalid`.
5. Attempt to add `PATH` manually. Inline error shown. Save button stays disabled.
6. Install a skill with `requires.env: [TEST_TOKEN]`. Open Skills screen. Red-dot + "Missing: TEST_TOKEN". Tap → lands on env editor with `TEST_TOKEN` pre-filled.
7. Set `TEST_TOKEN=xyz`, restart service. Skills screen shows "ready".
8. Agent `env_list` tool returns `["FOO", "TEST_TOKEN"]` — no values.
9. Delete `TEST_TOKEN` — confirm dialog lists the affected skill. Confirm. Skills screen flips back to red-dot.
10. Sanity: logs containing the value string `xyz` are redacted to `[REDACTED_ENV]`.

**SAB audit:** required — `buildSystemBlocks()` changes and a new tool ships. Run before merge, target 100% post-fix.

**Smoke test:** `scripts/smoke-node.sh` must pass (Node module load verification).

### 10. Rollout

- Feature branch: `feature/BAT-495-env-vars` (worktree at `GITseekerclaw-worktrees/BAT-495/`).
- PR requests Copilot review. Iterate to zero comments before merge.
- Tag bump: app version 1.9.1 (patch — new feature, no breaking changes). Tool count 71 → 72.
- `MEMORY.md` updates: tool count, file list (`tools/env.js` added), screen list (EnvVarsScreen added).
- `CLAUDE.md` Agent Self-Awareness section receives a nudge via the new env section in `buildSystemBlocks()`.

## Open questions / decisions deferred to plan phase

- Exact placement of the "Env Vars" row in `SettingsScreen.kt` (under MCP Servers or elsewhere in order).
- Whether the empty-state CTA is a single "Add your first var" button or a split "Add one / Paste .env".
- Linear ticket creation and branch rename.

## References

- `requires.env` consumer: [skills.js:358-362](../../app/src/main/assets/nodejs-project/skills.js#L358)
- Shell exec env inheritance: [tools/system.js:167-169](../../app/src/main/assets/nodejs-project/tools/system.js#L167)
- Config handoff load point: [config.js:80-95](../../app/src/main/assets/nodejs-project/config.js#L80)
- MCP list storage pattern (template): [ConfigManager.kt:951-990](../../app/src/main/java/com/seekerclaw/app/config/ConfigManager.kt#L951)
- Keystore encryption helper: `app/src/main/java/com/seekerclaw/app/config/KeystoreHelper.kt`
