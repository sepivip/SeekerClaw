#!/usr/bin/env node
// think-command.test.js — pin BAT-549 Commit 4 /think Telegram command
// invariants:
//
//  - No-args path returns multi-line status display (current state of all
//    3 toggles + active model + reasoningSupport tri-state)
//  - /think on / off / show / hide each writes RuntimeState exactly one
//    field; preserves all other fields via the partial-update merge in
//    runtime-state.js
//  - Unknown subcommand returns an error with usage hint
//  - Drift-guard test (telegram-commands.test.js) catches the registry
//    entry but not the handler's behavior — that's what this file does
//
// Run:  node tests/nodejs-project/think-command.test.js

'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');

// Stub out config.js + main.js dependencies BEFORE requiring message-handler
const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'bat549-think-'));
const workDir = path.join(tmpRoot, 'workspace');
fs.mkdirSync(workDir, { recursive: true });

// Seed runtime_state.json with a known starting state
const rtFile = path.join(tmpRoot, 'runtime_state.json');
fs.writeFileSync(rtFile, JSON.stringify({
    provider: 'claude',
    authType: 'api_key',
    model: 'claude-opus-4-7',
    reasoningEnabled: false,
    reasoningDisplayInChat: false,
    customEchoReasoning: false,
    customConfigSignature: null,
}, null, 2), 'utf8');

const runtimeStateModule = require('../../app/src/main/assets/nodejs-project/runtime-state');
const _runtimeState = runtimeStateModule.open(workDir);

// Mock config.js exports (message-handler imports a lot of names from config)
const configPath = path.resolve(__dirname, '../../app/src/main/assets/nodejs-project/config.js');
require.cache[configPath] = {
    id: configPath, filename: configPath, loaded: true,
    exports: {
        log: () => {},
        CHANNEL: 'telegram',
        workDir,
        PROVIDER: 'claude',
        AUTH_TYPE: 'api_key',
        OPENAI_AUTH_TYPE: 'api_key',
        resolveActiveModel: () => 'claude-opus-4-7',
        runtimeState: _runtimeState,
        config: {},
    },
};

// Stub other modules message-handler depends on
const stubModule = (relPath, exports) => {
    const fullPath = path.resolve(__dirname, '../../app/src/main/assets/nodejs-project', relPath);
    require.cache[fullPath] = { id: fullPath, filename: fullPath, loaded: true, exports };
};
stubModule('telegram.js', { sendTyping: async () => {}, sentMessageCache: new Map(), SENT_CACHE_TTL: 60000 });
stubModule('discord.js', {});
stubModule('channel.js', { sendMessage: async () => {} });
stubModule('skills.js', { findRelevantSkill: () => null });
stubModule('mcp-client.js', { MCPManager: class {} });
stubModule('database.js', { getDb: () => null });
stubModule('memory.js', {});
stubModule('cron.js', {});
stubModule('quick-actions.js', {});
stubModule('repetition-detector.js', {});
stubModule('task-store.js', { listOpenCheckpoints: () => [] });
stubModule('security.js', { redactSecrets: (s) => s });
stubModule('bridge.js', { androidBridgeCall: async () => ({}) });
stubModule('http.js', {});

// Now load message-handler
const messageHandler = require('../../app/src/main/assets/nodejs-project/message-handler');

// init the handler with the deps it expects
messageHandler.init({
    log: () => {},
    androidBridgeCall: async () => ({}),
    addToConversation: () => {},
    chatQueues: new Map(),
    getTools: () => [],
    aiChat: async () => '',
});

let failures = 0;
function ok(label, cond, hint = '') {
    if (cond) console.log(`PASS: ${label}`);
    else { console.log(`FAIL: ${label}${hint ? ' — ' + hint : ''}`); failures++; }
}

// ── /think with no args → status display ──

(async () => {
    const reply = await messageHandler.handleCommand('123', '/think', '', null);
    ok('no-args: returns a status string', typeof reply === 'string' && reply.length > 0);
    ok('no-args: includes "Reasoning state" header',
        typeof reply === 'string' && reply.includes('Reasoning state'));
    ok('no-args: shows extended thinking line',
        typeof reply === 'string' && reply.includes('Extended thinking'));
    ok('no-args: shows display-in-chat line',
        typeof reply === 'string' && reply.includes('Display in chat'));
    ok('no-args: shows active model',
        typeof reply === 'string' && reply.includes('claude-opus-4-7'));
    ok('no-args: shows reasoningSupport tri-state',
        typeof reply === 'string' && /reasoningSupport=(yes|no|unknown)/.test(reply));

    // ── /think on → reasoningEnabled=true, others preserved ──
    const onReply = await messageHandler.handleCommand('123', '/think', 'on', null);
    ok('/think on: success message', typeof onReply === 'string' && onReply.startsWith('✓'));
    const stateAfterOn = _runtimeState.read();
    ok('/think on: reasoningEnabled=true', stateAfterOn.reasoningEnabled === true);
    ok('/think on: reasoningDisplayInChat preserved (false)',
        stateAfterOn.reasoningDisplayInChat === false);
    ok('/think on: customEchoReasoning preserved (false)',
        stateAfterOn.customEchoReasoning === false);
    ok('/think on: customConfigSignature preserved (null)',
        stateAfterOn.customConfigSignature === null);
    ok('/think on: provider preserved', stateAfterOn.provider === 'claude');
    ok('/think on: model preserved', stateAfterOn.model === 'claude-opus-4-7');

    // ── /think show → reasoningDisplayInChat=true, reasoningEnabled stays true ──
    await messageHandler.handleCommand('123', '/think', 'show', null);
    const stateAfterShow = _runtimeState.read();
    ok('/think show: reasoningDisplayInChat=true',
        stateAfterShow.reasoningDisplayInChat === true);
    ok('/think show: reasoningEnabled still true (not clobbered)',
        stateAfterShow.reasoningEnabled === true);

    // ── /think off → reasoningEnabled=false, display preserved ──
    await messageHandler.handleCommand('123', '/think', 'off', null);
    const stateAfterOff = _runtimeState.read();
    ok('/think off: reasoningEnabled=false', stateAfterOff.reasoningEnabled === false);
    ok('/think off: reasoningDisplayInChat preserved (still true)',
        stateAfterOff.reasoningDisplayInChat === true);

    // ── /think hide → reasoningDisplayInChat=false ──
    await messageHandler.handleCommand('123', '/think', 'hide', null);
    const stateAfterHide = _runtimeState.read();
    ok('/think hide: reasoningDisplayInChat=false',
        stateAfterHide.reasoningDisplayInChat === false);

    // ── R21 Copilot: /think echo on / off (per-Custom advanced override) ──
    const echoOnReply = await messageHandler.handleCommand('123', '/think', 'echo on', null);
    const stateAfterEchoOn = _runtimeState.read();
    ok('/think echo on: customEchoReasoning=true',
        stateAfterEchoOn.customEchoReasoning === true);
    // current.provider was 'claude' from setup → message should warn
    ok('/think echo on: warns when not on Custom',
        typeof echoOnReply === 'string' && echoOnReply.includes('only takes effect when provider=custom'));

    await messageHandler.handleCommand('123', '/think', 'echo off', null);
    const stateAfterEchoOff = _runtimeState.read();
    ok('/think echo off: customEchoReasoning=false',
        stateAfterEchoOff.customEchoReasoning === false);

    // ── R23 Copilot: tokenized subcommand parsing tolerates extra whitespace ──
    await messageHandler.handleCommand('123', '/think', '   echo    on   ', null);
    const stateAfterMultiSpace = _runtimeState.read();
    ok('/think echo  on (multi-space): canonicalized → customEchoReasoning=true',
        stateAfterMultiSpace.customEchoReasoning === true);

    await messageHandler.handleCommand('123', '/think', 'echo\non', null);
    const stateAfterNewline = _runtimeState.read();
    ok('/think echo<newline>on: canonicalized → still echo on path',
        stateAfterNewline.customEchoReasoning === true);

    // Reset for downstream assertions
    await messageHandler.handleCommand('123', '/think', 'echo off', null);

    // ── R21 Copilot: status surfaces the third toggle ──
    const statusWithThird = await messageHandler.handleCommand('123', '/think', '', null);
    ok('Status: includes Echo reasoning to gateway line',
        typeof statusWithThird === 'string'
        && statusWithThird.includes('Echo reasoning to gateway'));

    // ── Unknown subcommand → error with usage hint ──
    const errReply = await messageHandler.handleCommand('123', '/think', 'banana', null);
    ok('Unknown subcommand: returns error',
        typeof errReply === 'string' && errReply.startsWith('❌'));
    ok('Unknown subcommand: hints at usage',
        typeof errReply === 'string' && errReply.includes('/think'));

    // ── Status reflects the latest writes ──
    const finalStatus = await messageHandler.handleCommand('123', '/think', '', null);
    ok('Final status: shows on/off correctly after multiple writes',
        typeof finalStatus === 'string'
        && finalStatus.includes('Extended thinking: ✗ off')
        && finalStatus.includes('Display in chat: ✗ off'));

    // Cleanup
    try { fs.rmSync(tmpRoot, { recursive: true, force: true }); } catch (_) {}

    console.log();
    if (failures === 0) {
        console.log('ALL TESTS PASS');
        process.exit(0);
    } else {
        console.log(`${failures} TEST(S) FAILED`);
        process.exit(1);
    }
})();
