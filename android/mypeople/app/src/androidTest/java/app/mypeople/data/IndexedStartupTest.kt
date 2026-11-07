package app.mypeople.data

import android.os.Build
import androidx.test.ext.junit.runners.AndroidJUnit4
import androidx.test.platform.app.InstrumentationRegistry
import java.io.File
import kotlinx.coroutines.runBlocking
import kotlinx.serialization.json.*
import org.junit.Assert.*
import org.junit.Assume.assumeTrue
import org.junit.Test
import org.junit.runner.RunWith

/** Production-shaped metadata, not just a large message count in a tiny graph.
 * Explicit synthetic-directory and emulator opt-ins; never a personal device. */
@RunWith(AndroidJUnit4::class)
class IndexedStartupTest {
    private fun directory(): File {
        val args=InstrumentationRegistry.getArguments()
        assumeTrue(args.getString("myPeopleDisposable") == "true" && args.getString("myPeopleIndexedSynthetic") == "true")
        check(Build.HARDWARE in setOf("ranchu","goldfish"))
        return File(InstrumentationRegistry.getInstrumentation().targetContext.cacheDir,"indexed-representative-qa/memory")
    }
    @Test fun coldEditableStartupAndEditsDoNotReplayHistory() = runBlocking {
        val dir=directory()
        val stages=mutableListOf<Pair<String,Long>>()
        val start=System.nanoTime()
        val store=Store(dir,startupTiming={s,t->stages+=s to t}); store.initialize()
        val ready=(System.nanoTime()-start)/1000000
        assertTrue(store.state.value.ready)
        assertEquals(2576,store.state.value.records.people.size)
        assertEquals(328825,store.state.value.records.people.values.sumOf { p->p.channels.sumOf { it.count } })
        val graph=store.snapshot().graph!!.bundle.reducer as IndexedGraph
        assertEquals("152547",graph.database.scalar("SELECT count(*) FROM operations"))
        assertTrue("Indexed startup must not replay/parse history: ${ready}ms",ready<1500)
        val person=store.state.value.records.people.entries.first()
        var now=System.nanoTime()
        store.saveContact(person.value.contactCard().copy(favorite=!person.value.contactCard().favorite),person.key)
        val edit=(System.nanoTime()-now)/1000000
        assertTrue("Indexed edit: ${edit}ms",edit<500)
        val merge=store.state.value.records.people.keys.filter { it != person.key }.take(2)
        now=System.nanoTime()
        store.enqueue("merge",buildJsonObject { put("person_ids",JsonArray(merge.map(::JsonPrimitive))) })
        val merged=(System.nanoTime()-now)/1000000
        assertEquals(2575,store.state.value.records.people.size)
        assertTrue("Indexed merge: ${merged}ms",merged<1000)
        println("Synthetic 152547 ops / 37461 blobs: ready=${ready}ms edit=${edit}ms merge=${merged}ms stages=$stages heap=${Runtime.getRuntime().maxMemory()}")
    }
    @Test fun freshProcessRetainsMergeWithoutFullBookWork() = runBlocking {
        val dir=directory()
        val start=System.nanoTime(); val store=Store(dir); store.initialize()
        val elapsed=(System.nanoTime()-start)/1000000
        assertEquals(2575,store.state.value.records.people.size)
        assertEquals(328825,store.state.value.records.people.values.sumOf { p->p.channels.sumOf { it.count } })
        assertEquals(37461,store.snapshot().graph!!.bundle.blobs.size)
        assertTrue(elapsed<1500)
        println("Synthetic production-shaped second cold ready=${elapsed}ms")
    }
}
