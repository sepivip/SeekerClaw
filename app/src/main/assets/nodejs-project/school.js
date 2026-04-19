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

const INSUFFICIENT_SIGNAL_MIN_CALLS = 20;
const EXPENSIVE_TURN_MIN_TOOLS = 8;

function scanLogs(db, { window_days = 7, min_repetition = 3, now_ms = Date.now(), caps = {} } = {}) {
    const capPatterns = caps.patterns ?? 5;
    const capSequences = caps.sequences ?? 10;
    const capTurns = caps.turns ?? 5;
    const cutoff = now_ms - window_days * 24 * 3600 * 1000;

    const total = db.exec(`SELECT COUNT(*) FROM tool_call_log WHERE created_at > ?`, [cutoff]);
    const totalCalls = total.length ? total[0].values[0][0] : 0;
    if (totalCalls < INSUFFICIENT_SIGNAL_MIN_CALLS) {
        return { window_days, empty: true, reason: 'insufficient_signal', total_tool_calls: totalCalls, suggested_window_days: Math.min(30, window_days * 2) };
    }
    const totalTurns = db.exec(`SELECT COUNT(DISTINCT turn_id) FROM tool_call_log WHERE created_at > ?`, [cutoff])[0].values[0][0];

    const repRows = db.exec(`
        SELECT call_shape, COUNT(*) as cnt, COUNT(DISTINCT DATE(created_at/1000, 'unixepoch')) as distinct_days,
               GROUP_CONCAT(DISTINCT turn_id) as turns, GROUP_CONCAT(DISTINCT message_id) as msgs
        FROM tool_call_log
        WHERE created_at > ?
        GROUP BY call_shape
        HAVING cnt >= ?
        ORDER BY cnt DESC
        LIMIT ?`, [cutoff, min_repetition, capPatterns]);
    const repeated_patterns = (repRows[0] ? repRows[0].values : []).map(r => ({
        call_shape_chain: [r[0]],
        count: r[1],
        spans_distinct_days: r[2],
        sample_turn_ids: String(r[3] || '').split(',').slice(0, 3),
        sample_message_ids: String(r[4] || '').split(',').slice(0, 3),
    }));

    const failRows = db.exec(`
        SELECT tool_name, call_shape, error_kind, COUNT(*) as cnt
        FROM tool_call_log
        WHERE created_at > ? AND result_status = 'error'
        GROUP BY tool_name, call_shape, error_kind
        HAVING cnt >= ?
        ORDER BY cnt DESC
        LIMIT ?`, [cutoff, min_repetition, capSequences]);
    const failed_sequences = (failRows[0] ? failRows[0].values : []).map(r => ({
        tool_name: r[0], call_shape: r[1], error_kind: r[2], count: r[3]
    }));

    const exRows = db.exec(`
        SELECT turn_id, MIN(message_id), COUNT(*) as tool_count, SUM(latency_ms) as latency_sum
        FROM tool_call_log
        WHERE created_at > ?
        GROUP BY turn_id
        HAVING tool_count >= ?
        ORDER BY tool_count DESC, latency_sum DESC
        LIMIT ?`, [cutoff, EXPENSIVE_TURN_MIN_TOOLS, capTurns]);
    const expensive_turns = (exRows[0] ? exRows[0].values : []).map(r => ({
        turn_id: r[0], message_id: r[1], tool_count: r[2], latency_ms_total: r[3]
    }));

    const triggeredRows = db.exec(`SELECT DISTINCT skill_name FROM skill_trigger_log WHERE created_at > ?`, [cutoff]);
    const triggered_skills = (triggeredRows[0] ? triggeredRows[0].values : []).map(r => r[0]);

    return {
        window_days,
        empty: false,
        total_turns: totalTurns,
        total_tool_calls: totalCalls,
        repeated_patterns,
        failed_sequences,
        expensive_turns,
        triggered_skills,
        unused_tools: [],
    };
}

module.exports = { normalizeTitle, signatureOf, transition, scanLogs };
