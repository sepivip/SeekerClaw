package com.seekerclaw.app.config

import com.seekerclaw.app.util.LinkHygiene
import org.junit.Assert.assertTrue
import org.junit.Test
import java.io.File
import java.nio.file.Paths

/**
 * BAT-1409 P1-C (amendment v3.3 M1): boot link hygiene checks the prefs files by exact name, so
 * every SharedPreferences call site must take its name from [PrefsNames].
 */
class PrefsNamesTest {

    @Test
    fun everyGetSharedPreferencesCallUsesTheRegistry() {
        val src = File("src/main/java")
        assertTrue("run from the app module", src.isDirectory)
        val call = Regex("""getSharedPreferences\(\s*([^,)]*)""")
        val offenders = mutableListOf<String>()
        src.walkTopDown().filter { it.isFile && it.name.endsWith(".kt") }.forEach { f ->
            f.readLines().forEachIndexed { i, line ->
                val t = line.trimStart()
                if (t.startsWith("//") || t.startsWith("*")) return@forEachIndexed
                call.findAll(line).forEach { m ->
                    if (!m.groupValues[1].trim().startsWith("PrefsNames.")) offenders += "${f.path}:${i + 1}: ${line.trim()}"
                }
            }
        }
        assertTrue("prefs names outside PrefsNames:\n" + offenders.joinToString("\n"), offenders.isEmpty())
    }

    @Test
    fun registryNamesAreDistinctAndCheckedAtBoot() {
        assertTrue(PrefsNames.ALL.toSet().size == PrefsNames.ALL.size)
        val data = Paths.get("data")
        val list = LinkHygiene.criticalPaths(data.resolve("files"), data, PrefsNames.ALL)
        for (n in PrefsNames.ALL) {
            assertTrue(data.resolve("shared_prefs/$n.xml") in list)
            assertTrue(data.resolve("shared_prefs/$n.xml.bak") in list)
        }
    }
}
