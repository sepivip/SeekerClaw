// SeekerClaw — payment/x402.js
// X402 protocol implementation. pay.sh-compatible Solana mainnet USDC
// settlement.
//
// CONTRACT (per BAT-582 v1.6 — Codex sign-off 2026-05-10)
// -------------------------------------------------------
// detect + build + settle all support BOTH x402 v1 AND v2.
// Per-version mechanics in the settle() docs below. The bridge
// multi-sig piece (Android-side signing of partially-signed v2 txs)
// lives in SolanaTxSigner + the /burner/sign-transaction endpoint
// with allowPartiallySigned=true.
//
// detect(response):
//   - true when response.status === 402 AND a usable Solana mainnet
//     payment requirement exists (body OR `payment-required` header,
//     scheme=exact, version 1 or 2). False for v3+, malformed bodies,
//     EVM-only multi-chain offers, devnet/testnet Solana variants.
//
// build(response, ctx):
//   - Extracts requirements payload from body (`accepts` /
//     `paymentRequirements`) OR `payment-required` header (base64 JSON).
//   - Validates x402Version (1 or 2 accepted; 3+ → unsupported_version;
//     missing → missing_x402_version).
//   - Walks `accepts` for first Solana mainnet entry with scheme=exact:
//     - bare network "solana" → mainnet (v1 backward compat)
//     - CAIP-2 network "solana:5eykt4Us…vdp" → mainnet
//     - any other Solana genesis → non_mainnet_solana
//     - no Solana entry → no_solana_offer
//   - Reads `amount` (v2) or `maxAmountRequired` (v1). Both present
//     and differing → conflicting_amount_fields.
//   - Validates asset = USDC mint (rejects EVM-shaped 0x… addresses
//     defensively even if upstream picked solana).
//   - Validates payTo as valid Solana base58 pubkey.
//   - Builds USDC SPL TransferChecked tx.
//   - Returns { txBase64, paymentMeta } with paymentMeta.x402Version
//     and paymentMeta.negotiatedNetwork captured for settle().
//
// settle(originalRequest, signedTxBase64, paymentMeta):
//   - v1 (paymentMeta.x402Version === 1): replays request with
//     `x-payment` base64-JSON header per the canonical fixture
//     tests/payment/fixtures/paysh-sandbox-success.json. SHIPPED.
//   - v2 (paymentMeta.x402Version === 2): replays request with
//     `PAYMENT-SIGNATURE` base64-JSON header carrying a structured
//     PaymentPayload per Coinbase x402 v2 spec — outer keys:
//     `x402Version`, `resource`, `accepted` (singular, the chosen
//     requirement from `accepts[]`), `payload.transaction`. Parses
//     `PAYMENT-RESPONSE` header on 200 to surface the on-chain
//     signature (`SettlementResponse.transaction`) and explicitly
//     fails as `settle_failed` when SettlementResponse.success=false.
//     Successful v2 end-to-end requires Android bridge multi-sig
//     signing (Phase 5d) so the burner signs slot 1 (facilitator
//     signs slot 0 server-side). SHIPPED at Phase 5c.
//
// PRE-FLIGHT REJECTIONS (HTTPS-only, private-IP, DNS rebinding, max
// body, etc.) happen in the agent_pay tool before detect(). This
// module focuses on the x402-specific protocol mechanics only.

'use strict';

const crypto = require('crypto');
const { PaymentProtocol } = require('./protocol');

// USDC mint pinned per BAT-582 contract (mainnet).
const USDC_MINT = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v';
const USDC_DECIMALS = 6;

// Solana program IDs (base58).
const TOKEN_PROGRAM_ID = 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA';
const ASSOCIATED_TOKEN_PROGRAM_ID = 'ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL';

const X402_VERSION = 1;

// ── Base58 helpers ───────────────────────────────────────────────────────────
// Self-contained — avoids pulling solana.js (which requires config.js and
// can't load in tests). Cribbed from solana.js's identical implementation.

function _base58Decode(str) {
    const ALPHABET = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';
    let zeros = 0;
    for (let i = 0; i < str.length && str[i] === '1'; i++) zeros++;
    let value = 0n;
    for (let i = 0; i < str.length; i++) {
        const idx = ALPHABET.indexOf(str[i]);
        if (idx < 0) throw new Error('Invalid base58 character: ' + str[i]);
        value = value * 58n + BigInt(idx);
    }
    // BAT-582 R5 fix: when value === 0n, value.toString(16) returns "0",
    // which then pads to "00" and produces a 1-byte Buffer([0]) — adding a
    // spurious trailing zero byte to the decoded result. The correct payload
    // for a zero-value bigint is an empty buffer; the leading-zero count alone
    // populates the result. Failure case: the System Program ID
    // "11111111111111111111111111111111" (32 chars of '1') decodes to value=0n
    // and should produce a 32-byte all-zero buffer, but pre-fix produced 33
    // bytes (and was rejected by _decodeSolanaPubkey's length check).
    const hex = value.toString(16);
    const hexPadded = hex.length % 2 ? '0' + hex : hex;
    const decoded = value === 0n ? Buffer.alloc(0) : Buffer.from(hexPadded, 'hex');
    const result = Buffer.alloc(zeros + decoded.length);
    decoded.copy(result, zeros);
    return result;
}

function _base58Encode(buf) {
    const ALPHABET = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';
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

// Validate that `s` decodes to exactly 32 bytes. Returns the decoded Buffer
// or null on failure.
function _decodeSolanaPubkey(s) {
    if (typeof s !== 'string' || !s) return null;
    let decoded;
    try { decoded = _base58Decode(s); } catch (_) { return null; }
    if (decoded.length !== 32) return null;
    return decoded;
}

// BAT-582 R11: pre-decoded buffer constants. Program IDs and the USDC
// mint are byte-stable strings — base58-decoding them once at module load
// is dramatically cheaper than re-decoding on every agent_pay call. The
// hot path (_findAssociatedTokenAddress + _buildUsdcTransferTx) called
// _base58Decode 4× per payment; with the constants hoisted, only the
// recipient pubkey + recent blockhash need runtime decoding.
const _USDC_MINT_BYTES = _base58Decode(USDC_MINT);
const _TOKEN_PROGRAM_ID_BYTES = _base58Decode(TOKEN_PROGRAM_ID);
const _ATA_PROGRAM_ID_BYTES = _base58Decode(ASSOCIATED_TOKEN_PROGRAM_ID);

// ── Compact-u16 (shortvec) encoding for tx wire format ───────────────────────

function _encodeCompactU16(n) {
    if (n < 0 || n > 0xffff) throw new Error('compact-u16 out of range');
    const bytes = [];
    let v = n;
    do {
        let b = v & 0x7f;
        v >>>= 7;
        if (v) b |= 0x80;
        bytes.push(b);
    } while (v);
    return Buffer.from(bytes);
}

// ── Associated Token Account (ATA) PDA derivation ────────────────────────────

const _MAX_SEED_LEN = 32;
const _PDA_MARKER = Buffer.from('ProgramDerivedAddress', 'utf8');

// Solana's ed25519 curve check is implemented via a try/error in C; pure JS
// can approximate with the "curve point on edwards curve" math, but for ATA
// derivation Solana iterates `bump` from 255 down until it finds an OFF-curve
// point. For program-derived ATAs the standard `findProgramAddressSync`
// algorithm is: hash(seeds + program_id + [bump] + "ProgramDerivedAddress")
// → if the first byte is "off curve", that's the PDA. We implement a simpler
// version that mirrors @solana/web3.js: iterate bumps and return the first
// SHA256 result whose ed25519 on-curve check fails. The on-curve check can
// be approximated by attempting Ed25519 point decompression — if it fails,
// the point is off-curve.
//
// HOWEVER for ATAs we don't actually need the full PDA derivation in Node —
// the ATA PDA derivation is deterministic and well-known. We use the same
// approach as @solana/spl-token's getAssociatedTokenAddressSync:
//   seeds = [owner_pubkey, token_program_id, mint_pubkey]
//   ata = findProgramAddressSync(seeds, ASSOCIATED_TOKEN_PROGRAM_ID).address
//
// To avoid implementing full Ed25519 curve math here, we use a tightened
// version: iterate bumps 255..0, hash, and check via a partial-curve heuristic
// using crypto's tweetnacl-like check. For V1 we ship with the well-known
// algorithm using SHA256 and the standard "is on curve" approximation — and
// PIN the result with fixture tests against known-good ATA derivations.

function _findProgramAddress(seeds, programId) {
    // programId is Buffer (32 bytes); seeds are Buffer[].
    for (let b of seeds) {
        if (b.length > _MAX_SEED_LEN) throw new Error('seed too long');
    }
    let bump = 255;
    while (bump >= 0) {
        const buf = Buffer.concat([
            ...seeds,
            Buffer.from([bump]),
            programId,
            _PDA_MARKER,
        ]);
        const hash = crypto.createHash('sha256').update(buf).digest();
        if (!_isOnCurve(hash)) {
            return { address: hash, bump };
        }
        bump--;
    }
    throw new Error('Unable to find a valid program address');
}

// Ed25519 on-curve check via point decompression. Returns true when the
// 32-byte little-endian y-coordinate (with x sign bit in MSB) represents a
// valid point on the Ed25519 curve.
//
// Algorithm (per RFC 8032):
//   - p = 2^255 - 19
//   - d = -121665 * 121666^-1 mod p
//   - Given 32 bytes b: read y = LE integer of b with bit 255 cleared, sign = bit 255
//   - Compute u = y^2 - 1, v = d*y^2 + 1
//   - Compute x^2 = u * v^(p-2) mod p (modular inverse via Fermat)
//   - Try to find x = (x^2)^((p+3)/8) mod p (the standard square-root candidate)
//   - If x^2 == u/v: on curve
//   - If (x^2 * v) % p == (-u) % p: multiply x by 2^((p-1)/4) and recheck
//   - Else: off curve
//
// Direct port of the ed25519 reference impl. Uses BigInt — Ed25519 is small
// enough that perf isn't an issue (we run this 256 times max during PDA
// derivation, in-process during agent_pay only).
const _ED25519_P = (1n << 255n) - 19n;
const _ED25519_D = -((121665n * _modInverse(121666n, _ED25519_P)) % _ED25519_P);
// keep d positive
const _ED25519_D_POS = ((_ED25519_D % _ED25519_P) + _ED25519_P) % _ED25519_P;

function _modPow(base, exp, mod) {
    let result = 1n;
    base = ((base % mod) + mod) % mod;
    while (exp > 0n) {
        if (exp & 1n) result = (result * base) % mod;
        exp >>= 1n;
        base = (base * base) % mod;
    }
    return result;
}

function _modInverse(a, mod) {
    return _modPow(((a % mod) + mod) % mod, mod - 2n, mod);
}

function _bytesLeToBigInt(bytes) {
    let v = 0n;
    for (let i = bytes.length - 1; i >= 0; i--) {
        v = (v << 8n) | BigInt(bytes[i]);
    }
    return v;
}

function _isOnCurve(pubkeyBytes) {
    if (pubkeyBytes.length !== 32) return false;
    const p = _ED25519_P;
    const d = _ED25519_D_POS;

    // Read y (clear sign bit)
    const yBytes = Buffer.from(pubkeyBytes);
    yBytes[31] = yBytes[31] & 0x7f;
    const y = _bytesLeToBigInt(yBytes);
    if (y >= p) return false;

    const y2 = (y * y) % p;
    const u = ((y2 - 1n) % p + p) % p;
    const v = (d * y2 + 1n) % p;
    if (v === 0n) return false;

    // Try x^2 = u/v
    const vInv = _modInverse(v, p);
    const x2 = (u * vInv) % p;
    if (x2 === 0n) return true; // y = ±1 case handled trivially

    // Tentative root: x = x2^((p+3)/8) mod p
    const exp = (p + 3n) / 8n;
    let x = _modPow(x2, exp, p);

    // Check x^2 == x2
    if ((x * x) % p === x2) return true;
    // Else check x^2 == -x2 (mod p); if so, multiply by 2^((p-1)/4)
    if (((x * x) % p) === ((p - x2) % p)) {
        const sqrtMinus1 = _modPow(2n, (p - 1n) / 4n, p);
        x = (x * sqrtMinus1) % p;
        if ((x * x) % p === x2) return true;
    }
    return false;
}

function _findAssociatedTokenAddress(ownerPubkeyBytes, mintPubkeyBytes) {
    // BAT-582 R11: token program + ATA program pubkeys are constants — use
    // the module-level pre-decoded buffers (see _TOKEN_PROGRAM_ID_BYTES /
    // _ATA_PROGRAM_ID_BYTES above).
    const seeds = [ownerPubkeyBytes, _TOKEN_PROGRAM_ID_BYTES, mintPubkeyBytes];
    return _findProgramAddress(seeds, _ATA_PROGRAM_ID_BYTES);
}

// ── SPL Token TransferChecked instruction builder ────────────────────────────
// TransferChecked is the recommended SPL transfer for safety (it asserts the
// mint + decimals match expectations). Layout:
//   tag (1 byte)         = 12 (TransferChecked)
//   amount (u64 LE)      = 8 bytes
//   decimals (u8)        = 1 byte
// Total: 10 bytes.
//
// Accounts (in order):
//   0. [writable]            source ATA
//   1. [readonly]            mint
//   2. [writable]            destination ATA
//   3. [signer]              owner (source authority — burner)

function _buildSplTransferCheckedData(amountAtomic, decimals) {
    const data = Buffer.alloc(10);
    data.writeUInt8(12, 0); // TransferChecked discriminator
    // amount as u64 little-endian
    data.writeBigUInt64LE(BigInt(amountAtomic), 1);
    data.writeUInt8(decimals & 0xff, 9);
    return data;
}

// ── x402 v2: ComputeBudget + Memo instruction builders ───────────────────────
// Solana well-known program IDs (base58):
const COMPUTE_BUDGET_PROGRAM_ID = 'ComputeBudget111111111111111111111111111111';
const MEMO_PROGRAM_ID           = 'MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr';

// Pre-decoded program-ID bytes — same hoisting pattern as USDC_MINT
// (avoids re-decoding on every v2 tx build).
const _COMPUTE_BUDGET_PROGRAM_ID_BYTES = _base58Decode(COMPUTE_BUDGET_PROGRAM_ID);
const _MEMO_PROGRAM_ID_BYTES           = _base58Decode(MEMO_PROGRAM_ID);

// ComputeBudgetProgram::SetComputeUnitLimit
//   tag (1 byte) = 0x02
//   units (u32 LE) = 4 bytes
// Total: 5 bytes.
//
// BAT-582 v1.6 R-pr367-fix-5: validate `limit` is a positive u32 integer.
// Pre-fix used `limit >>> 0` which silently coerces negatives (-1 → 0xFFFFFFFF)
// and non-integers, producing unintended compute-unit limits. Throw a clear
// error instead so misuse fails loudly at build time.
function _buildCuLimitData(limit) {
    if (!Number.isInteger(limit) || limit <= 0 || limit > 0xFFFFFFFF) {
        throw new Error(`_buildCuLimitData: limit must be a positive integer in u32 range, got ${String(limit)}`);
    }
    const data = Buffer.alloc(5);
    data.writeUInt8(0x02, 0);
    data.writeUInt32LE(limit, 1);
    return data;
}

// ComputeBudgetProgram::SetComputeUnitPrice
//   tag (1 byte) = 0x03
//   micro_lamports (u64 LE) = 8 bytes
// Total: 9 bytes.
function _buildCuPriceData(microLamports) {
    const data = Buffer.alloc(9);
    data.writeUInt8(0x03, 0);
    data.writeBigUInt64LE(BigInt(microLamports), 1);
    return data;
}

// Memo program v2 takes the memo content as raw UTF-8 bytes (no
// discriminator). Per BAT-582 v1.6 contract amendment 4 + x402 v2 spec:
// the client MUST include a Memo instruction containing either
// `extra.memo` from the challenge (if present) or a random ≥16-byte
// hex nonce. We use 32 hex chars (16 bytes of entropy) when generating.
function _buildMemoData(memoString) {
    return Buffer.from(String(memoString), 'utf8');
}

function _generateRandomMemoNonce() {
    // 16 bytes random → 32 hex chars. Spec minimum.
    return crypto.randomBytes(16).toString('hex');
}

// ── Build a legacy USDC SPL transfer transaction ─────────────────────────────
// Returns { txBuffer, paymentMeta }. Caller serializes to base64.
//
// Message layout (legacy):
//   header (3 bytes): numRequiredSignatures, numReadonlySigned, numReadonlyUnsigned
//   account-keys: shortvec(K) + K × 32 bytes
//   recent blockhash: 32 bytes
//   instructions: shortvec(I) + per-instruction {
//       program_id_index: u8
//       accounts: shortvec(N) + N × u8 (account indices)
//       data: shortvec(L) + L bytes
//   }
//
// For an SPL transfer the burner (signer) is index 0. Account ordering:
//   0: burner (signer, writable — paying fees too) — fee-payer
//   1: source ATA (writable)
//   2: dest ATA (writable)
//   3: mint (readonly)
//   4: token program (readonly)
function _buildUsdcTransferTx(burnerPubkey58, recipientPubkey58, amountAtomic, recentBlockhash58) {
    const burnerBytes = _decodeSolanaPubkey(burnerPubkey58);
    const recipientBytes = _decodeSolanaPubkey(recipientPubkey58);
    if (!burnerBytes) throw new Error('invalid burner pubkey');
    if (!recipientBytes) throw new Error('invalid recipient pubkey');

    // BAT-582 R11: USDC mint + token program pubkeys are constants —
    // reuse the module-level pre-decoded buffers. Only the per-payment
    // recent blockhash still needs runtime decoding.
    const mintBytes = _USDC_MINT_BYTES;
    const tokenProgramBytes = _TOKEN_PROGRAM_ID_BYTES;
    const blockhashBytes = _base58Decode(recentBlockhash58);
    if (blockhashBytes.length !== 32) throw new Error('invalid blockhash');

    const sourceAta = _findAssociatedTokenAddress(burnerBytes, mintBytes).address;
    const destAta = _findAssociatedTokenAddress(recipientBytes, mintBytes).address;

    // Account-keys order (signer first, then writable, then readonly):
    //   index 0: burner          (signer, writable — fee-payer)
    //   index 1: source ATA      (writable)
    //   index 2: dest ATA        (writable)
    //   index 3: mint            (readonly)
    //   index 4: token program   (readonly)
    const accountKeys = [burnerBytes, sourceAta, destAta, mintBytes, tokenProgramBytes];

    // Header: 1 signer (the burner), 0 readonly-signed, 2 readonly-unsigned
    // (mint + token program). source ATA and dest ATA are writable-unsigned.
    const header = Buffer.from([
        1, // numRequiredSignatures
        0, // numReadonlySignedAccounts
        2, // numReadonlyUnsignedAccounts
    ]);

    // Instruction: TransferChecked
    //   programId = token program (account index 4)
    //   accounts (in instruction order):
    //     0. source ATA       (account index 1, writable)
    //     1. mint             (account index 3, readonly)
    //     2. dest ATA         (account index 2, writable)
    //     3. owner (burner)   (account index 0, signer, writable)
    const ixData = _buildSplTransferCheckedData(amountAtomic, USDC_DECIMALS);
    const ixAccounts = Buffer.from([1, 3, 2, 0]);
    const instruction = Buffer.concat([
        Buffer.from([4]),                       // programIdIndex = token program (idx 4)
        _encodeCompactU16(ixAccounts.length),   // num accounts (4)
        ixAccounts,                             // account indices
        _encodeCompactU16(ixData.length),       // data length (10)
        ixData,                                 // instruction data
    ]);

    const accountKeysBuf = Buffer.concat([
        _encodeCompactU16(accountKeys.length),
        ...accountKeys,
    ]);
    const instructionsBuf = Buffer.concat([
        _encodeCompactU16(1),
        instruction,
    ]);

    const message = Buffer.concat([
        header,
        accountKeysBuf,
        blockhashBytes,
        instructionsBuf,
    ]);

    // Wrap with a single empty signature placeholder. Android's signer fills
    // it in at index 0.
    const tx = Buffer.concat([
        _encodeCompactU16(1),       // shortvec(1) — one signature slot
        Buffer.alloc(64),           // empty signature placeholder
        message,
    ]);

    return {
        txBuffer: tx,
        paymentMeta: {
            amountAtomic: BigInt(amountAtomic),
            recipient: recipientPubkey58,
            sourceAta: _base58Encode(sourceAta),
            destAta: _base58Encode(destAta),
            blockhash: recentBlockhash58,
            mint: USDC_MINT,
        },
    };
}

// ── x402 v2 USDC transfer transaction builder ────────────────────────────────
// Per Coinbase x402 v2 spec (specs/schemes/exact/scheme_exact_svm.md):
//
// PARTIALLY-SIGNED versioned (v0) transaction with 4 instructions in
// this exact order:
//   1. ComputeBudgetProgram::SetComputeUnitLimit
//   2. ComputeBudgetProgram::SetComputeUnitPrice
//   3. SPL TransferChecked (USDC, burner → recipient ATA)
//   4. Memo with `extra.memo` from challenge OR random ≥16-byte hex nonce
//
// Two required signers:
//   - slot 0: facilitator (feePayer, signer + writable) — left empty;
//     server co-signs after receiving PAYMENT-SIGNATURE.
//   - slot 1: burner (signer + readonly) — caller fills this slot.
//
// Account-keys order (Solana convention — writable signers first, then
// readonly signers, then writable non-signers, then readonly non-signers):
//   idx 0: facilitator    (signer, writable, feePayer)
//   idx 1: burner         (signer, readonly — only authorizes SPL transfer)
//   idx 2: source ATA     (writable)
//   idx 3: dest ATA       (writable)
//   idx 4: USDC mint      (readonly)
//   idx 5: ComputeBudget  (readonly program)
//   idx 6: Token program  (readonly program)
//   idx 7: Memo program   (readonly program)
//
// Header: numRequiredSignatures=2, numReadonlySigned=1 (burner),
//         numReadonlyUnsigned=4 (mint + 3 programs).
//
// Returns { txBuffer, paymentMeta } — caller writes burner sig at slot 1
// (offset = 1 + 64 = 65 of the tx buffer), then base64-encodes.
//
// Default compute-budget values are conservative for a TransferChecked +
// Memo flow. Caller can override via opts if a service demands higher.
function _buildV2UsdcTransferTx(burnerPubkey58, recipientPubkey58, facilitatorPubkey58, amountAtomic, recentBlockhash58, memoString, opts = {}) {
    const burnerBytes      = _decodeSolanaPubkey(burnerPubkey58);
    const recipientBytes   = _decodeSolanaPubkey(recipientPubkey58);
    const facilitatorBytes = _decodeSolanaPubkey(facilitatorPubkey58);
    if (!burnerBytes)      throw new Error(`v2: invalid burner pubkey: ${burnerPubkey58}`);
    if (!recipientBytes)   throw new Error(`v2: invalid recipient pubkey: ${recipientPubkey58}`);
    if (!facilitatorBytes) throw new Error(`v2: invalid facilitator pubkey: ${facilitatorPubkey58}`);

    const mintBytes          = _USDC_MINT_BYTES;
    const tokenProgramBytes  = _TOKEN_PROGRAM_ID_BYTES;
    const cuProgramBytes     = _COMPUTE_BUDGET_PROGRAM_ID_BYTES;
    const memoProgramBytes   = _MEMO_PROGRAM_ID_BYTES;

    const sourceAta = _findAssociatedTokenAddress(burnerBytes, mintBytes).address;
    const destAta   = _findAssociatedTokenAddress(recipientBytes, mintBytes).address;

    const blockhashBytes = _base58Decode(recentBlockhash58);
    if (blockhashBytes.length !== 32) throw new Error(`v2: blockhash must decode to 32 bytes, got ${blockhashBytes.length}`);

    // Compute-budget defaults. 50000 CU is generous for a TransferChecked
    // + Memo (each is a few hundred CU); 1000 microlamports/CU is a
    // modest priority fee that helps with mainnet congestion without
    // burning much fee. Override via opts only if a specific facilitator
    // requires higher.
    //
    // BAT-582 v1.6 R-pr367-fix-5: validate opts.cuLimit explicitly rather
    // than bitwise-coercing. Pre-fix `(opts.cuLimit | 0) || 50_000` allowed
    // negative values (truthy after | 0) and silently truncated non-integers
    // to i32. Throw on anything outside positive u32 range so a buggy
    // caller fails loudly instead of producing nonsense limits.
    let cuLimit = 50_000;
    if (opts.cuLimit !== undefined && opts.cuLimit !== null) {
        const parsed = Number(opts.cuLimit);
        if (!Number.isInteger(parsed) || parsed <= 0 || parsed > 0xFFFFFFFF) {
            throw new Error(`v2: opts.cuLimit must be a positive integer in u32 range, got ${String(opts.cuLimit)}`);
        }
        cuLimit = parsed;
    }
    const cuPriceMicroLam = (opts.cuPriceMicroLamports != null) ? BigInt(opts.cuPriceMicroLamports) : 1000n;

    // Account-keys layout (see header comment).
    const accountKeys = [
        facilitatorBytes,    // 0: feePayer (signer, writable)
        burnerBytes,         // 1: burner   (signer, readonly)
        sourceAta,           // 2: source ATA (writable)
        destAta,             // 3: dest ATA   (writable)
        mintBytes,           // 4: USDC mint  (readonly)
        cuProgramBytes,      // 5: ComputeBudget program
        tokenProgramBytes,   // 6: Token program
        memoProgramBytes,    // 7: Memo program
    ];

    // Header per Solana message format.
    const header = Buffer.from([
        2, // numRequiredSignatures (facilitator + burner)
        1, // numReadonlySignedAccounts (burner is readonly-signer)
        4, // numReadonlyUnsignedAccounts (mint, ComputeBudget, Token, Memo)
    ]);

    // Instructions (4 total, in spec-required order).
    const ixCuLimit = (() => {
        const data = _buildCuLimitData(cuLimit);
        return Buffer.concat([
            Buffer.from([5]),                       // programIdIndex = ComputeBudget (idx 5)
            _encodeCompactU16(0),                   // no accounts
            _encodeCompactU16(data.length),
            data,
        ]);
    })();
    const ixCuPrice = (() => {
        const data = _buildCuPriceData(cuPriceMicroLam);
        return Buffer.concat([
            Buffer.from([5]),                       // programIdIndex = ComputeBudget
            _encodeCompactU16(0),
            _encodeCompactU16(data.length),
            data,
        ]);
    })();
    const ixTransferChecked = (() => {
        const data = _buildSplTransferCheckedData(amountAtomic, USDC_DECIMALS);
        // accounts: source ATA (2), mint (4), dest ATA (3), owner=burner (1)
        const ixAccounts = Buffer.from([2, 4, 3, 1]);
        return Buffer.concat([
            Buffer.from([6]),                       // programIdIndex = Token (idx 6)
            _encodeCompactU16(ixAccounts.length),
            ixAccounts,
            _encodeCompactU16(data.length),
            data,
        ]);
    })();
    const ixMemo = (() => {
        const data = _buildMemoData(memoString);
        // Memo can run without specifying accounts. Per Solana convention,
        // including the burner (signer) makes the memo verifiable as
        // authored by them — useful for downstream tooling. We include it.
        const ixAccounts = Buffer.from([1]);
        return Buffer.concat([
            Buffer.from([7]),                       // programIdIndex = Memo (idx 7)
            _encodeCompactU16(ixAccounts.length),
            ixAccounts,
            _encodeCompactU16(data.length),
            data,
        ]);
    })();

    const accountKeysBuf = Buffer.concat([
        _encodeCompactU16(accountKeys.length),
        ...accountKeys,
    ]);
    const instructionsBuf = Buffer.concat([
        _encodeCompactU16(4),
        ixCuLimit,
        ixCuPrice,
        ixTransferChecked,
        ixMemo,
    ]);
    // Address Lookup Tables section (v0 only). Empty: compact-u16(0).
    const altBuf = _encodeCompactU16(0);

    // v0 versioned message: prefix byte 0x80 | 0 = 0x80, then standard
    // message bytes, then ALT section.
    const versionByte = Buffer.from([0x80]);
    const message = Buffer.concat([
        versionByte,
        header,
        accountKeysBuf,
        blockhashBytes,
        instructionsBuf,
        altBuf,
    ]);

    // Two empty 64-byte signature slots (facilitator at 0, burner at 1).
    // Caller fills slot 1 via the Android KeyVault bridge before sending
    // PAYMENT-SIGNATURE. The bridge does NOT take an explicit slot index
    // — SolanaTxSigner locates the burner's slot by matching the burner
    // pubkey against the tx's account_keys in the first
    // numRequiredSignatures positions. To opt into partial-sign mode
    // (slot 0 left empty for the facilitator), agent_pay sends
    // `allowPartiallySigned: true` on the /burner/sign-transaction call.
    const tx = Buffer.concat([
        _encodeCompactU16(2),       // 2 sig slots
        Buffer.alloc(64),           // slot 0 (facilitator, empty)
        Buffer.alloc(64),           // slot 1 (burner, empty until signed)
        message,
    ]);

    return {
        txBuffer: tx,
        paymentMeta: {
            x402Version: 2,
            amountAtomic: BigInt(amountAtomic),
            recipient: recipientPubkey58,
            facilitator: facilitatorPubkey58,
            sourceAta: _base58Encode(sourceAta),
            destAta:   _base58Encode(destAta),
            blockhash: recentBlockhash58,
            mint: USDC_MINT,
            memo: memoString,
            burnerSigSlot: 1,                 // for Android bridge: sign slot 1
            cuLimit,
            cuPriceMicroLamports: cuPriceMicroLam.toString(),
        },
    };
}

// ── x402 v2: PAYMENT-SIGNATURE header builder ────────────────────────────────
// Per Coinbase x402 v2 spec (specs/transports-v2/http.md +
// specs/schemes/exact/scheme_exact_svm.md): the proof header carries
// a base64-encoded `PaymentPayload` with this exact shape (note
// `accepted` is SINGULAR — the chosen requirement from the challenge's
// `accepts` array):
//
//   {
//     "x402Version": 2,
//     "resource": { url, description, mimeType },
//     "accepted": {
//       "scheme": "exact",
//       "network": "solana:<genesis>",
//       "amount": "10000",
//       "asset": "EPjFW...",
//       "payTo": "<recipient>",
//       "maxTimeoutSeconds": 300,
//       "extra": { "feePayer": "<facilitator>"  /* + any other fields
//                  the challenge's accepts[i].extra had — see invariant
//                  below; memo is NOT added unconditionally */ }
//     },
//     "payload": { "transaction": "<base64 signed tx>" }
//   }
//
// `accepted.extra` INVARIANT (R-pr368-live-fix-1): the proof must echo
// the challenge's accepts[i].extra exactly. Adding fields that the
// challenge didn't send (e.g. memo when challenge only had feePayer)
// produces "No matching payment requirements" rejection from strict
// facilitators. The Memo instruction in the tx itself is the on-chain
// commitment; the header echo does not include it unless the challenge
// did.
//
// Returns { value: <base64 string> } on success or { error, reason }
// if paymentMeta is missing required fields (defensive — build()
// should have provided everything).
function _buildV2PaymentSignatureHeader(paymentMeta, signedTxBase64) {
    if (!paymentMeta || typeof paymentMeta !== 'object') {
        return { error: 'v2_settle_missing_meta', reason: 'paymentMeta is null or not an object' };
    }
    // BAT-582 v1.6 R-pr367-fix-5: fail-closed when signedTxBase64 is not a
    // usable string. Pre-fix we'd happily emit PAYMENT-SIGNATURE with
    // `payload.transaction: undefined/null/''`, producing a spec-invalid
    // proof that's hard to diagnose downstream (facilitator just returns a
    // generic "invalid tx"). Surface a stable error code instead.
    if (typeof signedTxBase64 !== 'string' || signedTxBase64.length === 0) {
        return { error: 'v2_settle_missing_signed_tx', reason: 'signedTxBase64 must be a non-empty string' };
    }
    const req = paymentMeta.requirement || {};
    const extra = req.extra || {};
    if (typeof extra.feePayer !== 'string' || !_decodeSolanaPubkey(extra.feePayer)) {
        return { error: 'v2_settle_missing_facilitator', reason: 'paymentMeta.requirement.extra.feePayer not present' };
    }
    if (typeof paymentMeta.memo !== 'string' || paymentMeta.memo.length === 0) {
        return { error: 'v2_settle_missing_memo', reason: 'paymentMeta.memo not present (build should have set it)' };
    }
    if (typeof paymentMeta.amountAtomic !== 'bigint') {
        return { error: 'v2_settle_missing_amount', reason: 'paymentMeta.amountAtomic missing or not BigInt' };
    }
    // Resource may be an object (per spec) or a string (older v1-shaped
    // captures). Normalize to the v2 object shape — facilitators require
    // it. If only a string is present, treat it as `url` with sensible
    // empty defaults for description + mimeType.
    //
    // BAT-582 v1.6 R-pr367-fix-1: fail closed when the resource URL is
    // missing/empty. Pre-fix we emitted PAYMENT-SIGNATURE with
    // `resource.url: ''` which is spec-invalid (and would let a server
    // accept an ambiguous proof). Returning a stable error code lets
    // agent_pay surface "v2 challenge missing required resource" instead
    // of sending a malformed header.
    let resource = req.resource;
    if (typeof resource === 'string') {
        resource = { url: resource, description: req.description || '', mimeType: 'application/json' };
    } else if (!resource || typeof resource !== 'object') {
        resource = null; // signal below
    }
    if (!resource || typeof resource.url !== 'string' || resource.url.length === 0) {
        return {
            error: 'v2_settle_missing_resource',
            reason: 'paymentMeta.requirement.resource.url not present — required for v2 PAYMENT-SIGNATURE proof per spec',
        };
    }

    const payload = {
        x402Version: 2,
        resource,
        accepted: {
            scheme: req.scheme || 'exact',
            // Use the CAIP-2 wire-form network the challenge actually sent.
            // paymentMeta.negotiatedNetwork is the preserved wire string
            // ("solana" or "solana:<genesis>"); we echo it back verbatim.
            network: paymentMeta.negotiatedNetwork || req.network || 'solana',
            amount: paymentMeta.amountAtomic.toString(),
            asset: paymentMeta.asset || USDC_MINT,
            payTo: req.payTo || paymentMeta.recipient,
            maxTimeoutSeconds: typeof req.maxTimeoutSeconds === 'number' ? req.maxTimeoutSeconds : 300,
            // BAT-582 v1.6 R-pr368-live-fix-1: `accepted.extra` must be
            // an exact echo of the chosen accepts[i].extra from the
            // challenge. Some facilitators (e.g. paysponge.com,
            // 2wKupLR9...) strict-match this field and reject with
            // "No matching payment requirements" when client adds keys
            // the challenge didn't have. The MEMO lives in the tx as a
            // Memo instruction (on-chain commitment) — it does NOT
            // belong in the header echo unless the challenge itself
            // included it in extra (in which case the shallow-clone
            // already preserves it).
            //
            // Pre-fix we added `memo: paymentMeta.memo` unconditionally,
            // which produced a working header against lenient
            // facilitators (CoinGecko) but a "No matching payment
            // requirements" rejection against strict ones (paysponge).
            // Caught by tests/paysh/live-pay-curated.js — three
            // services tested, one succeeded, two rejected with
            // identical error.
            //
            // R-pr367-fix-7 preservation intent (extension fields like
            // signingNonce, feeTier, expiresAt) still works: the spread
            // echoes back whatever the challenge sent.
            extra: { ...extra },
        },
        payload: {
            transaction: signedTxBase64,
        },
    };
    const value = Buffer.from(JSON.stringify(payload), 'utf8').toString('base64');
    // BAT-582 v1.6 R-pr367-fix-8: cap header size to defend against a
    // hostile/buggy facilitator inflating server-controlled fields
    // (extra.*, resource.description, mimeType) to force oversized
    // PAYMENT-SIGNATURE headers. Common HTTP server limits cap individual
    // headers at 8KB; 8192 bytes here is well above any legitimate proof
    // size (~1-2 KB) and below typical server limits. Fail closed before
    // the network call instead of letting the request blow up with a
    // generic 431/400 from an upstream proxy.
    if (value.length > 8192) {
        return {
            error: 'v2_settle_proof_too_large',
            reason: `PAYMENT-SIGNATURE header serialized to ${value.length} bytes (max 8192) — server may be inflating extra/resource fields`,
        };
    }
    return { value };
}

// ── Payment requirement parsing per pay.sh fixture ───────────────────────────

// pay.sh / x402 V1 returns a 402 with body shape (fixture-pinned):
//   {
//     x402Version: 1,
//     accepts: [
//       {
//         scheme: "exact",
//         network: "solana",
//         maxAmountRequired: "100000",        // atomic USDC microunits as string
//         resource: "https://...",
//         payTo: "<solana base58 pubkey>",
//         asset: "EPjFWdd5..." | "USDC",
//         mimeType: "application/json",
//         description: "...",
//         maxTimeoutSeconds: 60,
//         extra: { ... }                       // protocol-specific extension
//       }
//     ]
//   }
//
// Some servers may use `paymentRequirements` instead of `accepts`; we accept
// both for forward-compat.
// BAT-582 v1.6: Solana mainnet genesis hash (CAIP-2 anchor for x402 v2
// network field). Pinned per Codex sign-off — single value, no list.
const SOLANA_MAINNET_GENESIS = '5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp';
// Supported x402 protocol versions. v1 (legacy paysh) and v2 (current
// pay.sh ecosystem — Tripadvisor, CoinGecko, Textbelt all v2 as of
// 2026-05-10). v3+ is rejected as unsupported_version per contract v1.6.
const X402_VERSIONS_SUPPORTED = new Set([1, 2]);
// Max base64 length we'll attempt to decode from a payment-required
// header. ~16KB after decode is plenty for any reasonable payment
// requirements payload while bounding worst-case allocation.
const PAYMENT_REQUIRED_HEADER_MAX_B64_BYTES = 22_000;

/**
 * BAT-582 v1.6: extract payment-requirements payload from the response.
 * x402 v2 delivers requirements via EITHER the JSON body
 * (Tripadvisor, Textbelt) OR a base64-encoded `payment-required` header
 * (CoinGecko). Both modes are committed real-wire captures under
 * tests/paysh/captures/.
 *
 * Returns { payload, source } where payload is the parsed object that
 * SHOULD contain `accepts`/`paymentRequirements` and `x402Version`, and
 * `source` is 'body' or 'header'. Returns null if neither delivery mode
 * yielded a usable shape — caller surfaces as no_payment_requirements.
 */
function _extractPayload(response) {
    const body = response && response.bodyJson;
    if (body && typeof body === 'object' && !Array.isArray(body)) {
        if ((Array.isArray(body.accepts) && body.accepts.length > 0) ||
            (Array.isArray(body.paymentRequirements) && body.paymentRequirements.length > 0)) {
            return { payload: body, source: 'body' };
        }
    }
    // Body lacked requirements — check `payment-required` header (v2).
    const headers = response && response.headers;
    if (headers && typeof headers === 'object') {
        // Normalize: HTTP headers are case-insensitive; Node lowercases them
        // in res.headers but we defensively also check capitalized form.
        const headerVal = headers['payment-required'] || headers['Payment-Required'];
        if (typeof headerVal === 'string' && headerVal.length > 0 &&
            headerVal.length <= PAYMENT_REQUIRED_HEADER_MAX_B64_BYTES) {
            try {
                const decoded = Buffer.from(headerVal, 'base64').toString('utf8');
                const parsed = JSON.parse(decoded);
                if (parsed && typeof parsed === 'object' &&
                    (Array.isArray(parsed.accepts) || Array.isArray(parsed.paymentRequirements))) {
                    return { payload: parsed, source: 'header' };
                }
            } catch (_) { /* fall through to null */ }
        }
    }
    return null;
}

function _extractRequirementsArray(payload) {
    if (!payload || typeof payload !== 'object') return null;
    if (Array.isArray(payload.accepts) && payload.accepts.length > 0) return payload.accepts;
    if (Array.isArray(payload.paymentRequirements) && payload.paymentRequirements.length > 0) return payload.paymentRequirements;
    return null;
}

/**
 * BAT-582 v1.6: determine if `network` string identifies Solana mainnet.
 * Returns { kind: 'solana-mainnet' | 'solana-other' | 'non-solana' }.
 *
 *   - bare `"solana"` (v1, lowercase) → solana-mainnet (backward compat)
 *   - `"solana:<MAINNET_GENESIS>"` (v2 CAIP-2) → solana-mainnet
 *   - `"solana:<other-genesis>"` → solana-other (devnet/testnet, reject)
 *   - `"eip155:..."` or anything else → non-solana
 */
function _classifyNetwork(network) {
    const s = String(network || '').trim().toLowerCase();
    if (!s) return { kind: 'non-solana' };
    if (s === 'solana') return { kind: 'solana-mainnet' };
    if (s.startsWith('solana:')) {
        const genesis = s.slice('solana:'.length);
        return genesis === SOLANA_MAINNET_GENESIS.toLowerCase()
            ? { kind: 'solana-mainnet' }
            : { kind: 'solana-other', genesis };
    }
    return { kind: 'non-solana' };
}

/**
 * BAT-582 v1.6: walk requirements array, find first Solana mainnet entry
 * with scheme=exact. Returns:
 *   - { requirement }                              when a Solana mainnet entry is found
 *   - { error: 'no_solana_offer' }                 when no Solana entries exist at all
 *   - { error: 'non_mainnet_solana', genesis }     when Solana entries exist but all are devnet/testnet
 *   - { error: 'no_acceptable_requirement' }       when Solana entries exist but none have scheme=exact
 *
 * Per contract v1.6 amendment 5: we do NOT fall back to first network
 * when Solana is absent. Multi-chain (Base + Solana) → pick Solana.
 * EVM-only → reject as no_solana_offer.
 */
function _pickSolanaRequirement(reqs) {
    let sawSolanaButNonMainnet = false;
    let lastNonMainnetGenesis = null;
    let sawSolanaButWrongScheme = false;
    for (const r of reqs) {
        const classified = _classifyNetwork(r.network);
        if (classified.kind === 'non-solana') continue;
        if (classified.kind === 'solana-other') {
            sawSolanaButNonMainnet = true;
            lastNonMainnetGenesis = classified.genesis;
            continue;
        }
        // solana-mainnet — check scheme
        const scheme = String(r.scheme || '').toLowerCase();
        if (scheme && scheme !== 'exact') { sawSolanaButWrongScheme = true; continue; }
        return { requirement: r };
    }
    if (sawSolanaButNonMainnet) {
        return { error: 'non_mainnet_solana', genesis: lastNonMainnetGenesis };
    }
    if (sawSolanaButWrongScheme) {
        return { error: 'no_acceptable_requirement' };
    }
    return { error: 'no_solana_offer' };
}

/**
 * BAT-582 v1.6: validate x402Version. Per contract:
 *   - 1 or 2 → ok
 *   - missing → missing_x402_version (fail-closed; don't guess)
 *   - 3+ → unsupported_version (forward-compat fail-closed)
 */
function _validateVersion(payload) {
    if (!payload || typeof payload.x402Version !== 'number' || !Number.isInteger(payload.x402Version)) {
        return { error: 'missing_x402_version' };
    }
    if (!X402_VERSIONS_SUPPORTED.has(payload.x402Version)) {
        return { error: 'unsupported_version', version: payload.x402Version };
    }
    return { ok: true, version: payload.x402Version };
}

function _isUsdcAsset(asset) {
    if (!asset) return false;
    const s = String(asset).trim();
    // EVM USDC contract addresses (e.g. 0x833589fCD6e... on Base) are
    // explicitly NOT accepted — even though _pickSolanaRequirement should
    // have already filtered them out by network, defense-in-depth here
    // catches a buggy fixture where network claims solana but asset is
    // an EVM address.
    if (/^0x[a-fA-F0-9]+$/.test(s)) return false;
    return s === USDC_MINT || s.toLowerCase() === 'usdc' || s.toLowerCase() === 'usd-coin';
}

// BAT-582 R10: maximum atomic-amount digit length we'll BigInt-parse on
// the x402 server-controlled path. `paymentRequirements.maxAmountRequired`
// comes over the wire from a third-party 402 challenge response — a
// malicious or misbehaving server could emit a 10MB digit string and burn
// O(n²) CPU in BigInt parsing. 30 digits is far past any realistic USDC
// atomic value (1 trillion USDC is 19 microunit digits) while bounding
// the worst case to single-digit microseconds.
const _MAX_ATOMIC_DIGITS_X402 = 30;

function _parseAmountAtomic(s) {
    if (s == null) return null;
    const str = String(s).trim();
    if (str.length === 0 || str.length > _MAX_ATOMIC_DIGITS_X402) return null;
    if (!/^[0-9]+$/.test(str)) return null;
    try { return BigInt(str); } catch (_) { return null; }
}

/**
 * BAT-582 v1.6: read the demand amount from a requirement entry.
 * v1 uses `maxAmountRequired`, v2 uses `amount`. Per Codex amendment:
 *   - Both fields present and EQUAL → ok, use value
 *   - Both fields present and DIFFERENT → reject as conflicting_amount_fields
 *   - One field present → use it
 *   - Neither → reject as missing_amount
 *   - Value not a strict atomic-microunit integer string → reject as invalid_demand
 *
 * Returns { demand: BigInt, raw: string } on success, or { error, reason } on failure.
 */
function _readAmount(requirement) {
    if (!requirement || typeof requirement !== 'object') {
        return { error: 'missing_amount', reason: 'requirement entry is null or not an object' };
    }
    const hasAmount = Object.prototype.hasOwnProperty.call(requirement, 'amount');
    const hasMaxAmount = Object.prototype.hasOwnProperty.call(requirement, 'maxAmountRequired');
    if (!hasAmount && !hasMaxAmount) {
        return { error: 'missing_amount', reason: 'requirement has neither amount nor maxAmountRequired' };
    }
    if (hasAmount && hasMaxAmount) {
        // Compare as STRINGS first — both are spec'd as decimal-digit strings,
        // so a strict equality is more honest than risking BigInt coercion
        // hiding e.g. "0010" vs "10". If strings differ, attempt BigInt
        // comparison; if those agree, treat as equivalent (e.g. "10" vs "10 ").
        const a = String(requirement.amount).trim();
        const m = String(requirement.maxAmountRequired).trim();
        if (a !== m) {
            const aBig = _parseAmountAtomic(a);
            const mBig = _parseAmountAtomic(m);
            if (aBig == null || mBig == null || aBig !== mBig) {
                return {
                    error: 'conflicting_amount_fields',
                    reason: `requirement has both amount="${a}" and maxAmountRequired="${m}" which differ`,
                };
            }
        }
        // Equal — prefer the canonical v2 `amount` field.
        const demand = _parseAmountAtomic(a);
        if (demand == null) return { error: 'invalid_demand', reason: `amount="${a}" is not a positive integer string` };
        return { demand, raw: a };
    }
    const raw = String(hasAmount ? requirement.amount : requirement.maxAmountRequired).trim();
    const demand = _parseAmountAtomic(raw);
    if (demand == null) return { error: 'invalid_demand', reason: `${hasAmount ? 'amount' : 'maxAmountRequired'}="${raw}" is not a positive integer string` };
    return { demand, raw };
}

// ── Recent blockhash fetch ───────────────────────────────────────────────────
// We need a recent blockhash for the tx. Lazy-required to keep this module
// loadable in tests (solana.js requires config.js).

let _blockhashOverride = null;
function _setBlockhashFetcher(fn) { _blockhashOverride = fn; }

async function _fetchRecentBlockhash() {
    if (_blockhashOverride) return _blockhashOverride();
    // Lazy require — solana.js loads config.js.
    const { solanaRpc } = require('../solana');
    // BAT-582 R11 (CRITICAL): solanaRpc() already unwraps the JSON-RPC
    // envelope and returns `json.result` (see solana.js:52). The shape we
    // see HERE is therefore `{context, value: {blockhash, lastValidBlockHeight}}`,
    // NOT `{result: {context, value: {...}}}`. Earlier code did
    // `res.result.value.blockhash` and silently returned undefined,
    // breaking agent_pay end-to-end (could not build the USDC SPL transfer
    // tx). The expected shape is documented in solana.js#solanaRpcOnce.
    const res = await solanaRpc('getLatestBlockhash', [{ commitment: 'finalized' }]);
    if (!res || res.error) throw new Error(`getLatestBlockhash failed: ${res && res.error ? res.error : 'unknown'}`);
    const bh = res && res.value && res.value.blockhash;
    if (!bh) throw new Error('getLatestBlockhash response missing blockhash');
    return bh;
}

// ── X402 protocol class ──────────────────────────────────────────────────────

class X402Protocol extends PaymentProtocol {
    get name() { return 'x402'; }

    /**
     * Detect whether a 402 response carries x402 payment requirements we
     * can act on (Solana mainnet, USDC, scheme=exact, supported version).
     *
     * Pinned against:
     *   - tests/payment/fixtures/paysh-sandbox-402.json (v1, body-form)
     *   - tests/paysh/captures/tripadvisor-search-402.json (v2, body-form, multi-chain)
     *   - tests/paysh/captures/coingecko-trending-pools.json (v2, header-form)
     *   - tests/paysh/captures/textbelt-text-402.json (v2, body-form, POST)
     *   - synthetic-* fixtures for fail-closed proofs
     *
     * Returns true ONLY when an acceptable Solana mainnet entry exists.
     * For any rejection path (no Solana, unsupported version, malformed,
     * non-USDC), returns false — the caller surfaces the specific error
     * via build(), which calls the same helpers and exposes the reason.
     */
    detect(response) {
        if (!response || response.status !== 402) return false;
        const extracted = _extractPayload(response);
        if (!extracted) return false;
        // Version gate before walking requirements — a v3+ response is not
        // actionable even if it happens to advertise a Solana entry, per
        // forward-compat fail-closed rule.
        const versionCheck = _validateVersion(extracted.payload);
        if (!versionCheck.ok) return false;
        const reqs = _extractRequirementsArray(extracted.payload);
        if (!reqs) return false;
        const pick = _pickSolanaRequirement(reqs);
        if (pick.error) return false;
        // We have a Solana mainnet entry with scheme=exact. Build() will
        // separately re-verify asset/amount/payTo at the construction
        // step; detect() only needs to confirm the protocol IS x402 and
        // there IS a usable offer.
        return !!pick.requirement;
    }

    async build(response, ctx) {
        const ws = ctx || {};
        const maxUsdcAtomic = ws.maxUsdcAtomic;
        if (typeof maxUsdcAtomic !== 'bigint') {
            return { error: 'invalid_input', reason: 'ctx.maxUsdcAtomic must be a BigInt' };
        }
        // BAT-582 R11: caller passes `ctx.burnerPubkey` (resolved via
        // `await /burner/status` upstream — see tools/agent_pay.js:472).
        // We previously fell back to `ctx.signerWallet.pubkeySync()` if
        // `burnerPubkey` was missing, but the Wallet interface
        // (wallet/wallet.js) only defines async `pubkey()` — there is no
        // `pubkeySync` on any implementation. The fallback path was dead
        // code that would have thrown if exercised. Remove the broken
        // fallback; require the caller to pass `burnerPubkey` directly.
        const burnerPubkey58 = ws.burnerPubkey;
        if (typeof burnerPubkey58 !== 'string' || !_decodeSolanaPubkey(burnerPubkey58)) {
            return { error: 'invalid_burner_pubkey', reason: 'burner pubkey not available or invalid' };
        }

        // BAT-582 v1.6: extract payment requirements from body OR
        // `payment-required` header (CoinGecko delivers via header).
        const extracted = _extractPayload(response);
        if (!extracted) {
            return {
                error: 'no_payment_requirements',
                reason: '402 response has neither a body accepts/paymentRequirements array nor a payment-required header',
            };
        }

        // Version gate — v1 or v2 only.
        const versionCheck = _validateVersion(extracted.payload);
        if (versionCheck.error === 'missing_x402_version') {
            return { error: 'missing_x402_version', reason: 'response has no x402Version field' };
        }
        if (versionCheck.error === 'unsupported_version') {
            return { error: 'unsupported_version', reason: `x402Version=${versionCheck.version} is not supported (only v1, v2)` };
        }

        const reqs = _extractRequirementsArray(extracted.payload);
        if (!reqs) return { error: 'invalid_402_body', reason: 'extracted payload has empty accepts/paymentRequirements array' };

        // Multi-chain handling per v1.6 amendment: walk requirements,
        // pick first Solana mainnet entry with scheme=exact.
        const pick = _pickSolanaRequirement(reqs);
        if (pick.error === 'no_solana_offer') {
            return { error: 'no_solana_offer', reason: 'response offers no Solana mainnet payment option (only EVM/other chains)' };
        }
        if (pick.error === 'non_mainnet_solana') {
            return { error: 'non_mainnet_solana', reason: `Solana offer specifies non-mainnet genesis: ${pick.genesis}` };
        }
        if (pick.error === 'no_acceptable_requirement') {
            return { error: 'no_acceptable_requirement', reason: 'Solana offer present but scheme is not "exact"' };
        }
        const r = pick.requirement;

        // Asset — must be USDC (or its mint). EVM-shaped asset (0x...)
        // explicitly rejected even if the network field accidentally
        // claimed solana — defense-in-depth.
        if (!_isUsdcAsset(r.asset)) {
            return { error: 'non_usdc_asset', reason: `asset=${r.asset} not supported (USDC only on Solana mainnet)` };
        }

        // Demand amount — v1 uses maxAmountRequired, v2 uses amount.
        // Read whichever is present; if BOTH present and they differ,
        // reject as conflicting_amount_fields (Codex amendment).
        const amountReadResult = _readAmount(r);
        if (amountReadResult.error) {
            return { error: amountReadResult.error, reason: amountReadResult.reason };
        }
        const demand = amountReadResult.demand;
        if (demand <= 0n) {
            return { error: 'invalid_demand', reason: `amount=${amountReadResult.raw} must be a positive integer` };
        }
        if (demand > maxUsdcAtomic) {
            return {
                error: 'demand_exceeds_max_usdc',
                reason: `demand=${demand.toString()} microUSDC exceeds max_usdc=${maxUsdcAtomic.toString()} microUSDC`,
            };
        }

        // Recipient.
        const recipient = r.payTo || r.recipient || r.to;
        if (!_decodeSolanaPubkey(recipient)) {
            return { error: 'invalid_recipient', reason: `payTo=${recipient} is not a valid Solana base58 pubkey` };
        }

        // Build the tx.
        let recentBlockhash;
        try { recentBlockhash = await _fetchRecentBlockhash(); }
        catch (e) { return { error: 'blockhash_fetch_failed', reason: e.message }; }

        const negotiatedVersion = versionCheck.version;
        let built;
        if (negotiatedVersion === 2) {
            // BAT-582 v1.6 Phase 5b: v2 challenges produce v2-shape txs.
            // v2 requires the facilitator's pubkey from `extra.feePayer`
            // (the server-side co-signer who pays gas + submits the tx)
            // and a Memo instruction containing either the challenge's
            // `extra.memo` or a fresh random ≥16-byte hex nonce per spec.
            const extra = r.extra || {};
            const facilitatorPubkey58 = extra.feePayer;
            if (typeof facilitatorPubkey58 !== 'string' || !_decodeSolanaPubkey(facilitatorPubkey58)) {
                return {
                    error: 'missing_facilitator',
                    reason: 'v2 challenge has no extra.feePayer — required for the partially-signed flow',
                };
            }
            // BAT-582 v1.6 R-pr367-fix-2: bound server-controlled memo
            // length. `extra.memo` flows verbatim into both the Memo
            // instruction (Solana tx size cap is 1232 bytes) and the
            // base64-encoded PAYMENT-SIGNATURE header (HTTP header cap
            // varies, typically 8K). Without a length bound, a buggy or
            // malicious server could force oversize allocations or
            // exceed Solana's per-tx byte cap (which would just reject
            // the tx, but waste a sign call). 256 bytes is generous for
            // any plausible memo (payment ID, order ref, etc.) while
            // far below any wire-format limit. Reject loud if exceeded
            // so the agent surfaces a clear error.
            const MAX_MEMO_BYTES = 256;
            let memoString;
            if (typeof extra.memo === 'string' && extra.memo.length > 0) {
                const memoBytes = Buffer.byteLength(extra.memo, 'utf8');
                if (memoBytes > MAX_MEMO_BYTES) {
                    return {
                        error: 'memo_too_large',
                        reason: `challenge extra.memo is ${memoBytes} bytes (UTF-8); max ${MAX_MEMO_BYTES}`,
                    };
                }
                memoString = extra.memo;
            } else {
                memoString = _generateRandomMemoNonce();
            }
            try {
                built = _buildV2UsdcTransferTx(
                    burnerPubkey58, recipient, facilitatorPubkey58,
                    demand, recentBlockhash, memoString,
                );
            } catch (e) {
                return { error: 'tx_build_failed', reason: e.message };
            }
        } else {
            // v1: single-signer legacy tx, burner pays gas + signs slot 0.
            try {
                built = _buildUsdcTransferTx(burnerPubkey58, recipient, demand, recentBlockhash);
            } catch (e) {
                return { error: 'tx_build_failed', reason: e.message };
            }
        }

        const txBase64 = built.txBuffer.toString('base64');
        // BAT-582 R22 / v1.6 Codex clarification 1: pass through the
        // ACTUAL negotiated x402Version (1 or 2) and the ACTUAL network
        // string from the requirement (could be bare "solana" or
        // "solana:<genesis>"). settle() uses these to decide whether to
        // emit a v1 proof header (existing path, fixture-pinned) or to
        // build a v2 PAYMENT-SIGNATURE proof (Phase 5c).
        const meta = {
            ...built.paymentMeta,
            scheme: 'exact',
            network: 'solana',                   // normalized for tx-build purposes
            negotiatedNetwork: String(r.network || 'solana'),  // wire form for settle
            asset: USDC_MINT,
            x402Version: negotiatedVersion,
            // Store a short-lived ref to the original requirement so settle()
            // can echo back any extension fields if the server requires them.
            //
            // BAT-582 v1.6 R-pr367-fix: `resource` lives at the TOP LEVEL
            // of the v2 challenge payload (per the Coinbase spec and
            // confirmed against the real Tripadvisor/Textbelt/CoinGecko
            // captures), NOT inside the chosen `accepts[]` entry. Pre-fix
            // we read it as `r.resource` which is always `null` for real
            // v2 challenges — the v2 PAYMENT-SIGNATURE header then went
            // out with `resource.url: ''` (spec-invalid). Read from the
            // extracted payload instead, fall back to the requirement
            // entry only for v1-shaped challenges where it might legacily
            // live there.
            requirement: {
                scheme: r.scheme || 'exact',
                network: r.network || 'solana',
                payTo: r.payTo,
                resource: extracted.payload.resource || r.resource,
                description: r.description,
                maxTimeoutSeconds: r.maxTimeoutSeconds,
                extra: r.extra,                   // v2 settle needs `extra.feePayer`
            },
        };
        return { txBase64, paymentMeta: meta };
    }

    /**
     * Replay the original GET with the X-PAYMENT proof header. The header is
     * base64-encoded JSON per the x402 spec — pinned against
     * tests/payment/fixtures/paysh-sandbox-success.json.
     *
     * `originalRequest` carries the parsed URL + pinned IP from agent_pay's
     * pre-flight, plus the remaining timeout budget. `helpers._fetchWithLimits`
     * is injected by the caller so this module doesn't import the agent_pay
     * tool (avoiding a circular require).
     */
    async settle(originalRequest, signedTxBase64, paymentMeta, helpers) {
        const fetchFn = helpers && helpers._fetchWithLimits;
        if (typeof fetchFn !== 'function') {
            return { error: 'missing_fetch_helper', reason: 'settle() requires helpers._fetchWithLimits' };
        }
        const { parsed, pinnedIp, pinnedFamily, timeoutLeftMs } = originalRequest || {};
        if (!parsed) return { error: 'missing_request_context', reason: 'originalRequest.parsed missing' };

        // BAT-582 v1.6 Phase 5c: settle() dispatches v1 vs v2 proof-header
        // paths per paymentMeta.x402Version.
        //   v1: legacy `x-payment` header carrying a flat PaymentPayload
        //       (x402Version, scheme, network, payload.transaction).
        //       Pinned against tests/payment/fixtures/paysh-sandbox-success.json.
        //   v2: `PAYMENT-SIGNATURE` header carrying a structured
        //       PaymentPayload (x402Version, resource, accepted, payload).
        //       Per Coinbase x402 v2 spec
        //       (specs/transports-v2/http.md +
        //        specs/schemes/exact/scheme_exact_svm.md).
        const negotiatedVersion = paymentMeta && paymentMeta.x402Version;
        if (negotiatedVersion !== 1 && negotiatedVersion !== 2) {
            return {
                error: 'unsupported_settle_version',
                reason: `paymentMeta.x402Version=${negotiatedVersion} is not a settleable version`,
            };
        }

        let proofHeaders;
        if (negotiatedVersion === 2) {
            const built = _buildV2PaymentSignatureHeader(paymentMeta, signedTxBase64);
            if (built.error) return built;
            proofHeaders = { 'payment-signature': built.value };
        } else {
            const xPaymentPayload = {
                x402Version: 1,
                scheme: 'exact',
                network: 'solana',
                payload: {
                    transaction: signedTxBase64,
                },
            };
            const xPaymentHeader = Buffer.from(JSON.stringify(xPaymentPayload), 'utf8').toString('base64');
            proofHeaders = { 'x-payment': xPaymentHeader };
        }

        const resp = await fetchFn(parsed, pinnedIp, pinnedFamily, proofHeaders, timeoutLeftMs || 30000);

        if (resp.error) return { error: resp.error, reason: resp.reason };
        if (resp.status === 402) {
            return { error: 'payment_rejected', reason: `server returned 402 again (status=${resp.status})` };
        }
        if (resp.status >= 400) {
            return { error: 'settle_http_error', reason: `server returned ${resp.status} after payment` };
        }

        // Settlement signature: server returns the on-chain payment
        // signature on a successful 200 via a base64-encoded response
        // header. The header NAME differs by version:
        //   v1: `X-Payment-Response` (pay.sh sandbox-success fixture)
        //   v2: `PAYMENT-RESPONSE` (per Coinbase x402 v2 spec — a
        //       `SettlementResponse` object: { success, transaction,
        //       network, payer } or { success: false, errorReason, ... }).
        // The inner JSON shape converged across versions enough that we
        // can read `.transaction` (v1 & v2 both use that key for the
        // signature) — fall back to `.signature` for any legacy variant.
        // We check both header names to be liberal in what we accept.
        let signature = null;
        let v2SettlementResponse = null;
        const respHeader = resp.headers && (
            resp.headers['payment-response'] ||       // v2 (lowercased by Node)
            resp.headers['PAYMENT-RESPONSE'] ||       // v2 (defensive)
            resp.headers['x-payment-response'] ||     // v1
            resp.headers['X-Payment-Response']        // v1 (defensive)
        );
        if (typeof respHeader === 'string') {
            try {
                const decoded = JSON.parse(Buffer.from(respHeader, 'base64').toString('utf8'));
                if (decoded && typeof decoded.transaction === 'string') signature = decoded.transaction;
                else if (decoded && typeof decoded.signature === 'string') signature = decoded.signature;
                // v2 spec: SettlementResponse with explicit success boolean.
                // When success=false the on-chain tx didn't land — surface
                // as an error rather than a fake success.
                if (negotiatedVersion === 2 && decoded && decoded.success === false) {
                    return {
                        error: 'settle_failed',
                        reason: `facilitator reported failure: ${decoded.errorReason || 'no reason given'}`,
                        response: resp,
                    };
                }
                if (negotiatedVersion === 2) v2SettlementResponse = decoded;
            } catch (_) { /* leave signature null */ }
        }

        const out = { response: resp, signature };
        if (v2SettlementResponse) out.settlementResponse = v2SettlementResponse;
        return out;
    }
}

module.exports = {
    X402Protocol,
    // Exposed for tests:
    USDC_MINT,
    TOKEN_PROGRAM_ID,
    ASSOCIATED_TOKEN_PROGRAM_ID,
    _buildUsdcTransferTx,
    _buildV2UsdcTransferTx,
    _buildCuLimitData,
    _buildCuPriceData,
    _buildMemoData,
    _generateRandomMemoNonce,
    _buildV2PaymentSignatureHeader,
    COMPUTE_BUDGET_PROGRAM_ID,
    MEMO_PROGRAM_ID,
    _findAssociatedTokenAddress,
    _isOnCurve,
    _decodeSolanaPubkey,
    _extractPayload,
    _extractRequirementsArray,
    _classifyNetwork,
    _pickSolanaRequirement,
    _validateVersion,
    _readAmount,
    _isUsdcAsset,
    _parseAmountAtomic,
    _setBlockhashFetcher,
    // Constants for tests
    SOLANA_MAINNET_GENESIS,
    X402_VERSIONS_SUPPORTED,
};
