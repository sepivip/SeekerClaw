// SeekerClaw — reasoning-display.js (BAT-549 Commit 4)
//
// Format captured reasoning blocks as a Telegram expandable blockquote
// for display in chat when `RuntimeState.reasoningDisplayInChat` is on.
// Pure helper: no IO, no telegram-API calls. Caller decides whether to
// render (gated on reasoningDisplayInChat) and how to send.
//
// ## Telegram HTML format (R21 Copilot fix)
//
// SeekerClaw's send pipeline (telegram.js: toTelegramHtml) uses
// `parse_mode: 'HTML'`, NOT MarkdownV2 — markdown-it converts the
// agent's response from markdown to HTML before send. Telegram HTML
// supports the `expandable` attribute on blockquote:
//
//   <blockquote expandable>line 1
//   line 2
//   line 3</blockquote>
//
// This renders collapsed by default with a tap-to-expand affordance.
// Output from this helper MUST be sent verbatim with parse_mode='HTML'
// — running it through `toTelegramHtml` would re-escape the angle
// brackets and produce literal `&lt;blockquote&gt;...` text. The
// caller is responsible for bypassing the markdown-it conversion
// for these messages.
//
// ## Per-provider extraction
//
// Each block has a different wire shape per its provider. The display
// extractor picks the human-readable summary if present, falls back to
// a structural placeholder if not:
//
//   anthropic / claude:
//     wire.thinking         (text/content of the thinking block)
//     OR placeholder for redacted_thinking (no readable text)
//
//   openai:
//     wire.summary[].text   (joined; the reasoning summary OAuth/Codex returns)
//     OR placeholder if encrypted_content only
//
//   openrouter:
//     wire.text             (reasoning_details normalized text)
//     OR wire.reasoning_content (DeepSeek-via-OR style)
//
//   custom:
//     wire.reasoning_content (DeepSeek native gateway style)
//     OR opaque-shape placeholder
//
// Returns `null` when no displayable text is found across any block —
// so the caller can skip sending a blockquote entirely (no point
// surfacing "[reasoning captured but not human-readable]").

'use strict';

/**
 * Extract a single block's displayable summary text. Returns an empty
 * string if the block has no readable text (caller skips it).
 *
 * The function is deliberately conservative: only known wire shapes
 * are read. An unknown shape returns "" so an unfamiliar block doesn't
 * leak a JSON-stringified payload into the user's chat.
 */
function extractDisplayText(block) {
    if (!block || typeof block !== 'object') return '';
    const wire = block.wire;
    if (!wire || typeof wire !== 'object' || Array.isArray(wire)) return '';

    // Anthropic thinking block
    if (wire.type === 'thinking' && typeof wire.thinking === 'string') {
        return wire.thinking;
    }
    if (wire.type === 'redacted_thinking') {
        return ''; // No human-readable text — server-encrypted only
    }

    // OpenAI Responses reasoning item — wire.summary is an array of
    // summary parts; each part has {type:'summary_text', text:'...'}.
    if (wire.type === 'reasoning' && Array.isArray(wire.summary)) {
        const parts = wire.summary
            .filter((s) => s && typeof s.text === 'string' && s.text.length > 0)
            .map((s) => s.text);
        if (parts.length > 0) return parts.join('\n');
        return ''; // encrypted_content-only blocks have no display text
    }

    // OpenRouter normalized reasoning_details entry (with `text` field) —
    // OR's docs mark `text` as the human-readable summary regardless of
    // the underlying provider.
    if (typeof wire.text === 'string' && wire.text.length > 0) {
        return wire.text;
    }

    // DeepSeek via OR / native — reasoning_content as a top-level string.
    if (typeof wire.reasoning_content === 'string' && wire.reasoning_content.length > 0) {
        return wire.reasoning_content;
    }

    return '';
}

/**
 * Telegram HTML reserves `<`, `>`, and `&`; they MUST be escaped when
 * emitting user-controlled text inside an HTML message body (otherwise
 * the server returns 400 with "can't parse entities" or — worse —
 * accidental tag injection from a `<script>`-shaped reasoning summary).
 * Escape with the standard HTML entity references.
 */
function escapeHtml(text) {
    if (typeof text !== 'string') return '';
    return text
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;');
}

/**
 * Format an array of reasoningBlocks as a Telegram HTML expandable
 * blockquote string. Returns `null` when no blocks have displayable
 * text — caller should skip sending entirely instead of emitting an
 * empty blockquote.
 *
 * Output shape: `<blockquote expandable>content</blockquote>` with
 * paragraphs separated by blank lines (rendered as `<br><br>` in the
 * Telegram client). Send with `parse_mode: 'HTML'` and bypass any
 * markdown-it conversion — the angle brackets MUST reach Telegram
 * unescaped for the expandable affordance to activate.
 */
function formatExpandableBlockquote(reasoningBlocks) {
    if (!Array.isArray(reasoningBlocks) || reasoningBlocks.length === 0) return null;

    const paragraphs = [];
    for (const blk of reasoningBlocks) {
        const text = extractDisplayText(blk);
        if (text && text.trim().length > 0) paragraphs.push(text.trim());
    }
    if (paragraphs.length === 0) return null;

    // Each paragraph's text is HTML-escaped (so `<script>` in a reasoning
    // summary doesn't inject a tag). Paragraphs are joined with a blank
    // line so they render as separate visual paragraphs inside the
    // blockquote.
    const escapedParagraphs = paragraphs.map((p) => escapeHtml(p));
    const inner = escapedParagraphs.join('\n\n');
    return `<blockquote expandable>${inner}</blockquote>`;
}

module.exports = {
    formatExpandableBlockquote,
    extractDisplayText,
    escapeHtml,
};
