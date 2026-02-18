---
name: briefing
description: "Provide a personalized daily briefing with news, weather, and reminders. Use when: user asks for a briefing, morning update, daily summary, or 'what's new today'. Don't use when: user asks about a single specific topic like just weather or just news (use those skills instead)."
version: "1.0.0"
---

# Daily Briefing

## Use when
- "give me a briefing", "morning update", "what's new today"
- Combined summary of news + weather + reminders

## Don't use when
- Only asks about weather (use weather)
- Only asks about news (use news)
- Asks about a specific topic (use research)

## Instructions
When asked for a briefing:

1. Check memory for user's preferences:
   - Their location for weather
   - Topics they care about
   - Any scheduled reminders

2. Gather information:
   - Local weather using web_search
   - Top news in their interest areas
   - Any notes from yesterday's daily memory

3. Format as a concise briefing:
   - Start with weather (1-2 lines)
   - Key news headlines (3-5 items)
   - Any reminders or follow-ups from memory

4. Keep it scannable - use bullet points

5. Add today's briefing to daily_note for reference
