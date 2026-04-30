// SeekerClaw — reasoning-redact.js (BAT-549)
//
// Centralized log-redaction helper for reasoning content. Codex v4.1 review
// finding 1: NO raw reasoning snippets at any log level (mobile bug-report
// risk — logs get copied into screenshots and shared).
//
// Usage in any 4-adapter or ai.js log line that touches a reasoning block
// or array of blocks:
//
//   log(`[Custom] reasoning captured: ${redactReasoningBlocks(blocks)}`, 'INFO');
//
// Always returns a log-safe string — only length, type/kind, provider/model,
// block count, and short hash (sha256 first 8 chars). Never the raw payload.
//
// Allowed at any log level: provider id, sourceAdapter, sourceModel, turnId,
// schemaVersion, byte-lengths, fingerprint hashes, block counts, format type
// tags, OpenAI reasoning item ids (server-assigned, non-sensitive).
//
// Forbidden at every level (regression-tested): raw reasoning text, raw
// signature, raw encrypted_content base64, raw redacted_thinking.data, any
// first-N-chars sample of reasoning content.

'use strict';

const crypto = require('crypto');

/**
 * Short fingerprint of any string/buffer — first 8 hex chars of sha256.
 * Returns '-' for empty/missing input.
 */
function fingerprint(input) {
    if (input === null || input === undefined || input === '') return '-';
    const s = typeof input === 'string' ? input : JSON.stringify(input);
    return crypto.createHash('sha256').update(s, 'utf8').digest('hex').slice(0, 8);
}

/**
 * Byte length of a string (UTF-8). 0 for missing.
 */
function byteLen(s) {
    if (typeof s !== 'string') return 0;
    return Buffer.byteLength(s, 'utf8');
}

/**
 * Reduce a single reasoning block (the v4.1 wire-payload shape from the
 * BAT-549 contract: `{schemaVersion, provider, sourceAdapter, sourceModel,
 * turnId, wire, ...}`) to a log-safe single-line summary string.
 *
 * Per redaction matrix (contract §4):
 *  - Anthropic signature → sha256[:8] only
 *  - Anthropic thinking text → length + sha256[:8]
 *  - Anthropic redacted_thinking.data → sha256[:8] only
 *  - OpenAI encrypted_content → sha256[:8] + byte length
 *  - OpenAI summary text → length + sha256[:8]
 *  - OpenAI reasoning item id → verbatim (server-assigned, non-sensitive)
 *  - OpenRouter reasoning_details → format tag + per-item lengths + sha256[:8]
 *  - DeepSeek reasoning_content → length + sha256[:8]
 *  - Custom wire payload → length + sha256[:8]
 *
 * Output shape example (single block):
 *   "{provider=custom, model=deepseek-v4-pro, kind=plain, len=842, fp=a3b9c1d2}"
 */
function redactReasoningBlock(block) {
    if (!block || typeof block !== 'object') return '{empty}';

    const parts = [];
    if (block.provider) parts.push(`provider=${block.provider}`);
    if (block.sourceAdapter && block.sourceAdapter !== block.provider) {
        parts.push(`sourceAdapter=${block.sourceAdapter}`);
    }
    if (block.delegateAdapter) parts.push(`delegateAdapter=${block.delegateAdapter}`);
    if (block.sourceModel) parts.push(`model=${block.sourceModel}`);
    if (block.turnId) parts.push(`turnId=${block.turnId}`);
    if (typeof block.schemaVersion === 'number') parts.push(`v=${block.schemaVersion}`);

    const wire = block.wire;
    if (wire && typeof wire === 'object') {
        // Provider-specific structural summary (counts/lengths/fingerprints only)
        if (block.provider === 'anthropic') {
            const type = wire.type || 'thinking';
            parts.push(`kind=${type}`);
            if (type === 'thinking') {
                parts.push(`textLen=${byteLen(wire.thinking)}`);
                parts.push(`textFp=${fingerprint(wire.thinking)}`);
                parts.push(`sigFp=${fingerprint(wire.signature)}`);
            } else if (type === 'redacted_thinking') {
                parts.push(`dataFp=${fingerprint(wire.data)}`);
            }
        } else if (block.provider === 'openai') {
            // Wire is the full reasoning item from output[]
            if (wire.id) parts.push(`itemId=${wire.id}`);
            if (Array.isArray(wire.summary)) {
                const summaryLens = wire.summary.map(s => byteLen(s && s.text));
                parts.push(`summaryParts=${wire.summary.length}`);
                parts.push(`summaryLens=[${summaryLens.join(',')}]`);
                const totalText = wire.summary.map(s => s && s.text || '').join('');
                parts.push(`summaryFp=${fingerprint(totalText)}`);
            }
            if (typeof wire.encrypted_content === 'string') {
                parts.push(`encLen=${byteLen(wire.encrypted_content)}`);
                parts.push(`encFp=${fingerprint(wire.encrypted_content)}`);
            }
        } else if (block.provider === 'openrouter') {
            // Wire is one entry from reasoning_details[]
            const fmt = wire.format || 'unknown';
            const t = wire.type || 'reasoning.unknown';
            parts.push(`format=${fmt}`);
            parts.push(`type=${t}`);
            if (typeof wire.text === 'string') {
                parts.push(`textLen=${byteLen(wire.text)}`);
                parts.push(`textFp=${fingerprint(wire.text)}`);
            }
            if (typeof wire.encrypted === 'string') {
                parts.push(`encLen=${byteLen(wire.encrypted)}`);
                parts.push(`encFp=${fingerprint(wire.encrypted)}`);
            }
        } else if (block.provider === 'custom') {
            // Wire is gateway-shaped, treat opaquely
            if (typeof wire.reasoning_content === 'string') {
                parts.push(`kind=plain`);
                parts.push(`len=${byteLen(wire.reasoning_content)}`);
                parts.push(`fp=${fingerprint(wire.reasoning_content)}`);
            } else {
                // Unknown gateway shape — fingerprint the whole wire object
                const serialized = JSON.stringify(wire);
                parts.push(`kind=opaque`);
                parts.push(`len=${byteLen(serialized)}`);
                parts.push(`fp=${fingerprint(serialized)}`);
            }
        } else {
            // Unknown provider — fingerprint without disclosure
            const serialized = JSON.stringify(wire);
            parts.push(`kind=unknown`);
            parts.push(`len=${byteLen(serialized)}`);
            parts.push(`fp=${fingerprint(serialized)}`);
        }
    } else if (wire !== undefined) {
        parts.push(`wire=non-object`);
    }

    return `{${parts.join(', ')}}`;
}

/**
 * Reduce an array of reasoning blocks to a single log-safe summary string.
 * For empty/missing input returns "blocks=0".
 */
function redactReasoningBlocks(blocks) {
    if (!Array.isArray(blocks) || blocks.length === 0) return 'blocks=0';
    const summaries = blocks.map(redactReasoningBlock);
    return `blocks=${blocks.length} ${summaries.join(' ')}`;
}

/**
 * Reduce a single reasoning text/payload field (NOT a block — used when
 * code has the raw text in hand without wrapping it in a block yet).
 * Returns a log-safe `len=N fp=XXXXXXXX` summary.
 */
function redactReasoningField(value) {
    if (value === null || value === undefined) return 'absent';
    if (typeof value === 'string') return `len=${byteLen(value)} fp=${fingerprint(value)}`;
    if (typeof value === 'object') {
        const s = JSON.stringify(value);
        return `objLen=${byteLen(s)} fp=${fingerprint(s)}`;
    }
    return `type=${typeof value}`;
}

module.exports = {
    redactReasoningBlock,
    redactReasoningBlocks,
    redactReasoningField,
    fingerprint,
    byteLen,
};
