// wallet/cap-hint.js — BAT-1409 P1-I: raising burner caps is Settings-only. The bridge refuses a
// raise (409 cap_raise_settings_only); every message that mentions raising a cap points here.

'use strict';

const CAP_RAISE_HINT = 'Raising caps is only possible in the SeekerClaw app: Settings → Burner Wallet.';

module.exports = { CAP_RAISE_HINT };
