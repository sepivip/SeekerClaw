// tools/notebook.js — Notebook Knowledge Layer (BAT-991 v1.1)
//
// The notebook is the agent's record of NAMED ENTITIES in the user's world
// (people, projects, tokens, places, topics, tools). It lives at
// workspace/notebook/<category>/<entity>.md as plain markdown + YAML
// frontmatter — Obsidian-compatible by accident, not by design.
//
// v1 scope (per spec):
//   - EXPLICIT-ONLY creation. The agent calls notebook_save only when the
//     user clearly asks ("remember…", "save…", "note that X is Y", "add to
//     notebook"). No auto-population from passing references. No background
//     scanner. No prompt-trigger heuristic.
//   - SEARCH-BEFORE-CREATE. notebook_save reads any existing page at the
//     same path, preserves its frontmatter (updating only `updated`), and
//     APPENDS new content rather than overwriting.
//   - SOURCE filter on search via parameterized SQL.js binding.
//   - Routing-debug log lines prefixed `[notebook-route]` for the system
//     prompt rubric to be iterated against real traffic.

const fs = require('fs');
const path = require('path');

const {
    workDir, log, localDateStr,
} = require('../config');

const {
    redactSecrets, safePath,
} = require('../security');

const { searchMemory } = require('../memory');
const { getDb, indexMemoryFiles } = require('../database');

// ─── Constants ───────────────────────────────────────────────────────────────

const NOTEBOOK_DIR = path.join(workDir, 'notebook');
const DEFAULT_CATEGORY = 'topics';
// Seed categories — the agent MAY create new ones, but should prefer these
// to avoid category fragmentation (`family/` vs `people/` for similar
// entities). The list is in the rubric in ai.js too.
const SEED_CATEGORIES = ['people', 'projects', 'crypto', 'places', 'topics', 'tools'];

// ─── Frontmatter helpers ─────────────────────────────────────────────────────
//
// Manual minimal YAML — only the 5 simple fields the spec requires, no
// nested objects, no anchors, no folded scalars. Avoids adding a dep
// (js-yaml) for what is essentially a key:value sandwich between `---`
// markers. If a page contains frontmatter we did not write (e.g. user
// edited it in Obsidian and added fields), we round-trip unknown keys
// verbatim — they're treated as opaque string values and preserved
// during merge so user-added metadata isn't silently dropped.

function _quoteIfNeeded(s) {
    if (s == null) return '';
    const str = String(s);
    // Quote if contains chars YAML would interpret as structural.
    if (/^[a-zA-Z0-9_\-./ :]+$/.test(str) && !/^\s|\s$/.test(str)) return str;
    return JSON.stringify(str); // JSON strings are valid YAML flow scalars
}

function _formatArray(arr) {
    if (!Array.isArray(arr)) return '[]';
    if (arr.length === 0) return '[]';
    return '[' + arr.map(v => _quoteIfNeeded(v)).join(', ') + ']';
}

function serializeFrontmatter(fm) {
    const lines = ['---'];
    // Required keys in canonical order
    lines.push(`title: ${_quoteIfNeeded(fm.title)}`);
    lines.push(`category: ${_quoteIfNeeded(fm.category)}`);
    lines.push(`created: ${_quoteIfNeeded(fm.created)}`);
    lines.push(`updated: ${_quoteIfNeeded(fm.updated)}`);
    // Optional but conventionally present
    if (fm.tags !== undefined) {
        lines.push(`tags: ${_formatArray(fm.tags)}`);
    }
    if (Array.isArray(fm.related) && fm.related.length > 0) {
        lines.push(`related: ${_formatArray(fm.related)}`);
    }
    // Preserve any unknown keys verbatim (user-added in Obsidian).
    const known = new Set(['title', 'category', 'created', 'updated', 'tags', 'related']);
    for (const k of Object.keys(fm)) {
        if (known.has(k)) continue;
        const v = fm[k];
        if (Array.isArray(v)) {
            lines.push(`${k}: ${_formatArray(v)}`);
        } else if (v && typeof v === 'object') {
            // Best effort — JSON-encode unknown nested objects.
            lines.push(`${k}: ${JSON.stringify(v)}`);
        } else {
            lines.push(`${k}: ${_quoteIfNeeded(v)}`);
        }
    }
    lines.push('---');
    return lines.join('\n');
}

function _parseScalar(raw) {
    if (raw == null) return '';
    const s = raw.trim();
    if (!s) return '';
    // JSON-quoted scalar
    if ((s.startsWith('"') && s.endsWith('"')) || (s.startsWith("'") && s.endsWith("'"))) {
        try { return JSON.parse(s.replace(/^'|'$/g, '"')); } catch (_) { return s.slice(1, -1); }
    }
    return s;
}

function _parseArray(raw) {
    if (raw == null) return [];
    const s = raw.trim();
    if (!s || s === '[]') return [];
    if (s.startsWith('[') && s.endsWith(']')) {
        const inner = s.slice(1, -1).trim();
        if (!inner) return [];
        // Naive comma split — YAML flow arrays don't allow unquoted commas,
        // and our values are simple strings.
        return inner.split(',').map(part => _parseScalar(part)).filter(v => v !== '');
    }
    return [s];
}

/**
 * Parse markdown content into { frontmatter, body }. If no frontmatter is
 * present, returns frontmatter: null and body = original content.
 */
function parseFrontmatter(content) {
    if (typeof content !== 'string') return { frontmatter: null, body: '' };
    const fmMatch = content.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n?/);
    if (!fmMatch) return { frontmatter: null, body: content };

    const yaml = fmMatch[1];
    const body = content.slice(fmMatch[0].length);
    const fm = {};
    for (const line of yaml.split(/\r?\n/)) {
        if (!line.trim() || /^\s*#/.test(line)) continue;
        const m = line.match(/^([a-zA-Z_][a-zA-Z0-9_-]*)\s*:\s*(.*)$/);
        if (!m) continue;
        const key = m[1];
        const rawVal = m[2];
        if (key === 'tags' || key === 'related') {
            fm[key] = _parseArray(rawVal);
        } else {
            fm[key] = _parseScalar(rawVal);
        }
    }
    return { frontmatter: fm, body };
}

// ─── Path & input sanitation ─────────────────────────────────────────────────

/**
 * Normalize a single path segment (category or page name) so it's safe to
 * use as a filesystem name. Lowercases, replaces whitespace with `-`,
 * strips anything that isn't alnum/dash/underscore. Returns null if the
 * result is empty (caller must reject).
 */
function _slugify(s) {
    if (s == null) return null;
    const slug = String(s).trim().toLowerCase()
        .replace(/[\\/]+/g, '-')        // path separators -> dash
        .replace(/\s+/g, '-')           // whitespace -> dash
        .replace(/[^a-z0-9\-_]/g, '')   // strip anything else
        .replace(/-+/g, '-')            // collapse repeated dashes
        .replace(/^-+|-+$/g, '');       // trim leading/trailing dashes
    return slug || null;
}

/**
 * Resolve a notebook page path to an absolute filesystem path. Accepts
 * either:
 *   - { category, name } — preferred form for notebook_save
 *   - { path: 'notebook/people/mom.md' } — raw path (still validated via
 *     safePath against workDir)
 * Returns { abs, rel, category, name } or { error } on failure.
 */
function resolvePagePath({ category, name, path: rawPath }) {
    if (rawPath) {
        // Normalize: strip leading slash, require notebook/ prefix, force .md
        let rel = String(rawPath).trim().replace(/^\/+/, '');
        if (!rel.startsWith('notebook/')) {
            return { error: 'path must start with "notebook/"' };
        }
        if (!rel.endsWith('.md')) rel = rel + '.md';
        const abs = safePath(rel);
        if (!abs) return { error: 'Access denied: path outside workspace' };
        // Derive category + name for log + frontmatter defaults
        const parts = rel.split('/').filter(Boolean);
        const derivedCategory = parts.length >= 3 ? parts[1] : DEFAULT_CATEGORY;
        const derivedName = parts[parts.length - 1].replace(/\.md$/i, '');
        return { abs, rel, category: derivedCategory, name: derivedName };
    }
    const cat = _slugify(category || DEFAULT_CATEGORY) || DEFAULT_CATEGORY;
    const nm = _slugify(name);
    if (!nm) return { error: 'name is required (and must contain at least one alphanumeric character)' };
    const rel = path.posix.join('notebook', cat, nm + '.md');
    const abs = safePath(rel);
    if (!abs) return { error: 'Access denied: path outside workspace' };
    return { abs, rel, category: cat, name: nm };
}

// ─── Routing debug log ───────────────────────────────────────────────────────
//
// Per spec: every save logs which tool was chosen, the triggering user
// message (truncated to ~200 chars), and whether the page already existed.
// Grep `[notebook-route]` in node_debug.log to iterate the routing rubric
// against real traffic.

function logRoute({ tool, userMessage, considered, pageExisted, pageRel }) {
    const truncMsg = userMessage
        ? String(userMessage).replace(/\s+/g, ' ').slice(0, 200)
        : '(no user message in context)';
    const consideredStr = Array.isArray(considered) && considered.length
        ? considered.join(',') : 'none';
    log(
        `[notebook-route] tool=${tool} ` +
        `existed=${pageExisted ? 'yes' : 'no'} ` +
        `page=${pageRel || '-'} ` +
        `considered=${consideredStr} ` +
        `trigger="${truncMsg}"`,
        'DEBUG'
    );
}

// ─── Tool definitions ────────────────────────────────────────────────────────

const tools = [
    {
        name: 'notebook_save',
        description:
            'Save a durable fact about a named entity in the user\'s world — a person, place, project, token, or topic with a one- or two-word name. ' +
            'Pages live under workspace/notebook/<category>/<entity>.md as markdown + YAML frontmatter, and are indexed into the SQL search DB (source="notebook"). ' +
            'Search first (notebook_search or memory_search) — if a page exists at the same path, the tool reads + merges + saves rather than overwriting (frontmatter preserved, content appended). ' +
            'Do NOT use this for the user\'s own preferences (use memory_save) or for events with no entity (use daily_note). ' +
            'v1 explicit-only rule: only call this when the user clearly asks ("remember that…", "save this…", "note that X is Y", "add to notebook…"). Do NOT auto-create pages from passing references during conversation. ' +
            'Secrets policy: never store API keys, private keys, seed phrases, passwords, OAuth tokens, or auth headers in notebook pages — notebook content lives in plain text on disk and is indexed into the searchable database. For API keys the user provides in chat, save to agent_settings.json under apiKeys.<service>; for higher-risk secrets (seed phrases, private keys, etc.), direct the user to the Settings UI. Credentials belong in Settings → Env Vars.',
        input_schema: {
            type: 'object',
            properties: {
                name: { type: 'string', description: 'One- or two-word entity name (e.g. "Mom", "Solana", "Tbilisi"). Used as both the page title and the slugified filename.' },
                category: { type: 'string', description: 'Category folder. Seed categories: people, projects, crypto, places, topics, tools. May create new top-level categories if the entity does not fit, but prefer the seed list. Defaults to "topics".' },
                content: { type: 'string', description: 'Markdown body to add to the page. On a new page, becomes the body. On an existing page, is APPENDED below current content (no overwrite).' },
                tags: { type: 'array', items: { type: 'string' }, description: 'Optional tags. Pass [] if no tags are known so the field is present and consistent across pages.' },
                related: { type: 'array', items: { type: 'string' }, description: 'Optional array of related notebook page paths (e.g. ["notebook/people/dad.md"]). Only include when you have a clear cross-reference to record.' },
                path: { type: 'string', description: 'Optional explicit page path (e.g. "notebook/people/mom.md"). Use when updating a page you already discovered via notebook_search. If omitted, the path is derived from name + category.' },
                user_message: { type: 'string', description: 'Optional — the user message that triggered the save. Used only for the [notebook-route] debug log so the maintainer can iterate the routing rubric.' },
                considered: { type: 'array', items: { type: 'string' }, description: 'Optional — list any other save tools you considered (memory_save, daily_note). Helps the routing audit.' }
            },
            required: ['name', 'content']
        }
    },
    {
        name: 'notebook_read',
        description:
            'Read a specific notebook page by path. Returns full content including frontmatter. ' +
            'Use before notebook_save when updating an existing page so the merge has the current state.',
        input_schema: {
            type: 'object',
            properties: {
                path: { type: 'string', description: 'Notebook page path (e.g. "notebook/people/mom.md"). Must live under workspace/notebook/.' }
            },
            required: ['path']
        }
    },
    {
        name: 'notebook_search',
        description:
            'Search notebook pages by keyword or tag. Returns ranked notebook-only results (source="notebook"). ' +
            'For cross-bucket search across notebook + MEMORY + daily notes, use memory_search instead.',
        input_schema: {
            type: 'object',
            properties: {
                query: { type: 'string', description: 'Search term or pattern' },
                max_results: { type: 'number', description: 'Maximum results to return (default 10)' }
            },
            required: ['query']
        }
    },
    {
        name: 'notebook_delete',
        description:
            'Remove a notebook page by path. Also removes it from the search index on the next index pass. ' +
            'Use when the user explicitly asks to forget an entity, or when a merge produced a duplicate that should be consolidated. ' +
            'Log the reason to today\'s daily note via daily_note so the deletion is auditable.',
        input_schema: {
            type: 'object',
            properties: {
                path: { type: 'string', description: 'Notebook page path (e.g. "notebook/people/mom.md").' },
                reason: { type: 'string', description: 'Optional one-line reason for the deletion (appears in the debug log).' }
            },
            required: ['path']
        }
    },
];

// ─── Handlers ────────────────────────────────────────────────────────────────

const handlers = {
    async notebook_save(input, chatId) {
        const resolved = resolvePagePath({
            category: input.category,
            name: input.name,
            path: input.path,
        });
        if (resolved.error) return { error: resolved.error };

        const { abs, rel, category, name } = resolved;
        // Redact secrets defensively — the description tells the agent NOT
        // to pass credentials, but redaction is the belt to the prompt's
        // braces (parity with memory_save / daily_note).
        const content = redactSecrets(String(input.content ?? '')).trim();
        if (!content) {
            return { error: 'content is empty after redaction — nothing to save' };
        }

        // Ensure parent dir exists. fs.mkdir recursive is idempotent and
        // safe to call on every save — no need to check existence first.
        try {
            fs.mkdirSync(path.dirname(abs), { recursive: true });
        } catch (e) {
            return { error: `Could not create notebook directory: ${e.message}` };
        }

        const today = localDateStr();
        let pageExisted = false;
        let merged;

        if (fs.existsSync(abs)) {
            pageExisted = true;
            const raw = fs.readFileSync(abs, 'utf8');
            const { frontmatter, body } = parseFrontmatter(raw);
            // Preserve existing frontmatter; only update `updated`. If the
            // caller passed new tags/related, MERGE them (de-duped) into
            // the existing arrays rather than replacing — overwriting a
            // user-curated tag list with the agent's narrower set would
            // silently lose metadata.
            const fm = Object.assign(
                {
                    title: name,
                    category,
                    created: today,
                    tags: [],
                },
                frontmatter || {}
            );
            fm.updated = today;
            if (Array.isArray(input.tags) && input.tags.length) {
                const have = new Set((fm.tags || []).map(String));
                for (const t of input.tags) if (t && !have.has(String(t))) {
                    fm.tags = fm.tags || [];
                    fm.tags.push(t);
                    have.add(String(t));
                }
            } else if (!Array.isArray(fm.tags)) {
                fm.tags = [];
            }
            if (Array.isArray(input.related) && input.related.length) {
                fm.related = fm.related || [];
                const have = new Set(fm.related.map(String));
                for (const r of input.related) if (r && !have.has(String(r))) {
                    fm.related.push(r);
                    have.add(String(r));
                }
            }

            // Append new content under a dated section so merges over time
            // remain readable. The agent can collapse/clean these later.
            const cleanBody = (body || '').replace(/\s+$/, '');
            const appended = `${cleanBody}\n\n## Update — ${today}\n\n${content}\n`;
            merged = `${serializeFrontmatter(fm)}\n\n${appended}`;
        } else {
            const fm = {
                title: input.name,
                category,
                created: today,
                updated: today,
                tags: Array.isArray(input.tags) ? input.tags : [],
            };
            if (Array.isArray(input.related) && input.related.length) {
                fm.related = input.related;
            }
            // Title heading is conventional but cheap; agent may delete it.
            merged = `${serializeFrontmatter(fm)}\n\n# ${input.name}\n\n${content}\n`;
        }

        try {
            fs.writeFileSync(abs, merged, 'utf8');
        } catch (e) {
            return { error: `Could not write notebook page: ${e.message}` };
        }

        logRoute({
            tool: 'notebook_save',
            userMessage: input.user_message,
            considered: input.considered,
            pageExisted,
            pageRel: rel,
        });

        // Re-index so the new/updated page shows up in search immediately.
        try { indexMemoryFiles(); } catch (_) { /* indexer is best-effort */ }

        return {
            success: true,
            path: rel,
            category,
            merged: pageExisted,
            message: pageExisted
                ? `Updated existing notebook page ${rel} (content appended, frontmatter preserved)`
                : `Created new notebook page ${rel}`,
        };
    },

    async notebook_read(input, chatId) {
        if (!input.path) return { error: 'path is required' };
        const rel = String(input.path).trim().replace(/^\/+/, '');
        if (!rel.startsWith('notebook/')) {
            return { error: 'path must start with "notebook/"' };
        }
        const abs = safePath(rel);
        if (!abs) return { error: 'Access denied: path outside workspace' };
        if (!fs.existsSync(abs)) {
            return { error: `Notebook page not found: ${rel}` };
        }
        const content = fs.readFileSync(abs, 'utf8');
        const { frontmatter, body } = parseFrontmatter(content);
        return {
            path: rel,
            frontmatter: frontmatter || null,
            content,
            body,
        };
    },

    async notebook_search(input, chatId) {
        const maxResults = input.max_results || 10;
        const results = searchMemory(input.query, maxResults, { source: 'notebook' });
        return {
            query: input.query,
            source: 'notebook',
            count: results.length,
            results,
        };
    },

    async notebook_delete(input, chatId) {
        if (!input.path) return { error: 'path is required' };
        const rel = String(input.path).trim().replace(/^\/+/, '');
        if (!rel.startsWith('notebook/')) {
            return { error: 'path must start with "notebook/"' };
        }
        const abs = safePath(rel);
        if (!abs) return { error: 'Access denied: path outside workspace' };
        if (!fs.existsSync(abs)) {
            return { error: `Notebook page not found: ${rel}` };
        }
        try {
            fs.unlinkSync(abs);
        } catch (e) {
            return { error: `Could not delete notebook page: ${e.message}` };
        }
        // Best-effort: also drop chunks for this path from the index now,
        // rather than waiting for the next indexMemoryFiles pass to notice
        // the missing file. (indexMemoryFiles itself does not currently
        // garbage-collect rows for deleted files; this is the cheapest
        // safety net.)
        const db = getDb();
        if (db) {
            try {
                db.run(`DELETE FROM chunks WHERE path = ?`, [abs]);
                db.run(`DELETE FROM files  WHERE path = ?`, [abs]);
            } catch (_) { /* non-fatal */ }
        }
        log(
            `[notebook-route] tool=notebook_delete page=${rel} ` +
            `reason="${String(input.reason || '').slice(0, 200)}"`,
            'DEBUG'
        );
        return { success: true, path: rel, message: `Deleted notebook page ${rel}` };
    },
};

module.exports = {
    tools,
    handlers,
    // Exposed for tests and any future internal consumer (e.g. backfill in v1.5)
    parseFrontmatter,
    serializeFrontmatter,
    resolvePagePath,
    NOTEBOOK_DIR,
    SEED_CATEGORIES,
};
