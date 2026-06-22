// tools/solana.js — all solana_* and jupiter_* tool handlers

const fs = require('fs');
const path = require('path');

const {
    workDir, log, config,
} = require('../config');

const { androidBridgeCall } = require('../bridge');

// BAT-1037: native-SOL-only denomination guard (pure, dependency-free module
// so it is unit-testable without config). See tools/solana-send-guard.js.
const { classifySolSendDenomination } = require('./solana-send-guard');

const {
    solanaRpc, base58Encode, buildSolTransferTx,
    resolveToken, jupiterQuote, jupiterPrice,
    jupiterUltraOrder, jupiterUltraExecute,
    jupiterTriggerExecute, jupiterRecurringExecute,
    verifySwapTransaction, jupiterRequest,
    isValidSolanaAddress, parseInputAmountToLamports,
    ensureWalletAuthorized, getConnectedWalletAddress,
    refreshJupiterProgramLabels, heliusDasRequest,
} = require('../solana');

const {
    httpRequest,
} = require('../http');

// BAT-582 Phase 5: wallet dispatch helper. Tool handlers compute their
// unsigned tx + a per-tool broadcast callback, then delegate routing
// (burner-vs-main, reservation, sign, broadcast, commit/release) to
// routeAndSign. Cancels go through signCancelViaBurner. Jupiter create
// tools record ownership via recordJupiterOwnership after a successful
// broadcast. The tool handler stays focused on tx construction +
// post-broadcast bookkeeping; the routing dance lives in wallet/dispatch.
const {
    routeAndSign,
    signCancelViaBurner,
    signZeroCapTxViaBurner,
    recordJupiterOwnership,
} = require('../wallet/dispatch');

// BAT-697 PR B: Jupiter Trigger V2 adapter. Activated when
// `config.useTriggerV2 === true` (default false). V1 paths in
// jupiter_trigger_* handlers remain the shipping default until the staged
// rollout (live smoke → default flip → V1 deletion) lands in subsequent PRs.
const triggerV2 = require('../jupiter/trigger-v2');

// BAT-255: Safe number-to-decimal-string conversion (imported from index.js shared state)
let numberToDecimalString;
function _setNumberToDecimalString(fn) { numberToDecimalString = fn; }

// Q5 (BAT-1013-followup): minimal fee-payer extractor for unsigned txs. Used
// by solana_swap to detect sponsored-fee Ultra txs where account[0] is the
// Jupiter relayer (not the burner) — those would land a silent burner-policy
// reject under Phase 3b's burner_only signerMode, so we route to main as a
// defensive fallback. Parses just enough of the wire format to read message
// account[0]; throws on malformed input so the caller can choose to proceed
// (debug-log) or fail closed. Mirrors the strictness of solana.js
// verifySwapTransaction's preamble (base64 charset + length check + signature
// section skip + v0 prefix detect) without re-walking the instruction tree.
function _extractFeePayerBase58(txBase64) {
    if (typeof txBase64 !== 'string' || txBase64.length === 0) {
        throw new Error('empty or non-string tx');
    }
    // R-next-6 same-class sweep: Solana caps tx packets at 1232 bytes. Pre-
    // decode reject so we never materialize an oversized buffer (DoS guard).
    // 1232 bytes encodes to at most ceil(1232/3)*4 = 1644 chars in base64.
    //
    // R-next-16: length cap MUST run before the charset regex — otherwise
    // a malicious multi-MB string of valid base64 chars forces the regex
    // to scan the full buffer before rejection, defeating the DoS guard.
    if (txBase64.length > 1644) {
        throw new Error(`tx_oversize: ~${Math.floor(txBase64.length * 3 / 4)} bytes exceeds Solana's 1232-byte packet cap`);
    }
    if (!/^[A-Za-z0-9+/]+={0,2}$/.test(txBase64) || txBase64.length % 4 !== 0) {
        throw new Error('invalid base64');
    }
    const buf = Buffer.from(txBase64, 'base64');
    if (buf.length === 0) throw new Error('empty decoded buffer');
    if (buf.length > 1232) {
        throw new Error(`tx_oversize: ${buf.length} bytes exceeds Solana's 1232-byte packet cap`);
    }
    // Decode compact-u16 inline (small helper — solana.js's readCompactU16
    // is not exported through tools/solana.js's import surface).
    let off = 0;
    function readCompactU16At(b, o) {
        let v = 0, s = 0, end = o;
        for (let i = 0; i < 3; i++) {
            if (end >= b.length) throw new Error('compactu16 truncated');
            const byte = b[end];
            end++;
            v |= (byte & 0x7f) << s;
            s += 7;
            if ((byte & 0x80) === 0) return { value: v, offset: end };
        }
        throw new Error('compactu16 too long');
    }
    const numSigs = readCompactU16At(buf, off);
    off = numSigs.offset;
    if (off + numSigs.value * 64 > buf.length) {
        throw new Error('signature bytes truncated');
    }
    off += numSigs.value * 64;
    if (off >= buf.length) throw new Error('message truncated');
    // Detect versioned vs legacy. Solana versioned-message prefix has the
    // high bit set: (prefix & 0x80) !== 0; the lower 7 bits encode the
    // version number. Today only v0 (prefix = 0x80) exists; future versions
    // (v1, v2, ...) would set prefix = 0x81, 0x82, etc. Copilot PR #398 R13:
    // do NOT strict-equal 0x80 — a future v1 (0x81) would silently skip
    // nothing and parse the version number as numRequiredSignatures, yielding
    // the wrong fee-payer with no error signal. Fail closed on any version
    // we don't understand.
    const versionPrefix = buf[off];
    const isVersioned = (versionPrefix & 0x80) !== 0;
    if (isVersioned) {
        const version = versionPrefix & 0x7F;
        if (version !== 0) {
            throw new Error(`unsupported_tx_version: v${version} (only v0 is supported)`);
        }
        off++; // consume v0 prefix byte
    }
    // 3-byte header
    if (off + 3 > buf.length) throw new Error('header truncated');
    off += 3;
    // Account keys count
    const numAccts = readCompactU16At(buf, off);
    off = numAccts.offset;
    if (numAccts.value === 0) throw new Error('zero accounts');
    if (off + 32 > buf.length) throw new Error('account[0] truncated');
    // account[0] = fee payer in legacy AND v0 transactions
    return base58Encode(buf.slice(off, off + 32));
}

const tools = [
    {
        name: 'solana_balance',
        description: 'Get SOL balance and SPL token balances for a Solana wallet address.',
        input_schema: {
            type: 'object',
            properties: {
                address: { type: 'string', description: 'Solana wallet public key (base58). If omitted, uses the connected wallet address.' }
            }
        }
    },
    {
        name: 'solana_history',
        description: 'Get recent transaction history for a Solana wallet address.',
        input_schema: {
            type: 'object',
            properties: {
                address: { type: 'string', description: 'Solana wallet public key (base58). If omitted, uses the connected wallet address.' },
                limit: { type: 'number', description: 'Number of transactions (default 10, max 50)' }
            }
        }
    },
    {
        name: 'solana_address',
        description: 'Get the connected Solana wallet address from the SeekerClaw app.',
        input_schema: {
            type: 'object',
            properties: {}
        }
    },
    {
        name: 'solana_send',
        description: 'Send **native SOL only** to a Solana address. This tool does NOT send SPL tokens (USDC, BONK, PYUSD, …) and does NOT take a fiat amount — do not supply `token` / `mint` / `asset` / `symbol` / `currency`; pass only `to` + `amount` (in SOL). For an SPL token transfer the user must use their wallet app / main wallet manually (a dedicated `solana_send_token` tool is not available yet). For a USD amount, call `solana_price` to get SOL/USD and compute the SOL amount yourself (solana_price does not convert non-USD currencies). **Routing (BAT-582)**: by default (source="auto" or omitted) routes by cap — under burner per-tx + daily SOL caps -> signs silently from the **Burner wallet** (no popup); over cap or burner not configured -> prompts the **Main wallet** for approval (MWA popup). Use `source="main"` when the user EXPLICITLY says "from main" / "from my main wallet" — forces MWA popup regardless of cap. Use `source="burner"` to force burner (rare; usually unnecessary). ALWAYS confirm with the user in chat before calling this tool.',
        input_schema: {
            type: 'object',
            properties: {
                to: { type: 'string', description: 'Recipient Solana address (base58). Must NOT equal the source wallet — self-sends are rejected.' },
                amount: { type: 'number', description: 'Amount of SOL to send' },
                source: { type: 'string', enum: ['burner', 'main', 'auto'], description: 'Which wallet to send from. "main" forces MWA popup (use when user says "from main"). "burner" forces burner. "auto" (default) routes by cap. Default: "auto".' }
            },
            required: ['to', 'amount']
        }
    },
    {
        name: 'solana_price',
        description: 'Get the current USD price of one or more tokens. Use token symbols (SOL, USDC, BONK) or mint addresses. Returns price, currency, and confidenceLevel (high/medium/low). Low confidence means unreliable pricing — warn the user and avoid using for swaps or DCA.',
        input_schema: {
            type: 'object',
            properties: {
                tokens: {
                    type: 'array',
                    items: { type: 'string' },
                    description: 'Token symbols or mint addresses (e.g., ["SOL", "BONK", "USDC"])'
                }
            },
            required: ['tokens']
        }
    },
    {
        name: 'solana_quote',
        description: 'Get a swap quote from Jupiter DEX aggregator. Shows estimated output amount, price impact, and route — without executing. Use this to check prices before swapping.',
        input_schema: {
            type: 'object',
            properties: {
                inputToken: { type: 'string', description: 'Token to sell — symbol (e.g., "SOL") or mint address' },
                outputToken: { type: 'string', description: 'Token to buy — symbol (e.g., "USDC") or mint address' },
                amount: { type: 'number', description: 'Amount of inputToken to sell (in human units, e.g., 1.5 SOL)' },
                slippageBps: { type: 'number', description: 'Slippage tolerance in basis points (default: 100 = 1%). Use lower for stablecoins, higher for volatile tokens.' }
            },
            required: ['inputToken', 'outputToken', 'amount']
        }
    },
    {
        name: 'solana_swap',
        description: 'Swap tokens using Jupiter Ultra (gasless, no SOL needed for fees). **Routing (BAT-582)**: under burner per-tx + daily caps for the input asset -> silent burner sign; over cap or burner not configured -> Main wallet popup. ALWAYS confirm with the user and show the quote first before calling this tool.',
        input_schema: {
            type: 'object',
            properties: {
                inputToken: { type: 'string', description: 'Token to sell — symbol (e.g., "SOL") or mint address' },
                outputToken: { type: 'string', description: 'Token to buy — symbol (e.g., "USDC") or mint address' },
                amount: { type: 'number', description: 'Amount of inputToken to sell (in human units, e.g., 1.5 SOL)' },
            },
            required: ['inputToken', 'outputToken', 'amount']
        }
    },
    // PR #388 R6: the jupiter_trigger_create schema is flag-aware. V1 (default
    // when config.useTriggerV2 is false) requires `triggerPrice`; V2 (when the
    // flag is true) requires `triggerPriceUsd`. Pre-fix the schema relaxed
    // `required` to allow BOTH callers, but that meant the model/gate would
    // accept a V1 call missing triggerPrice and only fail at runtime with
    // "Invalid trigger price". Build the schema once at module load against
    // the active flag so the schema validator rejects bad calls upstream of
    // the handler. Flag changes require a process restart (already true for
    // most flag-gated paths here).
    (() => {
        const v2Enabled = config.useTriggerV2 === true;
        const baseProperties = {
            inputToken: { type: 'string', description: 'Token to sell — symbol (e.g., "SOL") or mint address' },
            outputToken: { type: 'string', description: 'Token to buy — symbol (e.g., "USDC") or mint address' },
            inputAmount: { type: 'number', description: 'Amount of inputToken to sell (in human units)' },
        };
        const v1Properties = {
            triggerPrice: { type: 'number', description: 'Price as outputToken-per-inputToken ratio (e.g., 90 = "1 SOL = 90 USDC"). REQUIRED.' },
            expiryTime: { type: 'number', description: 'Order expiration as Unix seconds. Optional; defaults to 30 days from now.' },
        };
        const v2Properties = {
            triggerPriceUsd: { type: 'number', description: 'USD price where the trigger fires (e.g., 80.50 for $80.50). REQUIRED.' },
            expiresAt: { type: 'number', description: 'Order expiration as Unix seconds OR milliseconds (auto-detected). REQUIRED (no silent default in V2).' },
            expiryTime: { type: 'number', description: 'Legacy alias for `expiresAt` (Unix seconds). Accepted if `expiresAt` not provided. One of the two IS required.' },
            triggerCondition: { type: 'string', enum: ['above', 'below'], description: 'When to fire: "above" (price rises to trigger) or "below" (price drops to trigger). Auto-inferred when one side of the pair is a stablecoin; required for non-stable pairs.' },
            slippageBps: { type: 'number', description: 'Slippage tolerance in basis points (1-10000). Optional; defaults to 100 (1%).' },
            triggerMint: { type: 'string', description: 'Mint address of the asset whose USD price the trigger watches. Auto-inferred when exactly one side of the pair is a stablecoin (SOL↔USDC → SOL is watched). REQUIRED for non-stable↔non-stable pairs (SOL↔JUP) and both-stable pairs (USDC↔USDT).' },
        };
        const v2Schema = {
            type: 'object',
            properties: { ...baseProperties, ...v2Properties },
            required: ['inputToken', 'outputToken', 'inputAmount', 'triggerPriceUsd'],
            // PR #388 R7: V2 handler hard-rejects with `expires_at_required`
            // if NEITHER `expiresAt` nor `expiryTime` is provided. Encode
            // that disjunction in the schema (anyOf) so the model/gate
            // rejects the missing-expiry case at validation time rather than
            // letting it reach the user-confirmation card and dying later.
            anyOf: [
                { required: ['expiresAt'] },
                { required: ['expiryTime'] },
            ],
        };
        const v1Schema = {
            type: 'object',
            properties: { ...baseProperties, ...v1Properties },
            required: ['inputToken', 'outputToken', 'inputAmount', 'triggerPrice'],
        };
        return {
            name: 'jupiter_trigger_create',
            description: v2Enabled
                ? 'Create a trigger (limit) order on Jupiter (V2 API). Requires Jupiter API key (get free at portal.jup.ag). Order executes automatically when the USD price reaches `triggerPriceUsd`. **Routing (BAT-582)**: under burner caps -> silent burner sign; over cap or burner not configured -> Main wallet popup.'
                : 'Create a trigger (limit) order on Jupiter (V1 API). Requires Jupiter API key (get free at portal.jup.ag). Order executes automatically when the output/input price ratio reaches `triggerPrice`. Use for: buy at lower price (limit buy) or sell at higher price (limit sell). **Routing (BAT-582)**: under burner caps -> silent burner sign; over cap or burner not configured -> Main wallet popup.',
            input_schema: v2Enabled ? v2Schema : v1Schema,
        };
    })(),
    {
        name: 'jupiter_trigger_list',
        description: 'List your active or historical limit/stop orders on Jupiter. Shows order status, prices, amounts, and expiration. Requires Jupiter API key.',
        input_schema: {
            type: 'object',
            properties: {
                status: { type: 'string', enum: ['active', 'history'], description: 'Filter by status: "active" for open orders, "history" for filled/cancelled orders. Optional - omit to see all orders.' },
                page: { type: 'number', description: 'Page number for pagination (default: 1)' }
            },
            required: []
        }
    },
    {
        name: 'jupiter_trigger_cancel',
        description: 'Cancel an active limit or stop order on Jupiter. Requires the order ID from jupiter_trigger_list. Requires Jupiter API key. **Routing (BAT-582)**: cancels for orders the burner created -> silent burner sign; cancels for main-wallet orders (or unknown ownership) -> Main wallet popup. Cancels do not consume cap principal.',
        input_schema: {
            type: 'object',
            properties: {
                orderId: { type: 'string', description: 'The order ID to cancel (get from jupiter_trigger_list)' }
            },
            required: ['orderId']
        }
    },
    {
        name: 'jupiter_dca_create',
        description: 'Create a recurring DCA (Dollar Cost Averaging) order on Jupiter. Automatically buys tokens on a schedule to average out price. Perfect for building positions over time. Requires Jupiter API key. **Routing (BAT-582)**: total committed amount (amountPerCycle x cycles) is checked against burner caps; under cap -> silent burner sign; over cap or burner not configured -> Main wallet popup.',
        input_schema: {
            type: 'object',
            properties: {
                inputToken: { type: 'string', description: 'Token to sell (usually stablecoin like "USDC") — symbol or mint address' },
                outputToken: { type: 'string', description: 'Token to buy — symbol (e.g., "SOL", "JUP") or mint address' },
                amountPerCycle: { type: 'number', description: 'Amount of inputToken to spend per cycle (in human units)' },
                cycleInterval: { type: 'string', enum: ['hourly', 'daily', 'weekly'], description: 'How often to execute the buy: "hourly", "daily", or "weekly"' },
                totalCycles: { type: 'number', description: 'Total number of cycles to run (e.g., 30 for 30 days of daily buys). Optional, defaults to 30 cycles.' }
            },
            required: ['inputToken', 'outputToken', 'amountPerCycle', 'cycleInterval']
        }
    },
    {
        name: 'jupiter_dca_list',
        description: 'List your active or historical DCA (recurring) orders on Jupiter. Shows schedule, amounts, cycles completed, and next execution time. Requires Jupiter API key.',
        input_schema: {
            type: 'object',
            properties: {
                status: { type: 'string', enum: ['active', 'history'], description: 'Filter by status: "active" for running DCA orders, "history" for completed/cancelled. Optional - omit to see all orders.' },
                page: { type: 'number', description: 'Page number for pagination (default: 1)' }
            },
            required: []
        }
    },
    {
        name: 'jupiter_dca_cancel',
        description: 'Cancel an active DCA (recurring) order on Jupiter. Stops all future executions. Requires the order ID from jupiter_dca_list. Requires Jupiter API key. **Routing (BAT-582)**: cancels for orders the burner created -> silent burner sign; cancels for main-wallet orders (or unknown ownership) -> Main wallet popup. Cancels do not consume cap principal.',
        input_schema: {
            type: 'object',
            properties: {
                orderId: { type: 'string', description: 'The DCA order ID to cancel (get from jupiter_dca_list)' }
            },
            required: ['orderId']
        }
    },
    {
        name: 'jupiter_token_search',
        description: 'Search for Solana tokens by name or symbol using Jupiter\'s comprehensive token database. Returns token symbol, name, mint address, decimals, price, market cap, liquidity, verification status, organicScore (0-100, higher = more organic trading activity), and isSus (true if flagged suspicious by Jupiter audit). Warn the user about low organicScore or isSus tokens.',
        input_schema: {
            type: 'object',
            properties: {
                query: { type: 'string', description: 'Token name or symbol to search for (e.g., "Bonk", "JUP", "Wrapped SOL")' },
                limit: { type: 'number', description: 'Max number of results (default: 10)' }
            },
            required: ['query']
        }
    },
    {
        name: 'jupiter_token_security',
        description: 'Check token safety using Jupiter Shield + Tokens v2. Scans for red flags: freeze authority, mint authority, low liquidity, isSus (suspicious audit flag), and organicScore (trading activity legitimacy 0-100). ALWAYS check before swapping unknown tokens. Requires Jupiter API key.',
        input_schema: {
            type: 'object',
            properties: {
                token: { type: 'string', description: 'Token symbol (e.g., "BONK") or mint address to check' }
            },
            required: ['token']
        }
    },
    {
        name: 'jupiter_wallet_holdings',
        description: 'View all tokens held by a Solana wallet address. Returns complete list with balances, USD values, and token metadata. More detailed than basic Solana RPC. Requires Jupiter API key.',
        input_schema: {
            type: 'object',
            properties: {
                address: { type: 'string', description: 'Solana wallet address to check (defaults to your connected wallet if not specified)' }
            },
            required: []
        }
    },
    {
        name: 'solana_nft_holdings',
        description: 'View NFTs (including compressed/cNFTs) held by a Solana wallet (up to 100). Returns collection name, NFT name, asset ID, mint address (non-compressed only), image URL, and whether it is compressed. Requires Helius API key. For floor prices, use a skill with Magic Eden or Tensor APIs.',
        input_schema: {
            type: 'object',
            properties: {
                address: {
                    type: 'string',
                    description: 'Solana wallet public key (base58). If omitted, uses the connected wallet address.'
                }
            },
            required: []
        }
    },
];

// ============================================================================
// JUPITER TRIGGER V2 HELPERS (BAT-697 PR B)
// ============================================================================
//
// V2 endpoints are gated behind `config.useTriggerV2`. The V1 handlers below
// branch at the top: if the flag is true, delegate to the helper below;
// otherwise continue the existing V1 path unchanged.
//
// V2 flow (create):
//   1. authenticate(walletPubkey, signers)        → JWT (cached 24h-60s)
//   2. ensureVault(walletPubkey, token)           → lazy register on first use
//   3. depositCraft(...)                          → unsigned deposit tx + depositRequestId
//   4. routeAndSign with broadcast callback that:
//        - signs deposit (main MWA or burner-with-reservation, both via routeAndSign)
//        - POSTs signed deposit to /trigger/v2/orders/price via submitCreateOrder
//        - returns { signature } on create success, { error } on hard failure
//      routeAndSign handles burner reserve/sign/commit-or-release atomically.
//   5. recordJupiterOwnership(id, wallet) — fire-and-forget bookkeeping
//
// V2 flow (cancel):
//   1. ownership lookup (same as V1) → creatorRole
//   2. authenticate that wallet                    → JWT
//   3. cancelStep1(orderId, pubkey, token)         → unsigned cancel tx + cancelRequestId
//   4. sign:
//        - burner-owned → signCancelViaBurner (zero-cap reservation, ownership-gated)
//        - main/unknown → /solana/sign-only via MWA
//   5. confirmCancel(orderId, pubkey, token, signedTx, cancelRequestId)
//
// V2 flow (list):
//   1. main wallet only (scope cut — burner-routed orders need separate auth)
//   2. authenticate main → JWT
//   3. listOrders(pubkey, token, status, page)
//
// AMBIGUOUS-CREATE RECOVERY (Codex round-2 §5)
// --------------------------------------------
// The adapter's submitCreateOrder() runs recovery on 5xx / network drop /
// missing-id-after-200. Recovery queries /orders/history; if a matching
// order is found, returns success with `recovered: true`. If not found,
// returns `create_ambiguous_no_recovery` — the deposit MAY have moved
// funds into the Jupiter vault. We treat this as broadcast success
// (commits the burner cap conservatively) and surface a warning to the
// user with the depositRequestId for manual recovery via Jupiter UI.
// Rationale: cap over-count > under-count for user safety.
//
// MESSAGE-CHALLENGE DEFERRED
// --------------------------
// PR B uses transaction-challenge for both wallets — there is no
// `/burner/sign-message` or `/solana/sign-message` bridge endpoint yet.
// The adapter's signers.signMessage parameter is `null` for both wallets;
// the adapter falls through to transaction-challenge per Codex round-2 #3
// ("unsupported-method/capability error"). A follow-up BAT can add the
// bridge endpoints and pass a non-null signMessage to take the cheaper
// message-only path.

/**
 * Build signers object for trigger-v2.authenticate() based on wallet role.
 * signMessage is null in PR B (see "MESSAGE-CHALLENGE DEFERRED" above).
 */
function _buildAuthSigners(walletRole) {
    if (walletRole === 'burner') {
        return {
            signTransaction: async (txB64) => {
                const r = await signZeroCapTxViaBurner({
                    unsignedTxBase64: txB64,
                    flowName: 'trigger-v2-auth',
                });
                if (!r.ok) return { error: r.error, reason: r.reason };
                return r.signedTxBase64;
            },
            signMessage: null,
        };
    }
    return {
        signTransaction: async (txB64) => {
            try { await ensureWalletAuthorized(); }
            catch (e) { return { error: 'wallet_not_authorized', reason: e.message }; }
            const r = await androidBridgeCall('/solana/sign-only', { transaction: txB64 }, 120000);
            if (r.error) return { error: 'sign_failed', reason: r.error };
            if (!r.signedTransaction) return { error: 'sign_failed', reason: 'no signed tx returned from wallet' };
            return r.signedTransaction;
        },
        signMessage: null,
    };
}

/**
 * Resolve `triggerCondition` for V2 from explicit input or from the
 * input/output token relationship. Returns 'above' | 'below' | null
 * (null only when both are unstable, e.g., a custom altcoin pair without
 * an obvious stable side).
 *
 * Rules:
 *   - Explicit input wins.
 *   - input is a stablecoin (USDC/USDT) → buying outputToken → 'below'
 *     (trigger when output price drops to triggerPriceUsd or lower)
 *   - output is a stablecoin → selling inputToken → 'above'
 *     (trigger when input price rises to triggerPriceUsd or higher)
 *   - neither obvious → null; caller must pass explicit triggerCondition
 */
const _STABLE_MINTS = new Set([
    'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v', // USDC
    'Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB', // USDT
]);
function _inferTriggerCondition(inputMint, outputMint, explicit) {
    if (explicit === 'above' || explicit === 'below') return explicit;
    if (_STABLE_MINTS.has(inputMint) && !_STABLE_MINTS.has(outputMint)) return 'below';
    if (_STABLE_MINTS.has(outputMint) && !_STABLE_MINTS.has(inputMint)) return 'above';
    return null;
}

/**
 * Resolve which mint Jupiter should watch the USD price of (the
 * `triggerMint` body field). The non-stable side of the pair — that's
 * the asset whose USD price actually moves around the trigger value:
 *   - Buying a non-stable with a stable (USDC → SOL, "below $80"):
 *     trigger reads SOL's price → triggerMint = outputMint.
 *   - Selling a non-stable for a stable (SOL → USDC, "above $90"):
 *     trigger reads SOL's price → triggerMint = inputMint.
 *   - Non-stable ↔ non-stable (rare, e.g. SOL ↔ JUP) OR both-stable
 *     (USDC ↔ USDT): NO inference is safe — Jupiter would watch the
 *     wrong asset's USD price and either fire on the wrong side or
 *     never fire. Caller must pass explicit `input.triggerMint`.
 *     Returns null to signal "ambiguous" so the handler can fail
 *     closed with a clear `triggerMint_required` error instead of
 *     silently routing to outputMint (PR #388 R5 finding).
 *
 * The pre-fix shipped `triggerMint = outputMint` unconditionally, which
 * for a sell-into-stable (e.g. SOL → USDC) made Jupiter watch USDC at
 * ~$1 — the documented "SOL ≥ $90" limit-sell would never trigger
 * (PR #388 R2 finding). R5 hardens the degenerate-pair path the same
 * way: never let the wrong asset slip through silently.
 */
function _inferTriggerMint(inputMint, outputMint, explicit) {
    if (typeof explicit === 'string' && explicit.length > 0) return explicit;
    if (_STABLE_MINTS.has(inputMint) && !_STABLE_MINTS.has(outputMint)) return outputMint;
    if (_STABLE_MINTS.has(outputMint) && !_STABLE_MINTS.has(inputMint)) return inputMint;
    return null; // both-stable or both-non-stable: degenerate. Caller MUST pass explicit triggerMint.
}

async function _jupiterTriggerCreateV2(input, _chatId) {
    if (!config.jupiterApiKey) {
        return {
            error: 'Jupiter API key required',
            guide: 'Get a free API key at portal.jup.ag, then add it in SeekerClaw Settings > Configuration > Jupiter API Key',
        };
    }
    try {
        // 1. Resolve tokens (mirrors V1).
        const inputToken = await resolveToken(input.inputToken);
        const outputToken = await resolveToken(input.outputToken);
        if (!inputToken || inputToken.ambiguous) {
            return { error: 'Could not resolve input token', details: inputToken?.ambiguous
                ? `Multiple tokens match "${input.inputToken}". Use the full mint address.`
                : `Token "${input.inputToken}" not found.` };
        }
        if (inputToken.warning && inputToken.decimals == null) {
            return { error: 'Unverified input token with missing metadata', details: inputToken.warning };
        }
        if (!outputToken || outputToken.ambiguous) {
            return { error: 'Could not resolve output token', details: outputToken?.ambiguous
                ? `Multiple tokens match "${input.outputToken}". Use the full mint address.`
                : `Token "${input.outputToken}" not found.` };
        }
        if (outputToken.warning && outputToken.decimals == null) {
            return { error: 'Unverified output token with missing metadata', details: outputToken.warning };
        }

        // 2. Token-2022 shield check (Trigger V2 also rejects Token-2022).
        try {
            const mints = [inputToken.address, outputToken.address].join(',');
            const shieldRes = await jupiterRequest({
                hostname: 'api.jup.ag',
                path: `/ultra/v1/shield?mints=${encodeURIComponent(mints)}`,
                method: 'GET',
                headers: { 'x-api-key': config.jupiterApiKey },
            });
            if (shieldRes.status === 200) {
                const shieldData = typeof shieldRes.data === 'string' ? JSON.parse(shieldRes.data) : shieldRes.data;
                for (const [mint, info] of Object.entries(shieldData || {})) {
                    if (info && (info.tokenType === 'token-2022' || info.isToken2022)) {
                        const sym = mint === inputToken.address ? inputToken.symbol : outputToken.symbol;
                        return {
                            error: 'Token-2022 not supported for limit orders',
                            details: `${sym} (${mint}) is a Token-2022 token. Use a regular swap instead.`,
                        };
                    }
                }
            }
        } catch (shieldErr) {
            log(`[Jupiter Trigger V2] Token-2022 check skipped: ${shieldErr.message}`, 'DEBUG');
        }

        // 3. Routing decision (V1 parity — same caps/preflight call).
        const { routeFor: _routeForTriggerV2 } = require('../caps/preflight');
        const routingHint = await _routeForTriggerV2('jupiter_trigger_create', input);

        // PR #388 R9: over-cap fail-fast. routeFor returns
        // {routingDecision:'burner', underCap:false} when the principal would
        // breach a cap. Pre-fix, the V2 handler continued through burner
        // pubkey lookup, Jupiter auth (server-side session), vault register
        // (server-side vault row), AND deposit/craft (server-side deposit
        // request id) before routeAndSign finally surfaced burner_over_cap.
        // All of those side effects were wasted server state for an order
        // that would never sign. Handle it here:
        //   - With `input._allowMainFallback === true`: flip routing to
        //     'main' BEFORE step 4 so the rest of the flow proceeds against
        //     the MWA wallet (mirrors V1 routing semantics).
        //   - Otherwise: refuse immediately with the same shape dispatch.js
        //     would return, but before any Jupiter or burner-bridge state
        //     is touched.
        if (routingHint.routingDecision === 'burner' && routingHint.underCap === false) {
            if (input._allowMainFallback === true) {
                routingHint.routingDecision = 'main';
                log(`[Jupiter Trigger V2] over-cap (${routingHint.reason || 'unknown'}) — _allowMainFallback set, flipping route to main BEFORE side effects`, 'INFO');
            } else {
                return {
                    error: 'burner_over_cap',
                    reason:
                        `Burner over cap (${routingHint.reason || 'unknown'}). ` +
                        'Raise the cap with wallet_set_caps, or retry with _allowMainFallback: true to use the main wallet (popup required).',
                    capName: routingHint.capName,
                };
            }
        }

        // 4. Resolve wallet address — burner pubkey if routing=burner, MWA pubkey otherwise.
        // If burner routing was chosen but the burner pubkey is unavailable
        // (bridge unreachable, not configured, etc.), we MUST also flip the
        // routing decision to 'main' before proceeding. Otherwise routeAndSign
        // would re-evaluate routing as 'burner' and attempt to sign a tx
        // whose fee payer is the MWA wallet — cap state and signer mismatch.
        let walletAddress;
        if (routingHint.routingDecision === 'burner') {
            try {
                const burnerStatus = await androidBridgeCall('/burner/status', {}, 5000);
                if (burnerStatus && !burnerStatus.error && burnerStatus.configured && burnerStatus.pubkey) {
                    walletAddress = burnerStatus.pubkey;
                }
            } catch (_) { /* fall through */ }
            if (!walletAddress) {
                log('[Jupiter Trigger V2] burner routing chosen but pubkey unavailable — falling back to main wallet', 'WARN');
                routingHint.routingDecision = 'main';
            }
        }
        if (!walletAddress) {
            try { walletAddress = getConnectedWalletAddress(); }
            catch (e) { return { error: e.message }; }
        }

        // 5. Parse inputAmount → raw atomic units (BigInt-safe).
        let inputAmountAtomic;
        try {
            inputAmountAtomic = parseInputAmountToLamports(numberToDecimalString(input.inputAmount), inputToken.decimals);
        } catch (e) {
            return { error: 'Invalid input amount', details: e.message };
        }

        // 6. Compute USD value of inputAmount via jupiterPrice for the $10 min check.
        let inputUsdValue;
        try {
            const priceData = await jupiterPrice([inputToken.address]);
            const priceEntry = priceData && (priceData[inputToken.address] || priceData.data?.[inputToken.address]);
            const usdPrice = priceEntry && (priceEntry.usdPrice ?? priceEntry.price);
            if (!Number.isFinite(Number(usdPrice)) || Number(usdPrice) <= 0) {
                return { error: 'price_unavailable', reason: `Could not fetch USD price for ${inputToken.symbol} — required for $10 minimum check.` };
            }
            inputUsdValue = Number(input.inputAmount) * Number(usdPrice);
        } catch (e) {
            return { error: 'price_lookup_failed', reason: e.message };
        }

        // 7. Resolve V2-specific args. PR #388 R4 hardened the contract:
        // V2 REQUIRES explicit triggerPriceUsd and explicit expiry. No silent
        // fallbacks — they were causing two real failure modes:
        //   (a) Falling back to the V1 `triggerPrice` field silently reused a
        //       ratio value (V1 semantic) as if it were a USD price (V2
        //       semantic). For most pairs the order would fire at the wrong
        //       price; for a stablecoin-to-asset buy where the ratio
        //       coincidentally lands near $X, the user would never notice.
        //   (b) Defaulting expiresAt to "30 days from now" silently locked
        //       funds into a much longer order than the caller intended.
        // Both fail loudly now; consumers MUST migrate to V2 field names.
        if (input.triggerPriceUsd == null) {
            return {
                error: 'trigger_price_usd_required',
                reason: 'V2 requires explicit `triggerPriceUsd` (USD price; e.g. 80.5). The V1 `triggerPrice` field was a token ratio with a different meaning and is not accepted by the V2 path — see PR #388.',
            };
        }
        const triggerPriceUsd = Number(input.triggerPriceUsd);
        const slippageBps = input.slippageBps != null ? Number(input.slippageBps) : triggerV2.DEFAULT_SLIPPAGE_BPS;
        // expiresAt MUST be provided (in seconds OR ms — heuristic still
        // accepts either unit) OR expiryTime (legacy V1 alias, Unix seconds).
        // No silent default — fail loud if neither is set.
        let expiresAtMs;
        if (input.expiresAt != null) {
            const n = Number(input.expiresAt);
            expiresAtMs = n * (n < 10_000_000_000 ? 1000 : 1);
        } else if (input.expiryTime != null) {
            expiresAtMs = Number(input.expiryTime) * 1000; // legacy V1 alias (seconds)
        } else {
            return {
                error: 'expires_at_required',
                reason: 'V2 requires explicit `expiresAt` (Unix seconds OR ms) or legacy `expiryTime` (Unix seconds). No silent default — pass an explicit expiration timestamp. See PR #388.',
            };
        }
        const triggerCondition = _inferTriggerCondition(inputToken.address, outputToken.address, input.triggerCondition);
        if (!triggerCondition) {
            return {
                error: 'trigger_condition_required',
                reason: 'Could not infer triggerCondition from token pair. Pass triggerCondition: "above" or "below" explicitly.',
            };
        }
        // PR #388 R6: resolve triggerMint and fail closed for ambiguous pairs
        // BEFORE any Jupiter side effects (auth / vault register / deposit
        // craft). Pre-fix this check ran after depositCraft, so an ambiguous
        // pair without explicit triggerMint could leave a server-side vault
        // + a wasted /deposit/craft request before returning the error.
        const triggerMint = _inferTriggerMint(inputToken.address, outputToken.address, input.triggerMint);
        if (!triggerMint) {
            return {
                error: 'trigger_mint_required',
                reason: 'For non-stable↔non-stable pairs (e.g. SOL↔JUP) and both-stable pairs (e.g. USDC↔USDT), the trigger asset cannot be inferred safely — Jupiter would watch the wrong asset\'s USD price. Pass `triggerMint` explicitly to disambiguate.',
                inputMint: inputToken.address,
                outputMint: outputToken.address,
            };
        }
        // PR #388 R8: validate the resolved triggerMint as a real Solana
        // base58 address (32-byte Ed25519 pubkey). The auto-inferred path
        // uses inputMint/outputMint which were already validated by upstream
        // token resolution, so this only fires when the caller supplied an
        // EXPLICIT `input.triggerMint` override — pre-fix a whitespace-only
        // or otherwise malformed non-empty string passed the null-check and
        // would only fail later at Jupiter's create endpoint (after auth +
        // vault register + signed deposit). Fail closed here BEFORE any side
        // effects.
        if (!isValidSolanaAddress(triggerMint)) {
            return {
                error: 'trigger_mint_invalid',
                reason: 'Explicit `triggerMint` is not a valid Solana base58 address (must base58-decode to 32 bytes). Pass a real mint pubkey.',
            };
        }

        // 8. Semantic validation (pure — fail fast before any network work).
        const validation = triggerV2.validateOrderArgs({ inputUsdValue, expiresAtMs, triggerPriceUsd, slippageBps });
        if (!validation.ok) {
            return { error: validation.error, reason: validation.reason };
        }

        // 9. Authenticate (cached 24h-60s per pubkey).
        const walletRole = routingHint.routingDecision === 'burner' ? 'burner' : 'main';
        const authSigners = _buildAuthSigners(walletRole);
        const authResult = await triggerV2.authenticate(walletAddress, authSigners);
        if (!authResult.ok) {
            return { error: authResult.error, reason: authResult.reason };
        }
        const token = authResult.token;

        // 10. Ensure vault (lazy — registered via idempotent GET on first use).
        const vaultResult = await triggerV2.ensureVault(walletAddress, token);
        if (!vaultResult.ok) {
            return { error: vaultResult.error, reason: vaultResult.reason };
        }
        const vaultAddress = vaultResult.vaultPubkey;
        // BAT-1013: tighten vaultPubkey validation at the call site.
        // trigger-v2.ensureVault checks only that the field is truthy (a
        // string like 'undefined' or 'true' from a malformed Jupiter
        // response would pass). Validate as a real base58 Solana pubkey.
        // After BAT-1031 the policy no longer binds to vaultAddress, but
        // the value still flows back to the caller (and into logs as
        // diagnostic context), so a malformed pubkey here is still a
        // fail-closed condition — the V2 deposit flow depends on
        // vaultPubkey being correct, and there is no equivalent main-MWA
        // recovery (vault is Privy-custodial), so fail closed with a clear
        // error and let the agent surface it to the user.
        if (!isValidSolanaAddress(vaultAddress)) {
            log(`[Jupiter Trigger V2] ensureVault returned non-base58 vaultPubkey: ${JSON.stringify(vaultAddress)} — failing closed`, 'WARN');
            return {
                error: 'vault_unavailable',
                reason: `Jupiter /vault response vaultPubkey is not a valid Solana base58 address: ${JSON.stringify(vaultAddress)}`,
            };
        }

        // 11. Craft deposit (outputMint is required by /deposit/craft).
        const craftResult = await triggerV2.depositCraft({
            pubkey: walletAddress,
            token,
            inputMint: inputToken.address,
            outputMint: outputToken.address,
            inputAmount: String(inputAmountAtomic),
        });
        if (!craftResult.ok) {
            return { error: craftResult.error, reason: craftResult.reason };
        }
        const {
            transaction: unsignedDepositTx,
            depositRequestId,
            recoveryContext,
        } = craftResult;

        // BAT-1031 (Option A): no producer-side destination cross-check.
        // The previous binding (receiverAddress === vaultAddress and
        // depositVault.expectedTokenOwner === receiverAddress) was
        // structurally broken on the prod burner — Jupiter routes to an
        // Anchor PDA whose SPL decode produces a garbage mint and rejected
        // every deposit. burner-policy now relies on burnerDebit exact-
        // delta + sol_fee_headroom for the burner-side safety bound;
        // destination shape is Jupiter's responsibility. See Linear
        // BAT-1031 v1.1 + v1.2 + Appendix A.

        // 12. Verify deposit tx fee payer matches active wallet — guard against
        // a malicious craft response that would route funds from the wrong wallet.
        try {
            const verification = verifySwapTransaction(unsignedDepositTx, walletAddress);
            if (!verification.valid) {
                return { error: `Deposit tx rejected: ${verification.error}` };
            }
        } catch (verifyErr) {
            return { error: `Could not verify deposit tx: ${verifyErr.message}` };
        }

        // 13. routeAndSign for the deposit signing + orders/price POST.
        // triggerMint was resolved + validated in step 7 (above) BEFORE any
        // Jupiter side effects. See PR #388 R2 (sell-into-stable bug) and
        // R5/R6 (ambiguous-pair fail-closed + early-fail ordering).
        const orderArgs = {
            inputMint: inputToken.address,
            inputAmount: String(inputAmountAtomic),
            outputMint: outputToken.address,
            triggerMint,
            triggerPriceUsd,
            triggerCondition,
            slippageBps,
            expiresAtMs,
        };
        let submitWarning = null;
        // PR #388 R2: if our local burner-fallback fired above (we couldn't
        // reach burner pubkey so flipped routingHint to 'main'), pass that
        // override into routeAndSign so it does NOT re-route to burner and
        // try to sign with a burner the deposit tx isn't paying from.
        // BAT-1013 Phase 3b: build expectedDelta for the burner-policy gate.
        // Trigger V2 deposits move `inputAmountAtomic` of `inputToken` from
        // the burner's input ATA into the Jupiter Limit Order V2 vault. There's
        // NO credit at deposit time (output happens at fill time in a separate
        // tx the burner doesn't sign — see DELTA_KINDS doc).
        let expectedDelta = null;
        try {
            const burnerPubkey = walletAddress;
            const inputIsSol = inputToken.address === 'So11111111111111111111111111111111111111112';
            const ataMod = require('../wallet/ata');
            const debitAccount = inputIsSol ? burnerPubkey : ataMod.deriveAtaBase58(burnerPubkey, inputToken.address);
            expectedDelta = {
                kind: 'jupiter_trigger_create_deposit',
                signerMode: 'burner_only',
                burnerDebit: {
                    account: debitAccount,
                    mint: inputIsSol ? 'native_sol' : inputToken.address,
                    atomicAmount: String(inputAmountAtomic),
                },
                // BAT-1031 + BAT-1027: burnerOwnedAccounts declares only
                // the EXPLICIT input debit ATA. Other burner-owned ATAs the
                // deposit flow may touch — the freshly-created output WSOL
                // ATA (when input is SPL), wrap/unwrap intermediaries — are
                // NOT enumerated here.
                //
                // What is and isn't caught today:
                //   • Drainer walker (burner-policy validateDrainerOpcodes)
                //     still blocks SetAuthority / Approve / CloseAccount /
                //     Burn / Assign / AdvanceNonce on any account
                //     resolvable as burner-owned, AND blocks plain Transfer
                //     in `zero_value_*` kinds.
                //   • For `jupiter_trigger_create_deposit` (a non-zero-value
                //     deposit), a plain SPL Transfer out of an UNDECLARED
                //     burner-owned ATA is NOT currently rejected.
                //     Generalized undeclared-ATA per-account delta
                //     enforcement lands in BAT-1027.
                //   • The same-tx-create-init-with-zero-balance pattern
                //     (Jupiter creating the burner's WSOL output ATA at
                //     deposit time, paying rent from the burner inside the
                //     existing sol_fee_headroom) is documented in the
                //     BAT-1031 v1.2 Gate 0 carve-out rubric and exercised
                //     by tests/nodejs-project/burner-policy-carveout.test.js.
                burnerOwnedAccounts: [debitAccount].filter(a => a !== burnerPubkey),
            };
        } catch (eDelta) {
            // Copilot PR #398 R2 finding: a falsy expectedDelta is NOT
            // forwarded to BurnerSigner by dispatch.js, which would let
            // the burner sign without the policy gate running. Force
            // routing to main so the user sees an MWA popup instead.
            log(`[Jupiter Trigger V2] Could not build expectedDelta — forcing main wallet routing: ${eDelta.message}`, 'WARN');
            routingHint.routingDecision = 'main';
            expectedDelta = null;
        }

        const dispatchResult = await routeAndSign({
            toolName: 'jupiter_trigger_create',
            toolArgs: input,
            unsignedTxBase64: unsignedDepositTx,
            broadcastVia: 'jupiter',
            flowName: 'jupiter_trigger_create_v2',
            forceRouting: routingHint,
            expectedDelta,
            broadcast: async (txOrUnsigned, _signer, ctx) => {
                let signedDeposit;
                if (ctx && ctx.signed) {
                    signedDeposit = txOrUnsigned;
                } else {
                    try { await ensureWalletAuthorized(); }
                    catch (e) { return { error: 'wallet_not_authorized', reason: e.message }; }
                    const signRes = await androidBridgeCall('/solana/sign-only', { transaction: txOrUnsigned }, 120000);
                    if (signRes.error) return { error: 'sign_failed', reason: signRes.error };
                    if (!signRes.signedTransaction) return { error: 'sign_failed', reason: 'no signed tx returned from wallet' };
                    signedDeposit = signRes.signedTransaction;
                }
                const submitRes = await triggerV2.submitCreateOrder({
                    token,
                    recoveryContext,
                    depositSignedTx: signedDeposit,
                    order: orderArgs,
                });
                if (submitRes.ok) {
                    if (submitRes.recovered) {
                        submitWarning = submitRes.recoveryNote || 'Order recovered from /orders/history after lost create response.';
                    }
                    return { signature: submitRes.txSignature, trigger: submitRes };
                }
                // Ambiguous-no-recovery: deposit MAY have moved funds. Conservative —
                // treat as broadcast success so the burner cap is committed
                // (over-count is safer than under-count). Surface a clear warning
                // including the depositRequestId so the user can reconcile via
                // Jupiter UI.
                if (submitRes.error === 'create_ambiguous_no_recovery') {
                    submitWarning =
                        `Trigger V2 create response was lost AND /orders/history showed no matching order. ` +
                        `Deposit may still be in flight in Jupiter's vault. Check Jupiter UI for ` +
                        `depositRequestId=${depositRequestId}. ` +
                        `Your wallet's burner cap has been committed conservatively — if the deposit ` +
                        `did NOT land on-chain, the cap will regenerate at the next daily window.`;
                    return { signature: null, trigger: submitRes };
                }
                return { error: submitRes.error, reason: submitRes.reason };
            },
        });

        if (!dispatchResult.ok) {
            return { error: dispatchResult.error, reason: dispatchResult.reason };
        }

        const orderResult = (dispatchResult.broadcastResult && dispatchResult.broadcastResult.trigger) || {};
        const orderId = orderResult.id || null;

        // 14. Record ownership (fire-and-forget; failure logs only, doesn't unwind).
        if (orderId) {
            await recordJupiterOwnership(orderId, dispatchResult.wallet, 'jupiter_trigger_create_v2');
        } else {
            log('[Jupiter Trigger V2] No orderId from create — ownership not recorded', 'WARN');
        }

        const warnings = [];
        if (inputToken.warning) warnings.push(`⚠️ ${inputToken.symbol}: ${inputToken.warning}`);
        if (outputToken.warning) warnings.push(`⚠️ ${outputToken.symbol}: ${outputToken.warning}`);
        if (submitWarning) warnings.push(submitWarning);

        // PR #388 R2: V1 alias for `signature` (V1 returned `signature`, V2
        // canonical is `txSignature`). PR #388 R3: also surface V1's
        // `triggerPrice` and `expiryTime` field names so consumers that
        // parse the V1 shape don't see undefined when the flag flips.
        //
        // SEMANTIC NOTE on `triggerPrice`: V1's `triggerPrice` was a token
        // ratio (e.g. 90 meaning "1 SOL = 90 USDC"). V2's `triggerPriceUsd`
        // is a USD price. We alias `triggerPrice` to the USD value (not the
        // ratio) because that's what the underlying order actually uses now —
        // a consumer that interprets it as a ratio is already broken
        // semantically by the V1→V2 cutover; preserving the field name at
        // least keeps the field present so the consumer's parse doesn't blow
        // up. Consumers SHOULD migrate to `triggerPriceUsd`.
        const _sig = orderResult.txSignature || dispatchResult.signature || null;
        const _expiresAtSec = Math.floor(expiresAtMs / 1000);
        return {
            success: true,
            orderId,
            txSignature: _sig,
            signature: _sig,
            depositRequestId,
            inputToken: `${inputToken.symbol} (${inputToken.address})`,
            outputToken: `${outputToken.symbol} (${outputToken.address})`,
            inputAmount: input.inputAmount,
            triggerPriceUsd,
            triggerPrice: triggerPriceUsd, // V1 alias (semantic shifted ratio→USD; see comment above)
            triggerCondition,
            slippageBps,
            expiresAt: _expiresAtSec,
            expiryTime: _expiresAtSec, // V1 alias (both Unix seconds)
            wallet: dispatchResult.wallet,
            vaultAddress,
            recovered: orderResult.recovered === true || undefined,
            warnings: warnings.length > 0 ? warnings : undefined,
        };
    } catch (e) {
        return { error: e.message };
    }
}

async function _jupiterTriggerListV2(input, _chatId) {
    if (!config.jupiterApiKey) {
        return {
            error: 'Jupiter API key required',
            guide: 'Get a free API key at portal.jup.ag, then add it in SeekerClaw Settings > Configuration > Jupiter API Key',
        };
    }
    try {
        let walletAddress;
        try { walletAddress = getConnectedWalletAddress(); }
        catch (e) { return { error: e.message }; }

        if (input.status && !['active', 'history'].includes(input.status)) {
            return { error: 'Invalid status value', details: 'status must be either "active" or "history"' };
        }
        if (input.page != null && (!Number.isInteger(Number(input.page)) || Number(input.page) <= 0)) {
            return { error: 'Invalid page value', details: 'page must be a positive integer' };
        }

        // Scope cut for PR B: V2 list authenticates the MAIN wallet only.
        // Listing burner-routed orders requires authenticating the burner
        // pubkey separately — deferred to a follow-up BAT to avoid surfacing
        // a "sign to view your orders" prompt for users with no burner orders.
        const authSigners = _buildAuthSigners('main');
        const authResult = await triggerV2.authenticate(walletAddress, authSigners);
        if (!authResult.ok) return { error: authResult.error, reason: authResult.reason };

        const listResult = await triggerV2.listOrders({
            pubkey: walletAddress,
            token: authResult.token,
            status: input.status,
            page: input.page != null ? Number(input.page) : undefined,
        });
        if (!listResult.ok) return { error: listResult.error, reason: listResult.reason };

        return {
            success: true,
            count: listResult.orders.length,
            wallet: walletAddress,
            note: 'V2 list shows main-wallet orders only. Burner-routed orders need separate auth (follow-up).',
            // Field names verified live 2026-05-30: real rows use orderState,
            // rawState, initialInputAmount, remainingInputAmount, fillPercent.
            // The first-draft status/vaultState/inputAmount fields don't exist
            // on the API — mapping them would return three `undefined`s per row.
            // PR #388 R2 added inputToken/outputToken aliases. R3: also add
            // V1's `inputAmount`, `triggerPrice`, `status`, `expiryTime`
            // aliases so consumers that parse the V1 list shape don't see
            // undefined when the flag flips. SEMANTIC NOTES:
            //   - `inputAmount` ← initialInputAmount (same atomic-string semantic).
            //   - `triggerPrice` ← triggerPriceUsd (V1 was a token ratio,
            //     V2 is USD — see same comment on the create response above;
            //     consumers SHOULD migrate to `triggerPriceUsd`).
            //   - `status` ← orderState (same lowercase state vocabulary:
            //     active/cancelled/expired/etc).
            //   - `expiryTime` ← expiresAt converted ms→sec (V1 unit was
            //     Unix seconds; V2 `expiresAt` is milliseconds).
            orders: listResult.orders.map(order => ({
                orderId: order.id || order.orderId,
                orderType: order.orderType,
                inputMint: order.inputMint,
                outputMint: order.outputMint,
                inputToken: order.inputMint,
                outputToken: order.outputMint,
                initialInputAmount: order.initialInputAmount,
                remainingInputAmount: order.remainingInputAmount,
                inputAmount: order.initialInputAmount, // V1 alias
                triggerPriceUsd: order.triggerPriceUsd,
                triggerPrice: order.triggerPriceUsd, // V1 alias (semantic shifted ratio→USD)
                triggerCondition: order.triggerCondition,
                slippageBps: order.slippageBps,
                orderState: order.orderState,
                rawState: order.rawState,
                status: order.orderState, // V1 alias
                fillPercent: order.fillPercent,
                expiresAt: order.expiresAt,
                expiryTime: (typeof order.expiresAt === 'number' && order.expiresAt > 1e12)
                    ? Math.floor(order.expiresAt / 1000)
                    : order.expiresAt, // V1 alias in Unix SECONDS (V2 expiresAt is ms)
                createdAt: order.createdAt,
            })),
        };
    } catch (e) {
        return { error: e.message };
    }
}

async function _jupiterTriggerCancelV2(input, _chatId) {
    if (!config.jupiterApiKey) {
        return {
            error: 'Jupiter API key required',
            guide: 'Get a free API key at portal.jup.ag, then add it in SeekerClaw Settings > Configuration > Jupiter API Key',
        };
    }
    try {
        if (!input.orderId || String(input.orderId).trim() === '') {
            return { error: 'orderId is required' };
        }
        const orderId = String(input.orderId).trim();

        // 1. Ownership lookup (same as V1).
        let creatorRole = 'unknown';
        try {
            const lookup = await androidBridgeCall(
                '/jupiter/order-owner/get',
                { orderId },
                5000,
            );
            if (lookup && !lookup.error && (lookup.creatorWalletRole === 'burner' || lookup.creatorWalletRole === 'main')) {
                creatorRole = lookup.creatorWalletRole;
            }
        } catch (_) { /* fall through to MWA path */ }

        // 2. Resolve wallet address per creator role.
        let walletAddress;
        if (creatorRole === 'burner') {
            try {
                const burnerStatus = await androidBridgeCall('/burner/status', {}, 5000);
                if (burnerStatus && !burnerStatus.error && burnerStatus.configured && burnerStatus.pubkey) {
                    walletAddress = burnerStatus.pubkey;
                }
            } catch (_) { /* fall through */ }
            if (!walletAddress) {
                log('[Jupiter Trigger V2] burner-owned cancel but burner pubkey unavailable — falling back to MWA', 'WARN');
                creatorRole = 'main';
            }
        }
        if (!walletAddress) {
            try { walletAddress = getConnectedWalletAddress(); }
            catch (e) { return { error: e.message }; }
        }

        // 3. Authenticate the relevant wallet (cached per-pubkey).
        const walletRole = creatorRole === 'burner' ? 'burner' : 'main';
        const authSigners = _buildAuthSigners(walletRole);
        const authResult = await triggerV2.authenticate(walletAddress, authSigners);
        if (!authResult.ok) return { error: authResult.error, reason: authResult.reason };
        const token = authResult.token;

        // 4. Cancel step 1 — get unsigned cancel tx.
        const step1 = await triggerV2.cancelStep1({ orderId, pubkey: walletAddress, token });
        if (!step1.ok) return { error: step1.error, reason: step1.reason };

        // 5. Verify cancel tx fee payer.
        try {
            const verification = verifySwapTransaction(step1.transaction, walletAddress);
            if (!verification.valid) return { error: `Cancel tx rejected: ${verification.error}` };
        } catch (e) {
            return { error: `Could not verify cancel tx: ${e.message}` };
        }

        // 6. Sign + confirm-cancel — routed to burner or main path.
        let signedCancelB64;
        let signWallet;
        if (creatorRole === 'burner') {
            // Use signZeroCapTxViaBurner (cancel doesn't consume cap principal,
            // and signCancelViaBurner is broadcast-coupled). We POST confirm-cancel
            // separately below — so this is sign-only, then explicit POST.
            const signRes = await signZeroCapTxViaBurner({
                unsignedTxBase64: step1.transaction,
                flowName: 'jupiter_trigger_cancel_v2',
            });
            if (!signRes.ok) return { error: signRes.error, reason: signRes.reason };
            signedCancelB64 = signRes.signedTxBase64;
            signWallet = 'burner';
        } else {
            try { await ensureWalletAuthorized(); }
            catch (e) { return { error: 'wallet_not_authorized', reason: e.message }; }
            const signRes = await androidBridgeCall('/solana/sign-only', { transaction: step1.transaction }, 120000);
            if (signRes.error) return { error: signRes.error, reason: signRes.reason };
            if (!signRes.signedTransaction) return { error: 'sign_failed', reason: 'No signed transaction returned from wallet' };
            signedCancelB64 = signRes.signedTransaction;
            signWallet = 'main';
        }

        // 7. Confirm cancel.
        const confirmRes = await triggerV2.confirmCancel({
            orderId,
            pubkey: walletAddress,
            token,
            signedTransaction: signedCancelB64,
            cancelRequestId: step1.cancelRequestId,
        });
        if (!confirmRes.ok) return { error: confirmRes.error, reason: confirmRes.reason };

        return {
            success: true,
            orderId: confirmRes.id,
            txSignature: confirmRes.txSignature,
            // PR #388 R2: V1's `signature` alias kept so downstream parsers
            // don't break when the flag flips.
            signature: confirmRes.txSignature,
            status: 'cancelled',
            wallet: signWallet,
            creatorRole,
        };
    } catch (e) {
        return { error: e.message };
    }
}

// ============================================================================

const handlers = {
    async solana_address(input, chatId) {
        const walletConfigPath = path.join(workDir, 'solana_wallet.json');
        if (fs.existsSync(walletConfigPath)) {
            try {
                const walletConfig = JSON.parse(fs.readFileSync(walletConfigPath, 'utf8'));
                return { address: walletConfig.publicKey, label: walletConfig.label || '' };
            } catch (e) {
                return { error: 'Failed to read wallet config' };
            }
        }
        return { error: 'No wallet connected. Connect a wallet in the SeekerClaw app Settings.' };
    },

    async solana_balance(input, chatId) {
        let address = input.address;
        if (!address) {
            try {
                address = getConnectedWalletAddress();
            } catch (e) {
                return { error: e.message };
            }
        }

        const balanceResult = await solanaRpc('getBalance', [address]);
        if (balanceResult.error) return { error: balanceResult.error };

        const solBalance = (balanceResult.value || 0) / 1e9;

        const tokenResult = await solanaRpc('getTokenAccountsByOwner', [
            address,
            { programId: 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA' },
            { encoding: 'jsonParsed' }
        ]);

        const tokens = [];
        if (tokenResult.value) {
            for (const account of tokenResult.value) {
                try {
                    const info = account.account.data.parsed.info;
                    if (parseFloat(info.tokenAmount.uiAmountString) > 0) {
                        tokens.push({
                            mint: info.mint,
                            amount: info.tokenAmount.uiAmountString,
                            decimals: info.tokenAmount.decimals,
                        });
                    }
                } catch (e) { log(`[Tools] Failed to parse token account: ${e.message}`, 'DEBUG'); }
            }
        }

        return { address, sol: solBalance, tokens, tokenCount: tokens.length };
    },

    async solana_history(input, chatId) {
        let address = input.address;
        if (!address) {
            try {
                address = getConnectedWalletAddress();
            } catch (e) {
                return { error: e.message };
            }
        }

        const limit = Math.min(input.limit || 10, 50);
        const signatures = await solanaRpc('getSignaturesForAddress', [address, { limit }]);
        if (signatures.error) return { error: signatures.error };

        return {
            address,
            transactions: (signatures || []).map(sig => ({
                signature: sig.signature,
                slot: sig.slot,
                blockTime: sig.blockTime ? new Date(sig.blockTime * 1000).toISOString() : null,
                status: sig.err ? 'Failed' : 'Success',
                memo: sig.memo || null,
            })),
            count: (signatures || []).length,
        };
    },

    async solana_send(input, chatId) {
        // BAT-1037: solana_send is native-SOL-only. Reject SPL / fiat
        // denomination hints (field-only log — never the supplied value)
        // before any routing or tx build, so a wrong-asset request fails fast
        // with actionable guidance and zero downstream side effects.
        const denomReject = classifySolSendDenomination(input);
        if (denomReject) {
            log(`[solana_send] REJECT field=${denomReject.field} error=${denomReject.error}`, 'WARN');
            return { error: denomReject.error, reason: denomReject.reason };
        }
        // BAT-582 Phase 5: route through wallet dispatch so a configured
        // burner wallet can sign autonomously when under cap, and the
        // main MWA flow stays the fallback for over-cap or uncapped assets.
        // Behavior when burner is unconfigured matches v1.0 exactly: MWA
        // popup via /solana/sign.
        //
        // BAT-1013 foundation patch: added `source` param so the agent can
        // explicitly route to main (user said "from main") or burner. When
        // omitted, behavior is exactly the previous cap-based routing.
        let from;
        try {
            from = getConnectedWalletAddress();
        } catch (e) {
            from = null;
        }
        const to = input.to;
        const amount = input.amount;
        const sourcePref = (input.source === 'main' || input.source === 'burner') ? input.source : 'auto';

        if (!to || !amount || amount <= 0) {
            return { error: 'Both "to" address and a positive "amount" are required.' };
        }

        // BAT-1013 pre-flight: when the user explicitly said "from main"
        // (source='main') but main wallet isn't connected, fail fast with
        // a clear actionable message. Without this, the handler would fall
        // through to the burner path and surface AccountLoadedTwice on a
        // burner→burner self-send.
        if (sourcePref === 'main' && from === null) {
            return {
                error: 'main_wallet_not_connected',
                reason: 'Main wallet is not connected. Tap the Wallet button in the SeekerClaw app to authorize MWA, then retry.',
            };
        }

        // BAT-1013 pre-flight: when no source preference is given AND main
        // isn't connected, check if a burner is available — if neither is
        // available, return the clear error instead of letting the handler
        // tunnel into a broken tx build.
        if (sourcePref === 'auto' && from === null) {
            let burnerAvailable = false;
            try {
                const bs = await androidBridgeCall('/burner/status', {}, 3000);
                burnerAvailable = !!(bs && !bs.error && bs.configured && bs.pubkey);
            } catch (_) { /* treat as unavailable */ }
            if (!burnerAvailable) {
                return {
                    error: 'main_wallet_not_connected',
                    reason: 'Main wallet is not connected and no burner is configured. Tap the Wallet button to authorize MWA, or set up a burner in Settings > Burner Wallet.',
                };
            }
        }

        // Step 1: Get latest blockhash (shared by both wallets — RPC call,
        // no signer required).
        const blockhashResult = await solanaRpc('getLatestBlockhash', [{ commitment: 'finalized' }]);
        if (blockhashResult.error) return { error: 'Failed to get blockhash: ' + blockhashResult.error };
        const recentBlockhash = blockhashResult.blockhash || (blockhashResult.value && blockhashResult.value.blockhash);
        if (!recentBlockhash) return { error: 'No blockhash returned from RPC' };

        // Step 2: Determine the source address. BAT-1013: respect explicit
        // `source` preference; otherwise fall back to cap-based routing.
        // Burner pubkey if routing says burner; otherwise the connected MWA wallet.
        // We need the source BEFORE building the tx because Solana
        // transactions encode the fee payer in the message.
        const { routeFor } = require('../caps/preflight');
        let routingHint;
        if (sourcePref === 'main') {
            // User explicitly said "from main" — force MWA routing regardless
            // of caps. forceRouting is the same plumbing PR #398 R13 fixed
            // for the Ultra-swap path; routeAndSign will skip routeFor() and
            // use this decision directly.
            routingHint = { routingDecision: 'main', underCap: true };
        } else if (sourcePref === 'burner') {
            // Explicit burner — still subject to cap math (over-cap → reject).
            routingHint = await routeFor('solana_send', input);
            if (routingHint.routingDecision !== 'burner') {
                return {
                    error: 'over_burner_cap',
                    reason: 'source="burner" requested but amount exceeds burner per-tx or daily cap. Either lower the amount or use source="main".',
                };
            }
        } else {
            // 'auto' (default): existing behavior — cap-based routing.
            routingHint = await routeFor('solana_send', input);
        }

        let sourceAddress = from;
        if (routingHint.routingDecision === 'burner') {
            // Pull the burner pubkey from /burner/status. If burner is
            // configured but somehow has no pubkey, fall back to main.
            try {
                const burnerStatus = await androidBridgeCall('/burner/status', {}, 5000);
                if (burnerStatus && !burnerStatus.error && burnerStatus.configured && burnerStatus.pubkey) {
                    sourceAddress = burnerStatus.pubkey;
                }
            } catch (_) { /* fall back to main */ }
        }
        if (!sourceAddress) {
            return { error: 'No source wallet available — connect a wallet (Settings > Solana Wallet) or configure a burner (Settings > Burner Wallet).' };
        }

        // BAT-1013 self-send guard: reject burner→burner (or main→main)
        // transfers BEFORE building the tx. Without this the simulator returns
        // AccountLoadedTwice — a cryptic error the user can't act on. This
        // handler-level check complements the defense-in-depth shape check
        // in burner-policy.validateExpectedDeltaShape so the main-wallet
        // path also gets the friendly error (the policy gate runs only on
        // burner signs).
        if (sourceAddress === to) {
            return {
                error: 'self_send_rejected',
                reason: `Cannot send to the same address that pays the transaction (${sourceAddress.slice(0, 4)}…${sourceAddress.slice(-4)}). Pick a different recipient, or use source="main" to send from your main wallet to the burner.`,
            };
        }

        // Step 3: Build unsigned transaction.
        // BAT-255: BigInt-safe parsing avoids floating-point precision loss.
        const lamports = parseInputAmountToLamports(numberToDecimalString(amount), 9); // SOL has 9 decimals
        let unsignedTx;
        try {
            unsignedTx = buildSolTransferTx(sourceAddress, to, lamports, recentBlockhash);
        } catch (e) {
            return { error: 'Failed to build transaction: ' + e.message };
        }
        const txBase64 = unsignedTx.toString('base64');

        // Step 4: Route + sign + broadcast via the wallet dispatch helper.
        // Broadcast callback differs by signer — main signs+broadcasts
        // atomically via /solana/sign (existing MWA behavior); burner
        // signs only, then we broadcast the signed bytes via RPC
        // sendTransaction.
        // BAT-1013 Phase 3b: solana_send for native SOL only (this code path
        // is the SOL transfer branch — SPL goes through a different handler).
        const sendExpectedDelta = {
            kind: 'solana_send',
            signerMode: 'burner_only',
            burnerDebit: {
                account: sourceAddress,
                mint: 'native_sol',
                atomicAmount: String(lamports),
            },
            recipient: {
                account: to,
                mint: 'native_sol',
            },
            burnerOwnedAccounts: [],
        };

        const result = await routeAndSign({
            toolName: 'solana_send',
            toolArgs: input,
            unsignedTxBase64: txBase64,
            broadcastVia: 'rpc',
            flowName: 'solana_send',
            // BAT-1013: thread routingHint via forceRouting so dispatch.js
            // honors the explicit source preference (especially source='main')
            // instead of re-calling routeFor(toolArgs) which would ignore the
            // 'source' field. Same plumbing as PR #398 R13 fixed for solana_swap.
            forceRouting: routingHint,
            expectedDelta: sendExpectedDelta,
            broadcast: async (txBase64, _signer, ctx) => {
                // ctx.signed === false for main path (unsigned tx → sign+broadcast via MWA)
                // ctx.signed === true  for burner path (signed bytes → RPC sendTransaction)
                if (!ctx || !ctx.signed) {
                    // Main path: existing /solana/sign sign-and-broadcast flow.
                    await ensureWalletAuthorized();
                    const r = await androidBridgeCall(
                        '/solana/sign',
                        { transaction: txBase64 },
                        120000,
                    );
                    if (!r || r.error) return { error: r && r.error ? r.error : 'sign_failed' };
                    if (!r.signature) return { error: 'No signature returned from wallet' };
                    const sigBytes = Buffer.from(r.signature, 'base64');
                    return { signature: base58Encode(sigBytes) };
                }
                // Burner path: signer already signed; broadcast via RPC.
                const sendResult = await solanaRpc('sendTransaction', [
                    txBase64,
                    { encoding: 'base64', skipPreflight: false, preflightCommitment: 'confirmed' },
                ]);
                if (sendResult && sendResult.error) {
                    return { error: 'rpc_send_failed', reason: typeof sendResult.error === 'string' ? sendResult.error : JSON.stringify(sendResult.error) };
                }
                // sendTransaction returns a base58 signature string directly.
                if (typeof sendResult === 'string') return { signature: sendResult };
                if (sendResult && sendResult.value) return { signature: sendResult.value };
                return { error: 'rpc_send_failed', reason: 'no signature in RPC response' };
            },
        });

        if (!result.ok) {
            return { error: result.error, reason: result.reason };
        }
        return { signature: result.signature, success: true, wallet: result.wallet };
    },

    async solana_price(input, chatId) {
        try {
            const tokens = input.tokens || [];
            if (tokens.length === 0) return { error: 'Provide at least one token symbol or mint address.' };
            if (tokens.length > 10) return { error: 'Maximum 10 tokens per request.' };

            // Resolve all symbols to mint addresses
            const resolved = [];
            for (const t of tokens) {
                const token = await resolveToken(t);
                if (!token) {
                    resolved.push({ input: t, error: `Unknown token: "${t}"` });
                } else if (token.ambiguous) {
                    resolved.push({ input: t, ambiguous: token });
                } else {
                    resolved.push({ input: t, token });
                }
            }

            // If any are ambiguous, return candidates so agent can ask user
            const ambiguous = resolved.filter(r => r.ambiguous);
            if (ambiguous.length > 0) {
                return {
                    ambiguous: true,
                    message: 'Multiple tokens found with the same symbol. Ask the user which one they mean, or have them provide the contract address (mint).',
                    tokens: ambiguous.map(a => ({
                        symbol: a.ambiguous.symbol,
                        candidates: a.ambiguous.candidates.map(c => ({
                            name: c.name,
                            mint: c.address,
                        })),
                    })),
                };
            }

            const validMints = resolved.filter(r => r.token).map(r => r.token.address);
            if (validMints.length === 0) {
                return { error: 'Could not resolve any tokens.', details: resolved.filter(r => r.error) };
            }

            const priceData = await jupiterPrice(validMints);
            const prices = [];

            for (const r of resolved) {
                if (r.error) {
                    prices.push({ token: r.input, error: r.error });
                    continue;
                }
                // Price v3 returns flat {mint: {usdPrice, ...}} — no 'data' wrapper
                const pd = priceData[r.token.address];
                const entry = {
                    token: r.token.symbol,
                    mint: r.token.address,
                    price: pd?.usdPrice != null ? parseFloat(pd.usdPrice) : null,
                    currency: 'USD',
                };
                // Surface confidenceLevel from Jupiter Price v3 — low confidence means unreliable pricing
                if (pd?.confidenceLevel) {
                    entry.confidenceLevel = pd.confidenceLevel;
                    if (pd.confidenceLevel === 'low') {
                        entry.warning = 'Low price confidence — pricing data may be unreliable. Do not use for safety-sensitive decisions.';
                    }
                }
                prices.push(entry);
            }

            return { prices };
        } catch (e) {
            return { error: e.message };
        }
    },

    async solana_quote(input, chatId) {
        try {
            const inputToken = await resolveToken(input.inputToken);
            if (!inputToken) return { error: `Unknown input token: "${input.inputToken}". Try a symbol like SOL, USDC, BONK or a mint address.` };
            if (inputToken.ambiguous) return { ambiguous: true, message: `Multiple tokens found for "${input.inputToken}". Ask user which one or use the contract address.`, candidates: inputToken.candidates.map(c => ({ name: c.name, symbol: c.symbol, mint: c.address })) };

            const outputToken = await resolveToken(input.outputToken);
            if (!outputToken) return { error: `Unknown output token: "${input.outputToken}". Try a symbol like SOL, USDC, BONK or a mint address.` };
            if (outputToken.ambiguous) return { ambiguous: true, message: `Multiple tokens found for "${input.outputToken}". Ask user which one or use the contract address.`, candidates: outputToken.candidates.map(c => ({ name: c.name, symbol: c.symbol, mint: c.address })) };

            if (!input.amount || input.amount <= 0) return { error: 'Amount must be positive.' };

            if (inputToken.decimals === null) return { error: `Cannot determine decimals for input token ${input.inputToken}. Use a known symbol or verified mint.` };

            // Convert human amount to raw (smallest unit) — BigInt-safe path avoids floating-point rounding
            const amountRaw = parseInputAmountToLamports(numberToDecimalString(input.amount), inputToken.decimals);
            const slippageBps = input.slippageBps || 100;

            const quote = await jupiterQuote(inputToken.address, outputToken.address, amountRaw, slippageBps);

            // Convert output amounts back to human units
            const outDecimals = outputToken.decimals || 6;
            const outAmount = parseInt(quote.outAmount) / Math.pow(10, outDecimals);
            const minOutAmount = parseInt(quote.otherAmountThreshold) / Math.pow(10, outDecimals);

            const warnings = [];
            if (inputToken.warning) warnings.push(`\u26A0\uFE0F Input token: ${inputToken.warning}`);
            if (outputToken.warning) warnings.push(`\u26A0\uFE0F Output token: ${outputToken.warning}`);
            const priceImpact = quote.priceImpactPct ? parseFloat(quote.priceImpactPct) : 0;
            if (priceImpact > 5) warnings.push(`\u26A0\uFE0F High price impact (${priceImpact.toFixed(2)}%). This trade will move the market significantly. Warn the user.`);
            if (priceImpact > 1) warnings.push(`Price impact is ${priceImpact.toFixed(2)}% — consider using a smaller amount.`);

            const result = {
                inputToken: inputToken.symbol,
                outputToken: outputToken.symbol,
                inputAmount: input.amount,
                outputAmount: outAmount,
                minimumReceived: minOutAmount,
                priceImpactPct: priceImpact,
                slippageBps,
                route: (quote.routePlan || []).map(r => ({
                    dex: r.swapInfo?.label || 'Unknown',
                    inputMint: r.swapInfo?.inputMint,
                    outputMint: r.swapInfo?.outputMint,
                    percent: r.percent,
                })),
                effectivePrice: outAmount / input.amount,
            };
            if (warnings.length > 0) result.warnings = warnings;
            return result;
        } catch (e) {
            return { error: e.message };
        }
    },

    async solana_swap(input, chatId) {
        // BAT-582 Phase 5: route swaps through wallet dispatch. Burner
        // pubkey is the swap taker when routing=burner; main wallet's
        // pubkey is the taker for the v1.0 path. Jupiter Ultra signs the
        // tx for execution against the taker — sourcing the right pubkey
        // is the only routing-aware step before sign + execute.
        const { routeFor } = require('../caps/preflight');
        const routingHint = await routeFor('solana_swap', input);

        let userPublicKey;
        try {
            userPublicKey = getConnectedWalletAddress();
        } catch (_) {
            userPublicKey = null;
        }
        if (routingHint.routingDecision === 'burner') {
            try {
                const burnerStatus = await androidBridgeCall('/burner/status', {}, 5000);
                if (burnerStatus && !burnerStatus.error && burnerStatus.configured && burnerStatus.pubkey) {
                    userPublicKey = burnerStatus.pubkey;
                }
            } catch (_) { /* fall back to main */ }
        }
        if (!userPublicKey) {
            return { error: 'No source wallet available — connect a wallet or configure a burner.' };
        }

        try {
            const inputToken = await resolveToken(input.inputToken);
            if (!inputToken) return { error: `Unknown input token: "${input.inputToken}". Try a symbol like SOL, USDC, BONK or a mint address.` };
            if (inputToken.ambiguous) return { ambiguous: true, message: `Multiple tokens found for "${input.inputToken}". Ask user which one or use the contract address.`, candidates: inputToken.candidates.map(c => ({ name: c.name, symbol: c.symbol, mint: c.address })) };

            const outputToken = await resolveToken(input.outputToken);
            if (!outputToken) return { error: `Unknown output token: "${input.outputToken}". Try a symbol like SOL, USDC, BONK or a mint address.` };
            if (outputToken.ambiguous) return { ambiguous: true, message: `Multiple tokens found for "${input.outputToken}". Ask user which one or use the contract address.`, candidates: outputToken.candidates.map(c => ({ name: c.name, symbol: c.symbol, mint: c.address })) };

            if (!input.amount || input.amount <= 0) return { error: 'Amount must be positive.' };

            if (inputToken.decimals === null) return { error: `Cannot determine decimals for input token ${input.inputToken}. Use a known symbol or verified mint.` };

            // BAT-255: Pre-swap balance check — fail fast before wallet popup / Jupiter order
            const SOL_NATIVE_MINT = 'So11111111111111111111111111111111111111112';
            const isNativeSOL = inputToken.address === SOL_NATIVE_MINT;
            // BAT-582 follow-up: native SOL swaps need headroom for tx fees +
            // ATA rent on top of the swap amount. Pre-fix the check passed
            // when amount exactly equalled balance — Ultra then rejected with
            // "Insufficient funds" because there was nothing left for fees.
            // Reserve a small buffer so the error happens here (with a clear
            // message) instead of after a round-trip to Ultra.
            //
            // 0.005 SOL covers: ~5000 lamports per signature × up to ~3 sigs
            // (Ultra route may chain 2-3 hops), plus ~2,039,280 lamports for
            // a fresh USDC ATA if the destination doesn't have one yet, plus
            // a small priority-fee margin. Tuned conservatively — the user
            // can always retry with `amount - 0.005` if they want to swap
            // closer to the limit.
            const NATIVE_SOL_FEE_BUFFER = 0.005;
            try {
                if (isNativeSOL) {
                    const bal = await solanaRpc('getBalance', [userPublicKey]);
                    if (!bal.error) {
                        const solBalance = (bal.value || 0) / 1e9;
                        if (input.amount > solBalance) {
                            return { error: `Insufficient SOL balance: you have ${solBalance} SOL but tried to swap ${input.amount} SOL.` };
                        }
                        if (input.amount + NATIVE_SOL_FEE_BUFFER > solBalance) {
                            return {
                                error: `SOL balance too tight: you have ${solBalance} SOL and tried to swap ${input.amount} SOL, but Jupiter also needs ~${NATIVE_SOL_FEE_BUFFER} SOL for tx fees + ATA rent. Try swapping at most ${(solBalance - NATIVE_SOL_FEE_BUFFER).toFixed(6)} SOL or fund the wallet with a bit more SOL.`,
                            };
                        }
                    }
                } else {
                    const tokenAccts = await solanaRpc('getTokenAccountsByOwner', [
                        userPublicKey,
                        { mint: inputToken.address },
                        { encoding: 'jsonParsed' }
                    ]);
                    if (!tokenAccts.error && tokenAccts.value) {
                        let tokenBalance = 0;
                        for (const acct of tokenAccts.value) {
                            try { tokenBalance += parseFloat(acct.account.data.parsed.info.tokenAmount.uiAmountString); } catch (_) {}
                        }
                        if (input.amount > tokenBalance) {
                            return { error: `Insufficient ${inputToken.symbol} balance: you have ${tokenBalance} ${inputToken.symbol} but tried to swap ${input.amount} ${inputToken.symbol}.` };
                        }
                    }
                }
            } catch (balErr) {
                log(`[Jupiter Ultra] Balance pre-check skipped: ${balErr.message}`, 'DEBUG');
                // Non-fatal: continue to Ultra order (Jupiter will reject if insufficient)
            }

            // Pre-swap price confidence check — fail closed on low-confidence data
            try {
                const priceData = await jupiterPrice([inputToken.address]);
                const pd = priceData[inputToken.address];
                if (pd?.confidenceLevel === 'low') {
                    return {
                        error: 'Price confidence too low for swap',
                        details: `${inputToken.symbol} has low price confidence. This means pricing data is unreliable and the swap could result in significant losses. Try again later or check the token's liquidity.`,
                    };
                }
            } catch (priceErr) {
                log(`[Jupiter Ultra] Pre-swap price check skipped: ${priceErr.message}`, 'DEBUG');
                // Continue — Ultra order will have its own pricing
            }

            // Jupiter Ultra flow: gasless, RPC-less swaps
            // BAT-255: use BigInt-safe parsing (same as trigger/DCA) to avoid
            // floating-point precision loss (e.g., 0.1 + 0.2 !== 0.3 in JS)
            const amountRaw = parseInputAmountToLamports(numberToDecimalString(input.amount), inputToken.decimals);

            // Step 1: Get Ultra order (quote + unsigned tx in one call)
            // Ultra signed payloads have ~2 min TTL — track timing for re-quote
            const ULTRA_TTL_SAFE_MS = 90000; // Re-quote if >90s elapsed (30s buffer before 2-min TTL)
            let order, orderTimestamp;

            const fetchAndVerifyOrder = async () => {
                log(`[Jupiter Ultra] Getting order: ${input.amount} ${inputToken.symbol} → ${outputToken.symbol}`, 'INFO');
                const o = await jupiterUltraOrder(inputToken.address, outputToken.address, amountRaw, userPublicKey);
                if (!o.transaction) {
                    // BAT-582 follow-up (local Jupiter test layer 1): Ultra returns
                    // 200 OK with a structured `errorMessage`/`errorCode` when it
                    // can route on paper but won't build a tx (sponsored-mode
                    // floor exceeded → gasless mode → output value < $5 →
                    // "Minimum $5 for gasless"; or balance < amount + fees →
                    // "Insufficient funds"). Pre-fix this threw a generic
                    // "did not return a transaction" message and dropped the
                    // diagnostic — surface Ultra's own explanation, then add an
                    // actionable hint for the gasless dead zone (the band where
                    // sponsored-mode rejected the size but the swap value is
                    // still below $5 so gasless rejects too — Jupiter's
                    // routing engine; nothing we can route around).
                    const detail = o.errorMessage || o.error || 'no detail returned';
                    const code = (o.errorCode != null) ? ` [code=${o.errorCode}]` : '';
                    let hint = '';
                    const detailLower = String(detail).toLowerCase();
                    if (detailLower.includes('gasless')) {
                        hint = ' — Jupiter\'s gasless mode requires output ≥ $5 for this route. Try a smaller swap (~$1 or less, sponsored mode) or a larger one (~$5+ output, gasless mode).';
                    } else if (detailLower.includes('insufficient')) {
                        hint = ' — wallet may not have enough SOL to cover the swap amount + tx fees. Fund the wallet with a bit more SOL and retry.';
                    }
                    throw new Error(`Jupiter Ultra did not return a transaction: ${detail}${code}${hint}`);
                }
                if (!o.requestId) throw new Error('Jupiter Ultra did not return a requestId.');

                // Verify transaction before sending to wallet
                const verification = verifySwapTransaction(o.transaction, userPublicKey, { skipPayerCheck: true });
                if (!verification.valid) throw new Error(`Swap transaction rejected: ${verification.error}`);
                log('[Jupiter Ultra] Order tx verified — programs OK', 'DEBUG');
                return o;
            };

            try {
                order = await fetchAndVerifyOrder();
                orderTimestamp = Date.now();
            } catch (e) {
                return { error: e.message };
            }

            // BAT-582 Phase 5: route through wallet dispatch. The broadcast
            // callback handles the Jupiter Ultra TTL re-quote dance — for
            // burner the sign step is fast (no popup) so re-quote is
            // basically never needed; for main, MWA approval can take
            // longer than the Ultra signed-payload TTL (~2 min) so we
            // detect that and re-quote inside the broadcast callback.
            //
            // routeAndSign passes UNSIGNED tx to broadcast() for the main
            // path (signer.signAndSend signs+broadcasts atomically via MWA)
            // and SIGNED tx for the burner path (sign-only happened before
            // broadcast()). We branch on which we got and handle TTL
            // accordingly. For Phase 5 we keep the existing TTL safe-guard
            // wired only on the main path — the burner path's reservation
            // already enforces a 60s TTL upstream and Ultra's 2-min limit
            // is comfortably wider.
            const ULTRA_RPC_HINT = 'jupiter';

            // BAT-1013 Phase 3b: build expectedDelta for the burner-policy gate.
            // Only the burner path consumes it; main path ignores the field.
            // Ultra is a sponsored-fee flow, so signerMode is 'sponsored' when
            // routed through Ultra's gasless mode (Jupiter pays the fee + may
            // co-sign). The cosigner allowlist is left empty by default — the
            // policy's `sponsored` mode allows the fee payer to be ANY signer
            // declared in feePayerAllowlist; for Ultra the relayer pubkey is
            // surfaced as `order.feePayer` in some responses. When the
            // expectedDelta fields are imprecise (sponsored mode + missing
            // relayer pubkey), the burner-policy reject is availability-class
            // and the agent surfaces it; in v2.1 first-ship we err on the
            // side of fail-closed for Ultra-via-burner until the live test
            // fixtures pin the exact field shapes.
            // Q5 (BAT-1013-followup): fee-payer introspection on the unsigned
            // Ultra tx. Jupiter Ultra is a sponsored-fee design — the relayer
            // typically pays the fee, so account[0] (fee payer) will NOT equal
            // the burner pubkey in production. The Phase 3b expectedDelta below
            // declares signerMode='burner_only', which the policy gate
            // interprets as "burner is fee payer" — that mismatch would either
            // (a) fail-closed at the policy gate, or (b) silently allow a
            // sponsored tx through if signerMode is misread. As a defensive
            // belt-and-braces fallback: when routing was 'burner' AND the
            // unsigned tx's fee payer differs from the burner pubkey, route to
            // main so the user sees the MWA popup instead of an opaque
            // burner-policy reject. The full sponsored-mode wiring (with
            // feePayerAllowlist sourced from order.feePayer when Jupiter
            // surfaces it) is tracked in Phase 3b-follow-up; until that lands,
            // this defensive check prevents a silent burner-policy reject.
            try {
                const feePayer = _extractFeePayerBase58(order.transaction);
                if (feePayer && feePayer !== userPublicKey && routingHint.routingDecision === 'burner') {
                    log(`[Jupiter Ultra] Unsigned tx fee payer ${feePayer} != burner ${userPublicKey} (sponsored-fee design) — Phase 3b expectedDelta declares burner_only, defensive fallback to main wallet to avoid silent policy reject`, 'WARN');
                    routingHint.routingDecision = 'main';
                }
            } catch (introspectErr) {
                log(`[Jupiter Ultra] fee-payer introspection failed: ${introspectErr.message} — proceeding with declared routing`, 'DEBUG');
            }

            let expectedDelta = null;
            try {
                const burnerPubkey = userPublicKey; // burner path uses burner as taker
                const inputIsSol = inputToken.address === 'So11111111111111111111111111111111111111112';
                const outputIsSol = outputToken.address === 'So11111111111111111111111111111111111111112';
                const ata = require('../wallet/ata');
                const debitAccount = inputIsSol ? burnerPubkey : ata.deriveAtaBase58(burnerPubkey, inputToken.address);
                const creditAccount = outputIsSol ? burnerPubkey : ata.deriveAtaBase58(burnerPubkey, outputToken.address);
                const minOut = String(order.otherAmountThreshold || order.outAmount || '0');
                // B1 (BAT-1013-followup): when input OR output is native SOL,
                // Jupiter Ultra's documented wrapping pattern is open-wSOL-ATA
                // → swap → CloseAccount(wSOL-ATA, destination=burner). The
                // burner-policy drainer-walk treats CloseAccount as drainer-
                // class by default; without an explicit exemption the policy
                // gate would reject every native-SOL Ultra swap. The
                // exemption is encoded as an OPTIONAL field on
                // jupiter_swap_immediate: { ata, destination } MUST both
                // match the burner's wSOL ATA and the burner itself, validated
                // structurally by burner-policy.js at expectedDelta-shape time.
                // Any deviation (different destination, different ATA, ix not
                // CloseAccount) is fail-closed.
                //
                // Q8 (BAT-1013-followup): burnerOwnedAccounts below declares
                // the EXPLICIT debit + credit ATAs the burner debits/credits.
                // Multi-hop intermediate ATAs Jupiter routes through are NOT
                // declared here — burner-policy.js step 10 derives the
                // multi-hop ownership set from the simulation pre-snapshot
                // (declared ∪ sim-owned). If Jupiter inserts an intermediate
                // ATA the burner owns but we didn't declare, sim-owned picks
                // it up; if it inserts one we DON'T own, the policy's
                // ownership-resolver fails closed (drainer_* or
                // account_ownership_uncertain).
                const NATIVE_MINT_BASE58 = 'So11111111111111111111111111111111111111112';
                let wsolAtaExemption = null;
                if (inputIsSol || outputIsSol) {
                    try {
                        const wsolAta = ata.deriveAtaBase58(burnerPubkey, NATIVE_MINT_BASE58);
                        wsolAtaExemption = { ata: wsolAta, destination: burnerPubkey };
                    } catch (wsolErr) {
                        log(`[Jupiter Ultra] Could not derive wSOL ATA for exemption: ${wsolErr.message}`, 'WARN');
                        // Fall through — exemption stays null. Policy gate
                        // will reject CloseAccount, which routeAndSign treats
                        // as a security failure; user sees the rejection.
                    }
                }
                expectedDelta = {
                    kind: 'jupiter_swap_immediate',
                    signerMode: 'burner_only', // single-signer path; sponsored mode wires in Phase 3b-follow-up once Ultra fee-payer pubkey is plumbed
                    burnerDebit: {
                        account: debitAccount,
                        mint: inputIsSol ? 'native_sol' : inputToken.address,
                        atomicAmount: String(amountRaw),
                    },
                    burnerCreditMin: {
                        account: creditAccount,
                        mint: outputIsSol ? 'native_sol' : outputToken.address,
                        atomicAmount: minOut,
                    },
                    burnerOwnedAccounts: [debitAccount, creditAccount].filter(a => a !== burnerPubkey),
                    toleranceBps: Math.min((order.slippageBps || 100) + 25, 200),
                    ...(wsolAtaExemption ? { wsolAtaExemption } : {}),
                };
            } catch (eDelta) {
                // Copilot PR #398 R2: a null expectedDelta is silently
                // skipped by dispatch.js -> BurnerSigner, which would let
                // the burner sign without the policy gate. Force main
                // routing so the user sees the MWA popup instead.
                log(`[Jupiter Ultra] Could not build expectedDelta — forcing main wallet routing: ${eDelta.message}`, 'WARN');
                routingHint.routingDecision = 'main';
                expectedDelta = null;
            }

            const result = await routeAndSign({
                toolName: 'solana_swap',
                toolArgs: input,
                unsignedTxBase64: order.transaction,
                broadcastVia: ULTRA_RPC_HINT,
                flowName: 'solana_swap',
                // Copilot PR #398 R13: thread routingHint through forceRouting.
                // The fee-payer introspection block (~line 1696) and the
                // expectedDelta-build catch (~line 1772) BOTH mutate
                // routingHint.routingDecision = 'main' to force MWA fallback.
                // Without forceRouting, dispatch.js re-calls routeFor() from
                // the unmodified toolArgs and proceeds on burner with
                // expectedDelta=null — bypassing validateBurnerTx entirely
                // (the security hole PR #398 R2 was meant to close).
                forceRouting: routingHint,
                expectedDelta,
                broadcast: async (txOrUnsigned, _signer, ctx) => {
                    // ctx.signed === true  → burner path (txOrUnsigned is already signed by burner)
                    // ctx.signed === false → main path  (txOrUnsigned is unsigned, sign via MWA)
                    if (ctx && ctx.signed) {
                        log('[Jupiter Ultra] Executing burner-signed tx...', 'INFO');
                        const ex = await jupiterUltraExecute(txOrUnsigned, order.requestId);
                        if (ex.status === 'Failed') {
                            return { error: 'execute_failed', reason: ex.error || 'Jupiter Ultra rejected' };
                        }
                        if (!ex.signature) {
                            return { error: 'execute_failed', reason: 'no signature in Ultra response' };
                        }
                        return { signature: ex.signature, ultra: ex };
                    }
                    // Main path: txOrUnsigned IS the unsigned tx. Sign via MWA + execute.
                    await ensureWalletAuthorized();
                    log('[Jupiter Ultra] Sending to wallet for approval (sign-only)...', 'INFO');
                    let signResult = await androidBridgeCall('/solana/sign-only', {
                        transaction: txOrUnsigned,
                    }, 120000);
                    if (signResult.error) return { error: 'sign_failed', reason: signResult.error };
                    if (!signResult.signedTransaction) return { error: 'sign_failed', reason: 'no signed tx returned from wallet' };

                    // TTL re-quote check — MWA can hold the popup for a long
                    // time; if approval took >90s we re-quote to stay
                    // within Ultra's 2-min signed-payload TTL.
                    const elapsed = Date.now() - orderTimestamp;
                    let finalSignedTx = signResult.signedTransaction;
                    let finalRequestId = order.requestId;
                    if (elapsed > ULTRA_TTL_SAFE_MS) {
                        log(`[Jupiter Ultra] MWA approval took ${Math.round(elapsed / 1000)}s (>90s) — re-quoting...`, 'WARN');
                        try {
                            order = await fetchAndVerifyOrder();
                            orderTimestamp = Date.now();
                            const reSignResult = await androidBridgeCall('/solana/sign-only', {
                                transaction: order.transaction,
                            }, 60000);
                            if (reSignResult.error) return { error: 'sign_failed', reason: `re-quote sign failed: ${reSignResult.error}` };
                            if (!reSignResult.signedTransaction) return { error: 'sign_failed', reason: 'no signed tx from re-quote' };
                            finalSignedTx = reSignResult.signedTransaction;
                            finalRequestId = order.requestId;
                        } catch (reQuoteErr) {
                            log(`[Jupiter Ultra] Re-quote failed, attempting original: ${reQuoteErr.message}`, 'WARN');
                        }
                    }

                    log('[Jupiter Ultra] Executing signed transaction...', 'INFO');
                    const execResult = await jupiterUltraExecute(finalSignedTx, finalRequestId);
                    if (execResult.status === 'Failed') {
                        return { error: 'execute_failed', reason: execResult.error || 'Jupiter Ultra rejected' };
                    }
                    if (!execResult.signature) {
                        return { error: 'execute_failed', reason: 'no signature in Ultra response' };
                    }
                    return { signature: execResult.signature, ultra: execResult };
                },
            });

            if (!result.ok) {
                return { error: result.error, reason: result.reason };
            }
            const execResult = (result.broadcastResult && result.broadcastResult.ultra) || { signature: result.signature };

            const outDecimals = outputToken.decimals || 6;
            const inDecimals = inputToken.decimals || 9;

            const response = {
                success: true,
                signature: execResult.signature,
                inputToken: inputToken.symbol,
                outputToken: outputToken.symbol,
                inputAmount: execResult.inputAmount
                    ? parseInt(execResult.inputAmount) / Math.pow(10, inDecimals)
                    : input.amount,
                outputAmount: execResult.outputAmount
                    ? parseInt(execResult.outputAmount) / Math.pow(10, outDecimals)
                    : null,
                gasless: true,
            };
            // BAT-582 Phase 5: surface which wallet signed.
            response.wallet = result.wallet;
            const warnings = [];
            if (inputToken.warning) warnings.push(inputToken.warning);
            if (outputToken.warning) warnings.push(outputToken.warning);
            if (warnings.length > 0) response.warnings = warnings;
            return response;
        } catch (e) {
            return { error: e.message };
        }
    },

    // ========== JUPITER API TOOLS ==========

    async jupiter_trigger_create(input, chatId) {
        // BAT-697 PR B: gate on useTriggerV2 flag. Default false → V1 path
        // below. Flag flips in commit 4 of the staged rollout.
        if (config.useTriggerV2 === true) {
            return _jupiterTriggerCreateV2(input, chatId);
        }

        if (!config.jupiterApiKey) {
            return {
                error: 'Jupiter API key required',
                guide: 'Get a free API key at portal.jup.ag, then add it in SeekerClaw Settings > Configuration > Jupiter API Key'
            };
        }

        try {
            // 1. Resolve tokens
            const inputToken = await resolveToken(input.inputToken);
            const outputToken = await resolveToken(input.outputToken);

            if (!inputToken || inputToken.ambiguous) {
                return {
                    error: 'Could not resolve input token',
                    details: inputToken?.ambiguous
                        ? `Multiple tokens match "${input.inputToken}". Please use the full mint address.`
                        : `Token "${input.inputToken}" not found.`
                };
            }
            if (inputToken.warning && inputToken.decimals == null) {
                return {
                    error: 'Unverified input token with missing metadata',
                    details: `${inputToken.warning}\n\nThe token is missing decimal metadata, which is required for amount calculations. Only verified tokens on Jupiter's token list can be used.`
                };
            }
            if (!outputToken || outputToken.ambiguous) {
                return {
                    error: 'Could not resolve output token',
                    details: outputToken?.ambiguous
                        ? `Multiple tokens match "${input.outputToken}". Please use the full mint address.`
                        : `Token "${input.outputToken}" not found.`
                };
            }
            if (outputToken.warning && outputToken.decimals == null) {
                return {
                    error: 'Unverified output token with missing metadata',
                    details: `${outputToken.warning}\n\nThe token is missing decimal metadata, which is required for amount calculations. Only verified tokens on Jupiter's token list can be used.`
                };
            }

            // Token-2022 check — Trigger orders do NOT support Token-2022 tokens
            try {
                const mints = [inputToken.address, outputToken.address].join(',');
                const shieldParams = new URLSearchParams({ mints });
                const shieldRes = await jupiterRequest({
                    hostname: 'api.jup.ag',
                    path: `/ultra/v1/shield?${shieldParams.toString()}`,
                    method: 'GET',
                    headers: { 'x-api-key': config.jupiterApiKey }
                });
                if (shieldRes.status === 200) {
                    const shieldData = typeof shieldRes.data === 'string' ? JSON.parse(shieldRes.data) : shieldRes.data;
                    for (const [mint, info] of Object.entries(shieldData)) {
                        if (info.tokenType === 'token-2022' || info.isToken2022) {
                            const sym = mint === inputToken.address ? inputToken.symbol : outputToken.symbol;
                            return {
                                error: 'Token-2022 not supported for limit orders',
                                details: `${sym} (${mint}) is a Token-2022 token. Jupiter Trigger orders do not support Token-2022 tokens. Use a regular swap instead.`
                            };
                        }
                    }
                }
            } catch (shieldErr) {
                log(`[Jupiter Trigger] Token-2022 check skipped: ${shieldErr.message}`, 'DEBUG');
            }

            // BAT-582 Phase 5: routing decision determines maker/payer.
            // Burner-routed → burner pubkey (autonomous). Main-routed → MWA wallet.
            const { routeFor: _routeForTrigger } = require('../caps/preflight');
            const routingHint = await _routeForTrigger('jupiter_trigger_create', input);

            // 2. Get wallet address — burner pubkey if routing=burner, MWA pubkey otherwise.
            let walletAddress;
            if (routingHint.routingDecision === 'burner') {
                try {
                    const burnerStatus = await androidBridgeCall('/burner/status', {}, 5000);
                    if (burnerStatus && !burnerStatus.error && burnerStatus.configured && burnerStatus.pubkey) {
                        walletAddress = burnerStatus.pubkey;
                    }
                } catch (_) { /* fall through to MWA */ }
            }
            if (!walletAddress) {
                try {
                    walletAddress = getConnectedWalletAddress();
                } catch (e) {
                    return { error: e.message };
                }
            }

            // 3. Validate and convert input amount (makingAmount in raw units)
            let makingAmount;
            try {
                makingAmount = parseInputAmountToLamports(numberToDecimalString(input.inputAmount), inputToken.decimals);
            } catch (e) {
                return { error: 'Invalid input amount', details: e.message };
            }

            // 4. Validate triggerPrice and compute takingAmount (raw output units)
            const triggerPriceNum = Number(input.triggerPrice);
            if (!Number.isFinite(triggerPriceNum) || triggerPriceNum <= 0) {
                return { error: 'Invalid trigger price', details: 'triggerPrice must be a positive finite number' };
            }
            // takingAmount = inputAmount (human) * triggerPrice, converted to output token raw units
            // Use parseInputAmountToLamports + BigInt to avoid all floating-point precision issues
            let takingAmount;
            try {
                const makingLamports = parseInputAmountToLamports(numberToDecimalString(input.inputAmount), inputToken.decimals);
                const makingBig = BigInt(makingLamports);
                // Convert triggerPrice to a 12-decimal-place integer via string parsing (no FP math)
                let priceStr;
                if (typeof input.triggerPrice === 'string') {
                    priceStr = input.triggerPrice;
                } else {
                    const numStr = input.triggerPrice.toString();
                    if (numStr.includes('e') || numStr.includes('E')) {
                        return { error: 'Invalid trigger price', details: 'triggerPrice must not use exponential notation; pass a decimal string for high-precision values' };
                    }
                    priceStr = numStr;
                }
                const priceScaled = BigInt(parseInputAmountToLamports(priceStr, 12));
                const outputScale = BigInt(10) ** BigInt(outputToken.decimals);
                const inputScale = BigInt(10) ** BigInt(inputToken.decimals);
                const precisionScale = BigInt(10) ** BigInt(12);
                takingAmount = ((makingBig * priceScaled * outputScale) / (inputScale * precisionScale)).toString();
                if (takingAmount === '0') return { error: 'Calculated takingAmount is zero — check triggerPrice and inputAmount' };
            } catch (e) {
                return { error: 'Invalid taking amount calculation', details: e.message };
            }

            // 5. Compute expiryTime: use provided value, or default to 30 days from now
            let expiryTime;
            if (input.expiryTime == null) {
                expiryTime = Math.floor((Date.now() + 30 * 24 * 60 * 60 * 1000) / 1000);
            } else {
                const expiryTimeNum = Number(input.expiryTime);
                const nowInSeconds = Math.floor(Date.now() / 1000);
                if (!Number.isFinite(expiryTimeNum) || expiryTimeNum <= 0) {
                    return { error: 'Invalid expiryTime', details: 'Must be a positive Unix timestamp in seconds' };
                }
                if (expiryTimeNum <= nowInSeconds) {
                    return { error: 'Invalid expiryTime', details: 'Must be in the future' };
                }
                expiryTime = Math.floor(expiryTimeNum);
            }

            // 6. Call Jupiter Trigger API — createOrder
            log(`[Jupiter Trigger] Creating order: ${input.inputAmount} ${inputToken.symbol} → ${outputToken.symbol} at ${input.triggerPrice}`, 'INFO');
            const reqBody = {
                inputMint: inputToken.address,
                outputMint: outputToken.address,
                maker: walletAddress,
                payer: walletAddress,
                params: {
                    makingAmount: makingAmount,
                    takingAmount: takingAmount,
                    expiredAt: String(expiryTime),
                },
                computeUnitPrice: 'auto',
                wrapAndUnwrapSol: true,
            };

            // No retry for createOrder — non-idempotent POST could create duplicates
            const res = await httpRequest({
                hostname: 'api.jup.ag',
                path: '/trigger/v1/createOrder',
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    'x-api-key': config.jupiterApiKey
                }
            }, reqBody);

            if (res.status !== 200) {
                return { error: `Jupiter API error: ${res.status}`, details: res.data };
            }

            const data = typeof res.data === 'string' ? JSON.parse(res.data) : res.data;
            if (!data.transaction) return { error: 'Jupiter did not return a transaction' };
            if (!data.requestId) return { error: 'Jupiter did not return a requestId' };

            // 7. Verify transaction (security — user is fee payer for trigger orders)
            try {
                const verification = verifySwapTransaction(data.transaction, walletAddress);
                if (!verification.valid) {
                    log(`[Jupiter Trigger] Tx verification FAILED: ${verification.error}`, 'ERROR');
                    return { error: `Transaction rejected: ${verification.error}` };
                }
                log('[Jupiter Trigger] Tx verified — programs OK', 'DEBUG');
            } catch (verifyErr) {
                log(`[Jupiter Trigger] Tx verification error: ${verifyErr.message}`, 'WARN');
                return { error: `Could not verify transaction: ${verifyErr.message}` };
            }

            // BAT-1013 Phase 3b: V1 trigger create deposit shape.
            let v1ExpectedDelta = null;
            let v1ForceRouting = null;
            try {
                const inputIsSol = inputToken.address === 'So11111111111111111111111111111111111111112';
                const ataMod = require('../wallet/ata');
                const debitAccount = inputIsSol ? walletAddress : ataMod.deriveAtaBase58(walletAddress, inputToken.address);
                // V1 createOrder response includes the order PDA in `data.order`
                // when present. expectedOwner is Jupiter Limit Order V1 — cross-
                // verified against jup-ag/platform-list (jupiterLimitContract),
                // @jup-ag/limit-order-sdk@0.1.10 (PROGRAM_ID_BY_CLUSTER), and
                // Solscan label 'Jupiter Limit Order V1'.
                //
                // Contract v8.3 (per Codex review): depositVault is REQUIRED
                // for autonomous burner signing of deposit flows. If Jupiter
                // omits `data.order` from its response (older API shape),
                // we cannot verify the destination — fail closed by routing
                // to main wallet (MWA popup) rather than silently signing
                // without destination verification.
                // C2 (BAT-1013-followup): tighten data.order validation. Pre-
                // fix only checked truthiness — a Jupiter response with
                // data.order='undefined' (string) or 'pending' or any other
                // truthy non-pubkey would pass and then be tunneled into
                // expectedDelta.depositVault.pubkey, where burner-policy would
                // either reject with a confusing shape error or (if base58
                // decoded to garbage) treat an arbitrary 32-byte blob as the
                // deposit destination. Validate as a real Solana base58
                // address and route to main if absent OR malformed.
                if (!data.order || !isValidSolanaAddress(data.order)) {
                    const reason = data.order
                        ? `data.order=${JSON.stringify(data.order)} is not a valid Solana base58 address`
                        : 'data.order missing from Jupiter response';
                    log(`[Jupiter Trigger V1] ${reason} — autonomous burner cannot verify deposit destination; routing to main wallet`, 'WARN');
                    v1ForceRouting = { routingDecision: 'main' };
                } else {
                    v1ExpectedDelta = {
                        kind: 'jupiter_trigger_create_deposit',
                        signerMode: 'burner_only',
                        burnerDebit: {
                            account: debitAccount,
                            mint: inputIsSol ? 'native_sol' : inputToken.address,
                            atomicAmount: String(makingAmount),
                        },
                        depositVault: {
                            pubkey: data.order,
                            expectedOwner: 'jupoNjAxXgZ4rjzxzPMP4oxduvQsQtZzyknqvzYNrNu',
                        },
                        burnerOwnedAccounts: [debitAccount].filter(a => a !== walletAddress),
                    };
                }
            } catch (eDelta) {
                // Copilot PR #398 R2 (same class as V2/Ultra): null
                // expectedDelta is skipped by dispatch.js -> BurnerSigner;
                // force main routing so policy gate isn't silently bypassed.
                log(`[Jupiter Trigger V1] Could not build expectedDelta — forcing main wallet routing: ${eDelta.message}`, 'WARN');
                v1ForceRouting = { routingDecision: 'main' };
                v1ExpectedDelta = null;
            }

            // 8 + 9. Sign + execute via wallet dispatch. Jupiter Trigger
            // broadcasts the tx itself (we never hit RPC sendTransaction);
            // the broadcast callback always calls jupiterTriggerExecute on
            // a signed tx, regardless of wallet.
            const dispatchResult = await routeAndSign({
                toolName: 'jupiter_trigger_create',
                toolArgs: input,
                unsignedTxBase64: data.transaction,
                broadcastVia: 'jupiter',
                flowName: 'jupiter_trigger_create',
                expectedDelta: v1ExpectedDelta,
                forceRouting: v1ForceRouting,
                broadcast: async (txOrUnsigned, _signer, ctx) => {
                    let signedTx;
                    if (ctx && ctx.signed) {
                        signedTx = txOrUnsigned;
                    } else {
                        await ensureWalletAuthorized();
                        log('[Jupiter Trigger] Sending to wallet for approval (sign-only)...', 'INFO');
                        const signResult = await androidBridgeCall('/solana/sign-only', { transaction: txOrUnsigned }, 120000);
                        if (signResult.error) return { error: 'sign_failed', reason: signResult.error };
                        if (!signResult.signedTransaction) return { error: 'sign_failed', reason: 'no signed tx returned from wallet' };
                        signedTx = signResult.signedTransaction;
                    }
                    log('[Jupiter Trigger] Executing signed transaction...', 'INFO');
                    const ex = await jupiterTriggerExecute(signedTx, data.requestId);
                    if (ex.status === 'Failed') {
                        return { error: 'execute_failed', reason: ex.error || 'Jupiter Trigger rejected' };
                    }
                    if (!ex.signature) return { error: 'execute_failed', reason: 'no signature in Trigger response' };
                    return { signature: ex.signature, trigger: ex };
                },
            });

            if (!dispatchResult.ok) {
                return { error: dispatchResult.error, reason: dispatchResult.reason };
            }
            const execResult = (dispatchResult.broadcastResult && dispatchResult.broadcastResult.trigger) || { signature: dispatchResult.signature };

            // BAT-582 Phase 5: record ownership AFTER successful broadcast.
            // Failure here is logged but does NOT unwind the create \u2014 per
            // contract v1.4, the order is real on-chain; the cancel will
            // fall back to "unknown \u2192 main + confirm + diagnostic" if the
            // ownership write missed.
            const orderId = execResult.order || execResult.orderId || data.order || null;
            if (orderId) {
                await recordJupiterOwnership(orderId, dispatchResult.wallet, 'jupiter_trigger_create');
            } else {
                log('[Jupiter Trigger] No orderId in execute response \u2014 ownership not recorded', 'WARN');
            }

            const warnings = [];
            if (inputToken.warning) warnings.push(`\u26A0\uFE0F ${inputToken.symbol}: ${inputToken.warning}`);
            if (outputToken.warning) warnings.push(`\u26A0\uFE0F ${outputToken.symbol}: ${outputToken.warning}`);

            return {
                success: true,
                orderId,
                signature: execResult.signature,
                inputToken: `${inputToken.symbol} (${inputToken.address})`,
                outputToken: `${outputToken.symbol} (${outputToken.address})`,
                inputAmount: input.inputAmount,
                triggerPrice: input.triggerPrice,
                expiryTime: expiryTime,
                wallet: dispatchResult.wallet,
                warnings: warnings.length > 0 ? warnings : undefined
            };
        } catch (e) {
            return { error: e.message };
        }
    },

    async jupiter_trigger_list(input, chatId) {
        if (config.useTriggerV2 === true) {
            return _jupiterTriggerListV2(input, chatId);
        }

        if (!config.jupiterApiKey) {
            return {
                error: 'Jupiter API key required',
                guide: 'Get a free API key at portal.jup.ag, then add it in SeekerClaw Settings > Configuration > Jupiter API Key'
            };
        }

        try {
            // 1. Get wallet address
            let walletAddress;
            try {
                walletAddress = getConnectedWalletAddress();
            } catch (e) {
                return { error: e.message };
            }

            // 2. Validate input against schema
            if (input.status) {
                const allowedStatuses = ['active', 'history'];
                if (!allowedStatuses.includes(input.status)) {
                    return {
                        error: 'Invalid status value',
                        details: 'status must be either "active" or "history"'
                    };
                }
            }
            if (input.page !== undefined && input.page !== null) {
                const pageNum = Number(input.page);
                if (!Number.isInteger(pageNum) || pageNum <= 0) {
                    return {
                        error: 'Invalid page value',
                        details: 'page must be a positive integer (1, 2, 3, ...)'
                    };
                }
            }

            // 3. Build query params — orderStatus is required by Jupiter API
            const params = new URLSearchParams({
                user: walletAddress,
                orderStatus: input.status || 'active',  // Default to 'active', Jupiter requires this
            });
            if (input.page !== undefined && input.page !== null) {
                params.append('page', String(Number(input.page)));
            }

            // 4. Call Jupiter Trigger API
            const res = await jupiterRequest({
                hostname: 'api.jup.ag',
                path: `/trigger/v1/getTriggerOrders?${params.toString()}`,
                method: 'GET',
                headers: {
                    'x-api-key': config.jupiterApiKey
                }
            });

            if (res.status !== 200) {
                return { error: `Jupiter API error: ${res.status}`, details: res.data };
            }

            const data = typeof res.data === 'string' ? JSON.parse(res.data) : res.data;
            const orders = data.orders || [];

            return {
                success: true,
                count: orders.length,
                orders: orders.map(order => ({
                    orderId: order.orderId,
                    orderType: order.orderType,
                    inputToken: order.inputMint,
                    outputToken: order.outputMint,
                    inputAmount: order.inputAmount,
                    triggerPrice: order.triggerPrice,
                    status: order.status,
                    expiryTime: order.expiryTime || 'No expiry',
                    createdAt: order.createdAt
                }))
            };
        } catch (e) {
            return { error: e.message };
        }
    },

    async jupiter_trigger_cancel(input, chatId) {
        if (config.useTriggerV2 === true) {
            return _jupiterTriggerCancelV2(input, chatId);
        }

        if (!config.jupiterApiKey) {
            return {
                error: 'Jupiter API key required',
                guide: 'Get a free API key at portal.jup.ag, then add it in SeekerClaw Settings > Configuration > Jupiter API Key'
            };
        }

        try {
            // 1. Validate required input
            if (!input.orderId || String(input.orderId).trim() === '') {
                return { error: 'orderId is required' };
            }

            // BAT-582 Phase 5: cancel routes to the wallet that CREATED
            // the order. Look up ownership from the bridge map. burner →
            // sign via burner (silent). main / unknown → sign via MWA
            // (existing flow). The confirmation gate in ai.js already
            // enforced "none" for burner-owned and "confirm" for main/unknown,
            // so by the time this handler runs the routing decision is set.
            let creatorRole = 'unknown';
            try {
                const lookup = await androidBridgeCall(
                    '/jupiter/order-owner/get',
                    { orderId: input.orderId },
                    5000,
                );
                if (lookup && !lookup.error && (lookup.creatorWalletRole === 'burner' || lookup.creatorWalletRole === 'main')) {
                    creatorRole = lookup.creatorWalletRole;
                }
            } catch (_) { /* fall back to unknown → MWA path */ }

            // 2. Get wallet address — burner pubkey (creator was burner) or MWA pubkey.
            let walletAddress;
            if (creatorRole === 'burner') {
                try {
                    const burnerStatus = await androidBridgeCall('/burner/status', {}, 5000);
                    if (burnerStatus && !burnerStatus.error && burnerStatus.configured && burnerStatus.pubkey) {
                        walletAddress = burnerStatus.pubkey;
                    }
                } catch (_) { /* fall through to MWA path */ }
                if (!walletAddress) {
                    log('[Jupiter Trigger] burner-owned cancel but burner pubkey unavailable — falling back to MWA path', 'WARN');
                    creatorRole = 'main';
                }
            }
            if (!walletAddress) {
                try {
                    walletAddress = getConnectedWalletAddress();
                } catch (e) {
                    return { error: e.message };
                }
            }

            // 3. Call Jupiter Trigger API — cancelOrder (no retry — non-idempotent POST)
            log(`[Jupiter Trigger] Cancelling order: ${input.orderId} (creator=${creatorRole})`, 'INFO');
            const res = await httpRequest({
                hostname: 'api.jup.ag',
                path: '/trigger/v1/cancelOrder',
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    'x-api-key': config.jupiterApiKey
                }
            }, {
                maker: walletAddress,
                order: input.orderId,
                computeUnitPrice: 'auto',
            });

            if (res.status !== 200) {
                return { error: `Jupiter API error: ${res.status}`, details: res.data };
            }

            const data = typeof res.data === 'string' ? JSON.parse(res.data) : res.data;
            if (!data.transaction) return { error: 'Jupiter did not return a transaction' };
            if (!data.requestId) return { error: 'Jupiter did not return a requestId' };

            // 4. Verify transaction (user is fee payer for trigger cancels)
            try {
                const verification = verifySwapTransaction(data.transaction, walletAddress);
                if (!verification.valid) return { error: `Transaction rejected: ${verification.error}` };
            } catch (e) {
                return { error: `Could not verify transaction: ${e.message}` };
            }

            // 5 + 6. Sign + execute. Burner-owned → signCancelViaBurner
            // (silent, ownership-gated, reserves 0 to enforce burner is
            // configured). Main/unknown-owned → existing MWA sign-only +
            // execute path.
            const broadcastFn = async (signedTx) => {
                log('[Jupiter Trigger] Executing cancel transaction...', 'INFO');
                const ex = await jupiterTriggerExecute(signedTx, data.requestId);
                if (ex.status === 'Failed') {
                    return { error: 'execute_failed', reason: ex.error || 'Jupiter Trigger rejected' };
                }
                if (!ex.signature) return { error: 'execute_failed', reason: 'no signature in Trigger response' };
                return { signature: ex.signature };
            };

            let dispatchResult;
            if (creatorRole === 'burner') {
                dispatchResult = await signCancelViaBurner({
                    unsignedTxBase64: data.transaction,
                    flowName: 'jupiter_trigger_cancel',
                    broadcast: async (signedTx) => broadcastFn(signedTx),
                });
            } else {
                // Main / unknown path — existing MWA flow.
                await ensureWalletAuthorized();
                log('[Jupiter Trigger] Sending cancel tx to wallet for approval...', 'INFO');
                const signResult = await androidBridgeCall('/solana/sign-only', {
                    transaction: data.transaction,
                }, 120000);
                if (signResult.error) {
                    return { error: signResult.error };
                }
                if (!signResult.signedTransaction) {
                    return { error: 'No signed transaction returned from wallet' };
                }
                const broadcast = await broadcastFn(signResult.signedTransaction);
                if (broadcast.error) {
                    return { error: broadcast.reason || broadcast.error };
                }
                dispatchResult = { ok: true, wallet: 'main', signature: broadcast.signature };
            }

            if (!dispatchResult.ok) {
                return { error: dispatchResult.error || 'cancel_failed', reason: dispatchResult.reason };
            }

            return {
                success: true,
                orderId: input.orderId,
                signature: dispatchResult.signature,
                status: 'cancelled',
                wallet: dispatchResult.wallet,
                creatorRole,
            };
        } catch (e) {
            return { error: e.message };
        }
    },

    async jupiter_dca_create(input, chatId) {
        if (!config.jupiterApiKey) {
            return {
                error: 'Jupiter API key required',
                guide: 'Get a free API key at portal.jup.ag, then add it in SeekerClaw Settings > Configuration > Jupiter API Key'
            };
        }

        try {
            // 1. Resolve tokens
            const inputToken = await resolveToken(input.inputToken);
            const outputToken = await resolveToken(input.outputToken);

            if (!inputToken || inputToken.ambiguous) {
                return {
                    error: 'Could not resolve input token',
                    details: inputToken?.ambiguous
                        ? `Multiple tokens match "${input.inputToken}". Please use the full mint address.`
                        : `Token "${input.inputToken}" not found.`
                };
            }
            if (inputToken.warning && inputToken.decimals == null) {
                return {
                    error: 'Unverified input token with missing metadata',
                    details: `${inputToken.warning}\n\nThe token is missing decimal metadata, which is required for amount calculations. Only verified tokens on Jupiter's token list can be used.`
                };
            }
            if (!outputToken || outputToken.ambiguous) {
                return {
                    error: 'Could not resolve output token',
                    details: outputToken?.ambiguous
                        ? `Multiple tokens match "${input.outputToken}". Please use the full mint address.`
                        : `Token "${input.outputToken}" not found.`
                };
            }
            if (outputToken.warning && outputToken.decimals == null) {
                return {
                    error: 'Unverified output token with missing metadata',
                    details: `${outputToken.warning}\n\nThe token is missing decimal metadata, which is required for amount calculations. Only verified tokens on Jupiter's token list can be used.`
                };
            }

            // Token-2022 check — DCA/Recurring orders do NOT support Token-2022 tokens
            try {
                const mints = [inputToken.address, outputToken.address].join(',');
                const shieldParams = new URLSearchParams({ mints });
                const shieldRes = await jupiterRequest({
                    hostname: 'api.jup.ag',
                    path: `/ultra/v1/shield?${shieldParams.toString()}`,
                    method: 'GET',
                    headers: { 'x-api-key': config.jupiterApiKey }
                });
                if (shieldRes.status === 200) {
                    const shieldData = typeof shieldRes.data === 'string' ? JSON.parse(shieldRes.data) : shieldRes.data;
                    for (const [mint, info] of Object.entries(shieldData)) {
                        if (info.tokenType === 'token-2022' || info.isToken2022) {
                            const sym = mint === inputToken.address ? inputToken.symbol : outputToken.symbol;
                            return {
                                error: 'Token-2022 not supported for DCA orders',
                                details: `${sym} (${mint}) is a Token-2022 token. Jupiter Recurring/DCA orders do not support Token-2022 tokens. Use a regular swap instead.`
                            };
                        }
                    }
                }
            } catch (shieldErr) {
                log(`[Jupiter DCA] Token-2022 check skipped: ${shieldErr.message}`, 'DEBUG');
            }

            // BAT-582 Phase 5: routing decision determines maker/payer.
            const { routeFor: _routeForDca } = require('../caps/preflight');
            const dcaRoutingHint = await _routeForDca('jupiter_dca_create', input);

            // 2. Get wallet address — burner pubkey if routing=burner, MWA pubkey otherwise.
            let walletAddress;
            if (dcaRoutingHint.routingDecision === 'burner') {
                try {
                    const burnerStatus = await androidBridgeCall('/burner/status', {}, 5000);
                    if (burnerStatus && !burnerStatus.error && burnerStatus.configured && burnerStatus.pubkey) {
                        walletAddress = burnerStatus.pubkey;
                    }
                } catch (_) { /* fall through to MWA */ }
            }
            if (!walletAddress) {
                try {
                    walletAddress = getConnectedWalletAddress();
                } catch (e) {
                    return { error: e.message };
                }
            }

            // 3. Map cycleInterval and validate totalCycles
            const intervalMap = { hourly: 3600, daily: 86400, weekly: 604800 };
            const cycleIntervalSeconds = intervalMap[input.cycleInterval];
            if (!cycleIntervalSeconds) {
                return { error: `Invalid cycleInterval: "${input.cycleInterval}". Must be "hourly", "daily", or "weekly".` };
            }

            // numberOfOrders: required by API (no "unlimited" option)
            // Jupiter DCA minimums: >=2 orders, >=$50/order, >=$100 total
            let numberOfOrders = 30; // Default when not specified
            if (input.totalCycles != null) {
                const tc = Number(input.totalCycles);
                if (!Number.isFinite(tc) || tc <= 0 || !Number.isInteger(tc)) {
                    return { error: 'Invalid totalCycles', details: `Must be a positive integer; received "${input.totalCycles}".` };
                }
                numberOfOrders = tc;
            }
            if (numberOfOrders < 2) {
                return { error: 'DCA requires at least 2 orders', details: 'Jupiter Recurring API minimum is 2 orders. Increase totalCycles to 2 or more.' };
            }

            // 4. Compute total inAmount = amountPerCycle * numberOfOrders
            // Jupiter API expects the TOTAL deposit, split across numberOfOrders
            // Use BigInt math to avoid floating-point precision issues
            let totalInAmount;
            try {
                const perCycleLamports = parseInputAmountToLamports(numberToDecimalString(input.amountPerCycle), inputToken.decimals);
                const perCycleBig = BigInt(perCycleLamports);
                totalInAmount = (perCycleBig * BigInt(numberOfOrders)).toString();
            } catch (e) {
                return { error: 'Invalid amountPerCycle', details: e.message };
            }

            // Validate USD minimums ($50/order, $100 total) using Jupiter price
            try {
                const priceData = await jupiterPrice([inputToken.address]);
                const pd = priceData[inputToken.address];
                if (pd?.usdPrice) {
                    const usdPerOrder = Number(input.amountPerCycle) * parseFloat(pd.usdPrice);
                    const usdTotal = usdPerOrder * numberOfOrders;
                    if (usdPerOrder < 50) {
                        return {
                            error: 'DCA order too small',
                            details: `Each order must be worth at least $50. Current value: ~$${usdPerOrder.toFixed(2)} per order. Increase amountPerCycle.`
                        };
                    }
                    if (usdTotal < 100) {
                        return {
                            error: 'DCA total too small',
                            details: `Total DCA value must be at least $100. Current total: ~$${usdTotal.toFixed(2)} (${numberOfOrders} orders × $${usdPerOrder.toFixed(2)}). Increase amountPerCycle or totalCycles.`
                        };
                    }
                }
            } catch (priceErr) {
                log(`[Jupiter DCA] Price check skipped (non-fatal): ${priceErr.message}`, 'DEBUG');
                // Continue without USD validation — API will reject if truly below minimum
            }

            // 5. Call Jupiter Recurring API — createOrder
            const inAmountNum = Number(totalInAmount);
            if (!Number.isSafeInteger(inAmountNum)) {
                return { error: 'Amount too large', details: `Total amount (${totalInAmount} lamports) exceeds safe integer precision. Reduce amountPerCycle or totalCycles.` };
            }

            log(`[Jupiter DCA] Creating: ${input.amountPerCycle} ${inputToken.symbol} → ${outputToken.symbol}, ${input.cycleInterval} x${numberOfOrders}`, 'INFO');
            const reqBody = {
                user: walletAddress,
                inputMint: inputToken.address,
                outputMint: outputToken.address,
                params: {
                    time: {
                        inAmount: inAmountNum,  // Jupiter API requires number, not string
                        numberOfOrders: numberOfOrders,
                        interval: cycleIntervalSeconds,
                    }
                },
            };

            // No retry for createOrder — non-idempotent POST could create duplicates
            const res = await httpRequest({
                hostname: 'api.jup.ag',
                path: '/recurring/v1/createOrder',
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    'x-api-key': config.jupiterApiKey
                }
            }, reqBody);

            if (res.status !== 200) {
                return { error: `Jupiter API error: ${res.status}`, details: res.data };
            }

            const data = typeof res.data === 'string' ? JSON.parse(res.data) : res.data;
            if (!data.transaction) return { error: 'Jupiter did not return a transaction' };
            if (!data.requestId) return { error: 'Jupiter did not return a requestId' };

            // 6. Verify transaction (user is fee payer for DCA orders)
            try {
                const verification = verifySwapTransaction(data.transaction, walletAddress);
                if (!verification.valid) {
                    log(`[Jupiter DCA] Tx verification FAILED: ${verification.error}`, 'ERROR');
                    return { error: `Transaction rejected: ${verification.error}` };
                }
                log('[Jupiter DCA] Tx verified — programs OK', 'DEBUG');
            } catch (verifyErr) {
                log(`[Jupiter DCA] Tx verification error: ${verifyErr.message}`, 'WARN');
                return { error: `Could not verify transaction: ${verifyErr.message}` };
            }

            // BAT-1013 contract v8.3 (per Codex review): Jupiter Recurring
            // createOrder response does NOT include the DCA position account
            // pubkey before sign (orderId only surfaces on execResult after
            // broadcast). Without a verified deposit destination, autonomous
            // burner signing cannot prove the burner's debit lands in a
            // DCA-controlled account vs an attacker-controlled token account.
            // Per Codex: route DCA create to main wallet (MWA popup) until
            // the equivalent destination assertion is implemented as
            // follow-up work (BAT-XXXX: derive DCA position account from
            // tx instruction set or scan simulation pre-snapshot for
            // accounts owned by DCA265Vj8a9CEuX1eb1LWRnDT7uK6q1xMipnNyatn23M).
            const dcaForceRouting = { routingDecision: 'main' };
            log('[Jupiter DCA] Autonomous burner unsupported for DCA create until vault discovery ships — routing to main wallet', 'INFO');

            // 7 + 8. Sign + execute via wallet dispatch.
            const dispatchResult = await routeAndSign({
                toolName: 'jupiter_dca_create',
                toolArgs: input,
                unsignedTxBase64: data.transaction,
                broadcastVia: 'jupiter',
                flowName: 'jupiter_dca_create',
                expectedDelta: null,
                forceRouting: dcaForceRouting,
                broadcast: async (txOrUnsigned, _signer, ctx) => {
                    let signedTx;
                    if (ctx && ctx.signed) {
                        signedTx = txOrUnsigned;
                    } else {
                        await ensureWalletAuthorized();
                        log('[Jupiter DCA] Sending to wallet for approval (sign-only)...', 'INFO');
                        const signResult = await androidBridgeCall('/solana/sign-only', { transaction: txOrUnsigned }, 120000);
                        if (signResult.error) return { error: 'sign_failed', reason: signResult.error };
                        if (!signResult.signedTransaction) return { error: 'sign_failed', reason: 'no signed tx returned from wallet' };
                        signedTx = signResult.signedTransaction;
                    }
                    log('[Jupiter DCA] Executing signed transaction...', 'INFO');
                    const ex = await jupiterRecurringExecute(signedTx, data.requestId);
                    if (ex.status === 'Failed') {
                        return { error: 'execute_failed', reason: ex.error || 'Jupiter Recurring rejected' };
                    }
                    if (!ex.signature) return { error: 'execute_failed', reason: 'no signature in Recurring response' };
                    return { signature: ex.signature, recurring: ex };
                },
            });

            if (!dispatchResult.ok) {
                return { error: dispatchResult.error, reason: dispatchResult.reason };
            }
            const execResult = (dispatchResult.broadcastResult && dispatchResult.broadcastResult.recurring) || { signature: dispatchResult.signature };

            // BAT-582 Phase 5: record ownership AFTER successful broadcast.
            const orderId = execResult.order || execResult.orderId || null;
            if (orderId) {
                await recordJupiterOwnership(orderId, dispatchResult.wallet, 'jupiter_dca_create');
            } else {
                log('[Jupiter DCA] No orderId in execute response \u2014 ownership not recorded', 'WARN');
            }

            const warnings = [];
            if (inputToken.warning) warnings.push(`\u26A0\uFE0F ${inputToken.symbol}: ${inputToken.warning}`);
            if (outputToken.warning) warnings.push(`\u26A0\uFE0F ${outputToken.symbol}: ${outputToken.warning}`);

            return {
                success: true,
                orderId,
                signature: execResult.signature,
                inputToken: `${inputToken.symbol} (${inputToken.address})`,
                outputToken: `${outputToken.symbol} (${outputToken.address})`,
                amountPerCycle: input.amountPerCycle,
                cycleInterval: input.cycleInterval,
                totalCycles: numberOfOrders,
                wallet: dispatchResult.wallet,
                warnings: warnings.length > 0 ? warnings : undefined
            };
        } catch (e) {
            return { error: e.message };
        }
    },

    async jupiter_dca_list(input, chatId) {
        if (!config.jupiterApiKey) {
            return {
                error: 'Jupiter API key required',
                guide: 'Get a free API key at portal.jup.ag, then add it in SeekerClaw Settings > Configuration > Jupiter API Key'
            };
        }

        try {
            // 1. Get wallet address
            let walletAddress;
            try {
                walletAddress = getConnectedWalletAddress();
            } catch (e) {
                return { error: e.message };
            }

            // 2. Validate input against schema
            if (input.status !== undefined && input.status !== null) {
                const allowedStatuses = ['active', 'history'];
                if (!allowedStatuses.includes(input.status)) {
                    return {
                        error: 'Invalid status for jupiter_dca_list',
                        details: 'status must be either "active" or "history"'
                    };
                }
            }
            if (input.page !== undefined && input.page !== null) {
                const pageNum = Number(input.page);
                if (!Number.isInteger(pageNum) || pageNum <= 0) {
                    return {
                        error: 'Invalid page for jupiter_dca_list',
                        details: 'page must be a positive integer'
                    };
                }
            }

            // 3. Build query params
            const params = new URLSearchParams({ user: walletAddress, recurringType: 'time' });
            if (input.status) {
                params.append('orderStatus', input.status);
            }
            if (input.page !== undefined && input.page !== null) {
                params.append('page', String(Number(input.page)));
            }

            // 4. Call Jupiter Recurring API
            const res = await jupiterRequest({
                hostname: 'api.jup.ag',
                path: `/recurring/v1/getRecurringOrders?${params.toString()}`,
                method: 'GET',
                headers: {
                    'x-api-key': config.jupiterApiKey
                }
            });

            if (res.status !== 200) {
                return { error: `Jupiter API error: ${res.status}`, details: res.data };
            }

            const data = typeof res.data === 'string' ? JSON.parse(res.data) : res.data;
            const orders = data.orders || [];

            // Helper to convert seconds to human-readable interval
            const formatCycleInterval = (seconds) => {
                if (seconds === 3600) return 'hourly';
                if (seconds === 86400) return 'daily';
                if (seconds === 604800) return 'weekly';
                // Fallback for custom intervals
                if (seconds < 3600) return `${seconds / 60} minutes`;
                if (seconds < 86400) return `${seconds / 3600} hours`;
                return `${seconds / 86400} days`;
            };

            return {
                success: true,
                count: orders.length,
                orders: orders.map(order => ({
                    orderId: order.orderId,
                    inputToken: order.inputMint,
                    outputToken: order.outputMint,
                    inputAmount: order.inputAmount,
                    cycleInterval: formatCycleInterval(order.cycleInterval),
                    totalCycles: order.totalCycles || 'Unlimited',
                    completedCycles: order.completedCycles || 0,
                    status: order.status,
                    nextExecutionTime: order.nextExecutionTime,
                    createdAt: order.createdAt
                }))
            };
        } catch (e) {
            return { error: e.message };
        }
    },

    async jupiter_dca_cancel(input, chatId) {
        if (!config.jupiterApiKey) {
            return {
                error: 'Jupiter API key required',
                guide: 'Get a free API key at portal.jup.ag, then add it in SeekerClaw Settings > Configuration > Jupiter API Key'
            };
        }

        try {
            // 1. Validate required input
            if (!input.orderId || String(input.orderId).trim() === '') {
                return { error: 'orderId is required' };
            }

            // BAT-582 Phase 5: route by creator role (same pattern as
            // jupiter_trigger_cancel — see that handler for full
            // discussion). Cancels are ownership-gated: burner-owned
            // signs silently via burner; main/unknown-owned uses MWA.
            let creatorRole = 'unknown';
            try {
                const lookup = await androidBridgeCall(
                    '/jupiter/order-owner/get',
                    { orderId: input.orderId },
                    5000,
                );
                if (lookup && !lookup.error && (lookup.creatorWalletRole === 'burner' || lookup.creatorWalletRole === 'main')) {
                    creatorRole = lookup.creatorWalletRole;
                }
            } catch (_) { /* fall back to unknown → MWA path */ }

            // 2. Get wallet address — burner pubkey if creator was burner.
            let walletAddress;
            if (creatorRole === 'burner') {
                try {
                    const burnerStatus = await androidBridgeCall('/burner/status', {}, 5000);
                    if (burnerStatus && !burnerStatus.error && burnerStatus.configured && burnerStatus.pubkey) {
                        walletAddress = burnerStatus.pubkey;
                    }
                } catch (_) { /* fall through to MWA path */ }
                if (!walletAddress) {
                    log('[Jupiter DCA] burner-owned cancel but burner pubkey unavailable — falling back to MWA path', 'WARN');
                    creatorRole = 'main';
                }
            }
            if (!walletAddress) {
                try {
                    walletAddress = getConnectedWalletAddress();
                } catch (e) {
                    return { error: e.message };
                }
            }

            // 3. Call Jupiter Recurring API — cancelOrder (no retry — non-idempotent POST)
            log(`[Jupiter DCA] Cancelling order: ${input.orderId} (creator=${creatorRole})`, 'INFO');
            const res = await httpRequest({
                hostname: 'api.jup.ag',
                path: '/recurring/v1/cancelOrder',
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    'x-api-key': config.jupiterApiKey
                }
            }, {
                user: walletAddress,
                order: input.orderId,
                recurringType: 'time',
            });

            if (res.status !== 200) {
                return { error: `Jupiter API error: ${res.status}`, details: res.data };
            }

            const data = typeof res.data === 'string' ? JSON.parse(res.data) : res.data;
            if (!data.transaction) return { error: 'Jupiter did not return a transaction' };
            if (!data.requestId) return { error: 'Jupiter did not return a requestId' };

            // 4. Verify transaction (user is fee payer for DCA cancels)
            try {
                const verification = verifySwapTransaction(data.transaction, walletAddress);
                if (!verification.valid) return { error: `Transaction rejected: ${verification.error}` };
            } catch (e) {
                return { error: `Could not verify transaction: ${e.message}` };
            }

            // 5 + 6. Sign + execute. Burner → silent. Main/unknown → MWA.
            const broadcastFn = async (signedTx) => {
                log('[Jupiter DCA] Executing cancel transaction...', 'INFO');
                const ex = await jupiterRecurringExecute(signedTx, data.requestId);
                if (ex.status === 'Failed') {
                    return { error: 'execute_failed', reason: ex.error || 'Jupiter Recurring rejected' };
                }
                if (!ex.signature) return { error: 'execute_failed', reason: 'no signature in Recurring response' };
                return { signature: ex.signature };
            };

            let dispatchResult;
            if (creatorRole === 'burner') {
                dispatchResult = await signCancelViaBurner({
                    unsignedTxBase64: data.transaction,
                    flowName: 'jupiter_dca_cancel',
                    broadcast: async (signedTx) => broadcastFn(signedTx),
                });
            } else {
                await ensureWalletAuthorized();
                log('[Jupiter DCA] Sending cancel tx to wallet for approval...', 'INFO');
                const signResult = await androidBridgeCall('/solana/sign-only', {
                    transaction: data.transaction,
                }, 120000);
                if (signResult.error) {
                    return { error: signResult.error };
                }
                if (!signResult.signedTransaction) {
                    return { error: 'No signed transaction returned from wallet' };
                }
                const broadcast = await broadcastFn(signResult.signedTransaction);
                if (broadcast.error) {
                    return { error: broadcast.reason || broadcast.error };
                }
                dispatchResult = { ok: true, wallet: 'main', signature: broadcast.signature };
            }

            if (!dispatchResult.ok) {
                return { error: dispatchResult.error || 'cancel_failed', reason: dispatchResult.reason };
            }

            return {
                success: true,
                orderId: input.orderId,
                signature: dispatchResult.signature,
                status: 'cancelled',
                wallet: dispatchResult.wallet,
                creatorRole,
            };
        } catch (e) {
            return { error: e.message };
        }
    },

    async jupiter_token_search(input, chatId) {
        if (!config.jupiterApiKey) {
            return {
                error: 'Jupiter API key required',
                guide: 'Get a free API key at portal.jup.ag, then add it in SeekerClaw Settings > Configuration > Jupiter API Key'
            };
        }

        try {
            const DEFAULT_LIMIT = 10;
            const MAX_LIMIT = 100;

            // Validate and normalize query
            const rawQuery = typeof input.query === 'string' ? input.query.trim() : '';
            if (!rawQuery) {
                return {
                    error: 'Token search query is required',
                    details: 'Provide a non-empty search query, for example a token symbol, name, or address.'
                };
            }

            // Validate and normalize limit
            let limit = DEFAULT_LIMIT;
            if (input.limit !== undefined && input.limit !== null) {
                const parsedLimit = Number(input.limit);
                if (Number.isFinite(parsedLimit) && parsedLimit > 0) {
                    // Use an integer limit and cap to MAX_LIMIT
                    const normalizedLimit = Math.floor(parsedLimit);
                    limit = Math.min(normalizedLimit, MAX_LIMIT);
                }
            }

            // Build query params with validated values
            const params = new URLSearchParams({ query: rawQuery, limit: limit.toString() });

            // Call Jupiter Tokens API
            const res = await jupiterRequest({
                hostname: 'api.jup.ag',
                path: `/tokens/v2/search?${params.toString()}`,
                method: 'GET',
                headers: {
                    'x-api-key': config.jupiterApiKey
                }
            });

            if (res.status !== 200) {
                return { error: `Jupiter API error: ${res.status}`, details: res.data };
            }

            const data = typeof res.data === 'string' ? JSON.parse(res.data) : res.data;
            // Jupiter Tokens v2 returns flat array, not {tokens: [...]}
            const tokens = Array.isArray(data) ? data : (data.tokens || []);

            return {
                success: true,
                count: tokens.length,
                tokens: tokens.map(token => {
                    // Normalize v2 field names: id->address, usdPrice->price, mcap->marketCap, isVerified->verified
                    const mint = token.id || token.address;
                    const usdPrice = token.usdPrice ?? token.price ?? null;
                    const mCap = token.mcap ?? token.marketCap ?? null;
                    const entry = {
                        symbol: token.symbol,
                        name: token.name,
                        address: mint,
                        decimals: token.decimals,
                        price: (usdPrice !== null && usdPrice !== undefined) ? `$${usdPrice}` : 'N/A',
                        marketCap: (mCap !== null && mCap !== undefined) ? `$${(mCap / 1e6).toFixed(2)}M` : 'N/A',
                        liquidity: (token.liquidity !== null && token.liquidity !== undefined) ? `$${(token.liquidity / 1e6).toFixed(2)}M` : 'N/A',
                        verified: token.isVerified ?? token.verified ?? false,
                    };
                    // Surface organicScore and isSus from Tokens v2 API
                    if (token.organicScore !== undefined) entry.organicScore = token.organicScore;
                    if (token.audit?.isSus !== undefined) entry.isSus = token.audit.isSus;
                    if (token.audit?.isSus) entry.warning = '\u26A0\uFE0F SUSPICIOUS — This token is flagged as suspicious by Jupiter audit.';
                    return entry;
                })
            };
        } catch (e) {
            return { error: e.message };
        }
    },

    async jupiter_token_security(input, chatId) {
        if (!config.jupiterApiKey) {
            return {
                error: 'Jupiter API key required',
                guide: 'Get a free API key at portal.jup.ag, then add it in SeekerClaw Settings > Configuration > Jupiter API Key'
            };
        }

        try {
            // Resolve token to get mint address
            const token = await resolveToken(input.token);
            if (!token || token.ambiguous) {
                return {
                    error: 'Could not resolve token',
                    details: token?.ambiguous
                        ? `Multiple tokens match "${input.token}". Please use the full mint address.`
                        : `Token "${input.token}" not found.`
                };
            }

            // Call Jupiter Shield API
            const params = new URLSearchParams({ mints: token.address });
            const res = await jupiterRequest({
                hostname: 'api.jup.ag',
                path: `/ultra/v1/shield?${params.toString()}`,
                method: 'GET',
                headers: {
                    'x-api-key': config.jupiterApiKey
                }
            });

            if (res.status !== 200) {
                return { error: `Jupiter API error: ${res.status}`, details: res.data };
            }

            const data = typeof res.data === 'string' ? JSON.parse(res.data) : res.data;
            const tokenData = data[token.address] || {};
            const warnings = [];
            if (tokenData.freezeAuthority) warnings.push('\u2744\uFE0F FREEZE RISK - Token has freeze authority enabled');
            if (tokenData.mintAuthority) warnings.push('\uD83C\uDFED MINT RISK - Token has mint authority (can inflate supply)');
            if (tokenData.hasLowLiquidity) warnings.push('\uD83D\uDCA7 LOW LIQUIDITY - May be difficult to trade');

            // Fetch organicScore and isSus from Tokens v2 API
            let organicScore = null;
            let isSus = null;
            try {
                const tokenParams = new URLSearchParams({ query: token.address, limit: '1' });
                const tokenRes = await jupiterRequest({
                    hostname: 'api.jup.ag',
                    path: `/tokens/v2/search?${tokenParams.toString()}`,
                    method: 'GET',
                    headers: { 'x-api-key': config.jupiterApiKey }
                });
                if (tokenRes.status === 200) {
                    const tokenInfo = (typeof tokenRes.data === 'string' ? JSON.parse(tokenRes.data) : tokenRes.data);
                    // Tokens v2 API may return a flat array or { tokens: [...] }
                    const tokenArr = Array.isArray(tokenInfo) ? tokenInfo : (tokenInfo.tokens || []);
                    const match = tokenArr[0];
                    if (match) {
                        organicScore = match.organicScore ?? null;
                        isSus = match.audit?.isSus ?? null;
                    }
                }
            } catch (e) {
                log(`[Jupiter Security] Tokens v2 lookup skipped: ${e.message}`, 'DEBUG');
            }

            if (isSus) warnings.push('\uD83D\uDEA8 SUSPICIOUS — Token flagged as suspicious by Jupiter audit');

            const result = {
                success: true,
                token: `${token.symbol} (${token.address})`,
                isSafe: warnings.length === 0,
                warnings: warnings.length > 0 ? warnings : ['\u2705 No security warnings detected'],
                details: {
                    freezeAuthority: tokenData.freezeAuthority || false,
                    mintAuthority: tokenData.mintAuthority || false,
                    hasLowLiquidity: tokenData.hasLowLiquidity || false,
                    verified: tokenData.verified || false,
                }
            };
            if (organicScore !== null) result.organicScore = organicScore;
            if (isSus !== null) result.isSus = isSus;
            return result;
        } catch (e) {
            return { error: e.message };
        }
    },

    async jupiter_wallet_holdings(input, chatId) {
        if (!config.jupiterApiKey) {
            return {
                error: 'Jupiter API key required',
                guide: 'Get a free API key at portal.jup.ag, then add it in SeekerClaw Settings > Configuration > Jupiter API Key'
            };
        }

        try {
            // Get wallet address (align with schema: use `address` not `wallet`)
            let walletAddress = input.address;
            if (!walletAddress) {
                try {
                    walletAddress = getConnectedWalletAddress();
                } catch (e) {
                    return { error: e.message };
                }
            }

            // Validate wallet address before using in URL path
            if (!isValidSolanaAddress(walletAddress)) {
                return {
                    error: 'Invalid Solana wallet address',
                    details: `Address "${walletAddress}" is not a valid base58-encoded Solana public key.`
                };
            }

            // Call Jupiter Holdings API
            const res = await jupiterRequest({
                hostname: 'api.jup.ag',
                path: `/ultra/v1/holdings/${walletAddress}`,
                method: 'GET',
                headers: {
                    'x-api-key': config.jupiterApiKey
                }
            });

            if (res.status !== 200) {
                return { error: `Jupiter API error: ${res.status}`, details: res.data };
            }

            const data = typeof res.data === 'string' ? JSON.parse(res.data) : res.data;
            const holdings = data.holdings || [];
            const totalValue = holdings.reduce((sum, h) => sum + (h.valueUsd || 0), 0);

            return {
                success: true,
                wallet: walletAddress,
                totalValueUsd: `$${totalValue.toFixed(2)}`,
                count: holdings.length,
                holdings: holdings.map(holding => ({
                    symbol: holding.symbol,
                    name: holding.name,
                    address: holding.mint,
                    balance: holding.balance,
                    decimals: holding.decimals,
                    valueUsd: `$${(holding.valueUsd || 0).toFixed(2)}`,
                    price: (holding.price !== null && holding.price !== undefined) ? `$${holding.price}` : 'N/A'
                }))
            };
        } catch (e) {
            return { error: e.message };
        }
    },

    async solana_nft_holdings(input, chatId) {
        if (!config.heliusApiKey) {
            return {
                error: 'Helius API key required',
                guide: 'Get a free API key at helius.dev (50k requests/day free tier), then add it in SeekerClaw Settings > Solana Wallet > Helius API Key'
            };
        }

        let walletAddress = input.address;
        if (!walletAddress) {
            try {
                walletAddress = getConnectedWalletAddress();
            } catch (e) {
                return { error: e.message };
            }
        }
        if (!isValidSolanaAddress(walletAddress)) {
            return { error: 'Invalid Solana wallet address', details: `Address "${walletAddress}" is not a valid base58 Solana public key.` };
        }

        try {
            const dasResult = await heliusDasRequest('getAssetsByOwner', {
                ownerAddress: walletAddress,
                page: 1,
                limit: 100,
                displayOptions: {
                    showCollectionMetadata: true,
                    showFungible: false,
                }
            });

            if (dasResult.error) {
                return { error: dasResult.error };
            }

            const NFT_INTERFACES = ['V1_NFT', 'V2_NFT', 'ProgrammableNFT', 'MplCoreAsset'];
            const allItems = dasResult.items || [];
            const nfts = allItems.filter(item =>
                NFT_INTERFACES.includes(item.interface) ||
                (item.compression && item.compression.compressed)
            );

            const formatted = nfts.slice(0, 100).map(nft => {
                const isCompressed = nft.compression?.compressed ?? false;
                return {
                    name: nft.content?.metadata?.name ?? 'Unknown',
                    collection: nft.grouping?.find(g => g.group_key === 'collection')?.group_value ?? null,
                    collectionName: nft.content?.metadata?.collection?.name ??
                                   nft.grouping?.find(g => g.group_key === 'collection')?.collection_metadata?.name ?? null,
                    assetId: nft.id,
                    mint: isCompressed ? null : nft.id,
                    image: nft.content?.links?.image ?? nft.content?.files?.[0]?.uri ?? null,
                    compressed: isCompressed,
                };
            });

            const total = Number.isFinite(dasResult.total) ? dasResult.total : formatted.length;

            return {
                success: true,
                wallet: walletAddress,
                count: total,
                returned: formatted.length,
                nfts: formatted,
            };
        } catch (e) {
            return { error: e.message };
        }
    },
};

module.exports = { tools, handlers, _setNumberToDecimalString, _inferTriggerMint, _extractFeePayerBase58 };
