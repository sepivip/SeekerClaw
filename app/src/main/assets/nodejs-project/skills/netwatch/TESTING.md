# NetWatch — Testing Guide

## Test Prompts

### 1. Full Network Audit (default mode)
```
scan my network
```
**Expected:** Risk score, interface/IP/gateway/DNS summary, open ports flagged by severity, action checklist. Ends with "What would you like me to investigate further?"

### 2. Port Watch
```
check open ports on this device
```
**Expected:** Table of all listening TCP/UDP ports with process names. Each port flagged as Expected/Unusual/Dangerous. Summary count.

### 3. Connection Status
```
check my connection
```
**Expected:** Latency to 1.1.1.1 and api.telegram.org, DNS resolution result, VPN/proxy detection.

### 4. WiFi Query
```
what's on my wifi
```
**Expected:** Should trigger network audit mode. Shows WiFi SSID and signal if available, plus full audit. Gracefully handles missing WiFi info.

### 5. Security Focus
```
run a network security audit
```
**Expected:** Full audit with emphasis on risk scoring. Dangerous ports (23, 4444, 5555) flagged as critical. Suspicious outbound connections highlighted.

## Sample Audit Output

```
🛡️ NetWatch Audit Report
━━━━━━━━━━━━━━━━━━━━━━

📊 Risk Score: 35/100 (MEDIUM)

🔴 Critical Findings
  (none)

🟡 Warnings
  1. Port 5555/tcp open (adbd) — ADB debugging enabled, accessible over network
  2. 3 established connections to unknown IPs on non-standard ports

🟢 Info
  1. Port 8080/tcp open (nodejs) — SeekerClaw agent server
  2. Port 443/tcp outbound — normal HTTPS traffic
  3. DNS using 1.1.1.1 (Cloudflare)

📋 Network Summary
  - Interface: wlan0 (192.168.1.42/24)
  - Gateway: 192.168.1.1
  - DNS: 1.1.1.1
  - WiFi: HomeNetwork-5G (signal: -45 dBm)

✅ Action Checklist
  1. Disable ADB over network when not in use (if enabled with "adb tcpip 5555", revert with "adb usb")
  2. Investigate 3 unknown outbound connections
  3. Consider using DNS-over-HTTPS for privacy

What would you like me to investigate further?
```

## Validation Checklist
- [ ] Skill triggers on all listed phrases
- [ ] Read-only — no system changes made
- [ ] Gracefully handles missing commands (ss → netstat fallback)
- [ ] Gracefully handles permission denied errors
- [ ] Report ends with follow-up prompt
- [ ] Risk score calculated and severity emojis used
