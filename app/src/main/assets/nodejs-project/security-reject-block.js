// security-reject-block.js
//
// BAT-1039: deterministic rendering of a burner-policy SECURITY reject.
//
// When a wallet tool returns a reject with policyClass === 'security', the agent
// must surface the reject reason VERBATIM rather than let the model confabulate
// a cause. The ai.js tool loop short-circuits on the first such reject (so no
// further model / summary call ever sees the untrusted reason), then commits and
// returns the block this module builds.
//
// Pure + dependency-free so it loads in a bare-node unit test and the output is
// byte-for-byte assertable. The display reason is capped with an EXPLICIT
// truncation marker (never a bare ellipsis); the full raw reason stays in the
// structured tool result (and is NEVER logged raw — only its length).

'use strict';

// Universal display cap on the (attacker-influenced) reject reason. One
// constant, NO channel-specific logic: block ≤ ~1280 chars, which fits Discord's
// 2000-char limit. Telegram/console are larger still.
const SECURITY_REJECT_REASON_CAP = 1200;

// Codes that are a known fail-closed LIMITATION (not a suspicious tx) — for
// these only, the correct guidance IS the main-wallet (MWA) fallback. Mirrors
// the DIAGNOSTICS.md / ai.js door exception for the token_2022_* codes.
const MWA_FALLBACK_CODES = new Set([
    'token_2022_send_unsupported',
    'token_2022_extension_unsupported',
]);

// Fixed, code-mapped next-step guidance. Unknown security codes fall through to
// the class default — so a future security code (e.g. BAT-1027's
// drainer_undeclared_burner_ata) renders gracefully without a table edit.
function securityRejectGuidance(code) {
    if (MWA_FALLBACK_CODES.has(code)) {
        return 'This token is not autonomously supported by the burner. Retry the action from your main wallet (MWA) instead.';
    }
    if (code === 'simulation_delta_mismatch') {
        return 'The simulated balance change does not match the declared amount (a possible injected / tampered instruction). Do NOT retry; report the transaction for audit.';
    }
    // Class default for every other security code (drainer_*, signer_*, mint /
    // ownership mismatches, and any unrecognized security code).
    return 'The burner security policy blocked this transaction. Do NOT retry it — surface the reason to the user, and if this was unexpected, investigate the calling tool / upstream response or report it.';
}

// Build the deterministic block. The returned string is byte-identical to what
// ai.js commits to conversation history AND returns to the channel.
function buildSecurityRejectBlock(code, reason) {
    const safeCode = (typeof code === 'string' && code) ? code : 'unknown_security_reject';
    let displayReason = (typeof reason === 'string') ? reason : '';
    if (displayReason.length > SECURITY_REJECT_REASON_CAP) {
        const dropped = displayReason.length - SECURITY_REJECT_REASON_CAP;
        displayReason = displayReason.slice(0, SECURITY_REJECT_REASON_CAP)
            + `…[truncated ${dropped} chars; full reason in logs]`;
    }
    return [
        'SECURITY POLICY BLOCK',
        `Code:      ${safeCode}`,
        `Reason:    ${displayReason}`,
        `Next step: ${securityRejectGuidance(safeCode)}`,
    ].join('\n');
}

module.exports = {
    SECURITY_REJECT_REASON_CAP,
    MWA_FALLBACK_CODES,
    securityRejectGuidance,
    buildSecurityRejectBlock,
};
