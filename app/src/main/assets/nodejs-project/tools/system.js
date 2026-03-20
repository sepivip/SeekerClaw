// tools/system.js — shell_exec, js_eval handlers

const fs = require('fs');
const path = require('path');

const {
    workDir, log, config, SECRETS_BLOCKED, SHELL_ALLOWLIST,
} = require('../config');

const {
    redactSecrets, safePath,
} = require('../security');

const tools = [
    {
        name: 'shell_exec',
        description: 'Execute a shell command in a sandboxed environment. Working directory is restricted to your workspace. Only a predefined allowlist of safe commands is permitted (common Unix utilities like ls, cat, grep, find, curl). No shell chaining or redirection. Max 30s timeout. Note: node/npm/npx are NOT available (Node.js runs as a JNI library, not a standalone binary). Use for file operations, curl, and system info.',
        input_schema: {
            type: 'object',
            properties: {
                command: { type: 'string', description: 'Shell command to execute (e.g., "ls -la", "cat file.txt", "curl https://example.com", "grep pattern README.md")' },
                cwd: { type: 'string', description: 'Working directory relative to workspace (default: workspace root). Must be within workspace.' },
                timeout_ms: { type: 'number', description: 'Timeout in milliseconds (default: 30000, max: 30000)' }
            },
            required: ['command']
        }
    },
    {
        name: 'js_eval',
        description: 'Execute JavaScript code in a sandboxed VM context. Use for math, JSON manipulation, data processing, date calculations, and string operations. Has access to: Math, JSON, Date, RegExp, Buffer, URL, parseInt/parseFloat, encode/decodeURIComponent, setTimeout, and require() for safe Node.js built-ins (fs, path, http, crypto — but NOT child_process, vm, worker_threads, or config files). All output is redacted for secrets. 30s timeout. Use for computation and data processing, NOT for accessing app internals.',
        input_schema: {
            type: 'object',
            properties: {
                code: { type: 'string', description: 'JavaScript code to execute. The return value of the last expression is captured. Use console.log() for output. Async/await is supported.' },
                timeout_ms: { type: 'number', description: 'Timeout in milliseconds (default: 30000, max: 30000)' }
            },
            required: ['code']
        }
    },
];

const handlers = {
    async shell_exec(input, chatId) {
        const { exec } = require('child_process');
        const cmd = (input.command || '').trim();
        if (!cmd) return { error: 'command is required' };

        // Limit command length to prevent abuse
        if (cmd.length > 2048) {
            return { error: 'Command too long (max 2048 characters)' };
        }

        // Block newlines, null bytes, and Unicode line separators
        if (/[\r\n\0\u2028\u2029]/.test(cmd)) {
            return { error: 'Newline, null, or line separator characters are not allowed in commands' };
        }

        // Allowlist of safe command base names (shared constant from config.js).
        const ALLOWED_CMDS = SHELL_ALLOWLIST;

        // Extract the base command (first token before whitespace)
        const firstToken = cmd.split(/\s/)[0].trim();
        // Reject explicit paths (e.g., /usr/bin/rm, ./evil.sh)
        if (firstToken.includes('/') || firstToken.includes('\\')) {
            return { error: 'Command paths are not allowed. Use a bare command name from the allowlist.' };
        }
        if (!ALLOWED_CMDS.has(firstToken)) {
            return { error: `Command "${firstToken}" is not in the allowlist. Allowed: ${[...ALLOWED_CMDS].join(', ')}` };
        }

        // Block shell operators, command substitution, and glob patterns (incl. brackets)
        if (/[;&|`<>$~{}\[\]]|\*|\?/.test(cmd.slice(firstToken.length))) {
            return { error: 'Shell operators (;, &, |, `, <, >, $, *, ?, ~, {}, []) are not allowed in arguments. Run one simple command at a time.' };
        }

        // Resolve working directory (must be within workspace)
        let cwd = workDir;
        if (input.cwd) {
            const cwdInput = String(input.cwd).trim();
            const resolved = safePath(cwdInput);
            if (!resolved) return { error: 'Access denied: cwd is outside workspace' };
            if (!fs.existsSync(resolved)) return { error: `cwd does not exist: ${cwdInput}` };
            const cwdStat = fs.statSync(resolved);
            if (!cwdStat.isDirectory()) return { error: `cwd is not a directory: ${cwdInput}` };
            cwd = resolved;
        }

        // Validate and clamp timeout to [1, 30000]ms
        let timeout = 30000;
        if (input.timeout_ms !== undefined) {
            const t = Number(input.timeout_ms);
            if (!Number.isFinite(t) || t <= 0) {
                return { error: 'timeout_ms must be a positive number (max 30000)' };
            }
            timeout = Math.min(Math.max(t, 1), 30000);
        }

        // Detect shell: Android uses /system/bin/sh, standard Unix uses /bin/sh
        const shellPath = fs.existsSync('/system/bin/sh') ? '/system/bin/sh' : '/bin/sh';
        // Build child env from process.env (needed for nodejs-mobile paths)
        // but strip any vars that could leak secrets to child processes.
        const childEnv = { ...process.env, HOME: workDir, TERM: 'dumb' };
        // Remove sensitive patterns (API keys, tokens, credentials)
        for (const key of Object.keys(childEnv)) {
            const k = key.toUpperCase();
            if (k.includes('KEY') || k.includes('TOKEN') || k.includes('SECRET') ||
                k.includes('PASSWORD') || k.includes('CREDENTIAL') || k.includes('AUTH')) {
                delete childEnv[key];
            }
        }

        // Use async exec to avoid blocking the event loop
        return new Promise((resolve) => {
            exec(cmd, {
                cwd,
                timeout,
                encoding: 'utf8',
                maxBuffer: 1024 * 1024, // 1MB
                shell: shellPath,
                env: childEnv
            }, (err, stdout, stderr) => {
                if (err) {
                    if (err.killed && err.signal) {
                        log(`shell_exec TIMEOUT: ${cmd.slice(0, 80)}`, 'WARN');
                        resolve({
                            success: false,
                            command: cmd,
                            stdout: (stdout || '').slice(0, 50000),
                            stderr: `Command timed out after ${timeout}ms`,
                            exit_code: err.code || 1
                        });
                    } else {
                        log(`shell_exec FAIL (exit ${err.code || '?'}): ${cmd.slice(0, 80)}`, 'WARN');
                        resolve({
                            success: false,
                            command: cmd,
                            stdout: (stdout || '').slice(0, 50000),
                            stderr: (stderr || '').slice(0, 10000) || err.message || 'Unknown error',
                            exit_code: err.code || 1
                        });
                    }
                } else {
                    log(`shell_exec OK: ${cmd.slice(0, 80)}`, 'DEBUG');
                    resolve({
                        success: true,
                        command: cmd,
                        stdout: (stdout || '').slice(0, 50000),
                        stderr: (stderr || '').slice(0, 10000),
                        exit_code: 0
                    });
                }
            });
        });
    },

    async js_eval(input, chatId) {
        const code = (input.code || '').trim();
        if (!code) return { error: 'code is required' };
        if (code.length > 10000) return { error: 'Code too long (max 10000 characters)' };
        if (/\0/.test(code)) return { error: 'Null bytes are not allowed in code' };

        let timeout = 30000;
        if (input.timeout_ms !== undefined) {
            const t = Number(input.timeout_ms);
            if (!Number.isFinite(t) || t <= 0) {
                return { error: 'timeout_ms must be a positive number (max 30000)' };
            }
            timeout = Math.min(Math.max(t, 1), 30000);
        }

        // Capture console output
        const logs = [];
        const pushLog = (prefix, args) => logs.push((prefix ? prefix + ' ' : '') + args.map(a => {
            if (typeof a === 'object' && a !== null) try { return JSON.stringify(a); } catch { return String(a); }
            return String(a);
        }).join(' '));
        const mockConsole = {
            log: (...args) => pushLog('', args),
            info: (...args) => pushLog('', args),
            warn: (...args) => pushLog('[warn]', args),
            error: (...args) => pushLog('[error]', args),
            debug: (...args) => pushLog('[debug]', args),
            trace: (...args) => pushLog('[trace]', args),
            dir: (obj) => pushLog('', [obj]),
            table: (data) => pushLog('[table]', [data]),
            time: () => {}, timeEnd: () => {}, timeLog: () => {},
            assert: (cond, ...args) => { if (!cond) pushLog('[assert]', args.length ? args : ['Assertion failed']); },
            clear: () => {},
            count: () => {}, countReset: () => {},
            group: () => {}, groupEnd: () => {}, groupCollapsed: () => {},
        };

        // Sandboxed require: block dangerous modules and restrict fs access to sensitive files
        const BLOCKED_MODULES = new Set(['child_process', 'cluster', 'worker_threads', 'vm', 'v8', 'perf_hooks', 'module']);
        // Create a guarded fs proxy that blocks reads AND writes to sensitive files
        // promisesGuard: optional set of guarded methods for the .promises sub-property
        const createGuardedFsProxy = (realModule, guardedMethods, promisesGuard) => {
            return new Proxy(realModule, {
                get(target, prop) {
                    // Intercept fs.promises to return a guarded proxy too
                    if (prop === 'promises' && promisesGuard && target[prop]) {
                        return createGuardedFsProxy(target[prop], promisesGuard);
                    }
                    const original = target[prop];
                    if (typeof original !== 'function') return original;
                    if (guardedMethods.has(prop)) {
                        return function(...args) {
                            const filePath = String(args[0]);
                            // Resolve symlinks to prevent alias bypass (symlink -> config.json)
                            let resolvedPath = filePath;
                            try { resolvedPath = fs.realpathSync(filePath); } catch (_) {}
                            const basename = path.basename(resolvedPath);
                            if (SECRETS_BLOCKED.has(basename)) {
                                throw new Error(`Access to ${basename} is blocked for security.`);
                            }
                            return original.apply(target, args);
                        };
                    }
                    return original.bind(target);
                }
            });
        };
        const FS_GUARDED = new Set([
            'readFileSync', 'readFile', 'createReadStream', 'openSync', 'open',
            'writeFileSync', 'writeFile', 'appendFileSync', 'appendFile', 'createWriteStream',
            'copyFileSync', 'copyFile', 'cpSync', 'cp',
            'symlinkSync', 'symlink', 'linkSync', 'link',
        ]);
        const FSP_GUARDED = new Set(['readFile', 'writeFile', 'appendFile', 'open', 'copyFile', 'cp']);
        // Safe process subset — env is empty to prevent leaking sensitive variables
        // Defined here so sandboxedRequire can return it for require('process')
        const safeProcess = { env: {}, cwd: () => workDir, platform: process.platform, arch: process.arch, version: process.version };
        const sandboxedRequire = (mod) => {
            if (typeof mod !== 'string') {
                throw new Error('Module identifier must be a string in js_eval.');
            }
            // Normalize Node core specifiers like "node:fs" -> "fs"
            let normalizedMod = mod.startsWith('node:') ? mod.slice(5) : mod;

            // Block relative requires (including ".", "..") — prevents access to config.js (secrets), security.js, etc.
            if (
                normalizedMod === '.' ||
                normalizedMod === '..' ||
                normalizedMod.startsWith('./') ||
                normalizedMod.startsWith('../') ||
                normalizedMod.startsWith('.\\') ||
                normalizedMod.startsWith('..\\')
            ) {
                throw new Error('Relative module imports are blocked in js_eval for security.');
            }

            // Block absolute paths into workspace or source directory
            // Resolve both sides via realpathSync to defeat symlink aliases
            // (Android: /data/user/0/... is a symlink to /data/data/...)
            if (path.isAbsolute(normalizedMod)) {
                let resolvedMod = path.resolve(normalizedMod);
                try { resolvedMod = fs.realpathSync(resolvedMod); } catch (_) {}
                let resolvedWork = path.resolve(workDir);
                try { resolvedWork = fs.realpathSync(resolvedWork); } catch (_) {}
                let resolvedSrc = path.resolve(__dirname, '..');
                try { resolvedSrc = fs.realpathSync(resolvedSrc); } catch (_) {}
                const inWorkDir = resolvedMod === resolvedWork || resolvedMod.startsWith(resolvedWork + path.sep);
                const inSourceDir = resolvedMod === resolvedSrc || resolvedMod.startsWith(resolvedSrc + path.sep);
                if (inWorkDir || inSourceDir) {
                    throw new Error('Direct module imports from app directories are blocked in js_eval for security.');
                }
            }

            if (BLOCKED_MODULES.has(normalizedMod)) {
                throw new Error(`Module "${normalizedMod}" is blocked in js_eval for security. Use shell_exec for command execution.`);
            }

            if (normalizedMod === 'fs') {
                return createGuardedFsProxy(require('fs'), FS_GUARDED, FSP_GUARDED);
            }
            if (normalizedMod === 'fs/promises') {
                return createGuardedFsProxy(require('fs/promises'), FSP_GUARDED);
            }
            // Return safe process stub instead of real process (blocks env, mainModule)
            if (normalizedMod === 'process') {
                return safeProcess;
            }

            return require(normalizedMod);
        };

        let timerId;
        try {
            const vm = require('vm');

            // Wrap host-realm objects to sever prototype chain back to unrestricted
            // Function constructor. Without this, sandbox code can escape via:
            //   setTimeout.constructor.constructor('return process')()
            // Each wrapper exposes only the callable interface, not .constructor.
            const wrapFn = (fn) => {
                if (typeof fn !== 'function') return fn;
                const wrapped = (...args) => fn(...args);
                Object.defineProperty(wrapped, 'constructor', { value: undefined, writable: false, configurable: false });
                // Null prototype severs Object.getPrototypeOf(wrapped).constructor escape
                Object.setPrototypeOf(wrapped, null);
                Object.freeze(wrapped);
                return wrapped;
            };
            const wrapObj = (obj) => {
                if (!obj || typeof obj !== 'function') return obj;
                // For constructors like Buffer, URL — create a proxy that blocks constructor chain
                const handler = {
                    get(target, prop) {
                        if (prop === 'constructor' || prop === '__proto__') return undefined;
                        const val = target[prop];
                        if (typeof val === 'function') {
                            const bound = val.bind(target);
                            Object.setPrototypeOf(bound, null);
                            Object.defineProperty(bound, 'constructor', { value: undefined, writable: false, configurable: false });
                            return bound;
                        }
                        return val;
                    },
                    construct(target, args) { return new target(...args); },
                    getPrototypeOf() { return null; },
                };
                return new Proxy(obj, handler);
            };

            const sandbox = {
                console: mockConsole,
                require: wrapFn(sandboxedRequire),
                __dirname: workDir,
                __filename: path.join(workDir, 'eval.js'),
                process: safeProcess,
                global: undefined,
                globalThis: undefined,
                // Node.js globals — wrapped to sever constructor chain
                setTimeout: wrapFn(setTimeout), clearTimeout: wrapFn(clearTimeout),
                setInterval: wrapFn(setInterval), clearInterval: wrapFn(clearInterval),
                Buffer: wrapObj(Buffer), URL: wrapObj(URL), URLSearchParams: wrapObj(URLSearchParams),
                TextEncoder: wrapObj(typeof TextEncoder !== 'undefined' ? TextEncoder : undefined),
                TextDecoder: wrapObj(typeof TextDecoder !== 'undefined' ? TextDecoder : undefined),
                atob: wrapFn(typeof atob !== 'undefined' ? atob : undefined),
                btoa: wrapFn(typeof btoa !== 'undefined' ? btoa : undefined),
                AbortController: wrapObj(typeof AbortController !== 'undefined' ? AbortController : undefined),
                queueMicrotask: wrapFn(queueMicrotask),
                // Safe built-ins (value types — no constructor escape)
                JSON, Math, Date, parseInt, parseFloat, isNaN, isFinite,
                Number, String, Boolean, Array, Object, RegExp, Map, Set,
                Symbol, Promise, Error, TypeError, RangeError, SyntaxError,
                encodeURIComponent, decodeURIComponent, encodeURI, decodeURI,
                undefined, NaN, Infinity,
            };
            const context = vm.createContext(sandbox, {
                codeGeneration: { strings: false, wasm: false },
            });

            // Wrap in async IIFE for top-level await support, enforce strict mode
            const wrappedCode = `(async () => {\n'use strict';\n${code}\n})()`;
            const script = new vm.Script(wrappedCode, { filename: 'js_eval.js' });
            // VM timeout kills synchronous infinite loops (while(true){});
            // Promise.race timeout handles async hangs (await never resolves)
            const resultPromise = script.runInContext(context, { timeout });

            const timeoutPromise = new Promise((_, rej) => {
                timerId = setTimeout(() => rej(new Error(`Execution timed out after ${timeout}ms`)), timeout);
            });

            const result = await Promise.race([resultPromise, timeoutPromise]);
            clearTimeout(timerId);
            const output = logs.join('\n');

            // Serialize result: JSON for objects/arrays, String for primitives
            let resultStr;
            if (result === undefined) {
                resultStr = undefined;
            } else if (typeof result === 'object' && result !== null) {
                try { resultStr = JSON.stringify(result, null, 2).slice(0, 50000); } catch { resultStr = String(result).slice(0, 50000); }
            } else {
                resultStr = String(result).slice(0, 50000);
            }

            // Redact any secrets that may have leaked through sandbox gaps
            if (resultStr) resultStr = redactSecrets(resultStr);
            const safeOutput = output ? redactSecrets(output.slice(0, 50000)) : undefined;

            log(`js_eval OK (${code.length} chars)`, 'DEBUG');
            return {
                success: true,
                result: resultStr,
                output: safeOutput,
            };
        } catch (err) {
            clearTimeout(timerId);
            const output = logs.join('\n');
            log(`js_eval FAIL: ${err.message.slice(0, 100)}`, 'WARN');
            return {
                success: false,
                error: redactSecrets(err.message.slice(0, 5000)),
                output: output ? redactSecrets(output.slice(0, 50000)) : undefined,
            };
        }
    },
};

module.exports = { tools, handlers };
