#!/usr/bin/env node
// tool-schemas.test.js — regression for the agent-killing bug discovered
// during BAT-582 device test 2026-05-12.
//
// Symptom: every agent turn errored with
//   `API error (400): Invalid schema for function 'agentpay': In context
//    'properties', 'body', 'type', '1', array schema missing items`
// taking down the entire agent (not just agent_pay) because the Anthropic
// API rejects the whole toolset if ANY tool has an invalid input_schema.
//
// Root cause: tools/agent_pay.js declared
//   body: { type: ['object', 'array', 'string'], description: '...' }
// JSON Schema rule: when `type` includes `array`, an `items` schema MUST
// be defined. Validators that accept polymorphic `type` unions still
// enforce per-type constraints (Anthropic strict-mode).
//
// What this test asserts:
//   1. Every tool registered in tools/index.js has an input_schema
//   2. Every input_schema is a JSON object with type === 'object'
//   3. Recursively, anywhere a schema declares `array` (as `type:'array'`
//      OR via `type` array union containing 'array'), `items` MUST be
//      defined.
//   4. Every required property name appears in `properties`.
//
// Run: node tests/nodejs-project/tool-schemas.test.js
//
// Why this exists, not just a Copilot-review rule: schema bugs surface
// only when the agent actually makes an API call with the tools attached.
// Device-side bug, $-affecting, blocked by zero existing automated test.
// This script runs in pre-push (no network, no device) and catches
// regressions before they reach the wire.

'use strict';

const assert = require('assert');
const path = require('path');

const BUNDLE = path.resolve(__dirname, '..', '..', 'app', 'src', 'main', 'assets', 'nodejs-project');

// ── Minimal mocks so requiring tools/index.js doesn't pull the world ────────
// We only need the TOOLS array — handlers and bridge are not exercised.
// Some transitive deps (security.js) read `config` as a destructured object
// and iterate Object.keys(config), so we have to expose a real (if empty)
// object — not undefined.
const configPath = require.resolve(path.join(BUNDLE, 'config.js'));
require.cache[configPath] = {
    id: configPath,
    filename: configPath,
    loaded: true,
    exports: {
        BRIDGE_TOKEN: 'test-token',
        CHANNEL: 'telegram',
        log: () => {},
        workDir: '/tmp/seekerclaw-test',
        config: {},
        REASONING_ENABLED: false,
        MAX_TOOL_USES: 25,
        HARD_MAX_TOOL_RESULT_CHARS: 50_000,
    },
};

// ── Load TOOLS ──────────────────────────────────────────────────────────────
const { TOOLS } = require(path.join(BUNDLE, 'tools', 'index.js'));

assert.ok(Array.isArray(TOOLS), 'TOOLS export must be an array');
assert.ok(TOOLS.length > 0, 'TOOLS array must be non-empty');

// ── Recursive schema walker ─────────────────────────────────────────────────
// Returns a list of issues. Empty list = schema is OK.
//
// `isTopLevel` distinguishes the tool's input_schema root from nested
// property / item / combinator schemas. Some Anthropic-API restrictions
// apply only at the top level (notably the oneOf/allOf/anyOf rule below).
function findSchemaIssues(schema, schemaPath /* string */, isTopLevel = false) {
    const issues = [];
    if (schema == null || typeof schema !== 'object') {
        issues.push(`${schemaPath}: schema is not an object (got ${typeof schema})`);
        return issues;
    }

    // Rule: Anthropic API REJECTS top-level oneOf, allOf, and anyOf in tool
    // input_schemas with HTTP 400 ("inputSchema does not support oneOf,
    // allOf, or anyOf at the top level") — which takes down the ENTIRE
    // toolset (not just the bad tool). Bit by this on PR #393 device test
    // 2026-06-02 when V2 became the default — jupiter_trigger_create V2
    // had a top-level `anyOf` for the expiresAt/expiryTime disjunction
    // (originally PR #388 R7 contract). Runtime handler validation is the
    // correct enforcement path; top-level combinators are not.
    if (isTopLevel) {
        for (const combinator of ['oneOf', 'anyOf', 'allOf']) {
            if (Object.prototype.hasOwnProperty.call(schema, combinator)) {
                issues.push(
                    `${schemaPath}: has top-level '${combinator}' — Anthropic API REJECTS this with `
                    + `HTTP 400 ("inputSchema does not support oneOf, allOf, or anyOf at the top level"), `
                    + `taking down ALL agent turns. Enforce the constraint in the tool handler instead.`
                );
            }
        }
    }

    // Resolve declared type(s) — string OR array of strings.
    const t = schema.type;
    const types = Array.isArray(t) ? t : (typeof t === 'string' ? [t] : []);

    // Rule: any schema that allows `array` must define `items`. The
    // Anthropic API enforces this even when type is a polymorphic union.
    // This is the rule that bit BAT-664 — without `items`, the entire
    // toolset is rejected with HTTP 400 and every agent turn fails.
    if (types.includes('array') && !Object.prototype.hasOwnProperty.call(schema, 'items')) {
        issues.push(`${schemaPath}: declares type 'array' (or union including it) but is missing required 'items' schema`);
    }

    // Rule: any schema that allows `object` and declares `properties`
    // must list `required` entries that all appear in `properties`.
    if (types.includes('object') && schema.properties && schema.required) {
        if (!Array.isArray(schema.required)) {
            issues.push(`${schemaPath}: 'required' must be an array, got ${typeof schema.required}`);
        } else {
            for (const name of schema.required) {
                if (!Object.prototype.hasOwnProperty.call(schema.properties, name)) {
                    issues.push(`${schemaPath}: 'required' lists "${name}" but it's not in properties`);
                }
            }
        }
    }

    // Recurse into nested schemas.
    if (schema.properties && typeof schema.properties === 'object') {
        for (const [k, v] of Object.entries(schema.properties)) {
            issues.push(...findSchemaIssues(v, `${schemaPath}.properties.${k}`));
        }
    }
    if (schema.items && typeof schema.items === 'object' && !Array.isArray(schema.items)) {
        // items can also be `{}` (= "any value") — that's valid and has
        // no nested constraints to walk. Only recurse when there's real
        // structure inside (any non-empty object schema).
        if (Object.keys(schema.items).length > 0) {
            issues.push(...findSchemaIssues(schema.items, `${schemaPath}.items`));
        }
    }
    for (const combinator of ['oneOf', 'anyOf', 'allOf']) {
        if (Array.isArray(schema[combinator])) {
            schema[combinator].forEach((s, i) => {
                issues.push(...findSchemaIssues(s, `${schemaPath}.${combinator}[${i}]`));
            });
        }
    }
    return issues;
}

// ── Run checks ──────────────────────────────────────────────────────────────
console.log(`Validating input_schema for ${TOOLS.length} tools…`);
let failed = 0;
const allIssues = [];

for (const tool of TOOLS) {
    assert.ok(typeof tool.name === 'string' && tool.name.length > 0,
        `tool missing name: ${JSON.stringify(tool).slice(0, 80)}`);
    assert.ok(typeof tool.description === 'string' && tool.description.length > 0,
        `tool ${tool.name}: missing or empty description`);
    assert.ok(tool.input_schema && typeof tool.input_schema === 'object',
        `tool ${tool.name}: missing input_schema`);
    assert.strictEqual(tool.input_schema.type, 'object',
        `tool ${tool.name}: input_schema.type must be 'object' (got ${JSON.stringify(tool.input_schema.type)})`);

    const issues = findSchemaIssues(tool.input_schema, `[${tool.name}].input_schema`, /* isTopLevel */ true);
    if (issues.length > 0) {
        failed++;
        allIssues.push({ tool: tool.name, issues });
    }
}

if (failed > 0) {
    console.error(`\n✗ ${failed} tool(s) have schema issues:\n`);
    for (const { tool, issues } of allIssues) {
        console.error(`  ${tool}:`);
        for (const issue of issues) console.error(`    - ${issue}`);
    }
    console.error('\nThese schemas would be rejected by the Anthropic API,');
    console.error('taking down ALL agent turns (not just calls to the bad tool).');
    process.exit(1);
}

console.log(`✓ All ${TOOLS.length} tool input_schemas pass JSON Schema validity checks`);

// ── Internal self-check: confirm the validator actually catches the bug ─────
// This is meta-test: if someone breaks `findSchemaIssues` (e.g. by removing
// the array-needs-items rule), the rest of the test stays green but we've
// lost the actual regression coverage. We synthesize the exact buggy
// schema shapes we've shipped historically and assert the validator flags
// each of them.
//
// Each entry's `topLevel` flag determines whether the validator should be
// invoked in top-level mode (mimics the tool's input_schema root) — some
// rules only fire at the top level.
const BUG_SHAPES = [
    {
        name: 'BAT-664: type union containing "array" without items (kills entire toolset on Anthropic)',
        topLevel: false,
        schema: {
            type: 'object',
            properties: {
                body: { type: ['object', 'array', 'string'], description: 'oops no items' },
            },
        },
    },
    {
        name: 'PR #393 / BAT-995: top-level anyOf (Anthropic: "inputSchema does not support oneOf, allOf, or anyOf at the top level")',
        topLevel: true,
        schema: {
            type: 'object',
            properties: { a: { type: 'string' }, b: { type: 'string' } },
            anyOf: [{ required: ['a'] }, { required: ['b'] }],
        },
    },
    {
        name: 'PR #393 / BAT-995: top-level oneOf (same Anthropic rejection class)',
        topLevel: true,
        schema: {
            type: 'object',
            properties: { a: { type: 'string' }, b: { type: 'string' } },
            oneOf: [{ required: ['a'] }, { required: ['b'] }],
        },
    },
    {
        name: 'PR #393 / BAT-995: top-level allOf (same Anthropic rejection class)',
        topLevel: true,
        schema: {
            type: 'object',
            properties: { a: { type: 'string' } },
            allOf: [{ required: ['a'] }],
        },
    },
];
let metaFailures = 0;
for (const { name, topLevel, schema } of BUG_SHAPES) {
    const found = findSchemaIssues(schema, '[meta]', topLevel);
    if (found.length === 0) {
        console.error(`✗ META-CHECK FAILED — validator no longer detects: ${name}`);
        console.error('  The regression rule has been weakened — restore the check in findSchemaIssues.');
        metaFailures++;
    } else {
        console.log(`  ✓ flags: ${name}`);
    }
}
if (metaFailures > 0) process.exit(1);
console.log(`✓ Meta-check: validator flags all ${BUG_SHAPES.length} historical bug shapes`);

// ── PR #388 R9: flag-on schema smoke (Jupiter Trigger V2) ───────────────────
// The jupiter_trigger_create schema is constructed flag-aware at module load
// (see tools/solana.js IIFE around line 145). The default flag-off pass above
// only validates the V1 schema. Reload tools/index.js with
// `config.useTriggerV2: true` so the V2 schema (incl. its `anyOf` expiry
// disjunction) goes through findSchemaIssues. Without this, a flag-on
// rollout could ship a malformed V2 schema undetected — the whole toolset
// would be rejected by the Anthropic API on first agent turn.
require.cache[configPath].exports.config = { useTriggerV2: true };
for (const key of Object.keys(require.cache)) {
    if (key.startsWith(BUNDLE) && key !== configPath) delete require.cache[key];
}
const { TOOLS: TOOLS_V2 } = require(path.join(BUNDLE, 'tools', 'index.js'));
const triggerCreateV2 = TOOLS_V2.find(t => t.name === 'jupiter_trigger_create');
assert.ok(triggerCreateV2, 'jupiter_trigger_create must be present in flag-on load');
// PR #393 / BAT-995 device test 2026-06-02: the original R7 contract here
// (V2 schema MUST declare a top-level anyOf for expiry disjunction) was
// WRONG — Anthropic API rejects top-level anyOf/oneOf/allOf with HTTP 400.
// Replaced with the inverse contract: V2 schema MUST NOT have top-level
// combinators (the handler's runtime check is the actual enforcement).
// PR #393 R5: use hasOwnProperty (matches findSchemaIssues' check) so an
// explicit `anyOf: undefined` or `anyOf: null` is ALSO rejected. Array.isArray
// on a non-array would let those slip through, even though the key itself
// is still present.
assert.ok(!Object.prototype.hasOwnProperty.call(triggerCreateV2.input_schema, 'anyOf'),
    'V2 schema MUST NOT declare top-level anyOf — Anthropic API rejects. '
    + 'See PR #393 BAT-995. Handler validates expiresAt/expiryTime at runtime.');
assert.ok(!Object.prototype.hasOwnProperty.call(triggerCreateV2.input_schema, 'oneOf'),
    'V2 schema MUST NOT declare top-level oneOf — Anthropic API rejects.');
assert.ok(!Object.prototype.hasOwnProperty.call(triggerCreateV2.input_schema, 'allOf'),
    'V2 schema MUST NOT declare top-level allOf — Anthropic API rejects.');
assert.ok(triggerCreateV2.input_schema.required.includes('triggerPriceUsd'),
    'V2 schema must require triggerPriceUsd (PR #388 R6 contract)');
const v2Issues = findSchemaIssues(triggerCreateV2.input_schema, '[jupiter_trigger_create.V2].input_schema', /* isTopLevel */ true);
if (v2Issues.length > 0) {
    console.error('\n✗ V2 jupiter_trigger_create schema has issues (flag-on load):');
    for (const issue of v2Issues) console.error(`    - ${issue}`);
    console.error('\nThis would take down the entire agent on a flag-on rollout.');
    process.exit(1);
}
// Walk the full flag-on TOOLS set too — any other tool that conditions its
// schema on the flag is now covered.
let v2Failed = 0;
const v2AllIssues = [];
for (const tool of TOOLS_V2) {
    const issues = findSchemaIssues(tool.input_schema, `[V2][${tool.name}].input_schema`, /* isTopLevel */ true);
    if (issues.length > 0) { v2Failed++; v2AllIssues.push({ tool: tool.name, issues }); }
}
if (v2Failed > 0) {
    console.error(`\n✗ ${v2Failed} tool(s) have schema issues under useTriggerV2=true:\n`);
    for (const { tool, issues } of v2AllIssues) {
        console.error(`  ${tool}:`);
        for (const issue of issues) console.error(`    - ${issue}`);
    }
    process.exit(1);
}
console.log(`✓ Flag-on (useTriggerV2=true): all ${TOOLS_V2.length} schemas pass + V2 jupiter_trigger_create has NO top-level anyOf/oneOf/allOf (Anthropic-rejected) + requires triggerPriceUsd`);
