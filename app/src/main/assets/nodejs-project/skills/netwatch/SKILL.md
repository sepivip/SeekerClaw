---
name: netwatch
description: "Network monitoring and security audit. Use when: user asks to scan network, check open ports, network audit, who's on wifi, check connection, port scan, firewall check, network status, or network security. Don't use when: user asks about crypto transactions (use solana tools) or web search (use research skill)."
version: "1.0.0"
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
metadata:
  openclaw:
    requires:
      bins: ["ip"]
---

# NetWatch — Network Monitor & Security Audit

Read-only network monitoring and security auditing skill for Android/Linux.

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
- VPN setup or configuration changes (out of scope for v1)

## Operating Rules

**READ-ONLY by default.** Never make changes without explicit user approval.

Before any proposed change:
1. Show the exact command that would run
2. Explain the impact
3. Describe how to rollback
4. Wait for user confirmation

Only use reversible actions. If something can't be undone, say so and let the user decide.

## Instructions

You have three modes. Default to **Network Audit** unless the user asks for something specific.

### Mode 1: Network Audit (default)

Run these commands via `shell_exec` and compile a report:

```
# Active interface + IP
ip addr show | grep -E 'state UP|inet '

# WiFi info (if available)
(dumpsys wifi | grep -E 'SSID|rssi|linkSpeed') 2>/dev/null || echo "WiFi info not available"

# Open listening ports + owning process
ss -tlnp 2>/dev/null || netstat -tlnp 2>/dev/null

# Established outbound connections
ss -tnp state established 2>/dev/null || netstat -tnp 2>/dev/null | grep ESTABLISHED

# DNS servers
cat /etc/resolv.conf 2>/dev/null || getprop net.dns1 2>/dev/null

# Default gateway
ip route | grep default
```

**Output format:**

```
🛡️ NetWatch Audit Report
━━━━━━━━━━━━━━━━━━━━━━

📊 Risk Score: [0-100] ([LOW/MEDIUM/HIGH])

🔴 Critical Findings
- [numbered list, most urgent first]

🟡 Warnings
- [numbered list]

🟢 Info
- [numbered list]

📋 Network Summary
- Interface: [name] ([IP])
- Gateway: [IP]
- DNS: [server]
- WiFi: [SSID] (signal: [dBm])

✅ Action Checklist
1. [most important action]
2. [next action]
...

What would you like me to investigate further?
```

**Risk scoring guidelines:**
- 0-25: Low risk — standard config, no unexpected ports
- 26-50: Medium — some open ports or minor config issues
- 51-75: High — suspicious connections or dangerous ports open
- 76-100: Critical — active threats or severe misconfig

**Known dangerous ports to flag:**
- 21 (FTP), 23 (Telnet), 25 (SMTP), 445 (SMB), 3389 (RDP)
- 4444, 5555 (common reverse shells / ADB)
- Any port above 49152 with unknown process

**Known suspicious destinations:**
- Connections to unexpected or unknown external IP addresses (non-private ranges)
- Many connections to the same IP
- Connections on non-standard ports to unknown hosts

### Mode 2: Port Watch

Run port analysis and present results:

```
# All listening ports with process info
ss -tlnp 2>/dev/null || netstat -tlnp 2>/dev/null

# UDP listeners too
ss -ulnp 2>/dev/null || netstat -ulnp 2>/dev/null
```

**Output format:**

```
🔍 Port Watch Report
━━━━━━━━━━━━━━━━━━━━

PORT    PROTO  PROCESS         STATUS
────    ─────  ───────         ──────
[port]  TCP    [process name]  🟢 Expected / 🟡 Unusual / 🔴 Dangerous
...

Summary: [X] ports open, [Y] flagged

What would you like me to investigate further?
```

**Flag rules:**
- 🟢 Expected: well-known service ports (80, 443, 8080, 53)
- 🟡 Unusual: non-standard ports with known processes
- 🔴 Dangerous: known-bad ports (23, 4444, 5555) or unknown processes

### Mode 3: Connection Status

Check connectivity and latency:

```
# Latency to key endpoints
ping -c 3 1.1.1.1 2>/dev/null
ping -c 3 api.telegram.org 2>/dev/null

# DNS resolution check
nslookup google.com 2>/dev/null || host google.com 2>/dev/null || echo "DNS tools (nslookup/host) not available; skipping DNS resolution check."

# Check for VPN/proxy indicators
ip route show table all 2>/dev/null | grep -i 'tun\|tap\|wg'
cat /proc/net/if_inet6 2>/dev/null | grep -i 'tun\|tap'
```

**Output format:**

```
📡 Connection Status
━━━━━━━━━━━━━━━━━━━━

Endpoint             Latency    Status
────────             ───────    ──────
1.1.1.1              [X]ms      🟢 / 🔴
api.telegram.org     [X]ms      🟢 / 🔴
DNS Resolution       [X]ms      🟢 / 🔴

VPN/Proxy: [Detected / Not detected]
Connection: [Direct / Tunneled]

What would you like me to investigate further?
```

## Constraints
- v1 is **read-only only** — no iptables, no ifconfig changes, no route modifications
- Use only `shell_exec` with the commands listed above
- Target platform is Android/Linux (no Windows commands)
- No root-required commands — if a command fails due to permissions, note it and move on
- If a command is not available, use the fallback (e.g., `netstat` if `ss` is missing)
- Never install packages or modify system configuration
