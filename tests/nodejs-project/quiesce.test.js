// BAT-1155 Codex re-review major-2 — the quiesce LEASE. A controlled Stop quiesces Node;
// an ABANDONED (kept-alive) Stop tries to /unquiesce, but if that call fails there may be no
// "next boot" to self-heal — so quiesce is a LEASE that auto-expires, guaranteeing a kept-alive
// agent resumes on its own even if every unquiesce is lost.

const path = require('path');
const assert = require('assert');

const quiescePath = path.join(__dirname, '..', '..', 'app', 'src', 'main', 'assets', 'nodejs-project', 'quiesce.js');
const q = require(quiescePath);

let failures = 0;
function ok(label, cond) {
    if (cond) console.log('PASS: ' + label);
    else { console.log('FAIL: ' + label); failures++; }
}

(async function run() {
    // Baseline: not quiesced.
    q.unquiesce();
    ok('starts un-quiesced', q.isQuiesced() === false);

    // quiesce() arms it; unquiesce() clears it; both idempotent.
    q.quiesce();
    ok('quiesce() → isQuiesced true', q.isQuiesced() === true);
    q.quiesce();
    ok('quiesce() is idempotent (still true)', q.isQuiesced() === true);
    q.unquiesce();
    ok('unquiesce() → isQuiesced false', q.isQuiesced() === false);
    q.unquiesce();
    ok('unquiesce() is idempotent (still false)', q.isQuiesced() === false);

    // LEASE: with a tiny lease, an un-refreshed quiesce auto-expires (the abandoned-Stop safety net).
    q._setLeaseMsForTest(40);
    q.quiesce();
    ok('lease armed → quiesced immediately', q.isQuiesced() === true);
    await new Promise((r) => setTimeout(r, 90));
    ok('lease EXPIRES without refresh → auto-resumes (no dependence on a next boot)', q.isQuiesced() === false);

    // Re-arming the lease (each /shutdown/flush) keeps it alive across the drain.
    q.quiesce();
    await new Promise((r) => setTimeout(r, 25));
    q.quiesce(); // refresh before expiry
    await new Promise((r) => setTimeout(r, 25));
    ok('re-arming before expiry keeps it quiesced', q.isQuiesced() === true);
    q.unquiesce();
    q._setLeaseMsForTest(q.LEASE_MS); // restore

    ok('LEASE_MS is a sane positive constant', typeof q.LEASE_MS === 'number' && q.LEASE_MS > 0);

    console.log();
    if (failures === 0) { console.log('ALL TESTS PASS'); process.exit(0); }
    else { console.log(`${failures} TEST(S) FAILED`); process.exit(1); }
})();
