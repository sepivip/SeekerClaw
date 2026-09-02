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
    const src = fs.readFileSync(GRADLE, 'utf8');
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
        const count = src.split(value).length - 1;
        if (count !== 1) dupes.push(name + ' = ' + value + ' appears ' + count + 'x');
    }
    assert.deepStrictEqual(dupes, [],
        'A build-identity value appears more than once, so the copies can diverge. ' +
        'That is exactly what happened in part 1: the provenance generator was fed ' +
        'hand-typed literals duplicating defaultConfig, and a bump editing one and ' +
        'not the other stamped the OLD version into build-metadata.json. Reference ' +
        'the val instead of retyping the value.');
});
