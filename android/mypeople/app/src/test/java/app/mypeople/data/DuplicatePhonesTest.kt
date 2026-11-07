package app.mypeople.data

import java.util.UUID
import kotlinx.coroutines.runBlocking
import org.junit.Assert.*
import org.junit.Rule
import org.junit.Test
import org.junit.rules.TemporaryFolder

class DuplicatePhonesTest {
    @get:Rule val temp = TemporaryFolder()
    private fun point(value: String, region: String = "", label: String = "", preferred: Boolean = false, userAdded: Boolean = false) =
        ContactField("phone", value, label, preferred, region = region, user_added = userAdded, object_id = UUID.randomUUID().toString())

    @Test fun internationalAndNationalFormatsRetainOneStablePointAndAllMetadata() {
        val national = point("020 7946 0018", "GB", "Work", userAdded = true)
        val preferred = point("+44 (20) 7946-0018", label = "Mobile", preferred = true)
        val card = ContactCard("Synthetic", region = "GB", notes = "Keep notes", originals = listOf("Keep original"), source_records = listOf("Keep source"), fields = listOf(national, ContactField("email", "a@example.test"), preferred))
        val cleaned = card.withoutDuplicatePhones()
        assertEquals(1, cleaned.removed)
        assertEquals(listOf(card.fields[1], preferred.copy(label = "Work / Mobile", user_added = true)), cleaned.card.fields)
        assertEquals(card.copy(fields = cleaned.card.fields), cleaned.card)
        assertEquals(0, cleaned.card.withoutDuplicatePhones().removed)
    }

    @Test fun countriesLeadingZeroesAndExtensionsAreNeverGuessedAway() {
        val cards = listOf(
            ContactCard("Country", fields = listOf(point("2025550101", "US"), point("2025550101", "GB"))),
            ContactCard("Unverified", legacy_unverified = true, region = "GB", fields = listOf(point("020 7946 0018"), point("+442079460018"))),
            ContactCard("Extension", region = "GB", fields = listOf(point("+442079460018 ext 1"), point("+442079460018 ext 2"), point("+442079460018"))),
            ContactCard("Pause", fields = listOf(point("+12025550101,42"), point("+12025550101;42"))),
            ContactCard("Short", legacy_unverified = true, fields = listOf(point("01234"), point("1234"))),
            ContactCard("Region override", legacy_unverified = true, fields = listOf(point("030123456", "DE"), point("030123456", "JP"))),
        )
        for (card in cards) assertSame(card, card.withoutDuplicatePhones().card)
    }

    @Test fun formattingOnlyAndEquivalentExtensionsAreDuplicatesWithoutRewritingNumbers() {
        val unverified = ContactCard("Unknown country", legacy_unverified = true, fields = listOf(point("030 123-456"), point("(030)123456")))
        assertEquals(1, unverified.withoutDuplicatePhones().removed)
        assertTrue(unverified.withoutDuplicatePhones().card.legacy_unverified)
        assertEquals("030 123-456", unverified.withoutDuplicatePhones().card.fields.single().value)
        val extended = ContactCard("Extended", region = "GB", fields = listOf(point("02079460018 ext. 42"), point("+442079460018;ext=42")))
        assertEquals(1, extended.withoutDuplicatePhones().removed)
        val italian = ContactCard("Italy", region = "IT", fields = listOf(point("06 6982"), point("+39 06 6982")))
        assertEquals(1, italian.withoutDuplicatePhones().removed)
    }

    @Test fun incompatibleStructuredDetailsAndNonPhoneFieldsArePreserved() {
        val a = point("+12025550101").copy(structured = "first metadata")
        val b = point("+1 (202) 555-0101").copy(structured = "different metadata")
        val email = ContactField("email", "same@example.test")
        val card = ContactCard("Metadata", fields = listOf(a, b, email, email, point(""), point("")))
        assertSame(card, card.withoutDuplicatePhones().card)
    }

    @Test fun durableCleanupRetainsOriginalsOtherPeopleAndHistoricalGraph() = runBlocking {
        val dir = temp.newFolder()
        val store = Store(dir)
        val first = store.saveContact(ContactCard("First", region = "GB", notes = "Keep notes", originals = listOf("Original source"), source_records = listOf("Source reference"), fields = listOf(ContactField("phone", "02079460018", "Work"), ContactField("phone", "+442079460018", "Mobile"))))
        val second = store.saveContact(ContactCard("Other person with same number", fields = listOf(ContactField("phone", "+442079460018"))))
        val old = store.snapshot().graph!!
        val before = store.state.value.records.people.getValue(first)
        val other = store.state.value.records.people.getValue(second)
        val cleanup = before.contactCard().withoutDuplicatePhones()
        store.saveContact(cleanup.card, first, before.contact_uid, expectedPerson = before)
        val restarted = Store(dir); restarted.initialize()
        val after = restarted.state.value.records.people.getValue(first).contactCard()
        assertEquals(cleanup.card.fields, after.fields)
        assertEquals(before.contactCard().originals, after.originals)
        assertEquals(before.contactCard().source_records, after.source_records)
        assertEquals(before.contactCard().notes, after.notes)
        assertEquals(other, restarted.state.value.records.people.getValue(second))
        assertEquals(2, GraphStore(old).project().people.getValue(first).contactCard().fields.size)
        assertTrue(restarted.snapshot().graph!!.bundle.commits.size > old.bundle.commits.size)
        assertEquals(0, after.withoutDuplicatePhones().removed)
    }
}
