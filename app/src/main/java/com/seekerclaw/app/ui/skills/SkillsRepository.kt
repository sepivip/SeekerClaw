package com.seekerclaw.app.ui.skills

import android.util.Log
import java.io.File
import java.security.MessageDigest

object SkillsRepository {

    private const val TAG = "SkillsRepository"

    fun loadSkills(
        workspaceDir: File,
        defaultSkillNames: Set<String> = emptySet(),
        defaultSkillHashes: Map<String, String> = emptyMap(),
    ): List<SkillInfo> {
        val skillsDir = File(workspaceDir, "skills")
        if (!skillsDir.exists()) {
            // Keep the registry consistent with "no skills loaded" — otherwise
            // a stale requirements map from a prior load would still drive
            // red-dot badges on the (now-empty) Skills screen.
            com.seekerclaw.app.config.EnvVarRegistry.setSkillRequirements(emptyMap())
            return emptyList()
        }

        val result = mutableListOf<SkillInfo>()
        skillsDir.listFiles()
            ?.sortedBy { it.name }
            ?.forEach { entry ->
                when {
                    entry.isDirectory -> {
                        val skillFile = File(entry, "SKILL.md")
                        if (skillFile.exists()) {
                            runCatching { skillFile.readText() }
                                .onFailure { e -> Log.w(TAG, "Failed to read ${skillFile.path}: ${e.message}") }
                                .getOrNull()
                                ?.let { content ->
                                    parseSkillFile(content, entry.name, skillFile.absolutePath)?.let { skill ->
                                        val isDefault = entry.name in defaultSkillNames
                                        val isModified = if (isDefault) {
                                            val expectedHash = defaultSkillHashes[entry.name]
                                            if (expectedHash != null) computeHash(content) != expectedHash else false
                                        } else false
                                        result.add(skill.copy(isDefault = isDefault, isModifiedDefault = isModified))
                                    }
                                }
                        }
                    }
                    entry.isFile && entry.name.endsWith(".md") -> {
                        runCatching { entry.readText() }
                            .onFailure { e -> Log.w(TAG, "Failed to read ${entry.path}: ${e.message}") }
                            .getOrNull()
                            ?.let { parseSkillFile(it, entry.nameWithoutExtension, entry.absolutePath) }
                            ?.let { result.add(it) } // Flat files are never default
                    }
                }
            }
        val sorted = result.sortedBy { it.name.lowercase() }
        // Feed the skill ↔ env reverse index so EnvVarsScreen/SkillsScreen can
        // surface missing vars without re-parsing frontmatter.
        val requirementsMap: Map<String, List<String>> = sorted
            .filter { it.requiresEnv.isNotEmpty() }
            .associate { it.dirName to it.requiresEnv }
        com.seekerclaw.app.config.EnvVarRegistry.setSkillRequirements(requirementsMap)
        return sorted
    }

    private fun computeHash(content: String): String {
        val digest = MessageDigest.getInstance("SHA-256")
        val bytes = digest.digest(content.toByteArray(Charsets.UTF_8))
        return bytes.joinToString("") { "%02x".format(it) }
    }

    private fun parseSkillFile(content: String, dirName: String, filePath: String): SkillInfo? {
        val fm = parseFrontmatter(content)
        val name = (fm["name"] as? String)?.trim()?.takeIf { it.isNotEmpty() }
            ?: extractHeading(content)
            ?: run { Log.w(TAG, "Skipping skill '$filePath': no name found"); return null }
        val description = (fm["description"] as? String)?.trim() ?: ""
        val version = (fm["version"] as? String)?.trim() ?: ""
        val emoji = (fm["emoji"] as? String)?.trim()?.takeIf { it.isNotEmpty() }
            ?: extractFrontmatterLine(content, "emoji")
        val imageUrl = (fm["image"] as? String)?.trim()?.takeIf {
            it.startsWith("https://") || it.startsWith("http://")
        } ?: ""
        @Suppress("UNCHECKED_CAST")
        val triggers: List<String> = when (val t = fm["triggers"]) {
            is List<*> -> (t as? List<String>)
                ?.map { it.trim().lowercase() }
                ?.filter { it.isNotEmpty() }
                ?: emptyList()
            is String -> t.split(',').map { it.trim().lowercase() }.filter { it.isNotEmpty() }
            else -> extractBodyTriggers(content)
        }
        val requiresEnv: List<String> = parseRequiresEnv(content)
        val warnings = validateSkillFormat(description, version, triggers, content)
        return SkillInfo(
            name = name,
            description = description,
            version = version,
            emoji = emoji,
            triggers = triggers,
            filePath = filePath,
            dirName = dirName,
            warnings = warnings,
            imageUrl = imageUrl,
            requiresEnv = requiresEnv,
        )
    }

    /**
     * Minimal YAML frontmatter parser. Returns a map where values are either
     * String (scalar) or List<String> (sequence). Handles:
     * - Simple scalars:  key: value
     * - Inline sequences: triggers: [hello, test]
     * - Block sequences:  triggers:\n  - hello\n  - test
     */
    private val POSIX_ENV_NAME = Regex("^[A-Z_][A-Z0-9_]*$")

    /**
     * Extract `requires.env` env var names from skill frontmatter.
     *
     * Handles both layouts in real skill frontmatter:
     *   (a) top-level: `requires:\n  env:\n    - KEY` (or flow `env: [KEY, KEY]`)
     *   (b) nested:    `metadata:\n  openclaw:\n    requires:\n      env: [...]`
     *
     * The flow form (`env: [A, B]`) is the one used by bundled SeekerClaw skills
     * (e.g. default-skills/github/SKILL.md); the block form matches the
     * OpenClaw-canonical shape. Both parse to the same list.
     *
     * The final POSIX-name filter acts as a safety net — any accidentally-matched
     * `env:` key elsewhere in the YAML is discarded unless items look like env vars.
     */
    private fun parseRequiresEnv(content: String): List<String> {
        if (!content.startsWith("---")) return emptyList()
        val endIdx = content.indexOf("---", 3)
        if (endIdx < 0) return emptyList()
        val frontmatter = content.substring(3, endIdx)

        // Scan every `env:` occurrence and try both inline-flow and block-list forms.
        // Earlier matches win (shallower is more canonical), but any match with valid
        // items is returned.
        val envKeyRegex = Regex("(?m)^[ \\t]*env:\\s*(.*)$")
        for (match in envKeyRegex.findAll(frontmatter)) {
            val after = match.groupValues[1].trim()

            // Inline flow form: `env: [KEY, "KEY2"]` (possibly empty `env: []`)
            if (after.startsWith("[")) {
                val close = after.indexOf(']')
                if (close >= 0) {
                    val items = after.substring(1, close)
                        .split(',')
                        .map { it.trim().trim('"', '\'') }
                        .filter { it.isNotEmpty() && POSIX_ENV_NAME.matches(it) }
                    if (items.isNotEmpty()) return items
                    // `env: []` is an explicit empty — skip to next candidate
                    continue
                }
            }

            // Block-list form — the value is empty on this line; following indented
            // `- KEY` lines hold the items. Collect consecutive `- ...` lines.
            if (after.isEmpty()) {
                val lineEnd = frontmatter.indexOf('\n', match.range.last)
                if (lineEnd < 0) continue
                val tail = frontmatter.substring(lineEnd + 1)
                val items = tail.lineSequence()
                    .takeWhile { line ->
                        val t = line.trim()
                        t.startsWith("-") || t.isEmpty()
                    }
                    .mapNotNull { line ->
                        val t = line.trim()
                        if (!t.startsWith("-")) return@mapNotNull null
                        t.removePrefix("-").trim().trim('"', '\'').takeIf { it.isNotEmpty() }
                    }
                    .filter { POSIX_ENV_NAME.matches(it) }
                    .toList()
                if (items.isNotEmpty()) return items
                // Block form with no items — keep scanning (might be `requires.env: []`
                // at top level and another non-empty env elsewhere in the same file)
            }
        }
        return emptyList()
    }

    private fun parseFrontmatter(content: String): Map<String, Any> {
        if (!content.startsWith("---")) return emptyMap()
        val endIdx = content.indexOf("---", 3)
        if (endIdx < 0) return emptyMap()

        val lines = content.substring(3, endIdx).lines()
        val result = mutableMapOf<String, Any>()
        var i = 0

        while (i < lines.size) {
            val line = lines[i]
            val trimmed = line.trim()
            if (trimmed.isEmpty() || trimmed.startsWith('#')) { i++; continue }

            val colonIdx = trimmed.indexOf(':')
            if (colonIdx <= 0) { i++; continue }

            val key = trimmed.substring(0, colonIdx).trim()
            val rawValue = trimmed.substring(colonIdx + 1).trim()
            val baseIndent = line.indexOfFirst { !it.isWhitespace() }.coerceAtLeast(0)

            if (rawValue.isEmpty()) {
                // Collect indented child lines
                val children = mutableListOf<String>()
                i++
                while (i < lines.size) {
                    val child = lines[i]
                    val childTrimmed = child.trim()
                    if (childTrimmed.isEmpty()) { i++; continue }
                    val childIndent = child.indexOfFirst { !it.isWhitespace() }.coerceAtLeast(0)
                    if (childIndent <= baseIndent) break
                    children.add(child)
                    i++
                }
                val items = children.map { it.trim() }.filter { it.isNotEmpty() }
                if (items.isNotEmpty() && items.all { it.startsWith("- ") }) {
                    result[key] = items.map {
                        it.substring(2).trim().removeSurrounding("\"").removeSurrounding("'")
                    }
                }
                continue
            }

            when {
                rawValue.startsWith('[') -> {
                    val inner = if (rawValue.endsWith(']'))
                        rawValue.substring(1, rawValue.length - 1)
                    else
                        rawValue.removePrefix("[")
                    result[key] = inner.split(',')
                        .map { it.trim().removeSurrounding("\"").removeSurrounding("'") }
                        .filter { it.isNotEmpty() }
                }
                rawValue.startsWith('{') -> { /* skip JSON objects */ }
                else -> result[key] = rawValue.removeSurrounding("\"").removeSurrounding("'")
            }
            i++
        }
        return result
    }

    /** Scan the raw frontmatter block for any line containing `key:`, regardless of nesting depth. */
    private fun extractFrontmatterLine(content: String, key: String): String {
        if (!content.startsWith("---")) return ""
        val endIdx = content.indexOf("---", 3)
        if (endIdx < 0) return ""
        return content.substring(3, endIdx).lines()
            .firstOrNull { it.trim().startsWith("$key:") }
            ?.substringAfter(':')?.trim()
            ?.removeSurrounding("\"")?.removeSurrounding("'")
            ?: ""
    }

    private fun extractHeading(content: String): String? {
        val body = if (content.startsWith("---")) {
            val end = content.indexOf("---", 3)
            if (end > 0) content.substring(end + 3) else content
        } else content
        return body.lines().firstOrNull { it.startsWith("# ") }?.substring(2)?.trim()
    }

    private fun extractBodyTriggers(content: String): List<String> {
        val body = if (content.startsWith("---")) {
            val end = content.indexOf("---", 3)
            if (end > 0) content.substring(end + 3) else content
        } else content
        val line = body.lines().firstOrNull { it.trim().lowercase().startsWith("trigger:") }
            ?: return emptyList()
        return line.substring(line.indexOf(':') + 1)
            .split(',').map { it.trim().lowercase() }.filter { it.isNotEmpty() }
    }

    private fun validateSkillFormat(
        description: String,
        version: String,
        triggers: List<String>,
        content: String,
    ): List<String> {
        val warnings = mutableListOf<String>()
        if (description.isEmpty()) warnings += "missing \"description\""
        if (version.isEmpty()) warnings += "missing \"version\""
        val body = if (content.startsWith("---")) {
            val end = content.indexOf("---", 3)
            if (end > 0) content.substring(end + 3) else content
        } else content
        val hasLegacyTrigger = body.lines().any { it.trim().lowercase().startsWith("trigger:") }
        if (hasLegacyTrigger) {
            warnings += "has legacy \"Trigger:\" line — use triggers: in frontmatter"
        }
        return warnings
    }
}
