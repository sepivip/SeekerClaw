// tools/shell-grammar.js — BAT-1409 P1-G: the deny-unknown argument grammar for shell_exec.
//
// One entry per allowlisted command (all 34). Each lists the accepted short and long flags,
// whether a flag takes a value and that value's role, and the role of the operands:
//   read   a file whose CONTENT the command reads (workspace path rule + the read tool's names)
//   meta   a path used only for names and sizes (workspace path rule; may name protected files)
//   write  a path the command creates, changes or removes (workspace rule + protected root names)
//   url    a curl URL (http/https only)
//   plain  not a path
// Unknown flags, unknown long options and forms the table does not cover are refused before
// anything runs, with a message naming the flag. Commands with special rules (cp, mv, sed, curl,
// find, grep, sort, uniq, date, touch, diff) carry a `check` hook used by shell-validate.js.
//
// Pure data plus the generic parser; no I/O.

'use strict';

class GrammarError extends Error {}

/** A flag that takes no value. */
const F = () => ({ value: null });
/** A flag that takes a value with role [role]. */
const V = (role) => ({ value: role });
/** A long option whose value is optional and given only as --opt=VALUE (GNU/toybox rule). */
const O = (role) => ({ value: role, optional: true });

/**
 * The commands' grammars. `short` maps a one-letter flag to F()/V(role); `long` maps a long option
 * (without the leading --) the same way; `operands` is the role of every operand (or a function
 * (index, all) => role); `minOperands`/`maxOperands` bound them; `refuse` maps flags to the reason
 * they are refused (named, so the message explains it).
 */
const GRAMMAR = {
    cat: {
        short: { n: F(), b: F(), A: F(), E: F(), T: F(), v: F(), e: F(), t: F(), s: F(), u: F() },
        long: { number: F(), 'number-nonblank': F(), 'show-all': F(), 'show-ends': F(), 'show-tabs': F(), 'squeeze-blank': F() },
        operands: 'read',
    },
    ls: {
        short: {
            a: F(), A: F(), l: F(), h: F(), R: F(), r: F(), t: F(), S: F(), s: F(), d: F(), F: F(), i: F(), n: F(),
            '1': F(), C: F(), x: F(), m: F(), p: F(), c: F(), u: F(), k: F(), g: F(), o: F(), q: F(), Z: F(), U: F(), X: F(),
        },
        long: { all: F(), 'almost-all': F(), 'human-readable': F(), recursive: F(), reverse: F(), color: F(), 'color=never': F(), 'color=auto': F(), 'full-time': F(), 'group-directories-first': F() },
        refuse: { L: 'ls -L follows links', H: 'ls -H follows links', dereference: 'ls --dereference follows links' },
        operands: 'meta',
    },
    mkdir: { short: { p: F(), v: F(), m: V('plain') }, long: { parents: F(), verbose: F(), mode: V('plain') }, operands: 'write', minOperands: 1 },
    // Write options the device's toybox does not have (0.8.9: --target-directory, --no-target-directory,
    // sort --output, sed --in-place answer "Unknown option") are refused, naming the short form (§6).
    cp: {
        short: { r: F(), R: F(), L: F(), f: F(), i: F(), n: F(), p: F(), v: F(), u: F(), F: F(), T: F(), t: V('write') },
        long: { recursive: F(), dereference: F(), force: F(), interactive: F(), 'no-clobber': F(), preserve: O('plain'), verbose: F(), update: F() },
        refuse: {
            l: 'cp -l creates hard links', s: 'cp -s creates symbolic links', link: 'cp --link creates hard links',
            'symbolic-link': 'cp --symbolic-link creates links', d: 'cp -d copies links as links', P: 'cp -P copies links as links',
            H: 'cp -H copies links as links', a: 'cp -a copies links as links', 'no-dereference': 'cp --no-dereference copies links as links',
            archive: 'cp --archive copies links as links',
            'target-directory': "cp --target-directory is not in the device's toybox (use -t DIR)",
            'no-target-directory': "cp --no-target-directory is not in the device's toybox (use -T)",
        },
        operands: 'special', minOperands: 1,
    },
    mv: {
        short: { f: F(), i: F(), n: F(), v: F(), u: F(), F: F(), T: F(), t: V('write') },
        long: { force: F(), interactive: F(), 'no-clobber': F(), verbose: F(), update: F() },
        refuse: {
            'target-directory': "mv --target-directory is not in the device's toybox (use -t DIR)",
            'no-target-directory': "mv --no-target-directory is not in the device's toybox (use -T)",
        },
        operands: 'special', minOperands: 1,
    },
    // echo only prints its arguments: every word is plain text (toybox prints unknown -x as text).
    echo: { allPlain: true, operands: 'plain' },
    pwd: { short: { L: F(), P: F() }, long: {}, operands: 'plain', maxOperands: 0 },
    which: { short: { a: F() }, long: {}, operands: 'plain' },
    head: { short: { n: V('plain'), c: V('plain'), q: F(), v: F() }, long: { lines: V('plain'), bytes: V('plain'), quiet: F(), silent: F(), verbose: F() }, operands: 'read', numericShort: true },
    tail: { short: { n: V('plain'), c: V('plain'), q: F(), v: F(), f: F(), F: F() }, long: { lines: V('plain'), bytes: V('plain'), quiet: F(), silent: F(), verbose: F(), follow: F() }, operands: 'read', numericShort: true },
    wc: { short: { l: F(), w: F(), c: F(), m: F(), L: F() }, long: { lines: F(), words: F(), bytes: F(), chars: F(), 'max-line-length': F() }, operands: 'read' },
    sort: {
        short: { n: F(), r: F(), u: F(), f: F(), b: F(), d: F(), i: F(), M: F(), h: F(), g: F(), s: F(), c: F(), C: F(), z: F(), V: F(), R: F(), k: V('plain'), t: V('plain'), o: V('write') },
        long: { 'numeric-sort': F(), reverse: F(), unique: F(), 'ignore-case': F(), 'ignore-leading-blanks': F(), 'dictionary-order': F(), 'human-numeric-sort': F(), 'general-numeric-sort': F(), stable: F(), check: F(), 'version-sort': F(), key: V('plain'), 'field-separator': V('plain') },
        refuse: {
            T: 'sort -T writes temporary files elsewhere', 'compress-program': 'sort --compress-program runs a program', 'files0-from': 'sort --files0-from reads a file list', S: 'sort -S is not needed',
            output: "sort --output is not in the device's toybox (use -o FILE)",
        },
        operands: 'read',
    },
    uniq: {
        short: { c: F(), d: F(), u: F(), i: F(), z: F(), f: V('plain'), s: V('plain'), w: V('plain'), D: F() },
        long: { count: F(), repeated: F(), unique: F(), 'ignore-case': F(), 'skip-fields': V('plain'), 'skip-chars': V('plain'), 'check-chars': V('plain'), 'all-repeated': F() },
        operands: (i) => (i === 0 ? 'read' : 'write'), maxOperands: 2,
    },
    grep: {
        short: {
            i: F(), v: F(), c: F(), l: F(), L: F(), n: F(), h: F(), H: F(), o: F(), q: F(), s: F(), w: F(), x: F(), E: F(), F: F(), G: F(),
            r: F(), I: F(), b: F(), z: F(), Z: F(), a: F(), U: F(),
            e: V('plain'), f: V('read'), m: V('plain'), A: V('plain'), B: V('plain'), C: V('plain'),
        },
        long: {
            'ignore-case': F(), 'invert-match': F(), count: F(), 'files-with-matches': F(), 'files-without-match': F(), 'line-number': F(),
            'no-filename': F(), 'with-filename': F(), 'only-matching': F(), quiet: F(), silent: F(), 'no-messages': F(), 'word-regexp': F(),
            'line-regexp': F(), 'extended-regexp': F(), 'fixed-strings': F(), 'basic-regexp': F(), recursive: F(), color: F(), 'color=never': F(),
            regexp: V('plain'), file: V('read'), 'max-count': V('plain'), 'after-context': V('plain'), 'before-context': V('plain'), context: V('plain'),
            include: V('plain'), exclude: V('plain'), 'exclude-dir': V('plain'),
        },
        refuse: { R: 'grep -R follows links (use grep -r)', 'dereference-recursive': 'grep --dereference-recursive follows links' },
        operands: 'special', numericShort: true,
    },
    find: { operands: 'special' },
    curl: { operands: 'special' },
    ping: {
        short: { c: V('plain'), i: V('plain'), W: V('plain'), w: V('plain'), s: V('plain'), t: V('plain'), q: F(), n: F(), '4': F(), '6': F(), D: F(), v: F() },
        long: {}, operands: 'plain', minOperands: 1, maxOperands: 1,
    },
    date: {
        short: { u: F(), R: F(), I: F(), d: V('plain'), r: V('read'), D: V('plain') },
        long: { utc: F(), universal: F(), 'rfc-2822': F(), 'rfc-email': F(), date: V('plain'), reference: V('read'), 'iso-8601': F() },
        refuse: { s: 'date -s sets the clock', set: 'date --set sets the clock' },
        operands: 'plain', maxOperands: 1,
    },
    df: { short: { h: F(), k: F(), P: F(), a: F(), i: F(), T: F(), H: F(), m: F(), t: V('plain') }, long: { 'human-readable': F(), all: F(), inodes: F(), 'print-type': F(), portability: F() }, operands: 'meta' },
    du: {
        short: { h: F(), s: F(), a: F(), c: F(), k: F(), m: F(), x: F(), d: V('plain') },
        long: { 'human-readable': F(), summarize: F(), all: F(), total: F(), 'max-depth': V('plain'), 'one-file-system': F() },
        refuse: { L: 'du -L follows links', H: 'du -H follows links', dereference: 'du --dereference follows links' },
        operands: 'meta',
    },
    uname: { short: { a: F(), s: F(), n: F(), r: F(), v: F(), m: F(), o: F(), p: F(), i: F() }, long: { all: F() }, operands: 'plain', maxOperands: 0 },
    printenv: { short: { '0': F() }, long: { null: F() }, operands: 'plain' },
    touch: {
        short: { a: F(), m: F(), c: F(), h: F(), d: V('plain'), t: V('plain'), r: V('read') },
        long: { 'no-create': F(), date: V('plain'), reference: V('read') },
        operands: 'write', minOperands: 1,
    },
    diff: {
        short: { u: F(), U: V('plain'), r: F(), N: F(), q: F(), b: F(), B: F(), w: F(), i: F(), a: F(), t: F(), T: F(), s: F(), d: F(), y: F(), W: V('plain'), L: V('plain') },
        long: { unified: V('plain'), recursive: F(), 'new-file': F(), brief: F(), 'ignore-space-change': F(), 'ignore-blank-lines': F(), 'ignore-all-space': F(), 'ignore-case': F(), text: F(), 'report-identical-files': F(), color: F(), 'color=never': F(), 'side-by-side': F() },
        refuse: { x: 'diff -x reads exclude patterns', X: 'diff -X reads a pattern file', S: 'diff -S is not needed' },
        operands: 'special', minOperands: 2, maxOperands: 2,
    },
    sed: { operands: 'special' },
    cut: { short: { b: V('plain'), c: V('plain'), f: V('plain'), d: V('plain'), s: F(), n: F(), D: F(), O: V('plain') }, long: { bytes: V('plain'), characters: V('plain'), fields: V('plain'), delimiter: V('plain'), 'only-delimited': F(), complement: F() }, operands: 'read' },
    base64: { short: { d: F(), D: F(), i: F(), w: V('plain') }, long: { decode: F(), 'ignore-garbage': F(), wrap: V('plain') }, operands: 'read', maxOperands: 1 },
    stat: {
        short: { c: V('plain'), f: F(), t: F() },
        long: { format: V('plain'), 'file-system': F(), terse: F(), printf: V('plain') },
        refuse: { L: 'stat -L follows links', dereference: 'stat --dereference follows links' },
        operands: 'meta', minOperands: 1,
    },
    file: {
        short: { b: F(), i: F(), z: F(), s: F(), h: F() },
        long: { brief: F(), mime: F(), 'mime-type': F(), 'no-dereference': F() },
        refuse: { L: 'file -L follows links', m: 'file -m reads a magic file', f: 'file -f reads a file list', 'files-from': 'file --files-from reads a file list', dereference: 'file --dereference follows links' },
        operands: 'meta', minOperands: 1,
    },
    sleep: { short: {}, long: {}, operands: 'plain', minOperands: 1, maxOperands: 1 },
    getprop: { short: { T: F(), Z: F() }, long: {}, operands: 'plain', maxOperands: 2 },
    md5sum: { short: { b: F(), t: F(), s: F(), w: F(), q: F() }, long: { binary: F(), text: F(), quiet: F(), status: F(), tag: F() }, refuse: { c: 'md5sum -c reads the files a list names', check: 'md5sum --check reads the files a list names' }, operands: 'read' },
    sha256sum: { short: { b: F(), t: F(), s: F(), w: F(), q: F() }, long: { binary: F(), text: F(), quiet: F(), status: F(), tag: F() }, refuse: { c: 'sha256sum -c reads the files a list names', check: 'sha256sum --check reads the files a list names' }, operands: 'read' },
    screencap: { short: { p: F(), d: V('plain') }, long: {}, operands: 'write', maxOperands: 1 },
};

/**
 * Generic option parser for [cmd] with [args] (argv without the command name). Returns
 * `{ flags: [{name, long, value, role}], operands: [string] }`. Options may appear anywhere
 * (toybox permutes); `--` ends them; a lone `-` is an operand (stdin).
 */
function parseOptions(cmd, args, g = GRAMMAR[cmd]) {
    const flags = [];
    const operands = [];
    if (g.allPlain) return { flags, operands: args.slice() };
    let i = 0;
    let ended = false;
    while (i < args.length) {
        const a = args[i];
        if (ended || a === '-' || !a.startsWith('-')) {
            operands.push(a);
            i++;
            continue;
        }
        if (a === '--') { ended = true; i++; continue; }
        if (a.startsWith('--')) {
            const eq = a.indexOf('=');
            const name = eq < 0 ? a.slice(2) : a.slice(2, eq);
            const refuse = g.refuse && Object.prototype.hasOwnProperty.call(g.refuse, name) ? g.refuse[name] : null;
            if (refuse) throw new GrammarError(`${cmd}: ${refuse}; refused.`);
            let spec = Object.prototype.hasOwnProperty.call(g.long || {}, name) ? g.long[name] : null;
            if (!spec && eq >= 0 && Object.prototype.hasOwnProperty.call(g.long || {}, a.slice(2))) spec = F(); // e.g. --color=never
            if (!spec) throw new GrammarError(`${cmd}: the option --${name} is not allowed.`);
            if (spec.value === null) {
                if (eq >= 0 && !Object.prototype.hasOwnProperty.call(g.long, a.slice(2))) throw new GrammarError(`${cmd}: --${name} takes no value.`);
                flags.push({ name, long: true, value: null, role: null });
                i++;
            } else if (spec.optional) {
                flags.push({ name, long: true, value: eq >= 0 ? a.slice(eq + 1) : null, role: eq >= 0 ? spec.value : null });
                i++;
            } else {
                let value;
                if (eq >= 0) { value = a.slice(eq + 1); i++; } else {
                    if (i + 1 >= args.length) throw new GrammarError(`${cmd}: --${name} needs a value.`);
                    value = args[i + 1];
                    i += 2;
                }
                flags.push({ name, long: true, value, role: spec.value });
            }
            continue;
        }
        // Short cluster. `head -5` style numbers are a count, not flags.
        if (g.numericShort && /^-\d+$/.test(a)) {
            flags.push({ name: 'n', long: false, value: a.slice(1), role: 'plain' });
            i++;
            continue;
        }
        let j = 1;
        let consumedNext = false;
        while (j < a.length) {
            const ch = a[j];
            const refuse = g.refuse && Object.prototype.hasOwnProperty.call(g.refuse, ch) ? g.refuse[ch] : null;
            if (refuse) throw new GrammarError(`${cmd}: ${refuse}; refused.`);
            const spec = Object.prototype.hasOwnProperty.call(g.short || {}, ch) ? g.short[ch] : null;
            if (!spec) throw new GrammarError(`${cmd}: the flag -${ch} is not allowed.`);
            if (spec.value === null) {
                flags.push({ name: ch, long: false, value: null, role: null });
                j++;
                continue;
            }
            let value = a.slice(j + 1);
            if (value === '') {
                if (i + 1 >= args.length) throw new GrammarError(`${cmd}: -${ch} needs a value.`);
                value = args[i + 1];
                consumedNext = true;
            }
            flags.push({ name: ch, long: false, value, role: spec.value });
            break;
        }
        i += consumedNext ? 2 : 1;
    }
    if (g.minOperands !== undefined && operands.length < g.minOperands) throw new GrammarError(`${cmd}: missing operand.`);
    if (g.maxOperands !== undefined && operands.length > g.maxOperands) throw new GrammarError(`${cmd}: too many operands.`);
    return { flags, operands };
}

function has(flags, ...names) {
    return flags.some((f) => names.includes(f.name));
}

module.exports = { GRAMMAR, parseOptions, GrammarError, has, F, V, O };
