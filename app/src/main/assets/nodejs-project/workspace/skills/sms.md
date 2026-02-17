---
name: sms
description: "Send SMS text messages to contacts or phone numbers"
metadata:
  openclaw:
    emoji: "💬"
    requires:
      bins: []
      env: []
---

# SMS

Send text messages using the Android SMS tool.

## When to Use

User says things like:
- "Text John that I'll be late"
- "Send SMS to 555-1234"
- "Message Mom happy birthday"
- "Tell Sarah I'm on my way"

## CRITICAL: Always Confirm First!

**NEVER send an SMS without explicit user confirmation.**

Before sending, always:
1. Show the recipient (name or number)
2. Show the exact message
3. Ask "Should I send this?"

## Usage

### Step 1: Find the contact (if name given)

```javascript
android_contacts_search({ query: "John" })
```

Response:
```json
{
  "contacts": [
    { "name": "John Smith", "phone": "+15551234567" }
  ]
}
```

### Step 2: Confirm with user

"I'll send this SMS:
📱 **To:** John Smith (+1 555-123-4567)
💬 **Message:** Running 10 minutes late, see you soon!

Should I send it?"

### Step 3: Send after confirmation

```javascript
android_sms({
  phone: "+15551234567",
  message: "Running 10 minutes late, see you soon!"
})
```

## Important Notes

- Messages over 160 characters are split into multiple parts
- Use full phone numbers with country code when possible
- If contact not found, ask user for the number
- NEVER assume a phone number - always verify

## Error Handling

If permission denied:
"I don't have permission to send SMS. Please grant SMS permission in the app settings."

If contact not found:
"I couldn't find [name] in your contacts. What's their phone number?"
