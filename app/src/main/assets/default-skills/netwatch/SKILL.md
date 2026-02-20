---
name: netwatch
description: "Network monitoring and security audit. Use when: user asks to scan network, check open ports, network audit, who's on wifi, check connection, port scan, firewall check, network status, or network security. Don't use when: user asks about crypto transactions (use solana tools) or web search (use research skill)."
version: "2.1.0"
emoji: "🛡️"
triggers:
  - "scan my network"
  - "network scan"
  - "check open ports"
  - "open ports"
  - "network audit"
  - "network security"
  - "what's on my wifi"
  - "who's on my network"
  - "check my connection"
  - "network status"
  - "port scan"
  - "firewall check"
---

# NetWatch — Network Monitor & Security Audit

Read-only network monitoring and security auditing skill for Android.

## Android Sandbox Compatibility

This skill runs entirely within the Node.js runtime and Android bridge. It does **NOT** use `shell_exec` at all — `ping`, `curl`, `cat`, `ls`, and other shell commands are unavailable or unreliable on the Android sandbox.

**Probe methods used:**
- **Network info:** `android_bridge` `/network` endpoint (WiFi SSID, IP, type, signal)
- **Connectivity + latency:** `js_eval` with Node.js `https.get()` + `Date.now()` timing
- **DNS health:** `js_eval` with `require('dns').resolve()`
- **Port probing:** `js_eval` with `require('net').createConnection()` to localhost
- **Device context:** `android_bridge` `/battery`

**Do NOT use `shell_exec` for any probe.** No `ping`, no `curl`, no `cat`. These commands produce `FAIL` noise on Android.
Do NOT attempt to read `/proc/net/*`, `/sys/class/net/*`, `/etc/resolv.conf`.

## Use when
- "scan my network" / "network scan"
- "check open ports" / "open ports"
- "network audit" / "network security"
- "what's on my wifi" / "who's on my network"
- "check my connection" / "network status"
- "port scan" / "firewall check"

## Don't use when
- Crypto/blockchain queries (use solana tools)
- General web search (use research skill)
- VPN setup or configuration changes (out of scope)

## Operating Rules

**STRICTLY READ-ONLY.** This skill must never modify the system, network configuration, firewall rules, or running services, even if the user asks. If the user requests changes, explain that NetWatch is observation-only and suggest they make changes manually.

## Telegram Output Formatting Rules

ALL output MUST follow these Telegram-optimized formatting rules:

1. **No ASCII tables.** Never use `| col | col |` pipe-delimited tables or box-drawing characters.
2. Use Telegram-safe markdown:
   - **Bold** for section headers
   - `inline code` for IPs, ports, hostnames, commands
   - Bullet points (•) for list items
3. Keep lines short for mobile readability (under 50 chars per line where possible).
4. Status emoji convention:
   - ✅ = good / healthy / expected
   - ⚠️ = warning / unusual / investigate
   - ❌ = critical / failed / dangerous
   - ℹ️ = informational
5. Blank line between each section.
6. End every report with ONE clear follow-up question or CTA.

## Instructions

You have three modes. Default to **Network Audit** unless the user asks for something specific.

**Allowed tools — ONLY these:**
- `android_bridge` calls: `/network`, `/battery`, `/storage`, `/ping`
- `js_eval` for ALL network probes and data processing
- **NO `shell_exec`** — do not use it at all in this skill

### js_eval Probe Patterns

Use these `js_eval` snippets for network probing. Each returns a JSON result.

**Latency probe (HTTPS endpoint):**
```javascript
const https = require('https');
const start = Date.now();
const url = 'https://api.telegram.org';
const req = https.get(url, { timeout: 5000 }, (res) => {
  res.resume();
  res.on('end', () => {
    const ms = Date.now() - start;
    process.stdout.write(JSON.stringify({ url, status: res.statusCode, latencyMs: ms, ok: true }));
  });
});
req.on('timeout', () => { req.destroy(); process.stdout.write(JSON.stringify({ url, ok: false, error: 'timeout' })); });
req.on('error', (e) => { process.stdout.write(JSON.stringify({ url, ok: false, error: e.message })); });
```

**DNS resolution probe:**
```javascript
const dns = require('dns');
const host = 'api.telegram.org';
dns.resolve(host, (err, addresses) => {
  if (err) {
    process.stdout.write(JSON.stringify({ host, ok: false, error: err.code }));
  } else {
    process.stdout.write(JSON.stringify({ host, ok: true, addresses }));
  }
});
```

**Local port probe (TCP connect):**
```javascript
const net = require('net');
const port = 8765;
const start = Date.now();
const sock = net.createConnection({ host: '127.0.0.1', port, timeout: 3000 }, () => {
  const ms = Date.now() - start;
  sock.destroy();
  process.stdout.write(JSON.stringify({ port, open: true, latencyMs: ms }));
});
sock.on('timeout', () => { sock.destroy(); process.stdout.write(JSON.stringify({ port, open: false, error: 'timeout' })); });
sock.on('error', (e) => { process.stdout.write(JSON.stringify({ port, open: false, error: e.message })); });
```

### Mode 1: Network Audit (default)

Gather data from these sources via separate tool calls:

**Step 1 — Device & network info (android_bridge):**
```
POST /network  -> { type, ssid, ip, signalStrength, linkSpeed, frequency }
POST /battery  -> { level, isCharging, chargeType }
```

**Step 2 — Connectivity + latency probes (js_eval, each separate):**
Run the HTTPS latency probe pattern for each endpoint:
- `https://1.1.1.1` (Cloudflare)
- `https://8.8.8.8` (Google DNS)
- `https://api.telegram.org`
- `https://www.google.com`
- `https://api.anthropic.com`

**Step 3 — DNS resolution health (js_eval, each separate):**
Run the DNS resolve probe pattern for each hostname:
- `api.telegram.org`
- `google.com`
- `api.anthropic.com`

**Step 4 — Local service port checks (js_eval, each separate):**
Run the TCP port probe pattern for each port:
- `8765` (Android bridge)
- `3000` (dev server)
- `8080` (HTTP)

**Step 5 — Compile report:**
Process all gathered data, calculate risk score, and format the report.

**Output format (Telegram-optimized):**

```
🛡️ **NetWatch Audit Report**
📅 <timestamp> • Scan took <X>s
📡 Source: Android APIs + JS network probes

📊 **Risk Score: X/100 (LEVEL)**

❌ **Critical Findings**
• <finding with `code` for IPs/ports>

⚠️ **Warnings**
• <warning item>

ℹ️ **Info**
• <informational item>

📋 **Network Summary**
• Connection: `WiFi` / `Mobile` / `None`
• SSID: `<name>`
• IP: `<address>`
• Signal: <level> (<quality>)
• DNS: ✅ resolving / ❌ failing
• Telegram API: ✅ reachable (<X>ms) / ❌ down
• Anthropic API: ✅ reachable (<X>ms) / ❌ down

🔌 **Local Services**
• `localhost:8765` (bridge): ✅ / ❌
• `localhost:3000`: ✅ / ❌ / not running
• `localhost:8080`: ✅ / ❌ / not running

🔋 **Device**
• Battery: <level>% (<charging status>)

✅ **Recommendations**
1. <most important action>
2. <next action>

👉 What should I look into next?
```

**Risk scoring guidelines:**
- 0-25 LOW: Normal connectivity, expected services only
- 26-50 MEDIUM: DNS issues, high latency, or unexpected local ports
- 51-75 HIGH: Connectivity failures, API unreachable, multiple issues
- 76-100 CRITICAL: No network, DNS failing, critical services down

**Risk score factors:**
- No network connectivity: +40
- DNS resolution failing: +25
- Telegram API unreachable: +20
- Anthropic API unreachable: +15
- High latency (>200ms avg): +10
- Android bridge not responding: +20
- Unknown local port open: +5 each
- Expected services not running: +5

### Mode 2: Port Watch

Check local service ports using js_eval TCP connect probes:

**Standard ports to check (js_eval, each separate):**
Run the TCP port probe pattern for each port:
- `8765` (Android bridge)
- `3000` (dev server)
- `8080` (HTTP)
- `5555` (ADB)
- `4444` (reverse shell)
- `22` (SSH)
- `53` (DNS)
- `80` (HTTP)
- `443` (HTTPS)

**Output format (Telegram-optimized):**

```
🔍 **Port Watch Report**

🟢 **Expected Services**
• `8765` — Android bridge ✅ responding
• `8080` — HTTP service ✅ responding

⚠️ **Unusual Ports**
• `3000` — unknown service ⚠️ responding

❌ **Dangerous Ports**
• `5555` — ADB debugging ❌ open!
• `4444` — reverse shell port ❌ open!

📊 **Summary**
• Scanned: 9 ports
• Open: X • Closed: Y
• Flagged: Z

👉 Want me to investigate any of these?
```

**Port classification:**
- ✅ Expected: `8765` (Android bridge), `80`, `443`, `8080`, `53`
- ⚠️ Unusual: `3000`, any other responding port
- ❌ Dangerous: `5555` (ADB), `4444` (reverse shell), `22` (SSH exposed), `23` (Telnet)

### Mode 3: Connection Status

Check connectivity and latency to key endpoints:

**Step 1 — Latency probes (js_eval, each separate):**
Run the HTTPS latency probe pattern for each endpoint:
- `https://1.1.1.1` (Cloudflare)
- `https://8.8.8.8` (Google DNS)
- `https://api.telegram.org`
- `https://www.google.com`
- `https://api.anthropic.com`

**Step 2 — DNS resolution (js_eval, each separate):**
Run the DNS resolve probe pattern for:
- `google.com`
- `api.telegram.org`
- `api.anthropic.com`

**Step 3 — Network info (android_bridge):**
```
POST /network
```

**Output format (Telegram-optimized):**

```
📡 **Connection Status**

**Latency**
• `1.1.1.1` (Cloudflare): XXms ✅
• `8.8.8.8` (Google DNS): XXms ✅
• `api.telegram.org`: XXms ✅
• `google.com`: XXms ✅
• `api.anthropic.com`: XXms ⚠️

**DNS Resolution**
• `google.com` → ✅ resolved
• `api.telegram.org` → ✅ resolved
• `api.anthropic.com` → ✅ resolved

**Connection**
• Type: `WiFi`
• Signal: Good (-45 dBm)
• IP: `192.168.1.42`

👉 Anything specific you want me to check?
```

**Latency thresholds:**
- ✅ Good: <100ms
- ⚠️ Elevated: 100-300ms
- ❌ High/timeout: >300ms or unreachable

## Graceful Capability Handling

If any probe is unavailable or returns an error:
- Report it as: `ℹ️ Unavailable on this Android sandbox`
- Do NOT retry failed probes
- Do NOT fall back to `shell_exec`
- Move on and compile the report with available data
- Always produce a complete report even if some probes fail

## Constraints
- **Read-only** — no iptables, no ifconfig, no route modifications
- **Do NOT use `shell_exec`** — no `ping`, `curl`, `cat`, `ls`, or any shell command
- **Do NOT** read from `/proc/net/*`, `/sys/class/net/*`, `/etc/resolv.conf`
- Use `js_eval` with Node.js `https`, `dns`, `net` modules for all probes
- Use `android_bridge` for device info
- Target platform is Android — no desktop-specific commands
- Never install packages or modify system configuration
- If a probe fails, note it gracefully and continue
