---
name: timer
description: "Set countdown timers for cooking, workouts, or any timed activity. Use when: user wants a countdown timer, 'set a timer for X minutes'. Don't use when: user wants a reminder at a specific clock time (use reminders skill) or wants to schedule recurring tasks."
version: "1.0.0"
emoji: "⏱️"
---

# Timer

## Use when
- "set a timer for 5 minutes", "timer for pasta"
- Countdown for cooking/workouts/breaks
- "start a countdown"

## Don't use when
- Reminder at a specific clock time like "at 3pm" (use reminders)
- Schedule recurring tasks (use cron tools)

## Instructions
When the user wants a timer:

1. Parse the duration:
   - "5 minutes", "30 seconds", "1 hour"
   - "5 min timer", "timer for 10 minutes"

2. Use reminder_set with the duration:
   - Message: "⏱️ Timer complete! [original request]"
   - Time: "in X minutes"

3. Confirm the timer is set with the end time

4. For very short timers (<1 min), note that there may be a slight delay

Examples:
- "Set a 5 minute timer" → reminder_set("⏱️ Timer done!", "in 5 minutes")
- "Timer for 30 minutes for pasta" → reminder_set("⏱️ Pasta timer done!", "in 30 minutes")
