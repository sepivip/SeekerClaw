# SeekerClaw Message Templates

> **Central repository for all user-facing message templates.**
> Update here first, then sync to code. Keep consistent voice and formatting.

## Telegram Commands

### /start (First-Time Users)
```
Hello! I'm {AGENT_NAME}, your AI assistant running on Android via SeekerClaw.

I can:
- Have conversations and remember context
- Search the web for current information
- Save and recall memories
- Take daily notes
- Check camera view (vision) and describe what it sees
- Use specialized skills for specific tasks

Commands:
/status - Show system status
/new - Save session summary & start fresh
/reset - Clear conversation history (no summary)
/soul - Show my personality
/memory - Show long-term memory
/skills - List installed skills
/help - Show this message

Just send me a message to chat!
```

### /start (Returning Users)
```
Welcome back! I'm {AGENT_NAME}.

Commands:
/status - Show system status
/new - Save session summary & start fresh
/reset - Clear conversation history (no summary)
/soul - Show my personality
/memory - Show long-term memory
/skills - List installed skills
/help - Show this message

Ready to continue where we left off!
```

### /status
```
🟢 **Status:** Running
⏱️ **Uptime:** {uptime}
💬 **Messages:** {messageCount} total, {messagesToday} today
📊 **Model:** {model}
🧠 **Memory:** {memoryFiles} files indexed

Last active: {lastActivity}
```

### /help
Delegates to `/start`

### /soul
Shows contents of `SOUL.md`

### /memory
Shows contents of `MEMORY.md`

### /skills
Lists all installed skills from workspace

### /new
```
Session summary saved. Starting fresh conversation.
```

### /reset
```
Conversation history cleared (no summary saved).
```

## Error Messages

### API Authentication Failed
```
Error: API authentication failed. Please check your API key in Settings.
```

### Network Offline
```
⚠️ No internet connection. Please check your network and try again.
```

### Rate Limited
```
⚠️ API rate limit reached. Retrying in {seconds}s...
```

### File Too Large
```
File too large ({sizeMb}MB). Max is {maxMb}MB.
```

### Permission Denied
```
Permission denied: {permissionName}. Please enable in Android Settings.
```

## Bootstrap Ritual Messages

### Welcome (BOOTSTRAP.md exists)
Agent receives bootstrap instructions from system prompt, not a hardcoded template.

### Post-Bootstrap Confirmation
Agent-generated after completing ritual and deleting BOOTSTRAP.md.

## Setup Flow Messages (Android UI)

### Welcome Screen
```
Welcome to SeekerClaw

Turn your Seeker phone into a 24/7 AI assistant.
```

### QR Scan Prompt
```
Scan QR Code

Use the SeekerClaw web setup tool to generate your configuration QR code.
```

### Manual Entry
```
Or enter credentials manually below
```

### Setup Success
```
✅ Configuration saved!

Your AI assistant is ready to deploy.
```

### Setup Error
```
❌ Setup failed: {errorMessage}

Please check your credentials and try again.
```

## Notification Messages

### Foreground Service
```
SeekerClaw is running

Your AI assistant is active and monitoring Telegram.
```

### Low Battery Warning
```
⚠️ Battery below 15%. Agent may stop soon. Please charge your device.
```

## Notes

- **Variable placeholders:** Use `{variableName}` format for dynamic content
- **Emoji usage:** Minimal — only for status indicators and critical warnings
- **Tone:** Professional, helpful, concise
- **Formatting:** Use bold for emphasis, code blocks for technical terms
- **Updates:** When updating templates here, sync changes to main.js immediately
