// tools/android.js — all android_* tool handlers

const fs = require('fs');
const path = require('path');

const {
    workDir, log,
} = require('../config');

const { androidBridgeCall } = require('../bridge');

const { visionAnalyzeImage } = require('../ai');

// Moves a camera capture from the app's capture directory into workspace/media/inbound/ and
// rewrites `result.path` to the workspace-relative path. Best effort: on failure the result keeps
// the original path and a WARN is logged.
function moveCaptureIntoWorkspace(result) {
    if (!(result && result.success && result.path && fs.existsSync(result.path))) return;
    try {
        const filename = path.basename(result.path);
        const inboundDir = path.join(workDir, 'media', 'inbound');
        fs.mkdirSync(inboundDir, { recursive: true });
        const dest = path.join(inboundDir, filename);
        try {
            fs.renameSync(result.path, dest);
        } catch (e) {
            // Cross-filesystem fallback: copy + delete
            fs.copyFileSync(result.path, dest);
            try { fs.unlinkSync(result.path); } catch (_) { /* ignore cleanup */ }
        }
        result.path = 'media/inbound/' + filename;
    } catch (e) {
        log(`Camera move to workspace failed: ${e.message}`, 'WARN');
    }
}

// BAT-1409 P1-H: the bridge puts a message or call draft in the notifications and reports exactly
// one outcome (AndroidBridge draftResponse; 429 carries code "rate_limited"). The wording is fixed
// here, so the agent never says "sent", "opened", "calling" or "called".
const DRAFT_POSTED = {
    sms: 'I\'ve put the message in the notifications on the phone running SeekerClaw — tap it to open your SMS app and send.',
    call: 'I\'ve put the call in the notifications on the phone running SeekerClaw — tap it to dial.',
};
const DRAFT_TURN_ON = 'Turn them on in SeekerClaw → Settings → Notifications, then ask again.';

// Drafts are made only in a live chat. Scheduled tasks (`cron:*`) and heartbeat probes could never
// text or call before (their confirmation step always refused), and they still can't: nobody is
// there to have asked for the draft that would appear on the phone.
function isUnattendedTurn(chatId) {
    return typeof chatId === 'string' && (chatId.startsWith('cron:') || chatId === '__heartbeat__');
}

function refuseUnattended(kind, chatId) {
    const ctx = chatId.startsWith('cron:') ? 'a scheduled task' : 'a heartbeat probe';
    log(`[Drafts] Refused a ${kind} draft in ${ctx} (${chatId})`, 'WARN');
    return draftResult(kind, { error: 'unattended', outcome: 'unattended' });
}

function draftResult(kind, res) {
    const none = `No ${kind === 'sms' ? 'message' : 'call'} draft was created`;
    const outcome = res && (res.outcome || (res.code === 'rate_limited' ? 'rate_limited' : undefined));
    const refused = (message) => ({ error: outcome, outcome, message });
    switch (outcome) {
        case 'posted':
            return { success: true, outcome, message: DRAFT_POSTED[kind] };
        case 'notifications_disabled':
            return refused(`${none}: SeekerClaw's notifications are off on the phone running it. ${DRAFT_TURN_ON}`);
        case 'notifications_paused':
            return refused(`${none}: SeekerClaw is paused on the phone running it (for example by Digital Wellbeing or a focus mode), so its notifications are held back. Unpause it, check SeekerClaw → Settings → Notifications, then ask again.`);
        case 'channel_blocked':
            return refused(`${none}: the "Message & call drafts" notifications are blocked on the phone running SeekerClaw. ${DRAFT_TURN_ON}`);
        case 'no_handler':
            return refused(`${none}: the phone running SeekerClaw has no ${kind === 'sms' ? 'SMS app' : 'phone dialer'} to open it.`);
        case 'invalid_recipient':
            return refused(`${none}: that number can't be used. Give one phone number — digits with an optional leading + (no letters, *, #, pauses or several recipients).`);
        case 'rate_limited':
            return refused(`${none}: too many drafts in a short time. Wait a minute, then ask again.`);
        case 'unattended':
            return refused(`${none}: messages and calls are only drafted when the user asks in chat, not in a scheduled task or a heartbeat check.`);
        default: {
            // Not a draft outcome: the bridge was unreachable or rejected the request.
            const error = (res && res.error) || 'draft_failed';
            return { error, message: `${none}: ${error}.` };
        }
    }
}

const tools = [
    {
        name: 'android_battery',
        description: 'Get device battery level, charging status, and charge type.',
        input_schema: {
            type: 'object',
            properties: {}
        }
    },
    {
        name: 'android_storage',
        description: 'Get device storage information (total, available, used).',
        input_schema: {
            type: 'object',
            properties: {}
        }
    },
    {
        name: 'android_clipboard_get',
        description: 'Get current clipboard content.',
        input_schema: {
            type: 'object',
            properties: {}
        }
    },
    {
        name: 'android_clipboard_set',
        description: 'Set clipboard content.',
        input_schema: {
            type: 'object',
            properties: {
                content: { type: 'string', description: 'Text to copy to clipboard' }
            },
            required: ['content']
        }
    },
    {
        name: 'android_contacts_search',
        description: 'Search contacts by name. Requires READ_CONTACTS permission.',
        input_schema: {
            type: 'object',
            properties: {
                query: { type: 'string', description: 'Name to search for' },
                limit: { type: 'number', description: 'Max results (default 10)' }
            },
            required: ['query']
        }
    },
    {
        name: 'android_sms',
        description: 'Draft a text message (SMS) for the user to send. Nothing is sent by this tool: it puts a draft in the notifications on the phone running SeekerClaw, and the user taps it to open their SMS app, then presses Send. No chat confirmation (the user confirms on the phone); 1 per 60s; not available in scheduled tasks. Needs SeekerClaw\'s notifications on. Returns an `outcome` and a `message` to relay — never say the SMS was "sent".',
        input_schema: {
            type: 'object',
            properties: {
                phone: { type: 'string', description: 'One phone number: digits with an optional leading +, e.g. +15551234567 (spaces, dashes, dots and brackets are fine). No letters, *, #, pauses or several recipients.' },
                message: { type: 'string', description: 'Message text' }
            },
            required: ['phone', 'message']
        }
    },
    {
        name: 'android_call',
        description: 'Draft a phone call for the user to dial. Nothing is dialled by this tool: it puts a draft in the notifications on the phone running SeekerClaw, and the user taps it to open their dialer with the number filled in, then presses Dial. No chat confirmation (the user confirms on the phone); 1 per 60s; not available in scheduled tasks. Needs SeekerClaw\'s notifications on. Returns an `outcome` and a `message` to relay — never say "calling" or "called".',
        input_schema: {
            type: 'object',
            properties: {
                phone: { type: 'string', description: 'One phone number: digits with an optional leading +, e.g. +15551234567 (spaces, dashes, dots and brackets are fine). No letters, *, #, pauses or USSD codes.' }
            },
            required: ['phone']
        }
    },
    {
        name: 'android_location',
        description: 'Get current GPS location. Requires ACCESS_FINE_LOCATION permission.',
        input_schema: {
            type: 'object',
            properties: {}
        }
    },
    {
        name: 'android_tts',
        description: 'Speak text out loud using device text-to-speech.',
        input_schema: {
            type: 'object',
            properties: {
                text: { type: 'string', description: 'Text to speak' },
                speed: { type: 'number', description: 'Speech rate 0.5-2.0 (default 1.0)' },
                pitch: { type: 'number', description: 'Pitch 0.5-2.0 (default 1.0)' }
            },
            required: ['text']
        }
    },
    {
        name: 'android_camera_capture',
        description: 'Capture a photo from the device camera. Requires CAMERA permission. Returns a workspace-relative path (media/inbound/) that can be used directly with send_file.',
        input_schema: {
            type: 'object',
            properties: {
                lens: { type: 'string', description: 'Camera lens: "back" (default) or "front"' }
            }
        }
    },
    {
        name: 'android_camera_check',
        description: 'Capture a photo and analyze it with Claude vision. Use only when the user explicitly asks what the camera sees (e.g. "check my dog").',
        input_schema: {
            type: 'object',
            properties: {
                prompt: { type: 'string', description: 'What to check in the image. Example: "What is my dog doing?"' },
                lens: { type: 'string', description: 'Camera lens: "back" (default) or "front"' },
                max_tokens: { type: 'number', description: 'Optional output token cap for vision response (default 400)' }
            }
        }
    },
    {
        name: 'android_apps_list',
        description: 'List installed apps that can be launched.',
        input_schema: {
            type: 'object',
            properties: {}
        }
    },
    {
        name: 'android_apps_launch',
        description: 'Launch an app by package name.',
        input_schema: {
            type: 'object',
            properties: {
                package: { type: 'string', description: 'Package name (e.g., com.android.chrome)' }
            },
            required: ['package']
        }
    },
];

const handlers = {
    async android_battery(input, chatId) {
        return await androidBridgeCall('/battery');
    },

    async android_storage(input, chatId) {
        return await androidBridgeCall('/storage');
    },

    async android_clipboard_get(input, chatId) {
        return await androidBridgeCall('/clipboard/get');
    },

    async android_clipboard_set(input, chatId) {
        return await androidBridgeCall('/clipboard/set', { content: input.content });
    },

    async android_contacts_search(input, chatId) {
        return await androidBridgeCall('/contacts/search', {
            query: input.query,
            limit: input.limit || 10
        });
    },

    async android_sms(input, chatId) {
        if (isUnattendedTurn(chatId)) return refuseUnattended('sms', chatId);
        return draftResult('sms', await androidBridgeCall('/sms', {
            phone: input.phone,
            message: input.message
        }));
    },

    async android_call(input, chatId) {
        if (isUnattendedTurn(chatId)) return refuseUnattended('call', chatId);
        return draftResult('call', await androidBridgeCall('/call', { phone: input.phone }));
    },

    async android_location(input, chatId) {
        return await androidBridgeCall('/location');
    },

    async android_tts(input, chatId) {
        return await androidBridgeCall('/tts', {
            text: input.text,
            speed: input.speed || 1.0,
            pitch: input.pitch || 1.0
        });
    },

    async android_camera_capture(input, chatId) {
        const lens = input.lens === 'front' ? 'front' : 'back';
        const result = await androidBridgeCall('/camera/capture', { lens }, 45000);
        // Move capture into workspace so telegram_send_file can access it
        moveCaptureIntoWorkspace(result);
        return result;
    },

    async android_camera_check(input, chatId) {
        const lens = input.lens === 'front' ? 'front' : 'back';
        const capture = await androidBridgeCall('/camera/capture', { lens }, 45000);
        if (!capture || capture.error) {
            return { error: capture?.error || 'Camera capture failed' };
        }

        if (!capture.path || !fs.existsSync(capture.path)) {
            return { error: 'Captured image file not found on device' };
        }
        // BAT-1409 P1-E: like android_camera_capture, the photo moves into media/inbound/, so the
        // returned path is a workspace path the file tools accept.
        moveCaptureIntoWorkspace(capture);
        const imagePath = path.isAbsolute(capture.path) ? capture.path : path.join(workDir, capture.path);

        let imageBase64;
        try {
            imageBase64 = fs.readFileSync(imagePath).toString('base64');
        } catch (e) {
            return { error: `Failed to read captured image: ${e.message}` };
        }

        const vision = await visionAnalyzeImage(
            imageBase64,
            input.prompt || 'What is happening in this image? Keep the answer concise and practical.',
            input.max_tokens || 400
        );

        if (vision.error) {
            return { error: vision.error };
        }

        return {
            success: true,
            lens: capture.lens || lens,
            capturedAt: capture.capturedAt || null,
            path: capture.path,
            analysis: vision.text
        };
    },

    async android_apps_list(input, chatId) {
        return await androidBridgeCall('/apps/list');
    },

    async android_apps_launch(input, chatId) {
        return await androidBridgeCall('/apps/launch', { package: input.package });
    },
};

module.exports = { tools, handlers, draftResult };
