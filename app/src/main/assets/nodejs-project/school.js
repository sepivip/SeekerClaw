// school.js — pure module for Go to School feature. No side effects at module load.
// Grows over Phase B: B1 (this commit) = normalizeTitle + signatureOf.
// B2+ adds state-machine transition, pattern mining, skill file writers, persistent-log helpers.

const crypto = require('crypto');

// normalizeTitle(raw: string) → kebab-case slug.
// Non-ASCII chars (é, ñ, CJK) are dropped by the [^a-z0-9-] filter — acceptable
// for v1 since titles are agent-generated and always English.
function normalizeTitle(raw) {
    return String(raw || '')
        .toLowerCase()
        .replace(/[_\s.]+/g, '-')
        .replace(/[^a-z0-9-]/g, '')
        .replace(/-+/g, '-')
        .replace(/^-|-$/g, '');
}

function signatureOf(type, title) {
    const norm = normalizeTitle(title);
    return 'sha256:' + crypto.createHash('sha256').update(`${type}|${norm}`).digest('hex');
}

const STALE_BARE_YES_MS = 60 * 1000;

// transition(state, input) — pure function, no I/O.
// state: { kind: 'awaiting_approval' | 'reviewing_<N>' | 'done' | 'scanning', open_proposal_ns: int[], reviewing_n?: int, reviewing_opened_at?: ms }
// input: { kind: 'yes'|'no'|'review'|'skip'|'stop', proposal_n?: int, message_date: ms, raw_text?: string }
// returns: { nextState, nextAction: { kind, ...details } }
function transition(state, input) {
    const open = state.open_proposal_ns || [];
    const n = input.proposal_n;
    const lastAfterRemoval = (removeN) => open.filter(x => x !== removeN);

    if (state.kind === 'awaiting_approval') {
        if (input.kind === 'review') {
            if (!open.includes(n)) {
                return { nextState: state, nextAction: { kind: 'reply_only', template: 'proposal_not_open', open } };
            }
            return {
                nextState: { kind: 'reviewing_<N>', reviewing_n: n, open_proposal_ns: open, reviewing_opened_at: input.message_date },
                nextAction: { kind: 'send_review_artifact', proposal_n: n },
            };
        }
        if (input.kind === 'skip') {
            const remaining = lastAfterRemoval(n);
            if (remaining.length === 0) {
                return { nextState: { kind: 'done', open_proposal_ns: [] }, nextAction: { kind: 'end_session', skipped: [n] } };
            }
            return {
                nextState: { kind: 'awaiting_approval', open_proposal_ns: remaining },
                nextAction: { kind: 'reply_only', template: 'skipped', n, remaining },
            };
        }
        if (input.kind === 'stop') {
            return { nextState: { kind: 'done', open_proposal_ns: [] }, nextAction: { kind: 'end_session', ignored: open } };
        }
        if (input.kind === 'yes' || input.kind === 'no') {
            return { nextState: state, nextAction: { kind: 'reply_only', template: 'yes_no_outside_review' } };
        }
        return { nextState: state, nextAction: { kind: 'reply_only', template: 'unknown_input' } };
    }

    if (state.kind === 'reviewing_<N>') {
        const cur = state.reviewing_n;
        if (input.kind === 'yes' || input.kind === 'no') {
            let targetN = n;
            if (targetN === undefined) {
                const elapsed = input.message_date - (state.reviewing_opened_at || 0);
                if (elapsed <= STALE_BARE_YES_MS) targetN = cur;
                else return { nextState: state, nextAction: { kind: 'reply_only', template: 'ambiguous_bare_yes_no' } };
            }
            if (targetN !== cur) {
                return { nextState: state, nextAction: { kind: 'reply_only', template: 'invalid_proposal_n', got: targetN, expected: cur } };
            }
            if (input.kind === 'no') {
                return {
                    nextState: { kind: 'awaiting_approval', open_proposal_ns: open },
                    nextAction: { kind: 'reply_only', template: 'drafted_but_denied', n: cur },
                };
            }
            const remaining = lastAfterRemoval(cur);
            const next = remaining.length === 0
                ? { kind: 'done', open_proposal_ns: [] }
                : { kind: 'awaiting_approval', open_proposal_ns: remaining };
            return { nextState: next, nextAction: { kind: 'write_skill', n: cur } };
        }
        if (input.kind === 'review') {
            if (!open.includes(n)) {
                return { nextState: state, nextAction: { kind: 'reply_only', template: 'proposal_not_open', open } };
            }
            return {
                nextState: { kind: 'reviewing_<N>', reviewing_n: n, open_proposal_ns: open, reviewing_opened_at: input.message_date },
                nextAction: { kind: 'send_review_artifact', proposal_n: n, skipped_n: cur },
            };
        }
        if (input.kind === 'skip') {
            if (n === cur) {
                const remaining = lastAfterRemoval(n);
                if (remaining.length === 0) {
                    return { nextState: { kind: 'done', open_proposal_ns: [] }, nextAction: { kind: 'end_session', skipped: [n] } };
                }
                return {
                    nextState: { kind: 'awaiting_approval', open_proposal_ns: remaining },
                    nextAction: { kind: 'reply_only', template: 'skipped', n, remaining },
                };
            }
            return {
                nextState: { kind: 'reviewing_<N>', reviewing_n: cur, open_proposal_ns: lastAfterRemoval(n), reviewing_opened_at: state.reviewing_opened_at },
                nextAction: { kind: 'reply_only', template: 'skipped_other', n, cur },
            };
        }
        if (input.kind === 'stop') {
            return { nextState: { kind: 'done', open_proposal_ns: [] }, nextAction: { kind: 'end_session', drafted_but_denied: [cur], ignored: lastAfterRemoval(cur) } };
        }
        return { nextState: state, nextAction: { kind: 'reply_only', template: 'unknown_input' } };
    }

    return { nextState: state, nextAction: { kind: 'reply_only', template: 'unsupported_state', state: state.kind } };
}

module.exports = { normalizeTitle, signatureOf, transition };
