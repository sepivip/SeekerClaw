---
name: weather
description: "Get current weather information and forecasts for any location"
version: "1.0.0"
---

# Weather

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
