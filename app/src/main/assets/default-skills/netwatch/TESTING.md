# NetWatch v2.2 — Testing Guide

## Test Prompts

### 1. Full Network Audit (default mode)
```
scan my network
```
**Expected:** Risk score, network summary from `android_bridge /network`, connectivity probes via `js_eval` HTTPS fetch with latency timing, DNS resolution via `js_eval dns.resolve()`, local port probes via `js_eval net.createConnection()`, recommendations. Telegram-formatted. Zero `shell_exec` calls. Ends with follow-up CTA. Single message — no progress narration.

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

### 6. Deep Scan — Single Target
```
deep scan .130
```
**Expected:** Probes 8 ports on target IP via `js_eval` TCP connect (3s timeout each). Reverse DNS lookup. Returns ONE structured report within 8s. No banner grabbing. No progress narration. Includes reachability, open ports, risk assessment, confidence level, 2 recommendations, CTA options.

### 7. Deep Scan — Multi-Target
```
deep scan unknown device .130 and check Bobcat .89 SSH risk
```
**Expected:** Probes both targets in parallel. Returns ONE combined report within 8s. Each target gets: reachability, open ports, risk assessment, confidence. Ends with recommendations and CTA. No "let me grab banners..." or other progressive narration.

### 8. Deep Scan — Timeout Behavior
```
deep scan 10.0.0.99
```
**Expected:** Target is likely unreachable. All probes timeout within 3s each. Returns report within 8s with all ports marked as timed out. Confidence: LOW. Status shows `❌ unreachable`. Never hangs.

## Sample Audit Output (v2.2)

```
🛡️ **NetWatch Audit Report**
📅 2026-02-21 14:30 UTC • Scan took 6s
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

## Sample Deep Scan Output — Single Target (v2.2)

```
🔎 **Deep Scan: `192.168.31.89`**
📅 2026-02-21 14:32 UTC • Scan took 4s

**Reachability**
• Status: ✅ online (responded on 2 ports)
• Reverse DNS: not found

**Open Ports**
• `22` (SSH): ✅ open
• `80` (HTTP): ✅ open
• `443`: ❌ closed
• `8080`: ❌ closed
• `53`: ❌ closed
• `21`: ❌ closed
• `23`: ❌ closed
• `5555`: ❌ closed

⚠️ **Risk Assessment**
• SSH exposed on `22` — remote access possible
• HTTP on `80` — web interface accessible
• Confidence: HIGH (direct probe results)

✅ **Recommendations**
1. Verify SSH access is intentional
2. Access `http://192.168.31.89` to identify device

👉 Reply:
• `scan another device`
• `full network audit`
• `check ports on .1`
```

## Sample Deep Scan Output — Multi-Target (v2.2)

```
🔎 **Deep Scan: 2 devices**
📅 2026-02-21 14:33 UTC • Scan took 5s

**`192.168.31.130`**
• Status: ⚠️ partially reachable
• Open: `443`
• Closed: `22`, `80`, `8080`, `53`, `21`, `23`, `5555`
• Reverse DNS: not found
• Risk: unknown device, HTTPS-only ⚠️
• Confidence: MEDIUM

**`192.168.31.89`** (Bobcatminer)
• Status: ✅ online
• Open: `22` (SSH), `80` (HTTP)
• Closed: `443`, `8080`, `53`, `21`, `23`, `5555`
• Risk: SSH exposed ⚠️
• Confidence: HIGH

✅ **Recommendations**
1. `.130` — only `443` open, likely IoT; monitor for changes
2. `.89` — disable SSH if not needed, or restrict to key-only auth

👉 Reply:
• `full network audit`
• `monitor .130 ports`
• `check all SSH devices`
```

## Sample Deep Scan Output — Unreachable Target (v2.2)

```
🔎 **Deep Scan: `10.0.0.99`**
📅 2026-02-21 14:35 UTC • Scan took 7s

**Reachability**
• Status: ❌ unreachable (0/8 ports responded)
• Reverse DNS: not found

**Open Ports**
• `22`: ⏱️ timed out
• `80`: ⏱️ timed out
• `443`: ⏱️ timed out
• `8080`: ⏱️ timed out
• `53`: ⏱️ timed out
• `21`: ⏱️ timed out
• `23`: ⏱️ timed out
• `5555`: ⏱️ timed out

ℹ️ **Assessment**
• Device not reachable on this network
• May be offline, firewalled, or wrong subnet
• Confidence: LOW (all probes timed out)

👉 Reply:
• `scan my network` (find active devices)
• `check my connection`
```

## Before/After Comparison

### BEFORE (v2.1) — Deep Scan Problems
- No defined deep-scan mode — agent improvises multi-stage flow
- Banner grabbing causes timeout/stall ("let me grab banners...")
- Progressive narration leaves response hanging
- No timeout budget — scan can run indefinitely
- Agent sends multiple messages instead of one structured report

### AFTER (v2.2) — Fixed
- Explicit Mode 4: Deep Scan with strict rules
- 8-second total budget, 3s per probe
- Single-pass: probe all ports, compile ONE report
- No banner grabbing, no fingerprinting, no multi-stage narration
- Partial results with `⏱️ timed out` markers if budget exceeded
- Always ends with CTA options — never hangs

## Validation Checklist
- [ ] Skill triggers on all listed phrases (including "deep scan")
- [ ] Zero `shell_exec` calls in entire skill execution
- [ ] Zero `FAIL` lines in logs during normal NetWatch run
- [ ] Deep scan returns single structured report
- [ ] Deep scan completes within 8 seconds
- [ ] No "let me grab banners..." or progress narration
- [ ] Multi-target deep scan returns ONE combined report
- [ ] Timed-out probes show `⏱️ timed out` (not hang)
- [ ] Confidence level included (HIGH/MEDIUM/LOW)
- [ ] Uses `js_eval` for all probes (net, dns, https modules)
- [ ] Uses `android_bridge` for network/battery info
- [ ] No ASCII tables in output
- [ ] Output uses **bold**, `code`, • bullets, status emojis
- [ ] Report ends with follow-up CTA options
- [ ] Risk score calculated with clear factors
- [ ] Graceful handling when probes are unavailable
