package app.mypeople.data

import kotlinx.coroutines.runBlocking
import org.junit.Assume.assumeTrue
import org.junit.Rule
import org.junit.Test
import org.junit.rules.TemporaryFolder
import java.io.File
import java.time.LocalDate
import kotlinx.serialization.json.decodeFromJsonElement

/** Times real-sized operations against a private copy of a phone store.
 * Skipped unless MYPEOPLE_BENCH_STORE names a store directory; the copy is never modified. */
class RealStoreBenchmark {
    @get:Rule val temp = TemporaryFolder()

    private inline fun <T> time(label: String, block: () -> T): T {
        val start = System.nanoTime()
        val result = block()
        println("BENCH %-34s %8.1f ms".format(label, (System.nanoTime() - start) / 1e6))
        return result
    }

    private var store0: Store? = null
    private fun view0() = store0!!.state.value.records
    @Test fun `real store operations`() = runBlocking {
        val source = System.getenv("MYPEOPLE_BENCH_STORE")?.let(::File)
        assumeTrue(source?.isDirectory == true)
        val dir = temp.newFolder()
        source!!.listFiles()!!.filter { it.isFile }.forEach { it.copyTo(File(dir, it.name)) }
        // Warm up class loading and the JIT once, as a running app would be.
        Store(temp.newFolder()).initialize()

        val disk = time("journal load") { StoreJournal(dir).load() }
        println("BENCH people=${disk.records.people.size} events=${disk.records.events.size} changes=${disk.replica.changes.size} pending=${disk.pending.size}")
        repeat(2) { time("ContactHistory(changes) #$it") { ContactHistory(disk.replica.changes) } }
        val h = ContactHistory(disk.replica.changes)
        val withReplaces = disk.replica.changes.count { it.replaces.isNotEmpty() }; val withRemoves = disk.replica.changes.count { it.removes.isNotEmpty() }; val withLinks = disk.replica.changes.count { it.links.isNotEmpty() }
        println("BENCH replaces=$withReplaces removes=$withRemoves links=$withLinks parentsTotal=${disk.replica.changes.sumOf { it.parents.size }} distinctParentLists=${disk.replica.changes.map { System.identityHashCode(it.parents) }.toSet().size} distinctEdges=${java.util.IdentityHashMap<List<String>, Int>().also { m -> disk.replica.changes.forEach { m[it.parents] = it.parents.size } }.values.sum()} maxParents=${disk.replica.changes.maxOf { it.parents.size }}")
        val cards = h.contacts.values.map { ContactHistory.cardObject(it.card) }
        time("decode all cards") { cards.forEach { json.decodeFromJsonElement<ContactCard>(it).validate() } }
        val all = disk.replica.changes
        time("observed checks (replaces)") { all.forEach { c -> c.replaces.values.flatten().forEach { h.observed(it, c.parents) } } }
        println("BENCH heads=${h.heads.size} contacts=${h.contacts.size}")
        val base = optimistic(disk.records, disk.pending)
        repeat(2) { time("project #$it") { h.project(base, disk.replica.localIds) } }

        val someone = h.contacts.values.first()
        val change = h.edit(someone.uid, someone.card.copy(favorite = !someone.card.favorite))
        repeat(2) { time("history.plus(edit) #$it") { h.plus(listOf(change)) } }
        repeat(2) { time("startupIndex.save #$it") { StartupIndex(temp.newFolder()).save(h.project(base, disk.replica.localIds)) } }
        time("journal save (1 change)") { val j = StoreJournal(dir); val d = j.load(); j.save(d, d.copy(replica = d.replica.copy(changes = d.replica.changes + change))) }

        val store = Store(dir).also { store0 = it }
        time("store initialize") { store.initialize() }
        val records = store.state.value.records
        val target = records.people.entries.first { it.value.contact_uid.isNotEmpty() && it.value.card != null && !it.value.trashed }
        repeat(3) { i ->
            val person = store.state.value.records.people.getValue(target.key)
            time("favorite toggle #$i") { store.saveContact(person.contactCard().copy(favorite = !person.contactCard().favorite), target.key, person.contact_uid, expectedPerson = person) }
        }

        val shown = view0().dupes.values.count { d -> d.person_ids.count { it in view0().people } >= 2 }
        println("BENCH dupes stored=${disk.records.dupes.size} inView=${view0().dupes.size} shown=$shown")
        view0().dupes.values.take(6).forEach { d -> println("BENCH   dupe ${d.person_ids} -> ${d.person_ids.map { view0().people[it]?.name }}") }
        System.getenv("MYPEOPLE_BENCH_BEFORE")?.let(::File)?.takeIf { it.isDirectory }?.let { before ->
            val old = StoreJournal(before).load().records
            val now = disk.records
            val names = { r: Records, d: Dupes -> d.person_ids.map { r.people[it]?.name } }
            println("BENCH before dupes=${old.dupes.size} after=${now.dupes.size} new=${(now.dupes.keys - old.dupes.keys).size} gone=${(old.dupes.keys - now.dupes.keys).size}")
            (now.dupes.keys - old.dupes.keys).forEach { println("BENCH   new ${names(now, now.dupes.getValue(it))}") }
            (old.dupes.keys - now.dupes.keys).take(10).forEach { println("BENCH   gone ${names(old, old.dupes.getValue(it))}") }
            println("BENCH people before=${old.people.size} after=${now.people.size}")
        }
        val touchedAll = view0().people.values.map { it.contact_uid }.filter { it.isNotEmpty() }.toSet()
        val everything = time("localDuplicates (every contact touched)") { localDuplicates(view0(), touchedAll, emptyList()) }
        println("BENCH local groups pending=${store.state.value.pending.count { it.kind == "contact_change" }} shownLocal=${view0().dupes.keys.count { it.startsWith(LOCAL_DUPES_PREFIX) }} worstCase=${everything.size}")
        val today = LocalDate.now()
        val view = store.state.value.records
        repeat(2) { time("search name #$it") { view.search("", "name") } }
        time("search closeness") { view.search("", "closeness") }
        time("search query 'ann'") { view.search("ann", "name") }
        val results = view.search("", "name")
        time("peopleSections") { peopleSections(results.map { it.value.name }) }
        time("profileByPerson") { view.events.values.groupBy { it.person_id }.mapValues { currentProfile(it.value) } }
        time("contactCard all") { view.people.values.forEach { it.contactCard() } }
        time("phoneCallTarget all") { view.people.values.forEach { p -> val c = p.contactCard(); c.fields.firstOrNull { it.kind == "phone" }?.let { f -> phoneCallTarget(f.value, f.region.ifEmpty { c.region }) } } }
        time("home today") { view.today(today) }
        time("home upcoming") { view.upcoming(today) }
        time("eventsFor one person") { view.eventsFor(target.key) }
        Unit
    }
}
