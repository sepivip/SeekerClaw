// tools/shell-args.js — BAT-1409 P1-G: turns a shell_exec command line into argv.
//
// Builds argv the way /system/bin/sh (mksh) does for the only forms that remain legal: words
// separated by unquoted spaces or tabs, single quotes (literal), double quotes (backslash escapes
// only \ " $ ` and newline) and unquoted backslash escapes. An unescaped $ or ` inside double
// quotes is refused: the shell would expand it, and nothing is expanded here.
//
// Unquoted characters outside the safe set [A-Za-z0-9._/:=@%+,-] are refused: pipes, redirection,
// chaining, $, backticks, globs, ~, braces, brackets, `#` (a comment at word start), `(`, `)`,
// `!` and `^`. Quoted, they are plain text: shell_exec runs the validated argv with execFile (no
// shell), so the argv that was checked is exactly the argv that runs and nothing in it is
// expanded or interpreted.
//
// Pure: no I/O, no requires.

'use strict';

const SAFE_UNQUOTED = /^[A-Za-z0-9._/:=@%+,-]$/;

class ShellArgsError extends Error {}

/** Why an unquoted character is refused, phrased for the model. */
function unquotedMessage(c) {
    if (';&|<>'.includes(c)) {
        return 'Pipes, redirection and command chaining are not supported: run one simple command at a time (quote the character if it is part of an argument, e.g. grep -E "a|b").';
    }
    if (c === '$' || c === '`') return 'Variables and command substitution are not expanded. Put a literal $ inside single quotes; read env vars from js_eval (process.env).';
    if ('*?[]{}~'.includes(c)) return `Wildcards and expansions are not supported (${JSON.stringify(c)}); name files explicitly or quote the character if it is literal.`;
    return `The character ${JSON.stringify(c)} must be quoted when it is part of an argument.`;
}

/**
 * Splits [line] into words. Returns `{ argv, raw }`: `argv` the unquoted words, `raw[i]` the
 * source text of word i (for messages). Throws ShellArgsError for an unterminated quote, a
 * trailing backslash or an unquoted character outside the safe set.
 */
function tokenize(line) {
    // Newlines and NUL never belong in a command line (shell_exec refuses them up front too).
    if (/[\r\n\0\u2028\u2029]/.test(line)) throw new ShellArgsError('Newline, NUL and line separator characters are not allowed.');
    const argv = [];
    const raw = [];
    let i = 0;
    const n = line.length;
    while (i < n) {
        while (i < n && (line[i] === ' ' || line[i] === '\t')) i++;
        if (i >= n) break;
        const start = i;
        let word = '';
        while (i < n && line[i] !== ' ' && line[i] !== '\t') {
            const c = line[i];
            if (c === "'") {
                const end = line.indexOf("'", i + 1);
                if (end < 0) throw new ShellArgsError('Unterminated single quote.');
                word += line.slice(i + 1, end);
                i = end + 1;
            } else if (c === '"') {
                i++;
                let closed = false;
                while (i < n) {
                    const d = line[i];
                    if (d === '"') { closed = true; i++; break; }
                    if (d === '\\' && i + 1 < n && '\\"$`'.includes(line[i + 1])) {
                        word += line[i + 1];
                        i += 2;
                        continue;
                    }
                    // Inside double quotes the shell would expand these; nothing is expanded here,
                    // so refuse rather than pass the text on literally (single quotes are fine).
                    if (d === '$' || d === '`') throw new ShellArgsError(unquotedMessage(d));
                    word += d;
                    i++;
                }
                if (!closed) throw new ShellArgsError('Unterminated double quote.');
            } else if (c === '\\') {
                if (i + 1 >= n) throw new ShellArgsError('A trailing backslash is not allowed.');
                word += line[i + 1];
                i += 2;
            } else {
                if (!SAFE_UNQUOTED.test(c)) throw new ShellArgsError(unquotedMessage(c));
                word += c;
                i++;
            }
        }
        argv.push(word);
        raw.push(line.slice(start, i));
    }
    return { argv, raw };
}

module.exports = { tokenize, ShellArgsError, SAFE_UNQUOTED };
