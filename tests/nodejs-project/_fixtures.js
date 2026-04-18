// _fixtures.js — shared test fixtures for nodejs-project tests.
//
// database.js transitively requires config.js, which reads config.json from
// process.argv[2] (falls back to __dirname) and calls process.exit(1) if the
// file is missing. This helper stands up a minimal fixture workdir so the
// require succeeds in a standalone test environment.

const fs = require('fs');
const os = require('os');
const path = require('path');

/**
 * Create a tmp workdir with a minimal config.json and point process.argv[2]
 * at it, so requiring config.js (and anything that depends on it) doesn't
 * exit the test process.
 *
 * @param {string} [prefix='seekerclaw-test-'] - tmpdir prefix for debuggability
 * @returns {string} The fixture directory path.
 */
function setupConfigFixture(prefix = 'seekerclaw-test-') {
    const fixtureDir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
    fs.writeFileSync(path.join(fixtureDir, 'config.json'), JSON.stringify({
        channel: 'telegram',
        botToken: 'test-bot-token',
        ownerId: '1',
        provider: 'claude',
        anthropicApiKey: 'test-anthropic-key',
        agentName: 'TestAgent',
    }));
    process.argv[2] = fixtureDir;
    return fixtureDir;
}

module.exports = { setupConfigFixture };
