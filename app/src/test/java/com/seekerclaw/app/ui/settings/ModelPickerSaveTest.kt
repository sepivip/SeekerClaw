package com.seekerclaw.app.ui.settings

import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Test

/**
 * BAT-1661 (contract v2.4 §0; CodeRabbit on 444ba220): the model picker's Save never turns the
 * display substitute into a stored selection without a real choice. [pickerSaveValue] is the
 * rule; `ModelSelectionSourceGuardTest` pins that the picker's Save goes through it.
 */
class ModelPickerSaveTest {

    @Test
    fun `untouched display substitute - Save writes nothing`() {
        // Stored gpt-5.4 on ChatGPT sign-in shows (and preselects) the default, gpt-6.2-sol.
        assertNull(pickerSaveValue(stored = "gpt-5.4", display = "gpt-6.2-sol", selected = "gpt-6.2-sol", touched = false))
    }

    @Test
    fun `tapping the highlighted default is a choice - it is saved`() {
        assertEquals("gpt-6.2-sol", pickerSaveValue("gpt-5.4", "gpt-6.2-sol", "gpt-6.2-sol", touched = true))
    }

    @Test
    fun `another model picked - it is saved`() {
        assertEquals("gpt-6-astra", pickerSaveValue("gpt-5.4", "gpt-6.2-sol", "gpt-6-astra", touched = true))
    }

    @Test
    fun `display equals stored - Save behaves as before`() {
        assertEquals("gpt-6-astra", pickerSaveValue("gpt-6-astra", "gpt-6-astra", "gpt-6-astra", touched = false))
    }

    @Test
    fun `custom ID typed - saved trimmed`() {
        assertEquals("my-model", pickerSaveValue("gpt-5.4", "gpt-6.2-sol", "  my-model  ", touched = true))
    }

    @Test
    fun `blank selection - nothing to save`() {
        assertNull(pickerSaveValue("gpt-5.4", "gpt-6.2-sol", "   ", touched = true))
    }
}
