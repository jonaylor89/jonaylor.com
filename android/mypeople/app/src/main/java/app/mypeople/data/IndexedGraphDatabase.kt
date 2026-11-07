package app.mypeople.data

import java.io.File
import java.time.OffsetDateTime
import java.util.UUID
import kotlinx.serialization.encodeToString
import kotlinx.serialization.decodeFromString
import kotlinx.serialization.json.*

/** Durable graph log AND materialized working indexes. No history replay on open.
 * Register/view lifetimes provide immutable snapshots for exports and projections.
 * All edits, index changes, metadata and screen rows commit in one FULL-sync transaction. */
internal class IndexedGraphDatabase(val sql: GraphSql, val blobDirectory: File) : AutoCloseable {
    var latest = 0L; private set
    var viewVersion = 0L; private set
    private var componentVersion = -1L
    private var componentValue: GraphComponents? = null
    init {
        val version=sql.query("PRAGMA user_version").single().first()!!.toInt()
        require(version in 0..1) { "Unsupported indexed Store version; data was not replaced." }
        sql.execute("CREATE TABLE IF NOT EXISTS meta(key TEXT PRIMARY KEY,value TEXT NOT NULL)")
        sql.execute("CREATE TABLE IF NOT EXISTS commits(seq INTEGER PRIMARY KEY,id TEXT NOT NULL UNIQUE,collection TEXT NOT NULL,peer TEXT NOT NULL,at TEXT NOT NULL,parents TEXT NOT NULL,nops INTEGER NOT NULL)")
        sql.execute("CREATE TABLE IF NOT EXISTS operations(id TEXT PRIMARY KEY,commit_seq INTEGER NOT NULL REFERENCES commits(seq),ordinal INTEGER NOT NULL,kind TEXT NOT NULL,target TEXT NOT NULL,payload TEXT NOT NULL,replaces TEXT NOT NULL,UNIQUE(commit_seq,ordinal))")
        sql.execute("CREATE INDEX IF NOT EXISTS operation_target ON operations(target)")
        sql.execute("CREATE TABLE IF NOT EXISTS entities(id TEXT PRIMARY KEY,type TEXT NOT NULL,src TEXT,dst TEXT,created INTEGER NOT NULL REFERENCES commits(seq),ordinal INTEGER NOT NULL,active INTEGER NOT NULL)")
        sql.execute("CREATE INDEX IF NOT EXISTS entity_from ON entities(src,type,created)")
        sql.execute("CREATE INDEX IF NOT EXISTS entity_to ON entities(dst,type,created)")
        sql.execute("CREATE INDEX IF NOT EXISTS entity_type ON entities(type,created)")
        sql.execute("CREATE TABLE IF NOT EXISTS registers(entity TEXT NOT NULL,property TEXT NOT NULL,op TEXT NOT NULL REFERENCES operations(id),value TEXT NOT NULL,born INTEGER NOT NULL,died INTEGER,PRIMARY KEY(entity,property,op))")
        sql.execute("CREATE INDEX IF NOT EXISTS register_live ON registers(entity,born,died,property)")
        sql.execute("CREATE INDEX IF NOT EXISTS register_operation ON registers(op,entity,property)")
        sql.execute("CREATE TABLE IF NOT EXISTS blob_catalog(hash TEXT PRIMARY KEY,born INTEGER NOT NULL)")
        sql.execute("CREATE TABLE IF NOT EXISTS blob_references(commit_seq INTEGER NOT NULL,hash TEXT NOT NULL,PRIMARY KEY(commit_seq,hash))")
        sql.execute("CREATE TABLE IF NOT EXISTS components(person TEXT NOT NULL,root TEXT NOT NULL,born INTEGER NOT NULL,died INTEGER,PRIMARY KEY(person,born))")
        sql.execute("CREATE INDEX IF NOT EXISTS component_live ON components(born,died)")
        sql.execute("CREATE TABLE IF NOT EXISTS screen(scope TEXT NOT NULL,kind TEXT NOT NULL,id TEXT NOT NULL,owner INTEGER,data TEXT NOT NULL,born INTEGER NOT NULL,died INTEGER,PRIMARY KEY(scope,kind,id,born))")
        sql.execute("CREATE INDEX IF NOT EXISTS screen_live ON screen(scope,kind,born,died,id)")
        sql.execute("CREATE INDEX IF NOT EXISTS screen_owner ON screen(scope,kind,owner,born,died)")
        sql.execute("CREATE TABLE IF NOT EXISTS person_fast(scope TEXT NOT NULL,id TEXT NOT NULL,data BLOB NOT NULL,PRIMARY KEY(scope,id))")
        if (version == 0) sql.execute("PRAGMA user_version=1")
        refresh()
    }
    fun refresh() {
        latest = scalar("SELECT coalesce(max(seq),0) FROM commits")?.toLong() ?: 0
        viewVersion = meta("view_version")?.toLong() ?: 0
        componentVersion = -1; componentValue = null
    }
    fun scalar(query: String, args: List<Any?> = emptyList()): String? = sql.query(query, args).firstOrNull()?.firstOrNull()
    fun meta(key: String): String? = scalar("SELECT value FROM meta WHERE key=?", listOf(key))
    fun putMeta(key: String, value: String) = sql.execute("INSERT OR REPLACE INTO meta(key,value) VALUES (?,?)", listOf(key,value))
    fun <T> transaction(block: () -> T): T {
        if (sql.inTransaction) return block()
        sql.begin()
        return try { block().also { sql.commit() } } catch (error: Throwable) { sql.rollback(); refresh(); throw error }
    }
    fun graph(at: Long = latest) = IndexedGraph(this, at)
    fun operation(row: List<String?>): GraphOperation = GraphOperation(row[0]!!,row[1]!!,row[2]!!,json.parseToJsonElement(row[3]!!).jsonObject,json.decodeFromString(row[4]!!))
    fun operations(commit: Long, count: Int): List<GraphOperation> = object : AbstractList<GraphOperation>() {
        override val size = count
        override fun get(index: Int): GraphOperation {
            require(index in indices)
            return operation(sql.query("SELECT id,kind,target,payload,replaces FROM operations WHERE commit_seq=? AND ordinal=?", listOf(commit,index)).single())
        }
        override fun iterator(): Iterator<GraphOperation> = object : Iterator<GraphOperation> {
            var offset = 0; var page = emptyList<List<String?>>(); var position = 0
            override fun hasNext() = offset < size
            override fun next(): GraphOperation {
                check(hasNext())
                if (position == page.size) { page = sql.query("SELECT id,kind,target,payload,replaces FROM operations WHERE commit_seq=? AND ordinal>=? ORDER BY ordinal LIMIT 128", listOf(commit,offset)); position = 0 }
                offset++; return operation(page[position++])
            }
        }
    }
    fun headers(at: Long): List<GraphCommit> = sql.query("SELECT seq,id,collection,peer,at,parents,nops FROM commits WHERE seq<=? ORDER BY seq", listOf(at)).map { r ->
        GraphCommit(r[1]!!,r[2]!!,r[3]!!,r[4]!!,1,json.decodeFromString(r[5]!!),operations(r[0]!!.toLong(),r[6]!!.toInt()))
    }
    private fun uuid(value: String) { require(UUID.fromString(value).toString() == value) { "Expected canonical graph UUID" } }
    private fun string(value: JsonElement?): String { require(value is JsonPrimitive && value.isString); return value.content }
    private fun properties(value: JsonElement?): JsonObject { require(value is JsonObject && value.keys.all { it.isNotEmpty() && !it.startsWith('_') }); return value }
    fun append(commit: GraphCommit, local: Boolean, validate: Boolean = true): IndexedGraph = transaction {
        val before = graph()
        if (validate) {
            listOf(commit.id,commit.collection,commit.peer).forEach(::uuid)
            require(commit.version == 1 && commit.operations.isNotEmpty())
            require(before.collection == null || before.collection == commit.collection) { "Different graph collection" }
            require(commit.id !in before.commits) { "Commit UUID reused" }
            require(commit.parents.size <= 100000 && commit.parents.distinct().size == commit.parents.size && commit.parents.all { it in before.commits }) { "Missing graph parent" }
            commit.parents.forEach(::uuid); OffsetDateTime.parse(commit.recorded_at)
            require(!local || commit.parents == before.heads) { "Stale local graph frontier" }
            require(before.commits.size < 100000 && (scalar("SELECT count(*) FROM operations")!!.toLong() + commit.operations.size) <= 1000000)
        }
        val seq = latest + 1
        sql.execute("INSERT INTO commits(seq,id,collection,peer,at,parents,nops) VALUES (?,?,?,?,?,?,?)", listOf(seq,commit.id,commit.collection,commit.peer,commit.recorded_at,json.encodeToString(commit.parents),commit.operations.size))
        var identityChanged = false
        commit.operations.forEachIndexed { ordinal, op ->
            if (validate) { listOf(op.id,op.target).forEach(::uuid); op.replaces.forEach(::uuid); require(op.replaces.distinct().size == op.replaces.size); VersionedGraph.validateJson(op.payload,3) }
            val p = op.payload
            val values: Map<String,JsonElement>
            if (op.kind in setOf("create_object","create_edge")) {
                require(op.replaces.isEmpty())
                val objectCreation = op.kind == "create_object"
                require(p.keys == if (objectCreation) setOf("type","properties") else setOf("type","properties","from","to"))
                val type = string(p["type"]); val props = properties(p["properties"])
                val from = if (objectCreation) null else string(p["from"])
                val to = if (objectCreation) null else string(p["to"])
                if (validate) {
                    require(scalar("SELECT 1 FROM entities WHERE id=?",listOf(op.target)) == null) { "Entity identity cannot be recreated" }
                    if (objectCreation) require(type in VersionedGraph.objectTypes) else {
                        val allowed = requireNotNull(VersionedGraph.edgeTypes[type])
                        fun endpoint(id: String): String {
                            uuid(id)
                            val row = sql.query("SELECT e.type,c.id FROM entities e JOIN commits c ON c.seq=e.created WHERE e.id=?",listOf(id)).singleOrNull()
                            require(row != null && (row[1] == commit.id || before.observed(row[1]!!, commit.parents))) { "Unobserved endpoint" }
                            return row[0]!!
                        }
                        val a = endpoint(from!!); val b = endpoint(to!!)
                        require((allowed.first == null || a in allowed.first!!) && (allowed.second == null || b in allowed.second!!))
                        require(type !in setOf("same_person","distinct_person") || from != to)
                    }
                }
                sql.execute("INSERT INTO entities(id,type,src,dst,created,ordinal,active) VALUES (?,?,?,?,?,?,1)",listOf(op.target,type,from,to,seq,ordinal))
                identityChanged = identityChanged || type in setOf("Person","same_person","distinct_person")
                values = props + ("_lifecycle" to JsonPrimitive("active"))
            } else {
                require(op.kind in setOf("set_property","set_lifecycle")) { "Unknown operation kind" }
                val prop = if (op.kind == "set_property") string(p["property"]) else "_lifecycle"
                require(p.keys == if (op.kind == "set_property") setOf("property","value") else setOf("value"))
                if (op.kind == "set_lifecycle") require(string(p["value"]) in setOf("active","trashed","retracted")) else properties(JsonObject(mapOf(prop to p.getValue("value"))))
                if (validate) {
                    val created = scalar("SELECT c.id FROM entities e JOIN commits c ON c.seq=e.created WHERE e.id=?",listOf(op.target))
                    require(created != null && (created == commit.id || before.observed(created,commit.parents))) { "Unobserved entity" }
                }
                for (old in op.replaces) {
                    if (validate) {
                        val origin = scalar("SELECT c.id FROM registers r JOIN operations o ON o.id=r.op JOIN commits c ON c.seq=o.commit_seq WHERE r.entity=? AND r.property=? AND r.op=?",listOf(op.target,prop,old))
                        require(origin != null && (origin == commit.id || before.observed(origin,commit.parents))) { "Replacement targets an unobserved or different property" }
                    }
                    sql.execute("UPDATE registers SET died=? WHERE entity=? AND property=? AND op=? AND died IS NULL",listOf(seq,op.target,prop,old))
                }
                values = mapOf(prop to p.getValue("value"))
                if (prop == "_lifecycle") identityChanged = identityChanged || scalar("SELECT type FROM entities WHERE id=?",listOf(op.target)) in setOf("same_person","distinct_person")
            }
            sql.execute("INSERT INTO operations(id,commit_seq,ordinal,kind,target,payload,replaces) VALUES (?,?,?,?,?,?,?)",listOf(op.id,seq,ordinal,op.kind,op.target,p.toString(),json.encodeToString(op.replaces)))
            for ((property,value) in values) sql.execute("INSERT INTO registers(entity,property,op,value,born) VALUES (?,?,?,?,?)",listOf(op.target,property,op.id,value.toString(),seq))
            if ("_lifecycle" in values) {
                val states = sql.query("SELECT value FROM registers WHERE entity=? AND property='_lifecycle' AND died IS NULL",listOf(op.target)).map { json.parseToJsonElement(it[0]!!) }.distinct()
                sql.execute("UPDATE entities SET active=? WHERE id=?",listOf(states.size == 1 && states.single() == JsonPrimitive("active"),op.target))
            }
            fun refs(value: JsonElement) { when(value) {
                is JsonObject -> { value["blob_hash"]?.jsonPrimitive?.content?.let { sql.execute("INSERT OR IGNORE INTO blob_references(commit_seq,hash) VALUES (?,?)",listOf(seq,it)) }; value.values.forEach(::refs) }
                is JsonArray -> value.forEach(::refs)
                else -> Unit
            } }
            refs(p)
        }
        latest = seq
        if (identityChanged || componentValue == null) rebuildComponents()
        graph()
    }
    private fun rebuildComponents() {
        val value = graph().calculateComponents()
        val old = sql.query("SELECT person,root FROM components WHERE died IS NULL").associate { it[0]!! to it[1]!! }
        for ((person,root) in value.rootByPerson) if (old[person] != root) {
            sql.execute("UPDATE components SET died=? WHERE person=? AND died IS NULL",listOf(latest,person))
            sql.execute("INSERT INTO components(person,root,born) VALUES (?,?,?)",listOf(person,root,latest))
        }
        componentVersion = latest; componentValue = value
        putMeta("contradictions",json.encodeToString(value.contradictions))
    }
    fun components(at: Long): GraphComponents {
        if (at == componentVersion) return componentValue!!
        if (at != latest) return graph(at).calculateComponents()
        val rows = sql.query("SELECT person,root FROM components WHERE died IS NULL ORDER BY person")
        val groups = rows.groupBy({it[1]!!},{it[0]!!})
        val value = GraphComponents(groups,meta("contradictions")?.let { json.decodeFromString<List<String>>(it) }.orEmpty())
        componentValue = value; componentVersion = at
        return value
    }
    fun readState(): DiskState {
        require(meta("ready") == "1") { "Incomplete indexed Store; original history was retained." }
        val base = json.decodeFromString<DiskState>(requireNotNull(meta("state")))
        val core = json.decodeFromString<GraphState>(requireNotNull(meta("graph"))).copy(localIds=json.decodeFromString(requireNotNull(meta("local_ids"))))
        val reduced = graph()
        val bundle = GraphBundle(core.bundle.collection,reduced.heads,reduced.ordered,DatabaseBlobs(this,latest)).also { it.reducer = reduced; it.blobsVerified = true }
        return base.copy(records = readRecords("derived"),graph = core.copy(bundle = bundle))
    }
    fun importState(state: DiskState, view: Records) = transaction {
        require(latest == 0L && meta("ready") == null)
        val gs = GraphStore(requireNotNull(state.graph)) // Validate once, never during normal open.
        for (commit in gs.graph.ordered) append(commit,local = false,validate = false)
        save(null,state,view)
        require(authorityHash(gs.graph.ordered) == authorityHash(graph().ordered)) { "Indexed history differs; original Store was not replaced." }
        val restored=readRecords("view")
        require(restored.people == view.people && restored.events == view.events && restored.profiles == view.profiles && restored.moments == view.moments && restored.dupes == view.dupes) { "Indexed projection differs; original Store was not replaced." }
        require(DatabaseBlobs(this,latest).keys == gs.state.bundle.blobs.keys) { "Indexed blob inventory differs." }
        putMeta("ready","1")
        val roundtrip=readState()
        require(roundtrip.copy(graph=null) == state.copy(graph=null) && roundtrip.graph!!.localIds == state.graph!!.localIds && roundtrip.graph.peer == state.graph.peer && roundtrip.graph.remoteHeads == state.graph.remoteHeads) { "Indexed metadata/outbox differs; original Store was not replaced." }
    }
    @OptIn(kotlinx.serialization.ExperimentalSerializationApi::class)
    private fun authorityHash(commits: List<GraphCommit>): String {
        val digest=java.security.MessageDigest.getInstance("SHA-256")
        val sink=object : java.io.OutputStream() { override fun write(value: Int) { }; override fun write(bytes: ByteArray,offset: Int,length: Int) { } }
        val out=java.io.BufferedOutputStream(java.security.DigestOutputStream(sink,digest),128*1024)
        VersionedGraph.wire.encodeToStream(kotlinx.serialization.builtins.ListSerializer(GraphCommit.serializer()),commits,out); out.flush()
        return digest.digest().joinToString("") { "%02x".format(it) }
    }
    fun save(previous: DiskState?, state: DiskState, view: Records, previousView: Records? = null): Records {
        check(sql.inTransaction)
        val gs = requireNotNull(state.graph)
        if (graph().collection != null && gs.bundle.collection != graph().collection) {
            require(previous?.graph?.remoteHeads?.isEmpty() == true) { "An established graph cannot change collection." }
            val headers=headers(latest)
            for (header in headers) sql.execute("UPDATE commits SET id=?,collection=?,parents=? WHERE id=?",listOf(
                GraphStore.namespacedId(gs.bundle.collection,header.id),gs.bundle.collection,
                json.encodeToString(header.parents.map { GraphStore.namespacedId(gs.bundle.collection,it) }),header.id))
        }
        // Non-indexed graphs can arrive through a cold restore/bootstrap.
        for (commit in gs.bundle.commits) if (scalar("SELECT 1 FROM commits WHERE id=?",listOf(commit.id)) == null) append(commit,false)
        if (previous?.graph?.bundle?.blobs !== gs.bundle.blobs) for (hash in gs.bundle.blobs.keys) {
            require(Regex("[0-9a-f]{64}").matches(hash) && File(blobDirectory,hash).isFile) { "Missing durable blob" }
            sql.execute("INSERT OR IGNORE INTO blob_catalog(hash,born) VALUES (?,?)",listOf(hash,latest))
        }
        val oldSequence = (previous?.graph?.bundle?.reducer as? IndexedGraph)?.sequence ?: 0L
        require(scalar("SELECT 1 FROM blob_references r LEFT JOIN blob_catalog b ON b.hash=r.hash WHERE r.commit_seq>? AND b.hash IS NULL LIMIT 1",listOf(oldSequence)) == null) { "Missing graph blob reference" }
        putMeta("state",json.encodeToString(state.copy(records=Records(),graph=null)))
        val stub = gs.copy(bundle=GraphBundle(gs.bundle.collection,gs.bundle.heads),localIds=emptyMap())
        putMeta("graph",json.encodeToString(stub))
        if (previous == null || previous.graph?.localIds !== gs.localIds) putMeta("local_ids",json.encodeToString(gs.localIds))
        val revision = viewVersion + 1
        writeRecords("derived",previous?.records,state.records,revision)
        val changed=writeRecords("view",previousView,view,revision)
        view.duplicateIndex?.takeUnless { it === previousView?.duplicateIndex }?.let { putMeta("duplicate_keys",json.encodeToString(it.persistedKeys())) }
        viewVersion = revision; putMeta("view_version",revision.toString())
        putMeta("person_codec","1")
        if (view === previousView) return view
        return view.copy(events=if ("event" in changed) viewMap("view","event",revision) else previousView?.events ?: view.events,
            profiles=if ("profile" in changed) viewMap("view","profile",revision) else previousView?.profiles ?: view.profiles).also { it.duplicateIndex=view.duplicateIndex }
    }
    private fun writeRecords(scope: String, previous: Records?, next: Records, revision: Long): Set<String> {
        val changed=hashSetOf<String>()
        fun <T> rows(kind: String, values: Map<String,T>, encode: (T)->String, owner: (T)->Int? = {null}, oldModels: Map<String,T>? = null) {
            if (values is ProjectedRows<*>) {
                @Suppress("UNCHECKED_CAST") val changes = values as ProjectedRows<T>
                if (changes.write(this,scope,kind,revision,encode,owner)) changed+=kind
                return
            }
            val oldKeys = oldModels?.keys ?: sql.query("SELECT id FROM screen WHERE scope=? AND kind=? AND died IS NULL",listOf(scope,kind)).map { it[0]!! }.toSet()
            for (key in oldKeys - values.keys) {
                changed+=kind
                sql.execute("UPDATE screen SET died=? WHERE scope=? AND kind=? AND id=? AND died IS NULL",listOf(revision,scope,kind,key))
                if (kind == "person") sql.execute("DELETE FROM person_fast WHERE scope=? AND id=?",listOf(scope,key))
            }
            for ((key,value) in values) {
                if (oldModels != null && oldModels[key] == value) continue
                val data = encode(value)
                if (oldModels == null && scalar("SELECT data FROM screen WHERE scope=? AND kind=? AND id=? AND died IS NULL",listOf(scope,kind,key)) == data) continue
                changed+=kind
                sql.execute("UPDATE screen SET died=? WHERE scope=? AND kind=? AND id=? AND died IS NULL",listOf(revision,scope,kind,key))
                sql.execute("INSERT INTO screen(scope,kind,id,owner,data,born) VALUES (?,?,?,?,?,?)",listOf(scope,kind,key,owner(value),data,revision))
                if (kind == "person") sql.execute("INSERT OR REPLACE INTO person_fast(scope,id,data) VALUES (?,?,?)",listOf(scope,key,StoreCheckpoint.encodePerson(value as Person)))
            }
        }
        if (previous == null || previous.people !== next.people) rows("person",next.people.mapKeys { it.key.toString() },{json.encodeToString(it)},oldModels=previous?.people?.mapKeys { it.key.toString() })
        if (previous == null || previous.events !== next.events) rows("event",next.events,{json.encodeToString(it)},{it.person_id},previous?.events)
        if (previous == null || previous.profiles !== next.profiles) rows("profile",next.profiles,{json.encodeToString(it)},{it.person_id},previous?.profiles)
        if (previous == null || previous.moments !== next.moments) rows("moment",next.moments,{json.encodeToString(it)},{it.person_id},previous?.moments)
        if (previous == null || previous.dupes !== next.dupes) rows("dupes",next.dupes,{json.encodeToString(it)},oldModels=previous?.dupes)
        if (previous == null || previous.contactChanges !== next.contactChanges) rows("contact_change",next.contactChanges,{json.encodeToString(it)},oldModels=previous?.contactChanges)
        return changed
    }
    private fun ensureFastPeople() {
        if (meta("person_codec") == "1") return
        transaction {
            sql.execute("DELETE FROM person_fast")
            for (row in sql.query("SELECT scope,id,data FROM screen WHERE kind='person' AND died IS NULL")) {
                sql.execute("INSERT INTO person_fast(scope,id,data) VALUES (?,?,?)",listOf(row[0],row[1],StoreCheckpoint.encodePerson(json.decodeFromString<Person>(row[2]!!))))
            }
            putMeta("person_codec","1")
        }
    }
    fun readRecords(scope: String): Records {
        ensureFastPeople()
        fun <T> all(kind: String, decode: (String)->T): Map<String,T> = sql.query("SELECT id,data FROM screen WHERE scope=? AND kind=? AND died IS NULL",listOf(scope,kind)).associate { it[0]!! to decode(it[1]!!) }
        val records = Records(sql.blobs("SELECT id,data FROM person_fast WHERE scope=?",listOf(scope)).associate { it.first.toInt() to StoreCheckpoint.decodePerson(it.second) }, viewMap(scope,"event",viewVersion),viewMap(scope,"profile",viewVersion),all("moment"){json.decodeFromString(it)},all("dupes"){json.decodeFromString(it)},all("contact_change"){json.decodeFromString(it)})
        if (scope == "view") meta("duplicate_keys")?.let { records.duplicateIndex = GraphDuplicateIndex.restore(json.decodeFromString(it)) }
        return records
    }
    inline fun <reified T> viewMap(scope: String, kind: String, version: Long): Map<String,T> = SqlRecordMap(this,scope,kind,version,decode = { json.decodeFromString<T>(it) })
    override fun close() { sql.close() }
}
