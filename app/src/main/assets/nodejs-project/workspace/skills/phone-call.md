---
name: phone-call
version: "1.0.0"
description: "Make phone calls to contacts or phone numbers"
metadata:
  openclaw:
    emoji: "📞"
    requires:
      bins: []
      env: []
---

# Phone Call

Make phone calls using the Android call tool.

## When to Use

User says things like:
- "Call Mom"
- "Phone John"
- "Dial 555-1234"
- "Call the pizza place"

## CRITICAL: Always Confirm First!

**NEVER make a call without explicit user confirmation.**

Before calling, always:
1. Show who you're calling (name or number)
2. Ask "Should I call them?"

## Usage

### Step 1: Find the contact (if name given)

```javascript
android_contacts_search({ query: "Mom" })
```

### Step 2: Confirm with user

"📞 Call **Mom** (+1 555-123-4567)?

Say 'yes' to call or 'no' to cancel."

### Step 3: Make call after confirmation

```javascript
android_call({ phone: "+15551234567" })
```

The phone app will open and initiate the call.

## Important Notes

- The call is made immediately - phone app opens
- User can hang up from the phone app
- Use full phone numbers with country code when possible
- For businesses, you may need to web search for the number

## Finding Business Numbers

If user wants to call a business:
1. Use web_search to find the business number
2. Confirm the number with the user
3. Then make the call

Example:
User: "Call the nearest Domino's"
1. Search: "Domino's pizza [user's city] phone number"
2. Present the number found
3. Confirm before calling

## Error Handling

If permission denied:
"I don't have permission to make calls. Please grant phone permission in the app settings."

If contact not found:
"I couldn't find [name] in your contacts. What's their phone number?"
