# Discord PR 1 — Message Shape Normalization

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Refactor `message-handler.js` to accept a normalized message shape instead of raw Telegram objects, enabling any channel (Telegram, Discord) to feed messages into the same handler.

**Architecture:** Define a `NormalizedMessage` shape that both Telegram and Discord can produce. Move Telegram-specific field extraction into main.js's poll loop (the caller). Refactor `handleMessage()` to consume the normalized shape. Abstract media handling so both Telegram file_id downloads and direct URL downloads work. All changes are pure refactor — Telegram behavior unchanged.

**Tech Stack:** Node.js 18 (JS agent only — no Kotlin changes in this PR)

---

## File Map

| File | Action | Responsibility |
|------|--------|----------------|
| `message-handler.js` | **Modify** | Change `handleMessage(msg)` to accept normalized shape: `{ chatId, senderId, text, caption, media, messageId, replyTo, replyAuthor, quoteText }`. Remove all `msg.chat.id`, `msg.from.id`, `msg.text`, `msg.reply_to_message` etc. accesses. |
| `main.js` | **Modify** | Add `normalizeTelegramMessage(msg)` function in the poll loop that converts raw Telegram update.message into the normalized shape before passing to `enqueueMessage()`. Update `handleReactionUpdate` call with normalized reaction shape. |
| `telegram.js` | **Modify** | Add `downloadFile(fileId, fileName)` as alias for existing `downloadTelegramFile`. Export new `downloadFileByUrl(url, fileName)` for direct-URL downloads (Discord). Update `extractMedia` to return a shape that includes `downloadMethod: 'telegram_file_id' | 'url'`. |

---

## Normalized Message Shape

```javascript
{
    chatId: string | number,     // Telegram: msg.chat.id, Discord: channel_id
    senderId: string,            // Telegram: String(msg.from.id), Discord: author.id
    text: string,                // Telegram: msg.text, Discord: msg.content
    caption: string,             // Telegram: msg.caption, Discord: '' (no concept)
    messageId: string | number,  // Telegram: msg.message_id, Discord: msg.id
    media: {                     // null if no attachment
        type: string,            // 'photo', 'document', 'video', 'audio', 'voice', 'video_note'
        file_id: string | null,  // Telegram file_id (null for Discord)
        url: string | null,      // Direct download URL (null for Telegram)
        file_size: number,
        mime_type: string,
        file_name: string,
    } | null,
    replyTo: {                   // null if not a reply
        text: string,            // Body of the replied-to message
        authorName: string,      // First name / display name of original author
    } | null,
    quoteText: string | null,    // Inline quote text (Telegram-specific, null for Discord)
    raw: object,                 // Original raw message for channel-specific tools
}
```

---

## Task 1: Add `normalizeTelegramMessage()` to main.js

**Files:**
- Modify: `app/src/main/assets/nodejs-project/main.js`

- [ ] **Step 1: Add normalization function before the poll() function**

Add this function before `async function poll()` (~line 313):

```javascript
/**
 * Convert raw Telegram message into channel-agnostic normalized shape.
 * This is the only place that reads Telegram-specific fields from update.message.
 */
function normalizeTelegramMessage(msg) {
    const media = extractMedia(msg);
    // Normalize media to include downloadMethod
    let normalizedMedia = null;
    if (media) {
        normalizedMedia = {
            ...media,
            url: null,           // Telegram uses file_id, not URLs
            downloadMethod: 'telegram_file_id',
        };
    }

    // Extract reply context
    const reply = msg.reply_to_message;
    const externalReply = msg.external_reply;
    const quoteText = (msg.quote?.text ?? externalReply?.quote?.text ?? '').trim() || null;
    const replyLike = reply ?? externalReply;
    let replyTo = null;
    if (replyLike) {
        replyTo = {
            text: (replyLike.text ?? replyLike.caption ?? '').trim(),
            authorName: reply?.from?.first_name || 'Someone',
        };
    }

    return {
        chatId: msg.chat.id,
        senderId: String(msg.from?.id),
        text: (msg.text || '').trim(),
        caption: (msg.caption || '').trim(),
        messageId: msg.message_id,
        media: normalizedMedia,
        replyTo,
        quoteText,
        raw: msg,
    };
}
```

- [ ] **Step 2: Import `extractMedia` from telegram.js**

Find the existing telegram.js import block (~line 108-112) and add `extractMedia` to the destructured imports:

```javascript
const {
    telegram,
    sendMessage, sendTyping,
    downloadTelegramFile, extractMedia,
    // ... other existing imports
} = require('./telegram');
```

- [ ] **Step 3: Update `enqueueMessage` call in poll loop**

In `poll()`, find the line `enqueueMessage(update.message)` (~line 360). Replace with:
```javascript
                        enqueueMessage(normalizeTelegramMessage(update.message));
```

- [ ] **Step 4: Update confirmation interception in poll loop**

The confirmation interception block (~lines 336-358) reads raw Telegram fields. Update it to also use normalized fields. Find:
```javascript
                        const msgChatId = update.message.chat.id;
```
Keep this as-is (it's before normalization, in the poll loop). But update the plain text check to use raw message fields (this stays Telegram-specific in the poll loop — it's intercepting before enqueue):
This block can stay as-is since it operates on raw Telegram updates before normalization.

- [ ] **Step 5: Update callback query synthetic message**

Find the callback query handler (~line 376-399) where it creates a synthetic message for the quick-action callback. Update to produce a normalized shape:

Find:
```javascript
                            const cbChat = cb.message?.chat || { id: cb.from.id };
                            const cbMsgId = cb.message?.message_id;
```

After the `quickText` handling, where a synthetic message is enqueued, ensure it's in normalized shape. Find the `enqueueMessage` call for callbacks and wrap it:
```javascript
                            enqueueMessage({
                                chatId: cbChat.id,
                                senderId: String(cb.from.id),
                                text: (quickText || cb.data || '').trim(),
                                caption: '',
                                messageId: cbMsgId,
                                media: null,
                                replyTo: null,
                                quoteText: null,
                                raw: cb.message || {},
                            });
```

- [ ] **Step 6: Syntax check**
```bash
node --check app/src/main/assets/nodejs-project/main.js && echo "OK"
```

- [ ] **Step 7: Commit**
```bash
git add app/src/main/assets/nodejs-project/main.js
git commit -m "feat: add normalizeTelegramMessage() — convert raw Telegram to normalized shape

Co-Authored-By: Claude Opus 4.6 <noreply@anthropic.com>"
```

---

## Task 2: Refactor `handleMessage()` to use normalized shape

**Files:**
- Modify: `app/src/main/assets/nodejs-project/message-handler.js`

This is the largest task. Change every `msg.xxx` access in `handleMessage()` to use the normalized field names.

- [ ] **Step 1: Update function signature and initial field extraction**

Replace lines ~370-398 (the entire top of handleMessage):

```javascript
async function handleMessage(msg) {
    assertInit();
    const chatId = msg.chat.id;
    const senderId = String(msg.from?.id);
    const rawText = (msg.text || msg.caption || '').trim();
    const media = deps.extractMedia(msg);

    // Skip messages with no text AND no media
    if (!rawText && !media) return;

    // Extract quoted/replied message context
    let text = rawText;
    const reply = msg.reply_to_message;
    const externalReply = msg.external_reply;
    const quoteText = (msg.quote?.text ?? externalReply?.quote?.text ?? '').trim();
    const replyLike = reply ?? externalReply;

    if (quoteText) {
        const quotedFrom = reply?.from?.first_name || 'Someone';
        text = `[Replying to ${quotedFrom}: "${quoteText}"]\n\n${rawText}`;
    } else if (replyLike) {
        const replyBody = (replyLike.text ?? replyLike.caption ?? '').trim();
        if (replyBody) {
            const quotedFrom = reply?.from?.first_name || 'Someone';
            text = `[Replying to ${quotedFrom}: "${replyBody}"]\n\n${rawText}`;
        }
    }
```

With:

```javascript
async function handleMessage(normalized) {
    assertInit();
    const { chatId, senderId, text: rawText, caption, messageId, media, replyTo, quoteText } = normalized;
    const combinedText = (rawText || caption || '').trim();

    // Skip messages with no text AND no media
    if (!combinedText && !media) return;

    // Build text with reply context (channel-agnostic)
    let text = combinedText;
    if (quoteText) {
        const quotedFrom = replyTo?.authorName || 'Someone';
        text = `[Replying to ${quotedFrom}: "${quoteText}"]\n\n${combinedText}`;
    } else if (replyTo?.text) {
        const quotedFrom = replyTo.authorName || 'Someone';
        text = `[Replying to ${quotedFrom}: "${replyTo.text}"]\n\n${combinedText}`;
    }
```

- [ ] **Step 2: Update owner auto-detect section**

No changes needed — it already uses `chatId`, `senderId`, `deps.sendMessage(chatId, ...)`. These come from the destructured normalized shape now.

- [ ] **Step 3: Update logging and status reaction**

Find (~line 422):
```javascript
    deps.log(`Message: ${rawText ? rawText.slice(0, 100) + (rawText.length > 100 ? '...' : '') : '(no text)'}${media ? ` [${media.type}]` : ''}${msg.reply_to_message ? ' [reply]' : ''}`, 'DEBUG');

    const statusReaction = deps.createStatusReactionController(chatId, msg.message_id);
```

Replace with:
```javascript
    deps.log(`Message: ${combinedText ? combinedText.slice(0, 100) + (combinedText.length > 100 ? '...' : '') : '(no text)'}${media ? ` [${media.type}]` : ''}${replyTo ? ' [reply]' : ''}`, 'DEBUG');

    const statusReaction = deps.createStatusReactionController(chatId, messageId);
```

- [ ] **Step 4: Update `lastIncomingMessages` tracking**

Find (~line 465):
```javascript
        deps.lastIncomingMessages.set(String(chatId), { messageId: msg.message_id, chatId });
```

Replace with:
```javascript
        deps.lastIncomingMessages.set(String(chatId), { messageId, chatId });
```

- [ ] **Step 5: Update media handling — abstract download method**

Find the media download section (~line 492-502):
```javascript
                    let saved;
                    const TRANSIENT_ERRORS = /timeout|timed out|aborted|ECONNRESET|ETIMEDOUT|Connection closed/i;
                    try {
                        saved = await deps.downloadTelegramFile(media.file_id, media.file_name);
                    } catch (firstErr) {
                        if (TRANSIENT_ERRORS.test(firstErr.message)) {
                            deps.log(`Media download failed (transient: ${firstErr.message}), retrying in 2s...`, 'WARN');
                            await new Promise(r => setTimeout(r, 2000));
                            saved = await deps.downloadTelegramFile(media.file_id, media.file_name);
                        } else {
                            throw firstErr;
                        }
                    }
```

Replace with:
```javascript
                    let saved;
                    const TRANSIENT_ERRORS = /timeout|timed out|aborted|ECONNRESET|ETIMEDOUT|Connection closed/i;
                    const downloadFn = media.downloadMethod === 'url'
                        ? () => deps.downloadFileByUrl(media.url, media.file_name)
                        : () => deps.downloadTelegramFile(media.file_id, media.file_name);
                    try {
                        saved = await downloadFn();
                    } catch (firstErr) {
                        if (TRANSIENT_ERRORS.test(firstErr.message)) {
                            deps.log(`Media download failed (transient: ${firstErr.message}), retrying in 2s...`, 'WARN');
                            await new Promise(r => setTimeout(r, 2000));
                            saved = await downloadFn();
                        } else {
                            throw firstErr;
                        }
                    }
```

- [ ] **Step 6: Update sendMessage calls that use msg.message_id for reply-to**

Find all `msg.message_id` references in handleMessage and replace with `messageId`:

- `await deps.sendMessage(chatId, ..., msg.message_id)` → `await deps.sendMessage(chatId, ..., messageId)`
- The `[[reply_to_current]]` section (~line 600): `replyToId = msg.message_id` → `replyToId = messageId`
- Final sendMessage (~line 603): `await deps.sendMessage(chatId, response, replyToId || msg.message_id)` → `await deps.sendMessage(chatId, response, replyToId || messageId)`

- [ ] **Step 7: Remove `extractMedia` from deps**

Since media extraction now happens in the normalization layer (main.js), `handleMessage` no longer calls `deps.extractMedia(msg)`. The `extractMedia` reference can be removed from the deps interface in `initMessageHandler`. Find where `extractMedia` is passed in deps and verify it's no longer used inside `handleMessage`.

Note: `extractMedia` is still needed by main.js for `normalizeTelegramMessage()`, so it stays exported from telegram.js.

- [ ] **Step 8: Update `handleReactionUpdate` to use normalized shape (optional)**

Find `handleReactionUpdate(reaction)` (~line 620). This receives raw Telegram reaction objects. For now, keep it as-is — reactions are Telegram-specific and will be abstracted in PR 3. The raw shape works fine.

- [ ] **Step 9: Syntax check**
```bash
node --check app/src/main/assets/nodejs-project/message-handler.js && echo "OK"
```

- [ ] **Step 10: Commit**
```bash
git add app/src/main/assets/nodejs-project/message-handler.js
git commit -m "refactor: handleMessage() accepts normalized message shape — channel-agnostic

Co-Authored-By: Claude Opus 4.6 <noreply@anthropic.com>"
```

---

## Task 3: Add `downloadFileByUrl()` to telegram.js

**Files:**
- Modify: `app/src/main/assets/nodejs-project/telegram.js`

- [ ] **Step 1: Add downloadFileByUrl function**

Add after `downloadTelegramFile` function:

```javascript
/**
 * Download a file from a direct URL (for non-Telegram channels like Discord).
 * Saves to the same media/inbound/ directory as Telegram downloads.
 * @param {string} url - Direct download URL
 * @param {string} fileName - Filename to save as
 * @returns {{ localPath, localName, size }}
 */
async function downloadFileByUrl(url, fileName) {
    const safeName = (fileName || `file_${Date.now()}`).replace(/[^a-zA-Z0-9._-]/g, '_').slice(0, 120);
    const uniqueName = `${Date.now()}_${safeName}`;
    const mediaDir = path.join(workDir, 'media', 'inbound');
    if (!fs.existsSync(mediaDir)) fs.mkdirSync(mediaDir, { recursive: true });
    const localPath = path.join(mediaDir, uniqueName);

    const { httpRequest: httpReq } = require('./http');
    const parsedUrl = new URL(url);
    const res = await httpReq({
        hostname: parsedUrl.hostname,
        port: parsedUrl.port || undefined,
        path: parsedUrl.pathname + parsedUrl.search,
        method: 'GET',
        protocol: parsedUrl.protocol,
        headers: { 'User-Agent': 'SeekerClaw/1.0' },
    });

    if (res.status < 200 || res.status >= 300) {
        throw new Error(`Download failed: HTTP ${res.status}`);
    }

    const data = typeof res.data === 'string' ? Buffer.from(res.data) : Buffer.from(JSON.stringify(res.data));
    fs.writeFileSync(localPath, data);
    const size = fs.statSync(localPath).size;

    return { localPath, localName: uniqueName, size };
}
```

- [ ] **Step 2: Add to exports**

Add `downloadFileByUrl` to the module.exports object:
```javascript
    downloadFileByUrl,
```

- [ ] **Step 3: Syntax check**
```bash
node --check app/src/main/assets/nodejs-project/telegram.js && echo "OK"
```

- [ ] **Step 4: Commit**
```bash
git add app/src/main/assets/nodejs-project/telegram.js
git commit -m "feat: add downloadFileByUrl() for direct-URL media downloads

Co-Authored-By: Claude Opus 4.6 <noreply@anthropic.com>"
```

---

## Task 4: Wire `downloadFileByUrl` into message-handler deps

**Files:**
- Modify: `app/src/main/assets/nodejs-project/main.js`

- [ ] **Step 1: Import downloadFileByUrl**

Add `downloadFileByUrl` to the telegram.js import block in main.js:
```javascript
const {
    telegram,
    sendMessage, sendTyping,
    downloadTelegramFile, downloadFileByUrl, extractMedia,
    // ... other imports
} = require('./telegram');
```

- [ ] **Step 2: Pass downloadFileByUrl to message-handler init**

Find where `initMessageHandler` is called and add `downloadFileByUrl` to the deps object:
```javascript
    downloadFileByUrl,
```

- [ ] **Step 3: Syntax check**
```bash
node --check app/src/main/assets/nodejs-project/main.js && echo "OK"
```

- [ ] **Step 4: Full syntax check all modified files**
```bash
cd app/src/main/assets/nodejs-project
node --check main.js && node --check message-handler.js && node --check telegram.js && echo "ALL OK"
```

- [ ] **Step 5: Commit**
```bash
git add app/src/main/assets/nodejs-project/main.js
git commit -m "feat: wire downloadFileByUrl into message-handler deps

Co-Authored-By: Claude Opus 4.6 <noreply@anthropic.com>"
```

---

## Task 5: Smoke test

- [ ] **Step 1: Syntax check all modified files**
```bash
cd app/src/main/assets/nodejs-project
node --check main.js && node --check message-handler.js && node --check telegram.js && echo "ALL OK"
```

- [ ] **Step 2: Grep for remaining raw Telegram field accesses in handleMessage**
```bash
# These should NOT appear inside handleMessage() anymore:
grep -n "msg\.chat\|msg\.from\|msg\.text\|msg\.caption\|msg\.message_id\|msg\.reply_to\|msg\.external_reply\|msg\.quote\|msg\.document\|msg\.photo\|msg\.video\|msg\.audio\|msg\.voice" app/src/main/assets/nodejs-project/message-handler.js
```
Expected: zero results inside `handleMessage()`. Any hits outside (like `handleReactionUpdate`) are OK for now.

- [ ] **Step 3: Verify normalizeTelegramMessage is used**
```bash
grep -n "normalizeTelegramMessage\|enqueueMessage" app/src/main/assets/nodejs-project/main.js | head -10
```

- [ ] **Step 4: Device test**
Build APK, install, verify:
1. App launches, agent starts
2. Send text message → agent responds
3. Send image → agent processes it (vision or file note)
4. Reply to agent message → agent sees reply context
5. /status command works
6. Heartbeat fires normally

---

## Summary

| Task | Files | What |
|------|-------|------|
| 1 | `main.js` | `normalizeTelegramMessage()` + update poll loop callers |
| 2 | `message-handler.js` | Refactor `handleMessage()` to normalized shape |
| 3 | `telegram.js` | Add `downloadFileByUrl()` for direct-URL downloads |
| 4 | `main.js` | Wire `downloadFileByUrl` into deps |
| 5 | All | Smoke test + device test |
