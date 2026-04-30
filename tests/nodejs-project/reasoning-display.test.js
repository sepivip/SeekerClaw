#!/usr/bin/env node
// reasoning-display.test.js — pin BAT-549 Commit 4 reasoning-display
// helpers (R22 Copilot fix: now Telegram HTML, not MarkdownV2).
//
// What this guards:
//   - Per-provider display-text extraction (Anthropic, OpenAI, OpenRouter,
//     DeepSeek-via-OR, Custom) returns the human-readable summary
//   - Encrypted/redacted-only blocks return "" so the caller skips them
//   - Unknown wire shapes return "" (no JSON-stringify leak into chat)
//   - HTML escape covers the 3 entity-reserved chars (& < >)
//   - Expandable blockquote formatting:
//       * `<blockquote expandable>...</blockquote>` shape
//       * Multi-block paragraphs joined with blank line
//       * Returns null when no blocks have displayable text
//   - Telegram pipeline integration: caller sends with parse_mode='HTML'
//     and bypasses markdown-it conversion (output's angle brackets must
//     reach Telegram unescaped).
//
// Run:  node tests/nodejs-project/reasoning-display.test.js

'use strict';

const {
    formatExpandableBlockquote,
    extractDisplayText,
    escapeHtml,
} = require('../../app/src/main/assets/nodejs-project/reasoning-display');

let failures = 0;
function ok(label, cond, hint = '') {
    if (cond) console.log(`PASS: ${label}`);
    else { console.log(`FAIL: ${label}${hint ? ' — ' + hint : ''}`); failures++; }
}
function eq(label, actual, expected) {
    const a = JSON.stringify(actual), e = JSON.stringify(expected);
    if (a === e) console.log(`PASS: ${label}`);
    else { console.log(`FAIL: ${label}\n  actual:   ${a}\n  expected: ${e}`); failures++; }
}

// ── Per-provider extraction ──────────────────────────────────────

console.log('── extractDisplayText: per-provider shapes ──');

eq('Anthropic thinking → wire.thinking text',
    extractDisplayText({
        provider: 'anthropic',
        wire: { type: 'thinking', thinking: 'Let me think about this carefully.' },
    }),
    'Let me think about this carefully.');

eq('Anthropic redacted_thinking → "" (no human-readable text)',
    extractDisplayText({
        provider: 'anthropic',
        wire: { type: 'redacted_thinking', data: 'encrypted-blob' },
    }),
    '');

eq('OpenAI summary → joined summary[].text',
    extractDisplayText({
        provider: 'openai',
        wire: {
            type: 'reasoning',
            id: 'rs_01',
            summary: [
                { type: 'summary_text', text: 'First step.' },
                { type: 'summary_text', text: 'Second step.' },
            ],
        },
    }),
    'First step.\nSecond step.');

eq('OpenAI encrypted_content only (no summary) → ""',
    extractDisplayText({
        provider: 'openai',
        wire: {
            type: 'reasoning',
            id: 'rs_01',
            summary: [],
            encrypted_content: 'gAAA-blob',
        },
    }),
    '');

eq('OpenRouter normalized text field',
    extractDisplayText({
        provider: 'openrouter',
        wire: {
            type: 'reasoning.text',
            format: 'anthropic-claude-v1',
            text: 'Reasoning normalized by OR.',
        },
    }),
    'Reasoning normalized by OR.');

eq('DeepSeek via OR / Custom — reasoning_content',
    extractDisplayText({
        provider: 'custom',
        wire: { reasoning_content: 'V4 native thoughts here.' },
    }),
    'V4 native thoughts here.');

eq('Unknown wire shape → ""',
    extractDisplayText({
        provider: 'custom',
        wire: { mystery_field: 'opaque' },
    }),
    '');

eq('Empty block → ""', extractDisplayText({}), '');
eq('null wire → ""', extractDisplayText({ wire: null }), '');
eq('Array wire → ""', extractDisplayText({ wire: [] }), '');

// ── HTML escape ──────────────────────────────────────────────────

console.log();
console.log('── escapeHtml ──');

eq('escapes ampersand', escapeHtml('a & b'), 'a &amp; b');
eq('escapes less-than', escapeHtml('a < b'), 'a &lt; b');
eq('escapes greater-than', escapeHtml('a > b'), 'a &gt; b');
eq('escapes <script> tag', escapeHtml('<script>x</script>'), '&lt;script&gt;x&lt;/script&gt;');
eq('escape order: & first',
    escapeHtml('<&>'),
    '&lt;&amp;&gt;');
eq('plain text untouched', escapeHtml('hello world'), 'hello world');
eq('non-string returns ""', escapeHtml(42), '');
// MarkdownV2 chars NOT escaped here (HTML doesn't reserve them)
eq('asterisks pass through (HTML)', escapeHtml('*bold*'), '*bold*');
eq('parens pass through (HTML)', escapeHtml('(a)'), '(a)');

// ── formatExpandableBlockquote ───────────────────────────────────

console.log();
console.log('── formatExpandableBlockquote ──');

eq('null for empty array', formatExpandableBlockquote([]), null);
eq('null for non-array', formatExpandableBlockquote('not an array'), null);
eq('null for blocks with no displayable text',
    formatExpandableBlockquote([
        { wire: { type: 'redacted_thinking', data: 'blob' } },
        { wire: { mystery_field: 'opaque' } },
        { wire: null },
    ]),
    null);

// Single block, single line → wrapped in <blockquote expandable>
const singleBlock = [{
    provider: 'anthropic',
    wire: { type: 'thinking', thinking: 'Hello.' },
}];
eq('single block: <blockquote expandable>...</blockquote>',
    formatExpandableBlockquote(singleBlock),
    '<blockquote expandable>Hello.</blockquote>');

// Single block, multiple lines (newlines inside the same paragraph)
const multiLineBlock = [{
    provider: 'anthropic',
    wire: { type: 'thinking', thinking: 'Line 1.\nLine 2.\nLine 3.' },
}];
const multiResult = formatExpandableBlockquote(multiLineBlock);
ok('multi-line: starts with <blockquote expandable>',
    typeof multiResult === 'string' && multiResult.startsWith('<blockquote expandable>'));
ok('multi-line: ends with </blockquote>',
    typeof multiResult === 'string' && multiResult.endsWith('</blockquote>'));
ok('multi-line: preserves newlines inside the same paragraph',
    typeof multiResult === 'string' && multiResult.includes('Line 1.\nLine 2.'));

// Multiple blocks → blank line between paragraphs
const multiBlock = [
    { provider: 'anthropic', wire: { type: 'thinking', thinking: 'First.' } },
    { provider: 'openai', wire: { type: 'reasoning', id: 'r1', summary: [{ type: 'summary_text', text: 'Second.' }] } },
];
eq('multiple blocks: paragraphs separated by blank line',
    formatExpandableBlockquote(multiBlock),
    '<blockquote expandable>First.\n\nSecond.</blockquote>');

// Mix of displayable + non-displayable: skips the empty ones
const mixed = [
    { provider: 'anthropic', wire: { type: 'thinking', thinking: 'Visible.' } },
    { provider: 'anthropic', wire: { type: 'redacted_thinking', data: 'blob' } },
    { provider: 'openai', wire: { type: 'reasoning', summary: [], encrypted_content: 'enc' } },
    { provider: 'custom', wire: { reasoning_content: 'Also visible.' } },
];
const mixedResult = formatExpandableBlockquote(mixed);
ok('mixed: only blocks with text are included',
    typeof mixedResult === 'string'
    && mixedResult.includes('Visible')
    && mixedResult.includes('Also visible'));
ok('mixed: encrypted-only and redacted blocks NOT in output',
    typeof mixedResult === 'string'
    && !mixedResult.includes('blob')
    && !mixedResult.includes('enc'));

// HTML reserved chars in reasoning text are escaped — defends against
// `<script>`-shaped or `<blockquote>`-shaped reasoning text injecting
// tags into the message body.
const tagInjection = [{
    provider: 'anthropic',
    wire: { type: 'thinking', thinking: '<script>alert(1)</script>\n<blockquote>nested</blockquote>' },
}];
const escapedResult = formatExpandableBlockquote(tagInjection);
ok('HTML tag-injection in reasoning text is escaped',
    typeof escapedResult === 'string'
    && escapedResult.includes('&lt;script&gt;')
    && escapedResult.includes('&lt;/script&gt;')
    && escapedResult.includes('&lt;blockquote&gt;')
    && !escapedResult.includes('<script>'));
// The OUTER expandable blockquote tags are NOT escaped (they ARE meant
// to render). Only the inner content is escaped.
ok('outer <blockquote expandable> tags pass through unescaped',
    typeof escapedResult === 'string'
    && escapedResult.startsWith('<blockquote expandable>')
    && escapedResult.endsWith('</blockquote>'));

// Ampersand in reasoning text
const ampBlock = [{
    provider: 'anthropic',
    wire: { type: 'thinking', thinking: 'Both A & B.' },
}];
eq('ampersand escaped to &amp;',
    formatExpandableBlockquote(ampBlock),
    '<blockquote expandable>Both A &amp; B.</blockquote>');

console.log();
if (failures === 0) {
    console.log('ALL TESTS PASS');
    process.exit(0);
} else {
    console.log(`${failures} TEST(S) FAILED`);
    process.exit(1);
}
