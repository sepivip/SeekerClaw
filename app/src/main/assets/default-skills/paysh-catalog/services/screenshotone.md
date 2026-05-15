# ScreenshotOne (paysponge)

Capture screenshots (and animated captures) of any public HTTPS URL.

## Endpoint

- **URL pattern:** `https://screenshotone.x402.paysponge.com/animate?url=<target>&...` (animated)
- **Method:** GET
- **Cost:** $0.02 USDC per call (Solana mainnet)
- **Suggested max_usdc:** 0.10

## Query construction

Required:
- `url=<target-url>` — the URL to screenshot. URL-encode it.

Common options:
- `viewport_width=1280` / `viewport_height=720`
- `format=png` | `jpg` | `webp` | `gif` (for animated)
- `full_page=true` — capture the whole scrollable page
- `block_ads=true` — strip ads before capture

## Example flow

User: *"Take a screenshot of github.com"*

1. Encode `https://github.com` → `https%3A%2F%2Fgithub.com`
2. Call `agent_pay("https://screenshotone.x402.paysponge.com/animate?url=https%3A%2F%2Fgithub.com&format=png", max_usdc=0.10)`
3. Response is binary image data — return as an attachment to the active channel (Telegram/Discord) using the channel's media-send pathway, not as text.

## Sending the image to the user

The response body is the image bytes. Use the active channel's file/photo send method:
- Telegram: `telegram_send_file` tool with the bytes as a buffer
- Discord: `discord_send_file` if available, or post a message with the image as attachment

If neither channel can ship binary, save to a temp path and tell the user where it is.
