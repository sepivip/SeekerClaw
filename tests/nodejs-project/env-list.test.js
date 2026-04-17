#!/usr/bin/env node
const assert = require('assert');
const path = require('path');

// Mock config.js before requiring tools/env.js. tools/env.js will
// require('../config') — we inject a fake module via the cache.
const configPath = require.resolve(path.join(__dirname, '..', '..', 'app',
    'src', 'main', 'assets', 'nodejs-project', 'config.js'));
require.cache[configPath] = {
    id: configPath,
    filename: configPath,
    loaded: true,
    exports: {
        USER_ENV_KEYS: ['FOO', 'BAR', 'BAZ'],
        log: () => {},
    },
};

const envToolPath = path.join(__dirname, '..', '..', 'app', 'src', 'main',
    'assets', 'nodejs-project', 'tools', 'env.js');
const envMod = require(envToolPath);

const tests = [];
function t(name, fn) { tests.push([name, fn]); }

t('exports tools array with env_list', () => {
    assert.ok(Array.isArray(envMod.tools));
    const names = envMod.tools.map((x) => x.name);
    assert.deepStrictEqual(names, ['env_list']);
});

t('env_list description mentions values-never-returned guarantee', () => {
    const desc = envMod.tools[0].description;
    assert.ok(/never|names only|KEYS ONLY/i.test(desc),
        `description should note that values are NOT returned; got: ${desc}`);
});

t('env_list returns keys and count (plain object, not JSON string)', async () => {
    const handler = envMod.handlers.env_list;
    const result = await handler({});
    // Handler should return a plain object — ai.js does the JSON serialization.
    assert.strictEqual(typeof result, 'object', 'result must be an object, not a JSON string');
    assert.deepStrictEqual(result, {
        keys: ['BAR', 'BAZ', 'FOO'],
        count: 3,
    });
});

t('env_list empty when no keys set', async () => {
    require.cache[configPath].exports.USER_ENV_KEYS = [];
    delete require.cache[envToolPath];
    const freshEnvMod = require(envToolPath);
    const result = await freshEnvMod.handlers.env_list({});
    assert.deepStrictEqual(result, { keys: [], count: 0 });
});

let passed = 0, failed = 0;
(async () => {
    for (const [name, fn] of tests) {
        try { await fn(); console.log(`  ok  ${name}`); passed++; }
        catch (e) { console.error(`  FAIL ${name}\n    ${e.message}`); failed++; }
    }
    console.log(`\n${passed} passed, ${failed} failed`);
    process.exit(failed === 0 ? 0 : 1);
})();
