package app.mypeople.data

import kotlinx.coroutines.runBlocking
import kotlinx.serialization.json.*
import org.junit.Assert.*
import org.junit.Test
import java.time.LocalDate

class LogicTest {
    private val now = LocalDate.of(2026, 10, 27)
    private fun op(kind: String, payload: String) = PendingOp("id-$kind", kind, json.parseToJsonElement(payload).jsonObject, created_at = "2026-10-27T12:00:00")
    private fun e(type: String = "job", date: String = "", source: String = "imessage", said: String? = "2026-10-25", pid: Int = 1, created: String = "2026-10-01") = Event(pid, type, "$type fact", date, source = source, said_at = said, created_at = created)
    private val people = mapOf(1 to Person("Sam", aliases = listOf("Sammy"), identifiers = listOf(Identifier("phone", "5551234567"))), 2 to Person("Samuel", channels = listOf(ChannelCount("email", 20))))

    @Test fun `rename aliases and relationship overlay never mutate server records`() {
        val base = Records(people = people)
        val view = optimistic(base, listOf(
            op("rename", """{"person_id":1,"name":"New name"}"""),
            op("alias_add", """{"person_id":1,"alias":"Sammy"}"""),
            op("alias_add", """{"person_id":1,"alias":"S"}"""),
            op("alias_remove", """{"person_id":1,"alias":"sAMMy"}"""),
            op("relationship", """{"person_id":1,"category":"friend","closeness":0.8,"cadence_days":12,"muted":true}"""),
        ))
        assertEquals("Sam", base.people[1]?.name)
        assertEquals("New name", view.people[1]?.name)
        assertEquals(listOf("S"), view.people[1]?.aliases)
        assertEquals("friend", view.people[1]?.category)
        assertEquals(0.8, view.people.getValue(1).closeness, 0.001)
        assertEquals(12.0, view.people.getValue(1).cadence_days!!, 0.001)
        assertTrue(view.people.getValue(1).muted)
    }
    @Test fun `temporary events forget profile and moment status`() {
        val base = Records(people, events = mapOf("8" to e()), profiles = mapOf("9" to Profile(1, "github", "https://example.com")), moments = mapOf("birthday:1" to Moment(1, "birthday", "Birthday", surfaced_on = now.toString())))
        val queue = listOf(op("event_add", """{"person_id":1,"type":"move","value":"Denver"}"""), op("event_forget", """{"event_id":8}"""), op("profile_status", """{"profile_id":9,"status":"confirmed"}"""), op("moment_status", """{"key":"birthday:1","status":"done"}"""))
        val view = optimistic(base, queue)
        assertEquals(setOf("-1"), view.events.keys)
        assertEquals("manual", view.events.getValue("-1").source)
        assertEquals("2026-10-27T12:00:00", view.events.getValue("-1").created_at)
        assertEquals("confirmed", view.profiles["9"]?.status)
        assertEquals("done", view.moments["birthday:1"]?.status)
        assertEquals(view, optimistic(base, queue))
    }
    @Test fun `merge keeps history winner reroutes records and subsequent edits`() {
        val base = Records(people, events = mapOf("1" to e()), dupes = mapOf("1-2" to Dupes(listOf(1, 2)), "1-2-3" to Dupes(listOf(1, 2, 3))))
        val view = optimistic(base, listOf(op("merge", """{"person_ids":[1,2]}"""), op("rename", """{"person_id":1,"name":"Merged"}""")))
        assertEquals(setOf(2), view.people.keys)
        assertEquals("Merged", view.people[2]?.name)
        assertEquals(2, view.events["1"]?.person_id)
        assertFalse("1-2" in view.dupes)
        assertEquals(listOf(2, 3), view.dupes["1-2-3"]?.person_ids)
    }
    @Test fun `distinct hides selected duplicate group but not larger groups`() {
        val base = Records(dupes = mapOf("1-2" to Dupes(listOf(1, 2)), "1-2-3" to Dupes(listOf(1, 2, 3))))
        assertEquals(setOf("1-2-3"), optimistic(base, listOf(op("distinct", """{"person_ids":[1,2]}"""))).dupes.keys)
    }
    @Test fun `a note shows on the contact at once as your own words`() {
        val note = optimistic(Records(people), listOf(op("note", """{"person_id":1,"text":"  Remember  "}"""))).events.values.single()
        assertEquals("Remember", note.value)
        assertTrue(note.isNote && note.isManual)
        assertEquals("Added by you", note.origin)
    }
    @Test fun `every fact says whether you wrote it or it was derived`() {
        fun event(type: String, source: String) = Event(1, type, "x", source = source)
        assertTrue(event("job", "manual").isManual && !event("job", "manual").isNote)
        assertFalse(event("family", "note").isManual)
        assertEquals("Derived from your note", event("family", "note").origin)
        assertEquals("Imported from a vCard", event("job", "vcard").origin)
        assertEquals("Derived from imessage", event("job", "imessage").origin)
    }
    @Test fun `requests queued by an older version are kept without fabricating facts`() {
        val base = Records(people)
        assertEquals(base, optimistic(base, listOf(op("extract", """{"person_id":1}"""), op("photos", "{}"), op("find_profiles", """{"person_id":1}"""))))
    }
    @Test fun `current profile matches Python source preference date and creation fallback`() {
        val oldConversation = e(date = "2020", source = "imessage")
        val addressBook = e(date = "2026", source = "vcard")
        val latest = e(date = "", source = "manual", created = "2026-10-27")
        val education = e(type = "education", date = "--10-10", created = "2026-10-26")
        val result = currentProfile(listOf(oldConversation, addressBook, latest, education, e(type = "interest")))
        assertEquals(latest, result["job"])
        assertEquals(education, result["education"])
        assertEquals(2, result.size)
        assertEquals(oldConversation, currentProfile(listOf(oldConversation, addressBook))["job"])
    }
    @Test fun `date formatting handles partial yearless unknown and invalid dates`() {
        assertEquals("date unknown", formatDate(""))
        assertEquals("2020", formatDate("2020"))
        assertEquals("Oct 2020", formatDate("2020-10"))
        assertEquals("Oct 2, 2020", formatDate("2020-10-02"))
        assertEquals("Feb 29", formatDate("--02-29"))
        assertEquals("date unknown", formatDate("2026-02-29"))
        assertEquals("", normalizeDate("--13-02"))
        assertEquals("", normalizeDate("2026-13"))
        assertEquals("", normalizeDate("words"))
    }
    @Test fun `today is new only today first then last seven days`() {
        fun m(date: String, status: String = "new") = Moment(1, "life", "Reason", surfaced_on = date, status = status)
        val records = Records(people, moments = mapOf("old" to m("2026-10-21"), "today" to m("2026-10-27"), "done" to m("2026-10-27", "done"), "ancient" to m("2026-10-01"), "future" to m("2026-10-28")))
        assertEquals(listOf("today", "old"), records.today(now).map { it.key })
    }
    @Test fun `upcoming handles rollover ages anniversaries plans muted and partial dates`() {
        val records = Records(people + (3 to Person("Muted", muted = true)), events = mapOf(
            "birthday" to e(type = "birthday", date = "1990-11-01"),
            "yearless" to e(type = "birthday", date = "--10-28"),
            "loss" to e(type = "loss", date = "2020-11-02"),
            "engaged" to e(type = "engagement", date = "2023-11-03"),
            "trip" to e(type = "trip", date = "2026-12-01"),
            "partial" to e(type = "wedding", date = "2020-11"),
            "muted" to e(type = "birthday", date = "--11-02", pid = 3),
            "outside" to e(type = "plan", date = "2027-01-01"),
            "past" to e(type = "trip", date = "2026-10-01"),
        ))
        val result = records.upcoming(now)
        assertEquals(listOf("yearless", "birthday", "loss", "engaged", "trip"), result.map { it.eventId })
        assertEquals("Birthday · turns 36", result[1].label)
        assertEquals("6 years since · loss", result[2].label)
        val rollover = Records(people, events = mapOf("b" to e(type = "birthday", date = "--01-02"))).upcoming(LocalDate.of(2026, 12, 25))
        assertEquals(LocalDate.of(2027, 1, 2), rollover.single().on)
    }
    @Test fun `leap birthday falls on March first outside leap year`() {
        val r = Records(people, events = mapOf("b" to e(type = "birthday", date = "2000-02-29")))
        assertEquals(LocalDate.of(2027, 3, 1), r.upcoming(LocalDate.of(2027, 2, 1)).single().on)
    }
    @Test fun `search supports nickname formatted phones email and closeness ordering`() {
        val r = Records(people + (3 to Person("Other", closeness = 0.9, identifiers = listOf(Identifier("email", "other@example.com")))))
        assertEquals(3, r.search("").first().key)
        assertEquals(1, r.search("SAMMY").single().key)
        assertEquals(1, r.search("(555) 123-4567").single().key)
        assertEquals(3, r.search("example.com").single().key)
        assertEquals("(555) 123-4567", formatPhone("5551234567"))
    }
    @Test fun `failed op rolls back overlay preserves server and surfaces message once`() {
        val op = op("rename", """{"person_id":1,"name":"B"}""")
        val disk = DiskState(records = Records(people), pending = listOf(op))
        val page = Changes(1, false, emptyList(), listOf(OpState(1, op.client_id, op.kind, op.payload, "failed", "name is missing")))
        val next = disk.receive(page)
        assertTrue(next.pending.isEmpty())
        assertEquals("Sam", optimistic(next.records, next.pending).people[1]?.name)
        assertEquals("name is missing", next.notices.single().message)
        assertEquals(next.notices, next.receive(page).notices)
    }

    @Test fun forgettingByWhatItSaysFindsAFactNotSyncedYet() {
        val base = Records(people = mapOf("1" to Person("Sam Rivera")).mapKeys { 1 })
        fun op(kind: String, vararg fields: Pair<String, String>) = PendingOp("c-$kind", kind, buildJsonObject {
            put("person_id", 1); fields.forEach { (k, v) -> put(k, v) }
        })
        val added = optimistic(base, listOf(op("event_add", "type" to "job", "value" to "Works at Example", "date" to "")))
        assertEquals(1, added.events.size)
        val gone = optimistic(base, listOf(
            op("event_add", "type" to "job", "value" to "Works at Example", "date" to ""),
            op("event_forget", "type" to "job", "value" to "Works at Example", "date" to ""),
        ))
        assertEquals(0, gone.events.size)
    }
}
