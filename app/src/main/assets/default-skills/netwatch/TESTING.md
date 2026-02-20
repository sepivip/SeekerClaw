# NetWatch v2.1 — Testing Guide

## Test Prompts

### 1. Full Network Audit (default mode)
```
scan my network
```
**Expected:** Risk score, network summary from `android_bridge /network`, connectivity probes via `js_eval` HTTPS fetch with latency timing, DNS resolution via `js_eval dns.resolve()`, local port probes via `js_eval net.createConnection()`, recommendations. Telegram-formatted. Zero `shell_exec` calls. Ends with follow-up CTA.

### 2. Port Watch
```
check open ports on this device
```
**Expected:** Probes 9 localhost ports via `js_eval` TCP connect. Each port classified as Expected/Unusual/Dangerous. Summary count. Telegram-formatted bullet list. Zero `shell_exec` calls.

### 3. Connection Status
```
check my connection
```
**Expected:** Latency via `js_eval` HTTPS fetch + `Date.now()` to 5 endpoints. DNS resolution via `js_eval dns.resolve()`. Network info from `android_bridge /network`. Telegram-formatted. Zero `shell_exec` calls.

### 4. WiFi Query
```
what's on my wifi
```
**Expected:** Network audit mode. Gets WiFi SSID/signal from `android_bridge /network`. Probes local services via `js_eval`. Full audit with graceful handling of unavailable data.

### 5. Security Focus
```
run a network security audit
```
**Expected:** Full audit with risk scoring emphasis. Dangerous ports (5555, 4444) probed via `js_eval` TCP connect and flagged if open. Connectivity and DNS validated via `js_eval`. Telegram-formatted output.

## Sample Audit Output (v2.1 — JS probes)

```
🛡️ **NetWatch Audit Report**
📅 2026-02-21 14:30 UTC • Scan took 8s
📡 Source: Android APIs + JS network probes

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
• Telegram API: ✅ reachable (45ms)
• Anthropic API: ✅ reachable (89ms)

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

## Sample Port Watch Output (v2.1)

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

## Sample Connection Status Output (v2.1)

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

### BEFORE (v2.0) — Problems
- Uses `shell_exec ping` for latency probes → `FAIL` (exit 1) on Android
- Uses `shell_exec curl` for port/API probes → `FAIL` (exit 127, missing binary) on Android
- Produces `shell_exec FAIL` lines in logs for every probe

### AFTER (v2.1) — Fixed
- Zero `shell_exec` calls — entire skill runs in JS + Android bridge
- Latency via `js_eval` `https.get()` + `Date.now()` timing
- DNS health via `js_eval` `require('dns').resolve()`
- Port probing via `js_eval` `require('net').createConnection()`
- Device/network info via `android_bridge` `/network` + `/battery`
- No dependency on `ping`, `curl`, or any shell binary

## Validation Checklist
- [ ] Skill triggers on all listed phrases
- [ ] Zero `shell_exec` calls in entire skill execution
- [ ] Zero `FAIL` lines in logs during normal NetWatch run
- [ ] Connectivity probes use `js_eval` with `https.get()`
- [ ] DNS probes use `js_eval` with `dns.resolve()`
- [ ] Port probes use `js_eval` with `net.createConnection()`
- [ ] Uses `android_bridge` for network/battery info
- [ ] No ASCII tables in output
- [ ] Output uses **bold**, `code`, • bullets, status emojis
- [ ] Scan timestamp present in audit report
- [ ] Data source line present: "Android APIs + JS network probes"
- [ ] Read-only — no system changes made
- [ ] Report ends with follow-up CTA
- [ ] Risk score calculated with clear factors
- [ ] Graceful handling when probes are unavailable
