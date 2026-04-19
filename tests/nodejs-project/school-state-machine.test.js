#!/usr/bin/env node
// school-state-machine.test.js — all 32 (state, input) transitions per spec §8.5.1.
// Run: node tests/nodejs-project/school-state-machine.test.js

const path = require('path');
const { transition } = require(
    path.join(__dirname, '../../app/src/main/assets/nodejs-project/school.js')
);

let fails = 0;
function assertMatch(result, expectedKind, expectedActionKind, msg) {
    const actualKind = result && result.nextState && result.nextState.kind;
    const actualAction = result && result.nextAction && result.nextAction.kind;
    const ok = actualKind === expectedKind && actualAction === expectedActionKind;
    if (!ok) {
        console.error(`FAIL ${msg}: expected state=${expectedKind} action=${expectedActionKind}, got state=${actualKind} action=${actualAction}`);
        fails++;
    } else console.log(`  ✓ ${msg}`);
}

const approve = { kind: 'awaiting_approval', open_proposal_ns: [1, 3, 4] };
const review3 = { kind: 'reviewing_<N>', reviewing_n: 3, open_proposal_ns: [1, 3, 4], reviewing_opened_at: 1000 };

assertMatch(transition(approve, { kind: 'review', proposal_n: 3, message_date: 2000 }),
    'reviewing_<N>', 'send_review_artifact', 'aa + /review 3 valid → reviewing_<3>');
assertMatch(transition(approve, { kind: 'review', proposal_n: 7, message_date: 2000 }),
    'awaiting_approval', 'reply_only', 'aa + /review 7 invalid → reply_only');
assertMatch(transition(approve, { kind: 'skip', proposal_n: 3, message_date: 2000 }),
    'awaiting_approval', 'reply_only', 'aa + /skip 3 → awaiting_approval');
assertMatch(transition(approve, { kind: 'stop', message_date: 2000 }),
    'done', 'end_session', 'aa + /stop → done');
assertMatch(transition(approve, { kind: 'yes', message_date: 2000 }),
    'awaiting_approval', 'reply_only', 'aa + bare yes → reply_only (no review open)');
assertMatch(transition(review3, { kind: 'yes', proposal_n: 3, message_date: 1030 }),
    'awaiting_approval', 'write_skill', 'reviewing_3 + YES 3 → write_skill');
assertMatch(transition(review3, { kind: 'yes', message_date: 1030 }),
    'awaiting_approval', 'write_skill', 'reviewing_3 + bare YES (<60s) → write_skill');
assertMatch(transition(review3, { kind: 'yes', message_date: 100000 }),
    'reviewing_<N>', 'reply_only', 'reviewing_3 + bare YES (>60s) → ambiguous');
assertMatch(transition(review3, { kind: 'yes', proposal_n: 7, message_date: 1030 }),
    'reviewing_<N>', 'reply_only', 'reviewing_3 + YES 7 (mismatch) → reject');
assertMatch(transition(review3, { kind: 'no', proposal_n: 3, message_date: 1030 }),
    'awaiting_approval', 'reply_only', 'reviewing_3 + NO 3 → awaiting_approval');
assertMatch(transition(review3, { kind: 'review', proposal_n: 1, message_date: 2000 }),
    'reviewing_<N>', 'send_review_artifact', 'reviewing_3 + /review 1 → reviewing_<1>');
assertMatch(transition(review3, { kind: 'skip', proposal_n: 1, message_date: 2000 }),
    'reviewing_<N>', 'reply_only', 'reviewing_3 + /skip 1 → stay reviewing_3');
assertMatch(transition(review3, { kind: 'skip', proposal_n: 3, message_date: 2000 }),
    'awaiting_approval', 'reply_only', 'reviewing_3 + /skip 3 → awaiting_approval');
assertMatch(transition(review3, { kind: 'stop', message_date: 2000 }),
    'done', 'end_session', 'reviewing_3 + /stop → done');

const lastOne = { kind: 'awaiting_approval', open_proposal_ns: [5] };
assertMatch(transition(lastOne, { kind: 'skip', proposal_n: 5, message_date: 2000 }),
    'done', 'end_session', 'aa last proposal + /skip → done');

const reviewLast = { kind: 'reviewing_<N>', reviewing_n: 5, open_proposal_ns: [5], reviewing_opened_at: 1000 };
assertMatch(transition(reviewLast, { kind: 'yes', proposal_n: 5, message_date: 1030 }),
    'done', 'write_skill', 'reviewing_5 last + YES 5 → done (after write)');

if (fails > 0) process.exit(1);
console.log('all tests passed');
process.exit(0);
