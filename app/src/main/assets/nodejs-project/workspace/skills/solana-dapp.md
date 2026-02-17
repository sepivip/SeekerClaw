---
name: solana-dapp
description: "Discover, launch, and interact with Solana dApps on the Seeker device via the dApp Store and MWA"
version: "1.0.0"
metadata:
  openclaw:
    emoji: "📱"
    requires:
      bins: []
      env: []
---

# Solana Seeker dApp

Discover, launch, and manage Solana dApps on the Solana Seeker device. Help the user navigate the Solana Mobile ecosystem including the dApp Store, Mobile Wallet Adapter (MWA), and popular DeFi/NFT applications.

## When to Use

User asks about:
- Solana dApps ("What dApps do I have?", "Show my Solana apps")
- dApp Store ("What's in the dApp Store?", "Find a swap app")
- Launching dApps ("Open Jupiter", "Launch Tensor")
- DeFi on Seeker ("How do I swap tokens?", "Where can I stake SOL?")
- NFT apps ("Show me NFT marketplaces", "Where can I view my NFTs?")
- Mobile Wallet Adapter ("How does wallet connect work?", "Connect my wallet")
- Seeker features ("What can my Seeker do?", "Seeker crypto features")
- dApp recommendations ("Best Solana apps", "What should I install?")

## Tools Available

| Tool | Purpose |
|------|---------|
| `android_apps_list` | List installed apps on device |
| `android_apps_launch` | Launch an app by package name |
| `web_fetch` | Look up dApp info, token data, project details |
| `solana_balance` | Check wallet balance (via solana-wallet skill) |

## Solana Mobile Stack Overview

The Solana Seeker runs three core components:

1. **Mobile Wallet Adapter (MWA)** — Protocol connecting dApps to wallet apps for transaction signing. dApps don't need per-wallet integrations; MWA provides a unified API.
2. **Seed Vault** — Secure key custody service. Keys/seeds never leave the secure execution environment. Wallet apps use this to protect user funds.
3. **Solana dApp Store** — Crypto-friendly app store for Solana Mobile devices. Supports Android apps and PWAs. No restrictive policies on crypto functionality.

## Discovering Installed dApps

List installed apps and filter for known Solana dApps:

```javascript
android_apps_list()
```

### Known Solana dApp Package Names

| App | Package Name | Category |
|-----|-------------|----------|
| Phantom | `app.phantom` | Wallet |
| Solflare | `com.solflare.mobile` | Wallet |
| Backpack | `app.backpack.mobile` | Wallet |
| Jupiter | `ag.jup.mobile` | DEX / Swap |
| Raydium | `io.raydium` | DEX / AMM |
| Orca | `com.orca.app` | DEX / Swap |
| Tensor | `com.tensor.android` | NFT Marketplace |
| Magic Eden | `io.magiceden.android` | NFT Marketplace |
| Marinade | `finance.marinade.app` | Staking |
| Helium | `com.helium.wallet.app` | IoT / Network |
| Dialect | `to.dialect.app` | Messaging |
| Tiplink | `xyz.tiplink.app` | Payments |
| Solana dApp Store | `com.solanamobile.dappstore` | Store |

When listing dApps, match installed apps against known packages and present clearly:

```
📱 **Installed Solana dApps**

🟣 Phantom — Wallet
🔶 Jupiter — DEX / Swap
🎨 Tensor — NFT Marketplace
🏪 Solana dApp Store
```

If no Solana dApps found:
"No Solana dApps detected. Open the **Solana dApp Store** to browse and install apps, or check out the recommendations below."

## Launching dApps

```javascript
android_apps_launch({ package: "app.phantom" })
```

Always confirm before launching:
"Opening **Phantom** wallet on your device..."

If the app isn't installed:
"**Jupiter** isn't installed. You can get it from the Solana dApp Store or download the APK from their website."

## dApp Categories & Recommendations

### Wallets
| App | Description | Best For |
|-----|-------------|----------|
| **Phantom** | Most popular Solana wallet. MWA support, built-in swap, NFT gallery | General use |
| **Solflare** | Feature-rich wallet with staking, MWA support | Staking, power users |
| **Backpack** | xNFT-enabled wallet by Coral/Mad Lads team | xNFTs, developers |

### DEX / Swap
| App | Description | Best For |
|-----|-------------|----------|
| **Jupiter** | Aggregator — finds best swap rates across all DEXes | Any token swap |
| **Raydium** | AMM + liquidity pools + AcceleRaytor launchpad | LP farming, new tokens |
| **Orca** | Concentrated liquidity DEX, user-friendly UI | Simple swaps, LPing |

### NFT Marketplaces
| App | Description | Best For |
|-----|-------------|----------|
| **Tensor** | Pro trading tools, collection bids, analytics | Active NFT trading |
| **Magic Eden** | Largest multi-chain NFT marketplace | Browsing, buying NFTs |

### Staking
| App | Description | Best For |
|-----|-------------|----------|
| **Marinade** | Liquid staking (mSOL), native staking | Earning yield on SOL |
| **Solflare** | Built-in native staking to validators | Direct validator staking |

### Other Notable dApps
| App | Description |
|-----|-------------|
| **Dialect** | Web3 messaging and notifications |
| **Helium** | IoT network management and HNT rewards |
| **Tiplink** | Send crypto via links, great for onboarding |
| **Squads** | Multisig for teams and DAOs |

## Common Workflows

### "How do I swap tokens?"

1. Check if Jupiter or a DEX is installed:
   ```javascript
   android_apps_list()
   ```
2. If Jupiter is installed, launch it:
   ```javascript
   android_apps_launch({ package: "ag.jup.mobile" })
   ```
3. Guide: "Jupiter will find the best rate across all Solana DEXes. Select your input token, output token, enter the amount, and confirm the swap. Your wallet (Phantom/Solflare) will pop up for transaction approval via MWA."

If no DEX installed:
"I'd recommend installing **Jupiter** from the dApp Store — it aggregates all DEXes to find you the best swap rate."

### "How do I stake SOL?"

Options to present:
1. **Liquid staking (Marinade):** Stake SOL, receive mSOL (tradeable). Earn ~7% APY while keeping liquidity.
2. **Native staking (Solflare/Phantom):** Delegate to a validator directly. ~7% APY, 2-3 day unstaking period.
3. **LST options:** mSOL (Marinade), bSOL (BlazeStake), jitoSOL (Jito) — each liquid staking token has different validator strategies.

### "Where can I see my NFTs?"

1. Most wallets (Phantom, Solflare, Backpack) have built-in NFT galleries
2. For trading/analytics: Tensor or Magic Eden
3. Quick check via wallet:
   ```javascript
   solana_balance()
   ```
   Token count can indicate NFT holdings.

### "What's MWA / Mobile Wallet Adapter?"

Explain: "MWA is the protocol that lets dApps on your Seeker connect to your wallet for transaction signing. When a dApp needs to send a transaction, MWA pops up your wallet app to review and approve it. Your private keys never leave the Seed Vault's secure environment. It works automatically — any MWA-compatible dApp connects to any MWA-compatible wallet."

## Looking Up dApp / Token Information

### Token info via web
```javascript
web_fetch({ url: "https://api.jup.ag/tokens/v1/solana" })
```

### Token price
```javascript
web_fetch({ url: "https://api.jup.ag/price/v2?ids=So11111111111111111111111111111111111111112" })
```

Common token addresses:
| Token | Mint |
|-------|------|
| SOL (wrapped) | So11111111111111111111111111111111111111112 |
| USDC | EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v |
| USDT | Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB |
| JUP | JUPyiwrYJFskUPiHa7hkeR8VUtAeFoSYbKedZNsDvCN |
| BONK | DezXAZ8z7PnrnRJjz3wXBoRgixCa6xjnB7YaB1pPB263 |
| WIF | EKpQGSJtjMFqKZ9KQanSqYXRcF8fBopzLHYxdM65zcjm |
| RAY | 4k3Dyjzvzp8eMZWUXbBCjEvwSkkk59S5iCNLY3QrkX6R |
| HNT | hntyVP6YFm1Hg25TN9WGLqM12b8TQmcknKrdu1oxWux |

### Project info
```javascript
web_fetch({ url: "https://api.coingecko.com/api/v3/coins/solana" })
```

## Seeker-Specific Features

The Solana Seeker is purpose-built for crypto:

- **Seed Vault:** Hardware-level key security. Private keys are stored in a secure execution environment isolated from Android. Even if the OS is compromised, keys remain safe.
- **dApp Store pre-installed:** Browse and install Solana dApps without Google Play restrictions on crypto.
- **MWA native support:** All MWA-compatible dApps work seamlessly. No browser extensions or workarounds needed.
- **Stock Android:** No OEM bloat that kills background services. Ideal for running SeekerClaw 24/7.
- **Snapdragon 6 Gen 1 + 8GB RAM:** Handles DeFi dApps, NFT rendering, and Node.js runtime simultaneously.

## Response Format

When presenting dApp information:

```
📱 **Jupiter — DEX Aggregator**
🏷️ Category: DeFi / Swap
📦 Package: ag.jup.mobile
🔗 Website: jup.ag

Best swap rates across all Solana DEXes.
Supports limit orders, DCA, and perpetuals.
```

When listing multiple dApps, use a compact format:

```
📱 **Solana dApps on Your Seeker**

💰 Wallets:  Phantom, Solflare
🔄 Swap:     Jupiter, Orca
🎨 NFTs:     Tensor, Magic Eden
📈 Staking:  Marinade
```

## Error Handling

**Can't list apps:**
"I wasn't able to check your installed apps. You can tell me which dApps you have, or I can recommend popular ones."

**App launch failed:**
"Couldn't launch the app. Make sure it's installed and up to date. Try opening it manually from your home screen."

**Unknown dApp:**
If user asks about a dApp you don't recognize, search the web:
```javascript
web_fetch({ url: "https://www.google.com/search?q=solana+dapp+{name}" })
```

## Tips

- The **Solana dApp Store** is the primary way to install Solana apps on Seeker — no Google Play needed
- Most DeFi dApps require a wallet app (Phantom recommended) installed first
- MWA handles wallet connections automatically — users just approve transactions when prompted
- For best swap rates, always recommend **Jupiter** as the aggregator
- Liquid staking tokens (mSOL, jitoSOL, bSOL) can be used in DeFi while earning staking yield
- Check `solana_balance` before recommending DeFi actions to ensure user has funds
- Link to Solscan for on-chain exploration: `https://solscan.io/account/{address}`
