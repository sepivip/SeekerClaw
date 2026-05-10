// tests/jupiter-ultra/lib/base58.js
//
// Self-contained base58 encode/decode (Bitcoin alphabet). Mirrors the
// implementation in payment/x402.js so test results match production
// exactly.

'use strict';

const ALPHABET = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';

function decode(str) {
    let zeros = 0;
    for (let i = 0; i < str.length && str[i] === '1'; i++) zeros++;
    let value = 0n;
    for (let i = 0; i < str.length; i++) {
        const idx = ALPHABET.indexOf(str[i]);
        if (idx < 0) throw new Error('Invalid base58 character: ' + str[i]);
        value = value * 58n + BigInt(idx);
    }
    const hex = value.toString(16);
    const hexPadded = hex.length % 2 ? '0' + hex : hex;
    const decoded = value === 0n ? Buffer.alloc(0) : Buffer.from(hexPadded, 'hex');
    const result = Buffer.alloc(zeros + decoded.length);
    decoded.copy(result, zeros);
    return result;
}

function encode(buf) {
    let zeros = 0;
    for (let i = 0; i < buf.length && buf[i] === 0; i++) zeros++;
    let value = 0n;
    for (let i = 0; i < buf.length; i++) value = value * 256n + BigInt(buf[i]);
    let result = '';
    while (value > 0n) {
        result = ALPHABET[Number(value % 58n)] + result;
        value = value / 58n;
    }
    return '1'.repeat(zeros) + result;
}

module.exports = { decode, encode };
