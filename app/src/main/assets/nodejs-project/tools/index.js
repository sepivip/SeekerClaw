// tools/index.js — Tool registry + executeTool() dispatcher (BAT-470)
// Merges all domain modules, builds handler dispatch map, routes tool calls.

const { log, CHANNEL } = require('../config');
const channel = require('../channel');
// BAT-582 R1: BigInt-safe decimal math for monetary values (e.g. DCA total
// deposit display). Avoids JS Number coercion on user-supplied strings.
const { _decimalToAtomic } = require('../caps/preflight');

// ── Domain modules ───────────────────────────────────────────────────────────

const webMod      = require('./web');
const memoryMod   = require('./memory');
const fileMod     = require('./file');
const skillMod    = require('./skill');
const cronMod     = require('./cron');
const sessionMod  = require('./session');
const androidMod  = require('./android');
const solanaMod   = require('./solana');
const telegramMod = CHANNEL === 'telegram' ? require('./telegram') : null;
const systemMod   = require('./system');
const envMod      = require('./env');
// BAT-582 Phase 4: wallet_status + wallet_set_caps
const walletMod   = require('./wallet');
// BAT-582 Phase 6: agent_pay (x402 client)
const agentPayMod = require('./agent_pay');

// ── Merged TOOLS array ───────────────────────────────────────────────────────

const TOOLS = [
    ...webMod.tools,
    ...memoryMod.tools,
    ...fileMod.tools,
    ...skillMod.tools,
    ...cronMod.tools,
    ...sessionMod.tools,
    ...androidMod.tools,
    ...solanaMod.tools,
    ...(telegramMod ? telegramMod.tools : []),
    ...systemMod.tools,
    ...envMod.tools,
    ...walletMod.tools,
    ...agentPayMod.tools,
];

// ── Handler dispatch map ─────────────────────────────────────────────────────

const handlerMap = Object.assign({},
    webMod.handlers,
    memoryMod.handlers,
    fileMod.handlers,
    skillMod.handlers,
    cronMod.handlers,
    sessionMod.handlers,
    androidMod.handlers,
    solanaMod.handlers,
    ...(telegramMod ? [telegramMod.handlers] : []),
    systemMod.handlers,
    envMod.handlers,
    walletMod.handlers,
    agentPayMod.handlers,
);

// ── Shared state ─────────────────────────────────────────────────────────────

let _mcpExecuteTool = null;

function setMcpExecuteTool(fn) {
    _mcpExecuteTool = fn;
}

const pendingConfirmations = new Map(); // chatId -> { resolve, timer }
const lastToolUseTime = new Map();      // toolName -> timestamp

// BAT-255: Safe number-to-decimal-string conversion.
// String(0.0000001) -> "1e-7" but we need "0.0000001" for parseInputAmountToLamports.
function numberToDecimalString(n) {
    const s = String(n);
    if (!s.includes('e') && !s.includes('E')) return s;
    return n.toFixed(20).replace(/\.?0+$/, '');
}

// BAT-582 R1: BigInt → decimal string for confirmation-message display.
// Inverse of caps/preflight's _decimalToAtomic; formats `atomicBig` (BigInt)
// using `decimals` fractional digits and trims trailing zeros so the
// confirmation prompt reads "1.5" not "1.500000000". Returns null on
// non-BigInt input so caller can fall back to a "?" placeholder rather
// than rendering "[object Object]".
function _atomicBigIntToDecimal(atomicBig, decimals) {
    if (typeof atomicBig !== 'bigint') return null;
    let s = atomicBig.toString();
    const negative = s.startsWith('-');
    if (negative) s = s.slice(1);
    if (s === '0') return '0';
    const pad = s.padStart(decimals + 1, '0');
    const head = pad.slice(0, pad.length - decimals);
    const tail = pad.slice(pad.length - decimals).replace(/0+$/, '');
    const out = tail.length ? `${head}.${tail}` : head;
    return negative ? `-${out}` : out;
}

// BAT-582 R1: BigInt-safe DCA total-deposit math for the confirmation
// message. amountPerCycle is a user-supplied decimal string; multiplying
// it by JS Number (`input.amountPerCycle * cycles`) silently produces
// NaN/precision loss (e.g. "0.1" × 30 = 3.0000000000000004) and on string
// inputs always yields NaN. We parse to atomic BigInt, multiply by cycles
// as BigInt, then format back to a clean decimal string for display.
//
// Token decimals are derived from the input symbol/mint: SOL → 9 lamports,
// USDC (or its mainnet mint) → 6 microunits, anything else → null and we
// fall back to a placeholder. This keeps the confirmation message correct
// for the 99% case (SOL/USDC DCA) without hard-coding decimals for every
// possible SPL — that decision belongs in routing / tool execution, not in
// the confirmation prompt's display string.
const _SOL_DECIMALS_DISPLAY = 9;
const _USDC_DECIMALS_DISPLAY = 6;
const _USDC_MINT_DISPLAY = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v';
function _decimalsForToken(tokenSymbolOrMint) {
    if (!tokenSymbolOrMint) return null;
    const s = String(tokenSymbolOrMint).trim();
    const lower = s.toLowerCase();
    if (lower === 'sol' || lower === 'so11111111111111111111111111111111111111112') {
        return _SOL_DECIMALS_DISPLAY;
    }
    if (lower === 'usdc' || s === _USDC_MINT_DISPLAY) {
        return _USDC_DECIMALS_DISPLAY;
    }
    return null;
}
// BAT-582 R10: maximum digit-string length we'll BigInt-parse on the
// agent-controlled `totalCycles` path. V8's BigInt construction is O(n²)
// in the digit count for large arbitrary-precision values — a 10MB digit
// string would burn CPU and heap before the rest of the cap-math runs.
// 20 digits comfortably allows the R7 BigInt-precision regression test
// (which uses 16-digit values past Number.MAX_SAFE_INTEGER, e.g.
// 9007199254740993) and rejects any pathological prompt-injection payload.
// Bound is in DIGIT COUNT, not byte count, but [0-9]-class strings are
// 1:1 with bytes here (regex already gated to ASCII 0-9). Precompiled at
// module load — `_formatDcaTotalDeposit` is on the per-tool-call hot path.
const _BOUNDED_CYCLES_RE = /^[0-9]{1,20}$/;

function _formatDcaTotalDeposit(amountPerCycle, totalCycles, inputToken) {
    const decimals = _decimalsForToken(inputToken);
    if (decimals == null) return '?'; // unknown token decimals — agent will see the per-cycle amount; total is a hint
    // BAT-582 R3: accept numeric strings ("10") in addition to numbers.
    // The agent (especially via prompt-injected JSON) regularly passes
    // numeric fields as strings; the previous `typeof === 'number'` check
    // silently fell through to the 30-cycle default, producing
    // "Cycles: 10, Total deposit: <30-cycle value>" — a confirmation
    // message internally inconsistent with what the user reads.
    let cyclesBig = 30n;
    if (typeof totalCycles === 'number' && Number.isInteger(totalCycles) && totalCycles > 0) {
        // Number path: config/internal callers — assumed within Number.MAX_SAFE_INTEGER
        // since these values come from user-typed cycle counts (typical max: thousands).
        // The string path below is the agent-controlled path; that one MUST avoid
        // any Number round-trip to preserve precision for arbitrarily large digit strings.
        cyclesBig = BigInt(totalCycles);
    } else if (typeof totalCycles === 'string' && _BOUNDED_CYCLES_RE.test(totalCycles)) {
        // BAT-582 R7: convert digit string directly to BigInt — `parseInt` would
        // truncate to a Number first, losing precision past 2^53-1 and silently
        // corrupting cap-math for very large totalCycles values.
        // BAT-582 R10: regex bounds the digit string to ≤20 chars BEFORE
        // BigInt() runs so model-controlled `totalCycles` can't DoS the
        // confirmation pipeline with a 10MB digit payload. The try/catch
        // is defense in depth — the regex already guarantees BigInt()
        // succeeds, but a future refactor that weakens the regex must
        // not crash the confirmation generator.
        try {
            const n = BigInt(totalCycles);
            if (n > 0n) cyclesBig = n;
        } catch (_) { /* fall through to the 30-cycle default */ }
    }
    const perCycleAtomic = _decimalToAtomic(amountPerCycle, decimals);
    if (perCycleAtomic == null) return '?';
    let perCycleBig;
    try { perCycleBig = BigInt(perCycleAtomic); } catch (_) { return '?'; }
    const totalBig = perCycleBig * cyclesBig;
    return _atomicBigIntToDecimal(totalBig, decimals) || '?';
}

// ── Wire cross-module dependencies ───────────────────────────────────────────

solanaMod._setNumberToDecimalString(numberToDecimalString);
memoryMod._setFormatBytes(fileMod.formatBytes);
// DeerFlow P2: tool_search needs access to ALL tools (static + MCP).
// Default to static TOOLS; main.js upgrades this after MCP is initialized.
let _fullToolGetter = () => TOOLS;
systemMod._setToolRegistry(() => _fullToolGetter());

function setFullToolRegistry(getter) { _fullToolGetter = getter; }

// ── Confirmation UI ──────────────────────────────────────────────────────────

// Format a human-readable confirmation message for the user.
// Uses Markdown — Telegram's toTelegramHtml() converts **bold** to <b>bold</b>,
// Discord renders **bold** natively. One format, both channels work.
//
// BAT-582 Phase 4: when the dynamic confirmation policy hook returns a custom
// message (e.g. wallet_set_caps's old → new diff), pass it as `policyMessage`
// and we use it as the "details" line instead of the per-tool template.
function formatConfirmationMessage(toolName, input, policyMessage) {
    const esc = (s) => {
        let v = String(s ?? '');
        if (v.length > 200) v = v.slice(0, 197) + '...';
        return v;
    };
    // R-pr370-fix-3 (BAT-664): policy hooks construct their own preview
    // strings (agent_pay POST: method + URL + max_usdc + 200-char body
    // preview; wallet_set_caps: old→new cap diffs). These messages are
    // intentionally multi-line and can exceed the 200-char per-field cap.
    // Use a more generous limit for explicit policyMessage so URLs +
    // body previews aren't decapitated. 1024 chars covers a long URL +
    // a 200-char body preview + framing comfortably; still bounded so
    // a buggy hook can't blow up the confirmation card.
    //
    // R-pr370-fix-13 (security): the policyMessage can include
    // model-controlled args (e.g. wallet_set_caps decimals, agent_pay
    // URL/body). markdown-it on the channel side renders backticks as
    // code, [text](url) as links, ** as bold, etc. Escape Markdown
    // metacharacters here at the render boundary so EVERY policy hook
    // is safe by default — individual hooks don't have to remember to
    // sanitize. Newlines are PRESERVED so multi-line cards still
    // render as separate visual lines (hooks that want a single-line
    // preview must literalize their own newlines first).
    const escPolicy = (s) => {
        let v = String(s ?? '');
        // Escape backslash first (so we don't double-escape markers below).
        v = v.replace(/\\/g, '\\\\');
        // Markdown structure characters + HTML angle brackets. Use explicit
        // \[ and \] inside the character class so the regex is unambiguous
        // to future readers (the parser handles `[\]]` correctly but mixed
        // escaping inside a class is a recurring source of confusion).
        v = v.replace(/[`*_~\[\](){}#>|!<>]/g, (c) => '\\' + c);
        // Strip control chars OTHER than newlines (newlines are the
        // structural separator for multi-line cards and must survive).
        // eslint-disable-next-line no-control-regex
        v = v.replace(/[\x00-\x09\x0B-\x1F\x7F]/g, ' ');
        // R-pr370-fix-40/42: neutralize Markdown line-start structures.
        // markdown-it auto-renders:
        //   `- foo` / `+ foo` / `1. foo` → list items
        //   `--- ` → horizontal rule (or setext H2 underline)
        //   `=== ` → setext H1 underline
        // (`***` and `___` HR patterns are already neutralized by the
        // per-character escape pass above — every `*` and `_` becomes
        // `\*` / `\_` which breaks the contiguous-marker requirement
        // markdown-it uses to detect HRs.)
        //
        // Because we intentionally preserve newlines for multi-line cards,
        // a model-controlled value containing `\n--- ` could inject a
        // visual divider or restructure the card. Escape the line-leading
        // marker so each renders as literal text.
        v = v.replace(/(^|\n)([-+])(\s)/g, '$1\\$2$3');
        v = v.replace(/(^|\n)(\d+)(\.)(\s)/g, '$1$2\\$3$4');
        v = v.replace(/(^|\n)(-{3,}|={3,})/g, (m, lead, run) => `${lead}\\${run[0]}${run.slice(1)}`);
        // R-pr370-fix-18 (security): markdown-it's `linkify: true` auto-
        // detects raw URLs (http:// / https:// / ftp:// etc.) and renders
        // them as clickable links — even after Markdown char escaping.
        // An attacker-controlled body preview containing a URL would
        // render as a clickable phishing link in the confirmation card.
        // Insert a zero-width space (U+200B) between the scheme and `//`
        // to break linkify's detection. URLs remain visually readable
        // (the ZWSP renders as nothing) but copy/paste users get a tiny
        // anomaly they can clean up — preferable to a one-click phish.
        // R-pr370-fix-19/23/26/28: declare ZWSP via String.fromCharCode so
        // the literal U+200B character never appears in source.
        const ZWSP = String.fromCharCode(0x200B);
        // Break schemed URLs (http://, https://, ftp://, ws://, wss://,
        // file://, data://).
        v = v.replace(/(https?|ftp|ws|wss|file|data):\/\//gi, `$1:${ZWSP}//`);
        // R-pr370-fix-32/34/38: break BARE DOMAINS (no scheme). markdown-it
        // linkify defaults to `fuzzyLink: true`, which auto-detects
        // patterns like "attacker.evil.com" or "www.example.org" and
        // renders them as clickable links without any explicit scheme.
        //
        // Match an alpha-led label as a capture group + `.` + lookahead
        // for 2+ alphabetic chars, then re-insert the captured label
        // before the ZWSP. The capture-group approach avoids a
        // variable-length lookbehind (which some JS engines don't
        // support — V8 does, but explicit capture is portable). For
        // consecutive dots in `api.example.com`, /g advances past each
        // match (past the consumed label + dot), then the next
        // iteration starts on `example` and matches its trailing dot
        // too — both dots get a ZWSP. Numeric values like "0.10" are
        // not mangled because the capture group requires alpha-led.
        v = v.replace(/([a-z][a-z0-9-]*)\.(?=[a-z]{2,})/gi, `$1${ZWSP}.`);
        // R-pr370-fix-15: cap AFTER escaping + de-linkify so the rendered
        // message is actually bounded. Escaping can roughly double the
        // byte count (every `*` becomes `\*`); de-linkify adds ~1 char
        // per URL. Cap the final output, not the input.
        if (v.length > 1024) v = v.slice(0, 1021) + '...';
        return v;
    };
    let details;
    if (typeof policyMessage === 'string' && policyMessage.length > 0) {
        details = `**${esc(toolName)}** — ${escPolicy(policyMessage)}`;
    } else {
        switch (toolName) {
            case 'android_sms':
                details = `📱 **Send SMS**\n  To: \`${esc(input.phone)}\`\n  Message: "${esc(input.message)}"`;
                break;
            case 'android_call':
                details = `📞 **Make Phone Call**\n  To: \`${esc(input.phone)}\``;
                break;
            case 'solana_send':
                details = `💸 **Send SOL**\n  To: \`${esc(input.to)}\`\n  Amount: ${esc(input.amount)} SOL`;
                break;
            case 'solana_swap':
                details = `🔄 **Swap Tokens**\n  Sell: ${esc(input.amount)} ${esc(input.inputToken)}\n  Buy: ${esc(input.outputToken)}`;
                break;
            case 'jupiter_trigger_create':
                details = `📊 **Create Trigger Order**\n  Sell: ${esc(input.inputAmount)} ${esc(input.inputToken)}\n  For: ${esc(input.outputToken)}\n  Trigger price: ${esc(input.triggerPrice)}`;
                break;
            case 'jupiter_dca_create': {
                // BAT-582 R1: total deposit was previously computed via
                // `input.amountPerCycle * (input.totalCycles || 30)` — JS
                // Number multiplication on user-supplied strings produces
                // NaN, and on big values loses precision. Now BigInt-safe.
                const totalDeposit = _formatDcaTotalDeposit(
                    input.amountPerCycle,
                    input.totalCycles,
                    input.inputToken,
                );
                details = `🔄 **Create DCA Order**\n  ${esc(input.amountPerCycle)} ${esc(input.inputToken)} → ${esc(input.outputToken)}\n  Every: ${esc(input.cycleInterval)}\n  Cycles: ${input.totalCycles != null ? esc(String(input.totalCycles)) : '30 (default)'}\n  Total deposit: ${esc(totalDeposit)} ${esc(input.inputToken)}`;
                break;
            }
            default:
                details = `**${esc(toolName)}**`;
        }
    }
    return `⚠️ **Action requires confirmation:**\n\n${details}\n\nReply **YES** to proceed or anything else to cancel.\n_(Auto-cancels in 60s)_`;
}

// Send confirmation message and wait for user reply (Promise-based).
// BAT-582 Phase 4: optional `policyMessage` overrides the per-tool template
// (used by the dynamic confirmation policy hook for wallet_set_caps diffs etc.)
function requestConfirmation(chatId, toolName, input, policyMessage) {
    // BAT-326: Cron sessions use synthetic chatIds (e.g. "cron:abc123") that are not
    // valid Telegram chat IDs. Auto-deny confirmation-gated tools in cron turns with
    // a clear error rather than sending a Telegram message that will always fail.
    // #298: Heartbeat probes use "__heartbeat__" chatId — same restriction applies.
    if (typeof chatId === 'string' && (chatId.startsWith('cron:') || chatId === '__heartbeat__')) {
        const ctx = chatId.startsWith('cron:') ? 'scheduled tasks' : 'heartbeat probes';
        log(`[Confirm] Rejected ${toolName} in ${ctx} (${chatId}) — confirmation-gated tools not available`, 'WARN');
        return Promise.reject(new Error(`${toolName} requires user confirmation which is not available in ${ctx}. Confirmation-gated tools (swaps, transfers, etc.) cannot be used here.`));
    }

    const msg = formatConfirmationMessage(toolName, input, policyMessage);
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
        channel.sendMessage(chatId, msg).then((result) => {
            if (result && result.error) {
                log(`[Confirm] Channel rejected confirmation message: ${result.error}`, 'WARN');
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

// ── executeTool() dispatcher ─────────────────────────────────────────────────

async function executeTool(name, input, chatId) {
    log(`Executing tool: ${name}`, 'DEBUG');
    // OpenClaw parity: normalize whitespace-padded tool names
    name = typeof name === 'string' ? name.trim() : '';
    if (!name) return { error: 'Tool name is required and must be a non-empty string after trimming whitespace.' };

    // Look up handler in dispatch map
    const handler = handlerMap[name];
    if (handler) {
        return await handler(input, chatId);
    }

    // Route MCP tools (mcp__<server>__<tool>) to MCPManager
    if (name.startsWith('mcp__')) {
        if (_mcpExecuteTool) return await _mcpExecuteTool(name, input);
        return { error: `MCP tools not available — mcpManager not wired` };
    }

    return { error: `Unknown tool: ${name}` };
}

// ── Re-exported helpers ──────────────────────────────────────────────────────

const { listFilesRecursive, formatBytes } = fileMod;

// ============================================================================
// EXPORTS
// ============================================================================

module.exports = {
    TOOLS, executeTool,
    formatConfirmationMessage, requestConfirmation,
    pendingConfirmations, lastToolUseTime,
    listFilesRecursive, formatBytes,
    setMcpExecuteTool, setFullToolRegistry,
    // BAT-582 R7: exposed for unit tests — verifies BigInt cycles preservation
    // for very large totalCycles digit strings (above Number.MAX_SAFE_INTEGER).
    _formatDcaTotalDeposit,
};
