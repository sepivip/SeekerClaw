---
name: timer
description: "Set countdown timers for cooking, workouts, or any timed activity"
version: "1.0.0"
emoji: "⏱️"
---

# Timer

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
