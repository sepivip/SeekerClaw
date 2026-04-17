// env tools — read-only surface for user-set environment variables.
// Only exposes KEY NAMES, never values. Values are accessible implicitly
// to shell_exec, js_eval, and skills via process.env. Writes are user-only
// via the Android UI — no env_set tool by design (prompt-injection hazard).

const { USER_ENV_KEYS } = require('../config');

const tools = [
    {
        name: 'env_list',
        description: 'List names of user-set environment variables. Returns KEYS ONLY, never values. Use this to check whether a credential (e.g. GITHUB_TOKEN, DATABASE_URL) is available before suggesting or attempting an action that requires it. Values are available to shell_exec, js_eval, and skills via process.env — you just cannot read them yourself. If a variable you need is not in the list, tell the user to add it in Settings → Env Vars.',
        input_schema: {
            type: 'object',
            properties: {},
            additionalProperties: false,
        },
    },
];

const handlers = {
    // Return a plain object — ai.js normalizes/serializes tool results.
    env_list: async (_input) => {
        const keys = [...USER_ENV_KEYS].sort();
        return { keys, count: keys.length };
    },
};

module.exports = { tools, handlers };
