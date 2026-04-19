#!/usr/bin/env node
// call-shape.test.js — per-tool shape builders. Must produce structural
// classifiers without leaking sensitive values (wallets, API keys, user text).
// Run: node tests/nodejs-project/call-shape.test.js

const path = require('path');
const { getShape } = require(path.join(__dirname, '../../app/src/main/assets/nodejs-project/call-shape.js'));

let fails = 0;
function assertEq(actual, expected, msg) {
    if (actual !== expected) {
        console.error(`FAIL ${msg}: expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
        fails++;
    } else {
        console.log(`  ✓ ${msg}`);
    }
}
function assertNotContains(shape, needle, msg) {
    if (typeof shape === 'string' && shape.includes(needle)) {
        console.error(`FAIL ${msg}: shape ${JSON.stringify(shape)} contained ${JSON.stringify(needle)}`);
        fails++;
    } else {
        console.log(`  ✓ ${msg}`);
    }
}

// web_fetch: host + method only
assertEq(getShape('web_fetch', { url: 'https://api.anthropic.com/v1/messages?key=secret', method: 'POST' }),
    'web_fetch:api.anthropic.com:POST', 'web_fetch shape: host+method');
assertEq(getShape('web_fetch', { url: 'https://example.com/path' }),
    'web_fetch:example.com:GET', 'web_fetch shape: default GET');

// solana_swap: well-known mints are public; unknown mints → "other"
assertEq(getShape('solana_swap', { inputMint: 'So11111111111111111111111111111111111111112', outputMint: 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v' }),
    'solana_swap:SOL:USDC', 'solana_swap shape: known mint pair');
assertEq(getShape('solana_swap', { inputMint: 'AbcXyzRandomMintAddress1234567890', outputMint: 'So11111111111111111111111111111111111111112' }),
    'solana_swap:other:SOL', 'solana_swap shape: unknown input mint → other');

// solana_balance: self vs other
assertEq(getShape('solana_balance', {}), 'solana_balance:self', 'solana_balance shape: self');
assertEq(getShape('solana_balance', { address: 'SomeOtherWallet' }), 'solana_balance:other', 'solana_balance shape: other');

// file_read: path pattern
assertEq(getShape('file_read', { path: 'memory/2026-04-19.md' }), 'file_read:memory/*.md', 'file_read shape: memory daily');
assertEq(getShape('file_read', { path: 'skills/weather.md' }), 'file_read:skills/*.md', 'file_read shape: skills');
assertEq(getShape('file_read', { path: 'SOUL.md' }), 'file_read:SOUL.md', 'file_read shape: root md');

// shell_exec: first token only
assertEq(getShape('shell_exec', { cmd: 'ls -la /tmp' }), 'shell_exec:ls', 'shell_exec shape: first token');
assertEq(getShape('shell_exec', { cmd: 'cat /etc/passwd' }), 'shell_exec:cat', 'shell_exec shape: cat');

// default — just the tool name
assertEq(getShape('some_new_unknown_tool', { whatever: 'x' }), 'some_new_unknown_tool',
    'default shape: just tool name');

// Privacy red-team — sensitive values never appear in shape
const wallet = 'AbcXyzWallet1234567890xxx';
const apiKey = 'sk-ant-api03-secret';
assertNotContains(getShape('solana_balance', { address: wallet }), wallet, 'wallet not in shape');
assertNotContains(getShape('web_fetch', { url: `https://example.com?key=${apiKey}` }), apiKey, 'api key not in shape');
assertNotContains(getShape('file_read', { path: 'memory/private-name-here.md' }), 'private-name-here', 'filename not in shape');

// Size cap — 64 chars max
const huge = 'solana_swap';
const longMint = 'X'.repeat(100);
const shape = getShape('solana_swap', { inputMint: longMint, outputMint: longMint });
if (shape.length > 64) {
    console.error(`FAIL shape length ${shape.length} > 64: ${shape}`);
    fails++;
} else {
    console.log(`  ✓ shape length capped at 64 chars`);
}

if (fails > 0) { console.error(`${fails} failures`); process.exit(1); }
console.log('all tests passed');
process.exit(0);
