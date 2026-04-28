#!/usr/bin/env node
// idle-summary-timers.test.js — tests for the BAT-524 per-chat
// idle-summary timer model in ai.js.
//
// Run:  node tests/nodejs-project/idle-summary-timers.test.js
// Exit: 0 = all pass, 1 = at least one failure.
//
// WHY THIS FILE EXISTS
// --------------------
// Phase 3B of BAT-518 replaced a single global `setInterval(60s)` sweep
// over `sessionTracking` with a per-chat `setTimeout(IDLE_TIMEOUT_MS)`
// model. Three correctness invariants need pinning:
//
//   1. Each chat has at MOST one active timer at any time. A new
//      message must cancel the prior timer before scheduling a new
//      one — otherwise idle bursts could pile up parallel timers
//      that fire saveSessionSummary multiple times.
//
//   2. New messages on chat A must NOT touch chat B's timer. The
//      old global sweep fired one summary at a time; the new model
//      must preserve per-chat isolation.
//
//   3. Cancellation paths (clearConversation, sessionTracking.delete,
//      shutdown) must clear the timer so it never fires post-cancel.
//
// All three are pure timer/Map logic, but they live next to live
// session-tracking + saveSessionSummary calls. Following the
// active-model.test.js pattern, we mirror the schedule/cancel
// primitives locally and grep the source at the end to fail loudly
// on drift.

'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');

const AI_JS = path.join(__dirname, '..', '..', 'app', 'src', 'main',
    'assets', 'nodejs-project', 'ai.js');
const MAIN_JS = path.join(__dirname, '..', '..', 'app', 'src', 'main',
    'assets', 'nodejs-project', 'main.js');

// Strip JS comments before drift-guard matching. Without this, every
// regex below could false-pass on a comment that happens to contain
// the symbol it's looking for — the same trap that burned the BAT-523
// setInterval drift guard ("Pre-BAT-523, the DB was saved every 60s
// via setInterval(saveDatabase)" in a comment matched the regex
// looking for the live setInterval call).
//
// String literals are deliberately NOT masked: real strings like
// `process.on('SIGTERM', ...)` need the literal to match. Drift
// guards instead use `\b<identifier>\s*\(` patterns that match a
// function call site — a string containing an identifier never has
// a `(` immediately after its closing quote, so the false-positive
// surface is eliminated by anchoring on the call form rather than
// by masking strings.
function stripJsComments(src) {
    let out = '';
    let i = 0;
    while (i < src.length) {
        const c = src[i];
        const next = src[i + 1];
        if (c === '/' && next === '/') {
            // Line comment — skip to end of line.
            const eol = src.indexOf('\n', i);
            i = eol === -1 ? src.length : eol;
        } else if (c === '/' && next === '*') {
            // Block comment — skip to */.
            const end = src.indexOf('*/', i + 2);
            i = end === -1 ? src.length : end + 2;
        } else if (c === '"' || c === "'" || c === '`') {
            // String literal — copy verbatim, skipping over its body
            // so an inner `//` or `/*` can't be misread as a comment
            // boundary.
            const quote = c;
            out += quote;
            i++;
            while (i < src.length && src[i] !== quote) {
                out += src[i];
                if (src[i] === '\\' && i + 1 < src.length) {
                    out += src[i + 1];
                    i += 2;
                } else {
                    i++;
                }
            }
            if (i < src.length) {
                out += src[i];
                i++;
            }
        } else {
            out += c;
            i++;
        }
    }
    return out;
}

function readJsSource(filePath) {
    return stripJsComments(fs.readFileSync(filePath, 'utf8'));
}

// --- mirrored logic (must match ai.js scheduleIdleSummary / cancelIdleSummary) ---
function makeHarness({ idleTimeoutMs = 60_000, minMessagesForSummary = 3 } = {}) {
    const conversations = new Map();   // chatId → array of messages
    const idleSummaryTimers = new Map(); // chatId → NodeJS.Timeout
    let summaryCount = 0;
    const summaryCalls = []; // {chatId, reason, convLen}

    function pretendSaveSummary(chatId, reason) {
        summaryCount++;
        const conv = conversations.get(chatId);
        summaryCalls.push({ chatId, reason, convLen: conv ? conv.length : 0 });
        return Promise.resolve();
    }

    function scheduleIdleSummary(chatId) {
        cancelIdleSummary(chatId);
        const timer = setTimeout(() => {
            idleSummaryTimers.delete(chatId);
            const conv = conversations.get(chatId);
            if (conv && conv.length >= minMessagesForSummary) {
                pretendSaveSummary(chatId, 'idle').catch(() => {});
            }
        }, idleTimeoutMs);
        idleSummaryTimers.set(chatId, timer);
    }

    function cancelIdleSummary(chatId) {
        const timer = idleSummaryTimers.get(chatId);
        if (timer !== undefined) {
            clearTimeout(timer);
            idleSummaryTimers.delete(chatId);
        }
    }

    function cancelAllIdleSummaries() {
        for (const t of idleSummaryTimers.values()) clearTimeout(t);
        idleSummaryTimers.clear();
    }

    function setConv(chatId, msgs) { conversations.set(chatId, msgs); }
    function clearConv(chatId) {
        conversations.set(chatId, []);
        cancelIdleSummary(chatId);
    }

    return {
        scheduleIdleSummary, cancelIdleSummary, cancelAllIdleSummaries,
        setConv, clearConv,
        get timerCount() { return idleSummaryTimers.size; },
        hasTimer: (chatId) => idleSummaryTimers.has(chatId),
        get summaryCount() { return summaryCount; },
        get summaryCalls() { return summaryCalls.slice(); },
    };
}

// --- runner ---
const tests = [];
let pass = 0, fail = 0;
function test(name, fn) { tests.push({ name, fn }); }
async function run() {
    for (const { name, fn } of tests) {
        try {
            await fn();
            pass++;
            console.log(`PASS  ${name}`);
        } catch (e) {
            fail++;
            console.log(`FAIL  ${name}`);
            console.log(`  ${e.message}`);
            if (e.stack) console.log(e.stack.split('\n').slice(1, 4).join('\n'));
        }
    }
    console.log(`\n${pass} passed, ${fail} failed`);
    process.exit(fail === 0 ? 0 : 1);
}

// --- behavioural tests ---

test('schedule installs exactly one timer per chat', () => {
    const h = makeHarness({ idleTimeoutMs: 60_000 });
    h.scheduleIdleSummary('chat-A');
    assert.strictEqual(h.timerCount, 1);
    assert.ok(h.hasTimer('chat-A'));
    h.cancelAllIdleSummaries();
});

test('re-scheduling same chat does NOT pile up timers', () => {
    const h = makeHarness({ idleTimeoutMs: 60_000 });
    for (let i = 0; i < 50; i++) h.scheduleIdleSummary('chat-A');
    // A naïve impl would have 50 dangling timers in flight (event-loop
    // memory leak + 50 saveSessionSummary fires when window expires).
    assert.strictEqual(h.timerCount, 1, 'still exactly one pending timer');
    h.cancelAllIdleSummaries();
});

test('different chats get independent timers', () => {
    const h = makeHarness({ idleTimeoutMs: 60_000 });
    h.scheduleIdleSummary('chat-A');
    h.scheduleIdleSummary('chat-B');
    h.scheduleIdleSummary('chat-C');
    assert.strictEqual(h.timerCount, 3);
    assert.ok(h.hasTimer('chat-A'));
    assert.ok(h.hasTimer('chat-B'));
    assert.ok(h.hasTimer('chat-C'));
    h.cancelAllIdleSummaries();
});

test('rescheduling chat A leaves chat B untouched', () => {
    const h = makeHarness({ idleTimeoutMs: 60_000 });
    h.scheduleIdleSummary('chat-A');
    h.scheduleIdleSummary('chat-B');
    // Burst of activity on A — must not touch B's timer.
    for (let i = 0; i < 10; i++) h.scheduleIdleSummary('chat-A');
    assert.ok(h.hasTimer('chat-A'));
    assert.ok(h.hasTimer('chat-B'));
    assert.strictEqual(h.timerCount, 2);
    h.cancelAllIdleSummaries();
});

test('cancelIdleSummary removes the timer and is idempotent', () => {
    const h = makeHarness({ idleTimeoutMs: 60_000 });
    h.scheduleIdleSummary('chat-A');
    h.cancelIdleSummary('chat-A');
    assert.strictEqual(h.timerCount, 0);
    // Idempotent — second cancel should not throw.
    h.cancelIdleSummary('chat-A');
    h.cancelIdleSummary('chat-NEVER-SCHEDULED');
});

test('cancelAllIdleSummaries clears every timer', () => {
    const h = makeHarness({ idleTimeoutMs: 60_000 });
    h.scheduleIdleSummary('chat-A');
    h.scheduleIdleSummary('chat-B');
    h.scheduleIdleSummary('chat-C');
    h.cancelAllIdleSummaries();
    assert.strictEqual(h.timerCount, 0);
});

test('timer fires saveSessionSummary when conversation has enough messages', async () => {
    const h = makeHarness({ idleTimeoutMs: 30, minMessagesForSummary: 3 });
    h.setConv('chat-A', [{}, {}, {}]);
    h.scheduleIdleSummary('chat-A');
    await new Promise(r => setTimeout(r, 60));
    assert.strictEqual(h.summaryCount, 1, 'one summary fired');
    assert.strictEqual(h.timerCount, 0, 'timer slot cleared after firing');
});

test('timer does NOT fire saveSessionSummary when conversation is too short', async () => {
    const h = makeHarness({ idleTimeoutMs: 30, minMessagesForSummary: 3 });
    h.setConv('chat-A', [{}, {}]); // < MIN_MESSAGES_FOR_SUMMARY
    h.scheduleIdleSummary('chat-A');
    await new Promise(r => setTimeout(r, 60));
    assert.strictEqual(h.summaryCount, 0, 'no summary for tiny session');
});

test('rescheduling resets the idle window — timer does NOT fire if reset before deadline', async () => {
    const h = makeHarness({ idleTimeoutMs: 50, minMessagesForSummary: 3 });
    h.setConv('chat-A', [{}, {}, {}]);
    h.scheduleIdleSummary('chat-A');
    // Reset before original deadline — the new timer fires 50ms from now,
    // so we wait less than that to confirm no fire happened.
    await new Promise(r => setTimeout(r, 30));
    h.scheduleIdleSummary('chat-A');
    await new Promise(r => setTimeout(r, 30)); // total: 60ms, but reset at 30ms means new window started at 30ms
    assert.strictEqual(h.summaryCount, 0, 'reset prevented the original timer from firing');
    assert.ok(h.hasTimer('chat-A'), 'new timer still pending');
    h.cancelAllIdleSummaries();
});

test('clearConv cancels the timer (so cleared sessions never re-summarize)', async () => {
    const h = makeHarness({ idleTimeoutMs: 30, minMessagesForSummary: 3 });
    h.setConv('chat-A', [{}, {}, {}]);
    h.scheduleIdleSummary('chat-A');
    h.clearConv('chat-A');
    assert.strictEqual(h.timerCount, 0, 'timer cancelled by clearConv');
    await new Promise(r => setTimeout(r, 60));
    assert.strictEqual(h.summaryCount, 0, 'no summary fired after clear');
});

test('only ONE summary fires even after a burst of (re)schedules', async () => {
    const h = makeHarness({ idleTimeoutMs: 30, minMessagesForSummary: 3 });
    h.setConv('chat-A', [{}, {}, {}]);
    for (let i = 0; i < 100; i++) h.scheduleIdleSummary('chat-A');
    await new Promise(r => setTimeout(r, 60));
    assert.strictEqual(h.summaryCount, 1, 'coalesced burst produced exactly one summary');
});

// --- structural drift guards ---

test('drift: ai.js exports the per-chat timer helpers', () => {
    // Use readJsSource so comments / string literals can't satisfy
    // the regex by substring presence — pin to actual code.
    const src = readJsSource(AI_JS);
    // The export block must reference all three. Match each as an
    // identifier followed by `,` or `}` so a long substring inside
    // an unrelated context can't false-pass.
    const exportMatch = src.match(/module\.exports\s*=\s*\{[\s\S]*?\};/);
    assert.ok(exportMatch, 'module.exports block not found');
    const exportBody = exportMatch[0];
    for (const sym of ['scheduleIdleSummary', 'cancelIdleSummary', 'cancelAllIdleSummaries']) {
        const re = new RegExp(`\\b${sym}\\s*[,}]`);
        assert.ok(re.test(exportBody), `module.exports must include ${sym}`);
    }
});

test('drift: main.js no longer has the idle-session sweep setInterval', () => {
    // Comments now stripped — the BAT-524 explanatory comments in
    // main.js mention the old pattern but stripped source contains
    // only live code.
    const src = readJsSource(MAIN_JS);
    assert.ok(!/setInterval[\s\S]*sessionTracking\.forEach/.test(src),
        'main.js must not contain a setInterval that sweeps sessionTracking (BAT-524 — replaced with per-chat setTimeouts)');
});

test('drift: clearConversation in ai.js cancels the idle timer', () => {
    const src = readJsSource(AI_JS);
    const fnMatch = src.match(/function\s+clearConversation\s*\(\s*chatId\s*\)\s*\{[\s\S]*?\n\}/);
    assert.ok(fnMatch, 'clearConversation function body not found');
    const body = fnMatch[0];
    assert.ok(/\bcancelIdleSummary\s*\(\s*chatId\s*\)/.test(body),
        'clearConversation must call cancelIdleSummary(chatId) (BAT-524 — prevents post-clear fire)');
});

test('drift: SIGTERM/SIGINT handlers in main.js cancel all idle timers', () => {
    const src = readJsSource(MAIN_JS);
    // Both signal handlers must INVOKE cancelAllIdleSummaries — match
    // the call form `cancelAllIdleSummaries(...)` not just the
    // identifier, so a stray reference can't satisfy the guard.
    const sigtermMatch = src.match(/process\.on\(['"]SIGTERM['"][\s\S]*?\}\);/);
    const sigintMatch = src.match(/process\.on\(['"]SIGINT['"][\s\S]*?\}\);/);
    assert.ok(sigtermMatch, 'SIGTERM handler not found');
    assert.ok(sigintMatch, 'SIGINT handler not found');
    assert.ok(/\bcancelAllIdleSummaries\s*\(/.test(sigtermMatch[0]),
        'SIGTERM handler must call cancelAllIdleSummaries(...)');
    assert.ok(/\bcancelAllIdleSummaries\s*\(/.test(sigintMatch[0]),
        'SIGINT handler must call cancelAllIdleSummaries(...)');
});

test('drift: scheduleIdleSummary calls .unref() on the timer', () => {
    // Without unref(), a pending idle timer can keep the Node event
    // loop alive past a clean shutdown unless every exit path
    // reliably cancels it. Pin that the live source uses the same
    // `if (timer.unref) timer.unref()` defensive pattern as cron.js.
    const src = readJsSource(AI_JS);
    const fnMatch = src.match(/function\s+scheduleIdleSummary[\s\S]*?\n\}/);
    assert.ok(fnMatch, 'scheduleIdleSummary function body not found');
    const body = fnMatch[0];
    assert.ok(/timer\.unref\s*\(\s*\)/.test(body),
        'scheduleIdleSummary must call timer.unref() so a pending idle timer cannot block clean process exit');
});

test('drift: gracefulShutdown receives cancelAllIdleSummaries via setShutdownDeps', () => {
    const dbSrc = readJsSource(path.join(__dirname, '..', '..', 'app', 'src', 'main',
        'assets', 'nodejs-project', 'database.js'));
    // The shutdown-deps record must declare cancelAllIdleSummaries.
    assert.ok(/cancelAllIdleSummaries\s*:/.test(dbSrc),
        'database.js _shutdownDeps must declare cancelAllIdleSummaries (BAT-524 — gracefulShutdown can call process.exit before main.js SIGTERM listener runs)');
    // gracefulShutdown must invoke it.
    const fnMatch = dbSrc.match(/async\s+function\s+gracefulShutdown[\s\S]*?\n\}/);
    assert.ok(fnMatch, 'gracefulShutdown function body not found');
    assert.ok(/_shutdownDeps\.cancelAllIdleSummaries\s*\(\s*\)/.test(fnMatch[0]),
        'gracefulShutdown must call _shutdownDeps.cancelAllIdleSummaries() so timers are released even when main.js SIGTERM listener is bypassed');
    // main.js must pass cancelAllIdleSummaries when wiring deps.
    const mainSrc = readJsSource(MAIN_JS);
    assert.ok(/setShutdownDeps\s*\(\s*\{[^}]*cancelAllIdleSummaries/.test(mainSrc),
        'main.js setShutdownDeps(...) call must include cancelAllIdleSummaries');
});

test('drift: stripJsComments actually removes comments without breaking strings', () => {
    // Sanity check on the helper itself — without this the other
    // drift guards' "comment immunity" claim is unverified. If
    // stripping breaks, the rest of the suite would still pass on
    // raw source and silently lose the immunity.
    const sample = `
        // line comment with setInterval(saveDatabase, 60000)
        const x = 1; /* block comment with cancelIdleSummary(chatId) */
        const sig = process.on('SIGTERM', () => {});
        const tpl = \`/* not a comment */ literal\`;
        function liveCall() { cancelIdleSummary(99); }
    `;
    const stripped = stripJsComments(sample);
    // Comments removed.
    assert.ok(!/setInterval\(saveDatabase, 60000\)/.test(stripped),
        'line comment content removed');
    assert.ok(!/cancelIdleSummary\(chatId\)/.test(stripped),
        'block comment content removed');
    // Strings preserved (the SIGTERM drift guard depends on this).
    assert.ok(/'SIGTERM'/.test(stripped),
        'string literal SIGTERM preserved');
    assert.ok(/literal/.test(stripped),
        'template literal body preserved');
    assert.ok(/not a comment/.test(stripped),
        'block-comment-looking content INSIDE a template literal is preserved');
    // Live calls preserved.
    assert.ok(/cancelIdleSummary\(99\)/.test(stripped),
        'live function call preserved');
});

run();
