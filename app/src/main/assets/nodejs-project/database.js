// SeekerClaw — database.js
// SQL.js initialization, persistence, memory indexing, stats server, graceful shutdown.
// Depends on: config.js, memory.js (setDb)

const fs = require('fs');
const path = require('path');

const {
    workDir, log, localTimestamp, localDateStr,
    DB_PATH, MEMORY_PATH, MEMORY_DIR,
} = require('./config');

const { setDb } = require('./memory');

// ============================================================================
// DATABASE STATE
// ============================================================================

let db = null;

// Wire db getter into memory.js so searchMemory() can access SQL.js
setDb(() => db);

/** @returns {object|null} The SQL.js Database instance, or null if not initialized */
function getDb() { return db; }

// ============================================================================
// DATABASE INJECTION (shutdown deps live in main.js / claude.js, injected here)
// ============================================================================

let _shutdownDeps = {
    conversations: null,          // Map — from main.js (will move to claude.js in BAT-203)
    saveSessionSummary: null,     // async fn — from main.js (will move to claude.js in BAT-203)
    MIN_MESSAGES_FOR_SUMMARY: 3,  // constant — from main.js (will move to claude.js in BAT-203)
};

/**
 * Inject shutdown dependencies that live outside this module.
 * Call after claude/main modules are loaded.
 */
function setShutdownDeps(deps) {
    if (!deps || typeof deps !== 'object') {
        log('[DB] WARNING: setShutdownDeps called with invalid argument', 'WARN');
        return;
    }
    if (deps.conversations) _shutdownDeps.conversations = deps.conversations;
    if (typeof deps.saveSessionSummary === 'function') _shutdownDeps.saveSessionSummary = deps.saveSessionSummary;
    if (typeof deps.MIN_MESSAGES_FOR_SUMMARY === 'number') _shutdownDeps.MIN_MESSAGES_FOR_SUMMARY = deps.MIN_MESSAGES_FOR_SUMMARY;
}

// ============================================================================
// INIT & PERSISTENCE
// ============================================================================

async function initDatabase() {
    try {
        const initSqlJs = require('./sql-wasm.js');
        // WASM binary lives in __dirname (bundled assets); DB file in workDir (writable app data)
        const SQL = await initSqlJs({
            locateFile: file => path.join(__dirname, file)
        });

        // Load existing DB or create new (with corrupted DB recovery)
        if (fs.existsSync(DB_PATH)) {
            try {
                const buffer = fs.readFileSync(DB_PATH);
                db = new SQL.Database(buffer);
                log('[DB] Loaded existing database', 'INFO');
            } catch (loadErr) {
                log(`[DB] Corrupted database, backing up and recreating: ${loadErr.message}`, 'WARN');
                const backupPath = DB_PATH + '.corrupt.' + Date.now();
                try { fs.renameSync(DB_PATH, backupPath); } catch (_) {}
                db = new SQL.Database();
                log('[DB] Created fresh database after corruption recovery', 'INFO');
            }
        } else {
            db = new SQL.Database();
            log('[DB] Created new database', 'INFO');
        }

        // Create tables
        db.run(`CREATE TABLE IF NOT EXISTS api_request_log (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            timestamp TEXT NOT NULL,
            chat_id TEXT,
            input_tokens INTEGER,
            output_tokens INTEGER,
            cache_creation_tokens INTEGER DEFAULT 0,
            cache_read_tokens INTEGER DEFAULT 0,
            status INTEGER,
            retry_count INTEGER DEFAULT 0,
            duration_ms INTEGER
        )`);

        // Memory indexing tables (BAT-25)
        db.run(`CREATE TABLE IF NOT EXISTS chunks (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            path TEXT NOT NULL,
            source TEXT DEFAULT 'memory',
            start_line INTEGER,
            end_line INTEGER,
            hash TEXT,
            text TEXT NOT NULL,
            updated_at TEXT NOT NULL
        )`);
        db.run(`CREATE INDEX IF NOT EXISTS idx_chunks_path ON chunks(path)`);
        db.run(`CREATE INDEX IF NOT EXISTS idx_chunks_source ON chunks(source)`);

        db.run(`CREATE TABLE IF NOT EXISTS files (
            path TEXT PRIMARY KEY,
            source TEXT DEFAULT 'memory',
            hash TEXT,
            mtime TEXT,
            size INTEGER
        )`);

        db.run(`CREATE TABLE IF NOT EXISTS meta (
            key TEXT PRIMARY KEY,
            value TEXT
        )`);

        // Persist immediately so the file exists on disk right away
        saveDatabase();

        log('[DB] SQL.js database initialized', 'INFO');

        // Start periodic saves only after successful init
        setInterval(saveDatabase, 60000);

    } catch (err) {
        log(`[DB] Failed to initialize SQL.js (non-fatal): ${err.message}`, 'ERROR');
        db = null;
    }
}

function saveDatabase() {
    if (!db) return;
    try {
        const data = db.export();
        const buffer = Buffer.from(data);
        // Atomic write: write to temp file, then rename
        const tmpPath = DB_PATH + '.tmp';
        fs.writeFileSync(tmpPath, buffer);
        fs.renameSync(tmpPath, DB_PATH);
    } catch (err) {
        log(`[DB] Save error: ${err.message}`, 'ERROR');
    }
}

// ============================================================================
// MEMORY INDEXING (BAT-26)
// ============================================================================

// Index memory files into chunks table for search
function indexMemoryFiles() {
    if (!db) return;
    try {
        const crypto = require('crypto');
        const filesToIndex = [];

        // Collect MEMORY.md
        if (fs.existsSync(MEMORY_PATH)) {
            filesToIndex.push({ path: MEMORY_PATH, source: 'memory' });
        }

        // Collect daily memory files
        if (fs.existsSync(MEMORY_DIR)) {
            const dailyFiles = fs.readdirSync(MEMORY_DIR).filter(f => f.endsWith('.md'));
            for (const f of dailyFiles) {
                filesToIndex.push({ path: path.join(MEMORY_DIR, f), source: 'daily' });
            }
        }

        let indexed = 0;
        let skipped = 0;

        for (const file of filesToIndex) {
            const stat = fs.statSync(file.path);
            const mtime = stat.mtime.toISOString();
            const size = stat.size;

            // Check if file already indexed with same mtime+size
            const existing = db.exec(
                `SELECT mtime, size FROM files WHERE path = ?`, [file.path]
            );
            if (existing.length > 0 && existing[0].values.length > 0) {
                const [existMtime, existSize] = existing[0].values[0];
                if (existMtime === mtime && existSize === size) {
                    skipped++;
                    continue;
                }
            }

            // Read and chunk the file
            const content = fs.readFileSync(file.path, 'utf8');
            const hash = crypto.createHash('md5').update(content).digest('hex');
            const chunks = chunkMarkdown(content);

            // Delete old chunks for this path
            db.run(`DELETE FROM chunks WHERE path = ?`, [file.path]);

            // Insert new chunks
            for (const chunk of chunks) {
                db.run(
                    `INSERT INTO chunks (path, source, start_line, end_line, hash, text, updated_at)
                     VALUES (?, ?, ?, ?, ?, ?, ?)`,
                    [file.path, file.source, chunk.startLine, chunk.endLine, hash,
                     chunk.text, localTimestamp()]
                );
            }

            // Update files table
            db.run(
                `INSERT OR REPLACE INTO files (path, source, hash, mtime, size)
                 VALUES (?, ?, ?, ?, ?)`,
                [file.path, file.source, hash, mtime, size]
            );
            indexed++;
        }

        // Update meta
        db.run(`INSERT OR REPLACE INTO meta (key, value) VALUES ('last_indexed', ?)`,
            [localTimestamp()]);

        if (indexed > 0) saveDatabase();
        log(`[Memory] Indexed ${indexed} files, skipped ${skipped} unchanged`, 'DEBUG');
    } catch (err) {
        log(`[Memory] Indexing error (non-fatal): ${err.message}`, 'WARN');
    }
}

// Split markdown content into chunks by headers or paragraphs
function chunkMarkdown(content) {
    const lines = content.split('\n');
    const chunks = [];
    let current = { text: '', startLine: 1, endLine: 1 };

    for (let i = 0; i < lines.length; i++) {
        const line = lines[i];
        const lineNum = i + 1;

        // New chunk on ## or ### headers (keep # as single chunk boundary)
        if (/^#{1,3}\s/.test(line) && current.text.trim()) {
            current.endLine = lineNum - 1;
            chunks.push({ ...current, text: current.text.trim() });
            current = { text: line + '\n', startLine: lineNum, endLine: lineNum };
        } else {
            current.text += line + '\n';
            current.endLine = lineNum;
        }
    }

    // Push remaining
    if (current.text.trim()) {
        chunks.push({ ...current, text: current.text.trim() });
    }

    // Split oversized chunks (>2000 chars) by double-newline
    const result = [];
    for (const chunk of chunks) {
        if (chunk.text.length <= 2000) {
            result.push(chunk);
        } else {
            const parts = chunk.text.split(/\n\n+/);
            let buf = '';
            let startLine = chunk.startLine;
            for (const part of parts) {
                if (buf.length + part.length > 2000 && buf.trim()) {
                    result.push({ text: buf.trim(), startLine, endLine: startLine });
                    buf = part + '\n\n';
                    startLine = chunk.startLine; // approximate
                } else {
                    buf += part + '\n\n';
                }
            }
            if (buf.trim()) {
                result.push({ text: buf.trim(), startLine, endLine: chunk.endLine });
            }
        }
    }

    return result;
}

// ============================================================================
// GRACEFUL SHUTDOWN (BAT-57)
// ============================================================================

// Registered outside initDatabase so shutdown hooks work even if DB init fails
async function gracefulShutdown(signal) {
    log(`[Shutdown] ${signal} received, saving session summary...`, 'INFO');
    try {
        const { conversations, saveSessionSummary, MIN_MESSAGES_FOR_SUMMARY } = _shutdownDeps;
        if (conversations && saveSessionSummary) {
            const timeout = new Promise((_, rej) => setTimeout(() => rej(new Error('timeout')), 5000));
            const summaries = [];
            for (const [chatId, conv] of conversations) {
                if (conv.length >= MIN_MESSAGES_FOR_SUMMARY) {
                    summaries.push(saveSessionSummary(chatId, 'shutdown', { force: true, skipIndex: true }));
                }
            }
            if (summaries.length > 0) {
                await Promise.race([Promise.all(summaries), timeout]);
                indexMemoryFiles(); // Single re-index after all summaries
            }
        }
    } catch (err) {
        log(`[Shutdown] Summary failed: ${err.message}`, 'ERROR');
    }
    saveDatabase();
    process.exit(0);
}
process.on('SIGTERM', () => gracefulShutdown('SIGTERM'));
process.on('SIGINT', () => gracefulShutdown('SIGINT'));

// ============================================================================
// DB SUMMARY & STATS SERVER (BAT-31)
// ============================================================================

function getDbSummary() {
    const summary = { today: null, month: null, memory: null };
    if (!db) return summary;

    try {
        const today = localDateStr();
        const rows = db.exec(
            `SELECT COUNT(*) as cnt,
                    COALESCE(SUM(input_tokens), 0) as inp,
                    COALESCE(SUM(output_tokens), 0) as outp,
                    COALESCE(AVG(duration_ms), 0) as avg_ms,
                    COALESCE(SUM(cache_read_tokens), 0) as cache_read,
                    COALESCE(SUM(cache_creation_tokens), 0) as cache_write,
                    SUM(CASE WHEN status != 200 THEN 1 ELSE 0 END) as errors
             FROM api_request_log WHERE timestamp LIKE ?`, [today + '%']
        );
        if (rows.length > 0 && rows[0].values.length > 0) {
            const [cnt, inp, outp, avgMs, cacheRead, cacheWrite, errors] = rows[0].values[0];
            if ((cnt || 0) > 0) {
                // Denominator = total tokens billed (non-cached + cache_read + cache_write).
                // Using only inp (non-cached) as denominator caused ratios > 1 when cache
                // reads dominated, producing UI values like 878%.
                const totalInp = (inp || 0) + (cacheRead || 0) + (cacheWrite || 0);
                const cacheHitRate = totalInp > 0 ? Math.min(1, (cacheRead || 0) / totalInp) : 0;
                summary.today = {
                    requests: cnt,
                    input_tokens: inp || 0,
                    output_tokens: outp || 0,
                    avg_latency_ms: Math.round(avgMs || 0),
                    errors: errors || 0,
                    cache_hit_rate: +cacheHitRate.toFixed(4),
                };
            }
        }
    } catch (e) { /* non-fatal */ }

    try {
        const monthPrefix = localDateStr().slice(0, 7); // YYYY-MM
        const rows = db.exec(
            `SELECT COUNT(*) as cnt,
                    COALESCE(SUM(input_tokens), 0) as inp,
                    COALESCE(SUM(output_tokens), 0) as outp
             FROM api_request_log WHERE timestamp LIKE ?`, [monthPrefix + '%']
        );
        if (rows.length > 0 && rows[0].values.length > 0) {
            const [cnt, inp, outp] = rows[0].values[0];
            if ((cnt || 0) > 0) {
                // Cost estimate: Sonnet pricing ~$3/M input, ~$15/M output
                const costEstimate = ((inp || 0) / 1e6) * 3 + ((outp || 0) / 1e6) * 15;
                summary.month = {
                    requests: cnt,
                    input_tokens: inp || 0,
                    output_tokens: outp || 0,
                    total_cost_estimate: +costEstimate.toFixed(2)
                };
            }
        }
    } catch (e) { /* non-fatal */ }

    try {
        const fileRows = db.exec('SELECT COUNT(*) FROM files');
        const chunkRows = db.exec('SELECT COUNT(*) FROM chunks');
        const metaRows = db.exec("SELECT value FROM meta WHERE key = 'last_indexed'");
        const filesCount = fileRows.length > 0 ? fileRows[0].values[0][0] : 0;
        const chunksCount = chunkRows.length > 0 ? chunkRows[0].values[0][0] : 0;
        const lastIndexed = metaRows.length > 0 ? metaRows[0].values[0][0] : null;
        if (filesCount > 0 || chunksCount > 0 || lastIndexed) {
            summary.memory = {
                files_indexed: filesCount,
                chunks_count: chunksCount,
                last_indexed: lastIndexed
            };
        }
    } catch (e) { /* non-fatal */ }

    return summary;
}

// Write DB summary to file for cross-process UI access (like claude_usage_state)
let dbSummaryDirty = false;
function writeDbSummaryFile() {
    dbSummaryDirty = false;
    try {
        const summary = getDbSummary();
        const targetPath = path.join(workDir, 'db_summary_state');
        const tmpPath = targetPath + '.tmp';
        fs.writeFileSync(tmpPath, JSON.stringify(summary));
        fs.renameSync(tmpPath, targetPath);
    } catch (e) { log(`[DB] Summary file write failed: ${e.message}`, 'WARN'); }
}
function markDbSummaryDirty() { dbSummaryDirty = true; }

function startDbSummaryInterval() {
    writeDbSummaryFile();
    setInterval(() => { if (dbSummaryDirty) writeDbSummaryFile(); }, 30000);
}

// ============================================================================
// INTERNAL HTTP SERVER — serves stats to Android UI via bridge proxy (BAT-31)
// ============================================================================

const STATS_PORT = 8766;

function startStatsServer() {
    const statsServer = require('http').createServer((req, res) => {
        if (req.method === 'GET' && req.url === '/stats/db-summary') {
            const summary = getDbSummary();
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify(summary));
        } else {
            res.writeHead(404, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: 'Not found' }));
        }
    });

    statsServer.on('error', (err) => {
        log(`[Stats] Internal stats server error (${err.code || 'UNKNOWN'}): ${err.message}`, 'ERROR');
    });

    statsServer.listen(STATS_PORT, '127.0.0.1', () => {
        log(`[Stats] Internal stats server listening on port ${STATS_PORT}`, 'INFO');
    });
}

// ============================================================================
// EXPORTS
// ============================================================================

module.exports = {
    getDb,
    setShutdownDeps,
    initDatabase,
    indexMemoryFiles,
    writeDbSummaryFile,
    markDbSummaryDirty,
    startDbSummaryInterval,
    startStatsServer,
};
