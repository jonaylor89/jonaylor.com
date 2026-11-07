package app.mypeople.data

import android.os.Build
import androidx.test.ext.junit.runners.AndroidJUnit4
import androidx.test.platform.app.InstrumentationRegistry
import app.mypeople.MyPeopleApp
import java.io.File
import java.util.UUID
import kotlinx.coroutines.runBlocking
import kotlinx.serialization.encodeToString
import kotlinx.serialization.json.*
import org.junit.Assert.*
import org.junit.Assume.assumeTrue
import org.junit.Test
import org.junit.runner.RunWith

/** Separate-process phases around real operator preview/apply, exclusively on an emulator. */
@RunWith(AndroidJUnit4::class)
class CardFactRepairDeviceTest {
    private fun graph(): app.mypeople.AppGraph {
        assumeTrue(InstrumentationRegistry.getArguments().getString("myPeopleDisposable") == "true")
        check(Build.HARDWARE in setOf("ranchu", "goldfish")) { "Synthetic QA must never run on a phone" }
        return (InstrumentationRegistry.getInstrumentation().targetContext.applicationContext as MyPeopleApp).graph
    }
    private fun expectation() = File(InstrumentationRegistry.getInstrumentation().targetContext.cacheDir, "synthetic-card-fact-repair.json")

    @Test fun prepare() = runBlocking {
        val app = graph(); app.store.initialize()
        check(app.store.state.value.records.people.isEmpty() && app.store.state.value.pending.isEmpty())
        app.settings.contactsEnabled = false
        val uid = UUID.randomUUID().toString()
        var state = GraphStore(GraphStore.empty()).saveCard(uid, ContactCard("Synthetic repair QA", region = "GB", notes = "Keep manual card note", originals = listOf("Keep original source"), fields = listOf(ContactField("phone", "02079460018", "Work"), ContactField("phone", "+442079460018", "Mobile", preferred = true))))
        state = GraphStore(state).saveCard(UUID.randomUUID().toString(), ContactCard("Other person QA", fields = listOf(ContactField("phone", "+442079460018"))))
        val ops = mutableListOf<GraphOperation>(); val retract = mutableListOf<String>()
        for (key in listOf("birthday", "organization", "title")) {
            val source = VersionedGraph.createObject("SourceRecord", buildJsonObject { put("table", "events") })
            val fact = VersionedGraph.createObject("Claim", buildJsonObject { put("predicate", key); put("value", "Original $key fact"); put("source", "synthetic") })
            val card = VersionedGraph.createObject("Claim", buildJsonObject { put("predicate", key); put("value", ""); put("asserted_by", "contact_card") })
            val edge = VersionedGraph.createEdge("subject_of", uid, fact.target)
            val cardEdge = VersionedGraph.createEdge("subject_of", uid, card.target)
            ops += listOf(source, fact, card, edge, cardEdge, VersionedGraph.createEdge("originated_from", fact.target, source.target))
            retract += listOf(edge.target, cardEdge.target)
        }
        state = GraphStore(state).commit(ops)
        var gs = GraphStore(state)
        state = gs.commit(retract.map { gs.graph.edit(it, "_lifecycle", JsonPrimitive("retracted")) })
        app.store.installOffline(TransferManifest(type = "snapshot", source = state.bundle.collection, revision = 1, graph = state.bundle))
        val person = app.store.state.value.records.people.values.first { it.contact_uid == uid }
        expectation().writeText(json.encodeToString(person.contactCard()))
        assertEquals(3, GraphStore(app.store.snapshot().graph!!).repairableCardFactAttributions().size)
    }

    @Test fun verifyRepair() = runBlocking {
        val app = graph(); app.store.initialize()
        val records = app.store.state.value.records
        assertEquals(2, records.people.size)
        val person = records.people.entries.first { it.value.name == "Synthetic repair QA" }
        val before = json.decodeFromString<ContactCard>(expectation().readText())
        assertEquals(before, person.value.contactCard())
        assertEquals(setOf("Original birthday fact", "Original organization fact", "Original title fact", "Keep manual card note"), records.eventsFor(person.key).values.map { it.value }.toSet())
        assertTrue(GraphStore(app.store.snapshot().graph!!).repairableCardFactAttributions().isEmpty())
        assertEquals(5, app.store.snapshot().graph!!.bundle.commits.size)
        app.store.saveContact(before.copy(favorite = !before.favorite), person.key, expectedPerson = person.value)
        assertEquals(4, app.store.state.value.records.eventsFor(person.key).size)
    }

    @Test fun verifyPhoneCleanup() = runBlocking {
        val app = graph(); app.store.initialize()
        val records = app.store.state.value.records
        assertEquals(2, records.people.size)
        val person = records.people.entries.first { it.value.name == "Synthetic repair QA" }
        val card = person.value.contactCard()
        assertEquals(1, card.fields.count { it.kind == "phone" })
        assertEquals("Work / Mobile", card.fields.single().label)
        assertTrue(card.fields.single().preferred)
        assertEquals(listOf("Keep original source"), card.originals)
        assertEquals("Keep manual card note", card.notes)
        assertEquals(4, records.eventsFor(person.key).size)
        assertEquals(1, records.people.values.first { it.name == "Other person QA" }.contactCard().fields.size)
        assertEquals(0, card.withoutDuplicatePhones().removed)
    }
}
