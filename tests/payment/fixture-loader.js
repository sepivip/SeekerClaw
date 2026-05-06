// tests/payment/fixture-loader.js — BAT-582 Phase 6.
//
// Reads x402 / pay.sh test fixtures from JSON. Strips the leading `_fixture`
// metadata object so consumers see only the wire-shape (status, headers,
// body). Tests can use `loadFixture('paysh-sandbox-402')` for a clean
// {status, headers, body} object.

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
