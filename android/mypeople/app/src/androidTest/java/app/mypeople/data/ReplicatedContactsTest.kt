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
        check(graph.store.state.value.records.people.isEmpty() && graph.store.state.value.pending.isEmpty() && !graph.settings.configured) { "Use a fresh disposable emulator." }
        for (permission in listOf(Manifest.permission.READ_CONTACTS, Manifest.permission.WRITE_CONTACTS)) instrumentation.uiAutomation.grantRuntimePermission(context.packageName, permission)
        graph.settings.contactsEnabled = false
        val first = graph.store.saveContact(ContactCard("Ada QA", notes = "Original", region = "GB", fields = listOf(ContactField("phone", "020 7946 0018", region = "GB"))))
        val second = graph.store.saveContact(ContactCard("Ada duplicate QA", notes = "Original", fields = listOf(ContactField("email", "ada@example.test"))))
        val people = graph.store.state.value.records.people
        val uid = people.getValue(second).contact_uid
        val base = ContactHistory(graph.store.snapshot().replica.changes)
        graph.deviceContacts.ensureAccount(); graph.settings.contactsEnabled = true
        assertFalse(graph.deviceContacts.reconcile().contains("Conflicts"))
        val start = System.nanoTime()
        graph.submitEdit("merge", buildJsonObject { putJsonArray("person_ids") { add(first); add(second) } })
        println("Provider-backed local merge: ${(System.nanoTime() - start) / 1_000_000}ms")
        assertEquals(1, graph.store.state.value.records.people.size)
        assertEquals(3, graph.store.state.value.pending.count { it.kind == "contact_change" })
        graph.deviceContacts.reconcile()
        var merged = graph.store.state.value.records.people.values.single()
        assertNotNull(graph.deviceContacts.lookup(merged.contact_uid))
        assertEquals(1, context.contentResolver.query(C.RawContacts.CONTENT_URI, arrayOf(C.RawContacts._ID), "${C.RawContacts.ACCOUNT_TYPE}=? AND ${C.RawContacts.DELETED}=0", arrayOf(DeviceContacts.ACCOUNT_TYPE), null)!!.use { it.count })
        graph.settings.contactsEnabled = false
        val remote = base.plus(listOf(base.edit(uid, values = buildJsonObject { put("notes", "Mac note") })))
        // The remote branch has never seen our merge. Import must join, not replace it.
        graph.store.installOffline(TransferManifest(type = "snapshot", source = newContactUid(), publisher = newContactUid(), revision = 1,
            contact_version = 1, contact_history = remote.changes, contact_heads = remote.heads))
        merged = graph.store.state.value.records.people.values.single()
        assertEquals(setOf("Original", "Mac note"), merged.contact_conflicts.getValue("notes").map { it.value.jsonPrimitive.content }.toSet())
        graph.settings.contactsEnabled = true
        assertTrue(graph.deviceContacts.reconcile().contains("Conflicts"))
        compose.setContent {
            val state by graph.store.state.collectAsStateWithLifecycle()
            val person = state.records.people.entries.single()
            MyPeopleTheme { ContactDetails(person.value, person.key, graph) { } }
        }
        compose.onNodeWithText("Two versions, safely kept").assertIsDisplayed()
        compose.onNodeWithText("Keep Mac note").performClick()
        compose.waitUntil(5000) { graph.store.state.value.records.people.values.single().contact_conflicts.isEmpty() }
        assertEquals("Mac note", graph.store.state.value.records.people.values.single().contactCard().notes)
        assertFalse(graph.deviceContacts.reconcile().contains("Conflicts"))
        val root = graph.store.state.value.records.people.values.single().contact_uid
        val rawId = context.contentResolver.query(C.RawContacts.CONTENT_URI, arrayOf(C.RawContacts._ID), "${C.RawContacts.ACCOUNT_TYPE}=? AND ${C.RawContacts.SOURCE_ID}=? AND ${C.RawContacts.DELETED}=0", arrayOf(DeviceContacts.ACCOUNT_TYPE, root), null)!!.use { assertTrue(it.moveToFirst()); it.getLong(0) }
        val note = context.contentResolver.query(C.Data.CONTENT_URI, arrayOf(K.Note.NOTE), "${C.Data.RAW_CONTACT_ID}=? AND ${C.Data.MIMETYPE}=?", arrayOf(rawId.toString(), K.Note.CONTENT_ITEM_TYPE), null)!!.use { assertTrue(it.moveToFirst()); it.getString(0) }
        assertEquals("Mac note", note)
        val restarted = Store(File(context.filesDir, "memory")); restarted.initialize()
        assertEquals("Mac note", restarted.state.value.records.people.values.single().contactCard().notes)
        assertEquals(4, restarted.state.value.pending.size)
        graph.settings.contactsEnabled = false
        Unit
    }
}
