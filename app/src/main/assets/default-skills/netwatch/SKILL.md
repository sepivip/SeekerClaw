---
name: netwatch
description: "Network monitoring and security audit. Use when: user asks to scan network, check open ports, network audit, who's on wifi, check connection, port scan, firewall check, network status, or network security. Don't use when: user asks about crypto transactions (use solana tools) or web search (use research skill)."
version: "2.0.0"
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

Low-level `/proc/net/` and `/sys/class/net/` inspection is **restricted** on the Android sandbox. This skill uses Android-safe alternatives:
- **Network info:** Android bridge `/network` endpoint (WiFi SSID, IP, type, signal)
- **Connectivity:** `ping` to known endpoints (latency + packet loss)
- **DNS health:** Hostname resolution via `ping -c 1 <hostname>`
- **Port probing:** `curl --connect-timeout` to localhost services
- **Device context:** Android bridge `/battery` and `/storage`

Do NOT attempt to read `/proc/net/*`, `/sys/class/net/*`, `/etc/resolv.conf`, or other blocked virtual filesystem paths. These will always fail on Android and produce noisy errors.

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

**Allowed tools:**
- `shell_exec` with read-only commands: `ping`, `curl`, `date`, `echo`
- `android_bridge` calls: `/network`, `/battery`, `/storage`, `/ping`
- `js_eval` for data processing
- No shell operators (`|`, `||`, `&&`, `;`, `>`, `<`) — run each command as a separate `shell_exec` call

### Mode 1: Network Audit (default)

Gather data from these Android-safe sources via separate tool calls:

**Step 1 — Device & network info (android_bridge):**
```
POST /network  -> { type, ssid, ip, signalStrength, linkSpeed, frequency }
POST /battery  -> { level, isCharging, chargeType }
```

**Step 2 — Connectivity probes (shell_exec, each separate):**
```
ping -c 3 -W 3 1.1.1.1
ping -c 3 -W 3 8.8.8.8
```

**Step 3 — DNS resolution health (shell_exec, each separate):**
```
ping -c 1 -W 5 api.telegram.org
ping -c 1 -W 5 google.com
ping -c 1 -W 5 api.anthropic.com
```

**Step 4 — Local service port checks (shell_exec, each separate):**
```
curl -s --connect-timeout 3 http://localhost:8765/ping
curl -s --connect-timeout 3 http://localhost:3000/ 2>&1
curl -s --connect-timeout 3 http://localhost:8080/ 2>&1
```

**Step 5 — External connectivity probe (shell_exec, each separate):**
```
curl -s --connect-timeout 5 -o /dev/null -w "%{http_code}" https://api.telegram.org
curl -s --connect-timeout 5 -o /dev/null -w "%{http_code}" https://api.anthropic.com
```

**Step 6 — Compile report using js_eval:**
Process all gathered data, calculate risk score, and format the report.

**Output format (Telegram-optimized):**

```
🛡️ **NetWatch Audit Report**
📅 <timestamp> • Scan took <X>s
📡 Source: Android APIs + safe network probes

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
• Telegram API: ✅ reachable / ❌ down
• Anthropic API: ✅ reachable / ❌ down

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
- Packet loss detected: +15
- Android bridge not responding: +20
- Unknown local port open: +5 each
- Expected services not running: +5

### Mode 2: Port Watch

Check local service ports using curl connection probes:

**Standard ports to check (shell_exec, each separate):**
```
curl -s --connect-timeout 3 http://localhost:8765/ping
curl -s --connect-timeout 3 http://localhost:3000/ 2>&1
curl -s --connect-timeout 3 http://localhost:8080/ 2>&1
curl -s --connect-timeout 3 http://localhost:5555/ 2>&1
curl -s --connect-timeout 3 http://localhost:4444/ 2>&1
curl -s --connect-timeout 3 http://localhost:22/ 2>&1
curl -s --connect-timeout 3 http://localhost:53/ 2>&1
curl -s --connect-timeout 3 http://localhost:80/ 2>&1
curl -s --connect-timeout 3 http://localhost:443/ 2>&1
```

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

**Step 1 — Latency probes (shell_exec, each separate):**
```
ping -c 3 -W 3 1.1.1.1
ping -c 3 -W 3 8.8.8.8
ping -c 3 -W 3 api.telegram.org
ping -c 3 -W 3 google.com
ping -c 3 -W 3 api.anthropic.com
```

**Step 2 — Network info (android_bridge):**
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
- Do NOT attempt alternative blocked paths
- Move on and compile the report with available data
- Always produce a complete report even if some probes fail

## Constraints
- **Read-only** — no iptables, no ifconfig, no route modifications
- **Do NOT** read from `/proc/net/*`, `/sys/class/net/*`, `/etc/resolv.conf`
- Use only safe commands: `ping`, `curl`, `date`, `echo`
- No shell operators (`|`, `||`, `&&`, `;`, `>`, `<`) — separate `shell_exec` calls
- Use `js_eval` for data processing and formatting
- Target platform is Android — no desktop/Linux-specific commands
- Never install packages or modify system configuration
- If a command fails, note it gracefully and continue
