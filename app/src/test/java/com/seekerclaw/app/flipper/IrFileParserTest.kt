package com.seekerclaw.app.flipper

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * Tokenisation fixtures for the `.ir` parser.
 *
 * Every expectation here is derived from `lib/flipper_format/flipper_format_stream.c` at firmware
 * 8622f1a2, not from what the format looks like it ought to do. A mismatch between our parse and
 * the firmware's means `strcmp` fails, the press emits nothing, and the RPC still reports success
 * — the exact silent failure BAT-1201 §6 G4 exists to prevent.
 */
class IrFileParserTest {

    private fun parse(s: String) = IrFileParser.parseButtonNames(s.toByteArray(Charsets.UTF_8))

    // ------------------------------------------------------- the +2 seek rule

    @Test fun `space after the colon is consumed by the two-byte seek`() {
        assertEquals(listOf("Power"), parse("name: Power\n"))
    }

    @Test fun `no space after the colon eats the first character of the value`() {
        // seek_to_key seeks +2 from the ':' unconditionally — it does not look for a space. A
        // client that split on ':' and trimmed would produce "Power" and never match.
        assertEquals(listOf("ower"), parse("name:Power\n"))
    }

    @Test fun `two spaces after the colon leave one in the value`() {
        assertEquals(listOf(" Power"), parse("name:  Power\n"))
    }

    // -------------------------------------------------------- whitespace rules

    @Test fun `inner spaces are preserved`() {
        // read_string uses read_line, not read_value. read_value would stop at the first space
        // and yield "Vol" — the distinction decides whether multi-word names work at all.
        assertEquals(listOf("Vol Up"), parse("name: Vol Up\n"))
    }

    @Test fun `trailing space is preserved`() {
        assertEquals(listOf("Vol Up "), parse("name: Vol Up \n"))
    }

    @Test fun `tabs inside a value are preserved`() {
        assertEquals(listOf("Vol\tUp"), parse("name: Vol\tUp\n"))
    }

    @Test fun `carriage returns are dropped everywhere`() {
        // CRLF files are ordinary; a parser that keeps '\r' fails every strcmp.
        assertEquals(listOf("Power"), parse("name: Power\r\n"))
        assertEquals(listOf("Power"), parse("na\rme: Power\r\n"))
    }

    // ------------------------------------------------------------- line status

    @Test fun `comment lines are skipped`() {
        assertEquals(listOf("Power"), parse("# name: Ignored\nname: Power\n"))
    }

    @Test fun `a hash mid-line is an ordinary character`() {
        // Only '#' at the start of a line begins a comment.
        assertEquals(listOf("Pow#er"), parse("name: Pow#er\n"))
    }

    @Test fun `a line beginning with a colon is not a key`() {
        assertEquals(listOf("Power"), parse(":stray\nname: Power\n"))
    }

    @Test fun `leading whitespace makes the key not match`() {
        // read_valid_key accumulates spaces into the key, so " name" != "name".
        assertEquals(emptyList<String>(), parse(" name: Power\n"))
    }

    @Test fun `key matching is case sensitive`() {
        assertEquals(emptyList<String>(), parse("Name: Power\n"))
    }

    @Test fun `final line without a trailing newline still parses`() {
        assertEquals(listOf("Power"), parse("name: Power"))
    }

    @Test fun `empty value parses as empty rather than being skipped`() {
        // Surfacing it lets the caller reject it; silently dropping would hide a malformed file.
        assertEquals(listOf(""), parse("name:\n"))
    }

    // ------------------------------------------------------ ordering and dedupe

    @Test fun `names are returned in file order`() {
        val f = """
            name: Power
            name: Vol_up
            name: Vol_dn
        """.trimIndent()
        assertEquals(listOf("Power", "Vol_up", "Vol_dn"), parse(f))
    }

    @Test fun `duplicate names dedupe to first occurrence`() {
        // Ordinary in IRDB and universal packs. The firmware strcmp's first-match-wins, so our
        // list must agree or the allowlist points at a different signal than the one that fires.
        val f = """
            name: POWER
            name: MUTE
            name: POWER
        """.trimIndent()
        assertEquals(listOf("POWER", "MUTE"), parse(f))
    }

    // ------------------------------------------------------------- realistic file

    private val realisticRemote = """
        Filetype: IR signals file
        Version: 1
        #
        name: Power
        type: parsed
        protocol: NECext
        address: 04 00 00 00
        command: 08 00 00 00
        #
        name: Vol_up
        type: parsed
        protocol: NECext
        address: 04 00 00 00
        command: 02 00 00 00
        #
    """.trimIndent()

    @Test fun `realistic remote yields only the button names`() {
        assertEquals(listOf("Power", "Vol_up"), parse(realisticRemote))
    }

    @Test fun `other keys are parsed but not confused for names`() {
        val entries = IrFileParser.parse(realisticRemote.toByteArray())
        assertTrue(entries.any { it.key == "Filetype" && it.value == "IR signals file" })
        assertTrue(entries.any { it.key == "protocol" && it.value == "NECext" })
        assertTrue(entries.any { it.key == "command" && it.value == "08 00 00 00" })
    }

    @Test fun `remote file is recognised by its Filetype`() {
        assertTrue(IrFileParser.isRemoteFile(realisticRemote.toByteArray()))
    }

    @Test fun `library file is rejected by Filetype`() {
        // These live under /ext/infrared/assets and parse fine, but infrared_remote_load rejects
        // them with WrongFileType — so they must not reach the allowlist at all.
        val library = "Filetype: IR library file\nVersion: 1\nname: Power\n"
        assertFalse(IrFileParser.isRemoteFile(library.toByteArray()))
    }

    @Test fun `file with no Filetype is not a remote`() {
        assertFalse(IrFileParser.isRemoteFile("name: Power\n".toByteArray()))
    }

    // ------------------------------------------------------------- robustness

    @Test fun `empty file yields nothing`() {
        assertEquals(emptyList<String>(), parse(""))
        assertFalse(IrFileParser.isRemoteFile(ByteArray(0)))
    }

    @Test fun `file of only comments yields nothing`() {
        assertEquals(emptyList<String>(), parse("#\n# comment\n#\n"))
    }

    @Test fun `truncated final key without a colon is ignored`() {
        assertEquals(listOf("Power"), parse("name: Power\nnam"))
    }

    @Test fun `colon at end of input yields an empty value rather than throwing`() {
        assertEquals(listOf(""), parse("name:"))
    }

    @Test fun `high bytes survive as latin1 without utf8 substitution`() {
        // Decoding invalid UTF-8 wholesale substitutes U+FFFD, which both manufactures collisions
        // and breaks a legitimately approved button. Bytes map 1:1 instead.
        val bytes = "name: ".toByteArray() + byteArrayOf(0xFF.toByte(), 0xFE.toByte()) + "\n".toByteArray()
        val names = IrFileParser.parseButtonNames(bytes)
        assertEquals(1, names.size)
        assertEquals(2, names[0].length)
        assertEquals(0xFF, names[0][0].code)
        assertEquals(0xFE, names[0][1].code)
    }
}
