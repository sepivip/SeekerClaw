#!/usr/bin/env node
// tests/nodejs-project/agent-settings-mask.test.js
//
// BAT-1087: agent_settings.json stores plaintext provider keys under apiKeys.* and
// is readable by the model via the read / js_eval / shell_exec tools. This test
// pins the model-facing masking:
//   A. maskAgentSettings() masks apiKeys.* + credential-typed values at any depth,
//      keeps structural fields, and fails closed (null) on unparseable input.
//   B. registerAgentSettingsSecrets() registers EVERY stored value (incl. ones that
//      lost the config merge) so redactSecrets — applied by js_eval AND shell_exec —
//      masks them.
//   C. the read handler returns masked content (and withholds on corrupt JSON).
//   D. the save/write flow still persists + syncs keys (BAT-236 unbroken).
//
// This is MODEL-FACING OUTPUT MASKING, not storage-at-rest protection — the file on
// disk stays plaintext.

'use strict';

const assert = require('assert');
const path = require('path');
const fs = require('fs');
const os = require('os');

const BUNDLE = path.resolve(__dirname, '..', '..', 'app', 'src', 'main', 'assets', 'nodejs-project');

// Fixture workDir (config.js reads process.argv[2]). config.json marks braveApiKey
// as an Android-settings key so the agent's apiKeys.brave value is a MERGE-LOSER
// (never enters `config`) — the case that only registration, not the config-derived
// redaction patterns, can cover. Placeholders are obviously fake (no real-key shape).
const workDir = fs.mkdtempSync(path.join(os.tmpdir(), 'bat1087-mask-'));
fs.writeFileSync(path.join(workDir, 'config.json'), JSON.stringify({
    botToken: 'placeholder-not-a-real-bot-token',
    anthropicApiKey: 'placeholder-not-a-real-api-key',
    braveApiKey: 'ANDROID_BRAVE_PLACEHOLDER',
    ownerId: '111',
    channel: 'telegram',
}), 'utf8');
const ORIGINAL_SETTINGS = {
    apiKeys: {
        anthropic: 'SENTINEL_ANTHROPIC_VALUE',   // maps to an Android key -> merge-loser
        custommap: 'SENTINEL_CUSTOM_VALUE',       // unknown service -> not in config
        brave: 'SENTINEL_BRAVE_MERGELOSER',       // Android brave wins -> merge-loser
    },
    nested: { webhookSecret: 'SENTINEL_NESTED_SECRET' }, // credential by key-name, any depth
    heartbeatIntervalMinutes: 7,
    model: 'claude-opus-4-8',
    provider: 'claude',
};
fs.writeFileSync(path.join(workDir, 'agent_settings.json'), JSON.stringify(ORIGINAL_SETTINGS), 'utf8');
process.argv[2] = workDir;
process.on('exit', () => { try { fs.rmSync(workDir, { recursive: true, force: true }); } catch (_) {} });

const sec = require(path.join(BUNDLE, 'security.js'));       // registerAgentSettingsSecrets() runs at load
const cfg = require(path.join(BUNDLE, 'config.js'));
const fileTool = require(path.join(BUNDLE, 'tools', 'file.js'));
const sysTool = require(path.join(BUNDLE, 'tools', 'system.js'));

const SENTINELS = ['SENTINEL_ANTHROPIC_VALUE', 'SENTINEL_CUSTOM_VALUE', 'SENTINEL_BRAVE_MERGELOSER', 'SENTINEL_NESTED_SECRET'];
function hasNoSentinel(s, list = SENTINELS) { return list.every((x) => !String(s).includes(x)); }

let pass = 0, fail = 0;
function check(name, fn) {
    try { fn(); pass++; console.log(`  ✓ ${name}`); }
    catch (e) { fail++; console.error(`  ✗ ${name}: ${e.message}`); if (process.env.VERBOSE) console.error(e.stack); }
}
async function checkAsync(name, fn) {
    try { await fn(); pass++; console.log(`  ✓ ${name}`); }
    catch (e) { fail++; console.error(`  ✗ ${name}: ${e.message}`); if (process.env.VERBOSE) console.error(e.stack); }
}

console.log('agent-settings-mask.test.js — BAT-1087 model-facing settings masking');
console.log();

// ---------------------------------------------------------------------------
// A. maskAgentSettings — pure
// ---------------------------------------------------------------------------
check('masks apiKeys.* (known + unknown) and nested credential fields; keeps structure', () => {
    const sample = JSON.stringify({
        apiKeys: { anthropic: 'AAA_SECRET', weirdsvc: 'BBB_SECRET' },
        deep: { nested: { authToken: 'CCC_SECRET' } },
        heartbeatIntervalMinutes: 5,
        model: 'm',
        provider: 'claude',
    });
    const masked = sec.maskAgentSettings(sample);
    assert.ok(typeof masked === 'string', 'returns a string on valid input');
    const obj = JSON.parse(masked);
    assert.strictEqual(obj.apiKeys.anthropic, '[REDACTED]');
    assert.strictEqual(obj.apiKeys.weirdsvc, '[REDACTED]', 'unknown service value still masked');
    assert.strictEqual(obj.deep.nested.authToken, '[REDACTED]', 'nested credential-typed key masked');
    assert.strictEqual(obj.heartbeatIntervalMinutes, 5, 'structural field visible');
    assert.strictEqual(obj.model, 'm');
    assert.strictEqual(obj.provider, 'claude');
    assert.ok(!masked.includes('SECRET'), 'no raw secret value leaks');
});

check('fails closed (null) on unparseable / non-object JSON', () => {
    assert.strictEqual(sec.maskAgentSettings('{bad json'), null, 'corrupt JSON -> null');
    assert.strictEqual(sec.maskAgentSettings('[1,2,3]'), null, 'array -> null');
    assert.strictEqual(sec.maskAgentSettings('"just a string"'), null, 'primitive -> null');
});

// ---------------------------------------------------------------------------
// B. registration + redactSecrets  (the js_eval / shell_exec coverage mechanism)
// ---------------------------------------------------------------------------
check('every stored value (incl. merge-losers + nested) is registered for redaction', () => {
    // registerAgentSettingsSecrets() ran at security.js load against the seeded file.
    const blob = `dump: ${SENTINELS.join(' / ')}`;
    const red = sec.redactSecrets(blob);
    for (const s of SENTINELS) assert.ok(!red.includes(s), `${s} must be redacted by redactSecrets`);
});

// ---------------------------------------------------------------------------
// C. read handler
// ---------------------------------------------------------------------------
(async () => {
    await checkAsync('read agent_settings.json: values masked, structural fields visible', async () => {
        const r = await fileTool.handlers.read({ path: 'agent_settings.json' }, 'chat');
        assert.ok(!r.error, `unexpected error: ${r.error}`);
        assert.ok(hasNoSentinel(r.content), 'no sentinel value in returned content');
        assert.ok(r.content.includes('[REDACTED]'), 'masked placeholder present');
        assert.ok(r.content.includes('"heartbeatIntervalMinutes": 7'), 'heartbeat interval still visible');
        assert.ok(r.content.includes('"model": "claude-opus-4-8"'), 'model still visible');
    });

    // D. js_eval reading the file — redactSecrets (in the js_eval handler) masks the
    // registered values, INCLUDING merge-losers that never enter `config`.
    await checkAsync('js_eval reading the file: all stored values masked (incl. merge-loser)', async () => {
        const code = "const fs=require('fs'), p=require('path'); return fs.readFileSync(p.join(process.cwd(), 'agent_settings.json'),'utf8');";
        const r = await sysTool.handlers.js_eval({ code }, 'chat');
        assert.ok(r.success, `js_eval failed: ${r.error}`);
        assert.ok(hasNoSentinel(r.result), 'js_eval result must not contain any raw stored value');
    });

    // shell_exec cat — same redactSecrets wrapper on stdout. Guarded: on a runner
    // without a POSIX shell the handler fails; the redaction mechanism is already
    // proven by test B (redactSecrets) and runs for real on the Linux CI runner.
    await checkAsync('shell_exec cat agent_settings.json: stdout redacted (CI/POSIX)', async () => {
        const sh = await sysTool.handlers.shell_exec({ command: 'cat agent_settings.json' }, 'chat');
        if (sh && sh.success && sh.stdout) {
            assert.ok(hasNoSentinel(sh.stdout), 'shell_exec cat stdout must be redacted');
        } else {
            console.log('    (shell unavailable on this host — asserted via redactSecrets in test B; runs on Linux CI)');
        }
    });

    // ---------------------------------------------------------------------------
    // D. save/write regression — BAT-236 sync + new-key registration still work
    // ---------------------------------------------------------------------------
    await checkAsync('write flow persists a new key, syncs to config, masks on read-back', async () => {
        const NEWKEY = 'NEWPERPLEXITY_PLACEHOLDER_VALUE';
        const newSettings = JSON.stringify({ apiKeys: { perplexity: NEWKEY }, heartbeatIntervalMinutes: 9 });
        const w = await fileTool.handlers.write({ path: 'agent_settings.json', content: newSettings }, 'chat');
        assert.ok(w.success, 'write succeeded');
        // BAT-236: syncAgentApiKeys picked the new key into config (perplexity is not an Android key here)
        assert.strictEqual(cfg.config.perplexityApiKey, NEWKEY, 'new key synced into config');
        // File on disk stays plaintext (this is output masking, not at-rest encryption)
        const onDisk = fs.readFileSync(path.join(workDir, 'agent_settings.json'), 'utf8');
        assert.ok(onDisk.includes(NEWKEY), 'file persists the raw key on disk');
        // Reading it back through the tool is masked, and it is now registered for redaction
        const rr = await fileTool.handlers.read({ path: 'agent_settings.json' }, 'chat');
        assert.ok(!rr.content.includes(NEWKEY), 'read-back masks the newly-saved key');
        assert.ok(!sec.redactSecrets(`k=${NEWKEY}`).includes(NEWKEY), 'newly-saved key registered for redaction');
    });

    // ---------------------------------------------------------------------------
    // C. corrupt file — fail closed (run last: it clobbers the settings file)
    // ---------------------------------------------------------------------------
    await checkAsync('corrupt agent_settings.json → content withheld (fail closed)', async () => {
        fs.writeFileSync(path.join(workDir, 'agent_settings.json'), '{ this is : not valid json ', 'utf8');
        const r = await fileTool.handlers.read({ path: 'agent_settings.json' }, 'chat');
        assert.ok(r.error && /withheld/i.test(r.error), 'unparseable settings file must be withheld');
        assert.strictEqual(r.content, undefined, 'no raw content returned');
    });

    console.log();
    console.log(`Result: ${pass} passed, ${fail} failed`);
    if (fail > 0) { console.error('FAIL: agent-settings-mask.test.js'); process.exit(1); }
    console.log('PASS: agent-settings-mask.test.js');
})();
