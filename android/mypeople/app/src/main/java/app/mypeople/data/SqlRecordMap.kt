package app.mypeople.data

/** Preserve owner lookup through SQL-backed maps and uncommitted projection deltas. */
internal interface OwnerScopedRows<T> : Map<String,T> {
    fun forOwner(owner: Int, ownerOf: (T)->Int): Map<String,T>
}

internal fun <T> Map<String,T>.rowsForOwner(owner: Int, ownerOf: (T)->Int): Map<String,T> =
    if (this is OwnerScopedRows<T>) forOwner(owner,ownerOf) else filterValues { ownerOf(it) == owner }

/** Immutable, version-bounded screen rows. Events/profiles are decoded only when used. */
internal class SqlRecordMap<T>(private val db: IndexedGraphDatabase, val scope: String, val kind: String, val version: Long, val decode: (String)->T, private val excluded: Set<Int> = emptySet(), private val owner: Int? = null) : AbstractMap<String,T>(), OwnerScopedRows<T> {
    private val where = "scope=? AND kind=? AND born<=? AND (died IS NULL OR died>?)" +
        (if (excluded.isEmpty()) "" else " AND (owner IS NULL OR owner NOT IN (${excluded.joinToString(",") { "?" }}))") +
        (if (owner == null) "" else " AND owner=?")
    private val args: List<Any?> = listOf(scope,kind,version,version)+excluded.toList()+listOfNotNull(owner)
    // ORDER BY id + LIMIT can otherwise make SQLite scan the book's id index,
    // filtering owners afterward. Sorting one owner's small slice is the bounded path.
    private val table = if (owner == null) "screen" else "screen INDEXED BY screen_owner"
    fun without(owners: Set<Int>) = SqlRecordMap(db,scope,kind,version,decode,excluded+owners,owner)
    override fun forOwner(owner: Int, ownerOf: (T)->Int): Map<String,T> =
        if (owner in excluded || (this.owner != null && this.owner != owner)) emptyMap()
        else SqlRecordMap(db,scope,kind,version,decode,excluded,owner)
    override val size get() = db.scalar("SELECT count(*) FROM $table WHERE $where",args)!!.toInt()
    override fun containsKey(key: String) = db.scalar("SELECT 1 FROM $table WHERE $where AND id=?",args+key) != null
    override fun get(key: String): T? = db.scalar("SELECT data FROM $table WHERE $where AND id=?",args+key)?.let(decode)
    override val entries: Set<Map.Entry<String,T>> get() = object : AbstractSet<Map.Entry<String,T>>() {
        override val size get() = this@SqlRecordMap.size
        override fun iterator(): Iterator<Map.Entry<String,T>> = object : Iterator<Map.Entry<String,T>> {
            var after = ""; var page = emptyList<List<String?>>(); var position = 0; var done = false
            override fun hasNext(): Boolean {
                if (position < page.size) return true
                if (done) return false
                page = db.sql.query("SELECT id,data FROM $table WHERE $where AND id>? ORDER BY id LIMIT 128",args+after)
                position=0; done=page.isEmpty(); return !done
            }
            override fun next(): Map.Entry<String,T> {
                check(hasNext()); val row=page[position++]; after=row[0]!!
                return java.util.AbstractMap.SimpleImmutableEntry(after,decode(row[1]!!))
            }
        }
    }
}

/** A projection delta, not a copy of every memory row in the address book. */
internal class ProjectedRows<T>(private val previous: SqlRecordMap<T>, private val dirty: Set<Int>, private val generated: Map<String,T>) : AbstractMap<String,T>(), OwnerScopedRows<T> {
    private val retained = previous.without(dirty)
    override fun forOwner(owner: Int, ownerOf: (T)->Int): Map<String,T> =
        retained.forOwner(owner,ownerOf) + generated.filter { (key,value) -> ownerOf(value) == owner && !retained.containsKey(key) }
    override val size get() = retained.size + generated.keys.count { !retained.containsKey(it) }
    override fun get(key: String) = retained[key] ?: generated[key]
    override fun containsKey(key: String) = retained.containsKey(key) || generated.containsKey(key)
    override val entries: Set<Map.Entry<String,T>> get() = object : AbstractSet<Map.Entry<String,T>>() {
        override val size get() = this@ProjectedRows.size
        override fun iterator() = (generated.entries.asSequence().filterNot { retained.containsKey(it.key) } + retained.entries.asSequence()).iterator()
    }
    fun write(db: IndexedGraphDatabase, scope: String, kind: String, revision: Long, encode: (T)->String, owner: (T)->Int?): Boolean {
        require(scope == previous.scope && kind == previous.kind)
        if (dirty.isEmpty()) return false
        val old=db.sql.query("SELECT id,data FROM screen WHERE scope=? AND kind=? AND died IS NULL AND owner IN (${dirty.joinToString(",") { "?" }})",listOf(scope,kind)+dirty.toList()).associate { it[0]!! to it[1]!! }
        val replacement=generated.filterKeys { !retained.containsKey(it) }
        if (old == replacement.mapValues { encode(it.value) }) return false
        if (dirty.isNotEmpty()) db.sql.execute("UPDATE screen SET died=? WHERE scope=? AND kind=? AND died IS NULL AND owner IN (${dirty.joinToString(",") { "?" }})",listOf(revision,scope,kind)+dirty.toList())
        for ((id,value) in replacement) db.sql.execute("INSERT INTO screen(scope,kind,id,owner,data,born) VALUES (?,?,?,?,?,?)",listOf(scope,kind,id,owner(value),encode(value),revision))
        return true
    }
}

internal fun <T> replaceProjected(previous: Map<String,T>, dirty: Set<Int>, generated: Map<String,T>, owner: (T)->Int): Map<String,T> =
    if (previous is SqlRecordMap<T>) ProjectedRows(previous,dirty,generated)
    else generated + previous.filterValues { owner(it) !in dirty }
