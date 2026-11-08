package app.mypeople.data

import android.os.Build
import androidx.test.ext.junit.runners.AndroidJUnit4
import androidx.test.platform.app.InstrumentationRegistry
import java.io.File
import java.util.UUID
import kotlinx.coroutines.runBlocking
import kotlinx.serialization.json.*
import org.junit.Assert.*
import org.junit.Assume.assumeTrue
import org.junit.Test
import org.junit.runner.RunWith

/** Exact production-shaped synthetic Store, isolated under cache, explicitly emulator-only. */
@RunWith(AndroidJUnit4::class)
class IndexedSyncTest {
    @Test fun repeatedSyncAndSmallDeltasDoNotReprojectTheBook() = runBlocking {
        val args=InstrumentationRegistry.getArguments()
        assumeTrue(args.getString("myPeopleDisposable")=="true" && args.getString("myPeopleIndexedSynthetic")=="true")
        check(Build.HARDWARE in setOf("ranchu","goldfish"))
        val context=InstrumentationRegistry.getInstrumentation().targetContext
        val dir=File(context.cacheDir,"indexed-sync-qa/memory")
        check(File(dir,"indexed-graph/graph.sqlite").isFile)
        val stages=mutableListOf<Pair<String,Long>>()
        val store=Store(dir,saveTiming={stage,ms -> stages += stage to ms}); store.initialize()
        var disk=store.snapshot()
        assertEquals(GraphStore.namespacedId("6ba7b811-9dad-11d1-80b4-00c04fd430c8","synthetic-indexed-startup:source"),disk.offlineSource)
        assertEquals(2576,store.state.value.records.people.size)
        val database=(disk.graph!!.bundle.reducer as IndexedGraph).database
        assertEquals("152547",database.scalar("SELECT count(*) FROM operations"))
        val initial=store.state.value.records
        val person=initial.people.entries.first { it.value.contactFields().isNotEmpty() }
        val other=initial.people.entries.first { it.key != person.key }
        fun snapshot(bundle: GraphBundle, records: List<RecordChange> = emptyList()) = TransferManifest(
            type="snapshot",source=disk.offlineSource!!,publisher=disk.replica.publisher,
            revision=disk.offlineRevision+1,base_revision=disk.offlineRevision,graph=bundle,records=records)
        var now=System.nanoTime()
        store.installOffline(snapshot(GraphBundle(disk.graph!!.bundle.collection,disk.graph!!.bundle.heads)))
        val noop=(System.nanoTime()-now)/1000000
        assertSame(initial,store.state.value.records)
        assertTrue("Metadata-only sync must not reproject: ${noop}ms",noop<1000)
        assertEquals("152547",database.scalar("SELECT count(*) FROM operations"))

        disk=store.snapshot()
        now=System.nanoTime()
        store.installOffline(snapshot(GraphBundle(disk.graph!!.bundle.collection,disk.graph!!.bundle.heads),listOf(
            RecordChange("person",person.key.toString(),json.encodeToJsonElement(Person("",contact_uid=person.value.contact_uid,category="friend")))
        )))
        val hint=(System.nanoTime()-now)/1000000
        assertEquals("friend",store.state.value.records.people.getValue(person.key).category)
        assertSame(other.value,store.state.value.records.people.getValue(other.key))
        assertTrue("Relationship delta must touch only its owner: ${hint}ms",hint<1000)

        disk=store.snapshot()
        val graph=disk.graph!!.bundle.reducer!!
        val point=person.value.contactFields().first().object_id
        val commit=graph.commit(UUID.randomUUID().toString(),listOf(graph.edit(point,"label",JsonPrimitive("Updated synthetic label"))),disk.graph!!.bundle.collection)
        now=System.nanoTime()
        store.installOffline(snapshot(GraphBundle(commit.collection,listOf(commit.id),listOf(commit))))
        val delta=(System.nanoTime()-now)/1000000
        assertEquals("Updated synthetic label",store.state.value.records.people.getValue(person.key).contactFields().first { it.object_id==point }.label)
        assertSame(other.value,store.state.value.records.people.getValue(other.key))
        assertTrue("Small native sync must not reproject: ${delta}ms",delta<1000)
        assertEquals("152548",database.scalar("SELECT count(*) FROM operations"))
        assertEquals(37461,store.snapshot().graph!!.bundle.blobs.size)
        val restarted=Store(dir); restarted.initialize()
        assertEquals("friend",restarted.state.value.records.people.getValue(person.key).category)
        assertEquals("Updated synthetic label",restarted.state.value.records.people.getValue(person.key).contactFields().first { it.object_id==point }.label)
        println("Synthetic indexed sync 152547 operations: noop=${noop}ms hints=${hint}ms delta=${delta}ms stages=$stages")
    }
}
