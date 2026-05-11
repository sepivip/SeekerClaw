// tests/jupiter-ultra/lib/generate-wallet.js
//
// Generate a fresh Solana keypair for local tests. Prints both the
// 64-number JSON array (paste into BURNER_SECRET_KEY) and the base58
// pubkey (paste into BURNER_PUBKEY).
//
// Run: node tests/jupiter-ultra/lib/generate-wallet.js
//
// IMPORTANT: this is a TEST wallet. Do not reuse for production.

'use strict';

const { generateKeyPairSync } = require('crypto');
const base58 = require('./base58');

const { publicKey, privateKey } = generateKeyPairSync('ed25519');
const secret = Buffer.from(privateKey.export({ format: 'jwk' }).d, 'base64url');
const pub    = Buffer.from(publicKey.export({  format: 'jwk' }).x, 'base64url');
const secretKey64 = Buffer.concat([secret, pub]);

console.log('═══ Fresh test wallet ═══');
console.log('');
console.log('BURNER_PUBKEY (base58):');
console.log(`  ${base58.encode(pub)}`);
console.log('');
console.log('BURNER_SECRET_KEY (64-number JSON array — paste into .env.test):');
console.log(`  ${JSON.stringify(Array.from(secretKey64))}`);
console.log('');
console.log('Fund the pubkey with ~0.02 SOL on mainnet, then run:');
console.log('  node tests/jupiter-ultra/01-probe-order.js');
console.log('');
console.log('⚠ TEST WALLET ONLY — do NOT use for real funds beyond test budget.');
