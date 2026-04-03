// channel.js — Thin router for channel abstraction
// Picks telegram or discord at init(), forwards all calls.
// Adding a new channel = implement the interface in a new file, add to init().

const { CHANNEL, log } = require('./config');

let impl = null;

function assertInit() {
    if (!impl) throw new Error('channel.js: init() must be called before use');
}

function init() {
    if (CHANNEL === 'discord') {
        impl = require('./discord');
    } else {
        impl = require('./telegram');
    }
    log(`[Channel] Initialized: ${CHANNEL}`, 'INFO');
}

module.exports = {
    init,
    start(onMessage, onReaction) { assertInit(); return impl.start(onMessage, onReaction); },
    stop() { assertInit(); return impl.stop(); },
    sendMessage(chatId, text, replyTo) { assertInit(); return impl.sendMessage(chatId, text, replyTo); },
    sendTyping(chatId) { assertInit(); return impl.sendTyping(chatId); },
    sendFile(chatId, filePath, caption) { assertInit(); return impl.sendFile(chatId, filePath, caption); },
    editMessage(chatId, messageId, text, replyMarkup) { assertInit(); return impl.editMessage(chatId, messageId, text, replyMarkup); },
    deleteMessage(chatId, messageId) { assertInit(); return impl.deleteMessage(chatId, messageId); },
    getOwnerChatId() { assertInit(); return impl.getOwnerChatId(); },
    createStatusReactionController(chatId, messageId) {
        assertInit();
        return impl.createStatusReactionController(chatId, messageId);
    },
};
