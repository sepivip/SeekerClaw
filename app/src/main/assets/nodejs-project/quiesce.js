// SeekerClaw — quiesce.js
// BAT-1155 Codex re-review blocker: a process-wide "controlled Stop in progress" latch.
//
// The pre-stop durability gate can only prove the on-disk xAI OAuth record is safe at ONE
// instant. Without a quiesce barrier, Node can begin a NEW turn / heartbeat / token refresh
// AFTER that "disk safe" acknowledgement and BEFORE the process is killed — consuming the
// on-disk refresh token (T0) and minting a new pair (T1) that the imminent kill then strands.
// The next boot replays the consumed T0 → the family-revocation brick, all over again.
//
// So a controlled Stop/restart QUIESCES the process first: new turns, heartbeat-triggered
// turns, and provider token ROTATIONS are refused while quiesced, in-flight work + OAuth
// persistence drain, the final durability signal is reported, and the process stays quiesced
// until teardown. If the Stop is ABANDONED (durability could not be established and the
// service is kept alive instead of killed), the caller explicitly unquiesces so the agent
// resumes normal operation.
//
// Single tiny module so every gate site (ai.js turns, main.js heartbeat, xai.js rotation,
// internal-control-server.js) shares ONE authoritative flag with no circular-require risk.

let _quiesced = false;

/** True while a controlled Stop/restart is draining — new turns/heartbeats/rotations must be refused. */
function isQuiesced() {
    return _quiesced;
}

/** Enter the quiesced state (idempotent). Called at the start of /shutdown/flush. */
function quiesce() {
    _quiesced = true;
}

/** Leave the quiesced state (idempotent). Called when a controlled Stop is ABANDONED (kept alive). */
function unquiesce() {
    _quiesced = false;
}

module.exports = { isQuiesced, quiesce, unquiesce };
