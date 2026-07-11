#!/usr/bin/env node
// test-thinking-poison.js — ISOLATES the exact BAT-1033 trigger.
//
// The main repro probe (test-thinking-repro.js) replays each thinking block
// VERBATIM (real signature) → always 200, even when the thinking TEXT is empty.
// That proves empty-text is NOT the trigger. This script isolates the real one:
// the EMPTY SIGNATURE that http.js produces by dropping `signature_delta`.
//
// It fetches one real thinking block (sonnet-5, extended), then replays it 3 ways
// on a tool-loop turn:
//   A. verbatim            (real signature)      → control, expect 200
//   B. signature: ''       (http.js poison)      → expect 400 "must contain thinking"
//   C. signature stripped  (field deleted)       → expect 400
//
// Run: node tests/live/anthropic/test-thinking-poison.js
'use strict';

const https = require('https');
const { loadEnv, CC_BILLING_HEADER } = require('./lib');
loadEnv();

// Default to opus-4-8: it reliably emits the empty-text thinking block, and the
// signature trigger we're isolating is model-agnostic. Sonnet-5's thinking-block
// emission is stochastic (the very reason prod flaps), so it's a poor R1 source.
const MODEL = process.env.TEST_MODELS && process.env.TEST_MODELS.trim() && process.env.TEST_MODELS.trim() !== 'all'
    ? process.env.TEST_MODELS.split(',')[0].trim()
    : 'claude-opus-4-8';
const BETA = 'prompt-caching-2024-07-31,oauth-2025-04-20,interleaved-thinking-2025-05-14';
const TOOL = { name: 'get_weather', description: 'Get the current weather for a city.', input_schema: { type: 'object', properties: { city: { type: 'string' } }, required: ['city'] } };
const USER_MSG = 'What is the weather in Tbilisi right now? Use the get_weather tool, then tell me.';
const sys = () => [{ type: 'text', text: CC_BILLING_HEADER }, { type: 'text', text: 'You are a helpful assistant. Use tools when appropriate.' }];

function httpPost(token, bodyObj) {
    return new Promise((resolve, reject) => {
        const req = https.request({
            hostname: 'api.anthropic.com', path: '/v1/messages', method: 'POST',
            headers: { 'Content-Type': 'application/json', 'anthropic-version': '2023-06-01', 'anthropic-beta': BETA, 'Authorization': `Bearer ${token}` },
        }, (res) => { let d = ''; res.on('data', (c) => d += c); res.on('end', () => { let p; try { p = JSON.parse(d); } catch { p = d; } resolve({ status: res.statusCode, data: p }); }); });
        req.on('error', reject); req.setTimeout(60000, () => req.destroy(new Error('timeout')));
        req.write(JSON.stringify(bodyObj)); req.end();
    });
}

function classify(rr) {
    const m = rr.data?.error?.message || '';
    if (rr.status === 200) return '200 ✅';
    const tag = /each thinking block must contain thinking/i.test(m) ? '🎯 THE BUG (must contain thinking)' : m.slice(0, 70);
    return `${rr.status} ❌ ${tag}`;
}

(async () => {
    const token = process.env.SETUP_TOKEN || process.env.ANTHROPIC_SETUP_TOKEN;
    if (!token) { console.error('❌ Set SETUP_TOKEN in tests/live/anthropic/.env'); process.exit(1); }
    console.log(`🧪 BAT-1033 poison isolation — ${MODEL}\n`);

    // 1) Get a real assistant turn with a thinking block + tool_use.
    //    Thinking-block emission is stochastic, so retry until we get one.
    const base = { model: MODEL, max_tokens: 4096, stream: false, system: sys(), tools: [TOOL], thinking: { type: 'enabled', budget_tokens: 2000 } };
    let content = [];
    let thinkingBlock;
    let toolUse;
    for (let attempt = 1; attempt <= 6; attempt++) {
        const r1 = await httpPost(token, { ...base, messages: [{ role: 'user', content: USER_MSG }] });
        if (r1.status !== 200) { console.error(`R1 failed: ${r1.status} ${JSON.stringify(r1.data).slice(0, 120)}`); process.exit(1); }
        content = Array.isArray(r1.data.content) ? r1.data.content : [];
        thinkingBlock = content.find((b) => b.type === 'thinking');
        toolUse = content.find((b) => b.type === 'tool_use');
        if (thinkingBlock && toolUse) break;
        console.log(`  (attempt ${attempt}: got [${content.map((b) => b.type).join(',')}], retrying for thinking+tool_use…)`);
        await new Promise((r) => setTimeout(r, 1000));
    }
    if (!thinkingBlock || !toolUse) { console.error('Could not obtain a thinking+tool_use turn after 6 attempts.'); process.exit(1); }
    console.log(`R1 block: thinking(len=${(thinkingBlock.thinking || '').length}, sig=${thinkingBlock.signature ? `${thinkingBlock.signature.length} chars` : 'MISSING'})`);
    console.log(`         → the API returned an empty-TEXT thinking block WITH a real signature.\n`);

    const replay = (blk) => httpPost(token, { ...base, messages: [
        { role: 'user', content: USER_MSG },
        { role: 'assistant', content: content.map((b) => (b.type === 'thinking' ? blk : b)) },
        { role: 'user', content: [{ type: 'tool_result', tool_use_id: toolUse.id, content: '{"temp_c":18,"condition":"clear"}' }] },
    ] });

    // A) verbatim — control
    const A = await replay({ ...thinkingBlock });
    console.log(`A. verbatim (real signature)      → ${classify(A)}`);
    await new Promise((r) => setTimeout(r, 1000));

    // B) signature: '' — EXACTLY what http.js stores when it drops signature_delta
    const B = await replay({ ...thinkingBlock, signature: '' });
    console.log(`B. signature:'' (http.js poison)  → ${classify(B)}`);
    await new Promise((r) => setTimeout(r, 1000));

    // C) signature field removed entirely
    const cNoSig = { ...thinkingBlock }; delete cNoSig.signature;
    const C = await replay(cNoSig);
    console.log(`C. signature removed              → ${classify(C)}`);

    console.log('\nExpected: A=200 (verbatim OK), B & C = 400 "must contain thinking" (empty/missing sig = the bug).');
})();
