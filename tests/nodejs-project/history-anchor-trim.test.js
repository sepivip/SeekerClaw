'use strict';
// BAT-1186 Stage 1 — pins the INVARIANT, not the line: the in-flight turn's
// user instruction (the "anchor") must survive an arbitrary number of tool
// rounds, non-anchor history must stay <= MAX_HISTORY (additive-exempt, Codex
// R2), and no tool_use/tool_result pair may ever be orphaned (provider-400).
// A negative control reproduces the OLD role-blind loop and asserts it FAILS,
// so a future refactor that reintroduces a head-blind trim breaks this test.
//
// PURE: requires only ./history-trim.js — no ai.js dependency-graph mocking,
// no device, no live API. Run: node tests/nodejs-project/history-anchor-trim.test.js
const assert = require('assert');
const fs = require('fs');
const path = require('path');

const BUNDLE = path.resolve(__dirname, '../../app/src/main/assets/nodejs-project');
const {
    trimHistoryPreservingAnchor, _groupSizeAt, createWarnLimiter, warnOnce,
    anchorGuardRepair, buildCheckpointSlicePreservingAnchor,
} = require(path.join(BUNDLE, 'history-trim.js'));

// Mirror of ai.js:296. Drift-guarded below so a cap change can't silently
// desync this test's expectations from production.
const MAX_HISTORY = 35;

let pass = 0;
const ok = (c, m) => { assert.ok(c, m); pass++; };

// ── drift guard: the mirrored cap must still match ai.js ────────────────────
{
    const aiSrc = fs.readFileSync(path.join(BUNDLE, 'ai.js'), 'utf8');
    const m = aiSrc.match(/const\s+MAX_HISTORY\s*=\s*(\d+)/);
    ok(m && Number(m[1]) === MAX_HISTORY, `MAX_HISTORY mirror matches ai.js (ai.js=${m && m[1]}, test=${MAX_HISTORY})`);
}

// ── helpers ─────────────────────────────────────────────────────────────────
let _uid = 0;
function makeAnchor() { return { role: 'user', content: 'INSTRUCTION: ' + 'Q'.repeat(200) }; }

// One neutral tool round: 1 assistant with k toolCalls + k role:'tool' results.
function pushRound(msgs, k, big = true) {
    const ids = Array.from({ length: k }, () => `tc_${++_uid}`);
    msgs.push({ role: 'assistant', content: '', toolCalls: ids.map(id => ({ id, name: 'read' })) });
    for (const id of ids) msgs.push({ role: 'tool', toolCallId: id, content: (big ? 'X'.repeat(2000) : 'ok') });
}

function nonAnchorLen(msgs, anchor) { return msgs.length - ((anchor && msgs[0] === anchor) ? 1 : 0); }

// Provider-400 guard: every role:'tool' belongs to a preceding assistant group,
// and every assistant.toolCalls id has its following role:'tool' before the next assistant.
function assertNoOrphans(msgs, ctx) {
    for (let i = 0; i < msgs.length; i++) {
        const m = msgs[i];
        if (m.role === 'tool') {
            let j = i - 1;
            while (j >= 0 && msgs[j].role === 'tool') j--;
            const a = msgs[j];
            assert.ok(a && a.role === 'assistant' && Array.isArray(a.toolCalls)
                && a.toolCalls.some(tc => tc.id === m.toolCallId),
                `${ctx}: orphaned tool_result @${i} (id=${m.toolCallId})`);
        }
        if (m.role === 'assistant' && Array.isArray(m.toolCalls) && m.toolCalls.length) {
            const need = new Set(m.toolCalls.map(tc => tc.id));
            let k = i + 1;
            while (k < msgs.length && msgs[k].role === 'tool') { need.delete(msgs[k].toolCallId); k++; }
            assert.ok(need.size === 0, `${ctx}: assistant @${i} missing tool_results for ${[...need]}`);
        }
    }
}

// The OLD role-blind trim (ai.js:3447 pre-fix) — the negative control.
function oldRoleBlindTrim(messages, cap) {
    while (messages.length > cap) {
        const first = messages[0];
        messages.shift();
        if (first.role === 'assistant' && first.toolCalls && first.toolCalls.length) {
            const ids = new Set(first.toolCalls.map(tc => tc.id));
            while (messages.length && messages[0].role === 'tool' && ids.has(messages[0].toolCallId)) {
                messages.shift();
            }
        }
    }
}

// ── 1. additive-exempt invariant across long turns, k = 1/2/3/5 ─────────────
for (const k of [1, 2, 3, 5]) {
    const anchor = makeAnchor();
    const messages = [anchor];
    for (let round = 1; round <= 40; round++) {
        pushRound(messages, k);
        const lenBefore = messages.length;
        const r = trimHistoryPreservingAnchor(messages, MAX_HISTORY, anchor);
        ok(messages.includes(anchor), `k=${k} r=${round}: anchor preserved`);
        ok(messages[0] === anchor, `k=${k} r=${round}: anchor stays at head`);
        ok(nonAnchorLen(messages, anchor) <= MAX_HISTORY, `k=${k} r=${round}: nonAnchorLen ${nonAnchorLen(messages, anchor)} <= ${MAX_HISTORY}`);
        ok(messages.length <= MAX_HISTORY + 1, `k=${k} r=${round}: total <= cap+1`);
        ok(r.nonAnchorLen === nonAnchorLen(messages, anchor), `k=${k} r=${round}: returned nonAnchorLen matches`);
        // `removed` is part of the [History] diagnostics contract — splice removes
        // exactly `removed` elements, so it must equal the length delta.
        ok(r.removed === lenBefore - messages.length, `k=${k} r=${round}: removed count accurate (got ${r.removed}, delta ${lenBefore - messages.length})`);
        assertNoOrphans(messages, `k=${k} r=${round}`);
    }
}

// ── 2. NEGATIVE CONTROL: old role-blind loop MUST evict the anchor ──────────
{
    const anchor = makeAnchor();
    const messages = [anchor];
    for (let round = 1; round <= 40; round++) { pushRound(messages, 3); oldRoleBlindTrim(messages, MAX_HISTORY); }
    ok(!messages.includes(anchor), 'negative control: old role-blind trim DID evict the anchor (proves the test catches a regression)');
}

// ── 3. no anchor → plain cap (backward compat) ──────────────────────────────
{
    const messages = [];
    for (let round = 1; round <= 40; round++) {
        pushRound(messages, 3);
        trimHistoryPreservingAnchor(messages, MAX_HISTORY, null);
        ok(messages.length <= MAX_HISTORY, `no-anchor r=${round}: length <= cap`);
        assertNoOrphans(messages, `no-anchor r=${round}`);
    }
}

// ── 4. anchor buried behind a leading (stale prev-turn) message is still
//      preserved: front-trim removes the leading msg, promoting the anchor to
//      the head, at which point it is exempted. Protects the anchor regardless
//      of starting position. ────────────────────────────────────────────────
{
    const anchor = makeAnchor();
    const messages = [{ role: 'assistant', content: 'stale prev-turn tail' }, anchor];
    for (let i = 0; i < 50; i++) messages.push({ role: 'assistant', content: 'x' + i });
    trimHistoryPreservingAnchor(messages, MAX_HISTORY, anchor);
    ok(messages.includes(anchor), 'buried-anchor: preserved after front-trim promotes it to head');
    ok(messages[0] === anchor, 'buried-anchor: anchor ends at head');
    ok(nonAnchorLen(messages, anchor) <= MAX_HISTORY, 'buried-anchor: nonAnchorLen <= cap');
    ok(messages.length <= MAX_HISTORY + 1, 'buried-anchor: total <= cap+1');
}

// ── 5. _groupSizeAt covers neutral AND Claude-native groups ─────────────────
{
    const neutral = [
        { role: 'assistant', content: '', toolCalls: [{ id: 'a' }, { id: 'b' }, { id: 'c' }] },
        { role: 'tool', toolCallId: 'a', content: 'x' },
        { role: 'tool', toolCallId: 'b', content: 'x' },
        { role: 'tool', toolCallId: 'c', content: 'x' },
        { role: 'assistant', content: 'next' },
    ];
    ok(_groupSizeAt(neutral, 0) === 4, `neutral group size = 4 (got ${_groupSizeAt(neutral, 0)})`);

    const claude = [
        { role: 'assistant', content: [{ type: 'text', text: 'hi' }, { type: 'tool_use', id: 'x', name: 'read' }] },
        { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'x', content: 'res' }] },
        { role: 'assistant', content: 'next' },
    ];
    ok(_groupSizeAt(claude, 0) === 2, `claude-native group size = 2 (got ${_groupSizeAt(claude, 0)})`);

    ok(_groupSizeAt([{ role: 'user', content: 'hi' }], 0) === 1, 'plain user = 1');
    ok(_groupSizeAt([{ role: 'assistant', content: 'no tools' }], 0) === 1, 'plain assistant = 1');
    ok(_groupSizeAt([{ role: 'tool', toolCallId: 'z', content: 'x' }, { role: 'tool', toolCallId: 'y', content: 'x' }], 0) === 2, 'orphan tool run = 2');
}

// ── 6. Claude-native group trimmed atomically (no split orphan after anchor) ─
{
    const anchor = makeAnchor();
    const messages = [anchor];
    for (let round = 1; round <= 40; round++) {
        messages.push({ role: 'assistant', content: [{ type: 'tool_use', id: `u${round}`, name: 'read' }] });
        messages.push({ role: 'user', content: [{ type: 'tool_result', tool_use_id: `u${round}`, content: 'X'.repeat(2000) }] });
        trimHistoryPreservingAnchor(messages, MAX_HISTORY, anchor);
        ok(messages.includes(anchor), `claude-native r=${round}: anchor preserved`);
        const afterAnchor = messages[1];
        const isOrphanResult = afterAnchor && afterAnchor.role === 'user'
            && Array.isArray(afterAnchor.content) && afterAnchor.content.some(b => b && b.type === 'tool_result');
        ok(!isOrphanResult, `claude-native r=${round}: no leading tool_result orphan after anchor`);
    }
}

// ── 7. WARN rate-limiter (Codex amendment C): once per turn+site, resets per
//      turn, and the turnId=null (addToConversation) path rides under the
//      current turn's key — proving it WARNs once per ACTUAL turn, not once
//      per process or never. ────────────────────────────────────────────────
{
    const st = createWarnLimiter();
    ok(warnOnce(st, 'turnA', 'toolRound', 1) === true, 'warn: turnA first skip → WARN');
    ok(warnOnce(st, 'turnA', 'toolRound', 1) === false, 'warn: turnA repeat same-turn → DEBUG');
    ok(warnOnce(st, 'turnA', 'toolRound', 0) === false, 'warn: skipped=0 → never warns');
    ok(warnOnce(st, 'turnB', 'toolRound', 1) === true, 'warn: turnB first skip → WARN (resets per new turn)');
    // addToConversation end-of-turn append trims with turnId=null → rides under turnB
    ok(warnOnce(st, null, 'addToConversation', 1) === true, 'warn: null-turn first skip at new site → WARN');
    ok(warnOnce(st, null, 'addToConversation', 1) === false, 'warn: null-turn repeat same site → DEBUG');

    // two consecutive turns each WARN exactly once for the same site
    const st2 = createWarnLimiter();
    ok(warnOnce(st2, 't1', 'toolRound', 1) === true, 'two-turns: t1 → WARN');
    ok(warnOnce(st2, 't1', 'toolRound', 1) === false, 'two-turns: t1 repeat → DEBUG');
    ok(warnOnce(st2, 't2', 'toolRound', 1) === true, 'two-turns: t2 → WARN (once per actual turn)');
    ok(warnOnce(st2, 't2', 'toolRound', 1) === false, 'two-turns: t2 repeat → DEBUG');
}

// ── 8. AnchorGuard (Layer B): repairs===0 on healthy runs; repairs a forced
//      missing anchor. ──────────────────────────────────────────────────────
{
    // healthy: after 40 real trim rounds the anchor is still present → NO repair
    const anchor = makeAnchor();
    const messages = [anchor];
    for (let round = 1; round <= 40; round++) {
        pushRound(messages, 3);
        trimHistoryPreservingAnchor(messages, MAX_HISTORY, anchor);
    }
    ok(anchorGuardRepair(messages, anchor) === false, 'AnchorGuard: healthy long turn needs no repair (repairs stays 0)');
    ok(anchorGuardRepair(messages, null) === false, 'AnchorGuard: null anchor → no-op');

    // forced missing (negative control): guard re-inserts the SAME ref at head
    const anchor2 = makeAnchor();
    const broken = [{ role: 'assistant', content: '', toolCalls: [{ id: 'z' }] }, { role: 'tool', toolCallId: 'z', content: 'x' }];
    ok(broken.indexOf(anchor2) === -1, 'forced-missing: anchor absent before repair');
    ok(anchorGuardRepair(broken, anchor2) === true, 'AnchorGuard: missing anchor → repaired');
    ok(broken[0] === anchor2, 'AnchorGuard: repaired anchor is the SAME reference at the head');
    ok(anchorGuardRepair(broken, anchor2) === false, 'AnchorGuard: second call is a no-op (already present)');
}

// ── 9. Checkpoint slice (Codex R1-A): <= max, anchor preserved, no leading
//      orphan tool_result after the anchor. ──────────────────────────────────
{
    // anchor already within the last 8 → normal tail slice, includes anchor
    const a1 = makeAnchor();
    const inWindow = [a1];
    for (let i = 0; i < 3; i++) pushRound(inWindow, 1);
    const s1 = buildCheckpointSlicePreservingAnchor(inWindow, a1, 8);
    ok(s1.length <= 8, 'ckpt in-window: <= 8');
    ok(s1.includes(a1), 'ckpt in-window: anchor present');

    // anchor OLDER than the window (long turn) → [anchor, ...tail], <= 8, anchor kept
    const a2 = makeAnchor();
    const longTurn = [a2];
    for (let i = 0; i < 20; i++) pushRound(longTurn, 1); // anchor now far outside last 8
    const s2 = buildCheckpointSlicePreservingAnchor(longTurn, a2, 8);
    ok(s2.length <= 8, `ckpt long-turn: <= 8 (got ${s2.length})`);
    ok(s2.includes(a2), 'ckpt long-turn: anchor preserved (would be lost by plain slice(-8))');
    ok(s2[0] === a2, 'ckpt long-turn: anchor at head');
    // the message right after the anchor must not be an orphan tool_result
    const after = s2[1];
    const orphan = after && ((after.role === 'tool') || (after.role === 'user' && Array.isArray(after.content) && after.content.some(b => b && b.type === 'tool_result')));
    ok(!orphan, 'ckpt long-turn: no leading orphan tool_result after the anchor');
    // plain slice(-8) WOULD have dropped the anchor — proves the helper matters
    ok(!longTurn.slice(-8).includes(a2), 'ckpt long-turn: control — plain slice(-8) drops the anchor');

    // no anchor → plain tail slice
    const plain = [];
    for (let i = 0; i < 20; i++) pushRound(plain, 1);
    ok(buildCheckpointSlicePreservingAnchor(plain, null, 8).length <= 8, 'ckpt no-anchor: <= 8');

    // max===1 edge (Copilot/CodeRabbit #446): slice(-(1-1)) === slice(-0) === slice(0)
    // must NOT return the whole array. With one slot the anchor takes it.
    const a3 = makeAnchor();
    const many = [a3];
    for (let i = 0; i < 10; i++) pushRound(many, 1); // anchor far outside the window
    const s3 = buildCheckpointSlicePreservingAnchor(many, a3, 1);
    ok(s3.length === 1 && s3[0] === a3, `ckpt max=1: returns exactly [anchor], not the whole array (got len ${s3.length})`);
    const s4 = buildCheckpointSlicePreservingAnchor(many, a3, 2);
    ok(s4.length <= 2, `ckpt max=2: <= 2 (got ${s4.length})`);
    ok(s4.includes(a3), 'ckpt max=2: anchor preserved');

    // early-return path must ALSO strip a leading orphan tool_result (CodeRabbit #446):
    // a window that starts mid-group, with anchor null (or already inside).
    const om = [
        { role: 'assistant', content: '', toolCalls: [{ id: 'g1' }, { id: 'g2' }] },
        { role: 'tool', toolCallId: 'g1', content: 'x' },
        { role: 'tool', toolCallId: 'g2', content: 'x' },
        { role: 'assistant', content: 'done' },
    ];
    const s5 = buildCheckpointSlicePreservingAnchor(om, null, 3); // slice(-3) leads with orphan tool
    ok(!(s5[0] && s5[0].role === 'tool'), 'ckpt early-return: leading orphan tool_result stripped (no-anchor path)');
    const a6 = makeAnchor();
    const om2 = [a6, ...om]; // anchor present but outside a mid-group window
    const s6 = buildCheckpointSlicePreservingAnchor(om2, a6, 3);
    ok(!(s6[1] && s6[1].role === 'tool'), 'ckpt: no leading orphan right after the anchor');
    ok(s6.includes(a6), 'ckpt: anchor still preserved after orphan cleanup');
}

console.log(`\n✓ history-anchor-trim.test.js — ${pass} assertions passed`);
