package app.mydpremote

import org.junit.Assert.assertEquals
import org.junit.Assert.assertThrows
import org.junit.Test

class DuepiTest {
    private val key = Duepi.deriveKey("TESTCODE")

    @Test
    fun `trame identique a la reference Python et TypeScript`() {
        val frame = Duepi.encodeFrame(key, "RD9000", ByteArray(16) { 7 })
        assertEquals(0x1b, frame.first().toInt())
        assertEquals('&'.code, frame.last().toInt())
        assertEquals("BwcHBwcHBwcHBwcHBwcHB27GXumsfJTVjPSRk3SaNxw=", String(frame, 1, frame.size - 2, Charsets.US_ASCII))
    }

    @Test
    fun `aller-retour chiffrer dechiffrer`() {
        assertEquals("RD9000" + Duepi.checksum("RD9000"), Duepi.decodeFrame(key, Duepi.encodeFrame(key, "RD9000")))
    }

    @Test
    fun `somme et lecture des reponses`() {
        assertEquals("1F", Duepi.checksum("\u000F\u0010"))
        assertEquals("00AF00", Duepi.parseReply("00AF00" + Duepi.checksum("00AF00")))
        assertThrows(ProtocolException::class.java) { Duepi.parseReply("00AF0000") }
        assertEquals(0xAF, Duepi.value4("00AF00"))
        assertEquals(12694, Duepi.value6("003196"))
    }

    @Test
    fun `commandes et bornes`() {
        assertEquals("RF0030", Duepi.powerCommand(3))
        assertEquals("RF2150", Duepi.setpointCommand(21))
        assertThrows(IllegalArgumentException::class.java) { Duepi.powerCommand(6) }
        assertThrows(IllegalArgumentException::class.java) { Duepi.setpointCommand(41) }
    }
}
