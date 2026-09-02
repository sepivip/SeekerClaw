'use strict';

/**
 * BAT-1293 — enforce the build-identity invariant.
 *
 * THE INVARIANT: no build-identity value may be a compile-time constant, and no
 * such value may be written down twice.
 *
 * Both halves have already been violated once each, in the fix itself:
 *
 *   half 1 — GIT_SHA was a `public static final String`. Java/Kotlin INLINE
 *            those at every call site, so when the value changed AGP regenerated
 *            BuildConfig.java but incremental compilation did not recompile the
 *            readers: they kept the PREVIOUS literal in bytecode. A clean build
 *            hid it, so it only ever bit the incremental path used all day.
 *
 *   half 2 — the fix for half 1 then fed GenerateBuildProvenanceTask four
 *            HAND-TYPED literals duplicating defaultConfig 560 lines above, with
 *            nothing asserting they agreed. Same stale identity, relocated from
 *            bytecode into the build script, and strictly worse: unlike the
 *            inlining bug it never self-heals on a clean build.
 *
 * Neither half is visible to a compiler — a reintroduced constant compiles
 * perfectly, and two disagreeing literals are both valid Kotlin. `pre-push-check`
 * runs a Kotlin COMPILE, which is precisely the step blind to this class. So the
 * guard has to be a source assertion, and it has to run somewhere that actually
 * executes. This file is in the build.yml test loop for that reason; the repo's
 * own ci-coverage-manifest test refuses to let it be added and forgotten.
 *
 * NEGATIVE CONTROL (run by hand after changing this file):
 *   1. add `buildConfigField("String", "GIT_SHA", "\"abc\"")` to defaultConfig
 *      -> case 1 must go red
 *   2. write `BuildConfig.VERSION_NAME` into any Kotlin file under app/src/main
 *      -> case 2 must go red
 *   3. change `versionNameIn = appVersionName` back to a literal `"2.2.0"`
 *      -> case 3 must go red
 * All three were confirmed red before this file was committed.
 *
 * Case 3 also has to stay QUIET when nothing is wrong, or it gets switched off
 * and the duplicate it exists to catch then ships behind it. Its first version
 * counted with `src.split(value)` over the RAW file and cried wolf on both of the
 * shapes below, so those are controls too:
 *   4. add a second `versionNameIn = "2.2.0"` line          -> must go red
 *   5. put `"2.2.0"`, quotes included, inside a comment     -> must stay green
 *   6. put an unrelated 23 in a comment, and a number that
 *      merely contains 23 (e.g. 2300) in code               -> must stay green
 * Observed: 4 red, 5 green, 6 green. Against the old split()-on-raw counting the
 * same 5 and 6 were both RED — two false alarms, which is why the counting is now
 * comment-aware and, for the unquoted versionCode, whole-token.
 */

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');

const REPO = path.resolve(__dirname, '..', '..');
const GRADLE = path.join(REPO, 'app', 'build.gradle.kts');
const KOTLIN_ROOT = path.join(REPO, 'app', 'src', 'main', 'java');

/** Values that identify WHICH BUILD this is. Not feature flags, not store names. */
const IDENTITY_NAMES = [
    'GIT_SHA', 'BUILD_DATE', 'BUILD_TIME', 'COMMIT', 'COMMIT_SHA',
    'VERSION_NAME', 'VERSION_CODE', 'OPENCLAW_VERSION', 'NODEJS_VERSION',
];

function walk(dir, out) {
    out = out || [];
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
        const p = path.join(dir, e.name);
        if (e.isDirectory()) walk(p, out);
        else if (e.name.endsWith('.kt')) out.push(p);
    }
    return out;
}

/**
 * Strip block and line comments so prose ABOUT this bug is not itself a hit —
 * several files legitimately quote `BuildConfig.VERSION_NAME` while explaining
 * why they no longer read it.
 *
 * These sources are CRLF. `\r` is a line terminator to the JS regex engine, so
 * `.` cannot cross it and an anchored `/\/\/.*$/` never matches on a `...\r`
 * line — it silently strips nothing. Match a bounded run instead of anchoring.
 */
function stripComments(src) {
    return src
        .replace(/\/\*[\s\S]*?\*\//g, '')
        .replace(/\/\/[^\r\n]*/g, '');
}

/** Escape a literal so it can be embedded in a RegExp source. */
function escapeRegExp(s) {
    return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Count how many times an identity VALUE is literally written in `src`.
 *
 * This began as `src.split(value).length - 1` over the RAW file, which counts
 * SUBSTRINGS and counts prose. Both shapes cried wolf: `appVersionCode = 23` was
 * reported as duplicated by any unrelated 23 in the file (a line number, a 2023,
 * a `.23` inside some other version string), and a comment quoting "2.2.0"
 * counted as a second definition. A guard that reports duplicates which are not
 * there is a guard someone deletes — and then the real duplicate ships.
 *
 * The caller strips comments, so only code is counted. A quoted value is counted
 * WITH its quotes, and a bare number counts only as a whole token — no digit and
 * no `.` on either side — so it can never match a slice of a longer number or of
 * a dotted version string.
 */
function countLiteral(src, value) {
    const pattern = value.startsWith('"')
        ? escapeRegExp(value)
        : '(?<![\\d.])' + escapeRegExp(value) + '(?![\\d.])';
    return (src.match(new RegExp(pattern, 'g')) || []).length;
}

test('no build-identity value is declared as a buildConfigField', () => {
    const src = stripComments(fs.readFileSync(GRADLE, 'utf8'));
    const offenders = [];
    const re = /buildConfigField\s*\(\s*"[^"]*"\s*,\s*"([^"]+)"/g;
    let m;
    while ((m = re.exec(src)) !== null) {
        if (IDENTITY_NAMES.includes(m[1])) offenders.push(m[1]);
    }
    assert.deepStrictEqual(offenders, [],
        'buildConfigField creates a compile-time constant, which inlines into every ' +
        'reader and goes stale on an incremental build. Read it at runtime instead ' +
        '(BuildProvenance for packaged values, PackageManager for versionName/Code).');
});

test('no Kotlin source reads a build-identity value off BuildConfig', () => {
    const offenders = [];
    for (const file of walk(KOTLIN_ROOT)) {
        const src = stripComments(fs.readFileSync(file, 'utf8'));
        for (const name of IDENTITY_NAMES) {
            if (src.includes('BuildConfig.' + name)) {
                offenders.push(path.relative(REPO, file).replace(/\\/g, '/') + ' -> ' + name);
            }
        }
    }
    assert.deepStrictEqual(offenders, [],
        'These reads inline the constant into the reading class. When the value ' +
        'changes, incremental compilation does not recompile them and they keep the ' +
        'OLD literal — which is how a wrong SHA reached a device-test record.');
});

test('each build-identity value is written down exactly once in build.gradle.kts', () => {
    // Stripped, not raw: the declarations sit under a comment block that quotes
    // the very values it explains, and prose is not a second definition anyone
    // can bump out of sync. Stripping also stops a commented-out `val` counting
    // as a declaration.
    const src = stripComments(fs.readFileSync(GRADLE, 'utf8'));
    // The four single-source declarations, e.g. `val appVersionName = "2.2.0"`.
    const decls = [...src.matchAll(/^val\s+(appVersionName|appVersionCode|openclawVersion|nodejsVersion)\s*=\s*(.+)$/gm)];
    assert.strictEqual(decls.length, 4,
        'expected exactly 4 single-source declarations, found ' + decls.length +
        ' — if one was renamed or removed, this guard can no longer see it');

    const dupes = [];
    for (const [, name, rawValue] of decls) {
        const value = rawValue.trim();
        // Count literal occurrences of the VALUE. One is the declaration itself;
        // any second occurrence is a hand-typed copy that can silently diverge.
        const count = countLiteral(src, value);
        if (count !== 1) dupes.push(name + ' = ' + value + ' appears ' + count + 'x');
    }
    assert.deepStrictEqual(dupes, [],
        'A build-identity value appears more than once, so the copies can diverge. ' +
        'That is exactly what happened in part 1: the provenance generator was fed ' +
        'hand-typed literals duplicating defaultConfig, and a bump editing one and ' +
        'not the other stamped the OLD version into build-metadata.json. Reference ' +
        'the val instead of retyping the value.');
});
