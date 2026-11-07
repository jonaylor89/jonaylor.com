package app.mypeople.data

import java.io.File
import java.sql.DriverManager
import java.util.UUID
import kotlinx.serialization.json.*
import org.junit.Assert.*
import org.junit.Rule
import org.junit.Test
import org.junit.rules.TemporaryFolder

internal class JdbcGraphSql(file: File) : GraphSql {
    private val connection = DriverManager.getConnection("jdbc:sqlite:${file.path}")
    override var inTransaction = false; private set
    init { execute("PRAGMA foreign_keys=ON"); execute("PRAGMA journal_mode=WAL"); execute("PRAGMA synchronous=FULL") }
    override fun execute(sql: String, args: List<Any?>) { connection.prepareStatement(sql).use { s -> args.forEachIndexed { i,v -> s.setObject(i+1,if (v is Boolean) if(v) 1 else 0 else v) }; s.execute(); Unit } }
    override fun query(sql: String, args: List<Any?>): List<List<String?>> = connection.prepareStatement(sql).use { s ->
        args.forEachIndexed { i,v -> s.setObject(i+1,v) }; s.executeQuery().use { r -> buildList { while(r.next()) add(List(r.metaData.columnCount) { r.getString(it+1) }) } }
    }
    override fun blobs(sql: String,args: List<Any?>): List<Pair<String,ByteArray>> = connection.prepareStatement(sql).use { s ->
        args.forEachIndexed { i,v -> s.setObject(i+1,v) }; s.executeQuery().use { r -> buildList { while(r.next()) add(r.getString(1) to r.getBytes(2)) } }
    }
    override fun begin() { connection.autoCommit=false; inTransaction=true }
    override fun commit() { connection.commit(); connection.autoCommit=true; inTransaction=false }
    override fun rollback() { connection.rollback(); connection.autoCommit=true; inTransaction=false }
    override fun close() = connection.close()
}

class IndexedGraphDatabaseTest {
    @get:Rule val temp = TemporaryFolder()
    private fun id() = UUID.randomUUID().toString()
    private fun open(file: File) = IndexedGraphDatabase(JdbcGraphSql(file),File(file.parentFile,"graph-blobs"))
    private fun assertSameGraph(expected: VersionedGraph, actual: VersionedGraph) {
        assertEquals(expected.heads,actual.heads)
        assertEquals(expected.objects,actual.objects); assertEquals(expected.edges,actual.edges)
        assertEquals(expected.components(),actual.components())
        for (target in expected.objects.keys+expected.edges.keys) {
            assertEquals(expected.active(target),actual.active(target))
            assertEquals(expected.propertyNames(target),actual.propertyNames(target))
            for (property in expected.propertyNames(target)+"_lifecycle") {
                assertEquals(expected.alternatives(target,property),actual.alternatives(target,property))
                assertEquals(expected.value(target,property),actual.value(target,property))
                assertEquals(expected.conflicted(target,property),actual.conflicted(target,property))
            }
            assertEquals(expected.deletionConflicts(target),actual.deletionConflicts(target))
        }
    }
    @Test fun prepareWhollySyntheticProductionShapedIndexForEmulator() {
        val path=System.getenv("MYPEOPLE_SYNTHETIC_INDEXED_ARCHIVE")
        org.junit.Assume.assumeTrue(path != null)
        require(File(path!!).name == "mypeople-synthetic-indexed.sherloq" && path.startsWith("/tmp/mypeople-synthetic-"))
        val root=File("/tmp/mypeople-synthetic-indexed-prepared")
        require(!root.exists()); root.mkdirs()
        val memory=File(root,"memory").also { it.mkdirs() }
        val archive=LargeArchive.read(File(path),"synthetic-indexed-startup-passphrase",root,File(memory,"graph-blobs")).memory!!
        assertEquals(GraphStore.namespacedId("6ba7b811-9dad-11d1-80b4-00c04fd430c8","synthetic-indexed-startup:source"),archive.source)
        val gs=GraphStore(GraphStore(GraphState(GraphBundle(archive.graph!!.collection))).receive(archive.graph)).indexed()
        val view=GraphStore(gs).project()
        val dir=File(memory,"indexed-graph").also { it.mkdir() }
        IndexedGraphDatabase(JdbcGraphSql(File(dir,"graph.sqlite")),File(memory,"graph-blobs")).use { db ->
            db.importState(DiskState(graph=gs,offlineSource=archive.source,offlineRevision=1,replica=ReplicaState(publisher=archive.publisher)),view)
            assertEquals("152547",db.scalar("SELECT count(*) FROM operations"))
        }
        println("Prepared wholly synthetic production-shaped indexed Store: ${view.people.size} people at $root")
    }

    @Test fun sharedFixtureAndEveryRestartMatchReference() {
        val fixture = VersionedGraph.wire.parseToJsonElement(javaClass.getResource("/versioned-graph.json")!!.readText()).jsonObject
        val commits = VersionedGraph.wire.decodeFromJsonElement<List<GraphCommit>>(fixture.getValue("commits"))
        val ordered = VersionedGraph(commits).ordered
        val file = temp.newFile("graph.sqlite")
        for (index in ordered.indices) {
            open(file).use { db -> db.append(ordered[index],false); assertSameGraph(VersionedGraph(ordered.take(index+1)),db.graph()) }
            open(file).use { db -> assertSameGraph(VersionedGraph(ordered.take(index+1)),db.graph()) }
        }
    }
    @Test fun invalidOperationRollsBackTheWholeReceivedCommit() {
        open(temp.newFile("invalid.sqlite")).use { db ->
            val person=VersionedGraph.createObject("Person")
            val bad=VersionedGraph.createEdge("has_name",person.target,id())
            val commit=VersionedGraph().commit(id(),listOf(person,bad))
            try { db.append(commit,false); fail("Missing endpoint accepted") } catch (_: IllegalArgumentException) { }
            assertEquals(0,db.graph().commits.size)
            assertEquals("0",db.scalar("SELECT count(*) FROM entities"))
            assertEquals("0",db.scalar("SELECT count(*) FROM operations"))
        }
    }
    @Test fun missingBinaryPersonCacheRebuildsFromTransactionalScreenRows() {
        val file=temp.newFile("person-cache.sqlite")
        val initial=GraphStore(GraphStore(GraphStore.empty()).saveCard(id(),ContactCard("Synthetic cache",originals=listOf("Wholly synthetic original")))).indexed()
        val view=GraphStore(initial).project()
        open(file).use { db ->
            db.importState(DiskState(graph=initial),view)
            db.transaction { db.sql.execute("DELETE FROM person_fast"); db.sql.execute("DELETE FROM meta WHERE key='person_codec'") }
        }
        open(file).use { db -> assertEquals(view.people,db.readRecords("view").people); assertEquals("1",db.meta("person_codec")) }
    }
    @Test fun indexedOpenDoesNotReadOperationPayloadsOrBlobBytes() {
        val file=temp.newFile("no-replay.sqlite")
        val initial=GraphStore(GraphStore(GraphStore.empty()).saveCard(id(),ContactCard("Synthetic no replay"))).indexed()
        open(file).use { it.importState(DiskState(graph=initial),GraphStore(initial).project()) }
        val queries=mutableListOf<String>()
        val delegate=JdbcGraphSql(file)
        val traced=object : GraphSql by delegate {
            override fun query(sql: String,args: List<Any?>): List<List<String?>> { queries+=sql; return delegate.query(sql,args) }
        }
        IndexedGraphDatabase(traced,File(file.parentFile,"graph-blobs")).use { db ->
            val state=db.readState(); db.readRecords("view"); GraphStore(state.graph!!).graph.components()
            assertTrue(queries.none { "payload" in it })
            assertTrue(queries.none { "registers" in it })
        }
    }
    @Test fun immutableSnapshotsAndRollbackKeepVersionsAndHistory() {
        val file=temp.newFile("snapshots.sqlite")
        open(file).use { db ->
            val person=VersionedGraph.createObject("Person",buildJsonObject { put("label","Before") })
            val first=VersionedGraph().commit(id(),listOf(person)); db.append(first,true)
            val old=db.graph()
            val edit=old.commit(id(),listOf(old.edit(person.target,"label",JsonPrimitive("After"))))
            db.append(edit,true)
            assertEquals(JsonPrimitive("Before"),old.value(person.target,"label"))
            assertEquals(JsonPrimitive("After"),db.graph().value(person.target,"label"))
            val heads=db.graph().heads
            try { db.transaction { db.graph().appended(db.graph().commit(id(),listOf(db.graph().edit(person.target,"label",JsonPrimitive("Never committed"))))); error("rollback") } } catch (_: IllegalStateException) { }
            assertEquals(heads,db.graph().heads)
            assertEquals(JsonPrimitive("After"),db.graph().value(person.target,"label"))
            assertEquals(2,db.headers(db.latest).size)
        }
    }
    @Test fun graphScreenAndOutboxRollbackTogetherAndSnapshotsCannotWrite() {
        val file=temp.newFile("rollback.sqlite")
        val uid=id()
        val initial=GraphStore(GraphStore(GraphStore.empty()).saveCard(uid,ContactCard("Synthetic rollback"))).indexed()
        open(file).use { db -> db.importState(DiskState(graph=initial),GraphStore(initial).project()) }
        open(file).use { db ->
            val disk=db.readState(); val view=db.readRecords("view"); val heads=disk.graph!!.bundle.heads
            try { GraphStore(disk.graph).saveCard(uid,ContactCard("Not a transaction")); fail("Read snapshot wrote") } catch (_: IllegalStateException) { }
            assertEquals(heads,db.graph().heads)
            try { db.transaction {
                val next=GraphStore(disk.graph).saveCard(uid,ContactCard("Must roll back"))
                db.save(disk,disk.copy(graph=next,lastSync="not committed"),GraphStore(next).project())
                error("Power loss before COMMIT")
            } } catch (_: IllegalStateException) { }
            assertEquals(disk,db.readState())
            assertEquals(view.people,db.readRecords("view").people)
            assertEquals(heads,db.graph().heads)
        }
        open(file).use { db -> assertEquals("Synthetic rollback",db.readRecords("view").people.values.single().name); assertEquals(1,db.graph().commits.size) }
    }
    @Test fun firstPairingRehomesWithoutLosingOriginalHistoryOrBlobs() {
        val file=temp.newFile("join.sqlite")
        val initial=GraphStore(GraphStore(GraphStore.empty()).saveCard(id(),ContactCard("Synthetic standalone"))).indexed()
        open(file).use { db ->
            db.importState(DiskState(graph=initial),GraphStore(initial).project())
            val collection=id()
            db.transaction {
                val disk=db.readState()
                var joined=GraphStore(disk.graph!!).rehome(collection)
                joined=joined.copy(bundle=joined.bundle.copy(blobs=GraphBlobs.persist(joined.bundle.blobs,db.blobDirectory)))
                db.save(disk,disk.copy(graph=joined),GraphStore(joined).project(),db.readRecords("view"))
            }
            val state=db.readState()
            assertEquals(collection,state.graph!!.bundle.collection)
            assertEquals(2,state.graph.bundle.commits.size)
            assertEquals(1,state.graph.bundle.blobs.size)
            assertEquals("Synthetic standalone",db.readRecords("view").people.values.single().name)
        }
    }
    @Test fun indexedIdentityChangesMatchFullProjectionAndKeepSharedRows() {
        val file=temp.newFile("identity.sqlite")
        val a=id(); val b=id()
        var initial=GraphStore(GraphStore.empty()).saveCard(a,ContactCard("Synthetic A",notes="A note",fields=listOf(ContactField("phone","020 7946 0000")),legacy_unverified=true))
        initial=GraphStore(initial).saveCard(b,ContactCard("Synthetic B",notes="B note",fields=listOf(ContactField("email","b@example.test"))))
        initial=GraphStore(initial).indexed()
        open(file).use { db ->
            db.importState(DiskState(graph=initial),GraphStore(initial).project())
            db.transaction {
                val disk=db.readState(); val before=db.readRecords("view")
                val edge=VersionedGraph.createEdge("same_person",a,b,buildJsonObject { put("preferred_person",a) })
                val next=GraphStore(disk.graph!!).commit(listOf(edge))
                val delta=GraphStore(next).project(previous=before,changedTargets=setOf(a,b,edge.target))
                val full=GraphStore(next).project()
                assertEquals(full.people,delta.people); assertEquals(full.events,delta.events)
                db.save(disk,disk.copy(graph=next),delta,before)
                assertEquals(1,db.readRecords("view").people.size)
                assertEquals(2,db.readRecords("view").events.size)
                assertTrue(db.readRecords("view").people.values.single().contactCard().legacy_unverified)
            }
        }
    }
    @Test fun screenAndMetadataCommitWithGraphAndReloadWithoutPayloadReplay() {
        val file=temp.newFile("store.sqlite")
        val base=GraphStore(GraphStore(GraphStore.empty()).saveCard(id(),ContactCard("Synthetic indexed"))).indexed()
        val view=GraphStore(base).project()
        open(file).use { db -> db.importState(DiskState(graph=base),view) }
        open(file).use { db ->
            val disk=db.readState(); val loaded=db.readRecords("view")
            assertEquals(view.people,loaded.people)
            assertTrue(disk.graph!!.bundle.reducer is IndexedGraph)
            db.transaction {
                val person=loaded.people.entries.single()
                val next=GraphStore(disk.graph).saveCard(person.value.contact_uid,person.value.contactCard().copy(favorite=true))
                val projected=GraphStore(next).project(previous=loaded,changedTargets=setOf(person.value.contact_uid))
                db.save(disk,disk.copy(graph=next),projected)
            }
        }
        open(file).use { db -> assertTrue(db.readRecords("view").people.values.single().contactCard().favorite); assertEquals(2,db.graph().commits.size) }
    }
}
