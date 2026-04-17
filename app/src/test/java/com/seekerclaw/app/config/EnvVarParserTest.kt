package com.seekerclaw.app.config

import org.junit.Assert.assertEquals
import org.junit.Test

class EnvVarParserTest {

    @Test fun `simple KEY=VALUE parses`() {
        val result = EnvVarParser.parse("FOO=bar")
        assertEquals(1, result.size)
        val entry = result[0]
        assertEquals("FOO", entry.name)
        assertEquals("bar", entry.value)
        assertEquals(ParseStatus.OK, entry.status)
    }

    @Test fun `multiple lines parse`() {
        val result = EnvVarParser.parse("FOO=1\nBAR=2\nBAZ=3")
        assertEquals(3, result.size)
        assertEquals(listOf("FOO", "BAR", "BAZ"), result.map { it.name })
    }

    @Test fun `double quoted value strips quotes`() {
        val result = EnvVarParser.parse("""FOO="bar baz"""")
        assertEquals("bar baz", result[0].value)
    }

    @Test fun `single quoted value strips quotes`() {
        val result = EnvVarParser.parse("FOO='bar baz'")
        assertEquals("bar baz", result[0].value)
    }

    @Test fun `comment line ignored`() {
        val result = EnvVarParser.parse("# this is a comment\nFOO=bar")
        assertEquals(1, result.size)
        assertEquals("FOO", result[0].name)
    }

    @Test fun `export prefix tolerated`() {
        val result = EnvVarParser.parse("export FOO=bar")
        assertEquals("FOO", result[0].name)
        assertEquals("bar", result[0].value)
    }

    @Test fun `blank lines ignored`() {
        val result = EnvVarParser.parse("\n\nFOO=bar\n\n")
        assertEquals(1, result.size)
    }

    @Test fun `line without equals marked malformed`() {
        val result = EnvVarParser.parse("NOT_A_VAR")
        assertEquals(1, result.size)
        assertEquals(ParseStatus.MALFORMED, result[0].status)
    }

    @Test fun `lowercase key marked invalid name`() {
        val result = EnvVarParser.parse("foo=bar")
        assertEquals(ParseStatus.INVALID_NAME, result[0].status)
    }

    @Test fun `reserved name PATH marked reserved`() {
        val result = EnvVarParser.parse("PATH=/tmp")
        assertEquals(ParseStatus.RESERVED, result[0].status)
    }

    @Test fun `empty value treated as OK`() {
        val result = EnvVarParser.parse("FOO=")
        assertEquals(ParseStatus.OK, result[0].status)
        assertEquals("", result[0].value)
    }

    @Test fun `value with equals sign preserved`() {
        val result = EnvVarParser.parse("FOO=a=b=c")
        assertEquals("a=b=c", result[0].value)
    }

    @Test fun `CRLF line endings parsed correctly`() {
        val result = EnvVarParser.parse("FOO=1\r\nBAR=2\r\n")
        assertEquals(2, result.size)
        assertEquals("FOO", result[0].name)
        assertEquals("BAR", result[1].name)
    }
}
