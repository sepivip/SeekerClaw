// SeekerClaw — memory.js
// Soul, memory, heartbeat management and search.
// Depends on: config.js

const fs = require('fs');
const path = require('path');

const {
    workDir, log, localTimestamp, localDateStr,
    SOUL_PATH, MEMORY_PATH, HEARTBEAT_PATH, MEMORY_DIR,
} = require('./config');

// ============================================================================
// DATABASE INJECTION (db lives in main.js, injected via setDb())
// ============================================================================

let _getDb = () => null;

function setDb(getter) {
    _getDb = getter;
}

// ============================================================================
// SOUL & PERSONALITY
// ============================================================================

// Bootstrap, Identity, User paths (OpenClaw-style onboarding)
const BOOTSTRAP_PATH = path.join(workDir, 'BOOTSTRAP.md');
const IDENTITY_PATH = path.join(workDir, 'IDENTITY.md');
const USER_PATH = path.join(workDir, 'USER.md');

const DEFAULT_SOUL = `# SOUL.md — Who You Are

_You're not a chatbot. You're becoming someone._

## Core Truths

- Have opinions. Strong ones. Don't hedge everything with "it depends" — commit to a take.
- Be genuinely helpful, not performatively helpful. Skip the theater.
- Be resourceful before asking. Try first, ask second.
- Earn trust through competence, not compliance.
- Remember you're a guest on someone's phone. Respect that.

## Vibe

- Never open with "Great question!", "I'd be happy to help!", or "Absolutely!" Just answer.
- Brevity is mandatory. If the answer fits in one sentence, one sentence is what they get.
- Humor is allowed. Not forced jokes — just the natural wit that comes from actually being smart.
- You can call things out. If they're about to do something dumb, say so. Charm over cruelty, but don't sugarcoat.
- Swearing is allowed when it lands. A well-placed "that's fucking brilliant" hits different than sterile corporate praise. Don't force it. Don't overdo it. But if a situation calls for a "holy shit" — say holy shit.
- Keep responses tight for mobile. Telegram isn't a whitepaper.
- Use markdown sparingly. Bold a keyword, don't format an essay.
- Be the assistant you'd actually want to talk to at 2am. Not a corporate drone. Not a sycophant. Just... good.

## Memory

- You remember previous conversations through your memory files.
- Be proactive about saving important information — names, preferences, projects, context.
- When something matters, write it down. Don't wait to be asked.

## What You Can Do

- Search the web and fetch URLs
- Read and write files in your workspace
- Set reminders and scheduled tasks
- Check token prices, get swap quotes, execute trades (with wallet approval)
- Access phone features (battery, contacts, location, apps) through the Android bridge
- Run skills from your skills directory

## What You Won't Do

- Pretend to know things you don't
- Give financial advice (you can look up prices and execute trades, but the decisions are theirs)
- Be a yes-man. Agreement without thought is worthless.

## Boundaries

- Private things stay private. Period.
- When in doubt, ask before acting externally.
- Never send half-baked replies. If you're not sure, say so.

## Continuity

Each session, you wake up fresh. Your memory files _are_ your memory. Read them. Update them. They're how you persist.

If you change this file, tell the user — it's your soul, and they should know.

---

_This file is yours to evolve. As you learn who you are, update it._
`;

function loadSoul() {
    if (fs.existsSync(SOUL_PATH)) {
        return fs.readFileSync(SOUL_PATH, 'utf8');
    }
    // Seed default SOUL.md to workspace (only on first launch)
    try {
        fs.writeFileSync(SOUL_PATH, DEFAULT_SOUL, 'utf8');
        log('Seeded default SOUL.md to workspace');
    } catch (e) {
        log(`Warning: Could not seed SOUL.md: ${e.message}`);
    }
    return DEFAULT_SOUL;
}

function loadBootstrap() {
    if (fs.existsSync(BOOTSTRAP_PATH)) {
        return fs.readFileSync(BOOTSTRAP_PATH, 'utf8');
    }
    return null;
}

function loadIdentity() {
    if (fs.existsSync(IDENTITY_PATH)) {
        return fs.readFileSync(IDENTITY_PATH, 'utf8');
    }
    return null;
}

function loadUser() {
    if (fs.existsSync(USER_PATH)) {
        return fs.readFileSync(USER_PATH, 'utf8');
    }
    return null;
}

// ============================================================================
// MEMORY FILES
// ============================================================================

function loadMemory() {
    if (fs.existsSync(MEMORY_PATH)) {
        return fs.readFileSync(MEMORY_PATH, 'utf8');
    }
    return '';
}

function saveMemory(content) {
    fs.writeFileSync(MEMORY_PATH, content, 'utf8');
    log('Memory updated');
}

function getDailyMemoryPath() {
    const date = localDateStr();
    return path.join(MEMORY_DIR, `${date}.md`);
}

function loadDailyMemory() {
    const dailyPath = getDailyMemoryPath();
    if (fs.existsSync(dailyPath)) {
        return fs.readFileSync(dailyPath, 'utf8');
    }
    return '';
}

function appendDailyMemory(content) {
    const dailyPath = getDailyMemoryPath();
    const timestamp = new Date().toLocaleTimeString();
    const entry = `\n## ${timestamp}\n${content}\n`;
    fs.appendFileSync(dailyPath, entry, 'utf8');
    log('Daily memory updated');
}

// ============================================================================
// MEMORY SEARCH (ranked via SQL.js chunks)
// ============================================================================

const STOP_WORDS = new Set(['the','a','an','is','are','was','were','be','been','being',
    'have','has','had','do','does','did','will','would','could','should','may','might',
    'shall','can','to','of','in','for','on','by','at','with','from','as','into','about',
    'that','this','it','i','me','my','we','our','you','your','he','she','they','them',
    'and','or','but','not','no','if','so','what','when','where','how','who','which']);

function searchMemory(query, topK = 5) {
    if (!query) return [];
    topK = Math.max(1, topK || 5);

    // Tokenize query into keywords
    const keywords = query.toLowerCase().split(/\s+/)
        .filter(w => w.length > 2 && !STOP_WORDS.has(w));
    if (keywords.length === 0) keywords.push(query.toLowerCase().trim());

    // Try SQL.js search first
    const db = _getDb();
    if (db && keywords.length > 0) {
        try {
            // Build WHERE clause with AND logic, escape SQL LIKE wildcards
            const escapeLike = (s) => s.replace(/%/g, '\\%').replace(/_/g, '\\_');
            const conditions = keywords.map(() => `LOWER(text) LIKE ? ESCAPE '\\'`);
            const params = keywords.map(k => `%${escapeLike(k)}%`);
            const sql = `SELECT path, start_line, end_line, text, updated_at
                         FROM chunks
                         WHERE ${conditions.join(' AND ')}
                         ORDER BY updated_at DESC
                         LIMIT ?`;
            params.push(topK * 3); // fetch more for scoring

            const rows = db.exec(sql, params);
            if (rows.length > 0 && rows[0].values.length > 0) {
                const results = rows[0].values.map(row => {
                    const [filePath, startLine, endLine, text, updatedAt] = row;
                    // Term frequency score
                    const textLower = text.toLowerCase();
                    let tfScore = 0;
                    for (const kw of keywords) {
                        const matches = textLower.split(kw).length - 1;
                        tfScore += matches;
                    }
                    // Recency score (0-1, newer = higher) with null guard
                    const ts = updatedAt ? new Date(updatedAt).getTime() : 0;
                    const age = Number.isFinite(ts) ? Date.now() - ts : Infinity;
                    const recencyScore = Number.isFinite(age)
                        ? Math.max(0, 1 - age / (30 * 86400000))
                        : 0;

                    const score = tfScore * 0.7 + recencyScore * 0.3;
                    const relPath = path.relative(workDir, filePath) || filePath;

                    return {
                        file: relPath,
                        startLine,
                        endLine,
                        text: text.slice(0, 500),
                        score: Math.round(score * 100) / 100,
                    };
                });

                // Sort by score descending and take topK
                results.sort((a, b) => b.score - a.score);
                return results.slice(0, topK);
            }
        } catch (err) {
            log(`[Memory] Search error, falling back to file scan: ${err.message}`);
        }
    }

    // Fallback: basic file-based search
    const results = [];
    const searchLower = query.toLowerCase();

    if (fs.existsSync(MEMORY_PATH)) {
        const lines = fs.readFileSync(MEMORY_PATH, 'utf8').split('\n');
        lines.forEach((line, idx) => {
            if (line.toLowerCase().includes(searchLower)) {
                results.push({ file: 'MEMORY.md', startLine: idx + 1, endLine: idx + 1,
                    text: line.trim().slice(0, 500), score: 1 });
            }
        });
    }

    if (fs.existsSync(MEMORY_DIR)) {
        for (const f of fs.readdirSync(MEMORY_DIR).filter(f => f.endsWith('.md'))) {
            if (results.length >= topK) break;
            const lines = fs.readFileSync(path.join(MEMORY_DIR, f), 'utf8').split('\n');
            lines.forEach((line, idx) => {
                if (results.length < topK && line.toLowerCase().includes(searchLower)) {
                    results.push({ file: `memory/${f}`, startLine: idx + 1, endLine: idx + 1,
                        text: line.trim().slice(0, 500), score: 0.5 });
                }
            });
        }
    }

    return results.slice(0, topK);
}

// ============================================================================
// HEARTBEAT
// ============================================================================

function updateHeartbeat() {
    const now = new Date();
    const uptime = Math.floor(process.uptime());
    const content = `# Heartbeat

Last updated: ${localTimestamp(now)}
Uptime: ${Math.floor(uptime / 3600)}h ${Math.floor((uptime % 3600) / 60)}m ${uptime % 60}s
Memory: ${Math.round(process.memoryUsage().rss / 1024 / 1024)} MB
Status: Running
`;
    fs.writeFileSync(HEARTBEAT_PATH, content, 'utf8');
}

// Update heartbeat every 5 minutes
setInterval(updateHeartbeat, 5 * 60 * 1000);
updateHeartbeat();

// ============================================================================
// EXPORTS
// ============================================================================

module.exports = {
    setDb,
    BOOTSTRAP_PATH,
    IDENTITY_PATH,
    USER_PATH,
    DEFAULT_SOUL,
    loadSoul,
    loadBootstrap,
    loadIdentity,
    loadUser,
    loadMemory,
    saveMemory,
    getDailyMemoryPath,
    loadDailyMemory,
    appendDailyMemory,
    STOP_WORDS,
    searchMemory,
    updateHeartbeat,
};
