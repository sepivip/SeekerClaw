// workspace-path.js — BAT-1409 P1-E / P1-F / P1-G: the one path rule every agent-facing file
// route uses (file tools, js_eval's fs, shell_exec arguments).
//
// The rule (contract v3.2 P1-E): realpath the longest existing ancestor of the target, append the
// not-yet-existing tail lexically, and require the result to sit inside realpath(workDir). Both
// sides are realpath'd, so the /data/user/0 <-> /data/data alias works, and new files and
// directories are allowed. A link that already exists anywhere on the way is resolved, so it
// cannot lead outside the workspace.
//
// Writers additionally refuse any link on the path (`linkOnPath`), and the protected config names
// are anchored at the workspace root on both the lexical and the real path (`isProtectedRootName`).
//
// Pure: depends on fs + path only (no config.js), so the tests can drive it with any workDir.

'use strict';

const fs = require('fs');
const path = require('path');

/**
 * realpath of the longest existing ancestor of `abs`, with the missing tail appended lexically.
 * Throws for errors other than "does not exist" (EACCES, ELOOP, ...): the caller refuses.
 */
function realpathWithTail(abs) {
    let cur = abs;
    const tail = [];
    for (;;) {
        try {
            const real = fs.realpathSync(cur);
            return tail.length ? path.join(real, ...tail.reverse()) : real;
        } catch (e) {
            if (!e || (e.code !== 'ENOENT' && e.code !== 'ENOTDIR')) throw e;
            const parent = path.dirname(cur);
            if (parent === cur) throw e;
            tail.push(path.basename(cur));
            cur = parent;
        }
    }
}

function isInside(p, root) {
    return p === root || p.startsWith(root.endsWith(path.sep) ? root : root + path.sep);
}

/**
 * Resolves `userPath` against `workDir` once. Returns `{ abs, real, rootReal, rel }` when the real
 * target is inside the real workspace, else null. `abs` is the lexical absolute path (the one a
 * caller must hand to fs), `rel` the real path relative to the real workspace ('' for the root).
 * Non-string paths (Buffer excepted, converted as UTF-8) and paths containing NUL are refused.
 */
function resolveInWorkspace(workDir, userPath) {
    let p = userPath;
    if (Buffer.isBuffer(p)) p = p.toString('utf8');
    if (typeof p !== 'string' || p.includes('\0')) return null;
    let rootReal;
    let real;
    try {
        rootReal = fs.realpathSync(workDir);
        real = realpathWithTail(path.resolve(workDir, p));
    } catch (_) {
        return null;
    }
    if (!isInside(real, rootReal)) return null;
    // An absolute path through the other alias of the workspace (/data/data/... while workDir is
    // /data/user/0/...) is rebased lexically onto workDir, so writers check the same components
    // and the root-name checks see the usual path.
    const lexRoot = path.resolve(workDir);
    let abs = path.resolve(workDir, p);
    if (!isInside(abs, lexRoot) && isInside(abs, rootReal)) abs = path.join(lexRoot, path.relative(rootReal, abs));
    return { abs, real, rootReal, rel: path.relative(rootReal, real) };
}

/**
 * For writers: the first component from the workspace root down to `abs` (inclusive) that is a
 * symlink, as a workspace-relative string, or null. Components that do not exist yet end the walk.
 * `abs` must be inside the lexical workDir (resolveInWorkspace's `abs` is, unless `..` segments
 * climb out and back, which this also refuses by returning the offending component).
 */
function linkOnPath(workDir, abs) {
    const root = path.resolve(workDir);
    const rel = path.relative(root, abs);
    if (rel === '') return null;
    // Outside the lexical root (never a real name like `..notes`): fail closed.
    if (rel === '..' || rel.startsWith('..' + path.sep) || path.isAbsolute(rel)) return rel;
    let cur = root;
    for (const part of rel.split(path.sep)) {
        cur = path.join(cur, part);
        let st;
        try {
            st = fs.lstatSync(cur);
        } catch (e) {
            if (e && (e.code === 'ENOENT' || e.code === 'ENOTDIR')) return null;
            return path.relative(root, cur); // cannot check: treat as unsafe
        }
        if (st.isSymbolicLink()) return path.relative(root, cur);
    }
    return null;
}

/**
 * Root-anchored name check on both layers: true when the lexical target is `workDir/<name>` or its
 * real path is `realpath(workDir)/<name>` for a name in `names`. A file with the same name in a
 * subdirectory (calclaw's `nutrition/config.json`) is not affected.
 */
function isProtectedRootName(workDir, resolved, names) {
    if (!resolved) return false;
    const root = path.resolve(workDir);
    const lexRel = path.relative(root, resolved.abs);
    if (!lexRel.includes(path.sep) && names.has(lexRel)) return true;
    return !resolved.rel.includes(path.sep) && names.has(resolved.rel);
}

module.exports = { resolveInWorkspace, linkOnPath, isProtectedRootName, realpathWithTail, isInside };
