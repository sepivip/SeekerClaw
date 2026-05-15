# Textbelt SMS (paysponge)

Send a real SMS message to any phone number. paysponge wraps Textbelt's public API behind an x402 paid endpoint — we pay USDC, paysponge supplies the Textbelt API key.

## Endpoint

- **URL:** `https://api.paysponge.com/x402/purchase/svc_d6kszbre4qwg5n4n4/text`
- **Method:** POST (JSON body)
- **Cost:** $0.02 USDC per message (Solana mainnet)
- **Suggested max_usdc:** `"0.05"` (decimal STRING)

## Body construction

Textbelt-compatible JSON body:

```json
{
  "phone": "+15551234567",
  "message": "Your SMS text here (typically ≤ 160 chars for a single SMS segment)"
}
```

- **`phone`** — recipient phone number in E.164 format (`+` then country code then number, no spaces or dashes). **US and Canada only** for this paysponge tier — `+1` country code. Examples: `"+15551234567"` (US), `"+14165551234"` (Toronto). Non-US/Canada numbers (e.g. UK `+44…`, Germany `+49…`) **WILL still consume the $0.02 payment** and return `success: false`. Don't send to non-US/CA numbers — confirm the leading `+1` before paying.
- **`message`** — the SMS body. Plain text. Standard SMS limit is 160 GSM-7 chars per segment; carriers may concatenate longer messages but each segment counts.

The `body` field passed to `agent_pay` MUST be a JSON object (the validator rejects strings/primitives with `body_not_json`).

## When to use — authorized use only

SMS-send has abuse vectors (spam, phishing, impersonation, smishing). Follow the same authorization pattern as 2Captcha — only two allowed contexts:

- **The user's own phone** — the user explicitly asks to send an SMS to their own number (e.g. for a calendar reminder, a self-test, a backup-of-text-to-phone flow). Agent should still confirm the phone + message before paying.
- **A recipient who has clearly consented** — the user names the recipient (e.g. "send my mom this") AND has indicated the recipient has agreed to receive automated SMS from them. If unclear, ask.

**NOT allowed without further authorization** — DO NOT call this service if:
- The user asks to send to a random / unspecified number
- The user is sending in bulk (multiple numbers in sequence)
- The content reads like phishing, marketing-without-opt-in, account takeover ("click this link to reset your password"), or impersonation
- The user hasn't confirmed the EXACT phone number AND the EXACT message body for this specific call

**A user's consent alone is NOT sufficient.** A user asking the agent to spam their ex's phone, or send "from a friend"-style messages to a third party, does NOT make it allowed — the RECIPIENT's interests matter too. Refuse if the request smells like abuse.

### Always confirm before paying

POST endpoints already trigger an `agent_pay` confirmation prompt by default. For SMS specifically, the agent should ALSO read back the phone number AND the message to the user in plain text BEFORE the confirmation prompt fires, so the user sees exactly what they're about to send. If anything is wrong, abort.

## Response shape

JSON `{ textId, success, quotaRemaining }` (Textbelt's standard response). `success: true` means the SMS was queued. The `textId` can be used later to check delivery status via Textbelt's free status endpoint (separate, not paid).

## Notes

- The catalog's "service URL" (`https://api.paysponge.com/x402/purchase/svc_d6kszbre4qwg5n4n4/text`) is paysponge's gateway, not Textbelt's direct API. paysponge holds the Textbelt API key — that's what we're paying for.
- A separate GET `/status` endpoint exists on Textbelt for delivery confirmation; it's free (no x402 challenge) and not part of this catalog entry. If the user wants delivery confirmation, use `web_fetch` on `https://textbelt.com/status/<textId>` after the SMS is sent.
- **US and Canada only** — paysponge's Textbelt tier (the one this service is wrapping) does not support other countries. A non-US/CA `+44…` / `+49…` / `+81…` number will still get charged $0.02 USDC but return `success: false`. Verify the `+1` prefix before paying.
