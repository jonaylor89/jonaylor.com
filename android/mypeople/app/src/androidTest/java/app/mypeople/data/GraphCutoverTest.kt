package app.mypeople.data

import android.Manifest
import android.os.Build
import android.provider.ContactsContract
import androidx.compose.runtime.*
import androidx.compose.ui.test.*
import androidx.compose.ui.test.junit4.createComposeRule
import androidx.test.ext.junit.runners.AndroidJUnit4
import androidx.test.platform.app.InstrumentationRegistry
import app.mypeople.MyPeopleApp
import app.mypeople.ui.MyPeopleTheme
import app.mypeople.ui.MoveContactItemsSheet
import app.mypeople.ui.PersonScreen
import java.io.File
import kotlinx.coroutines.runBlocking
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.put
import org.junit.Assert.*
import org.junit.Assume.assumeTrue
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith

/** Explicit emulator opt-in; never seed a personal installation or use a real phone. */
@RunWith(AndroidJUnit4::class)
class GraphCutoverTest {
    @get:Rule val compose = createComposeRule()

    @Test fun nativeSplitProviderAndDurableRestart() = runBlocking {
        assumeTrue(InstrumentationRegistry.getArguments().getString("myPeopleDisposable") == "true")
        check(Build.HARDWARE in setOf("ranchu", "goldfish")) { "Graph QA requires a fresh disposable emulator, never a phone." }
        val instrumentation = InstrumentationRegistry.getInstrumentation()
        val context = instrumentation.targetContext
        val app = (context.applicationContext as MyPeopleApp).graph
        app.store.initialize()
        check(app.store.state.value.records.people.isEmpty() && app.store.state.value.pending.isEmpty()) { "Graph QA requires an empty disposable app store." }
        app.settings.contactsEnabled = false
        for (permission in listOf(Manifest.permission.READ_CONTACTS, Manifest.permission.WRITE_CONTACTS)) instrumentation.uiAutomation.grantRuntimePermission(context.packageName, permission)
        val existing = context.contentResolver.query(ContactsContract.RawContacts.CONTENT_URI, arrayOf(ContactsContract.RawContacts._ID),
            "${ContactsContract.RawContacts.ACCOUNT_TYPE}=? AND ${ContactsContract.RawContacts.DELETED}=0", arrayOf(DeviceContacts.ACCOUNT_TYPE), null)!!.use { it.count }
        check(existing == 0) { "Use a fresh disposable Contacts Provider as well as an empty app store." }
        val originalId = app.store.saveContact(ContactCard("Cameron A", notes = "Ambiguous note stays for review", fields = listOf(
            ContactField("phone", "+12025550101", "Mobile"), ContactField("phone", "+12025550102", "Mobile")),
            photo = "iVBORw0KGgoAAAANSUhEUgAAAAgAAAAICAIAAABLbSncAAAAFElEQVR4nGPUyHNjwAaYsIoOWgkAsRIA7LoaLVcAAAAASUVORK5CYII="))
        val original = app.store.state.value.records.people.getValue(originalId)
        assertNotNull(app.store.snapshot().graph)
        app.store.enqueue("note", buildJsonObject { put("person_id", originalId); put("contact_uid", original.contact_uid); put("text", "Explicit graph note") })
        var opened = ""
        val selection = app.store.associations(original.contact_uid)
        val anchor = selection.associations.single { it.label.contains("+12025550102") }
        var showContact by mutableStateOf(false)
        var contactId by mutableStateOf(originalId)
        compose.setContent { MyPeopleTheme {
            val state by app.store.state.collectAsState()
            if (showContact) PersonScreen(contactId, state, app, onBack = {})
            else MoveContactItemsSheet(original, selection, anchor.id, app, close = {}, moved = { receipt, _ -> opened = receipt.destinationUid })
        } }
        compose.onNodeWithTag("move-destination").performTextInput("Cameron B")
        androidx.test.espresso.Espresso.closeSoftKeyboard()
        compose.onNodeWithTag("move-confirm").performClick()
        compose.waitUntil(5000) { opened.isNotEmpty() }
        val people = app.store.state.value.records.people
        assertEquals(2, people.size)
        val remaining = people.values.first { it.contact_uid == original.contact_uid }
        val separated = people.values.first { it.contact_uid == opened }
        assertEquals("Cameron B", separated.name)
        assertEquals(listOf("+12025550101"), remaining.contactCard().fields.map { it.value })
        assertEquals(listOf("+12025550102"), separated.contactCard().fields.map { it.value })
        assertEquals("Ambiguous note stays for review", remaining.contactCard().notes)
        assertTrue(app.store.state.value.records.events.values.any { it.value == "Explicit graph note" })

        // Correct another item in place, choose an existing contact, and undo without
        // leaving the original page. No multi-screen split wizard is involved.
        val separatedId = people.entries.single { it.value.contact_uid == opened }.key
        val secondSelection = app.store.associations(opened)
        val secondAnchor = secondSelection.associations.single { it.kind == "has_contact_point" }
        compose.runOnIdle { contactId = separatedId; showContact = true }
        compose.onNodeWithTag("edit-person").performClick()
        compose.waitUntil(5000) { compose.onAllNodesWithTag("reassign-${secondAnchor.id}").fetchSemanticsNodes().isNotEmpty() }
        compose.onNodeWithTag("person-list").performScrollToNode(hasTestTag("reassign-${secondAnchor.id}"))
        compose.onNodeWithTag("reassign-${secondAnchor.id}").performClick()
        compose.onNodeWithTag("move-destination").performTextInput("Cameron A")
        androidx.test.espresso.Espresso.closeSoftKeyboard()
        compose.waitUntil(5000) { compose.onAllNodesWithTag("move-to-${original.contact_uid}").fetchSemanticsNodes().isNotEmpty() }
        compose.onNodeWithTag("move-to-${original.contact_uid}").performScrollTo().performClick()
        compose.onNodeWithText("Move to Cameron A").performClick()
        compose.waitUntil(5000) { app.store.state.value.records.people.getValue(separatedId).contactFields().isEmpty() }
        compose.onNodeWithText("Undo").performClick()
        compose.waitUntil(5000) { app.store.state.value.records.people.getValue(separatedId).contactFields().size == 1 }
        compose.onNodeWithText("Move undone").assertIsDisplayed()
        assertEquals("+12025550102", app.store.state.value.records.people.getValue(separatedId).contactFields().single().value)

        for (permission in listOf(Manifest.permission.READ_CONTACTS, Manifest.permission.WRITE_CONTACTS)) instrumentation.uiAutomation.grantRuntimePermission(context.packageName, permission)
        app.deviceContacts.ensureAccount()
        app.settings.contactsEnabled = true
        assertFalse(app.deviceContacts.reconcile().contains("Conflicts"))
        val count = context.contentResolver.query(ContactsContract.RawContacts.CONTENT_URI, arrayOf(ContactsContract.RawContacts._ID),
            "${ContactsContract.RawContacts.ACCOUNT_TYPE}=? AND ${ContactsContract.RawContacts.DELETED}=0", arrayOf(DeviceContacts.ACCOUNT_TYPE), null)!!.use { it.count }
        assertEquals(2, count)
        val baseline = ContactMirror(File(context.filesDir, "contacts-mirror.json")).load()
        assertTrue(baseline.entries.values.all { it.local.photo.isEmpty() && it.exported.photo.isEmpty() })
        assertTrue(baseline.entries.values.any { it.local.photo_hash.isNotEmpty() && it.exported.photo_hash.isNotEmpty() })
        assertEquals(original.contactCard().photo_hash, app.store.state.value.records.people.values.first { it.contact_uid == original.contact_uid }.contactCard().photo_hash)
        val stableField = separated.contactCard().fields.single().object_id
        val dataRow = context.contentResolver.query(ContactsContract.Data.CONTENT_URI,
            arrayOf(ContactsContract.Data._ID, ContactsContract.Data.SYNC1),
            "${ContactsContract.Data.MIMETYPE}=? AND ${ContactsContract.CommonDataKinds.Phone.NUMBER}=?",
            arrayOf(ContactsContract.CommonDataKinds.Phone.CONTENT_ITEM_TYPE, "+12025550102"), null)!!.use { cursor ->
                check(cursor.moveToFirst()); assertEquals(stableField, cursor.getString(1)); cursor.getLong(0)
            }
        context.contentResolver.update(android.content.ContentUris.withAppendedId(ContactsContract.Data.CONTENT_URI, dataRow), android.content.ContentValues().apply {
            put(ContactsContract.CommonDataKinds.Phone.NUMBER, "+12025550103")
            put(ContactsContract.Data.DATA3, "Work")
        }, null, null)
        app.deviceContacts.reconcile()
        val changed = app.store.state.value.records.people.values.first { it.contact_uid == opened }.contactCard().fields.single()
        assertEquals(stableField, changed.object_id)
        assertEquals("+12025550102", changed.value)
        assertEquals("Mobile", changed.label)
        val restarted = Store(File(context.filesDir, "memory"))
        restarted.initialize()
        assertEquals(app.store.state.value.records.people.mapValues { it.value.contactCard() }, restarted.state.value.records.people.mapValues { it.value.contactCard() })
        assertNotNull(restarted.snapshot().graph)
        app.settings.contactsEnabled = false

        // The per-detail menu deletes only one duplicate, never the whole group.
        val currentOriginal = app.store.state.value.records.people.getValue(originalId)
        app.store.saveContact(currentOriginal.contactCard().copy(fields = currentOriginal.contactFields() + listOf(
            ContactField("phone", "+12025550101", "Old import"),
            ContactField("email", "duplicate@example.test", "Home"), ContactField("email", "duplicate@example.test", "Work"),
        )), originalId)
        compose.runOnIdle { contactId = originalId }
        val phoneOptions = "Options for ${phoneDisplay("+12025550101")}"
        compose.onNodeWithTag("person-list").performScrollToNode(hasContentDescription(phoneOptions))
        compose.onNodeWithContentDescription(phoneOptions).performClick()
        compose.onNodeWithText("Delete").performClick()
        compose.onNodeWithText("Delete one saved copy?").assertIsDisplayed()
        compose.onNodeWithText("Delete").performClick()
        compose.waitUntil(5000) { app.store.state.value.records.people.getValue(originalId).contactFields().count { it.kind == "phone" } == 1 }
        val emailOptions = "Options for duplicate@example.test"
        compose.onNodeWithTag("person-list").performScrollToNode(hasContentDescription(emailOptions))
        compose.onAllNodesWithContentDescription(emailOptions).onFirst().performClick()
        compose.onNodeWithText("Delete").performClick()
        compose.onNodeWithText("Cancel").performClick()
        assertEquals(2, app.store.state.value.records.people.getValue(originalId).contactFields().count { it.kind == "email" })
        compose.onAllNodesWithContentDescription(emailOptions).onFirst().performClick()
        compose.onNodeWithText("Delete").performClick()
        compose.onNodeWithText("Delete").performClick()
        compose.waitUntil(5000) { app.store.state.value.records.people.getValue(originalId).contactFields().count { it.kind == "email" } == 1 }
        assertEquals("Ambiguous note stays for review", app.store.state.value.records.people.getValue(originalId).contactCard().notes)
    }
}
