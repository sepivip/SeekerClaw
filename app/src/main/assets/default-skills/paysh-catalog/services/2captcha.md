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

## When to use

- A user explicitly asks "solve this captcha"
- The agent is automating something and hits a CAPTCHA wall (rare on-device, but possible)

Don't proactively solve CAPTCHAs as part of a broader automation unless the user has clearly authorized it.
