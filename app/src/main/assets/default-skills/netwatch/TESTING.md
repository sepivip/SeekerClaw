# NetWatch v2 — Testing Guide

## Test Prompts

### 1. Full Network Audit (default mode)
```
scan my network
```
**Expected:** Risk score, network summary from Android bridge `/network`, connectivity probes via `ping`, DNS resolution checks, local service port probes via `curl`, recommendations. Telegram-formatted (no ASCII tables). Ends with follow-up CTA. Zero `shell_exec FAIL` for `/proc` or `/sys` paths.

### 2. Port Watch
```
check open ports on this device
```
**Expected:** Probes 9 localhost ports via `curl --connect-timeout`. Each port classified as Expected/Unusual/Dangerous. Summary count. Telegram-formatted bullet list (no pipe tables).

### 3. Connection Status
```
check my connection
```
**Expected:** Latency via `ping -c 3 -W 3` to 5 endpoints (1.1.1.1, 8.8.8.8, api.telegram.org, google.com, api.anthropic.com). DNS resolution status. Network info from Android bridge `/network`. Telegram-formatted.

### 4. WiFi Query
```
what's on my wifi
```
**Expected:** Network audit mode. Gets WiFi SSID/signal from Android bridge `/network` (NOT from `/proc/net/wireless`). Probes local services. Full audit with graceful handling of unavailable data.

### 5. Security Focus
```
run a network security audit
```
**Expected:** Full audit with risk scoring emphasis. Dangerous ports (5555, 4444) probed and flagged if open. Connectivity and DNS validated. Telegram-formatted output.

## Sample Audit Output (v2 — Telegram-optimized)

```
🛡️ **NetWatch Audit Report**
📅 2026-02-21 14:30 UTC • Scan took 12s
📡 Source: Android APIs + safe network probes

📊 **Risk Score: 15/100 (LOW)**

ℹ️ **Info**
• `localhost:8765` bridge responding ✅
• DNS resolving normally ✅
• All critical APIs reachable ✅

📋 **Network Summary**
• Connection: `WiFi`
• SSID: `HomeNetwork`
• IP: `192.168.1.42`
• Signal: -45 dBm (Good)
• DNS: ✅ resolving
• Telegram API: ✅ reachable
• Anthropic API: ✅ reachable

🔌 **Local Services**
• `localhost:8765` (bridge): ✅
• `localhost:3000`: not running
• `localhost:8080`: not running

🔋 **Device**
• Battery: 85% (charging via USB)

✅ **Recommendations**
1. Network looks healthy — no action needed
2. Consider enabling DNS-over-HTTPS for privacy

👉 What should I look into next?
```

## Sample Port Watch Output (v2)

```
🔍 **Port Watch Report**

🟢 **Expected Services**
• `8765` — Android bridge ✅ responding

📊 **Summary**
• Scanned: 9 ports
• Open: 1 • Closed: 8
• Flagged: 0

👉 Want me to investigate any of these?
```

## Sample Connection Status Output (v2)

```
📡 **Connection Status**

**Latency**
• `1.1.1.1` (Cloudflare): 12ms ✅
• `8.8.8.8` (Google DNS): 15ms ✅
• `api.telegram.org`: 45ms ✅
• `google.com`: 18ms ✅
• `api.anthropic.com`: 89ms ✅

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

## Before/After Comparison

### BEFORE (v1) — Problems
- Attempts `cat /proc/net/tcp`, `ls /sys/class/net/`, `cat /etc/resolv.conf` → all produce `shell_exec FAIL`
- ASCII table output with `━━━`, `────`, `| col | col |` → breaks on Telegram mobile
- No Android bridge integration
- No scan timestamp or data source line

### AFTER (v2) — Fixed
- Zero `/proc` or `/sys` access attempts
- Uses Android bridge `/network` + `ping` + `curl` probes
- Telegram-optimized markdown (bold, bullets, inline code, emojis)
- Scan timestamp + data source line in every report
- Graceful "unavailable on Android sandbox" for any probe that fails

## Validation Checklist
- [ ] Skill triggers on all listed phrases
- [ ] Zero `shell_exec FAIL` for `/proc` or `/sys` paths
- [ ] Uses `ping` and `curl` for connectivity probes
- [ ] Uses `android_bridge` for network/battery info
- [ ] No ASCII tables in output
- [ ] Output uses **bold**, `code`, • bullets, status emojis
- [ ] Scan timestamp present in audit report
- [ ] Data source line present: "Android APIs + safe network probes"
- [ ] Read-only — no system changes made
- [ ] Report ends with follow-up CTA
- [ ] Risk score calculated with clear factors
- [ ] Graceful handling when probes are unavailable
