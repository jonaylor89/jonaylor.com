package app.mypeople.data

import java.util.UUID
import java.util.Base64
import kotlinx.coroutines.runBlocking
import kotlinx.serialization.json.*
import org.junit.Assert.*
import org.junit.Rule
import org.junit.Test
import org.junit.rules.TemporaryFolder

class PhotoCandidatesTest {
    @get:Rule val temp = TemporaryFolder()
    private fun fixture(): Pair<GraphStore, String> {
        val fixture = json.parseToJsonElement(javaClass.getResource("/photo-candidates.json")!!.readText()).jsonObject
        val bundle = json.decodeFromJsonElement<GraphBundle>(fixture.getValue("bundle"))
        return GraphStore(GraphState(bundle)) to fixture.text("uid")
    }

    @Test fun `shared Python fixture selects adequate recent image not largest or newest thumbnail`() {
        val (gs, uid) = fixture()
        val expected = json.parseToJsonElement(javaClass.getResource("/photo-candidates.json")!!.readText()).jsonObject.getValue("expected").jsonObject
        val choices = gs.photoChoices(uid)
        assertEquals(expected.text("selected"), choices.selected)
        assertEquals(expected.text("preferred"), choices.preferred)
        assertTrue(choices.automatic)
        assertFalse(choices.conflict)
        assertEquals(3, choices.candidates.size)
        assertEquals("whatsapp", choices.candidates.single { it.id == choices.selected }.source)
        assertEquals(choices.candidates.single { it.id == choices.selected }.hash, gs.project().people.values.single().photo)
    }

    @Test fun `offline preference survives restart and unrelated card edit without rewriting assets`() = runBlocking {
        val (gs, uid) = fixture()
        val directory = temp.newFolder()
        val store = Store(directory)
        store.installOffline(TransferManifest(type = "snapshot", source = gs.state.bundle.collection, revision = 1, graph = gs.state.bundle))
        val photo = store.photoChoices(uid).candidates.first { it.source == "groupme" }
        store.choosePhoto(uid, photo.id)
        var row = store.state.value.records.people.entries.single()
        assertEquals(photo.hash, row.value.photo)
        store.saveContact(row.value.contactCard().copy(favorite = true), row.key, uid)
        assertEquals(3, store.photoChoices(uid).candidates.size)
        assertEquals(photo.id, store.photoChoices(uid).preferred)
        val restarted = Store(directory)
        restarted.initialize()
        assertEquals(photo.id, restarted.photoChoices(uid).preferred)
        restarted.choosePhoto(uid, "")
        assertTrue(restarted.photoChoices(uid).automatic)
        assertEquals(3, restarted.photoChoices(uid).candidates.size)
        assertEquals(GraphStore(restarted.snapshot().graph!!).project(), restarted.state.value.records)
    }

    @Test fun `concurrent pins survive sync as explicit conflict and choice resolves both`() {
        val (base, uid) = fixture()
        val photos = base.photoChoices(uid).candidates
        val left = base.choosePhoto(uid, photos[0].id)
        val right = GraphStore(base.state.copy(peer = UUID.randomUUID().toString())).choosePhoto(uid, photos[1].id)
        val merged = GraphStore(GraphStore(left).receive(right.bundle))
        assertTrue(merged.photoChoices(uid).conflict)
        assertThrows(IllegalArgumentException::class.java) { merged.choosePhoto(uid, "", base.photoChoices(uid).observed) }
        val resolved = GraphStore(merged.choosePhoto(uid, ""))
        assertFalse(resolved.photoChoices(uid).conflict)
        assertTrue(resolved.photoChoices(uid).automatic)
    }

    @Test fun `manual upload and replacement keep previous photo and return to automatic keeps all`() {
        val (base, uid) = fixture()
        val image = Base64.getEncoder().encodeToString(byteArrayOf(0xff.toByte(), 0xd8.toByte(), 0xff.toByte(), 0, 1))
        val old = base.project().people.values.single().contactCard()
        val uploaded = GraphStore(base.saveCard(uid, old.copy(photo = image, photo_hash = "")))
        assertEquals(4, uploaded.photoChoices(uid).candidates.size)
        assertEquals(uploaded.photoChoices(uid).selected, uploaded.photoChoices(uid).preferred)
        val automatic = GraphStore(uploaded.choosePhoto(uid, ""))
        val reuploaded = GraphStore(automatic.saveCard(uid, automatic.project().people.values.single().contactCard().copy(photo = image, photo_hash = "")))
        assertEquals(4, reuploaded.photoChoices(uid).candidates.size)
        assertFalse(reuploaded.photoChoices(uid).automatic)
        assertEquals(4, automatic.photoChoices(uid).candidates.size)
        assertTrue(automatic.photoChoices(uid).automatic)
    }

    @Test fun `merge undo keeps source associations and preferred candidate`() {
        val (base, uid) = fixture()
        val photo = base.photoChoices(uid).candidates.first().id
        val pinned = GraphStore(base.choosePhoto(uid, photo))
        val other = UUID.randomUUID().toString()
        val both = GraphStore(pinned.saveCard(other, ContactCard("Synthetic Other")))
        val link = VersionedGraph.createEdge("same_person", uid, other)
        val merged = GraphStore(both.commit(listOf(link)))
        assertEquals(3, merged.photoChoices(uid).candidates.size)
        assertEquals(photo, merged.photoChoices(other).preferred)
        val separate = GraphStore(merged.commit(listOf(merged.graph.edit(link.target, "_lifecycle", JsonPrimitive("retracted")))))
        assertEquals(photo, separate.photoChoices(uid).preferred)
        assertTrue(separate.photoChoices(other).candidates.isEmpty())
    }
}
