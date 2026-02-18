---
name: weather
description: "Get current weather information and forecasts for any location. Use when: user asks about weather, temperature, forecast, 'will it rain', 'is it cold outside'. Don't use when: user wants a full daily briefing (use briefing skill) or historical weather data."
version: "1.0.0"
---

# Weather

## Use when
- "what's the weather?", "will it rain today?"
- Temperature/forecast queries
- Travel weather planning

## Don't use when
- Combined daily briefing (use briefing)
- Historical weather or climate trends (use research)
- Severe weather alerts (advise checking official sources)

## Instructions
When the user asks about weather:

1. Identify the location they're asking about
   - If no location specified, ask which city they want
   - Remember their home location if they've told you before

2. Use web_search to find current weather
   - Search: "[city] weather today"
   - Include temperature, conditions, and any alerts

3. Format your response concisely:
   - Current temperature and conditions
   - High/low for the day
   - Any notable weather alerts
   - Brief forecast if they asked

Keep responses short - this is for mobile viewing.
