/**
 * BAT-1025 C1 — live capture of Jupiter Trigger V2 deposit tx + pre-sign simulation.
 *
 * Per the BAT-1025 v9.1 contract on Linear (Codex Option C re-pin, 2026-06-08):
 *
 *   Phase (i)  — deserialize the unsigned deposit tx, walk TOP-LEVEL Token Program
 *                Transfer / TransferChecked instructions. If a burner-source SPL
 *                transfer is found at top level, compare its destination to
 *                derivedAta(vaultPubkey, USDC). Match → Option B confirmed.
 *
 *   Phase (ii) — if no top-level burner-source transfer (expected — Jupiter
 *                Trigger V2 is an Anchor program), run simulateTransaction with
 *                innerInstructions:true, then walk sim.value.innerInstructions[]
 *                for the burner-source SPL transfer.
 *
 *   Phase (iii) — if neither path matches, halt and post evidence on Linear.
 *                 No A/B/C feature-flag implementation.
 *
 * Outputs:
 *   - tests/jupiter-ultra/fixtures/sim-deposit-pinned.json (canonical, replay test)
 *   - tests/jupiter-ultra/fixtures/sim-deposit-<unix-ms>.json (audit trail)
 *
 * Safety:
 *   - Loads BURNER_SECRET_KEY from .env.test, never echoes it.
 *   - Does NOT sign or broadcast the deposit tx (sigVerify:false simulation only).
 *   - Fixture omits JWT, secret key material, full RPC URL.
 *   - Pubkeys logged as aaaa…zzzz prefix/suffix.
 */

require('dotenv').config({ path: __dirname + '/.env.test' });

const https = require('https');
const bs58 = require('bs58');
const fs = require('fs');
const path = require('path');
const {
    Keypair,
    VersionedTransaction,
    Connection,
    PublicKey,
} = require('@solana/web3.js');

const JUPITER_HOST = 'api.jup.ag';
const USDC_MINT = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v';
const SOL_MINT = 'So11111111111111111111111111111111111111112';
const USDC_DECIMALS = 6;

const TOKEN_PROGRAM_ID = 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA';
const TOKEN_2022_PROGRAM_ID = 'TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb';
const ASSOCIATED_TOKEN_PROGRAM_ID = 'ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL';
const SYSTEM_PROGRAM_ID = '11111111111111111111111111111111';

const TOKEN_IX = Object.freeze({
    TRANSFER: 3,
    TRANSFER_CHECKED: 12,
});

const INPUT_AMOUNT_ATOMIC = process.env.SEEKERCLAW_TEST_ORDER_USDC_ATOMIC
    || String(10n * (10n ** BigInt(USDC_DECIMALS)));

const FIXTURE_DIR = path.join(__dirname, 'fixtures');
const PINNED_FIXTURE = path.join(FIXTURE_DIR, 'sim-deposit-pinned.json');
const AUDIT_FIXTURE = path.join(FIXTURE_DIR, `sim-deposit-${Date.now()}.json`);

function redactPubkey(pk) {
    const s = typeof pk === 'string' ? pk : (pk && pk.toBase58 ? pk.toBase58() : String(pk));
    return s.length < 8 ? '<pk>' : `${s.slice(0, 4)}…${s.slice(-4)}`;
}

function loadKeypair() {
    const raw = process.env.BURNER_SECRET_KEY;
    if (!raw) throw new Error('BURNER_SECRET_KEY missing from .env.test');
    let bytes;
    try { bytes = bs58.decode(raw); }
    catch (_) {
        try { bytes = Uint8Array.from(JSON.parse(raw)); }
        catch (_2) { bytes = Buffer.from(raw, 'base64'); }
    }
    return Keypair.fromSecretKey(bytes);
}

function jupiterRequest(method, requestPath, body, token) {
    return new Promise((resolve, reject) => {
        const apiKey = process.env.JUPITER_API_KEY;
        if (!apiKey) return reject(new Error('JUPITER_API_KEY missing from .env.test'));
        const payload = body ? JSON.stringify(body) : null;
        const headers = {
            'Accept': 'application/json',
            'x-api-key': apiKey,
        };
        if (token) headers['Authorization'] = `Bearer ${token}`;
        if (payload) {
            headers['Content-Type'] = 'application/json';
            headers['Content-Length'] = Buffer.byteLength(payload);
        }
        const req = https.request({ hostname: JUPITER_HOST, path: requestPath, method, headers, timeout: 30000 }, (res) => {
            let data = '';
            res.on('data', c => data += c);
            res.on('end', () => {
                let parsed;
                try { parsed = JSON.parse(data); } catch { parsed = data; }
                resolve({ status: res.statusCode, body: parsed });
            });
        });
        req.on('error', reject);
        req.on('timeout', () => { req.destroy(new Error(`Jupiter ${method} ${requestPath} timeout`)); });
        if (payload) req.write(payload);
        req.end();
    });
}

function deriveAta(ownerBase58, mintBase58, tokenProgramBase58 = TOKEN_PROGRAM_ID) {
    const owner = new PublicKey(ownerBase58);
    const mint = new PublicKey(mintBase58);
    const tokenProgram = new PublicKey(tokenProgramBase58);
    const associatedTokenProgram = new PublicKey(ASSOCIATED_TOKEN_PROGRAM_ID);
    const [ata] = PublicKey.findProgramAddressSync(
        [owner.toBuffer(), tokenProgram.toBuffer(), mint.toBuffer()],
        associatedTokenProgram,
    );
    return ata.toBase58();
}

function readLEUInt64(buf, offset) {
    return BigInt(buf.readUInt32LE(offset)) | (BigInt(buf.readUInt32LE(offset + 4)) << 32n);
}

function decodeSplTransferAmount(dataBytes) {
    // Transfer:        [0]=3,  [1..9]=amount (u64 LE)
    // TransferChecked: [0]=12, [1..9]=amount (u64 LE), [9]=decimals
    if (dataBytes.length < 9) return null;
    const disc = dataBytes[0];
    if (disc !== TOKEN_IX.TRANSFER && disc !== TOKEN_IX.TRANSFER_CHECKED) return null;
    return readLEUInt64(Buffer.from(dataBytes), 1);
}

/**
 * Phase (i) — walk top-level instructions in the unsigned tx for a burner-source
 * SPL Token Transfer. Returns the matched destination + amount, or null.
 *
 * Account index by discriminator:
 *   Transfer        (3)  → [0]=source, [1]=destination,        [2]=authority
 *   TransferChecked (12) → [0]=source, [1]=mint, [2]=destination, [3]=authority
 */
function walkTopLevelForBurnerTransfer(msg, allKeys, burnerUsdcAta) {
    const matches = [];
    msg.compiledInstructions.forEach((ix, ixIdx) => {
        const programId = allKeys[ix.programIdIndex];
        if (programId !== TOKEN_PROGRAM_ID && programId !== TOKEN_2022_PROGRAM_ID) return;
        const dataBytes = Buffer.from(ix.data);
        const amount = decodeSplTransferAmount(dataBytes);
        if (amount === null) return;
        const disc = dataBytes[0];
        const srcIdx = ix.accountKeyIndexes[0];
        const dstIdx = disc === TOKEN_IX.TRANSFER_CHECKED ? ix.accountKeyIndexes[2] : ix.accountKeyIndexes[1];
        if (srcIdx >= allKeys.length || dstIdx === undefined || dstIdx >= allKeys.length) {
            return;
        }
        const source = allKeys[srcIdx];
        const destination = allKeys[dstIdx];
        if (source === burnerUsdcAta) {
            matches.push({
                ixIdx,
                discriminator: disc === TOKEN_IX.TRANSFER_CHECKED ? 'TransferChecked' : 'Transfer',
                source,
                destination,
                amountAtomic: amount.toString(),
                programId,
                level: 'top',
            });
        }
    });
    return matches;
}

/**
 * Phase (ii) — walk sim.value.innerInstructions[].instructions[] for a
 * burner-source SPL Token Transfer.
 */
function walkInnerInstructionsForBurnerTransfer(sim, allKeysIncludingAlt, burnerUsdcAta) {
    const matches = [];
    const inner = sim?.value?.innerInstructions;
    if (!Array.isArray(inner)) return matches;
    inner.forEach((entry) => {
        const outerIdx = entry.index;
        const instructions = entry.instructions || [];
        instructions.forEach((iix, innerIdx) => {
            const programIdIdx = iix.programIdIndex;
            const programId = allKeysIncludingAlt[programIdIdx];
            if (programId !== TOKEN_PROGRAM_ID && programId !== TOKEN_2022_PROGRAM_ID) return;
            const dataBytes = Buffer.from(bs58.decode(iix.data));
            const amount = decodeSplTransferAmount(dataBytes);
            if (amount === null) return;
            const disc = dataBytes[0];
            const srcIdx = iix.accounts[0];
            const dstIdx = disc === TOKEN_IX.TRANSFER_CHECKED ? iix.accounts[2] : iix.accounts[1];
            if (srcIdx >= allKeysIncludingAlt.length || dstIdx === undefined || dstIdx >= allKeysIncludingAlt.length) return;
            const source = allKeysIncludingAlt[srcIdx];
            const destination = allKeysIncludingAlt[dstIdx];
            if (source === burnerUsdcAta) {
                matches.push({
                    outerIdx,
                    innerIdx,
                    discriminator: disc === TOKEN_IX.TRANSFER_CHECKED ? 'TransferChecked' : 'Transfer',
                    source,
                    destination,
                    amountAtomic: amount.toString(),
                    programId,
                    level: 'inner',
                });
            }
        });
    });
    return matches;
}

function ensureFixtureDir() {
    if (!fs.existsSync(FIXTURE_DIR)) fs.mkdirSync(FIXTURE_DIR, { recursive: true });
}

function writeFixture(payload) {
    ensureFixtureDir();
    const json = JSON.stringify(payload, null, 2);
    fs.writeFileSync(PINNED_FIXTURE, json + '\n');
    fs.writeFileSync(AUDIT_FIXTURE, json + '\n');
}

(async () => {
    const result = {
        phaseMatched: null,
        verdict: null,
        evidence: {},
    };

    try {
        const kp = loadKeypair();
        const burnerPubkey = kp.publicKey.toBase58();
        console.log(`Burner pubkey: ${redactPubkey(burnerPubkey)}`);

        // Stage 1-3: Auth challenge → sign → verify → JWT
        console.log('[Stage 1] /trigger/v2/auth/challenge ...');
        const challenge = await jupiterRequest('POST', '/trigger/v2/auth/challenge', { walletPubkey: burnerPubkey, type: 'transaction' });
        if (challenge.status !== 200 || !challenge.body.transaction) {
            throw new Error(`auth/challenge failed: status=${challenge.status} body=${JSON.stringify(challenge.body).slice(0, 300)}`);
        }
        const chTxBytes = Buffer.from(challenge.body.transaction, 'base64');
        const chTx = VersionedTransaction.deserialize(chTxBytes);
        chTx.sign([kp]);
        const chSigned = Buffer.from(chTx.serialize()).toString('base64');

        console.log('[Stage 2] /trigger/v2/auth/verify ...');
        const verify = await jupiterRequest('POST', '/trigger/v2/auth/verify', { type: 'transaction', walletPubkey: burnerPubkey, signedTransaction: chSigned });
        if (verify.status !== 200 || !verify.body.token) {
            throw new Error(`auth/verify failed: status=${verify.status} body=${JSON.stringify(verify.body).slice(0, 300)}`);
        }
        const jwt = verify.body.token;
        console.log('[Stage 2] JWT obtained');

        // Stage 4: GET vault
        console.log('[Stage 4] GET /trigger/v2/vault ...');
        const vaultRes = await jupiterRequest('GET', '/trigger/v2/vault', null, jwt);
        if (vaultRes.status !== 200 || !vaultRes.body.vaultPubkey) {
            throw new Error(`vault GET failed: status=${vaultRes.status} body=${JSON.stringify(vaultRes.body).slice(0, 300)}`);
        }
        const vaultPubkey = vaultRes.body.vaultPubkey;
        console.log(`[Stage 4] vaultPubkey: ${redactPubkey(vaultPubkey)}`);

        // Stage 5: POST deposit/craft
        console.log(`[Stage 5] POST /trigger/v2/deposit/craft (amount=${INPUT_AMOUNT_ATOMIC}) ...`);
        const craft = await jupiterRequest('POST', '/trigger/v2/deposit/craft', {
            inputMint: USDC_MINT,
            outputMint: SOL_MINT,
            userAddress: burnerPubkey,
            amount: INPUT_AMOUNT_ATOMIC,
            orderType: 'price',
            orderSubType: 'single',
        }, jwt);
        if (craft.status !== 200 || !craft.body.transaction) {
            throw new Error(`deposit/craft failed: status=${craft.status} body=${JSON.stringify(craft.body).slice(0, 500)}`);
        }
        const depositTxB64 = craft.body.transaction;
        const receiverAddress = craft.body.receiverAddress;
        const craftRequestId = craft.body.requestId;
        const inputTokenAccount = craft.body.inputTokenAccount;
        const craftMint = craft.body.mint;
        const craftAmount = craft.body.amount;
        const craftTokenDecimals = craft.body.tokenDecimals;
        console.log(`[Stage 5] depositRequestId obtained, receiverAddress: ${redactPubkey(receiverAddress)}`);
        console.log(`[Stage 5] receiverAddress matches vaultPubkey: ${receiverAddress === vaultPubkey}`);
        console.log(`[Stage 5] inputTokenAccount from craft response: ${inputTokenAccount ? redactPubkey(inputTokenAccount) : '(absent)'}`);
        console.log(`[Stage 5] craft.body.mint: ${craftMint ? redactPubkey(craftMint) : '(absent)'} (USDC mint = ${redactPubkey(USDC_MINT)})`);
        console.log(`[Stage 5] craft.body.amount: ${craftAmount || '(absent)'}, tokenDecimals: ${craftTokenDecimals || '(absent)'}`);
        console.log(`[Stage 5] Top-level craft response keys: ${JSON.stringify(Object.keys(craft.body))}`);

        // Stage 6: Decode unsigned tx + derive ATAs
        const txBytes = Buffer.from(depositTxB64, 'base64');
        const tx = VersionedTransaction.deserialize(txBytes);
        const msg = tx.message;
        const staticKeys = msg.staticAccountKeys.map(k => k.toBase58());
        console.log(`[Stage 6] unsigned tx: ${msg.compiledInstructions.length} top-level instructions, ${msg.addressTableLookups.length} ALTs`);

        const burnerUsdcAta = deriveAta(burnerPubkey, USDC_MINT);
        const vaultUsdcAta = deriveAta(vaultPubkey, USDC_MINT);
        console.log(`[Stage 6] burnerUsdcAta:   ${redactPubkey(burnerUsdcAta)}`);
        console.log(`[Stage 6] vaultUsdcAta:    ${redactPubkey(vaultUsdcAta)}  ← Option B prediction`);

        result.evidence = {
            burnerPubkey,
            vaultPubkey,
            burnerUsdcAta,
            vaultUsdcAta,
            receiverAddress,
            receiverAddressEqualsVaultPubkey: receiverAddress === vaultPubkey,
            inputTokenAccount,
            inputTokenAccountEqualsVaultUsdcAta: inputTokenAccount === vaultUsdcAta,
            inputMint: USDC_MINT,
            inputAmountAtomic: INPUT_AMOUNT_ATOMIC,
            craftResponseKeys: Object.keys(craft.body),
            craftMint,
            craftAmount,
            craftTokenDecimals,
            topLevelInstructionCount: msg.compiledInstructions.length,
            altCount: msg.addressTableLookups.length,
            staticKeyCount: staticKeys.length,
        };

        // ── Phase (i) — top-level walk ───────────────────────────────────────
        console.log('\n[Phase i] Walking top-level instructions for burner-source SPL Transfer ...');
        const phase1Matches = walkTopLevelForBurnerTransfer(msg, staticKeys, burnerUsdcAta);
        console.log(`[Phase i] burner-source SPL transfers found at top level: ${phase1Matches.length}`);
        phase1Matches.forEach((m, i) => {
            console.log(`  match[${i}]: ${m.discriminator} src=${redactPubkey(m.source)} dst=${redactPubkey(m.destination)} amount=${m.amountAtomic}`);
            console.log(`            dst === vaultUsdcAta:      ${m.destination === vaultUsdcAta}  (Option B)`);
            console.log(`            dst === inputTokenAccount: ${m.destination === inputTokenAccount}  (Option C)`);
        });
        const phase1Match = phase1Matches.find(m => m.destination === vaultUsdcAta);
        const phase1OptionCMatch = phase1Matches.find(m => m.destination === inputTokenAccount && inputTokenAccount);
        if (phase1Match) {
            console.log('[Phase i] ✅ Option B CONFIRMED at top level — destination matches deriveAta(vaultPubkey, USDC)');
            result.phaseMatched = 'i';
            result.optionConfirmed = 'B';
            result.matchedTransfer = phase1Match;
        } else if (phase1OptionCMatch) {
            console.log('[Phase i] ✅ Option C CONFIRMED at top level — destination matches inputTokenAccount from /deposit/craft response');
            result.phaseMatched = 'i';
            result.optionConfirmed = 'C';
            result.matchedTransfer = phase1OptionCMatch;
        }

        // ── Phase (ii) — ALWAYS run sim (per Codex C1 review 2026-06-08):
        //    owner-binding policy assertion is a sim post-state check, not a
        //    pre-sign getAccountInfo preflight. Fixture MUST include
        //    sim.value.accounts so the replay test can validate
        //    postAI.splToken.owner === receiverAddress.
        //    Phase (i) Option B/C match still wins for the verdict; we just
        //    capture the sim alongside for downstream test infrastructure.
        let simResult = null;
        let preSnapshot = null;
        const alwaysRunSim = true;
        if (alwaysRunSim || !result.phaseMatched) {
            console.log('\n[Phase ii] No top-level match — running simulateTransaction(innerInstructions:true) ...');
            const rpcUrl = process.env.SOLANA_RPC;
            if (!rpcUrl) throw new Error('SOLANA_RPC missing from .env.test');
            const conn = new Connection(rpcUrl, 'processed');

            // Public Solana RPC caps simulateTransaction accounts.addresses at 13.
            // Copilot PR #401 R2: prioritize `inputTokenAccount` because the
            // pinned fixture's `postAI.splToken.owner === receiverAddress`
            // replay assertion is on THIS address — if it gets bumped past
            // slot 13 by static-key padding, the fixture loses post-state
            // for the very account the replay test needs. Order: the 4
            // strictly-needed pubkeys (burner, vault, burner ATA, vault
            // USDC ATA derived) + inputTokenAccount when present, then
            // pad with staticKeys for richer fixture coverage.
            const RPC_ACCOUNT_CAP = 13;
            const priority = [burnerPubkey, vaultPubkey, burnerUsdcAta, vaultUsdcAta];
            if (inputTokenAccount) priority.push(inputTokenAccount);
            const requestedAddresses = new Set(priority);
            for (const k of staticKeys) {
                if (requestedAddresses.size >= RPC_ACCOUNT_CAP) break;
                requestedAddresses.add(k);
            }
            const requestedAddressesArr = [...requestedAddresses];

            // getMultipleAccounts at processed commitment immediately before sim
            const preAccounts = await conn.getMultipleAccountsInfo(
                requestedAddressesArr.map(k => new PublicKey(k)),
                'processed',
            );
            preSnapshot = preAccounts.map((acc, i) => ({
                address: requestedAddressesArr[i],
                exists: acc !== null,
                owner: acc ? acc.owner.toBase58() : null,
                executable: acc ? acc.executable : null,
                lamports: acc ? acc.lamports : null,
                dataLen: acc ? acc.data.length : 0,
                dataBase64: acc ? acc.data.toString('base64') : null,
            }));
            console.log(`[Phase ii] preSnapshot: ${preSnapshot.length} accounts, ${preSnapshot.filter(a => a.exists).length} exist`);

            const sim = await conn.simulateTransaction(tx, {
                sigVerify: false,
                replaceRecentBlockhash: true,
                innerInstructions: true,
                accounts: { addresses: requestedAddressesArr, encoding: 'base64' },
                commitment: 'processed',
            });
            simResult = sim;
            console.log(`[Phase ii] sim.value.err: ${JSON.stringify(sim.value.err)}`);
            console.log(`[Phase ii] sim.value.innerInstructions length: ${(sim.value.innerInstructions || []).length}`);

            // Build extended account-key set including ALT-resolved addresses
            const loadedAddresses = sim.value.loadedAddresses || {};
            const altWritable = (loadedAddresses.writable || []);
            const altReadonly = (loadedAddresses.readonly || []);
            const allKeysIncludingAlt = [...staticKeys, ...altWritable, ...altReadonly];
            console.log(`[Phase ii] allKeysIncludingAlt: ${staticKeys.length} static + ${altWritable.length} alt-writable + ${altReadonly.length} alt-readonly = ${allKeysIncludingAlt.length}`);

            const phase2Matches = walkInnerInstructionsForBurnerTransfer(sim, allKeysIncludingAlt, burnerUsdcAta);
            console.log(`[Phase ii] burner-source SPL transfers found in innerInstructions: ${phase2Matches.length}`);
            phase2Matches.forEach((m, i) => {
                console.log(`  match[${i}]: outer=${m.outerIdx} inner=${m.innerIdx} src=${redactPubkey(m.source)} dst=${redactPubkey(m.destination)} amount=${m.amountAtomic}`);
                console.log(`            dst === vaultUsdcAta: ${m.destination === vaultUsdcAta}`);
            });
            const phase2OptionBMatch = phase2Matches.find(m => m.destination === vaultUsdcAta);
            const phase2OptionCMatch = phase2Matches.find(m => m.destination === inputTokenAccount && inputTokenAccount);
            if (!result.phaseMatched && phase2OptionBMatch) {
                console.log('[Phase ii] ✅ Option B CONFIRMED at CPI / inner-instruction level');
                result.phaseMatched = 'ii';
                result.optionConfirmed = 'B';
                result.matchedTransfer = phase2OptionBMatch;
            } else if (!result.phaseMatched && phase2OptionCMatch) {
                console.log('[Phase ii] ✅ Option C CONFIRMED at CPI / inner-instruction level');
                result.phaseMatched = 'ii';
                result.optionConfirmed = 'C';
                result.matchedTransfer = phase2OptionCMatch;
            }
            // Always capture phase-ii evidence for fixture even if phase (i) won
            result.evidence.phase1Matches = phase1Matches;
            result.evidence.phase2Matches = phase2Matches;
            result.evidence.simErr = sim.value.err;
            result.evidence.simLogs = (sim.value.logs || []).slice(-20);
            result.evidence.altCounts = { writable: altWritable.length, readonly: altReadonly.length };
            if (!result.phaseMatched) {
                console.log('[Phase iii] ❌ HALT: No burner-source SPL Transfer to inputTokenAccount (Option C) or deriveAta(vaultPubkey, USDC) (Option B) at top OR inner level.');
            }
        }

        result.verdict = result.phaseMatched
            ? (result.optionConfirmed === 'C' ? 'option_c_confirmed_inputTokenAccount' : 'option_b_confirmed')
            : 'no_option_matched_halt_and_escalate';

        // Persist fixture (no JWT, no key, no full RPC URL)
        const fixture = {
            spec: 'BAT-1025 v9.1 C1 capture (Codex re-pinned to Option C; owner-binding is sim post-state assertion)',
            capturedAt: new Date().toISOString(),
            network: 'mainnet-beta',
            commitment: 'processed',
            optionConfirmed: result.optionConfirmed || null,  // 'B' | 'C' | null
            phaseMatched: result.phaseMatched,
            verdict: result.verdict,
            evidence: result.evidence,
            matchedTransfer: result.matchedTransfer || null,
            txBase64: depositTxB64,
            receiverAddress,
            jupiterCraftRequestId: craftRequestId,
            preSnapshot,
            sim: simResult ? {
                slot: simResult.context?.slot,
                err: simResult.value.err,
                logs: simResult.value.logs,
                unitsConsumed: simResult.value.unitsConsumed,
                accounts: simResult.value.accounts,
                innerInstructions: simResult.value.innerInstructions,
                loadedAddresses: simResult.value.loadedAddresses,
            } : null,
        };
        writeFixture(fixture);

        console.log(`\n=== C1 RESULT ===`);
        console.log(`Verdict: ${result.verdict}`);
        console.log(`Phase matched: ${result.phaseMatched || '(none)'}`);
        if (result.matchedTransfer) {
            console.log(`Matched transfer: ${result.matchedTransfer.level} level, src=${redactPubkey(result.matchedTransfer.source)}, dst=${redactPubkey(result.matchedTransfer.destination)}, amount=${result.matchedTransfer.amountAtomic}`);
        }
        console.log(`Pinned fixture: ${PINNED_FIXTURE}`);
        console.log(`Audit fixture:  ${AUDIT_FIXTURE}`);

        process.exit(result.phaseMatched ? 0 : 2);
    } catch (err) {
        console.error(`\n=== C1 ERROR ===`);
        console.error(err.message);
        console.error(err.stack);
        const fixture = {
            spec: 'BAT-1025 v9.1 C1 capture — ERROR',
            capturedAt: new Date().toISOString(),
            verdict: 'capture_error',
            error: err.message,
            evidence: result.evidence,
        };
        try { writeFixture(fixture); } catch (_) { /* best effort */ }
        process.exit(1);
    }
})();
