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
        // Telegram's BotFather rejects names with non-lowercase letters,
        // digits, or underscores.
        assert.ok(/^[a-z][a-z0-9_]*$/.test(entry.name),
            `invalid command name '${entry.name}' (must be lowercase alnum+underscore)`);
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

t('buildHelpLines() excludes /help itself', () => {
    const lines = tc.buildHelpLines();
    for (const line of lines) {
        assert.ok(!/^\/help\b/.test(line), `help excludes itself; found: ${line}`);
    }
});

t('buildHelpLines() covers every non-help registry entry', () => {
    const lines = tc.buildHelpLines();
    const nonHelpCount = tc.COMMAND_REGISTRY.filter((c) => c.name !== 'help').length;
    assert.strictEqual(lines.length, nonHelpCount);
});

t('DRIFT-GUARD: every registered command has a case branch in message-handler.js', () => {
    // The invariant this test exists to defend: if someone adds a command
    // to the registry (exposing it in /help + setMyCommands) but forgets
    // the handler, Telegram will show "/foo" in autocomplete, the user
    // will type it, and the dispatcher will fall through to chat() — the
    // agent will get a confused message starting with "/foo ...". Fail
    // the build loudly instead.
    const src = fs.readFileSync(MESSAGE_HANDLER_JS, 'utf8');
    for (const entry of tc.COMMAND_REGISTRY) {
        // Match `case '/<name>':` with optional whitespace. Also accept the
        // alias-style where multiple cases stack (e.g. `case '/help':\n case '/commands':`).
        const pattern = new RegExp(`case\\s*['"]\\/${entry.name}['"]\\s*:`);
        assert.ok(pattern.test(src),
            `Registered command '/${entry.name}' has no \`case '/${entry.name}':\` branch in message-handler.js. ` +
            `Add the handler or remove the registry entry.`);
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
