// school.js — pure module for Go to School feature. No side effects at module load.
// Grows over Phase B: B1 (this commit) = normalizeTitle + signatureOf.
// B2+ adds state-machine transition, pattern mining, skill file writers, persistent-log helpers.

const crypto = require('crypto');
const fs = require('fs');
const pathMod = require('path');

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
// Unix-seconds timestamps are bounded by ~1e10 through year 2286; any ms
// timestamp post-2001 is > 1e12. Use 1e12 as the dividing line — if a caller
// hands us seconds (e.g. forwarded straight from Telegram's message.date),
// normalize to ms so STALE_BARE_YES_MS stays meaningful.
const MS_SECONDS_THRESHOLD = 1e12;
function toMs(t) {
    const n = Number(t);
    if (!Number.isFinite(n)) return 0;
    return n < MS_SECONDS_THRESHOLD ? n * 1000 : n;
}

// transition(state, input) — pure function, no I/O.
// state: { kind: 'awaiting_approval' | 'reviewing_<N>' | 'done' | 'scanning', open_proposal_ns: int[], reviewing_n?: int, reviewing_opened_at?: ms }
// input: { kind: 'yes'|'no'|'review'|'skip'|'stop', proposal_n?: int, message_date: ms-or-seconds, raw_text?: string }
//   - message_date is normalized to ms at the boundary. Passing seconds (Telegram's
//     message.date) or ms (Date.now()) both work; state is always stored in ms.
// returns: { nextState, nextAction: { kind, ...details } }
function transition(state, input) {
    // Normalize time-bearing fields to ms so the state machine can compare
    // against STALE_BARE_YES_MS uniformly regardless of caller's unit choice.
    const normalizedInput = { ...input, message_date: toMs(input.message_date) };
    const normalizedState = { ...state, reviewing_opened_at: toMs(state.reviewing_opened_at) };
    input = normalizedInput;
    state = normalizedState;
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

function schoolDir(workDir) { return pathMod.join(workDir, 'school'); }
function schoolMdPath(workDir) { return pathMod.join(workDir, 'SCHOOL.md'); }
function schoolLogPath(workDir) { return pathMod.join(workDir, 'school', 'log.jsonl'); }

function ensureSchoolDir(workDir) {
    const d = schoolDir(workDir);
    fs.mkdirSync(d, { recursive: true });
    fs.mkdirSync(pathMod.join(d, 'drafts'), { recursive: true });
    fs.mkdirSync(pathMod.join(d, 'retired'), { recursive: true });
}

function writeSchoolMd(workDir, sessionObj) {
    ensureSchoolDir(workDir);
    const frontmatter = [
        '---',
        `session_id: ${sessionObj.session_id}`,
        `started_at: ${sessionObj.started_at}`,
        `trigger: ${sessionObj.trigger || 'on_demand'}`,
        `state: ${sessionObj.state || 'scanning'}`,
        `window_days: ${sessionObj.window_days || 7}`,
        `open_proposal_ns: [${(sessionObj.open_proposal_ns || []).join(', ')}]`,
        `rubric_version: "${sessionObj.rubric_version || '1.0.0'}"`,
        // reviewing_n tracks the proposal currently under /review N — needed
        // for school_handle_input to reconstruct state between turns.
        sessionObj.reviewing_n != null ? `reviewing_n: ${sessionObj.reviewing_n}` : '',
        sessionObj.reviewing_opened_at ? `reviewing_opened_at: ${sessionObj.reviewing_opened_at}` : '',
        '---',
        '',
        `# School Session — ${new Date(sessionObj.started_at).toISOString()}`,
        '',
        '## Proposals',
        JSON.stringify(sessionObj.proposals || [], null, 2),
        '',
    ].filter(Boolean).join('\n');
    fs.writeFileSync(schoolMdPath(workDir), frontmatter);
}

// Reconstruct the state-machine input shape expected by transition() from the
// flat SCHOOL.md frontmatter. Returns { kind, open_proposal_ns, reviewing_n,
// reviewing_opened_at } — the exact shape transition() reads.
function schoolStateFromFrontmatter(fm) {
    if (!fm) return null;
    return {
        kind: fm.state || 'scanning',
        open_proposal_ns: fm.open_proposal_ns || [],
        reviewing_n: (fm.reviewing_n != null && !isNaN(fm.reviewing_n)) ? fm.reviewing_n : undefined,
        reviewing_opened_at: fm.reviewing_opened_at || null,
    };
}

function readSchoolMd(workDir) {
    const p = schoolMdPath(workDir);
    if (!fs.existsSync(p)) return null;
    const content = fs.readFileSync(p, 'utf8');
    const m = content.match(/^---\n([\s\S]+?)\n---/);
    if (!m) throw new Error('SCHOOL.md malformed (no YAML frontmatter)');
    const fm = {};
    for (const line of m[1].split('\n')) {
        const kv = line.match(/^(\w+):\s*(.+)$/);
        if (!kv) continue;
        const [, k, v] = kv;
        if (k === 'open_proposal_ns') {
            fm[k] = v.replace(/[\[\]]/g, '').split(',').map(s => parseInt(s.trim(), 10)).filter(n => !isNaN(n));
        } else if (k === 'started_at' || k === 'reviewing_opened_at' || k === 'window_days' || k === 'reviewing_n') {
            fm[k] = parseInt(v, 10);
        } else {
            fm[k] = v.replace(/^["']|["']$/g, '');
        }
    }
    let proposals = [];
    const pm = content.match(/## Proposals\n(\[[\s\S]*?\])\n/);
    if (pm) {
        try { proposals = JSON.parse(pm[1]); } catch (_) { proposals = []; }
    }
    return { ...fm, proposals, raw: content };
}

function appendLogLine(workDir, obj) {
    ensureSchoolDir(workDir);
    fs.appendFileSync(schoolLogPath(workDir), JSON.stringify(obj) + '\n');
}

function readPriorSessions(workDir, limit = 10) {
    const p = schoolLogPath(workDir);
    if (!fs.existsSync(p)) return [];
    const lines = fs.readFileSync(p, 'utf8').trim().split('\n').filter(Boolean);
    return lines.slice(-limit).map(l => { try { return JSON.parse(l); } catch (_) { return null; } }).filter(Boolean);
}

const MAX_SKILL_BYTES = 64 * 1024;

// Serialize a value as a YAML-safe scalar. Evidence is agent-generated and can
// contain newlines, colons, # comments, or quotes — all of which would break
// the simple regex-based frontmatter parser in readSchoolMd. Strip newlines
// (collapse to spaces) and double-quote if the value contains any reserved
// character; escape embedded double-quotes.
function yamlScalar(val) {
    const s = String(val == null ? '' : val).replace(/\r?\n/g, ' ').trim();
    if (/[:#"'\[\]{}&*!|>%@`]/.test(s) || s === '' || /^[-?]/.test(s)) {
        return `"${s.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;
    }
    return s;
}

function injectOrReplaceFrontmatterKeys(body, keys) {
    const m = body.match(/^---\n([\s\S]+?)\n---/);
    if (!m) throw new Error('no_frontmatter');
    const existing = m[1].split('\n');
    const existingMap = {};
    const order = [];
    for (const line of existing) {
        const kv = line.match(/^(\w[\w-]*):\s*(.+)$/);
        if (kv) { existingMap[kv[1]] = kv[2]; if (!order.includes(kv[1])) order.push(kv[1]); }
    }
    for (const k of Object.keys(keys)) {
        existingMap[k] = yamlScalar(keys[k]);
        if (!order.includes(k)) order.push(k);
    }
    const newFm = '---\n' + order.map(k => `${k}: ${existingMap[k]}`).join('\n') + '\n---';
    return body.replace(/^---\n[\s\S]+?\n---/, newFm);
}

function todayStr() { return new Date().toISOString().slice(0, 10); }

async function writeSkillFile({ workDir, mode, relPath, body, evidence }) {
    if (!relPath.startsWith('skills/') || relPath.includes('..')) {
        return { ok: false, error: 'path_outside_workspace_skills' };
    }
    if (Buffer.byteLength(body, 'utf8') > MAX_SKILL_BYTES) {
        return { ok: false, error: 'oversize', limit_bytes: MAX_SKILL_BYTES };
    }
    if (!body.startsWith('---\n')) return { ok: false, error: 'missing_frontmatter' };
    if (!/^#\s+.+/m.test(body.replace(/^---\n[\s\S]+?\n---\n/, ''))) {
        return { ok: false, error: 'missing_body_heading' };
    }
    const fullPath = pathMod.join(workDir, relPath);
    let finalBody;
    if (mode === 'create') {
        finalBody = injectOrReplaceFrontmatterKeys(body, {
            source: 'school', created: todayStr(), evidence,
        });
    } else if (mode === 'patch') {
        if (!fs.existsSync(fullPath)) return { ok: false, error: 'patch_target_missing' };
        const existing = fs.readFileSync(fullPath, 'utf8');
        const existingSourceMatch = existing.match(/^source:\s*(.+)$/m);
        const existingSource = existingSourceMatch ? existingSourceMatch[1].trim() : 'user';
        // Inject existing source directly — if the patch body omits `source:`
        // entirely, the post-hoc .replace() had nothing to match and provenance
        // was silently lost. injectOrReplaceFrontmatterKeys now both overwrites
        // an existing source AND adds it if missing.
        finalBody = injectOrReplaceFrontmatterKeys(body, {
            source: existingSource,
            last_patched_by: 'school', last_patched_at: todayStr(), patch_evidence: evidence,
        });
    } else {
        return { ok: false, error: 'invalid_mode' };
    }
    fs.mkdirSync(pathMod.dirname(fullPath), { recursive: true });
    fs.writeFileSync(fullPath, finalBody);
    const sha = crypto.createHash('sha256').update(finalBody).digest('hex');
    return { ok: true, path: relPath, action: mode, sha256: sha };
}

module.exports = { normalizeTitle, signatureOf, transition, scanLogs, writeSchoolMd, readSchoolMd, schoolStateFromFrontmatter, appendLogLine, readPriorSessions, ensureSchoolDir, schoolMdPath, schoolLogPath, writeSkillFile };
