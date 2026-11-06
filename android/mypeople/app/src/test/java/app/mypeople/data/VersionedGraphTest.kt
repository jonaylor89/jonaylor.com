package app.mypeople.data

import java.util.UUID
import kotlinx.serialization.json.*
import org.junit.Assert.*
import org.junit.Test

class VersionedGraphTest {
    private fun fixture() = VersionedGraph.wire.parseToJsonElement(javaClass.getResource("/versioned-graph.json")!!.readText()).jsonObject
    private fun commits() = VersionedGraph.wire.decodeFromJsonElement<List<GraphCommit>>(fixture().getValue("commits"))
    private fun id() = UUID.randomUUID().toString()

    @Test fun decoderSharesExactUuidAndPropertyStringsWithoutChangingWireValues() {
        val person = VersionedGraph.createObject("Person", buildJsonObject { put("label", "Synthetic 🌱\u0000 value") })
        val name = VersionedGraph.createObject("Name", buildJsonObject { put("display", "Synthetic 🌱\u0000 value") })
        val edge = VersionedGraph.createEdge("has_name", person.target, name.target)
        val commit = VersionedGraph().commit(id(), listOf(person, name, edge))
        val raw = VersionedGraph.wire.encodeToString(GraphCommit.serializer(), commit)
        val decoded = GraphAtoms.decoding { VersionedGraph.wire.decodeFromString<GraphCommit>(raw) }
        assertEquals(commit, decoded)
        assertSame(decoded.operations[0].target, decoded.operations[2].payload.getValue("from").jsonPrimitive.content)
        assertSame(decoded.operations[0].kind, decoded.operations[1].kind)
        assertEquals(raw, VersionedGraph.wire.encodeToString(GraphCommit.serializer(), decoded))
    }

    @Test fun sharedFixtureConvergesAndSplitPreservesAmbiguity() {
        val expected = fixture().getValue("expect").jsonObject
        val input = commits()
        val g = VersionedGraph(input.reversed())
        val phone = expected.getValue("phone").jsonPrimitive.content
        val person = expected.getValue("person").jsonPrimitive.content
        assertTrue(g.conflicted(phone, "label"))
        assertEquals(setOf("home", "work"), g.alternatives(phone, "label").map { it.value.jsonPrimitive.content }.toSet())
        assertEquals(JsonPrimitive("US"), g.value(phone, "region"))
        assertEquals(listOf(input[1].id, input[2].id), g.heads)
        val move = expected.getValue("move").jsonArray.map { it.jsonPrimitive.content }
        val plan = g.split(person, "Cameron B", move)
        assertEquals(expected.getValue("review").jsonArray.map { it.jsonPrimitive.content }, plan.review)
        val splitCommit = g.commit(id(), plan.operations)
        val result = VersionedGraph(input + splitCommit)
        assertEquals(2, result.components().groups.size)
        assertTrue(move.none(result::active))
        assertEquals(g.objects.size + 2, result.objects.size)
        assertEquals(result.edges, VersionedGraph((input + splitCommit).reversed()).edges)
        assertTrue(result.edges.any { (key, edge) -> result.active(key) && edge.type == "participant" && edge.to == plan.person })
        assertTrue(g.objects.all { (key, entity) -> result.objects[key] == entity })
    }

    @Test fun explicitResolutionReplacesAllObservedAlternatives() {
        val g = VersionedGraph(commits())
        val phone = fixture().getValue("expect").jsonObject.getValue("phone").jsonPrimitive.content
        val unrelated = g.commit(id(), listOf(g.edit(phone, "region", JsonPrimitive("GB"))))
        val next = VersionedGraph(commits() + unrelated)
        assertTrue(next.conflicted(phone, "label"))
        val resolution = next.commit(id(), listOf(next.edit(phone, "label", JsonPrimitive("mobile"))))
        val resolved = VersionedGraph(commits() + unrelated + resolution)
        assertFalse(resolved.conflicted(phone, "label"))
        assertEquals(JsonPrimitive("mobile"), resolved.value(phone, "label"))
    }

    @Test fun lifecycleAlternativesAreNotAnExportableChoice() {
        val g = VersionedGraph(commits())
        val person = fixture().getValue("expect").jsonObject.getValue("person").jsonPrimitive.content
        val trash = g.commit(id(), listOf(g.edit(person, "_lifecycle", JsonPrimitive("trashed"))))
        val keep = g.commit(id(), listOf(g.edit(person, "_lifecycle", JsonPrimitive("active"))))
        val joined = VersionedGraph(commits() + trash + keep)
        assertTrue(joined.conflicted(person, "_lifecycle"))
        assertFalse(joined.active(person))
    }

    @Test fun concurrentDeletionAndEditRemainExplicit() {
        val g = VersionedGraph(commits())
        val person = fixture().getValue("expect").jsonObject.getValue("person").jsonPrimitive.content
        val deletion = g.commit(id(), listOf(g.edit(person, "_lifecycle", JsonPrimitive("trashed"))))
        val edit = g.commit(id(), listOf(g.edit(person, "label", JsonPrimitive("Corrected Cameron"))))
        val joined = VersionedGraph(commits() + deletion + edit)
        assertEquals(2, joined.deletionConflicts(person).size)
        assertFalse(joined.active(person))
        val restore = joined.commit(id(), listOf(joined.edit(person, "_lifecycle", JsonPrimitive("active"))))
        assertTrue(VersionedGraph(commits() + deletion + edit + restore).deletionConflicts(person).isEmpty())
    }

    @Test fun malformedAndForgedHistoryIsRejected() {
        val input = commits()
        assertThrows(IllegalArgumentException::class.java) { VersionedGraph(input.drop(1)) }
        assertThrows(IllegalArgumentException::class.java) { VersionedGraph(input + input.first().copy(recorded_at = "2025-01-01T00:00:00Z")) }
        assertThrows(IllegalArgumentException::class.java) { VersionedGraph(listOf(input.first().copy(parents = listOf(input.first().id)))) }
        assertThrows(IllegalArgumentException::class.java) { VersionedGraph(input + input.last().copy(id = id(), collection = id())) }
        val root = VersionedGraph(listOf(input.first()))
        val phone = fixture().getValue("expect").jsonObject.getValue("phone").jsonPrimitive.content
        val forged = root.commit(id(), listOf(root.edit(phone, "label", JsonPrimitive("forged"), listOf(input[1].operations[0].id))))
        assertThrows(IllegalArgumentException::class.java) { VersionedGraph(input + forged) }
        assertEquals(VersionedGraph(input).commits, VersionedGraph(input + input).commits)
    }

    @Test fun incrementalLocalAppendMatchesReplayAndDoesNotMutateItsBase() {
        val input = commits()
        val base = VersionedGraph(input)
        val phone = fixture().getValue("expect").jsonObject.getValue("phone").jsonPrimitive.content
        val before = base.alternatives(phone, "label")
        val c = base.commit(id(), listOf(base.edit(phone, "label", JsonPrimitive("Resolved"))))
        val appended = base.appended(c)
        val replayed = VersionedGraph(input + c)
        assertEquals(replayed.alternatives(phone, "label"), appended.alternatives(phone, "label"))
        assertEquals(before, base.alternatives(phone, "label"))
        val bad = base.commit(id(), listOf(base.edit(phone, "label", JsonPrimitive("Must rollback")), VersionedGraph.createEdge("same_person", id(), id())))
        assertThrows(IllegalArgumentException::class.java) { base.appended(bad) }
        assertEquals(before, base.alternatives(phone, "label"))
    }

    @Test fun persistentIndexesShareUnchangedComponentsWithoutLeakingAcrossBranches() {
        val person = VersionedGraph.createObject("Person")
        val name = VersionedGraph.createObject("Name", buildJsonObject { put("display", "Original") })
        val edge = VersionedGraph.createEdge("has_name", person.target, name.target)
        val root = VersionedGraph().commit(id(), listOf(person, name, edge))
        val base = VersionedGraph(listOf(root))
        val components = base.components()
        var next = base
        repeat(64) { n ->
            val c = next.commit(id(), listOf(next.edit(name.target, "display", JsonPrimitive("Edit $n"))))
            next = next.appended(c)
            assertSame(components, next.components())
            assertEquals("Original", base.value(name.target, "display")!!.jsonPrimitive.content)
        }
        val branch = base.appended(base.commit(id(), listOf(base.edit(edge.target, "_lifecycle", JsonPrimitive("retracted")))))
        assertFalse(branch.active(edge.target)); assertTrue(base.active(edge.target)); assertTrue(next.active(edge.target))
        assertEquals(base.outgoing(person.target), next.outgoing(person.target))
        assertEquals(base.incoming(name.target), next.incoming(name.target))
        val replayed = VersionedGraph(next.ordered)
        assertEquals(replayed.objects, next.objects)
        assertEquals(replayed.edges, next.edges)
        assertEquals(replayed.alternatives(name.target, "display"), next.alternatives(name.target, "display"))
        val other = VersionedGraph.createObject("Person")
        val expanded = next.appended(next.commit(id(), listOf(other)))
        assertEquals(2, expanded.components().groups.size)
        assertEquals(1, next.components().groups.size)
        assertFalse(base.people.contains(other.target))
        assertTrue(expanded.people.contains(other.target))
    }

    @Test fun incrementalRemoteBranchesMatchFullReplayAndPreserveDecisionOrdering() {
        val input = commits()
        val base = VersionedGraph(input)
        val person = fixture().getValue("expect").jsonObject.getValue("person").jsonPrimitive.content
        fun decision(value: Boolean): GraphCommit {
            val obj = VersionedGraph.createObject("Decision", buildJsonObject { put("action", "favorite"); put("value", value) })
            return base.commit(id(), listOf(obj, VersionedGraph.createEdge("targets", obj.target, person)))
        }
        val left = decision(true); val right = decision(false)
        val replay = VersionedGraph(input + left + right)
        val expected = GraphStore(GraphState(GraphBundle(input.first().collection, replay.heads, replay.ordered))).project()
        for (branches in listOf(listOf(left, right), listOf(right, left))) {
            var incremental = base
            branches.forEach { incremental = incremental.received(it) }
            assertEquals(replay.heads, incremental.heads)
            assertEquals(replay.ordered, incremental.ordered)
            val bundle = GraphBundle(input.first().collection, incremental.heads, incremental.ordered).also { it.reducer = incremental }
            val store = GraphStore(GraphState(bundle))
            assertEquals(expected, store.project())
            val unchanged = store.receive(bundle.copy(commits = emptyList(), blobs = emptyMap()))
            assertSame(incremental, unchanged.bundle.reducer)
        }
        assertEquals(input.size, base.commits.size)
    }

    @Test fun identityLinksCanBeRetractedWithoutDeletingObjects() {
        val a = VersionedGraph.createObject("Person")
        val b = VersionedGraph.createObject("Person")
        val link = VersionedGraph.createEdge("same_person", a.target, b.target)
        val distinct = VersionedGraph.createEdge("distinct_person", a.target, b.target)
        val base = VersionedGraph().commit(id(), listOf(a, b, link, distinct))
        val g = VersionedGraph(listOf(base))
        assertEquals(1, g.components().groups.size)
        assertEquals(listOf(distinct.target), g.components().contradictions)
        val undo = g.commit(id(), listOf(g.edit(link.target, "_lifecycle", JsonPrimitive("retracted"))))
        val separated = VersionedGraph(listOf(base, undo))
        assertEquals(2, separated.components().groups.size)
        assertTrue(separated.components().contradictions.isEmpty())
        assertEquals(g.objects, separated.objects)
    }
}
