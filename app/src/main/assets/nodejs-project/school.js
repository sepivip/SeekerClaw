// school.js — pure module for Go to School feature. No side effects at module load.
// Grows over Phase B: B1 (this commit) = normalizeTitle + signatureOf.
// B2+ adds state-machine transition, pattern mining, skill file writers, persistent-log helpers.

const crypto = require('crypto');

// normalizeTitle(raw: string) → kebab-case slug.
// Non-ASCII chars (é, ñ, CJK) are dropped by the [^a-z0-9-] filter — acceptable
// for v1 since titles are agent-generated and always English.
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
