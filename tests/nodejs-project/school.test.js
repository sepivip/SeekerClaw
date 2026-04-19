#!/usr/bin/env node
// school.test.js — pure functions in school.js.
// Run: node tests/nodejs-project/school.test.js

const path = require('path');
const { normalizeTitle, signatureOf } = require(
    path.join(__dirname, '../../app/src/main/assets/nodejs-project/school.js')
);

let fails = 0;
function assertEq(actual, expected, msg) {
    if (actual !== expected) {
        console.error(`FAIL ${msg}: expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
        fails++;
    } else console.log(`  ✓ ${msg}`);
}

// normalizeTitle — 4 variants collapse
assertEq(normalizeTitle('Recipe Scaling'), 'recipe-scaling', 'title spaces');
assertEq(normalizeTitle('recipe_scaling'), 'recipe-scaling', 'title underscore');
assertEq(normalizeTitle('recipe-scaling'), 'recipe-scaling', 'title kebab');
assertEq(normalizeTitle('RECIPE.SCALING!'), 'recipe-scaling', 'title upper+punct');
assertEq(normalizeTitle('  --recipe scaling--  '), 'recipe-scaling', 'title trimmed');

// Drift → different signature
if (signatureOf('create', 'Recipe Scaling') === signatureOf('create', 'recipe-scaling-v2')) {
    console.error(`FAIL signatureOf: v2 variant should differ from original`);
    fails++;
} else console.log('  ✓ signatureOf distinguishes v2 variant');

// Same title → same sig across cases
if (signatureOf('create', 'Recipe Scaling') !== signatureOf('create', 'RECIPE.SCALING!')) {
    console.error(`FAIL signatureOf: same normalized title should produce same sig`);
    fails++;
} else console.log('  ✓ signatureOf stable across case+punctuation');

if (fails > 0) process.exit(1);
console.log('all tests passed');
process.exit(0);
