// school.js — pure module for Go to School feature.
// Provides state-machine transition, pattern mining, skill file writers,
// and persistent-log helpers. No side effects at module load.

const crypto = require('crypto');

function normalizeTitle(raw) {
    return String(raw || '')
        .toLowerCase()
        .replace(/[_\s.]+/g, '-')
        .replace(/[^a-z0-9-]/g, '')
        .replace(/-+/g, '-')
        .replace(/^-|-$/g, '');
}

function signatureOf(type, title) {
    const norm = normalizeTitle(title);
    return 'sha256:' + crypto.createHash('sha256').update(`${type}|${norm}`).digest('hex');
}

module.exports = { normalizeTitle, signatureOf };
