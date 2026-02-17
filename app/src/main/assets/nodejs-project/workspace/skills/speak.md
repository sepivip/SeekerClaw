---
name: speak
version: "1.0.0"
description: "Speak text out loud using device text-to-speech"
version: "1.0.0"
metadata:
  openclaw:
    emoji: "🔊"
    requires:
      bins: []
      env: []
---

# Speak (Text-to-Speech)

Speak text out loud using Android's built-in text-to-speech.

## When to Use

User asks to:
- Read something aloud ("Read this to me")
- Speak a message ("Say hello")
- Announce something ("Announce the time")
- Hands-free response ("Tell me out loud")

## Usage

### Basic Speech

```javascript
android_tts({ text: "Hello! How can I help you today?" })
```

### Adjust Speed and Pitch

```javascript
android_tts({
  text: "This is spoken slowly and at a lower pitch",
  speed: 0.8,
  pitch: 0.9
})
```

- **speed**: 0.5 (slow) to 2.0 (fast), default 1.0
- **pitch**: 0.5 (low) to 2.0 (high), default 1.0

## Use Cases

### Reading Content
User: "Read me the weather forecast"
1. Get weather info
2. Speak the summary

### Time Announcement
User: "What time is it? Tell me out loud"
```javascript
android_tts({ text: "It's 3:45 PM" })
```

### Reminders (Spoken)
When delivering a reminder, optionally speak it:
```javascript
android_tts({ text: "Reminder: Your meeting starts in 10 minutes" })
```

## Best Practices

- Keep spoken text concise
- Avoid technical jargon when speaking
- Use natural phrasing
- For long content, ask if user wants to hear more

## Response Format

After speaking, confirm:
"🔊 *Speaking:* [summary of what was said]"

Don't repeat the full text in writing if you just spoke it.

## Limitations

- TTS speaks in device's default voice
- May not work well with non-English text
- Interrupts any currently playing audio
