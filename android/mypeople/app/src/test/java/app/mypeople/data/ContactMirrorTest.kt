package app.mypeople.data

import kotlinx.serialization.encodeToString
import org.junit.Assert.*
import org.junit.Rule
import org.junit.Test
import org.junit.rules.TemporaryFolder
import java.io.File

class ContactMirrorTest {
    @get:Rule val temp = TemporaryFolder()
    @Test fun `old provider baseline migrates and contact-sized transactions survive restart`() {
        val file = File(temp.newFolder(), "contacts-mirror.json")
        val card = ContactCard("Ada", notes = "x".repeat(4096))
        val old = MirrorState((1..2000).associate { it.toString() to MirrorEntry(it.toLong(), card, card) })
        file.writeText(json.encodeToString(old))
        val checkpoint = file.readBytes()
        val mirror = ContactMirror(file)
        val changed = card.copy(notes = "Changed")
        val next = old.copy(entries = old.entries + ("1" to MirrorEntry(1, changed, changed)))
        mirror.save(next)
        assertArrayEquals(checkpoint, file.readBytes())
        val log = File(file.parentFile, "contacts-mirror.journal")
        assertTrue(log.length() < 2000)
        val restarted = ContactMirror(file)
        assertEquals("Changed", restarted.load().entries.getValue("1").local.notes)
        assertEquals(2000, restarted.load().entries.size)
        restarted.save(MirrorState()) // explicitly re-enabling a removed account resets the baseline
        assertTrue(ContactMirror(file).load().entries.isEmpty())
    }
    @Test fun `a torn last provider transaction is discarded but checkpoint corruption is not`() {
        val file = File(temp.newFolder(), "contacts-mirror.json")
        val card = ContactCard("Ada")
        ContactMirror(file).save(MirrorState(mapOf("a" to MirrorEntry(1, card, card))))
        val log = File(file.parentFile, "contacts-mirror.journal")
        val size = log.length(); log.appendBytes(byteArrayOf(0, 1))
        assertEquals("Ada", ContactMirror(file).load().entries.getValue("a").local.name)
        assertEquals(size, log.length())
        file.writeText("broken")
        try { ContactMirror(file).load(); fail("Corrupt baseline") } catch (_: IllegalArgumentException) { }
        assertEquals("broken", file.readText())
    }
}
