'use strict';
// BAT-1067 — confirmation-UX regression tests.
//  Part 1: static drift-guard — fund-moving prompt/tool descriptions must NOT
//          tell the agent to run its OWN confirmation (the system gate owns it),
//          and the inline-keyboard door must not demonstrate a Confirm/Cancel pair.
//  Part 2: telegram_send deterministic guard — a button whose callback/label is a
//          confirm/approve/cancel of a FUND action is rejected (confirmation_buttons_not_allowed);
//          navigation buttons are unaffected.

const assert = require('assert');
const path = require('path');
const fs = require('fs');

const BUNDLE = path.resolve(__dirname, '..', '..', 'app', 'src', 'main', 'assets', 'nodejs-project');

let pass = 0, fail = 0;
async function check(name, fn) {
    try { await fn(); console.log('  ✓ ' + name); pass++; }
    catch (e) { console.log('  ✗ ' + name + '\n    ' + (e && e.message)); fail++; }
}

// ── Part 1: static drift-guard ────────────────────────────────────────────
const aiSrc = fs.readFileSync(path.join(BUNDLE, 'ai.js'), 'utf8');
const solSrc = fs.readFileSync(path.join(BUNDLE, 'tools', 'solana.js'), 'utf8');

async function runStatic() {
    await check('drift: no "ALWAYS confirm with the user" in ai.js or tools/solana.js', () => {
        assert.ok(!/ALWAYS confirm with the user/i.test(aiSrc), 'ai.js still says ALWAYS confirm with the user');
        assert.ok(!/ALWAYS confirm with the user/i.test(solSrc), 'tools/solana.js still says ALWAYS confirm with the user');
    });
    await check('drift: no "confirm in chat before calling" in ai.js or tools/solana.js', () => {
        assert.ok(!/confirm in chat before calling/i.test(aiSrc), 'ai.js stale self-confirm phrase');
        assert.ok(!/confirm in chat before calling/i.test(solSrc), 'tools/solana.js stale self-confirm phrase');
    });
    await check('drift: ai.js swap workflow no longer says "confirming the quote with the user"', () => {
        assert.ok(!/confirm(ing)? the quote with the user/i.test(aiSrc), 'ai.js swap workflow still self-confirms');
    });
    await check('drift: inline-keyboard door no longer demonstrates a ✅Confirm/❌Cancel pair', () => {
        const i = aiSrc.indexOf('Inline keyboard buttons');
        assert.ok(i !== -1, 'inline-keyboard door missing');
        // BAT-1071: bound the slice to the door's OWN lines.push(...) string
        // (up to the next lines.push) rather than a brittle fixed char window —
        // a magic 1400 could capture a later push's example or miss content.
        const next = aiSrc.indexOf('lines.push(', i + 1);
        // Fail fast if the terminator is missing — otherwise the slice would run
        // to EOF and unrelated later content could make this drift guard flaky.
        assert.ok(next !== -1, 'door terminator missing (no lines.push after the inline-keyboard door)');
        const door = aiSrc.slice(i, next);
        assert.ok(!/"callback_data":\s*"(yes|no)"/i.test(door), 'door still uses a yes/no confirm example');
        assert.ok(!(/✅\s*Confirm/.test(door) && /❌\s*Cancel/.test(door)), 'door still shows a Confirm/Cancel pair example');
    });
    await check('drift: canonical "Tool Confirmation Gates" section forbids self-confirm + own buttons', () => {
        assert.ok(/Tool Confirmation Gates/.test(aiSrc), 'gates section missing');
        assert.ok(/must NOT\) ask for confirmation yourself|must NOT.*ask for confirmation|do NOT need to \(and must NOT\) ask/i.test(aiSrc), 'gates section missing no-self-confirm rule');
        assert.ok(/do NOT attach your own Confirm\/Approve\/Cancel\/Retry inline buttons/i.test(aiSrc), 'gates section missing no-own-buttons rule');
    });
}

// ── Part 2: telegram_send guard (load tools/telegram.js with mocked transport) ──
function setupMocks() {
    const cfgPath = require.resolve(path.join(BUNDLE, 'config.js'));
    require.cache[cfgPath] = { id: cfgPath, filename: cfgPath, loaded: true, exports: { log: () => {} } };
    const secPath = require.resolve(path.join(BUNDLE, 'security.js'));
    require.cache[secPath] = { id: secPath, filename: secPath, loaded: true, exports: { safePath: (p) => p, redactSecrets: (s) => s } };
    const tgPath = require.resolve(path.join(BUNDLE, 'telegram.js'));
    require.cache[tgPath] = {
        id: tgPath, filename: tgPath, loaded: true,
        exports: {
            telegram: async () => ({ ok: true, result: { message_id: 42 } }),
            telegramSendFile: async () => ({ ok: true }),
            detectTelegramFileType: () => 'document',
            cleanResponse: (t) => t,
            toTelegramHtml: (t) => t,
            stripMarkdown: (t) => t,
            recordSentMessage: () => {},
            // BAT-1050: telegram_send now shares richTrySend + classifyTelegramOutcome
            // and the 32768-byte budget. Rich off here (delivered:false) -> classic path.
            richTrySend: async () => ({ delivered: false }),
            classifyTelegramOutcome: (result, error) => error ? { verdict: 'uncertain' } : (result && result.ok ? { verdict: 'ok' } : { verdict: 'fallback' }),
            RICH_MAX_BYTES: 32768,
        },
    };
}

async function runGuard() {
    setupMocks();
    const { handlers } = require(path.join(BUNDLE, 'tools', 'telegram.js'));
    const CHAT = '12345';
    const send = (buttons) => handlers.telegram_send({ text: 'msg', buttons }, CHAT);
    const REJECT = 'confirmation_buttons_not_allowed';

    // Rejected: confirm/approve/cancel of a fund action (the observed device cases)
    for (const cb of ['confirm_swap', 'confirm_usdc_send', 'confirm_pyusd_swap', 'confirm_swap_back', 'approve_send', 'cancel_order', 'retry_swap', 'confirm_pyusd_retry']) {
        await check(`guard: rejects callback_data "${cb}"`, async () => {
            const r = await send([[{ text: 'tap', callback_data: cb }]]);
            assert.strictEqual(r.error, REJECT, JSON.stringify(r));
        });
    }
    await check('guard: rejects "✅ Confirm" label even with a benign callback (text is fund-confirm)', async () => {
        const r = await send([[{ text: '✅ Confirm swap', callback_data: 'do_it' }]]);
        assert.strictEqual(r.error, REJECT, JSON.stringify(r));
    });

    // Allowed: navigation / non-fund buttons reach the transport (mock → ok)
    await check('guard: allows navigation button "show_more"', async () => {
        const r = await send([[{ text: '📊 Show more', callback_data: 'show_more' }]]);
        assert.ok(!r.error, `navigation button must not be rejected: ${JSON.stringify(r)}`);
        assert.ok(r.ok, JSON.stringify(r));
    });
    await check('guard: allows "pick_token" (fund keyword but NO confirm verb → not a confirmation)', async () => {
        const r = await send([[{ text: 'USDC', callback_data: 'pick_token_usdc' }]]);
        assert.ok(!r.error, `pick-token button must not be rejected: ${JSON.stringify(r)}`);
        assert.ok(r.ok, JSON.stringify(r));
    });
    await check('guard: allows a bare "cancel" (confirm verb but NO fund keyword)', async () => {
        const r = await send([[{ text: 'Cancel', callback_data: 'cancel' }]]);
        assert.ok(!r.error, `bare cancel must not be rejected: ${JSON.stringify(r)}`);
        assert.ok(r.ok, JSON.stringify(r));
    });
}

(async () => {
    await runStatic();
    await runGuard();
    console.log('');
    if (fail > 0) { console.log(`FAIL: confirmation-buttons-guard.test.js (${fail} failed, ${pass} passed)`); process.exit(1); }
    console.log(`PASS: confirmation-buttons-guard.test.js (${pass} checks).`);
})();
