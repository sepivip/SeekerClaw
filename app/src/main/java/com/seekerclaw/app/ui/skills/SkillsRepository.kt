package com.seekerclaw.app.ui.skills

import java.io.File

object SkillsRepository {

    fun loadSkills(workspaceDir: File): List<SkillInfo> {
        val skillsDir = File(workspaceDir, "skills")
        if (!skillsDir.exists()) return emptyList()

        val result = mutableListOf<SkillInfo>()
        skillsDir.listFiles()
            ?.sortedBy { it.name }
            ?.forEach { entry ->
                when {
                    entry.isDirectory -> {
                        val skillFile = File(entry, "SKILL.md")
                        if (skillFile.exists()) {
                            runCatching { skillFile.readText() }
                                .getOrNull()
                                ?.let { parseSkillFile(it, entry.name, skillFile.absolutePath) }
                                ?.let { result.add(it) }
                        }
                    }
                    entry.isFile && entry.name.endsWith(".md") -> {
                        runCatching { entry.readText() }
                            .getOrNull()
                            ?.let { parseSkillFile(it, entry.nameWithoutExtension, entry.absolutePath) }
                            ?.let { result.add(it) }
                    }
                }
            }
        return result.sortedBy { it.name.lowercase() }
    }

    private fun parseSkillFile(content: String, dirName: String, filePath: String): SkillInfo? {
        val fm = parseFrontmatter(content)
        val name = (fm["name"] as? String)?.trim()?.takeIf { it.isNotEmpty() }
            ?: extractHeading(content)
            ?: return null
        val description = (fm["description"] as? String)?.trim() ?: ""
        val version = (fm["version"] as? String)?.trim() ?: ""
        val emoji = (fm["emoji"] as? String)?.trim() ?: ""
        @Suppress("UNCHECKED_CAST")
        val triggers: List<String> = when (val t = fm["triggers"]) {
            is List<*> -> (t as? List<String>)
                ?.map { it.trim().lowercase() }
                ?.filter { it.isNotEmpty() }
                ?: emptyList()
            is String -> t.split(',').map { it.trim().lowercase() }.filter { it.isNotEmpty() }
            else -> extractBodyTriggers(content)
        }
        return SkillInfo(
            name = name,
            description = description,
            version = version,
            emoji = emoji,
            triggers = triggers,
            filePath = filePath,
            dirName = dirName,
        )
    }

    /**
     * Minimal YAML frontmatter parser. Returns a map where values are either
     * String (scalar) or List<String> (sequence). Handles:
     * - Simple scalars:  key: value
     * - Inline sequences: triggers: [hello, test]
     * - Block sequences:  triggers:\n  - hello\n  - test
     */
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
}
