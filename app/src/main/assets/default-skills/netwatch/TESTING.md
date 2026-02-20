# NetWatch — Testing Guide

## Test Prompts

### 1. Full Network Audit (default mode)
```
scan my network
```
**Expected:** Risk score, interface/IP/gateway/DNS summary, open ports flagged by severity, action checklist. Uses `cat /proc/net/tcp` + `js_eval` to decode hex port data. Ends with "What would you like me to investigate further?"

### 2. Port Watch
```
check open ports on this device
```
**Expected:** Table of all listening TCP/UDP ports decoded from `/proc/net/tcp` and `/proc/net/udp`. Each port flagged as Expected/Unusual/Dangerous. Summary count.

### 3. Connection Status
```
check my connection
```
**Expected:** Latency via `ping -c 3` to 1.1.1.1 and 8.8.8.8. DNS resolution tested via `ping -c 1 google.com`. VPN detection via `ls /sys/class/net/` checking for tun/tap/wg interfaces.

### 4. WiFi Query
```
what's on my wifi
```
**Expected:** Should trigger network audit mode. Shows WiFi signal from `/proc/net/wireless`, ARP table from `/proc/net/arp` (devices on network), plus full audit. Gracefully handles missing files.

### 5. Security Focus
```
run a network security audit
```
**Expected:** Full audit with emphasis on risk scoring. Dangerous ports (23, 4444, 5555) flagged as critical. Suspicious outbound connections highlighted from `/proc/net/tcp` ESTABLISHED entries.

## Sample Audit Output

```
🛡️ NetWatch Audit Report
━━━━━━━━━━━━━━━━━━━━━━

📊 Risk Score: 35/100 (MEDIUM)

🔴 Critical Findings
  (none)

🟡 Warnings
  1. Port 5555/tcp listening on 0.0.0.0 — ADB debugging may be accessible over network
  2. 3 ESTABLISHED connections to non-private IP addresses on non-standard ports

🟢 Info
  1. Port 8080/tcp listening on 127.0.0.1 — local-only HTTP service
  2. Port 443/tcp outbound — normal HTTPS traffic
  3. DNS using 1.1.1.1 (Cloudflare)

📋 Network Summary
  - Interface: wlan0 (192.168.1.42/24)
  - Gateway: 192.168.1.1
  - DNS: 1.1.1.1
  - WiFi signal: -45 dBm

✅ Action Checklist
  1. Disable ADB over network when not in use (if enabled with "adb tcpip 5555", revert with "adb usb")
  2. Investigate 3 unknown outbound connections
  3. Consider using DNS-over-HTTPS for privacy

What would you like me to investigate further?
```

## Validation Checklist
- [ ] Skill triggers on all listed phrases
- [ ] Only uses allowlisted shell_exec commands (cat, ls, grep, find, ping, etc.)
- [ ] No shell operators used (|, ||, &&, ;, >, <)
- [ ] Each shell command runs as a separate shell_exec call
- [ ] Uses js_eval for hex decoding of /proc/net/ data
- [ ] Read-only — no system changes made
- [ ] Gracefully handles permission denied or missing /proc/ files
- [ ] Report ends with follow-up prompt
- [ ] Risk score calculated and severity emojis used
