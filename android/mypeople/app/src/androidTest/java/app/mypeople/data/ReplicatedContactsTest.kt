package app.mypeople.data

import android.Manifest
import android.provider.ContactsContract as C
import android.provider.ContactsContract.CommonDataKinds as K
import androidx.compose.runtime.getValue
import androidx.compose.ui.test.*
import androidx.compose.ui.test.junit4.createComposeRule
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import androidx.test.ext.junit.runners.AndroidJUnit4
import androidx.test.platform.app.InstrumentationRegistry
import app.mypeople.MyPeopleApp
import app.mypeople.ui.ContactDetails
import app.mypeople.ui.MyPeopleTheme
import kotlinx.coroutines.runBlocking
import kotlinx.serialization.json.*
import org.junit.Assert.*
import org.junit.Assume.assumeTrue
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith
import java.io.File

/** Opt-in, fresh disposable emulator only. Does not dial, send messages, or use a real database. */
@RunWith(AndroidJUnit4::class)
class ReplicatedContactsTest {
    @get:Rule val compose = createComposeRule()
    @Test fun localMergeRemoteConflictExplicitChoiceProviderAndRestart() = runBlocking {
        assumeTrue(InstrumentationRegistry.getArguments().getString("myPeopleDisposable") == "true")
        val instrumentation = InstrumentationRegistry.getInstrumentation()
        val context = instrumentation.targetContext
        val graph = (context.applicationContext as MyPeopleApp).graph
        graph.store.initialize()
        check(graph.store.state.value.records.people.isEmpty() && graph.store.state.value.pending.isEmpty()) { "Use a fresh disposable emulator." }
        for (permission in listOf(Manifest.permission.READ_CONTACTS, Manifest.permission.WRITE_CONTACTS)) instrumentation.uiAutomation.grantRuntimePermission(context.packageName, permission)
        graph.settings.contactsEnabled = false
        val first = graph.store.saveContact(ContactCard("Ada QA", notes = "Original", region = "GB", fields = listOf(ContactField("phone", "020 7946 0018", region = "GB"))))
        val second = graph.store.saveContact(ContactCard("Ada duplicate QA", notes = "Original", fields = listOf(ContactField("email", "ada@example.test"))))
        val people = graph.store.state.value.records.people
        val uid = people.getValue(second).contact_uid
        val base = graph.store.snapshot().graph!!
        graph.store.saveContact(graph.store.state.value.records.people.getValue(second).contactCard().copy(notes = "Phone note"), second)
        graph.deviceContacts.ensureAccount(); graph.settings.contactsEnabled = true
        assertFalse(graph.deviceContacts.reconcile().contains("Conflicts"))
        val start = System.nanoTime()
        graph.submitEdit("merge", buildJsonObject { putJsonArray("person_ids") { add(first); add(second) } })
        println("Provider-backed local merge: ${(System.nanoTime() - start) / 1_000_000}ms")
        assertEquals(1, graph.store.state.value.records.people.size)
        assertNotNull(graph.store.snapshot().graph)
        assertTrue(graph.store.state.value.pending.isEmpty())
        graph.deviceContacts.reconcile()
        var merged = graph.store.state.value.records.people.values.single()
        assertNotNull(graph.deviceContacts.lookup(merged.contact_uid))
        assertEquals(1, context.contentResolver.query(C.RawContacts.CONTENT_URI, arrayOf(C.RawContacts._ID), "${C.RawContacts.ACCOUNT_TYPE}=? AND ${C.RawContacts.DELETED}=0", arrayOf(DeviceContacts.ACCOUNT_TYPE), null)!!.use { it.count })
        graph.settings.contactsEnabled = false
        // A real Store creates the synthetic peer branch; indexed snapshots are read-only.
        val peer = Store(File(context.cacheDir, "replicated-qa-peer"))
        peer.initialize()
        peer.installOffline(TransferManifest(type = "snapshot", source = base.bundle.collection, revision = 1, graph = base.bundle))
        val remotePerson = peer.state.value.records.people.entries.first { it.value.contact_uid == uid }
        peer.saveContact(remotePerson.value.contactCard().copy(notes = "Mac note"), remotePerson.key)
        val remote = peer.snapshot().graph!!
        // The remote branch has never seen our merge. Import must join, not replace it.
        graph.store.installOffline(TransferManifest(type = "snapshot", source = newContactUid(), publisher = newContactUid(), revision = 1,
            graph = remote.bundle))
        merged = graph.store.state.value.records.people.values.single()
        assertEquals(setOf("Phone note", "Mac note"), merged.contact_conflicts.values.flatten().map { it.value.jsonPrimitive.content }.toSet())
        graph.settings.contactsEnabled = true
        assertTrue(graph.deviceContacts.reconcile().contains("Conflicts"))
        try {
            graph.deviceContacts.prepareMerge(graph.store.state.value.records.people.keys)
            fail("Offline conflicts must still block merge preparation")
        } catch (e: EditRejected) { assertTrue(e.message!!.contains("offline contact conflicts")) }
        compose.setContent {
            val state by graph.store.state.collectAsStateWithLifecycle()
            val person = state.records.people.entries.single()
            MyPeopleTheme { ContactDetails(person.value, person.key, graph) { } }
        }
        compose.onNodeWithText("Two versions, safely kept").assertIsDisplayed()
        compose.onNodeWithText("Keep Mac note").performClick()
        compose.waitUntil(5000) { graph.store.state.value.records.people.values.single().contact_conflicts.isEmpty() }
        assertTrue(graph.store.state.value.records.people.values.single().contactCard().notes.contains("Mac note"))
        assertFalse(graph.deviceContacts.reconcile().contains("Conflicts"))
        val root = graph.store.state.value.records.people.values.single().contact_uid
        val rawId = context.contentResolver.query(C.RawContacts.CONTENT_URI, arrayOf(C.RawContacts._ID), "${C.RawContacts.ACCOUNT_TYPE}=? AND ${C.RawContacts.SOURCE_ID}=? AND ${C.RawContacts.DELETED}=0", arrayOf(DeviceContacts.ACCOUNT_TYPE, root), null)!!.use { assertTrue(it.moveToFirst()); it.getLong(0) }
        val note = context.contentResolver.query(C.Data.CONTENT_URI, arrayOf(K.Note.NOTE), "${C.Data.RAW_CONTACT_ID}=? AND ${C.Data.MIMETYPE}=?", arrayOf(rawId.toString(), K.Note.CONTENT_ITEM_TYPE), null)!!.use { assertTrue(it.moveToFirst()); it.getString(0) }
        assertEquals(graph.store.state.value.records.people.values.single().contactCard().notes, note)
        val restarted = Store(File(context.filesDir, "memory")); restarted.initialize()
        assertEquals(note, restarted.state.value.records.people.values.single().contactCard().notes)
        assertTrue(restarted.state.value.pending.isEmpty())
        assertEquals(graph.store.snapshot().graph!!.bundle.heads, restarted.snapshot().graph!!.bundle.heads)
        graph.settings.contactsEnabled = false
        Unit
    }
}
