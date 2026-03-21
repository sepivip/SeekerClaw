// tools/memory.js — memory_save, memory_read, daily_note, memory_search, memory_get, memory_stats handlers

const fs = require('fs');
const path = require('path');

const {
    workDir, log, config, localDateStr,
} = require('../config');

const {
    redactSecrets, safePath,
} = require('../security');

const {
    loadMemory, saveMemory, appendDailyMemory, searchMemory,
} = require('../memory');

const { getDb, indexMemoryFiles } = require('../database');

// Forward declaration — filled in by index.js re-export
let formatBytes;
function _setFormatBytes(fn) { formatBytes = fn; }

// DeerFlow P1: Memory session scrubbing — strip session-specific noise before persisting
const SCRUB_PATTERNS = [
    /\b(?:I\s+)?(?:used|called|ran|executed|invoked)\s+(?:the\s+)?\w+(?:_\w+)?\s+tool\b/gi,
    /\b(?:upload(?:ed)?|sent|received|attached)\s+(?:a\s+)?(?:file|image|photo|document|video|voice)\s+\S+/gi,
    /\bmessage\s*#?\d{5,}\b/gi,
    /\/tmp\/\S+/gi,
];

function scrubSessionContent(content) {
    if (!content || typeof content !== 'string') return content;
    let scrubbed = content;
    let scrubCount = 0;
    for (const pattern of SCRUB_PATTERNS) {
        const before = scrubbed;
        scrubbed = scrubbed.replace(pattern, '');
        if (scrubbed !== before) scrubCount++;
    }
    scrubbed = scrubbed.replace(/\n{3,}/g, '\n\n').trim();
    if (scrubCount > 0) log(`[MemoryScrub] Scrubbed ${scrubCount} session-specific patterns`, 'DEBUG');
    if (!scrubbed) return null;
    return scrubbed;
}

const tools = [
    {
        name: 'memory_save',
        description: 'Save important information to long-term memory (MEMORY.md). Use this to remember facts, preferences, or important details about the user.',
        input_schema: {
            type: 'object',
            properties: {
                content: { type: 'string', description: 'The content to save to memory' }
            },
            required: ['content']
        }
    },
    {
        name: 'memory_read',
        description: 'Read the current contents of long-term memory.',
        input_schema: {
            type: 'object',
            properties: {}
        }
    },
    {
        name: 'daily_note',
        description: 'Add a note to today\'s daily memory file. Use this for logging events, conversations, or daily observations.',
        input_schema: {
            type: 'object',
            properties: {
                note: { type: 'string', description: 'The note to add' }
            },
            required: ['note']
        }
    },
    {
        name: 'memory_search',
        description: 'Search your SQL.js database (seekerclaw.db) for memory content. All memory files are indexed into searchable chunks — this performs ranked keyword search with recency weighting, returning top matches with file paths and line numbers.',
        input_schema: {
            type: 'object',
            properties: {
                query: { type: 'string', description: 'Search term or pattern to find' },
                max_results: { type: 'number', description: 'Maximum results to return (default 10)' }
            },
            required: ['query']
        }
    },
    {
        name: 'memory_get',
        description: 'Get specific lines from a memory file by line number. Use after memory_search to retrieve full context.',
        input_schema: {
            type: 'object',
            properties: {
                file: { type: 'string', description: 'File path relative to workspace (e.g., "MEMORY.md" or "memory/2024-01-15.md")' },
                start_line: { type: 'number', description: 'Starting line number (1-indexed)' },
                end_line: { type: 'number', description: 'Ending line number (optional, defaults to start_line + 10)' }
            },
            required: ['file', 'start_line']
        }
    },
    {
        name: 'memory_stats',
        description: 'Get memory system statistics: file sizes, daily file count, total storage used, and database index status.',
        input_schema: {
            type: 'object',
            properties: {}
        }
    },
];

const handlers = {
    async memory_save(input, chatId) {
        // DeerFlow P1: Scrub session-specific content before persisting
        const scrubbed = scrubSessionContent(redactSecrets(input.content));
        if (!scrubbed) {
            return { success: true, message: 'Content was entirely session-specific and was not saved. Only save durable facts, preferences, and important details.' };
        }
        const currentMemory = loadMemory();
        const newMemory = currentMemory + '\n\n---\n\n' + scrubbed;
        saveMemory(newMemory.trim());
        return { success: true, message: 'Memory saved' };
    },

    async memory_read(input, chatId) {
        const memory = loadMemory();
        return { content: memory || '(Memory is empty)' };
    },

    async daily_note(input, chatId) {
        // DeerFlow P1: Scrub session-specific content before persisting
        const scrubbed = scrubSessionContent(redactSecrets(input.note));
        if (!scrubbed) {
            return { success: true, message: 'Note was entirely session-specific and was not saved. Only save durable facts and observations.' };
        }
        appendDailyMemory(scrubbed);
        return { success: true, message: 'Note added to daily memory' };
    },

    async memory_search(input, chatId) {
        const maxResults = input.max_results || 10;
        const results = searchMemory(input.query, maxResults);
        return {
            query: input.query,
            count: results.length,
            results
        };
    },

    async memory_get(input, chatId) {
        const filePath = safePath(input.file);
        if (!filePath) return { error: 'Access denied: path outside workspace' };
        if (!fs.existsSync(filePath)) {
            return { error: `File not found: ${input.file}` };
        }
        const content = fs.readFileSync(filePath, 'utf8');
        const lines = content.split('\n');
        const startLine = Math.max(1, input.start_line) - 1;
        const endLine = Math.min(lines.length, input.end_line || startLine + 11) - 1;
        const selectedLines = lines.slice(startLine, endLine + 1);
        return {
            file: input.file,
            start_line: startLine + 1,
            end_line: endLine + 1,
            content: selectedLines.map((line, i) => `${startLine + i + 1}: ${line}`).join('\n')
        };
    },

    async memory_stats(input, chatId) {
        const stats = {
            memoryMd: { exists: false, size: 0 },
            dailyFiles: { count: 0, totalSize: 0, oldestDate: null, newestDate: null },
            total: { size: 0, warning: null }
        };

        // Check MEMORY.md
        const memoryPath = path.join(workDir, 'MEMORY.md');
        if (fs.existsSync(memoryPath)) {
            const stat = fs.statSync(memoryPath);
            stats.memoryMd.exists = true;
            stats.memoryMd.size = stat.size;
            stats.total.size += stat.size;

            // Warn if MEMORY.md exceeds 50KB
            if (stat.size > 50 * 1024) {
                stats.total.warning = `MEMORY.md is ${Math.round(stat.size / 1024)}KB - consider archiving old entries`;
            }
        }

        // Check daily memory files
        const memoryDir = path.join(workDir, 'memory');
        if (fs.existsSync(memoryDir)) {
            const files = fs.readdirSync(memoryDir).filter(f => f.endsWith('.md')).sort();
            stats.dailyFiles.count = files.length;

            if (files.length > 0) {
                stats.dailyFiles.oldestDate = files[0].replace('.md', '');
                stats.dailyFiles.newestDate = files[files.length - 1].replace('.md', '');
            }

            for (const file of files) {
                const filePath = path.join(memoryDir, file);
                const stat = fs.statSync(filePath);
                stats.dailyFiles.totalSize += stat.size;
                stats.total.size += stat.size;
            }
        }

        // Format sizes for readability
        stats.memoryMd.sizeFormatted = formatBytes(stats.memoryMd.size);
        stats.dailyFiles.totalSizeFormatted = formatBytes(stats.dailyFiles.totalSize);
        stats.total.sizeFormatted = formatBytes(stats.total.size);

        // Check if we have too many daily files (>30 days)
        if (stats.dailyFiles.count > 30) {
            stats.total.warning = (stats.total.warning || '') +
                ` ${stats.dailyFiles.count} daily files - consider pruning old files.`;
        }

        return stats;
    },
};

module.exports = { tools, handlers, _setFormatBytes };
