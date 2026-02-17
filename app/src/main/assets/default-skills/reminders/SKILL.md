---
name: reminders
description: "Set reminders that will notify you at the specified time"
version: "1.0.0"
emoji: "⏰"
---

# Reminders

## Instructions
Use the reminder tools to manage reminders:

**Setting a reminder:**
1. Extract what to remind about
2. Parse when (natural language supported):
   - "in 30 minutes", "in 2 hours"
   - "tomorrow at 9am", "at 5pm"
   - "2024-01-15 14:30" (ISO format)
3. Call reminder_set with message and time
4. Confirm with the scheduled time

**Listing reminders:**
- Use reminder_list to show pending reminders
- Show ID, message, and when it's due

**Canceling reminders:**
- Use reminder_cancel with the reminder ID
- Confirm cancellation

Examples:
- "Remind me to call mom in 30 minutes"
  → reminder_set("Call mom", "in 30 minutes")
- "What reminders do I have?"
  → reminder_list()
- "Cancel reminder rem_abc123"
  → reminder_cancel("rem_abc123")
