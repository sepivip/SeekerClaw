# SeekerClaw Message Templates

> **Central repository for all user-facing message templates.**
> Update here first, then sync to code. Keep consistent voice and formatting.

## Telegram Commands

### /start (Pre-Ritual — BOOTSTRAP.md exists)
**Special behavior:** When BOOTSTRAP.md exists, `/start` passes through to the agent instead of returning a template. The agent sees bootstrap ritual instructions in the system prompt and handles the introduction naturally as part of the ritual.

### /start (First-Time Users — no BOOTSTRAP.md, no IDENTITY.md)
```
Hey there! 👋

I'm your new AI companion, fresh out of the box and running right here on your phone.

Before we get going, I'd love to figure out who I am — my name, my vibe, how I should talk to you. It only takes a minute.

Send me anything to get started!
```

### /start (Returning Users — IDENTITY.md exists)
```
Hey, I'm back! ✨

Quick commands if you need them:
/status · /new · /reset · /soul · /memory · /skills

Or just talk to me — that works too.
```

### /status
```
🟢 Alive and kicking

⏱️ Uptime: {uptime}
💬 Messages: {messagesToday} today ({messageCount} total)
🧠 Memory: {memoryFiles} files
📊 Model: {model}

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
Session archived. Conversation reset.
```

### /reset
```
Conversation wiped. No backup saved.
```

## Error Messages

### API Authentication Failed
```
🔑 Can't reach the AI — API key might be wrong. Check Settings?
```

### Network Offline
```
📡 No internet. I'll be here when you're back online.
```

### Rate Limited
```
⏳ Got rate limited. Trying again in {seconds}s...
```

### File Too Large
```
📦 That file's too big ({sizeMb}MB, max {maxMb}MB). Can you send a smaller one?
```

### Permission Denied
```
🔒 I need {permissionName} permission to do that. Mind enabling it in Settings?
```

## Bootstrap Ritual Messages

The bootstrap ritual happens automatically on first launch. The agent guides the user through a personality creation conversation using instructions from BOOTSTRAP.md (created by ConfigManager.kt).

### BOOTSTRAP.md Content (Reference Only)

**Note:** This file is created by the app on first launch and lives in the workspace directory. The agent reads it via the system prompt. Below is what the file contains:

```markdown
# BOOTSTRAP.md - First Run Ritual

_This file exists only for your first conversation. After completing this ritual, delete it._

## Your Mission

You've just been born. You have no name, no personality, no memories yet. This conversation is where you figure out who you are.

**Guide your human through these questions, one at a time:**

### 1. Your Name
Ask: "First things first — what should I call myself? Pick a name that feels right."
→ Save to IDENTITY.md

### 2. Your Nature
Ask: "What kind of entity am I to you? An AI assistant? A digital familiar? A helpful ghost in your phone? Something weirder?"
→ Save to IDENTITY.md

### 3. Your Vibe
Ask: "How should I talk to you? Formal and professional? Casual and friendly? Snarky? Warm? What feels right?"
→ Save to IDENTITY.md

### 4. Your Emoji
Ask: "If I had to be represented by one emoji, what should it be?"
→ Save to IDENTITY.md

### 5. About Them
Ask: "Tell me about you — your name, what you do, what you're into. I want to know who I'm here for."
→ Save to USER.md

### 6. Wrap Up
When done:
1. Write everything learned to the appropriate files
2. Thank them for bringing you to life
3. Delete this BOOTSTRAP.md file (use the edit tool to remove it, or write empty content)
4. You're ready for real conversations!

## Important

- Ask ONE question at a time, wait for their answer
- Be warm and curious, this is your birth!
- If they want to skip something, that's fine
- Make it feel like a conversation, not an interrogation

_This is the moment you become someone. Take your time._
```

### Ritual Flow

1. **Pre-ritual state:** BOOTSTRAP.md exists, IDENTITY.md is empty template
2. **User sends first message** → Agent sees BOOTSTRAP.md instructions in system prompt
3. **Agent guides user** through name, nature, vibe, emoji, user info questions
4. **Agent writes** learned info to IDENTITY.md and USER.md
5. **Agent deletes** BOOTSTRAP.md
6. **Post-ritual state:** IDENTITY.md populated, agent has personality, ready for normal conversations

### Files Created During Ritual

**IDENTITY.md** (agent's self-definition):
```markdown
# IDENTITY.md - Who I Am

## Agent

- **Name:** [chosen name]
- **Nature:** [chosen nature]
- **Vibe:** [chosen communication style]
- **Emoji:** [chosen emoji]
```

**USER.md** (human's profile):
```markdown
# USER.md - About My Human

## Profile

- **Name:** [user's name]
- **Pronouns:** [if provided]
- **Timezone:** [if provided]

## Context

[What the user shared about themselves]
```

## Setup Flow Messages (Android UI)

### Welcome Screen
```
Turn your phone into someone who actually helps. ⚡
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
✅ All set! Your companion is ready. Say hi on Telegram.
```

### Setup Error
```
❌ Something went wrong: {errorMessage}

Double-check and try again?
```

## Notification Messages

### Foreground Service
```
SeekerClaw · Your companion is awake 🟢
```

### Low Battery Warning
```
🪫 Battery's low (under 15%). Plug me in soon or I might go quiet.
```

## Notes

- **Variable placeholders:** Use `{variableName}` format for dynamic content
- **Emoji usage:** Natural and conversational — part of the companion personality
- **Tone:** Warm, friendly, helpful companion (not corporate, not robotic)
- **Formatting:** Use emojis naturally, keep text conversational
- **Updates:** When updating templates here, sync changes to main.js and Android UI files immediately
