// tools/flipper-invocation.js — turn-origin classification for Flipper IR (BAT-1202)
//
// Split out of `tools/flipper.js` for one reason: that file requires `../bridge`,
// whose load chain calls `process.exit()` outside the device, so it cannot be
// required by a test. This module has NO dependencies, so it can be — and this
// logic decides whether a physical appliance is allowed to actuate, which is not
// something to leave covered only by a device test on one channel.
//
// See tests/nodejs-project/flipper-invocation.test.js.

'use strict';

/**
 * Classify how a `flipper_press` reached us, from the framework-supplied chatId.
 *
 * The Kotlin bridge REFUSES anything classified as automation, so this is wrong
 * in both directions: too permissive lets a cron job actuate hardware with nobody
 * present, too restrictive kills the feature outright.
 *
 * ### The two channels disagree on the type
 *
 *   main.js  normalizeTelegramMessage → chatId: msg.chat.id     (JSON **number**)
 *   discord.js                        → chatId: msg.channel_id  (snowflake **string**)
 *
 * Telegram's id is passed through raw — note `senderId: String(msg.from?.id)` on
 * the line beside it, which *is* converted. So a `typeof chatId !== 'string'`
 * rejection classified every genuine Telegram message as automation and refused
 * it with `automation_not_allowed`, while Discord worked normally. Coerce first,
 * then test the sentinels.
 *
 * ### This is defence in depth, not a boundary
 *
 * `shell_exec` can curl the bridge directly and `js_eval` has `require('http')`,
 * so a sufficiently injected agent can bypass this file entirely and claim
 * whatever it likes. The bridge defaults to automation when the field is absent,
 * and the enforceable protections — the Kotlin allowlist, the master switch and
 * the rolling-hour ceiling — carry the real weight. Contract §4b amendment filed
 * on BAT-1201.
 *
 * @param {*} chatId framework-supplied conversation id
 * @returns {'user_message'|'automated'}
 */
function invocationFor(chatId) {
    const kind = typeof chatId;
    // Only scalar ids are meaningful. Anything else (object, function, null,
    // undefined, non-finite number) is not an id we can reason about — fail closed.
    if (kind !== 'string' && kind !== 'number' && kind !== 'bigint') return 'automated';
    if (kind === 'number' && !Number.isFinite(chatId)) return 'automated';

    const id = String(chatId);
    if (!id) return 'automated';
    // The same set tools/index.js uses for confirmation-gated tools: cron sessions
    // AND heartbeat probes. Checking only `cron:` left autonomous heartbeat turns
    // classified as user-driven, so they could fire IR.
    if (id.startsWith('cron:') || id === '__heartbeat__') return 'automated';
    return 'user_message';
}

module.exports = { invocationFor };
