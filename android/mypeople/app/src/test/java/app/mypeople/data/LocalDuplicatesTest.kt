package app.mypeople.data

import org.junit.Assert.*
import org.junit.Test

class LocalDuplicatesTest {
    private fun person(name: String, uid: String, vararg fields: ContactField) = Person(name, contact_uid = uid, card = ContactCard(name, fields = fields.toList()))
    private val records = Records(people = mapOf(
        1 to person("Ada Lovelace", "a"),
        2 to person("Grace Hopper", "g", ContactField("phone", "+1 415 555 0123")),
        3 to person("Ada", "a2"),
        4 to person("Bob Smith", "b", ContactField("email", "bob@example.com")),
        -1 to person("ada lovelace", "new"),
        -2 to person("G. H.", "gh", ContactField("phone", "(415) 555-0123")),
        -3 to person("Robert", "r", ContactField("email", " Bob@Example.com ")),
    ))

    @Test fun `only contacts changed on the phone produce groups`() {
        assertTrue(localDuplicates(records, emptySet(), emptyList()).isEmpty())
        // "Ada" and "Ada Lovelace" are both on the Mac; untouched, they are the Mac's to suggest.
        assertTrue(localDuplicates(records, setOf("g2"), emptyList()).isEmpty())
    }

    @Test fun `same name, first name, phone and email matches`() {
        val found = localDuplicates(records, setOf("new", "gh", "r"), emptyList())
        assertEquals(setOf(listOf(-1, 1), listOf(-1, 1, 3), listOf(-2, 2), listOf(-3, 4)), found.values.map { it.person_ids }.toSet())
        assertTrue(found.keys.all { it.startsWith(LOCAL_DUPES_PREFIX) })
        assertTrue("Same phone number" in found.getValue("local:-2-2").clues)
    }

    @Test fun `groups the Mac sent or that were marked different are skipped`() {
        val withMac = records.copy(dupes = mapOf("1--1" to Dupes(listOf(-1, 1))))
        assertEquals(listOf(listOf(-1, 1, 3)), localDuplicates(withMac, setOf("new"), emptyList()).values.map { it.person_ids })
        assertTrue(localDuplicates(records, setOf("new"), listOf(setOf(-1, 1, 3))).isEmpty())
    }

    @Test fun `trashed people and shared office numbers are ignored`() {
        val office = ContactField("phone", "+1 212 555 0100")
        val crowded = Records(people = (1..6).associateWith { person("Person $it", "p$it", office) })
        assertTrue(localDuplicates(crowded, setOf("p1"), emptyList()).isEmpty())
        val trashed = records.copy(people = records.people + (1 to records.people.getValue(1).copy(trashed = true)))
        assertFalse(localDuplicates(trashed, setOf("new"), emptyList()).values.any { 1 in it.person_ids })
    }
}
