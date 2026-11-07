package app.mypeople.data

import org.junit.Assert.*
import org.junit.Test

class ContactCopyPolicyTest {
    private val local = ContactCard("Ada", notes = "MyPeople", fields = listOf(ContactField("phone", "020 7946 0018", region = "GB")))
    // Android renders a normalized number while MyPeople keeps the original.
    private val exported = local.copy(fields = listOf(ContactField("phone", "+442079460018")))
    private val entry = MirrorEntry(1, exported, local, phoneFormat = 1)

    @Test fun unchangedProjectionDoesNotLoop() {
        assertFalse(entry.needsWrite(local, exported))
        assertFalse(entry.copy().needsWrite(local, exported))
    }

    @Test fun externalEditsAndDeletionsAlwaysRepairFromMyPeople() {
        assertTrue(entry.needsWrite(local, exported.copy(notes = "Android")))
        assertTrue(entry.needsWrite(local, null))
        assertTrue(entry.needsWrite(local.copy(notes = "New MyPeople"), exported.copy(notes = "Android")))
    }

    @Test fun localEditsAndOldNumberFormatsExport() {
        assertTrue(entry.needsWrite(local.copy(notes = "Saved offline"), exported))
        assertTrue(entry.copy(phoneFormat = 0).needsWrite(local, exported))
        assertEquals("020 7946 0018", local.fields.single().value)
        assertEquals("GB", local.fields.single().region)
    }

    @Test fun sourceHistoryAndPhotoRepresentationDoNotCauseRewrites() {
        assertFalse(entry.needsWrite(local.copy(originals = listOf("retained original"), edit_id = "new", user_edited = true), exported))
        val photo = local.copy(photo = java.util.Base64.getEncoder().encodeToString(byteArrayOf(1, 2, 3)))
        assertEquals(photo.androidBaseline(), photo.copy(photo = "", photo_hash = GraphStore.digest(byteArrayOf(1, 2, 3))).androidBaseline())
    }
}
