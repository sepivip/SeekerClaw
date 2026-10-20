// tools/shell-validate.js — BAT-1409 P1-G: validates a tokenized shell_exec argv against the
// grammar (shell-grammar.js) and the workspace path rule, and returns the argv to run.
//
// Every read path, write path and metadata path is resolved against the effective cwd and must
// satisfy the P1-E rule (real path inside realpath(workDir)). Exceptions are exact strings: the
// read-only /proc list (shared with P1-F) and /dev/null, /dev/stdout, /dev/stderr as write
// targets. Content-reading paths refuse the names the read tool refuses; write paths refuse the
// protected root names and any link on the path. cp/mv compute their effective targets as toybox
// does and pre-walk recursive sources (bounded). curl values are parsed with curl's own file
// syntax per option; only http/https URLs are accepted, and loopback URLs on the app's bridge
// ports are refused (P1-L).
//
// Guardrail-level (invariant 6); TOCTOU between this check and exec is residual risk S6′.

'use strict';

const fs = require('fs');
const path = require('path');
const dns = require('dns');
const net = require('net');
const { resolveInWorkspace, linkOnPath, isProtectedRootName } = require('../workspace-path');
const { GRAMMAR, parseOptions, GrammarError, has } = require('./shell-grammar');

const PROC_READ_ALLOW = new Set(['/proc/meminfo', '/proc/cpuinfo', '/proc/loadavg', '/proc/uptime', '/proc/version']);
const DEV_WRITE_ALLOW = new Set(['/dev/null', '/dev/stdout', '/dev/stderr']);
const BRIDGE_PORTS = new Set([8765, 8766]);
const PREWALK_MAX_ENTRIES = 2000;
const PREWALK_MAX_DEPTH = 16;
// Names a recursive grep never reads (over-exclusion is harmless).
const GREP_EXCLUDES = ['config.json', 'config.yaml', 'config.js', 'seekerclaw.db*', 'agent_settings.json', 'bridge_token', 'xai_oauth.json'];

/**
 * ctx: { workDir, cwd (absolute effective cwd), names: { ROOT_SECRET_NAMES, SECRETS_ANYWHERE,
 * WRITE_PROTECTED_ROOT }, agentSettingsFile, lookup?(host) -> Promise<string[]> }.
 */
function makeChecker(ctx) {
    const { workDir, cwd, names, agentSettingsFile } = ctx;

    function resolve(value) {
        if (typeof value !== 'string' || value.includes('\0')) throw new GrammarError('Invalid path.');
        return resolveInWorkspace(workDir, path.resolve(cwd, value));
    }

    function contentBlocked(r) {
        const bn = [path.basename(r.abs), path.basename(r.real)];
        const hit = bn.find((b) => names.SECRETS_ANYWHERE.has(b) || b === agentSettingsFile);
        if (hit) return hit;
        if (isProtectedRootName(workDir, r, names.ROOT_SECRET_NAMES)) return path.basename(r.abs);
        return null;
    }

    function read(value, what) {
        if (value === '-') return;
        if (PROC_READ_ALLOW.has(value)) return;
        const r = resolve(value);
        if (!r) throw new GrammarError(`${what}: ${value} is outside the workspace.`);
        const blocked = contentBlocked(r);
        if (blocked) throw new GrammarError(`${what}: reading ${blocked} is blocked for security (use the read tool).`);
    }

    function meta(value, what) {
        if (value === '-') return;
        const r = resolve(value);
        if (!r) throw new GrammarError(`${what}: ${value} is outside the workspace.`);
    }

    // [allowRoot]: the workspace folder itself is acceptable (a cp/mv destination directory).
    function write(value, what, allowRoot = false) {
        if (DEV_WRITE_ALLOW.has(value)) return null;
        const r = resolve(value);
        if (!r) throw new GrammarError(`${what}: ${value} is outside the workspace.`);
        if (r.rel === '' && !allowRoot) throw new GrammarError(`${what}: the workspace itself cannot be a write target.`);
        const bn = [path.basename(r.abs), path.basename(r.real)];
        const secret = bn.find((b) => names.SECRETS_ANYWHERE.has(b));
        if (secret) throw new GrammarError(`${what}: writing ${secret} is blocked.`);
        if (isProtectedRootName(workDir, r, names.WRITE_PROTECTED_ROOT)) {
            throw new GrammarError(`${what}: writing ${path.basename(r.abs)} is blocked: it is managed by the app.`);
        }
        const link = linkOnPath(workDir, r.abs);
        if (link) throw new GrammarError(`${what}: ${link} is a link; writes never go through links.`);
        return r;
    }

    function byRole(role, value, what) {
        if (role === 'read') return read(value, what);
        if (role === 'meta') return meta(value, what);
        if (role === 'write') return write(value, what);
        return undefined;
    }

    return { resolve, read, meta, write, byRole, contentBlocked, cwd };
}

// ------------------------------------------------------------------------------------- cp / mv

function lstatOrNull(p) {
    try { return fs.lstatSync(p); } catch (_) { return null; }
}

function stripTrailingSlashes(s) {
    let t = s;
    while (t.length > 1 && t.endsWith('/')) t = t.slice(0, -1);
    return t;
}

/** basename as toybox cp computes it: a source ending in `/.` is `.` (its contents). */
function cpBasename(src) {
    if (src === '.' || src.endsWith('/.')) return '.';
    return path.basename(stripTrailingSlashes(src));
}

/**
 * Bounded walk of [rootAbs]: calls visit(relPath, lstat) for every entry below it (not the root).
 * Throws when the bounds are exceeded.
 */
function prewalk(rootAbs, visit) {
    let count = 0;
    const stack = [[rootAbs, '', 0]];
    while (stack.length) {
        const [dir, rel, depth] = stack.pop();
        let entries;
        try { entries = fs.readdirSync(dir); } catch (_) { continue; }
        for (const name of entries) {
            if (++count > PREWALK_MAX_ENTRIES) throw new GrammarError('too many files to verify — copy a smaller folder');
            const abs = path.join(dir, name);
            const r = rel ? rel + '/' + name : name;
            const st = lstatOrNull(abs);
            visit(r, st);
            if (st && st.isDirectory() && !st.isSymbolicLink()) {
                if (depth + 1 > PREWALK_MAX_DEPTH) throw new GrammarError('too many files to verify — copy a smaller folder');
                stack.push([abs, r, depth + 1]);
            }
        }
    }
}

function checkCpMv(cmd, parsed, chk, ctx) {
    const { flags } = parsed;
    let operands = parsed.operands.slice();
    const isCp = cmd === 'cp';
    const recursive = isCp && has(flags, 'r', 'R', 'recursive');
    if (recursive && !has(flags, 'L', 'dereference')) {
        throw new GrammarError('cp -r is refused because it copies links as links; use cp -rL <src> <dst>');
    }
    if (flags.some((f) => f.name === 'preserve' && /links|all/.test(String(f.value)))) {
        throw new GrammarError(`${cmd}: --preserve=links copies links as links; refused.`);
    }
    // One destination selector. toybox keeps the LAST value of a string option, so with several
    // -t / --target-directory the checked destination need not be the one written (Codex R1 on
    // #459: `cp -t safe -t . staged/owner_ids`). -t with -T is contradictory: refused too.
    const tFlags = flags.filter((f) => f.name === 't' || f.name === 'target-directory');
    if (tFlags.length > 1) throw new GrammarError(`${cmd}: give one destination (-t or --target-directory once).`);
    const tFlag = tFlags[0];
    const noTargetDir = has(flags, 'T', 'no-target-directory');
    if (tFlag && noTargetDir) throw new GrammarError(`${cmd}: -t and -T cannot be combined.`);
    let dst;
    let sources;
    if (tFlag) {
        dst = tFlag.value;
        sources = operands;
    } else {
        if (operands.length < 2) throw new GrammarError(`${cmd}: needs a source and a destination.`);
        dst = operands[operands.length - 1];
        sources = operands.slice(0, -1);
    }
    if (sources.length === 0) throw new GrammarError(`${cmd}: missing source.`);
    chk.write(dst, `${cmd} destination`, true);
    const dstAbs = path.resolve(ctx.cwd, dst);
    const dstSt = lstatOrNull(dstAbs);
    const dstIsDir = dstSt && dstSt.isDirectory() && !dstSt.isSymbolicLink();
    let mode;
    if (noTargetDir) {
        if (sources.length > 1) throw new GrammarError(`${cmd}: -T takes one source.`);
        mode = 'self';
    } else if (tFlag || sources.length > 1) {
        if (!tFlag && !dstIsDir) throw new GrammarError(`${cmd}: with several sources the destination must be an existing directory.`);
        mode = 'into';
    } else {
        mode = dstIsDir ? 'into' : 'self';
    }
    for (const src of sources) {
        const what = `${cmd} source`;
        const srcAbs = path.resolve(ctx.cwd, src);
        const srcSt = lstatOrNull(srcAbs);
        if (srcSt && srcSt.isSymbolicLink()) throw new GrammarError(`${what}: ${src} is a link; refused.`);
        if (isCp) chk.read(src, what); else {
            const r = chk.write(src, what); // mv removes its sources
            if (r && r.rel === '') throw new GrammarError(`${what}: the workspace itself cannot be moved.`);
        }
        const base = cpBasename(src);
        const finalTarget = mode === 'self' ? dst : (base === '.' ? dst : path.join(dst, base));
        // `cp -rL src/. .` copies the contents into the root: each entry is checked below.
        chk.write(finalTarget, `${cmd} target`, base === '.' && mode === 'into');
        const finalAbs = path.resolve(ctx.cwd, finalTarget);
        const srcIsDir = srcSt && srcSt.isDirectory();
        if (srcIsDir && (recursive || !isCp)) {
            prewalk(srcAbs, (rel, st) => {
                const entrySrc = path.join(src, rel);
                if (st && st.isSymbolicLink() && !isCp) throw new GrammarError(`${cmd}: ${entrySrc} is a link inside the folder; refused.`);
                if (isCp) {
                    if (!(st && st.isDirectory())) chk.read(entrySrc, `${cmd} source entry`);
                }
                const t = path.join(finalTarget, rel);
                chk.write(t, `${cmd} target`);
                const tSt = lstatOrNull(path.resolve(ctx.cwd, t));
                if (tSt && tSt.isSymbolicLink()) throw new GrammarError(`${cmd} target: ${t} is a link; refused.`);
            });
            // Links already in the existing destination subtree.
            const fSt = lstatOrNull(finalAbs);
            if (fSt && fSt.isDirectory() && !fSt.isSymbolicLink()) {
                prewalk(finalAbs, (rel, st) => {
                    if (st && st.isSymbolicLink()) throw new GrammarError(`${cmd} target: ${path.join(finalTarget, rel)} is a link; refused.`);
                });
            }
        }
    }
    return null;
}

// ------------------------------------------------------------------------------------- grep

function checkGrep(parsed, chk) {
    const { flags } = parsed;
    const operands = parsed.operands.slice();
    const patternGiven = has(flags, 'e', 'regexp', 'f', 'file');
    if (!patternGiven) {
        if (operands.length === 0) throw new GrammarError('grep: missing pattern.');
        operands.shift();
    }
    for (const f of flags) if (f.role === 'read') chk.read(f.value, `grep -${f.name}`);
    const recursive = has(flags, 'r', 'recursive');
    const files = operands.length ? operands : (recursive ? ['.'] : []);
    for (const f of files) {
        // Under -r a directory is walked (the excludes below skip protected names); a file named
        // directly is read like any other.
        const st = recursive ? lstatOrNull(path.resolve(chk.cwd, f)) : null;
        if (recursive && st && st.isDirectory()) chk.meta(f, 'grep -r'); else chk.read(f, 'grep');
    }
    if (recursive) {
        // Appended right after the command name: every protected content name is skipped.
        return { prepend: GREP_EXCLUDES.map((n) => '--exclude=' + n) };
    }
    return null;
}

// ------------------------------------------------------------------------------------- find

const FIND_VALUE = new Set(['-name', '-iname', '-path', '-ipath', '-wholename', '-iwholename', '-regex', '-iregex', '-type', '-size',
    '-mtime', '-mmin', '-atime', '-amin', '-ctime', '-cmin', '-maxdepth', '-mindepth', '-perm', '-user', '-group', '-uid', '-gid',
    '-links', '-inum', '-printf', '-context']);
const FIND_PATH_VALUE = new Set(['-newer', '-anewer', '-cnewer', '-samefile']);
const FIND_PLAIN = new Set(['-print', '-print0', '-prune', '-depth', '-xdev', '-mount', '-empty', '-o', '-or', '-a', '-and', '-not',
    '!', '(', ')', '-true', '-false', '-ls', '-quit', '-nouser', '-nogroup', '-readable', '-writable', '-executable', '-P']);
const FIND_REFUSED = {
    '-delete': 'find -delete removes files (use the delete tool)', '-exec': 'find -exec runs a program', '-execdir': 'find -execdir runs a program',
    '-ok': 'find -ok runs a program', '-okdir': 'find -okdir runs a program', '-fprint': 'find -fprint writes a file',
    '-fprint0': 'find -fprint0 writes a file', '-fprintf': 'find -fprintf writes a file', '-fls': 'find -fls writes a file',
    '-L': 'find -L follows links', '-follow': 'find -follow follows links', '-H': 'find -H follows links',
};

function checkFind(args, chk) {
    let i = 0;
    const starts = [];
    while (i < args.length && !args[i].startsWith('-') && args[i] !== '!' && args[i] !== '(') starts.push(args[i++]);
    for (const s of starts) chk.meta(s, 'find');
    while (i < args.length) {
        const a = args[i];
        if (Object.prototype.hasOwnProperty.call(FIND_REFUSED, a)) throw new GrammarError(`${FIND_REFUSED[a]}; refused.`);
        if (FIND_VALUE.has(a) || FIND_PATH_VALUE.has(a)) {
            if (i + 1 >= args.length) throw new GrammarError(`find: ${a} needs a value.`);
            if (FIND_PATH_VALUE.has(a)) chk.meta(args[i + 1], `find ${a}`);
            i += 2;
            continue;
        }
        if (FIND_PLAIN.has(a)) { i++; continue; }
        throw new GrammarError(`find: ${a} is not allowed.`);
    }
    return null;
}

// ------------------------------------------------------------------------------------- sed

/** Reads a delimited field starting at [i] (just after the delimiter); returns the index after the closing delimiter. */
function sedField(script, i, delim) {
    while (i < script.length) {
        const c = script[i];
        if (c === '\\') { i += 2; continue; }
        if (c === delim) return i + 1;
        i++;
    }
    throw new GrammarError('sed: unterminated expression.');
}

function sedAddress(script, i) {
    const c = script[i];
    if (c === undefined) return i;
    if (c === '$') return i + 1;
    if (/[0-9]/.test(c)) {
        while (/[0-9]/.test(script[i] || '')) i++;
        if (script[i] === '~') { i++; while (/[0-9]/.test(script[i] || '')) i++; } // first~step
        return i;
    }
    if (c === '/') { i = sedField(script, i + 1, '/'); while (/[IM]/.test(script[i] || '')) i++; return i; }
    if (c === '\\' && script[i + 1]) { const d = script[i + 1]; i = sedField(script, i + 2, d); while (/[IM]/.test(script[i] || '')) i++; return i; }
    return i;
}

/** Validates one sed script against the safe subset (one command, no w/e/r/R/W/F/v/b/t/T/:). */
function checkSedScript(script) {
    // One command per expression: a newline would start a second, unchecked one (shell_exec also
    // refuses newlines in the whole command line before tokenizing).
    if (/[\r\n\u2028\u2029]/.test(script)) throw new GrammarError('sed: one command per -e expression (no newlines).');
    let i = 0;
    const skipWs = () => { while (script[i] === ' ' || script[i] === '\t') i++; };
    skipWs();
    const a1 = sedAddress(script, i);
    if (a1 !== i) {
        i = a1;
        if (script[i] === ',') {
            i++;
            if (script[i] === '+' || script[i] === '~') { i++; while (/[0-9]/.test(script[i] || '')) i++; } else i = sedAddress(script, i);
        }
    }
    skipWs();
    if (script[i] === '!') { i++; skipWs(); }
    const cmd = script[i];
    if (cmd === undefined) throw new GrammarError('sed: empty script.');
    i++;
    if ('pPdDnNgGhHx='.includes(cmd)) {
        skipWs();
        if (i !== script.length) throw new GrammarError('sed: one command per -e expression.');
        return;
    }
    if (cmd === 'q' || cmd === 'Q' || cmd === 'l') {
        skipWs();
        while (/[0-9]/.test(script[i] || '')) i++;
        skipWs();
        if (i !== script.length) throw new GrammarError('sed: one command per -e expression.');
        return;
    }
    if (cmd === 'a' || cmd === 'i' || cmd === 'c') return; // text to the end of the expression
    if (cmd === 's' || cmd === 'y') {
        const delim = script[i];
        if (!delim || delim === '\\' || delim === ' ') throw new GrammarError('sed: bad delimiter.');
        i = sedField(script, i + 1, delim);
        i = sedField(script, i, delim);
        const fl = script.slice(i);
        if (cmd === 's' && !/^[gpiImM0-9]*\s*$/.test(fl)) throw new GrammarError('sed: s flags other than g, p, i, I, m, M and a number are refused (w and e write files or run commands).');
        if (cmd === 'y' && fl.trim() !== '') throw new GrammarError('sed: one command per -e expression.');
        return;
    }
    throw new GrammarError(`sed: the command "${cmd}" is not allowed (allowed: s y p P d D q Q = l n N g G h H x a i c).`);
}

const SED_SUFFIX = /^\.[A-Za-z0-9._~-]+$/;

function checkSed(args, chk) {
    const scripts = [];
    const operands = [];
    let inPlace = false;
    let ended = false;
    for (let i = 0; i < args.length; i++) {
        const a = args[i];
        if (ended || a === '-' || !a.startsWith('-')) { operands.push(a); continue; }
        if (a === '--') { ended = true; continue; }
        if (a.startsWith('--')) {
            const [name, val] = a.slice(2).split(/=(.*)/s);
            if (name === 'quiet' || name === 'silent' || name === 'regexp-extended' || name === 'separate' || name === 'null-data' || name === 'posix' || name === 'debug') continue;
            if (name === 'in-place') {
                if (val !== undefined && !SED_SUFFIX.test(val)) throw new GrammarError('sed --in-place=SUFFIX: the suffix must look like .bak.');
                inPlace = true;
                continue;
            }
            if (name === 'expression') {
                const v = val !== undefined ? val : args[++i];
                if (v === undefined) throw new GrammarError('sed: --expression needs a value.');
                scripts.push(v);
                continue;
            }
            if (name === 'file') throw new GrammarError('sed --file reads a script file; refused.');
            throw new GrammarError(`sed: the option --${name} is not allowed.`);
        }
        for (let j = 1; j < a.length; j++) {
            const ch = a[j];
            if ('nErsuz'.includes(ch)) continue;
            if (ch === 'i') {
                // -i[SUFFIX]: the rest of the word is the backup suffix, which must look like .bak.
                const suffix = a.slice(j + 1);
                if (suffix !== '' && !SED_SUFFIX.test(suffix)) throw new GrammarError('sed -i: write the backup suffix as -i.bak (put other flags before -i).');
                inPlace = true;
                break;
            }
            if (ch === 'e') {
                const rest = a.slice(j + 1);
                const v = rest !== '' ? rest : args[++i];
                if (v === undefined) throw new GrammarError('sed: -e needs a value.');
                scripts.push(v);
                break;
            }
            if (ch === 'f') throw new GrammarError('sed -f reads a script file; refused.');
            throw new GrammarError(`sed: the flag -${ch} is not allowed.`);
        }
    }
    if (scripts.length === 0) {
        if (operands.length === 0) throw new GrammarError('sed: missing script.');
        scripts.push(operands.shift());
    }
    for (const s of scripts) checkSedScript(s);
    for (const f of operands) {
        chk.read(f, 'sed');
        if (inPlace) chk.write(f, 'sed -i');
    }
    if (inPlace && operands.length === 0) throw new GrammarError('sed -i needs a file.');
    return null;
}

// ------------------------------------------------------------------------------------- curl

const CURL_FLAGS = new Set(['s', 'S', 'L', 'I', 'i', 'k', 'f', 'v', 'G', 'N', '4', '6', 'g', 'j', '#', 'q', 'Z', 'l', 'n'].filter((c) => !['Z', 'l', 'n'].includes(c)));
const CURL_LONG_FLAGS = new Set(['silent', 'show-error', 'location', 'head', 'include', 'insecure', 'fail', 'fail-with-body', 'verbose', 'get',
    'compressed', 'no-buffer', 'http1.0', 'http1.1', 'http2', 'ipv4', 'ipv6', 'globoff', 'junk-session-cookies', 'progress-bar', 'no-progress-meter',
    'location-trusted', 'raw', 'tr-encoding', 'path-as-is', 'create-dirs', 'show-headers', 'disable', 'no-keepalive', 'ssl-no-revoke', 'fail-early',
    'remove-on-error', 'no-sessionid', 'tcp-nodelay', 'tcp-fastopen']);
// value options: role 'plain' | 'url' | 'write' | 'data' (@file) | 'header' (@file) | 'writeout' | 'urlencode' | 'form' | 'upload' | 'cookie' | 'read'
const CURL_SHORT_VALUES = {
    X: 'plain', A: 'plain', e: 'plain', m: 'plain', u: 'plain', r: 'plain', y: 'plain', Y: 'plain', C: 'plain', z: 'meta',
    d: 'data', H: 'header', w: 'writeout', F: 'form', T: 'upload', b: 'cookie', o: 'write', c: 'write', D: 'write',
};
const CURL_LONG_VALUES = {
    request: 'plain', 'user-agent': 'plain', referer: 'plain', 'max-time': 'plain', 'connect-timeout': 'plain', retry: 'plain',
    'retry-delay': 'plain', 'retry-max-time': 'plain', 'max-redirs': 'plain', user: 'plain', 'limit-rate': 'plain', range: 'plain',
    'speed-time': 'plain', 'speed-limit': 'plain', 'continue-at': 'plain', 'max-filesize': 'plain', 'oauth2-bearer': 'plain',
    'data-raw': 'plain', 'form-string': 'plain', 'request-target': 'plain', 'expect100-timeout': 'plain', 'keepalive-time': 'plain',
    'time-cond': 'meta', 'aws-sigv4': 'plain', 'retry-all-errors': null,
    url: 'url', data: 'data', 'data-ascii': 'data', 'data-binary': 'data', json: 'data', header: 'header', 'write-out': 'writeout',
    'data-urlencode': 'urlencode', 'url-query': 'urlencode', form: 'form', 'upload-file': 'upload', cookie: 'cookie',
    output: 'write', 'cookie-jar': 'write', 'dump-header': 'write', trace: 'write', 'trace-ascii': 'write',
    stderr: 'write', libcurl: 'write', 'etag-save': 'write', 'etag-compare': 'read', hsts: 'write', 'alt-svc': 'write',
};
const CURL_REFUSED = {
    K: 'curl -K reads a config file', config: 'curl --config reads a config file', O: 'curl -O writes a name the URL chooses',
    'remote-name': 'curl --remote-name writes a name the URL chooses', 'remote-name-all': 'curl --remote-name-all writes names the URLs choose',
    J: 'curl -J writes a name the server chooses', 'remote-header-name': 'curl --remote-header-name writes a name the server chooses',
    x: 'curl -x (proxy) is not available', proxy: 'curl --proxy is not available', resolve: 'curl --resolve is not available',
    'connect-to': 'curl --connect-to is not available', 'unix-socket': 'curl --unix-socket is not available',
    'output-dir': 'curl --output-dir is not available (name the output file with -o)', proto: 'curl --proto is set by the app',
    'dns-servers': 'curl --dns-servers is not available',
    'proto-redir': 'curl --proto-redir is set by the app',
    'abstract-unix-socket': 'curl --abstract-unix-socket is not available', next: 'curl --next is not available', ':': 'curl --next is not available',
};

function curlValue(role, v, chk, what, urls) {
    switch (role) {
        case 'plain': return;
        case 'url': urls.push(v); return;
        case 'write':
            if (/[{}[\]#]/.test(v)) throw new GrammarError(`${what}: braces, brackets and # (curl globbing) are not allowed in file names.`);
            chk.write(v, what);
            return;
        case 'read': chk.read(v, what); return;
        case 'data':
        case 'header':
            if (v.startsWith('@')) chk.read(v.slice(1), what);
            return;
        case 'writeout':
            if (v.startsWith('@')) chk.read(v.slice(1), what);
            if (/%output\{|%\{stderr\}|%\{stdout\}/.test(v)) throw new GrammarError(`${what}: %output{} and stream switching are not available.`);
            return;
        case 'urlencode': {
            const at = v.indexOf('@');
            const eq = v.indexOf('=');
            if (at >= 0 && (eq < 0 || at < eq)) chk.read(v.slice(at + 1), what);
            return;
        }
        case 'form': {
            const eq = v.indexOf('=');
            if (eq < 0) throw new GrammarError(`${what}: expected name=content.`);
            const content = v.slice(eq + 1);
            // curl reads files named in ;modifiers too (;headers=@file, ;headers=<file): refused.
            if (/;\s*[A-Za-z_-]+\s*=\s*[@<]/.test(content)) {
                throw new GrammarError(`${what}: a ;modifier that reads a file (e.g. headers=@file) is not allowed.`);
            }
            if (content.startsWith('@') || content.startsWith('<')) {
                // curl reads a quoted file name ("a;b") and a comma list: neither form is accepted.
                if (/["\\]/.test(content)) throw new GrammarError(`${what}: quotes and backslashes in a file part are not allowed.`);
                const file = content.slice(1).split(';')[0];
                if (file.includes(',')) throw new GrammarError(`${what}: a comma in a file part names several files; refused.`);
                chk.read(file, what);
            }
            return;
        }
        case 'upload':
            if (/[{}[\]]/.test(v)) throw new GrammarError(`${what}: braces and brackets (curl globbing) are not allowed in file names.`);
            if (v !== '-' && v !== '.') chk.read(v, what);
            return;
        case 'cookie':
            if (!v.includes('=')) chk.read(v, what);
            return;
        case 'meta': {
            // -z / --time-cond: curl skips one leading +, - or = (If-Modified-Since,
            // If-Unmodified-Since, Last-Modified), and when the rest is not a date it stat()s it as
            // a file name (sending its mtime), so the name obeys the metadata rule.
            const name = v.replace(/^[+=-]/, '');
            if (name) chk.meta(name, what);
            return;
        }
        default:
            throw new GrammarError(`${what}: not allowed.`);
    }
}

function parseCurl(args, chk) {
    const urls = [];
    let ended = false;
    for (let i = 0; i < args.length; i++) {
        const a = args[i];
        if (ended || !a.startsWith('-') || a === '-') { urls.push(a); continue; }
        if (a === '--') { ended = true; continue; }
        if (a.startsWith('--')) {
            const eq = a.indexOf('=');
            // curl does not accept --opt=value; the next word is the value.
            const name = a.slice(2);
            if (eq >= 0) throw new GrammarError(`curl: write --${a.slice(2, eq)} VALUE (curl does not take --option=value).`);
            if (Object.prototype.hasOwnProperty.call(CURL_REFUSED, name)) throw new GrammarError(`${CURL_REFUSED[name]}; refused.`);
            if (CURL_LONG_FLAGS.has(name) || (CURL_LONG_VALUES[name] === null)) continue;
            if (Object.prototype.hasOwnProperty.call(CURL_LONG_VALUES, name)) {
                if (i + 1 >= args.length) throw new GrammarError(`curl: --${name} needs a value.`);
                curlValue(CURL_LONG_VALUES[name], args[++i], chk, `curl --${name}`, urls);
                continue;
            }
            throw new GrammarError(`curl: the option --${name} is not allowed.`);
        }
        for (let j = 1; j < a.length; j++) {
            const ch = a[j];
            if (Object.prototype.hasOwnProperty.call(CURL_REFUSED, ch)) throw new GrammarError(`${CURL_REFUSED[ch]}; refused.`);
            if (CURL_FLAGS.has(ch)) continue;
            if (Object.prototype.hasOwnProperty.call(CURL_SHORT_VALUES, ch)) {
                let v = a.slice(j + 1);
                if (v === '') {
                    if (i + 1 >= args.length) throw new GrammarError(`curl: -${ch} needs a value.`);
                    v = args[++i];
                }
                curlValue(CURL_SHORT_VALUES[ch], v, chk, `curl -${ch}`, urls);
                break;
            }
            throw new GrammarError(`curl: the flag -${ch} is not allowed.`);
        }
    }
    if (urls.length === 0) throw new GrammarError('curl: missing URL.');
    return urls;
}

function isLoopbackHost(host) {
    let h = String(host).toLowerCase();
    if (h.startsWith('[') && h.endsWith(']')) h = h.slice(1, -1);
    if (h === 'localhost' || h.endsWith('.localhost')) return true;
    const v = net.isIP(h);
    if (v === 4) { const first = Number(h.split('.')[0]); return first === 127 || first === 0; }
    if (v === 6) {
        let canon;
        try { canon = new URL('http://[' + h + ']/').hostname.slice(1, -1); } catch (_) { return true; }
        if (canon === '::1' || canon === '::') return true;
        const m = canon.match(/^::(?:ffff:)?([0-9a-f]{1,4}):([0-9a-f]{1,4})$/);
        if (m) { const first = parseInt(m[1], 16) >> 8; return first === 127 || first === 0; }
    }
    return false;
}

/**
 * The host and port curl itself connects to for [u]: the authority after `scheme://` (or the
 * start of a schemeless URL), userinfo dropped at the LAST `@`, as curl's parser does.
 */
function curlAuthority(u) {
    const m = u.match(/^[a-z][a-z0-9+.-]*:\/\//i);
    const rest = m ? u.slice(m[0].length) : u;
    let auth = rest.split(/[/?#]/)[0];
    const at = auth.lastIndexOf('@');
    if (at >= 0) auth = auth.slice(at + 1);
    let host = auth;
    let port = '';
    const v6 = auth.match(/^\[([^\]]*)\](?::(\d*))?$/);
    if (v6) { host = v6[1]; port = v6[2] || ''; } else {
        const c = auth.lastIndexOf(':');
        if (c >= 0) { host = auth.slice(0, c); port = auth.slice(c + 1); }
    }
    return { host: host.toLowerCase(), port };
}

/**
 * Checks [urls]; returns `--resolve host:port:addr` pins for every host name on a bridge port, so
 * curl connects to the address checked here instead of resolving the name again (DNS rebinding).
 */
async function checkCurlUrls(urls, lookup) {
    const pins = [];
    for (const u of urls) {
        if (/[\\\s]/.test(u)) throw new GrammarError('curl: backslashes and spaces are not allowed in URLs.');
        const hasScheme = /^[a-z][a-z0-9+.-]*:\/\//i.test(u);
        // `file:/x`, `mailto:` and the like: a scheme without `//` (host:port is the only colon form).
        if (!hasScheme && /^[a-z][a-z0-9+.-]*:(?!\d+(?:[/?#]|$))/i.test(u)) {
            throw new GrammarError('curl: only http and https URLs are allowed.');
        }
        const withScheme = hasScheme ? u : 'http://' + u;
        let parsed;
        try { parsed = new URL(withScheme); } catch (_) { throw new GrammarError(`curl: ${u.slice(0, 80)} is not a valid URL.`); }
        const scheme = parsed.protocol.replace(/:$/, '').toLowerCase();
        if (scheme !== 'http' && scheme !== 'https') throw new GrammarError(`curl: only http and https URLs are allowed (got ${scheme}:).`);
        // Use the host and port as curl reads them; refuse a URL two parsers read differently.
        const auth = curlAuthority(u);
        const urlHost = parsed.hostname.startsWith('[') ? parsed.hostname.slice(1, -1) : parsed.hostname;
        const norm = (h) => h.toLowerCase().replace(/\.$/, '');
        if (norm(auth.host) !== norm(urlHost)) {
            throw new GrammarError(`curl: ${u.slice(0, 80)} is ambiguous; write it as scheme://host:port/path.`);
        }
        const port = auth.port ? Number(auth.port) : (scheme === 'https' ? 443 : 80);
        if (!BRIDGE_PORTS.has(port)) continue;
        // BAT-1409 P1-L: the app's bridge ports are refused on loopback, checked on the resolved address.
        let host = parsed.hostname;
        if (isLoopbackHost(host)) throw new GrammarError(`curl: port ${port} on this device is one of the app's internal ports; refused.`);
        if (host.startsWith('[')) host = host.slice(1, -1);
        if (!net.isIP(host)) {
            let addrs = [];
            try { addrs = await lookup(host); } catch (_) { addrs = []; }
            if (addrs.some(isLoopbackHost)) throw new GrammarError(`curl: ${host} resolves to this device, and port ${port} is one of the app's internal ports; refused.`);
            if (addrs.length === 0) throw new GrammarError(`curl: ${host} could not be resolved.`);
            const a = addrs[0];
            pins.push('--resolve', `${host}:${port}:${net.isIP(a) === 6 ? '[' + a + ']' : a}`);
        }
    }
    return pins;
}

function defaultLookup(host) {
    return new Promise((resolve, reject) => {
        dns.lookup(host, { all: true }, (err, addrs) => (err ? reject(err) : resolve(addrs.map((a) => a.address))));
    });
}

// ------------------------------------------------------------------------------------- diff

function checkDiff(parsed, chk, ctx) {
    const recursive = has(parsed.flags, 'r', 'recursive');
    for (const f of parsed.flags) if (f.role === 'read') chk.read(f.value, `diff -${f.name}`);
    for (const op of parsed.operands) {
        chk.read(op, 'diff');
        const opSt = lstatOrNull(path.resolve(ctx.cwd, op));
        // diff compares same-named files inside directories even without -r: a directory operand
        // goes through the -r rules (no workspace root, no protected file inside).
        if (!recursive && !(opSt && opSt.isDirectory())) continue;
        const r = chk.resolve(op);
        if (r && r.rel === '') throw new GrammarError('diff: compare subfolders (the workspace root holds protected settings files).');
        const abs = path.resolve(ctx.cwd, op);
        const st = lstatOrNull(abs);
        if (st && st.isDirectory()) {
            prewalk(abs, (rel) => {
                const entry = path.join(op, rel);
                const er = chk.resolve(entry);
                if (er && chk.contentBlocked(er)) throw new GrammarError(`diff: ${entry} is a protected file; compare a folder without it.`);
            });
        }
    }
    return null;
}

// ------------------------------------------------------------------------------------- entry

/**
 * Validates [argv] (argv[0] is the command). Returns `{ argv }`, the argv to run, which may carry
 * additions (grep -r excludes, curl -q). Throws GrammarError with a message for the model.
 */
async function validateArgv(argv, ctx) {
    const cmd = argv[0];
    const args = argv.slice(1);
    const g = GRAMMAR[cmd];
    if (!g) throw new GrammarError(`Command "${cmd}" has no grammar entry.`);
    const chk = makeChecker(ctx);
    if (cmd === 'find') { checkFind(args, chk); return { argv }; }
    if (cmd === 'sed') { checkSed(args, chk); return { argv }; }
    if (cmd === 'curl') {
        const urls = parseCurl(args, chk);
        const pins = await checkCurlUrls(urls, ctx.lookup || defaultLookup);
        // -q: no .curlrc. -g: no URL globbing ({a,b} and [1-9] are literal). --proto: only http(s),
        // also after redirects. --resolve pins a bridge-port host name to the address checked
        // above. They come first, so nothing the caller passes can precede them. Residual: a
        // redirect (-L) to the device's bridge port is not seen here (curl has no loopback block);
        // both bridge ports refuse any request without the per-boot token, which the agent cannot
        // read (P1-E/F/G).
        return { argv: ['curl', '-q', '-g', '--proto', '=http,https', '--proto-redir', '=http,https', ...pins, ...args] };
    }
    const parsed = parseOptions(cmd, args, g);
    for (const f of parsed.flags) {
        // cp/mv's -t DIR is the destination: checkCpMv checks it with the target table.
        if ((cmd === 'cp' || cmd === 'mv') && (f.name === 't' || f.name === 'target-directory')) continue;
        if (f.role && f.role !== 'plain') chk.byRole(f.role, f.value, `${cmd} -${f.long ? '-' : ''}${f.name}`);
    }
    let extra = null;
    if (cmd === 'cp' || cmd === 'mv') extra = checkCpMv(cmd, parsed, chk, ctx);
    else if (cmd === 'grep') extra = checkGrep(parsed, chk);
    else if (cmd === 'diff') extra = checkDiff(parsed, chk, ctx);
    else if (cmd === 'date') {
        for (const op of parsed.operands) if (!op.startsWith('+')) throw new GrammarError('date: only +FORMAT operands are allowed (setting the clock is not).');
    } else {
        parsed.operands.forEach((op, i) => {
            const role = typeof g.operands === 'function' ? g.operands(i, parsed.operands) : g.operands;
            chk.byRole(role, op, cmd);
        });
    }
    if (extra && extra.prepend) return { argv: [cmd, ...extra.prepend, ...args] };
    return { argv };
}

module.exports = {
    validateArgv, makeChecker, isLoopbackHost, checkSedScript, cpBasename,
    PROC_READ_ALLOW, DEV_WRITE_ALLOW, GREP_EXCLUDES, PREWALK_MAX_ENTRIES,
};
