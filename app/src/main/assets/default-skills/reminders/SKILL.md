---
name: reminders
description: "Set reminders that will notify you at the specified time. Use when: user says 'remind me to X at Y', wants to schedule a notification, or manage existing reminders. Don't use when: user wants a countdown timer (use timer skill) or wants to save a note without a time trigger (use notes skill)."
version: "1.0.0"
emoji: "⏰"
---

# Reminders

## Use when
- "remind me to X in 30 minutes", "remind me at 5pm"
- List or cancel existing reminders
- Time-specific notifications

## Don't use when
- Simple countdown timer (use timer)
- Save a note without time trigger (use notes)
- Recurring scheduled automation (use cron tools directly)

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
