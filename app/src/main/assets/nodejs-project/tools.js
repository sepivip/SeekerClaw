// tools.js — Tool Definitions + executeTool() Dispatch (BAT-204)
// Extracted from main.js as part of the modular refactor (BAT-192)

const fs = require('fs');
const path = require('path');

// ── Imports from other SeekerClaw modules ──────────────────────────────────

const {
    workDir, config, log, localTimestamp, localDateStr,
    AGENT_NAME, MODEL, SECRETS_BLOCKED, SKILLS_DIR, SHELL_ALLOWLIST,
    syncAgentApiKeys,
} = require('./config');

const {
    safePath, detectSuspiciousPatterns,
    wrapExternalContent, wrapSearchResults,
} = require('./security');

const { androidBridgeCall } = require('./bridge');

const {
    loadMemory, saveMemory, appendDailyMemory, searchMemory,
} = require('./memory');

const {
    cronService, parseTimeExpression, formatDuration,
} = require('./cron');

const { getDb, indexMemoryFiles } = require('./database');

const {
    solanaRpc, base58Encode, buildSolTransferTx,
    resolveToken, jupiterQuote, jupiterPrice,
    jupiterUltraOrder, jupiterUltraExecute,
    jupiterTriggerExecute, jupiterRecurringExecute,
    verifySwapTransaction, jupiterRequest,
    isValidSolanaAddress, parseInputAmountToLamports,
    ensureWalletAuthorized, getConnectedWalletAddress,
    refreshJupiterProgramLabels,
} = require('./solana');

const {
    httpRequest, cacheGet, cacheSet,
    htmlToMarkdown, BRAVE_FRESHNESS_VALUES,
    searchBrave, searchPerplexity, searchDDG, searchDDGLite,
    webFetch,
} = require('./web');

const {
    telegram, telegramSendFile, detectTelegramFileType,
    cleanResponse, toTelegramHtml,
    recordSentMessage, sendMessage,
} = require('./telegram');

const { visionAnalyzeImage, conversations } = require('./claude');

const { loadSkills, parseSkillFile } = require('./skills');

// ── Injected dependencies (set from main.js at startup) ───────────────────
// mcpManager singleton lives in main.js; injected to route mcp__* tools.

let _mcpExecuteTool = null;

function setMcpExecuteTool(fn) {
    _mcpExecuteTool = fn;
}

const pendingConfirmations = new Map(); // chatId -> { resolve, timer }
const lastToolUseTime = new Map();      // toolName -> timestamp

// BAT-255: Safe number-to-decimal-string conversion.
// String(0.0000001) → "1e-7" but we need "0.0000001" for parseInputAmountToLamports.
function numberToDecimalString(n) {
    const s = String(n);
    if (!s.includes('e') && !s.includes('E')) return s;
    return n.toFixed(20).replace(/\.?0+$/, '');
}

// Format a human-readable confirmation message for the user
function formatConfirmationMessage(toolName, input) {
    const esc = (s) => {
        let v = String(s ?? '');
        if (v.length > 200) v = v.slice(0, 197) + '...';
        return v.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
    };
    let details;
    switch (toolName) {
        case 'android_sms':
            details = `\u{1F4F1} <b>Send SMS</b>\n  To: <code>${esc(input.phone)}</code>\n  Message: "${esc(input.message)}"`;
            break;
        case 'android_call':
            details = `\u{1F4DE} <b>Make Phone Call</b>\n  To: <code>${esc(input.phone)}</code>`;
            break;
        case 'solana_send':
            details = `\u{1F4B8} <b>Send SOL</b>\n  To: <code>${esc(input.to)}</code>\n  Amount: ${esc(input.amount)} SOL`;
            break;
        case 'solana_swap':
            details = `\u{1F504} <b>Swap Tokens</b>\n  Sell: ${esc(input.amount)} ${esc(input.inputToken)}\n  Buy: ${esc(input.outputToken)}`;
            break;
        case 'jupiter_trigger_create':
            details = `\u{1F4CA} <b>Create Trigger Order</b>\n  Sell: ${esc(input.inputAmount)} ${esc(input.inputToken)}\n  For: ${esc(input.outputToken)}\n  Trigger price: ${esc(input.triggerPrice)}`;
            break;
        case 'jupiter_dca_create':
            details = `\u{1F504} <b>Create DCA Order</b>\n  ${esc(input.amountPerCycle)} ${esc(input.inputToken)} \u{2192} ${esc(input.outputToken)}\n  Every: ${esc(input.cycleInterval)}\n  Cycles: ${input.totalCycles != null ? esc(String(input.totalCycles)) : '30 (default)'}\n  Total deposit: ${esc(input.amountPerCycle * (input.totalCycles || 30))} ${esc(input.inputToken)}`;
            break;
        default:
            details = `<b>${esc(toolName)}</b>`;
    }
    return `\u{26A0}\u{FE0F} <b>Action requires confirmation:</b>\n\n${details}\n\nReply <b>YES</b> to proceed or anything else to cancel.\n<i>(Auto-cancels in 60s)</i>`;
}

// Send confirmation message and wait for user reply (Promise-based)
function requestConfirmation(chatId, toolName, input) {
    const msg = formatConfirmationMessage(toolName, input);
    return new Promise((resolve) => {
        const timer = setTimeout(() => {
            pendingConfirmations.delete(chatId);
            log(`[Confirm] Timeout for ${toolName} in chat ${chatId}`, 'INFO');
            resolve(false);
        }, 60000);
        // Register BEFORE sending to prevent race where fast reply arrives
        // before pendingConfirmations is set (would be enqueued as normal message)
        pendingConfirmations.set(chatId, {
            resolve: (confirmed) => {
                clearTimeout(timer);
                resolve(confirmed);
            },
            timer,
            toolName,
        });
        log(`[Confirm] Awaiting confirmation for ${toolName} in chat ${chatId}`, 'DEBUG');
        telegram('sendMessage', {
            chat_id: chatId,
            text: msg,
            parse_mode: 'HTML',
            disable_notification: false,
        }).then((result) => {
            if (result && result.ok === false) {
                log(`[Confirm] Telegram rejected confirmation message: ${JSON.stringify(result).slice(0, 200)}`, 'WARN');
                pendingConfirmations.delete(chatId);
                clearTimeout(timer);
                resolve(false);
            }
            // Note: confirmation messages are NOT recorded in sentMessageCache — they are
            // transient system UI, not user content that should appear in "Recent Sent Messages"
        }).catch((err) => {
            log(`[Confirm] Failed to send confirmation message: ${err.message}`, 'ERROR');
            pendingConfirmations.delete(chatId);
            clearTimeout(timer);
            resolve(false);
        });
    });
}

// ============================================================================
// TOOLS
// ============================================================================

const TOOLS = [
    {
        name: 'web_search',
        description: 'Search the web for current information. Works out of the box with DuckDuckGo (no API key). Automatically uses Brave if its API key is configured (better quality). Perplexity Sonar available for AI-synthesized answers with citations.',
        input_schema: {
            type: 'object',
            properties: {
                query: { type: 'string', description: 'The search query' },
                provider: { type: 'string', enum: ['auto', 'brave', 'duckduckgo', 'perplexity'], description: 'Search provider. Default: auto (Brave if key configured, else DuckDuckGo). Use perplexity for complex questions needing synthesized answers.' },
                count: { type: 'number', description: 'Number of results (brave/duckduckgo, 1-10, default 5)' },
                freshness: { type: 'string', enum: ['day', 'week', 'month'], description: 'Freshness filter. Brave: filters by discovery time. Perplexity: sets search_recency_filter. Not supported by DuckDuckGo.' }
            },
            required: ['query']
        }
    },
    {
        name: 'web_fetch',
        description: 'Fetch a URL with full HTTP support. Returns markdown (HTML), JSON, or text. Supports custom headers (Bearer auth), methods (POST/PUT/DELETE), and request bodies for authenticated API calls.',
        input_schema: {
            type: 'object',
            properties: {
                url: { type: 'string', description: 'The URL to fetch' },
                method: { type: 'string', enum: ['GET', 'POST', 'PUT', 'DELETE'], description: 'HTTP method (default: GET)' },
                headers: { type: 'object', description: 'Custom HTTP headers (e.g. {"Authorization": "Bearer sk-..."})' },
                body: { type: ['string', 'object'], description: 'Request body for POST/PUT. String or JSON object.' },
                raw: { type: 'boolean', description: 'If true, return raw text without markdown conversion' }
            },
            required: ['url']
        }
    },
    {
        name: 'memory_save',
        description: 'Save important information to long-term memory (MEMORY.md). Use this to remember facts, preferences, or important details about the user.',
        input_schema: {
            type: 'object',
            properties: {
                content: { type: 'string', description: 'The content to save to memory' }
            },
            required: ['content']
        }
    },
    {
        name: 'memory_read',
        description: 'Read the current contents of long-term memory.',
        input_schema: {
            type: 'object',
            properties: {}
        }
    },
    {
        name: 'daily_note',
        description: 'Add a note to today\'s daily memory file. Use this for logging events, conversations, or daily observations.',
        input_schema: {
            type: 'object',
            properties: {
                note: { type: 'string', description: 'The note to add' }
            },
            required: ['note']
        }
    },
    {
        name: 'memory_search',
        description: 'Search your SQL.js database (seekerclaw.db) for memory content. All memory files are indexed into searchable chunks — this performs ranked keyword search with recency weighting, returning top matches with file paths and line numbers.',
        input_schema: {
            type: 'object',
            properties: {
                query: { type: 'string', description: 'Search term or pattern to find' },
                max_results: { type: 'number', description: 'Maximum results to return (default 10)' }
            },
            required: ['query']
        }
    },
    {
        name: 'memory_get',
        description: 'Get specific lines from a memory file by line number. Use after memory_search to retrieve full context.',
        input_schema: {
            type: 'object',
            properties: {
                file: { type: 'string', description: 'File path relative to workspace (e.g., "MEMORY.md" or "memory/2024-01-15.md")' },
                start_line: { type: 'number', description: 'Starting line number (1-indexed)' },
                end_line: { type: 'number', description: 'Ending line number (optional, defaults to start_line + 10)' }
            },
            required: ['file', 'start_line']
        }
    },
    {
        name: 'read',
        description: 'Read a file from the workspace directory. Only files within workspace/ can be read.',
        input_schema: {
            type: 'object',
            properties: {
                path: { type: 'string', description: 'File path relative to workspace (e.g., "notes.txt", "data/results.json")' }
            },
            required: ['path']
        }
    },
    {
        name: 'write',
        description: 'Write or create a file in the workspace directory. Overwrites if file exists.',
        input_schema: {
            type: 'object',
            properties: {
                path: { type: 'string', description: 'File path relative to workspace' },
                content: { type: 'string', description: 'Content to write to the file' }
            },
            required: ['path', 'content']
        }
    },
    {
        name: 'edit',
        description: 'Edit an existing file in the workspace. Supports append, prepend, or replace operations.',
        input_schema: {
            type: 'object',
            properties: {
                path: { type: 'string', description: 'File path relative to workspace' },
                operation: { type: 'string', enum: ['append', 'prepend', 'replace'], description: 'Type of edit operation' },
                content: { type: 'string', description: 'Content for the operation' },
                search: { type: 'string', description: 'Text to find (required for replace operation)' }
            },
            required: ['path', 'operation', 'content']
        }
    },
    {
        name: 'ls',
        description: 'List files and directories in the workspace. Returns file names, sizes, and types.',
        input_schema: {
            type: 'object',
            properties: {
                path: { type: 'string', description: 'Directory path relative to workspace (default: root)' },
                recursive: { type: 'boolean', description: 'List recursively (default: false)' }
            }
        }
    },
    {
        name: 'skill_read',
        description: 'Read a skill\'s full instructions, directory path, and list of supporting files. Use this when a skill from <available_skills> applies to the user\'s request. Returns: name, description, instructions, tools, emoji, dir (absolute path to the skill directory), and files (list of supporting file names relative to dir, excluding the main skill file). To read supporting files, use the read tool with workspace-relative paths like "skills/<skill-name>/" + filename.',
        input_schema: {
            type: 'object',
            properties: {
                name: { type: 'string', description: 'Name of the skill to read (from available_skills list)' }
            },
            required: ['name']
        }
    },
    {
        name: 'skill_install',
        description: 'Install or update a skill from a URL or raw markdown content. Parses frontmatter, validates required fields (name, description), checks existing version, and writes to skills/{name}/SKILL.md atomically. The full file content never enters the conversation — only a one-line summary is returned: "Installed {name} v{version} — triggers: {list}". Use this instead of web_fetch + write when installing skills.',
        input_schema: {
            type: 'object',
            properties: {
                url: { type: 'string', description: 'HTTPS URL to fetch the skill markdown from (30s timeout, retries once on transient failure)' },
                content: { type: 'string', description: 'Raw skill markdown content (for direct install without fetching a URL)' },
                force: { type: 'boolean', description: 'If true, install even if the currently installed version is newer. Default false.' }
            }
        }
    },
    {
        name: 'cron_create',
        description: 'Create a scheduled job. Supports one-shot reminders ("in 30 minutes", "tomorrow at 9am") and recurring intervals ("every 2 hours", "every 30 minutes").',
        input_schema: {
            type: 'object',
            properties: {
                name: { type: 'string', description: 'Short name for the job (e.g., "Water plants reminder")' },
                message: { type: 'string', description: 'The message to deliver when the job fires' },
                time: { type: 'string', description: 'When to fire: "in 30 minutes", "tomorrow at 9am", "every 2 hours", "at 3pm"' },
                deleteAfterRun: { type: 'boolean', description: 'If true, delete the job after it runs (default: false for one-shot, N/A for recurring)' }
            },
            required: ['message', 'time']
        }
    },
    {
        name: 'cron_list',
        description: 'List all scheduled jobs with their status and next run time.',
        input_schema: {
            type: 'object',
            properties: {
                includeDisabled: { type: 'boolean', description: 'Include disabled/completed jobs (default: false)' }
            }
        }
    },
    {
        name: 'cron_cancel',
        description: 'Cancel a scheduled job by its ID.',
        input_schema: {
            type: 'object',
            properties: {
                id: { type: 'string', description: 'The job ID to cancel' }
            },
            required: ['id']
        }
    },
    {
        name: 'cron_status',
        description: 'Get scheduling service status: total jobs, next wake time, etc.',
        input_schema: {
            type: 'object',
            properties: {}
        }
    },
    {
        name: 'datetime',
        description: 'Get current date and time in various formats. Supports timezone conversion.',
        input_schema: {
            type: 'object',
            properties: {
                format: { type: 'string', description: 'Output format: "iso", "unix", "human", "date", "time", "full" (default: "full")' },
                timezone: { type: 'string', description: 'Timezone like "America/New_York", "Europe/London", "Asia/Tokyo" (default: local)' }
            }
        }
    },
    {
        name: 'session_status',
        description: 'Get current session info including uptime, memory usage, model, conversation stats, AND API usage analytics from your SQL.js database (today\'s request count, token usage, avg latency, error rate, cache hit rate).',
        input_schema: {
            type: 'object',
            properties: {}
        }
    },
    {
        name: 'memory_stats',
        description: 'Get memory system statistics: file sizes, daily file count, total storage used, and database index status.',
        input_schema: {
            type: 'object',
            properties: {}
        }
    },
    // ==================== Android Bridge Tools ====================
    {
        name: 'android_battery',
        description: 'Get device battery level, charging status, and charge type.',
        input_schema: {
            type: 'object',
            properties: {}
        }
    },
    {
        name: 'android_storage',
        description: 'Get device storage information (total, available, used).',
        input_schema: {
            type: 'object',
            properties: {}
        }
    },
    {
        name: 'android_clipboard_get',
        description: 'Get current clipboard content.',
        input_schema: {
            type: 'object',
            properties: {}
        }
    },
    {
        name: 'android_clipboard_set',
        description: 'Set clipboard content.',
        input_schema: {
            type: 'object',
            properties: {
                content: { type: 'string', description: 'Text to copy to clipboard' }
            },
            required: ['content']
        }
    },
    {
        name: 'android_contacts_search',
        description: 'Search contacts by name. Requires READ_CONTACTS permission.',
        input_schema: {
            type: 'object',
            properties: {
                query: { type: 'string', description: 'Name to search for' },
                limit: { type: 'number', description: 'Max results (default 10)' }
            },
            required: ['query']
        }
    },
    {
        name: 'android_sms',
        description: 'Send an SMS message. Requires SEND_SMS permission. ALWAYS confirm with user before sending.',
        input_schema: {
            type: 'object',
            properties: {
                phone: { type: 'string', description: 'Phone number to send to' },
                message: { type: 'string', description: 'Message text' }
            },
            required: ['phone', 'message']
        }
    },
    {
        name: 'android_call',
        description: 'Make a phone call. Requires CALL_PHONE permission. ALWAYS confirm with user before calling.',
        input_schema: {
            type: 'object',
            properties: {
                phone: { type: 'string', description: 'Phone number to call' }
            },
            required: ['phone']
        }
    },
    {
        name: 'android_location',
        description: 'Get current GPS location. Requires ACCESS_FINE_LOCATION permission.',
        input_schema: {
            type: 'object',
            properties: {}
        }
    },
    {
        name: 'android_tts',
        description: 'Speak text out loud using device text-to-speech.',
        input_schema: {
            type: 'object',
            properties: {
                text: { type: 'string', description: 'Text to speak' },
                speed: { type: 'number', description: 'Speech rate 0.5-2.0 (default 1.0)' },
                pitch: { type: 'number', description: 'Pitch 0.5-2.0 (default 1.0)' }
            },
            required: ['text']
        }
    },
    {
        name: 'android_camera_capture',
        description: 'Capture a photo from the device camera. Requires CAMERA permission. Returns a workspace-relative path (media/inbound/) that can be used directly with telegram_send_file.',
        input_schema: {
            type: 'object',
            properties: {
                lens: { type: 'string', description: 'Camera lens: "back" (default) or "front"' }
            }
        }
    },
    {
        name: 'android_camera_check',
        description: 'Capture a photo and analyze it with Claude vision. Use only when the user explicitly asks what the camera sees (e.g. "check my dog").',
        input_schema: {
            type: 'object',
            properties: {
                prompt: { type: 'string', description: 'What to check in the image. Example: "What is my dog doing?"' },
                lens: { type: 'string', description: 'Camera lens: "back" (default) or "front"' },
                max_tokens: { type: 'number', description: 'Optional output token cap for vision response (default 400)' }
            }
        }
    },
    {
        name: 'android_apps_list',
        description: 'List installed apps that can be launched.',
        input_schema: {
            type: 'object',
            properties: {}
        }
    },
    {
        name: 'android_apps_launch',
        description: 'Launch an app by package name.',
        input_schema: {
            type: 'object',
            properties: {
                package: { type: 'string', description: 'Package name (e.g., com.android.chrome)' }
            },
            required: ['package']
        }
    },
    // Solana Wallet Tools
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
        description: 'Send SOL to a Solana address. IMPORTANT: This prompts the user to approve the transaction in their wallet app on the phone. ALWAYS confirm with the user in chat before calling this tool.',
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
        description: 'Swap tokens using Jupiter Ultra (gasless, no SOL needed for fees). IMPORTANT: This prompts the user to approve the transaction in their wallet app on the phone. ALWAYS confirm with the user and show the quote first before calling this tool.',
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
        description: 'Create a trigger (limit) order on Jupiter. Requires Jupiter API key (get free at portal.jup.ag). Order executes automatically when price condition is met. Use for: buy at lower price (limit buy) or sell at higher price (limit sell).',
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
        description: 'Cancel an active limit or stop order on Jupiter. Requires the order ID from jupiter_trigger_list. Requires Jupiter API key.',
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
        description: 'Create a recurring DCA (Dollar Cost Averaging) order on Jupiter. Automatically buys tokens on a schedule to average out price. Perfect for building positions over time. Requires Jupiter API key.',
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
        description: 'Cancel an active DCA (recurring) order on Jupiter. Stops all future executions. Requires the order ID from jupiter_dca_list. Requires Jupiter API key.',
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
        name: 'telegram_react',
        description: 'Send a reaction emoji to a Telegram message via the setMessageReaction API. Use sparingly — at most 1 reaction per 5-10 exchanges. Pass the message_id and chat_id from the current conversation context and a single standard emoji.',
        input_schema: {
            type: 'object',
            properties: {
                message_id: { type: 'number', description: 'The Telegram message_id to react to' },
                chat_id: { type: 'number', description: 'The Telegram chat_id where the message is' },
                emoji: { type: 'string', description: 'A single emoji to react with (e.g., "👍", "❤️", "🔥", "😂", "🤔"). Required when adding a reaction; not needed when remove is true.' },
                remove: { type: 'boolean', description: 'Set to true to remove your reaction instead of adding one (default: false)' }
            },
            required: ['message_id', 'chat_id']
        }
    },
    {
        name: 'shell_exec',
        description: 'Execute a shell command in a sandboxed environment. Working directory is restricted to your workspace. Only a predefined allowlist of safe commands is permitted (common Unix utilities like ls, cat, grep, find, curl). No shell chaining or redirection. Max 30s timeout. Note: node/npm/npx are NOT available (Node.js runs as a JNI library, not a standalone binary). Use for file operations, curl, and system info.',
        input_schema: {
            type: 'object',
            properties: {
                command: { type: 'string', description: 'Shell command to execute (e.g., "ls -la", "cat file.txt", "curl https://example.com", "grep pattern README.md")' },
                cwd: { type: 'string', description: 'Working directory relative to workspace (default: workspace root). Must be within workspace.' },
                timeout_ms: { type: 'number', description: 'Timeout in milliseconds (default: 30000, max: 30000)' }
            },
            required: ['command']
        }
    },
    {
        name: 'js_eval',
        description: 'Execute JavaScript code inside the running Node.js process. Use this instead of shell_exec when you need Node.js APIs or JS computation. Code runs via AsyncFunction in the same process with access to require() for Node.js built-ins (fs, path, http, crypto, etc.) and bundled modules. child_process is blocked for security. Returns the value of the last expression (or resolved Promise value). Objects/arrays are JSON-serialized. Output captured from console.log/warn/error. 30s timeout (cannot abort sync infinite loops — avoid them). Runs on the main event loop so long-running sync operations will block other tasks. Use for: data processing, JSON manipulation, math, date calculations, HTTP requests via http/https, file operations via fs.',
        input_schema: {
            type: 'object',
            properties: {
                code: { type: 'string', description: 'JavaScript code to execute. The return value of the last expression is captured. Use console.log() for output. Async/await is supported.' },
                timeout_ms: { type: 'number', description: 'Timeout in milliseconds (default: 30000, max: 30000)' }
            },
            required: ['code']
        }
    },
    {
        name: 'telegram_send_file',
        description: 'Send a file from the workspace to the current Telegram chat. Auto-detects type from extension (photo, video, audio, voice, document). Use for sharing reports, images, exported files, camera captures, or any workspace file with the user. Telegram bot limit: 50MB. Photos up to 10MB are sent as photos; larger images are automatically sent as documents.',
        input_schema: {
            type: 'object',
            properties: {
                path: { type: 'string', description: 'File path relative to workspace (e.g., "media/inbound/photo.jpg", "report.csv")' },
                chat_id: { type: 'number', description: 'The Telegram chat_id to send to (from conversation context)' },
                caption: { type: 'string', description: 'Optional caption/message to send with the file' },
                type: { type: 'string', enum: ['document', 'photo', 'audio', 'voice', 'video'], description: 'Override auto-detected file type. Usually not needed.' }
            },
            required: ['path', 'chat_id']
        }
    },
    {
        name: 'telegram_delete',
        description: 'Delete a message from a Telegram chat. The bot can always delete its own messages. In groups, the bot can delete user messages only if it has admin permissions. Messages older than 48 hours cannot be deleted by non-admin bots. Check the "Recent Sent Messages" section in the system prompt for your own recent message IDs — never guess a message_id.',
        input_schema: {
            type: 'object',
            properties: {
                message_id: { type: 'number', description: 'The message_id to delete. Use IDs from Recent Sent Messages in system prompt, or from a prior telegram_send call.' },
                chat_id: { type: 'number', description: 'The chat_id where the message is located' }
            },
            required: ['message_id', 'chat_id']
        }
    },
    {
        name: 'telegram_send',
        description: 'Send a Telegram message and get back the message_id. Use this instead of responding directly when you need the message_id — for example, to delete or edit it later in the same turn. Supports optional inline keyboard buttons — when the user taps a button, the callback data is injected back into the conversation as a message. Returns { ok, message_id, chat_id }.',
        input_schema: {
            type: 'object',
            properties: {
                text: { type: 'string', description: 'Message text to send (Markdown formatting supported; converted to Telegram HTML). Max 4096 characters — for long responses use the default sendMessage().' },
                buttons: {
                    type: 'array',
                    description: 'Optional inline keyboard rows. Each row is an array of button objects with "text" (display label) and "callback_data" (value sent back when tapped, max 64 bytes). Example: [[{"text": "✅ Yes", "callback_data": "yes"}, {"text": "❌ No", "callback_data": "no"}]]',
                    items: {
                        type: 'array',
                        items: {
                            type: 'object',
                            properties: {
                                text: { type: 'string' },
                                callback_data: { type: 'string' }
                            },
                            required: ['text', 'callback_data']
                        }
                    }
                }
            },
            required: ['text']
        }
    },
    {
        name: 'delete',
        description: 'Delete a file from the workspace directory. Cannot delete protected system files or database files. Cannot delete directories — only individual files. Use this to clean up temporary files, old media downloads, or files you no longer need.',
        input_schema: {
            type: 'object',
            properties: {
                path: { type: 'string', description: 'File path relative to workspace (e.g., "media/inbound/old_photo.jpg", "temp/script.js")' }
            },
            required: ['path']
        }
    }
];

// Compare two version strings (semver-like or date-like: "1.2.3", "2026.2.14")
// Returns: >0 if a is newer, <0 if b is newer, 0 if equal
function compareVersions(a, b) {
    const aParts = String(a).replace(/^v/i, '').split('.').map(n => parseInt(n, 10) || 0);
    const bParts = String(b).replace(/^v/i, '').split('.').map(n => parseInt(n, 10) || 0);
    const len = Math.max(aParts.length, bParts.length);
    for (let i = 0; i < len; i++) {
        const diff = (aParts[i] || 0) - (bParts[i] || 0);
        if (diff !== 0) return diff;
    }
    return 0;
}

async function executeTool(name, input, chatId) {
    log(`Executing tool: ${name}`, 'DEBUG');

    switch (name) {
        case 'web_search': {
            const rawProvider = (typeof input.provider === 'string' ? input.provider.toLowerCase() : 'auto');
            const VALID_PROVIDERS = new Set(['auto', 'brave', 'duckduckgo', 'perplexity']);
            if (!VALID_PROVIDERS.has(rawProvider)) {
                return { error: `Unknown search provider "${rawProvider}". Use "auto", "brave", "duckduckgo", or "perplexity".` };
            }
            // Resolve 'auto': Brave if key configured, else DuckDuckGo
            const provider = rawProvider === 'auto'
                ? (config.braveApiKey ? 'brave' : 'duckduckgo')
                : rawProvider;
            const safeCount = Math.min(Math.max(Number(input.count) || 5, 1), 10);
            const safeFreshness = BRAVE_FRESHNESS_VALUES.has(input.freshness) ? input.freshness : '';
            const cacheKey = provider === 'perplexity'
                ? `search:perplexity:${input.query}:${safeFreshness || 'default'}`
                : provider === 'brave'
                    ? `search:brave:${input.query}:${safeCount}:${safeFreshness}`
                    : `search:duckduckgo:${input.query}:${safeCount}`;
            const cached = cacheGet(cacheKey);
            if (cached) { log('[WebSearch] Cache hit', 'DEBUG'); return cached; }

            try {
                let result;
                if (provider === 'perplexity') {
                    result = await searchPerplexity(input.query, safeFreshness);
                } else if (provider === 'brave') {
                    result = await searchBrave(input.query, safeCount, safeFreshness);
                } else {
                    result = await searchDDG(input.query, safeCount);
                }
                // Treat empty DDG results as failure to trigger fallback (CAPTCHA returns 200 but no parseable results)
                if (result.results && result.results.length === 0 && result.message && provider === 'duckduckgo') {
                    throw new Error(result.message);
                }
                const wrappedResult = wrapSearchResults(result, provider);
                cacheSet(cacheKey, wrappedResult);
                return wrappedResult;
            } catch (e) {
                // Fallback chain: perplexity → brave → ddg → ddg-lite, brave → ddg → ddg-lite, ddg → ddg-lite
                log(`[WebSearch] ${provider} failed (${e.message}), trying fallback`, 'WARN');
                const fallbacks = [];
                if (provider === 'perplexity') {
                    if (config.braveApiKey) fallbacks.push('brave');
                    fallbacks.push('duckduckgo');
                    fallbacks.push('duckduckgo-lite');
                } else if (provider === 'brave') {
                    fallbacks.push('duckduckgo');
                    fallbacks.push('duckduckgo-lite');
                } else if (provider === 'duckduckgo') {
                    fallbacks.push('duckduckgo-lite');
                }
                for (const fb of fallbacks) {
                    try {
                        log(`[WebSearch] Falling back to ${fb}`, 'DEBUG');
                        let fallback;
                        if (fb === 'brave') fallback = await searchBrave(input.query, safeCount, safeFreshness);
                        else if (fb === 'duckduckgo-lite') fallback = await searchDDGLite(input.query, safeCount);
                        else fallback = await searchDDG(input.query, safeCount);
                        // Treat empty DDG results (CAPTCHA) as failure to continue fallback chain
                        if (fb === 'duckduckgo' && fallback.results && fallback.results.length === 0 && fallback.message) {
                            throw new Error(fallback.message);
                        }
                        const fbCacheKey = fb === 'brave'
                            ? `search:brave:${input.query}:${safeCount}:${safeFreshness}`
                            : `search:${fb}:${input.query}:${safeCount}`;
                        const wrappedFallback = wrapSearchResults(fallback, fb);
                        cacheSet(fbCacheKey, wrappedFallback);
                        // Also cache under original key so subsequent queries don't re-hit the failing provider
                        cacheSet(cacheKey, wrappedFallback);
                        return wrappedFallback;
                    } catch (fbErr) {
                        log(`[WebSearch] ${fb} fallback also failed: ${fbErr.message}`, 'ERROR');
                    }
                }
                const displayName = { brave: 'Brave', duckduckgo: 'DuckDuckGo', 'duckduckgo-lite': 'DuckDuckGo Lite', perplexity: 'Perplexity' }[provider] || provider;
                return { error: fallbacks.length > 0
                    ? `Search failed: ${displayName} (${e.message}), fallback providers also failed`
                    : `${displayName} search failed: ${e.message}. No fallback providers available.` };
            }
        }

        case 'web_fetch': {
            const rawMode = input.raw === true;
            const fetchMethod = (typeof input.method === 'string' ? input.method.toUpperCase() : 'GET');
            const ALLOWED_METHODS = new Set(['GET', 'POST', 'PUT', 'DELETE']);
            if (!ALLOWED_METHODS.has(fetchMethod)) {
                return { error: `Unsupported HTTP method "${fetchMethod}". Use GET, POST, PUT, or DELETE.` };
            }
            const isGet = fetchMethod === 'GET';
            const hasBody = input.body !== undefined && input.body !== null;

            // Build safe headers (filter prototype pollution + stringify values)
            const safeHeaders = {};
            if (input.headers && typeof input.headers === 'object' && !Array.isArray(input.headers)) {
                for (const [k, v] of Object.entries(input.headers)) {
                    if (k === '__proto__' || k === 'constructor' || k === 'prototype') continue;
                    if (v === undefined || v === null) continue;
                    safeHeaders[k] = String(v);
                }
            }
            const hasCustomHeaders = Object.keys(safeHeaders).length > 0;
            const useCache = isGet && !hasCustomHeaders && !hasBody;
            const fetchCacheKey = `fetch:${input.url}:${rawMode ? 'raw' : 'md'}`;
            if (useCache) {
                const fetchCached = cacheGet(fetchCacheKey);
                if (fetchCached) { log('[WebFetch] Cache hit', 'DEBUG'); return fetchCached; }
            }

            try {
                const fetchOptions = {};
                if (input.method) fetchOptions.method = fetchMethod;
                if (hasCustomHeaders) fetchOptions.headers = safeHeaders;
                if (input.body !== undefined) fetchOptions.body = input.body;
                const res = await webFetch(input.url, fetchOptions);
                if (res.status < 200 || res.status >= 300) {
                    let detail = '';
                    if (typeof res.data === 'string') {
                        detail = res.data.slice(0, 200);
                    } else if (res.data && typeof res.data === 'object') {
                        detail = (res.data.error && res.data.error.message) || res.data.message || '';
                    }
                    throw new Error(`HTTP error (${res.status})${detail ? ': ' + detail : ''}`);
                }
                let result;

                if (typeof res.data === 'object') {
                    // JSON response
                    const json = JSON.stringify(res.data, null, 2);
                    result = { content: json.slice(0, 50000), type: 'json', url: res.finalUrl };
                } else if (typeof res.data === 'string') {
                    const contentType = (res.headers && res.headers['content-type']) || '';
                    if (contentType.includes('text/markdown')) {
                        // Cloudflare Markdown for Agents: server returned pre-rendered markdown
                        if (rawMode) {
                            result = { content: res.data.slice(0, 50000), type: 'text', url: res.finalUrl };
                        } else {
                            result = { content: res.data.slice(0, 50000), type: 'markdown', extractor: 'cf-markdown', url: res.finalUrl };
                        }
                    } else if (contentType.includes('text/html') || /^\s*(?:<!DOCTYPE html|<html\b)/i.test(res.data)) {
                        if (rawMode) {
                            // Raw mode: basic strip only
                            let text = res.data.replace(/<script[^>]*>[\s\S]*?<\/script>/gi, '');
                            text = text.replace(/<style[^>]*>[\s\S]*?<\/style>/gi, '');
                            text = text.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
                            result = { content: text.slice(0, 50000), type: 'text', url: res.finalUrl };
                        } else {
                            // Markdown conversion (default)
                            const { text, title } = htmlToMarkdown(res.data);
                            result = { content: text.slice(0, 50000), ...(title && { title }), type: 'markdown', url: res.finalUrl };
                        }
                    } else {
                        // Plain text
                        result = { content: res.data.slice(0, 50000), type: 'text', url: res.finalUrl };
                    }
                } else {
                    result = { content: String(res.data).slice(0, 50000), type: 'text', url: res.finalUrl };
                }

                // Wrap content with untrusted content markers for prompt injection defense
                if (result.content) {
                    result.content = wrapExternalContent(result.content, `web_fetch: ${res.finalUrl || input.url}`);
                }

                if (useCache) cacheSet(fetchCacheKey, result);
                return result;
            } catch (e) {
                return { error: e.message, url: input.url };
            }
        }

        case 'memory_save': {
            const currentMemory = loadMemory();
            const newMemory = currentMemory + '\n\n---\n\n' + input.content;
            saveMemory(newMemory.trim());
            return { success: true, message: 'Memory saved' };
        }

        case 'memory_read': {
            const memory = loadMemory();
            return { content: memory || '(Memory is empty)' };
        }

        case 'daily_note': {
            appendDailyMemory(input.note);
            return { success: true, message: 'Note added to daily memory' };
        }

        case 'memory_search': {
            const maxResults = input.max_results || 10;
            const results = searchMemory(input.query, maxResults);
            return {
                query: input.query,
                count: results.length,
                results
            };
        }

        case 'memory_get': {
            const filePath = safePath(input.file);
            if (!filePath) return { error: 'Access denied: path outside workspace' };
            if (!fs.existsSync(filePath)) {
                return { error: `File not found: ${input.file}` };
            }
            const content = fs.readFileSync(filePath, 'utf8');
            const lines = content.split('\n');
            const startLine = Math.max(1, input.start_line) - 1;
            const endLine = Math.min(lines.length, input.end_line || startLine + 11) - 1;
            const selectedLines = lines.slice(startLine, endLine + 1);
            return {
                file: input.file,
                start_line: startLine + 1,
                end_line: endLine + 1,
                content: selectedLines.map((line, i) => `${startLine + i + 1}: ${line}`).join('\n')
            };
        }

        case 'read': {
            const filePath = safePath(input.path);
            if (!filePath) return { error: 'Access denied: path outside workspace' };
            // Check basename first, then resolve symlinks to catch aliased access
            const readBasename = path.basename(filePath);
            if (SECRETS_BLOCKED.has(readBasename)) {
                log(`[Security] BLOCKED read of sensitive file: ${readBasename}`, 'WARN');
                return { error: `Reading ${readBasename} is blocked for security.` };
            }
            if (!fs.existsSync(filePath)) {
                return { error: `File not found: ${input.path}` };
            }
            // Resolve symlinks and re-check basename (prevents symlink bypass)
            try {
                const realBasename = path.basename(fs.realpathSync(filePath));
                if (SECRETS_BLOCKED.has(realBasename)) {
                    log(`[Security] BLOCKED read via symlink to sensitive file: ${realBasename}`, 'WARN');
                    return { error: `Reading ${realBasename} is blocked for security.` };
                }
            } catch { /* realpathSync may fail on broken links — proceed to normal error */ }
            const stat = fs.statSync(filePath);
            if (stat.isDirectory()) {
                return { error: 'Path is a directory, use ls tool instead' };
            }
            const content = fs.readFileSync(filePath, 'utf8');
            return {
                path: input.path,
                size: stat.size,
                content: content.slice(0, 50000) // Limit to 50KB
            };
        }

        case 'write': {
            const filePath = safePath(input.path);
            if (!filePath) return { error: 'Access denied: path outside workspace' };

            // Skill file write protection: writes to skills/ directory are blocked
            // when suspicious injection patterns are detected in the content (defense
            // against prompt injection creating persistent backdoor skills).
            const relPath = path.relative(workDir, filePath);
            const relPathLower = relPath.toLowerCase();
            if (relPathLower.startsWith('skills' + path.sep) || relPathLower.startsWith('skills/')) {
                // Check for suspicious content in the skill being written
                const suspicious = detectSuspiciousPatterns(input.content || '');
                if (suspicious.length > 0) {
                    log(`[Security] BLOCKED skill write with suspicious patterns: ${suspicious.join(', ')} → ${relPath}`, 'WARN');
                    return { error: 'Skill file write blocked: suspicious content detected (' + suspicious.join(', ') + '). Remove the flagged content and retry.' };
                }
                log(`[Security] Skill write to ${relPath} — allowed (no suspicious patterns)`, 'DEBUG');
            }

            // Create parent directories if needed
            const dir = path.dirname(filePath);
            if (!fs.existsSync(dir)) {
                fs.mkdirSync(dir, { recursive: true });
            }
            fs.writeFileSync(filePath, input.content, 'utf8');

            // BAT-236: If agent wrote to workspace root agent_settings.json, re-sync API keys
            if (filePath === path.join(workDir, 'agent_settings.json')) {
                syncAgentApiKeys();
            }

            return {
                success: true,
                path: input.path,
                size: input.content.length
            };
        }

        case 'edit': {
            const filePath = safePath(input.path);
            if (!filePath) return { error: 'Access denied: path outside workspace' };
            if (!fs.existsSync(filePath)) {
                return { error: `File not found: ${input.path}` };
            }
            let content = fs.readFileSync(filePath, 'utf8');

            switch (input.operation) {
                case 'append':
                    content = content + '\n' + input.content;
                    break;
                case 'prepend':
                    content = input.content + '\n' + content;
                    break;
                case 'replace':
                    if (!input.search) {
                        return { error: 'Replace operation requires search parameter' };
                    }
                    if (!content.includes(input.search)) {
                        return { error: `Search text not found in file: ${input.search.slice(0, 50)}` };
                    }
                    content = content.replace(input.search, input.content);
                    break;
                default:
                    return { error: `Unknown operation: ${input.operation}` };
            }

            // Skill file edit protection (same as write tool)
            const editRelPath = path.relative(workDir, filePath).toLowerCase();
            if (editRelPath.startsWith('skills' + path.sep) || editRelPath.startsWith('skills/')) {
                const suspicious = detectSuspiciousPatterns(content);
                if (suspicious.length > 0) {
                    log(`[Security] BLOCKED skill edit with suspicious patterns: ${suspicious.join(', ')} → ${editRelPath}`, 'WARN');
                    return { error: 'Skill file edit blocked: suspicious content detected (' + suspicious.join(', ') + '). Remove the flagged content and retry.' };
                }
            }

            fs.writeFileSync(filePath, content, 'utf8');

            // BAT-236: If agent edited workspace root agent_settings.json, re-sync API keys
            if (filePath === path.join(workDir, 'agent_settings.json')) {
                syncAgentApiKeys();
            }

            return {
                success: true,
                path: input.path,
                operation: input.operation
            };
        }

        case 'ls': {
            const targetPath = safePath(input.path || '');
            if (!targetPath) return { error: 'Access denied: path outside workspace' };
            if (!fs.existsSync(targetPath)) {
                return { error: `Directory not found: ${input.path || '/'}` };
            }
            const stat = fs.statSync(targetPath);
            if (!stat.isDirectory()) {
                return { error: 'Path is not a directory' };
            }

            const listDir = (dir, prefix = '') => {
                const entries = [];
                const items = fs.readdirSync(dir);
                for (const item of items) {
                    const itemPath = path.join(dir, item);
                    const itemStat = fs.statSync(itemPath);
                    const entry = {
                        name: prefix + item,
                        type: itemStat.isDirectory() ? 'directory' : 'file',
                        size: itemStat.isDirectory() ? null : itemStat.size
                    };
                    entries.push(entry);
                    if (input.recursive && itemStat.isDirectory()) {
                        entries.push(...listDir(itemPath, prefix + item + '/'));
                    }
                }
                return entries;
            };

            return {
                path: input.path || '/',
                entries: listDir(targetPath)
            };
        }

        case 'skill_read': {
            const skills = loadSkills();
            const skillName = input.name.toLowerCase();
            const skill = skills.find(s => s.name.toLowerCase() === skillName);

            if (!skill) {
                return { error: `Skill not found: ${input.name}. Use skill name from <available_skills> list.` };
            }

            // Read skill content (supports both directory SKILL.md and flat .md files)
            const skillPath = skill.filePath || path.join(skill.dir, 'SKILL.md');
            if (!fs.existsSync(skillPath)) {
                return { error: `Skill file not found: ${skillPath}` };
            }

            const content = fs.readFileSync(skillPath, 'utf8');

            // List supporting files in the skill directory
            // Only list files for directory-based skills (not flat .md files which share SKILLS_DIR)
            let files = [];
            const isDirectorySkill = skill.filePath && path.basename(skill.filePath) === 'SKILL.md';
            if (isDirectorySkill && skill.dir && fs.existsSync(skill.dir)) {
                try {
                    const normalizedSkillPath = path.normalize(skillPath);
                    files = listFilesRecursive(skill.dir)
                        .filter(f => path.normalize(f) !== normalizedSkillPath)
                        .map(f => path.relative(skill.dir, f));
                } catch (e) {
                    // Non-critical — just skip file listing
                }
            }

            return {
                name: skill.name,
                description: skill.description,
                instructions: skill.instructions || content,
                tools: skill.tools,
                emoji: skill.emoji,
                dir: isDirectorySkill ? skill.dir : null,
                files: files
            };
        }

        case 'skill_install': {
            const { url, content: rawInput, force = false } = input;

            if ((!url && !rawInput) || (url && rawInput)) {
                return { error: 'Provide exactly one of url or content (not both)' };
            }

            let rawContent;

            const MAX_SKILL_SIZE = 1 * 1024 * 1024; // 1MB limit for skill files

            if (url) {
                // Fetch with 30s timeout, retry once on transient errors
                const TRANSIENT = /timeout|timed out|aborted|ECONNRESET|ETIMEDOUT|Connection closed/i;
                const doFetch = async () => {
                    const res = await webFetch(url, { timeout: 30000 });
                    if (res.status !== 200) throw new Error(`HTTP ${res.status} from ${url}`);
                    const body = typeof res.data === 'string' ? res.data : JSON.stringify(res.data);
                    if (body.length > MAX_SKILL_SIZE) {
                        throw new Error(`Skill file too large (${(body.length / 1024).toFixed(0)}KB, max 1MB)`);
                    }
                    // Detect HTML response — user likely passed a blob URL instead of raw
                    if (body.trimStart().startsWith('<')) {
                        throw new Error('URL returned HTML, not markdown. Use the raw file URL instead (e.g. raw.githubusercontent.com)');
                    }
                    return body;
                };
                try {
                    rawContent = await doFetch();
                } catch (firstErr) {
                    if (TRANSIENT.test(firstErr.message)) {
                        log(`skill_install: fetch failed (${firstErr.message}), retrying in 1s...`, 'WARN');
                        await new Promise(r => setTimeout(r, 1000));
                        try {
                            rawContent = await doFetch();
                        } catch (secondErr) {
                            return { error: `Failed to fetch skill: ${secondErr.message}` };
                        }
                    } else {
                        return { error: `Failed to fetch skill: ${firstErr.message}` };
                    }
                }
            } else {
                if (rawInput.length > MAX_SKILL_SIZE) {
                    return { error: `Skill content too large (${(rawInput.length / 1024).toFixed(0)}KB, max 1MB)` };
                }
                rawContent = rawInput;
            }

            // Parse skill using existing parser
            const skill = parseSkillFile(rawContent, SKILLS_DIR);

            // Validate required fields
            if (!skill.name) return { error: 'Invalid skill: missing "name" field in frontmatter' };
            if (!skill.description) return { error: 'Invalid skill: missing "description" field in frontmatter' };

            // Safe directory name: lowercase, alphanumeric + hyphens only
            const safeName = skill.name.toLowerCase().replace(/[^a-z0-9\-_]/g, '-').replace(/-+/g, '-').replace(/^-|-$/g, '');
            if (!safeName) return { error: `Invalid skill name: "${skill.name}"` };

            const skillDir = path.join(SKILLS_DIR, safeName);
            const skillFile = path.join(skillDir, 'SKILL.md');

            // Check existing version
            let action = 'installed';
            if (fs.existsSync(skillFile)) {
                try {
                    const existingContent = fs.readFileSync(skillFile, 'utf8');
                    const existing = parseSkillFile(existingContent, skillDir);

                    if (existing.version && skill.version) {
                        const cmp = compareVersions(skill.version, existing.version);
                        if (cmp === 0) {
                            return { result: `Skill "${skill.name}" v${skill.version} already installed (same version — skipped)` };
                        }
                        if (cmp < 0 && !force) {
                            return { result: `Skill "${skill.name}" v${existing.version} already installed. Incoming version (${skill.version}) is older — skipped. Use force:true to downgrade.` };
                        }
                        action = cmp >= 0
                            ? `updated v${existing.version} → v${skill.version}`
                            : `downgraded v${existing.version} → v${skill.version}`;
                    } else {
                        action = 'updated';
                    }
                } catch (_e) {
                    action = 'installed (replaced)';
                }
            }

            // Injection guard: same check as the write tool's skills/ protection
            const suspicious = detectSuspiciousPatterns(rawContent);
            if (suspicious.length > 0) {
                log(`[Security] skill_install blocked — suspicious patterns: ${suspicious.join(', ')}`, 'WARN');
                return { error: `Skill install blocked: suspicious content detected (${suspicious.join(', ')}). Remove the flagged content and retry.` };
            }

            // Atomic write: temp file → rename
            try {
                if (!fs.existsSync(skillDir)) {
                    fs.mkdirSync(skillDir, { recursive: true });
                }
                const tmpFile = skillFile + '.tmp';
                fs.writeFileSync(tmpFile, rawContent, 'utf8');
                fs.renameSync(tmpFile, skillFile);
                log(`skill_install: ${action} — ${safeName}/SKILL.md`, 'INFO');
            } catch (e) {
                return { error: `Failed to write skill: ${e.message}` };
            }

            const versionStr = skill.version ? ` v${skill.version}` : '';
            const triggersStr = skill.triggers.length > 0 ? skill.triggers.join(', ') : '(semantic — uses description matching)';
            return { result: `Skill "${skill.name}"${versionStr} ${action} — triggers: ${triggersStr}` };
        }

        case 'cron_create': {
            // Flat-params recovery: non-frontier models sometimes put job fields
            // at top level instead of using the schema correctly
            if (!input.time && !input.message) {
                // Check if params were wrapped in a 'job' object
                if (input.job && typeof input.job === 'object') {
                    if (input.job.time) input.time = input.job.time;
                    if (input.job.message) input.message = input.job.message;
                    if (input.job.name) input.name = input.job.name;
                    if (input.job.deleteAfterRun !== undefined) input.deleteAfterRun = input.job.deleteAfterRun;
                }
            }

            const triggerTime = parseTimeExpression(input.time);
            if (!triggerTime) {
                return { error: `Could not parse time: "${input.time}". Try formats like "in 30 minutes", "tomorrow at 9am", "every 2 hours", "at 3pm", or "2024-01-15 14:30".` };
            }

            const isRecurring = triggerTime._recurring === true;

            if (!isRecurring) {
                const diffMs = triggerTime.getTime() - Date.now();
                if (diffMs < -60000) {
                    return { error: 'Scheduled time is in the past.' };
                }
                if (diffMs > 10 * 365.25 * 24 * 3600000) {
                    return { error: 'Scheduled time is too far in the future (max 10 years).' };
                }
            }

            let schedule;
            if (isRecurring) {
                schedule = {
                    kind: 'every',
                    everyMs: triggerTime._everyMs,
                    anchorMs: Date.now(),
                };
            } else {
                schedule = {
                    kind: 'at',
                    atMs: triggerTime.getTime(),
                };
            }

            const job = cronService.create({
                name: input.name || input.message.slice(0, 50),
                description: input.message,
                schedule,
                payload: { kind: 'reminder', message: input.message },
                deleteAfterRun: input.deleteAfterRun || false,
            });

            return {
                success: true,
                id: job.id,
                name: job.name,
                message: input.message,
                type: isRecurring ? 'recurring' : 'one-shot',
                nextRunAt: job.state.nextRunAtMs ? localTimestamp(new Date(job.state.nextRunAtMs)) : null,
                nextRunIn: job.state.nextRunAtMs ? formatDuration(job.state.nextRunAtMs - Date.now()) : null,
                interval: isRecurring ? formatDuration(triggerTime._everyMs) : null,
            };
        }

        case 'cron_list': {
            const jobs = cronService.list({ includeDisabled: input.includeDisabled || false });

            return {
                count: jobs.length,
                jobs: jobs.map(j => ({
                    id: j.id,
                    name: j.name,
                    type: j.schedule.kind,
                    enabled: j.enabled,
                    message: j.payload?.message || j.description,
                    nextRunAt: j.state.nextRunAtMs ? localTimestamp(new Date(j.state.nextRunAtMs)) : null,
                    nextRunIn: j.state.nextRunAtMs ? formatDuration(j.state.nextRunAtMs - Date.now()) : null,
                    lastRun: j.state.lastRunAtMs ? localTimestamp(new Date(j.state.lastRunAtMs)) : null,
                    lastStatus: j.state.lastStatus || 'never',
                    lastDelivered: j.state.lastDelivered ?? null,
                }))
            };
        }

        case 'cron_cancel': {
            const jobs = cronService.list({ includeDisabled: true });
            const job = jobs.find(j => j.id === input.id);

            if (!job) {
                return { error: `Job not found: ${input.id}` };
            }

            const removed = cronService.remove(input.id);
            return {
                success: removed,
                id: input.id,
                message: `Job "${job.name}" cancelled and removed.`
            };
        }

        case 'cron_status': {
            return cronService.status();
        }

        case 'datetime': {
            const now = new Date();
            const format = input.format || 'full';

            // Timezone handling
            let dateStr;
            const tz = input.timezone;

            const formatDate = (date, tzOpt) => {
                const options = tzOpt ? { timeZone: tzOpt } : {};

                switch (format) {
                    case 'iso':
                        return date.toISOString();
                    case 'unix':
                        return Math.floor(date.getTime() / 1000).toString();
                    case 'date':
                        return date.toLocaleDateString('en-US', { ...options, weekday: 'long', year: 'numeric', month: 'long', day: 'numeric' });
                    case 'time':
                        return date.toLocaleTimeString('en-US', { ...options, hour: '2-digit', minute: '2-digit', second: '2-digit' });
                    case 'human':
                        return date.toLocaleString('en-US', { ...options, dateStyle: 'medium', timeStyle: 'short' });
                    case 'full':
                    default:
                        return date.toLocaleString('en-US', {
                            ...options,
                            weekday: 'long',
                            year: 'numeric',
                            month: 'long',
                            day: 'numeric',
                            hour: '2-digit',
                            minute: '2-digit',
                            second: '2-digit',
                            timeZoneName: 'short'
                        });
                }
            };

            try {
                dateStr = formatDate(now, tz);
            } catch (e) {
                // Invalid timezone, fall back to local
                dateStr = formatDate(now, null);
            }

            return {
                formatted: dateStr,
                iso: now.toISOString(),
                unix: Math.floor(now.getTime() / 1000),
                timezone: tz || 'local',
                dayOfWeek: now.toLocaleDateString('en-US', { weekday: 'long' }),
                weekNumber: Math.ceil((now - new Date(now.getFullYear(), 0, 1)) / (7 * 24 * 60 * 60 * 1000))
            };
        }

        case 'session_status': {
            const uptime = Math.floor(process.uptime());
            const memUsage = process.memoryUsage();
            const totalConversations = conversations.size;
            let totalMessages = 0;
            conversations.forEach(conv => totalMessages += conv.length);

            const result = {
                agent: AGENT_NAME,
                model: MODEL,
                uptime: {
                    seconds: uptime,
                    formatted: `${Math.floor(uptime / 3600)}h ${Math.floor((uptime % 3600) / 60)}m ${uptime % 60}s`
                },
                memory: {
                    rss: Math.round(memUsage.rss / 1024 / 1024),
                    heapUsed: Math.round(memUsage.heapUsed / 1024 / 1024),
                    heapTotal: Math.round(memUsage.heapTotal / 1024 / 1024),
                    external: Math.round(memUsage.external / 1024 / 1024)
                },
                conversations: {
                    active: totalConversations,
                    totalMessages: totalMessages
                },
                runtime: {
                    nodeVersion: process.version,
                    platform: process.platform,
                    arch: process.arch
                },
                features: {
                    webSearch: true,
                    webSearchProvider: config.braveApiKey ? 'brave' : 'duckduckgo',
                    reminders: true,
                    skills: loadSkills().length
                }
            };

            // API usage analytics from SQL.js (BAT-28)
            if (getDb()) {
                try {
                    const today = localDateStr();
                    const todayStats = getDb().exec(
                        `SELECT COUNT(*) as cnt,
                                COALESCE(SUM(input_tokens), 0) as inp,
                                COALESCE(SUM(output_tokens), 0) as outp,
                                COALESCE(AVG(duration_ms), 0) as avg_ms,
                                COALESCE(SUM(cache_read_tokens), 0) as cache_read,
                                COALESCE(SUM(cache_creation_tokens), 0) as cache_create,
                                SUM(CASE WHEN status != 200 THEN 1 ELSE 0 END) as errors
                         FROM api_request_log WHERE timestamp LIKE ?`, [today + '%']
                    );
                    if (todayStats.length > 0 && todayStats[0].values.length > 0) {
                        const [cnt, inp, outp, avgMs, cacheRead, , errors] = todayStats[0].values[0];
                        const totalTokens = (inp || 0) + (outp || 0);
                        const cacheHitRate = (inp || 0) > 0
                            ? Math.round(((cacheRead || 0) / (inp || 1)) * 100)
                            : 0;
                        result.apiUsage = {
                            today: {
                                requests: cnt || 0,
                                inputTokens: inp || 0,
                                outputTokens: outp || 0,
                                totalTokens,
                                avgLatencyMs: Math.round(avgMs || 0),
                                errors: errors || 0,
                                errorRate: cnt > 0 ? `${Math.round(((errors || 0) / cnt) * 100)}%` : '0%',
                                cacheHitRate: `${cacheHitRate}%`,
                            }
                        };
                    }
                } catch (e) {
                    // Non-fatal — analytics section just won't appear
                }
            }

            return result;
        }

        case 'memory_stats': {
            const stats = {
                memoryMd: { exists: false, size: 0 },
                dailyFiles: { count: 0, totalSize: 0, oldestDate: null, newestDate: null },
                total: { size: 0, warning: null }
            };

            // Check MEMORY.md
            const memoryPath = path.join(workDir, 'MEMORY.md');
            if (fs.existsSync(memoryPath)) {
                const stat = fs.statSync(memoryPath);
                stats.memoryMd.exists = true;
                stats.memoryMd.size = stat.size;
                stats.total.size += stat.size;

                // Warn if MEMORY.md exceeds 50KB
                if (stat.size > 50 * 1024) {
                    stats.total.warning = `MEMORY.md is ${Math.round(stat.size / 1024)}KB - consider archiving old entries`;
                }
            }

            // Check daily memory files
            const memoryDir = path.join(workDir, 'memory');
            if (fs.existsSync(memoryDir)) {
                const files = fs.readdirSync(memoryDir).filter(f => f.endsWith('.md')).sort();
                stats.dailyFiles.count = files.length;

                if (files.length > 0) {
                    stats.dailyFiles.oldestDate = files[0].replace('.md', '');
                    stats.dailyFiles.newestDate = files[files.length - 1].replace('.md', '');
                }

                for (const file of files) {
                    const filePath = path.join(memoryDir, file);
                    const stat = fs.statSync(filePath);
                    stats.dailyFiles.totalSize += stat.size;
                    stats.total.size += stat.size;
                }
            }

            // Format sizes for readability
            stats.memoryMd.sizeFormatted = formatBytes(stats.memoryMd.size);
            stats.dailyFiles.totalSizeFormatted = formatBytes(stats.dailyFiles.totalSize);
            stats.total.sizeFormatted = formatBytes(stats.total.size);

            // Check if we have too many daily files (>30 days)
            if (stats.dailyFiles.count > 30) {
                stats.total.warning = (stats.total.warning || '') +
                    ` ${stats.dailyFiles.count} daily files - consider pruning old files.`;
            }

            return stats;
        }

        // ==================== Android Bridge Tools ====================

        case 'android_battery': {
            return await androidBridgeCall('/battery');
        }

        case 'android_storage': {
            return await androidBridgeCall('/storage');
        }

        case 'android_clipboard_get': {
            return await androidBridgeCall('/clipboard/get');
        }

        case 'android_clipboard_set': {
            return await androidBridgeCall('/clipboard/set', { content: input.content });
        }

        case 'android_contacts_search': {
            return await androidBridgeCall('/contacts/search', {
                query: input.query,
                limit: input.limit || 10
            });
        }

        case 'android_sms': {
            return await androidBridgeCall('/sms', {
                phone: input.phone,
                message: input.message
            });
        }

        case 'android_call': {
            return await androidBridgeCall('/call', { phone: input.phone });
        }

        case 'android_location': {
            return await androidBridgeCall('/location');
        }

        case 'android_tts': {
            return await androidBridgeCall('/tts', {
                text: input.text,
                speed: input.speed || 1.0,
                pitch: input.pitch || 1.0
            });
        }

        case 'android_camera_capture': {
            const lens = input.lens === 'front' ? 'front' : 'back';
            const result = await androidBridgeCall('/camera/capture', { lens }, 45000);
            // Move capture into workspace so telegram_send_file can access it
            if (result && result.success && result.path && fs.existsSync(result.path)) {
                try {
                    const filename = path.basename(result.path);
                    const inboundDir = path.join(workDir, 'media', 'inbound');
                    fs.mkdirSync(inboundDir, { recursive: true });
                    const dest = path.join(inboundDir, filename);
                    try {
                        fs.renameSync(result.path, dest);
                    } catch (e) {
                        // Cross-filesystem fallback: copy + delete
                        fs.copyFileSync(result.path, dest);
                        try { fs.unlinkSync(result.path); } catch (_) { /* ignore cleanup */ }
                    }
                    result.path = 'media/inbound/' + filename;
                } catch (e) {
                    log(`Camera move to workspace failed: ${e.message}`, 'WARN');
                }
            }
            return result;
        }

        case 'android_camera_check': {
            const lens = input.lens === 'front' ? 'front' : 'back';
            const capture = await androidBridgeCall('/camera/capture', { lens }, 45000);
            if (!capture || capture.error) {
                return { error: capture?.error || 'Camera capture failed' };
            }

            const imagePath = capture.path;
            if (!imagePath || !fs.existsSync(imagePath)) {
                return { error: 'Captured image file not found on device' };
            }

            let imageBase64;
            try {
                imageBase64 = fs.readFileSync(imagePath).toString('base64');
            } catch (e) {
                return { error: `Failed to read captured image: ${e.message}` };
            }

            const vision = await visionAnalyzeImage(
                imageBase64,
                input.prompt || 'What is happening in this image? Keep the answer concise and practical.',
                input.max_tokens || 400
            );

            if (vision.error) {
                return { error: vision.error };
            }

            return {
                success: true,
                lens: capture.lens || lens,
                capturedAt: capture.capturedAt || null,
                path: imagePath,
                analysis: vision.text
            };
        }

        case 'android_apps_list': {
            return await androidBridgeCall('/apps/list');
        }

        case 'android_apps_launch': {
            return await androidBridgeCall('/apps/launch', { package: input.package });
        }

        // ==================== Solana Tools ====================

        case 'solana_address': {
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
        }

        case 'solana_balance': {
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
        }

        case 'solana_history': {
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
        }

        case 'solana_send': {
            // Build tx in JS, wallet signs AND broadcasts via signAndSendTransactions
            let from;
            try {
                from = getConnectedWalletAddress();
            } catch (e) {
                return { error: e.message };
            }
            const to = input.to;
            const amount = input.amount;

            if (!to || !amount || amount <= 0) {
                return { error: 'Both "to" address and a positive "amount" are required.' };
            }

            // Step 1: Get latest blockhash
            const blockhashResult = await solanaRpc('getLatestBlockhash', [{ commitment: 'finalized' }]);
            if (blockhashResult.error) return { error: 'Failed to get blockhash: ' + blockhashResult.error };
            const recentBlockhash = blockhashResult.blockhash || (blockhashResult.value && blockhashResult.value.blockhash);
            if (!recentBlockhash) return { error: 'No blockhash returned from RPC' };

            // Step 2: Build unsigned transaction
            // BAT-255: use BigInt-safe parsing to avoid floating-point precision loss
            const lamports = parseInputAmountToLamports(numberToDecimalString(amount), 9); // SOL has 9 decimals
            let unsignedTx;
            try {
                unsignedTx = buildSolTransferTx(from, to, lamports, recentBlockhash);
            } catch (e) {
                return { error: 'Failed to build transaction: ' + e.message };
            }
            const txBase64 = unsignedTx.toString('base64');

            // Step 3: Send to wallet — wallet signs AND broadcasts (signAndSendTransactions)
            // Pre-authorize to ensure wallet is warm (cold-start protection)
            await ensureWalletAuthorized();
            // 120s timeout: user needs time to open wallet app and approve
            const result = await androidBridgeCall('/solana/sign', { transaction: txBase64 }, 120000);
            if (result.error) return { error: result.error };
            if (!result.signature) return { error: 'No signature returned from wallet' };

            // Convert base64 signature to base58 for display
            const sigBytes = Buffer.from(result.signature, 'base64');
            const sigBase58 = base58Encode(sigBytes);

            return { signature: sigBase58, success: true };
        }

        case 'solana_price': {
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
        }

        case 'solana_quote': {
            try {
                const inputToken = await resolveToken(input.inputToken);
                if (!inputToken) return { error: `Unknown input token: "${input.inputToken}". Try a symbol like SOL, USDC, BONK or a mint address.` };
                if (inputToken.ambiguous) return { ambiguous: true, message: `Multiple tokens found for "${input.inputToken}". Ask user which one or use the contract address.`, candidates: inputToken.candidates.map(c => ({ name: c.name, symbol: c.symbol, mint: c.address })) };

                const outputToken = await resolveToken(input.outputToken);
                if (!outputToken) return { error: `Unknown output token: "${input.outputToken}". Try a symbol like SOL, USDC, BONK or a mint address.` };
                if (outputToken.ambiguous) return { ambiguous: true, message: `Multiple tokens found for "${input.outputToken}". Ask user which one or use the contract address.`, candidates: outputToken.candidates.map(c => ({ name: c.name, symbol: c.symbol, mint: c.address })) };

                if (!input.amount || input.amount <= 0) return { error: 'Amount must be positive.' };

                if (inputToken.decimals === null) return { error: `Cannot determine decimals for input token ${input.inputToken}. Use a known symbol or verified mint.` };

                // Convert human amount to raw (smallest unit)
                const amountRaw = Math.round(input.amount * Math.pow(10, inputToken.decimals));
                const slippageBps = input.slippageBps || 100;

                const quote = await jupiterQuote(inputToken.address, outputToken.address, amountRaw, slippageBps);

                // Convert output amounts back to human units
                const outDecimals = outputToken.decimals || 6;
                const outAmount = parseInt(quote.outAmount) / Math.pow(10, outDecimals);
                const minOutAmount = parseInt(quote.otherAmountThreshold) / Math.pow(10, outDecimals);

                const warnings = [];
                if (inputToken.warning) warnings.push(`⚠️ Input token: ${inputToken.warning}`);
                if (outputToken.warning) warnings.push(`⚠️ Output token: ${outputToken.warning}`);
                const priceImpact = quote.priceImpactPct ? parseFloat(quote.priceImpactPct) : 0;
                if (priceImpact > 5) warnings.push(`⚠️ High price impact (${priceImpact.toFixed(2)}%). This trade will move the market significantly. Warn the user.`);
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
        }

        case 'solana_swap': {
            // Requires connected wallet
            let userPublicKey;
            try {
                userPublicKey = getConnectedWalletAddress();
            } catch (e) {
                return { error: e.message };
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
                try {
                    if (isNativeSOL) {
                        const bal = await solanaRpc('getBalance', [userPublicKey]);
                        if (!bal.error) {
                            const solBalance = (bal.value || 0) / 1e9;
                            if (input.amount > solBalance) {
                                return { error: `Insufficient SOL balance: you have ${solBalance} SOL but tried to swap ${input.amount} SOL.` };
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
                    if (!o.transaction) throw new Error('Jupiter Ultra did not return a transaction.');
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

                // Step 2: Send to wallet for sign-only (120s timeout for user approval)
                // Pre-authorize to ensure wallet is warm (cold-start protection)
                await ensureWalletAuthorized();
                // Ultra flow: wallet signs but does NOT broadcast
                log('[Jupiter Ultra] Sending to wallet for approval (sign-only)...', 'INFO');
                const signResult = await androidBridgeCall('/solana/sign-only', {
                    transaction: order.transaction
                }, 120000);

                if (signResult.error) return { error: signResult.error };
                if (!signResult.signedTransaction) return { error: 'No signed transaction returned from wallet.' };

                // Step 3: Check TTL — if MWA approval took >90s, re-quote to avoid expired tx
                const elapsed = Date.now() - orderTimestamp;
                let finalSignedTx = signResult.signedTransaction;
                let finalRequestId = order.requestId;

                if (elapsed > ULTRA_TTL_SAFE_MS) {
                    log(`[Jupiter Ultra] MWA approval took ${Math.round(elapsed / 1000)}s (>90s) — re-quoting to avoid TTL expiry...`, 'WARN');
                    try {
                        order = await fetchAndVerifyOrder();
                        orderTimestamp = Date.now();

                        // Need wallet to sign the new transaction
                        log('[Jupiter Ultra] Re-signing with fresh order...', 'INFO');
                        const reSignResult = await androidBridgeCall('/solana/sign-only', {
                            transaction: order.transaction
                        }, 60000); // Shorter timeout for re-sign

                        if (reSignResult.error) return { error: `Re-quote sign failed: ${reSignResult.error}` };
                        if (!reSignResult.signedTransaction) return { error: 'No signed transaction from re-quote.' };

                        finalSignedTx = reSignResult.signedTransaction;
                        finalRequestId = order.requestId;
                        log('[Jupiter Ultra] Re-quote successful, executing fresh order', 'DEBUG');
                    } catch (reQuoteErr) {
                        log(`[Jupiter Ultra] Re-quote failed, attempting original: ${reQuoteErr.message}`, 'WARN');
                        // Fall through to try original — it might still be within 2-min TTL
                    }
                }

                // Step 4: Execute via Jupiter Ultra (Jupiter broadcasts the tx)
                log('[Jupiter Ultra] Executing signed transaction...', 'INFO');
                const execResult = await jupiterUltraExecute(finalSignedTx, finalRequestId);

                if (execResult.status === 'Failed') {
                    return { error: `Swap failed: ${execResult.error || 'Transaction execution failed'}` };
                }
                if (!execResult.signature) {
                    return { error: 'Jupiter Ultra execute returned no signature.' };
                }

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
                const warnings = [];
                if (inputToken.warning) warnings.push(inputToken.warning);
                if (outputToken.warning) warnings.push(outputToken.warning);
                if (warnings.length > 0) response.warnings = warnings;
                return response;
            } catch (e) {
                return { error: e.message };
            }
        }

        // ========== JUPITER API TOOLS ==========
        // Requires Jupiter API key from Settings → Solana Wallet
        // Get free key at portal.jup.ag

        case 'jupiter_trigger_create': {
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

                // 2. Get wallet address
                let walletAddress;
                try {
                    walletAddress = getConnectedWalletAddress();
                } catch (e) {
                    return { error: e.message };
                }

                // 3. Validate and convert input amount (makingAmount in raw units)
                let makingAmount;
                try {
                    makingAmount = parseInputAmountToLamports(input.inputAmount, inputToken.decimals);
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
                    const makingLamports = parseInputAmountToLamports(input.inputAmount, inputToken.decimals);
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

                // 8. Sign via MWA (120s timeout for user approval)
                await ensureWalletAuthorized();
                log('[Jupiter Trigger] Sending to wallet for approval (sign-only)...', 'INFO');
                const signResult = await androidBridgeCall('/solana/sign-only', {
                    transaction: data.transaction
                }, 120000);
                if (signResult.error) return { error: signResult.error };
                if (!signResult.signedTransaction) return { error: 'No signed transaction returned from wallet' };

                // 9. Execute (Jupiter broadcasts)
                log('[Jupiter Trigger] Executing signed transaction...', 'INFO');
                const execResult = await jupiterTriggerExecute(signResult.signedTransaction, data.requestId);
                if (execResult.status === 'Failed') {
                    return { error: `Order failed: ${execResult.error || 'Transaction execution failed'}` };
                }
                if (!execResult.signature) return { error: 'Jupiter execute returned no signature' };

                const warnings = [];
                if (inputToken.warning) warnings.push(`⚠️ ${inputToken.symbol}: ${inputToken.warning}`);
                if (outputToken.warning) warnings.push(`⚠️ ${outputToken.symbol}: ${outputToken.warning}`);

                return {
                    success: true,
                    orderId: execResult.order || execResult.orderId || data.order || null,
                    signature: execResult.signature,
                    inputToken: `${inputToken.symbol} (${inputToken.address})`,
                    outputToken: `${outputToken.symbol} (${outputToken.address})`,
                    inputAmount: input.inputAmount,
                    triggerPrice: input.triggerPrice,
                    expiryTime: expiryTime,
                    warnings: warnings.length > 0 ? warnings : undefined
                };
            } catch (e) {
                return { error: e.message };
            }
        }

        case 'jupiter_trigger_list': {
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
        }

        case 'jupiter_trigger_cancel': {
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

                // 2. Get wallet address
                let walletAddress;
                try {
                    walletAddress = getConnectedWalletAddress();
                } catch (e) {
                    return { error: e.message };
                }

                // 3. Call Jupiter Trigger API — cancelOrder (no retry — non-idempotent POST)
                log(`[Jupiter Trigger] Cancelling order: ${input.orderId}`, 'INFO');
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

                // 5. Sign via MWA
                await ensureWalletAuthorized();
                log('[Jupiter Trigger] Sending cancel tx to wallet for approval...', 'INFO');
                const signResult = await androidBridgeCall('/solana/sign-only', {
                    transaction: data.transaction
                }, 120000);
                if (signResult.error) return { error: signResult.error };
                if (!signResult.signedTransaction) return { error: 'No signed transaction returned from wallet' };

                // 6. Execute
                log('[Jupiter Trigger] Executing cancel transaction...', 'INFO');
                const execResult = await jupiterTriggerExecute(signResult.signedTransaction, data.requestId);
                if (execResult.status === 'Failed') {
                    return { error: `Cancel failed: ${execResult.error || 'Transaction execution failed'}` };
                }
                if (!execResult.signature) return { error: 'Jupiter did not return a transaction signature' };

                return {
                    success: true,
                    orderId: input.orderId,
                    signature: execResult.signature,
                    status: 'cancelled',
                };
            } catch (e) {
                return { error: e.message };
            }
        }

        case 'jupiter_dca_create': {
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

                // 2. Get wallet address
                let walletAddress;
                try {
                    walletAddress = getConnectedWalletAddress();
                } catch (e) {
                    return { error: e.message };
                }

                // 3. Map cycleInterval and validate totalCycles
                const intervalMap = { hourly: 3600, daily: 86400, weekly: 604800 };
                const cycleIntervalSeconds = intervalMap[input.cycleInterval];
                if (!cycleIntervalSeconds) {
                    return { error: `Invalid cycleInterval: "${input.cycleInterval}". Must be "hourly", "daily", or "weekly".` };
                }

                // numberOfOrders: required by API (no "unlimited" option)
                // Jupiter DCA minimums: ≥2 orders, ≥$50/order, ≥$100 total
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
                    const perCycleLamports = parseInputAmountToLamports(input.amountPerCycle, inputToken.decimals);
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

                // 7. Sign via MWA
                await ensureWalletAuthorized();
                log('[Jupiter DCA] Sending to wallet for approval (sign-only)...', 'INFO');
                const signResult = await androidBridgeCall('/solana/sign-only', {
                    transaction: data.transaction
                }, 120000);
                if (signResult.error) return { error: signResult.error };
                if (!signResult.signedTransaction) return { error: 'No signed transaction returned from wallet' };

                // 8. Execute (Jupiter broadcasts)
                log('[Jupiter DCA] Executing signed transaction...', 'INFO');
                const execResult = await jupiterRecurringExecute(signResult.signedTransaction, data.requestId);
                if (execResult.status === 'Failed') {
                    return { error: `DCA order failed: ${execResult.error || 'Transaction execution failed'}` };
                }
                if (!execResult.signature) return { error: 'Jupiter execute returned no signature' };

                const warnings = [];
                if (inputToken.warning) warnings.push(`⚠️ ${inputToken.symbol}: ${inputToken.warning}`);
                if (outputToken.warning) warnings.push(`⚠️ ${outputToken.symbol}: ${outputToken.warning}`);

                return {
                    success: true,
                    orderId: execResult.order || (execResult.orderId) || null,
                    signature: execResult.signature,
                    inputToken: `${inputToken.symbol} (${inputToken.address})`,
                    outputToken: `${outputToken.symbol} (${outputToken.address})`,
                    amountPerCycle: input.amountPerCycle,
                    cycleInterval: input.cycleInterval,
                    totalCycles: numberOfOrders,
                    warnings: warnings.length > 0 ? warnings : undefined
                };
            } catch (e) {
                return { error: e.message };
            }
        }

        case 'jupiter_dca_list': {
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
        }

        case 'jupiter_dca_cancel': {
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

                // 2. Get wallet address
                let walletAddress;
                try {
                    walletAddress = getConnectedWalletAddress();
                } catch (e) {
                    return { error: e.message };
                }

                // 3. Call Jupiter Recurring API — cancelOrder (no retry — non-idempotent POST)
                log(`[Jupiter DCA] Cancelling order: ${input.orderId}`, 'INFO');
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

                // 5. Sign via MWA
                await ensureWalletAuthorized();
                log('[Jupiter DCA] Sending cancel tx to wallet for approval...', 'INFO');
                const signResult = await androidBridgeCall('/solana/sign-only', {
                    transaction: data.transaction
                }, 120000);
                if (signResult.error) return { error: signResult.error };
                if (!signResult.signedTransaction) return { error: 'No signed transaction returned from wallet' };

                // 6. Execute
                log('[Jupiter DCA] Executing cancel transaction...', 'INFO');
                const execResult = await jupiterRecurringExecute(signResult.signedTransaction, data.requestId);
                if (execResult.status === 'Failed') {
                    return { error: `Cancel failed: ${execResult.error || 'Transaction execution failed'}` };
                }
                if (!execResult.signature) return { error: 'Jupiter did not return a transaction signature' };

                return {
                    success: true,
                    orderId: input.orderId,
                    signature: execResult.signature,
                    status: 'cancelled',
                };
            } catch (e) {
                return { error: e.message };
            }
        }

        case 'jupiter_token_search': {
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
                        // Normalize v2 field names: id→address, usdPrice→price, mcap→marketCap, isVerified→verified
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
                        if (token.audit?.isSus) entry.warning = '⚠️ SUSPICIOUS — This token is flagged as suspicious by Jupiter audit.';
                        return entry;
                    })
                };
            } catch (e) {
                return { error: e.message };
            }
        }

        case 'jupiter_token_security': {
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
                if (tokenData.freezeAuthority) warnings.push('❄️ FREEZE RISK - Token has freeze authority enabled');
                if (tokenData.mintAuthority) warnings.push('🏭 MINT RISK - Token has mint authority (can inflate supply)');
                if (tokenData.hasLowLiquidity) warnings.push('💧 LOW LIQUIDITY - May be difficult to trade');

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
                        const match = tokenInfo.tokens?.[0];
                        if (match) {
                            organicScore = match.organicScore ?? null;
                            isSus = match.audit?.isSus ?? null;
                        }
                    }
                } catch (e) {
                    log(`[Jupiter Security] Tokens v2 lookup skipped: ${e.message}`, 'DEBUG');
                }

                if (isSus) warnings.push('🚨 SUSPICIOUS — Token flagged as suspicious by Jupiter audit');

                const result = {
                    success: true,
                    token: `${token.symbol} (${token.address})`,
                    isSafe: warnings.length === 0,
                    warnings: warnings.length > 0 ? warnings : ['✅ No security warnings detected'],
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
        }

        case 'jupiter_wallet_holdings': {
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
        }

        case 'telegram_react': {
            const msgId = input.message_id;
            const chatId = input.chat_id;
            const emoji = String(input.emoji ?? '').trim();
            const remove = input.remove === true;
            if (!msgId) return { error: 'message_id is required' };
            if (!chatId) return { error: 'chat_id is required' };
            if (!emoji && !remove) return { error: 'emoji is required (or set remove: true)' };
            try {
                // When removing: empty array clears all reactions; when setting: pass the emoji
                const reactions = remove ? [] : (emoji ? [{ type: 'emoji', emoji }] : []);
                const result = await telegram('setMessageReaction', {
                    chat_id: chatId,
                    message_id: msgId,
                    reaction: reactions,
                });
                if (result.ok) {
                    const logAction = remove ? `removed${emoji ? ': ' + emoji : ' (all)'}` : 'set: ' + emoji;
                    log(`Reaction ${logAction} on msg ${msgId} in chat ${chatId}`, 'DEBUG');
                    return { ok: true, action: remove ? 'removed' : 'reacted', emoji, message_id: msgId, chat_id: chatId };
                } else {
                    // Check for invalid reaction emoji in Telegram error response
                    const desc = result.description || '';
                    if (desc.includes('REACTION_INVALID')) {
                        return { ok: false, warning: `Invalid reaction emoji "${emoji}" — Telegram may not support it` };
                    }
                    return { ok: false, warning: desc || 'Reaction failed' };
                }
            } catch (e) {
                return { error: e.message };
            }
        }

        case 'telegram_delete': {
            const msgId = input.message_id;
            const chatId = input.chat_id;
            if (!msgId) return { error: 'message_id is required' };
            if (!chatId) return { error: 'chat_id is required' };
            try {
                const result = await telegram('deleteMessage', {
                    chat_id: chatId,
                    message_id: msgId,
                });
                if (result.ok) {
                    log(`Deleted message ${msgId} in chat ${chatId}`, 'DEBUG');
                    return { ok: true, action: 'deleted', message_id: msgId, chat_id: chatId };
                } else {
                    const desc = result.description || '';
                    // Telegram error messages for common failures
                    if (desc.includes('MESSAGE_ID_INVALID') || desc.includes('message not found')) {
                        return { ok: false, warning: 'Message not found or already deleted' };
                    }
                    if (desc.includes('MESSAGE_DELETE_FORBIDDEN') || desc.includes('not enough rights')) {
                        return { ok: false, warning: 'Cannot delete message (no permission or message too old)' };
                    }
                    if (desc.includes('message can\'t be deleted')) {
                        return { ok: false, warning: 'Message cannot be deleted (older than 48h or no admin rights)' };
                    }
                    return { ok: false, warning: desc || 'Delete failed' };
                }
            } catch (e) {
                return { error: e.message };
            }
        }

        case 'telegram_send': {
            const text = input.text;
            if (!text) return { error: 'text is required' };
            if (text.length > 4096) return { error: 'text exceeds Telegram 4096 character limit' };
            if (!chatId) return { error: 'No active chat' };
            // Validate buttons structure if provided
            if (input.buttons) {
                if (!Array.isArray(input.buttons)) return { error: 'buttons must be an array of rows' };
                for (const row of input.buttons) {
                    if (!Array.isArray(row)) return { error: 'Each button row must be an array' };
                    for (const btn of row) {
                        if (!btn.text || !btn.callback_data) return { error: 'Each button must have "text" and "callback_data"' };
                        if (Buffer.byteLength(btn.callback_data, 'utf8') > 64) return { error: `callback_data "${btn.callback_data.slice(0, 20)}..." exceeds Telegram 64-byte limit` };
                    }
                }
            }
            try {
                const cleaned = cleanResponse(text);
                const replyMarkup = input.buttons ? { inline_keyboard: input.buttons } : undefined;
                // Try HTML first, fall back to plain text
                let result, htmlFailed = false;
                try {
                    const payload = {
                        chat_id: chatId,
                        text: toTelegramHtml(cleaned),
                        parse_mode: 'HTML',
                    };
                    if (replyMarkup) payload.reply_markup = replyMarkup;
                    result = await telegram('sendMessage', payload);
                } catch (e) {
                    htmlFailed = true;
                }
                if (htmlFailed || !result || !result.ok) {
                    const payload = {
                        chat_id: chatId,
                        text: cleaned,
                    };
                    if (replyMarkup) payload.reply_markup = replyMarkup;
                    result = await telegram('sendMessage', payload);
                }
                if (result && result.ok && result.result && result.result.message_id) {
                    const messageId = result.result.message_id;
                    recordSentMessage(chatId, messageId, cleaned);
                    log(`telegram_send: sent message ${messageId}`, 'DEBUG');
                    return { ok: true, message_id: messageId, chat_id: chatId };
                }
                if (result) {
                    if (result.ok) return { ok: false, warning: 'Message sent but message_id not returned' };
                    return { ok: false, warning: result.description || 'Send failed' };
                }
                return { ok: false, warning: 'No response from Telegram API' };
            } catch (e) {
                return { error: e.message };
            }
        }

        case 'shell_exec': {
            const { exec } = require('child_process');
            const cmd = (input.command || '').trim();
            if (!cmd) return { error: 'command is required' };

            // Limit command length to prevent abuse
            if (cmd.length > 2048) {
                return { error: 'Command too long (max 2048 characters)' };
            }

            // Block newlines, null bytes, and Unicode line separators
            if (/[\r\n\0\u2028\u2029]/.test(cmd)) {
                return { error: 'Newline, null, or line separator characters are not allowed in commands' };
            }

            // Allowlist of safe command base names (shared constant from config.js).
            const ALLOWED_CMDS = SHELL_ALLOWLIST;

            // Extract the base command (first token before whitespace)
            const firstToken = cmd.split(/\s/)[0].trim();
            // Reject explicit paths (e.g., /usr/bin/rm, ./evil.sh)
            if (firstToken.includes('/') || firstToken.includes('\\')) {
                return { error: 'Command paths are not allowed. Use a bare command name from the allowlist.' };
            }
            if (!ALLOWED_CMDS.has(firstToken)) {
                return { error: `Command "${firstToken}" is not in the allowlist. Allowed: ${[...ALLOWED_CMDS].join(', ')}` };
            }

            // Block shell operators, command substitution, and glob patterns (incl. brackets)
            if (/[;&|`<>$~{}\[\]]|\*|\?/.test(cmd.slice(firstToken.length))) {
                return { error: 'Shell operators (;, &, |, `, <, >, $, *, ?, ~, {}, []) are not allowed in arguments. Run one simple command at a time.' };
            }

            // Resolve working directory (must be within workspace)
            let cwd = workDir;
            if (input.cwd) {
                const cwdInput = String(input.cwd).trim();
                const resolved = safePath(cwdInput);
                if (!resolved) return { error: 'Access denied: cwd is outside workspace' };
                if (!fs.existsSync(resolved)) return { error: `cwd does not exist: ${cwdInput}` };
                const cwdStat = fs.statSync(resolved);
                if (!cwdStat.isDirectory()) return { error: `cwd is not a directory: ${cwdInput}` };
                cwd = resolved;
            }

            // Validate and clamp timeout to [1, 30000]ms
            let timeout = 30000;
            if (input.timeout_ms !== undefined) {
                const t = Number(input.timeout_ms);
                if (!Number.isFinite(t) || t <= 0) {
                    return { error: 'timeout_ms must be a positive number (max 30000)' };
                }
                timeout = Math.min(Math.max(t, 1), 30000);
            }

            // Detect shell: Android uses /system/bin/sh, standard Unix uses /bin/sh
            const shellPath = fs.existsSync('/system/bin/sh') ? '/system/bin/sh' : '/bin/sh';
            // Build child env from process.env (needed for nodejs-mobile paths)
            // but strip any vars that could leak secrets to child processes.
            const childEnv = { ...process.env, HOME: workDir, TERM: 'dumb' };
            // Remove sensitive patterns (API keys, tokens, credentials)
            for (const key of Object.keys(childEnv)) {
                const k = key.toUpperCase();
                if (k.includes('KEY') || k.includes('TOKEN') || k.includes('SECRET') ||
                    k.includes('PASSWORD') || k.includes('CREDENTIAL') || k.includes('AUTH')) {
                    delete childEnv[key];
                }
            }

            // Use async exec to avoid blocking the event loop
            return new Promise((resolve) => {
                exec(cmd, {
                    cwd,
                    timeout,
                    encoding: 'utf8',
                    maxBuffer: 1024 * 1024, // 1MB
                    shell: shellPath,
                    env: childEnv
                }, (err, stdout, stderr) => {
                    if (err) {
                        if (err.killed && err.signal) {
                            log(`shell_exec TIMEOUT: ${cmd.slice(0, 80)}`, 'WARN');
                            resolve({
                                success: false,
                                command: cmd,
                                stdout: (stdout || '').slice(0, 50000),
                                stderr: `Command timed out after ${timeout}ms`,
                                exit_code: err.code || 1
                            });
                        } else {
                            log(`shell_exec FAIL (exit ${err.code || '?'}): ${cmd.slice(0, 80)}`, 'WARN');
                            resolve({
                                success: false,
                                command: cmd,
                                stdout: (stdout || '').slice(0, 50000),
                                stderr: (stderr || '').slice(0, 10000) || err.message || 'Unknown error',
                                exit_code: err.code || 1
                            });
                        }
                    } else {
                        log(`shell_exec OK: ${cmd.slice(0, 80)}`, 'DEBUG');
                        resolve({
                            success: true,
                            command: cmd,
                            stdout: (stdout || '').slice(0, 50000),
                            stderr: (stderr || '').slice(0, 10000),
                            exit_code: 0
                        });
                    }
                });
            });
        }

        case 'js_eval': {
            const code = (input.code || '').trim();
            if (!code) return { error: 'code is required' };
            if (code.length > 10000) return { error: 'Code too long (max 10000 characters)' };
            if (/\0/.test(code)) return { error: 'Null bytes are not allowed in code' };

            let timeout = 30000;
            if (input.timeout_ms !== undefined) {
                const t = Number(input.timeout_ms);
                if (!Number.isFinite(t) || t <= 0) {
                    return { error: 'timeout_ms must be a positive number (max 30000)' };
                }
                timeout = Math.min(Math.max(t, 1), 30000);
            }

            // Capture console output
            const logs = [];
            const pushLog = (prefix, args) => logs.push((prefix ? prefix + ' ' : '') + args.map(a => {
                if (typeof a === 'object' && a !== null) try { return JSON.stringify(a); } catch { return String(a); }
                return String(a);
            }).join(' '));
            const mockConsole = {
                log: (...args) => pushLog('', args),
                info: (...args) => pushLog('', args),
                warn: (...args) => pushLog('[warn]', args),
                error: (...args) => pushLog('[error]', args),
                debug: (...args) => pushLog('[debug]', args),
                trace: (...args) => pushLog('[trace]', args),
                dir: (obj) => pushLog('', [obj]),
                table: (data) => pushLog('[table]', [data]),
                time: () => {}, timeEnd: () => {}, timeLog: () => {},
                assert: (cond, ...args) => { if (!cond) pushLog('[assert]', args.length ? args : ['Assertion failed']); },
                clear: () => {},
                count: () => {}, countReset: () => {},
                group: () => {}, groupEnd: () => {}, groupCollapsed: () => {},
            };

            // Sandboxed require: block dangerous modules and restrict fs access to sensitive files
            const BLOCKED_MODULES = new Set(['child_process', 'cluster', 'worker_threads', 'vm', 'v8', 'perf_hooks']);
            // Create a guarded fs proxy that blocks reads AND writes to sensitive files
            // promisesGuard: optional set of guarded methods for the .promises sub-property
            const createGuardedFsProxy = (realModule, guardedMethods, promisesGuard) => {
                return new Proxy(realModule, {
                    get(target, prop) {
                        // Intercept fs.promises to return a guarded proxy too
                        if (prop === 'promises' && promisesGuard && target[prop]) {
                            return createGuardedFsProxy(target[prop], promisesGuard);
                        }
                        const original = target[prop];
                        if (typeof original !== 'function') return original;
                        if (guardedMethods.has(prop)) {
                            return function(...args) {
                                const filePath = String(args[0]);
                                const basename = path.basename(filePath);
                                if (SECRETS_BLOCKED.has(basename)) {
                                    throw new Error(`Access to ${basename} is blocked for security.`);
                                }
                                return original.apply(target, args);
                            };
                        }
                        return original.bind(target);
                    }
                });
            };
            const FS_GUARDED = new Set([
                'readFileSync', 'readFile', 'createReadStream', 'openSync', 'open',
                'writeFileSync', 'writeFile', 'appendFileSync', 'appendFile', 'createWriteStream',
                'copyFileSync', 'copyFile', 'cpSync', 'cp',
            ]);
            const FSP_GUARDED = new Set(['readFile', 'writeFile', 'appendFile', 'open', 'copyFile', 'cp']);
            const sandboxedRequire = (mod) => {
                if (BLOCKED_MODULES.has(mod)) {
                    throw new Error(`Module "${mod}" is blocked in js_eval for security. Use shell_exec for command execution.`);
                }
                if (mod === 'fs') return createGuardedFsProxy(require('fs'), FS_GUARDED, FSP_GUARDED);
                if (mod === 'fs/promises') return createGuardedFsProxy(require('fs/promises'), FSP_GUARDED);
                return require(mod);
            };

            let timerId;
            try {
                // AsyncFunction allows top-level await
                const AsyncFunction = Object.getPrototypeOf(async function(){}).constructor;
                // Shadow process/global/globalThis to prevent process.mainModule.require bypass
                // Provide safe process subset — env is empty to prevent leaking sensitive variables
                const safeProcess = { env: {}, cwd: () => workDir, platform: process.platform, arch: process.arch, version: process.version };
                const fn = new AsyncFunction('console', 'require', '__dirname', '__filename', 'process', 'global', 'globalThis', code);

                const resultPromise = fn(mockConsole, sandboxedRequire, workDir, path.join(workDir, 'eval.js'), safeProcess, undefined, undefined);
                const timeoutPromise = new Promise((_, rej) => {
                    timerId = setTimeout(() => rej(new Error(`Execution timed out after ${timeout}ms`)), timeout);
                });

                const result = await Promise.race([resultPromise, timeoutPromise]);
                clearTimeout(timerId);
                const output = logs.join('\n');

                // Serialize result: JSON for objects/arrays, String for primitives
                let resultStr;
                if (result === undefined) {
                    resultStr = undefined;
                } else if (typeof result === 'object' && result !== null) {
                    try { resultStr = JSON.stringify(result, null, 2).slice(0, 50000); } catch { resultStr = String(result).slice(0, 50000); }
                } else {
                    resultStr = String(result).slice(0, 50000);
                }

                log(`js_eval OK (${code.length} chars)`, 'DEBUG');
                return {
                    success: true,
                    result: resultStr,
                    output: output ? output.slice(0, 50000) : undefined,
                };
            } catch (err) {
                clearTimeout(timerId);
                const output = logs.join('\n');
                log(`js_eval FAIL: ${err.message.slice(0, 100)}`, 'WARN');
                return {
                    success: false,
                    error: err.message.slice(0, 5000),
                    output: output ? output.slice(0, 50000) : undefined,
                };
            }
        }

        case 'telegram_send_file': {
            if (!input.path) return { error: 'path is required' };
            if (!input.chat_id) return { error: 'chat_id is required' };

            const filePath = safePath(input.path);
            if (!filePath) return { error: 'Access denied: path outside workspace' };
            if (!fs.existsSync(filePath)) return { error: `File not found: ${input.path}` };

            let stat;
            try { stat = fs.statSync(filePath); } catch (e) { return { error: `Cannot stat file: ${e.message}` }; }
            if (stat.isDirectory()) return { error: 'Cannot send a directory. Specify a file path.' };
            if (stat.size === 0) return { error: 'Cannot send empty file (0 bytes)' };

            const MAX_SEND_SIZE = 50 * 1024 * 1024; // 50MB Telegram bot limit
            const MAX_PHOTO_SIZE = 10 * 1024 * 1024; // 10MB for sendPhoto
            if (stat.size > MAX_SEND_SIZE) {
                return { error: `📦 That file's too big (${(stat.size / 1024 / 1024).toFixed(1)}MB, max 50MB). Can you send a smaller one?` };
            }

            const ext = path.extname(filePath).toLowerCase();
            const fileName = path.basename(filePath);
            let detected = detectTelegramFileType(ext);

            // Manual type override
            if (input.type) {
                const TYPE_MAP = {
                    document: { method: 'sendDocument', field: 'document' },
                    photo: { method: 'sendPhoto', field: 'photo' },
                    audio: { method: 'sendAudio', field: 'audio' },
                    voice: { method: 'sendVoice', field: 'voice' },
                    video: { method: 'sendVideo', field: 'video' },
                };
                detected = TYPE_MAP[input.type] || detected;
            }

            // Photos > 10MB must be sent as document (applies to both auto-detected and overridden)
            if (detected.method === 'sendPhoto' && stat.size > MAX_PHOTO_SIZE) {
                const safLogName = fileName.replace(/[\r\n\0\u2028\u2029]/g, '_');
                log(`[TgSendFile] Photo ${safLogName} is ${(stat.size / 1024 / 1024).toFixed(1)}MB — downgrading to document`, 'DEBUG');
                detected = { method: 'sendDocument', field: 'document' };
            }

            try {
                const params = { chat_id: String(input.chat_id) };
                if (input.caption) params.caption = String(input.caption).slice(0, 1024);

                const safLogName = fileName.replace(/[\r\n\0\u2028\u2029]/g, '_');
                log(`[TgSendFile] ${detected.method}: ${safLogName} (${(stat.size / 1024).toFixed(1)}KB) → chat ${input.chat_id}`, 'DEBUG');
                const result = await telegramSendFile(detected.method, params, detected.field, filePath, fileName, stat.size);

                if (result && result.ok === true) {
                    log(`[TgSendFile] Sent successfully`, 'DEBUG');
                    return { success: true, method: detected.method, file: input.path, size: stat.size };
                } else {
                    const desc = (result && result.description) || 'Unknown error';
                    log(`[TgSendFile] Failed: ${desc}`, 'WARN');
                    return { error: `Telegram API error: ${desc}` };
                }
            } catch (e) {
                log(`[TgSendFile] Error: ${e && e.message ? e.message : String(e)}`, 'ERROR');
                return { error: e && e.message ? e.message : String(e) };
            }
        }

        case 'delete': {
            // Core identity files + secrets (uses shared SECRETS_BLOCKED for the latter)
            const DELETE_PROTECTED = new Set([
                'SOUL.md', 'MEMORY.md', 'IDENTITY.md', 'USER.md', 'HEARTBEAT.md',
                ...SECRETS_BLOCKED,
            ]);

            if (!input.path) return { error: 'path is required' };
            const filePath = safePath(input.path);
            if (!filePath) return { error: 'Access denied: path outside workspace' };

            // Check against protected files (compare basename for top-level, full relative for nested)
            const relativePath = path.relative(workDir, filePath);
            const baseName = path.basename(filePath);
            if (DELETE_PROTECTED.has(relativePath) || DELETE_PROTECTED.has(baseName)) {
                return { error: `Cannot delete protected file: ${baseName}` };
            }

            if (!fs.existsSync(filePath)) {
                return { error: `File not found: ${input.path}` };
            }

            try {
                const stat = fs.statSync(filePath);
                if (stat.isDirectory()) {
                    return { error: 'Cannot delete directories. Delete individual files instead.' };
                }

                fs.unlinkSync(filePath);
                // Sanitize path for logging (strip control chars)
                const safLogPath = String(input.path).replace(/[\r\n\0\u2028\u2029]/g, '_');
                log(`File deleted: ${safLogPath}`, 'DEBUG');
                return { success: true, path: input.path, deleted: true };
            } catch (err) {
                log(`Error deleting file: ${err && err.message ? err.message : String(err)}`, 'ERROR');
                return { error: `Failed to delete file: ${err && err.message ? err.message : String(err)}` };
            }
        }

        default:
            // Route MCP tools (mcp__<server>__<tool>) to MCPManager
            if (name.startsWith('mcp__')) {
                if (_mcpExecuteTool) return await _mcpExecuteTool(name, input);
                return { error: `MCP tools not available — mcpManager not wired` };
            }
            return { error: `Unknown tool: ${name}` };
    }
}

// Helper to recursively list files in a directory (used by skill_read)
function listFilesRecursive(dir, maxDepth = 3, currentDepth = 0) {
    if (currentDepth >= maxDepth) return [];
    const results = [];
    try {
        const entries = fs.readdirSync(dir, { withFileTypes: true });
        for (const entry of entries) {
            const fullPath = path.join(dir, entry.name);
            // Skip symlinks for security
            if (entry.isSymbolicLink()) continue;
            if (entry.isFile()) {
                results.push(fullPath);
            } else if (entry.isDirectory() && !entry.name.startsWith('.')) {
                results.push(...listFilesRecursive(fullPath, maxDepth, currentDepth + 1));
            }
        }
    } catch (e) { /* ignore permission errors */ }
    return results;
}

// Helper to format bytes
function formatBytes(bytes) {
    if (bytes === 0) return '0 B';
    const k = 1024;
    const sizes = ['B', 'KB', 'MB', 'GB'];
    const i = Math.floor(Math.log(bytes) / Math.log(k));
    return parseFloat((bytes / Math.pow(k, i)).toFixed(2)) + ' ' + sizes[i];
}


// ============================================================================
// EXPORTS
// ============================================================================

module.exports = {
    TOOLS, executeTool,
    formatConfirmationMessage, requestConfirmation,
    pendingConfirmations, lastToolUseTime,
    listFilesRecursive, formatBytes,
    setMcpExecuteTool,
};
