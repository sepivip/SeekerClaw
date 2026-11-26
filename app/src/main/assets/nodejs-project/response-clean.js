// SeekerClaw — response-clean.js
// The cleanup every agent reply passes through before a channel sends it: reasoning
// tags, internal markers and degenerate repeated lines are stripped. Pure functions,
// no I/O, so modules that must predict what will actually be delivered (the BAT-1705
// refusal notice) can run the same cleanup without loading a channel. telegram.js
// re-exports cleanResponse for its existing callers.

// Strip reasoning tags (<think>, <thinking>, etc.) and internal markers from AI responses.
// Ported from OpenClaw shared/text/reasoning-tags.ts and pi-embedded-utils.ts
function cleanResponse(text) {
    if (!text) return text;

    let cleaned = text;

    // Strip <think>...</think> and variants (think, thinking, thought, antthinking)
    // Quick check first to avoid regex work on clean text
    if (/<\s*\/?\s*(?:think(?:ing)?|thought|antthinking)\b/i.test(cleaned)) {
        // Remove matched pairs: <think>...</think> (including multiline content)
        cleaned = cleaned.replace(/<\s*(?:think(?:ing)?|thought|antthinking)\b[^>]*>[\s\S]*?<\s*\/\s*(?:think(?:ing)?|thought|antthinking)\s*>/gi, '');
        // Remove any orphaned opening tags (unclosed thinking block — strip to end)
        cleaned = cleaned.replace(/<\s*(?:think(?:ing)?|thought|antthinking)\b[^>]*>[\s\S]*/gi, '');
    }

    // Strip [Historical context: ...] markers
    cleaned = cleaned.replace(/\[Historical context:[^\]]*\]\n?/gi, '');

    // Repetition detector — catch degenerate model output (reasoning loops)
    // If any line appears 3+ times, keep first 2 and replace rest with a count.
    // Matching is case-insensitive with leading/trailing whitespace trimmed.
    cleaned = deduplicateRepeatedLines(cleaned);

    return cleaned.trim();
}

/**
 * Detect and collapse repeated lines in model output.
 * Keeps first 2 occurrences of any repeated line, replaces the rest with
 * "(repeated N more times)" to prevent degenerate output from reaching the user.
 * Only triggers at 3+ repetitions — normal content passes through unchanged.
 */
function deduplicateRepeatedLines(text) {
    if (!text) return text;
    const lines = text.split('\n');
    if (lines.length < 6) return text; // too short to have meaningful repetition

    // Count occurrences of each normalized line
    const counts = new Map();
    for (const line of lines) {
        const key = line.trim().toLowerCase();
        if (!key) continue; // skip blank lines
        counts.set(key, (counts.get(key) || 0) + 1);
    }

    // Check if any line repeats 3+ times
    let hasRepetition = false;
    for (const count of counts.values()) {
        if (count >= 3) { hasRepetition = true; break; }
    }
    if (!hasRepetition) return text;

    // Rebuild with deduplication
    const seen = new Map(); // normalized → times included so far
    const result = [];
    for (const line of lines) {
        const key = line.trim().toLowerCase();
        if (!key) { result.push(line); continue; } // preserve blank lines

        const total = counts.get(key) || 0;
        const seenCount = seen.get(key) || 0;

        if (total < 3) {
            // Not a repeated line — pass through
            result.push(line);
        } else if (seenCount < 2) {
            // Keep first 2 occurrences
            result.push(line);
            seen.set(key, seenCount + 1);
        } else if (seenCount === 2) {
            // Replace 3rd+ with count, preserving leading whitespace/list markers
            const prefix = line.match(/^(\s*(?:[-*•]\s*)?)/)[1] || '';
            result.push(`${prefix}(repeated ${total - 2} more times)`);
            seen.set(key, seenCount + 1);
        }
        // seenCount > 2: skip (already added the count message)
    }

    return result.join('\n');
}

module.exports = { cleanResponse, deduplicateRepeatedLines };
