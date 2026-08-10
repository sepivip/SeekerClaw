// tools/flipper.js — Flipper Zero IR control (BAT-1202)
//
// Two narrow tools over a Bluetooth-paired Flipper Zero: list the remotes the
// user enabled, and fire one of their buttons.
//
// EVERY rule that matters is enforced in Kotlin, not here. This file is a thin
// pass-through by design — `shell_exec` can run curl and `js_eval` has
// `require('http')`, so anything enforced on this side is advisory at best. The
// allowlist, the resolution, the single-in-flight lock and the rate ceiling all
// live behind the bridge (contract BAT-1201 §3).
//
// Notably absent, and deliberately: no path parameter, no raw IR, no arbitrary
// RPC, no way to change what is allowed. The model names a remote and a button
// by the labels the user chose; the file path comes from the stored allowlist
// entry on the Kotlin side and is never accepted from here.

const { androidBridgeCall } = require('../bridge');

// The Kotlin press budget is 25s (§4a). This must exceed it, or a press that
// SUCCEEDED reports as a bridge timeout — and since IR power codes are almost
// all toggles, a retry would turn the appliance back off. The default 10s in
// bridge.js is far too short for a cold connect + app start + transmit.
const PRESS_TIMEOUT_MS = 30000;
const LIST_TIMEOUT_MS = 20000;

// Turn origin, using the convention already in the codebase: cron sessions run
// under a `cron:<jobId>` chatId (main.js:1042), which ai.js:646 keys off for its
// own cron-session handling. The model cannot set this — chatId is supplied by
// the framework, not by tool input.
//
// This is defence in depth, NOT a boundary: `shell_exec` can curl the bridge
// directly and `js_eval` has `require('http')`, so a sufficiently injected agent
// can bypass this file entirely and claim whatever it likes. The bridge defaults
// to "automated" when the field is absent, and the enforceable protections —
// the Kotlin allowlist and the rolling-hour ceiling — carry the real weight.
// Contract §4b amendment filed on BAT-1201.
function invocationFor(chatId) {
    if (typeof chatId !== 'string' || chatId.startsWith('cron:')) return 'automated';
    return 'user_message';
}

const tools = [
    {
        name: 'flipper_remotes',
        description:
            'List the infrared remotes the user has enabled for you on their Flipper Zero, ' +
            'and which buttons of each you may press. Use this to find the exact remote and ' +
            'button names before calling flipper_press — the names must match exactly. ' +
            'Returns only what the user explicitly enabled in SeekerClaw settings.',
        input_schema: {
            type: 'object',
            properties: {}
        }
    },
    {
        name: 'flipper_press',
        description:
            'Press one button on one of the user\'s enabled Flipper Zero remotes, which ' +
            'transmits that infrared command — for example turning on a TV or air conditioner. ' +
            'Use flipper_remotes first to get exact names; both must match exactly, including ' +
            'case. ' +
            'IMPORTANT: infrared is one-way. A successful result means the signal was ' +
            'transmitted, NOT that the appliance reacted — there is no way to know whether it ' +
            'did. Tell the user you sent the command, never that the device turned on or off. ' +
            'Do not retry a failed or uncertain press: most power buttons are toggles, so a ' +
            'repeat is as likely to undo the action as complete it.',
        input_schema: {
            type: 'object',
            properties: {
                remote: {
                    type: 'string',
                    description: 'Remote name exactly as returned by flipper_remotes'
                },
                button: {
                    type: 'string',
                    description: 'Button name exactly as returned by flipper_remotes'
                }
            },
            required: ['remote', 'button']
        }
    }
];

const handlers = {
    async flipper_remotes(input, chatId) {
        return await androidBridgeCall('/flipper/remotes', {}, LIST_TIMEOUT_MS);
    },

    async flipper_press(input, chatId) {
        // Passed through unmodified. Trimming or case-folding here would silently
        // diverge from the byte-exact match the bridge performs, turning a clear
        // "not allowed" into a confusing failure (§6 G4).
        return await androidBridgeCall(
            '/flipper/press',
            {
                remote: input.remote,
                button: input.button,
                invocation: invocationFor(chatId)
            },
            PRESS_TIMEOUT_MS
        );
    }
};

module.exports = { tools, handlers };
