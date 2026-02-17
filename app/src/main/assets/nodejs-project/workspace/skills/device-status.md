---
name: device-status
description: "Check battery level, storage space, and device status"
metadata:
  openclaw:
    emoji: "🔋"
    requires:
      bins: []
      env: []
---

# Device Status

Check device status including battery, storage, and more.

## When to Use

User asks about:
- Battery level ("How much battery do I have?")
- Storage space ("How much space is left?")
- Device info ("What's my phone status?")

## Usage

### Battery Status

```javascript
android_battery()
```

Response:
```json
{
  "level": 75,
  "isCharging": true,
  "chargeType": "usb"
}
```

Format response:
"🔋 **Battery:** 75% (charging via USB)"

### Storage Status

```javascript
android_storage()
```

Response:
```json
{
  "total": 128849018880,
  "available": 45097156608,
  "used": 83751862272,
  "totalFormatted": "120.00 GB",
  "availableFormatted": "42.00 GB",
  "usedFormatted": "78.00 GB"
}
```

Format response:
"💾 **Storage:** 42 GB available of 120 GB (65% used)"

### Full Device Status

When user asks for general status, combine both:

```
📱 **Device Status**

🔋 Battery: 75% (charging)
💾 Storage: 42 GB free / 120 GB total
```

## Response Format

Keep it concise and easy to read:
- Use emojis for visual clarity
- Round numbers to whole percentages
- Warn if battery is low (<20%) or storage is low (<10%)

## Warnings

If battery < 20%:
"⚠️ Battery is low (15%). Consider charging soon."

If storage < 10%:
"⚠️ Storage is almost full. Consider freeing up space."
