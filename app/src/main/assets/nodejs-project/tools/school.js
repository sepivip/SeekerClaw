// tools/school.js — Go-to-School tool handlers.
const crypto = require('crypto');
const fs = require('fs');
const { writeSchoolMd, readSchoolMd, appendLogLine, readPriorSessions, schoolMdPath } = require('../school');

function newSessionId() { return crypto.randomBytes(8).toString('hex'); }

// workDir comes from trusted sources only: ctx (injected by tool dispatcher) or
// WORKDIR env (set at app startup from config). args.workDir is deliberately NOT
// honored — tool args are agent-controlled and must not steer filesystem roots.
async function schoolBeginHandler(args, ctx) {
    const workDir = (ctx && ctx.workDir) || process.env.WORKDIR;
    const existing = readSchoolMd(workDir);
    if (existing) {
        return {
            ok: true, resumed: true,
            session_id: existing.session_id,
            started_at: existing.started_at,
            prior_sessions: readPriorSessions(workDir, 10),
            resumed_state: {
                session_id: existing.session_id,
                started_at: existing.started_at,
                trigger: existing.trigger,
                state: existing.state,
                window_days: existing.window_days,
                open_proposal_ns: existing.open_proposal_ns,
                proposals: existing.proposals,
                rubric_version: existing.rubric_version,
                reviewing_opened_at: existing.reviewing_opened_at || null,
            },
        };
    }
    const sessionId = newSessionId();
    const startedAt = Date.now();
    writeSchoolMd(workDir, {
        session_id: sessionId, started_at: startedAt, trigger: args.reason || 'on_demand',
        state: 'scanning', window_days: 7, open_proposal_ns: [], proposals: [], rubric_version: '1.0.0',
    });
    return {
        ok: true, resumed: false,
        session_id: sessionId,
        started_at: startedAt,
        prior_sessions: readPriorSessions(workDir, 10),
        resumed_state: null,
    };
}

async function schoolEndHandler(args, ctx) {
    const workDir = (ctx && ctx.workDir) || process.env.WORKDIR;
    const existing = readSchoolMd(workDir) || {};
    const entry = {
        session_id: args.session_id,
        started_at: existing.started_at || Date.now(),
        ended_at: Date.now(),
        trigger: existing.trigger || 'on_demand',
        window_days: 7,
        rubric_version: '1.0.0',
        proposals: args.summary && args.summary.approved
            ? [...(args.summary.approved || []), ...(args.summary.drafted_but_denied || []), ...(args.summary.skipped || []), ...(args.summary.ignored || []), ...(args.summary.rejected_by_rubric || []), ...(args.summary.rejected_as_duplicate || [])]
            : [],
    };
    appendLogLine(workDir, entry);
    try { fs.unlinkSync(schoolMdPath(workDir)); } catch (_) {}
    return { ok: true };
}

module.exports = { schoolBeginHandler, schoolEndHandler };
