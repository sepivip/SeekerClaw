// SeekerClaw — reasoning-display.js (BAT-549 Commit 4)
//
// Format captured reasoning blocks as a Telegram expandable blockquote
// for display in chat when `RuntimeState.reasoningDisplayInChat` is on.
// Pure helper: no IO, no telegram-API calls. Caller decides whether to
// render (gated on reasoningDisplayInChat) and how to send.
//
// ## Telegram expandable blockquote format
//
// MarkdownV2 syntax (Telegram Bot API 7.0+):
//   **>line 1
//   >line 2
//   >line 3||
//
// The leading `**>` opens an EXPANDABLE blockquote (collapsed by default,
// tap to expand). Each subsequent line starts with `>`. The closing `||`
// marks the end. Used because:
//  - Reasoning summaries can be long (multi-paragraph thinking).
//  - Most users don't want it inline; collapsed-by-default keeps the
//    chat readable.
//  - Power users can tap to expand for depth.
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
 * Telegram MarkdownV2 reserves these characters; they MUST be escaped
 * when emitting user-controlled text inside a blockquote (otherwise the
 * server returns 400 with "can't parse entities"). Escape with backslash.
 */
const _MDV2_RESERVED = /[_*[\]()~`>#+\-=|{}.!]/g;
function escapeMarkdownV2(text) {
    if (typeof text !== 'string') return '';
    return text.replace(_MDV2_RESERVED, '\\$&');
}

/**
 * Format an array of reasoningBlocks as a Telegram MarkdownV2 expandable
 * blockquote string. Returns `null` when no blocks have displayable text
 * — caller should skip sending entirely instead of emitting an empty
 * blockquote.
 *
 * Each block's text is a separate paragraph (blank-line-separated)
 * inside the blockquote. Lines inside each paragraph are prefixed with
 * `>` per the MarkdownV2 expandable-blockquote spec.
 */
function formatExpandableBlockquote(reasoningBlocks) {
    if (!Array.isArray(reasoningBlocks) || reasoningBlocks.length === 0) return null;

    const paragraphs = [];
    for (const blk of reasoningBlocks) {
        const text = extractDisplayText(blk);
        if (text && text.trim().length > 0) paragraphs.push(text.trim());
    }
    if (paragraphs.length === 0) return null;

    // Build the blockquote. First-line opener `**>`, every subsequent
    // line `>`, closing `||`. Blank lines between paragraphs render as
    // `>` (empty quote line) so the visual paragraph break is preserved
    // inside the collapsed view.
    const escapedLines = [];
    for (let i = 0; i < paragraphs.length; i++) {
        const para = paragraphs[i];
        for (const line of para.split('\n')) {
            escapedLines.push(escapeMarkdownV2(line));
        }
        if (i < paragraphs.length - 1) {
            escapedLines.push(''); // blank quote line between paragraphs
        }
    }

    const head = '**>' + escapedLines[0];
    const body = escapedLines.slice(1).map((l) => '>' + l).join('\n');
    return body.length > 0 ? `${head}\n${body}||` : `${head}||`;
}

module.exports = {
    formatExpandableBlockquote,
    extractDisplayText,
    escapeMarkdownV2,
};
