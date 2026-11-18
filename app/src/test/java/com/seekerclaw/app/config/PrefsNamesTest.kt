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

    /**
     * BAT-1157 (D7.1/D12): `seekerclaw_prefs` is opened only inside [MainPrefs], so every writer goes
     * through `forWrite` (null in `:node`) and `:node` readers get a getter-only [PrefsReader].
     */
    @Test
    fun mainPrefsIsOpenedOnlyInsideMainPrefs() {
        assertTrue(mainPrefsOpeners(File("src/main/java")).isEmpty())
    }

    private fun mainPrefsOpeners(root: File): List<String> {
        val offenders = mutableListOf<String>()
        root.walkTopDown().filter { it.isFile && it.name.endsWith(".kt") && it.name != "MainPrefs.kt" && it.name != "PrefsNames.kt" }
            .forEach { f ->
                f.readLines().forEachIndexed { i, line ->
                    val t = line.trimStart()
                    if (t.startsWith("//") || t.startsWith("*")) return@forEachIndexed
                    if (line.contains("getSharedPreferences(PrefsNames.MAIN") || line.contains("\"seekerclaw_prefs\"")) {
                        offenders += "${f.path}:${i + 1}: ${line.trim()}"
                    }
                }
            }
        return offenders
    }

    @Test
    fun mainPrefsOpenerGuardCatchesADirectCall() {
        // Negative control: a direct opener outside MainPrefs (today's pre-BAT-1157 call sites).
        val dir = File.createTempFile("prefsguard", "").apply { delete(); mkdirs() }
        try {
            File(dir, "Bad.kt").writeText("val p = ctx.getSharedPreferences(PrefsNames.MAIN, 0)\nval q = ctx.getSharedPreferences(\"seekerclaw_prefs\", 0)\n")
            assertTrue(mainPrefsOpeners(dir).size == 2)
        } finally {
            dir.deleteRecursively()
        }
    }

    @Test
    fun prefsReaderCannotBeTurnedBackIntoEditablePrefs() {
        // No getter hands back SharedPreferences or an Editor…
        for (m in PrefsReader::class.java.methods) {
            assertTrue("PrefsReader.${m.name} returns ${m.returnType}",
                !android.content.SharedPreferences::class.java.isAssignableFrom(m.returnType) &&
                    !android.content.SharedPreferences.Editor::class.java.isAssignableFrom(m.returnType))
        }
        // …and the implementation behind MainPrefs.read is not itself a SharedPreferences.
        val impl = MainPrefs::class.java.declaredClasses.filter { PrefsReader::class.java.isAssignableFrom(it) }
        assertTrue("MainPrefs has a PrefsReader implementation", impl.isNotEmpty())
        impl.forEach { assertTrue("${it.name} must not implement SharedPreferences", !android.content.SharedPreferences::class.java.isAssignableFrom(it)) }
    }

    @Test
    fun noPrefsReaderIsCastBackToSharedPreferences() {
        val cast = Regex("""\b(as\??|is)\s+(android\.content\.)?SharedPreferences\b""")
        val offenders = File("src/main/java").walkTopDown().filter { it.isFile && it.name.endsWith(".kt") }.flatMap { f ->
            f.readLines().mapIndexedNotNull { i, line -> if (cast.containsMatchIn(line)) "${f.path}:${i + 1}" else null }
        }.toList()
        assertTrue("casts to SharedPreferences:\n" + offenders.joinToString("\n"), offenders.isEmpty())
        assertTrue("guard regex sees `as SharedPreferences`", cast.containsMatchIn("val p = reader as SharedPreferences"))
        assertTrue("guard regex sees `as?`", cast.containsMatchIn("(r as? android.content.SharedPreferences)"))
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
