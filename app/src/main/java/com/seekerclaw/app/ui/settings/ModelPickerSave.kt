package com.seekerclaw.app.ui.settings

/**
 * BAT-1661 (contract v2.4 §0; CodeRabbit on 444ba220): what the model picker's Save writes.
 *
 * The picker opens on the model the row SHOWS ([com.seekerclaw.app.config.AppConfig.displayModel]).
 * For a model the current sign-in can no longer use, that is the provider default, not the stored
 * model. `displayModel` is display-only: Save must not turn it into a stored selection unless the
 * user actually chose it. A tap on a row (the highlighted one included) or an edit of the custom
 * ID is a choice ([touched]).
 *
 * Returns the model id to save (trimmed), or null when Save must write nothing: the selection is
 * blank, or it is still the untouched display substitute ([display] differs from [stored]).
 */
internal fun pickerSaveValue(stored: String, display: String, selected: String, touched: Boolean): String? {
    val pick = selected.trim()
    if (pick.isEmpty()) return null
    if (!touched && display != stored && pick == display.trim()) return null
    return pick
}
