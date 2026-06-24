'use strict';
//
// BAT-1057: read a mint's Token-2022 TransferFee config to decide if a held
// token can be safely CONVERTED by the burner (heldToken → USDC/SOL).
//
// A fee-bearing Token-2022 input makes the burner spend `amount + fee`, but the
// burner-policy declares an EXACT debit of `amount` → simulation_delta_mismatch
// (fails closed, no theft, but a confusing reject). So in V1 we detect the fee
// BEFORE routing and send fee-bearing / unparseable Token-2022 inputs to main
// (Codex BAT-1057 v2, point 6: "unknown/unparseable Token-2022 mint config →
// main; never assume fee-free").
//
// Layout verified against real on-chain PYUSD mint data (2026-06-24): a
// Token-2022 mint WITH extensions is padded to the 165-byte account size, byte
// 165 is the account-type discriminator (1 = Mint), and TLV extensions start at
// byte 166 as { type:u16 LE, len:u16 LE, data:len }. TransferFeeConfig is
// extension type 1; its data is authority(32) + withdrawAuth(32) + withheld(8)
// + older_transfer_fee[epoch8, max8, bps2] + newer_transfer_fee[epoch8, max8,
// bps2] = 108 bytes. The current fee depends on the epoch, so we take
// max(older.bps, newer.bps) — conservative + epoch-independent.

const TOKEN_PROGRAM_ID = 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA';
const TOKEN_2022_PROGRAM_ID = 'TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb';

const EXT_TRANSFER_FEE_CONFIG = 1;
const ACCOUNT_TYPE_MINT = 1;
const MINT_PADDED_LEN = 165;             // base mint (82) padded to Account size before the type byte
const TRANSFER_FEE_CONFIG_MIN_LEN = 108; // authority(32)+withdraw(32)+withheld(8)+older(18)+newer(18)
const OLDER_BPS_OFFSET = 88;             // within the extension data: 32+32+8 + (epoch8+max8) = 88
const NEWER_BPS_OFFSET = 106;            // older(18) further: 88 + 18 = 106

/**
 * Determine a mint's token standard + transfer-fee bps from its account info.
 *
 * @param {string} owner - the mint account's owner program id (base58)
 * @param {string} base64Data - the mint account data (base64, from getAccountInfo)
 * @returns {{ standard: 'classic'|'token_2022'|'unknown', feeBps: number|null }}
 *   feeBps: 0 = fee-free (safe to convert); > 0 = fee-bearing (→ main in V1);
 *   null = could not determine (→ main; never assume fee-free).
 */
function readMintTransferFeeBps(owner, base64Data) {
    if (owner === TOKEN_PROGRAM_ID) return { standard: 'classic', feeBps: 0 }; // classic SPL has no transfer fee
    if (owner !== TOKEN_2022_PROGRAM_ID) return { standard: 'unknown', feeBps: null };

    let buf;
    try { buf = Buffer.from(base64Data || '', 'base64'); } catch (_) { return { standard: 'token_2022', feeBps: null }; }
    if (buf.length === 0) return { standard: 'token_2022', feeBps: null };

    // A base (un-extended) Token-2022 mint is 82 bytes → no extensions → no fee.
    if (buf.length <= MINT_PADDED_LEN) return { standard: 'token_2022', feeBps: 0 };

    // Extended mint: byte 165 MUST be the Mint account-type discriminator.
    if (buf[MINT_PADDED_LEN] !== ACCOUNT_TYPE_MINT) return { standard: 'token_2022', feeBps: null };

    let off = MINT_PADDED_LEN + 1; // TLV starts at byte 166
    let guard = 0;
    while (off + 4 <= buf.length) {
        if (++guard > 64) return { standard: 'token_2022', feeBps: null }; // runaway guard
        const extType = buf.readUInt16LE(off);
        const extLen = buf.readUInt16LE(off + 2);
        const dataStart = off + 4;
        if (dataStart + extLen > buf.length) return { standard: 'token_2022', feeBps: null }; // truncated TLV
        if (extType === EXT_TRANSFER_FEE_CONFIG) {
            if (extLen < TRANSFER_FEE_CONFIG_MIN_LEN) return { standard: 'token_2022', feeBps: null };
            const olderBps = buf.readUInt16LE(dataStart + OLDER_BPS_OFFSET);
            const newerBps = buf.readUInt16LE(dataStart + NEWER_BPS_OFFSET);
            return { standard: 'token_2022', feeBps: Math.max(olderBps, newerBps) };
        }
        if (extType === 0 && extLen === 0) break; // uninitialized padding tail → stop
        off = dataStart + extLen;
    }
    // Walked all extensions, no TransferFeeConfig → no transfer fee.
    return { standard: 'token_2022', feeBps: 0 };
}

module.exports = { readMintTransferFeeBps, TOKEN_PROGRAM_ID, TOKEN_2022_PROGRAM_ID };
