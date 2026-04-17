package com.seekerclaw.app.config

import android.content.Context
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.withContext

/**
 * Single source of truth for env var key names and the skill ↔ env reverse index.
 *
 * UI observes [keys] to re-render instantly on add/delete. [skillsForKey] lets
 * EnvVarsScreen show "used by: …" chips without re-parsing skill frontmatter.
 *
 * Populated from two sources:
 *   - [refreshFromConfig] — call after any ConfigManager.saveEnvVars / initial load.
 *   - [setSkillRequirements] — call once on skills load from SkillsRepository.
 */
object EnvVarRegistry {
    private val _keys = MutableStateFlow<Set<String>>(emptySet())
    val keys: StateFlow<Set<String>> = _keys.asStateFlow()

    private val _skillRequirements = MutableStateFlow<Map<String, List<String>>>(emptyMap())
    val skillRequirements: StateFlow<Map<String, List<String>>> = _skillRequirements.asStateFlow()

    /**
     * Reads the current env var list from encrypted prefs and publishes the names.
     * Suspending: Keystore decrypt + JSON parse runs on [Dispatchers.IO] to avoid main-thread jank.
     *
     * Prefer [updateKeys] at call sites that already have the decrypted list to
     * avoid a second decrypt+parse pass.
     */
    suspend fun refreshFromConfig(context: Context) {
        val names = withContext(Dispatchers.IO) {
            ConfigManager.loadEnvVars(context).map { it.name }.toSet()
        }
        _keys.value = names
    }

    /**
     * Publish key names from an already-loaded list. Synchronous — no I/O.
     * Use this when the caller has just loaded the env var list (e.g. in
     * EnvVarsScreen's LaunchedEffect after a configVersion bump) so we avoid
     * a redundant keystore decrypt + JSON parse inside [refreshFromConfig].
     */
    fun updateKeys(envVars: List<EnvVar>) {
        _keys.value = envVars.map { it.name }.toSet()
    }

    /**
     * Replace the skill-requirements map.
     * @param requirements map of `skillId → list of required env var names`
     */
    fun setSkillRequirements(requirements: Map<String, List<String>>) {
        _skillRequirements.value = requirements
    }

    /** Skills that declare [envKey] in their requires.env. Alphabetical. */
    fun skillsForKey(envKey: String): List<String> {
        return _skillRequirements.value
            .filterValues { it.contains(envKey) }
            .keys
            .sorted()
    }

    /** Env keys declared by [skillId] but not currently set. */
    fun missingForSkill(skillId: String): List<String> {
        val required = _skillRequirements.value[skillId] ?: return emptyList()
        val set = _keys.value
        return required.filterNot { set.contains(it) }
    }
}
