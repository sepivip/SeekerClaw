// BAT-1157 (Codex diff review #4): the OpenAI sign-in family + epoch that config.js hands to
// providers/openai.js. Kept separate from config.js (which exits the process on invalid config)
// so the rule can be tested on its own.
//
// The epoch must be a JSON number that is a SAFE integer ≥ 1; Kotlin keeps it below
// Number.MAX_SAFE_INTEGER. Above 2^53 two different epochs compare equal, so an unsafe, string,
// fractional or non-positive epoch drops the family too. The first recovery is then a legacy
// confirm (null family, epoch 0) that adopts whatever the token store holds — never a compare
// against a mangled epoch.
'use strict';

function normalizeOAuthFamily(family, epoch) {
    const epochOk = Number.isSafeInteger(epoch) && epoch >= 1;
    const fam = (epochOk && typeof family === 'string') ? family.trim() : '';
    return fam ? { familyId: fam, epoch } : { familyId: null, epoch: 0 };
}

module.exports = { normalizeOAuthFamily };
