package app.mypeople.data

import android.Manifest
import android.content.ContentValues
import android.net.Uri
import android.provider.ContactsContract as C
import android.provider.ContactsContract.CommonDataKinds as K
import androidx.compose.runtime.getValue
import androidx.compose.ui.test.*
import androidx.compose.ui.test.junit4.createComposeRule
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import androidx.test.ext.junit.runners.AndroidJUnit4
import androidx.test.platform.app.InstrumentationRegistry
import app.mypeople.MyPeopleApp
import app.mypeople.ui.ReviewScreen
import app.mypeople.ui.MyPeopleTheme
import kotlinx.coroutines.runBlocking
import kotlinx.serialization.json.*
import org.junit.Assert.*
import org.junit.Assume.assumeTrue
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith
import java.util.UUID

/** Explicit disposable-emulator opt-in only; never run this on a personal contact database. */
@RunWith(AndroidJUnit4::class)
class MergeInternationalTest {
    @get:Rule val compose = createComposeRule()

    @Test fun unrelatedConflictsDoNotBlockMergeButSelectedConflictsStayVisible() = runBlocking {
        assumeTrue(InstrumentationRegistry.getArguments().getString("myPeopleDisposable") == "true")
        val instrumentation = InstrumentationRegistry.getInstrumentation()
        val context = instrumentation.targetContext
        val graph = (context.applicationContext as MyPeopleApp).graph
        graph.store.initialize()
        check(graph.store.state.value.records.people.isEmpty() && graph.store.state.value.pending.isEmpty()) { "Use a fresh disposable emulator." }
        for (permission in listOf(Manifest.permission.READ_CONTACTS, Manifest.permission.WRITE_CONTACTS)) instrumentation.uiAutomation.grantRuntimePermission(context.packageName, permission)
        graph.settings.contactsEnabled = false
        val uk = ContactCard("Alex QA", region = "GB", notes = "Original notes", fields = listOf(ContactField("phone", "020 7946 0018 ext 42", "UK"), ContactField("phone", "03-1234-5678", "Japan", region = "JP"), ContactField("phone", "06 6982", "Italy", region = "IT")))
        val cards = mapOf(1 to uk, 2 to uk.copy(name = "Alex QA duplicate"), 3 to ContactCard("Charlie QA", notes = "Original notes"), 4 to ContactCard("Charlie QA duplicate", notes = "Original notes"))
        val people = cards.mapValues { (_, card) -> Person(card.name, contact_uid = UUID.randomUUID().toString(), card = card) }
        val records = people.map { (id, person) -> RecordChange("person", id.toString(), json.encodeToJsonElement(person)) } + listOf(
            RecordChange("dupes", "1-2", json.encodeToJsonElement(Dupes(listOf(1, 2)))),
            RecordChange("dupes", "3-4", json.encodeToJsonElement(Dupes(listOf(3, 4)))),
        )
        graph.store.receive(Changes(1, false, records, emptyList()))
        val resolver = context.contentResolver
        fun rawId(uid: String): Long = resolver.query(C.RawContacts.CONTENT_URI, arrayOf(C.RawContacts._ID), "${C.RawContacts.ACCOUNT_TYPE}=? AND ${C.RawContacts.SOURCE_ID}=?", arrayOf(DeviceContacts.ACCOUNT_TYPE, uid), null)!!.use { assertTrue(it.moveToFirst()); it.getLong(0) }
        graph.deviceContacts.ensureAccount(); graph.settings.contactsEnabled = true
        graph.deviceContacts.reconcile()
        val firstRaw = rawId(people.getValue(1).contact_uid)
        val exportedPhones = resolver.query(C.Data.CONTENT_URI, arrayOf(K.Phone.NUMBER), "${C.Data.RAW_CONTACT_ID}=? AND ${C.Data.MIMETYPE}=?", arrayOf(firstRaw.toString(), K.Phone.CONTENT_ITEM_TYPE), C.Data._ID)!!.use { c -> buildList { while (c.moveToNext()) add(c.getString(0)) } }
        assertEquals(listOf("+442079460018;42", "+81312345678", "+39066982"), exportedPhones)
        assertEquals(uk.fields, graph.store.state.value.records.people.getValue(1).card!!.fields)
        // Check intent data only. Never invoke a dialer or send a message in this test.
        assertEquals("+442079460018;42", Uri.fromParts("tel", phoneCallTarget(uk.fields[0].value, "GB"), null).schemeSpecificPart)
        assertEquals("+442079460018", Uri.fromParts("smsto", phoneSmsTarget(uk.fields[0].value, "GB"), null).schemeSpecificPart)

        val charlieRaw = rawId(people.getValue(3).contact_uid)
        graph.deviceContacts.exclusive {
        graph.settings.contactsEnabled = false
        resolver.update(C.Data.CONTENT_URI, ContentValues().apply { put(K.Note.NOTE, "Android version") }, "${C.Data.RAW_CONTACT_ID}=? AND ${C.Data.MIMETYPE}=?", arrayOf(charlieRaw.toString(), K.Note.CONTENT_ITEM_TYPE))
        graph.store.saveContact(cards.getValue(3).copy(notes = "MyPeople version"), 3)
        }
        graph.settings.contactsEnabled = true
        val conflictStatus = graph.deviceContacts.reconcile()
        assertTrue(conflictStatus, conflictStatus.startsWith("Conflicts"))
        graph.submitEdit("merge", buildJsonObject { putJsonArray("person_ids") { add(1); add(2) } })
        assertEquals(1, graph.store.state.value.pending.count { it.kind == "merge" })
        assertEquals(setOf(1, 3, 4), graph.store.state.value.records.people.keys)
        assertTrue(graph.deviceContacts.status.startsWith("Conflicts")) // scoped checks don't erase unrelated status
        assertEquals("MyPeople version", graph.store.state.value.records.people.getValue(3).card!!.notes)

        compose.setContent {
            val state by graph.store.state.collectAsStateWithLifecycle()
            MyPeopleTheme { ReviewScreen(state.records, graph) { } }
        }
        compose.onNodeWithText("Duplicates").performClick()
        compose.onNodeWithText("Merge all 2 records").performScrollTo().performClick()
        compose.onNodeWithText("Merge", useUnmergedTree = true).performClick()
        val error = "Resolve Android contact conflicts for the selected people in Settings before merging. No merge was queued."
        compose.waitUntil(5000) { compose.onAllNodesWithText(error).fetchSemanticsNodes().isNotEmpty() }
        compose.onNodeWithText(error).assertIsDisplayed()
        compose.onNodeWithText("Merge 2 people?").assertIsDisplayed()
        compose.onNodeWithText("Cancel").performClick()
        assertEquals(1, graph.store.state.value.pending.count { it.kind == "merge" })
        assertTrue(graph.store.state.value.records.people.keys.containsAll(listOf(3, 4)))
        assertEquals("Android version", resolver.query(C.Data.CONTENT_URI, arrayOf(K.Note.NOTE), "${C.Data.RAW_CONTACT_ID}=? AND ${C.Data.MIMETYPE}=?", arrayOf(charlieRaw.toString(), K.Note.CONTENT_ITEM_TYPE), null)!!.use { assertTrue(it.moveToFirst()); it.getString(0) })
        graph.settings.contactsEnabled = false
        Unit
    }
}
