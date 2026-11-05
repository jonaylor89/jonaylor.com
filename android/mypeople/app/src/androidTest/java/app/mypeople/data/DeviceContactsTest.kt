package app.mypeople.data

import android.Manifest
import android.content.ContentProviderOperation
import android.content.ContentUris
import android.content.ContentValues
import android.provider.ContactsContract as C
import android.provider.ContactsContract.CommonDataKinds as K
import androidx.test.ext.junit.runners.AndroidJUnit4
import androidx.test.platform.app.InstrumentationRegistry
import app.mypeople.MyPeopleApp
import kotlinx.coroutines.runBlocking
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.put
import org.junit.Assert.*
import org.junit.Test
import org.junit.runner.RunWith

/** Run ONLY on a fresh disposable emulator: see docs/contacts.md. No personal-data tests. */
@RunWith(AndroidJUnit4::class)
class DeviceContactsTest {
    @Test fun ownedAccountExternalEditsConflictsTrashRestoreAndPicker() = runBlocking {
        org.junit.Assume.assumeTrue(InstrumentationRegistry.getArguments().getString("myPeopleDisposable") == "true")
        val instrumentation = InstrumentationRegistry.getInstrumentation()
        val context = instrumentation.targetContext
        val graph = (context.applicationContext as MyPeopleApp).graph
        graph.store.initialize()
        check(graph.store.state.value.records.people.isEmpty()) { "Use a fresh disposable emulator, never a personal installation." }
        for (permission in listOf(Manifest.permission.READ_CONTACTS, Manifest.permission.WRITE_CONTACTS)) {
            instrumentation.uiAutomation.grantRuntimePermission(context.packageName, permission)
        }
        val r = context.contentResolver
        val foreign = r.insert(C.RawContacts.CONTENT_URI, ContentValues().apply { putNull(C.RawContacts.ACCOUNT_TYPE); putNull(C.RawContacts.ACCOUNT_NAME) })!!
        val foreignId = ContentUris.parseId(foreign)
        r.insert(C.Data.CONTENT_URI, ContentValues().apply { put(C.Data.RAW_CONTACT_ID, foreignId); put(C.Data.MIMETYPE, K.StructuredName.CONTENT_ITEM_TYPE); put(K.StructuredName.DISPLAY_NAME, "Other account untouched") })
        val card = ContactCard("Alice QA", given = "Alice", family = "QA", notes = "Verified notes", favorite = true, fields = listOf(ContactField("phone", "+442079460018", "Work", true), ContactField("email", "alice@example.org", "Personal"), ContactField("address", "12 Main Street\nLondon", "Home")))
        val id = graph.store.saveContact(card)
        val uid = graph.store.state.value.records.people.getValue(id).contact_uid
        graph.deviceContacts.ensureAccount()
        graph.settings.contactsEnabled = true
        assertFalse(graph.deviceContacts.reconcile().contains("Conflicts"))
        val uri = graph.deviceContacts.lookup(uid)
        assertNotNull(uri)
        assertEquals(uid, graph.deviceContacts.uidFor(uri!!))
        val phoneUri = graph.deviceContacts.lookup(uid, K.Phone.CONTENT_TYPE)
        assertNotNull(phoneUri)
        assertFalse(graph.deviceContacts.reconcile().contains("Conflicts"))
        val ownRaw = r.query(C.RawContacts.CONTENT_URI, arrayOf(C.RawContacts._ID), "${C.RawContacts.SOURCE_ID}=? AND ${C.RawContacts.ACCOUNT_TYPE}=?", arrayOf(uid, DeviceContacts.ACCOUNT_TYPE), null)!!.use { assertTrue(it.moveToFirst()); it.getLong(0) }
        assertNotEquals(foreignId, ownRaw)
        graph.settings.contactsEnabled = false
        r.update(phoneUri!!, ContentValues().apply { put(K.Phone.NUMBER, "+4930123456") }, null, null)
        graph.settings.contactsEnabled = true
        graph.deviceContacts.reconcile()
        assertEquals("+4930123456", graph.store.state.value.records.people.getValue(id).card!!.fields.first { it.kind == "phone" }.value)
        // Simultaneous changes: default behavior must not overwrite either side.
        graph.settings.contactsEnabled = false
        r.update(C.Data.CONTENT_URI, ContentValues().apply { put(K.Note.NOTE, "Android version") }, "${C.Data.RAW_CONTACT_ID}=? AND ${C.Data.MIMETYPE}=?", arrayOf(ownRaw.toString(), K.Note.CONTENT_ITEM_TYPE))
        graph.store.saveContact(graph.store.state.value.records.people.getValue(id).card!!.copy(notes = "MyPeople version"), id)
        graph.settings.contactsEnabled = true
        assertTrue(graph.deviceContacts.reconcile().contains("Conflicts"))
        assertEquals("MyPeople version", graph.store.state.value.records.people.getValue(id).card!!.notes)
        graph.deviceContacts.reconcile("android")
        assertEquals("Android version", graph.store.state.value.records.people.getValue(id).card!!.notes)
        graph.store.enqueue("contact_trash", buildJsonObject { put("person_id", id); put("contact_uid", uid) })
        graph.deviceContacts.reconcile()
        assertNull(graph.deviceContacts.lookup(uid))
        graph.store.enqueue("contact_restore", buildJsonObject { put("person_id", id); put("contact_uid", uid) })
        graph.deviceContacts.reconcile()
        assertNotNull(graph.deviceContacts.lookup(uid))
        assertEquals("Other account untouched", r.query(C.Data.CONTENT_URI, arrayOf(K.StructuredName.DISPLAY_NAME), "${C.Data.RAW_CONTACT_ID}=? AND ${C.Data.MIMETYPE}=?", arrayOf(foreignId.toString(), K.StructuredName.CONTENT_ITEM_TYPE), null)!!.use { assertTrue(it.moveToFirst()); it.getString(0) })
        // Full backup including unsynced edits, followed by a simulated canonical
        // acknowledgment and real restore through the Android document I/O path.
        val backupFile = java.io.File(context.cacheDir, "contacts-qa-backup.sherloq")
        graph.backups.export(android.net.Uri.fromFile(backupFile), "device-backup-test")
        val savedOps = graph.store.state.value.pending
        graph.settings.contactsEnabled = false
        val person = graph.store.state.value.records.people.getValue(id)
        val history = ContactHistory(graph.store.snapshot().replica.changes)
        graph.store.installOffline(TransferManifest(type = "snapshot", source = java.util.UUID.randomUUID().toString(), revision = 1,
            contact_version = 1, contact_history = history.changes, contact_heads = history.heads,
            records = listOf(RecordChange("person", "1", kotlinx.serialization.json.Json.encodeToJsonElement(Person.serializer(), person))),
            results = savedOps.mapIndexed { i, op -> OpState(i.toLong(), op.client_id, op.kind, op.payload, "done") }))
        assertTrue(graph.store.state.value.pending.isEmpty())
        graph.backups.restore(android.net.Uri.fromFile(backupFile), "device-backup-test")
        assertEquals(savedOps.map { it.client_id }, graph.store.state.value.pending.map { it.client_id })
        assertEquals("Android version", graph.store.state.value.records.people.getValue(id).card!!.notes)
        assertFalse(graph.settings.contactsEnabled)
        graph.settings.contactsEnabled = true
        android.accounts.AccountManager.get(context).removeAccountExplicitly(android.accounts.Account(DeviceContacts.ACCOUNT_NAME, DeviceContacts.ACCOUNT_TYPE))
        graph.deviceContacts.reconcile()
        assertFalse(graph.settings.contactsEnabled)
        assertFalse(graph.store.state.value.records.people.getValue(id).trashed)
        graph.deviceContacts.ensureAccount()
        graph.settings.contactsEnabled = true
        graph.deviceContacts.reconcile()
        assertFalse(graph.store.state.value.records.people.getValue(id).trashed)
        assertNotNull(graph.deviceContacts.lookup(uid))
        graph.settings.contactsEnabled = false
        r.delete(foreign, null, null)
        Unit
    }
}
