// Quick Actions — Telegram preset task buttons (#279)
// Self-contained module: button map, command handler, callback router.

const QUICK_ACTIONS = {
    'quick:status':    'Quick status check — battery, storage, uptime, last message time',
    'quick:portfolio': 'Check my Solana portfolio — balances and total USD value',
    'quick:sol_price': "What's the current SOL price?",
    'quick:news':      "Give me a 3-sentence summary of today's top crypto/tech news",
    'quick:tasks':     'List my scheduled tasks and any pending TODOs',
    'quick:memory':    'What do you remember about me? Summarize key facts.',
};

const KEYBOARD = {
    inline_keyboard: [
        [
            { text: '🔋 Status',    callback_data: 'quick:status' },
            { text: '💰 Portfolio', callback_data: 'quick:portfolio' },
            { text: '📊 SOL Price', callback_data: 'quick:sol_price' },
        ],
        [
            { text: '📰 News Brief', callback_data: 'quick:news' },
            { text: '⏰ My Tasks',   callback_data: 'quick:tasks' },
            { text: '🧠 Memory',     callback_data: 'quick:memory' },
        ],
    ],
};

/**
 * Handle /quick command — sends inline keyboard to chatId.
 * @param {number|string} chatId
 * @param {Function} telegramFn - the telegram() helper from telegram.js
 * @returns {Promise<void>}
 */
async function handleQuickCommand(chatId, telegramFn) {
    await telegramFn('sendMessage', {
        chat_id: chatId,
        text: '⚡ Quick Actions — tap to run:',
        reply_markup: KEYBOARD,
    });
}

/**
 * Handle a quick action callback query.
 * Deletes the keyboard message, returns the mapped user message text.
 * Returns null if callback_data is not a quick action.
 *
 * @param {object} cb - Telegram callback_query object
 * @param {Function} telegramFn - the telegram() helper
 * @returns {Promise<string|null>} mapped message text, or null if not a quick action
 */
async function handleQuickCallback(cb, telegramFn) {
    const data = (cb.data || '').trim();
    const mappedText = QUICK_ACTIONS[data];
    if (!mappedText) return null;

    // Delete the inline keyboard message (clean UX)
    const chatId = cb.message?.chat?.id;
    const messageId = cb.message?.message_id;
    if (chatId && messageId) {
        telegramFn('deleteMessage', {
            chat_id: chatId,
            message_id: messageId,
        }).catch(() => {
            // Silently ignore — message may already be deleted or too old
        });
    }

    return mappedText;
}

module.exports = { QUICK_ACTIONS, handleQuickCommand, handleQuickCallback };
