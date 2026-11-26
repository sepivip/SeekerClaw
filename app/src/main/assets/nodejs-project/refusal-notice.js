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
const { cleanResponse } = require('./response-clean');

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
 * What survives the delivery path's cleanup: the protocol-token stripping in
 * message-handler.js `deliverAgentText` (SILENT_REPLY, HEARTBEAT_OK, a
 * `[[reply_to_current]]` tag) plus the channel's `cleanResponse` (reasoning tags,
 * where an unclosed `<think>` strips to the end; `[Historical context:]` markers;
 * repeated lines). Codex 2b68f44a #3: model text or a job label could otherwise
 * make that cleanup erase the notice, and the turn would end silent.
 */
function deliveryVisible(text) {
    if (typeof text !== 'string') return '';
    let s = stripSilentReply(
        text.trim()
            .replace(/(?:^|\s+|\*+)HEARTBEAT_OK\s*$/gi, '').replace(/\bHEARTBEAT_OK\b/gi, '')
    );
    if (typeof s !== 'string') return '';
    s = s.replace(/\[\[reply_to_current\]\]/g, '');
    return cleanResponse(s) || '';
}

/** True when the delivery cleanup leaves `text` exactly as composed. */
function survivesDelivery(text) {
    return typeof text === 'string' && text.trim() !== '' && deliveryVisible(text) === text.trim();
}

/**
 * A model's own refusal message, made safe to show: cleaned exactly as the delivery
 * path will clean it, trimmed, capped at `max` characters. null when nothing visible
 * is left, so the caller falls back to the fixed wording.
 */
function sanitizeModelMessage(msg, max = MODEL_MESSAGE_MAX_CHARS) {
    if (typeof msg !== 'string') return null;
    let s = deliveryVisible(msg);
    if (!s) return null;
    if (s.length > max) s = s.slice(0, Math.max(0, max - 1)).trimEnd() + '…';
    return s;
}

/**
 * The two parts of a notice: `fixed` (always shown) and `optional` (the model's
 * own message, which may be dropped to fit a budget). `join` composes them.
 */
function noticeParts(refusal, dispatchedTools, redact = s => s) {
    const filtered = refusal && refusal.kind === 'provider_content_filter';
    // Redact the RAW model message before it is capped (Codex connector on #472): a
    // registered secret straddling the cap would otherwise lose its tail and no longer
    // match the literal redactors downstream, leaking its prefix.
    const raw = refusal && typeof refusal.modelMessage === 'string' ? redact(refusal.modelMessage) : null;
    const optional = filtered ? null : sanitizeModelMessage(raw);
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

/**
 * The reply for a refused / filtered turn. Pass the channel's `redact` so the model's
 * message is redacted before it is capped (the channel redacts again on send).
 */
function buildRefusalNotice(refusal, dispatchedTools = 0, { redact = s => s } = {}) {
    const p = noticeParts(refusal, dispatchedTools, redact);
    const full = p.join(p.fixed, p.optional);
    // The composed notice must reach the user as composed; if the model's text
    // interacts with the cleanup (e.g. repeats a fixed line), drop it.
    if (p.optional && !survivesDelivery(full)) return p.join(p.fixed, null);
    return full;
}

/**
 * A job name made safe for a one-line label: no control characters, collapsed
 * whitespace, and no text the delivery cleanup would strip (a `<think>` in the label
 * would otherwise erase the fixed notice that follows it).
 */
function _cleanLabel(name) {
    if (typeof name !== 'string') return '';
    const oneLine = name.replace(/[\u0000-\u001f\u007f]+/g, ' ').replace(/\s+/g, ' ').trim();
    return deliveryVisible(oneLine).replace(/\s+/g, ' ').trim();
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
    // A candidate is sendable when, redacted, it fits one request AND survives the
    // delivery cleanup unchanged (Codex 2b68f44a #3).
    const fits = s => { const r = redact(s); return r.length <= limit && survivesDelivery(r); };
    const p = noticeParts(refusal, dispatchedTools, redact);
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
    deliveryVisible,
    survivesDelivery,
    sanitizeModelMessage,
    buildRefusalNotice,
    buildCronRefusalNotice,
};
