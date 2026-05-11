// SeekerClaw — confirmation/policy.js
// Dynamic confirmation hook (BAT-582 Phase 4). Replaces the static
// CONFIRM_REQUIRED constant in config.js. Called from ai.js BEFORE every
// tool dispatch.
//
// Returns a string OR an object:
//   "none"                                 → dispatch the tool directly
//   { policy: "confirm", message? }        → run the existing confirmation flow
//   { policy: "block",   reason, message } → do NOT dispatch; return tool error
//
// For backward-compat with the existing ai.js gate (which only knew "is in
// CONFIRM_REQUIRED → confirm, else direct dispatch"), the gate code in ai.js
// branches on a normalized result. The simple string "confirm" / "none" /
// "block" forms are also accepted for terseness.
//
// REGRESSION SAFETY (NON-NEGOTIABLE)
// ----------------------------------
// When walletState.burnerConfigured === false, the hook MUST return the same
// policy as the v1.0 static set for every existing tool. The Phase 1 snapshot
// V1_STATIC_CONFIRM is the canonical record of the v1.0 set. The regression
// test (tests/nodejs-project/confirmation-policy.test.js) verifies this.
//
// CONTRACT MATRIX (BAT-582 v1.4 — "Confirmation policy")
// ------------------------------------------------------
// | tool                         | burner | routing | underCap | policy      |
// | solana_send/swap/Jup-create  | false  | n/a     | n/a      | confirm     |
// | solana_send/swap/Jup-create  | true   | burner  | true     | none        |
// | solana_send/swap/Jup-create  | true   | burner  | false    | block (raise cap or use main) |
// | solana_send/swap/Jup-create  | true   | main    | n/a      | confirm     |
// | jupiter_*_cancel             | any    | per creator-role                | |
// |   creatorRole=burner         |        |                                  | none |
// |   creatorRole=main|unknown   |        |                                  | confirm |
// | wallet_set_caps              | any    | n/a     | n/a      | confirm (with old→new diff) |
// | agent_pay (with max_usdc)    | any    | n/a     | n/a      | none (real demand check happens inside the tool, Phase 6) |
// | wallet_status                | any    | n/a     | n/a      | none        |
// | (any other tool in v1.0 set) | n/a    | n/a     | n/a      | confirm     |

'use strict';

// Mirror of the v1.0 static CONFIRM_REQUIRED set in config.js (line 681 at the
// time of the Phase 1 snapshot). Phase 4 REMOVES the constant from config.js,
// and this set becomes the regression-test source of truth. The pinned
// regression test (tests/nodejs-project/confirmation-policy.test.js) asserts
// that this set still matches the documented v1.0 contract.
//
// IF YOU ADD a tool that should always require confirmation regardless of
// burner state, append it here AND wire the burner-specific override below
// (or accept the v1.0 default of "always confirm").
const V1_STATIC_CONFIRM = new Set([
    'android_sms',
    'android_call',
    'android_camera_capture',
    'android_location',
    'solana_send',
    'solana_swap',
    'jupiter_trigger_create',
    'jupiter_dca_create',
]);

// Tools that participate in burner routing for write actions.
const SOLANA_WRITE_TOOLS = new Set([
    'solana_send',
    'solana_swap',
    'jupiter_trigger_create',
    'jupiter_dca_create',
]);

// Jupiter cancel tools route by creator-role (ownership-gated).
const JUPITER_CANCEL_TOOLS = new Set([
    'jupiter_trigger_cancel',
    'jupiter_dca_cancel',
]);

// ── Helpers for diff messages ────────────────────────────────────────────────

function _atomicToDecimal(atomic, decimals) {
    if (atomic == null) return null;
    let s;
    try { s = BigInt(String(atomic)).toString(); } catch (_) { return String(atomic); }
    if (s === '0') return '0';
    const pad = s.padStart(decimals + 1, '0');
    const head = pad.slice(0, pad.length - decimals);
    const tail = pad.slice(pad.length - decimals).replace(/0+$/, '');
    return tail.length ? `${head}.${tail}` : head;
}

// BAT-582 R10: bound model-controlled input length for parity with the
// other `_decimalToAtomic` clones (caps/preflight.js, tools/agent_pay.js,
// tools/wallet.js). This copy doesn't itself construct a BigInt — it
// returns the digit string for downstream display — but the regex still
// has no length anchor, so a pathological input would burn CPU on the
// regex test alone. 40 chars covers any realistic SOL/USDC value.
const _MAX_DECIMAL_INPUT_LEN = 40;

function _decimalToAtomic(decimal, decimals) {
    if (decimal == null) return null;
    const s = String(decimal).trim();
    if (s.length === 0 || s.length > _MAX_DECIMAL_INPUT_LEN) return null;
    if (!/^[0-9]+(\.[0-9]+)?$/.test(s)) return null;
    const [intPart, fracPart = ''] = s.split('.');
    if (fracPart.length > decimals) return null;
    const padded = fracPart.padEnd(decimals, '0');
    const full = (intPart + padded).replace(/^0+/, '') || '0';
    return full;
}

// BAT-664 (R-pr370-fix-4): early body validation in the policy hook so
// invalid POST calls fail fast WITHOUT prompting the user to confirm an
// action that would deterministically reject downstream. Mirrors the
// rules in tools/agent_pay.js::validateAndSerializeBody — duplicated
// here rather than imported to avoid a confirmation→tools require cycle.
// The two MUST stay in sync (regression test in agent-pay-post.test.js
// pins the rules cross-check).
const _POLICY_MAX_POST_BODY_BYTES = 8 * 1024;
function _validateAgentPayPostBody(body) {
    if (body === undefined || body === null) {
        return { error: 'body_required_for_post', reason: 'POST requires a JSON body' };
    }
    let parsed = body;
    if (typeof body === 'string') {
        // R-pr370-fix-5: bound raw string length BEFORE JSON.parse to
        // avoid resource exhaustion in the confirmation path. Same 2×
        // cap as agent_pay's validator — final compact-serialized size
        // is still checked against the strict 8 KB cap below.
        if (Buffer.byteLength(body, 'utf8') > _POLICY_MAX_POST_BODY_BYTES * 2) {
            return {
                error: 'body_too_large',
                reason: `raw POST body string exceeds ${_POLICY_MAX_POST_BODY_BYTES * 2} bytes pre-parse`,
            };
        }
        try { parsed = JSON.parse(body); }
        catch (_) {
            return { error: 'body_not_json', reason: 'string body must be valid JSON' };
        }
    }
    if (parsed === null || typeof parsed !== 'object') {
        return { error: 'body_not_json', reason: `body must be a JSON object or array (got ${parsed === null ? 'null' : typeof parsed})` };
    }
    let s;
    try { s = JSON.stringify(parsed); }
    catch (e) {
        return { error: 'body_not_json', reason: `body could not be serialized: ${e.message}` };
    }
    if (typeof s !== 'string') {
        return { error: 'body_not_json', reason: 'body did not produce a JSON value' };
    }
    if (Buffer.byteLength(s, 'utf8') > _POLICY_MAX_POST_BODY_BYTES) {
        return { error: 'body_too_large', reason: `POST body exceeds ${_POLICY_MAX_POST_BODY_BYTES} UTF-8 bytes` };
    }
    return { ok: true };
}

// BAT-664: confirmation message for agent_pay POST. Shows method + URL +
// max_usdc + a 200-char body PREVIEW that the UI can render. Per Codex v2
// note 2: the preview is for HUMAN display only — it must not be persisted
// to analytics in any form that contains body content. Callers that emit
// telemetry should record `method`, `host`, `bodyByteLength`, and a
// `bodyTruncated: true` flag instead. This helper does NOT log or emit;
// it just returns a string for the confirmation card.
// R-pr370-fix-3.2: budget the body preview at 200 chars TOTAL (including
// the truncation suffix), not 200 chars + suffix. Pre-fix produced strings
// like "<200 chars>… (truncated)" which were 213 chars long — broke the
// 200-char contract from BAT-664 v2.
const _BODY_PREVIEW_MAX = 200;
const _BODY_PREVIEW_SUFFIX = '… (truncated)';

// R-pr370-fix-13 (BAT-664 security): Markdown escaping happens at the
// render boundary in tools/index.js::formatConfirmationMessage — EVERY
// policy-built message gets sanitized there, so individual hooks don't
// have to remember to escape backticks/links/bold/etc. Newlines are
// preserved structurally by the format function; only the BODY content
// here literalizes its own embedded newlines (\n in the JSON value
// shouldn't break the body line out into a new structural line).
function _literalizeNewlines(s) {
    return String(s).replace(/\r\n?/g, '\n').replace(/\n/g, '\\n');
}

function _agentPayPostConfirmMessage(args) {
    // R-pr370-fix-16: literalize newlines in EVERY interpolated field so
    // a model-controlled url or max_usdc with embedded \n can't inject
    // extra structural lines into the confirmation card. Pre-fix only the
    // body had newline literalization — url/max_usdc were passed through
    // verbatim and formatConfirmationMessage's escape preserves real
    // newlines for structure, which is the exact lever an attacker would
    // use to misrepresent the action being confirmed.
    const url = typeof args.url === 'string' ? _literalizeNewlines(args.url) : '<missing url>';
    const max = _literalizeNewlines(typeof args.max_usdc === 'string' ? args.max_usdc : String(args.max_usdc));
    let bodyPreview = '';
    if (args.body !== undefined && args.body !== null) {
        let s;
        try { s = typeof args.body === 'string' ? args.body : JSON.stringify(args.body); }
        catch (_) { s = '<unserializable body>'; }
        // R-pr370-fix-33: literalize BEFORE truncating. Newline → "\n"
        // is a 2-char expansion; truncating before literalization could
        // produce a post-literalize string that exceeds _BODY_PREVIEW_MAX.
        // Now the truncation bound holds on the final user-visible content.
        s = _literalizeNewlines(s);
        if (s.length > _BODY_PREVIEW_MAX) {
            s = s.slice(0, _BODY_PREVIEW_MAX - _BODY_PREVIEW_SUFFIX.length) + _BODY_PREVIEW_SUFFIX;
        }
        bodyPreview = `body: ${s}`;
    } else {
        bodyPreview = 'body: <empty>';
    }
    return `POST ${url}\nmax_usdc: ${max} USDC\n${bodyPreview}`;
}

function _capDiffMessage(args, walletState) {
    // wallet_set_caps args are decimal strings; current caps in walletState are atomic strings.
    const current = (walletState && walletState.burnerCaps) || {};
    const changes = [];
    const ROWS = [
        ['per_tx_sol',  'capPerTxSol',  9, 'per-tx SOL'],
        ['daily_sol',   'capDailySol',  9, 'daily SOL'],
        ['per_tx_usdc', 'capPerTxUsdc', 6, 'per-tx USDC'],
        ['daily_usdc',  'capDailyUsdc', 6, 'daily USDC'],
    ];
    for (const [argKey, capKey, decimals, label] of ROWS) {
        if (args && args[argKey] != null) {
            const newDec = String(args[argKey]);
            const oldAtomic = current[capKey];
            const oldDec = oldAtomic != null ? _atomicToDecimal(oldAtomic, decimals) : '?';
            changes.push(`${label}: ${oldDec} → ${newDec}`);
        }
    }
    if (!changes.length) return 'Update burner wallet caps (no changes provided)';
    return `Update burner caps — ${changes.join('; ')}`;
}

// ── Main hook ────────────────────────────────────────────────────────────────

/**
 * @param {string} toolName
 * @param {object} args - tool input arguments
 * @param {object} walletState - {
 *     burnerConfigured: boolean,
 *     routingDecision?: "burner" | "main",
 *     underCap?: boolean,
 *     creatorRole?: "burner" | "main" | "unknown",
 *     burnerCaps?: object,
 *     burnerSpentToday?: object,
 * }
 * @returns {"none" | {policy: "confirm", message?: string} | {policy: "block", reason: string, message: string}}
 *
 * IMPORTANT: when walletState fields are missing, behave conservatively —
 * fall back to the v1.0 static behavior. This preserves regression safety.
 */
// eslint-disable-next-line no-unused-vars
function getConfirmationPolicy(toolName, args, walletState) {
    const ws = walletState || {};
    const a = args || {};
    const burnerConfigured = ws.burnerConfigured === true;

    // ── Burner-specific overrides (always apply, regardless of v1.0 set) ─────

    // wallet_status is purely informational — never confirm.
    if (toolName === 'wallet_status') {
        return 'none';
    }

    // wallet_set_caps always confirms (raise OR lower) and surfaces a diff.
    if (toolName === 'wallet_set_caps') {
        return {
            policy: 'confirm',
            message: _capDiffMessage(a, ws),
        };
    }

    // agent_pay — Phase 4 authorizes the call when max_usdc is provided.
    // Phase 6 does the real demand-vs-max_usdc check inside the tool itself
    // (Node has no way to know the demand pre-fetch). When max_usdc is
    // missing, block at the gate to fail fast.
    //
    // BAT-664: POST always requires user confirmation (side-effect-aware).
    // POST endpoints can send SMS, post content, or trigger paid actions.
    // _agentPayPostConfirmMessage() below builds the preview text that the
    // confirmation UI will render verbatim (method + URL + 200-char body
    // preview + max_usdc). The UI shows this string in the card; this
    // hook is the source of truth for the preview content. GET keeps its
    // existing under-cap silent behavior.
    if (toolName === 'agent_pay') {
        if (typeof a.max_usdc !== 'string' && typeof a.max_usdc !== 'number') {
            return {
                policy: 'block',
                reason: 'agent_pay_missing_max_usdc',
                message: 'agent_pay requires a max_usdc cap (decimal string).',
            };
        }
        // R-pr370-fix-9: gate-level method validation. Pre-fix any method
        // other than POST silently fell through to GET behavior (return
        // 'none'), so an invalid method only failed at the handler. Now
        // block unsupported methods at the policy so the agent gets a
        // clear, immediate reason without going through the confirmation
        // or dispatch path.
        let method;
        if (a.method === undefined || a.method === null) {
            method = 'GET';
        } else if (typeof a.method !== 'string') {
            return {
                policy: 'block',
                reason: 'method_not_allowed',
                message: `agent_pay: method must be a string (got ${typeof a.method})`,
            };
        } else {
            method = a.method.toUpperCase();
        }
        if (method !== 'GET' && method !== 'POST') {
            return {
                policy: 'block',
                reason: 'method_not_allowed',
                message: `agent_pay: method must be GET or POST (got ${method})`,
            };
        }
        if (method === 'POST') {
            // R-pr370-fix-39/43: validate url here — if missing/non-string,
            // unparseable, or non-HTTPS, the tool deterministically rejects
            // downstream. Don't prompt the user to confirm an action that
            // can't succeed. We don't replicate the FULL preflight here
            // (private IP / debug-localhost) since those need DNS — just
            // the cheap pre-DNS checks.
            if (typeof a.url !== 'string' || a.url.length === 0) {
                return {
                    policy: 'block',
                    reason: 'invalid_input',
                    message: 'agent_pay POST requires a non-empty url string.',
                };
            }
            let parsedUrl;
            try { parsedUrl = new URL(a.url); }
            catch (_) {
                return {
                    policy: 'block',
                    reason: 'invalid_url',
                    message: 'agent_pay POST: url failed to parse as a URL.',
                };
            }
            // R-pr370-fix-44: mirror tools/agent_pay.js::preflightUrlSync.
            // https:// always OK. http:// only OK for localhost AND debug
            // build — otherwise non_https. Any other scheme → non_https.
            // Pre-fix the gate only blocked non-http(s); plain `http://x`
            // would reach 'confirm' even though the tool deterministically
            // rejects it as non_https.
            if (parsedUrl.protocol !== 'https:' && parsedUrl.protocol !== 'http:') {
                return {
                    policy: 'block',
                    reason: 'non_https',
                    message: `agent_pay POST: url scheme must be https (got ${parsedUrl.protocol}).`,
                };
            }
            if (parsedUrl.protocol === 'http:') {
                const host = (parsedUrl.hostname || '').toLowerCase();
                const isLocal = host === 'localhost' || host === '127.0.0.1' || host === '::1' || host === '[::1]';
                const isDebug = process.env.NODE_ENV === 'development' || process.env.NODE_ENV === 'test';
                if (!isLocal || !isDebug) {
                    return {
                        policy: 'block',
                        reason: 'non_https',
                        message: 'agent_pay POST: http:// only allowed for localhost in debug builds.',
                    };
                }
            }
            // R-pr370-fix-20: fail-fast at gate when no burner. POST
            // deterministically rejects with burner_not_configured at the
            // handler — prompting the user to confirm an action that
            // can't succeed is bad UX. Block early so the agent gets the
            // signal without involving the user.
            if (!burnerConfigured) {
                return {
                    policy: 'block',
                    reason: 'burner_not_configured',
                    message: 'agent_pay POST requires a burner wallet. Configure one in Settings → Burner Wallet.',
                };
            }
            // R-pr370-fix-4: validate the body here BEFORE asking the user
            // to confirm. Pre-fix the user could confirm a POST that the
            // tool then deterministically rejects with body_required_for_post
            // / body_not_json / body_too_large — wasted UX. Block at the
            // policy gate with a clear reason so the agent fixes the call
            // without involving the user.
            const v = _validateAgentPayPostBody(a.body);
            if (v.error) {
                return {
                    policy: 'block',
                    reason: v.error,
                    message: `agent_pay POST rejected: ${v.reason}`,
                };
            }
            return {
                policy: 'confirm',
                message: _agentPayPostConfirmMessage(a),
            };
        }
        // GET: keep the existing under-cap-silent behavior.
        return 'none';
    }

    // Jupiter cancel tools route by creator-role.
    if (JUPITER_CANCEL_TOOLS.has(toolName)) {
        const role = ws.creatorRole;
        if (role === 'burner') return 'none';
        // main OR unknown OR undefined → confirm (per contract: unknown defaults to main + confirm + diagnostic)
        return { policy: 'confirm' };
    }

    // Solana write tools — burner routing + cap-aware policy.
    if (SOLANA_WRITE_TOOLS.has(toolName)) {
        // Burner not configured → fall through to v1.0 static behavior (always confirm).
        if (!burnerConfigured) {
            return { policy: 'confirm' };
        }
        const routing = ws.routingDecision;

        // Defensive: routing decision missing → conservative confirm.
        if (routing !== 'burner' && routing !== 'main') {
            return { policy: 'confirm' };
        }

        if (routing === 'main') {
            // User-explicit fallback or principal exceeded burner cap and the
            // tool requested main fallback → MWA popup.
            return { policy: 'confirm' };
        }

        // routing === 'burner'
        if (ws.underCap === true) {
            return 'none';
        }
        // Over cap — agent must EITHER raise the cap OR opt into main wallet
        // fallback by passing _allowMainFallback: true (then this branch
        // re-enters with routing='main' and returns confirm).
        if (a._allowMainFallback === true) {
            return { policy: 'confirm' };
        }
        return {
            policy: 'block',
            reason: 'burner_cap_exceeded',
            message:
                'Burner cap exceeded. Raise the cap with wallet_set_caps, ' +
                'or retry with _allowMainFallback: true to use the main wallet (popup required).',
        };
    }

    // ── v1.0 static fallback ────────────────────────────────────────────────
    if (V1_STATIC_CONFIRM.has(toolName)) {
        return { policy: 'confirm' };
    }
    return 'none';
}

/**
 * Normalize the policy result into a uniform { policy, ... } object.
 * Useful for consumers that don't want to branch on string-vs-object.
 */
function normalizePolicy(result) {
    if (typeof result === 'string') return { policy: result };
    return result;
}

module.exports = {
    getConfirmationPolicy,
    normalizePolicy,
    V1_STATIC_CONFIRM,
    SOLANA_WRITE_TOOLS,
    JUPITER_CANCEL_TOOLS,
};
