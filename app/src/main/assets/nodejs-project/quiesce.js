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

// Codex re-review major-2: a LEASE, not a sticky flag. An abandoned Stop that is KEPT ALIVE
// tries to /unquiesce, but that call can transiently fail (timeout/401) — and there may be no
// "next boot" to self-heal, so a sticky flag would freeze turns/heartbeats/rotations forever.
// Instead each quiesce() arms a short lease; if Kotlin stops refreshing it (Stop abandoned or
// crashed mid-drain), isQuiesced() auto-expires and the agent resumes on its own. A legitimate
// controlled Stop completes (kill or explicit /unquiesce) in well under the lease.
const LEASE_MS = 15_000;

// Monotonic clock — immune to wall-clock/NTP jumps (parity with the Kotlin gate's System.nanoTime).
function _nowMs() {
    return Number(process.hrtime.bigint() / 1_000_000n);
}

let _quiescedUntilMs = 0;
let _leaseMs = LEASE_MS; // overridable in tests to exercise expiry without a real 15s wait

/** True while a controlled Stop/restart is draining — new turns/heartbeats/rotations are refused. */
function isQuiesced() {
    if (_quiescedUntilMs === 0) return false;
    if (_nowMs() >= _quiescedUntilMs) { _quiescedUntilMs = 0; return false; } // lease expired → auto-resume
    return true;
}

/** (Re)arm the quiesce lease (idempotent). Called at the start of every /shutdown/flush. */
function quiesce() {
    _quiescedUntilMs = _nowMs() + _leaseMs;
}

/** Leave the quiesced state (idempotent). Called when a controlled Stop is ABANDONED (kept alive). */
function unquiesce() {
    _quiescedUntilMs = 0;
}

// Test seam only (not used by production): shrink the lease so the expiry path is testable.
function _setLeaseMsForTest(ms) { _leaseMs = ms; }

module.exports = { isQuiesced, quiesce, unquiesce, LEASE_MS, _setLeaseMsForTest };
