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

**Important:** Only use commands from the `shell_exec` allowlist: `cat`, `ls`, `grep`, `find`, `ping`, `curl`, `uname`, `printenv`, `head`, `tail`, `wc`, `sort`, `uniq`, `date`, `df`, `du`, `pwd`, `which`, `echo`, `mkdir`, `cp`, `mv`. No shell operators (`|`, `||`, `&&`, `;`, `>`, `<`, `` ` ``). Run each command as a separate `shell_exec` call.

Network data is read from `/proc/net/` and `/sys/class/net/` virtual filesystems.

### Mode 1: Network Audit (default)

Run these commands via separate `shell_exec` calls and compile a report:

```
# List network interfaces
ls /sys/class/net/

# Interface state (run for each interface found, e.g. wlan0)
cat /sys/class/net/wlan0/operstate
cat /sys/class/net/wlan0/address

# Network device stats (traffic counters, interface names)
cat /proc/net/dev

# WiFi signal info (if wlan0 exists)
cat /proc/net/wireless

# Open TCP sockets (hex-encoded local/remote addr:port, state)
cat /proc/net/tcp
cat /proc/net/tcp6

# DNS servers
cat /etc/resolv.conf

# Routing table (gateway info, hex-encoded)
cat /proc/net/route

# ARP table (devices on local network)
cat /proc/net/arp
```

**Parsing /proc/net/tcp:** Each line has hex-encoded fields:
- Column 1 (local_address): `IP:PORT` in hex (e.g., `0100007F:1F90` = 127.0.0.1:8080)
- Column 2 (rem_address): remote address in hex
- Column 3 (st): state — `0A` = LISTEN, `01` = ESTABLISHED, `06` = TIME_WAIT
- IP bytes are in reverse order: `0100007F` → `7F.00.00.01` → `127.0.0.1`
- Port is big-endian hex: `1F90` → `8080`

Use `js_eval` to decode the hex data if needed:
```javascript
// Example: decode hex IP
const hex = '0100007F';
const ip = [3,2,1,0].map(i => parseInt(hex.substr(i*2,2), 16)).join('.');
// Result: 127.0.0.1
```

**Parsing /proc/net/route:** Column format:
- Column 0: interface name
- Column 1: destination (hex, `00000000` = default)
- Column 2: gateway (hex IP, reverse byte order)

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
- WiFi: [signal level from /proc/net/wireless]

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

**Known dangerous ports to flag (decimal):**
- 21 (FTP), 23 (Telnet), 25 (SMTP), 445 (SMB), 3389 (RDP)
- 4444, 5555 (common reverse shells / ADB)
- Any port above 49152 with unknown origin

**Known suspicious destinations:**
- Connections to unexpected or unknown external IP addresses (non-private ranges)
- Many connections to the same IP
- Connections on non-standard ports to unknown hosts

### Mode 2: Port Watch

Run port analysis using `/proc/net/` and present results:

```
# TCP sockets (includes listening + established)
cat /proc/net/tcp
cat /proc/net/tcp6

# UDP sockets
cat /proc/net/udp
cat /proc/net/udp6
```

Parse the hex-encoded output (see Mode 1 parsing notes). Filter for state `0A` (LISTEN) to find listening ports.

**Output format:**

```
🔍 Port Watch Report
━━━━━━━━━━━━━━━━━━━━

PORT    PROTO  BIND ADDRESS    STATUS
────    ─────  ────────────    ──────
[port]  TCP    [IP]            🟢 Expected / 🟡 Unusual / 🔴 Dangerous
...

Summary: [X] ports open, [Y] flagged

What would you like me to investigate further?
```

**Flag rules:**
- 🟢 Expected: well-known service ports (80, 443, 8080, 53)
- 🟡 Unusual: non-standard high ports or uncommon service ports
- 🔴 Dangerous: known-bad ports (23, 4444, 5555) or bound to 0.0.0.0 on sensitive ports

### Mode 3: Connection Status

Check connectivity and latency:

```
# Latency to key endpoints (each as separate shell_exec call)
ping -c 3 1.1.1.1
ping -c 3 8.8.8.8

# DNS resolution via ping (will resolve hostname)
ping -c 1 api.telegram.org
ping -c 1 google.com

# Check for VPN/tunnel interfaces
ls /sys/class/net/
# Then check operstate of any tun/tap/wg interfaces found

# IPv6 interface info (may show tun/tap interfaces)
cat /proc/net/if_inet6
```

**Output format:**

```
📡 Connection Status
━━━━━━━━━━━━━━━━━━━━

Endpoint             Latency    Status
────────             ───────    ──────
1.1.1.1              [X]ms      🟢 / 🔴
8.8.8.8              [X]ms      🟢 / 🔴
api.telegram.org     [X]ms      🟢 / 🔴
google.com           [X]ms      🟢 / 🔴

DNS Resolution: 🟢 Working / 🔴 Failed
VPN/Proxy: [Detected / Not detected]
Connection: [Direct / Tunneled]

What would you like me to investigate further?
```

## Constraints
- v1 is **read-only only** — no iptables, no ifconfig changes, no route modifications
- Use only `shell_exec` with allowlisted commands: cat, ls, grep, find, ping, curl, uname, printenv, head, tail, wc, sort, uniq, date, df, du, pwd, which, echo
- No shell operators (|, ||, &&, ;, >, <) — run each command as a separate shell_exec call
- Use `js_eval` for complex parsing (hex decoding from /proc/net/ files)
- Target platform is Android/Linux (no Windows commands)
- No root-required commands — if a command fails due to permissions, note it and move on
- Never install packages or modify system configuration
