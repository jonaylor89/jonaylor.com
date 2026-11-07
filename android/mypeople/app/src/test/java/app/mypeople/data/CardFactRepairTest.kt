package app.mypeople.data

import java.util.UUID
import kotlinx.coroutines.runBlocking
import kotlinx.serialization.json.*
import org.junit.Assert.*
import org.junit.Rule
import org.junit.Test
import org.junit.rules.TemporaryFolder

class CardFactRepairTest {
    @get:Rule val temp = TemporaryFolder()
    private data class Fixture(val state: GraphState, val edges: List<String>, val facts: List<String>, val uid: String)
    private fun fixture(): Fixture {
        val uid = UUID.randomUUID().toString()
        var state = GraphStore(GraphStore.empty()).saveCard(uid, ContactCard("Synthetic repair", notes = "Keep card note", fields = listOf(ContactField("phone", "+12025550101")), originals = listOf("Original source")))
        val ops = mutableListOf<GraphOperation>()
        val edges = mutableListOf<String>(); val facts = mutableListOf<String>(); val retract = mutableListOf<String>()
        for (key in listOf("birthday", "organization", "title")) {
            val source = VersionedGraph.createObject("SourceRecord", buildJsonObject { put("table", "events") })
            val fact = VersionedGraph.createObject("Claim", buildJsonObject { put("predicate", key); put("value", "Original $key fact"); put("source", "synthetic") })
            val card = VersionedGraph.createObject("Claim", buildJsonObject { put("predicate", key); put("value", ""); put("asserted_by", "contact_card") })
            val attribution = VersionedGraph.createEdge("subject_of", uid, fact.target)
            val cardEdge = VersionedGraph.createEdge("subject_of", uid, card.target)
            ops += listOf(source, fact, card, attribution, cardEdge, VersionedGraph.createEdge("originated_from", fact.target, source.target))
            edges += attribution.target; facts += fact.target; retract += listOf(attribution.target, cardEdge.target)
        }
        state = GraphStore(state).commit(ops)
        val gs = GraphStore(state)
        state = gs.commit(retract.map { gs.graph.edit(it, "_lifecycle", JsonPrimitive("retracted")) })
        return Fixture(state, edges.sorted(), facts, uid)
    }

    @Test fun verifiedRepairIsDurableIdempotentAndNeverEditsCardsOrFactBodies() = runBlocking {
        val fixture = fixture()
        val store = Store(temp.newFolder())
        store.initialize()
        store.installOffline(TransferManifest(type = "snapshot", source = fixture.state.bundle.collection, revision = 1, graph = fixture.state.bundle))
        val before = store.state.value.records.people.values.single().contactCard()
        val snapshot = store.snapshot().graph!!
        assertEquals(fixture.edges, GraphStore(snapshot).repairableCardFactAttributions())
        store.repairCardFactAttributions(snapshot.bundle.heads, fixture.edges)
        val after = store.snapshot().graph!!
        assertTrue(fixture.edges.all { GraphStore(after).graph.active(it) })
        assertTrue(GraphStore(after).repairableCardFactAttributions().isEmpty())
        assertEquals(before, store.state.value.records.people.values.single().contactCard())
        for (id in fixture.facts) assertEquals(GraphStore(snapshot).graph.value(id, "value"), GraphStore(after).graph.value(id, "value"))
        assertEquals(snapshot.bundle.commits.size + 1, after.bundle.commits.size)
        assertFalse(GraphStore(snapshot).graph.active(fixture.edges.first()))
        try { store.repairCardFactAttributions(snapshot.bundle.heads, fixture.edges); fail("Stale plan accepted") } catch (_: IllegalArgumentException) { }
    }

    @Test fun rejectedFactsAndExplicitForgetAreNeverRestored() {
        val fixture = fixture()
        var state = fixture.state
        var gs = GraphStore(state)
        state = gs.commit(listOf(gs.graph.edit(fixture.facts[0], "status", JsonPrimitive("rejected")), gs.graph.edit(fixture.facts[1], "_lifecycle", JsonPrimitive("retracted"))))
        assertEquals(1, GraphStore(state).repairableCardFactAttributions().size)
        // A separate explicit edge retraction has no paired contact-card retraction in its commit.
        gs = GraphStore(state)
        state = gs.commit(listOf(gs.graph.edit(fixture.edges.first { edge -> gs.graph.edges.getValue(edge).to == fixture.facts[2] }, "_lifecycle", JsonPrimitive("retracted"))))
        assertTrue(GraphStore(state).repairableCardFactAttributions().isEmpty())
    }
}
