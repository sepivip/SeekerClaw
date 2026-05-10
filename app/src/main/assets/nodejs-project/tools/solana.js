// tools/solana.js — all solana_* and jupiter_* tool handlers

const fs = require('fs');
const path = require('path');

const {
    workDir, log, config,
} = require('../config');

const { androidBridgeCall } = require('../bridge');

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
    recordJupiterOwnership,
} = require('../wallet/dispatch');

// BAT-255: Safe number-to-decimal-string conversion (imported from index.js shared state)
let numberToDecimalString;
function _setNumberToDecimalString(fn) { numberToDecimalString = fn; }

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
        description: 'Send SOL to a Solana address. **Routing (BAT-582)**: under burner per-tx + daily SOL caps -> signs silently from the **Burner wallet** (no popup); over cap or burner not configured -> prompts the **Main wallet** for approval (MWA popup). ALWAYS confirm with the user in chat before calling this tool.',
        input_schema: {
            type: 'object',
            properties: {
                to: { type: 'string', description: 'Recipient Solana address (base58)' },
                amount: { type: 'number', description: 'Amount of SOL to send' }
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
    {
        name: 'jupiter_trigger_create',
        description: 'Create a trigger (limit) order on Jupiter. Requires Jupiter API key (get free at portal.jup.ag). Order executes automatically when price condition is met. Use for: buy at lower price (limit buy) or sell at higher price (limit sell). **Routing (BAT-582)**: under burner caps -> silent burner sign; over cap or burner not configured -> Main wallet popup.',
        input_schema: {
            type: 'object',
            properties: {
                inputToken: { type: 'string', description: 'Token to sell — symbol (e.g., "SOL") or mint address' },
                outputToken: { type: 'string', description: 'Token to buy — symbol (e.g., "USDC") or mint address' },
                inputAmount: { type: 'number', description: 'Amount of inputToken to sell (in human units)' },
                triggerPrice: { type: 'number', description: 'Price at which order triggers (outputToken per inputToken, e.g., 90 means 1 SOL = 90 USDC)' },
                expiryTime: { type: 'number', description: 'Order expiration timestamp (Unix seconds). Optional, defaults to 30 days from now.' }
            },
            required: ['inputToken', 'outputToken', 'inputAmount', 'triggerPrice']
        }
    },
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
        // BAT-582 Phase 5: route through wallet dispatch so a configured
        // burner wallet can sign autonomously when under cap, and the
        // main MWA flow stays the fallback for over-cap or uncapped assets.
        // Behavior when burner is unconfigured matches v1.0 exactly: MWA
        // popup via /solana/sign.
        let from;
        try {
            from = getConnectedWalletAddress();
        } catch (e) {
            // Main wallet not connected — burner can still sign on its own
            // pubkey if configured, but the existing tool semantics are
            // "send FROM the connected wallet". Burner-as-source is a
            // future-Phase change (Phase 5 keeps the MWA-from semantics
            // even on the burner path: agent signs as the burner, but the
            // tx pays from the burner's address — the burner pubkey IS
            // the from address in that case).
            //
            // For Phase 5: if main wallet isn't connected and burner is
            // configured, surface the clearer error from the bridge after
            // routeAndSign returns. Don't pre-fail here.
            from = null;
        }
        const to = input.to;
        const amount = input.amount;

        if (!to || !amount || amount <= 0) {
            return { error: 'Both "to" address and a positive "amount" are required.' };
        }

        // Step 1: Get latest blockhash (shared by both wallets — RPC call,
        // no signer required).
        const blockhashResult = await solanaRpc('getLatestBlockhash', [{ commitment: 'finalized' }]);
        if (blockhashResult.error) return { error: 'Failed to get blockhash: ' + blockhashResult.error };
        const recentBlockhash = blockhashResult.blockhash || (blockhashResult.value && blockhashResult.value.blockhash);
        if (!recentBlockhash) return { error: 'No blockhash returned from RPC' };

        // Step 2: Determine the source address. Burner pubkey if routing
        // says burner; otherwise the connected MWA wallet.
        // We need the source BEFORE building the tx because Solana
        // transactions encode the fee payer in the message.
        // routeFor decides routing based on amount + caps; we read it once
        // here and reuse the decision for the broadcast path so the source
        // matches the signer.
        const { routeFor } = require('../caps/preflight');
        const routingHint = await routeFor('solana_send', input);
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
        const result = await routeAndSign({
            toolName: 'solana_send',
            toolArgs: input,
            unsignedTxBase64: txBase64,
            broadcastVia: 'rpc',
            flowName: 'solana_send',
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

            const result = await routeAndSign({
                toolName: 'solana_swap',
                toolArgs: input,
                unsignedTxBase64: order.transaction,
                broadcastVia: ULTRA_RPC_HINT,
                flowName: 'solana_swap',
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

            // 7 + 8. Sign + execute via wallet dispatch.
            const dispatchResult = await routeAndSign({
                toolName: 'jupiter_dca_create',
                toolArgs: input,
                unsignedTxBase64: data.transaction,
                broadcastVia: 'jupiter',
                flowName: 'jupiter_dca_create',
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

module.exports = { tools, handlers, _setNumberToDecimalString };
