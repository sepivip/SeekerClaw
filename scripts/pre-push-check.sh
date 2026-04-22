#!/usr/bin/env bash
# pre-push-check.sh — run all local checks before `git push`.
#
# Why this exists
# ---------------
# Our local dev machine had Java 8 for a long time, which meant the only
# Kotlin compile check was CI. Yesterday (BAT-498 / PR #334), a missing
# `aspectRatio` import on a Kotlin-only change passed `node tests/nodejs-project/smoke.js`
# (Node-only, can't see Kotlin) and only got caught by CI ~4 minutes later —
# forcing a force-push cycle on a PR branch.
#
# Discovery (2026-04-22): Android Studio ships a JDK 21 at `jbr/` that compiles
# the project cleanly in ~5 seconds. This script uses it unconditionally so
# every push gets a Kotlin compile check for the cost of a few seconds of
# wall-clock time. No JDK install required.
#
# What it checks (in order, fail-fast):
#   1. Node.js smoke test (`tests/nodejs-project/smoke.js`) — syntax + module load
#   2. Kotlin compile (`compileDappStoreDebugKotlin`) — catches import errors,
#      type mismatches, unresolved references BEFORE CI
#
# Usage:
#   scripts/pre-push-check.sh
#
# Exit codes:
#   0 = all checks passed
#   1 = Node smoke failed
#   2 = Kotlin compile failed
#   3 = JDK 17+ not found (see JDK_CANDIDATES below)
#   4 = Android SDK not found (ANDROID_HOME / local.properties / standard paths)
#   5 = Script couldn't cd to repo root (broken path / permissions)
#
# Optional: wire this into `.git/hooks/pre-push` by symlinking:
#   ln -s ../../scripts/pre-push-check.sh .git/hooks/pre-push
# (Hooks aren't committed; you'd need this on each clone.)

set -uo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$REPO_ROOT" || { echo "❌ can't cd to repo root: $REPO_ROOT"; exit 5; }

# ── Resolve JDK 17+ path ────────────────────────────────────────────────────
# We look in several standard Windows + macOS + Linux locations so the script
# works for any contributor. Android Studio's bundled JBR is the easiest bet.
JDK_CANDIDATES=(
    # Android Studio bundled JBR (most common case)
    "/e/Android Studio/jbr"
    "/c/Program Files/Android/Android Studio/jbr"
    "/Applications/Android Studio.app/Contents/jbr/Contents/Home"
    "$HOME/Library/Application Support/Google/AndroidStudio*/jbr"

    # Explicit JDK 17 / 21 installs (Windows — Temurin is the standard)
    "/c/Program Files/Eclipse Adoptium/jdk-21.*"
    "/c/Program Files/Eclipse Adoptium/jdk-17.*"

    # macOS Homebrew
    "/opt/homebrew/opt/openjdk@21"
    "/opt/homebrew/opt/openjdk@17"
    "/usr/local/opt/openjdk@21"
    "/usr/local/opt/openjdk@17"

    # Linux
    "/usr/lib/jvm/java-21-openjdk-amd64"
    "/usr/lib/jvm/java-17-openjdk-amd64"
)

# Resolve the java binary for a given JDK root — returns the first existing
# of `bin/java`, `bin/java.exe`, or empty if neither exists. Works for paths
# with spaces (quoted variable expansion).
_resolve_java() {
    local root="$1"
    if [ -x "$root/bin/java.exe" ]; then
        echo "$root/bin/java.exe"
    elif [ -x "$root/bin/java" ]; then
        echo "$root/bin/java"
    fi
}

# Returns 0 if the path's java binary reports version >= 17.
_is_jdk17plus() {
    local java_bin="$1"
    [ -z "$java_bin" ] && return 1
    local ver
    ver=$("$java_bin" -version 2>&1 | head -1 | grep -oE '"[0-9]+' | tr -d '"')
    [ -n "$ver" ] && [ "$ver" -ge 17 ] 2>/dev/null
}

# Honor a pre-set JAVA_HOME if it points at JDK 17+.
if [ -n "${JAVA_HOME:-}" ]; then
    _jb=$(_resolve_java "$JAVA_HOME")
    if _is_jdk17plus "$_jb"; then
        RESOLVED_JDK="$JAVA_HOME"
    fi
fi

# Walk the candidate list. Each candidate may contain glob wildcards; we
# expand them via compgen so unquoted word-splitting doesn't break paths
# that contain spaces (e.g. "/e/Android Studio/jbr").
if [ -z "${RESOLVED_JDK:-}" ]; then
    for pattern in "${JDK_CANDIDATES[@]}"; do
        # If the pattern has no glob chars, just test it directly.
        if [[ "$pattern" != *[*?]* ]]; then
            _jb=$(_resolve_java "$pattern")
            if _is_jdk17plus "$_jb"; then
                RESOLVED_JDK="$pattern"
                break
            fi
            continue
        fi
        # Glob expansion. compgen -G emits whole matched paths (one per line,
        # spaces preserved). The `while IFS= read -r path` loop consumes each
        # line verbatim — no word-splitting, no subshell fork for xargs.
        while IFS= read -r path; do
            _jb=$(_resolve_java "$path")
            if _is_jdk17plus "$_jb"; then
                RESOLVED_JDK="$path"
                break 2
            fi
        done < <(compgen -G "$pattern" 2>/dev/null || true)
    done
fi

if [ -z "${RESOLVED_JDK:-}" ]; then
    echo "❌ No JDK 17+ found."
    echo "   Searched:"
    for c in "${JDK_CANDIDATES[@]}"; do echo "     $c"; done
    echo ""
    echo "   Fixes:"
    echo "     - Install Android Studio (bundles JDK 21 at jbr/)"
    echo "     - Install Temurin 17: winget install EclipseAdoptium.Temurin.17.JDK"
    echo "     - Set JAVA_HOME to point at a JDK 17+ install"
    exit 3
fi

echo "─── Pre-push check ──────────────────────────────"
echo "  Repo: $REPO_ROOT"
echo "  JDK:  $RESOLVED_JDK"

# Re-resolve the java binary (may be `java` or `java.exe`) to print the version.
# The JDK detection loop above tested executability of this binary already, so
# this resolve always succeeds.
RESOLVED_JAVA_BIN=$(_resolve_java "$RESOLVED_JDK")
"$RESOLVED_JAVA_BIN" -version 2>&1 | head -1 | sed 's/^/         /'
echo ""

# ── Resolve ANDROID_HOME ───────────────────────────────────────────────────
# Gradle can't find the Android SDK without `ANDROID_HOME`, `ANDROID_SDK_ROOT`,
# or `sdk.dir` in `local.properties`. Worktrees don't have `local.properties`
# (gitignored), so we probe:
#   1. Pre-set `ANDROID_HOME` / `ANDROID_SDK_ROOT` env
#   2. Main-repo `local.properties` (for worktrees created via `git worktree`)
#   3. Standard install locations
if [ -z "${ANDROID_HOME:-}" ] && [ -n "${ANDROID_SDK_ROOT:-}" ]; then
    ANDROID_HOME="$ANDROID_SDK_ROOT"
fi

if [ -z "${ANDROID_HOME:-}" ]; then
    # Main-repo's local.properties (works for worktrees — .git/ points back to main).
    # Capture into a variable (no `xargs`) so paths with spaces don't get word-split.
    _git_common_dir="$(git rev-parse --git-common-dir 2>/dev/null || true)"
    _main_repo=""
    if [ -n "$_git_common_dir" ]; then
        _main_repo="$(dirname "$_git_common_dir")"
    fi
    if [ -n "$_main_repo" ] && [ -f "$_main_repo/local.properties" ]; then
        # Java properties format escapes `:` and `\` — a line like
        #   sdk.dir=E\:\\AndroidSDK
        # decodes to `E:\AndroidSDK`. Unescape in two passes:
        #   1. `\:` → `:`
        #   2. `\\` → `\`   (must happen AFTER #1 so we don't eat escapes twice)
        _sdk=$(grep -E '^sdk\.dir=' "$_main_repo/local.properties" | head -1 | cut -d= -f2- | tr -d '\r')
        _sdk=$(printf '%s' "$_sdk" | sed -e 's|\\:|:|g' -e 's|\\\\|\\|g')
        # Convert Windows path → POSIX (MSYS git-bash) so the -d test works.
        if command -v cygpath >/dev/null 2>&1 && [ -n "$_sdk" ]; then
            _sdk_posix=$(cygpath -u "$_sdk" 2>/dev/null || echo "$_sdk")
        else
            _sdk_posix="$_sdk"
        fi
        if [ -n "$_sdk_posix" ] && [ -d "$_sdk_posix" ]; then
            ANDROID_HOME="$_sdk_posix"
        fi
    fi
fi

if [ -z "${ANDROID_HOME:-}" ]; then
    # Standard install locations
    for cand in \
        "/e/AndroidSDK" \
        "$HOME/AppData/Local/Android/Sdk" \
        "/c/Users/$USER/AppData/Local/Android/Sdk" \
        "$HOME/Library/Android/sdk" \
        "$HOME/Android/Sdk"; do
        if [ -d "$cand/platforms" ] || [ -d "$cand/build-tools" ]; then
            ANDROID_HOME="$cand"
            break
        fi
    done
fi

if [ -z "${ANDROID_HOME:-}" ]; then
    echo "❌ Android SDK not found."
    echo "   Set ANDROID_HOME env var, or put sdk.dir=<path> in local.properties."
    exit 4
fi

echo "  SDK:  $ANDROID_HOME"
echo ""

# Gradle on Windows expects Windows-style paths (E:\foo) in ANDROID_HOME, not
# MSYS POSIX style (/e/foo). `cygpath -w` converts if we're on Windows;
# harmless no-op elsewhere (falls back to the original value).
if command -v cygpath >/dev/null 2>&1; then
    ANDROID_HOME=$(cygpath -w "$ANDROID_HOME")
fi
export ANDROID_HOME

# Same for JAVA_HOME — Gradle's JDK selection on Windows reads this.
if command -v cygpath >/dev/null 2>&1; then
    export JAVA_HOME=$(cygpath -w "$RESOLVED_JDK")
else
    export JAVA_HOME="$RESOLVED_JDK"
fi
export PATH="$RESOLVED_JDK/bin:$PATH"


# ── 1. Node.js smoke test ───────────────────────────────────────────────────
echo "── 1/2  Node smoke test ─────────────────────────"
if ! node tests/nodejs-project/smoke.js; then
    echo ""
    echo "❌ Node smoke test failed — don't push."
    exit 1
fi
echo ""

# ── 2. Kotlin compile (dappStore debug) ─────────────────────────────────────
# Only compile the dappStore flavor — googlePlay is identical Kotlin source, so
# dappStore catches every compile error at ~half the time of both flavors.
echo "── 2/2  Kotlin compile (dappStoreDebug) ─────────"

# Unique temp log per invocation — avoids races between concurrent runs and
# symlink-clobber risk on multi-user systems. Path is printed below on failure.
KOTLIN_LOG_FILE="$(mktemp "${TMPDIR:-/tmp}/pre-push-kotlin.XXXXXX.log")"

# Run Gradle and capture both stdout+stderr to a tee'd log. Rely on
# ${PIPESTATUS[0]} instead of `$?` since `tee|tail` masks the real exit code.
# (We also have `set -o pipefail` above, but being explicit here is safer
# against future refactors that might remove the set.)
./gradlew --console=plain compileDappStoreDebugKotlin 2>&1 \
    | tee "$KOTLIN_LOG_FILE" \
    | tail -20
GRADLE_EXIT=${PIPESTATUS[0]}

if [ "$GRADLE_EXIT" -ne 0 ]; then
    echo ""
    echo "❌ Kotlin compile failed (exit $GRADLE_EXIT) — don't push."
    echo "   Full log: $KOTLIN_LOG_FILE"
    exit 2
fi

# Extra check: grep the tee'd log for any 'e:' (Kotlin error prefix) even if
# the exit code was 0 (belt + suspenders for the "warnings treated as errors"
# edge case).
if grep -qE "^e: " "$KOTLIN_LOG_FILE"; then
    echo ""
    echo "❌ Kotlin compile log contains errors (exit code was 0 but 'e:' lines found)."
    grep -E "^e: " "$KOTLIN_LOG_FILE" | head -5
    echo "   Full log: $KOTLIN_LOG_FILE"
    exit 2
fi

# Clean up on success — keep the log on failure for debugging.
rm -f "$KOTLIN_LOG_FILE"

echo ""
echo "─── ALL CHECKS PASSED ───────────────────────────"
echo "  Safe to push."
