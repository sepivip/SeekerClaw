// SeekerClaw — refusal-notice.js
// BAT-1705: what the user is told when the model declines a request (a refusal) or
// the provider's content filter blocks the reply. Pure functions, no I/O, shared
// by ai.js (the reply of the turn) and cron.js (the bounded cron delivery).
//
// The contract (BAT-1705 v2 + v2.1 + v2.2, Codex sign-off 563398e8):
// - A refused / filtered response is never shown, executed or replayed; the
//   user gets one of the notices below instead of silence.
// - When tools were actually dispatched earlier in the turn, the reply OPENS
//   with a disclosure that never claims success, rollback or safe replay.
// - A content filter never surfaces a model message and never says
//   "the model declined".
// - A model's own refusal message (OpenAI family) is capped and stripped, and
//   never replaces the prior-tool disclosure.

const { stripSilentReply } = require('./silent-reply');

const NOTICE_DECLINED = "I couldn't answer that: the model declined this request. Try rephrasing it or splitting it into smaller steps, switch models with /model, or start fresh with /new.";
const NOTICE_FILTERED = "My reply was blocked by the provider's content filter. Try rephrasing it, switch models with /model, or start fresh with /new.";
const DISCLOSURE_DECLINED = 'The model declined to continue after I attempted some tools. Some actions may already have taken effect; check their results before retrying.';
const DISCLOSURE_FILTERED = "My reply was blocked by the provider's content filter after I attempted some tools. Some actions may already have taken effect; check their results before retrying.";
const RECOVERY_LINE = 'You can rephrase, switch models with /model, or start fresh with /new.';

const MODEL_MESSAGE_MAX_CHARS = 2000;
// Cron delivery budget: one plain request on both channels (Telegram CHUNK_MAX
// 3500, Discord 2000), measured on the redacted payload.
const CRON_NOTICE_MAX_CHARS = 1800;
const CRON_LABEL_MAX_CHARS = 80;

const CATEGORY_RE = /^[a-z_]{1,32}$/;

/** The category as logged: null when absent, the value when it is a short snake_case word, else 'other'. */
function categoryForLog(category) {
    if (category === null || category === undefined) return null;
    return (typeof category === 'string' && CATEGORY_RE.test(category)) ? category : 'other';
}

/**
 * A model's own refusal message, made safe to show: SILENT_REPLY / protocol tokens
 * stripped, trimmed, capped at `max` characters. null when nothing is left.
 */
function sanitizeModelMessage(msg, max = MODEL_MESSAGE_MAX_CHARS) {
    if (typeof msg !== 'string') return null;
    let s = stripSilentReply(msg);
    if (typeof s !== 'string') return null;
    s = s.trim();
    if (!s) return null;
    if (s.length > max) s = s.slice(0, Math.max(0, max - 1)).trimEnd() + '…';
    return s;
}

/**
 * The two parts of a notice: `fixed` (always shown) and `optional` (the model's
 * own message, which may be dropped to fit a budget). `join` composes them.
 */
function noticeParts(refusal, dispatchedTools) {
    const filtered = refusal && refusal.kind === 'provider_content_filter';
    const optional = filtered ? null : sanitizeModelMessage(refusal && refusal.modelMessage);
    if (dispatchedTools > 0) {
        // Disclosure first; the model message, if any, is appended after it.
        const fixed = `${filtered ? DISCLOSURE_FILTERED : DISCLOSURE_DECLINED}\n\n${RECOVERY_LINE}`;
        return { fixed, optional, join: (f, o) => (o ? `${f}\n\n${o}` : f) };
    }
    if (filtered) return { fixed: NOTICE_FILTERED, optional: null, join: f => f };
    // No tools ran: the model's own message replaces the generic notice; the
    // generic notice is what remains if that message is dropped.
    return { fixed: NOTICE_DECLINED, optional, join: (f, o) => (o || f) };
}

/** The reply for a refused / filtered turn. */
function buildRefusalNotice(refusal, dispatchedTools = 0) {
    const p = noticeParts(refusal, dispatchedTools);
    return p.join(p.fixed, p.optional);
}

/** A job name made safe for a one-line label: no control characters, collapsed whitespace. */
function _cleanLabel(name) {
    if (typeof name !== 'string') return '';
    return name.replace(/[\u0000-\u001f\u007f]+/g, ' ').replace(/\s+/g, ' ').trim();
}

/**
 * The cron delivery of a refusal notice (Codex 563398e8 pin 1): the text the
 * channel will send, already redacted with `redact`, guaranteed to measure at
 * most `limit` characters AFTER redaction (redaction can expand: a configured
 * secret becomes `[REDACTED:<key>]`). Optional content is redacted BEFORE it is
 * truncated, so truncation can never cut a secret ahead of its redaction. The
 * fixed notice and any prior-tool disclosure are always kept; the label and the
 * model's message are bounded or dropped to fit.
 */
function buildCronRefusalNotice({ jobName, refusal, dispatchedTools = 0 }, { redact = s => s, limit = CRON_NOTICE_MAX_CHARS } = {}) {
    const fits = s => redact(s).length <= limit;
    const p = noticeParts(refusal, dispatchedTools);
    const fixed = redact(p.fixed);

    let label = redact(_cleanLabel(jobName));
    if (label.length > CRON_LABEL_MAX_CHARS) label = label.slice(0, CRON_LABEL_MAX_CHARS - 1).trimEnd() + '…';
    // Plain send (no parse_mode), so no Markdown: `**[name]**` would show its asterisks.
    let prefix = label ? `[${label}]\n\n` : '';
    if (!fits(prefix + fixed)) prefix = ''; // a pathological label is dropped before the notice is touched

    const optional = p.optional ? redact(p.optional) : null;
    if (optional) {
        const full = prefix + p.join(fixed, optional);
        if (fits(full)) return redact(full);
        // Truncate the (already redacted) optional text to the remaining budget.
        const base = prefix + p.join(fixed, '');
        let room = limit - redact(base).length - 1; // 1 for the ellipsis
        if (room > 0) {
            const cut = optional.slice(0, room).trimEnd() + '…';
            const candidate = prefix + p.join(fixed, cut);
            if (fits(candidate)) return redact(candidate);
        }
    }
    return redact(prefix + p.join(fixed, null));
}

module.exports = {
    NOTICE_DECLINED,
    NOTICE_FILTERED,
    DISCLOSURE_DECLINED,
    DISCLOSURE_FILTERED,
    RECOVERY_LINE,
    MODEL_MESSAGE_MAX_CHARS,
    CRON_NOTICE_MAX_CHARS,
    categoryForLog,
    sanitizeModelMessage,
    buildRefusalNotice,
    buildCronRefusalNotice,
};
