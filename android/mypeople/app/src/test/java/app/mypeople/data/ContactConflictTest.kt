package app.mypeople.data

import java.util.UUID
import kotlinx.coroutines.runBlocking
import kotlinx.serialization.json.*
import org.junit.Assert.*
import org.junit.Rule
import org.junit.Test
import org.junit.rules.TemporaryFolder

class ContactConflictTest {
    @get:Rule val temp = TemporaryFolder()
    private data class Fixture(val state: GraphState, val separate: String)
    private fun fixture(shared: Boolean = false, nameConflict: Boolean = false): Fixture {
        val a = UUID.randomUUID().toString(); val b = UUID.randomUUID().toString(); val c = UUID.randomUUID().toString()
        var base = GraphStore(GraphStore.empty()).saveCard(a, ContactCard("Case A", region = "GB", notes = "A notes", originals = listOf("A original"), fields = listOf(ContactField("phone", "02079460018", "Mobile"))))
        base = GraphStore(base).saveCard(b, ContactCard("Case B", region = "GB", notes = "B notes", originals = listOf("B original"), fields = listOf(ContactField("phone", "+442079460018", if (shared) "Work" else "Mobile"))))
        if (shared) {
            base = GraphStore(base).saveCard(c, ContactCard("Other owner"))
            val points = GraphStore(base).project().people.values.filter { it.contact_uid in setOf(a,b) }.flatMap { it.contactFields() }.map { it.object_id }
            base = GraphStore(base).commit(points.map { VersionedGraph.createEdge("has_contact_point", c, it) })
        }
        val separate = VersionedGraph.createEdge("distinct_person", a, b)
        val oldDecision = GraphStore(base).commit(listOf(separate))
        val laterMerge = GraphStore(base).commit(listOf(VersionedGraph.createEdge("same_person", a, b, buildJsonObject { put("preferred_person", a) })))
        var joined = GraphStore(oldDecision).receive(laterMerge.bundle)
        if (nameConflict) {
            val gs = GraphStore(joined)
            val name = gs.graph.outgoing(a).first { it.second.type == "has_name" }.second.to!!
            val left = gs.commit(listOf(gs.graph.edit(name,"display",JsonPrimitive("Left name"))))
            val right = gs.commit(listOf(gs.graph.edit(name,"display",JsonPrimitive("Right name"))))
            joined = GraphStore(left).receive(right.bundle)
        }
        return Fixture(joined, separate.target)
    }
    private suspend fun install(fixture: Fixture, directory: java.io.File): Store = Store(directory).also {
        it.initialize(); it.installOffline(TransferManifest(type="snapshot",source=fixture.state.bundle.collection,revision=1,graph=fixture.state.bundle))
    }

    @Test fun sixKnownEntriesBecomeTwoNumbersWithoutResolvingIdentityOrDiscardingHints() = runBlocking {
        val a=UUID.randomUUID().toString(); val b=UUID.randomUUID().toString()
        var base=GraphStore(GraphStore.empty()).saveCard(a,ContactCard("Example A",region="GB",legacy_unverified=true,notes="Keep A note",
            fields=listOf("+442079460018","+44 20 7946 0018","+44 (20) 7946-0018").map { ContactField("phone",it,"Mobile") }))
        base=GraphStore(base).saveCard(b,ContactCard("Example B",region="US",legacy_unverified=true,notes="Keep B note",
            fields=listOf("+12025550101","+1 202 555 0101","+1 (202) 555-0101").map { ContactField("phone",it,"Mobile") }))
        val hints=listOf("2079460018","2025550101").map { value ->
            VersionedGraph.createObject("ContactPoint",buildJsonObject { put("kind","phone"); put("value",value); put("matching_hint",true); put("compat_table","identifiers") })
        }
        base=GraphStore(base).commit(hints + hints.map { VersionedGraph.createEdge("has_contact_point",a,it.target) })
        val separate=VersionedGraph.createEdge("distinct_person",a,b)
        val old=GraphStore(base).commit(listOf(separate))
        val merged=GraphStore(base).commit(listOf(VersionedGraph.createEdge("same_person",a,b)))
        val state=GraphStore(old).receive(merged.bundle)
        val dir=temp.newFolder(); val store=install(Fixture(state,separate.target),dir)
        val person=store.state.value.records.people.entries.single()
        val before=store.snapshot().graph!!
        val preview=store.contactPhonePreview(person.value)
        assertEquals(6,preview.entries); assertEquals(2,preview.numbers.size)
        assertEquals(listOf(3,3),preview.numbers.map { it.entries }); assertEquals(2,preview.importHints.size)
        assertEquals(4,preview.cleanup.removed)
        assertEquals(setOf("Example A","Example B"), preview.earlierSeparation.flatMap { listOf(it.left.name,it.right.name) }.toSet())
        assertTrue(preview.earlierSeparation.all { it.left.numbers.size==1 && it.right.numbers.size==1 })
        assertEquals(4,store.cleanDuplicatePhoneFields(person.key,person.value))
        val reopened=Store(dir); reopened.initialize()
        val after=reopened.state.value.records.people.entries.single()
        val clean=reopened.contactPhonePreview(after.value)
        assertEquals(2,clean.entries); assertEquals(2,clean.numbers.size); assertEquals(2,clean.importHints.size)
        assertEquals(preview.importHints,clean.importHints)
        assertEquals(person.value.contact_conflicts,after.value.contact_conflicts)
        assertTrue(GraphStore(reopened.snapshot().graph!!).graph.active(separate.target))
        assertEquals(person.value.contactCard().notes,after.value.contactCard().notes)
        assertEquals(8,GraphStore(before).project().people.values.single().contactFields().size)
        assertEquals("2079460018",phoneDisplay("2079460018"))
    }

    @Test fun mergeWarningsAreNotCompetingFieldVersions() {
        val person = GraphStore(fixture().state).project().people.values.single()
        assertEquals(1, person.mergeDecisionConflicts().size)
        assertEquals("Earlier keep-separate decision", person.contactConflictSummary())
        val key = person.mergeDecisionConflicts().keys.single()
        assertFalse(isMergeDecisionConflict(key, listOf(ContactConflict("ordinary-choice",JsonPrimitive("retracted")))))
        assertEquals("Notes", conflictFieldTitle("${UUID.randomUUID()}/body", person))
        assertFalse(person.contactConflictSummary().contains("_lifecycle"))
    }

    @Test fun explicitKeepAndCleanupShareOneDurableCommitWithoutLosingNotesOrHistory() = runBlocking {
        val fixture = fixture(); val dir = temp.newFolder(); val store = install(fixture,dir)
        val before = store.state.value.records.people.values.single()
        val old = store.snapshot().graph!!
        assertEquals(1, store.resolveMergeDecision(before, keepMerged=true, cleanPhones=true))
        val reopened = Store(dir); reopened.initialize()
        val after = reopened.state.value.records.people.values.single()
        assertTrue(after.contact_conflicts.isEmpty())
        assertEquals(1,after.contactFields().size)
        assertEquals(before.contactCard().notes,after.contactCard().notes)
        assertEquals(before.contactCard().originals,after.contactCard().originals)
        assertEquals(2,reopened.state.value.records.eventsFor(reopened.state.value.records.people.keys.single()).size)
        assertEquals(old.bundle.commits.size+1,reopened.snapshot().graph!!.bundle.commits.size)
        assertTrue(GraphStore(old).graph.active(fixture.separate))
        assertFalse(GraphStore(reopened.snapshot().graph!!).graph.active(fixture.separate))
    }

    @Test fun separateChoiceRestoresExistingOwnershipWithoutDeletingRecords() = runBlocking {
        val fixture=fixture(); val store=install(fixture,temp.newFolder())
        val expected=store.state.value.records.people.values.single()
        assertEquals(0,store.resolveMergeDecision(expected,keepMerged=false,cleanPhones=false))
        val people=store.state.value.records.people.values
        assertEquals(setOf("Case A","Case B"),people.map { it.name }.toSet())
        assertTrue(people.all { it.contact_conflicts.isEmpty() && it.contactFields().size==1 })
        assertEquals(setOf("A notes","B notes"),people.map { it.contactCard().notes }.toSet())
        assertTrue(GraphStore(store.snapshot().graph!!).graph.active(fixture.separate))
    }

    @Test fun staleChoiceAndSharedPhoneMetadataCannotPartiallyApplyAMergeDecision() = runBlocking {
        val fixture=fixture(shared=true); val store=install(fixture,temp.newFolder())
        val expected=store.state.value.records.people.values.first { it.mergeDecisionConflicts().isNotEmpty() }
        val heads=store.snapshot().graph!!.bundle.heads
        try { store.resolveMergeDecision(expected,keepMerged=true,cleanPhones=true); fail("Shared metadata must block the entire combined edit") } catch (_:IllegalArgumentException) { }
        assertEquals(heads,store.snapshot().graph!!.bundle.heads)
        assertTrue(GraphStore(store.snapshot().graph!!).graph.active(fixture.separate))
        store.resolveMergeDecision(expected,keepMerged=true,cleanPhones=false)
        val after=store.snapshot().graph!!.bundle.heads
        try { store.resolveMergeDecision(expected,keepMerged=true,cleanPhones=false); fail("Stale choice accepted") } catch (_:EditRejected) { }
        assertEquals(after,store.snapshot().graph!!.bundle.heads)
    }

    @Test fun confirmingIdentityNeverResolvesOtherIndependentFieldChoices() = runBlocking {
        val fixture=fixture(nameConflict=true); val store=install(fixture,temp.newFolder())
        val expected=store.state.value.records.people.values.single()
        assertTrue(expected.contact_conflicts.size > expected.mergeDecisionConflicts().size)
        val heads=store.snapshot().graph!!.bundle.heads
        try { store.cleanDuplicatePhoneFields(store.state.value.records.people.keys.single(),expected); fail("A genuine field conflict must still block cleanup") } catch (_:IllegalArgumentException) { }
        assertEquals(heads,store.snapshot().graph!!.bundle.heads)
        try { store.resolveMergeDecision(expected,keepMerged=true,cleanPhones=true); fail("Must not clean while a real field conflict remains") } catch (_:IllegalArgumentException) { }
        assertEquals(heads,store.snapshot().graph!!.bundle.heads)
        store.resolveMergeDecision(expected,keepMerged=true,cleanPhones=false)
        val person=store.state.value.records.people.values.single()
        assertTrue(person.mergeDecisionConflicts().isEmpty())
        assertEquals(1,person.contact_conflicts.size)
        val choice=person.contact_conflicts.entries.single()
        store.resolveContact(person.contact_uid,choice.key,choice.value.first().change)
        assertTrue(store.state.value.records.people.values.single().contact_conflicts.isEmpty())
    }
}
