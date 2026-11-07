package app.mypeople.data

import kotlinx.serialization.json.*

/** A point-in-time graph over persisted indexes, not a replayed Java object tree. */
internal class IndexedGraph(val database: IndexedGraphDatabase, val sequence: Long) : VersionedGraph() {
    override val commits = database.headers(sequence).associateBy { it.id }
    override val ordered = VersionedGraph.order(commits)
    override val heads = (commits.keys - commits.values.flatMap { it.parents }.toSet()).sorted()
    override val collection = ordered.firstOrNull()?.collection
    private val ranks = ordered.mapIndexed { i,c -> c.id to i }.toMap()
    private val propertyCache = object : LinkedHashMap<String,Map<String,List<GraphAlternative>>>(256,.75f,true) {
        override fun removeEldestEntry(eldest: MutableMap.MutableEntry<String,Map<String,List<GraphAlternative>>>) = size > 1024
    }
    override val objects: Map<String,GraphEntity> = EntityMap(false)
    override val edges: Map<String,GraphEntity> = EntityMap(true)
    override val people: Set<String> by lazy { database.sql.query("SELECT id FROM entities WHERE type='Person' AND created<=? ORDER BY id",listOf(sequence)).map { it[0]!! }.toSet() }
    private inner class EntityMap(val edge: Boolean) : AbstractMap<String,GraphEntity>() {
        private val clause = "created<=? AND src IS ${if (edge) "NOT " else ""}NULL"
        override val size get() = database.scalar("SELECT count(*) FROM entities WHERE $clause",listOf(sequence))!!.toInt()
        override fun containsKey(key: String) = database.scalar("SELECT 1 FROM entities WHERE id=? AND $clause",listOf(key,sequence)) != null
        override fun get(key: String): GraphEntity? = database.sql.query("SELECT type,src,dst FROM entities WHERE id=? AND $clause",listOf(key,sequence)).singleOrNull()?.let { GraphEntity(it[0]!!,it[1],it[2]) }
        override val entries: Set<Map.Entry<String,GraphEntity>> get() = object : AbstractSet<Map.Entry<String,GraphEntity>>() {
            override val size get() = this@EntityMap.size
            override fun iterator(): Iterator<Map.Entry<String,GraphEntity>> = object : Iterator<Map.Entry<String,GraphEntity>> {
                var after = ""; var page = emptyList<List<String?>>(); var position = 0; var done = false
                override fun hasNext(): Boolean {
                    if (position < page.size) return true
                    if (done) return false
                    page = database.sql.query("SELECT id,type,src,dst FROM entities WHERE $clause AND id>? ORDER BY id LIMIT 256",listOf(sequence,after))
                    position = 0; done = page.isEmpty(); return !done
                }
                override fun next(): Map.Entry<String,GraphEntity> {
                    check(hasNext()); val row = page[position++]; after = row[0]!!
                    return java.util.AbstractMap.SimpleImmutableEntry(after,GraphEntity(row[1]!!,row[2],row[3]))
                }
            }
        }
    }
    private fun edgeRows(where: String, args: List<Any?>): List<Pair<String,GraphEntity>> = database.sql.query("SELECT e.id,e.type,e.src,e.dst,c.id,e.ordinal FROM entities e JOIN commits c ON c.seq=e.created WHERE e.src IS NOT NULL AND e.created<=? AND $where",listOf(sequence)+args)
        .sortedWith(compareBy<List<String?>> { ranks.getValue(it[4]!!) }.thenBy { it[5]!!.toInt() }).map { it[0]!! to GraphEntity(it[1]!!,it[2],it[3]) }
    override fun outgoing(id: String) = edgeRows("e.src=?",listOf(id))
    override fun incoming(id: String) = edgeRows("e.dst=?",listOf(id))
    override fun edgesOfType(type: String) = edgeRows("e.type=?",listOf(type))
    private fun properties(target: String): Map<String,List<GraphAlternative>> = propertyCache.getOrPut(target) {
        database.sql.query("SELECT property,op,value FROM registers WHERE entity=? AND born<=? AND (died IS NULL OR died>?) ORDER BY property,op",listOf(target,sequence,sequence))
            .groupBy({it[0]!!},{GraphAlternative(it[1]!!,json.parseToJsonElement(it[2]!!))})
    }
    override fun propertyNames(target: String) = properties(target).keys - "_lifecycle"
    override fun alternatives(target: String, property: String) = properties(target)[property].orEmpty()
    override fun value(target: String, property: String): JsonElement? = alternatives(target,property).lastOrNull()?.value
    override fun conflicted(target: String, property: String) = alternatives(target,property).map { it.value }.distinct().size > 1
    override fun active(target: String): Boolean = if (sequence == database.latest) database.scalar("SELECT active FROM entities WHERE id=? AND created<=?",listOf(target,sequence)) == "1" else !conflicted(target,"_lifecycle") && value(target,"_lifecycle") == JsonPrimitive("active")
    override fun observed(origin: String, commit: String): Boolean {
        if (origin == commit) return true
        val todo = java.util.ArrayDeque(commits[commit]?.parents.orEmpty()); val seen = hashSetOf<String>()
        while (todo.isNotEmpty()) { val id = todo.removeLast(); if (id == origin) return true; if (seen.add(id)) todo.addAll(commits.getValue(id).parents) }
        return false
    }
    fun observed(origin: String, parents: List<String>) = parents.any { observed(origin,it) }
    override fun deletionConflicts(target: String): List<GraphAlternative> {
        val out = sortedMapOf<String,JsonElement>()
        fun origin(op: String) = requireNotNull(database.scalar("SELECT c.id FROM operations o JOIN commits c ON c.seq=o.commit_seq WHERE o.id=?",listOf(op)))
        for (life in alternatives(target,"_lifecycle")) if (life.value != JsonPrimitive("active")) {
            val deletion = origin(life.operation)
            for (property in propertyNames(target)) for (version in alternatives(target,property)) {
                val edit = origin(version.operation)
                if (!observed(deletion,edit) && !observed(edit,deletion)) {
                    out[life.operation] = buildJsonObject { put("property","_lifecycle"); put("value",life.value) }
                    out[version.operation] = buildJsonObject { put("property",property); put("value",version.value) }
                }
            }
        }
        return out.map { GraphAlternative(it.key,it.value) }
    }
    override fun appended(commit: GraphCommit): VersionedGraph {
        check(database.sql.inTransaction) { "Indexed edits require a Store transaction; snapshots are read-only." }
        require(sequence == database.latest) { "Stale indexed graph snapshot" }
        return database.append(commit,true)
    }
    override fun received(commit: GraphCommit): VersionedGraph {
        check(database.sql.inTransaction) { "Indexed imports require a Store transaction; snapshots are read-only." }
        require(sequence == database.latest) { "Stale indexed graph snapshot" }
        return database.append(commit,false)
    }
    override fun components() = database.components(sequence)
    fun calculateComponents() = super.components()
    fun knownBlobs(commits: Set<String>): Set<String> = if (commits.isEmpty()) emptySet() else database.sql.query("SELECT DISTINCT r.hash FROM blob_references r JOIN commits c ON c.seq=r.commit_seq WHERE c.id IN (${commits.joinToString(",") { "?" }})",commits.toList()).map { it[0]!! }.toSet()
}
