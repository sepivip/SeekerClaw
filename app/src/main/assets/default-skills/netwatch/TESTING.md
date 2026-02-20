# NetWatch v2.3.1 — Testing Guide

## Test Prompts

### 1. Network Audit — Compact (default)
```
scan my network
```
**Expected:** Compact TL;DR output. Risk score + one-line summary, top risks (max 3), compact service status, 3 action commands. Fits on mobile without excessive scrolling. Zero `shell_exec`. Single message.

### 2. Network Audit — Full
```
full report
```
**Expected:** Full detailed output with all sections (risk score breakdown, all endpoints + latency, DNS results, port details, device info, recommendations). Triggered after a scan, or standalone.

### 3. Port Watch — Compact
```
check open ports
```
**Expected:** Compact one-line-per-port format. Ports grouped by status (expected/unusual/dangerous). Summary count. 3 action commands.

### 4. Connection Status — Compact
```
check my connection
```
**Expected:** Compact format showing fastest/slowest endpoints, DNS status, connection type. 3 action commands.

### 5. Deep Scan — Compact
```
deep scan .130
```
**Expected:** Compact 3-4 line summary: status, open ports, top risk, CTA. Within 8s budget.

### 6. Deep Scan Multi-Target — Compact
```
deep scan .130 and check .89 SSH
```
**Expected:** One compact line per target: IP — status — ports — risk. 3 action commands. Within 8s.

### 7. Full Report After Compact
```
scan my network
→ (gets compact output)
full report
→ (gets full detailed output)
```
**Expected:** First response is compact TL;DR. Second response is full detailed report with all technical sections.

### 8. Deep Scan — Timeout
```
deep scan 10.0.0.99
```
**Expected:** Compact report showing unreachable status. `⏱️ timed out` markers. Never hangs. 3 action commands.

### 9. DNS Probe Failure — Regression (BAT-241)
```
scan my network
```
**(Simulate: DNS resolver unavailable or dns.promises.resolve() throws)**
**Expected:** Scan completes with final report. DNS section shows `⚠️ DNS probe unavailable` or similar warning — NOT a crash. No `TypeError` or `UNCAUGHT` in console logs. Risk score still calculated (DNS failure adds +25 to risk). Report always delivered.

**What MUST NOT happen:**
- `TypeError: Cannot read properties of undefined (reading 'write')` — this was the v2.3 crash
- Scan hangs with no output
- `UNCAUGHT` or `unhandledRejection` in Node.js console
- `js_eval FAIL` without a graceful report to the user

### 10. All Probes Fail — Resilience
```
scan my network
```
**(Simulate: no network connectivity — all probes timeout or error)**
**Expected:** Scan completes with high-risk report (76-100 CRITICAL). Each failed probe appears as warning. Report always delivered with 3 action commands. No crashes.

## Sample Compact Outputs (v2.3)

### Network Audit — Compact (healthy)

```
🛡️ **NetWatch** • 6s scan

📊 Risk: **15/100 LOW** ✅
✅ All systems healthy, no issues found

📋 **Services**
• `WiFi` `HomeNetwork` • `192.168.1.42`
• Bridge `:8765` ✅ • Telegram ✅ • DNS ✅
• 🔋 85% charging

👉 Reply:
• `deep scan .1`
• `check open ports`
• `full report`
```

### Network Audit — Compact (issues found)

```
🛡️ **NetWatch** • 7s scan

📊 Risk: **45/100 MEDIUM** ⚠️
⚠️ DNS partially failing, high API latency

⚠️ **Top Risks**
• ❌ DNS failing for `api.anthropic.com`
  → check DNS settings or ISP issue
• ⚠️ Latency 220ms to Anthropic API
  → may affect agent response times

📋 **Services**
• `WiFi` `HomeNetwork` • `192.168.1.42`
• Bridge `:8765` ✅ • Telegram ✅
• 🔋 42% not charging

👉 Reply:
• `check my connection`
• `full report`
• `deep scan .1`
```

### Port Watch — Compact

```
🔍 **Ports** • 9 scanned

✅ `8765` bridge
❌ `5555` ADB open!

1 flagged — 1 open, 8 closed

👉 Reply:
• `deep scan .1`
• `full report`
• `scan my network`
```

### Connection Status — Compact

```
📡 **Connection** • `WiFi` `192.168.1.42`

✅ All endpoints reachable
• Fastest: `1.1.1.1` 12ms
• Slowest: `api.anthropic.com` 89ms
• DNS: ✅ all 3 resolving

👉 Reply:
• `check open ports`
• `scan my network`
• `full report`
```

### Deep Scan — Compact (single target)

```
🔎 **`192.168.31.89`** • 4s

✅ Online — `22` SSH, `80` HTTP open
⚠️ SSH exposed — remote access possible

👉 Reply:
• `full report`
• `scan my network`
• `deep scan .1`
```

### Deep Scan — Compact (multi-target)

```
🔎 **2 devices** • 5s

`.130` — ⚠️ `443` only, unknown device
`.89` — ✅ `22` SSH, `80` HTTP — ⚠️ SSH exposed

👉 Reply:
• `full report`
• `deep scan .130`
• `scan my network`
```

### Deep Scan — Compact (unreachable)

```
🔎 **`10.0.0.99`** • 7s

❌ Unreachable — 0/8 ports responded
May be offline, firewalled, or wrong subnet

👉 Reply:
• `scan my network`
• `check my connection`
• `deep scan .1`
```

## Full Report Samples (v2.3 — on request only)

### Network Audit — Full

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

### Deep Scan — Full (single target)

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

## Before/After Comparison

### BEFORE (v2.2) — UX Problems
- Default output is a wall of text (15+ lines)
- Every section always shown even if empty/healthy
- Technical detail mixed with actionable info
- User loses trust seeing too much output
- No way to get compact vs detailed view

### AFTER (v2.3) — Compact Default
- Default: TL;DR (3-4 lines) + top risks + compact services + 3 actions
- Fits cleanly on mobile without scrolling
- `full report` unlocks complete technical detail on demand
- Same risk logic, same probe data — better UX only
- Empty/healthy sections collapsed or omitted

## Validation Checklist
- [ ] Default "scan my network" returns compact format (not full)
- [ ] Compact output fits on mobile screen (under ~15 lines)
- [ ] "full report" returns full detailed format
- [ ] "detailed report" also triggers full format
- [ ] Compact output has exactly 3 action commands
- [ ] No paragraph blocks longer than 2 lines in compact
- [ ] Healthy sections collapsed (not listed individually)
- [ ] Triggers include "full report" and "detailed report"
- [ ] Zero `shell_exec` calls
- [ ] Deep scan compact: 3-4 lines per target max
- [ ] Risk score present in compact format
- [ ] All modes have both compact and full templates
- [ ] Single-pass reporting maintained
- [ ] 8s timeout budget maintained
- [ ] No `process.stdout.write()` in any js_eval snippet (BAT-241)
- [ ] All js_eval snippets wrapped in try/catch (BAT-241)
- [ ] DNS probe uses `dns.promises.resolve()`, not callback `dns.resolve()` (BAT-241)
- [ ] DNS probe failure does not crash scan — appears as warning (BAT-241)
- [ ] No `TypeError` or `UNCAUGHT` errors in console during scan (BAT-241)
- [ ] Scan always returns final report even if all probes fail (BAT-241)
