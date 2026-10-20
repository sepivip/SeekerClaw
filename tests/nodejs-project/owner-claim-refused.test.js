#!/usr/bin/env node
// owner-claim-refused.test.js — BAT-1409 P1-D (Node side). When the app refuses an owner claim
// over the bridge (409 owner_already_set / inactive_channel, 400 bad_channel), Node reverts the
// in-memory claim and never says "Owner set". A different-owner refusal is silent; an inactive
// channel gets one reply per process. Negative control: a bridge that is merely unavailable keeps
// today's behaviour (claim kept in memory, "persistence failed" reply).
//
// Run:  node tests/nodejs-project/owner-claim-refused.test.js

'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const BUNDLE = path.resolve(__dirname, '..', '..', 'app', 'src', 'main', 'assets', 'nodejs-project');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'p1d-'));
fs.writeFileSync(path.join(tmp, 'config.json'), JSON.stringify({ botToken: 'placeholder', anthropicApiKey: 'placeholder', ownerId: '', channel: 'telegram' }));
process.argv[2] = tmp;
process.on('exit', () => { try { fs.rmSync(tmp, { recursive: true, force: true }); } catch (_) {} });

const mh = require(path.join(BUNDLE, 'message-handler.js'));

let failures = 0;
async function check(label, fn) {
    try {
        await fn();
        console.log('PASS: ' + label);
    } catch (e) {
        console.log('FAIL: ' + label + ' — ' + (e && e.message));
        failures++;
    }
}

function harness(bridgeReply) {
    const state = { owner: '', sent: [], logs: [], bridgeCalls: 0 };
    mh.init({
        getOwnerId: () => state.owner,
        setOwnerId: (id) => { state.owner = id; },
        log: (m, lvl) => state.logs.push(`${lvl || 'INFO'} ${m}`),
        androidBridgeCall: async (endpoint, body) => {
            state.bridgeCalls++;
            assert.strictEqual(endpoint, '/config/save-owner');
            assert.strictEqual(body.channel, 'telegram');
            return bridgeReply;
        },
        sendMessage: async (chatId, text) => { state.sent.push(text); },
    });
    return state;
}

async function message(senderId) {
    try {
        await mh.handleMessage({ chatId: 'c1', senderId, text: 'hi', messageId: 1 });
    } catch (_) {
        // Past the owner gate the handler needs the full agent; only the claim is under test.
    }
}

(async () => {
    await check('a different owner already set: claim reverted, no reply', async () => {
        const s = harness({ error: 'owner already set', code: 'owner_already_set' });
        await message('stranger');
        assert.strictEqual(s.owner, '');
        assert.deepStrictEqual(s.sent, []);
        assert.ok(s.logs.some((l) => l.startsWith('WARN') && l.includes('owner_already_set')));
    });
    await check('inactive channel: claim reverted and one reply per process', async () => {
        const s = harness({ error: 'channel changed; restart required', code: 'inactive_channel' });
        await message('u1');
        await message('u1');
        assert.strictEqual(s.owner, '');
        assert.deepStrictEqual(s.sent, ['Channel changed in Settings — restart SeekerClaw to finish.']);
        assert.strictEqual(s.bridgeCalls, 2);
    });
    await check('bad channel: claim reverted, no reply', async () => {
        const s = harness({ error: 'unknown channel', code: 'bad_channel' });
        await message('u2');
        assert.strictEqual(s.owner, '');
        assert.deepStrictEqual(s.sent, []);
    });
    await check('an unreadable owner record: claim refused, no reply', async () => {
        const s = harness({ error: 'Owner record unreadable', code: 'owner_unreadable' });
        await message('u5');
        assert.strictEqual(s.owner, '');
        assert.deepStrictEqual(s.sent, []);
    });
    await check('the owner is set only after the app accepts (never during the bridge call)', async () => {
        const s = harness({ success: true });
        let ownerDuringCall = 'unset';
        mh.init({
            getOwnerId: () => s.owner,
            setOwnerId: (id) => { s.owner = id; },
            log: () => {},
            androidBridgeCall: async () => { ownerDuringCall = s.owner; return { success: true }; },
            sendMessage: async (c, t) => { s.sent.push(t); },
        });
        await message('u6');
        assert.strictEqual(ownerDuringCall, '');
        assert.strictEqual(s.owner, 'u6');
    });
    await check('two quick messages make one claim and one "Owner set" reply', async () => {
        const s = { owner: '', sent: [], calls: 0 };
        mh.init({
            getOwnerId: () => s.owner,
            setOwnerId: (id) => { s.owner = id; },
            log: () => {},
            androidBridgeCall: async () => { s.calls++; await new Promise((r) => setTimeout(r, 50)); return { success: true }; },
            sendMessage: async (c, t) => { s.sent.push(t); },
        });
        await Promise.all([message('u7'), message('u7'), message('stranger2')]);
        assert.strictEqual(s.calls, 1);
        assert.strictEqual(s.owner, 'u7');
        assert.strictEqual(s.sent.filter((t) => t.startsWith('Owner set')).length, 1);
    });
    await check('every refusal code Node reverts on is one the bridge returns (OwnerClaimPolicy.response)', () => {
        // The bridge's reply for each decision lives in OwnerClaimPolicy.response, which
        // AndroidBridge.handleConfigSaveOwner returns (pinned by OwnerClaimPolicyTest).
        const kt = fs.readFileSync(path.resolve(BUNDLE, '..', '..', 'java', 'com', 'seekerclaw', 'app', 'bridge', 'OwnerClaimPolicy.kt'), 'utf8');
        const js = fs.readFileSync(path.join(BUNDLE, 'message-handler.js'), 'utf8');
        const set = js.match(/OWNER_CLAIM_REFUSED = new Set\(\[([^\]]*)\]\)/);
        assert.ok(set, 'OWNER_CLAIM_REFUSED found');
        const codes = [...set[1].matchAll(/'([a-z_]+)'/g)].map((m) => m[1]);
        assert.deepStrictEqual(codes.sort(), ['bad_channel', 'inactive_channel', 'owner_already_set', 'owner_unreadable']);
        for (const c of codes) assert.ok(kt.includes(`"code" to "${c}"`), `OwnerClaimPolicy.response returns ${c}`);
    });
    await check('negative control: an unavailable bridge keeps the claim and says persistence failed', async () => {
        const s = harness({ error: 'Android Bridge unavailable: connect ECONNREFUSED' });
        await message('u3');
        assert.strictEqual(s.owner, 'u3');
        assert.ok(s.sent.some((t) => t.includes('persistence failed')));
        assert.ok(!s.sent.some((t) => t.includes('Only you can use this bot')));
    });
    await check('negative control: an accepted claim says Owner set', async () => {
        const s = harness({ success: true });
        await message('u4');
        assert.strictEqual(s.owner, 'u4');
        assert.ok(s.sent.some((t) => t.startsWith('Owner set to your account (u4)')));
    });

    if (failures > 0) {
        console.log(`\n${failures} failure(s)`);
        process.exit(1);
    }
    console.log('\nAll owner-claim refusal checks passed.');
    process.exit(0);
})();
