// SeekerClaw — skills.js
// Skill loading, YAML parsing, matching, and system prompt building.
// Depends on: config.js

const fs = require('fs');
const path = require('path');

const { SKILLS_DIR, log } = require('./config');

// ============================================================================
// SKILLS SYSTEM
// ============================================================================

/**
 * Skill definition loaded from SKILL.md
 *
 * Supported formats:
 *
 * 1. OpenClaw JSON-in-YAML frontmatter:
 * ```
 * ---
 * name: skill-name
 * description: "What it does"
 * metadata: { "openclaw": { "emoji": "🔧", "requires": { "bins": ["curl"] } } }
 * allowed-tools: ["shell_exec"]
 * ---
 * (body is instructions)
 * ```
 *
 * 2. SeekerClaw YAML block frontmatter:
 * ```
 * ---
 * name: skill-name
 * description: "What it does"
 * metadata:
 *   openclaw:
 *     emoji: "🔧"
 *     requires:
 *       bins: ["curl"]
 * ---
 * (body is instructions)
 * ```
 *
 * 3. Legacy markdown (no frontmatter):
 * ```
 * # Skill Name
 * Trigger: keyword1, keyword2
 * ## Description
 * What this skill does
 * ## Instructions
 * How to handle requests matching this skill
 * ## Tools
 * - tool_name: description
 * ```
 */

// ============================================================================
// YAML FRONTMATTER PARSER
// ============================================================================

// Indentation-aware YAML frontmatter parser (no external dependencies)
// Handles: simple key:value, JSON-in-YAML (OpenClaw), and YAML block nesting
function parseYamlFrontmatter(content) {
    return parseYamlLines(content.split('\n'), -1);
}

// Try JSON.parse, with fallback that strips trailing commas (OpenClaw uses them)
function tryJsonParse(text) {
    try { return JSON.parse(text); } catch (e) { /* fall through */ }
    try { return JSON.parse(text.replace(/,\s*([\]}])/g, '$1')); } catch (e) { /* fall through */ }
    return null;
}

// Normalize a value to an array (handles arrays, comma-separated strings, and other types)
function toArray(val) {
    if (Array.isArray(val)) return val;
    if (val == null) return [];
    if (typeof val === 'string') return val ? val.split(',').map(s => s.trim()) : [];
    // Convert other primitives (number, boolean) to single-element array
    return [String(val)];
}

// Recursively parse YAML lines using indentation to detect nesting
function parseYamlLines(lines, parentIndent) {
    const result = {};
    let i = 0;

    while (i < lines.length) {
        const line = lines[i];
        const trimmed = line.trim();

        // Skip empty lines and comments
        if (!trimmed || trimmed.startsWith('#')) { i++; continue; }

        // Stop if we've returned to or past the parent indent level
        const lineIndent = line.search(/\S/);
        if (lineIndent <= parentIndent) break;

        // Find key: value (first colon only)
        const colonIdx = trimmed.indexOf(':');
        if (colonIdx <= 0) { i++; continue; }

        const key = trimmed.slice(0, colonIdx).trim().replace(/^["']|["']$/g, '');
        let value = trimmed.slice(colonIdx + 1).trim();

        // Strip surrounding quotes from value
        if ((value.startsWith('"') && value.endsWith('"')) ||
            (value.startsWith("'") && value.endsWith("'"))) {
            value = value.slice(1, -1);
        }

        // Case 1: JSON value on the same line (e.g., metadata: {"openclaw":...})
        if (value && (value.startsWith('{') || value.startsWith('['))) {
            const parsed = tryJsonParse(value);
            result[key] = parsed !== null ? parsed : value;
            i++;
            continue;
        }

        // Case 2: Non-empty scalar value
        if (value) {
            result[key] = value;
            i++;
            continue;
        }

        // Case 3: Empty value — collect indented child lines
        let j = i + 1;
        const childLines = [];
        while (j < lines.length) {
            const nextLine = lines[j];
            const nextTrimmed = nextLine.trim();
            if (!nextTrimmed) { childLines.push(nextLine); j++; continue; }
            const nextIndent = nextLine.search(/\S/);
            if (nextIndent <= lineIndent) break;
            childLines.push(nextLine);
            j++;
        }

        if (childLines.length > 0) {
            // Try multi-line JSON first (OpenClaw format: metadata:\n  { "openclaw": ... })
            const jsonText = childLines.map(l => l.trim()).filter(Boolean).join(' ');
            if (jsonText.startsWith('{') || jsonText.startsWith('[')) {
                const parsed = tryJsonParse(jsonText);
                if (parsed !== null) {
                    result[key] = parsed;
                    i = j;
                    continue;
                }
            }
            // Check for YAML list items (- value)
            const nonEmpty = childLines.map(l => l.trim()).filter(Boolean);
            if (nonEmpty.length > 0 && nonEmpty.every(l => l.startsWith('- '))) {
                result[key] = nonEmpty.map(l => {
                    let v = l.slice(2).trim();
                    if ((v.startsWith('"') && v.endsWith('"')) ||
                        (v.startsWith("'") && v.endsWith("'"))) {
                        v = v.slice(1, -1);
                    }
                    return v;
                });
                i = j;
                continue;
            }
            // Fall back to recursive YAML block parsing
            result[key] = parseYamlLines(childLines, lineIndent);
        } else {
            result[key] = '';
        }

        i = j;
    }

    return result;
}

// ============================================================================
// SKILL FILE PARSING
// ============================================================================

function parseSkillFile(content, skillDir) {
    const skill = {
        name: '',
        triggers: [],
        description: '',
        instructions: '',
        version: '',
        tools: [],
        emoji: '',
        requires: { bins: [], env: [], config: [] },
        allowedTools: [],
        dir: skillDir
    };

    let body = content;
    let hasFrontmatter = false;

    // Check for YAML frontmatter (OpenClaw format)
    if (content.startsWith('---')) {
        const endIndex = content.indexOf('---', 3);
        if (endIndex > 0) {
            hasFrontmatter = true;
            const yamlContent = content.slice(3, endIndex).trim();
            const frontmatter = parseYamlFrontmatter(yamlContent);

            // Extract OpenClaw-style fields
            if (frontmatter.name) skill.name = frontmatter.name;
            if (frontmatter.description) skill.description = frontmatter.description;
            if (frontmatter.version) skill.version = frontmatter.version;
            if (frontmatter.emoji) skill.emoji = frontmatter.emoji;

            // Handle metadata.openclaw.emoji
            if (frontmatter.metadata?.openclaw?.emoji) {
                skill.emoji = frontmatter.metadata.openclaw.emoji;
            }

            // Handle requires — merge from metadata.openclaw.requires or direct requires
            const reqSource = frontmatter.metadata?.openclaw?.requires || frontmatter.requires;
            if (reqSource) {
                skill.requires.bins = toArray(reqSource.bins);
                skill.requires.env = toArray(reqSource.env);
                skill.requires.config = toArray(reqSource.config);
            }

            // Handle allowed-tools (OpenClaw format)
            if (frontmatter['allowed-tools']) {
                skill.allowedTools = toArray(frontmatter['allowed-tools']);
            }

            // Body is everything after frontmatter
            body = content.slice(endIndex + 3).trim();
        }
    }

    const lines = body.split('\n');
    let currentSection = '';
    let sectionContent = [];

    for (const line of lines) {
        // Parse skill name from # heading (if not set by frontmatter)
        if (line.startsWith('# ') && !skill.name) {
            skill.name = line.slice(2).trim();
            continue;
        }

        // Parse trigger keywords (legacy format, still supported)
        if (line.toLowerCase().startsWith('trigger:')) {
            skill.triggers = line.slice(8).split(',').map(t => t.trim().toLowerCase()).filter(Boolean);
            continue;
        }

        // Detect section headers
        if (line.startsWith('## ')) {
            // Save previous section
            if (currentSection && sectionContent.length > 0) {
                const text = sectionContent.join('\n').trim();
                if (currentSection === 'description' && !skill.description) skill.description = text;
                else if (currentSection === 'instructions') skill.instructions = text;
                else if (currentSection === 'tools') {
                    skill.tools = text.split('\n')
                        .filter(l => l.trim().startsWith('-'))
                        .map(l => l.slice(l.indexOf('-') + 1).trim());
                }
            }
            currentSection = line.slice(3).trim().toLowerCase();
            sectionContent = [];
            continue;
        }

        // Accumulate section content
        if (currentSection) {
            sectionContent.push(line);
        }
    }

    // Save last section
    if (currentSection && sectionContent.length > 0) {
        const text = sectionContent.join('\n').trim();
        if (currentSection === 'description' && !skill.description) skill.description = text;
        else if (currentSection === 'instructions') skill.instructions = text;
        else if (currentSection === 'tools') {
            skill.tools = text.split('\n')
                .filter(l => l.trim().startsWith('-'))
                .map(l => l.slice(l.indexOf('-') + 1).trim());
        }
    }

    // If frontmatter was successfully parsed but body had no ## Instructions section,
    // treat the entire body as instructions (OpenClaw-style: body IS the instructions)
    if (hasFrontmatter && !skill.instructions && body.trim()) {
        skill.instructions = body.trim();
    }

    return skill;
}

// ============================================================================
// SKILL VALIDATION & LOADING
// ============================================================================

const _skillWarningsLogged = new Set();
function validateSkillFormat(skill, filePath) {
    if (_skillWarningsLogged.has(filePath)) return;
    const warnings = [];
    if (!skill.name) warnings.push('missing "name"');
    if (!skill.description) warnings.push('missing "description"');
    if (!skill.version) warnings.push('missing "version" — add version field for auto-update support');
    if (skill.triggers.length > 0 && skill.description) {
        warnings.push('has legacy "Trigger:" line — description-based matching preferred');
    }
    if (warnings.length > 0) {
        _skillWarningsLogged.add(filePath);
        log(`Skill format warning (${path.basename(filePath)}): ${warnings.join(', ')}`, 'WARN');
    }
}

let _firstLoadLogged = false;

function loadSkills() {
    const skills = [];
    const isFirstLoad = !_firstLoadLogged;

    if (!fs.existsSync(SKILLS_DIR)) {
        return skills;
    }

    let dirCount = 0, fileCount = 0;

    try {
        const entries = fs.readdirSync(SKILLS_DIR, { withFileTypes: true });

        for (const entry of entries) {
            if (entry.isDirectory()) {
                // OpenClaw format: directory with SKILL.md inside
                const skillPath = path.join(SKILLS_DIR, entry.name, 'SKILL.md');
                if (fs.existsSync(skillPath)) {
                    try {
                        const content = fs.readFileSync(skillPath, 'utf8');
                        const skill = parseSkillFile(content, path.join(SKILLS_DIR, entry.name));
                        validateSkillFormat(skill, skillPath);
                        if (skill.name) {
                            skill.filePath = skillPath;
                            skills.push(skill);
                            dirCount++;
                            if (isFirstLoad) log(`Loaded skill: ${skill.name} (triggers: ${skill.triggers.join(', ')})`, 'DEBUG');
                        }
                    } catch (e) {
                        log(`Error loading skill ${entry.name}: ${e.message}`, 'ERROR');
                    }
                }
            } else if (entry.isFile() && entry.name.endsWith('.md')) {
                // Flat .md skill files (SeekerClaw format)
                const filePath = path.join(SKILLS_DIR, entry.name);
                try {
                    const content = fs.readFileSync(filePath, 'utf8');
                    const skill = parseSkillFile(content, SKILLS_DIR);
                    validateSkillFormat(skill, filePath);
                    if (skill.name) {
                        skill.filePath = filePath;
                        skills.push(skill);
                        fileCount++;
                        if (isFirstLoad) log(`Loaded skill: ${skill.name} (triggers: ${skill.triggers.join(', ')})`, 'DEBUG');
                    }
                } catch (e) {
                    log(`Error loading skill ${entry.name}: ${e.message}`, 'ERROR');
                }
            }
        }
    } catch (e) {
        log(`Error reading skills directory: ${e.message}`, 'ERROR');
    }

    if (isFirstLoad && skills.length > 0) {
        log(`[Skills] ${skills.length} skills loaded (${dirCount} dir, ${fileCount} flat)`, 'INFO');
        _firstLoadLogged = true;
    }

    return skills;
}

// ============================================================================
// SKILL MATCHING & PROMPT BUILDING
// ============================================================================

function findMatchingSkills(message) {
    const skills = loadSkills();
    const lowerMsg = message.toLowerCase();

    const matched = [];
    for (const skill of skills) {
        if (matched.length >= 2) break;

        const hasTrigger = skill.triggers.some(trigger => {
            // Multi-word triggers: substring match is fine
            if (trigger.includes(' ')) return lowerMsg.includes(trigger);
            // Single-word triggers: require word boundary
            const regex = new RegExp(`\\b${trigger.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`, 'i');
            return regex.test(message);
        });

        if (hasTrigger) matched.push(skill);
    }

    return matched;
}

function buildSkillsSection(skills) {
    if (skills.length === 0) return '';

    const lines = ['## Active Skills', ''];
    lines.push('The following skills are available and may be relevant to this request:');
    lines.push('');

    for (const skill of skills) {
        lines.push(`### ${skill.name}`);
        if (skill.description) {
            lines.push(skill.description);
        }
        lines.push('');
        if (skill.instructions) {
            lines.push('**Instructions:**');
            lines.push(skill.instructions);
            lines.push('');
        }
        if (skill.tools.length > 0) {
            lines.push('**Recommended tools:** ' + skill.tools.join(', '));
            lines.push('');
        }
    }

    return lines.join('\n');
}

// ============================================================================
// EXPORTS
// ============================================================================

module.exports = {
    loadSkills,
    findMatchingSkills,
    parseSkillFile,
};
