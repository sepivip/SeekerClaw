# Tool Guard Settings — Implementation Plan

> **Status:** Planned | **Created:** 2026-03-15 | **Author:** Claude Opus 4.6
>
> Power-user security settings that move hardcoded tool-execution controls into
> an Android Settings UI, with one-directional flow to the Node.js runtime.

---

## Table of Contents

1. [Motivation & Context](#motivation--context)
2. [Architecture Overview](#architecture-overview)
3. [Phase 1: Kotlin Data Model & Bridge Endpoint](#phase-1-kotlin-data-model--bridge-endpoint)
4. [Phase 2: Settings UI (Compose)](#phase-2-settings-ui-compose)
5. [Phase 3: Node.js Integration](#phase-3-nodejs-integration)
6. [Phase 4: Agent Self-Awareness](#phase-4-agent-self-awareness)
7. [Phase 5: Optional — tool_guard_status Tool](#phase-5-optional--tool_guard_status-tool)
8. [File Changes Summary](#file-changes-summary)
9. [Migration & Upgrade Path](#migration--upgrade-path)
10. [Dependencies & Prerequisites](#dependencies--prerequisites)
11. [Estimated Effort](#estimated-effort)
12. [Risks & Mitigations](#risks--mitigations)
13. [Open Questions](#open-questions)

---

## Motivation & Context

### Current State

Security controls for tool execution are **hardcoded in JavaScript** across several
files. A power user has no way to customize which tools require confirmation,
which are blocked, or which shell commands are allowed — short of editing JS
source on-device.

| Control | Location | Description |
|---------|----------|-------------|
| `CONFIRM_REQUIRED` | `config.js:257` | `Set` of 8 tools that require YES/NO via Telegram |
| `TOOL_RATE_LIMITS` | `config.js:269` | Per-tool cooldowns (ms) |
| `SHELL_ALLOWLIST` | `config.js:240` | 27 allowed shell commands |
| `TOOL_STATUS_MAP` | `config.js:281` | Status messages during tool execution |
| Confirmation gate | `claude.js:1616` | Checks `CONFIRM_REQUIRED` before executing |
| MCP tools (`mcp__*`) | `tools.js:3908` | **ZERO** confirmation coverage — bypass all gates |

### Problems

1. **No user control** — users cannot tighten or relax security without editing JS.
2. **MCP gap** — remote MCP tools execute with zero confirmation or rate limiting.
3. **Shell allowlist is static** — users who need `awk` or `jq` cannot add them.
4. **No "deny" or "hide" state** — tools can only be allowed or confirmed, never blocked.
5. **Agent could modify workspace files** — if config lived in `workspace/`, the
   agent could change its own security settings.

### Key Architectural Decision

**Security config lives in Kotlin/SharedPreferences (encrypted), NOT in workspace
files.** The agent runs in the `:node` process and communicates with the Android
app via AndroidBridge (HTTP on localhost:8765). The flow is **one-directional**:

```
User edits in Settings UI (Kotlin/Compose)
        | writes to
        v
SharedPreferences (encrypted via KeystoreHelper, AES-256-GCM)
        | served via
        v
AndroidBridge GET /tool-guard endpoint (NanoHTTPD, port 8765)
        | read by
        v
Node.js at startup + cached in memory (read-only)
```

The agent has **read-only** access (via the bridge endpoint or an optional
`tool_guard_status` tool). It **cannot** write back or modify the guard config.

---

## Architecture Overview

```
+-----------------------------------------------------+
|                  Android App (UI Process)             |
|                                                       |
|  ToolGuardScreen.kt ─── ToolGuardViewModel.kt        |
|         |                        |                    |
|         v                        v                    |
|  ToolGuardConfig.kt        ConfigManager.kt           |
|  (data model)              (save/load encrypted)      |
|         |                        |                    |
|         +--------+   +-----------+                    |
|                  v   v                                |
|          SharedPreferences (encrypted)                 |
+-----------------------------------------------------+
                      |
                      | (cross-process: :node reads via HTTP)
                      v
+-----------------------------------------------------+
|                  :node Process                        |
|                                                       |
|  AndroidBridge.kt ─── /tool-guard endpoint            |
|         |                                             |
|         | HTTP GET response (JSON)                    |
|         v                                             |
|  Node.js (tool-guard.js or config.js)                 |
|         |                                             |
|         v                                             |
|  _guardConfig (in-memory cache)                       |
|         |                                             |
|    +----+----+----+                                   |
|    |         |    |                                   |
|    v         v    v                                   |
| claude.js  tools.js  shell_exec (tools.js)            |
| (confirm)  (filter)  (allowlist + param scan)         |
+-----------------------------------------------------+
```

### Data Flow — Tool Execution

```
1. Agent decides to call a tool (e.g., "android_sms")
2. claude.js checks _guardConfig:
   a. Is tool in "denied" set?  → Block immediately, return error
   b. Is tool in "hidden" set?  → Should never reach here (filtered from TOOLS)
   c. Is tool in "guarded" set? → Run confirmation flow (YES/NO via Telegram)
   d. Is tool an MCP tool matching auto-guard pattern? → Confirmation flow
   e. None of the above → Execute normally
3. If executing, check rate limit from _guardConfig.rateLimits
4. For shell_exec specifically: check shellAllowlist + shellParamRules
5. Execute tool, return result
```

---

## Phase 1: Kotlin Data Model & Bridge Endpoint

### 1.1 Data Model — `ToolGuardConfig.kt`

**New file:** `app/src/main/java/com/seekerclaw/app/config/ToolGuardConfig.kt`

```kotlin
package com.seekerclaw.app.config

import kotlinx.serialization.Serializable

/**
 * User-configurable security settings for tool execution.
 * Stored encrypted in SharedPreferences, served read-only to Node.js via AndroidBridge.
 *
 * Empty maps/sets = "use defaults" — this is the zero-config upgrade path.
 * Non-empty values override (replace) the corresponding default.
 */
@Serializable
data class ToolGuardConfig(
    /**
     * Per-tool guard state overrides.
     * Key: tool name (e.g., "android_sms", "solana_send").
     * Value: desired state (ALLOW, CONFIRM, DENY, HIDDEN).
     * Tools not in this map use [ToolGuardDefaults.GUARDED_TOOLS] if present,
     * otherwise default to ALLOW.
     */
    val toolStates: Map<String, ToolGuardState> = emptyMap(),

    /**
     * Per-tool rate limits in milliseconds.
     * Key: tool name. Value: minimum cooldown between executions.
     * Overrides [ToolGuardDefaults.RATE_LIMITS] for the given tool.
     * A value of 0 means "no rate limit."
     */
    val rateLimits: Map<String, Long> = emptyMap(),

    /**
     * Shell commands the user has ADDED to the default allowlist.
     * Merged via set union: effective = defaults + added - removed.
     */
    val shellAllowlistAdded: Set<String> = emptySet(),

    /**
     * Shell commands the user has REMOVED from the default allowlist.
     * Merged via set difference: effective = defaults + added - removed.
     */
    val shellAllowlistRemoved: Set<String> = emptySet(),

    /**
     * Glob patterns for auto-guarding MCP tools.
     * Any MCP tool whose name matches one of these patterns requires
     * confirmation, unless explicitly listed in [mcpUnguarded].
     *
     * Glob syntax: `*` matches any substring.
     * Example: "mcp__*__send*" matches "mcp__slack__sendMessage".
     *
     * Empty list = use [ToolGuardDefaults.MCP_GUARD_PATTERNS].
     */
    val mcpGuardPatterns: List<String> = emptyList(),

    /**
     * MCP tool names explicitly trusted (skip auto-guard even if they
     * match a pattern). Useful for tools the user has vetted.
     */
    val mcpUnguarded: Set<String> = emptySet(),

    /**
     * How long (ms) the user has to respond YES/NO in Telegram before
     * the confirmation auto-cancels. Range: 15_000..180_000.
     * Default: 60_000 (60 seconds).
     */
    val confirmationTimeoutMs: Long = 60_000,

    /**
     * Shell argument scanning rules. Each rule is a regex that, if matched
     * against the full shell command string, blocks execution.
     * Merged with [ToolGuardDefaults.SHELL_PARAM_RULES].
     */
    val shellParamRules: List<ShellParamRule> = emptyList(),

    /**
     * Schema version for future migration.
     */
    val version: Int = 1,
)

/**
 * Guard state for a tool. Determines what happens when the agent tries to call it.
 */
@Serializable
enum class ToolGuardState {
    /** No confirmation needed — tool executes immediately. */
    ALLOW,

    /** Requires explicit YES/NO confirmation via Telegram before executing. */
    CONFIRM,

    /** Unconditionally blocked — agent receives an error message. */
    DENY,

    /**
     * Removed from the agent's tool list entirely. The agent does not know
     * the tool exists and will never attempt to call it. More restrictive
     * than DENY (which the agent can see but cannot use).
     */
    HIDDEN,
}

/**
 * A rule that scans shell_exec command arguments for dangerous patterns.
 * If the compiled regex matches the full command string, execution is blocked.
 */
@Serializable
data class ShellParamRule(
    /** Unique identifier (e.g., "FIND_DELETE", "CURL_EXFIL"). */
    val id: String,

    /** Regex pattern (case-insensitive). */
    val pattern: String,

    /** Severity: CRITICAL, HIGH, MEDIUM, LOW. Informational only. */
    val severity: String,

    /** Human-readable description shown in UI and error messages. */
    val description: String,

    /** Whether this rule is active. Disabled rules are stored but not enforced. */
    val enabled: Boolean = true,
)
```

### 1.2 Defaults — `ToolGuardDefaults.kt`

**New file:** `app/src/main/java/com/seekerclaw/app/config/ToolGuardDefaults.kt`

These defaults **exactly match** the current hardcoded behavior so that upgrading
users experience zero change.

```kotlin
package com.seekerclaw.app.config

/**
 * Hardcoded default values for tool guard settings.
 * These match the current behavior in config.js so that upgrading
 * from v1.6.x to the Tool Guard version is seamless.
 *
 * When the user has not customized a setting, these values are used.
 * The bridge endpoint merges user overrides on top of these.
 */
object ToolGuardDefaults {

    /**
     * Tools that require YES/NO confirmation by default.
     * Matches CONFIRM_REQUIRED in config.js:257.
     */
    val GUARDED_TOOLS: Map<String, ToolGuardState> = mapOf(
        "android_sms"            to ToolGuardState.CONFIRM,
        "android_call"           to ToolGuardState.CONFIRM,
        "android_camera_capture" to ToolGuardState.CONFIRM,
        "android_location"       to ToolGuardState.CONFIRM,
        "solana_send"            to ToolGuardState.CONFIRM,
        "solana_swap"            to ToolGuardState.CONFIRM,
        "jupiter_trigger_create" to ToolGuardState.CONFIRM,
        "jupiter_dca_create"     to ToolGuardState.CONFIRM,
    )

    /**
     * Default rate limits (milliseconds) per tool.
     * Matches TOOL_RATE_LIMITS in config.js:269.
     */
    val RATE_LIMITS: Map<String, Long> = mapOf(
        "android_sms"            to 60_000L,
        "android_call"           to 60_000L,
        "android_camera_capture" to 15_000L,
        "android_location"       to 15_000L,
        "solana_send"            to 15_000L,
        "solana_swap"            to 15_000L,
        "jupiter_trigger_create" to 30_000L,
        "jupiter_dca_create"     to 30_000L,
    )

    /**
     * Default shell allowlist.
     * Matches SHELL_ALLOWLIST in config.js:240.
     */
    val SHELL_ALLOWLIST: Set<String> = setOf(
        // Basic file/text utilities
        "ls", "cat", "head", "tail", "wc", "sort", "uniq", "tr", "tee", "yes",
        // Output/logic
        "echo", "printf", "true", "false", "test", "expr", "seq", "env",
        // Search/find
        "grep", "find", "xargs", "which", "whoami", "hostname", "id",
        // Network
        "curl", "ping",
        // System info
        "date", "df", "du", "uname", "printenv",
        // File manipulation
        "touch", "diff", "sed", "cut", "base64",
        // Misc
        "stat", "file", "sleep", "getprop", "md5sum", "sha256sum", "screencap",
    )

    /**
     * Default shell argument scanning rules.
     * These catch dangerous argument patterns even for allowed commands.
     */
    val SHELL_PARAM_RULES: List<ShellParamRule> = listOf(
        ShellParamRule(
            id = "FIND_DELETE",
            pattern = "find.*-delete",
            severity = "HIGH",
            description = "find with -delete flag — can recursively delete files",
        ),
        ShellParamRule(
            id = "CURL_EXFIL",
            pattern = "curl.*\\?(api_key|token|secret|password)=",
            severity = "HIGH",
            description = "Possible credential exfiltration via curl query params",
        ),
        ShellParamRule(
            id = "SED_INPLACE",
            pattern = "sed\\s+-i",
            severity = "MEDIUM",
            description = "In-place file modification via sed -i",
        ),
    )

    /**
     * Glob patterns for auto-guarding MCP tools.
     * Any mcp__*__<verb> matching these patterns requires confirmation.
     */
    val MCP_GUARD_PATTERNS: List<String> = listOf(
        "mcp__*__send*",
        "mcp__*__delete*",
        "mcp__*__pay*",
        "mcp__*__transfer*",
        "mcp__*__charge*",
        "mcp__*__publish*",
    )

    /**
     * Default confirmation timeout (ms).
     */
    const val CONFIRMATION_TIMEOUT_MS: Long = 60_000L

    /**
     * Valid range for confirmation timeout slider.
     */
    val CONFIRMATION_TIMEOUT_RANGE: LongRange = 15_000L..180_000L
}
```

### 1.3 Storage — `ConfigManager.kt` Extension

**Modified file:** `app/src/main/java/com/seekerclaw/app/config/ConfigManager.kt`

Add these members to the existing `ConfigManager` class:

```kotlin
// --- Tool Guard Config ---

private const val PREF_TOOL_GUARD_CONFIG = "tool_guard_config"

/**
 * Persist the tool guard configuration.
 * Serialized to JSON, encrypted via KeystoreHelper, stored in SharedPreferences.
 */
fun saveToolGuardConfig(config: ToolGuardConfig) {
    val json = Json.encodeToString(config)
    val encrypted = keystoreHelper.encrypt(json)
    prefs.edit().putString(PREF_TOOL_GUARD_CONFIG, encrypted).apply()
}

/**
 * Load the tool guard configuration.
 * Returns an empty [ToolGuardConfig] if nothing is stored (i.e., first launch
 * after upgrade) — the bridge endpoint merges this with [ToolGuardDefaults].
 */
fun loadToolGuardConfig(): ToolGuardConfig {
    val encrypted = prefs.getString(PREF_TOOL_GUARD_CONFIG, null)
        ?: return ToolGuardConfig()
    return try {
        val json = keystoreHelper.decrypt(encrypted)
        Json.decodeFromString<ToolGuardConfig>(json)
    } catch (e: Exception) {
        Log.w(TAG, "Failed to load tool guard config, using defaults", e)
        ToolGuardConfig()
    }
}

/**
 * Merge user overrides with defaults to produce the effective guard config.
 * This is what the bridge endpoint returns to Node.js.
 */
fun getEffectiveToolGuardConfig(): EffectiveToolGuardConfig {
    val user = loadToolGuardConfig()
    val defaults = ToolGuardDefaults

    // Tool states: defaults first, then user overrides on top
    val mergedToolStates = defaults.GUARDED_TOOLS.toMutableMap()
    mergedToolStates.putAll(user.toolStates)

    // Rate limits: defaults first, then user overrides on top
    val mergedRateLimits = defaults.RATE_LIMITS.toMutableMap()
    mergedRateLimits.putAll(user.rateLimits)

    // Shell allowlist: defaults + user additions - user removals
    val mergedShellAllowlist = defaults.SHELL_ALLOWLIST
        .plus(user.shellAllowlistAdded)
        .minus(user.shellAllowlistRemoved)

    // Shell param rules: defaults + user-added, filter by enabled
    val mergedShellRules = (defaults.SHELL_PARAM_RULES + user.shellParamRules)
        .filter { it.enabled }

    // MCP patterns: user overrides if non-empty, otherwise defaults
    val mcpPatterns = user.mcpGuardPatterns.ifEmpty { defaults.MCP_GUARD_PATTERNS }

    // Confirmation timeout: user override or default
    val timeout = if (user.confirmationTimeoutMs != defaults.CONFIRMATION_TIMEOUT_MS)
        user.confirmationTimeoutMs else defaults.CONFIRMATION_TIMEOUT_MS

    return EffectiveToolGuardConfig(
        toolStates = mergedToolStates,
        rateLimits = mergedRateLimits,
        shellAllowlist = mergedShellAllowlist,
        shellParamRules = mergedShellRules,
        mcpGuardPatterns = mcpPatterns,
        mcpUnguarded = user.mcpUnguarded,
        confirmationTimeoutMs = timeout,
    )
}

/**
 * The fully merged config, ready for JSON serialization to Node.js.
 */
data class EffectiveToolGuardConfig(
    val toolStates: Map<String, ToolGuardState>,
    val rateLimits: Map<String, Long>,
    val shellAllowlist: Set<String>,
    val shellParamRules: List<ShellParamRule>,
    val mcpGuardPatterns: List<String>,
    val mcpUnguarded: Set<String>,
    val confirmationTimeoutMs: Long,
)
```

### 1.4 Bridge Endpoint — `AndroidBridge.kt`

**Modified file:** `app/src/main/java/com/seekerclaw/app/service/AndroidBridge.kt`

Add a new route handler in the existing `serve()` method:

```kotlin
"/tool-guard" -> handleToolGuard()
```

Handler implementation:

```kotlin
private fun handleToolGuard(): Response {
    val effective = configManager.getEffectiveToolGuardConfig()

    val response = JSONObject().apply {
        // Tools grouped by state — easier for Node.js to consume as Sets
        put("guarded", JSONArray(
            effective.toolStates
                .filter { it.value == ToolGuardState.CONFIRM }
                .keys.toList()
        ))
        put("denied", JSONArray(
            effective.toolStates
                .filter { it.value == ToolGuardState.DENY }
                .keys.toList()
        ))
        put("hidden", JSONArray(
            effective.toolStates
                .filter { it.value == ToolGuardState.HIDDEN }
                .keys.toList()
        ))

        // Rate limits: tool_name -> cooldown_ms
        put("rateLimits", JSONObject().apply {
            effective.rateLimits.forEach { (tool, ms) -> put(tool, ms) }
        })

        // Shell config
        put("shellAllowlist", JSONArray(effective.shellAllowlist.sorted()))
        put("shellParamRules", JSONArray().apply {
            effective.shellParamRules.forEach { rule ->
                put(JSONObject().apply {
                    put("id", rule.id)
                    put("pattern", rule.pattern)
                    put("severity", rule.severity)
                    put("description", rule.description)
                })
            }
        })

        // MCP config
        put("mcpGuardPatterns", JSONArray(effective.mcpGuardPatterns))
        put("mcpUnguarded", JSONArray(effective.mcpUnguarded.toList()))

        // Confirmation timeout
        put("confirmationTimeoutMs", effective.confirmationTimeoutMs)
    }

    return newFixedLengthResponse(
        Response.Status.OK,
        "application/json",
        response.toString()
    )
}
```

**Bridge endpoint contract (JSON response schema):**

```json
{
  "guarded":              ["android_sms", "solana_send", ...],
  "denied":               ["dangerous_tool", ...],
  "hidden":               ["tool_i_never_want", ...],
  "rateLimits":           { "android_sms": 60000, "solana_send": 15000 },
  "shellAllowlist":       ["ls", "cat", "curl", ...],
  "shellParamRules":      [
    { "id": "FIND_DELETE", "pattern": "find.*-delete", "severity": "HIGH", "description": "..." }
  ],
  "mcpGuardPatterns":     ["mcp__*__send*", "mcp__*__delete*", ...],
  "mcpUnguarded":         ["mcp__myserver__safeTool"],
  "confirmationTimeoutMs": 60000
}
```

---

## Phase 2: Settings UI (Compose)

### 2.1 Navigation

**Modified file:** `app/src/main/java/com/seekerclaw/app/ui/navigation/NavGraph.kt`

Add a new route:

```kotlin
const val TOOL_GUARD_ROUTE = "tool_guard"

// In NavHost:
composable(TOOL_GUARD_ROUTE) {
    ToolGuardScreen(
        viewModel = viewModel { ToolGuardViewModel(configManager) },
        onBack = { navController.popBackStack() },
    )
}
```

**Modified file:** `app/src/main/java/com/seekerclaw/app/ui/settings/SettingsScreen.kt`

Add a card in the Settings screen that navigates to the new screen:

```kotlin
// In the settings list, add between existing sections:
SettingsCard(
    icon = Icons.Outlined.Security,
    title = "Security & Permissions",
    subtitle = "Tool confirmation, shell allowlist, MCP guards",
    onClick = { navController.navigate(TOOL_GUARD_ROUTE) },
)
```

### 2.2 Screen Layout — `ToolGuardScreen.kt`

**New file:** `app/src/main/java/com/seekerclaw/app/ui/settings/ToolGuardScreen.kt`

The screen is a single scrollable column with collapsible sections:

```
+--------------------------------------------------+
| < Security & Permissions                          |
+--------------------------------------------------+
|                                                    |
| [Section 1: Tool Permissions]              [-/+]  |
| +----------------------------------------------+  |
| | > Android                                     |  |
| |   android_sms        [ALLOW|CONFIRM|DENY|HIDE]|  |
| |   android_call       [ALLOW|CONFIRM|DENY|HIDE]|  |
| |   android_camera     [ALLOW|CONFIRM|DENY|HIDE]|  |
| |   android_location   [ALLOW|CONFIRM|DENY|HIDE]|  |
| |   android_clipboard  [ALLOW|CONFIRM|DENY|HIDE]|  |
| |   ...                                         |  |
| | > Solana / Jupiter                             |  |
| |   solana_send        [ALLOW|CONFIRM|DENY|HIDE]|  |
| |   solana_swap        [ALLOW|CONFIRM|DENY|HIDE]|  |
| |   ...                                         |  |
| | > File System                                  |  |
| |   ...                                         |  |
| | > Web                                          |  |
| |   ...                                         |  |
| | > System                                       |  |
| |   ...                                         |  |
| | > Memory                                       |  |
| |   ...                                         |  |
| | > Telegram                                     |  |
| |   ...                                         |  |
| | > Cron                                         |  |
| |   ...                                         |  |
| | > Skills                                       |  |
| |   ...                                         |  |
| +----------------------------------------------+  |
|                                                    |
| [Section 2: Rate Limits]                   [-/+]  |
| +----------------------------------------------+  |
| | Tools with CONFIRM state:                      |  |
| |   android_sms     [====|----] 60s              |  |
| |   solana_send     [==|------] 15s              |  |
| |   ...                                         |  |
| +----------------------------------------------+  |
|                                                    |
| [Section 3: Shell Commands]                [-/+]  |
| +----------------------------------------------+  |
| | ! Modifying the shell allowlist affects        |  |
| |   security. Only add commands you trust.       |  |
| |                                                |  |
| |   [x] ls    [x] cat   [x] curl  [x] grep     |  |
| |   [x] find  [x] sed   [x] ping  [x] date     |  |
| |   ...                                         |  |
| |                                                |  |
| |   [+ Add Custom Command]                      |  |
| +----------------------------------------------+  |
|                                                    |
| [Section 4: Shell Argument Rules]          [-/+]  |
| +----------------------------------------------+  |
| |   [x] FIND_DELETE  [HIGH]                      |  |
| |       find.*-delete                            |  |
| |   [x] CURL_EXFIL   [HIGH]                      |  |
| |       curl.*\?(api_key|token|...)              |  |
| |   [x] SED_INPLACE  [MEDIUM]                    |  |
| |       sed\s+-i                                 |  |
| |                                                |  |
| |   [+ Add Custom Rule]                         |  |
| |   [Test a Command...]                          |  |
| +----------------------------------------------+  |
|                                                    |
| [Section 5: MCP Security]                  [-/+]  |
| +----------------------------------------------+  |
| | Auto-guard patterns:                           |  |
| |   mcp__*__send*                          [x]   |  |
| |   mcp__*__delete*                        [x]   |  |
| |   mcp__*__pay*                           [x]   |  |
| |   mcp__*__transfer*                      [x]   |  |
| |   mcp__*__charge*                        [x]   |  |
| |   mcp__*__publish*                       [x]   |  |
| |   [+ Add Pattern]                             |  |
| |                                                |  |
| | Trusted (skip auto-guard):                     |  |
| |   (none)                                       |  |
| |   [+ Trust a Tool]                             |  |
| +----------------------------------------------+  |
|                                                    |
| [Section 6: General]                       [-/+]  |
| +----------------------------------------------+  |
| | Confirmation timeout                           |  |
| |   [====|----------] 60s                        |  |
| |   (15s — 180s)                                 |  |
| |                                                |  |
| | [Reset All to Defaults]                        |  |
| +----------------------------------------------+  |
|                                                    |
+--------------------------------------------------+
```

#### Component Breakdown

**ToolStateSelector** — A segmented button row for choosing ALLOW/CONFIRM/DENY/HIDDEN:

```kotlin
@Composable
fun ToolStateSelector(
    state: ToolGuardState,
    onStateChange: (ToolGuardState) -> Unit,
    modifier: Modifier = Modifier,
) {
    // Segmented button with 4 segments
    // Color coding:
    //   ALLOW  → SeekerClawColors.accent (green #4ADE80)
    //   CONFIRM → SeekerClawColors.warning (yellow #FBBF24)
    //   DENY   → SeekerClawColors.error (red #E41F28)
    //   HIDDEN → SeekerClawColors.textSecondary (gray)
}
```

**ToolGuardItem Row** — One row per tool:

```kotlin
@Composable
fun ToolGuardRow(
    item: ToolGuardItem,
    onStateChange: (ToolGuardState) -> Unit,
    modifier: Modifier = Modifier,
) {
    // Row: icon + name (bold) + description (secondary text) + ToolStateSelector
    // If item.isDefault is false, show a small dot or "modified" indicator
    // If state is CONFIRM, show rate limit below (or expand to show slider)
}
```

**CategorySection** — Expandable group:

```kotlin
@Composable
fun CategorySection(
    title: String,
    tools: List<ToolGuardItem>,
    onToolStateChange: (String, ToolGuardState) -> Unit,
    initiallyExpanded: Boolean = false,
) {
    // Expandable card with arrow indicator
    // Shows count: "Android (3 of 8 guarded)"
}
```

**ShellCommandGrid** — Grid of toggleable command chips:

```kotlin
@Composable
fun ShellCommandGrid(
    commands: Set<String>,
    enabled: Set<String>,
    onToggle: (String, Boolean) -> Unit,
    onAddCustom: (String) -> Unit,
) {
    // FlowRow of FilterChip items
    // Each chip shows the command name, checkmark if enabled
    // Custom (user-added) commands have a different border color
}
```

**ShellRuleCard** — One card per shell param rule:

```kotlin
@Composable
fun ShellRuleCard(
    rule: ShellParamRule,
    onToggle: (Boolean) -> Unit,
    onDelete: (() -> Unit)?,  // null for default rules (cannot delete)
) {
    // Card: switch + id + severity badge + pattern (monospace) + description
    // Severity badge colors: CRITICAL=red, HIGH=orange, MEDIUM=yellow, LOW=gray
}
```

**AddRuleDialog** — Dialog for adding a custom shell param rule:

```kotlin
@Composable
fun AddShellRuleDialog(
    onDismiss: () -> Unit,
    onConfirm: (ShellParamRule) -> Unit,
) {
    // Fields: pattern (monospace TextField), severity (dropdown), description
    // Validation: pattern must be valid regex
    // "Test" button: user enters a sample command, shows match/no-match
}
```

**TestCommandDialog** — Dialog for testing shell param rules:

```kotlin
@Composable
fun TestCommandDialog(
    rules: List<ShellParamRule>,
    onDismiss: () -> Unit,
) {
    // TextField for entering a command
    // Live results: which rules match, with severity badges
}
```

**ResetConfirmDialog** — Confirmation before resetting to defaults:

```kotlin
@Composable
fun ResetConfirmDialog(
    onDismiss: () -> Unit,
    onConfirm: () -> Unit,
) {
    // "Are you sure? This will reset all security settings to defaults.
    //  Your custom rules and overrides will be lost."
    // Two buttons: Cancel, Reset
}
```

### 2.3 ViewModel — `ToolGuardViewModel.kt`

**New file:** `app/src/main/java/com/seekerclaw/app/ui/settings/ToolGuardViewModel.kt`

```kotlin
package com.seekerclaw.app.ui.settings

import androidx.lifecycle.ViewModel
import androidx.lifecycle.viewModelScope
import com.seekerclaw.app.config.*
import kotlinx.coroutines.flow.*
import kotlinx.coroutines.launch

class ToolGuardViewModel(
    private val configManager: ConfigManager,
) : ViewModel() {

    // --- State ---

    private val _config = MutableStateFlow(configManager.loadToolGuardConfig())
    val config: StateFlow<ToolGuardConfig> = _config.asStateFlow()

    /**
     * All known tools with their effective state (merged defaults + overrides),
     * grouped by category. This is the primary data source for the UI.
     */
    val toolList: StateFlow<List<ToolGuardItem>> = _config.map { cfg ->
        buildToolList(cfg)
    }.stateIn(viewModelScope, SharingStarted.WhileSubscribed(5000), emptyList())

    /**
     * Effective shell allowlist (defaults + added - removed).
     */
    val shellAllowlist: StateFlow<ShellAllowlistState> = _config.map { cfg ->
        ShellAllowlistState(
            defaults = ToolGuardDefaults.SHELL_ALLOWLIST,
            added = cfg.shellAllowlistAdded,
            removed = cfg.shellAllowlistRemoved,
            effective = ToolGuardDefaults.SHELL_ALLOWLIST
                .plus(cfg.shellAllowlistAdded)
                .minus(cfg.shellAllowlistRemoved),
        )
    }.stateIn(viewModelScope, SharingStarted.WhileSubscribed(5000), ShellAllowlistState())

    /**
     * All shell param rules (defaults + user-added).
     */
    val shellParamRules: StateFlow<List<ShellParamRuleItem>> = _config.map { cfg ->
        val defaults = ToolGuardDefaults.SHELL_PARAM_RULES.map {
            ShellParamRuleItem(rule = it, isDefault = true)
        }
        val userRules = cfg.shellParamRules.map {
            ShellParamRuleItem(rule = it, isDefault = false)
        }
        defaults + userRules
    }.stateIn(viewModelScope, SharingStarted.WhileSubscribed(5000), emptyList())

    /**
     * MCP guard config.
     */
    val mcpConfig: StateFlow<McpGuardState> = _config.map { cfg ->
        McpGuardState(
            patterns = cfg.mcpGuardPatterns.ifEmpty {
                ToolGuardDefaults.MCP_GUARD_PATTERNS
            },
            unguarded = cfg.mcpUnguarded,
            usingDefaults = cfg.mcpGuardPatterns.isEmpty(),
        )
    }.stateIn(viewModelScope, SharingStarted.WhileSubscribed(5000), McpGuardState())

    /**
     * Whether any setting has been modified from defaults.
     */
    val hasChanges: StateFlow<Boolean> = _config.map { cfg ->
        cfg != ToolGuardConfig()
    }.stateIn(viewModelScope, SharingStarted.WhileSubscribed(5000), false)

    // --- Actions ---

    fun setToolState(toolName: String, state: ToolGuardState) {
        _config.update { current ->
            current.copy(toolStates = current.toolStates + (toolName to state))
        }
        save()
    }

    fun setRateLimit(toolName: String, ms: Long) {
        _config.update { current ->
            current.copy(rateLimits = current.rateLimits + (toolName to ms))
        }
        save()
    }

    fun addShellCommand(cmd: String) {
        val trimmed = cmd.trim().lowercase()
        if (trimmed.isBlank()) return
        _config.update { current ->
            current.copy(
                shellAllowlistAdded = current.shellAllowlistAdded + trimmed,
                shellAllowlistRemoved = current.shellAllowlistRemoved - trimmed,
            )
        }
        save()
    }

    fun removeShellCommand(cmd: String) {
        _config.update { current ->
            if (cmd in ToolGuardDefaults.SHELL_ALLOWLIST) {
                // Default command — add to removals
                current.copy(
                    shellAllowlistRemoved = current.shellAllowlistRemoved + cmd,
                )
            } else {
                // User-added command — just remove from additions
                current.copy(
                    shellAllowlistAdded = current.shellAllowlistAdded - cmd,
                )
            }
        }
        save()
    }

    fun addShellParamRule(rule: ShellParamRule) {
        _config.update { current ->
            current.copy(shellParamRules = current.shellParamRules + rule)
        }
        save()
    }

    fun removeShellParamRule(ruleId: String) {
        _config.update { current ->
            current.copy(shellParamRules = current.shellParamRules.filter { it.id != ruleId })
        }
        save()
    }

    fun toggleShellParamRule(ruleId: String, enabled: Boolean) {
        _config.update { current ->
            current.copy(shellParamRules = current.shellParamRules.map {
                if (it.id == ruleId) it.copy(enabled = enabled) else it
            })
        }
        save()
    }

    fun addMcpGuardPattern(pattern: String) {
        _config.update { current ->
            val currentPatterns = current.mcpGuardPatterns.ifEmpty {
                ToolGuardDefaults.MCP_GUARD_PATTERNS
            }
            current.copy(mcpGuardPatterns = currentPatterns + pattern)
        }
        save()
    }

    fun removeMcpGuardPattern(pattern: String) {
        _config.update { current ->
            current.copy(mcpGuardPatterns = current.mcpGuardPatterns - pattern)
        }
        save()
    }

    fun trustMcpTool(toolName: String) {
        _config.update { current ->
            current.copy(mcpUnguarded = current.mcpUnguarded + toolName)
        }
        save()
    }

    fun untrustMcpTool(toolName: String) {
        _config.update { current ->
            current.copy(mcpUnguarded = current.mcpUnguarded - toolName)
        }
        save()
    }

    fun setConfirmationTimeout(ms: Long) {
        val clamped = ms.coerceIn(ToolGuardDefaults.CONFIRMATION_TIMEOUT_RANGE)
        _config.update { current ->
            current.copy(confirmationTimeoutMs = clamped)
        }
        save()
    }

    fun resetToDefaults() {
        _config.value = ToolGuardConfig()
        save()
    }

    // --- Private ---

    private fun save() {
        viewModelScope.launch {
            configManager.saveToolGuardConfig(_config.value)
        }
    }

    /**
     * Build the full tool list with effective states.
     * Categories and tool metadata are defined here (could be extracted
     * to a separate registry if the list grows).
     */
    private fun buildToolList(cfg: ToolGuardConfig): List<ToolGuardItem> {
        val effectiveStates = ToolGuardDefaults.GUARDED_TOOLS.toMutableMap()
        effectiveStates.putAll(cfg.toolStates)

        return ALL_TOOLS.map { meta ->
            val state = effectiveStates[meta.name] ?: ToolGuardState.ALLOW
            val defaultState = ToolGuardDefaults.GUARDED_TOOLS[meta.name]
                ?: ToolGuardState.ALLOW
            val rateLimit = cfg.rateLimits[meta.name]
                ?: ToolGuardDefaults.RATE_LIMITS[meta.name]

            ToolGuardItem(
                name = meta.name,
                displayName = meta.displayName,
                description = meta.description,
                category = meta.category,
                state = state,
                rateLimit = rateLimit,
                isDefault = state == defaultState
                    && rateLimit == ToolGuardDefaults.RATE_LIMITS[meta.name],
            )
        }
    }

    companion object {
        /**
         * Static registry of all known tools with display metadata.
         * This list is maintained in Kotlin — it mirrors the TOOLS array in tools.js.
         */
        val ALL_TOOLS: List<ToolMeta> = listOf(
            // --- Android ---
            ToolMeta("android_sms", "Send SMS", "Send a text message", ToolCategory.ANDROID),
            ToolMeta("android_call", "Make Call", "Initiate a phone call", ToolCategory.ANDROID),
            ToolMeta("android_camera_capture", "Camera", "Capture a photo", ToolCategory.ANDROID),
            ToolMeta("android_location", "Location", "Get GPS coordinates", ToolCategory.ANDROID),
            ToolMeta("android_clipboard_get", "Read Clipboard", "Read clipboard contents", ToolCategory.ANDROID),
            ToolMeta("android_clipboard_set", "Write Clipboard", "Write to clipboard", ToolCategory.ANDROID),
            ToolMeta("android_contacts_search", "Search Contacts", "Search phone contacts", ToolCategory.ANDROID),
            ToolMeta("android_contacts_add", "Add Contact", "Add a new contact", ToolCategory.ANDROID),
            ToolMeta("android_tts", "Text-to-Speech", "Speak text aloud", ToolCategory.ANDROID),
            ToolMeta("android_apps_list", "List Apps", "List installed apps", ToolCategory.ANDROID),
            ToolMeta("android_apps_launch", "Launch App", "Launch an installed app", ToolCategory.ANDROID),
            ToolMeta("android_battery", "Battery Status", "Get battery level and charging state", ToolCategory.ANDROID),
            ToolMeta("android_storage", "Storage Info", "Get storage usage stats", ToolCategory.ANDROID),
            ToolMeta("android_network", "Network Status", "Get connectivity info", ToolCategory.ANDROID),

            // --- Solana / Jupiter ---
            ToolMeta("solana_send", "Send SOL/SPL", "Transfer tokens to an address", ToolCategory.SOLANA),
            ToolMeta("solana_swap", "Swap Tokens", "Swap via Jupiter DEX", ToolCategory.SOLANA),
            ToolMeta("jupiter_trigger_create", "Trigger Order", "Create a Jupiter trigger order", ToolCategory.SOLANA),
            ToolMeta("jupiter_dca_create", "DCA Order", "Create a dollar-cost-average order", ToolCategory.SOLANA),
            ToolMeta("solana_balance", "Check Balance", "Get wallet balances", ToolCategory.SOLANA),
            ToolMeta("solana_price", "Token Price", "Look up token price", ToolCategory.SOLANA),
            ToolMeta("solana_quote", "Get Quote", "Get a swap quote", ToolCategory.SOLANA),
            ToolMeta("solana_history", "Transaction History", "View recent transactions", ToolCategory.SOLANA),
            ToolMeta("solana_address", "Wallet Address", "Get wallet public key", ToolCategory.SOLANA),
            ToolMeta("solana_token_search", "Token Search", "Search for tokens by name", ToolCategory.SOLANA),
            ToolMeta("solana_token_security", "Token Security", "Check token security score", ToolCategory.SOLANA),
            ToolMeta("solana_holdings", "Holdings", "View all token holdings", ToolCategory.SOLANA),

            // --- File System ---
            ToolMeta("read", "Read File", "Read a file from workspace", ToolCategory.FILESYSTEM),
            ToolMeta("write", "Write File", "Write/create a file", ToolCategory.FILESYSTEM),
            ToolMeta("edit", "Edit File", "Edit a file with search/replace", ToolCategory.FILESYSTEM),
            ToolMeta("delete", "Delete File", "Delete a file", ToolCategory.FILESYSTEM),
            ToolMeta("ls", "List Files", "List directory contents", ToolCategory.FILESYSTEM),

            // --- Web ---
            ToolMeta("web_search", "Web Search", "Search the web (Brave/DDG/Perplexity)", ToolCategory.WEB),
            ToolMeta("web_fetch", "Fetch URL", "Fetch a web page or API", ToolCategory.WEB),

            // --- System ---
            ToolMeta("shell_exec", "Shell Command", "Execute a shell command", ToolCategory.SYSTEM),
            ToolMeta("js_eval", "JS Eval", "Evaluate JavaScript in Node.js", ToolCategory.SYSTEM),
            ToolMeta("datetime", "Date/Time", "Get current date and time", ToolCategory.SYSTEM),

            // --- Memory ---
            ToolMeta("memory_save", "Save Memory", "Save to long-term memory", ToolCategory.MEMORY),
            ToolMeta("memory_read", "Read Memory", "Read memory files", ToolCategory.MEMORY),
            ToolMeta("memory_get", "Get Memory", "Get specific memory entry", ToolCategory.MEMORY),
            ToolMeta("memory_search", "Search Memory", "Search memory database", ToolCategory.MEMORY),
            ToolMeta("daily_note", "Daily Note", "Write to today's daily note", ToolCategory.MEMORY),
            ToolMeta("memory_stats", "Memory Stats", "Get memory usage statistics", ToolCategory.MEMORY),
            ToolMeta("session_status", "Session Status", "Get current session info", ToolCategory.MEMORY),

            // --- Telegram ---
            ToolMeta("telegram_send", "Send Message", "Send a Telegram message", ToolCategory.TELEGRAM),
            ToolMeta("telegram_send_file", "Send File", "Send a file via Telegram", ToolCategory.TELEGRAM),
            ToolMeta("telegram_delete", "Delete Message", "Delete a Telegram message", ToolCategory.TELEGRAM),
            ToolMeta("telegram_react", "React", "Add emoji reaction", ToolCategory.TELEGRAM),

            // --- Cron ---
            ToolMeta("cron_create", "Create Job", "Schedule a cron job or reminder", ToolCategory.CRON),
            ToolMeta("cron_list", "List Jobs", "List scheduled jobs", ToolCategory.CRON),
            ToolMeta("cron_cancel", "Cancel Job", "Cancel a scheduled job", ToolCategory.CRON),
            ToolMeta("cron_status", "Job Status", "Get cron job status", ToolCategory.CRON),

            // --- Skills ---
            ToolMeta("skill_read", "Read Skill", "Read a skill definition", ToolCategory.SKILLS),
            ToolMeta("skill_install", "Install Skill", "Install a new skill", ToolCategory.SKILLS),
        )
    }
}

// --- Data Classes ---

data class ToolGuardItem(
    val name: String,
    val displayName: String,
    val description: String,
    val category: ToolCategory,
    val state: ToolGuardState,
    val rateLimit: Long?,
    val isDefault: Boolean,
)

data class ToolMeta(
    val name: String,
    val displayName: String,
    val description: String,
    val category: ToolCategory,
)

enum class ToolCategory(val displayName: String) {
    ANDROID("Android"),
    SOLANA("Solana / Jupiter"),
    FILESYSTEM("File System"),
    WEB("Web"),
    SYSTEM("System"),
    MEMORY("Memory"),
    TELEGRAM("Telegram"),
    CRON("Cron / Scheduling"),
    SKILLS("Skills"),
    MCP("MCP Servers"),
}

data class ShellAllowlistState(
    val defaults: Set<String> = emptySet(),
    val added: Set<String> = emptySet(),
    val removed: Set<String> = emptySet(),
    val effective: Set<String> = emptySet(),
)

data class ShellParamRuleItem(
    val rule: ShellParamRule,
    val isDefault: Boolean,
)

data class McpGuardState(
    val patterns: List<String> = emptyList(),
    val unguarded: Set<String> = emptySet(),
    val usingDefaults: Boolean = true,
)
```

### 2.4 Theme Integration

All UI components use the existing `SeekerClawColors` object and `Theme.SeekerClaw`.
New color semantics needed (map to existing palette):

| Semantic | Color | Existing Token |
|----------|-------|----------------|
| ALLOW state | `#4ADE80` | `SeekerClawColors.accent` |
| CONFIRM state | `#FBBF24` | `SeekerClawColors.warning` |
| DENY state | `#E41F28` | `SeekerClawColors.primary` (error/red) |
| HIDDEN state | `#FFFFFF` at 50% | `SeekerClawColors.textSecondary` |
| Modified indicator | `#A78BFA` | `SeekerClawColors.accentPurple` (if exists) |
| Severity CRITICAL | `#E41F28` | `SeekerClawColors.primary` |
| Severity HIGH | `#FF8C00` | New or derive from warning |
| Severity MEDIUM | `#FBBF24` | `SeekerClawColors.warning` |
| Severity LOW | `#FFFFFF` at 50% | `SeekerClawColors.textSecondary` |

---

## Phase 3: Node.js Integration

### 3.1 Guard Config Loader

This can either be added to `config.js` or created as a new module `tool-guard.js`.
Recommendation: **new module** `tool-guard.js` for separation of concerns.

**New file:** `app/src/main/assets/nodejs-project/tool-guard.js`

```javascript
'use strict';

const { androidBridgeCall, log } = require('./config');

// In-memory cache of the guard config
let _guardConfig = null;

/**
 * Load tool guard config from the AndroidBridge /tool-guard endpoint.
 * Called once at startup. Falls back to hardcoded defaults on error.
 *
 * CRITICAL: Fallback must be at least as restrictive as current hardcoded
 * values — security must never degrade on bridge failure.
 */
async function loadToolGuardConfig() {
    try {
        const result = await androidBridgeCall('/tool-guard');
        if (result && !result.error) {
            _guardConfig = {
                guarded: new Set(result.guarded || []),
                denied: new Set(result.denied || []),
                hidden: new Set(result.hidden || []),
                rateLimits: result.rateLimits || {},
                shellAllowlist: new Set(result.shellAllowlist || []),
                shellParamRules: (result.shellParamRules || []).map(r => ({
                    ...r,
                    compiledPattern: new RegExp(r.pattern, 'i'),
                })),
                mcpGuardPatterns: (result.mcpGuardPatterns || []).map(glob => ({
                    glob,
                    regex: new RegExp(
                        '^' + glob.replace(/[.+^${}()|[\]\\]/g, '\\$&')
                                   .replace(/\*/g, '.*') + '$'
                    ),
                })),
                mcpUnguarded: new Set(result.mcpUnguarded || []),
                confirmationTimeoutMs: result.confirmationTimeoutMs || 60000,
            };

            log(
                `[ToolGuard] Loaded: ${_guardConfig.guarded.size} guarded, ` +
                `${_guardConfig.denied.size} denied, ` +
                `${_guardConfig.hidden.size} hidden, ` +
                `${_guardConfig.shellAllowlist.size} shell cmds`,
                'INFO'
            );
            return _guardConfig;
        }
    } catch (e) {
        log(
            `[ToolGuard] Bridge /tool-guard failed: ${e.message} — using hardcoded defaults`,
            'WARN'
        );
    }

    // Fallback: import current hardcoded values from config.js
    // This path is hit when: bridge not running, bridge error, first-launch race
    const { CONFIRM_REQUIRED, TOOL_RATE_LIMITS, SHELL_ALLOWLIST } = require('./config');
    _guardConfig = {
        guarded: new Set(CONFIRM_REQUIRED),
        denied: new Set(),
        hidden: new Set(),
        rateLimits: Object.fromEntries(
            [...CONFIRM_REQUIRED].map(t => [t, TOOL_RATE_LIMITS[t] || 0])
        ),
        shellAllowlist: new Set(SHELL_ALLOWLIST),
        shellParamRules: [],
        mcpGuardPatterns: [],
        mcpUnguarded: new Set(),
        confirmationTimeoutMs: 60000,
    };
    log('[ToolGuard] Using hardcoded fallback config', 'INFO');
    return _guardConfig;
}

/**
 * Get the cached guard config. Returns null if loadToolGuardConfig()
 * has not been called yet.
 */
function getGuardConfig() {
    return _guardConfig;
}

/**
 * Check if a tool requires confirmation.
 * Handles both built-in tools (via "guarded" set) and MCP tools (via glob patterns).
 */
function requiresConfirmation(toolName) {
    if (!_guardConfig) return false;

    // Built-in tools: check the guarded set directly
    if (_guardConfig.guarded.has(toolName)) return true;

    // MCP tools: check auto-guard patterns
    if (toolName.startsWith('mcp__')) {
        if (_guardConfig.mcpUnguarded.has(toolName)) return false;
        return _guardConfig.mcpGuardPatterns.some(p => p.regex.test(toolName));
    }

    return false;
}

/**
 * Check if a tool is denied (blocked).
 */
function isDenied(toolName) {
    return _guardConfig ? _guardConfig.denied.has(toolName) : false;
}

/**
 * Check if a tool is hidden (removed from agent's tool list).
 */
function isHidden(toolName) {
    return _guardConfig ? _guardConfig.hidden.has(toolName) : false;
}

/**
 * Get the rate limit (ms) for a tool. Returns 0 if no limit.
 */
function getRateLimit(toolName) {
    if (!_guardConfig) return 0;
    return _guardConfig.rateLimits[toolName] || 0;
}

/**
 * Check if a shell command is allowed.
 */
function isShellCommandAllowed(cmd) {
    if (!_guardConfig) return false;
    return _guardConfig.shellAllowlist.has(cmd);
}

/**
 * Scan a full shell command string against param rules.
 * Returns the first matching rule, or null if none match.
 */
function scanShellParams(fullCommand) {
    if (!_guardConfig) return null;
    for (const rule of _guardConfig.shellParamRules) {
        if (rule.compiledPattern.test(fullCommand)) {
            return rule;
        }
    }
    return null;
}

/**
 * Get the confirmation timeout (ms).
 */
function getConfirmationTimeout() {
    return _guardConfig ? _guardConfig.confirmationTimeoutMs : 60000;
}

/**
 * Format the guard config as a human-readable summary.
 * Used by the optional tool_guard_status tool.
 */
function formatGuardStatus() {
    if (!_guardConfig) return 'Tool guard config not loaded.';

    const lines = [];
    lines.push('## Tool Guard Status\n');

    if (_guardConfig.guarded.size > 0) {
        lines.push('### Confirmation Required');
        for (const t of [..._guardConfig.guarded].sort()) {
            const rl = _guardConfig.rateLimits[t];
            lines.push(`- \`${t}\`${rl ? ` (cooldown: ${rl / 1000}s)` : ''}`);
        }
        lines.push('');
    }

    if (_guardConfig.denied.size > 0) {
        lines.push('### Blocked Tools');
        for (const t of [..._guardConfig.denied].sort()) {
            lines.push(`- \`${t}\``);
        }
        lines.push('');
    }

    if (_guardConfig.hidden.size > 0) {
        lines.push('### Hidden Tools');
        for (const t of [..._guardConfig.hidden].sort()) {
            lines.push(`- \`${t}\``);
        }
        lines.push('');
    }

    lines.push('### Shell Allowlist');
    lines.push([..._guardConfig.shellAllowlist].sort().map(c => `\`${c}\``).join(', '));
    lines.push('');

    if (_guardConfig.shellParamRules.length > 0) {
        lines.push('### Shell Argument Rules');
        for (const r of _guardConfig.shellParamRules) {
            lines.push(`- **${r.id}** [${r.severity}]: ${r.description}`);
        }
        lines.push('');
    }

    if (_guardConfig.mcpGuardPatterns.length > 0) {
        lines.push('### MCP Auto-Guard Patterns');
        for (const p of _guardConfig.mcpGuardPatterns) {
            lines.push(`- \`${p.glob}\``);
        }
        lines.push('');
    }

    lines.push(`### Confirmation Timeout: ${_guardConfig.confirmationTimeoutMs / 1000}s`);

    return lines.join('\n');
}

module.exports = {
    loadToolGuardConfig,
    getGuardConfig,
    requiresConfirmation,
    isDenied,
    isHidden,
    getRateLimit,
    isShellCommandAllowed,
    scanShellParams,
    getConfirmationTimeout,
    formatGuardStatus,
};
```

### 3.2 Integration Points — Detailed Diffs

#### `main.js` — Load on Startup

In the initialization sequence (after bridge is available, before Telegram polling starts):

```javascript
// Existing code:
// await loadConfig();
// await initDatabase();

// ADD:
const { loadToolGuardConfig } = require('./tool-guard');
await loadToolGuardConfig();

// Existing code:
// startPolling();
```

**Important timing:** `loadToolGuardConfig()` must run AFTER the AndroidBridge is
available. In the current `SeekerClawService.kt` startup sequence (~line 139–162),
`NodeBridge.start()` runs first and `androidBridge.start()` runs after — so Node.js
code can race the bridge on cold boot. The bridge port (8765) and auth token are
passed via `config.json` at startup; `loadToolGuardConfig()` should retry with
backoff (see Section 7.3) instead of assuming the bridge is up on first call.

#### `claude.js` — Confirmation Gate (line ~1616)

**Current code (simplified):**
```javascript
if (CONFIRM_REQUIRED.has(toolUse.name)) {
    // ... confirmation flow with 60s timeout ...
}
const result = await executeTool(toolUse.name, toolUse.input);
```

**New code:**
```javascript
const {
    isDenied, requiresConfirmation, getRateLimit, getConfirmationTimeout
} = require('./tool-guard');

// 1. Check DENY — blocked tools
if (isDenied(toolUse.name)) {
    log(`[ToolGuard] DENIED: ${toolUse.name}`, 'WARN');
    toolResults.push({
        type: 'tool_result',
        tool_use_id: toolUse.id,
        content: JSON.stringify({
            error: `Tool "${toolUse.name}" is blocked by your security settings. ` +
                   `You can change this in SeekerClaw > Settings > Security & Permissions.`
        }),
    });
    continue; // Skip to next tool_use in the batch
}

// 2. Check CONFIRM — guarded tools (includes MCP auto-guard)
if (requiresConfirmation(toolUse.name)) {
    const timeout = getConfirmationTimeout();
    // ... existing confirmation flow, but use `timeout` instead of hardcoded 60000 ...
    // ... existing rate limit check, but use getRateLimit(toolUse.name) ...
}

// 3. Execute
const result = await executeTool(toolUse.name, toolUse.input);
```

#### `tools.js` — Filter Hidden Tools

**Current code (getTools or TOOLS export):**
```javascript
function getTools() {
    return TOOLS;
}
```

**New code:**
```javascript
const { isHidden } = require('./tool-guard');

function getTools() {
    return TOOLS.filter(t => !isHidden(t.name));
}
```

This affects the system prompt (which lists available tools) and the API call
(which sends the tools array to Claude/OpenAI).

#### `tools.js` — Shell Exec (line ~3490)

**Current code (simplified):**
```javascript
case 'shell_exec': {
    const cmd = input.command;
    const firstToken = cmd.split(/\s+/)[0];
    if (!SHELL_ALLOWLIST.has(firstToken)) {
        return { error: `Command "${firstToken}" is not in the allowlist.` };
    }
    // ... execute ...
}
```

**New code:**
```javascript
const { isShellCommandAllowed, scanShellParams } = require('./tool-guard');

case 'shell_exec': {
    const cmd = input.command;
    const firstToken = cmd.split(/\s+/)[0];

    // Check allowlist (from guard config)
    if (!isShellCommandAllowed(firstToken)) {
        return {
            error: `Command "${firstToken}" is not in the shell allowlist. ` +
                   `The user can add it in Settings > Security > Shell Commands.`
        };
    }

    // Scan arguments for dangerous patterns
    const matchedRule = scanShellParams(cmd);
    if (matchedRule) {
        log(`[ShellGuard] Blocked by rule ${matchedRule.id}: ${cmd}`, 'WARN');
        return {
            error: `Blocked by security rule "${matchedRule.id}" ` +
                   `[${matchedRule.severity}]: ${matchedRule.description}`
        };
    }

    // ... execute ...
}
```

#### `tools.js` — MCP Tool Execution (line ~3908)

**Current code:** MCP tools execute with no confirmation check.

**New code:** The `requiresConfirmation()` helper already handles MCP tools
(see 3.1 above), so the only change needed is in `claude.js` where the
confirmation gate runs — it now catches MCP tools via the auto-guard patterns.
No changes needed in `tools.js` MCP section itself.

---

## Phase 4: Agent Self-Awareness

**Modified file:** `claude.js` — `buildSystemBlocks()` function

Add a new section after the existing Safety section:

```javascript
// --- Tool Guard / Security Settings ---
const guard = getGuardConfig();
if (guard) {
    const guardLines = [];

    if (guard.denied.size > 0) {
        guardLines.push(
            `- **Blocked tools** (user has disabled these — do NOT attempt to call them): ` +
            `${[...guard.denied].join(', ')}`
        );
    }

    if (guard.guarded.size > 0) {
        guardLines.push(
            `- **Confirmation-required tools** (user will be asked YES/NO before execution): ` +
            `${[...guard.guarded].join(', ')}`
        );
    }

    // Note: hidden tools are already filtered from the TOOLS array,
    // so the agent cannot see them at all. No need to mention them.

    if (guardLines.length > 0) {
        blocks.push({
            title: 'Security Settings',
            content: guardLines.join('\n'),
        });
    }
}
```

This ensures the agent:
1. Knows which tools are blocked and will not waste API calls trying to use them
2. Knows which tools will trigger a confirmation prompt
3. Does NOT know about hidden tools (since they are removed from the tools array)

---

## Phase 5: Optional — `tool_guard_status` Tool

A read-only tool that lets the user ask "what are my security settings?"

**Modified file:** `tools.js` — add to TOOLS array

```javascript
{
    name: 'tool_guard_status',
    description:
        'Show your current security settings: which tools need confirmation, ' +
        'which are blocked, the shell allowlist, MCP guard patterns, and ' +
        'confirmation timeout. Read-only — cannot modify settings. ' +
        'Direct the user to SeekerClaw app > Settings > Security & Permissions ' +
        'to make changes.',
    input_schema: {
        type: 'object',
        properties: {},
        required: [],
    },
},
```

**Execution handler in tools.js:**

```javascript
case 'tool_guard_status': {
    const { formatGuardStatus } = require('./tool-guard');
    return { content: formatGuardStatus() };
}
```

This tool is explicitly read-only. The description tells the agent to direct users
to the Android Settings UI for changes.

---

## File Changes Summary

### New Files

| File | Location | Purpose | Lines (est.) |
|------|----------|---------|-------------|
| `ToolGuardConfig.kt` | `app/.../config/` | Data model (`ToolGuardConfig`, `ToolGuardState`, `ShellParamRule`) | ~90 |
| `ToolGuardDefaults.kt` | `app/.../config/` | Hardcoded defaults matching current JS behavior | ~80 |
| `ToolGuardScreen.kt` | `app/.../ui/settings/` | Compose UI — all 6 sections | ~600 |
| `ToolGuardViewModel.kt` | `app/.../ui/settings/` | ViewModel + data classes + tool registry | ~350 |
| `tool-guard.js` | `assets/nodejs-project/` | Guard config loader, helpers, formatters | ~200 |

### Modified Files

| File | Location | Change | Lines (est.) |
|------|----------|--------|-------------|
| `ConfigManager.kt` | `app/.../config/` | Add `save/loadToolGuardConfig()`, `getEffectiveToolGuardConfig()` | +60 |
| `AndroidBridge.kt` | `app/.../service/` | Add `/tool-guard` endpoint handler | +50 |
| `NavGraph.kt` | `app/.../ui/navigation/` | Add `TOOL_GUARD_ROUTE` composable | +10 |
| `SettingsScreen.kt` | `app/.../ui/settings/` | Add "Security & Permissions" navigation card | +15 |
| `main.js` | `assets/nodejs-project/` | Call `loadToolGuardConfig()` on startup | +5 |
| `claude.js` | `assets/nodejs-project/` | Replace `CONFIRM_REQUIRED` with guard API + self-awareness block | +40 |
| `tools.js` | `assets/nodejs-project/` | Filter hidden tools, shell param scanning, guard status tool | +30 |

### Files That DO NOT Change

| File | Reason |
|------|--------|
| `config.js` | Hardcoded constants remain as fallback; no removal needed |
| `proguard-rules.pro` | Wildcard rule already covers `com.seekerclaw.app.**` `@Serializable` classes |
| `AndroidManifest.xml` | No new permissions needed |
| `build.gradle.kts` | No new dependencies needed (all Compose/serialization deps already present) |

---

## Migration & Upgrade Path

### First Launch After Update

1. User installs new version over v1.6.x
2. `loadToolGuardConfig()` in ConfigManager finds no `tool_guard_config` key in SharedPreferences
3. Returns empty `ToolGuardConfig()` (all maps/sets empty)
4. `getEffectiveToolGuardConfig()` merges empty user config with `ToolGuardDefaults`
5. Result is **identical** to current hardcoded behavior
6. Node.js calls `/tool-guard` and receives the merged config
7. **Zero behavior change** for the user

### Explicit Verification

Test matrix for upgrade scenario:

| Scenario | Expected Behavior | Verified By |
|----------|-------------------|-------------|
| Fresh install | Defaults applied, 8 tools guarded | UI shows defaults |
| Upgrade from v1.6.x | Identical to fresh install | No confirmation changes |
| User sets tool to DENY | Tool returns error on next call | Trigger tool, see error |
| User sets tool to HIDDEN | Tool disappears from agent | Check system prompt |
| User adds shell command | Command becomes usable | shell_exec with new cmd |
| User removes shell command | Command blocked | shell_exec with removed cmd |
| User adds MCP pattern | Matching MCP tools require confirm | Call matching MCP tool |
| User resets to defaults | Returns to v1.6.x behavior | Compare with fresh install |
| Bridge failure | Hardcoded fallback used | Kill bridge, check behavior |

---

## Dependencies & Prerequisites

| Dependency | Status | Blocking? | Notes |
|------------|--------|-----------|-------|
| AndroidBridge running | Already implemented | No | Port 8765, auth token via config.json |
| KeystoreHelper encryption | Already implemented | No | AES-256-GCM |
| ConfigManager SharedPreferences | Already implemented | No | Extend with new methods |
| Compose navigation | Already implemented | No | Add one route |
| kotlinx.serialization | Already in deps | No | For ToolGuardConfig |
| config.js constants | Already exist | No | Used as fallback values |

No new Gradle dependencies required. No Gradle sync needed for Kotlin/JS changes.

---

## Estimated Effort

| Phase | BAT Tickets | Effort | Notes |
|-------|-------------|--------|-------|
| Phase 1: Data model + bridge | 1-2 | 1-2 days | Straightforward data + endpoint |
| Phase 2: Settings UI | 2-3 | 3-5 days | Largest piece — 6 sections, many interactive controls |
| Phase 3: Node.js integration | 1 | 1 day | New module + 3 file edits |
| Phase 4: Agent self-awareness | 0.5 | 0.5 day | Part of Phase 3 ticket |
| Phase 5: tool_guard_status | 0.5 | 0.5 day | Optional, simple |
| **Total** | **5-7** | **6-9 days** | |

### Suggested Ticket Breakdown

1. **BAT-XXX:** Tool Guard data model + ConfigManager + bridge endpoint (Phase 1)
2. **BAT-XXX:** Tool Guard UI — tool permissions section (Phase 2, Section 1-2)
3. **BAT-XXX:** Tool Guard UI — shell + MCP + general sections (Phase 2, Section 3-6)
4. **BAT-XXX:** Tool Guard Node.js integration + agent awareness (Phase 3-4)
5. **BAT-XXX:** tool_guard_status tool (Phase 5, optional)

---

## Risks & Mitigations

### 1. UI Complexity

**Risk:** The Settings UI has 6 sections with many interactive controls. Could become
overwhelming for non-power-users.

**Mitigation:**
- All sections are collapsed by default
- Most users will never open this screen (defaults are good)
- "Reset to Defaults" always available
- Progressive disclosure: simple tools first, advanced (shell rules) later
- Consider a "Preset Profiles" feature (see Open Questions)

### 2. Testing Matrix

**Risk:** Combinatorial explosion of states: 56 tools x 4 states + shell commands +
MCP patterns + rate limits.

**Mitigation:**
- Focus testing on state transitions (ALLOW->DENY->ALLOW roundtrip)
- Test bridge fallback (kill bridge, verify hardcoded defaults)
- Automated test for merge logic (unit test `getEffectiveToolGuardConfig`)
- Test the upgrade path explicitly (install v1.6.x, then update)

### 3. Bridge Timing Race

**Risk:** Node.js starts before AndroidBridge is ready, `/tool-guard` call fails.

**Mitigation:**
- Fallback to hardcoded defaults is already implemented (see 3.1)
- Current startup order in `SeekerClawService.kt` does NOT guarantee AndroidBridge
  is ready before Node.js — `NodeBridge.start()` runs first, `androidBridge.start()`
  runs after, so `/tool-guard` MUST tolerate bridge readiness lag on cold boot
- Add retry with backoff: if the initial `/tool-guard` call fails because the
  bridge is not yet listening, retry 3x at 1s intervals before falling back
- Log clearly when retry/fallback is used so users can diagnose startup-timing issues

### 4. Config Corruption

**Risk:** Encrypted SharedPreferences value becomes corrupt (device crash, storage error).

**Mitigation:**
- `loadToolGuardConfig()` catches all exceptions, returns empty config
- Empty config + defaults = current behavior (safe fallback)
- Consider adding a backup: write plaintext hash alongside encrypted value,
  verify on load (detect corruption early)

### 5. Agent Circumvention

**Risk:** A sufficiently clever prompt injection could try to convince the agent
to modify its own guard config.

**Mitigation:**
- **Architectural:** The agent literally cannot write to SharedPreferences.
  The bridge endpoint is read-only (GET). There is no `/tool-guard/set` endpoint.
- **Defense in depth:** Even if a new bridge endpoint were accidentally added,
  the auth token is per-boot and the bridge only listens on localhost.
- **Self-awareness prompt:** Tells the agent about restrictions but does not
  reveal how to change them (directs to "SeekerClaw app Settings").

---

## Open Questions

### 1. Hidden Tools and MCP

**Question:** Should "Hidden" tools still be callable via MCP servers? For example,
if a user hides `write` (built-in), should `mcp__myserver__write` still work?

**Recommendation:** Yes. "Hidden" only removes the tool from the built-in TOOLS
array. MCP tools are independently registered and have their own guard patterns.
This keeps the behavior predictable: hiding a built-in tool does not affect
identically-named MCP tools.

### 2. Agent Security Suggestions

**Question:** Should the agent be able to suggest security changes? For example:
"I notice `android_camera` is set to ALLOW — consider setting it to CONFIRM for
extra safety."

**Recommendation:** Not in v1. This adds complexity and could annoy users. If
implemented later, it should be a one-time suggestion (not repeated) and only
triggered when the agent actually tries to use the tool.

### 3. Preset Profiles

**Question:** Should there be preset profiles like "Paranoid" (everything CONFIRM),
"Balanced" (current defaults), "Permissive" (everything ALLOW)?

**Recommendation:** Nice-to-have for v2. Would simplify UX for users who don't
want to configure individual tools. Implementation: 3-4 predefined
`ToolGuardConfig` objects, selectable via a dropdown at the top of the screen.
User customizations would overlay the selected profile.

### 4. Per-Chat Guard Rules

**Question:** Should guard settings be per-Telegram-chat (for future multi-chat)?

**Recommendation:** No. SeekerClaw is single-owner. Guard settings apply globally.
If multi-chat is ever added, guard settings would still be global (they protect
the device, not individual conversations).

### 5. Export/Import

**Question:** Should guard config be included in the existing Settings export/import?

**Recommendation:** Yes. Add `toolGuardConfig` field to the export JSON. On import,
merge with existing config (don't overwrite if the import is from a different
device with different MCP servers).

---

## Appendix: Tool Name Registry

Complete list of tool names used in the guard system. This must stay in sync with
`tools.js` TOOLS array.

```
# Android Bridge (14)
android_battery, android_storage, android_network,
android_clipboard_get, android_clipboard_set,
android_contacts_search, android_contacts_add,
android_sms, android_call, android_location,
android_tts, android_apps_list, android_apps_launch,
android_camera_capture

# Solana / Jupiter (16)
solana_balance, solana_history, solana_address, solana_send,
solana_price, solana_quote, solana_swap,
jupiter_trigger_create, jupiter_trigger_list, jupiter_trigger_cancel,
jupiter_dca_create, jupiter_dca_list, jupiter_dca_cancel,
solana_token_search, solana_token_security, solana_holdings

# File System (5)
read, write, edit, delete, ls

# Web (2)
web_search, web_fetch

# System (3)
shell_exec, js_eval, datetime

# Memory (7)
memory_save, memory_read, memory_get, memory_search,
daily_note, memory_stats, session_status

# Telegram (4)
telegram_send, telegram_send_file, telegram_delete, telegram_react

# Cron (4)
cron_create, cron_list, cron_cancel, cron_status

# Skills (2)
skill_read, skill_install

# Guard Status (1, optional Phase 5)
tool_guard_status

# MCP (dynamic)
mcp__<server_id>__<tool_name> (matched by glob patterns)
```

**Total built-in:** 58 tools (57 existing + 1 new `tool_guard_status`)

---

*This plan was created based on analysis of SeekerClaw's existing security
architecture and adapted for its mobile-first, agent-cannot-modify-settings
design principle. The key architectural decision: security config lives in
Kotlin/SharedPreferences (agent cannot modify), not in workspace files
(agent could modify).*

*Reference: CoPaw Tool Guard competitive analysis (inspiration for the feature).*
