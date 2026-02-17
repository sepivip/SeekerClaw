---
name: location
description: "Get current GPS location and find nearby places"
metadata:
  openclaw:
    emoji: "📍"
    requires:
      bins: []
      env: []
---

# Location

Get current GPS location and find nearby places.

## When to Use

User asks about:
- Current location ("Where am I?")
- Nearby places ("Find coffee shops near me")
- Directions ("How do I get to...")
- Distance ("How far is...")

## Usage

### Get Current Location

```javascript
android_location()
```

Response:
```json
{
  "latitude": 37.7749,
  "longitude": -122.4194,
  "accuracy": 10.5,
  "provider": "gps"
}
```

Format response:
"📍 You're at 37.7749, -122.4194 (accuracy: ~10m)"

### Find Nearby Places

After getting location, use web_search to find nearby places:

```javascript
web_search({ query: "coffee shops near 37.7749, -122.4194" })
```

Or use Google Maps link:
`https://www.google.com/maps/search/coffee+shops/@37.7749,-122.4194,15z`

### Get Directions

Provide a Google Maps link:
```
https://www.google.com/maps/dir/?api=1&origin=current+location&destination=DESTINATION
```

## Response Format

For location queries:
"📍 **Your Location**
Coordinates: 37.7749, -122.4194
Accuracy: ~10 meters

[Open in Google Maps](https://maps.google.com/?q=37.7749,-122.4194)"

For nearby searches:
"☕ **Coffee Shops Near You**
1. Blue Bottle Coffee - 0.2 miles
2. Starbucks - 0.3 miles
3. Philz Coffee - 0.5 miles"

## Error Handling

If permission denied:
"I don't have permission to access your location. Please grant location permission in the app settings."

If no location available:
"I couldn't get your location. Make sure GPS is enabled and try again."

## Privacy Note

Always be mindful that location is sensitive data:
- Don't store precise location in memory unless asked
- Don't share location externally without permission
