// Test the OpenClaw draft-stream pattern (sendMessage + editMessageText with
// coalescing throttler) against a real Telegram bot.
//
// This is a faithful port of the relevant pieces of:
//   openclaw-reference/src/channels/draft-stream-loop.ts
//   openclaw-reference/extensions/telegram/src/draft-stream.ts
//
// Usage:
//   node test-telegram-draft.js getchat   — print chat_id from getUpdates
//   node test-telegram-draft.js           — run scenarios 1..4 sequentially
//   node test-telegram-draft.js basic     — scenario 1 only
//   node test-telegram-draft.js html      — scenario 4 only

const https = require('https');
const { loadEnv } = require('./lib');

loadEnv();

const TOKEN = process.env.TELEGRAM_BOT_TOKEN;
if (!TOKEN) {
    console.error('TELEGRAM_BOT_TOKEN missing in testing/.env');
    process.exit(1);
}

const TELEGRAM_TEXT_LIMIT = 4096;
const DEFAULT_THROTTLE_MS = 1000;

// ---- Telegram HTTP helper ---------------------------------------
function tg(method, body = {}) {
    const payload = JSON.stringify(body);
    return new Promise((resolve, reject) => {
        const req = https.request({
            hostname: 'api.telegram.org',
            path: `/bot${TOKEN}/${method}`,
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'Content-Length': Buffer.byteLength(payload),
            },
        }, (res) => {
            let data = '';
            res.on('data', (chunk) => data += chunk);
            res.on('end', () => {
                let parsed;
                try { parsed = JSON.parse(data); } catch { parsed = { ok: false, raw: data }; }
                resolve({ status: res.statusCode, body: parsed });
            });
        });
        req.on('error', reject);
        req.write(payload);
        req.end();
    });
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ---- chat_id discovery ------------------------------------------
async function discoverChatId() {
    const r = await tg('getUpdates');
    if (!r.body.ok) {
        console.error('getUpdates failed:', r.body);
        process.exit(1);
    }
    const updates = r.body.result || [];
    const ids = [...new Set(updates.map((u) => u.message?.chat?.id).filter(Boolean))];
    if (!ids.length) {
        console.error('No updates yet. Send any message to your bot first.');
        process.exit(1);
    }
    return ids[0];
}

// ---- Coalescing throttle loop (port of draft-stream-loop.ts) -----
function createDraftStreamLoop({ throttleMs, isStopped, sendOrEditStreamMessage }) {
    let lastSentAt = 0;
    let pendingText = '';
    let inFlight;
    let timer;

    const flush = async () => {
        if (timer) { clearTimeout(timer); timer = undefined; }
        while (!isStopped()) {
            if (inFlight) { await inFlight; continue; }
            const text = pendingText;
            if (!text.trim()) { pendingText = ''; return; }
            pendingText = '';
            const current = sendOrEditStreamMessage(text).finally(() => {
                if (inFlight === current) inFlight = undefined;
            });
            inFlight = current;
            const sent = await current;
            if (sent === false) { pendingText = text; return; }
            lastSentAt = Date.now();
            if (!pendingText) return;
        }
    };

    const schedule = () => {
        if (timer) return;
        const delay = Math.max(0, throttleMs - (Date.now() - lastSentAt));
        timer = setTimeout(() => { void flush(); }, delay);
    };

    return {
        update: (text) => {
            if (isStopped()) return;
            pendingText = text;
            if (inFlight) { schedule(); return; }
            if (!timer && Date.now() - lastSentAt >= throttleMs) { void flush(); return; }
            schedule();
        },
        flush,
        stop: () => { pendingText = ''; if (timer) { clearTimeout(timer); timer = undefined; } },
    };
}

// ---- Telegram draft stream (port of draft-stream.ts essentials) --
function createTelegramDraftStream({
    chatId,
    throttleMs = DEFAULT_THROTTLE_MS,
    minInitialChars = 0,
    parseMode,           // 'HTML' or undefined
    log = () => {},
    warn = console.warn,
}) {
    const state = { stopped: false };
    let messageId;
    let lastSentText = '';
    let editCount = 0;
    let sendCount = 0;
    let throttleHits = 0;

    const sendOrEdit = async (text) => {
        if (state.stopped) return false;
        const trimmed = text.trimEnd();
        if (!trimmed) return false;
        if (trimmed.length > TELEGRAM_TEXT_LIMIT) {
            warn(`text length ${trimmed.length} > ${TELEGRAM_TEXT_LIMIT}; stopping`);
            state.stopped = true;
            return false;
        }
        if (trimmed === lastSentText) return true;

        // Initial debounce: hold off the first sendMessage until threshold.
        if (messageId === undefined && minInitialChars > 0 && trimmed.length < minInitialChars) {
            return false;
        }

        lastSentText = trimmed;
        const opts = parseMode ? { parse_mode: parseMode } : undefined;

        if (messageId === undefined) {
            const r = await tg('sendMessage', { chat_id: chatId, text: trimmed, ...(opts || {}) });
            if (!r.body.ok) {
                if (r.body.error_code === 429) throttleHits++;
                warn(`sendMessage failed: ${r.body.description || r.status}`);
                lastSentText = '';
                return false;
            }
            messageId = r.body.result.message_id;
            sendCount++;
            log(`  → sendMessage ok, message_id=${messageId}, chars=${trimmed.length}`);
            return true;
        }

        const r = await tg('editMessageText', {
            chat_id: chatId, message_id: messageId, text: trimmed, ...(opts || {}),
        });
        if (!r.body.ok) {
            // "message is not modified" is benign — server already has same text
            if (/not modified/i.test(r.body.description || '')) return true;
            if (r.body.error_code === 429) throttleHits++;
            warn(`editMessageText failed: ${r.body.description || r.status}`);
            lastSentText = '';
            return false;
        }
        editCount++;
        return true;
    };

    const loop = createDraftStreamLoop({
        throttleMs,
        isStopped: () => state.stopped,
        sendOrEditStreamMessage: sendOrEdit,
    });

    return {
        update: loop.update,
        flush: loop.flush,
        stop: () => { state.stopped = true; loop.stop(); },
        messageId: () => messageId,
        stats: () => ({ sendCount, editCount, throttleHits }),
    };
}

// ---- Token feeder: simulates SSE token rate from an LLM ----------
async function feedTokens(stream, fullText, intervalMs) {
    let buf = '';
    for (const ch of fullText) {
        buf += ch;
        stream.update(buf);
        await sleep(intervalMs);
    }
    await stream.flush();
}

// ---- Scenarios ---------------------------------------------------
async function scenario1_realistic(chatId) {
    console.log('\n=== Scenario 1: realistic LLM stream (1000ms throttle, 200-char min initial) ===');
    const text = `OK so let me think about this carefully. The streaming approach OpenClaw uses is actually quite elegant — instead of relying on Telegram's sendMessageDraft (which is private-chat-only and rate-limited the same as sendMessage), they coalesce updates client-side. Each token from the LLM overwrites pendingText, and a 1-second throttle ensures we never spam Telegram. The first sendMessage waits until we have at least 200 characters buffered, so the user doesn't get a push notification for "I" or "OK,". Once the message is live, every subsequent edit lands in the same bubble. No animation tricks — just a clean, predictable update cadence that matches what users expect from modern chat UIs.`;
    const start = Date.now();
    const stream = createTelegramDraftStream({
        chatId, throttleMs: 1000, minInitialChars: 200, log: console.log,
    });
    await feedTokens(stream, text, 30);  // simulate 33 tokens/sec
    const elapsed = Date.now() - start;
    const stats = stream.stats();
    console.log(`  done in ${elapsed}ms — sends=${stats.sendCount}, edits=${stats.editCount}, 429s=${stats.throttleHits}`);
}

async function scenario2_short(chatId) {
    console.log('\n=== Scenario 2: short reply (under minInitialChars threshold) ===');
    const text = `Yes.`;
    const stream = createTelegramDraftStream({
        chatId, throttleMs: 1000, minInitialChars: 200, log: console.log,
    });
    await feedTokens(stream, text, 30);
    // With threshold=200 and text="Yes." (4 chars), no sendMessage should fire.
    // Caller would normally fall back to a regular sendMessage on stream end.
    if (stream.messageId() === undefined) {
        console.log('  no preview sent (threshold not met) — caller would now sendMessage normally');
        await tg('sendMessage', { chat_id: chatId, text });
    }
    const stats = stream.stats();
    console.log(`  sends=${stats.sendCount}, edits=${stats.editCount}, 429s=${stats.throttleHits}`);
}

async function scenario3_burst(chatId) {
    console.log('\n=== Scenario 3: burst (1000 char paragraph fed in 200ms) ===');
    const text = 'word '.repeat(200).trimEnd();  // ~1000 chars
    const start = Date.now();
    const stream = createTelegramDraftStream({
        chatId, throttleMs: 1000, minInitialChars: 200, log: console.log,
    });
    await feedTokens(stream, text, 1);  // 1ms ticks = aggressive
    const elapsed = Date.now() - start;
    const stats = stream.stats();
    console.log(`  done in ${elapsed}ms — sends=${stats.sendCount}, edits=${stats.editCount}, 429s=${stats.throttleHits}`);
}

async function scenario4_html(chatId) {
    console.log('\n=== Scenario 4: HTML parse_mode with balanced flushes ===');
    // Each "stage" represents a moment when the renderer has produced
    // balanced HTML. Simulates a markdown→HTML renderer that closes tags
    // before flushing.
    const stages = [
        'Plain text first.',
        'Plain text first. <b>Bold word</b> follows.',
        'Plain text first. <b>Bold word</b> follows. And <i>italic</i> after.',
        'Plain text first. <b>Bold word</b> follows. And <i>italic</i> after. Done.',
    ];
    const stream = createTelegramDraftStream({
        chatId, throttleMs: 1000, minInitialChars: 0, parseMode: 'HTML', log: console.log,
    });
    for (const s of stages) {
        stream.update(s);
        await sleep(1100);  // > throttleMs so each stage triggers send/edit
    }
    await stream.flush();
    const stats = stream.stats();
    console.log(`  sends=${stats.sendCount}, edits=${stats.editCount}, 429s=${stats.throttleHits}`);
}

// ---- Main --------------------------------------------------------
(async () => {
    const cmd = process.argv[2] || 'all';
    if (cmd === 'getchat') { console.log(await discoverChatId()); return; }

    const chatId = process.env.TELEGRAM_TEST_CHAT_ID
        ? Number(process.env.TELEGRAM_TEST_CHAT_ID)
        : await discoverChatId();
    console.log(`Using chat_id=${chatId}`);
    const me = await tg('getMe');
    if (!me.body.ok) { console.error('getMe failed:', me.body); process.exit(1); }
    console.log(`Bot: @${me.body.result.username}`);

    if (cmd === 'basic') return scenario1_realistic(chatId);
    if (cmd === 'html') return scenario4_html(chatId);
    if (cmd === 'short') return scenario2_short(chatId);
    if (cmd === 'burst') return scenario3_burst(chatId);

    await scenario1_realistic(chatId);
    await sleep(2500);
    await scenario2_short(chatId);
    await sleep(2500);
    await scenario3_burst(chatId);
    await sleep(2500);
    await scenario4_html(chatId);

    console.log('\nDone. Check the chat for visual results.');
})().catch((e) => {
    console.error('Fatal:', e);
    process.exit(1);
});
