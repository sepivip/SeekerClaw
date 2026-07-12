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
        // BAT-1148: V2 is now the DEFAULT order path. Mirror the production
        // default (jupiter/trigger-flag.js resolveUseTriggerV2 → true, unit-
        // tested in trigger-v2-flag.test.js) so the top-of-file TOOLS load
        // validates the V2 schema. The forced-off (V1) kill-switch is exercised
        // in the second load below.
        config: { useTriggerV2: true },
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
function findSchemaIssues(schema, schemaPath /* string */) {
    const issues = [];
    if (schema == null || typeof schema !== 'object') {
        issues.push(`${schemaPath}: schema is not an object (got ${typeof schema})`);
        return issues;
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

    const issues = findSchemaIssues(tool.input_schema, `[${tool.name}].input_schema`);
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
// lost the actual regression coverage. So we synthesize the exact buggy
// schema BAT-664 shipped and assert the validator flags it.
const synthBug = {
    type: 'object',
    properties: {
        body: { type: ['object', 'array', 'string'], description: 'oops no items' },
    },
};
const synthIssues = findSchemaIssues(synthBug, '[meta]');
if (synthIssues.length === 0) {
    console.error('✗ META-CHECK FAILED — validator no longer detects the BAT-664 bug shape');
    console.error('  (type union containing "array" without items). The regression');
    console.error('  rule has been weakened — restore the check in findSchemaIssues.');
    process.exit(1);
}
console.log(`✓ Meta-check: validator correctly flags the BAT-664 bug shape (${synthIssues.length} issue${synthIssues.length === 1 ? '' : 's'})`);

// ── BAT-1148: default-on (V2) + forced-off (V1) schema smoke ────────────────
// jupiter_trigger_create's schema is built flag-aware at module load
// (tools/solana.js IIFE). Since BAT-1148, V2 is the DEFAULT — the top-of-file
// TOOLS pass above already walked the full V2 toolset. Here we (a) assert the
// default schema really is the V2 shape, then (b) force the V1 kill-switch
// (useTriggerV2:false), reload, and validate the V1 toolset — so a regression
// in EITHER flag state (a malformed V2 anyOf, or a broken V1 fallback) is
// caught before the Anthropic API rejects the whole toolset on the first turn.

// (a) DEFAULT = V2 — assert the shape on the already-loaded TOOLS.
const triggerCreateV2 = TOOLS.find(t => t.name === 'jupiter_trigger_create');
assert.ok(triggerCreateV2, 'jupiter_trigger_create must be present in the default (V2) load');
assert.ok(Array.isArray(triggerCreateV2.input_schema.anyOf),
    'DEFAULT V2 schema must declare an anyOf for the expiry disjunction (BAT-1148: V2 is now default)');
assert.ok(triggerCreateV2.input_schema.required.includes('triggerPriceUsd'),
    'DEFAULT V2 schema must require triggerPriceUsd (BAT-1148: V2 is now default)');
console.log('✓ Default-on (V2): jupiter_trigger_create has anyOf expiry + requires triggerPriceUsd');

// (b) FORCED-OFF = V1 kill-switch — reload with useTriggerV2:false and validate.
require.cache[configPath].exports.config = { useTriggerV2: false };
for (const key of Object.keys(require.cache)) {
    if (key.startsWith(BUNDLE) && key !== configPath) delete require.cache[key];
}
const { TOOLS: TOOLS_V1 } = require(path.join(BUNDLE, 'tools', 'index.js'));
const triggerCreateV1 = TOOLS_V1.find(t => t.name === 'jupiter_trigger_create');
assert.ok(triggerCreateV1, 'jupiter_trigger_create must be present in the forced-off (V1) load');
assert.ok(triggerCreateV1.input_schema.required.includes('triggerPrice'),
    'V1 kill-switch schema must require triggerPrice');
assert.ok(!triggerCreateV1.input_schema.required.includes('triggerPriceUsd'),
    'V1 kill-switch schema must NOT require the V2-only triggerPriceUsd');
assert.ok(!Array.isArray(triggerCreateV1.input_schema.anyOf),
    'V1 kill-switch schema must NOT carry the V2 anyOf expiry disjunction');
let v1Failed = 0;
const v1AllIssues = [];
for (const tool of TOOLS_V1) {
    const issues = findSchemaIssues(tool.input_schema, `[V1][${tool.name}].input_schema`);
    if (issues.length > 0) { v1Failed++; v1AllIssues.push({ tool: tool.name, issues }); }
}
if (v1Failed > 0) {
    console.error(`\n✗ ${v1Failed} tool(s) have schema issues under useTriggerV2=false (V1 kill-switch):\n`);
    for (const { tool, issues } of v1AllIssues) {
        console.error(`  ${tool}:`);
        for (const issue of issues) console.error(`    - ${issue}`);
    }
    process.exit(1);
}
console.log(`✓ Forced-off (useTriggerV2=false / V1 kill-switch): all ${TOOLS_V1.length} schemas pass + V1 jupiter_trigger_create requires triggerPrice (no anyOf)`);
