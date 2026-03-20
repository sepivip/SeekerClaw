// tools/skill.js — skill_read, skill_install handlers

const fs = require('fs');
const path = require('path');

const {
    workDir, log, config, SKILLS_DIR,
} = require('../config');

const {
    detectSuspiciousPatterns,
} = require('../security');

const {
    webFetch,
} = require('../web');

const { loadSkills, parseSkillFile } = require('../skills');

const { listFilesRecursive } = require('./file');

// Compare two version strings (semver-like or date-like: "1.2.3", "2026.2.14")
// Returns: >0 if a is newer, <0 if b is newer, 0 if equal
function compareVersions(a, b) {
    const aParts = String(a).replace(/^v/i, '').split('.').map(n => parseInt(n, 10) || 0);
    const bParts = String(b).replace(/^v/i, '').split('.').map(n => parseInt(n, 10) || 0);
    const len = Math.max(aParts.length, bParts.length);
    for (let i = 0; i < len; i++) {
        const diff = (aParts[i] || 0) - (bParts[i] || 0);
        if (diff !== 0) return diff;
    }
    return 0;
}

const tools = [
    {
        name: 'skill_read',
        description: 'Read a skill\'s full instructions, directory path, and list of supporting files. Use this when a skill from <available_skills> applies to the user\'s request. Returns: name, description, instructions, tools, emoji, dir (absolute path to the skill directory), and files (list of supporting file names relative to dir, excluding the main skill file). To read supporting files, use the read tool with workspace-relative paths like "skills/<skill-name>/" + filename.',
        input_schema: {
            type: 'object',
            properties: {
                name: { type: 'string', description: 'Name of the skill to read (from available_skills list)' }
            },
            required: ['name']
        }
    },
    {
        name: 'skill_install',
        description: 'Install or update a skill from a URL or raw markdown content. Parses frontmatter, validates required fields (name, description), checks existing version, and writes to skills/{name}/SKILL.md atomically. The full file content never enters the conversation — only a one-line summary is returned: "Installed {name} v{version} — triggers: {list}". Use this instead of web_fetch + write when installing skills.',
        input_schema: {
            type: 'object',
            properties: {
                url: { type: 'string', description: 'HTTPS URL to fetch the skill markdown from (30s timeout, retries once on transient failure)' },
                content: { type: 'string', description: 'Raw skill markdown content (for direct install without fetching a URL)' },
                force: { type: 'boolean', description: 'If true, install even if the currently installed version is newer. Default false.' }
            }
        }
    },
];

const handlers = {
    async skill_read(input, chatId) {
        const skills = loadSkills();
        const skillName = input.name.toLowerCase();
        const skill = skills.find(s => s.name.toLowerCase() === skillName);

        if (!skill) {
            return { error: `Skill not found: ${input.name}. Use skill name from <available_skills> list.` };
        }

        // Read skill content (supports both directory SKILL.md and flat .md files)
        const skillPath = skill.filePath || path.join(skill.dir, 'SKILL.md');
        if (!fs.existsSync(skillPath)) {
            return { error: `Skill file not found: ${skillPath}` };
        }

        const content = fs.readFileSync(skillPath, 'utf8');

        // List supporting files in the skill directory
        // Only list files for directory-based skills (not flat .md files which share SKILLS_DIR)
        let files = [];
        const isDirectorySkill = skill.filePath && path.basename(skill.filePath) === 'SKILL.md';
        if (isDirectorySkill && skill.dir && fs.existsSync(skill.dir)) {
            try {
                const normalizedSkillPath = path.normalize(skillPath);
                files = listFilesRecursive(skill.dir)
                    .filter(f => path.normalize(f) !== normalizedSkillPath)
                    .map(f => path.relative(skill.dir, f));
            } catch (e) {
                // Non-critical — just skip file listing
            }
        }

        return {
            name: skill.name,
            description: skill.description,
            instructions: skill.instructions || content,
            tools: skill.tools,
            emoji: skill.emoji,
            dir: isDirectorySkill ? skill.dir : null,
            files: files
        };
    },

    async skill_install(input, chatId) {
        const { url, content: rawInput, force = false } = input;

        if ((!url && !rawInput) || (url && rawInput)) {
            return { error: 'Provide exactly one of url or content (not both)' };
        }

        let rawContent;

        const MAX_SKILL_SIZE = 1 * 1024 * 1024; // 1MB limit for skill files

        if (url) {
            // Fetch with 30s timeout, retry once on transient errors
            const TRANSIENT = /timeout|timed out|aborted|ECONNRESET|ETIMEDOUT|Connection closed/i;
            const doFetch = async () => {
                const res = await webFetch(url, { timeout: 30000 });
                if (res.status !== 200) throw new Error(`HTTP ${res.status} from ${url}`);
                const body = typeof res.data === 'string' ? res.data : JSON.stringify(res.data);
                if (body.length > MAX_SKILL_SIZE) {
                    throw new Error(`Skill file too large (${(body.length / 1024).toFixed(0)}KB, max 1MB)`);
                }
                // Detect HTML response — user likely passed a blob URL instead of raw
                if (body.trimStart().startsWith('<')) {
                    throw new Error('URL returned HTML, not markdown. Use the raw file URL instead (e.g. raw.githubusercontent.com)');
                }
                return body;
            };
            try {
                rawContent = await doFetch();
            } catch (firstErr) {
                if (TRANSIENT.test(firstErr.message)) {
                    log(`skill_install: fetch failed (${firstErr.message}), retrying in 1s...`, 'WARN');
                    await new Promise(r => setTimeout(r, 1000));
                    try {
                        rawContent = await doFetch();
                    } catch (secondErr) {
                        return { error: `Failed to fetch skill: ${secondErr.message}` };
                    }
                } else {
                    return { error: `Failed to fetch skill: ${firstErr.message}` };
                }
            }
        } else {
            if (rawInput.length > MAX_SKILL_SIZE) {
                return { error: `Skill content too large (${(rawInput.length / 1024).toFixed(0)}KB, max 1MB)` };
            }
            rawContent = rawInput;
        }

        // Parse skill using existing parser
        const skill = parseSkillFile(rawContent, SKILLS_DIR);

        // Validate required fields
        if (!skill.name) return { error: 'Invalid skill: missing "name" field in frontmatter' };
        if (!skill.description) return { error: 'Invalid skill: missing "description" field in frontmatter' };

        // Safe directory name: lowercase, alphanumeric + hyphens only
        const safeName = skill.name.toLowerCase().replace(/[^a-z0-9\-_]/g, '-').replace(/-+/g, '-').replace(/^-|-$/g, '');
        if (!safeName) return { error: `Invalid skill name: "${skill.name}"` };

        const skillDir = path.join(SKILLS_DIR, safeName);
        const skillFile = path.join(skillDir, 'SKILL.md');

        // Check existing version
        let action = 'installed';
        if (fs.existsSync(skillFile)) {
            try {
                const existingContent = fs.readFileSync(skillFile, 'utf8');
                const existing = parseSkillFile(existingContent, skillDir);

                if (existing.version && skill.version) {
                    const cmp = compareVersions(skill.version, existing.version);
                    if (cmp === 0) {
                        return { result: `Skill "${skill.name}" v${skill.version} already installed (same version — skipped)` };
                    }
                    if (cmp < 0 && !force) {
                        return { result: `Skill "${skill.name}" v${existing.version} already installed. Incoming version (${skill.version}) is older — skipped. Use force:true to downgrade.` };
                    }
                    action = cmp >= 0
                        ? `updated v${existing.version} → v${skill.version}`
                        : `downgraded v${existing.version} → v${skill.version}`;
                } else {
                    action = 'updated';
                }
            } catch (_e) {
                action = 'installed (replaced)';
            }
        }

        // Injection guard: same check as the write tool's skills/ protection
        const suspicious = detectSuspiciousPatterns(rawContent);
        if (suspicious.length > 0) {
            log(`[Security] skill_install blocked — suspicious patterns: ${suspicious.join(', ')}`, 'WARN');
            return { error: `Skill install blocked: suspicious content detected (${suspicious.join(', ')}). Remove the flagged content and retry.` };
        }

        // Atomic write: temp file -> rename
        try {
            if (!fs.existsSync(skillDir)) {
                fs.mkdirSync(skillDir, { recursive: true });
            }
            const tmpFile = skillFile + '.tmp';
            fs.writeFileSync(tmpFile, rawContent, 'utf8');
            fs.renameSync(tmpFile, skillFile);
            log(`skill_install: ${action} — ${safeName}/SKILL.md`, 'INFO');
        } catch (e) {
            return { error: `Failed to write skill: ${e.message}` };
        }

        const versionStr = skill.version ? ` v${skill.version}` : '';
        const triggersStr = skill.triggers.length > 0 ? skill.triggers.join(', ') : '(semantic — uses description matching)';
        return { result: `Skill "${skill.name}"${versionStr} ${action} — triggers: ${triggersStr}` };
    },
};

module.exports = { tools, handlers, compareVersions };
