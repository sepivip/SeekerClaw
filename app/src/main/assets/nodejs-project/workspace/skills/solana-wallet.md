---
name: solana-wallet
description: "Check Solana wallet balance, transaction history, and send SOL with wallet approval"
version: "1.0.0"
metadata:
  openclaw:
    emoji: "🪙"
    requires:
      bins: []
      env: []
---

# Solana Wallet

Interact with the user's Solana wallet connected via the SeekerClaw app.

## When to Use

User asks about:
- Wallet balance ("What's my SOL balance?", "How much crypto do I have?")
- Token holdings ("Do I have any tokens?", "Show my wallet")
- Transaction history ("Show my recent transactions", "What was my last transfer?")
- Sending SOL ("Send 0.1 SOL to ...", "Transfer SOL")
- Wallet address ("What's my wallet address?")

## Tools Available

| Tool | Purpose |
|------|---------|
| `solana_address` | Get connected wallet address |
| `solana_balance` | Get SOL + SPL token balances |
| `solana_history` | Get recent transaction history |
| `solana_send` | Send SOL (requires user + wallet approval) |

## Usage

### Check Wallet Address

```javascript
solana_address()
```

Response:
```json
{
  "address": "7xKXtg2CW87d97TXJSDpbD5jBkheTqA83TZRuJosgAsU",
  "label": ""
}
```

### Check Balance

```javascript
solana_balance()
// Or for a specific address:
solana_balance({ address: "7xKX..." })
```

Response:
```json
{
  "address": "7xKX...",
  "sol": 2.5,
  "tokens": [
    { "mint": "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v", "amount": "100.0", "decimals": 6 }
  ],
  "tokenCount": 1
}
```

Format response:
```
🪙 **Wallet Balance**

💰 **SOL:** 2.5 SOL
🪙 **USDC:** 100.0 (mint: EPjF...Dt1v)

📊 1 token account
```

### Common Token Mints

| Token | Mint Address |
|-------|-------------|
| USDC | EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v |
| USDT | Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB |
| BONK | DezXAZ8z7PnrnRJjz3wXBoRgixCa6xjnB7YaB1pPB263 |
| JUP | JUPyiwrYJFskUPiHa7hkeR8VUtAeFoSYbKedZNsDvCN |
| RAY | 4k3Dyjzvzp8eMZWUXbBCjEvwSkkk59S5iCNLY3QrkX6R |
| WIF | EKpQGSJtjMFqKZ9KQanSqYXRcF8fBopzLHYxdM65zcjm |

### Transaction History

```javascript
solana_history({ limit: 5 })
// Or for a specific address:
solana_history({ address: "7xKX...", limit: 10 })
```

Response:
```json
{
  "address": "7xKX...",
  "transactions": [
    {
      "signature": "5UBr...",
      "slot": 250000000,
      "blockTime": "2026-02-05T12:00:00.000Z",
      "status": "Success",
      "memo": null
    }
  ],
  "count": 5
}
```

Format response:
```
📜 **Recent Transactions** (last 5)

1. ✅ Success — Feb 5, 12:00 PM
   `5UBr...` (slot 250000000)
2. ✅ Success — Feb 4, 3:30 PM
   `3kPq...` (slot 249999500)
```

### Send SOL

## CRITICAL: Always Confirm First!

**NEVER call `solana_send` without explicit user confirmation in chat.**

Before sending, always:
1. Show the recipient address
2. Show the exact amount of SOL
3. Ask "Should I send this?"
4. ONLY after the user says yes, call the tool

The tool will ALSO trigger a wallet approval popup on the phone — so the user confirms twice (once in chat, once on device).

```javascript
solana_send({
  to: "RecipientAddressBase58...",
  amount: 0.1
})
```

Response (success):
```json
{
  "signature": "5UBr...",
  "success": true
}
```

### Example Send Flow

**User:** "Send 0.5 SOL to 9aE2..."

**You (confirm first):**
"I'll send this transaction:

💸 **Send:** 0.5 SOL
📬 **To:** 9aE2...
📤 **From:** Your connected wallet

You'll also need to approve this in your wallet app on the phone. Should I proceed?"

**User:** "Yes"

**Then call:**
```javascript
solana_send({ to: "9aE2...", amount: 0.5 })
```

**After success:**
"Transaction sent! Signature: `5UBr...`
You can view it on Solscan: https://solscan.io/tx/5UBr..."

## Error Handling

**No wallet connected:**
"No wallet is connected yet. Open the SeekerClaw app > Settings > Solana Wallet to paste your wallet address or connect via MWA."

**Insufficient balance:**
Check balance first before attempting to send. If SOL balance < requested amount:
"You only have X SOL. The transfer of Y SOL would fail."

**Transaction failed:**
"The transaction failed: [error message]. This could be due to insufficient funds, network congestion, or the wallet rejecting the request."

## Tips

- Always check `solana_address` first if unsure whether a wallet is connected
- Use `solana_balance` with no args to auto-use the connected wallet
- Link transactions to Solscan: `https://solscan.io/tx/{signature}`
- Link addresses to Solscan: `https://solscan.io/account/{address}`
- SPL tokens show mint addresses — match to known tokens above when possible
- The `solana_send` tool currently only supports SOL transfers, not SPL tokens
