# 2Captcha (paysponge)

Submit CAPTCHAs for solving — recaptcha v2/v3, hcaptcha, image, text, etc.

## Endpoint

- **URL pattern:** `https://2captcha.x402.paysponge.com/createTask`
- **Method:** POST
- **Cost:** $0.01 USDC per task created (Solana mainnet)
- **Suggested max_usdc:** 0.05

## Request body

JSON POST body shape depends on CAPTCHA type. Common examples:

**reCAPTCHA v2:**
```json
{
  "type": "RecaptchaV2TaskProxyless",
  "websiteURL": "https://example.com/login",
  "websiteKey": "6Le-wvkSAAAAA..."
}
```

**hCaptcha:**
```json
{
  "type": "HCaptchaTaskProxyless",
  "websiteURL": "https://example.com",
  "websiteKey": "10000000-ffff-ffff-..."
}
```

**Image CAPTCHA:**
```json
{
  "type": "ImageToTextTask",
  "body": "<base64-encoded image>"
}
```

## Two-step flow

`createTask` returns a `taskId`. The actual solution comes from a follow-up `getTaskResult` call (not on the paid x402 endpoint — that's free polling). Wait ~10s, then poll:

```
GET https://2captcha.x402.paysponge.com/getTaskResult?taskId=<id>
```

(The follow-up should be free or near-free. If it returns 402, treat it as a separate pay.sh call.)

## When to use — authorized use only

This service can defeat anti-abuse controls. The agent must NOT call it speculatively or to power broader automation. Allowed contexts:

- **Accessibility** — the user describes a disability and is asking for help completing a CAPTCHA on a site they're already legitimately using.
- **Owned-site testing** — the user is automating tests against a site they own and explicitly says so, OR has explicit permission from the site operator.
- **User explicitly authorizes the specific call** — they describe the exact situation and ask for it.

**NOT allowed without further authorization** — DO NOT call this service if:
- The user is automating against a site they don't own and haven't shown authorization for
- The agent encountered a CAPTCHA wall mid-automation and could "just solve it" to keep going — STOP and ask the user explicitly before paying
- The intent could plausibly be account creation, scraping at scale, or any other anti-abuse evasion

When in doubt, ask the user to describe the context. Refuse if the answer suggests defeating anti-abuse controls on a site the user doesn't operate.
