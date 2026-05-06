// tests/payment/fixture-loader.js — BAT-582 Phase 6.
//
// Reads x402 / pay.sh test fixtures from JSON. Splits the leading
// `_fixture` metadata object out of the wire-shape (status, headers, body)
// so consumers can match against either independently. Tests can use
// `loadFixture('paysh-sandbox-402')` to get `{ wire: <wire-shape>, meta:
// <fixture metadata or null> }` — `wire` is the {status, headers, body}
// payload tests assert against; `meta` carries human-readable context
// (description, source URL, etc.).

'use strict';

const fs = require('fs');
const path = require('path');

const FIXTURE_DIR = path.join(__dirname, 'fixtures');

function loadFixture(name) {
    const file = path.join(FIXTURE_DIR, `${name}.json`);
    const raw = JSON.parse(fs.readFileSync(file, 'utf8'));
    // Strip metadata that's for human readers — wire shape is what matters.
    const { _fixture, ...rest } = raw;
    return { wire: rest, meta: _fixture || null };
}

module.exports = { loadFixture, FIXTURE_DIR };
