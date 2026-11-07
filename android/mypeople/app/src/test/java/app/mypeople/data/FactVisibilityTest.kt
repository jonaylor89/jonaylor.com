package app.mypeople.data

import kotlinx.serialization.json.*
import org.junit.Assert.*
import org.junit.Test

class FactVisibilityTest {
    @Test fun emptyPeerRegistersStayInHistoryButNeverBecomeVisibleFacts() {
        fun obj(type: String, properties: JsonObject) = VersionedGraph.createObject(type, properties)
        val person = obj("Person", buildJsonObject {})
        val name = obj("Name", buildJsonObject { put("display", "Synthetic person") })
        val cardNote = obj("Note", buildJsonObject { put("body", ""); put("origin", "contact_card_notes") })
        val placeholders = listOf("birthday", "organization", "title").map { predicate ->
            obj("Claim", buildJsonObject { put("predicate", predicate); put("value", ""); put("asserted_by", "contact_card") })
        }
        val fact = obj("Claim", buildJsonObject { put("predicate", "family"); put("value", "Has a sister"); put("source", "imessage"); put("evidence", "Original evidence") })
        val note = obj("Note", buildJsonObject { put("body", "Real manual note"); put("source", "manual") })
        val ops = listOf(person, name, cardNote, fact, note) + placeholders + listOf(
            VersionedGraph.createEdge("has_name", person.target, name.target),
            VersionedGraph.createEdge("has_note", person.target, cardNote.target),
            VersionedGraph.createEdge("subject_of", person.target, fact.target),
            VersionedGraph.createEdge("has_note", person.target, note.target),
        ) + placeholders.map { VersionedGraph.createEdge("subject_of", person.target, it.target) }
        val state = GraphStore(GraphStore.empty()).commit(ops)
        val gs = GraphStore(state)
        val before = gs.graph.ordered
        val records = gs.project()
        assertEquals(setOf("Has a sister", "Real manual note"), records.events.values.map { it.value }.toSet())
        assertEquals("Original evidence", records.events.getValue(fact.target).evidence)
        assertEquals(JsonPrimitive(""), gs.graph.value(cardNote.target, "body"))
        placeholders.forEach { assertTrue(gs.graph.active(it.target)); assertEquals(JsonPrimitive(""), gs.graph.value(it.target, "value")) }
        assertEquals(before, gs.graph.ordered)
    }

    @Test fun savingContactScalarsNeverRetractsOrOverwritesIndependentFacts() {
        val person = VersionedGraph.createObject("Person")
        val name = VersionedGraph.createObject("Name", buildJsonObject { put("display", "Synthetic person") })
        val ops = mutableListOf(person, name, VersionedGraph.createEdge("has_name", person.target, name.target))
        val facts = listOf("birthday" to "1990-02-12", "organization" to "Inferred organization", "title" to "Inferred title").map { (key, value) ->
            val placeholder = VersionedGraph.createObject("Claim", buildJsonObject { put("predicate", key); put("value", ""); put("asserted_by", "contact_card") })
            val fact = VersionedGraph.createObject("Claim", buildJsonObject { put("predicate", key); put("value", value); put("source", "imessage") })
            val attribution = VersionedGraph.createEdge("subject_of", person.target, fact.target)
            ops += listOf(placeholder, fact, VersionedGraph.createEdge("subject_of", person.target, placeholder.target), attribution)
            Triple(fact.target, attribution.target, value)
        }
        var state = GraphStore(GraphStore.empty()).commit(ops)
        val card = GraphStore(state).project().people.values.single().contactCard()
        assertEquals("", card.birthday)
        assertEquals("", card.organization)
        assertEquals("", card.title)
        state = GraphStore(state).saveCard(person.target, card.copy(favorite = true))
        state = GraphStore(state).saveCard(person.target, card.copy(organization = "Manual organization"))
        val gs = GraphStore(state)
        for ((fact, edge, value) in facts) {
            assertTrue(gs.graph.active(edge))
            assertEquals(JsonPrimitive(value), gs.graph.value(fact, "value"))
        }
        assertEquals(facts.map { it.third }.toSet(), gs.project().events.values.map { it.value }.toSet().minus("Manual organization"))
        assertEquals("Manual organization", gs.project().people.values.single().contactCard().organization)
    }

    @Test fun existingMaterializedRowsAreFilteredWithoutChangingSavedData() {
        val original = mapOf(
            "blank-note" to Event(1, "note", ""),
            "blank-scalar" to Event(1, "birthday", "  "),
            "real" to Event(1, "family", "Original fact text"),
            "other-person" to Event(2, "note", "Someone else's note"),
        )
        val records = Records(events = original)
        assertEquals(setOf("real"), records.eventsFor(1).keys)
        assertEquals(4, original.size)
        assertEquals("Original fact text", original.getValue("real").value)
    }
}
