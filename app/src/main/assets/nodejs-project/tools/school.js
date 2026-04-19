// tools/school.js — Go-to-School tool handlers.
const crypto = require('crypto');
const fs = require('fs');
const pathMod = require('path');
const { writeSchoolMd, readSchoolMd, schoolStateFromFrontmatter, appendLogLine, readPriorSessions, schoolMdPath, writeSkillFile, transition, scanLogs } = require('../school');

function newSessionId() { return crypto.randomBytes(8).toString('hex'); }

// Stale-session cutoff: if SCHOOL.md hasn't been touched in this long, auto-end
// it on the next /school invocation instead of silently "resuming" state the
// user has forgotten about. Exported for main.js boot-time cleanup too.
const SCHOOL_STALE_THRESHOLD_MS = 48 * 60 * 60 * 1000;

// Shared entry-builder for auto-end logging. Keeps boot-time cleanup (main.js)
// and handler-time cleanup (below) using the same shape.
function buildStaleEndEntry(pre, nowMs) {
    return {
        session_id: pre.session_id,
        started_at: pre.started_at,
        ended_at: nowMs,
        trigger: pre.trigger || 'on_demand',
        window_days: pre.window_days || 7,
        rubric_version: pre.rubric_version || '1.0.0',
        proposals: (pre.proposals || []).map(p => ({ ...p, outcome: 'abandoned_stale' })),
    };
}

// workDir comes from trusted sources only: ctx (injected by tool dispatcher) or
// WORKDIR env (set at app startup from config). args.workDir is deliberately NOT
// honored — tool args are agent-controlled and must not steer filesystem roots.
async function schoolBeginHandler(args, ctx) {
    const workDir = (ctx && ctx.workDir) || process.env.WORKDIR;
    // readSchoolMd throws on malformed frontmatter. Surface a structured error
    // so the skill can route the user to /school-reset instead of letting the
    // exception bubble through executeTool's generic catch as "Tool execution
    // failed: SCHOOL.md malformed (no YAML frontmatter)".
    let existing;
    try {
        existing = readSchoolMd(workDir);
    } catch (e) {
        return {
            ok: false,
            error: 'school_md_unreadable',
            hint: 'SCHOOL.md exists but could not be parsed. Run /school-reset to discard it and start fresh.',
            detail: e.message,
        };
    }
    // If the existing session has gone stale (>48h since started), auto-end it
    // and create a fresh one. Agent's SKILL.md prose explains the combined-message
    // flow; the response flags it with `started_after_cleanup: true` so the agent
    // can surface the cleanup to the user in the same reply as the new scan.
    if (existing && (Date.now() - (existing.started_at || 0)) > SCHOOL_STALE_THRESHOLD_MS) {
        appendLogLine(workDir, buildStaleEndEntry(existing, Date.now()));
        try { fs.unlinkSync(schoolMdPath(workDir)); } catch (_) {}
        const sessionId = newSessionId();
        const startedAt = Date.now();
        writeSchoolMd(workDir, {
            session_id: sessionId, started_at: startedAt, trigger: args.reason || 'on_demand',
            state: 'scanning', window_days: 7, open_proposal_ns: [], proposals: [], rubric_version: '1.0.0',
        });
        return {
            ok: true, resumed: false,
            session_id: sessionId, started_at: startedAt,
            prior_sessions: readPriorSessions(workDir, 10),
            resumed_state: null,
            started_after_cleanup: true,
            cleaned_up: { prior_session_id: existing.session_id, prior_started_at: existing.started_at },
        };
    }
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
    // Preserve window_days + rubric_version from the active session record so
    // /school log and dedup comparisons stay accurate across scan-window or
    // rubric-version changes. Fall back to defaults only when SCHOOL.md is
    // absent (e.g., mid-shutdown race).
    const entry = {
        session_id: args.session_id,
        started_at: existing.started_at || Date.now(),
        ended_at: Date.now(),
        trigger: existing.trigger || 'on_demand',
        window_days: existing.window_days != null ? existing.window_days : 7,
        rubric_version: existing.rubric_version != null ? existing.rubric_version : '1.0.0',
        proposals: args.summary && args.summary.approved
            ? [...(args.summary.approved || []), ...(args.summary.drafted_but_denied || []), ...(args.summary.skipped || []), ...(args.summary.ignored || []), ...(args.summary.rejected_by_rubric || []), ...(args.summary.rejected_as_duplicate || [])]
            : [],
    };
    appendLogLine(workDir, entry);
    try { fs.unlinkSync(schoolMdPath(workDir)); } catch (_) {}
    return { ok: true };
}

async function schoolWriteSkillHandler(args, ctx) {
    const workDir = (ctx && ctx.workDir) || process.env.WORKDIR;
    return await writeSkillFile({
        workDir, mode: args.mode, relPath: args.path, body: args.body, evidence: args.evidence,
    });
}

async function schoolRetireSkillHandler(args, ctx) {
    const workDir = (ctx && ctx.workDir) || process.env.WORKDIR;
    const relPath = args.path;
    // Two distinct rejection cases. Using separate error codes makes failures
    // diagnosable — "cannot_retire_bundled" was misleading because bundled-skill
    // protection lives in the APK assets, not in the workspace path check.
    if (relPath.includes('..')) {
        return { ok: false, error: 'path_traversal' };
    }
    if (!relPath.startsWith('skills/')) {
        return { ok: false, error: 'path_outside_workspace_skills' };
    }
    const src = pathMod.join(workDir, relPath);
    if (!fs.existsSync(src)) return { ok: false, error: 'target_missing' };
    const name = pathMod.basename(relPath);
    const ts = Date.now();
    const dst = pathMod.join(workDir, 'school/retired', `${ts}-${name}`);
    fs.mkdirSync(pathMod.dirname(dst), { recursive: true });
    fs.renameSync(src, dst);
    return { ok: true, restored_path: dst.replace(workDir + '/', ''), reason: args.reason || '' };
}

async function schoolHandleInputHandler(args, ctx) {
    const workDir = (ctx && ctx.workDir) || process.env.WORKDIR;
    try {
        // Load persisted state from SCHOOL.md so the state machine operates on
        // the authoritative session record, not whatever the agent passed in
        // args.state (which can drift across turns). args.state is still a
        // useful fallback for first-turn calls before any state is persisted.
        const fm = readSchoolMd(workDir);
        const persistedState = schoolStateFromFrontmatter(fm);
        const prevState = persistedState || args.state;
        if (!prevState || !prevState.kind) {
            return { ok: false, error: 'no_session_state', hint: 'SCHOOL.md missing; call school_begin first' };
        }
        const { nextState, nextAction } = transition(prevState, args.input);
        // Persist the new state back to SCHOOL.md. Preserve session metadata
        // (session_id, started_at, trigger, window_days, rubric_version,
        // proposals) from the existing record; only the state-machine fields
        // change per input.
        if (fm) {
            writeSchoolMd(workDir, {
                session_id: fm.session_id,
                started_at: fm.started_at,
                trigger: fm.trigger,
                state: nextState.kind,
                window_days: fm.window_days,
                open_proposal_ns: nextState.open_proposal_ns || [],
                reviewing_n: nextState.reviewing_n,
                reviewing_opened_at: nextState.reviewing_opened_at,
                rubric_version: fm.rubric_version,
                proposals: fm.proposals,
            });
        }
        return {
            ok: true,
            session_id: fm ? fm.session_id : args.session_id,
            previous_state: prevState.kind,
            new_state: nextState.kind,
            next_action: nextAction,
            open_proposal_ns: nextState.open_proposal_ns || [],
            reviewing_n: nextState.reviewing_n != null ? nextState.reviewing_n : null,
            reviewing_opened_at: nextState.reviewing_opened_at || null,
        };
    } catch (e) {
        return { ok: false, error: 'transition_failed', hint: e.message };
    }
}

async function schoolScanHandler(args, ctx) {
    let db = (ctx && ctx.db);
    if (!db) {
        try {
            const { getDb } = require('../database');
            db = getDb();
        } catch (_) {
            db = null;
        }
    }
    if (!db) return { ok: false, error: 'db_unavailable' };
    try {
        const res = scanLogs(db, { window_days: args.window_days || 7, min_repetition: args.min_repetition || 3 });
        return { ok: true, ...res };
    } catch (e) {
        return { ok: false, error: 'scan_failed', hint: e.message };
    }
}

module.exports = { schoolBeginHandler, schoolEndHandler, schoolWriteSkillHandler, schoolRetireSkillHandler, schoolHandleInputHandler, schoolScanHandler, SCHOOL_STALE_THRESHOLD_MS, buildStaleEndEntry };
