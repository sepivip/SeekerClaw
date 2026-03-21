'use strict';

const crypto = require('crypto');

const LOOP_WARN_THRESHOLD = 3;
const LOOP_BREAK_THRESHOLD = 5;
const WINDOW_SIZE = 10;

// Per-chatId state to prevent cross-chat interference
const _chatState = new Map();

function _getState(chatId) {
    if (!_chatState.has(chatId)) {
        _chatState.set(chatId, { hashWindow: [], hashCounts: new Map() });
    }
    return _chatState.get(chatId);
}

function reset(chatId) {
    _chatState.delete(chatId);
}

function stableStringify(obj) {
    if (obj === null || typeof obj !== 'object') return JSON.stringify(obj);
    if (Array.isArray(obj)) return '[' + obj.map(stableStringify).join(',') + ']';
    return '{' + Object.keys(obj).sort().map(k => JSON.stringify(k) + ':' + stableStringify(obj[k])).join(',') + '}';
}

function hashToolCall(name, args) {
    // Stable stringify sorts keys recursively — order-independent hashing
    return crypto.createHash('md5')
        .update(name + stableStringify(args || {}))
        .digest('hex');
}

function recordToolCall(chatId, name, args) {
    const state = _getState(chatId);
    const hash = hashToolCall(name, args);

    state.hashWindow.push(hash);
    if (state.hashWindow.length > WINDOW_SIZE) {
        const removed = state.hashWindow.shift();
        const oldCount = state.hashCounts.get(removed) || 0;
        if (oldCount <= 1) state.hashCounts.delete(removed);
        else state.hashCounts.set(removed, oldCount - 1);
    }

    const count = (state.hashCounts.get(hash) || 0) + 1;
    state.hashCounts.set(hash, count);

    if (count >= LOOP_BREAK_THRESHOLD) return { status: 'break', hash, count };
    if (count >= LOOP_WARN_THRESHOLD) return { status: 'warn', hash, count };
    return { status: 'ok', hash, count };
}

module.exports = { reset, recordToolCall, LOOP_WARN_THRESHOLD, LOOP_BREAK_THRESHOLD };
