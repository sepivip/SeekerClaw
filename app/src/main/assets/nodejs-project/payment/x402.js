// SeekerClaw — payment/x402.js
// X402 protocol implementation (BAT-582 Phase 6). pay.sh-compatible
// Solana mainnet USDC settlement.
//
// CONTRACT (per BAT-582 v1.4 "x402 V1 boundary")
// ----------------------------------------------
// detect(response):
//   - true when response.status === 402 AND body parses as the x402 JSON
//     shape (has `accepts: [...]` or `paymentRequirements: [...]`).
//
// build(response, ctx):
//   - Parse JSON payment requirements per the captured pay.sh fixture.
//   - Validate `network === "solana"` (else: non_solana_network).
//   - Validate `asset === "USDC"` or asset matches the pinned USDC mint
//     EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v (else: non_usdc_asset).
//   - Parse demand `maxAmountRequired` (atomic USDC microunits) — must be
//     ≤ ctx.maxUsdcAtomic (else: demand_exceeds_max_usdc).
//   - Validate `payTo` is a valid Solana base58 pubkey (32 bytes when decoded).
//   - Build a USDC SPL TransferChecked tx from burner pubkey → recipient.
//     Returns { txBase64, paymentMeta }.
//
// settle(originalRequest, signedTxBase64, paymentMeta):
//   - Replay original GET with the X-PAYMENT proof header (per fixture).
//   - X-PAYMENT is base64-encoded JSON: { x402Version, scheme, network,
//     payload: { transaction: <signedTxBase64> } }. The exact shape comes
//     from the committed pay.sh sandbox-success fixture — see
//     tests/payment/fixtures/paysh-sandbox-success.json.
//
// PRE-FLIGHT REJECTIONS happen in the agent_pay tool before detect().
// This module focuses on the x402-specific protocol mechanics only.

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
    const hex = value.toString(16);
    const hexPadded = hex.length % 2 ? '0' + hex : hex;
    const decoded = Buffer.from(hexPadded, 'hex');
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
    const tokenProgramBytes = _base58Decode(TOKEN_PROGRAM_ID);
    const associatedTokenProgramBytes = _base58Decode(ASSOCIATED_TOKEN_PROGRAM_ID);
    const seeds = [ownerPubkeyBytes, tokenProgramBytes, mintPubkeyBytes];
    return _findProgramAddress(seeds, associatedTokenProgramBytes);
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

    const mintBytes = _base58Decode(USDC_MINT);
    const tokenProgramBytes = _base58Decode(TOKEN_PROGRAM_ID);
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
function _extractRequirements(body) {
    if (!body || typeof body !== 'object') return null;
    if (Array.isArray(body.accepts) && body.accepts.length > 0) return body.accepts;
    if (Array.isArray(body.paymentRequirements) && body.paymentRequirements.length > 0) return body.paymentRequirements;
    return null;
}

// Pick the first acceptable requirement: scheme=exact, network=solana, asset=USDC.
function _pickRequirement(reqs) {
    for (const r of reqs) {
        const scheme = String(r.scheme || '').toLowerCase();
        if (scheme && scheme !== 'exact') continue;
        const network = String(r.network || '').toLowerCase();
        if (network && network !== 'solana') continue;
        return r;
    }
    return null;
}

function _isUsdcAsset(asset) {
    if (!asset) return false;
    const s = String(asset).trim();
    return s === USDC_MINT || s.toLowerCase() === 'usdc' || s.toLowerCase() === 'usd-coin';
}

function _parseAmountAtomic(s) {
    if (s == null) return null;
    const str = String(s).trim();
    if (!/^\d+$/.test(str)) return null;
    try { return BigInt(str); } catch (_) { return null; }
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
    const res = await solanaRpc('getLatestBlockhash', [{ commitment: 'finalized' }]);
    if (!res || res.error) throw new Error(`getLatestBlockhash failed: ${res && res.error ? res.error : 'unknown'}`);
    const bh = res && res.result && res.result.value && res.result.value.blockhash;
    if (!bh) throw new Error('getLatestBlockhash response missing blockhash');
    return bh;
}

// ── X402 protocol class ──────────────────────────────────────────────────────

class X402Protocol extends PaymentProtocol {
    get name() { return 'x402'; }

    /**
     * Detect whether a 402 response carries x402 payment requirements.
     * Pinned against tests/payment/fixtures/paysh-sandbox-402.json.
     */
    detect(response) {
        if (!response || response.status !== 402) return false;
        const reqs = _extractRequirements(response.bodyJson);
        if (!reqs) return false;
        // At least one requirement on Solana with the exact scheme.
        for (const r of reqs) {
            const scheme = String(r.scheme || '').toLowerCase();
            const network = String(r.network || '').toLowerCase();
            if ((!scheme || scheme === 'exact') && (!network || network === 'solana')) {
                return true;
            }
        }
        return false;
    }

    async build(response, ctx) {
        const ws = ctx || {};
        const maxUsdcAtomic = ws.maxUsdcAtomic;
        if (typeof maxUsdcAtomic !== 'bigint') {
            return { error: 'invalid_input', reason: 'ctx.maxUsdcAtomic must be a BigInt' };
        }
        const burnerPubkey58 = ws.burnerPubkey || (ws.signerWallet && typeof ws.signerWallet.pubkeySync === 'function' ? ws.signerWallet.pubkeySync() : null);
        // burnerPubkey is awaited from /burner/status by the caller; make sure
        // we have it as a string here.
        if (typeof burnerPubkey58 !== 'string' || !_decodeSolanaPubkey(burnerPubkey58)) {
            return { error: 'invalid_burner_pubkey', reason: 'burner pubkey not available or invalid' };
        }

        const reqs = _extractRequirements(response.bodyJson);
        if (!reqs) return { error: 'invalid_402_body', reason: 'response body has no accepts/paymentRequirements array' };
        const r = _pickRequirement(reqs);
        if (!r) return { error: 'no_acceptable_requirement', reason: 'no x402 requirement matched scheme=exact + network=solana' };

        // Network — tightened guard (server may omit on default).
        if (r.network && String(r.network).toLowerCase() !== 'solana') {
            return { error: 'non_solana_network', reason: `network=${r.network} not supported (Solana only)` };
        }

        // Asset — must be USDC (or its mint).
        if (!_isUsdcAsset(r.asset)) {
            return { error: 'non_usdc_asset', reason: `asset=${r.asset} not supported (USDC only)` };
        }

        // Demand amount (atomic USDC microunits, string per x402 spec).
        const demand = _parseAmountAtomic(r.maxAmountRequired);
        if (demand == null || demand <= 0n) {
            return { error: 'invalid_demand', reason: `maxAmountRequired=${r.maxAmountRequired} not a positive integer string` };
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

        let built;
        try {
            built = _buildUsdcTransferTx(burnerPubkey58, recipient, demand, recentBlockhash);
        } catch (e) {
            return { error: 'tx_build_failed', reason: e.message };
        }

        const txBase64 = built.txBuffer.toString('base64');
        const meta = {
            ...built.paymentMeta,
            scheme: 'exact',
            network: 'solana',
            asset: USDC_MINT,
            x402Version: X402_VERSION,
            // Store a short-lived ref to the original requirement so settle()
            // can echo back any extension fields if the server requires them.
            requirement: {
                scheme: r.scheme || 'exact',
                network: r.network || 'solana',
                payTo: r.payTo,
                resource: r.resource,
                description: r.description,
                maxTimeoutSeconds: r.maxTimeoutSeconds,
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

        const xPaymentPayload = {
            x402Version: X402_VERSION,
            scheme: 'exact',
            network: 'solana',
            payload: {
                transaction: signedTxBase64,
            },
        };
        const xPaymentHeader = Buffer.from(JSON.stringify(xPaymentPayload), 'utf8').toString('base64');

        const resp = await fetchFn(parsed, pinnedIp, pinnedFamily, {
            'x-payment': xPaymentHeader,
        }, timeoutLeftMs || 30000);

        if (resp.error) return { error: resp.error, reason: resp.reason };
        if (resp.status === 402) {
            return { error: 'payment_rejected', reason: `server returned 402 again (status=${resp.status})` };
        }
        if (resp.status >= 400) {
            return { error: 'settle_http_error', reason: `server returned ${resp.status} after payment` };
        }

        // Settlement signature: pay.sh returns a `X-Payment-Response` header
        // (base64-encoded JSON) on success. We surface the on-chain signature
        // if present so the agent can show a Solscan link.
        let signature = null;
        const respHeader = resp.headers && (resp.headers['x-payment-response'] || resp.headers['X-Payment-Response']);
        if (typeof respHeader === 'string') {
            try {
                const decoded = JSON.parse(Buffer.from(respHeader, 'base64').toString('utf8'));
                if (decoded && typeof decoded.transaction === 'string') signature = decoded.transaction;
                else if (decoded && typeof decoded.signature === 'string') signature = decoded.signature;
            } catch (_) { /* leave null */ }
        }

        return {
            response: resp,
            signature,
        };
    }
}

module.exports = {
    X402Protocol,
    // Exposed for tests:
    USDC_MINT,
    TOKEN_PROGRAM_ID,
    ASSOCIATED_TOKEN_PROGRAM_ID,
    _buildUsdcTransferTx,
    _findAssociatedTokenAddress,
    _isOnCurve,
    _decodeSolanaPubkey,
    _extractRequirements,
    _pickRequirement,
    _isUsdcAsset,
    _parseAmountAtomic,
    _setBlockhashFetcher,
};
