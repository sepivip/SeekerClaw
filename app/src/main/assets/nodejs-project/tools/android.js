// tools/android.js — all android_* tool handlers

const fs = require('fs');
const path = require('path');

const {
    workDir, log,
} = require('../config');

const { androidBridgeCall } = require('../bridge');

const { visionAnalyzeImage } = require('../ai');

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
        description: 'Send an SMS message. Requires SEND_SMS permission. ALWAYS confirm with user before sending.',
        input_schema: {
            type: 'object',
            properties: {
                phone: { type: 'string', description: 'Phone number to send to' },
                message: { type: 'string', description: 'Message text' }
            },
            required: ['phone', 'message']
        }
    },
    {
        name: 'android_call',
        description: 'Make a phone call. Requires CALL_PHONE permission. ALWAYS confirm with user before calling.',
        input_schema: {
            type: 'object',
            properties: {
                phone: { type: 'string', description: 'Phone number to call' }
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
        return await androidBridgeCall('/sms', {
            phone: input.phone,
            message: input.message
        });
    },

    async android_call(input, chatId) {
        return await androidBridgeCall('/call', { phone: input.phone });
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
        if (result && result.success && result.path && fs.existsSync(result.path)) {
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
        return result;
    },

    async android_camera_check(input, chatId) {
        const lens = input.lens === 'front' ? 'front' : 'back';
        const capture = await androidBridgeCall('/camera/capture', { lens }, 45000);
        if (!capture || capture.error) {
            return { error: capture?.error || 'Camera capture failed' };
        }

        const imagePath = capture.path;
        if (!imagePath || !fs.existsSync(imagePath)) {
            return { error: 'Captured image file not found on device' };
        }

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
            path: imagePath,
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

module.exports = { tools, handlers };
