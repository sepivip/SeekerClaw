'use strict';
// history-trim.js — BAT-1186 Stage 1.
// PURE anchor-preserving history-trim primitives: no I/O, no deps, so the
// regression test drives them directly (no ai.js dependency-graph mocking).
// ai.js owns the [History] logging, the WARN rate-limit, and the belt-and-braces
// sanitizeConversation — those are I/O/cross-cutting concerns, not array surgery.
//
// Background: the live `messages` array (a getConversation alias in ai.js) was
// capped by role-blind front-trims that could evict the CURRENT turn's user
// instruction (the "anchor") after ~6-18 tool rounds, making the model
// confabulate. These primitives cap the NON-anchor history while exempting the
// one in-flight anchor (Codex R2: additive-exempt), group-atomic for both
// neutral and Claude-native tool groups so no tool_use/tool_result pair is ever
// orphaned (the provider-400 constraint).

// Size of the atomic group starting at index i. Covers BOTH message shapes:
//   neutral       — assistant.toolCalls[] followed by role:'tool' results
//   Claude-native — assistant.content[tool_use] followed by user.content[tool_result]
// A bare role:'tool' head is an already-orphaned run — sweep it whole.
function _groupSizeAt(messages, i) {
    const first = messages[i];
    if (!first) return 1;
    if (first.role === 'tool') {
        let n = 1;
        while (i + n < messages.length && messages[i + n].role === 'tool') n++;
        return n;
    }
    if (first.role === 'assistant') {
        // neutral group: assistant.toolCalls[] + its role:'tool' results
        if (Array.isArray(first.toolCalls) && first.toolCalls.length) {
            const ids = new Set(first.toolCalls.map(tc => tc.id));
            let n = 1;
            while (i + n < messages.length && messages[i + n].role === 'tool'
                   && ids.has(messages[i + n].toolCallId)) n++;
            return n;
        }
        // Claude-native group: assistant(content[tool_use]) + user(content[tool_result])
        if (Array.isArray(first.content) && first.content.some(b => b && b.type === 'tool_use')) {
            const next = messages[i + 1];
            if (next && next.role === 'user' && Array.isArray(next.content)
                && next.content.some(b => b && b.type === 'tool_result')) {
                return 2;
            }
        }
    }
    return 1;
}

// Enforce a history cap WITHOUT evicting the in-flight turn's anchor.
// Additive-exempt (Codex R2): cap the NON-anchor messages at `cap`; the single
// in-flight anchor (present iff it is messages[0]) rides free, so preserving the
// question costs 0 findings slots. Bounded — one anchor ⇒ messages.length <= cap + 1.
// SKIP-PAST, NOT BREAK: when the anchor is at index 0 we evict at index 1, so
// every pass removes >=1 and `nonAnchorLen <= cap` holds unconditionally.
// MUTATES IN PLACE — never reassigns the caller's array (BAT-549 PR #354).
// Returns { removed, skipped, nonAnchorLen, anchorExempt }; the caller logs and,
// when skipped, re-runs its orphan sweep (index-1 eviction is new).
function trimHistoryPreservingAnchor(messages, cap, anchor) {
    let removed = 0;
    let skipped = 0;
    const anchorHead = () => (anchor && messages[0] === anchor) ? 1 : 0;
    while (messages.length - anchorHead() > cap) {
        const i = anchorHead();
        if (i >= messages.length) break; // anchor is the sole entry (cap>=1 ⇒ dead code)
        if (i === 1) skipped = 1;
        const g = _groupSizeAt(messages, i);
        messages.splice(i, g);
        removed += g;
    }
    const exempt = anchorHead();
    return { removed, skipped, nonAnchorLen: messages.length - exempt, anchorExempt: exempt === 1 };
}

// [History] WARN rate-limit predicate (Codex R1 amendment C) — PURE, state is
// injected so ai.js owns the instance and the actual log() call. The FIRST
// anchorSkipped for a given turn+site is WARN (the old code would have deleted
// the question here); later same-turn skips are DEBUG so a long task doesn't
// spam WARN. Self-resets when a new non-null turnId appears; turnId===null
// callers (addToConversation) ride under the current turn's key.
function createWarnLimiter() {
    return { turn: null, seen: new Set() };
}
function warnOnce(state, turnId, site, skipped) {
    if (!skipped) return false;
    if (turnId && turnId !== state.turn) {
        state.turn = turnId;
        state.seen.clear();
    }
    const key = `${turnId || state.turn || '-'}:${site}`;
    if (state.seen.has(key)) return false;
    state.seen.add(key);
    return true;
}

// Layer B (defense in depth) — last-resort repair. If the in-flight anchor went
// missing from `messages` (some trimmer we did not cover, or a future refactor),
// re-insert the SAME reference at the head and return true. Index 0 cannot split
// a tool group (groups start at an assistant), so no tool_use/tool_result pair is
// orphaned, and it guarantees messages[0] is the user anchor. Returns false (no-op)
// when the anchor is absent-by-design (null) or still present — the healthy path.
// In a healthy build this NEVER repairs; ai.js asserts repairs===0 via the counter.
function anchorGuardRepair(messages, anchor) {
    if (!anchor) return false;
    if (messages.indexOf(anchor) !== -1) return false;
    messages.unshift(anchor);
    return true;
}

function _isLeadingToolResult(m) {
    if (!m) return false;
    if (m.role === 'tool') return true; // neutral orphan tool result
    return m.role === 'user' && Array.isArray(m.content)
        && m.content.some(b => b && b.type === 'tool_result'); // Claude-native orphan
}

// Checkpoint-slice builder (Codex R1-A). saveCheckpoint persists only the last
// MAX_CONVERSATION_SLICE (8) messages; with the anchor pinned at the head of a
// long turn it falls OUTSIDE that window, so /resume would restore a history with
// no user turn — the same defect one layer down. This returns AT MOST `max`
// messages and guarantees the anchor is present:
//   - anchor already within the last `max` → return the normal tail slice;
//   - anchor older than the window → [anchor, ...cleanedTail(max-1)], where the
//     tail is stripped of leading orphan tool/tool_result blocks so the restored
//     slice starts on a valid group boundary (never [anchor, orphan-result, ...]).
// Identity-based (includes/indexOf). Bounded: result.length <= max.
function buildCheckpointSlicePreservingAnchor(messages, anchor, max = 8) {
    if (max <= 0) return [];
    const normal = messages.slice(-max);
    if (!anchor || normal.includes(anchor)) return normal;
    // Guard max===1: max-1 is 0, and slice(-0) === slice(0) returns the WHOLE
    // array — which would make [anchor, ...tail] blow past `max`. With one slot
    // the anchor takes it and the tail is empty. Keeps result.length <= max.
    const tailCount = max - 1;
    let tail = tailCount > 0 ? messages.slice(-tailCount) : [];
    let i = 0;
    while (i < tail.length && _isLeadingToolResult(tail[i])) i++;
    tail = tail.slice(i);
    return [anchor, ...tail];
}

module.exports = {
    _groupSizeAt, trimHistoryPreservingAnchor, createWarnLimiter, warnOnce,
    anchorGuardRepair, buildCheckpointSlicePreservingAnchor,
};
