// tools/file.js — read, write, edit, ls, delete handlers

const fs = require('fs');
const path = require('path');

const {
    workDir, log, config, CHANNEL,
    syncAgentApiKeys,
} = require('../config');

const channel = require('../channel');

const {
    redactSecrets, rebuildRedactPatterns, detectSuspiciousPatterns,
    maskAgentSettings, registerAgentSettingsSecrets,
    resolveWorkspacePath, readBlockedName, sendBlockedName, writeBlockedName, writeLinkOnPath,
} = require('../security');

// BAT-1087: filename whose contents carry provider/service secrets under apiKeys.*
const AGENT_SETTINGS_FILE = 'agent_settings.json';

// BAT-1409 P1-E: control characters and line separators never reach a log line.
function logSafe(s) {
    return String(s).replace(/[\x00-\x1f\x7f\u2028\u2029]/g, '_').slice(0, 200);
}

// BAT-1409 P1-E: the writer checks shared by write, edit and delete. Returns an error result, or
// null when the write may go ahead.
function refuseWrite(r, input) {
    if (!r) return { error: 'Access denied: path outside workspace' };
    const blocked = writeBlockedName(r);
    if (blocked) {
        log(`[Security] BLOCKED write to protected file: ${logSafe(blocked)}`, 'WARN');
        return { error: `Writing ${blocked} is blocked: it is managed by the app.` };
    }
    const link = writeLinkOnPath(r);
    if (link) {
        log(`[Security] BLOCKED write through a link: ${logSafe(link)}`, 'WARN');
        return { error: `Access denied: ${link} is a link; the file tools do not write through links.` };
    }
    return null;
}

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
        description: `Send a workspace file to the user via ${CHANNEL === 'discord' ? 'Discord DM' : 'Telegram chat'}. Auto-detects type from extension. Use for sharing reports, camera captures, exported CSVs, generated images, or any file the user needs (app secret files — agent_settings.json, config.json, seekerclaw.db, tokens — are refused). Max ${CHANNEL === 'discord' ? '25MB (Discord limit)' : '50MB (Telegram limit), photos max 10MB'}.`,
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
        // BAT-1409 P1-E: the real path must stay inside the workspace (a link cannot lead out),
        // and the protected names are anchored at the workspace root on both layers.
        const r = resolveWorkspacePath(input.path);
        if (!r) return { error: 'Access denied: path outside workspace' };
        const blocked = readBlockedName(r);
        if (blocked) {
            log(`[Security] BLOCKED read of sensitive file: ${logSafe(blocked)}`, 'WARN');
            return { error: `Reading ${blocked} is blocked for security.` };
        }
        const filePath = r.real;
        if (!fs.existsSync(filePath)) {
            return { error: `File not found: ${input.path}` };
        }
        const readBasename = path.basename(r.abs);
        const realBasename = path.basename(r.real);
        const stat = fs.statSync(filePath);
        if (stat.isDirectory()) {
            return { error: 'Path is a directory, use ls tool instead' };
        }
        const content = fs.readFileSync(filePath, 'utf8');
        // BAT-1087: mask secret values before returning agent_settings.json to the
        // model. Match basename OR realpath-basename so symlink aliases are covered;
        // conservatively masking any file named agent_settings.json is acceptable.
        if (readBasename === AGENT_SETTINGS_FILE || realBasename === AGENT_SETTINGS_FILE) {
            const masked = maskAgentSettings(content);
            if (masked === null) {
                // Unparseable → fail closed: withhold rather than emit raw bytes.
                log('[Security] agent_settings.json unparseable — withholding content from model', 'WARN');
                return {
                    path: input.path,
                    size: stat.size,
                    error: 'agent_settings.json is unparseable; contents withheld to avoid leaking secrets',
                };
            }
            return { path: input.path, size: stat.size, content: masked.slice(0, 50000) };
        }
        return {
            path: input.path,
            size: stat.size,
            content: content.slice(0, 50000) // Limit to 50KB
        };
    },

    async write(input, chatId) {
        const r = resolveWorkspacePath(input.path);
        const refused = refuseWrite(r, input);
        if (refused) return refused;
        const filePath = r.abs;

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
        if (filePath === path.join(workDir, AGENT_SETTINGS_FILE)) {
            syncAgentApiKeys();
            rebuildRedactPatterns();
            registerAgentSettingsSecrets(); // BAT-1087: register newly-saved secrets for redaction
        }

        return {
            success: true,
            path: input.path,
            size: input.content.length
        };
    },

    async edit(input, chatId) {
        const r = resolveWorkspacePath(input.path);
        const refused = refuseWrite(r, input);
        if (refused) return refused;
        const filePath = r.abs;
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
        if (filePath === path.join(workDir, AGENT_SETTINGS_FILE)) {
            syncAgentApiKeys();
            rebuildRedactPatterns();
            registerAgentSettingsSecrets(); // BAT-1087: register newly-saved secrets for redaction
        }

        return {
            success: true,
            path: input.path,
            operation: input.operation
        };
    },

    async ls(input, chatId) {
        const r = resolveWorkspacePath(input.path || '');
        if (!r) return { error: 'Access denied: path outside workspace' };
        const targetPath = r.real;
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
                // BAT-1409 P1-E: lstat, so a link is listed as a link and never followed.
                let itemStat;
                try { itemStat = fs.lstatSync(itemPath); } catch (_) { continue; }
                if (itemStat.isSymbolicLink()) {
                    entries.push({ name: prefix + item, type: 'symlink', size: null });
                    continue;
                }
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
        // Core identity files (any depth, as before); the app-managed files are refused at the
        // workspace root by refuseWrite (BAT-1409 P1-E).
        const DELETE_PROTECTED = new Set(['SOUL.md', 'MEMORY.md', 'IDENTITY.md', 'USER.md', 'HEARTBEAT.md']);

        if (!input.path) return { error: 'path is required' };
        const r = resolveWorkspacePath(input.path);
        if (r && r.rel === '') return { error: 'Cannot delete the workspace itself.' };
        const refused = refuseWrite(r, input);
        if (refused) return refused;
        const filePath = r.abs;

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

        const r = resolveWorkspacePath(input.path);
        if (!r) return { error: 'Access denied: path outside workspace' };
        // BAT-1409 P1-E: raw bytes leave the device here, so the secret names and
        // agent_settings.json (only its masked form may leave, through read) are refused.
        const blocked = sendBlockedName(r);
        if (blocked) {
            log(`[Security] BLOCKED send of sensitive file: ${logSafe(blocked)}`, 'WARN');
            return { error: `Sending ${blocked} is blocked for security.` };
        }
        const filePath = r.real;
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
