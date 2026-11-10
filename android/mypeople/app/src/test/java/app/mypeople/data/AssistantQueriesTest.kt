package app.mypeople.data

import org.junit.Assert.*
import org.junit.Test
import java.time.LocalDate

class AssistantQueriesTest {
    private val today = LocalDate.of(2026, 11, 10)
    private fun card(name: String, vararg fields: ContactField) = ContactCard(name, fields = fields.toList())
    private val records = Records(
        people = mapOf(
            1 to Person("Robert Lee", aliases = listOf("Rob"), category = "friend", closeness = 0.9, trend = "drifting", last_contact = "2026-08-01T10:00:00",
                card = card("Robert Lee", ContactField("phone", "+15551234567"), ContactField("email", "rob@example.com"), ContactField("address", "12 Elm St, Austin, TX"))),
            2 to Person("Dana", category = "family", closeness = 0.5, cadence_days = 14.0, last_contact = "2026-10-01"),
            3 to Person("Muted Mo", trend = "drifting", muted = true, closeness = 0.99),
            4 to Person("Trashed Robin", trashed = true, trend = "drifting", closeness = 1.0, card = card("Trashed Robin", ContactField("address", "Austin"))),
            5 to Person("Ana", closeness = 0.2, cadence_days = 30.0, last_contact = "2026-10-20"),
        ),
        events = mapOf(
            "1" to Event(2, "move", "Moved to Austin", "2025-06-01", source = "imessage"),
            "2" to Event(2, "move", "Moved to Lisbon", "2026-03-01", source = "imessage"),
            "3" to Event(1, "job", "Engineer at Acme", "2024-01", source = "imessage"),
            "4" to Event(1, "birthday", "Birthday", "1995-11-20", source = "vcard"),
            "5" to Event(4, "birthday", "Birthday", "--11-12", source = "vcard"),
            "6" to Event(1, "note", "Training for the Berlin marathon", source = "manual", created_at = "2026-10-01"),
        ),
        moments = mapOf(
            "birthday:1" to Moment(1, "birthday", "Rob's birthday is coming up", surfaced_on = "2026-11-10"),
            "old" to Moment(2, "catch_up", "Too old", surfaced_on = "2026-10-01"),
            "trash" to Moment(4, "birthday", "Trashed", surfaced_on = "2026-11-10"),
        ),
    )

    @Test fun `find resolves nicknames and returns contact details but never trashed people`() {
        val found = records.assistantFindPeople("rob", 10)
        assertEquals(listOf(1), found.map { it.personId })
        assertEquals(listOf("+15551234567"), found.single().phones)
        assertEquals(listOf("rob@example.com"), found.single().emails)
        assertEquals("2026-08-01", found.single().lastContact)
    }

    @Test(expected = IllegalArgumentException::class) fun `find rejects an empty query instead of listing everyone`() {
        records.assistantFindPeople("  ", 10)
    }

    @Test fun `summary reports current profile, recency, and recent facts`() {
        val s = records.assistantSummary(1, today)!!
        assertEquals("Engineer at Acme", s.currentJob)
        assertEquals(101, s.daysSinceLastContact)
        assertTrue(s.recentFacts.any { it.type == "note" && it.value.contains("Berlin") })
        assertNull(records.assistantSummary(4, today))
        assertNull(records.assistantSummary(99, today))
    }

    @Test fun `moments cover the last week and skip trashed people`() {
        assertEquals(listOf("birthday:1"), records.assistantMoments(today).map { it.momentId })
    }

    @Test fun `place matches addresses and only the latest move`() {
        assertEquals(listOf(1 to "address"), records.assistantPeopleIn("austin").map { it.personId to it.source })
        assertEquals(listOf(2 to "Moved to Lisbon"), records.assistantPeopleIn("Lisbon").map { it.personId to it.where })
    }

    @Test fun `drifting includes fading and overdue people, not muted or trashed`() {
        val drifting = records.assistantDrifting(today, 10)
        assertEquals(listOf(1, 2), drifting.map { it.personId })
        assertTrue(drifting[1].why.contains("every 14"))
    }

    @Test fun `upcoming dates respect the window and skip trashed people`() {
        assertEquals(emptyList<Int>(), records.assistantUpcoming(today, 5).map { it.personId })
        val soon = records.assistantUpcoming(today, 14)
        assertEquals(listOf("2026-11-20"), soon.map { it.date })
        assertEquals("Birthday · turns 31", soon.single().label)
    }
}
