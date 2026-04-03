// tools/file.js — read, write, edit, ls, delete handlers

const fs = require('fs');
const path = require('path');

const {
    workDir, log, config, CHANNEL, SECRETS_BLOCKED,
    syncAgentApiKeys,
} = require('../config');

const channel = require('../channel');

const {
    redactSecrets, rebuildRedactPatterns, safePath, detectSuspiciousPatterns,
} = require('../security');

// Helper to recursively list files in a directory (used by skill_read)
function listFilesRecursive(dir, maxDepth = 3, currentDepth = 0) {
    if (currentDepth >= maxDepth) return [];
    const results = [];
    try {
        const entries = fs.readdirSync(dir, { withFileTypes: true });
        for (const entry of entries) {
            const fullPath = path.join(dir, entry.name);
            // Skip symlinks for security
            if (entry.isSymbolicLink()) continue;
            if (entry.isFile()) {
                results.push(fullPath);
            } else if (entry.isDirectory() && !entry.name.startsWith('.')) {
                results.push(...listFilesRecursive(fullPath, maxDepth, currentDepth + 1));
            }
        }
    } catch (e) { /* ignore permission errors */ }
    return results;
}

// Helper to format bytes
function formatBytes(bytes) {
    if (bytes === 0) return '0 B';
    const k = 1024;
    const sizes = ['B', 'KB', 'MB', 'GB'];
    const i = Math.floor(Math.log(bytes) / Math.log(k));
    return parseFloat((bytes / Math.pow(k, i)).toFixed(2)) + ' ' + sizes[i];
}

const tools = [
    {
        name: 'read',
        description: 'Read a file from the workspace directory. Only files within workspace/ can be read.',
        input_schema: {
            type: 'object',
            properties: {
                path: { type: 'string', description: 'File path relative to workspace (e.g., "notes.txt", "data/results.json")' }
            },
            required: ['path']
        }
    },
    {
        name: 'write',
        description: 'Write or create a file in the workspace directory. Overwrites if file exists.',
        input_schema: {
            type: 'object',
            properties: {
                path: { type: 'string', description: 'File path relative to workspace' },
                content: { type: 'string', description: 'Content to write to the file' }
            },
            required: ['path', 'content']
        }
    },
    {
        name: 'edit',
        description: 'Edit an existing file in the workspace. Supports append, prepend, or replace operations.',
        input_schema: {
            type: 'object',
            properties: {
                path: { type: 'string', description: 'File path relative to workspace' },
                operation: { type: 'string', enum: ['append', 'prepend', 'replace'], description: 'Type of edit operation' },
                content: { type: 'string', description: 'Content for the operation' },
                search: { type: 'string', description: 'Text to find (required for replace operation)' }
            },
            required: ['path', 'operation', 'content']
        }
    },
    {
        name: 'ls',
        description: 'List files and directories in the workspace. Returns file names, sizes, and types.',
        input_schema: {
            type: 'object',
            properties: {
                path: { type: 'string', description: 'Directory path relative to workspace (default: root)' },
                recursive: { type: 'boolean', description: 'List recursively (default: false)' }
            }
        }
    },
    {
        name: 'delete',
        description: 'Delete a file from the workspace directory. Cannot delete protected system files or database files. Cannot delete directories — only individual files. Use this to clean up temporary files, old media downloads, or files you no longer need.',
        input_schema: {
            type: 'object',
            properties: {
                path: { type: 'string', description: 'File path relative to workspace (e.g., "media/inbound/old_photo.jpg", "temp/script.js")' }
            },
            required: ['path']
        }
    },
    {
        name: 'send_file',
        description: `Send a workspace file to the user via ${CHANNEL === 'discord' ? 'Discord DM' : 'Telegram chat'}. Auto-detects type from extension. Use for sharing reports, camera captures, exported CSVs, generated images, or any file the user needs. Max ${CHANNEL === 'discord' ? '25MB (Discord limit)' : '50MB (Telegram limit), photos max 10MB'}.`,
        input_schema: {
            type: 'object',
            properties: {
                path: { type: 'string', description: 'File path relative to workspace (e.g., "media/inbound/photo.jpg", "report.csv")' },
                chat_id: { type: 'string', description: 'The chat/channel ID to send to (from conversation context)' },
                caption: { type: 'string', description: 'Optional caption/message to send with the file' }
            },
            required: ['path', 'chat_id']
        }
    }
];

const handlers = {
    async read(input, chatId) {
        const filePath = safePath(input.path);
        if (!filePath) return { error: 'Access denied: path outside workspace' };
        // Check basename first, then resolve symlinks to catch aliased access
        const readBasename = path.basename(filePath);
        if (SECRETS_BLOCKED.has(readBasename)) {
            log(`[Security] BLOCKED read of sensitive file: ${readBasename}`, 'WARN');
            return { error: `Reading ${readBasename} is blocked for security.` };
        }
        if (!fs.existsSync(filePath)) {
            return { error: `File not found: ${input.path}` };
        }
        // Resolve symlinks and re-check basename (prevents symlink bypass)
        try {
            const realBasename = path.basename(fs.realpathSync(filePath));
            if (SECRETS_BLOCKED.has(realBasename)) {
                log(`[Security] BLOCKED read via symlink to sensitive file: ${realBasename}`, 'WARN');
                return { error: `Reading ${realBasename} is blocked for security.` };
            }
        } catch { /* realpathSync may fail on broken links — proceed to normal error */ }
        const stat = fs.statSync(filePath);
        if (stat.isDirectory()) {
            return { error: 'Path is a directory, use ls tool instead' };
        }
        const content = fs.readFileSync(filePath, 'utf8');
        return {
            path: input.path,
            size: stat.size,
            content: content.slice(0, 50000) // Limit to 50KB
        };
    },

    async write(input, chatId) {
        const filePath = safePath(input.path);
        if (!filePath) return { error: 'Access denied: path outside workspace' };

        // Skill file write protection: writes to skills/ directory are blocked
        // when suspicious injection patterns are detected in the content (defense
        // against prompt injection creating persistent backdoor skills).
        const relPath = path.relative(workDir, filePath);
        const relPathLower = relPath.toLowerCase();
        if (relPathLower.startsWith('skills' + path.sep) || relPathLower.startsWith('skills/')) {
            // Check for suspicious content in the skill being written
            const suspicious = detectSuspiciousPatterns(input.content || '');
            if (suspicious.length > 0) {
                log(`[Security] BLOCKED skill write with suspicious patterns: ${suspicious.join(', ')} → ${relPath}`, 'WARN');
                return { error: 'Skill file write blocked: suspicious content detected (' + suspicious.join(', ') + '). Remove the flagged content and retry.' };
            }
            log(`[Security] Skill write to ${relPath} — allowed (no suspicious patterns)`, 'DEBUG');
        }

        // Create parent directories if needed
        const dir = path.dirname(filePath);
        if (!fs.existsSync(dir)) {
            fs.mkdirSync(dir, { recursive: true });
        }
        fs.writeFileSync(filePath, input.content, 'utf8');

        // BAT-236: If agent wrote to workspace root agent_settings.json, re-sync API keys
        if (filePath === path.join(workDir, 'agent_settings.json')) {
            syncAgentApiKeys();
            rebuildRedactPatterns();
        }

        return {
            success: true,
            path: input.path,
            size: input.content.length
        };
    },

    async edit(input, chatId) {
        const filePath = safePath(input.path);
        if (!filePath) return { error: 'Access denied: path outside workspace' };
        if (!fs.existsSync(filePath)) {
            return { error: `File not found: ${input.path}` };
        }
        let content = fs.readFileSync(filePath, 'utf8');

        switch (input.operation) {
            case 'append':
                content = content + '\n' + input.content;
                break;
            case 'prepend':
                content = input.content + '\n' + content;
                break;
            case 'replace':
                if (!input.search) {
                    return { error: 'Replace operation requires search parameter' };
                }
                if (!content.includes(input.search)) {
                    return { error: `Search text not found in file: ${input.search.slice(0, 50)}` };
                }
                content = content.replace(input.search, input.content);
                break;
            default:
                return { error: `Unknown operation: ${input.operation}` };
        }

        // Skill file edit protection (same as write tool)
        const editRelPath = path.relative(workDir, filePath).toLowerCase();
        if (editRelPath.startsWith('skills' + path.sep) || editRelPath.startsWith('skills/')) {
            const suspicious = detectSuspiciousPatterns(content);
            if (suspicious.length > 0) {
                log(`[Security] BLOCKED skill edit with suspicious patterns: ${suspicious.join(', ')} → ${editRelPath}`, 'WARN');
                return { error: 'Skill file edit blocked: suspicious content detected (' + suspicious.join(', ') + '). Remove the flagged content and retry.' };
            }
        }

        fs.writeFileSync(filePath, content, 'utf8');

        // BAT-236: If agent edited workspace root agent_settings.json, re-sync API keys
        if (filePath === path.join(workDir, 'agent_settings.json')) {
            syncAgentApiKeys();
            rebuildRedactPatterns();
        }

        return {
            success: true,
            path: input.path,
            operation: input.operation
        };
    },

    async ls(input, chatId) {
        const targetPath = safePath(input.path || '');
        if (!targetPath) return { error: 'Access denied: path outside workspace' };
        if (!fs.existsSync(targetPath)) {
            return { error: `Directory not found: ${input.path || '/'}` };
        }
        const stat = fs.statSync(targetPath);
        if (!stat.isDirectory()) {
            return { error: 'Path is not a directory' };
        }

        const listDir = (dir, prefix = '') => {
            const entries = [];
            const items = fs.readdirSync(dir);
            for (const item of items) {
                const itemPath = path.join(dir, item);
                const itemStat = fs.statSync(itemPath);
                const entry = {
                    name: prefix + item,
                    type: itemStat.isDirectory() ? 'directory' : 'file',
                    size: itemStat.isDirectory() ? null : itemStat.size
                };
                entries.push(entry);
                if (input.recursive && itemStat.isDirectory()) {
                    entries.push(...listDir(itemPath, prefix + item + '/'));
                }
            }
            return entries;
        };

        return {
            path: input.path || '/',
            entries: listDir(targetPath)
        };
    },

    async delete(input, chatId) {
        // Core identity files + secrets (uses shared SECRETS_BLOCKED for the latter)
        const DELETE_PROTECTED = new Set([
            'SOUL.md', 'MEMORY.md', 'IDENTITY.md', 'USER.md', 'HEARTBEAT.md',
            ...SECRETS_BLOCKED,
        ]);

        if (!input.path) return { error: 'path is required' };
        const filePath = safePath(input.path);
        if (!filePath) return { error: 'Access denied: path outside workspace' };

        // Check against protected files (compare basename for top-level, full relative for nested)
        const relativePath = path.relative(workDir, filePath);
        const baseName = path.basename(filePath);
        if (DELETE_PROTECTED.has(relativePath) || DELETE_PROTECTED.has(baseName)) {
            return { error: `Cannot delete protected file: ${baseName}` };
        }

        if (!fs.existsSync(filePath)) {
            return { error: `File not found: ${input.path}` };
        }

        try {
            const stat = fs.statSync(filePath);
            if (stat.isDirectory()) {
                return { error: 'Cannot delete directories. Delete individual files instead.' };
            }

            fs.unlinkSync(filePath);

            // Auto-clean empty parent directory inside skills/
            let directoryRemoved = false;
            const parentDir = path.dirname(filePath);
            const relParent = path.relative(workDir, parentDir);
            const parentParts = relParent.split('/');
            if (parentParts[0] === 'skills' && parentParts.length === 2) {
                try {
                    if (fs.readdirSync(parentDir).length === 0) {
                        fs.rmdirSync(parentDir);
                        directoryRemoved = true;
                        log(`Removed empty skill directory: ${relParent}`, 'DEBUG');
                    }
                } catch (_) { /* best-effort — rmdirSync only removes empty dirs */ }
            }

            // Sanitize path for logging (strip control chars)
            const safLogPath = String(input.path).replace(/[\r\n\0\u2028\u2029]/g, '_');
            log(`File deleted: ${safLogPath}`, 'DEBUG');
            return { success: true, path: input.path, deleted: true, directoryRemoved };
        } catch (err) {
            log(`Error deleting file: ${err && err.message ? err.message : String(err)}`, 'ERROR');
            return { error: `Failed to delete file: ${err && err.message ? err.message : String(err)}` };
        }
    },

    async send_file(input, chatId) {
        if (!input.path) return { error: 'path is required' };
        if (!input.chat_id) return { error: 'chat_id is required' };

        const filePath = safePath(input.path);
        if (!filePath) return { error: 'Access denied: path outside workspace' };
        if (!fs.existsSync(filePath)) return { error: `File not found: ${input.path}` };

        let stat;
        try { stat = fs.statSync(filePath); } catch (e) { return { error: `Cannot stat file: ${e.message}` }; }
        if (stat.isDirectory()) return { error: 'Cannot send a directory. Specify a file path.' };
        if (stat.size === 0) return { error: 'Cannot send empty file (0 bytes)' };

        // Channel-specific size limits
        const maxSize = CHANNEL === 'discord' ? 25 * 1024 * 1024 : 50 * 1024 * 1024;
        if (stat.size > maxSize) {
            const maxMb = (maxSize / 1024 / 1024).toFixed(0);
            return { error: `File too large (${(stat.size / 1024 / 1024).toFixed(1)}MB, max ${maxMb}MB)` };
        }

        try {
            const caption = input.caption ? String(input.caption).slice(0, 1024) : undefined;
            const safLogName = path.basename(filePath).replace(/[\r\n\0\u2028\u2029]/g, '_');
            log(`[SendFile] ${safLogName} (${(stat.size / 1024).toFixed(1)}KB) → chat ${input.chat_id}`, 'DEBUG');

            const result = await channel.sendFile(input.chat_id, filePath, caption);
            if (result && result.error) {
                log(`[SendFile] Failed: ${result.error}`, 'WARN');
                return { error: result.error };
            }
            log(`[SendFile] Sent successfully`, 'DEBUG');
            return { success: true, file: input.path, size: stat.size, messageId: result?.messageId ?? null };
        } catch (e) {
            log(`[SendFile] Error: ${e && e.message ? e.message : String(e)}`, 'ERROR');
            return { error: e && e.message ? e.message : String(e) };
        }
    },
};

module.exports = { tools, handlers, listFilesRecursive, formatBytes };
