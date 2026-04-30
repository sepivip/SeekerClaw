#!/usr/bin/env node
// reasoning-gating.test.js — pin Codex v4.1 finding 4 (conservative model
// gating) and finding 5 (Custom delegated wrapper gating) for BAT-549.
//
// What this test guards against:
//  - DeepSeek R1 regression: blanket sniff would crash R1 with 400.
//    Gating MUST return 'strip' for `deepseek-reasoner`/`deepseek-r1` IDs.
//  - DeepSeek V4 regression: server REQUIRES echo after tool calls. Gating
//    MUST return 'echo-on-tool-loop' for `deepseek-v4*` IDs.
//  - "Add a regex for /thinking/i" temptation: Codex explicitly rejected
//    this in v3. Qwen3-thinking, Mistral large-2407, Gemini deep-think,
//    Llama 4 thinking all start as `unknown` until tested.
//
// Run:  node tests/nodejs-project/reasoning-gating.test.js
// Exit: 0 = all pass, 1 = at least one failure.

'use strict';

const {
    detectCustomEchoBehavior,
    stripReasoningForCustomGating,
} = require('../../app/src/main/assets/nodejs-project/reasoning-gating');

let failures = 0;

function eq(label, actual, expected) {
    const a = JSON.stringify(actual);
    const e = JSON.stringify(expected);
    if (a === e) {
        console.log(`PASS: ${label}`);
    } else {
        console.log(`FAIL: ${label}\n  actual:   ${a}\n  expected: ${e}`);
        failures++;
    }
}

console.log('── detectCustomEchoBehavior — DeepSeek R1 (strip) ──');
eq('deepseek-reasoner → strip',           detectCustomEchoBehavior('deepseek-reasoner', false),       'strip');
eq('DeepSeek-R1 (mixed case) → strip',    detectCustomEchoBehavior('DeepSeek-R1', false),             'strip');
eq('deepseek-r1-distill → strip',         detectCustomEchoBehavior('deepseek-r1-distill', false),     'strip');

console.log();
console.log('── detectCustomEchoBehavior — DeepSeek V4 (echo) ──');
eq('deepseek-v4-pro → echo-on-tool-loop',   detectCustomEchoBehavior('deepseek-v4-pro', false),    'echo-on-tool-loop');
eq('deepseek-v4-flash → echo-on-tool-loop', detectCustomEchoBehavior('deepseek-v4-flash', false),  'echo-on-tool-loop');
eq('DEEPSEEK-V4-pro (upper) → echo',        detectCustomEchoBehavior('DEEPSEEK-V4-pro', false),    'echo-on-tool-loop');

console.log();
console.log('── detectCustomEchoBehavior — unknown families (capture-only) ──');
eq('qwen3-thinking → unknown',         detectCustomEchoBehavior('qwen3-thinking', false),         'unknown');
eq('mistral-large-2407 → unknown',     detectCustomEchoBehavior('mistral-large-2407', false),     'unknown');
eq('gemini-deep-think-pro → unknown',  detectCustomEchoBehavior('gemini-deep-think-pro', false),  'unknown');
eq('llama-4-thinking-70b → unknown',   detectCustomEchoBehavior('llama-4-thinking-70b', false),   'unknown');
eq('grok-4-thinking → unknown',        detectCustomEchoBehavior('grok-4-thinking', false),        'unknown');
eq('completely unknown → unknown',     detectCustomEchoBehavior('some-future-model-v9', false),   'unknown');

console.log();
console.log('── detectCustomEchoBehavior — degenerate input ──');
eq('null model → unknown',             detectCustomEchoBehavior(null, false),                     'unknown');
eq('undefined model → unknown',        detectCustomEchoBehavior(undefined, false),                'unknown');
eq('empty string → unknown',           detectCustomEchoBehavior('', false),                       'unknown');
eq('whitespace-only → unknown',        detectCustomEchoBehavior('   ', false),                    'unknown');
eq('non-string → unknown',             detectCustomEchoBehavior(42, false),                       'unknown');

console.log();
console.log('── customEchoOverride forces echo regardless of model ──');
eq('override + R1 → echo',             detectCustomEchoBehavior('deepseek-reasoner', true),       'echo-on-tool-loop');
eq('override + unknown → echo',        detectCustomEchoBehavior('qwen3-thinking', true),          'echo-on-tool-loop');
eq('override + V4 → echo',             detectCustomEchoBehavior('deepseek-v4-pro', true),         'echo-on-tool-loop');

console.log();
console.log('── stripReasoningForCustomGating — strip mode (R1 path) ──');

const messagesWithReasoning = [
    { role: 'user', content: 'hi' },
    {
        role: 'assistant',
        content: 'thinking...',
        toolCalls: [{ id: 'tc1', name: 'echo', input: { x: 1 } }],
        reasoningBlocks: [
            { schemaVersion: 1, provider: 'custom', sourceAdapter: 'custom',
              delegateAdapter: 'openrouter', sourceModel: 'deepseek-r1',
              wire: { reasoning_content: 'I considered options A, B, C…' } },
        ],
    },
    { role: 'tool', toolCallId: 'tc1', content: 'result' },
];

const stripped = stripReasoningForCustomGating(messagesWithReasoning, 'strip');
eq('strip: assistant.reasoningBlocks emptied', stripped[1].reasoningBlocks, []);
eq('strip: assistant.content preserved',       stripped[1].content,         'thinking...');
eq('strip: assistant.toolCalls preserved',     stripped[1].toolCalls.length, 1);
eq('strip: user message untouched',            stripped[0],                  messagesWithReasoning[0]);
eq('strip: tool message untouched',            stripped[2],                  messagesWithReasoning[2]);
// Original messages must NOT be mutated (immutability contract)
eq('strip: original assistant.reasoningBlocks unchanged',
   messagesWithReasoning[1].reasoningBlocks.length, 1);

console.log();
console.log('── stripReasoningForCustomGating — unknown mode ──');
const strippedUnknown = stripReasoningForCustomGating(messagesWithReasoning, 'unknown');
eq('unknown: assistant.reasoningBlocks emptied', strippedUnknown[1].reasoningBlocks, []);

console.log();
console.log('── stripReasoningForCustomGating — echo mode (V4 path) ──');
const echoed = stripReasoningForCustomGating(messagesWithReasoning, 'echo-on-tool-loop');
eq('echo: messages array passes through (===)',   echoed === messagesWithReasoning, true);
eq('echo: reasoningBlocks preserved on assistant',  echoed[1].reasoningBlocks.length, 1);

console.log();
console.log('── stripReasoningForCustomGating — degenerate input ──');
eq('non-array messages → returned as-is', stripReasoningForCustomGating(null, 'strip'),       null);
eq('empty array → empty array',           stripReasoningForCustomGating([], 'strip'),         []);

console.log();
console.log('── OpenRouter prefix-style model ids (Copilot 2a R1 finding 1) ──');
// OpenRouter routes models with the `<vendor>/<model>` prefix shape.
// Native OpenRouter is freeform — the user can configure
// `deepseek/deepseek-r1-0528` and the same R1 strip / V4 echo gating
// MUST apply on the native path, not just the bare-id Custom path.
eq('deepseek/deepseek-r1 (OR-prefix) → strip',
    detectCustomEchoBehavior('deepseek/deepseek-r1', false), 'strip');
eq('deepseek/deepseek-r1-0528 (OR-prefix, with date suffix) → strip',
    detectCustomEchoBehavior('deepseek/deepseek-r1-0528', false), 'strip');
eq('deepseek/deepseek-reasoner (OR-prefix) → strip',
    detectCustomEchoBehavior('deepseek/deepseek-reasoner', false), 'strip');
eq('deepseek/deepseek-v4-pro (OR-prefix) → echo-on-tool-loop',
    detectCustomEchoBehavior('deepseek/deepseek-v4-pro', false), 'echo-on-tool-loop');
eq('deepseek/deepseek-v4-flash (OR-prefix) → echo-on-tool-loop',
    detectCustomEchoBehavior('deepseek/deepseek-v4-flash', false), 'echo-on-tool-loop');
// Don't false-positive on lookalikes
eq('deepseek/deepseek-chat-v3.1 (V3 chat — not V4) → unknown',
    detectCustomEchoBehavior('deepseek/deepseek-chat-v3.1', false), 'unknown');
eq('anthropic/claude-sonnet-4-6 (non-deepseek prefix) → unknown',
    detectCustomEchoBehavior('anthropic/claude-sonnet-4-6', false), 'unknown');
eq('mistralai/mistral-large-2407 (non-deepseek) → unknown',
    detectCustomEchoBehavior('mistralai/mistral-large-2407', false), 'unknown');
// Bare ids still work (Custom adapter pointed at api.deepseek.com)
eq('Bare deepseek-r1 (no prefix) → strip',
    detectCustomEchoBehavior('deepseek-r1', false), 'strip');
eq('Bare deepseek-v4-pro (no prefix) → echo-on-tool-loop',
    detectCustomEchoBehavior('deepseek-v4-pro', false), 'echo-on-tool-loop');

console.log();
if (failures === 0) {
    console.log('ALL TESTS PASS');
    process.exit(0);
} else {
    console.log(`${failures} TEST(S) FAILED`);
    process.exit(1);
}
