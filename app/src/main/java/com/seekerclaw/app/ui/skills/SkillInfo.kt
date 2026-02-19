package com.seekerclaw.app.ui.skills

data class SkillInfo(
    val name: String,
    val description: String,
    val version: String,
    val emoji: String,
    val triggers: List<String>,
    val filePath: String,
    val dirName: String,
)
