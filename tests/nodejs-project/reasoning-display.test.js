#!/usr/bin/env node
// reasoning-display.test.js — pin BAT-549 Commit 4 reasoning-display
// helpers.
//
// What this guards:
//   - Per-provider display-text extraction (Anthropic, OpenAI, OpenRouter,
//     DeepSeek-via-OR, Custom) returns the human-readable summary
//   - Encrypted/redacted-only blocks return "" so the caller skips them
//   - Unknown wire shapes return "" (no JSON-stringify leak into chat)
//   - MarkdownV2 escape covers all reserved chars
//   - Expandable blockquote formatting:
//       * `**>` opener on first line, `>` on subsequent lines, `||` close
//       * Blank quote-line separator between paragraphs from different blocks
//       * Returns null when no blocks have displayable text
//
// Run:  node tests/nodejs-project/reasoning-display.test.js

'use strict';

const {
    formatExpandableBlockquote,
    extractDisplayText,
    escapeMarkdownV2,
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

// ── MarkdownV2 escape ────────────────────────────────────────────

console.log();
console.log('── escapeMarkdownV2 ──');

eq('escapes underscores', escapeMarkdownV2('_emphasis_'), '\\_emphasis\\_');
eq('escapes asterisks', escapeMarkdownV2('*bold*'), '\\*bold\\*');
eq('escapes brackets', escapeMarkdownV2('[link](url)'), '\\[link\\]\\(url\\)');
eq('escapes period and exclamation', escapeMarkdownV2('end.'), 'end\\.');
eq('escapes pipe and equals', escapeMarkdownV2('a|b=c'), 'a\\|b\\=c');
eq('escapes hyphen and plus', escapeMarkdownV2('1-2+3'), '1\\-2\\+3');
eq('escapes braces', escapeMarkdownV2('{x}'), '\\{x\\}');
eq('escapes hash and gt', escapeMarkdownV2('#h >q'), '\\#h \\>q');
eq('escapes backtick and tilde', escapeMarkdownV2('`code` ~strike~'), '\\`code\\` \\~strike\\~');
eq('plain text untouched', escapeMarkdownV2('hello world'), 'hello world');
eq('non-string returns ""', escapeMarkdownV2(42), '');

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

// Single block, single line
const singleBlock = [{
    provider: 'anthropic',
    wire: { type: 'thinking', thinking: 'Hello.' },
}];
const singleResult = formatExpandableBlockquote(singleBlock);
eq('single block single line: opens **> closes ||',
    singleResult, '**>Hello\\.||');

// Single block, multiple lines
const multiLineBlock = [{
    provider: 'anthropic',
    wire: { type: 'thinking', thinking: 'Line 1.\nLine 2.\nLine 3.' },
}];
const multiResult = formatExpandableBlockquote(multiLineBlock);
ok('multi-line: starts with **>',
    typeof multiResult === 'string' && multiResult.startsWith('**>Line 1\\.'));
ok('multi-line: subsequent lines start with >',
    typeof multiResult === 'string' && multiResult.includes('\n>Line 2\\.'));
ok('multi-line: ends with ||',
    typeof multiResult === 'string' && multiResult.endsWith('||'));

// Multiple blocks → blank quote-line between paragraphs
const multiBlock = [
    { provider: 'anthropic', wire: { type: 'thinking', thinking: 'First.' } },
    { provider: 'openai', wire: { type: 'reasoning', id: 'r1', summary: [{ type: 'summary_text', text: 'Second.' }] } },
];
const multiBlockResult = formatExpandableBlockquote(multiBlock);
ok('multiple blocks: blank quote line "\\n>\\n" between paragraphs',
    typeof multiBlockResult === 'string' && multiBlockResult.includes('\n>\n>Second\\.'));

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

// MarkdownV2 reserved chars in reasoning text are escaped
const specialCharsBlock = [{
    provider: 'anthropic',
    wire: { type: 'thinking', thinking: 'Use *bold* and (parens) and [brackets]!' },
}];
const escapedResult = formatExpandableBlockquote(specialCharsBlock);
ok('MarkdownV2 chars in reasoning text are escaped',
    typeof escapedResult === 'string'
    && escapedResult.includes('\\*bold\\*')
    && escapedResult.includes('\\(parens\\)')
    && escapedResult.includes('\\[brackets\\]')
    && escapedResult.includes('\\!'));

console.log();
if (failures === 0) {
    console.log('ALL TESTS PASS');
    process.exit(0);
} else {
    console.log(`${failures} TEST(S) FAILED`);
    process.exit(1);
}
