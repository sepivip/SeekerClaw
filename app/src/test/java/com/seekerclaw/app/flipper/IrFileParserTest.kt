package com.seekerclaw.app.flipper

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * Fixtures for the `.ir` parser, derived from `flipper_format_stream.c`, `flipper_format.c`,
 * `infrared_signal.c` and `infrared_remote.c` at firmware 8622f1a2 — not from what the format
 * looks like it ought to do.
 *
 * A mismatch produces a **wrong button list**: buttons we offer that the device cannot press, or
 * buttons it has that we never show. (An unresolvable name is *not* a silent success — the RPC
 * returns `ERROR_APP_CMD_ERROR`. The silent-OK mode exists only for index-addressed presses, which
 * we never emit.)
 */
class IrFileParserTest {

    /** Every real file has one. Enumeration cannot begin until the header is consumed. */
    private val HEADER = "Filetype: IR signals file\nVersion: 1\n"

    private fun parse(body: String) = IrFileParser.parseButtonNames((HEADER + body).toByteArray(Charsets.UTF_8))

    /** For cases that deliberately supply their own (or no) header. */
    private fun raw(whole: String) = IrFileParser.parseButtonNames(whole.toByteArray(Charsets.UTF_8))

    // ------------------------------------------------------- the +2 seek rule

    @Test fun `space after the colon is consumed by the two-byte seek`() {
        assertEquals(listOf("Power"), parse("name: Power\n"))
    }

    @Test fun `no space after the colon eats the first character of the value`() {
        // seek_to_key seeks +2 unconditionally; it does not look for a space. A client that split
        // on ':' and trimmed would produce "Power" and never match.
        assertEquals(listOf("ower"), parse("name:Power\n"))
    }

    @Test fun `two spaces after the colon leave one in the value`() {
        assertEquals(listOf(" Power"), parse("name:  Power\n"))
    }

    // -------------------------------------------------------- whitespace rules

    @Test fun `inner spaces are preserved`() {
        // read_string uses read_line, not read_value — the latter stops at the first space and
        // would yield "Vol".
        assertEquals(listOf("Vol Up"), parse("name: Vol Up\n"))
    }

    @Test fun `trailing space is preserved`() {
        assertEquals(listOf("Vol Up "), parse("name: Vol Up \n"))
    }

    @Test fun `tabs inside a value are preserved`() {
        assertEquals(listOf("Vol\tUp"), parse("name: Vol\tUp\n"))
    }

    @Test fun `carriage returns are dropped everywhere`() {
        assertEquals(listOf("Power"), parse("name: Power\r\n"))
        assertEquals(listOf("Power"), parse("na\rme: Power\r\n"))
    }

    // ------------------------------------------------------------- line status

    @Test fun `comment lines are skipped`() {
        assertEquals(listOf("Power"), parse("# name: Ignored\nname: Power\n"))
    }

    @Test fun `a hash mid-line is an ordinary character`() {
        assertEquals(listOf("Pow#er"), parse("name: Pow#er\n"))
    }

    @Test fun `a line beginning with a colon is not a key`() {
        assertEquals(listOf("Power"), parse(":stray\nname: Power\n"))
    }

    @Test fun `leading whitespace makes the key not match`() {
        assertEquals(emptyList<String>(), parse(" name: Power\n"))
    }

    @Test fun `key matching is case sensitive`() {
        assertEquals(emptyList<String>(), parse("Name: Power\n"))
    }

    @Test fun `final line without a trailing newline still parses`() {
        assertEquals(listOf("Power"), parse("name: Power"))
    }

    @Test fun `high bytes survive as latin1 without utf8 substitution`() {
        // Decoding invalid UTF-8 wholesale substitutes U+FFFD, manufacturing collisions and
        // breaking a legitimately approved button.
        val bytes = (HEADER + "name: ").toByteArray() +
            byteArrayOf(0xFF.toByte(), 0xFE.toByte()) + "\n".toByteArray()
        val names = IrFileParser.parseButtonNames(bytes)
        assertEquals(1, names.size)
        assertEquals(2, names[0].length)
        assertEquals(0xFF, names[0][0].code)
        assertEquals(0xFE, names[0][1].code)
    }

    // ------------------------------ D1: an empty value ends the enumeration

    @Test fun `empty name value truncates the list exactly as the firmware does`() {
        // read_line reports failure on a zero-length result, which breaks infrared_remote_load's
        // loop. Listing Vol_up here would advertise a button the device cannot press.
        assertEquals(listOf("Power"), parse("name: Power\nname: \nname: Vol_up\n"))
    }

    @Test fun `empty name value with CRLF also truncates`() {
        assertEquals(listOf("Power"), parse("name: Power\nname: \r\nname: Vol_up\n"))
    }

    @Test fun `two spaces after the colon is not an empty value and does not truncate`() {
        // The +2 eats one space, leaving " " — non-empty, so the loop continues.
        assertEquals(listOf("Power", " ", "Vol_up"), parse("name: Power\nname:  \nname: Vol_up\n"))
    }

    @Test fun `colon as the final byte yields nothing rather than an empty name`() {
        assertEquals(emptyList<String>(), parse("name:"))
    }

    @Test fun `bare empty name yields nothing`() {
        assertEquals(emptyList<String>(), parse("name:\n"))
    }

    // ------------------- D2: the +2 seek applies only to the matched key

    @Test fun `a non-matching key with an empty value does not swallow the next line`() {
        // On a non-match the stream stays ON the ':'. A flat sweep applying +2 here would step
        // over the newline and consume "name: Vol_up" as command's value.
        assertEquals(listOf("Power", "Vol_up"), parse("name: Power\ncommand:\nname: Vol_up\n"))
    }

    @Test fun `a non-matching key with a normal value is unaffected`() {
        assertEquals(listOf("Power", "Vol_up"), parse("name: Power\ncommand: 08\nname: Vol_up\n"))
    }

    @Test fun `a non-matching key ending CRLF is unaffected`() {
        assertEquals(listOf("Power", "Vol_up"), parse("name: Power\ncommand:\r\nname: Vol_up\n"))
    }

    // ------------------ D3: names above the header read head are invisible

    @Test fun `a name before the Version line is behind the read head`() {
        // read_header is Filetype then Version, sequential with no rewind, so Ghost is consumed
        // while scanning for Version and can never be enumerated.
        val f = "Filetype: IR signals file\nname: Ghost\nVersion: 1\nname: Power\n"
        assertEquals(listOf("Power"), raw(f))
    }

    // ------------------------------------- D4: the Version gate is real

    @Test fun `version two does not load`() {
        assertEquals(emptyList<String>(), raw("Filetype: IR signals file\nVersion: 2\nname: Power\n"))
    }

    @Test fun `version without a space does not load`() {
        // The +2 lands on the newline; read_value meets end-of-line before any data and fails.
        assertEquals(emptyList<String>(), raw("Filetype: IR signals file\nVersion:1\nname: Power\n"))
    }

    @Test fun `missing version does not load`() {
        assertEquals(emptyList<String>(), raw("Filetype: IR signals file\nname: Power\n"))
    }

    @Test fun `non-numeric version does not load`() {
        assertEquals(emptyList<String>(), raw("Filetype: IR signals file\nVersion: abc\nname: Power\n"))
    }

    @Test fun `version with trailing junk is accepted`() {
        // read_value stops at the first space after data, so "1 extra" parses as 1. Do not
        // over-reject: the firmware loads this file.
        assertEquals(listOf("Power"), raw("Filetype: IR signals file\nVersion: 1 extra\nname: Power\n"))
    }

    @Test fun `wrong filetype does not load`() {
        assertEquals(emptyList<String>(), raw("Filetype: IR library file\nVersion: 1\nname: Power\n"))
    }

    @Test fun `missing filetype does not load`() {
        assertEquals(emptyList<String>(), raw("Version: 1\nname: Power\n"))
    }

    @Test fun `filetype after version does not load`() {
        // Order matters — read_header seeks Filetype from offset 0 and finds it, but then seeks
        // Version forward from there and runs off the end.
        assertEquals(emptyList<String>(), raw("Version: 1\nFiletype: IR signals file\nname: Power\n"))
    }

    // ------------------------------------------------------ ordering and dedupe

    @Test fun `names are returned in file order`() {
        assertEquals(listOf("Power", "Vol_up", "Vol_dn"), parse("name: Power\nname: Vol_up\nname: Vol_dn\n"))
    }

    @Test fun `duplicate names dedupe to first occurrence`() {
        // Ordinary in IRDB and universal packs. The firmware strcmp's first-match-wins, so our
        // list must agree or the allowlist points at a different signal than the one that fires.
        assertEquals(listOf("POWER", "MUTE"), parse("name: POWER\nname: MUTE\nname: POWER\n"))
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
        assertEquals(listOf("Power", "Vol_up"), raw(realisticRemote))
    }

    @Test fun `realistic remote is recognised as loadable`() {
        assertTrue(IrFileParser.isRemoteFile(realisticRemote.toByteArray()))
    }

    @Test fun `library file is rejected`() {
        // Parses fine, but infrared_remote_load rejects it with WrongFileType — so it must never
        // reach the allowlist, or it would enumerate and then fail forever at press time.
        assertFalse(IrFileParser.isRemoteFile("Filetype: IR library file\nVersion: 1\nname: Power\n".toByteArray()))
    }

    @Test fun `file with no header is not a remote`() {
        assertFalse(IrFileParser.isRemoteFile("name: Power\n".toByteArray()))
    }

    @Test fun `version two is not a loadable remote`() {
        assertFalse(IrFileParser.isRemoteFile("Filetype: IR signals file\nVersion: 2\n".toByteArray()))
    }

    // ------------------------------------------------------------- robustness

    @Test fun `empty file yields nothing`() {
        assertEquals(emptyList<String>(), raw(""))
        assertFalse(IrFileParser.isRemoteFile(ByteArray(0)))
    }

    @Test fun `file of only comments yields nothing`() {
        assertEquals(emptyList<String>(), raw("#\n# comment\n#\n"))
    }

    @Test fun `truncated final key without a colon is ignored`() {
        assertEquals(listOf("Power"), parse("name: Power\nnam"))
    }

    // ------------------------------------------------- diagnostic dump is not authoritative

    @Test fun `parse is a flat dump and is documented as non-authoritative`() {
        // Kept for logging only. It applies +2 to every delimiter, so it disagrees with the
        // device on the D2 shape — asserted here so nobody mistakes it for the real path.
        val f = "Filetype: IR signals file\nVersion: 1\nname: Power\ncommand:\nname: Vol_up\n"
        val flat = IrFileParser.parse(f.toByteArray()).filter { it.key == "name" }.map { it.value }
        assertEquals(listOf("Power"), flat)
        assertEquals("the authoritative path disagrees", listOf("Power", "Vol_up"), raw(f))
    }
}
