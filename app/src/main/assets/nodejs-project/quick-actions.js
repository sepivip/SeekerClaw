// Quick Actions — Telegram preset task buttons (#279)
// Self-contained module: button map, command handler, callback router.
// Gated on CHANNEL === 'telegram' — Discord v1 does not support inline keyboards.

const { CHANNEL } = require('./config');

// Single source of truth — button definitions drive both the keyboard and the callback map.
const BUTTONS = [
    [
        { text: '🔋 Status',     key: 'quick:status',    message: 'Quick status check — battery, storage, uptime, last message time' },
        { text: '💰 Portfolio',  key: 'quick:portfolio', message: 'Check my Solana portfolio — balances and total USD value' },
        { text: '📊 SOL Price',  key: 'quick:sol_price', message: 'What\'s the current SOL price?' },
    ],
    [
        { text: '📰 News Brief', key: 'quick:news',   message: 'Give me a 3-sentence summary of today\'s top crypto/tech news' },
        { text: '⏰ My Tasks',   key: 'quick:tasks',  message: 'List my scheduled tasks and any pending TODOs' },
        { text: '🧠 Memory',     key: 'quick:memory', message: 'What do you remember about me? Summarize key facts.' },
    ],
];

// Derived: callback_data → message lookup
const QUICK_ACTIONS = {};
for (const row of BUTTONS) {
    for (const btn of row) {
        QUICK_ACTIONS[btn.key] = btn.message;
    }
}

// Derived: Telegram inline keyboard
const KEYBOARD = {
    inline_keyboard: BUTTONS.map(row =>
        row.map(btn => ({ text: btn.text, callback_data: btn.key }))
    ),
};

/**
 * Handle /quick command — sends inline keyboard to chatId.
 * @param {number|string} chatId
 * @param {Function} telegramFn - the telegram() helper from telegram.js
 * @returns {Promise<void>}
 */
async function handleQuickCommand(chatId, telegramFn) {
    if (CHANNEL !== 'telegram') return null;
    await telegramFn('sendMessage', {
        chat_id: chatId,
        text: '⚡ Quick Actions — tap to run:',
        reply_markup: KEYBOARD,
    });
}

/**
 * Handle a quick action callback query.
 * Removes the inline keyboard (keeps message for status reactions),
 * returns the mapped user message text.
 * Returns null if callback_data is not a quick action.
 *
 * @param {object} cb - Telegram callback_query object
 * @param {Function} telegramFn - the telegram() helper
 * @returns {Promise<string|null>} mapped message text, or null if not a quick action
 */
async function handleQuickCallback(cb, telegramFn) {
    if (CHANNEL !== 'telegram') return null;
    const data = (cb.data || '').trim();
    const mappedText = QUICK_ACTIONS[data];
    if (!mappedText) return null;

    // Remove inline keyboard but keep the message — the synthetic message
    // carries this message_id for status reactions during the agent turn.
    const chatId = cb.message?.chat?.id;
    const messageId = cb.message?.message_id;
    if (chatId && messageId) {
        telegramFn('editMessageReplyMarkup', {
            chat_id: chatId,
            message_id: messageId,
            reply_markup: { inline_keyboard: [] },
        }).catch(() => {});
    }

    return mappedText;
}

module.exports = { QUICK_ACTIONS, handleQuickCommand, handleQuickCallback };
