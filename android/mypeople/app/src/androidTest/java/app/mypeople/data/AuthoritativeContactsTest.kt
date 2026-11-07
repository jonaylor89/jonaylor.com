package app.mypeople.data

import android.Manifest
import android.content.ContentProvider
import android.content.ContentValues
import android.content.ContextWrapper
import android.content.pm.PackageManager
import android.net.Uri
import android.os.Build
import android.provider.ContactsContract as C
import android.provider.ContactsContract.CommonDataKinds as K
import androidx.test.ext.junit.runners.AndroidJUnit4
import androidx.test.platform.app.InstrumentationRegistry
import app.mypeople.MyPeopleApp
import java.io.File
import kotlinx.coroutines.delay
import kotlinx.coroutines.runBlocking
import org.junit.Assert.*
import org.junit.Assume.assumeTrue
import org.junit.Test
import org.junit.runner.RunWith

/** Synthetic data on an explicitly selected, empty disposable emulator only. */
@RunWith(AndroidJUnit4::class)
class AuthoritativeContactsTest {
    @Test fun automaticRepairRestartFailuresAndNoFeedbackLoop() = runBlocking {
        assumeTrue(InstrumentationRegistry.getArguments().getString("myPeopleDisposable") == "true")
        check(Build.HARDWARE in setOf("ranchu", "goldfish")) { "Never run on a personal phone." }
        val instrumentation = InstrumentationRegistry.getInstrumentation()
        val context = instrumentation.targetContext
        val graph = (context.applicationContext as MyPeopleApp).graph
        graph.store.initialize()
        check(graph.store.state.value.records.people.isEmpty()) { "Use an empty disposable app store." }
        graph.settings.contactsEnabled = false
        for (permission in listOf(Manifest.permission.READ_CONTACTS, Manifest.permission.WRITE_CONTACTS)) instrumentation.uiAutomation.grantRuntimePermission(context.packageName, permission)
        val resolver = context.contentResolver
        fun rawCount() = resolver.query(C.RawContacts.CONTENT_URI, arrayOf(C.RawContacts._ID), "${C.RawContacts.ACCOUNT_TYPE}=? AND ${C.RawContacts.DELETED}=0", arrayOf(DeviceContacts.ACCOUNT_TYPE), null)!!.use { it.count }
        check(rawCount() == 0) { "Use an empty disposable provider." }
        val id = graph.saveContact(ContactCard("Projection QA", notes = "MyPeople notes", region = "GB", fields = listOf(ContactField("phone", "020 7946 0018", region = "GB"))))
        val person = graph.store.state.value.records.people.getValue(id)
        val original = person.contactCard()
        val pending = graph.store.state.value.pending
        graph.deviceContacts.ensureAccount()
        graph.settings.contactsEnabled = true
        graph.deviceContacts.reconcile()
        fun rawId() = resolver.query(C.RawContacts.CONTENT_URI, arrayOf(C.RawContacts._ID), "${C.RawContacts.SOURCE_ID}=? AND ${C.RawContacts.DELETED}=0", arrayOf(person.contact_uid), null)!!.use { check(it.moveToFirst()); it.getLong(0) }
        fun note() = resolver.query(C.Data.CONTENT_URI, arrayOf(K.Note.NOTE), "${C.Data.RAW_CONTACT_ID}=? AND ${C.Data.MIMETYPE}=?", arrayOf(rawId().toString(), K.Note.CONTENT_ITEM_TYPE), null)!!.use { check(it.moveToFirst()); it.getString(0) }
        fun version() = resolver.query(C.RawContacts.CONTENT_URI, arrayOf(C.RawContacts.VERSION), "${C.RawContacts._ID}=?", arrayOf(rawId().toString()), null)!!.use { check(it.moveToFirst()); it.getLong(0) }
        val firstRaw = rawId()
        graph.deviceContacts.exclusive {
            graph.settings.contactsEnabled = false
            resolver.update(C.Data.CONTENT_URI, ContentValues().apply { put(K.Note.NOTE, "External change") }, "${C.Data.RAW_CONTACT_ID}=? AND ${C.Data.MIMETYPE}=?", arrayOf(firstRaw.toString(), K.Note.CONTENT_ITEM_TYPE))
        }
        graph.settings.contactsEnabled = true
        graph.deviceContacts.reconcile()
        assertEquals("MyPeople notes", note())
        assertEquals(firstRaw, rawId())
        assertEquals(original, graph.store.state.value.records.people.getValue(id).contactCard())
        assertEquals(pending, graph.store.state.value.pending)
        val settledVersion = version()
        repeat(3) { graph.deviceContacts.reconcile() }
        delay(1200) // own provider callbacks must settle without more writes or graph operations
        assertEquals(settledVersion, version())
        assertEquals(pending, graph.store.state.value.pending)
        assertEquals(1, rawCount())

        // Restart the bridge without a baseline: SOURCE_ID repairs in place, never inserts a duplicate.
        graph.deviceContacts.exclusive {
            graph.settings.contactsEnabled = false
            File(context.filesDir, "contacts-mirror.json").delete()
            File(context.filesDir, "contacts-mirror.journal").delete()
        }
        val restarted = DeviceContacts(context, graph)
        // Only one bridge may operate at a time, just as in the real AppGraph.
        suspend fun runBridge(bridge: DeviceContacts): String = graph.deviceContacts.exclusive {
            graph.settings.contactsEnabled = true
            try { bridge.reconcile() } finally { graph.settings.contactsEnabled = false }
        }
        runBridge(restarted)
        assertEquals(firstRaw, rawId())
        assertEquals(1, rawCount())
        val restartedStore = Store(File(context.filesDir, "memory")); restartedStore.initialize()
        assertEquals(original, restartedStore.state.value.records.people.getValue(id).contactCard())
        assertEquals(pending, restartedStore.state.value.pending)

        // A deleted Android copy is recreated, not interpreted as a MyPeople deletion.
        graph.deviceContacts.exclusive {
            graph.settings.contactsEnabled = false
            resolver.delete(android.content.ContentUris.withAppendedId(C.RawContacts.CONTENT_URI, rawId()), null, null)
        }
        runBridge(restarted)
        assertEquals(1, rawCount())
        assertEquals("MyPeople notes", note())
        assertFalse(graph.store.state.value.records.people.getValue(id).trashed)

        val denied = DeviceContacts(object : ContextWrapper(context) {
            override fun checkPermission(permission: String, pid: Int, uid: Int): Int = PackageManager.PERMISSION_DENIED
        }, graph)
        assertTrue(runBridge(denied).contains("permission was revoked"))
        assertEquals(1, rawCount())

        // A null cursor is a provider failure, not an empty book authorizing fresh inserts.
        val unavailable = object : ContentProvider() {
            override fun onCreate() = true
            override fun query(uri: Uri, projection: Array<out String>?, selection: String?, args: Array<out String>?, sort: String?): android.database.Cursor? = null
            override fun getType(uri: Uri): String? = null
            override fun insert(uri: Uri, values: ContentValues?): Uri? = error("Must not write")
            override fun delete(uri: Uri, selection: String?, args: Array<out String>?): Int = error("Must not delete")
            override fun update(uri: Uri, values: ContentValues?, selection: String?, args: Array<out String>?): Int = error("Must not update")
        }
        unavailable.attachInfo(context, android.content.pm.ProviderInfo())
        val failed = DeviceContacts(object : ContextWrapper(context) {
            override fun getContentResolver() = android.content.ContentResolver.wrap(unavailable)
        }, graph)
        try { runBridge(failed); fail("Provider failure must not look like success") } catch (_: IllegalStateException) { }
        assertTrue(failed.status.contains("could not be updated"))
        runBridge(restarted)
        assertEquals(1, rawCount())
        assertEquals(pending, graph.store.state.value.pending)

        // Routine saves propagate through AppGraph's committed-state collector, no manual retry.
        graph.settings.contactsEnabled = true
        graph.saveContact(original.copy(notes = "Saved automatically"), id)
        kotlinx.coroutines.withTimeout(5000) {
            while (note() != "Saved automatically") delay(50)
        }
        assertEquals(1, rawCount())
        val field = graph.store.state.value.records.people.getValue(id).contactCard().fields.single()
        assertEquals(original.fields.single().object_id, field.object_id)
        assertEquals("GB", field.region)
        assertEquals("020 7946 0018", field.value)
        val unverifiedId = graph.saveContact(ContactCard("Uncertain country QA", legacy_unverified = true, fields = listOf(ContactField("phone", "030 123456"))))
        assertTrue(graph.deviceContacts.reconcile().contains("verified before Android export"))
        assertEquals(1, rawCount())
        assertTrue(graph.store.state.value.records.people.getValue(unverifiedId).contactCard().legacy_unverified)
        graph.settings.contactsEnabled = false
    }
}
