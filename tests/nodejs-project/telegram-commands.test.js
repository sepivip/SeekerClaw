#!/usr/bin/env node
// telegram-commands.test.js — tests for the shared Telegram command
// registry in telegram-commands.js.
//
// Run:  node tests/nodejs-project/telegram-commands.test.js
// Exit: 0 = all pass, 1 = at least one failure.
//
// WHY THIS FILE EXISTS
// --------------------
// telegram-commands.js is the single source of truth for slash command
// discoverability — setMyCommands (both full and fallback payloads) and
// /help body all read from it. The drift-guard at the bottom verifies
// that every registered command has a matching `case '/<name>':` branch
// in message-handler.js's handleCommand. That's the one invariant that
// matters: if someone adds a command to the registry but forgets the
// handler, or adds a handler but forgets the registry, this test fails
// immediately instead of the bug sneaking through to device testing.
//
// Discovered the hard way in PR #339: /model and /provider handlers
// shipped without corresponding setMyCommands entries, so Telegram's
// `/` autocomplete didn't surface them. The CLAUDE.md rule addresses
// the "remember to update both" problem via documentation; this test
// enforces it via tooling.

'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');

const tc = require('../../app/src/main/assets/nodejs-project/telegram-commands');

const MESSAGE_HANDLER_JS = path.join(__dirname, '..', '..', 'app', 'src',
    'main', 'assets', 'nodejs-project', 'message-handler.js');

const tests = [];
function t(name, fn) { tests.push([name, fn]); }

t('COMMAND_REGISTRY is a non-empty array', () => {
    assert.ok(Array.isArray(tc.COMMAND_REGISTRY));
    assert.ok(tc.COMMAND_REGISTRY.length > 0);
});

t('every registry entry has name + description as non-blank strings', () => {
    for (const entry of tc.COMMAND_REGISTRY) {
        assert.ok(typeof entry.name === 'string' && entry.name.length > 0,
            `entry missing name: ${JSON.stringify(entry)}`);
        assert.ok(typeof entry.description === 'string' && entry.description.length > 0,
            `entry missing description: ${JSON.stringify(entry)}`);
        // Telegram's BotFather only allows command names that start with
        // a lowercase letter and then contain only lowercase letters,
        // digits, or underscores.
        assert.ok(/^[a-z][a-z0-9_]*$/.test(entry.name),
            `invalid command name '${entry.name}' (must start with a lowercase letter and contain only lowercase letters, digits, or underscores)`);
    }
});

t('no duplicate command names', () => {
    const names = tc.COMMAND_REGISTRY.map((c) => c.name);
    const unique = new Set(names);
    assert.strictEqual(names.length, unique.size, `duplicate names in registry: ${names}`);
});

t('telegramCommandMenu() returns {command, description} shape', () => {
    const menu = tc.telegramCommandMenu();
    assert.strictEqual(menu.length, tc.COMMAND_REGISTRY.length);
    for (const m of menu) {
        assert.deepStrictEqual(Object.keys(m).sort(), ['command', 'description']);
    }
});

t('telegramFallbackMenu() is a subset of full menu', () => {
    const fallback = tc.telegramFallbackMenu();
    const fallbackNames = new Set(fallback.map((c) => c.command));
    const allNames = new Set(tc.COMMAND_REGISTRY.map((c) => c.name));
    for (const n of fallbackNames) {
        assert.ok(allNames.has(n), `fallback has ${n} but registry doesn't`);
    }
    // Some commands should be in fallback (defensive — not zero).
    assert.ok(fallback.length > 0);
    // Fallback shouldn't exceed full menu size.
    assert.ok(fallback.length <= tc.COMMAND_REGISTRY.length);
});

t('buildHelpLines() excludes self-referential entries (/help and /commands)', () => {
    const lines = tc.buildHelpLines();
    for (const line of lines) {
        assert.ok(!/^\/help\b/.test(line), `/help excludes itself; found: ${line}`);
        assert.ok(!/^\/commands\b/.test(line), `/commands excludes itself; found: ${line}`);
    }
});

t('buildHelpLines() covers every non-self-ref registry entry', () => {
    const lines = tc.buildHelpLines();
    const nonSelfRefCount = tc.COMMAND_REGISTRY
        .filter((c) => c.name !== 'help' && c.name !== 'commands')
        .length;
    assert.strictEqual(lines.length, nonSelfRefCount);
});

// Commands that live as `case '/<name>':` in message-handler.js but
// intentionally stay out of the registry. These are either aliases
// for another command (stacked cases sharing a body) or handlers
// that predate the registry and aren't user-facing discoverable
// commands (yet). If you add a new command, PREFER adding it to the
// registry unless there's a specific reason not to — unfielded
// commands are undiscoverable.
const HANDLERS_NOT_IN_REGISTRY = new Set([
    'start',     // Telegram sends /start on first-contact; not useful as a menu item
    'skills',    // alias — shares body with /skill
]);

// Scan message-handler.js for every `case '/<name>':` once, reuse
// below for both drift directions.
function extractCaseBranches() {
    const src = fs.readFileSync(MESSAGE_HANDLER_JS, 'utf8');
    const re = /case\s*['"]\/([a-z][a-z0-9_]*)['"]\s*:/g;
    const names = new Set();
    let m;
    while ((m = re.exec(src)) !== null) {
        names.add(m[1]);
    }
    return names;
}

t('DRIFT-GUARD A: every registered command has a case branch in message-handler.js', () => {
    // If someone adds a command to the registry (exposing it in /help +
    // setMyCommands) but forgets the handler, Telegram will show "/foo"
    // in autocomplete, the user will type it, and the dispatcher will
    // fall through to chat() — the agent will get a confused message
    // starting with "/foo ...". Fail the build loudly instead.
    const caseBranches = extractCaseBranches();
    for (const entry of tc.COMMAND_REGISTRY) {
        assert.ok(caseBranches.has(entry.name),
            `Registered command '/${entry.name}' has no \`case '/${entry.name}':\` branch in message-handler.js. ` +
            `Add the handler or remove the registry entry.`);
    }
});

t('DRIFT-GUARD B: every case branch is in the registry or the allow-list', () => {
    // The inverse: if someone adds a `case '/foo':` handler but
    // forgets the registry entry, /foo will work if typed but won't
    // appear in /help or the `/` autocomplete menu — the exact bug
    // that motivated this whole refactor (PR #339). Allow-list via
    // HANDLERS_NOT_IN_REGISTRY covers aliases / Telegram built-ins.
    const caseBranches = extractCaseBranches();
    const registered = new Set(tc.COMMAND_REGISTRY.map((c) => c.name));
    for (const branch of caseBranches) {
        if (registered.has(branch)) continue;
        if (HANDLERS_NOT_IN_REGISTRY.has(branch)) continue;
        assert.fail(
            `Handler \`case '/${branch}':\` exists in message-handler.js but /${branch} is not in COMMAND_REGISTRY. ` +
            `Users won't see it in /help or '/' autocomplete. Either add it to the registry, or add '${branch}' to HANDLERS_NOT_IN_REGISTRY if it's intentionally undocumented.`
        );
    }
});

// --- runner ---
let passed = 0, failed = 0;
for (const [name, fn] of tests) {
    try { fn(); console.log(`  ok  ${name}`); passed++; }
    catch (e) { console.error(`  FAIL ${name}\n    ${e.message}`); failed++; }
}
console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed === 0 ? 0 : 1);
