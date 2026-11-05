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
    @Test fun `enrichment is queued without fabricating facts`() {
        val base = Records(people)
        assertEquals(base, optimistic(base, listOf(op("note", """{"person_id":1,"text":"Remember"}"""), op("extract", """{"person_id":1}"""), op("photos", "{}"), op("find_profiles", """{"person_id":1}"""))))
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
    @Test fun `feed uses said at not event date excludes imports and bounds dates`() {
        val records = Records(people, events = mapOf(
            "old-event" to e(date = "2000", said = "2026-10-26 10:00:00"),
            "unknown" to e(said = null), "old-said" to e(said = "2026-01-01"),
            "vcard" to e(source = "vcard"), "google" to e(source = "google"), "linkedin" to e(source = "linkedin"),
            "newer" to e(said = "2026-10-27"), "future" to e(said = "2027-01-01"), "orphan" to e(pid = 99),
            "boundary" to e(said = now.minusDays(90).toString()),
        ))
        assertEquals(listOf("newer", "old-event", "boundary"), records.feed(now).map { it.key })
        assertEquals(LocalDate.of(2026, 10, 26), weekOf("2026-10-27"))
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
    @Test fun `paging follows server cursors through ops-only pages and deletes`() = runBlocking {
        val calls = mutableListOf<Long>()
        val first = RecordChange("person", "1", json.encodeToJsonElement(Person("A")))
        val pending = op("rename", """{"person_id":1,"name":"B"}""")
        var disk = DiskState(pending = listOf(pending))
        pullChanges(0, { since ->
            calls += since
            when (since) {
                0L -> Changes(5, true, listOf(first), emptyList())
                5L -> Changes(12, true, emptyList(), listOf(OpState(1, pending.client_id, pending.kind, pending.payload, "pending")))
                else -> Changes(20, false, listOf(RecordChange("person", "1", null)), listOf(OpState(1, pending.client_id, pending.kind, pending.payload, "done")))
            }
        }, { disk = disk.receive(it) })
        assertEquals(listOf(0L, 5L, 12L), calls)
        assertEquals(20, disk.cursor.toInt())
        assertTrue(disk.records.people.isEmpty())
        assertTrue(disk.pending.isEmpty())
    }
    @Test fun `paging refuses nonadvancing or backward cursor before applying`() = runBlocking {
        for (cursor in listOf(4L, 5L)) {
            var applied = false
            try {
                pullChanges(5, { Changes(cursor, true, emptyList(), emptyList()) }, { applied = true })
                fail("Expected invalid cursor")
            } catch (_: IllegalStateException) { assertFalse(applied) }
        }
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
    @Test fun `HTTP restricted to emulator and HTTPS origins only`() {
        assertNull(validateServerUrl("https://host.tailnet.ts.net"))
        assertNull(validateServerUrl("http://10.0.2.2:8765"))
        listOf("http://host", "http://127.0.0.1:8765", "https://u:p@host", "https://host/path", "https://host?token=x", "https://host/#fragment", "garbage").forEach { assertNotNull(it, validateServerUrl(it)) }
    }
}
