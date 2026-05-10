// tests/jupiter-ultra/lib/derive-pubkey.js
//
// Helper: read BURNER_SECRET_KEY from .env.test and print the base58 pubkey.
// Use to populate BURNER_PUBKEY after generating a fresh keypair.
//
// Run: node tests/jupiter-ultra/lib/derive-pubkey.js

'use strict';

const { load, parseSecretKey } = require('./load-env');
const base58 = require('./base58');

const env = load();
if (!env.BURNER_SECRET_KEY) {
    console.error('✗ BURNER_SECRET_KEY not set in .env.test');
    process.exit(1);
}
const { pubkey } = parseSecretKey(env.BURNER_SECRET_KEY);
console.log(base58.encode(pubkey));
